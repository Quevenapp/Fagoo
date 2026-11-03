import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {dispatchService} from './dispatch-fixtures.mjs';
import {dispatchRoute,captureDispatchInput,dispatchBinding} from '../src/dispatch-protocol.mjs';
import {projectDispatchPublic,FLAGS} from '../src/dispatch-public-dto.mjs';
import {isMutationAction,mutationPath} from '../src/review-protocol.mjs';
import {actor,candidateId,commandId,secret,keyId,audience,internal,external,env,service,deferred,bounded} from './fixtures.mjs';
import {closureBody as body,closureResult as value} from './closure-fixtures.mjs';
function setup(overrides={}){
 const calls=[],actual={closeExpired:async()=>value(),closureCommand:async()=>value(true),...overrides};
 const tracked=Object.fromEntries(Object.entries(actual).map(([k,fn])=>[k,async(...args)=>{calls.push([k,...args]);return fn(...args);} ]));
 const handler=createAuthorizationRuntimeHandler({service:service(),dispatch:{service:dispatchService(tracked),readAccess:async()=>{throw Error('must use RPC ACL');},enabled:false},transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor,role:'admin'}),now:Date.now,nonce:randomUUID}),environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
 return{calls,handler,gateway,environment,close:()=>handler.dispose()};
}
test('074 dedicated closed routes and limits, no browser hash/actor/aliases',()=>{
 const prefix='/internal/v1/fiscal-authorization',selected=dispatchRoute(prefix+'/reviewed/close-expired','POST',prefix);assert.equal(selected.limit,4096);assert.equal(selected.responseLimit,16384);assert.equal(dispatchRoute(prefix+`/reviewed/closure-commands/${body.command_id}`,'GET',prefix).responseLimit,16384);assert.equal(dispatchRoute(prefix+'/reviewed/status','GET',prefix).responseLimit,262144);
 assert.deepEqual(captureDispatchInput(selected.action,body),body);assert.deepEqual(dispatchBinding(selected,body),{action:'closeExpired',commandId:body.command_id,input:body});assert.equal(isMutationAction(selected.action),true);assert.equal(mutationPath(prefix+'/reviewed/close-expired','POST'),true);assert.equal(isMutationAction('dispatchClosureCommand'),false);
 for(const patch of[{actor},{request_hash:'a'.repeat(64)},{original_command_id:commandId},{attempt_id:body.expected_attempt_id},{confirmed:false},{expected_state:'dispatched'}])assert.throws(()=>captureDispatchInput(selected.action,{...body,...patch}));
 assert.throws(()=>dispatchRoute(prefix+'/reviewed/close-expired','GET',prefix));assert.throws(()=>dispatchRoute(prefix+`/reviewed/closure-commands/${body.command_id}`,'POST',prefix));
});
test('074 public DTO binds original command/attempt/state, omits private hash and never authorizes effects',()=>{
 assert.deepEqual(projectDispatchPublic(value(),{action:'closeExpired',commandId:body.command_id,input:body}),value());
 for(const change of[v=>v.can_transmit=true,v=>v.receipt.request_hash='a'.repeat(64),v=>v.receipt.attempt_id=randomUUID(),v=>v.receipt.previous_state='prepared',v=>v.current.grant_consumed=true,v=>v.current.intent_consumed=true,v=>v.current.finished_at='2026-10-16T12:03:00Z',v=>v.receipt.closed_at='2026-10-16T11:59:00Z',v=>v.execution={}]){const v=value();change(v);assert.throws(()=>projectDispatchPublic(v,{action:'closeExpired',commandId:body.command_id,input:body}));}
 let gets=0;const v=value();Object.defineProperty(v.receipt,'candidate_id',{enumerable:true,get(){gets++;return candidateId;}});assert.throws(()=>projectDispatchPublic(v,{action:'closeExpired',commandId:body.command_id,input:body}));assert.equal(gets,0);
});
test('074 close and command remain usable with both runtime/gateway gates false',async()=>{
 const f=setup();try{const r=await f.gateway(external('/reviewed/close-expired',body),f.environment);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),value());assert.deepEqual(f.calls[0][1],{actor,request:body});const read=await f.gateway(external(`/reviewed/closure-commands/${body.command_id}`),f.environment);assert.equal(read.status,200);assert.deepEqual(await read.json(),value(true));assert.deepEqual(f.calls.map(c=>c[0]),['closeExpired','closureCommand']);}finally{f.close();}
});
test('074 CSRF, missing session and HMAC body/path changes reject before service',async()=>{
 const f=setup();try{
  const csrf=external('/reviewed/close-expired',body);csrf.headers.set('Origin','https://evil.invalid');assert.equal((await f.gateway(csrf,f.environment)).status,403);
  const noSession=external('/reviewed/close-expired',body);noSession.headers.delete('Authorization');assert.equal((await f.gateway(noSession,f.environment)).status,401);
  const original=await internal('/reviewed/close-expired',body),changed=new Request(original.url,{method:'POST',headers:original.headers,body:JSON.stringify({...body,expected_attempt_id:randomUUID()})});assert.equal((await f.handler(changed)).status,401);
  const other=await internal('/reviewed/recover',{command_id:body.command_id});assert.equal((await f.handler(new Request(original.url,{method:'POST',headers:other.headers,body:JSON.stringify(body)}))).status,401);assert.equal(f.calls.length,0);
 }finally{f.close();}
});
test('074 definitive SQL failures stay definitive and lost ACK preserves closure UUID without retry',async()=>{
 for(const [code,status]of[['42501',403],['40001',409],['P0002',404],['22023',400]]){const f=setup({closeExpired:async()=>{throw Object.assign(Error('PRIVATE'),{code});}});try{const r=await f.gateway(external('/reviewed/close-expired',body),f.environment);assert.equal(r.status,status);assert.deepEqual(await r.json(),{error:code==='42501'?'AUTHORIZATION_FORBIDDEN':code==='40001'?'AUTHORIZATION_CONFLICT':code==='P0002'?'AUTHORIZATION_NOT_FOUND':'AUTHORIZATION_INVALID_REQUEST',recovery_required:false,command_id:body.command_id});}finally{f.close();}}
 const f=setup({closeExpired:async()=>{throw Error('PRIVATE_LOST_COMMIT_ACK');}});try{const r=await f.gateway(external('/reviewed/close-expired',body),f.environment);assert.equal(r.status,503);const b=await r.json();assert.equal(b.command_id,body.command_id);assert.equal(b.recovery_required,true);assert.doesNotMatch(JSON.stringify(b),/PRIVATE/);assert.equal((await f.gateway(external(`/reviewed/closure-commands/${body.command_id}`),f.environment)).status,200);assert.deepEqual(f.calls.map(c=>c[0]),['closeExpired','closureCommand']);}finally{f.close();}
});
test('074 malformed result after close is uncertain; command404 is only a read',async()=>{
 const f=setup({closeExpired:async()=>({...value(),private_key:'PRIVATE'}),closureCommand:async()=>{throw Object.assign(Error('PRIVATE'),{code:'P0002'});}});try{const r=await f.gateway(external('/reviewed/close-expired',body),f.environment);assert.equal(r.status,502);assert.equal((await r.json()).recovery_required,true);const read=await f.gateway(external(`/reviewed/closure-commands/${body.command_id}`),f.environment);assert.equal(read.status,404);assert.equal((await read.json()).recovery_required,false);assert.equal(f.calls.length,2);}finally{f.close();}
});
test('074 abort after dispatch preserves the UUID and does not retry a late closure result',async()=>{
 const entered=deferred(),gate=deferred(),f=setup({closeExpired:async()=>{entered.resolve();await gate.promise;return value();}}),abort=new AbortController();try{const pending=f.handler(await internal('/reviewed/close-expired',body,{signal:abort.signal}));await entered.promise;abort.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,true);gate.resolve();assert.equal(f.calls.length,1);}finally{gate.resolve();f.close();}
});
