// Independent review probes. All data and RPCs are local, synthetic and in-memory.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';

let f;before(async()=>{f=await fixture();});after(()=>f?.close());
const deferred=()=>Promise.withResolvers();
const count=name=>f.calls.rpc.filter(v=>v.name==='erp_fiscal_unsigned_'+name).length;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('abort during a committed upload prevents finish, wipes borrowed bytes and recovers the same immutable object',async()=>{
 const j=await f.input(await f.prepare()),entered=deferred(),release=deferred(),controller=new AbortController();let borrowed;
 const finishes=count('finish'),orchestrator=f.orchestrator({storage:{...f.ports.storage,putImmutable:async input=>{
  borrowed=input.bytes;const ack=await f.ports.storage.putImmutable(input);entered.resolve();await release.promise;return ack;
 }}});
 const pending=orchestrator.run(j,{signal:controller.signal});await entered.promise;controller.abort();
 try{
  const result=await pending;assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_ABORTED');assert.equal(result.phase,'storage');
  assert.equal(count('finish'),finishes);assert.ok(borrowed.every(v=>v===0));assert.equal((await f.command(j)).current.state,'pending');
 }finally{release.resolve();await tick();}
 const puts=f.calls.put.length;await f.expire(j);const recovered=await f.orchestrator().run(j);
 assert.equal(recovered.status,'stored');assert.equal(recovered.storage_operations,1);assert.equal(f.calls.put.length,puts);
});

test('abort cancels a partial readback stream and cannot finalize an incomplete body',async()=>{
 const j=await f.input(await f.prepare()),entered=deferred(),controller=new AbortController();let cancelled=false;
 const finishes=count('finish'),orchestrator=f.orchestrator({storage:{...f.ports.storage,read:async input=>{
  const response=await f.ports.storage.read(input);if(!response)return null;
  const bytes=new Uint8Array(await response.arrayBuffer());
  const body=new ReadableStream({start(c){c.enqueue(bytes.slice(0,1));entered.resolve();},cancel(){cancelled=true;}});
  return new Response(body,{headers:{'content-type':'application/octet-stream','content-length':String(bytes.length)}});
 }}});
 const pending=orchestrator.run(j,{signal:controller.signal});await entered.promise;await tick();controller.abort();const result=await pending;await tick();
 assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_ABORTED');assert.equal(cancelled,true);assert.equal(count('finish'),finishes);
 assert.equal((await f.command(j)).artifact,null);const puts=f.calls.put.length;await f.expire(j);
 assert.equal((await f.orchestrator().run(j)).status,'stored');assert.equal(f.calls.put.length,puts);
});

test('global deadline includes a stream that never finishes and releases its reader without a new RPC',async()=>{
 const j=await f.input(await f.prepare()),entered=deferred();let cancelled=false;
 const finishes=count('finish'),orchestrator=f.orchestrator({storage:{...f.ports.storage,read:async input=>{
  const response=await f.ports.storage.read(input);if(!response)return null;
  return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([60]));entered.resolve();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/octet-stream'}});
 }}});
 const start=Date.now(),pending=orchestrator.run(j,{deadline:start+300});await entered.promise;
 const result=await pending;await tick();assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_TIMEOUT');assert.equal(cancelled,true);
 assert.ok(Date.now()-start<1500);assert.equal(count('finish'),finishes);assert.equal((await f.command(j)).artifact,null);
});

test('abort after finish was committed does not start recovery I/O; a later call reads the same terminal command',async()=>{
 const j=await f.input(await f.prepare()),entered=deferred(),release=deferred(),controller=new AbortController();
 const orchestrator=f.orchestrator({rpc:async(name,args,options)=>{
  const response=await f.rpc(name,args,options);if(name.endsWith('_finish')){entered.resolve();await release.promise;}return response;
 }});
 const pending=orchestrator.run(j,{signal:controller.signal});await entered.promise;const calls=f.calls.rpc.length;controller.abort();
 try{
  const result=await pending;assert.equal(result.status,'recoverable');assert.equal(result.code,'UNSIGNED_ABORTED');assert.equal(result.phase,'finish');
  assert.equal(result.xml_generated,null);assert.equal(f.calls.rpc.length,calls);
 }finally{release.resolve();await tick();}
 const counts=await f.counts(),puts=f.calls.put.length,reads=f.calls.read.length,recovered=await f.orchestrator().run(j);
 assert.equal(recovered.status,'stored');assert.equal(recovered.recovered,true);assert.equal(f.calls.put.length,puts);assert.equal(f.calls.read.length,reads);assert.deepEqual(await f.counts(),counts);
});

test('fallback after a lost finish ACK refuses a different job, hash or size despite an otherwise valid stored envelope',async()=>{
 for(const change of[r=>r.artifact.xml_hash='f'.repeat(64),r=>r.artifact.size_bytes++,r=>{r.receipt.job_id='f0000000-0000-4000-8000-000000000001';r.current.latest_job_id=r.receipt.job_id;}]){
  const j=await f.input(await f.prepare());let committed=false;
  const result=await f.orchestrator({rpc:async(name,args,options)=>{
   const response=await f.rpc(name,args,options);
   if(name.endsWith('_finish')){committed=true;throw new Error('synthetic lost ACK');}
   if(committed&&name.endsWith('_command'))change(response);return response;
  }}).run(j);
  assert.equal(result.status,'recoverable');assert.equal(result.outcome,'unconfirmed');assert.equal(result.xml_generated,null);assert.equal(result.artifact,undefined);
  assert.equal((await f.command(j)).current.state,'stored');assert.equal((await f.orchestrator().run(j)).status,'stored');
 }
});
