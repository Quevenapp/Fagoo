import test from 'node:test';import assert from 'node:assert/strict';
import {backupCapabilities,backupCrc32,prepareBackupBundle,uploadBackupBundle,backupResult,sendBackupItems} from '../src/lib/backup-import.ts';
import {captureBackupRequest,readBackupResponse} from '../src/lib/backup-import-client.ts';
import {backupFixture,storedZip} from './helpers/backup-import-fixture.mjs';
test('prepared ZIP validates CRC, exact manifest and all opaque bytes before upload',async()=>{
 const f=backupFixture(),progress=[],slices=[];assert.equal(backupCrc32(Buffer.from('123456789')),0xcbf43926);
 const file=new Blob([f.zip]),original=file.slice.bind(file);file.arrayBuffer=()=>{throw Error('Never read entire archive');};file.slice=(a,b)=>{slices.push(b-a);return original(a,b);};
 const bundle=await prepareBackupBundle(file,backupCapabilities(f.capabilities),{onProgress:p=>progress.push(p)});
 assert.equal(progress.at(-1).completed,f.files.length);assert.ok(Math.max(...slices)<file.size);
 for(const [name,bytes]of f.files)assert.deepEqual(Buffer.from(await bundle.content(name).arrayBuffer()),bytes);
 assert.deepEqual(f.calls,[]);assert.equal(Object.isFrozen(bundle.capabilities.objects[0]),true);
});
test('capabilities reject oversized, duplicate, misbound descriptors and disabled has no write contract',()=>{
 assert.equal(backupCapabilities({profile:'origin-backup-import-capabilities-v1',enabled:false}),null);
 for(const mutate of [c=>c.limits.archive_bytes++,c=>c.limits.concurrency=8,c=>c.objects[0].size=41943041,c=>c.objects[0].local='../escape',c=>c.objects[0].key=c.objects[1].key,c=>c.objects[1]=c.objects[0],c=>c.chunks[0].sha256='b'.repeat(64),c=>c.summary.counts.xml++,c=>c.summary.operational_effects=true]){
  const c=structuredClone(backupFixture().capabilities);mutate(c);assert.throws(()=>backupCapabilities(c));
 }
});
test('ZIP rejects compression, encryption, data descriptors, zip64, symlinks, inconsistent local/central and overlap',async()=>{
 const f=backupFixture(),end=f.zip.length-22,central=f.zip.readUInt32LE(end+16);
 const changes=[b=>b.writeUInt16LE(8,central+10),b=>b.writeUInt16LE(1,central+8),b=>b.writeUInt16LE(8,central+8),b=>b.writeUInt16LE(45,central+6),b=>b.writeUInt32LE(0xa1800000,central+38),b=>b.writeUInt16LE(1,central+30),b=>b.writeUInt16LE(1,28),b=>b.writeUInt32LE(1,central+42),b=>b.writeUInt32LE(0,central+16),b=>b.writeUInt16LE(1,end+4),b=>b.writeUInt16LE(65535,end+10),b=>b.writeUInt32LE(0xffffffff,end+16),b=>b.writeUInt16LE(1,end+20),b=>b[30]=0];
 for(const change of changes){const b=Buffer.from(f.zip);change(b);await assert.rejects(()=>prepareBackupBundle(new Blob([b]),f.capabilities));}
});
test('ZIP rejects unsafe, duplicate, missing, extra entries and altered data even with matching CRC',async()=>{
 const f=backupFixture();for(const files of [[...f.files,['extra.txt',Buffer.from('x')]],f.files.slice(1),[...f.files.slice(0,-1),f.files[0]],f.files.map(([p,b],i)=>[i===1?'objects/../escape':p,b]),f.files.map(([p,b],i)=>[p,i===1?Buffer.alloc(b.length,65):b])])await assert.rejects(()=>prepareBackupBundle(new Blob([storedZip(files)]),f.capabilities));
 const corrupt=Buffer.from(f.zip);corrupt[30+'manifest.json'.length]^=1;await assert.rejects(()=>prepareBackupBundle(new Blob([corrupt]),f.capabilities));
 const large=new Blob();Object.defineProperty(large,'size',{value:536870913});large.slice=()=>{throw Error('Should not read oversized archive');};await assert.rejects(()=>prepareBackupBundle(large,f.capabilities),/BACKUP_IMPORT_INVALID/);
});
test('validation cancellation prevents any begin, and uploads remain bounded to four with byte-exact chunks',async()=>{
 const f=backupFixture(),abort=new AbortController();abort.abort();await assert.rejects(()=>prepareBackupBundle(new Blob([f.zip]),f.capabilities,{signal:abort.signal}),e=>e.name==='AbortError');assert.equal(f.calls.length,0);
 const bundle=await prepareBackupBundle(new Blob([f.zip]),f.capabilities);let inflight=0,max=0;
 const request=async(path,o)=>{if(o.body){inflight++;max=Math.max(max,inflight);await new Promise(r=>setTimeout(r,2));const expected=f.files.find(([p])=>path.endsWith('/'+p)||f.capabilities.chunks.some(c=>p===c.local&&path.endsWith(`/chunks/${c.kind}/${c.sha256}`)));assert.deepEqual(Buffer.from(await o.body.arrayBuffer()),expected[1]);inflight--;}return f.request(path,o);};
 assert.deepEqual(await uploadBackupBundle(bundle,request),f.result);assert.equal(max,4);assert.ok(f.calls.at(-1).path.endsWith('/finish'));assert.ok(f.calls.every(c=>c.manifestHash===f.capabilities.manifest_sha256));
});
test('malformed upload ACK and cancellation stop before finish; uncertain finish replays exact same identities',async()=>{
 const f=backupFixture(),bundle=await prepareBackupBundle(new Blob([f.zip]),f.capabilities);let lost=true;
 const request=async(path,o)=>{const r=await f.request(path,o);if(path.endsWith('/finish')&&lost){lost=false;throw Error('ACK lost');}return r;};
 await assert.rejects(()=>uploadBackupBundle(bundle,request));f.calls.length=0;
 await uploadBackupBundle(bundle,request);assert.deepEqual(f.calls.map(c=>c.path),['/v1/backup-import/begin','/v1/backup-import/finish']);
 const fresh=await prepareBackupBundle(new Blob([f.zip]),f.capabilities);
 f.calls.length=0;await assert.rejects(()=>uploadBackupBundle(fresh,async(p,o)=>({...await f.request(p,o),...(p.includes('/objects/')?{verified:false}:{})})));assert.ok(f.calls.every(c=>!c.path.endsWith('/finish')));
 const a=new AbortController();f.calls.length=0;await assert.rejects(()=>uploadBackupBundle(bundle,async(p,o)=>{const r=await f.request(p,o);a.abort();return r;},{signal:a.signal}),e=>e.name==='AbortError');assert.equal(f.calls.length,1);
});
test('only exact acknowledged items are skipped; uncertain item is replayed and another manifest has no cache',async()=>{
 const f=backupFixture(),bundle=await prepareBackupBundle(new Blob([f.zip]),f.capabilities),uncertain=f.capabilities.chunks[1];let lost=true;
 const request=async(p,o)=>{const r=await f.request(p,o);if(p.endsWith('/'+uncertain.id)&&lost){lost=false;throw Error('chunk committed but ACK unknown');}return r;};
 await assert.rejects(()=>uploadBackupBundle(bundle,request));f.calls.length=0;await uploadBackupBundle(bundle,request);
 assert.equal(f.calls.filter(c=>c.path.includes('/objects/')).length,0);assert.ok(f.calls.some(c=>c.path.endsWith('/'+uncertain.id)));assert.equal(f.calls.some(c=>c.path.endsWith('/'+f.capabilities.chunks[0].id)),false);
 const g=backupFixture({seed:'another backup'}),other=await prepareBackupBundle(new Blob([g.zip]),g.capabilities);assert.notEqual(g.capabilities.manifest_sha256,f.capabilities.manifest_sha256);await uploadBackupBundle(other,g.request);assert.equal(g.calls.filter(c=>c.path.includes('/objects/')).length,g.capabilities.objects.length);assert.equal(g.calls.filter(c=>c.path.includes('/chunks/')).length,g.capabilities.chunks.length);
});
test('an already stored begin skips uploads but still requires a fresh complete finish readback',async()=>{
 const f=backupFixture(),bundle=await prepareBackupBundle(new Blob([f.zip]),f.capabilities),request=async(p,o)=>{const r=await f.request(p,o);return p.endsWith('/begin')?{...r,status:'stored_with_issues'}:r;};
 assert.deepEqual(await uploadBackupBundle(bundle,request),f.result);assert.deepEqual(f.calls.map(c=>c.path),['/v1/backup-import/begin','/v1/backup-import/finish']);
 await assert.rejects(()=>uploadBackupBundle(bundle,async(p,o)=>{const r=await request(p,o);return p.endsWith('/finish')?{...r,readback_verified:false}:r;}));
});
test('terminal result requires exact identity, counts, stored status and explicit verified readback',()=>{
 const f=backupFixture();for(const patch of [{readback_verified:false},{status:'completed'},{verified_objects:0},{verified_bytes:0},{operational_effects:true},{backup_sha256:'b'.repeat(64)},{manifest_sha256:'c'.repeat(64)}])assert.throws(()=>backupResult({...f.result,...patch},f.capabilities));
});
test('upload scheduler limits aggregate bodies to32MiB, a larger object alone, and stops queued work on cancel',async()=>{
 const M=1024*1024;
 for(const sizes of [[40,40,40,40],[16,16,1,8,8,8,8],[8,8,8,8,8]]){let active=0,bytes=0,max=0;const starts=[];
  await sendBackupItems(sizes,{weight:n=>n*M,onComplete(){},async run(size){active++;bytes+=size;max=Math.max(max,active);starts.push(size);assert.ok(active<=4);assert.ok(bytes<=32||active===1&&size>32);await new Promise(r=>setTimeout(r,1));active--;bytes-=size;}});
  assert.deepEqual(starts,sizes);if(sizes[0]===40)assert.equal(max,1);
 }
 const abort=new AbortController(),started=[];await assert.rejects(()=>sendBackupItems([40,40,40,40],{signal:abort.signal,weight:n=>n*M,onComplete(){},async run(n,signal){started.push(n);abort.abort();assert.equal(signal.aborted,true);}}),e=>e.name==='AbortError');assert.deepEqual(started,[40]);
});
test('SSE accepts split frames, never treats EOF/progress/error/duplicate result as success',async()=>{
 const f=backupFixture(),progress={profile:'origin-backup-import-progress-v1',phase:'verifying_objects',completed:6,total:6,verified_bytes:f.capabilities.summary.object_bytes},frame=(event,data)=>`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`,good=frame('progress',progress)+frame('result',f.result),seen=[];
 const selected=captureBackupRequest('/v1/backup-import/finish',{method:'POST',manifestHash:f.capabilities.manifest_sha256,onProgress:p=>seen.push(p)});
 const stream=new ReadableStream({start(c){for(const byte of new TextEncoder().encode(good))c.enqueue(Uint8Array.of(byte));c.close();}});
 assert.deepEqual(await readBackupResponse(new Response(stream,{headers:{'Content-Type':'text/event-stream'}}),selected,()=>{}),f.result);assert.equal(seen.length,1);
 for(const text of ['',frame('progress',progress),frame('error',{error:{code:'FAIL'},commit_status:'unknown'}),good+frame('result',f.result),good+'partial',frame('unknown',{})])await assert.rejects(()=>readBackupResponse(new Response(text,{headers:{'Content-Type':'text/event-stream'}}),selected,()=>{}));
});
