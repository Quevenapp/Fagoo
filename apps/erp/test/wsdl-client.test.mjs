import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createWsdlClient,WsdlClientError} from '../src/lib/wsdl-client.ts';
import {AccessError} from '../src/lib/real-access.ts';
import {WSDL_BASE} from '../src/lib/wsdl-model.ts';
import {payload,result,command,actor} from '../../../packages/fiscal-wsdl-runtime/test/fixtures.mjs';
const ready=()=>({phase:'ready',membership:{user_id:actor,role:'fiscal'}}),json=(v,init={})=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'},...init});
const gate=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function setup(fetchImpl=async()=>json(result()),getToken=()=> 'SYNTHETIC_NOT_A_TOKEN'){
 let state=ready(),epoch=0;const calls=[];const client=createWsdlClient({origin:'https://gateway.synthetic.invalid',getToken,getSnapshot:()=>state,getEpoch:()=>epoch,fetchImpl:async(...args)=>{calls.push(args);return fetchImpl(...args);}});
 return{client,calls,get state(){return state;},set state(v){state=v;},advance:()=>epoch++};
}
const send=(p,options={})=>p.client(WSDL_BASE+'/run',{method:'POST',body:payload(),...options});
test('WSDL client accepts only run and command GET, never invokes a request on construction',async()=>{
 const p=setup(async url=>json(result('stored',payload(),!url.endsWith('/run'))));assert.equal(p.calls.length,0);await send(p);await p.client(WSDL_BASE+'/commands/'+command);assert.equal(p.calls.length,2);
 for(const[url,options]of p.calls){assert.ok(url.startsWith('https://gateway.synthetic.invalid/v1/fiscal-wsdl/'));assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');}
 for(const path of [WSDL_BASE+'/history',WSDL_BASE+'/run?x=1',WSDL_BASE+'/run#x',WSDL_BASE+'/run%2f',WSDL_BASE+'/run/../run','https://evil.invalid'+WSDL_BASE+'/run'])await assert.rejects(p.client(path,{method:'POST',body:payload()}),e=>e.status===400);
 for(const extra of [{actor},{confirmed:false},{operation:'status'},{expected_identity_version:0},{xml:'PRIVATE'}])await assert.rejects(send(p,{body:{...payload(),...extra}}),e=>e.status===400);assert.equal(p.calls.length,2);
});
test('WSDL client captures body/signal before token await and rejects accessors',async()=>{
 const token=gate(),p=setup(undefined,()=>token.promise),original=new AbortController(),input=payload(),options={method:'POST',body:input,signal:original.signal};const waiting=p.client(WSDL_BASE+'/run',options);
 input.command_id=actor;input.operation='authorization';options.body={xml:'PRIVATE'};options.signal=new AbortController().signal;token.resolve('SYNTHETIC_NOT_A_TOKEN');await waiting;assert.deepEqual(JSON.parse(p.calls[0][1].body),payload());
 let invoked=false;const raw=payload();Object.defineProperty(raw,'confirmed',{get(){invoked=true;return true;},enumerable:true});await assert.rejects(send(p,{body:raw}),e=>e.status===400);assert.equal(invoked,false);
});
test('WSDL client enforces role/actor epoch and refuses late response after logout or actor switch',async()=>{
 const p=setup();p.state={phase:'ready',membership:{user_id:actor,role:'consulta'}};await assert.rejects(send(p),e=>e.status===403&&!e.recovery_required);assert.equal(p.calls.length,0);
 const started=gate(),response=gate(),q=setup(()=>{started.resolve();return response.promise;}),pending=send(q);await started.promise;q.advance();response.resolve(json(result()));await assert.rejects(pending,e=>e.name==='AbortError');
 for(const origin of ['http://invalid.test','https://invalid.test/','https://user:pass@invalid.test'])assert.throws(()=>createWsdlClient({origin,getSnapshot:ready,getToken:()=> 'x'}));
});
test('WSDL errors after dispatch retain uncertainty and upstream status; recovery is always read-only',async()=>{
 for(const status of [400,401,403,409]){const p=setup(async()=>json({error:'WSDL_CONFLICT',recovery_required:true},{status}));await assert.rejects(send(p),e=>e instanceof WsdlClientError&&e instanceof AccessError&&e.status===503&&e.recovery_required&&e.upstream_status===status);assert.equal(p.calls.length,1);}
 const p=setup(()=>{throw Error('PRIVATE TOKEN');});await assert.rejects(send(p),e=>e.recovery_required&&!String(e).includes('PRIVATE'));await assert.rejects(p.client(WSDL_BASE+'/commands/'+command),e=>!e.recovery_required);assert.equal(p.calls.length,2);
});
test('WSDL redirects, wrong binding, oversized decoded body and private fields fail closed',async()=>{
 for(const response of [new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}}),json({...result(),command_id:actor}),json({...result(),execution:'PRIVATE'}),json('x'.repeat(131073)),json({error:'PRIVATE',recovery_required:true},{status:409})]){
  const p=setup(async()=>response);await assert.rejects(send(p),e=>e.recovery_required&&!String(e).includes('PRIVATE'));assert.equal(p.calls.length,1);
 }
});
test('WSDL cancellation after POST is uncertain; token cancellation has no dispatch; deadline closes streams',async t=>{
 const started=gate(),p=setup(()=>{started.resolve();return new Promise(()=>{});}),abort=new AbortController(),pending=send(p,{signal:abort.signal});await started.promise;abort.abort();await assert.rejects(pending,e=>e.recovery_required);assert.equal(p.calls.length,1);
 const token=gate(),q=setup(undefined,()=>token.promise),cancel=new AbortController(),before=send(q,{signal:cancel.signal});cancel.abort();await assert.rejects(before,e=>e.name==='AbortError');token.resolve('TOKEN');await tick();assert.equal(q.calls.length,0);
 t.mock.timers.enable({apis:['setTimeout']});const pulled=gate();let cancelled=false;const stream=new ReadableStream({pull(){pulled.resolve();return new Promise(()=>{});},cancel(){cancelled=true;}}),r=setup(async()=>new Response(stream,{headers:{'Content-Type':'application/json'}})),slow=send(r);await pulled.promise;await tick();t.mock.timers.tick(65000);await assert.rejects(slow,e=>e.status===504&&e.recovery_required);await tick();assert.equal(cancelled,true);t.mock.timers.reset();
});
