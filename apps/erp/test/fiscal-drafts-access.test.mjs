import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',draft='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'fiscal',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('fiscal draft controller scopes requests, keeps bearer in headers and never stores fiscal responses in shared state',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({privateDraft:'fixture'});});const stop=c.start();await tick();
 try{await c.fiscalDraft('/v1/rascunhos-fiscais?model=65');await c.fiscalDraft(`/v1/rascunhos-fiscais/${draft}`,{method:'PATCH',body:{expected_version:1,preparation:{notes:'Fictício'}}});
  assert.equal(calls.length,2);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[1].options.redirect,'error');assert.equal(c.getSnapshot().privateDraft,undefined);
  for(const path of ['https://other.invalid/v1/rascunhos-fiscais','/v1/rascunhos-fiscais-other',`/v1/rascunhos-fiscais/${draft}/../outro`])await assert.rejects(()=>c.fiscalDraft(path),status(400));assert.equal(calls.length,2);
 }finally{stop();}
});
test('fiscal draft operations abort on logout and a late reply cannot revive private data',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.fiscalDraft('/v1/rascunhos-fiscais',{method:'POST',body:{}});await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({privateDraft:'late'}));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
test('fiscal draft responses are bounded and revoked fiscal access is rechecked',async()=>{
 let checks=0;const c=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'fiscal':'vendas'}):Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}));const stop=c.start();await tick();await assert.rejects(()=>c.fiscalDraft('/v1/rascunhos-fiscais'),status(403));await tick();assert.equal(c.getSnapshot().membership.role,'vendas');assert.equal(checks,2);stop();
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(4*1024*1024+1)}}));const stopB=bounded.start();await tick();try{await assert.rejects(()=>bounded.fiscalDraft('/v1/rascunhos-fiscais'),status(502));}finally{stopB();}
});
