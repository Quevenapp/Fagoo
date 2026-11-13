import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../src/index.mjs';
import {BackupImportError,loadBackupImportPlan,parseBackupImportRoute,executeBackupImport} from '../src/backup-import.mjs';

const userId='b0000000-0000-4000-8000-000000000001';
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const profile={user_id:userId,role:'admin',data_mode:'staging_readonly',resources:[]};
const url='https://erp.example.test/v1/backup-import/';
const row=(file_id,record_no,data)=>({file_id,record_no,data});
function fixture(){
  const bodies=new Map(),chunkBodies=new Map();
  const objects=[['zip','application/zip','SYNTHETIC ARCHIVE ONLY'],['xml','application/xml','<synthetic/>']].map(([ext,type,text])=>{
    const bytes=Buffer.from(text),sha=hash(bytes),key=`objects/${sha}.${ext}`;bodies.set(key,bytes);
    return {local:key,key,sha256:sha,size:bytes.length,content_type:type};
  });
  const ids=objects.map(o=>hash(o.key));
  const groups={file:objects.map((o,i)=>row(ids[i],0,{sha256:o.sha256,size:o.size,object_key:o.key,
    object_sha256:o.sha256,object_size:o.size,storage_representation:'object'})),
    xml:[row(ids[1],0,{sha256:objects[1].sha256,validation:'structural_only',signature_verified:false,xsd_validated:false})]};
  const chunks=Object.entries(groups).map(([kind,records],i)=>{
    const bytes=Buffer.from(JSON.stringify(records)),sha=hash(bytes);chunkBodies.set(sha,bytes);
    return {local:`chunks/${kind}-${String(i).padStart(5,'0')}-${sha}.json`,kind,id:sha,sha256:sha,records:records.length,size:bytes.length};
  });
  const manifest={summary:{format_version:1,source_sha256:objects[0].sha256,source_size:objects[0].size,
    counts:{file:2,csv:0,xml:1,issue:0},csv_rows_by_entity:{},invoice_occurrences_by_model:{},unique_invoice_keys_by_model:{},
    object_count:2,object_bytes:objects.reduce((n,o)=>n+o.size,0),validation:'structural_only_no_xsd_or_signature_verification',operational_effects:false},
    bucket:'origin-backups',objects,chunks};
  const env={BACKUP_IMPORT_ENABLED:'true',BACKUP_IMPORT_PLAN:JSON.stringify(manifest)};
  return {manifest,env,bodies,chunkBodies};
}
function mock(f){
  const calls=[],stored=new Map(),received=new Map();let begun=false,finished=false;
  const state={role:'admin',identity:userId,loss:null,corrupt:false,missing:false,readbackBad:false};
  const ports={userId,authenticate:async()=>({id:state.identity}),rpc:async(name,args)=>{
    calls.push({name,args});
    if(name==='erp_access_me')return {...profile,role:state.role};
    if(name==='origin_backup_begin'){const replayed=begun;begun=true;return {status:finished?'stored':'uploading',replayed};}
    if(name==='origin_backup_apply_chunk'){
      assert.ok(begun);assert.equal(args.p_backup_sha,f.manifest.summary.source_sha256);
      const prior=received.get(args.p_chunk_id);if(prior)assert.deepEqual(args,prior);
      received.set(args.p_chunk_id,args);
      if(state.loss==='chunk'){state.loss=null;throw new BackupImportError(503,'ERP_UPSTREAM_UNAVAILABLE');}
      return {replayed:!!prior,records:args.p_records.length,...(!prior?{inserted:args.p_records.length}:{})};
    }
    if(name==='origin_backup_finish'){
      assert.equal(received.size,f.manifest.chunks.length);finished=true;
      if(state.loss==='finish'){state.loss=null;throw new BackupImportError(503,'ERP_UPSTREAM_UNAVAILABLE');}
      return {status:'stored',operational_effects:false};
    }
    if(name==='erp_history_backups')return {data_mode:'backup_readonly',items:[{id:f.manifest.summary.source_sha256,
      status:state.readbackBad?'uploading':'stored',available:true,xml_occurrences:1,issues:0,finished_at:'2026-10-17T20:00:00Z'}]};
    assert.fail('unapproved RPC');
  },storage:async(method,key,bytes,type,{signal})=>{
    assert.ok(!signal.aborted);calls.push({method,key});
    if(method==='POST'){
      const existed=stored.has(key);if(!existed)stored.set(key,Buffer.from(bytes));
      return new Response(null,{status:existed?409:201});
    }
    const body=stored.get(key);
    return !body||state.missing?new Response(null,{status:404}):new Response(state.corrupt?Buffer.alloc(body.length):body);
  }};
  return {ports,calls,stored,received,state};
}
function req(path,method='POST',body,headers={},signal){return new Request(url+path,{method,headers,body,signal,...(body instanceof ReadableStream?{duplex:'half'}:{})});}
async function run(f,m,path,method='POST',body,headers={},signal){
  const request=req(path,method,body,{...(method!=='GET'?{'X-Backup-Manifest':hash(f.env.BACKUP_IMPORT_PLAN||'')}:{}),...headers},signal);
  return executeBackupImport(request,parseBackupImportRoute(new URL(request.url)),await loadBackupImportPlan(f.env),m.ports);
}
async function stage(f,m){
  await run(f,m,'begin');
  for(const o of f.manifest.objects)await run(f,m,o.key,'PUT',f.bodies.get(o.key),{'content-type':o.content_type});
  for(const c of f.manifest.chunks)await run(f,m,`chunks/${c.kind}/${c.id}`,'POST',f.chunkBodies.get(c.id),{'content-type':'application/json'});
}
async function events(result){
  assert.equal(result.type,'stream');
  return (await new Response(result.body).text()).trim().split('\n\n').filter(Boolean).map(block=>{
    const lines=block.split('\n');return {event:lines[0].slice(7),data:JSON.parse(lines[1].slice(6))};
  });
}

