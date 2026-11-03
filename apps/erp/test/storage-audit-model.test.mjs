import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {parseStorageAuditPlan,actorForStorageAudit,runStorageAudit,StorageAuditError} from '../src/lib/storage-audit-model.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const actor='a0000000-0000-4000-8000-000000000001',other='a0000000-0000-4000-8000-000000000002';
const uuid=i=>`b0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
const entry=(i,body='<synthetic/>',kind='synced_xml')=>({reference_sha256:hash('reference'+i),sha256:hash(body),size_bytes:Buffer.byteLength(body),download:kind==='backup_xml'?{kind,backup_sha256:hash('backup'),xml_sha256:hash(body)}:{kind,item_id:uuid(i)}});
const plan=entries=>({profile:'origin-storage-audit-plan-v1',inventory_sha256:hash('inventory'),inventory_payload_sha256:hash('inventory-payload'),entries});
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const prepared=entries=>parseStorageAuditPlan(encode(plan(entries)));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function until(predicate){for(let i=0;i<1000;i++){if(predicate())return;await nextTurn();}assert.fail('synthetic condition did not settle');}
function fixture(download=async()=>new Blob(['<synthetic/>'])){
 let state={phase:'ready',membership:{user_id:actor,role:'admin'}};const listeners=new Set(),calls=[];
 const call=async(kind,path,signal)=>{calls.push({kind,path,signal});return download({kind,path,signal,index:calls.length-1});};
 const controller={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},historyDownload:(p,s)=>call('backup_xml',p,s),syncedXmlDownload:(p,s)=>call('synced_xml',p,s)};
 return{controller,calls,set(patch){state={...state,...patch};for(const fn of listeners)fn();},get listenerCount(){return listeners.size;}};
}
const noPrivate=report=>{const text=JSON.stringify(report);for(const forbidden of [actor,other,'SECRET_ERROR_BODY','<synthetic','https://','/v1/','Bearer','authorization'])assert.equal(text.includes(forbidden),false);};

test('plan captures bytes before await, hashes original file and freezes every route descriptor',async()=>{
 const original=encode(plan([entry(0)])),expected=hash(original),pending=parseStorageAuditPlan(original);original.fill(32);
 const p=await pending;assert.equal(p.plan_sha256,expected);assert.equal(p.total_bytes,12);assert(Object.isFrozen(p)&&Object.isFrozen(p.plan)&&Object.isFrozen(p.plan.entries)&&Object.isFrozen(p.plan.entries[0])&&Object.isFrozen(p.plan.entries[0].download));
 assert.throws(()=>{p.plan.entries[0].download.item_id=uuid(9);},TypeError);
 const f=fixture();await assert.rejects(runStorageAudit({...p},f.controller),e=>e instanceof StorageAuditError&&e.code==='PLAN_INVALID');assert.equal(f.calls.length,0);
});

test('closed plan schema rejects injected paths, bad identities, duplicates and numeric limits',async()=>{
 const bad=[];const change=fn=>{const p=plan([entry(0)]);fn(p);bad.push(p);};
 change(p=>p.url='https://untrusted.invalid/SECRET_ERROR_BODY');change(p=>p.entries[0].path='/arbitrary');change(p=>p.entries[0].download.url='https://untrusted.invalid');
 change(p=>p.profile='other');change(p=>p.entries=[]);change(p=>p.entries.push(p.entries[0]));change(p=>p.entries[0].size_bytes=-1);change(p=>p.entries[0].size_bytes=0.1);change(p=>p.entries[0].size_bytes=8*1024*1024+1);
 change(p=>p.inventory_sha256='A'.repeat(64));change(p=>p.entries[0].download.item_id=uuid(0).toUpperCase());change(p=>p.entries[0].download.kind='rpc');
 change(p=>{p.entries[0]=entry(0,'<synthetic/>','backup_xml');p.entries[0].download.xml_sha256='f'.repeat(64);});
 for(const value of bad)await assert.rejects(parseStorageAuditPlan(encode(value)),e=>e.code==='PLAN_INVALID');
 await assert.rejects(parseStorageAuditPlan(new Uint8Array(16*1024*1024+1)),e=>e.code==='PLAN_TOO_LARGE');
 await assert.rejects(parseStorageAuditPlan(new Uint8Array([0xff,0xfe])),e=>e.code==='PLAN_INVALID');
 await assert.rejects(prepared(Array.from({length:10001},(_,i)=>entry(i,''))),e=>e.code==='PLAN_INVALID');
 const limit=Array.from({length:512},(_,i)=>({...entry(i),size_bytes:8*1024*1024}));assert.equal((await prepared(limit)).total_bytes,4*1024**3);
 await assert.rejects(prepared([...limit,{...entry(512),size_bytes:1}]),e=>e.code==='PLAN_INVALID');
});

test('zero-byte XML is an invalid plan and cannot initiate a download',async()=>{
 const f=fixture(async()=>new Blob([]));
 await assert.rejects(prepared([entry(0,'')]),e=>e.code==='PLAN_INVALID');assert.equal(f.calls.length,0);
});

test('existing GET ports receive only fixed routes and report ordered byte proofs',async()=>{
 const entries=[entry(0,'<synthetic/>','backup_xml'),entry(1)],p=await prepared(entries),f=fixture(),progress=[];
 const report=await runStorageAudit(p,f.controller,{onProgress:p=>progress.push(p)});
 assert.deepEqual(f.calls.map(c=>[c.kind,c.path]),[['backup_xml',`/v1/history/xml/${entries[0].sha256}/download?backup=${entries[0].download.backup_sha256}`],['synced_xml',`/v1/xmls-sincronizados/${uuid(1)}/download`]]);
 assert.equal(report.status,'completed');assert.equal(report.stop_reason,null);assert.equal(report.read_only,true);assert.equal(report.plan_sha256,p.plan_sha256);
 assert.deepEqual(report.results.map(x=>x.reference_sha256),entries.map(x=>x.reference_sha256));assert(report.results.every(x=>x.status==='verified'&&x.error===null&&x.observed_sha256===hash('<synthetic/>')));
 assert.deepEqual(Object.keys(progress[0]).sort(),['bytes_verified','completed','failed','started_at','total','verified']);assert.equal(progress.at(-1).completed,2);assert.equal(progress.at(-1).bytes_verified,24);assert(Object.isFrozen(report.results));assert.equal(f.listenerCount,0);noPrivate(report);
});

test('two requests at most, out-of-order completion never reorders results or copies result lists into progress',async()=>{
 const gates=Array.from({length:5},deferred),f=fixture(({index})=>gates[index].promise);let active=0,maxActive=0;const original=f.controller.syncedXmlDownload;
 f.controller.syncedXmlDownload=async(...args)=>{active++;maxActive=Math.max(active,maxActive);try{return await original(...args);}finally{active--;}};
 const p=await prepared(Array.from({length:5},(_,i)=>entry(i))),pending=runStorageAudit(p,f.controller);
 await until(()=>f.calls.length===2);gates[1].resolve(new Blob(['<synthetic/>']));await until(()=>f.calls.length===3);gates[2].resolve(new Blob(['<synthetic/>']));await until(()=>f.calls.length===4);
 gates[0].resolve(new Blob(['<synthetic/>']));await until(()=>f.calls.length===5);gates[4].resolve(new Blob(['<synthetic/>']));gates[3].resolve(new Blob(['<synthetic/>']));
 const r=await pending;assert.equal(maxActive,2);assert.deepEqual(r.results.map(x=>x.reference_sha256),p.plan.entries.map(x=>x.reference_sha256));assert(r.results.every(x=>x.status==='verified'));
});

test('size, hash and transport failures stay failures while the next items continue without retry or leaked body',async()=>{
 const f=fixture(({index})=>{if(index===0)return new Blob(['short']);if(index===1)return new Blob(['<different/>']);if(index===2)throw Object.assign(new Error('SECRET_ERROR_BODY https://private.invalid'),{status:503,body:'SECRET_ERROR_BODY'});return new Blob(['<synthetic/>']);});
 const p=await prepared(Array.from({length:4},(_,i)=>entry(i))),r=await runStorageAudit(p,f.controller);
 assert.equal(r.status,'completed');assert.deepEqual(r.results.map(x=>x.error),['SIZE_MISMATCH','HASH_MISMATCH','DOWNLOAD_FAILED',null]);assert.equal(r.results[1].observed_sha256,hash('<different/>'));assert.equal(f.calls.length,4);noPrivate(r);
});

test('actor and role changes abort both running downloads and leave unsent work not attempted',async()=>{
 for(const kind of ['actor','role','signed_out']){
  const late=deferred(),f=fixture(()=>late.promise),p=await prepared(Array.from({length:4},(_,i)=>entry(i))),pending=runStorageAudit(p,f.controller);
  await until(()=>f.calls.length===2);f.set(kind==='signed_out'?{phase:'signed_out',membership:null}:{membership:{user_id:kind==='actor'?other:actor,role:kind==='role'?'consulta':'admin'}});
  const r=await pending;assert.equal(r.status,'stopped');assert.equal(r.stop_reason,'session_changed');assert.equal(f.calls.length,2);assert(f.calls.every(c=>c.signal.aborted));assert.deepEqual(r.results.map(x=>x.status),['failed','failed','not_attempted','not_attempted']);
  late.resolve(new Blob(['<synthetic/>']));await nextTurn();assert(r.results.slice(0,2).every(x=>x.error==='SESSION_CHANGED'));assert.equal(f.listenerCount,0);noPrivate(r);
 }
});

test('401 and403 stop the whole batch and never promote concurrent late success',async()=>{
 for(const status of [401,403]){
  const gate=deferred(),late=deferred(),f=fixture(({index})=>index===0?gate.promise:late.promise),p=await prepared([entry(0),entry(1),entry(2)]),pending=runStorageAudit(p,f.controller);
  await until(()=>f.calls.length===2);gate.reject(Object.assign(new Error('SECRET_ERROR_BODY'),{status}));const r=await pending;
  assert.equal(r.stop_reason,status===401?'unauthorized':'forbidden');assert.equal(r.results[0].error,status===401?'UNAUTHORIZED':'FORBIDDEN');assert.equal(r.results[1].status,'failed');assert.equal(r.results[2].status,'not_attempted');assert(f.calls.every(c=>c.signal.aborted));
  late.resolve(new Blob(['<synthetic/>']));await nextTurn();noPrivate(r);
 }
});

test('explicit abort races an ignoring port and blocks every late response',async()=>{
 const a=new AbortController(),late=deferred(),f=fixture(()=>late.promise),p=await prepared([entry(0),entry(1),entry(2)]),pending=runStorageAudit(p,f.controller,{signal:a.signal});
 await until(()=>f.calls.length===2);a.abort();const r=await pending;assert.equal(r.stop_reason,'aborted');assert(r.results.slice(0,2).every(x=>x.error==='ABORTED'));assert.equal(r.results[2].status,'not_attempted');
 const saved=JSON.stringify(r);late.resolve(new Blob(['<synthetic/>']));await nextTurn();assert.equal(JSON.stringify(r),saved);noPrivate(r);
 const f2=fixture();const stopped=await runStorageAudit(p,f2.controller,{signal:a.signal});assert.equal(f2.calls.length,0);assert(stopped.results.every(x=>x.status==='not_attempted'));
 await assert.rejects(parseStorageAuditPlan(encode(plan([entry(0)])),a.signal),e=>e.code==='ABORTED');
});

test('session checks also cover Blob consumption after the download await',async()=>{
 const gate=deferred();class DelayedBlob extends Blob{arrayBuffer(){return gate.promise;}}
 const f=fixture(async()=>new DelayedBlob(['<synthetic/>'])),p=await prepared([entry(0)]),pending=runStorageAudit(p,f.controller);
 await until(()=>f.calls.length===1);await nextTurn();f.set({membership:{user_id:actor,role:'consulta'}});gate.resolve(new TextEncoder().encode('<synthetic/>').buffer);
 const r=await pending;assert.equal(r.results[0].status,'failed');assert.equal(r.results[0].observed_sha256,null);assert.equal(r.stop_reason,'session_changed');
});

test('digest failure is sanitized and an abort during an unfinished digest cannot record success',async t=>{
 const p=await prepared([entry(0)]),f=fixture();
 const digest=t.mock.method(crypto.subtle,'digest',async()=>{throw new Error('SECRET_ERROR_BODY');});
 const failed=await runStorageAudit(p,f.controller);assert.equal(failed.results[0].error,'HASH_FAILED');noPrivate(failed);digest.mock.restore();
 const gate=deferred(),a=new AbortController(),f2=fixture();let hashing=false;
 t.mock.method(crypto.subtle,'digest',()=>{hashing=true;return gate.promise;});
 const pending=runStorageAudit(p,f2.controller,{signal:a.signal});await until(()=>hashing);a.abort();const r=await pending;
 assert.equal(r.results[0].error,'ABORTED');assert.equal(r.results[0].observed_sha256,null);
 gate.resolve(new Uint8Array(Buffer.from(hash('<synthetic/>'),'hex')).buffer);await nextTurn();assert.equal(r.results[0].status,'failed');noPrivate(r);
});

test('45second item deadline applies even when a port ignores abort, with no auto retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const never=deferred(),f=fixture(({index})=>index===0?never.promise:new Blob(['<synthetic/>']));let good=0;
 const p=await prepared([entry(0),entry(1),entry(2)]),pending=runStorageAudit(p,f.controller,{onProgress:p=>{good=p.verified;}});
 await until(()=>good===2);t.mock.timers.tick(45_000);const r=await pending;assert.equal(r.status,'completed');assert.equal(r.results[0].error,'TIMEOUT');assert(r.results.slice(1).every(x=>x.status==='verified'));assert.equal(f.calls.length,3);assert.equal(f.calls[0].signal.aborted,true);never.resolve(new Blob(['<synthetic/>']));
});

test('unavailable access and progress callback failures cannot authorize work or leak errors',async()=>{
 const f=fixture();assert.equal(actorForStorageAudit(f.controller),actor);f.set({phase:'checking'});assert.equal(actorForStorageAudit(f.controller),null);
 const p=await prepared([entry(0)]),r=await runStorageAudit(p,f.controller);assert.equal(r.stop_reason,'access_unavailable');assert.equal(f.calls.length,0);
 const good=fixture(),ok=await runStorageAudit(p,good.controller,{onProgress:()=>{throw new Error('SECRET_ERROR_BODY');}});assert.equal(ok.results[0].status,'verified');noPrivate(ok);
});
