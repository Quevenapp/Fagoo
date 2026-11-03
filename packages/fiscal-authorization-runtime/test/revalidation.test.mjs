import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {route,parsePayload} from '../src/protocol.mjs';
import {revalidationBinding} from '../src/revalidation-protocol.mjs';
import {isMutationAction,mutationPath} from '../src/review-protocol.mjs';
import {actor,secret,keyId,audience,internal,external,env,service,deferred,bounded} from './fixtures.mjs';
import {revalidationBody as body,contextPath,runPath,commandPath,revalidationContext as context,revalidationResult as result,revalidationService} from './revalidation-fixtures.mjs';

function setup(overrides={}){
 const calls=[],port=revalidationService(overrides),wrapped=Object.fromEntries(Object.entries(port).map(([name,fn])=>[name,async(...args)=>{calls.push({name,args});return fn(...args);}]));
 const handler=createAuthorizationRuntimeHandler({service:service(),revalidationService:wrapped,transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID});
 const environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',FISCAL_PROTOCOL_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
 return{calls,handler,gateway,environment,close:()=>handler.dispose()};
}

test('079 exact routes bind both historical IDs and classify only revalidation POST as a mutation',()=>{
 const prefix='/internal/v1/fiscal-authorization';
 for(const[path,method,action]of[[contextPath,'GET','revalidationContext'],[runPath,'POST','revalidationRun'],[commandPath,'GET','revalidationCommand']]){
  const r=route(prefix+path,method);assert.equal(r.action,action);assert.equal(r.revalidation,true);assert.equal(r.dispatch,undefined);
  assert.equal(isMutationAction(action),method==='POST');assert.equal(mutationPath(prefix+path,method),method==='POST');
  assert.throws(()=>route(prefix+path,method==='POST'?'GET':'POST'),e=>e.status===405);
  assert.throws(()=>route(prefix+path+'/','GET'),e=>e.status===404);
 }
 const r=route(prefix+contextPath,'GET');assert.deepEqual(revalidationBinding(r,parsePayload(new Uint8Array(),r)),{action:'revalidationContext',authorizationCommandId:body.authorization_command_id,expectedAttemptId:body.expected_attempt_id});
 assert.throws(()=>parsePayload(new TextEncoder().encode('{}'),r));
 const p=route(prefix+runPath,'POST');for(const extra of[{actor},{xml:'PRIVATE'},{confirmed:false},{command_id:body.authorization_command_id}])assert.throws(()=>parsePayload(new TextEncoder().encode(JSON.stringify({...body,...extra})),p),e=>e.status===400);
});

test('079 session/HMAC chain works with both fiscal flags false and calls only selected historical ports',async()=>{
 const f=setup();try{
  for(const[path,input,expected]of[[contextPath,undefined,context()],[runPath,body,result(false)],[commandPath,undefined,result()]]){
   const r=await f.gateway(external(path,input),f.environment);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),expected);
  }
  assert.deepEqual(f.calls.map(x=>x.name),['context','revalidate','command']);
  assert.deepEqual(f.calls[0].args[0],{actor,authorizationCommandId:body.authorization_command_id,expectedAttemptId:body.expected_attempt_id});
  assert.deepEqual(f.calls[1].args[0],{actor,request:body});assert.deepEqual(f.calls[2].args[0],{actor,commandId:body.command_id});
  for(const call of f.calls){assert.ok(Object.isFrozen(call.args[0]));assert.ok(call.args[1].signal instanceof AbortSignal);assert.ok(Number.isSafeInteger(call.args[1].deadline));}
 }finally{f.close();}
});

test('079 missing session, hostile origin, query actor, changed path and changed signed body never enter service',async()=>{
 const f=setup();try{
  const absent=external(contextPath);absent.headers.delete('Authorization');assert.equal((await f.gateway(absent,f.environment)).status,401);
  const hostile=external(runPath,body);hostile.headers.set('Origin','https://evil.invalid');assert.equal((await f.gateway(hostile,f.environment)).status,403);
  assert.equal((await f.gateway(external(contextPath+'?actor='+actor),f.environment)).status,400);
  for(const replaced of[body.authorization_command_id,body.expected_attempt_id]){
   const signed=await internal(contextPath),changed=new Request('http://runtime.internal/internal/v1/fiscal-authorization'+contextPath.replace(replaced,randomUUID()),{headers:signed.headers});assert.equal((await f.handler(changed)).status,401);
  }
  const signed=await internal(runPath,body),changed=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify({...body,expected_source_hash:'e'.repeat(64)})});assert.equal((await f.handler(changed)).status,401);
  assert.equal(f.calls.length,0);
 }finally{f.close();}
});