test('plan is server-only, bounded, exact-byte pinned, and disabled by default',async()=>{
  assert.equal(await loadBackupImportPlan({}),null);
  const f=fixture(),plan=await loadBackupImportPlan(f.env);assert.equal(plan.manifestHash,hash(f.env.BACKUP_IMPORT_PLAN));
  const edits=[p=>p.objects[0].local='../escape',p=>p.bucket='erp-attachments',p=>p.summary.operational_effects=true,
    p=>p.objects[0].size=41943041,p=>p.objects[1].size=8388609,p=>p.chunks[0].records=251,
    p=>p.chunks[0].size=2097153,p=>p.chunks[0].id='a'.repeat(64),p=>p.summary.counts.file++,
    p=>p.objects.push({...p.objects[0]}),p=>p.chunks.push({...p.chunks[0]}),p=>p.summary.actor=userId];
  for(const edit of edits){const p=structuredClone(f.manifest);edit(p);await assert.rejects(loadBackupImportPlan({...f.env,BACKUP_IMPORT_PLAN:JSON.stringify(p)}),e=>e.status===503);}
  await assert.rejects(loadBackupImportPlan({...f.env,BACKUP_IMPORT_ENABLED:'yes'}),e=>e.status===503);
  await assert.rejects(loadBackupImportPlan({...f.env,BACKUP_IMPORT_PLAN:f.manifest}),e=>e.status===503);
});

test('routes reject arbitrary paths, query actors and wrong namespaces',()=>{
  for(const path of ['begin?actor=anything','objects/a.xml','chunks/native/a','other'])assert.throws(()=>parseBackupImportRoute(new URL(url+path)));
  assert.equal(parseBackupImportRoute(new URL('https://erp.example.test/v1/history/backups')),null);
});

test('missing or stale manifest precondition rejects every mutation before any RPC or storage access',async()=>{
  const f=fixture(),m=mock(f),p=await loadBackupImportPlan(f.env),o=f.manifest.objects[0],c=f.manifest.chunks[0];
  for(const [path,method] of [['begin','POST'],['finish','POST'],[o.key,'PUT'],[`chunks/${c.kind}/${c.id}`,'POST']]){
    for(const headers of [{},{'X-Backup-Manifest':hash('a previous deployment')}]){
      const request=req(path,method,undefined,headers);
      await assert.rejects(executeBackupImport(request,parseBackupImportRoute(new URL(request.url)),p,m.ports),e=>e.status===409&&e.code==='ERP_BACKUP_PLAN_CHANGED');
    }
  }
  assert.equal(m.calls.length,0);
});

