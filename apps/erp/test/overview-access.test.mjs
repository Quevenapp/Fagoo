import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',sha='a'.repeat(64),session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),isStatus=status=>e=>e instanceof AccessError&&e.status===status;
test('home and cutover clients permit only scoped GET and keep source data out of controller state',async()=>{
 const calls=[];const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({privateResult:'fixture'});});const stop=controller.start();await tick();
 try{await controller.home('/v1/inicio');await controller.cutover('/v1/preparacao-virada');await controller.cutover(`/v1/preparacao-virada/${sha}/contacts?limit=25&q=QA`);assert.equal(calls.length,3);assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[0].options.redirect,'error');assert.equal(controller.getSnapshot().privateResult,undefined);
  for(const method of ['POST','PATCH','DELETE']){await assert.rejects(()=>controller.home('/v1/inicio',{method}),isStatus(400));await assert.rejects(()=>controller.cutover('/v1/preparacao-virada',{method}),isStatus(400));}
  await assert.rejects(()=>controller.home('/v1/inicio',{body:{}}),isStatus(400));await assert.rejects(()=>controller.cutover('/v1/preparacao-virada',{body:{}}),isStatus(400));
  for(const path of ['/v1/inicio?actor=x','/v1/inicio/extra','https://other.invalid/v1/inicio'])await assert.rejects(()=>controller.home(path),isStatus(400));
  for(const path of ['/v1/preparacao-virada?actor=x','/v1/preparacao-virada-other',`/v1/preparacao-virada/${sha}/unknown`,`/v1/preparacao-virada/${sha}/contacts/../products`])await assert.rejects(()=>controller.cutover(path),isStatus(400));assert.equal(calls.length,3);
 }finally{stop();}
});
test('overview clients bound responses and discard late data on logout',async()=>{
 for(const [method,path]of [['home','/v1/inicio'],['cutover','/v1/preparacao-virada']]){
  let finish,signal;const controller=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=controller.start();await tick();const pending=controller[method](path);await tick();await controller.logout();assert.equal(signal.aborted,true);finish(Response.json({value:'late'}));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(controller.getSnapshot().phase,'signed_out');stop();
  const bounded=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json(me):new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':String(1024*1024+1)}}));const stopBounded=bounded.start();await tick();try{await assert.rejects(()=>bounded[method](path),isStatus(502));}finally{stopBounded();}
 }
});
test('cutover permission revocation clears old session state and rechecks membership',async()=>{
 let checks=0;const controller=createAccessController(auth,'https://api.example.test',async url=>url.endsWith('/me')?Response.json({...me,role:++checks===1?'admin':'consulta'}):Response.json({error:{code:'ERP_FORBIDDEN'}},{status:403}));const stop=controller.start();await tick();
 try{await assert.rejects(()=>controller.cutover('/v1/preparacao-virada'),isStatus(403));await tick();assert.equal(checks,2);assert.equal(controller.getSnapshot().membership.role,'consulta');}finally{stop();}
});
