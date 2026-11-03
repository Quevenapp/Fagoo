import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createFiscalReconciliationClient,ReconciliationClientError} from '../src/lib/fiscal-reconciliation-client.ts';
import {RECONCILIATION_BASE as BASE} from '../src/lib/fiscal-reconciliation-model.ts';
import {payload,result,history,unconfirmed,actor} from '../../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
const body=payload(),token='synthetic-token-0123456789',origin='https://protocol.synthetic.invalid';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const state=role=>({phase:'ready',membership:{user_id:actor,role:role??'fiscal'}});
function setup(fetcher=async()=>Response.json(result()),getToken=()=>token){
 let snapshot=state(),epoch=0;const calls=[];
 const client=createFiscalReconciliationClient({origin,getSnapshot:()=>snapshot,getEpoch:()=>epoch,getToken,fetchImpl:async(...args)=>{calls.push(args);return fetcher(...args);}});
 return{client,calls,set state(v){snapshot=v;},advance(){epoch++;}};
}
const send=(f,options={})=>f.client(BASE+'/run',{method:'POST',body,...options});
const read=f=>f.client(BASE+'/commands/'+body.command_id);
const bad=e=>e instanceof ReconciliationClientError&&e.status>=500&&!String(e).includes('SYNTHETIC_PRIVATE');
test('client has four closed actions, correct methods and bound public DTO; reads ignore can_query false',async()=>{
 const cases=[['/run',{method:'POST',body},result()],['/recover',{method:'POST',body:{command_id:body.command_id}},result()],['/commands/'+body.command_id,{},result('stored',body,true)],['/candidates/'+body.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}},history()]];
 for(const [path,options,dto] of cases){const f=setup(async()=>Response.json(dto));assert.equal(f.calls.length,0);const out=await f.client(BASE+path,options);assert.deepEqual(out,dto);assert.equal(Object.isFrozen(out),true);assert.equal(out.can_query,false);assert.equal(f.calls.length,1);const [url,o]=f.calls[0];assert.equal(url,origin+BASE+path);assert.equal(o.method,options.method??'GET');assert.equal(o.redirect,'manual');assert.equal(o.cache,'no-store');assert.equal(o.credentials,'omit');assert.equal(o.referrerPolicy,'no-referrer');assert.equal(o.headers.Authorization,`Bearer ${token}`);assert.equal(o.signal.aborted,true);}
});
test('route/body/options/role/token guards reject before fetch without coercion or getters',async()=>{
 const f=setup();for(const path of [BASE+'/run?',BASE+'/run/',BASE+'/RUN',BASE+'/commands/'+body.command_id+'?q=1',BASE+'/candidates/'+body.candidate_id,BASE+'/cancel','https://evil.invalid'+BASE+'/run'])await assert.rejects(f.client(path,{method:'POST',body}),e=>e.status===400);
 for(const options of [{method:'GET',body},{method:'PATCH',body},{method:'POST',body:{...body,confirmed:false}},{method:'POST',body:{...body,xml:'SYNTHETIC_PRIVATE'}},{method:'POST',body,signal:{}},{method:'POST',body,unknown:true}])await assert.rejects(f.client(BASE+'/run',options),e=>e.status===400);
 let touched=false;await assert.rejects(f.client(BASE+'/run',Object.defineProperty({},'body',{enumerable:true,get(){touched=true;return body;}})),e=>e.status===400);assert.equal(touched,false);
 for(const role of ['consulta','financeiro','vendas','estoque']){f.state=state(role);await assert.rejects(send(f),e=>e.status===403);}f.state={phase:'signed_out',membership:null};await assert.rejects(send(f),e=>e.status===401);assert.equal(f.calls.length,0);
 for(const tok of [null,'','private\nheader','x'.repeat(8193)]){const q=setup(undefined,()=>tok);await assert.rejects(send(q),e=>e.status===401);assert.equal(q.calls.length,0);}
 for(const origin of ['http://gateway.invalid','https://gateway.invalid/','https://u:p@gateway.invalid','https://gateway.invalid/path'])assert.throws(()=>createFiscalReconciliationClient({origin,getToken:()=>token,getSnapshot:state}));
});
test('body/signal captured before token refresh; mutations cannot alter dispatched command',async()=>{
 const t=gate(),f=setup(undefined,()=>t.promise),original=structuredClone(body),options={method:'POST',body:structuredClone(body),signal:new AbortController().signal};const request=f.client(BASE+'/run',options);options.body.command_id=actor;options.body.signed_hash='f'.repeat(64);options.method='GET';options.signal=new AbortController().signal;t.resolve(token);await request;assert.deepEqual(JSON.parse(f.calls[0][1].body),original);
 const t2=gate(),q=setup(undefined,()=>t2.promise),stop=new AbortController(),pending=send(q,{signal:stop.signal}),rejected=assert.rejects(pending,e=>e.name==='AbortError');stop.abort();await rejected;t2.resolve(token);await tick();assert.equal(q.calls.length,0);
});
test('401/403 preserve upstream status; mutation recovery flag takes precedence over HTTP rejection; no retries',async()=>{
 for(const status of [401,403,409])for(const recovery_required of [true,false]){const f=setup(async()=>Response.json({error:status===401?'RECONCILIATION_UNAUTHENTICATED':status===403?'RECONCILIATION_FORBIDDEN':'RECONCILIATION_CONFLICT',recovery_required},{status}));await assert.rejects(send(f),e=>e.upstream_status===status&&e.recovery_required===recovery_required&&e.status===(recovery_required?503:status));assert.equal(f.calls.length,1);}
 const disabled=setup(async()=>Response.json({error:'RECONCILIATION_DISABLED',recovery_required:false},{status:409}));await assert.rejects(send(disabled),e=>e.code==='RECONCILIATION_DISABLED'&&e.status===409&&!e.recovery_required);
 await assert.rejects(disabled.client(BASE+'/recover',{method:'POST',body:{command_id:body.command_id}}),e=>bad(e)&&e.recovery_required);
 const invalidRead=setup(async()=>Response.json({error:'RECONCILIATION_FORBIDDEN',recovery_required:true},{status:403}));await assert.rejects(read(invalidRead),e=>bad(e)&&!e.recovery_required);
});
test('network loss or malformed success after run/recover stays uncertain; command/history remain reads',async()=>{
 for(const path of ['/run','/recover'])for(const fetcher of [()=>{throw Error('SYNTHETIC_PRIVATE');},async()=>Response.json({private:'SYNTHETIC_PRIVATE'}),async()=>Response.json({...result(),can_query:true})]){const f=setup(fetcher);await assert.rejects(f.client(BASE+path,{method:'POST',body:path==='/run'?body:{command_id:body.command_id}}),e=>bad(e)&&e.recovery_required);assert.equal(f.calls.length,1);}
 const f=setup(async()=>Response.json(unconfirmed()));assert.equal((await send(f)).status,'unconfirmed');assert.equal(f.calls.length,1);
 const q=setup(()=>{throw Error('SYNTHETIC_PRIVATE');});await assert.rejects(read(q),e=>bad(e)&&!e.recovery_required);assert.equal(q.calls.length,1);
});
test('actor/logout/epoch changes discard late headers/body and never perform a subsequent request',async()=>{
 for(const change of [f=>f.state={phase:'signed_out',membership:null},f=>f.state={phase:'ready',membership:{user_id:body.command_id,role:'fiscal'}},f=>f.state=state('consulta'),f=>f.advance()]){
  const gateHttp=gate(),entered=gate(),f=setup(()=>{entered.resolve();return gateHttp.promise;}),pending=send(f);await entered.promise;change(f);let cancelled=false;gateHttp.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await assert.rejects(pending,e=>e.name==='AbortError');await tick();assert.equal(cancelled,true);assert.equal(f.calls.length,1);
 }
 const entered=gate(),f=setup(async()=>new Response(new ReadableStream({start(){entered.resolve();}}),{headers:{'content-type':'application/json'}})),stop=new AbortController(),pending=send(f,{signal:stop.signal});await entered.promise;await tick();stop.abort();await assert.rejects(pending,e=>bad(e)&&e.recovery_required);assert.equal(f.calls.length,1);
});
test('bounded fatal UTF8/body length/redirect and exact URL are enforced with stream cancellation',async()=>{
 const values=[()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json'}}),()=>new Response('x'.repeat(131073),{headers:{'content-type':'application/json'}}),()=>new Response(JSON.stringify(result()),{headers:{'content-type':'application/json','content-length':'2'}}),()=>Response.json(result(),{status:302,headers:{location:'https://evil.invalid'}}),()=>new Response(JSON.stringify(result()),{headers:{'content-type':'text/plain'}}),()=>new Response('{}',{headers:{'content-type':'application/json','content-encoding':'custom'}}),()=>{const r=Response.json(result());Object.defineProperty(r,'url',{value:'https://evil.invalid'});return r;}];
 for(const create of values){const f=setup(async()=>create());await assert.rejects(send(f),e=>bad(e)&&e.recovery_required);assert.equal(f.calls.length,1);}
 let cancelled=false;const f=setup(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(131073));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await assert.rejects(send(f),bad);await tick();assert.equal(cancelled,true);
 const compressed=setup(async()=>new Response(JSON.stringify(result()),{headers:{'content-type':'application/json','content-encoding':'gzip','content-length':'10'}}));assert.equal((await send(compressed)).status,'stored');
});
test('malformed/unknown/private error responses never expose server details',async()=>{
 for(const value of [{error:'SYNTHETIC_PRIVATE',recovery_required:true},{error:'RECONCILIATION_FORBIDDEN',recovery_required:true,trace:'SYNTHETIC_PRIVATE'},{error:'RECONCILIATION_FORBIDDEN'}]){const f=setup(async()=>Response.json(value,{status:403}));await assert.rejects(send(f),bad);assert.equal(f.calls.length,1);}
});