test('capabilities expose only pinned descriptors; disabled capability keeps authentication',async()=>{
  const f=fixture(),m=mock(f),result=await run(f,m,'capabilities','GET');
  assert.equal(result.body.enabled,true);assert.equal(result.body.manifest_sha256,hash(f.env.BACKUP_IMPORT_PLAN));
  assert.deepEqual(result.body.objects,f.manifest.objects);assert.deepEqual(result.body.chunks,f.manifest.chunks);
  const off={...f,env:{}};assert.deepEqual((await run(off,m,'capabilities','GET')).body,{profile:'origin-backup-import-capabilities-v1',enabled:false});
  m.state.role='fiscal';await assert.rejects(run(off,m,'capabilities','GET'),e=>e.status===403);
});

test('unknown descriptors, wrong MIME, hash, size and unsolicited begin body cannot mutate',async()=>{
  const f=fixture(),m=mock(f),o=f.manifest.objects[0];
  await assert.rejects(run(f,m,'begin','POST','{}'),e=>e.status===422);
  for(const [body,type] of [[Buffer.alloc(o.size),o.content_type],[Buffer.alloc(o.size+1),o.content_type],[f.bodies.get(o.key),'text/plain']])
    await assert.rejects(run(f,m,o.key,'PUT',body,{'content-type':type}),e=>[400,422].includes(e.status));
  await assert.rejects(run(f,m,'objects/'+hash('other')+'.zip','PUT','x',{'content-type':'application/zip'}),e=>e.status===404);
  assert.equal(m.calls.filter(c=>c.method==='POST'||c.name?.startsWith('origin_backup_')).length,0);
});

test('immutable object conflicts require authenticated byte verification and never overwrite',async()=>{
  const f=fixture(),m=mock(f),o=f.manifest.objects[0];
  let result=await run(f,m,o.key,'PUT',f.bodies.get(o.key),{'content-type':o.content_type});assert.equal(result.body.verified,true);
  result=await run(f,m,o.key,'PUT',f.bodies.get(o.key),{'content-type':o.content_type});assert.equal(result.body.verified,true);
  m.stored.set(o.key,Buffer.alloc(o.size));
  await assert.rejects(run(f,m,o.key,'PUT',f.bodies.get(o.key),{'content-type':o.content_type}),e=>e.code==='ERP_BACKUP_OBJECT_INTEGRITY');
  assert.deepEqual(m.stored.get(o.key),Buffer.alloc(o.size));
});

test('an interrupted request body and access revoked after body validation cannot upload',async()=>{
  const f=fixture(),m=mock(f),o=f.manifest.objects[0],abort=new AbortController();
  const body=new ReadableStream({start(controller){controller.enqueue(f.bodies.get(o.key).subarray(0,2));}});
  const pending=run(f,m,o.key,'PUT',body,{'content-type':o.content_type},abort.signal);
  setTimeout(()=>abort.abort(),5);await assert.rejects(pending,e=>e.status===408);
  let checks=0;m.ports.authenticate=async()=>{if(++checks===2)m.state.role='consulta';return {id:userId};};
  await assert.rejects(run(f,m,o.key,'PUT',f.bodies.get(o.key),{'content-type':o.content_type}),e=>e.status===403);
  assert.equal(m.calls.filter(c=>c.method==='POST').length,0);
});

test('chunk replay uses identical source identity and preimage after a lost acknowledgement',async()=>{
  const f=fixture(),m=mock(f),c=f.manifest.chunks[0];await run(f,m,'begin');m.state.loss='chunk';
  const send=()=>run(f,m,`chunks/${c.kind}/${c.id}`,'POST',f.chunkBodies.get(c.id),{'content-type':'application/json'});
  await assert.rejects(send(),e=>e.status===503);const result=await send();assert.equal(result.body.replayed,true);
  const writes=m.calls.filter(c=>c.name==='origin_backup_apply_chunk');assert.equal(writes.length,2);assert.deepEqual(writes[0].args,writes[1].args);
  const altered=Buffer.from(f.chunkBodies.get(c.id));altered[altered.length-1]=32;
  await assert.rejects(run(f,m,`chunks/${c.kind}/${c.id}`,'POST',altered,{'content-type':'application/json'}),e=>e.status===422);
  assert.equal(m.calls.filter(c=>c.name==='origin_backup_apply_chunk').length,2);
});

test('revoked membership or changed authentication stops writes and setup timers',async()=>{
  for(const change of ['role','identity']){
    const f=fixture(),m=mock(f);m.state[change]=change==='role'?'consulta':'b0000000-0000-4000-8000-000000000099';
    await assert.rejects(run(f,m,'finish'),e=>[401,403].includes(e.status));
    assert.equal(m.calls.filter(c=>c.name?.startsWith('origin_backup_')).length,0);
  }
});

