import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createUnsignedGateway} from '../../../workers/fiscal-gateway/src/unsigned.mjs';
import {digest,verifyRuntimeRequest} from '../src/auth.mjs';
import {FLAGS} from '../src/dto.mjs';
const ORIGIN='https://app.synthetic.invalid',PROJECT='https://abcdefghijklmnopqrst.supabase.co',TOKEN='Bearer synthetic-user-session-1234567890';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({auth,runtime}={}){
 const actor=randomUUID(),nonce=randomUUID(),secret=randomBytes(32),clock=Date.now(),calls={auth:0,runtime:0,claims:[],bodies:[]};
 const gateway=createUnsignedGateway({fetchImpl:async(url,options)=>{
  calls.auth++;assert.equal(url,PROJECT+'/auth/v1/user');assert.equal(options.headers.Authorization,TOKEN);assert.equal(options.redirect,'manual');assert.ok(options.signal instanceof AbortSignal);
  return auth?auth({url,options,actor,calls}):Response.json({id:actor,is_anonymous:false});
 },now:()=>clock,nonce:()=>nonce});
 const env={ALLOWED_ORIGINS:ORIGIN,SUPABASE_URL:PROJECT,SUPABASE_ANON_KEY:'synthetic-public-anon-key',A1_TRANSPORT_SECRET:secret.toString('base64'),A1_TRANSPORT_KEY_ID:'synthetic-key',A1_AUDIENCE:'synthetic-runtime',
  A1_RUNTIME:{fetch:async request=>{
   calls.runtime++;assert.equal(request.headers.get('apikey'),null);assert.equal(request.headers.get('origin'),null);assert.notEqual(request.headers.get('authorization'),TOKEN);
   const path=new URL(request.url).pathname,claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId:'synthetic-key',audience:'synthetic-runtime-unsigned',method:request.method,path,now:clock});
   const bytes=new Uint8Array(await request.arrayBuffer());assert.equal(claims.actor,actor);assert.equal(claims.body_hash,await digest(bytes));calls.claims.push(claims);
   const body=bytes.length?JSON.parse(new TextDecoder().decode(bytes)):{};calls.bodies.push(body);bytes.fill(0);
   if(runtime)return runtime({request,body,calls,claims});
   if(path.endsWith('/preview'))return Response.json({...FLAGS,status:'checked',draft_id:body.draft_id,completion_version:body.completion_version,basis_hash:'a'.repeat(64),completion_hash:'b'.repeat(64),builder_version:'brufap-business-builder-v1',model:'55',environment:'2',items:1,arithmetic_verified:true,identity_assigned:false,numbering_bound:false,xml_generated:false,pending:[],execution:{xml:'SECRET'}});
   return Response.json({...FLAGS,status:'recoverable',command_id:body.command_id,code:'UNSIGNED_TIMEOUT',phase:'finish',xml_generated:null,outcome:'unconfirmed',storage_operations:3});
  }}};
 const preview={draft_id:randomUUID(),completion_version:1},generate={command_id:randomUUID(),reservation_id:randomUUID(),draft_id:preview.draft_id,completion_version:1,completion_hash:'b'.repeat(64),basis_hash:'a'.repeat(64)};
 const request=(path='/preview',{method='POST',body=preview,headers={},signal}={})=>new Request('https://gateway.synthetic.invalid/v1/fiscal-unsigned'+path,{method,headers:{Origin:ORIGIN,Authorization:TOKEN,...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{}),...(signal?{signal}:{})});
 return{actor,calls,env,gateway,preview,generate,request,close(){secret.fill(0);}};
}
test('gateway authenticates actor, separates HMAC audience/domain, binds bytes and filters private output',async()=>{
 const f=fixture();try{
  const response=await f.gateway(f.request(),f.env),value=await response.json();assert.equal(response.status,200);assert.equal(value.status,'checked');assert.equal(value.execution,undefined);
  assert.equal(response.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  const generated=await f.gateway(f.request('/generate',{body:f.generate}),f.env);assert.equal(generated.status,200);assert.equal((await generated.json()).xml_generated,null);
  assert.equal(f.calls.auth,2);assert.equal(f.calls.runtime,2);assert.equal(f.calls.claims[0].audience,'synthetic-runtime-unsigned');
  assert.deepEqual(f.calls.bodies[1],f.generate);assert.equal(Object.hasOwn(f.calls.bodies[1],'actor'),false);
 }finally{f.close();}
});
test('CORS and strict paths/methods precede Auth; exact preflight never reaches runtime',async()=>{
 const f=fixture();try{
  const preflight=await f.gateway(f.request('/generate',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}}),f.env);assert.equal(preflight.status,204);
  for(const[request,status]of[[f.request('/preview',{headers:{Origin:'https://evil.invalid'}}),403],[f.request('/preview',{method:'DELETE'}),405],[f.request('/preview?x=1'),400],[f.request('/unknown'),404],
   [f.request('/generate',{method:'OPTIONS',headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-actor'}}),403]])assert.equal((await f.gateway(request,f.env)).status,status);
  assert.equal(f.calls.auth,0);assert.equal(f.calls.runtime,0);
 }finally{f.close();}
});
test('missing/anonymous authentication and strict payload failures never forward a command',async()=>{
 for(const auth of[()=>Response.json({id:randomUUID(),is_anonymous:true}),()=>Response.json({message:'private upstream'}, {status:401}),()=>new Response(null,{status:302,headers:{location:'https://never-follow.invalid'}})]){
  const f=fixture({auth});try{const response=await f.gateway(f.request(),f.env);assert.notEqual(response.status,200);assert.equal(f.calls.runtime,0);assert.doesNotMatch(await response.text(),/private upstream|never-follow/);}finally{f.close();}
 }
 const f=fixture();try{
  for(const request of[f.request('/generate',{body:{...f.generate,actor:f.actor}}),f.request('/generate',{body:{...f.generate,identity:{}}}),f.request('/preview',{body:'x'.repeat(4097)}),f.request('/preview',{headers:{'Content-Encoding':'gzip'}}),f.request('/preview',{headers:{'Content-Type':'text/plain'}})])assert.notEqual((await f.gateway(request,f.env)).status,200);
  assert.equal(f.calls.runtime,0);
  const missing=await f.gateway(f.request(),{...f.env,A1_AUDIENCE:undefined});assert.equal(missing.status,503);assert.equal(f.calls.runtime,0);
 }finally{f.close();}
});
test('runtime redirect, encoded or malformed response is closed and generate remains recoverable without automatic resend',async()=>{
 for(const runtime of[()=>new Response(null,{status:302,headers:{location:'https://never-follow.invalid'}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-encoding':'gzip'}}),()=>Response.json({error:'SECRET_RAW_MESSAGE',recovery_required:true},{status:409}),()=>new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}})]){
  const f=fixture({runtime});try{const response=await f.gateway(f.request('/generate',{body:f.generate}),f.env),value=await response.json();assert.ok(response.status>=500);assert.equal(value.recovery_required,true);assert.equal(f.calls.runtime,1);assert.doesNotMatch(JSON.stringify(value),/SECRET_RAW_MESSAGE|never-follow/);}finally{f.close();}
 }
 const f=fixture({runtime:()=>Response.json({error:'UNSIGNED_FORBIDDEN',recovery_required:false},{status:403})});try{const response=await f.gateway(f.request(),f.env);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'UNSIGNED_FORBIDDEN',recovery_required:false});}finally{f.close();}
});
test('request abort during an uncooperative Auth fetch observes both deadline promises without unhandled rejection',async()=>{
 const entered=Promise.withResolvers(),abort=new AbortController();let signal;const errors=[],listener=reason=>errors.push(reason);process.on('unhandledRejection',listener);
 const f=fixture({auth:({options})=>{signal=options.signal;entered.resolve();return new Promise(()=>{});}});
 try{
  const pending=f.gateway(f.request('/preview',{signal:abort.signal}),f.env);await entered.promise;abort.abort();const response=await pending;await tick();
  assert.equal(response.status,503);assert.equal((await response.json()).recovery_required,false);assert.equal(signal.aborted,true);assert.equal(f.calls.runtime,0);assert.deepEqual(errors,[]);
 }finally{process.off('unhandledRejection',listener);f.close();}
});
test('abort during runtime body consumption cancels the partial stream and preserves the generate command for recovery',async()=>{
 const entered=Promise.withResolvers(),abort=new AbortController();let cancelled=false;
 const f=fixture({runtime:()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));entered.resolve();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
 try{
  const pending=f.gateway(f.request('/generate',{body:f.generate,signal:abort.signal}),f.env);await entered.promise;await tick();abort.abort();const response=await pending;await tick();
  assert.equal(response.status,503);assert.equal((await response.json()).recovery_required,true);assert.equal(cancelled,true);assert.equal(f.calls.runtime,1);
 }finally{f.close();}
});
