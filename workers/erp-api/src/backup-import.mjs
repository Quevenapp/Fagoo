/** One compiled, private backup plan. No HTTP-supplied plan, actor, RPC or storage path. */
const PREFIX = '/v1/backup-import';
const SHA = /^[a-f0-9]{64}$/;
const KINDS = ['file', 'csv', 'xml', 'issue'];
const TYPES = {zip:'application/zip', xml:'application/xml', csv:'text/csv', bin:'application/octet-stream'};
const encoder = new TextEncoder();
export const BACKUP_IMPORT_LIMITS = Object.freeze({source_bytes:41943040, xml_bytes:8388608,
  chunk_bytes:2097152, chunk_records:250, objects:9000, archive_bytes:536870912,
  archive_entries:19001, concurrency:4});
export class BackupImportError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new BackupImportError(status, code); };
const invalid = () => fail(400, 'ERP_BACKUP_INVALID_INPUT');
const configInvalid = () => fail(503, 'ERP_BACKUP_NOT_CONFIGURED');
const upstreamInvalid = () => fail(502, 'ERP_BACKUP_UPSTREAM_INVALID');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const backupImportHash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
function check(signal) { if (signal?.aborted) fail(408, 'ERP_BACKUP_ABORTED'); }
function disposeBody(response) { void response?.body?.cancel().catch(()=>{}); }

export function backupImportRoute(path) { return path === PREFIX || path.startsWith(PREFIX + '/'); }
export function parseBackupImportRoute(url) {
  if (!backupImportRoute(url.pathname)) return null;
  if (url.search || url.hash) invalid();
  if (url.pathname === PREFIX + '/capabilities') return {action:'capabilities', method:'GET'};
  if (url.pathname === PREFIX + '/begin') return {action:'begin', method:'POST'};
  if (url.pathname === PREFIX + '/finish') return {action:'finish', method:'POST'};
  let match = /^\/v1\/backup-import\/objects\/([a-f0-9]{64}\.(?:zip|xml|csv|bin))$/.exec(url.pathname);
  if (match) return {action:'object', method:'PUT', key:'objects/' + match[1]};
  match = /^\/v1\/backup-import\/chunks\/(file|csv|xml|issue)\/([a-f0-9]{64})$/.exec(url.pathname);
  if (match) return {action:'chunk', method:'POST', kind:match[1], id:match[2]};
  fail(404, 'ERP_NOT_FOUND');
}
export function backupImportMethods(url) { return [parseBackupImportRoute(url).method]; }

