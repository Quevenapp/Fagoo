// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareFiscalNfceEmissionWindowApply,prepareFiscalNfceEmissionWindowReadback,SOURCE_SHA256} from './prepare_nfce_emission_window_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-emission-apply080-'),socket=join(root,'s'),port='56580';
await chmod(root,0o700);await mkdir(socket,{mode:0o700});let started=false;const children=new Set(),results=[];
function session(){
 const p=spawn(join(bin,'psql'),['-XAtq','-h',socket,'-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{env,stdio:['pipe','pipe','pipe']});
 children.add(p);let out='',err='',ended=false;
 const timer=setTimeout(()=>p.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{
  p.on('error',reject);p.stdin.on('error',()=>{});
  p.stdout.on('data',b=>{out+=b;if(out.length>2097152)p.kill('SIGKILL');});
  p.stderr.on('data',b=>{err+=b;if(err.length>65536)p.kill('SIGKILL');});
  p.on('close',code=>{ended=true;children.delete(p);clearTimeout(timer);resolve({code,out,err});});
 });done.catch(()=>{});
 return{done,write:s=>p.stdin.write(s+'\n'),end:s=>p.stdin.end(s+'\n'),async marker(value){
  const end=Date.now()+10000;
  while(!out.includes(value)){assert.equal(ended,false,err);assert.ok(Date.now()<end,'Marker timeout');await new Promise(r=>setTimeout(r,20));}
 }};
}
async function run(sql){const s=session();s.end(sql);return s.done;}
const ok=r=>{assert.equal(r.code,0,r.err);return r;};
const value=r=>JSON.parse(ok(r).out.trim().split('\n').findLast(x=>x.startsWith('{')));
try{
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'pipe',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -p ${port}`,'-w','start'],{env,stdio:'pipe',timeout:20000});started=true;
 assert.equal(ok(await run('show listen_addresses;')).out.trim(),'');
 ok(await run('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;'));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=79).sort();assert.equal(files.length,79);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table origin_sync.fixture080(id integer primary key,payload jsonb);insert into origin_sync.fixture080 values(1,'{\"synthetic\":true}');alter table origin_sync.fixture080 enable row level security;"));


 const helper='erp_fiscal_reviewed_authorization.check_nfce_emission_window(text,timestamptz)',guard='erp_fiscal_reviewed_authorization.guard_nfce_emission_window()';
 const sql=await prepareFiscalNfceEmissionWindowApply(),readback=await prepareFiscalNfceEmissionWindowReadback();
 const absent=async()=>{assert.equal(ok(await run(`select to_regprocedure('${helper}')is null and to_regprocedure('${guard}')is null and not exists(select 1 from pg_trigger where tgrelid='erp_fiscal_authorization.attempt'::regclass and tgname in('reviewed_use_time_guard','reviewed_use_time_commit'));`)).out.trim(),'t');assert.equal(ok(await run("select payload=jsonb_build_object('synthetic',true) from origin_sync.fixture080;")).out.trim(),'t');};
 for(const table of['origin_sync.resource_state','erp_fiscal_authorization.attempt']){
  const holder=session();holder.write(`begin;lock table ${table} in row exclusive mode;\n\\echo WRITER_HELD`);
  try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);await absent();results.push({scenario:table==='erp_fiscal_authorization.attempt'?'attempt_writer_refused_nowait_before_trigger_lock_upgrade':'cron_writer_refused_nowait_without_partial_helpers',passed:true});}
  finally{holder.end('rollback;');ok(await holder.done);}
 }
 const inject=v=>sql.replace('-- reviewed objects created',()=> '-- reviewed objects created\n'+v);
 for(const[name,input,expected]of[
  ['old_row_mutation_rolls_back_helpers_and_triggers',inject("update origin_sync.fixture080 set payload='{}';"),'existing_data_changed'],
  ['helper_delegation_is_refused',inject(`grant execute on function ${guard} to service_role with grant option;`),'function_contract_failed'],
  ['deferred_trigger_cannot_be_immediate',inject("drop trigger reviewed_use_time_commit on erp_fiscal_authorization.attempt;create constraint trigger reviewed_use_time_commit after update on erp_fiscal_authorization.attempt deferrable initially immediate for each row when(old.used_at is null and new.used_at is not null)execute function erp_fiscal_reviewed_authorization.guard_nfce_emission_window();"),'trigger_contract_failed'],
  ['prior_review_guard_must_remain_enabled',inject('alter table erp_fiscal_authorization.attempt disable trigger reviewed_use_guard;'),'table_security_changed']
 ]){assert.notEqual(input,sql);const rejected=await run(input);assert.equal(rejected.code,3);assert.ok(rejected.err.includes(expected),rejected.err);await absent();results.push({scenario:name,passed:true});}
 const futurePolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true,'binding_reviewed',true,'valid_from',clock_timestamp()+interval'1 hour','valid_until',clock_timestamp()+interval'2 hours'))).*from erp_fiscal_authorization.policy p where model='55'and version=(select max(version)from erp_fiscal_authorization.policy where model='55');";
 const future=await run('begin;'+futurePolicy+sql);assert.equal(future.code,3);assert.match(future.err,/fiscal_gate_not_closed/);await absent();results.push({scenario:'even_future_enabled_head_refused_before_ddl',passed:true});
 ok(await run(futurePolicy+"insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',101,'enabled',false))).*from erp_fiscal_authorization.policy p where model='55'and version=100;"));
 const reader=session();reader.write('begin;lock table erp_fiscal_authorization.attempt in access share mode;lock table origin_sync.resource_state in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.equal(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.new_service_only_rpcs,0);assert.equal(audit.new_tables,0);assert.equal(audit.enabled_heads,0);assert.equal(audit.new_triggers,2);assert.equal(audit.new_private_helpers,2);assert.equal(audit.historical_enabled_policies,1);assert.equal(audit.fiscal_attempts,0);assert.equal(audit.consumption_performed,false);assert.equal(audit.protected_table_count,153);results.push({scenario:'ordinary_readers_compatible_and_old_enabled_history_preserved',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','other_functions_sha256','default_privileges_sha256','other_catalog_sha256'])assert.equal(proof[k],audit[k]);results.push({scenario:'committed_readback_preserves_rows_acl_defaults_functions_catalog',passed:true});
 for(const role of['anon','authenticated','service_role'])for(const sig of[helper,guard])assert.equal(ok(await run(`select has_function_privilege('${role}','${sig}','EXECUTE');`)).out.trim(),'f');results.push({scenario:'both_helpers_closed_to_all_client_roles',passed:true});
 ok(await run(`grant execute on function ${guard} to service_role with grant option;`));const changed=await run(readback);assert.equal(changed.code,3);assert.match(changed.err,/function_contract_failed/);ok(await run(`revoke all on function ${guard} from service_role;`));assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'readback_refuses_later_grant_option',passed:true});
 const again=await run(sql);assert.equal(again.code,3);assert.match(again.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused_without_changes',passed:true});
 console.log(JSON.stringify({profile:'nfce-emission-window-080-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_SHA256,protected_tables:audit.protected_table_count,scenarios:results,native_mutation_performed:false,consumption_performed:false,fiscal_attempts:0,enabled_heads:0},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-emission-apply080-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
