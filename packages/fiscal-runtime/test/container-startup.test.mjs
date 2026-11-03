import test from 'node:test';
import assert from 'node:assert/strict';
import {createContainerBridge} from '../../../workers/fiscal-executor/src/bridge.mjs';
import {internal,env,deferred,bounded} from '../../fiscal-authorization-runtime/test/fixtures.mjs';
import {saveBody} from '../../fiscal-authorization-runtime/test/review-fixtures.mjs';
const command='10000000-0000-4000-8000-000000000001',candidate='10000000-0000-4000-8000-000000000002',path=`/review-commands/${command}`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate(),'fixture reached the required boundary');}
const readyResponse=()=>new Response(null,{status:401,headers:{'X-Content-Type-Options':'nosniff'}});
function fixture({readyAt=0,onProbe,onForward,onInactivity,wait}={}){
 const stamp=Date.now(),state={elapsed:0},calls={starts:[],timeouts:[],ports:[],probes:[],forwards:[],diagnostics:[],waits:[]};
 const port={async fetch(input,options){if(typeof input==='string'){calls.probes.push({url:input,signal:options.signal,at:state.elapsed});if(onProbe)return onProbe(state,calls);if(state.elapsed<readyAt)throw Error('SYNTHETIC_NOT_READY');return readyResponse();}calls.forwards.push({url:input.url,method:input.method,body:await input.text(),authorization:input.headers.get('authorization'),signal:input.signal,at:state.elapsed});if(onForward)return onForward(state,calls);return Response.json({synthetic:true});}};
 const container={running:false,images:{base:'synthetic-image'},start(args){calls.starts.push(args);this.running=true;},async setInactivityTimeout(value){calls.timeouts.push(value);return onInactivity?.(state,calls);},getTcpPort(value){calls.ports.push(value);return port;}};
 const environment={...env(),SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_ONLY',A1_FINGERPRINT_SECRET:'SYNTHETIC_ONLY',A1_KEK_RING_JSON:'SYNTHETIC_ONLY',A1_CURRENT_KEK_ID:'synthetic'};
 const bridge=createContainerBridge({container},environment,{now:()=>stamp+state.elapsed,wait:async ms=>{calls.waits.push(ms);if(wait)return wait(ms,state,calls);state.elapsed+=ms;},diagnostic:line=>calls.diagnostics.push(JSON.parse(line))});
 const request=(options={})=>internal(options.path??path,options.body,{origin:'https://fiscal-runtime.internal',now:stamp+(options.issuedOffset??0),signal:options.signal});
 return{bridge,request,state,calls,container};
}

test('readiness accepts cold starts beyond five seconds and below forty seconds before a single forward',async()=>{
 for(const readyAt of [5200,7000,39800]){const f=fixture({readyAt}),response=await f.bridge(await f.request());assert.equal(response.status,200);assert.equal(f.state.elapsed,readyAt);assert.equal(f.calls.starts.length,1);assert.deepEqual(f.calls.timeouts,[60000]);assert.deepEqual(f.calls.ports,[8080]);assert.equal(f.calls.forwards.length,1);assert.equal(f.calls.forwards[0].at,readyAt);assert.ok(f.calls.probes.length>25);assert.equal(f.calls.diagnostics.length,0);assert.deepEqual(f.calls.starts[0].instance,{vcpu:0.25,memoryMib:1024,diskMb:4000});}
});
test('readiness rejects at the deadline, including a success received too late and an inactive port',async()=>{
 for(const variant of ['never','at-deadline','late','valid-near-deadline']){const f=fixture({readyAt:variant==='never'?Infinity:40000,onProbe:variant==='late'||variant==='valid-near-deadline'?(state)=>{if(state.elapsed<39800)throw Error('SYNTHETIC_NOT_READY');state.elapsed=variant==='late'?40001:39999;return readyResponse();}:undefined}),response=await f.bridge(await f.request());assert.equal(response.status,variant==='valid-near-deadline'?200:503);assert.equal(f.calls.forwards.length,variant==='valid-near-deadline'?1:0);if(variant!=='valid-near-deadline'){assert.ok(f.state.elapsed>=40000&&f.state.elapsed<=40001);assert.equal(f.calls.diagnostics[0].phase,'readiness');assert.equal((await response.json()).error,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');}}
});
test('HTTP200 or401 without nosniff cannot unlock forwarding, and invalid credentials do not start readiness',async()=>{
 for(const status of [200,401]){const f=fixture({onProbe:()=>new Response(null,{status})});assert.equal((await f.bridge(await f.request())).status,503);assert.equal(f.calls.forwards.length,0);assert.equal(f.state.elapsed,40000);}
 const f=fixture();assert.equal((await f.bridge(new Request(`https://fiscal-runtime.internal/internal/v1/fiscal-authorization${path}`))).status,401);assert.equal(f.calls.starts.length,0);assert.equal(f.calls.probes.length,0);
});
test('each waiter rechecks HMAC freshness after the shared startup; no expired request reaches the port',async()=>{
 const f=fixture({readyAt:39800}),response=await f.bridge(await f.request({issuedOffset:-21000}));assert.equal(response.status,401);assert.equal((await response.json()).error,'AUTHORIZATION_RUNTIME_UNAUTHORIZED');assert.equal(f.calls.forwards.length,0);assert.equal(f.calls.starts.length,1);assert.equal(f.calls.diagnostics.length,0);
});
test('one cancelled waiter does not cancel concurrent readiness or alter the other request',async()=>{
 const gate=deferred(),f=fixture({onProbe:()=>gate.promise}),cancel=new AbortController();
 const original=await f.request({signal:cancel.signal}),other=await f.request({path:`/candidates/${candidate}/review`,body:saveBody()}),body=await other.clone().text(),authorization=other.headers.get('authorization');
 const first=f.bridge(original);await until(()=>f.calls.probes.length===1);const second=f.bridge(other);for(let i=0;i<5;i++)await tick();cancel.abort();assert.equal((await bounded(first)).status,503);assert.equal(f.calls.starts.length,1);assert.equal(f.calls.probes[0].signal.aborted,false);assert.equal(f.calls.forwards.length,0);gate.resolve(readyResponse());assert.equal((await bounded(second)).status,200);assert.equal(f.calls.forwards.length,1);assert.equal(f.calls.forwards[0].body,body);assert.equal(f.calls.forwards[0].authorization,authorization);assert.equal(f.calls.forwards[0].method,'POST');assert.equal(f.calls.starts.length,1);assert.equal(f.calls.probes.length,1);
});
test('an already cancelled request does not start the container and cancellation after readiness prevents forward',async()=>{
 const cancel=new AbortController();cancel.abort();let f=fixture();assert.equal((await f.bridge(await f.request({signal:cancel.signal}))).status,503);assert.equal(f.calls.starts.length,0);
 const later=new AbortController();f=fixture({onProbe:()=>{later.abort();return readyResponse();}});assert.equal((await f.bridge(await f.request({signal:later.signal}))).status,503);assert.equal(f.calls.forwards.length,0);
});
test('an ambiguous POST forwarding failure is never automatically forwarded twice',async()=>{
 const f=fixture({readyAt:7000,onForward:()=>{throw Error('SYNTHETIC_FORWARD_LOSS');}}),response=await f.bridge(await f.request({path:`/candidates/${candidate}/review`,body:saveBody()}));assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:true});assert.equal(f.calls.forwards.length,1);assert.equal(f.calls.starts.length,1);
});
test('a slow or non-cooperative probe is bounded to500ms and its late response is discarded',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const late=deferred();let cancelled=0;const f=fixture({onProbe:(_state,calls)=>calls.probes.length===1?late.promise:readyResponse()});
 try{const pending=f.bridge(await f.request());await until(()=>f.calls.probes.length===1);f.state.elapsed=500;t.mock.timers.tick(500);assert.equal((await bounded(pending)).status,200);assert.equal(f.calls.probes.length,2);assert.equal(f.calls.probes[0].signal.aborted,true);assert.equal(f.calls.forwards.length,1);late.resolve(new Response(new ReadableStream({cancel(){cancelled++;}}),{status:401,headers:{'X-Content-Type-Options':'nosniff'}}));for(let i=0;i<5;i++)await tick();assert.equal(cancelled,1);assert.equal(f.calls.forwards.length,1);}finally{late.resolve(readyResponse());t.mock.timers.reset();}
});
test('the overall startup deadline also bounds a non-cooperative inactivity API',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const late=deferred(),f=fixture({onInactivity:()=>late.promise});
 try{const pending=f.bridge(await f.request());await until(()=>f.calls.timeouts.length===1);f.state.elapsed=40000;t.mock.timers.tick(40000);assert.equal((await bounded(pending)).status,503);assert.equal(f.calls.probes.length,0);assert.equal(f.calls.forwards.length,0);assert.equal(f.calls.diagnostics[0].phase,'inactivity');late.resolve();for(let i=0;i<5;i++)await tick();assert.equal(f.calls.ports.length,0);}finally{late.resolve();t.mock.timers.reset();}
});
