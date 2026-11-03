import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {verifyRuntimeRequest} from '../src/auth.mjs';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {createExecutorDispatch} from '../../../workers/fiscal-executor/src/dispatch.mjs';
import {external,internal,env,secret,keyId,audience,actor,commandId,candidateId,previewBody,runBody,preview,result,service,deferred,bounded} from './fixtures.mjs';
function setup({authReply=()=>Response.json({id:actor}),runtimeReply,methods=service()}={}){
 const calls={auth:0,runtime:0,methods:[]};const wrapped={};for(const[k,fn]of Object.entries(methods))wrapped[k]=async(...args)=>{calls.methods.push(k);return fn(...args);};
 const handler=createAuthorizationRuntimeHandler({service:wrapped,transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async(url,o)=>{calls.auth++;assert.equal(url,env().SUPABASE_URL+'/auth/v1/user');assert.equal(o.redirect,'manual');assert.equal(o.credentials,'omit');return authReply(o);},now:Date.now,nonce:randomUUID});
 const environment={...env(),A1_RUNTIME:{fetch:async request=>{calls.runtime++;assert.equal(request.headers.has('apikey'),false);assert.equal(request.headers.has('cookie'),false);assert.equal(request.redirect,'manual');const path=new URL(request.url).pathname;const claim=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:secret,keyId,audience,method:request.method,path});assert.equal(claim.actor,actor);return runtimeReply?runtimeReply(request):handler(new Request('http://runtime.internal'+path,request));}}};
 return{calls,handler,environment,request:(...args)=>gateway(external(...args),environment),gateway};
}
test('gateway authenticates session and transports exact preview/command/history within its own HMAC domain',async()=>{
 const f=setup();try{for(const[path,body]of [['/preview',previewBody],['/commands/'+commandId,undefined],[`/candidates/${candidateId}/history`,{limit:25,before:null}]]){const r=await f.request(path,body);assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'https://app.synthetic.invalid');assert.equal((await r.json()).can_transmit,false);}assert.deepEqual(f.calls,{auth:3,runtime:3,methods:['preview','command','history']});}finally{f.handler.dispose();}
});
test('run returns503 after session validation with no private binding or service call',async()=>{
 const f=setup();try{const r=await f.request('/run',runBody);assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE',recovery_required:false,command_id:commandId});assert.deepEqual(f.calls,{auth:1,runtime:0,methods:[]});}finally{f.handler.dispose();}
});
test('anonymous or missing session, disallowed origin/method and malformed body cannot reach runtime',async()=>{
 for(const[authReply,path,body,options,status,count]of [[()=>Response.json({id:actor,is_anonymous:true}),'/preview',previewBody,{},401,1],[undefined,'/preview',previewBody,{headers:{Origin:'https://evil.invalid'}},403,0],[undefined,'/preview',undefined,{},405,0],[undefined,'/preview',previewBody,{headers:{Origin:'https://app.synthetic.invalid'}},401,0],[undefined,'/preview',{...previewBody,actor}, {},400,1]]){
  const f=setup({authReply});try{const r=await f.request(path,body,options);assert.equal(r.status,status);assert.equal(f.calls.runtime,0);assert.equal(f.calls.auth,count);}finally{f.handler.dispose();}
 }
 const f=setup();try{const r=await f.request('/preview',undefined,{method:'OPTIONS',headers:{Origin:'https://app.synthetic.invalid','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Methods'),'POST');assert.equal(f.calls.auth,0);}finally{f.handler.dispose();}
});
test('response redirects, oversized UTF8, private fields and auth redirects are closed without retries',async()=>{
 for(const patch of [{runtimeReply:()=>new Response(null,{status:302,headers:{Location:'https://never.invalid','Content-Type':'application/json'}})},{runtimeReply:()=>Response.json({...preview(),private_execution:{}})},{runtimeReply:()=>new Response(new Uint8Array(131073),{headers:{'Content-Type':'application/json'}})},{authReply:()=>new Response(null,{status:302,headers:{Location:'https://never.invalid','Content-Type':'application/json'}})}]){
  const f=setup(patch);try{const r=await f.request('/preview',previewBody);assert.ok([413,502].includes(r.status));assert.equal((await r.json()).recovery_required,false);assert.equal(f.calls.auth,1);assert.ok(f.calls.runtime<=1);}finally{f.handler.dispose();}
 }
});
test('gateway captures native Request before Auth await and cancels a late upstream response',async()=>{
 const enter=deferred(),release=deferred();const f=setup({authReply:async()=>{enter.resolve();await release.promise;return Response.json({id:actor});}});
 const req=external('/preview',previewBody);const pending=f.gateway(req,f.environment);await bounded(enter.promise);Object.defineProperty(req,'method',{get(){throw Error('MUTATED_REQUEST');}});req.headers.set('content-type','text/plain');release.resolve();try{assert.equal((await pending).status,200);}finally{f.handler.dispose();}
 let canceled=0;const entered=deferred(),late=deferred(),abort=new AbortController();const g=setup({runtimeReply:async()=>{entered.resolve();return late.promise;}});const work=g.request('/preview',previewBody,{signal:abort.signal});await bounded(entered.promise);abort.abort();assert.equal((await bounded(work)).status,503);late.resolve(new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{'Content-Type':'application/json'}}));await new Promise(r=>setTimeout(r,10));assert.equal(canceled,1);g.handler.dispose();
});
test('recover failure keeps command identity, never calls run, and does not auto resend',async()=>{
 const f=setup({runtimeReply:()=>Response.json({error:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE',recovery_required:true,command_id:commandId},{status:503})});try{const r=await f.request('/recover',{command_id:commandId});assert.equal(r.status,503);assert.equal((await r.json()).command_id,commandId);assert.deepEqual(f.calls,{auth:1,runtime:1,methods:[]});}finally{f.handler.dispose();}
});
test('real gateway → executor dispatch → container bridge → handler retains domain and starts only after auth',async()=>{
 const runtime=createAuthorizationRuntimeHandler({service:service(),transportSecret:secret,transportKeyId:keyId,audience});let starts=0,forwards=0;const container={running:false,images:{base:'synthetic'},start(){starts++;this.running=true;},async setInactivityTimeout(){},getTcpPort(){return{fetch:async(input,options)=>{
  if(typeof input==='string'){assert.equal(input,'http://container/internal/v1/a1');return new Response(null,{status:401,headers:{'x-content-type-options':'nosniff'}});}
  forwards++;return runtime(new Request('http://runtime.internal'+new URL(input.url).pathname,input));
 }}}};
 const environment={...env(),SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',A1_FINGERPRINT_SECRET:'synthetic-fingerprint',A1_KEK_RING_JSON:'synthetic-ring',A1_CURRENT_KEK_ID:'synthetic-kek'};
 const bridge=createContainerBridge({container},environment,{wait:async()=>{},diagnostic:()=>{}}),dispatch=createExecutorDispatch({fetchImpl:()=>{throw Error('UNSIGNED_FORBIDDEN');}});
 environment.A1_CONTAINER={getByName:name=>{assert.equal(name,'a1-custody-v1');return{fetch:bridge};}};environment.A1_RUNTIME={fetch:request=>dispatch(request,environment)};
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID});
 try{assert.equal((await bridge(new Request('https://fiscal-runtime.internal/internal/v1/fiscal-authorization/commands/'+commandId))).status,401);assert.equal(starts,0);
  const authentic=await internal('/commands/'+commandId,undefined,{origin:'https://fiscal-runtime.internal'}),[scheme,token]=authentic.headers.get('authorization').split(' '),[id,encoded]=token.split('.');
  for(const domain of ['a1','signed','wsdl','reconciliation','danfe','unsigned']){
   const mac=createHmac('sha256',secret).update(`brufap-${domain}-request-v1.${id}.${encoded}`).digest('hex');
   assert.equal((await bridge(new Request(authentic.url,{headers:{Authorization:`${scheme} ${id}.${encoded}.${mac}`}}))).status,401);
  }
  assert.equal(starts,0);
  const r=await gateway(external('/commands/'+commandId),environment);assert.equal(r.status,200);assert.deepEqual(await r.json(),result());assert.equal(starts,1);assert.equal(forwards,1);
  const noRoute=await dispatch(new Request('https://fiscal-runtime.internal/internal/v1/fiscal-authorization/unknown'),{A1_CONTAINER:{getByName(){throw Error('private');}}});assert.equal((await noRoute.json()).error,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');
 }finally{runtime.dispose();}
});
test('gateway total60s refuses late upstream success inside the65s client budget',async t=>{
 const realNow=Date.now;let clock=realNow();t.mock.method(Date,'now',()=>clock);const f=setup({runtimeReply:async()=>{clock+=60001;return Response.json(preview());}});try{const r=await f.request('/preview',previewBody);assert.equal(r.status,503);assert.equal(f.calls.runtime,1);assert.equal((await r.json()).recovery_required,false);}finally{f.handler.dispose();}
});