let cachedRaw, cachedPlan;
/** The string is the exact prepared manifest.json, not a reserialized HTTP document. */
export async function loadBackupImportPlan(env) {
  if (env.BACKUP_IMPORT_ENABLED === undefined || env.BACKUP_IMPORT_ENABLED === false || env.BACKUP_IMPORT_ENABLED === 'false') return null;
  if (env.BACKUP_IMPORT_ENABLED !== true && env.BACKUP_IMPORT_ENABLED !== 'true') configInvalid();
  const raw = env.BACKUP_IMPORT_PLAN;
  if (typeof raw !== 'string' || !raw || encoder.encode(raw).length > 16777216) configInvalid();
  if (cachedRaw === raw) return cachedPlan;
  let manifest;
  try { manifest = JSON.parse(raw); } catch { configInvalid(); }
  if (!exactKeys(manifest, ['summary','bucket','objects','chunks']) || manifest.bucket !== 'origin-backups'
    || !Array.isArray(manifest.objects) || !integer(manifest.objects.length, 1, BACKUP_IMPORT_LIMITS.objects)
    || !Array.isArray(manifest.chunks) || !integer(manifest.chunks.length, 1, 10000)) configInvalid();
  const s = manifest.summary;
  if (!exactKeys(s, ['format_version','source_sha256','source_size','counts','csv_rows_by_entity',
    'invoice_occurrences_by_model','unique_invoice_keys_by_model','object_count','object_bytes','validation','operational_effects'])
    || s.format_version !== 1 || !SHA.test(s.source_sha256) || !integer(s.source_size,1,BACKUP_IMPORT_LIMITS.source_bytes)
    || s.operational_effects !== false || s.validation !== 'structural_only_no_xsd_or_signature_verification'
    || s.object_count !== manifest.objects.length || !integer(s.object_bytes,1,BACKUP_IMPORT_LIMITS.archive_bytes)
    || !exactKeys(s.counts,KINDS) || KINDS.some(kind=>!integer(s.counts[kind],0,1000000))
    || encoder.encode(JSON.stringify(s,null,1)).length > 65536) configInvalid();
  for (const key of ['csv_rows_by_entity','invoice_occurrences_by_model','unique_invoice_keys_by_model']) {
    if (!plain(s[key]) || Object.keys(s[key]).length > 32 || Object.entries(s[key]).some(([name,value])=>
      !/^[a-z0-9_]{1,40}$/.test(name) || !integer(value,0,1000000))) configInvalid();
  }
  const objects = new Map(), chunks = new Map(), paths = new Set(['manifest.json']);
  let objectBytes = 0, archiveBytes = encoder.encode(raw).length;
  for (const item of manifest.objects) {
    if (!exactKeys(item,['local','key','sha256','size','content_type'])) configInvalid();
    const match = /^objects\/([a-f0-9]{64})\.(zip|xml|csv|bin)$/.exec(item.key);
    if (!match || item.local !== item.key || item.sha256 !== match[1] || item.content_type !== TYPES[match[2]]
      || !integer(item.size,1,match[2]==='xml'?BACKUP_IMPORT_LIMITS.xml_bytes:BACKUP_IMPORT_LIMITS.source_bytes)
      || paths.has(item.local)) configInvalid();
    paths.add(item.local); objects.set(item.key,Object.freeze(item)); objectBytes += item.size;
  }
  const counts = Object.fromEntries(KINDS.map(kind=>[kind,0]));
  for (const item of manifest.chunks) {
    if (!exactKeys(item,['local','kind','id','sha256','records','size']) || !KINDS.includes(item.kind)
      || !SHA.test(item.id) || item.sha256 !== item.id || chunks.has(item.id)
      || !new RegExp(`^chunks/${item.kind}-[0-9]{5}-${item.id}\\.json$`).test(item.local)
      || paths.has(item.local) || !integer(item.records,1,250) || !integer(item.size,1,BACKUP_IMPORT_LIMITS.chunk_bytes)) configInvalid();
    paths.add(item.local); chunks.set(item.id,Object.freeze(item)); counts[item.kind] += item.records; archiveBytes += item.size;
  }
  // Exact ZIP_STORED local/central header overhead, with no extras or comments.
  archiveBytes += objectBytes + 22 + [...paths].reduce((n,path)=>n+76+2*path.length,0);
  const source = objects.get(`objects/${s.source_sha256}.zip`);
  if (!source || source.size !== s.source_size || objectBytes !== s.object_bytes
    || KINDS.some(kind=>counts[kind] !== s.counts[kind]) || paths.size > BACKUP_IMPORT_LIMITS.archive_entries
    || archiveBytes > BACKUP_IMPORT_LIMITS.archive_bytes) configInvalid();
  const plan = Object.freeze({manifest, objects, chunks, manifestHash:await backupImportHash(encoder.encode(raw)), backupHash:s.source_sha256});
  // A single-entry cache never stores credentials or anything supplied by HTTP.
  cachedRaw = raw; cachedPlan = plan;
  return plan;
}

