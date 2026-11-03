// Synthetic PostgreSQL17 checks only. Isolated Unix socket, no TCP or project credentials.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {invoice,keyFor} from '../../workers/origin-sync/test/xml-fixtures.mjs';
import {inspectArchivedXml} from '../../packages/fiscal-xml/src/archive.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const q=value=>"'"+(typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")+"'";
const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'Explicit PostgreSQL17 binary directory required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const base=await realpath(process.env.BRUFAP_TEST_TMPDIR??tmpdir()),bs=await lstat(base);
assert.ok(bs.isDirectory()&&(!(bs.mode&0o022)||(bs.mode&0o1000)));assert.match(base,/^\/[A-Za-z0-9_./-]*$/);
const root=await mkdtemp(join(base,'brufap-xml092-')),owned=await lstat(root),socket=join(root,'s'),port='56592';
await mkdir(socket,{mode:0o700});assert.ok(Buffer.byteLength(join(socket,`.s.PGSQL.${port}`))<104);
let started=false;const children=new Set(),results=[];
async function ownedRoot(){const st=await lstat(root);assert.equal(dirname(root),base);assert.match(basename(root),/^brufap-xml092-[A-Za-z0-9]+$/);assert.ok(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.dev,owned.dev);assert.equal(st.ino,owned.ino);assert.equal(await realpath(root),root);}
function session(){
  const child=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
  children.add(child);let out='',err='',ended=false;const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.stdin.on('error',()=>{});child.stdout.on('data',b=>{out+=b;if(out.length>16777216)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>262144)child.kill('SIGKILL');});child.on('close',code=>{ended=true;children.delete(child);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});
  return{done,write:sql=>child.stdin.write(sql+'\n'),end:sql=>{if(!child.stdin.writableEnded)child.stdin.end(sql+'\n');},async marker(mark){const until=Date.now()+10000;while(!out.includes(mark)){assert.equal(ended,false,err);assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,15));}}};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const json=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(line=>line.startsWith('{')||line.startsWith('[')));
