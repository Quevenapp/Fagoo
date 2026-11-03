import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {closureBody,closureResult} from '../../fiscal-authorization-runtime/test/closure-fixtures.mjs';
import {captureClosureLookupInput,projectClosureLookupPublic} from '../src/closure-lookup-dto.mjs';
import {createAuthorizationClosureLookupService} from '../src/closure-lookup-service.mjs';
import {createAuthorizationClosureLookupRpc,CLOSURE_LOOKUP_RPC} from '../src/closure-lookup-rpc.mjs';
const query={authorization_command_id:closureBody.authorization_command_id,expected_attempt_id:closureBody.expected_attempt_id},actor=randomUUID(),input=()=>({actor,authorizationCommandId:query.authorization_command_id,expectedAttemptId:query.expected_attempt_id}),args=()=>({p_user_id:actor,p_authorization_command_id:query.authorization_command_id,p_expected_attempt_id:query.expected_attempt_id});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const bounded=async p=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('TEST_TIMEOUT')),1000);})]);}finally{clearTimeout(timer);}};
test('075 browser-safe projection binds original command/attempt before adopting discovered UUID',()=>{
 assert.deepEqual(projectClosureLookupPublic(closureResult(true),query),closureResult(true));let calls=0;const getter={...query};Object.defineProperty(getter,'expected_attempt_id',{enumerable:true,get(){calls++;return query.expected_attempt_id;}});assert.throws(()=>captureClosureLookupInput(getter));assert.equal(calls,0);
 for(const change of[v=>v.receipt.authorization_command_id=randomUUID(),v=>v.receipt.attempt_id=randomUUID(),v=>v.read_only=false,v=>v.replayed=false,v=>v.receipt.request_hash='a'.repeat(64),v=>v.can_transmit=true]){const v=closureResult(true);change(v);assert.throws(()=>projectClosureLookupPublic(v,query));}
 for(const patch of[{actor},{command_id:randomUUID()},{confirmed:true},{request_hash:'a'.repeat(64)}])assert.throws(()=>captureClosureLookupInput({...query,...patch}));
});
test('075 captures actor/query before await;404 and failed ports never call another operation',async()=>{
 const entered=deferred(),gate=deferred(),calls=[],service=createAuthorizationClosureLookupService({lookupRpc:async(a)=>{calls.push(a);entered.resolve();await gate.promise;return closureResult(true,{privateHash:true});}}),q=input(),pending=service.closureLookup(q);await entered.promise;q.actor=randomUUID();q.authorizationCommandId=randomUUID();q.expectedAttemptId=randomUUID();gate.resolve();assert.deepEqual(await pending,closureResult(true));assert.deepEqual(calls,[args()]);
 for(const code of['P0002','42501','40001']){let n=0;const service=createAuthorizationClosureLookupService({lookupRpc:async()=>{n++;throw Object.assign(Error('PRIVATE'),{code});}});await assert.rejects(()=>service.closureLookup(input()),e=>e.code===code);assert.equal(n,1);}
});
test('075 RPC is one fixed read-only endpoint with captured fields and sanitized bounded response',async()=>{
 let calls=0;const rpc=createAuthorizationClosureLookupRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-lookup-service-key-only',fetchImpl:async(url,o)=>{calls++;assert.equal(url,'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/'+CLOSURE_LOOKUP_RPC);assert.deepEqual(JSON.parse(o.body),args());assert.equal(o.redirect,'manual');return Response.json(closureResult(true,{privateHash:true}));}});assert.equal((await rpc(args())).command_id,closureBody.command_id);assert.equal(calls,1);
 const abort=new AbortController();abort.abort();await assert.rejects(()=>rpc(args(),{signal:abort.signal}));assert.equal(calls,1);
});
test('075 refuses empty/stalled/oversized/redirect/malformed replies; cancellation cannot hang cleanup',async()=>{
 let cancelled=0;const scenarios=[()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array());},cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'Content-Type':'application/json'}}),()=>new Response(new ReadableStream({pull(){},cancel(){cancelled++;return new Promise(()=>{});}}),{headers:{'Content-Type':'application/json'}}),()=>new Response(' '.repeat(16385),{headers:{'Content-Type':'application/json'}}),()=>new Response(null,{status:302,headers:{Location:'https://never.invalid','Content-Type':'application/json'}}),()=>new Response(new Uint8Array([255]),{headers:{'Content-Type':'application/json'}}),()=>Response.json({...closureResult(true,{privateHash:true}),private_key:'PRIVATE'})];
 for(const response of scenarios){let calls=0;const rpc=createAuthorizationClosureLookupRpc({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-lookup-service-key-only',fetchImpl:async()=>{calls++;return response();}});await assert.rejects(()=>bounded(rpc(args(),{deadline:Date.now()+40})));assert.equal(calls,1);}assert.equal(cancelled,2);
});
