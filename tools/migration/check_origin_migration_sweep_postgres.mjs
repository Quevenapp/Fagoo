// PostgreSQL17-only concurrency checks in an owned disposable Unix-socket cluster.
// Loads synthetic 001–090; never opens a project database or a TCP listener.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,lstat,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const q=v=>v===null?'null':typeof v==='number'||typeof v==='boolean'?String(v):"'"+(typeof v==='object'?JSON.stringify(v):String(v)).replaceAll("'","''")+"'";
const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'Explicit local PostgreSQL17 binary directory required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const tempBase=await realpath(process.env.BRUFAP_TEST_TMPDIR??tmpdir()),tempStat=await lstat(tempBase);
assert.match(tempBase,/^\/[A-Za-z0-9_./-]*$/);assert.ok(tempStat.isDirectory());
assert.ok(!(tempStat.mode&0o022)||(tempStat.mode&0o1000),'Shared temporary parent must have sticky bit');
const root=await mkdtemp(join(tempBase,'brufap-migration091-')),identity=await lstat(root),socket=join(root,'s'),port='56591';
assert.ok(Buffer.byteLength(join(socket,`.s.PGSQL.${port}`))<104);await mkdir(socket,{mode:0o700});
let started=false;const children=new Set(),results=[];
async function assertOwned(){const st=await lstat(root);assert.equal(dirname(root),tempBase);assert.match(basename(root),/^brufap-migration091-[A-Za-z0-9]+$/);assert.ok(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.dev,identity.dev);assert.equal(st.ino,identity.ino);assert.equal(await realpath(root),root);}
function session(){
 const child=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
 children.add(child);let out='',err='',ended=false;const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.stdin.on('error',()=>{});child.stdout.on('data',b=>{out+=b;if(out.length>8388608)child.kill('SIGKILL');});child.stderr.on('data',b=>{err+=b;if(err.length>262144)child.kill('SIGKILL');});child.on('close',code=>{ended=true;children.delete(child);clearTimeout(timer);resolve({code,out,err});});});done.catch(()=>{});
 return{done,write:s=>child.stdin.write(s+'\n'),end:s=>{if(!child.stdin.writableEnded)child.stdin.end(s+'\n');},async marker(mark){const until=Date.now()+10000;while(!out.includes(mark)){assert.equal(ended,false,err);assert.ok(Date.now()<until,'Marker timeout');await new Promise(r=>setTimeout(r,15));}}};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const value=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')||x.startsWith('[')));
const rejected=(r,code)=>{assert.equal(r.code,3,r.err);assert.match(r.err,new RegExp(`ERROR:\\s+${code}:`));assert.doesNotMatch(r.err,/40P01/);};
const record=(scenario,detail={})=>{results.push({scenario,passed:true,...detail});process.stderr.write('PASS '+scenario+'\n');};
const owner=randomUUID(),schedulerToken=randomUUID(),resourceToken=randomUUID();
const sourceUrl=new URL('../../supabase/migrations/202610170091_origin_migration_sweep.sql',import.meta.url),source=await readFile(sourceUrl,'utf8'),sourceHash=sha(source);
const raw=(id,payload={id,situacao:'A'},date=null)=>`insert into origin_sync.raw_record(entity,last_resource,source_id,payload,document_links,version_hash,source_updated_at)values('contacts','contacts',${q(id)},${q(payload)}::jsonb,'[]',encode(sha256(convert_to(jsonb_build_object('payload',${q(payload)}::jsonb,'document_links','[]'::jsonb)::text,'UTF8')),'hex'),${q(date)});`;
const metadata=async ids=>value(await run(`set role service_role;select public.origin_sync_migration_sources('contacts','${owner}','${schedulerToken}','${resourceToken}',${q(ids)}::jsonb);`));
const request=async(ids,payloads=ids.map(id=>({source_id:id,payload:{id,situacao:'A'},document_links:[]})))=>({p_resource:'contacts',p_entity:'contacts',p_owner:owner,p_scheduler_token:schedulerToken,p_resource_token:resourceToken,p_batch_id:randomUUID(),p_records:payloads,p_checkpoint:{migration_synthetic:true},p_expected_checkpoint_version:Number(ok(await run("select checkpoint_version from origin_sync.resource_state where resource='contacts';")).out.trim()),p_expected_sources:await metadata(ids)});
const applySql=args=>`set local role service_role;select public.origin_sync_migration_apply(${Object.entries(args).map(([k,v])=>`${k}=>${q(v)}`).join(',')});`;
const apply=async args=>run('begin;set local statement_timeout=\'8s\';'+applySql(args)+'commit;');
const functionsSql="select coalesce(jsonb_object_agg(p.oid::text,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),'{}')from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname~'^(erp|origin)_'or n.nspname='public')and p.proname not in('migration_entity','migration_require_leases','migration_source_metadata','origin_sync_migration_sources','origin_sync_migration_apply');";
async function protectedData(){return value(await run(`do $$declare r record;v jsonb;out jsonb:='{}';begin
 for r in select n.nspname ns,c.relname name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'and(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage'))and not(n.nspname='origin_sync'and c.relname in('raw_record','resource_state','batch_inbox'))order by 1,2 loop
 execute format('select jsonb_build_object(''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E''\\n''order by to_jsonb(x)::text),''''),''UTF8'')),''hex''))from %I.%I x',r.ns,r.name)into v;out:=out||jsonb_build_object(r.ns||'.'||r.name,v);end loop;
 perform set_config('brufap.migration091_test',out::text,false);end$$;select current_setting('brufap.migration091_test')::jsonb;`));}
async function heldFailure(name,hold,args,code='55P03'){
 const holder=session();holder.write('begin;'+hold+'\n\\echo HELD');
 try{await holder.marker('HELD');const at=Date.now();rejected(await apply(args),code);const elapsed=Date.now()-at;assert.ok(elapsed<3000,'Expected immediate NOWAIT failure');record(name,{elapsed_ms:elapsed});}
 finally{holder.end('rollback;');ok(await holder.done);}
}
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');ok(await run(bootstrap));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=90).sort();assert.equal(files.length,90);
 for(const f of files)ok(await run(await readFile(new URL(f,dir),'utf8')));
 const baselineFunctions=value(await run(functionsSql));const before=await protectedData();
 ok(await run(source));assert.deepEqual(value(await run(functionsSql)),baselineFunctions);assert.deepEqual(await protectedData(),before);record('091_adds_only_five_functions_preserves_001_090_data_and_routines');
 ok(await run(`insert into origin_sync.resource_state(resource,lease_owner,lease_token,lease_expires_at)values('__scheduler__','${owner}','${schedulerToken}',clock_timestamp()+interval '10 minutes'),('contacts','${owner}','${resourceToken}',clock_timestamp()+interval '10 minutes')on conflict(resource)do update set lease_owner=excluded.lease_owner,lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at;${raw('9101',undefined,'2020-01-01T00:00:00Z')}`));
 const a=await request(['9101']);
 await heldFailure('row_for_share_is_nowait',"select source_id from origin_sync.raw_record where entity='contacts'and source_id='9101'for share;",a);
 await heldFailure('row_for_update_is_nowait',"select source_id from origin_sync.raw_record where entity='contacts'and source_id='9101'for update;",a);
 await heldFailure('raw_writer_table_lock_is_nowait','lock table origin_sync.raw_record in row exclusive mode;',a);
 await heldFailure('empty_batch_advisory_is_nowait',"select pg_advisory_xact_lock(174852901,hashtext('contacts'));",await request([]));
 const absent=await request(['9102']),holder=session();holder.write('begin;'+raw('9102')+'\n\\echo INSERT_HELD');
 try{await holder.marker('INSERT_HELD');const at=Date.now();rejected(await apply(absent),'55P03');assert.ok(Date.now()-at<3000);holder.end('commit;');ok(await holder.done);rejected(await apply(absent),'40001');assert.equal(ok(await run(`select count(*)from origin_sync.batch_inbox where batch_id='${absent.p_batch_id}';`)).out.trim(),'0');record('absent_source_concurrent_insert_nowait_then_CAS_rejected');}
 finally{holder.end('rollback;');await holder.done;}
 const skipped=await request(['9102','9103'],[{source_id:'9103',payload:{id:'9103',situacao:'A'},document_links:[]}]);
 ok(await run("update origin_sync.raw_record set last_seen_at=clock_timestamp()where entity='contacts'and source_id='9102';"));
 rejected(await apply(skipped),'40001');assert.equal(ok(await run("select count(*)from origin_sync.raw_record where entity='contacts'and source_id='9103';")).out.trim(),'0');
 record('superset_skipped_source_changed_blocks_insertion_and_checkpoint');
 const skippedFresh=await request(['9102','9103'],[{source_id:'9103',payload:{id:'9103',situacao:'A'},document_links:[]}]);
 skippedFresh.p_checkpoint.migration={plan_sha256:'a'.repeat(64),page_ids:['9102','9103'],offset:2,failures:[]};
 const skippedResult=value(await apply(skippedFresh));assert.deepEqual(skippedResult.migration_receipt.source_ids,['9103']);assert.deepEqual(skippedResult.migration_receipt.guarded_source_ids,['9102','9103']);assert.deepEqual(skippedResult.migration_receipt.migration_checkpoint,skippedFresh.p_checkpoint.migration);
 record('superset_existing_skip_and_missing_insert_are_guarded_with_exact_checkpoint_receipt');
 const valid=await request(['9101'],[{source_id:'9101',payload:{id:'9101',situacao:'A',synthetic_change:1},document_links:[]}]);
 const committed=value(await apply(valid));assert.equal(committed.updated,1);assert.equal(committed.migration_receipt.records,1);assert.match(committed.migration_receipt.request_sha256,/^[a-f0-9]{64}$/);
 assert.equal(ok(await run("select source_updated_at='2020-01-01T00:00:00Z'::timestamptz from origin_sync.raw_record where entity='contacts'and source_id='9101';")).out.trim(),'t');record('successful_existing_source_preserves_source_updated_at');
 ok(await run("update origin_sync.raw_record set last_seen_at=clock_timestamp(),version=version+1,version_hash=repeat('f',64)where entity='contacts'and source_id='9101';update origin_sync.resource_state set lease_expires_at=clock_timestamp()-interval '1 second'where resource in('contacts','__scheduler__');"));
 const replay=value(await apply(valid));assert.equal(replay.replayed,true);assert.deepEqual(replay.migration_receipt,committed.migration_receipt);assert.equal(ok(await run("select version_hash=repeat('f',64)from origin_sync.raw_record where entity='contacts'and source_id='9101';")).out.trim(),'t');record('expired_lease_replay_after_source_change_returns_original_receipt_without_write');
 rejected(await apply({...valid,p_records:[{...valid.p_records[0],payload:{id:'9101',situacao:'I'}}]}),'22023');record('same_UUID_different_body_rejected_after_expiry');
 for(const role of['anon','authenticated'])rejected(await run(`set role ${role};select public.origin_sync_migration_sources(null,null,null,null,'[]');`),'42501');
 const acl=value(await run("select jsonb_build_object('new_functions',count(*),'bad_acl',coalesce(sum((select count(*)from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee<>p.proowner and(a.is_grantable or a.grantee<>to_regrole('service_role')or n.nspname<>'public'))),0),'bad_search_path',count(*)filter(where p.proconfig is distinct from array['search_path=pg_catalog']))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='origin_sync'and p.proname in('migration_entity','migration_require_leases','migration_source_metadata'))or(n.nspname='public'and p.proname in('origin_sync_migration_sources','origin_sync_migration_apply'));"));
 assert.deepEqual(acl,{new_functions:5,bad_acl:0,bad_search_path:0});record('three_private_helpers_two_service_only_rpcs_search_path_pinned');
 assert.deepEqual(await protectedData(),before);assert.deepEqual(value(await run(functionsSql)),baselineFunctions);assert.equal(sha(await readFile(sourceUrl,'utf8')),sourceHash);record('all_164_non_ingestion_tables_and_prior_functions_preserved');
 console.log(JSON.stringify({profile:'origin-migration-091-postgres-v1',source_sha256:sourceHash,postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,real_data:false,baseline:'001-090',protected_non_ingestion_tables:Object.keys(before).length,passed:results.length,scenarios:results},null,2));
}finally{
 for(const child of children)child.kill('SIGKILL');await assertOwned();
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 await assertOwned();await rm(root,{recursive:true,force:true});
}
