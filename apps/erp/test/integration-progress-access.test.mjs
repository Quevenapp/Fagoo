import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const me=role=>({user_id:uid,role,resources:[],data_mode:'staging_readonly'});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('033 controller denies every non-admin role without requesting an aggregate or restarting membership',async()=>{
 for(const role of ['consulta','vendas','financeiro','estoque','fiscal']){
  let checks=0,queries=0;const c=createAccessController(auth,'https://api.example.test',async url=>{if(url.endsWith('/me')){checks++;return Response.json(me(role));}queries++;return Response.json({});});
  const stop=c.start();await tick();try{await assert.rejects(()=>c.integrationProgress('/v1/integracao-origin'),status(403));assert.equal(queries,0);assert.equal(checks,1);assert.equal(c.getSnapshot().phase,'ready');}finally{stop();}
 }
});
test('033 controller only calls its fixed GET endpoint with bounded JSON and verified session token',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me('admin'));calls.push({url,options});return Response.json({privateResult:'fixture'});});const stop=c.start();await tick();
 try{
  await c.integrationProgress('/v1/integracao-origin');assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].options.redirect,'error');assert.equal(c.getSnapshot().privateResult,undefined);
  for(const method of ['POST','PATCH','DELETE'])await assert.rejects(()=>c.integrationProgress('/v1/integracao-origin',{method}),status(400));
  await assert.rejects(()=>c.integrationProgress('/v1/integracao-origin',{body:{}}),status(400));
  for(const path of ['/v1/integracao-origin?actor=x','/v1/integracao-origin/extra','/admin/status','https://other.invalid/v1/integracao-origin','/v1/integracao-origin/../inicio'])await assert.rejects(()=>c.integrationProgress(path),status(400));
  assert.equal(calls.length,1);
 }finally{stop();}
 const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me('admin')):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(1024*1024+1)}}));const end=bounded.start();await tick();try{await assert.rejects(()=>bounded.integrationProgress('/v1/integracao-origin'),status(502));}finally{end();}
});
test('033 late response is aborted after logout; permission loss rechecks and cannot loop through another aggregate',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me('admin'));signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const result=c.integrationProgress('/v1/integracao-origin');await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({private:'late'}));await assert.rejects(result,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
 let checks=0,queries=0;const changed=createAccessController(auth,'https://api.example.test',async url=>{if(url.endsWith('/me'))return Response.json(me(++checks===1?'admin':'consulta'));queries++;return Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403});});const end=changed.start();await tick();
 try{await assert.rejects(()=>changed.integrationProgress('/v1/integracao-origin'),status(403));await tick();assert.equal(changed.getSnapshot().membership.role,'consulta');await assert.rejects(()=>changed.integrationProgress('/v1/integracao-origin'),status(403));assert.equal(checks,2);assert.equal(queries,1);}finally{end();}
});
