import test from 'node:test';import assert from 'node:assert/strict';
import {createAccessController,AccessError} from '../src/lib/real-access.ts';
const uid='a0000000-0000-4000-8000-000000000001',id='b0000000-0000-4000-8000-000000000001',session={access_token:'synthetic-token',user:{id:uid}},me={user_id:uid,role:'admin',resources:[],data_mode:'staging_readonly'};
const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),status=n=>e=>e instanceof AccessError&&e.status===n;
test('review and stock controller ports stay scoped; stock disallows all writes before network',async()=>{
 const calls=[];const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);calls.push({url,options});return Response.json({privateFixture:true});});const stop=c.start();await tick();
 try{await c.stockPositions('/v1/posicoes-estoque?stock_state=no_movements');await c.cnabReview(`/v1/conferencia-retornos/events/${id}/preview`,{method:'POST',body:{file_id:id,line:2}});
  assert.equal(calls.length,2);assert.equal(calls[1].options.headers.Authorization,'Bearer synthetic-token');assert.equal(calls[1].options.redirect,'error');assert.equal(c.getSnapshot().privateFixture,undefined);
  for(const path of ['https://other.invalid/v1/posicoes-estoque','/v1/posicoes-estoque-other','/v1/posicoes-estoque/../outro'])await assert.rejects(()=>c.stockPositions(path),status(400));
  for(const options of [{method:'POST'},{method:'PATCH'},{body:{}}])await assert.rejects(()=>c.stockPositions('/v1/posicoes-estoque',options),status(400));
  await assert.rejects(()=>c.cnabReview('/v1/cnab/events'),status(400));assert.equal(calls.length,2);
 }finally{stop();}
});
test('review private read aborts on logout and cannot revive a late result',async()=>{
 let finish,signal;const c=createAccessController(auth,'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);signal=options.signal;return new Promise(resolve=>{finish=resolve;});});const stop=c.start();await tick();
 const pending=c.cnabReview(`/v1/conferencia-retornos/files/${id}`);await tick();await c.logout();assert.equal(signal.aborted,true);finish(Response.json({privateFixture:true}));await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(c.getSnapshot().phase,'signed_out');stop();
});
