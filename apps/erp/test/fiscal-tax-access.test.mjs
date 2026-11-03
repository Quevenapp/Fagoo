import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',draft='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'fiscal',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('040 controller scopes requests, rejects redirects and keeps private preparations out of shared state',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({privatePreparation:'fixture'});});const stop=c.start();await tick();
 try{await c.fiscalTax(`/v1/preparacao-tributaria/${draft}`);await c.fiscalTax(`/v1/preparacao-tributaria/${draft}/preview`,{method:'POST',body:{decisions:[]}});
  assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[1].options.redirect,'error');assert.equal(calls[1].options.cache,'no-store');assert.equal(c.getSnapshot().privatePreparation,undefined);
  for(const path of['https://other.invalid/v1/preparacao-tributaria','/v1/preparacao-tributaria-other',`/v1/preparacao-tributaria/${draft}/../outro`])await assert.rejects(()=>c.fiscalTax(path),status(400));assert.equal(calls.length,2);
 }finally{stop();}
});
test('040 controller logout aborts the body and rejects late preparation data',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.fiscalTax(`/v1/preparacao-tributaria/${draft}`,{method:'POST',body:{}});await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({privatePreparation:'late'}));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
test('040 controller enforces 2 MiB and rechecks revoked membership',async()=>{
 let checks=0;const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'fiscal':'vendas'}):Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}));const stop=c.start();await tick();await assert.rejects(()=>c.fiscalTax(`/v1/preparacao-tributaria/${draft}`),status(403));await tick();assert.equal(c.getSnapshot().membership.role,'vendas');assert.equal(checks,2);stop();
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(2*1024*1024+1)}}));const end=bounded.start();await tick();try{await assert.rejects(()=>bounded.fiscalTax(`/v1/preparacao-tributaria/${draft}`),status(502));}finally{end();}
});
