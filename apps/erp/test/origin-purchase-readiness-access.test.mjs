import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
import {ACTOR,BASE,page,deferred} from './helpers/purchase-readiness-fixtures.mjs';
const tick=()=>new Promise(r=>setTimeout(r,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
const session={access_token:'synthetic-token-076',user:{id:ACTOR}},me=role=>({user_id:ACTOR,role,resources:[],data_mode:'staging_readonly'});
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
test('076 real controller rejects other roles and every mutation without business fetch',async()=>{
 for(const role of ['admin','consulta','vendas','financeiro','estoque','fiscal']){
  let calls=0;const c=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me(role)):(calls++,Response.json(page()))),stop=c.start();await tick();
  try{if(role!=='admin')await assert.rejects(()=>c.purchaseReadiness(BASE),status(403));else{
   for(const options of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(()=>c.purchaseReadiness(BASE,options),status(400));
   for(const p of [BASE+'?actor='+ACTOR,BASE+'/../inicio',BASE+'/%31',BASE+'?limit=26'])await assert.rejects(()=>c.purchaseReadiness(p),status(400));
  }assert.equal(calls,0);}finally{stop();}
 }
});
test('076 real controller captures GET options and enforces response size',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me('admin')):(calls.push({url,o}),Response.json(page()))),stop=c.start();await tick();
 try{const options={method:'GET'},result=c.purchaseReadiness(BASE+'?limit=25',options);options.method='POST';options.body={changed:true};await result;assert.equal(calls.length,1);assert.equal(calls[0].o.method,'GET');assert.equal(calls[0].o.body,undefined);assert.equal(calls[0].o.headers.Authorization,'Bearer synthetic-token-076');assert.equal(calls[0].o.redirect,'error');}finally{stop();}
 const large=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me('admin')):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1048577'}})),end=large.start();await tick();try{await assert.rejects(()=>large.purchaseReadiness(BASE),status(502));}finally{end();}
});
test('076 logout suppresses late data and current permission loss prevents the next query',async()=>{
 const gate=deferred();let signal;const c=createAccessController(auth,'https://api.synthetic.test',async(url,o)=>url.endsWith('/me')?Response.json(me('admin')):(signal=o.signal,gate.promise)),stop=c.start();await tick();
 const read=c.purchaseReadiness(BASE);await tick();await c.logout();gate.resolve(Response.json(page()));await assert.rejects(read,e=>e.name==='AbortError');assert.equal(signal.aborted,true);stop();
 let checks=0,calls=0;const changed=createAccessController(auth,'https://api.synthetic.test',async url=>url.endsWith('/me')?Response.json(me(++checks===1?'admin':'consulta')):(calls++,Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}))),end=changed.start();await tick();
 try{await assert.rejects(()=>changed.purchaseReadiness(BASE),status(403));await tick();await assert.rejects(()=>changed.purchaseReadiness(BASE),status(403));assert.equal(calls,1);assert.equal(changed.getSnapshot().membership.role,'consulta');}finally{end();}
});
