import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {payload,result,history,actor} from '../../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
import {RECONCILIATION_BASE as BASE} from '../src/lib/fiscal-reconciliation-model.ts';
const token='synthetic-protocol-session-token-123456789',nextToken='synthetic-protocol-refreshed-token-123456789',origin='https://protocol.synthetic.invalid',other='b0000000-0000-4000-8000-000000000001',body=payload();
const session=(access_token=token,id=actor)=>({access_token,user:{id}}),member=(role='fiscal',id=actor)=>({user_id:id,role,resources:['nfe','nfce'],data_mode:'staging_readonly'});
const tick=()=>new Promise(r=>setImmediate(r));
async function until(p){for(let i=0;i<150&&!p();i++)await tick();assert.ok(p(),'bounded fixture wait');}
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function setup({role='fiscal',configured=true,before=()=>{},after=()=>{}}={}){
 let callback=()=>{};const state={role,actor},calls=[];
 const auth={getSession:async()=>({data:{session:session()},error:null}),onAuthStateChange(fn){callback=fn;return{data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{callback('SIGNED_OUT',null);return{error:null};},signInWithPassword:async()=>({data:{session:null},error:null})};
 const controller=createAccessController(auth,'https://erp.synthetic.invalid',async(url,options)=>{
  const call={url,options};calls.push(call);const custom=await before(call,state);if(custom)return custom;
  let value;if(url.endsWith('/v1/me'))value=member(state.role,state.actor);
  else if(url.endsWith('/run'))value=result('stored',JSON.parse(options.body));
  else if(url.endsWith('/history'))value=history();
  else value=result('stored',body,url.includes('/commands/'));
  return await after(call,state,value)??Response.json(value);
 },configured?{a1ApiUrl:origin}:{});
 const stop=controller.start();return{controller,state,calls,emit:(event,s)=>callback(event,s),close:stop};
}
const requests=p=>p.calls.filter(c=>c.url.startsWith(origin)),me=p=>p.calls.filter(c=>c.url.endsWith('/v1/me')),run=(p,o={})=>p.controller.fiscalReconciliation(BASE+'/run',{method:'POST',body,...o});
test('062 controller restricts authenticated roles/routes and uses only configured gateway',async()=>{
 for(const role of ['admin','fiscal']){const p=setup({role});try{await until(()=>p.controller.getSnapshot().phase==='ready');await run(p);assert.equal(requests(p).length,1);assert.equal(requests(p)[0].url,origin+BASE+'/run');assert.equal(requests(p)[0].options.headers.Authorization,`Bearer ${token}`);}finally{p.close();}}
 for(const role of ['consulta','vendas','financeiro','estoque']){const p=setup({role});try{await until(()=>p.controller.getSnapshot().phase==='ready');await assert.rejects(run(p),e=>e.status===403);assert.equal(requests(p).length,0);}finally{p.close();}}
 const p=setup();try{await until(()=>p.controller.getSnapshot().phase==='ready');for(const [path,o]of [[BASE+'/run',{method:'GET',body}],[BASE+'/run',{method:'POST',body:{...body,confirmed:false}}],[BASE+'/commands/'+body.command_id,{body:undefined}],[BASE+'/recover',{method:'POST',body:{...body}}],[BASE+'/run?x=1',{method:'POST',body}]])await assert.rejects(p.controller.fiscalReconciliation(path,o),e=>e.status===400);assert.equal(requests(p).length,0);}finally{p.close();}
 const absent=setup({configured:false});try{await until(()=>absent.controller.getSnapshot().phase==='ready');await assert.rejects(run(absent),e=>e.status===503);assert.equal(requests(absent).length,0);}finally{absent.close();}
});
test('controller captures body/method/signal before lazy import and token refresh; no caller mutation reaches run',async()=>{
 const p=setup();try{await until(()=>p.controller.getSnapshot().phase==='ready');const signal=new AbortController(),captured=structuredClone(body),options={method:'POST',body:structuredClone(body),signal:signal.signal};const pending=p.controller.fiscalReconciliation(BASE+'/run',options);options.body.command_id=other;options.body.signed_hash='f'.repeat(64);options.method='GET';options.signal=new AbortController().signal;await pending;assert.deepEqual(JSON.parse(requests(p)[0].options.body),captured);
 let invoked=false;await assert.rejects(p.controller.fiscalReconciliation(BASE+'/run',Object.defineProperty({},'body',{enumerable:true,get(){invoked=true;return body;}})),e=>e.status===400);assert.equal(invoked,false);
 }finally{p.close();}
 const fresh=gate(),q=setup({before(c){if(c.url.endsWith('/v1/me')&&c.options.headers.Authorization===`Bearer ${nextToken}`)return fresh.promise;}});try{await until(()=>q.controller.getSnapshot().phase==='ready');q.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(q).length===2);const b=structuredClone(body),pending=run(q,{body:b});b.candidate_id=other;await tick();assert.equal(requests(q).length,0);fresh.resolve(Response.json(member()));await pending;assert.equal(JSON.parse(requests(q)[0].options.body).candidate_id,body.candidate_id);assert.equal(requests(q)[0].options.headers.Authorization,`Bearer ${nextToken}`);}finally{fresh.resolve(Response.json(member()));q.close();}
});
test('uncertain 401/403 preserves recovery metadata while controller revalidates current authentication without resending',async()=>{
 for(const status of [401,403]){const p=setup({after(c){if(c.url===origin+BASE+'/run')return Response.json({error:status===401?'RECONCILIATION_UNAUTHENTICATED':'RECONCILIATION_FORBIDDEN',recovery_required:true},{status});}});try{await until(()=>p.controller.getSnapshot().phase==='ready');await assert.rejects(run(p),e=>e instanceof AccessError&&e.status===503&&e.recovery_required&&e.upstream_status===status);if(status===401)assert.equal(p.controller.getSnapshot().phase,'signed_out');else await until(()=>me(p).length===2&&p.controller.getSnapshot().permissionMessage===null);assert.equal(requests(p).length,1);}finally{p.close();}}
});
test('old-token uncertain 401 after same actor refresh cannot log out new credentials or retry',async()=>{
 const response=gate(),p=setup({after(c){if(c.url===origin+BASE+'/run')return response.promise;}});try{await until(()=>p.controller.getSnapshot().phase==='ready');const pending=run(p);await until(()=>requests(p).length===1);p.emit('TOKEN_REFRESHED',session(nextToken));await until(()=>me(p).length===2&&p.controller.getSnapshot().permissionMessage===null);response.resolve(Response.json({error:'RECONCILIATION_UNAUTHENTICATED',recovery_required:true},{status:401}));await assert.rejects(pending,e=>e.status===503&&e.recovery_required);assert.equal(p.controller.getSnapshot().phase,'ready');assert.equal(requests(p).length,1);}finally{response.resolve(Response.json({}));p.close();}
});
test('logout/actor switch/disposal cancel late responses, no result leaks and no follow-up dispatch occurs',async()=>{
 for(const action of ['logout','actor','dispose']){const response=gate();let cancelled=false;const p=setup({after(c){if(c.url===origin+BASE+'/run')return response.promise;}});try{await until(()=>p.controller.getSnapshot().phase==='ready');const pending=run(p),rejected=assert.rejects(pending,e=>e.name==='AbortError');await until(()=>requests(p).length===1);
 if(action==='logout')await p.controller.logout();else if(action==='actor'){p.state.actor=other;p.emit('SIGNED_IN',session(nextToken,other));await until(()=>p.controller.getSnapshot().membership?.user_id===other);}else p.close();await rejected;assert.equal(requests(p)[0].options.signal.aborted,true);
 response.resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));await until(()=>cancelled);assert.equal(requests(p).length,1);
 }finally{response.resolve(Response.json({}));p.close();}}
});
test('read and recover are explicit distinct actions; neither creates a run, including disabled feature errors',async()=>{
 const p=setup({after(c){if(c.url.endsWith('/run'))return Response.json({error:'RECONCILIATION_DISABLED',recovery_required:false},{status:409});}});try{await until(()=>p.controller.getSnapshot().phase==='ready');await assert.rejects(run(p),e=>e.status===409&&!e.recovery_required);
 await p.controller.fiscalReconciliation(BASE+'/commands/'+body.command_id);await p.controller.fiscalReconciliation(BASE+'/candidates/'+body.candidate_id+'/history',{method:'POST',body:{limit:25,before:null}});await p.controller.fiscalReconciliation(BASE+'/recover',{method:'POST',body:{command_id:body.command_id}});assert.deepEqual(requests(p).map(c=>[c.options.method,c.url.split('/').at(-1)]),[['POST','run'],['GET',body.command_id],['POST','history'],['POST','recover']]);
 }finally{p.close();}
});