test('finish independently rehashes every object and returns only verified readback',async()=>{
  const f=fixture(),m=mock(f);await stage(f,m);m.calls.length=0;
  const result=await events(await run(f,m,'finish'));
  const done=result.find(x=>x.event==='result').data;
  assert.equal(done.readback_verified,true);assert.equal(done.verified_objects,2);assert.equal(done.verified_bytes,f.manifest.summary.object_bytes);
  assert.equal(done.status,'stored');assert.deepEqual(done.counts,f.manifest.summary.counts);
  const at=m.calls.findIndex(c=>c.name==='origin_backup_finish');assert.equal(m.calls.slice(0,at).filter(c=>c.method==='GET').length,2);
  assert.equal(m.calls.filter(c=>c.name==='erp_history_backups').length,1);
  assert.ok(m.calls.every(c=>!c.name||['erp_access_me','erp_history_backups','origin_backup_begin','origin_backup_finish'].includes(c.name)));
});

test('missing/corrupt object and role revocation after reads prohibit finish',async()=>{
  for(const mode of ['missing','corrupt','revoked']){
    const f=fixture(),m=mock(f);await stage(f,m);m.calls.length=0;
    if(mode==='revoked'){const original=m.ports.storage;m.ports.storage=async(...args)=>{const r=await original(...args);m.state.role='consulta';return r;};}
    else m.state[mode]=true;
    const result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'error');
    assert.equal(result.at(-1).data.commit_status,'not_attempted');assert.equal(m.calls.filter(c=>c.name==='origin_backup_finish').length,0);
  }
});

test('cancelled request or SSE consumer aborts read work without dispatching finish',async()=>{
  const f=fixture(),m=mock(f);await stage(f,m);m.calls.length=0;
  const abort=new AbortController();abort.abort();await assert.rejects(run(f,m,'finish','POST',undefined,{},abort.signal),e=>e.status===408);
  const original=m.ports.storage;m.ports.storage=async(method,...args)=>method==='GET'?new Promise(()=>{}):original(method,...args);
  const streamed=await run(f,m,'finish');const reader=streamed.body.getReader();await reader.read();await reader.cancel();
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(m.calls.filter(c=>c.name==='origin_backup_finish').length,0);
  const active=new AbortController(),other=await run(f,m,'finish','POST',undefined,{},active.signal);
  const activeReader=other.body.getReader();await activeReader.read();active.abort();
  await assert.rejects(activeReader.read());
  assert.equal(m.calls.filter(c=>c.name==='origin_backup_finish').length,0);
});

test('lost finish ACK remains unknown; exact replay then readback proves completion',async()=>{
  const f=fixture(),m=mock(f);await stage(f,m);m.state.loss='finish';
  let result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'error');assert.equal(result.at(-1).data.commit_status,'unknown');
  result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'result');
  const writes=m.calls.filter(c=>c.name==='origin_backup_finish');assert.equal(writes.length,2);assert.deepEqual(writes[0].args,writes[1].args);
});

test('a committed finish with failed independent readback never reports success',async()=>{
  const f=fixture(),m=mock(f);await stage(f,m);m.state.readbackBad=true;
  const result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'error');assert.equal(result.at(-1).data.commit_status,'acknowledged');
  assert.ok(result.every(x=>x.event!=='result'));
});

