import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {route,parsePayload} from '../src/protocol.mjs';
import {isMutationAction,mutationPath} from '../src/review-protocol.mjs';
import {actor,secret,keyId,audience,internal,external,env,service,deferred,bounded} from './fixtures.mjs';
import {publicContext,publicHistory,publicResult,publicSelection,contextBinding,uuid} from '../../fiscal-authorization/test/receipt-query-public-fixture.mjs';
const run={...publicSelection(),command_id:uuid(11),confirmed:true};
const contextInput=contextBinding(publicContext()).input,historyInput=publicHistory().binding.input;
const contextPath='/reviewed/receipt-query-context',historyPath='/reviewed/receipt-query-history',runPath='/reviewed/receipt-queries',commandPath='/reviewed/receipt-query-commands/'+run.command_id,recoverPath=commandPath+'/recover';
function setup(overrides={}){
 const calls=[],port={context:async()=>publicContext({canQuery:false}),history:async()=>publicHistory().raw,run:async()=>publicResult({readOnly:false}),command:async()=>publicResult(),recover:async()=>publicResult({readOnly:false}),...overrides};
 const wrapped=Object.fromEntries(Object.entries(port).map(([name,fn])=>[name,async(...args)=>{calls.push({name,args});return fn(...args);}]))
 const handler=createAuthorizationRuntimeHandler({service:service(),receiptQueryService:wrapped,transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor}),now:Date.now,nonce:randomUUID});
 const environment={...env(),FISCAL_RECEIPT_QUERY_ENABLED:'false',FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',FISCAL_PROTOCOL_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
 return{calls,handler,gateway,environment,close:()=>handler.dispose()};
}
test('089 registered routes classify context/history POST as read-only at both bridge and runtime',()=>{
 for(const[path,method,action,input,mutation]of[[contextPath,'POST','receiptQueryContext',contextInput,false],[historyPath,'POST','receiptQueryHistory',historyInput,false],[runPath,'POST','receiptQueryRun',run,true],[commandPath,'GET','receiptQueryCommand',undefined,false],[recoverPath,'POST','receiptQueryRecover',{confirmed:true},true]]){
  const p='/internal/v1/fiscal-authorization'+path,r=route(p,method);assert.equal(r.action,action);assert.equal(isMutationAction(action),mutation);assert.equal(mutationPath(p,method),mutation);assert.deepEqual(parsePayload(new TextEncoder().encode(input===undefined?'':JSON.stringify(input)),r),input??{});
 }
});
test('089 session/HMAC reads and local recovery remain usable with all emission/query flags closed',async()=>{
 const f=setup();try{
  for(const[path,input]of[[contextPath,contextInput],[historyPath,historyInput],[commandPath,undefined],[recoverPath,{confirmed:true}]]){
   const r=await f.gateway(external(path,input),f.environment);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).can_transmit,false);
  }
  assert.deepEqual(f.calls.map(x=>x.name),['context','history','command','recover']);
  for(const call of f.calls){assert.ok(Object.isFrozen(call.args[0]));assert.equal(call.args[0].actor,actor);assert.ok(call.args[1].signal instanceof AbortSignal);assert.ok(Number.isSafeInteger(call.args[1].deadline));}
 }finally{f.close();}
});
test('089 new consultation requires its own exact flag and never uses emission flags',async()=>{
 for(const flag of[undefined,'false','TRUE',true,'true']){const f=setup();try{
  if(flag===undefined)delete f.environment.FISCAL_RECEIPT_QUERY_ENABLED;else f.environment.FISCAL_RECEIPT_QUERY_ENABLED=flag;
  const r=await f.gateway(external(runPath,run),f.environment);assert.equal(r.status,flag==='true'?200:503);assert.equal(f.calls.length,flag==='true'?1:0);
  const v=await r.json();if(flag!=='true'){assert.equal(v.recovery_required,false);assert.equal(v.command_id,run.command_id);}else assert.equal(v.receipt.query_id,run.command_id);
 }finally{f.close();}}
});
test('089 HMAC binds read bodies, mutation bodies, command paths, actor and method before service',async()=>{
 const f=setup();f.environment.FISCAL_RECEIPT_QUERY_ENABLED='true';try{
  const missing=external(contextPath,contextInput);missing.headers.delete('Authorization');assert.equal((await f.gateway(missing,f.environment)).status,401);
  const hostile=external(runPath,run);hostile.headers.set('Origin','https://evil.invalid');assert.equal((await f.gateway(hostile,f.environment)).status,403);
  assert.equal((await f.gateway(external(historyPath+'?actor='+actor,historyInput),f.environment)).status,400);
  for(const[path,input,change]of[[contextPath,contextInput,{source_command_id:uuid(999)}],[historyPath,historyInput,{limit:24}],[runPath,run,{expected_chain_hash:'e'.repeat(64)}],[recoverPath,{confirmed:true},{confirmed:false}]]){
   const signed=await internal(path,input),changed=new Request(signed.url,{method:'POST',headers:signed.headers,body:JSON.stringify({...input,...change})});assert.equal((await f.handler(changed)).status,401);
  }
  const signed=await internal(commandPath);assert.equal((await f.handler(new Request(signed.url.replace(run.command_id,uuid(998)),{headers:signed.headers}))).status,401);
  assert.equal(f.calls.length,0);
 }finally{f.close();}
});
test('089 failed reads stay read-only and uncertain run/recovery preserve command for GET',async()=>{
 for(const[path,input,name,mutation]of[[contextPath,contextInput,'context',false],[historyPath,historyInput,'history',false],[commandPath,undefined,'command',false],[runPath,run,'run',true],[recoverPath,{confirmed:true},'recover',true]]){
  const f=setup({[name]:async()=>{throw Error('PRIVATE_SECRET_OR_XML');}});f.environment.FISCAL_RECEIPT_QUERY_ENABLED='true';try{
   const r=await f.gateway(external(path,input),f.environment),v=await r.json();assert.equal(r.status,503);assert.equal(v.recovery_required,mutation);assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);assert.equal(f.calls.length,1);if(mutation)assert.equal(v.command_id,run.command_id);
  }finally{f.close();}
 }
});
test('089 abort after forwarding never retries POST and read abort does not imply a mutation',async()=>{
 for(const[path,input,name,mutation]of[[contextPath,contextInput,'context',false],[runPath,run,'run',true],[recoverPath,{confirmed:true},'recover',true]]){
  const entered=deferred(),gate=deferred(),f=setup({[name]:async()=>{entered.resolve();await gate.promise;return name==='context'?publicContext({canQuery:false}):publicResult({readOnly:false});}}),stop=new AbortController();
  try{const pending=f.handler(await internal(path,input,{signal:stop.signal}));await entered.promise;stop.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,mutation);assert.equal(f.calls.length,1);}finally{gate.resolve();f.close();}
 }
});
test('089 absent service fails before mutation and rejects payload extras before any call',async()=>{
 const handler=createAuthorizationRuntimeHandler({service:service(),transportSecret:secret,transportKeyId:keyId,audience});try{
  const r=await handler(await internal(runPath,run));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'AUTHORIZATION_SERVICE_UNAVAILABLE',recovery_required:false,command_id:run.command_id});
 }finally{handler.dispose();}
 const f=setup();try{for(const extra of[{actor},{receipt_number:'123456789012345'},{url:'https://evil.invalid'},{xml:'PRIVATE'}]){
  const r=await f.gateway(external(contextPath,{...contextInput,...extra}),f.environment);assert.equal(r.status,400);assert.equal((await r.json()).recovery_required,false);
 }assert.equal(f.calls.length,0);}finally{f.close();}
});