function scope(parent, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort',abort,{once:true});
  if (parent?.aborted) abort();
  const timer = setTimeout(abort,timeoutMs);
  return {controller, signal:controller.signal, close(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
async function cancellable(promise, signal, late) {
  check(signal);
  let listener;
  const cancelled = new Promise((_,r)=>{listener=()=>r(new BackupImportError(408,'ERP_BACKUP_ABORTED'));signal.addEventListener('abort',listener,{once:true});});
  const work = Promise.resolve(promise);
  void work.then(value=>{if(signal.aborted)late?.(value);},()=>{});
  try { const value = await Promise.race([work,cancelled]); check(signal); return value; }
  finally { signal.removeEventListener('abort',listener); }
}
async function bounded(parent, ms, fn) {
  const life=scope(parent,ms);
  try { return await cancellable(fn(life.signal),life.signal); }
  finally { life.close(); life.controller.abort(); }
}
async function exactBytes(message, size, signal, remote=false) {
  const bad = () => fail(remote?502:422,remote?'ERP_BACKUP_OBJECT_INTEGRITY':'ERP_BACKUP_INTEGRITY');
  const length=message.headers.get('content-length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length)!==size)) {disposeBody(message);bad();}
  if (!message.body) { if(size===0)return new Uint8Array();bad(); }
  const bytes=new Uint8Array(size), reader=message.body.getReader();let at=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try {
    while(true){
      const item=await cancellable(reader.read(),signal);
      if(item.done)break;
      if(!(item.value instanceof Uint8Array)||at+item.value.length>size)bad();
      bytes.set(item.value,at);at+=item.value.length;
    }
    check(signal);if(at!==size)bad();return bytes;
  } finally {signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function emptyBody(request, signal) { await exactBytes(request,0,signal); }
function contentType(request, expected) {
  const value=request.headers.get('content-type')||'';
  if (value.split(';')[0].trim().toLowerCase()!==expected || request.headers.has('content-encoding')) invalid();
}
function receipt(plan, action, fields) {
  return {profile:'origin-backup-import-receipt-v1',action,backup_sha256:plan.backupHash,
    manifest_sha256:plan.manifestHash,operational_effects:false,...fields};
}
function beginResult(raw) {
  if (!plain(raw) || !['uploading','stored','stored_with_issues'].includes(raw.status) || typeof raw.replayed!=='boolean') upstreamInvalid();
  return {status:raw.status,replayed:raw.replayed};
}
function safeError(error) { return typeof error?.code==='string' && /^ERP_[A-Z_]{1,80}$/.test(error.code) ? error.code : 'ERP_BACKUP_UPSTREAM_UNAVAILABLE'; }

/** All network adapters use a fixed server origin. No service credential enters a DTO. */
export async function executeBackupImport(request, route, plan, ports) {
  if (request.method!==route.method) fail(405,'ERP_METHOD_NOT_ALLOWED');
  const life=scope(request.signal,route.action==='finish'?1800000:90000);
  const signal=life.signal;let streaming=false;
  const rpc=async(name,args,active=signal)=>{
    if (!['erp_access_me','erp_history_backups','origin_backup_begin','origin_backup_apply_chunk','origin_backup_finish'].includes(name)) upstreamInvalid();
    check(active);const result=await cancellable(ports.rpc(name,args,{signal:active,deadline:Date.now()+15000}),active);check(active);return result;
  };
  const authorize=async(active=signal)=>{
    const user=await cancellable(ports.authenticate({signal:active,deadline:Date.now()+15000}),active);
    if (!user || user.id!==ports.userId || user.is_anonymous===true) fail(401,'ERP_UNAUTHENTICATED');
    const profile=await rpc('erp_access_me',{p_user_id:ports.userId},active);
    if (!profile || profile.user_id!==ports.userId || profile.data_mode!=='staging_readonly') upstreamInvalid();
    if(profile.role!=='admin')fail(403,'ERP_FORBIDDEN');check(active);
  };
  const storage=async(method,object,body,active)=>{
    if (!plan.objects.has(object.key)) upstreamInvalid();
    check(active);
    const response=await cancellable(ports.storage(method,object.key,body,object.content_type,{signal:active}),active,disposeBody);
    if (!response || response.redirected || response.status>=300&&response.status<400) {disposeBody(response);upstreamInvalid();}
    return response;
  };
  const verify=async(object)=>bounded(signal,30000,async active=>{
    const response=await storage('GET',object,undefined,active);
    if(response.status!==200){disposeBody(response);fail(502,'ERP_BACKUP_OBJECT_UNAVAILABLE');}
    const bytes=await exactBytes(response,object.size,active,true);
    if(await backupImportHash(bytes)!==object.sha256)fail(502,'ERP_BACKUP_OBJECT_INTEGRITY');
    check(active);return true;
  });
  try {
    // A deployment can replace the compiled plan after capabilities were read.
    // This precondition supplies no new plan data and precedes every RPC.
    if(route.action!=='capabilities'){
      if(!plan)fail(404,'ERP_BACKUP_DISABLED');
      if(request.headers.get('X-Backup-Manifest')!==plan.manifestHash)fail(409,'ERP_BACKUP_PLAN_CHANGED');
    }
    await authorize();
    if(route.action==='capabilities'){
      await emptyBody(request,signal);
      return {type:'json',body:plan?{profile:'origin-backup-import-capabilities-v1',enabled:true,
        manifest_sha256:plan.manifestHash,backup_sha256:plan.backupHash,summary:plan.manifest.summary,
        limits:BACKUP_IMPORT_LIMITS,objects:plan.manifest.objects,chunks:plan.manifest.chunks}:
        {profile:'origin-backup-import-capabilities-v1',enabled:false}};
    }
    if(!plan)fail(404,'ERP_BACKUP_DISABLED');
    if(route.action==='object'){
      const object=plan.objects.get(route.key);if(!object)fail(404,'ERP_NOT_FOUND');
      contentType(request,object.content_type);
      let bytes=await exactBytes(request,object.size,signal);
      if(await backupImportHash(bytes)!==object.sha256)fail(422,'ERP_BACKUP_INTEGRITY');check(signal);
      await authorize();
      try {
        await bounded(signal,45000,async active=>{
          const response=await storage('POST',object,bytes,active);
          const status=response.status;disposeBody(response);
          if(![200,201,400,409].includes(status))fail(502,'ERP_BACKUP_UPLOAD_UNAVAILABLE');
        });
      } finally { bytes=null; }
      // Release the upload buffer before allocating the authenticated readback buffer.
      await verify(object);
      await authorize();
      return {type:'json',body:receipt(plan,'object',{key:object.key,sha256:object.sha256,size:object.size,verified:true})};
    }
    if(route.action==='chunk'){
      const chunk=plan.chunks.get(route.id);if(!chunk||chunk.kind!==route.kind)fail(404,'ERP_NOT_FOUND');
      contentType(request,'application/json');
      const bytes=await exactBytes(request,chunk.size,signal);
      if(await backupImportHash(bytes)!==chunk.sha256)fail(422,'ERP_BACKUP_INTEGRITY');check(signal);
      let records;try{records=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid();}
      if(!Array.isArray(records)||records.length!==chunk.records||records.some(item=>!exactKeys(item,['file_id','record_no','data'])
        || !SHA.test(item.file_id)||!integer(item.record_no,0,9999999)||!plain(item.data)))invalid();
      await authorize();
      const raw=await rpc('origin_backup_apply_chunk',{p_backup_sha:plan.backupHash,p_kind:chunk.kind,p_chunk_id:chunk.id,p_records:records});
      if(!plain(raw)||raw.records!==chunk.records||typeof raw.replayed!=='boolean'
        || !raw.replayed&&!integer(raw.inserted,0,chunk.records))upstreamInvalid();
      await authorize();
      return {type:'json',body:receipt(plan,'chunk',{kind:chunk.kind,id:chunk.id,sha256:chunk.sha256,records:chunk.records,replayed:raw.replayed})};
    }
    await emptyBody(request,signal);
    if(route.action==='begin'){
      await authorize();
      const raw=beginResult(await rpc('origin_backup_begin',{p_backup_sha:plan.backupHash,p_manifest:plan.manifest.summary}));
      await authorize();return {type:'json',body:receipt(plan,'begin',raw)};
    }
    // The open response owns this work; delivered request/stream cancellation stops verification.
    // A disconnect that the runtime has not observed cannot undo a dispatched finish.
    let commitStatus='not_attempted';
    streaming=true;
    const {readable,writable}=new TransformStream();
    const writer=writable.getWriter();
    const cancelOutput=()=>{void writer.abort(new BackupImportError(408,'ERP_BACKUP_ABORTED')).catch(()=>{});};
    signal.addEventListener('abort',cancelOutput,{once:true});
    // Also stop reads when the response sink reports cancellation before Request.signal does.
    void writer.closed.catch(()=>life.controller.abort());
    const emit=async(event,data)=>{check(signal);await cancellable(writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),signal);};
    void (async()=>{
          let completed=0,verifiedBytes=0,nextAuth=50;
          const objects=plan.manifest.objects;
          const progress=()=>emit('progress',{profile:'origin-backup-import-progress-v1',phase:'verifying_objects',completed,total:objects.length,verified_bytes:verifiedBytes});
          await progress();
          // At most32MiB in parallel; a larger original ZIP runs alone.
          for(let at=0;at<objects.length;){
            check(signal);const batch=[];let bytes=0;
            while(at<objects.length&&batch.length<4&&(batch.length===0||bytes+objects[at].size<=33554432)){batch.push(objects[at++]);bytes+=batch.at(-1).size;}
            const results=await Promise.allSettled(batch.map(object=>verify(object)));
            const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
            completed+=batch.length;verifiedBytes+=bytes;
            if(completed>=nextAuth){await authorize();nextAuth=completed+50;}
            if(completed===objects.length||completed%24<batch.length)await progress();
          }
          if(completed!==objects.length||verifiedBytes!==plan.manifest.summary.object_bytes)upstreamInvalid();
          await authorize();
          // Bind the immutable manifest before the only finish call; begin is exact and replayable.
          beginResult(await rpc('origin_backup_begin',{p_backup_sha:plan.backupHash,p_manifest:plan.manifest.summary}));
          check(signal);commitStatus='unknown';
          const done=await rpc('origin_backup_finish',{p_backup_sha:plan.backupHash});
          const status=plan.manifest.summary.counts.issue?'stored_with_issues':'stored';
          if(!plain(done)||done.status!==status||done.operational_effects!==false)upstreamInvalid();
          commitStatus='acknowledged';
          await authorize();
          const same=beginResult(await rpc('origin_backup_begin',{p_backup_sha:plan.backupHash,p_manifest:plan.manifest.summary}));
          if(!same.replayed||same.status!==status)upstreamInvalid();
          const history=await rpc('erp_history_backups',{p_user_id:ports.userId});
          if(!history||history.data_mode!=='backup_readonly'||!Array.isArray(history.items)||history.items.length>100)upstreamInvalid();
          const rows=history.items.filter(item=>item.id===plan.backupHash);
          if(rows.length!==1||rows[0].status!==status||rows[0].available!==true
            || rows[0].xml_occurrences!==plan.manifest.summary.counts.xml||rows[0].issues!==plan.manifest.summary.counts.issue
            || typeof rows[0].finished_at!=='string'||!Number.isFinite(Date.parse(rows[0].finished_at)))upstreamInvalid();
          await authorize();
          await emit('result',{profile:'origin-backup-import-result-v1',backup_sha256:plan.backupHash,manifest_sha256:plan.manifestHash,
            status,verified_objects:completed,verified_bytes:verifiedBytes,counts:plan.manifest.summary.counts,readback_verified:true,operational_effects:false});
          await writer.close();
    })().catch(async error=>{
      try{await emit('error',{error:{code:safeError(error)},commit_status:commitStatus});await writer.close();}
      catch{cancelOutput();}
    }).finally(()=>{signal.removeEventListener('abort',cancelOutput);life.close();life.controller.abort();try{writer.releaseLock();}catch{}});
    return {type:'stream',body:readable};
  } finally {
    if(!streaming){life.close();life.controller.abort();}
  }
}
