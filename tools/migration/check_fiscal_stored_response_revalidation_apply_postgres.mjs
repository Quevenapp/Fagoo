// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareFiscalStoredResponseRevalidationApply,prepareFiscalStoredResponseRevalidationReadback,SOURCE_SHA256} from './prepare_fiscal_stored_response_revalidation_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-revalidation-apply079-'),socket=join(root,'s'),port='56579';
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
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=78).sort();assert.equal(files.length,78);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table origin_sync.fixture079(id integer primary key,payload jsonb);insert into origin_sync.fixture079 values(1,'{\"synthetic\":true}');alter table origin_sync.fixture079 enable row level security;"));

 const preflight='public.erp_fiscal_reviewed_authorization_revalidation_finish(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,integer,boolean)',selected='public.erp_fiscal_reviewed_authorization_revalidation_command(uuid,uuid)',context='public.erp_fiscal_reviewed_authorization_revalidation_context(uuid,uuid,uuid)';
 const sql=await prepareFiscalStoredResponseRevalidationApply(),readback=await prepareFiscalStoredResponseRevalidationReadback();
 const absent=async()=>{assert.equal(ok(await run(`select to_regprocedure('${preflight}')is null and to_regprocedure('${selected}')is null and to_regnamespace('erp_fiscal_authorization_revalidation')is null;`)).out.trim(),'t');};
 const holder=session();holder.write('begin;lock table origin_sync.resource_state in row exclusive mode;\n\\echo WRITER_HELD');
 try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);await absent();results.push({scenario:'cron_writer_refused_nowait_without_partial_rpc_creation',passed:true});}
 finally{holder.end('rollback;');ok(await holder.done);}
 const inject=v=>sql.replace('-- reviewed objects created',()=> '-- reviewed objects created\n'+v);
 for(const[name,input,expected]of[
  ['old_row_mutation_rolls_back_all_three_rpcs',inject("update origin_sync.fixture079 set payload='{}';"),'existing_data_changed'],
  ['new_rpc_delegation_is_refused',inject(`grant execute on function ${preflight} to service_role with grant option;`),'function_contract_failed']
 ]){assert.notEqual(input,sql);const rejected=await run(input);assert.equal(rejected.code,3);assert.ok(rejected.err.includes(expected),rejected.err);await absent();results.push({scenario:name,passed:true});}
 const futurePolicy="insert into erp_fiscal_authorization.policy select (jsonb_populate_record(null::erp_fiscal_authorization.policy,to_jsonb(p)||jsonb_build_object('version',100,'enabled',true,'binding_reviewed',true,'valid_from',clock_timestamp()+interval'1 second','valid_until',clock_timestamp()+interval'1 hour'))).*from erp_fiscal_authorization.policy p where model='55'and version=(select max(version)from erp_fiscal_authorization.policy where model='55');";
 const future=await run('begin;'+futurePolicy+inject('perform pg_sleep(1.1);'));assert.equal(future.code,3);assert.match(future.err,/fiscal_gate_not_closed/);await absent();results.push({scenario:'future_enabled_head_becoming_effective_during_apply_rolls_back',passed:true});
 const reader=session();reader.write('begin;lock table erp_fiscal_authorization.attempt in access share mode;lock table origin_sync.resource_state in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.new_service_only_rpcs,3);assert.equal(audit.new_tables,1);assert.equal(audit.effective_enabled_heads,0);assert.equal(audit.new_table_empty,true);assert.equal(audit.new_private_helpers,6);assert.equal(audit.revalidations_created,0);assert.equal(audit.fiscal_attempts,0);results.push({scenario:'ordinary_readers_compatible_with_parent_foreign_keys',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','other_functions_sha256','default_privileges_sha256'])assert.equal(proof[k],audit[k]);results.push({scenario:'committed_readback_preserves_rows_acl_functions',passed:true});
 for(const role of['anon','authenticated','service_role']){for(const sig of[preflight,selected,context])assert.equal(ok(await run(`select has_function_privilege('${role}','${sig}','EXECUTE');`)).out.trim(),role==='service_role'?'t':'f');assert.equal(ok(await run(`select has_table_privilege('${role}','erp_fiscal_authorization_revalidation.command','SELECT');`)).out.trim(),'f');}results.push({scenario:'only_service_role_has_rpc_access',passed:true});
 const again=await run(sql);assert.equal(again.code,3);assert.match(again.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused_without_changes',passed:true});
 console.log(JSON.stringify({profile:'fiscal-stored_response-revalidation-079-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_SHA256,protected_tables:audit.protected_table_count,scenarios:results,native_mutation_performed:false,fiscal_attempts:0,effective_enabled_heads:0},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-revalidation-apply079-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
