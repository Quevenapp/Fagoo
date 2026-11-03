import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthorizationRuntimeHandler} from '../src/handler.mjs';
import {createAuthorizationGateway} from '../src/gateway.mjs';
import {dispatchService} from './dispatch-fixtures.mjs';
import {dispatchRoute,captureDispatchInput,dispatchBinding,isDispatchMutation} from '../src/dispatch-protocol.mjs';
import {projectDispatchPublic} from '../src/dispatch-public-dto.mjs';
import {actor,secret,keyId,audience,internal,external,env,service,deferred,bounded} from './fixtures.mjs';
import {closureBody,closureResult} from './closure-fixtures.mjs';
const query={authorization_command_id:closureBody.authorization_command_id,expected_attempt_id:closureBody.expected_attempt_id};
const path=`/reviewed/commands/${query.authorization_command_id}/attempts/${query.expected_attempt_id}/closure`;
function setup(lookup=async()=>closureResult(true)){
 const calls=[];const handler=createAuthorizationRuntimeHandler({service:service(),dispatch:{service:dispatchService({closureLookup:async(...args)=>{calls.push(args);return lookup(...args);}}),readAccess:async()=>{throw Error('RPC must authorize current role');},enabled:false},transportSecret:secret,transportKeyId:keyId,audience});
 const gateway=createAuthorizationGateway({fetchImpl:async()=>Response.json({id:actor,role:'admin'}),now:Date.now,nonce:randomUUID}),environment={...env(),FISCAL_AUTHORIZATION_REVIEWED_ENABLED:'false',A1_RUNTIME:{fetch:r=>handler(new Request('http://runtime.internal'+new URL(r.url).pathname,r))}};
 return{calls,handler,gateway,environment,close:()=>handler.dispose()};
}
test('075 exact GET discovery binds both path IDs, has no input body, and remains nonmutating',()=>{
 const prefix='/internal/v1/fiscal-authorization',route=dispatchRoute(prefix+path,'GET',prefix);assert.equal(route.action,'dispatchClosureLookup');assert.equal(route.limit,0);assert.equal(route.responseLimit,16384);assert.equal(isDispatchMutation(route.action),false);
 assert.deepEqual(captureDispatchInput(route.action,{}),{});assert.deepEqual(dispatchBinding(route,{}),{action:'closureLookup',input:query});assert.deepEqual(projectDispatchPublic(closureResult(true),dispatchBinding(route,{})),closureResult(true));
 for(const extra of[{actor},{command_id:randomUUID()},{request_hash:'a'.repeat(64)}])assert.throws(()=>captureDispatchInput(route.action,extra));
 for(const method of['POST','PUT','DELETE'])assert.throws(()=>dispatchRoute(prefix+path,method,prefix));for(const bad of[path+'/',path.replace(query.expected_attempt_id,'invalid'),path.replace('/attempts/','/attempt/')])assert.throws(()=>dispatchRoute(prefix+bad,'GET',prefix));
});
test('075 gateway HMAC runtime with both gates false invokes only the lookup and returns the discovered closure',async()=>{
 const f=setup();try{const r=await f.gateway(external(path),f.environment);assert.equal(r.status,200,await r.clone().text());assert.deepEqual(await r.json(),closureResult(true));assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0][0],{actor,authorizationCommandId:query.authorization_command_id,expectedAttemptId:query.expected_attempt_id});assert.ok(f.calls[0][1].signal instanceof AbortSignal);}finally{f.close();}
});
test('075 session, origin and HMAC path binding reject before lookup without a browser actor',async()=>{
 const f=setup();try{const absent=external(path);absent.headers.delete('Authorization');assert.equal((await f.gateway(absent,f.environment)).status,401);const origin=external(path);origin.headers.set('Origin','https://evil.invalid');assert.equal((await f.gateway(origin,f.environment)).status,403);
 const signed=await internal(path),otherPath=path.replace(query.expected_attempt_id,randomUUID()),changed=new Request('http://runtime.internal/internal/v1/fiscal-authorization'+otherPath,{headers:signed.headers});assert.equal((await f.handler(changed)).status,401);
 assert.equal((await f.gateway(external(path+'?actor='+actor),f.environment)).status,400);assert.equal((await f.gateway(external(path,{}),f.environment)).status,405);assert.equal(f.calls.length,0);}finally{f.close();}
});
test('075 authoritative absence/ACL/CAS are readonly errors, with no invented closure UUID or retry',async()=>{
 for(const [code,status]of[['P0002',404],['42501',403],['40001',409],['22023',400]]){const f=setup(async()=>{throw Object.assign(Error('PRIVATE_UPSTREAM'),{code});});try{const r=await f.gateway(external(path),f.environment);assert.equal(r.status,status);const v=await r.json();assert.equal(v.recovery_required,false);assert.equal(Object.hasOwn(v,'command_id'),false);assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);assert.equal(f.calls.length,1);}finally{f.close();}}
});
test('075 rejects a different original/attempt, private hash, nonreadonly receipt, and unexpected fields',async()=>{
 for(const alter of[v=>v.receipt.authorization_command_id=randomUUID(),v=>v.receipt.attempt_id=randomUUID(),v=>v.receipt.request_hash='a'.repeat(64),v=>v.read_only=false,v=>v.private_key='PRIVATE']){const f=setup(async()=>{const v=closureResult(true);alter(v);return v;});try{const r=await f.gateway(external(path),f.environment);assert.equal(r.status,502);assert.equal((await r.json()).recovery_required,false);assert.equal(f.calls.length,1);}finally{f.close();}}
});
test('075 abort during lookup does not retry or mark a mutation uncertain',async()=>{
 const gate=deferred(),entered=deferred(),f=setup(async()=>{entered.resolve();await gate.promise;return closureResult(true);}),stop=new AbortController();try{const pending=f.handler(await internal(path,undefined,{signal:stop.signal}));await entered.promise;stop.abort();const r=await bounded(pending);assert.equal(r.status,503);assert.equal((await r.json()).recovery_required,false);gate.resolve();assert.equal(f.calls.length,1);}finally{gate.resolve();f.close();}
});
