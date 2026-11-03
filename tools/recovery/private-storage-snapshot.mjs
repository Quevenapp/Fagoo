// Local, explicit opt-in copy. Never lists Storage, mutates the project, or opens the A1 envelope.
import {open,lstat,mkdir,link,unlink,statfs,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,resolve,dirname,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const BUCKETS=Object.freeze({'origin-backups':41943040,'origin-fiscal-xml':8388608,'erp-attachments':10485760,'brufap-cnab':4020000,'brufap-a1-vault':1500000,'brufap-fiscal-artifacts':8388608,'brufap-received-dfe':8388608});
export const LIMITS=Object.freeze({inventoryBytes:16777216,objects:10000,totalBytes:4294967296,concurrency:2,objectMs:30000,runMs:900000,freeMarginBytes:536870912});
const SHA={test:x=>typeof x==='string'&&x.length===64&&!/[^a-f0-9]/.test(x)},UUID={test:x=>typeof x==='string'&&x.length===36&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x)},validatedEntries=new WeakMap(),repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex'),plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
export const ERROR_CODES=Object.freeze(["STORAGE_A1_SEALED_REFERENCE_REQUIRED", "STORAGE_BUCKET_NOT_PRIVATE", "STORAGE_CANCELLED", "STORAGE_COPY_INCOMPLETE", "STORAGE_DEADLINE", "STORAGE_DOWNLOAD_ABORTED", "STORAGE_DOWNLOAD_DISABLED", "STORAGE_DOWNLOAD_FAILED", "STORAGE_DUPLICATE_OBJECT", "STORAGE_ENTRY_NOT_INSPECTED", "STORAGE_EXPECTED_HASH_INVALID", "STORAGE_HASH_MISMATCH", "STORAGE_INVENTORY_HASH_MISMATCH", "STORAGE_INVENTORY_INVALID", "STORAGE_LOCAL_BLOB_MISMATCH", "STORAGE_LOCAL_DIRECTORY_CHANGED", "STORAGE_LOCAL_DIRECTORY_UNSAFE", "STORAGE_LOCAL_FILE_CHANGED", "STORAGE_LOCAL_FILE_LIMIT", "STORAGE_LOCAL_FILE_UNSAFE", "STORAGE_LOCAL_INVENTORY_MISMATCH", "STORAGE_LOCAL_PATH_INVALID", "STORAGE_LOCAL_READBACK_FAILED", "STORAGE_LOCAL_SPACE_LOW", "STORAGE_MANIFEST_CONFLICT", "STORAGE_MANIFEST_LIMIT", "STORAGE_METADATA_INVALID", "STORAGE_OBJECT_REVIEW_REQUIRED", "STORAGE_OUTPUT_IN_GIT", "STORAGE_RECEIPT_CONFLICT", "STORAGE_RECEIPT_INVALID", "STORAGE_RESPONSE_CHUNK_INVALID", "STORAGE_RESPONSE_ENCODING", "STORAGE_RESPONSE_ETAG", "STORAGE_RESPONSE_INVALID", "STORAGE_RESPONSE_SIZE", "STORAGE_RESPONSE_TYPE", "STORAGE_SNAPSHOT_INPUT_INVALID", "STORAGE_SNAPSHOT_IO_FAILED", "STORAGE_SNAPSHOT_LOCKED", "STORAGE_TOTAL_LIMIT", "STORAGE_UNATTESTED_LOCAL_BLOB"]);
export class StorageSnapshotError extends Error{constructor(code){const safe=ERROR_CODES.includes(code)?code:'STORAGE_SNAPSHOT_IO_FAILED';super(safe);this.name='StorageSnapshotError';Object.defineProperty(this,'code',{value:safe,enumerable:true});}}
const need=(x,code='STORAGE_SNAPSHOT_INPUT_INVALID')=>{if(!x)throw new StorageSnapshotError(code);};
const validProject=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9_-]{0,99}$/.test(x);
export function storageRuntimeConfig(env=process.env){
 const project=env.FAGOO_STORAGE_PROJECT,origin=env.SUPABASE_URL;let url;try{url=new URL(origin);}catch{throw new StorageSnapshotError('STORAGE_SNAPSHOT_INPUT_INVALID');}
 need(validProject(project)&&url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password);
 return Object.freeze({project,origin:url.origin});
}
const closed=(x,keys)=>plain(x)&&Reflect.ownKeys(x).length===keys.length&&Reflect.ownKeys(x).every(k=>keys.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value'));
function capture(x,keys){need(plain(x));const out={};for(const k of Reflect.ownKeys(x)){need(typeof k==='string'&&keys.includes(k));const d=Object.getOwnPropertyDescriptor(x,k);need(Object.hasOwn(d,'value'));out[k]=d.value;}return out;}
const safeError=e=>new StorageSnapshotError(e instanceof StorageSnapshotError?Object.getOwnPropertyDescriptor(e,'code')?.value:'STORAGE_SNAPSHOT_IO_FAILED');
function bytes(x,max){need(x instanceof Uint8Array&&!(x.buffer instanceof SharedArrayBuffer)&&x.byteLength<=max);return Buffer.from(x);}
const time=x=>typeof x==='string'&&x.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
const nullableText=(x,max)=>x===null||typeof x==='string'&&x.length<=max&&!/[\u0000-\u001f\u007f]/.test(x);
const safeKey=x=>typeof x==='string'&&Buffer.byteLength(x)<=1024&&x.length>0&&!/[\u0000-\u001f\u007f%?#\\]/.test(x)&&x.split('/').every(s=>s!==''&&s!=='.'&&s!=='..');
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};

/** The caller pins the exact private export, not a reserialized or silently expanded selection. */
export function inspectStorageInventory(input,expectedSha256){
 const raw=bytes(input,LIMITS.inventoryBytes);need(SHA.test(expectedSha256)&&hash(raw)===expectedSha256,'STORAGE_INVENTORY_HASH_MISMATCH');let v;try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new StorageSnapshotError('STORAGE_INVENTORY_INVALID');}
 need(closed(v,['profile','project','snapshot_id','observed_at','read_only','total_objects','truncated','unknown_private_bucket_count','buckets','objects','database_restore_verified','vault_recovery_verified','storage_bytes_snapshot_verified']),'STORAGE_INVENTORY_INVALID');
 need(v.profile==='brufap-private-storage-inventory-v1'&&validProject(v.project)&&UUID.test(v.snapshot_id)&&time(v.observed_at)&&v.read_only===true&&v.truncated===false&&v.database_restore_verified===false&&v.vault_recovery_verified===false&&v.storage_bytes_snapshot_verified===false,'STORAGE_INVENTORY_INVALID');
 need(Number.isSafeInteger(v.unknown_private_bucket_count)&&v.unknown_private_bucket_count>=0&&Array.isArray(v.buckets)&&v.buckets.length===7&&Array.isArray(v.objects)&&v.objects.length<=LIMITS.objects&&v.total_objects===v.objects.length,'STORAGE_INVENTORY_INVALID');
 const seenBuckets=new Set();for(const b of v.buckets){need(closed(b,['id','present','public','max_bytes'])&&Object.hasOwn(BUCKETS,b.id)&&!seenBuckets.has(b.id)&&b.max_bytes===BUCKETS[b.id]&&typeof b.present==='boolean'&&(b.present?b.public===false:b.public===null),'STORAGE_BUCKET_NOT_PRIVATE');seenBuckets.add(b.id);}
 let total=0,withHash=0;const seen=new Set();
 for(const o of v.objects){
  need(closed(o,['bucket','key','size_bytes','updated_at','metadata','expected_sha256','hash_basis','issues'])&&Object.hasOwn(BUCKETS,o.bucket)&&v.buckets.some(b=>b.id===o.bucket&&b.present)&&safeKey(o.key)&&Number.isSafeInteger(o.size_bytes)&&o.size_bytes>=0&&o.size_bytes<=BUCKETS[o.bucket]&&time(o.updated_at)&&Array.isArray(o.issues)&&o.issues.length===0,'STORAGE_OBJECT_REVIEW_REQUIRED');
  need(closed(o.metadata,['mime_type','etag','cache_control'])&&nullableText(o.metadata.mime_type,255)&&nullableText(o.metadata.etag,200)&&nullableText(o.metadata.cache_control,255),'STORAGE_METADATA_INVALID');
  const identity=JSON.stringify([o.bucket,o.key]);need(!seen.has(identity),'STORAGE_DUPLICATE_OBJECT');seen.add(identity);
  need(o.expected_sha256===null&&o.hash_basis===null||SHA.test(o.expected_sha256)&&['content_addressed_path','a1_sealed_ledger','fiscal_journal_ledger'].includes(o.hash_basis),'STORAGE_EXPECTED_HASH_INVALID');
  const journal=o.bucket==='brufap-fiscal-artifacts'&&/^(authorization|reconciliation)\//.test(o.key);
  if(journal||o.hash_basis==='fiscal_journal_ledger'){
   const m=o.key.match(/^(authorization|reconciliation)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(requests|responses|observations|processed)\/([a-f0-9]{64})\.(xml|json)$/);
   need(journal&&o.hash_basis==='fiscal_journal_ledger'&&m&&o.size_bytes>0&&o.metadata.mime_type==='application/octet-stream'&&
    (m[3]==='observations'?m[5]==='json'&&o.size_bytes<=8192:m[5]==='xml'&&o.size_bytes<=512000)&&
    (m[3]!=='processed'||m[1]==='authorization')&&
    (!['requests','processed'].includes(m[3])||m[4]===o.expected_sha256),'STORAGE_EXPECTED_HASH_INVALID');
  }
  if(o.expected_sha256!==null){if(!journal){const match=o.key.match(/(?:^|\/)([a-f0-9]{64})(?:\.[a-z0-9]{1,8})?$/);need(match?.[1]===o.expected_sha256,'STORAGE_EXPECTED_HASH_INVALID');}withHash++;}
  if(o.bucket==='brufap-a1-vault')need(o.hash_basis==='a1_sealed_ledger'&&o.size_bytes>0&&o.metadata.mime_type==='application/json'&&new RegExp(`^credentials/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/${o.expected_sha256}\\.json$`).test(o.key),'STORAGE_A1_SEALED_REFERENCE_REQUIRED');
  else need(o.hash_basis!=='a1_sealed_ledger','STORAGE_EXPECTED_HASH_INVALID');
  total+=o.size_bytes;need(total<=LIMITS.totalBytes,'STORAGE_TOTAL_LIMIT');
 }
 const result=freeze({inventory:v,inventorySha256:expectedSha256,totalBytes:total,withExpectedHash:withHash,withoutExpectedHash:v.objects.length-withHash});
 for(const entry of v.objects)validatedEntries.set(entry,v.project);return result;
}

