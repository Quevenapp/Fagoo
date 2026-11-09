import test from 'node:test';import assert from 'node:assert/strict';import {createAccessController} from '../src/lib/real-access.ts';
const actor='10000000-0000-4000-8000-000000000001',session={access_token:'synthetic',user:{id:actor}};
const me={user_id:actor,role:'operacao',resources:[],data_mode:'staging_readonly'};
const tick=()=>new Promise(r=>setTimeout(r,0));
function auth(){return {getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};}
test('communication media stays behind authenticated origin and preserves binary bytes',async()=>{
 const calls=[],controller=createAccessController(auth(),'https://api.example.test',async(url,options)=>{
  if(url.endsWith('/me'))return Response.json(me);calls.push(options);return new Response(new Uint8Array([0,255,3]),{headers:{'Content-Type':'audio/ogg'}});
 });const stop=controller.start();await tick();try{
  const response=await controller.communication('/v1/communication/units/u/media/m/content',{rawResponse:true});
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,255,3]);assert.equal(calls[0].redirect,'error');assert.equal(calls[0].headers.Authorization,'Bearer synthetic');
  for(const path of ['https://evil.test/x','/v1/communication/../me','/v1/communication/%2e%2e/me'])await assert.rejects(()=>controller.communication(path),{status:400});
 }finally{stop();}
});
test('a private media response finishing after session exit cannot reach the UI',async()=>{
 let resolve,signal;const controller=createAccessController(auth(),'https://api.example.test',async(url,options)=>url.endsWith('/me')?Response.json(me):new Promise(r=>{resolve=r;signal=options.signal;}));
 const stop=controller.start();await tick();const pending=controller.communication('/v1/communication/units/u/media/m/content',{rawResponse:true});await tick();
 stop();assert.equal(signal.aborted,true);resolve(new Response('private'));
 await assert.rejects(pending,error=>error.name==='AbortError');
});
test('uploads use scoped binary PUT and explicit idempotency without exposing credentials',async()=>{
 let sent;const controller=createAccessController(auth(),'https://api.example.test',async(url,options)=>{if(url.endsWith('/me'))return Response.json(me);sent=options;return Response.json({ok:true});});
 const stop=controller.start();await tick();try{
  const bytes=new Uint8Array([1,2,3]);await controller.communication('/v1/communication/units/u/media/uploads/m/parts/0',{method:'PUT',body:bytes,idempotencyKey:'command-123',contentType:'application/octet-stream'});
  assert.equal(sent.body,bytes);assert.equal(sent.method,'PUT');assert.equal(sent.headers['Idempotency-Key'],'command-123');assert.equal(sent.headers['Content-Type'],'application/octet-stream');
 }finally{stop();}
});