const rejected=(r,code)=>{assert.equal(r.code,3,r.err);assert.match(r.err,new RegExp(`ERROR:\\s+${code}:`));assert.doesNotMatch(r.err,/40P01/);};
const record=name=>{results.push({scenario:name,passed:true});process.stderr.write('PASS '+name+'\n');};
const source=await readFile(new URL('../../supabase/migrations/202610170092_origin_xml_priority_sources.sql',import.meta.url),'utf8');
const owner='92000000-0000-4000-8000-000000000001';let fence,candidate;
const invoke=()=>`set role service_role;select public.origin_sync_xml_priority_sources(${q(owner)},${q(fence)},${q([candidate])}::jsonb);reset role;`;
const functionCatalog=`select coalesce(jsonb_agg(to_jsonb(p)order by p.oid),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like'pg_%'and n.nspname<>'information_schema'and p.proname<>'origin_sync_xml_priority_sources';`;
try{
  execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
  execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
  assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
  const migrations=new URL('../../supabase/migrations/',import.meta.url),names=(await readdir(migrations)).filter(n=>/^202610(?:16|17)0\d{3}_.+\.sql$/.test(n)&&Number(n.slice(8,12))<=91).sort();assert.equal(names.length,91);
  for(const name of names)ok(await run(await readFile(new URL(name,migrations),'utf8')));
  const before=ok(await run(functionCatalog)).out;ok(await run(source));assert.equal(ok(await run(functionCatalog)).out,before);record('baseline001_091_function_rows_preserved');
  const contract=json(await run(`select jsonb_build_object('signature',oid::regprocedure::text,'prosrc_sha256',encode(sha256(convert_to(prosrc,'UTF8')),'hex'),
   'owner',pg_get_userbyid(proowner),'language',(select lanname from pg_language where oid=prolang),'security_definer',prosecdef,'volatility',provolatile,'parallel',proparallel,
   'kind',prokind,'returns',pg_get_function_result(oid),'config',proconfig,'acl',proacl::text,
   'grants',(select jsonb_agg(jsonb_build_object('grantee',case when grantee=0 then'PUBLIC'else pg_get_userbyid(grantee)end,'privilege',privilege_type,'grantable',is_grantable)order by grantee)from aclexplode(proacl)))
   from pg_proc where oid='public.origin_sync_xml_priority_sources(uuid,uuid,jsonb)'::regprocedure;`));
  assert.equal(contract.owner,'postgres');assert.equal(contract.language,'plpgsql');assert.equal(contract.security_definer,true);assert.equal(contract.volatility,'v');assert.equal(contract.parallel,'u');assert.equal(contract.kind,'f');assert.equal(contract.returns,'jsonb');
  assert.deepEqual(contract.config,['search_path=pg_catalog','lock_timeout=750ms','statement_timeout=5s']);assert.deepEqual(contract.grants.filter(g=>g.grantee!=='postgres'),[{grantee:'service_role',privilege:'EXECUTE',grantable:false}]);
  for(const role of ['anon','authenticated'])rejected(await run(`set role ${role};select public.origin_sync_xml_priority_sources(null,null,'[]');`),'42501');record('service_only_exact_function_contract');
  fence=json(await run(`select public.origin_sync_claim('__scheduler__',${q(owner)},600);`)).lease_token;
  const payload={id:'1',chaveAcesso:keyFor('55'),situacao:5,tipo:1,numero:'1',serie:1,dataEmissao:'2026-10-17 15:00:00',valorNota:42};
  ok(await run(`insert into origin_sync.resource_state(resource)values('nfe_out')on conflict do nothing;insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values('nfe','nfe_out','1',${q(payload)}::jsonb,repeat('a',64));`));
  candidate=json(await run(`select jsonb_build_object('entity','nfe','source_id','1','key',payload->>'chaveAcesso','fingerprint',origin_fiscal.fingerprint(payload))from origin_sync.raw_record where entity='nfe'and source_id='1';`));
  const rowHash=`select jsonb_build_object('raw',(select jsonb_agg(to_jsonb(r))from origin_sync.raw_record r),'state',(select jsonb_agg(to_jsonb(r)order by resource)from origin_sync.resource_state r),'sources',(select jsonb_agg(to_jsonb(r))from origin_fiscal.source r),'attempts',(select jsonb_agg(to_jsonb(r))from origin_fiscal.attempt r));`;
  const beforeRows=ok(await run(rowHash)).out,result=json(await run(invoke()));assert.equal(result.items[0].eligible,true);assert.equal(result.items[0].terminal_confirmed,false);assert.equal(ok(await run(rowHash)).out,beforeRows);record('read_only_exact_source_and_row_preservation');
  for(const [name,lock]of [
    ['scheduler_writer_nowait',"select resource from origin_sync.resource_state where resource='__scheduler__'for update;"],
    ['archive_DDL_lock_nowait','lock table origin_fiscal.source in access exclusive mode;'],
  ]){
    const holder=session();holder.write('begin;'+lock+'\n\\echo HELD');try{await holder.marker('HELD');const start=Date.now();rejected(await run(invoke()),'55P03');assert.ok(Date.now()-start<2500);record(name);}finally{holder.end('rollback;');ok(await holder.done);}
  }
  const reader=session();reader.write("begin;select resource from origin_sync.resource_state where resource='__scheduler__'for share;lock table origin_fiscal.source in access share mode;\n\\echo HELD");
  try{await reader.marker('HELD');assert.equal(json(await run(invoke())).items[0].eligible,true);record('compatible_reader_and_same_lease_allowed');}finally{reader.end('rollback;');ok(await reader.done);}
  rejected(await run(invoke().replace(q(owner),q('92000000-0000-4000-8000-000000000002'))),'55000');record('wrong_owner_fails_closed');
  const beginSql=`select public.origin_sync_xml_begin(${q(owner)},${q(fence)},'nfe','1',${q(candidate.key)},${q(candidate.fingerprint)});`;
  const attempt=json(await run(beginSql));assert.equal(json(await run(invoke())).items[0].terminal_confirmed,false);record('inflight_attempt_never_acknowledged');
  const bytes=new TextEncoder().encode(invoice()),meta={hash:sha(bytes),size:bytes.length,...inspectArchivedXml(bytes,{key:candidate.key,entity:'nfe'})};
  ok(await run(`insert into storage.objects(bucket_id,name,metadata)values('origin-fiscal-xml',${q('objects/'+meta.hash+'.xml')},${q({size:meta.size,mimetype:'application/xml'})});select public.origin_sync_xml_finish(${q(owner)},${q(fence)},${q(attempt.attempt_id)},${q([meta])}::jsonb);`));
  const stored=json(await run(invoke())).items[0];assert.equal(stored.terminal_confirmed,true);assert.equal(stored.stored_files,1);assert.equal(stored.attempt_id,attempt.attempt_id);record('stored_attempt_linked_through_storage');
  ok(await run("update storage.objects set metadata=jsonb_set(metadata,'{size}','1');"));assert.equal(json(await run(invoke())).items[0].terminal_confirmed,false);record('corrupt_storage_metadata_cannot_confirm');
  ok(await run("update origin_sync.raw_record set payload=jsonb_set(payload,'{situacao}','2');"));const changed=json(await run(invoke())).items[0];assert.equal(changed.source_matches,false);assert.equal(changed.eligible,false);assert.equal(changed.terminal_confirmed,false);record('changed_fingerprint_never_authorizes_GET');
  const storageDefinition=ok(await run("select pg_get_functiondef('origin_fiscal.storage_ready()'::regprocedure);")).out;
  ok(await run("create or replace function origin_fiscal.storage_ready()returns void language plpgsql security definer set search_path=pg_catalog as $$begin perform pg_sleep(0.15);end;$$;update origin_sync.resource_state set lease_expires_at=clock_timestamp()+interval'0.2 seconds'where resource='__scheduler__';"));
  rejected(await run(invoke()),'55000');ok(await run(storageDefinition));record('lease_expiry_during_inspection_rechecked_at_return');
  assert.equal(ok(await run(functionCatalog)).out,before);
  console.log(JSON.stringify({profile:'origin-xml-priority092-postgres17-test-v1',source_sha256:sha(source),baseline:'001-091',old_function_rows:JSON.parse(before.trim()).length,
    function_contract:contract,private_unix_socket:true,tcp:false,remote_executed:false,passed:results.length,scenarios:results},null,2));
}finally{
  for(const child of children)child.kill('SIGKILL');await ownedRoot();
  if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
  await ownedRoot();await rm(root,{recursive:true,force:true});
}