/** No default credentials, environment access, object listing or signed URL. */
export function createPrivateStorageReader(options){
 const c=capture(options,['serviceKey','downloadEnabled','fetchImpl','project','origin']);need(c.downloadEnabled===true,'STORAGE_DOWNLOAD_DISABLED');need(typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&!/\s/.test(c.serviceKey));const request=c.fetchImpl??globalThis.fetch;need(typeof request==='function');const key=c.serviceKey;
 const configured=storageRuntimeConfig({FAGOO_STORAGE_PROJECT:c.project,SUPABASE_URL:c.origin});
 return async(entry,options)=>{
   need(validatedEntries.has(entry),'STORAGE_ENTRY_NOT_INSPECTED');need(validatedEntries.get(entry)===configured.project,'STORAGE_INVENTORY_INVALID');const {signal}=capture(options,['signal','deadline']);need(signal instanceof AbortSignal);need(!signal.aborted,'STORAGE_DOWNLOAD_ABORTED');
   const url=`${configured.origin}/storage/v1/object/authenticated/${entry.bucket}/${entry.key.split('/').map(encodeURIComponent).join('/')}`;
  const headers={apikey:key,Authorization:`Bearer ${key}`,Accept:'*/*','Accept-Encoding':'identity','Cache-Control':'no-store'};
  const etag=entry.metadata.etag;if(typeof etag==='string'&&/^[a-fA-F0-9]{32}(?:-[0-9]+)?$/.test(etag))headers['If-Match']=`"${etag}"`;
  let response;try{response=await request(url,{method:'GET',headers,signal,redirect:'manual',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});}catch{throw new StorageSnapshotError(signal.aborted?'STORAGE_DOWNLOAD_ABORTED':'STORAGE_DOWNLOAD_FAILED');}
  try{
   need(response instanceof Response&&response.status===200&&!response.redirected&&response.url===url,'STORAGE_RESPONSE_INVALID');
   need(!response.headers.get('content-encoding')||response.headers.get('content-encoding').toLowerCase()==='identity','STORAGE_RESPONSE_ENCODING');
   const length=response.headers.get('content-length');need(length===null||/^(0|[1-9][0-9]{0,10})$/.test(length)&&Number(length)===entry.size_bytes,'STORAGE_RESPONSE_SIZE');
   if(entry.metadata.mime_type){
    const actual=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(),expected=entry.metadata.mime_type.toLowerCase();
    // Observed XML delivery only; copyPrivateStorageSnapshot still verifies the pinned SHA before publishing.
    const xmlAsText=expected==='application/xml'&&actual==='text/plain'&&['origin-backups','origin-fiscal-xml','brufap-fiscal-artifacts','brufap-received-dfe'].includes(entry.bucket)&&entry.key.endsWith('.xml')&&SHA.test(entry.expected_sha256);
    need(actual===expected||xmlAsText,'STORAGE_RESPONSE_TYPE');
   }
   if(headers['If-Match'])need(response.headers.get('etag')===headers['If-Match'],'STORAGE_RESPONSE_ETAG');
   return response;
  }catch(e){try{void response?.body?.cancel().catch(()=>{});}catch{}throw safeError(e);}
 };
}

