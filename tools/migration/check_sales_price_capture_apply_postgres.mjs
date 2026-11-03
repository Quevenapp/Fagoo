// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareSalesPriceCaptureApply,prepareSalesPriceCaptureReadback,SOURCE_SHA256} from './prepare_sales_price_capture_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-sales-apply078-'),socket=join(root,'s'),port='56578';
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
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=77).sort();assert.equal(files.length,77);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table origin_sync.fixture078(id integer primary key,payload jsonb);insert into origin_sync.fixture078 values(1,'{\"synthetic\":true}');alter table origin_sync.fixture078 enable row level security;"));
 const sig='text,text,uuid,uuid,uuid,jsonb,jsonb,bigint';
 const oldOid=ok(await run(`select 'public.origin_sync_apply_batch(${sig})'::regprocedure::oid;`)).out.trim();
 // A committed005/059 receipt exists before rename; replay must retain its bytes and checkpoint.
 ok(await run(`create table origin_sync.synthetic078_state(body jsonb,ack jsonb);do $$declare l jsonb;b jsonb;a jsonb;o uuid:='00000000-0000-4000-8000-000000000078';begin
 l:=public.origin_sync_claim('sales_orders',o,900);
 b:=jsonb_build_object('p_resource','sales_orders','p_entity','sales_orders','p_owner',o,'p_lease_token',l->>'lease_token','p_batch_id','00000000-0000-4000-8000-000000000079','p_records',jsonb_build_array(jsonb_build_object('source_id','1','payload',jsonb_build_object('id','1','itens',jsonb_build_array(jsonb_build_object('valor',1.2))),'document_links',jsonb_build_array(jsonb_build_object('kind','synthetic-backup')))),'p_checkpoint',jsonb_build_object('page',2),'p_expected_checkpoint_version',l->'checkpoint_version');
 a:=public.origin_sync_apply_batch(b->>'p_resource',b->>'p_entity',(b->>'p_owner')::uuid,(b->>'p_lease_token')::uuid,(b->>'p_batch_id')::uuid,b->'p_records',b->'p_checkpoint',(b->>'p_expected_checkpoint_version')::bigint);
 insert into origin_sync.synthetic078_state values(b,a);end;$$;`));
 const prepared=session();prepared.write(`prepare synthetic078_apply(${sig})as select public.origin_sync_apply_batch(${Array.from({length:8},(_,i)=>'$'+(i+1)).join(',')});\n\\echo PREPARED_READY`);await prepared.marker('PREPARED_READY');
 const sql=await prepareSalesPriceCaptureApply(),readback=await prepareSalesPriceCaptureReadback();
 // Probe a writer on the exact table locked by the sync RPC; no waiting upgrade or scheduler reset.
 const holder=session();holder.write('begin;lock table origin_sync.resource_state in row exclusive mode;\n\\echo WRITER_HELD');
 try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);assert.equal(ok(await run("select to_regprocedure('origin_sync.validate_sales_price_capture(jsonb,jsonb)')is null;")).out.trim(),'t');assert.equal(ok(await run(`select 'public.origin_sync_apply_batch(${sig})'::regprocedure::oid;`)).out.trim(),oldOid);results.push({scenario:'cron_writer_refused_nowait_without_partial_rename',passed:true});}
 finally{holder.end('rollback;');ok(await holder.done);}
 const corrupted=sql.replace(' EXECUTE source_body;'," EXECUTE source_body;update origin_sync.fixture078 set payload='{}';");assert.notEqual(corrupted,sql);const rejected=await run(corrupted);assert.equal(rejected.code,3);assert.match(rejected.err,/existing_data_changed/);assert.equal(ok(await run(`select 'public.origin_sync_apply_batch(${sig})'::regprocedure::oid;`)).out.trim(),oldOid);results.push({scenario:'post_ddl_audit_failure_rolls_back_rename_and_rows',passed:true});
 const weakened=sql.replace(' EXECUTE source_body;',` EXECUTE source_body;grant execute on function public.origin_sync_apply_sales_price_batch(${sig})to service_role with grant option;`);assert.notEqual(weakened,sql);const grantRejected=await run(weakened);assert.equal(grantRejected.code,3);assert.match(grantRejected.err,/function_contract_failed/);assert.equal(ok(await run(`select 'public.origin_sync_apply_batch(${sig})'::regprocedure::oid;`)).out.trim(),oldOid);results.push({scenario:'grant_option_failure_rolls_back_new_rpcs_and_rename',passed:true});
 const reader=session();reader.write('begin;lock table origin_sync.raw_record in access share mode;lock table origin_sync.resource_state in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.equal(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.new_function_count,3);assert.equal(audit.new_service_only_rpcs,1);assert.equal(audit.new_tables,0);assert.equal(audit.capture_written,false);assert.equal(ok(await run(`select 'origin_sync.apply_batch_legacy_078(${sig})'::regprocedure::oid;`)).out.trim(),oldOid);results.push({scenario:'ordinary_readers_compatible_original_oid_preserved',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.rows,audit.after);for(const k of['table_security_sha256','schema_security_sha256','other_functions_sha256','default_privileges_sha256','public_rpc_contract_sha256'])assert.equal(proof[k],audit[k]);results.push({scenario:'commit_readback_preserves_all_rows_acl_functions',passed:true});
 // Read the synthetic body as fixture owner, then execute only the public replay as service_role.
 const fixture=value(await run('select jsonb_build_object(\'body\',body,\'ack\',ack)from origin_sync.synthetic078_state;'));
 const b=fixture.body,quote=x=>"'"+String(x).replaceAll("'","''")+"'",replay=value(await run(`set role service_role;select public.origin_sync_apply_batch(${[b.p_resource,b.p_entity,b.p_owner,b.p_lease_token,b.p_batch_id,JSON.stringify(b.p_records),JSON.stringify(b.p_checkpoint),b.p_expected_checkpoint_version].map(quote).join(',')});`));assert.deepEqual(replay,{...fixture.ack,replayed:true});assert.deepEqual(value(await run(readback)).rows,proof.rows);results.push({scenario:'service_only_legacy_replay_after_rename_preserves_receipt_checkpoint',passed:true});
 const denied=await run(`set role service_role;select origin_sync.apply_batch_legacy_078('sales_orders','sales_orders',null,null,null,'[]','{}',0);`);assert.equal(denied.code,3);assert.match(denied.err,/42501/);results.push({scenario:'private_original_implementation_remains_inaccessible',passed:true});
 // A prepared general RPC resolves the new public wrapper after its original OID is renamed.
 const precise='[{"source_id":"2","payload":{"id":"2","itens":[{"valor":99999999.1234567891}]},"price_capture":{"profile":"origin-sales-price-json-v1","response_sha256":"'+'a'.repeat(64)+'","source":"detail","tokens":[{"path":"/itens/0/valor","lexeme":"99999999.1234567891"}]}}]';
 const version=ok(await run("select checkpoint_version from origin_sync.resource_state where resource='sales_orders';")).out.trim();
 const preparedArgs=[b.p_resource,b.p_entity,b.p_owner,b.p_lease_token,'00000000-0000-4000-8000-000000000080',precise,'{}',version].map(quote).join(',');
 prepared.end(`set role service_role;execute synthetic078_apply(${preparedArgs});`);const preparedAck=value(await prepared.done);assert.equal(preparedAck.sales_price_captures,1);assert.equal(preparedAck.inserted,1);
 assert.equal(ok(await run("select payload#>>'{itens,0,valor}'from origin_sync.raw_record where entity='sales_orders'and source_id='2';")).out.trim(),'99999999.1234567891');results.push({scenario:'prepared_before_rename_rebinds_to078_and_stores_precise_fixture_only',passed:true});
 const replayPrecise=value(await run(`set role service_role;select public.origin_sync_apply_sales_price_batch(${preparedArgs});`));assert.deepEqual(replayPrecise,{...preparedAck,replayed:true});results.push({scenario:'new_precise_fixture_replay_uses_same_ledger',passed:true});
 const finalProof=value(await run(readback));
 const again=await run(sql);assert.equal(again.code,3);assert.match(again.err,/already_present/);assert.deepEqual(value(await run(readback)),finalProof);results.push({scenario:'reapply_refused',passed:true});
 console.log(JSON.stringify({profile:'sales-price-capture-078-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_SHA256,protected_tables:audit.protected_table_count,scenarios:results,native_mutation_performed:false,applicator_capture_written:false,fixture_capture_count:1,checkpoint_reset:false},null,2));

}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-sales-apply078-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
