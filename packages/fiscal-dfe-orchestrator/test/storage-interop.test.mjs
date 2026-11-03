import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,BUCKET,hash} from './fixture.mjs';
import {createDfeStorage} from '../../fiscal-dfe-storage/src/storage.mjs';

let f;
before(async()=>{f=await fixture();});
beforeEach(()=>f.reset());
after(()=>f?.close());

// This mandatory HTTP driver never performs a network call. It emulates only
// immutable object creation/read and creates metadata in the same in-memory DB.
function memoryHttp({loseJournalAck=false,corruptRead=()=>false,redirect=false}={}){
 const calls=[];let lost=false;
 const port=createDfeStorage({projectUrl:'https://abcdefghijklmnopqrst.supabase.co',serviceKey:'synthetic-storage-service-key',fetchImpl:async(url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://abcdefghijklmnopqrst.supabase.co');assert.equal(parsed.search,'');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,'Bearer synthetic-storage-service-key');assert.ok(options.signal instanceof AbortSignal);
  const prefix=`/storage/v1/object/${options.method==='GET'?'authenticated/':''}${BUCKET}/`;assert.ok(parsed.pathname.startsWith(prefix));const key=parsed.pathname.slice(prefix.length);assert.match(key,/^(?:objects\/[a-f0-9]{64}|responses\/[a-f0-9-]{36}\/[a-f0-9]{64})\.xml$/);calls.push({method:options.method,key});
  if(redirect)return new Response(null,{status:307,headers:{Location:'https://not-followed.invalid/object'}});
  if(options.method==='POST'){
   assert.equal(options.headers['x-upsert'],'false');assert.equal(options.headers['If-None-Match'],'*');assert.equal(options.headers['Content-Type'],'application/octet-stream');const bytes=Buffer.from(options.body);assert.equal(options.headers['Content-Length'],String(bytes.length));
   if(f.files.has(key))return Response.json({error:'Duplicate'},{status:400});
   await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',[BUCKET,key,JSON.stringify({size:bytes.length,mimetype:'application/octet-stream'})]);f.files.set(key,bytes);
   if(loseJournalAck&&!lost&&key.startsWith('responses/')){lost=true;throw new Error('SYNTHETIC_RESPONSE_LOST');}
   return Response.json({Key:'opaque-provider-ack'},{status:201});
  }
  assert.equal(options.method,'GET');const bytes=f.files.get(key);if(!bytes)return Response.json({code:'NoSuchKey'},{status:404});
  return new Response(corruptRead(key)?Buffer.from('SYNTHETIC_CORRUPT_BODY'):Buffer.from(bytes),{headers:{'Content-Type':'application/octet-stream'}});
 }});
 return{port,calls};
}

test('orchestrator→strict HTTP Storage→SQL045 preserves bytes and recovers lost POST acknowledgement',async()=>{
 const j=await f.job(),http=memoryHttp({loseJournalAck:true}),result=await f.orchestrator({storage:http.port}).run(j);
 assert.equal(result.status,'stored',JSON.stringify(result));assert.equal(result.current.checkpoint,'000000000000001');assert.equal(f.calls.transport.length,1);assert.equal(http.calls.filter(x=>x.method==='POST').length,3);assert.equal(http.calls.filter(x=>x.method==='GET').length,4);assert.equal((await f.documents(j)).items.length,1);
 const bytes=await f.scalar("select count(*)::int value from storage.objects where bucket_id='brufap-received-dfe'");assert.equal(bytes,3);
 const receipt=result.receipt,canonical=f.files.get(`objects/${receipt.response_hash}.xml`);assert.equal(hash(canonical),receipt.response_hash);assert.equal(hash([...f.files.entries()].find(([key])=>key.startsWith('responses/'))[1]),receipt.response_hash);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-storage-service-key|Authorization|supabase\.co|<retDist/);
});

test('HTTP readback hash failure blocks atomic finalization; immutable duplicate replay recovers without transport',async()=>{
 const j=await f.job();let corrupt=true;const http=memoryHttp({corruptRead:key=>corrupt&&key.startsWith('objects/')}),app=f.orchestrator({storage:http.port});
 const failed=await app.run(j);assert.equal(failed.status,'review_required');assert.equal(failed.phase,'storage');assert.equal((await f.documents(j)).items.length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_finalize').length,0);
 const original=[...f.files].map(([key,bytes])=>[key,hash(bytes)]);corrupt=false;const recovered=await app.run(j);assert.equal(recovered.status,'stored');assert.equal(f.calls.transport.length,1);for(const[key,digest]of original)assert.equal(hash(f.files.get(key)),digest);assert.equal((await f.documents(j)).items.length,1);
 assert.ok(http.calls.filter(x=>x.method==='POST'&&x.key.startsWith('objects/')).length>=3);
});

test('a redirect while checking journal is not absence and prevents obtaining a dispatch ticket',async()=>{
 const j=await f.job(),http=memoryHttp({redirect:true}),result=await f.orchestrator({storage:http.port}).run(j);
 assert.equal(result.status,'blocked');assert.equal(result.phase,'journal');assert.equal(http.calls.length,1);assert.equal(f.calls.authorization.length,0);assert.equal(f.calls.transport.length,0);assert.equal(f.calls.rpc.filter(x=>x.name==='erp_dfe_dispatch').length,0);assert.equal((await f.settings()).current.checkpoint,'000000000000000');
});