function scope(signal,deadline){
 const abort=new AbortController();let reason='STORAGE_DEADLINE',timer;const stop=()=>{reason='STORAGE_CANCELLED';abort.abort();};
 need(signal===undefined||signal instanceof AbortSignal);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
 const expired=new Promise((_,reject)=>{const fail=()=>reject(new StorageSnapshotError(reason));if(abort.signal.aborted)fail();else abort.signal.addEventListener('abort',fail,{once:true});timer=setTimeout(()=>abort.abort(),Math.max(0,deadline-Date.now()));});expired.catch(()=>{});
 const check=()=>{if(Date.now()>=deadline){abort.abort();throw new StorageSnapshotError(reason);}need(!abort.signal.aborted,reason);};
 return{signal:abort.signal,check,async wait(p){check();const x=await Promise.race([p,expired]);check();return x;},close(){clearTimeout(timer);signal?.removeEventListener('abort',stop);},cancel:()=>abort.abort()};
}
async function safeAncestors(path,{rejectGit=true}={}){
 need(isAbsolute(path)&&resolve(path)===path,'STORAGE_LOCAL_PATH_INVALID');let p=path;
 while(true){const s=await lstat(p);need(!s.isSymbolicLink()&&s.isDirectory(),'STORAGE_LOCAL_PATH_INVALID');if(rejectGit){try{await lstat(join(p,'.git'));throw new StorageSnapshotError('STORAGE_OUTPUT_IN_GIT');}catch(e){if(e.code!=='ENOENT')throw e;}}const parent=dirname(p);if(parent===p)break;p=parent;}
}
const fileFlags=constants.O_NOFOLLOW;
async function privateFile(path,flags=constants.O_RDONLY){
 const f=await open(path,flags|fileFlags,0o600);try{const s=await f.stat();need(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&(s.mode&0o111)===0&&s.uid===process.getuid(),'STORAGE_LOCAL_FILE_UNSAFE');return f;}catch(e){await f.close();throw e;}
}
async function readPrivate(path,max){const f=await privateFile(path);try{const s=await f.stat();need(s.size<=max,'STORAGE_LOCAL_FILE_LIMIT');const b=await f.readFile();need(b.length===s.size&&b.length<=max,'STORAGE_LOCAL_FILE_CHANGED');return b;}finally{await f.close();}}
async function fileDigest(path,size,check){const f=await privateFile(path);try{const s=await f.stat();need(s.size===size,'STORAGE_LOCAL_BLOB_MISMATCH');const h=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;while(true){check();const r=await f.read(buffer,0,buffer.length,null);if(!r.bytesRead)break;offset+=r.bytesRead;need(offset<=size,'STORAGE_LOCAL_BLOB_MISMATCH');h.update(buffer.subarray(0,r.bytesRead));}buffer.fill(0);need(offset===size,'STORAGE_LOCAL_BLOB_MISMATCH');return h.digest('hex');}finally{await f.close();}}
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function syncDir(path){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}}
async function writeNew(path,data){
 const part=`${path}.${randomUUID()}.partial`;let f,st;try{f=await privateFile(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);st=await f.stat();await f.writeFile(data);await f.sync();await f.close();f=null;await link(part,path);}
 finally{try{await f?.close();}catch{}if(st){try{const now=await lstat(part);if(now.ino===st.ino&&now.dev===st.dev)await unlink(part);}catch{}}}
}
const entryTag=o=>hash(JSON.stringify(o));
const receiptPath=(dir,tag)=>join(dir,`${tag}.receipt.json`),blobPath=(dir,tag)=>join(dir,`${tag}.blob`);
async function record(dir,tag,value){const data=Buffer.from(JSON.stringify(value)+'\n'),path=receiptPath(dir,tag);if(await exists(path)){need((await readPrivate(path,8192)).equals(data),'STORAGE_RECEIPT_CONFLICT');return;}await writeNew(path,data);await syncDir(dir);need((await readPrivate(path,8192)).equals(data),'STORAGE_LOCAL_READBACK_FAILED');}
async function verifyReceipt(dir,tag,o,inventorySha,check){
 const path=receiptPath(dir,tag),blob=blobPath(dir,tag);if(!await exists(path)){if(!await exists(blob))return null;need(o.expected_sha256!==null,'STORAGE_UNATTESTED_LOCAL_BLOB');const sha=await fileDigest(blob,o.size_bytes,check);need(sha===o.expected_sha256,'STORAGE_LOCAL_BLOB_MISMATCH');return{profile:'brufap-storage-object-copy-v1',inventory_sha256:inventorySha,entry_sha256:tag,size_bytes:o.size_bytes,sha256:sha,expected_hash_verified:true,stored_at:new Date().toISOString(),recovered_from_expected_hash:true};}
 const raw=await readPrivate(path,8192);let r;try{r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new StorageSnapshotError('STORAGE_RECEIPT_INVALID');}
 need(closed(r,['profile','inventory_sha256','entry_sha256','size_bytes','sha256','expected_hash_verified','stored_at','recovered_from_expected_hash'])&&r.profile==='brufap-storage-object-copy-v1'&&r.inventory_sha256===inventorySha&&r.entry_sha256===tag&&r.size_bytes===o.size_bytes&&SHA.test(r.sha256)&&r.expected_hash_verified===(o.expected_sha256!==null)&&typeof r.recovered_from_expected_hash==='boolean'&&time(r.stored_at),'STORAGE_RECEIPT_INVALID');
 need(o.expected_sha256===null||o.expected_sha256===r.sha256,'STORAGE_RECEIPT_INVALID');need(await fileDigest(blob,o.size_bytes,check)===r.sha256,'STORAGE_LOCAL_BLOB_MISMATCH');return r;
}

