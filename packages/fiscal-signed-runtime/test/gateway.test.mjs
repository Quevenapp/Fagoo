import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createSignedGateway} from '../src/gateway.mjs';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {FLAGS} from '../src/dto.mjs';
import {projectSqlView} from '../src/sql-dto.mjs';
import {response as sqlResponse,candidate,command} from '../../fiscal-signed-rpc/test/fixtures.mjs';
const ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
const payload=()=>({command_id:randomUUID(),unsigned_job_id:randomUUID(),unsigned_hash:'a'.repeat(64),basis_hash:'b'.repeat(64),expected_a1_version:1});
const outcome=p=>({...FLAGS,status:'recoverable',command_id:p.command_id,code:'SIGNED_TIMEOUT',phase:'finish',signed:null,outcome:'unconfirmed',storage_operations:3,signature_verified:false,xsd_validated:false});
function fixture({auth,upstream,env:overrides}={}){
 const actor=randomUUID(),key=randomBytes(32),calls={auth:0,runtime:0};let latest;
 const env={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:key.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime',
  A1_RUNTIME:{async fetch(request){calls.runtime++;latest=request;return upstream?upstream(request):Response.json(outcome(await request.json()));}},...overrides};
 const gateway=createSignedGateway({now:Date.now,nonce:randomUUID,fetchImpl:async(url,options)=>{
  calls.auth++;assert.equal(url,PROJECT+'/auth/v1/user');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
  assert.equal(options.headers.Authorization,'Bearer synthetic-user-session-1234567890');assert.equal(options.headers.apikey,env.SUPABASE_ANON_KEY);
  return auth?auth(url,options):Response.json({id:actor,is_anonymous:false});
 }});
 const request=(path='/run',value=payload(),options={})=>new Request('https://gateway.synthetic.invalid/v1/fiscal-signed'+path,{
  method:options.method??(value===undefined?'GET':'POST'),headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890',...(value===undefined?{}:{'Content-Type':'application/json'}),...options.headers},
  ...(value===undefined?{}:{body:options.raw??JSON.stringify(value)}),signal:options.signal});
 return{actor,key,calls,env,request,async send(path,value,options){return gateway(request(path,value,options),env);},gateway,get latest(){return latest;}};
}
async function body(r,status){assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');const v=await r.json();assert.doesNotMatch(JSON.stringify(v),/PRIVATE_DIAGNOSTIC|credential_id|fingerprint|lease_|access_key|<NFe|Bearer/);return v;}
test('gateway authenticates the session and binds a separate signed request without forwarding session or API credentials',async()=>{
 let f;f=fixture({upstream:async request=>{
  assert.equal(request.url,'https://fiscal-runtime.internal/internal/v1/fiscal-signed/run');assert.equal(request.redirect,'manual');
  assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);
  const bytes=new Uint8Array(await request.arrayBuffer()),p=JSON.parse(new TextDecoder().decode(bytes));
  const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:f.key,keyId:f.env.A1_TRANSPORT_KEY_ID,audience:'synthetic-runtime-signed',method:'POST',path:new URL(request.url).pathname});
  assert.equal(claims.actor,f.actor);assert.equal(claims.body_hash,await digest(bytes));return Response.json(outcome(p));
 }});
 const p=payload(),r=await f.send('/run',p),v=await body(r,200);assert.equal(r.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(v.command_id,p.command_id);assert.equal(v.signed,null);assert.deepEqual(f.calls,{auth:1,runtime:1});
});
test('CORS, routes, auth, body shape and limits reject before forwarding a command',async()=>{
 const f=fixture(),preflight=new Request('https://gateway.synthetic.invalid/v1/fiscal-signed/run',{method:'OPTIONS',headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
 assert.equal((await f.gateway(preflight,f.env)).status,204);assert.deepEqual(f.calls,{auth:0,runtime:0});
 for(const [path,p,opts,status] of [
  ['/run',payload(),{headers:{Origin:'https://different.invalid'}},403],
  ['/run?extra=1',payload(),{},400],['/sign',payload(),{},404],
  ['/run',payload(),{headers:{Authorization:'Bearer short'}},401],
  ['/run',{...payload(),actor:randomUUID()}, {},400],
  ['/run',payload(),{raw:'x'.repeat(4097)},413],
  ['/run',payload(),{headers:{'Content-Encoding':'gzip'}},400],
  ['/run',payload(),{headers:{'Content-Type':'application/xml'}},415]
 ]){const v=await body(await f.send(path,p,opts),status);assert.equal(v.recovery_required,false);}
 assert.equal(f.calls.runtime,0);
});
test('Auth rejects anonymous/invalid sessions and never follows redirects',async()=>{
 for(const [auth,status]of [
  [()=>Response.json({id:randomUUID(),is_anonymous:true}),401],
  [()=>Response.json({id:'invalid'}),401],
  [()=>Response.json({error:'PRIVATE_DIAGNOSTIC'},{status:403}),401],
  [()=>new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}),502]
 ]){const f=fixture({auth});assert.equal((await body(await f.send(),status)).recovery_required,false);assert.deepEqual(f.calls,{auth:1,runtime:0});}
});
test('post-forward failure is recoverable; runtime errors retain only the approved code and recovery indication',async()=>{
 for(const upstream of [()=>{throw new Error('PRIVATE_DIAGNOSTIC');},()=>new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}),()=>Response.json({secret:'PRIVATE_DIAGNOSTIC'}),()=>new Response('x'.repeat(131073),{headers:{'Content-Type':'application/json'}})]){
  const f=fixture({upstream}),r=await f.send(),v=await body(r,r.status);assert.ok(r.status>=500);assert.equal(v.recovery_required,true);assert.equal(f.calls.runtime,1);
 }
 const f=fixture({upstream:()=>Response.json({error:'SIGNED_CONFLICT',recovery_required:true,diagnostic:'PRIVATE_DIAGNOSTIC'},{status:409})});
 assert.deepEqual(await body(await f.send(),409),{error:'SIGNED_CONFLICT',recovery_required:true});
});
test('metadata reads and history use scoped bindings, expose no raw executor object and do not infer signature for a page',async()=>{
 const view=projectSqlView(sqlResponse('get'),{candidateId:candidate});
 const f=fixture({upstream:request=>{
  const path=new URL(request.url).pathname;
  if(path.endsWith('/history'))return Response.json({...FLAGS,read_only:true,unsigned_job_id:view.unsigned_job_id,items:[view],limit:25,has_more:false,next_cursor:null,private:'PRIVATE_DIAGNOSTIC'});
  if(path.includes('/commands/'))return Response.json({...view,command_id:command,private:'PRIVATE_DIAGNOSTIC'});
  return Response.json({...view,private:'PRIVATE_DIAGNOSTIC'});
 }});
 const get=path=>f.gateway(new Request('https://gateway.synthetic.invalid/v1/fiscal-signed'+path,{headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890'}}),f.env);
 assert.equal((await body(await get('/candidates/'+candidate),200)).candidate_id,candidate);
 assert.equal((await body(await get('/commands/'+command),200)).command_id,command);
 const history=await body(await f.send(`/jobs/${view.unsigned_job_id}/history`,{limit:25,before:null}),200);assert.equal(history.items.length,1);assert.equal(Object.hasOwn(history,'signed'),false);
 const mismatch=await body(await get('/candidates/'+randomUUID()),502);assert.equal(mismatch.recovery_required,false);
});
test('client abort stops a forwarded run and cancels an eventual late response without returning its body',async()=>{
 let entered,finish,cancelled=false;const waiting=new Promise(resolve=>{entered=resolve;});
 const f=fixture({upstream:()=>{entered();return new Promise(resolve=>{finish=resolve;});}}),controller=new AbortController();
 const pending=f.send('/run',payload(),{signal:controller.signal});await waiting;controller.abort();
 assert.equal((await body(await pending,503)).recovery_required,true);
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
});
