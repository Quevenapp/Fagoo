import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createWsdlGateway} from '../src/gateway.mjs';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {payload,result,unconfirmed,command} from './fixtures.mjs';
const ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co';
function fixture({auth,upstream,env:overrides}={}){
 const actor=randomUUID(),key=randomBytes(32),calls={auth:0,runtime:0};
 const env={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:key.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime',
  A1_RUNTIME:{async fetch(request){calls.runtime++;return upstream?upstream(request):Response.json(unconfirmed(await request.json()));}},...overrides};
 const gateway=createWsdlGateway({now:Date.now,nonce:randomUUID,fetchImpl:async(url,options)=>{
  calls.auth++;assert.equal(url,PROJECT+'/auth/v1/user');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');
  assert.equal(options.headers.Authorization,'Bearer synthetic-user-session-1234567890');assert.equal(options.headers.apikey,env.SUPABASE_ANON_KEY);
  return auth?auth(url,options):Response.json({id:actor,is_anonymous:false});
 }});
 const request=(path='/run',value=payload(),options={})=>new Request('https://gateway.synthetic.invalid/v1/fiscal-wsdl'+path,{
  method:options.method??'POST',headers:{Origin:ORIGIN,Authorization:'Bearer synthetic-user-session-1234567890',...(options.method==='GET'?{}:{'Content-Type':'application/json'}),...options.headers},
  ...(options.method==='GET'?{}:{body:options.raw??JSON.stringify(value)}),signal:options.signal});
 return{actor,key,calls,env,request,gateway,send:(path,value,options)=>gateway(request(path,value,options),env)};
}
async function body(r,status){assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');const v=await r.json();assert.doesNotMatch(JSON.stringify(v),/PRIVATE_DIAGNOSTIC|credential_id|fingerprint|lease_id|issuer_cnpj|<NFe|Bearer|evidence.*tls/);return v;}
test('gateway authenticates the session and binds a WSDL-only request without forwarding Auth credentials',async()=>{
 let f;f=fixture({upstream:async request=>{
  assert.equal(request.url,'https://fiscal-runtime.internal/internal/v1/fiscal-wsdl/run');assert.equal(request.redirect,'manual');assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);
  const bytes=new Uint8Array(await request.arrayBuffer()),p=JSON.parse(new TextDecoder().decode(bytes));
  const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:f.key,keyId:'synthetic-key',audience:'synthetic-runtime-wsdl',method:'POST',path:new URL(request.url).pathname});
  assert.equal(claims.actor,f.actor);assert.equal(claims.body_hash,await digest(bytes));return Response.json(unconfirmed(p));
 }});
 const p=payload(),r=await f.send('/run',p),v=await body(r,200);assert.equal(v.command_id,p.command_id);assert.equal(v.recovery_required,true);assert.equal(r.headers.get('access-control-allow-origin'),ORIGIN);assert.deepEqual(f.calls,{auth:1,runtime:1});
});
test('CORS, path, method, input confirmation and payload limits fail before runtime admission',async()=>{
 const f=fixture(),preflight=new Request('https://gateway.synthetic.invalid/v1/fiscal-wsdl/run',{method:'OPTIONS',headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
 assert.equal((await f.gateway(preflight,f.env)).status,204);assert.deepEqual(f.calls,{auth:0,runtime:0});
 for(const [path,p,opts,status]of[
  ['/run',payload(),{headers:{Origin:'https://different.invalid'}},403],['/run?x=1',payload(),{},400],['/run#x',payload(),{},400],['/download',payload(),{},404],
  ['/run',payload(),{headers:{Authorization:'Bearer short'}},401],['/run',{...payload(),actor:randomUUID()},{},400],['/run',{...payload(),confirmed:false},{},400],
  ['/run',payload(),{raw:'x'.repeat(4097)},413],['/run',payload(),{headers:{'Content-Encoding':'gzip'}},400],['/run',payload(),{headers:{'Content-Type':'application/xml'}},415],
 ])assert.equal((await body(await f.send(path,p,opts),status)).recovery_required,false);
 assert.equal(f.calls.runtime,0);
});
test('Auth rejects anonymous or invalid sessions and refuses redirect without reaching the runtime',async()=>{
 for(const [auth,status]of[
  [()=>Response.json({id:randomUUID(),is_anonymous:true}),401],[()=>Response.json({id:'invalid'}),401],
  [()=>Response.json({error:'PRIVATE_DIAGNOSTIC'},{status:403}),401],[()=>new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}),502],
 ]){const f=fixture({auth});assert.equal((await body(await f.send(),status)).recovery_required,false);assert.deepEqual(f.calls,{auth:1,runtime:0});}
});
test('uncertain dispatch preserves command recovery and returns only approved runtime errors',async()=>{
 for(const upstream of [()=>{throw Error('PRIVATE_DIAGNOSTIC');},()=>new Response(null,{status:307,headers:{Location:'https://never-follow.invalid'}}),()=>Response.json({secret:'PRIVATE_DIAGNOSTIC'}),()=>new Response('x'.repeat(131073),{headers:{'Content-Type':'application/json'}})]){
  const f=fixture({upstream}),r=await f.send(),v=await body(r,r.status);assert.ok(r.status>=500);assert.equal(v.recovery_required,true);assert.equal(f.calls.runtime,1);
 }
 const f=fixture({upstream:()=>Response.json({error:'WSDL_CONFLICT',recovery_required:true,diagnostic:'PRIVATE_DIAGNOSTIC'},{status:409})});assert.deepEqual(await body(await f.send(),409),{error:'WSDL_CONFLICT',recovery_required:true});
 const bad=fixture({upstream:()=>Response.json({error:'PRIVATE_DIAGNOSTIC',recovery_required:false},{status:400})});assert.equal((await body(await bad.send(),502)).recovery_required,true);
});
test('command lookup binds UUID, strips private extras and cannot create a new GET WSDL',async()=>{
 const f=fixture({upstream:request=>{assert.equal(request.method,'GET');const raw=result('stored',payload(),true);raw.execution={credential_id:'PRIVATE_DIAGNOSTIC'};raw.artifact.evidence={fingerprint:'PRIVATE_DIAGNOSTIC'};return Response.json(raw);}});
 assert.equal((await body(await f.send('/commands/'+command,undefined,{method:'GET'}),200)).status,'stored');
 const v=await body(await f.send('/commands/'+randomUUID(),undefined,{method:'GET'}),502);assert.equal(v.recovery_required,false);
});
test('abort after dispatch returns uncertain and cancels a late body, without automatic retry',async()=>{
 let entered,finish,cancelled=false;const ready=new Promise(resolve=>{entered=resolve;});
 const f=fixture({upstream:()=>{entered();return new Promise(resolve=>{finish=resolve;});}}),controller=new AbortController();
 const pending=f.send('/run',payload(),{signal:controller.signal});await ready;controller.abort();assert.equal((await body(await pending,503)).recovery_required,true);
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}}));await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.equal(f.calls.runtime,1);
});