test('079 read-only lookup discovers existing validation and rejects a cross-source receipt',async()=>{
 for(const bad of[false,true]){const f=setup({context:async()=>{const v=context(result());if(bad)v.existing.receipt.attempt_id=randomUUID();return v;}});try{
  const r=await f.gateway(external(contextPath),f.environment);assert.equal(r.status,bad?502:200);const v=await r.json();if(bad)assert.equal(v.recovery_required,false);else assert.equal(v.existing.receipt.state,'authorized_homologation');assert.equal(f.calls.length,1);
 }finally{f.close();}}
});

test('079 ACL, absence and CAS failures are definitive unless the service says finish was uncertain',async()=>{
 for(const[code,status]of[['42501',403],['P0002',404],['40001',409],['55000',409],['22023',400]])for(const uncertain of[false,true]){
  const f=setup({revalidate:async()=>{throw Object.assign(Error('PRIVATE_UPSTREAM'),{code,...(uncertain?{recovery_required:true}:{})});}});try{
   const r=await f.gateway(external(runPath,body),f.environment);assert.equal(r.status,uncertain?503:status);const v=await r.json();assert.equal(v.recovery_required,uncertain);assert.equal(v.command_id,body.command_id);assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);assert.equal(f.calls.length,1);
  }finally{f.close();}
 }
});

test('079 invalid output after POST retains command and requires GET recovery without another POST',async()=>{
 for(const alter of[v=>v.receipt.attempt_id=randomUUID(),v=>v.receipt.source_hash='e'.repeat(64),v=>v.receipt.artifact.protocol_cstat='999',v=>v.receipt.private_key='PRIVATE',v=>v.can_transmit=true,v=>v.read_only=true]){
  const f=setup({revalidate:async()=>{const v=result(false);alter(v);return v;}});try{
   const r=await f.gateway(external(runPath,body),f.environment);assert.equal(r.status,502);const v=await r.json();assert.equal(v.recovery_required,true);assert.equal(v.command_id,body.command_id);assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);assert.equal(f.calls.length,1);
   const recovery=await f.gateway(external(commandPath),f.environment);assert.equal(recovery.status,200);assert.deepEqual(f.calls.map(c=>c.name),['revalidate','command']);
  }finally{f.close();}
 }
});

test('079 unknown service error is sanitized and readonly failures never advertise uncertain mutation',async()=>{
 for(const[path,input,name]of[[contextPath,undefined,'context'],[commandPath,undefined,'command'],[runPath,body,'revalidate']]){
  const f=setup({[name]:async()=>{throw Error('PRIVATE_SECRET_OR_XML');}});try{const r=await f.gateway(external(path,input),f.environment);assert.equal(r.status,503);const v=await r.json();assert.equal(v.recovery_required,name==='revalidate');assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);assert.equal(f.calls.length,1);}finally{f.close();}
 }
});

test('079 abort after dispatch does not retry; only POST remains uncertain',async()=>{
 for(const[path,input,name]of[[contextPath,undefined,'context'],[runPath,body,'revalidate']]){
  const gate=deferred(),entered=deferred(),f=setup({[name]:async()=>{entered.resolve();await gate.promise;return name==='context'?context():result(false);}}),stop=new AbortController();
  try{const pending=f.handler(await internal(path,input,{signal:stop.signal}));await entered.promise;stop.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,name==='revalidate');gate.resolve();assert.equal(f.calls.length,1);}finally{gate.resolve();f.close();}
 }
});

test('079 missing composition is rejected before the historical mutation is dispatched',async()=>{
 const handler=createAuthorizationRuntimeHandler({service:service(),transportSecret:secret,transportKeyId:keyId,audience});try{const r=await handler(await internal(runPath,body));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_SERVICE_UNAVAILABLE',recovery_required:false,command_id:body.command_id});}finally{handler.dispose();}
});