// The real module in workerd. /stats tells what the runtime saw: finishes dispatched, storage reads cancelled, requests aborted.
async function workerd(f){
  const {Miniflare,Log,LogLevel}=await import('miniflare');
  const source=await readFile(new URL('../src/backup-import.mjs',import.meta.url),'utf8');
  const script=source+`
    const testManifest=${JSON.stringify(f.manifest)},testUser=${JSON.stringify(userId)};
    let testFinished=0,testCancelled=0,testIncomingAborted=0;
    export default {async fetch(request){
      if(new URL(request.url).pathname==='/stats')return Response.json({finished:testFinished,cancelled:testCancelled,incomingAborted:testIncomingAborted});
      request.signal.addEventListener('abort',()=>testIncomingAborted++,{once:true});
      const plan=await loadBackupImportPlan({BACKUP_IMPORT_ENABLED:true,BACKUP_IMPORT_PLAN:JSON.stringify(testManifest)});
      const result=await executeBackupImport(request,parseBackupImportRoute(new URL(request.url)),plan,{
        userId:testUser,authenticate:async()=>({id:testUser}),
        rpc:async(name)=>{
          if(name==='erp_access_me')return {user_id:testUser,role:'admin',data_mode:'staging_readonly'};
          if(name==='origin_backup_begin')return {status:testFinished?'stored':'uploading',replayed:true};
          if(name==='origin_backup_finish'){testFinished++;return {status:'stored',operational_effects:false};}
          if(name==='erp_history_backups')return {data_mode:'backup_readonly',items:[{id:plan.backupHash,status:'stored',available:true,xml_occurrences:1,issues:0,finished_at:'2026-10-17T20:00:00Z'}]};
          throw new Error('unapproved');
        },
        storage:async(method,key,body,type,{signal})=>{
          if(method!=='GET')throw new Error('unapproved');
          await new Promise((resolve,reject)=>{
            const abort=()=>{clearTimeout(timer);testCancelled++;reject(new Error('cancelled'));};
            const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},250);
            signal.addEventListener('abort',abort,{once:true});
          });
          return new Response(key.endsWith('.zip')?'SYNTHETIC ARCHIVE ONLY':'<synthetic/>');
        },
      });
      return new Response(result.body,{headers:{'Content-Type':'text/event-stream'}});
    }};
  `;
  const mf=new Miniflare({workers:[{config:{name:'backup-import-runtime-test',compatibilityDate:'2026-10-15',compatibilityFlags:['enable_request_signal'],manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:script}}}},dev:{unsafeDirectSockets:[{host:'127.0.0.1',port:0}]}}],host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},log:new Log(LogLevel.NONE)});
  try{await mf.ready;}catch(error){await mf.dispose();throw error;}
  const origin=(await mf.unsafeGetDirectURL('backup-import-runtime-test')).origin;
  return {mf,endpoint:origin+'/v1/backup-import/finish',headers:{'X-Backup-Manifest':hash(f.env.BACKUP_IMPORT_PLAN)},stats:async()=>(await fetch(origin+'/stats')).json()};
}

test('workerd keeps SSE alive without waitUntil',async()=>{
  const {mf,endpoint,headers,stats}=await workerd(fixture());
  try{
    const first=await fetch(endpoint,{method:'POST',headers});
    const reader=first.body.getReader();const firstChunk=await reader.read();assert.match(new TextDecoder().decode(firstChunk.value),/event: progress/);
    let text='';while(true){const next=await reader.read();if(next.done)break;text+=new TextDecoder().decode(next.value);}
    assert.match(text,/event: result/);assert.equal((await stats()).finished,1);
  }finally{await mf.dispose();}
});

// workerd on Windows does not observe an abortive close while the response is idle: Request.signal fires only after the next
// write, when the finish has already been dispatched (measured with workerd 1.20261102.1, with a storage read of 2 s too).
// The API runs on Linux, and this case runs there: the reset has to be observed during the read, before any finish.
test('a TCP reset observed by workerd aborts verification before the finish',{skip:process.platform==='win32'&&'workerd on Windows observes the reset only at its next write; run on Linux'},async()=>{
  const {mf,endpoint,headers,stats}=await workerd(fixture());
  try{
    const {request:httpRequest}=await import('node:http');
    await new Promise((resolve,reject)=>{
      let received=false;
      const outgoing=httpRequest(endpoint,{method:'POST',headers},response=>{
        // An abortive close exercises a disconnect observed by workerd. A TCP half-close
        // is not guaranteed to be observed while the server is sending a response.
        response.once('data',chunk=>{received=true;assert.match(chunk.toString(),/event: progress/);response.socket.resetAndDestroy();resolve();});
        response.on('error',error=>{if(!received)reject(error);});
      });
      outgoing.on('error',error=>{if(!received)reject(error);});outgoing.end();
    });
    await new Promise(resolve=>setTimeout(resolve,400));
    const seen=await stats();assert.equal(seen.finished,0,JSON.stringify(seen));assert.ok(seen.cancelled>0);assert.ok(seen.incomingAborted>0);
  }finally{await mf.dispose();}
});

