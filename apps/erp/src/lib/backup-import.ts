// Deliberately narrow ZIP_STORED profile. PKWARE APPNOTE 6.3.10, sections
// 4.3.7, 4.3.12 and 4.3.16: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Original archives are opaque objects; this reader never opens their contents.
export const BACKUP_IMPORT_BASE = '/v1/backup-import';
const SHA = /^[a-f0-9]{64}$/;
const OBJECT = /^objects\/([a-f0-9]{64})\.(zip|csv|xml|bin)$/;
const CHUNK = /^chunks\/(file|csv|xml|issue)-\d{5}-([a-f0-9]{64})\.json$/;
const MIB = 1024 * 1024;
export type BackupObject = Readonly<{local:string;key:string;sha256:string;size:number;content_type:string}>;
export type BackupChunk = Readonly<{local:string;kind:'file'|'csv'|'xml'|'issue';id:string;sha256:string;size:number;records:number}>;
export type BackupCapabilities = Readonly<{profile:'origin-backup-import-capabilities-v1';enabled:true;manifest_sha256:string;backup_sha256:string;
  summary:{format_version:1;source_sha256:string;source_size:number;object_count:number;object_bytes:number;counts:Record<BackupChunk['kind'],number>;operational_effects:false};
  limits:{source_bytes:number;xml_bytes:number;chunk_bytes:number;chunk_records:number;objects:number;archive_bytes:number;archive_entries:number;concurrency:4};
  objects:readonly BackupObject[];chunks:readonly BackupChunk[]}>;