/** Existing copies must all verify before any new network request. No blob is overwritten. */
export async function copyPrivateStorageSnapshot(options,ports={}){
 const c=capture(options,['inventoryBytes','expectedInventorySha256','outputDir','readObject','downloadEnabled','signal','objectTimeoutMs','runTimeoutMs']);
 need(c.downloadEnabled===true,'STORAGE_DOWNLOAD_DISABLED');need(typeof c.readObject==='function'&&typeof c.outputDir==='string');const inspected=inspectStorageInventory(c.inventoryBytes,c.expectedInventorySha256),inventoryRaw=bytes(c.inventoryBytes,LIMITS.inventoryBytes),dir=c.outputDir,reader=c.readObject;
 const objectMs=c.objectTimeoutMs??LIMITS.objectMs,runMs=c.runTimeoutMs??LIMITS.runMs;need(Number.isInteger(objectMs)&&objectMs>=1&&objectMs<=LIMITS.objectMs&&Number.isInteger(runMs)&&runMs>=1&&runMs<=LIMITS.runMs);
 const dep=capture(ports,['spaceAvailable']);const spaceAvailable=dep.spaceAvailable??(async path=>{const s=await statfs(path,{bigint:true});return s.bavail*s.bsize;});need(typeof spaceAvailable==='function');
 const runDeadline=Date.now()+runMs,run=scope(c.signal,runDeadline);let lock,lockStat,rootStat;const result=[];let downloaded=0,resumed=0;
 try{
  need(dir!==repo&&!dir.startsWith(repo+sep),'STORAGE_OUTPUT_IN_GIT');await safeAncestors(dirname(dir));run.check();
  const initialFree=await spaceAvailable(dirname(dir));need(typeof initialFree==='bigint'&&initialFree>=BigInt(inventoryRaw.length+LIMITS.freeMarginBytes),'STORAGE_LOCAL_SPACE_LOW');
  try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  await safeAncestors(dir);rootStat=await lstat(dir);need((rootStat.mode&0o777)===0o700&&rootStat.uid===process.getuid(),'STORAGE_LOCAL_DIRECTORY_UNSAFE');
  const checkDir=async()=>{run.check();const s=await lstat(dir);need(s.isDirectory()&&!s.isSymbolicLink()&&s.dev===rootStat.dev&&s.ino===rootStat.ino&&(s.mode&0o777)===0o700,'STORAGE_LOCAL_DIRECTORY_CHANGED');need(await realpath(dir)===dir,'STORAGE_LOCAL_DIRECTORY_CHANGED');};
  try{lock=await privateFile(join(dir,'snapshot.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);}catch(e){if(e.code==='EEXIST')throw new StorageSnapshotError('STORAGE_SNAPSHOT_LOCKED');throw e;}lockStat=await lock.stat();await lock.writeFile(JSON.stringify({pid:process.pid,inventory_sha256:inspected.inventorySha256})+'\n');await lock.sync();
  const inventoryPath=join(dir,'inventory.json');if(await exists(inventoryPath))need((await readPrivate(inventoryPath,LIMITS.inventoryBytes)).equals(inventoryRaw),'STORAGE_LOCAL_INVENTORY_MISMATCH');else{await writeNew(inventoryPath,inventoryRaw);await syncDir(dir);}need((await readPrivate(inventoryPath,LIMITS.inventoryBytes)).equals(inventoryRaw),'STORAGE_LOCAL_READBACK_FAILED');
  const pending=[];for(const o of inspected.inventory.objects){await checkDir();const tag=entryTag(o),r=await verifyReceipt(dir,tag,o,inspected.inventorySha256,run.check);if(r){await record(dir,tag,r);result.push({o,tag,r});resumed++;}else pending.push({o,tag});}
  if(await exists(join(dir,'manifest.json')))need(pending.length===0,'STORAGE_MANIFEST_CONFLICT');
  const checkSpace=async required=>{await checkDir();const n=await spaceAvailable(dir);need(typeof n==='bigint'&&n>=BigInt(required)+BigInt(LIMITS.freeMarginBytes),'STORAGE_LOCAL_SPACE_LOW');};
  await checkSpace(pending.reduce((n,{o})=>n+o.size_bytes,0)+LIMITS.inventoryBytes+pending.length*8192);
  let next=0,failed;const worker=async()=>{while(!failed&&next<pending.length){const{o,tag}=pending[next++];const taskDeadline=Math.min(Date.now()+objectMs,runDeadline),task=scope(run.signal,taskDeadline);let file,part,partStat,response,stream;
   try{
    await checkSpace(o.size_bytes);task.check();const acquisition=Promise.resolve(reader(o,{signal:task.signal,deadline:taskDeadline}));acquisition.then(late=>{if(task.signal.aborted){try{void late?.body?.cancel().catch(()=>{});}catch{}}},()=>{});response=await task.wait(acquisition);need(response instanceof Response&&response.status===200,'STORAGE_RESPONSE_INVALID');
    part=join(dir,`${tag}.${randomUUID()}.partial`);file=await privateFile(part,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL);partStat=await file.stat();const h=createHash('sha256');let count=0;
    if(response.body){stream=response.body.getReader();while(true){const r=await task.wait(stream.read());if(r.done)break;need(r.value instanceof Uint8Array&&!(r.value.buffer instanceof SharedArrayBuffer)&&r.value.byteLength>0,'STORAGE_RESPONSE_CHUNK_INVALID');need(count+r.value.byteLength<=o.size_bytes,'STORAGE_RESPONSE_SIZE');const chunk=Buffer.from(r.value);try{count+=chunk.length;need(count<=o.size_bytes,'STORAGE_RESPONSE_SIZE');await checkSpace(chunk.length);task.check();await file.writeFile(chunk);h.update(chunk);}finally{chunk.fill(0);}}}
    need(count===o.size_bytes,'STORAGE_RESPONSE_SIZE');const sha=h.digest('hex');need(o.expected_sha256===null||sha===o.expected_sha256,'STORAGE_HASH_MISMATCH');task.check();await file.sync();await file.close();file=null;await checkDir();task.check();await link(part,blobPath(dir,tag));await unlink(part);part=null;await syncDir(dir);
    need(await fileDigest(blobPath(dir,tag),count,run.check)===sha,'STORAGE_LOCAL_READBACK_FAILED');const r={profile:'brufap-storage-object-copy-v1',inventory_sha256:inspected.inventorySha256,entry_sha256:tag,size_bytes:count,sha256:sha,expected_hash_verified:o.expected_sha256!==null,stored_at:new Date().toISOString(),recovered_from_expected_hash:false};await record(dir,tag,r);result.push({o,tag,r});downloaded++;
   }catch(e){failed??=safeError(e);run.cancel();}
   finally{task.close();try{void stream?.cancel().catch(()=>{});}catch{}try{stream?.releaseLock();}catch{}try{await file?.close();}catch{}if(part&&partStat){try{const s=await lstat(part);if(s.dev===partStat.dev&&s.ino===partStat.ino)await unlink(part);}catch{}}}
  }};
  await Promise.all(Array.from({length:Math.min(LIMITS.concurrency,pending.length)},worker));if(failed)throw failed;await checkDir();need(result.length===inspected.inventory.objects.length,'STORAGE_COPY_INCOMPLETE');
  result.sort((a,b)=>a.tag.localeCompare(b.tag));const content={profile:'brufap-private-storage-copy-v1',project:inspected.inventory.project,inventory_sha256:inspected.inventorySha256,snapshot_id:inspected.inventory.snapshot_id,inventory_observed_at:inspected.inventory.observed_at,object_count:result.length,total_bytes:inspected.totalBytes,with_expected_hash:inspected.withExpectedHash,without_expected_hash:inspected.withoutExpectedHash,unknown_private_bucket_count:inspected.inventory.unknown_private_bucket_count,copy_complete:true,local_readback_verified:true,database_restore_verified:false,vault_recovery_verified:false,storage_bytes_snapshot_verified:false,objects:result.map(({o,tag,r})=>({bucket:o.bucket,key:o.key,size_bytes:o.size_bytes,sha256:r.sha256,expected_sha256:o.expected_sha256,hash_basis:o.hash_basis,blob:`${tag}.blob`,receipt:`${tag}.receipt.json`}))};
  const data=Buffer.from(JSON.stringify(content)+'\n'),manifest=join(dir,'manifest.json');need(data.length<=LIMITS.inventoryBytes,'STORAGE_MANIFEST_LIMIT');if(await exists(manifest))need((await readPrivate(manifest,LIMITS.inventoryBytes)).equals(data),'STORAGE_MANIFEST_CONFLICT');else{await writeNew(manifest,data);await syncDir(dir);}need((await readPrivate(manifest,LIMITS.inventoryBytes)).equals(data),'STORAGE_LOCAL_READBACK_FAILED');
  return Object.freeze({complete:true,objects:result.length,downloaded,resumed,total_bytes:inspected.totalBytes,without_expected_hash:inspected.withoutExpectedHash,inventory_sha256:inspected.inventorySha256,manifest_sha256:hash(data),database_restore_verified:false,vault_recovery_verified:false,storage_bytes_snapshot_verified:false});
 }catch(e){throw safeError(e);}finally{run.close();try{await lock?.close();if(lockStat){const path=join(dir,'snapshot.lock'),s=await lstat(path);if(s.ino===lockStat.ino&&s.dev===lockStat.dev)await unlink(path);}}catch{}}
}

export function compareStorageInventories(before,after,beforeSha,afterSha){const a=inspectStorageInventory(before,beforeSha),b=inspectStorageInventory(after,afterSha);need(a.inventory.project===b.inventory.project,'STORAGE_INVENTORY_INVALID');const left=new Map(a.inventory.objects.map(o=>[JSON.stringify([o.bucket,o.key]),entryTag(o)])),right=new Map(b.inventory.objects.map(o=>[JSON.stringify([o.bucket,o.key]),entryTag(o)]));let added=0,removed=0,changed=0;for(const[k,v]of left)if(!right.has(k))removed++;else if(right.get(k)!==v)changed++;for(const k of right.keys())if(!left.has(k))added++;const bucket_metadata_changed=JSON.stringify(a.inventory.buckets)!==JSON.stringify(b.inventory.buckets)||a.inventory.unknown_private_bucket_count!==b.inventory.unknown_private_bucket_count;return Object.freeze({metadata_matches:added===0&&removed===0&&changed===0&&!bucket_metadata_changed,bucket_metadata_changed,added,removed,changed,without_expected_hash:a.withoutExpectedHash,storage_bytes_snapshot_verified:false,database_restore_verified:false,vault_recovery_verified:false});}

async function cli(){
 const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i++){const k=args[i];need(['--inventory','--inventory-sha256','--output','--secret-file','--download'].includes(k)&&!Object.hasOwn(opts,k));opts[k]=k==='--download'?true:args[++i];need(opts[k]!==undefined);}
 need(typeof opts['--inventory']==='string'&&SHA.test(opts['--inventory-sha256']));await safeAncestors(dirname(resolve(opts['--inventory'])),{rejectGit:false});const raw=await readPrivate(resolve(opts['--inventory']),LIMITS.inventoryBytes),parsed=inspectStorageInventory(raw,opts['--inventory-sha256']);
 if(!opts['--download']){need(!opts['--secret-file']);console.log(JSON.stringify({read_only_plan:true,objects:parsed.inventory.objects.length,total_bytes:parsed.totalBytes,without_expected_hash:parsed.withoutExpectedHash,network:false}));return;}
 const configured=storageRuntimeConfig();need(configured.project===parsed.inventory.project,'STORAGE_INVENTORY_INVALID');
 need(typeof opts['--secret-file']==='string'&&typeof opts['--output']==='string');const secretPath=resolve(opts['--secret-file']);await safeAncestors(dirname(secretPath),{rejectGit:false});const rawSecret=await readPrivate(secretPath,65536);let secret;try{secret=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawSecret));}finally{rawSecret.fill(0);}need(plain(secret)&&typeof secret.SUPABASE_SERVICE_ROLE_KEY==='string');const readObject=createPrivateStorageReader({...configured,serviceKey:secret.SUPABASE_SERVICE_ROLE_KEY,downloadEnabled:true});secret=null;
 console.log(JSON.stringify(await copyPrivateStorageSnapshot({inventoryBytes:raw,expectedInventorySha256:opts['--inventory-sha256'],outputDir:resolve(opts['--output']),readObject,downloadEnabled:true})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)cli().catch(e=>{console.error(JSON.stringify({ok:false,code:safeError(e).code}));process.exitCode=1;});