test('HTTP integration preserves CORS, exact actor, secret separation and private storage paths',async()=>{
  const f=fixture(),m=mock(f),network=[];
  const env={...f.env,SUPABASE_URL:'https://exampleproject.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-synthetic',ALLOWED_ORIGINS:'https://erp.example.test'};
  const handler=createHandler({fetchImpl:async(url,options)=>{
    network.push({url,options});const path=new URL(url).pathname;
    if(path==='/auth/v1/user'){assert.equal(options.headers.Authorization,'Bearer browser-only-synthetic');return json(await m.ports.authenticate());}
    assert.equal(options.headers.Authorization,'Bearer server-only-synthetic');assert.equal(options.headers.apikey,'server-only-synthetic');
    if(path.startsWith('/rest/v1/rpc/'))return json(await m.ports.rpc(path.split('/').at(-1),JSON.parse(options.body)));
    assert.match(path,/^\/storage\/v1\/object\/(?:authenticated\/)?origin-backups\/objects\/[a-f0-9]{64}\.(zip|xml)$/);
    assert.equal(options.headers['x-upsert'],'false');assert.equal(options.redirect,'manual');
    return m.ports.storage(options.method,path.slice(path.indexOf('objects/')),options.body,options.headers['Content-Type'],{signal:options.signal});
  }});
  const http=async(path,method='GET',body,type)=>handler(req(path,method,body,{Authorization:'Bearer browser-only-synthetic',Origin:'https://erp.example.test',...(method!=='GET'?{'X-Backup-Manifest':hash(f.env.BACKUP_IMPORT_PLAN)}:{}),...(type?{'Content-Type':type}:{})}),env);
  const capability=await http('capabilities');assert.equal(capability.status,200);assert.equal(capability.headers.get('Access-Control-Allow-Origin'),'https://erp.example.test');
  assert.doesNotMatch(await capability.text(),/server-only|browser-only|p_user_id/);
  assert.equal((await http('begin','POST')).status,200);
  const o=f.manifest.objects[0];assert.equal((await http(o.key,'PUT',f.bodies.get(o.key),o.content_type)).status,200);
  assert.ok(network.filter(c=>c.url.endsWith('/erp_access_me')).every(c=>JSON.parse(c.options.body).p_user_id===userId));
  const preflight=req(o.key,'OPTIONS',undefined,{Origin:'https://erp.example.test','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'authorization,content-type,x-backup-manifest'});
  assert.equal((await handler(preflight,env)).status,204);
  const count=network.length;assert.equal((await handler(req('capabilities','GET',undefined,{Origin:'https://evil.test'}),env)).status,403);assert.equal(network.length,count);
  assert.equal((await handler(req('capabilities','GET',undefined,{Authorization:'Bearer browser-only-synthetic'}),{...env,BACKUP_IMPORT_PLAN:'{}'})).status,503);
  assert.equal(network.length,count);
});

test('real staging SQL accepts a second immutable backup and preserves the first without native DML',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,name text,primary key(bucket_id,name));`);
    for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0007_erp_history'])
      await db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
    await db.query('insert into auth.users values($1)',[userId]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[userId]);
    const old=hash('old preserved origin');await db.query("insert into origin_backup.batch(backup_sha,manifest,status)values($1,'{}','stored')",[old]);
    const scalar=async(sql,args=[])=> (await db.query(sql,args)).rows[0].v;
    const before=await scalar('select to_jsonb(b)::text v from origin_backup.batch b where backup_sha=$1',[old]);
    const f=fixture(),m=mock(f);m.ports.rpc=async(name,args)=>{
      const names={erp_access_me:['p_user_id'],erp_history_backups:['p_user_id'],origin_backup_begin:['p_backup_sha','p_manifest'],
        origin_backup_apply_chunk:['p_backup_sha','p_kind','p_chunk_id','p_records'],origin_backup_finish:['p_backup_sha']};
      assert.ok(Object.hasOwn(names,name));
      const values=names[name].map(key=>typeof args[key]==='object'?JSON.stringify(args[key]):args[key]);
      return scalar(`select public.${name}(${values.map((_,i)=>'$'+(i+1)).join(',')})v`,values);
    };
    const store=m.ports.storage;m.ports.storage=async(method,key,...args)=>{
      const response=await store(method,key,...args);
      if(method==='POST')await db.query("insert into storage.objects values('origin-backups',$1)on conflict do nothing",[key]);
      return response;
    };
    await stage(f,m);let result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'result');
    await stage(f,m);result=await events(await run(f,m,'finish'));assert.equal(result.at(-1).event,'result');
    assert.equal(await scalar('select to_jsonb(b)::text v from origin_backup.batch b where backup_sha=$1',[old]),before);
    assert.equal(await scalar('select count(*)::int v from origin_backup.batch'),2);
    assert.equal(await scalar('select count(*)::int v from origin_backup.record'),3);
    assert.equal(await scalar('select count(*)::int v from origin_sync.raw_record'),0);
  }finally{await db.close();}
});
