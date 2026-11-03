import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController} from '../src/lib/real-access.ts';
import {actor,boletoFixture} from '../../../workers/erp-api/test/helpers/boleto-preview-fixture.mjs';
const f=await boletoFixture(),path=`/v1/boletos-itau/${f.billing}/preview`,token='synthetic-session-for-test';
const until=async fn=>{for(let i=0;i<100&&!fn();i++)await new Promise(r=>setImmediate(r));assert.ok(fn());};
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup(role='financeiro',read){let notify;const calls=[],auth={getSession:async()=>({data:{session:{access_token:token,user:{id:actor}}},error:null}),onAuthStateChange(fn){notify=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>({error:null})};
 const c=createAccessController(auth,'https://erp.synthetic.invalid',async(url,o)=>{calls.push({url,o});return url.endsWith('/v1/me')?Response.json({user_id:actor,role,resources:[],data_mode:'staging_readonly'}):read?read(url,o):Response.json(f.response);});const stop=c.start();
 return{c,calls,stop,emit:(value)=>notify('SIGNED_OUT',value)};
}
test('066 controller permits financial readers and captures GET/signal before a caller mutation',async()=>{
 for(const role of ['admin','financeiro','consulta']){const s=setup(role);try{await until(()=>s.c.getSnapshot().phase==='ready');const a=new AbortController(),o={signal:a.signal},p=s.c.boletoPreview(path,o);o.method='POST';o.body={};o.signal=new AbortController().signal;await p;assert.equal(s.calls.length,2);assert.equal(s.calls[1].o.method,'GET');assert.equal(s.calls[1].o.body,undefined);}finally{s.stop();}}
 for(const role of ['vendas','estoque','fiscal']){const s=setup(role);try{await until(()=>s.c.getSnapshot().phase==='ready');await assert.rejects(()=>s.c.boletoPreview(path),e=>e.status===403);assert.equal(s.calls.length,1);}finally{s.stop();}}
});
test('066 controller rejects writes/paths before fetch, fences logout and never retries read errors',async()=>{
 const s=setup();try{await until(()=>s.c.getSnapshot().phase==='ready');for(const o of [{method:'POST'},{body:{}},{signal:7}])await assert.rejects(()=>s.c.boletoPreview(path,o),e=>e.status===400);await assert.rejects(()=>s.c.boletoPreview(path+'?x=1'),e=>e.status===400);assert.equal(s.calls.length,1);}finally{s.stop();}
 const g=gate(),late=setup('consulta',()=>g.promise);try{await until(()=>late.c.getSnapshot().phase==='ready');const p=late.c.boletoPreview(path);await until(()=>late.calls.length===2);late.emit(null);g.resolve(Response.json(f.response));await assert.rejects(()=>p,e=>e.name==='AbortError');assert.equal(late.calls.length,2);}finally{g.resolve(Response.json(f.response));late.stop();}
 for(const status of [401,403,409,503]){const e=setup('financeiro',()=>Response.json({error:{code:'ERP_FORBIDDEN'}},{status}));try{await until(()=>e.c.getSnapshot().phase==='ready');await assert.rejects(()=>e.c.boletoPreview(path),x=>x.status===status);await new Promise(r=>setImmediate(r));assert.equal(e.calls.filter(c=>c.url===`https://erp.synthetic.invalid${path}`).length,1);}finally{e.stop();}}
});
