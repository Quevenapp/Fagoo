import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {ACTOR,OTHER,page,deferred} from './helpers/fiscal-draft-status-fixtures.mjs';
const BASE='/v1/rascunhos-fiscais/resumo',tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const session={access_token:'synthetic-082',user:{id:ACTOR}},me=(role,actor=ACTOR)=>({user_id:actor,role,resources:[],data_mode:'staging_readonly'});
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
test('082 controller allows only admin/fiscal reads and refuses writes or unrelated routes before fetch',async()=>{
 for(const role of ['admin','fiscal','consulta','vendas','financeiro','estoque']){
  const calls=[],c=createAccessController(auth,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me(role)):(calls.push({url,o}),Response.json(page()))),stop=c.start();await tick();
  try{if(!['admin','fiscal'].includes(role)){await assert.rejects(()=>c.fiscalDraftStatus(BASE),status(403));assert.equal(calls.length,0);continue;}
   for(const o of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(()=>c.fiscalDraftStatus(BASE,o),status(400));
   for(const p of [BASE+'/x',BASE+'?actor='+ACTOR,BASE+'?limit=26','/v1/rascunhos-fiscais'])await assert.rejects(()=>c.fiscalDraftStatus(p),status(400));
   const options={method:'GET'},pending=c.fiscalDraftStatus(BASE,options);options.method='POST';options.body={actor:OTHER};await pending;
   assert.equal(calls.length,1);assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.body,undefined);assert.equal(calls[0].o.redirect,'error');assert.equal(calls[0].o.headers.Authorization,'Bearer synthetic-082');
  }finally{stop();}
 }
});
test('082 controller enforces256KiB independently of legacy draft4MiB',async()=>{
 const c=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me('fiscal')):new Response('{}',{headers:{'content-type':'application/json','content-length':'262145'}})),stop=c.start();await tick();
 try{await assert.rejects(()=>c.fiscalDraftStatus(BASE),status(502));assert.deepEqual(await c.fiscalDraft('/v1/rascunhos-fiscais'),{});}finally{stop();}
});
test('082 refresh preserves captured GET and rechecks current fiscal role immediately before dispatch',async()=>{
 let emit,gate,role='fiscal',calls=0;const a={...auth,onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};}};
 const c=createAccessController(a,'https://api.synthetic.test',async(url,o)=>{if(url.endsWith('/me')){if(gate)await gate.promise;return Response.json(me(role));}calls++;assert.equal(o.method,'GET');assert.equal(o.body,undefined);return Response.json(page());}),stop=c.start();await tick();
 try{gate=deferred();emit('TOKEN_REFRESHED',{...session,access_token:'refreshed-082'});await tick();const options={method:'GET'},pending=c.fiscalDraftStatus(BASE,options);options.method='POST';options.body={secret:'must-not-send'};role='consulta';gate.resolve();await assert.rejects(pending,status(403));assert.equal(calls,0);}finally{gate?.resolve();stop();}
});
for(const change of ['logout','actor','role'])test(`082 ${change} suppresses a late fiscal result from the previous access`,async()=>{
 let emit,role='fiscal',actor=ACTOR,signal;const gate=deferred(),a={...auth,onAuthStateChange(fn){emit=fn;return{data:{subscription:{unsubscribe(){}}}};}};
 const c=createAccessController(a,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me(role,actor)):(signal=o.signal,gate.promise)),stop=c.start();await tick();
 try{const pending=c.fiscalDraftStatus(BASE);await tick();if(change==='logout')await c.logout();else{if(change==='actor')actor=OTHER;else role='consulta';emit('TOKEN_REFRESHED',{access_token:'new-082',user:{id:actor}});await tick();}
  gate.resolve(Response.json(page()));await assert.rejects(pending,e=>e.name==='AbortError'||e instanceof AccessError&&e.status===403);if(change!=='role')assert.equal(signal.aborted,true);assert.equal(c.getSnapshot().records,null);
 }finally{gate.resolve(Response.json(page()));stop();}
});
