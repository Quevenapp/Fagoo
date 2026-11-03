// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareWarehouseImportApply,prepareWarehouseImportReadback,SOURCE_HASHES} from './prepare_warehouse_import_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-warehouse-import-apply086-'),socket=join(root,'s'),port='56587';
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
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=85).sort();assert.equal(files.length,85);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table origin_sync.fixture086(id integer primary key,payload jsonb);insert into origin_sync.fixture086 values(1,'{\"synthetic\":true}');alter table origin_sync.fixture086 enable row level security;"));

 const actor='85000000-0000-4000-8000-000000000001';
 ok(await run(`insert into auth.users values('${actor}');insert into erp_access.membership(user_id,role)values('${actor}','admin');
 begin;
 insert into erp_sales_history.snapshot(history_id,source_id,command_id,snapshot_hash,observation)
 select 'bsh_'||u,'850'||g::text,u,encode(sha256(convert_to(v::text,'UTF8')),'hex'),v
 from(select g,('85000000-0000-4000-9000-'||lpad(g::text,12,'0'))::uuid u,jsonb_build_object('profile','origin-sales-history-observation-v1','source_id','850'||g::text)v from generate_series(1,200)g)x;
 insert into erp_sales_history.command(command_id,actor,request_hash,history_id,receipt)
 select command_id,'${actor}',repeat('a',64),history_id,'{}'::jsonb from erp_sales_history.snapshot;
 commit;`));
 ok(await run('alter default privileges grant select on tables to authenticated;'));
 const nativeCommand='86000000-0000-4000-8000-000000000002';
 const warehouse=value(await run(`select public.erp_catalog_save('${actor}','warehouses',null,0,'${nativeCommand}','{"name":"Preserved086"}');`)).record;
 ok(await run("insert into origin_sales_price_refresh.origin(source_id,failures,last_error)values('123',3,'HTTP_404');update origin_sales_price_refresh.scope_state set retry_after=clock_timestamp()+interval'1 hour';"));
 const lookup='public.erp_origin_warehouse_sources(uuid,integer,text,text)',list='public.erp_origin_warehouse_command(uuid,uuid)',helper='erp_warehouse_import.immutable()';
 const sql=await prepareWarehouseImportApply(),readback=await prepareWarehouseImportReadback();
 const absent=async()=>{assert.equal(ok(await run(`select to_regprocedure('${lookup}')is null AND to_regnamespace('erp_warehouse_import')is null;`)).out.trim(),'t');};
 const holder=session();holder.write('begin;lock table origin_sync.resource_state in row exclusive mode;\n\\echo WRITER_HELD');
 try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);await absent();results.push({scenario:'cron_writer_refused_nowait_without_partial_rpc_creation',passed:true});}
 finally{holder.end('rollback;');ok(await holder.done);}
 const fkHolder=session();fkHolder.write('begin;lock table erp_catalog.command in share mode;\n\\echo FK_READER_HELD');
 try{await fkHolder.marker('FK_READER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01|57014/);assert.ok(Date.now()-at<5000);await absent();results.push({scenario:'legacy_fk_lock_upgrade_prevented_nowait_before_ddl',passed:true});}
 finally{fkHolder.end('rollback;');ok(await fkHolder.done);}
 const inject=v=>sql.replace('-- reviewed functions created',()=> '-- reviewed functions created\n'+v);
 for(const[name,input,expected]of[
  ['old_row_mutation_rolls_back_rpc',inject("update origin_sync.fixture086 set payload='{}';"),'existing_data_changed'],
  ['global_default_mutation_rolls_back',inject('alter default privileges grant select on tables to anon;'),'default_privileges_changed'],
  ['new_rpc_delegation_is_refused',inject(`grant execute on function ${lookup} to service_role with grant option;`),'function_contract_failed'],
  ['new_binding_row_rolls_back_every_object',inject(`insert into erp_warehouse_import.binding(source_id,warehouse_id,command_id,source_hash,source_version,source_seen_at,observation,source,record)values('900','${warehouse.id}','${nativeCommand}',repeat('a',64),1,clock_timestamp(),'{}','{}','{}');`),'new_table_seed_invalid'],
  ['trigger_disable_rolls_back_every_object',inject('alter table erp_warehouse_import.command disable trigger immutable_command;'),'table_contract_failed'],
  ['historical_snapshot_change_rolls_back',inject("alter table erp_sales_history.snapshot disable trigger immutable_snapshot;update erp_sales_history.snapshot set captured_at=captured_at+interval '1 second';alter table erp_sales_history.snapshot enable trigger immutable_snapshot;"),'existing_data_changed']
 ]){assert.notEqual(input,sql);const rejected=await run(input);assert.equal(rejected.code,3);assert.ok(rejected.err.includes(expected),rejected.err);await absent();results.push({scenario:name,passed:true});}
 const reader=session();reader.write('begin;lock table erp_fiscal_authorization.attempt in access share mode;lock table origin_sync.resource_state in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.deepEqual(audit.source_sha256,SOURCE_HASHES);assert.equal(audit.new_service_only_rpcs,4);assert.equal(audit.new_tables,2);assert.equal(audit.protected_table_count,158);assert.equal(audit.native_mutation_performed,false);assert.equal(audit.worker_flag_changed,false);assert.equal(audit.new_immutable_triggers,2);assert.equal(audit.before['erp_sales_history.snapshot'].count,200);assert.equal(audit.before['erp_sales_history.command'].count,200);assert.equal(audit.new_private_helpers,8);results.push({scenario:'ordinary_readers_compatible_four_rpc_eight_helpers_two_tables',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','other_functions_sha256','other_catalog_sha256','default_privileges_sha256'])assert.equal(proof[k],audit[k]);results.push({scenario:'committed_readback_preserves_rows_acl_functions',passed:true});
 for(const role of['anon','authenticated','service_role'])for(const sig of[lookup,list])assert.equal(ok(await run(`select has_function_privilege('${role}','${sig}','EXECUTE');`)).out.trim(),role==='service_role'?'t':'f');results.push({scenario:'only_service_role_has_rpc_access',passed:true});
 assert.equal(ok(await run(`select has_function_privilege('service_role','${helper}','EXECUTE');`)).out.trim(),'f');
 const serviceStatus=value(await run(`begin read only;set local role service_role;select public.erp_origin_warehouse_sources('${actor}',25,null,null);commit;`));assert.equal(serviceStatus.items.length,0);assert.equal(serviceStatus.stock_effects,false);assert.equal(serviceStatus.financial_effects,false);
 results.push({scenario:'private_tables_and_helper_closed_service_status_readonly',passed:true});
 const again=await run(sql);assert.equal(again.code,3);assert.match(again.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused_without_changes',passed:true});
 console.log(JSON.stringify({profile:'warehouse-import-086-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_HASHES,protected_tables:audit.protected_table_count,scenarios:results,native_mutation_performed:false,new_service_only_rpcs:4,new_private_helpers:8,new_tables:2,preserved_historical_snapshots:200},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-warehouse-import-apply086-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