export type BackupProgress = {phase:'validating'|'objects'|'chunks'|'verifying_objects';completed:number;total:number};
export type BackupResult = {profile:'origin-backup-import-result-v1';backup_sha256:string;manifest_sha256:string;status:'stored'|'stored_with_issues';verified_objects:number;verified_bytes:number;counts:Record<BackupChunk['kind'],number>;readback_verified:true;operational_effects:false};
export type BackupRequestOptions = {method?:'GET'|'POST'|'PUT';body?:Blob;manifestHash?:string;signal?:AbortSignal;onProgress?:(value:BackupProgress)=>void};
export type BackupRequest = (path:string,options?:BackupRequestOptions)=>Promise<unknown>;
function invalid():never {throw new Error('BACKUP_IMPORT_INVALID');}
const record = (v:unknown):Record<string,any> => v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:invalid();
const integer=(v:unknown,min:number,max:number):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:invalid();
const same=(a:unknown,b:unknown)=>{if(a!==b)invalid();};
export const checkBackupAbort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('Request cancelled','AbortError');};
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export function backupCapabilities(value:unknown):BackupCapabilities|null {
  const v=record(value);same(v.profile,'origin-backup-import-capabilities-v1');
  if(v.enabled===false){if(Object.keys(v).length!==2)invalid();return null;}
  same(v.enabled,true);if(!SHA.test(v.manifest_sha256)||!SHA.test(v.backup_sha256))invalid();
  const l=record(v.limits),s=record(v.summary),counts=record(s.counts);
  for(const [k,max] of Object.entries({source_bytes:40*MIB,xml_bytes:8*MIB,chunk_bytes:2*MIB,chunk_records:250,objects:9000,archive_bytes:512*MIB,archive_entries:19001}))integer(l[k],1,max);
  same(l.concurrency,4);same(s.operational_effects,false);same(s.format_version,1);same(s.source_sha256,v.backup_sha256);integer(s.source_size,1,l.source_bytes);
  if(!Array.isArray(v.objects)||!v.objects.length||v.objects.length>l.objects||!Array.isArray(v.chunks)||!v.chunks.length||v.chunks.length>10000||1+v.objects.length+v.chunks.length>l.archive_entries)invalid();
  const paths=new Set<string>(),chunkIds=new Set<string>(),objects:BackupObject[]=[],chunks:BackupChunk[]=[];let bytes=0;const totals={file:0,csv:0,xml:0,issue:0};
  const mimes={zip:'application/zip',csv:'text/csv',xml:'application/xml',bin:'application/octet-stream'};
  for(const raw of v.objects){const o=record(raw),match=typeof o.local==='string'&&OBJECT.exec(o.local);if(!match||paths.has(o.local))invalid();paths.add(o.local);
    same(o.key,o.local);same(o.sha256,match[1]);same(o.content_type,mimes[match[2] as keyof typeof mimes]);integer(o.size,1,match[2]==='xml'?l.xml_bytes:l.source_bytes);bytes+=o.size;
    objects.push({local:o.local,key:o.key,sha256:o.sha256,size:o.size,content_type:o.content_type});}
  for(const raw of v.chunks){const c=record(raw),match=typeof c.local==='string'&&CHUNK.exec(c.local);if(!match||paths.has(c.local))invalid();paths.add(c.local);
    same(c.kind,match[1]);same(c.sha256,match[2]);same(c.id,c.sha256);if(chunkIds.has(c.id))invalid();chunkIds.add(c.id);integer(c.size,1,l.chunk_bytes);integer(c.records,1,l.chunk_records);totals[c.kind as keyof typeof totals]+=c.records;
    chunks.push({local:c.local,kind:c.kind,id:c.id,sha256:c.sha256,size:c.size,records:c.records});}
  for(const kind of Object.keys(totals) as (keyof typeof totals)[])same(integer(counts[kind],0,1000000),totals[kind]);
  same(s.object_count,objects.length);same(s.object_bytes,bytes);
  if(!objects.some(o=>o.sha256===v.backup_sha256&&o.size===s.source_size&&o.content_type==='application/zip')||bytes+chunks.reduce((n,c)=>n+c.size,0)>l.archive_bytes)invalid();
  // Copy only the public contract; mutations to an upstream object cannot change a selection.
  return freeze({profile:v.profile,enabled:true,manifest_sha256:v.manifest_sha256,backup_sha256:v.backup_sha256,
    summary:{format_version:1,source_sha256:v.backup_sha256,source_size:s.source_size,object_count:objects.length,object_bytes:bytes,counts:{...totals},operational_effects:false},
    limits:{source_bytes:l.source_bytes,xml_bytes:l.xml_bytes,chunk_bytes:l.chunk_bytes,chunk_records:l.chunk_records,objects:l.objects,archive_bytes:l.archive_bytes,archive_entries:l.archive_entries,concurrency:4},objects,chunks});
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function backupCrc32(bytes:Uint8Array){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
export async function backupSha256(bytes:Uint8Array<ArrayBuffer>){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
type Entry={name:string;offset:number;size:number;crc:number;start:number;header:Uint8Array<ArrayBuffer>};
export type BackupBundle={capabilities:BackupCapabilities;file:Blob;objects:readonly BackupObject[];chunks:readonly BackupChunk[];content:(path:string)=>Blob};
const prepared=new WeakSet<BackupBundle>();
// Only individually validated ACKs survive a retry, and only for this immutable
// in-memory bundle. A reselected file or another manifest starts with no cache.
const confirmedByBundle=new WeakMap<BackupBundle,{objects:Set<string>;chunks:Set<string>}>();
export async function prepareBackupBundle(file:Blob,capabilities:BackupCapabilities,{signal,onProgress}:{signal?:AbortSignal;onProgress?:(value:BackupProgress)=>void}={}):Promise<BackupBundle>{
  const cap=backupCapabilities(capabilities);if(!cap||!(file instanceof Blob)||file.size<22||file.size>cap.limits.archive_bytes)invalid();
  const expected=new Map<string,{size?:number;sha256:string}>([['manifest.json',{sha256:cap.manifest_sha256}],...[...cap.objects,...cap.chunks].map(x=>[x.local,x] as [string,{size:number;sha256:string}])]);
  const slice=async(start:number,length:number)=>{checkBackupAbort(signal);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<0||start+length>file.size)invalid();const b=new Uint8Array(await file.slice(start,start+length).arrayBuffer());checkBackupAbort(signal);if(b.length!==length)invalid();return b;};
  // Our producer forbids comments, so the only accepted EOCD is the final22 bytes.
  const end=new DataView((await slice(file.size-22,22)).buffer);
  if(end.getUint32(0,true)!==0x06054b50||end.getUint16(4,true)!==0||end.getUint16(6,true)!==0||end.getUint16(20,true)!==0)invalid();
  const count=end.getUint16(10,true),centralSize=end.getUint32(12,true),centralOffset=end.getUint32(16,true);
  if(count!==expected.size||count!==end.getUint16(8,true)||count>cap.limits.archive_entries||centralSize!==[...expected.keys()].reduce((n,name)=>n+46+name.length,0)||centralOffset+centralSize!==file.size-22)invalid();
  const central=await slice(centralOffset,centralSize),view=new DataView(central.buffer),entries:Entry[]=[],names=new Set<string>();let pos=0;
  const ascii=(b:Uint8Array)=>{if(b.some(x=>x<32||x>126))invalid();return String.fromCharCode(...b);};
  for(let i=0;i<count;i++){
    if(pos+46>central.length||view.getUint32(pos,true)!==0x02014b50)invalid();
    const host=view.getUint16(pos+4,true)>>>8,version=view.getUint16(pos+6,true),flags=view.getUint16(pos+8,true),size=view.getUint32(pos+24,true),length=view.getUint16(pos+28,true),attrs=view.getUint32(pos+38,true),mode=(attrs>>>16)&0xf000;
    if(![0,3].includes(host)||![10,20].includes(version)||![0,0x800].includes(flags)||view.getUint16(pos+10,true)!==0||view.getUint32(pos+20,true)!==size||view.getUint16(pos+30,true)!==0||view.getUint16(pos+32,true)!==0||view.getUint16(pos+34,true)!==0||(attrs&0x18)!==0||host===3&&mode!==0&&mode!==0x8000||pos+46+length>central.length)invalid();
    const name=ascii(central.subarray(pos+46,pos+46+length)),target=expected.get(name);
    if(!target||names.has(name)||target.size!==undefined&&size!==target.size||name==='manifest.json'&&(size<2||size>16*MIB))invalid();names.add(name);
    entries.push({name,offset:view.getUint32(pos+42,true),size,crc:view.getUint32(pos+16,true),start:0,header:central.slice(pos+6,pos+28)});pos+=46+length;
  }
  same(pos,central.length);entries.sort((a,b)=>a.offset-b.offset);let cursor=0;
  for(const e of entries){same(e.offset,cursor);const local=await slice(e.offset,30+e.name.length),v=new DataView(local.buffer);
    if(v.getUint32(0,true)!==0x04034b50||v.getUint16(26,true)!==e.name.length||v.getUint16(28,true)!==0||ascii(local.subarray(30))!==e.name)invalid();
    // Central version, flags, method, DOS time/date, CRC and both sizes must agree.
    for(let i=0;i<22;i++)same(local[4+i],e.header[i]);e.start=e.offset+30+e.name.length;cursor=e.start+e.size;if(cursor>centralOffset)invalid();
  }
  same(cursor,centralOffset);let checked=0;
  for(const e of entries){checkBackupAbort(signal);const bytes=await slice(e.start,e.size);if(backupCrc32(bytes)!==e.crc||await backupSha256(bytes)!==expected.get(e.name)!.sha256)invalid();checkBackupAbort(signal);onProgress?.({phase:'validating',completed:++checked,total:entries.length});}
  const map=new Map(entries.map(e=>[e.name,e]));
  const bundle:BackupBundle={capabilities:cap,file,objects:cap.objects,chunks:cap.chunks,content:path=>{const e=map.get(path);if(!e)invalid();return file.slice(e.start,e.start+e.size);}};
  Object.freeze(bundle);prepared.add(bundle);return bundle;
}
function receipt(value:unknown,cap:BackupCapabilities,action:string){const r=record(value);same(r.profile,'origin-backup-import-receipt-v1');same(r.action,action);same(r.backup_sha256,cap.backup_sha256);same(r.manifest_sha256,cap.manifest_sha256);same(r.operational_effects,false);return r;}
export function backupResult(value:unknown,cap:BackupCapabilities):BackupResult {const r=record(value);same(r.profile,'origin-backup-import-result-v1');same(r.backup_sha256,cap.backup_sha256);same(r.manifest_sha256,cap.manifest_sha256);same(r.readback_verified,true);same(r.operational_effects,false);same(r.verified_objects,cap.objects.length);same(r.verified_bytes,cap.summary.object_bytes);same(r.status,cap.summary.counts.issue?'stored_with_issues':'stored');const counts=record(r.counts);for(const kind of ['file','csv','xml','issue'] as const)same(counts[kind],cap.summary.counts[kind]);return r as BackupResult;}
/** Bound server-side body/readback allocations too: one object over32MiB runs alone. */
export async function sendBackupItems<T>(items:readonly T[],{signal,weight,run,onComplete}:{signal?:AbortSignal;weight:(item:T)=>number;run:(item:T,signal:AbortSignal)=>Promise<void>;onComplete:(completed:number)=>void}){
  let next=0,done=0;const local=new AbortController(),combined=signal?AbortSignal.any([signal,local.signal]):local.signal;
  while(next<items.length){
    checkBackupAbort(combined);const batch:T[]=[];let bytes=0;
    while(next<items.length&&batch.length<4){const size=integer(weight(items[next]),0,40*MIB);if(batch.length&&bytes+size>32*MIB)break;batch.push(items[next++]);bytes+=size;}
    let failure:unknown;
    const results=await Promise.allSettled(batch.map(async item=>{try{checkBackupAbort(combined);await run(item,combined);checkBackupAbort(combined);onComplete(++done);}catch(error){failure??=error;local.abort();throw error;}}));
    if(failure)throw failure;if(results.some(x=>x.status==='rejected'))invalid();
  }
  checkBackupAbort(signal);
}
export async function uploadBackupBundle(bundle:BackupBundle,request:BackupRequest,{signal,onProgress}:{signal?:AbortSignal;onProgress?:(value:BackupProgress)=>void}={}):Promise<BackupResult>{
  if(!prepared.has(bundle))invalid();checkBackupAbort(signal);const cap=bundle.capabilities;
  const manifestHash=cap.manifest_sha256;
  const begin=receipt(await request(BACKUP_IMPORT_BASE+'/begin',{method:'POST',manifestHash,signal}),cap,'begin');checkBackupAbort(signal);
  if(!['uploading','stored','stored_with_issues'].includes(begin.status)||typeof begin.replayed!=='boolean')invalid();
  const finish=async()=>{checkBackupAbort(signal);const result=await request(BACKUP_IMPORT_BASE+'/finish',{method:'POST',manifestHash,signal,onProgress});checkBackupAbort(signal);return backupResult(result,cap);};
  // The server still rehashes every object and verifies SQL counts/readback.
  if(begin.status!=='uploading')return finish();
  const confirmed=confirmedByBundle.get(bundle)??{objects:new Set<string>(),chunks:new Set<string>()};confirmedByBundle.set(bundle,confirmed);
  async function send<T extends {size:number}>(items:readonly T[],phase:'objects'|'chunks',offset:number,total:number,run:(item:T,signal:AbortSignal)=>Promise<void>){
    onProgress?.({phase,completed:offset,total});
    await sendBackupItems(items,{signal,weight:item=>item.size,run,onComplete:completed=>onProgress?.({phase,completed:offset+completed,total})});
  }
  await send(bundle.objects.filter(o=>!confirmed.objects.has(o.key)),'objects',confirmed.objects.size,bundle.objects.length,async(o,s)=>{const r=receipt(await request(`${BACKUP_IMPORT_BASE}/${o.key}`,{method:'PUT',body:bundle.content(o.local),manifestHash,signal:s}),cap,'object');same(r.key,o.key);same(r.sha256,o.sha256);same(r.size,o.size);same(r.verified,true);checkBackupAbort(s);confirmed.objects.add(o.key);});
  // File records are ingested before their dependent CSV/XML records, as in the preparer.
  for(const kind of ['file','csv','xml','issue'] as const)await send(bundle.chunks.filter(c=>c.kind===kind&&!confirmed.chunks.has(c.id)),'chunks',confirmed.chunks.size,bundle.chunks.length,async(c,s)=>{const r=receipt(await request(`${BACKUP_IMPORT_BASE}/chunks/${c.kind}/${c.sha256}`,{method:'POST',body:bundle.content(c.local),manifestHash,signal:s}),cap,'chunk');same(r.kind,c.kind);same(r.id,c.id);same(r.sha256,c.sha256);same(r.records,c.records);if(typeof r.replayed!=='boolean')invalid();checkBackupAbort(s);confirmed.chunks.add(c.id);});
  return finish();
}
