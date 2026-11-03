// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareReviewedAuthorizationApply,prepareReviewedAuthorizationReadback,SOURCE_SHA256} from './prepare_reviewed_authorization_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-reviewed-apply069-'),socket=join(root,'s'),port='56569';
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
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=68).sort();assert.equal(files.length,68);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table erp_fiscal_authorization.fixture_history(id integer primary key,payload jsonb);insert into erp_fiscal_authorization.fixture_history values(1,'{\"synthetic\":true,\"price\":1.1234567890}');alter table erp_fiscal_authorization.fixture_history enable row level security;insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_reviewed,tax_rules_reviewed,valid_from,valid_until)values('55',7,'operational',false,false,false,'2026-10-16T00:00:00Z','2026-10-26T00:00:00Z');"));
 const sql=await prepareReviewedAuthorizationApply(),readback=await prepareReviewedAuthorizationReadback();
 async function absent(){assert.deepEqual(value(await run("select jsonb_build_object('absent',to_regnamespace('erp_fiscal_reviewed_authorization')is null,'column_absent',not exists(select 1 from pg_attribute where attrelid='erp_fiscal_authorization.policy'::regclass and attname='authorization_profile'and not attisdropped),'policies',(select count(*)from erp_fiscal_authorization.policy));")),{absent:true,column_absent:true,policies:3});}
 ok(await run("ALTER TABLE erp_fiscal_authorization.policy DISABLE TRIGGER immutable;UPDATE erp_fiscal_authorization.policy SET enabled=true,binding_profile='synthetic-fixture-binding',rule_profile='synthetic-fixture-rule',source_manifest_hash=repeat('a',64),binding_reviewed=true,tax_rules_reviewed=true WHERE model='65' AND version=1;ALTER TABLE erp_fiscal_authorization.policy ENABLE TRIGGER immutable;"));
 const active=await run(sql);assert.equal(active.code,3);assert.match(active.err,/active_policy_preflight_refused/);await absent();
 assert.equal(ok(await run("select count(*)from erp_fiscal_authorization.policy where enabled;")).out.trim(),'1');
 ok(await run("ALTER TABLE erp_fiscal_authorization.policy DISABLE TRIGGER immutable;UPDATE erp_fiscal_authorization.policy SET enabled=false,binding_profile=null,rule_profile=null,source_manifest_hash=null,binding_reviewed=false,tax_rules_reviewed=false WHERE model='65' AND version=1;ALTER TABLE erp_fiscal_authorization.policy ENABLE TRIGGER immutable;"));results.push({scenario:'active_old_policy_refused_before_source',passed:true});
 for(const [scenario,lock]of[
  ['policy_reader_refused_upfront_nowait','lock table erp_fiscal_authorization.policy in access share mode;'],
  ['earlier_table_writer_refused_upfront_nowait','lock table erp_finance.title in row exclusive mode;']
 ]){
  const held=session();held.write(`begin;${lock}\n\\echo HELD`);
  try{await held.marker('HELD');const at=Date.now(),r=await run(sql),elapsed=Date.now()-at;assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(elapsed<5000);await absent();results.push({scenario,passed:true,nowait:true,elapsed_ms:elapsed});}
  finally{held.end('rollback;');ok(await held.done);}
 }
 // An unrelated ordinary reader is compatible with all FK lock modes acquired upfront.
 const reader=session();reader.write('begin;lock table erp_fiscal_authorization.attempt in access share mode;\n\\echo READER_READY');let audit;
 try{await reader.marker('READER_READY');audit=value(await run(sql));results.push({scenario:'success_with_existing_parent_reader',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 assert.equal(audit.source_sha256,SOURCE_SHA256);assert.deepEqual(audit.before,audit.after);assert.equal(audit.new_policy_seeds,2);assert.equal(audit.new_policy_seeds_disabled,true);assert.equal(audit.operation_activated,false);assert.equal(audit.policy_before_full.count,3);assert.equal(audit.policy_after_full.count,5);assert.notDeepEqual(audit.policy_before_full,audit.policy_after_full);
 const read=ok(await run(readback+"\nselect jsonb_build_object('local_cleared',nullif(current_setting('brufap.reviewed_069_readback_rows',true),'')is null);"));
 const readValues=read.out.trim().split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x)),proof=readValues[0];assert.deepEqual(readValues[1],{local_cleared:true});
 assert.deepEqual(proof.legacy_rows,audit.after);assert.equal(proof.other_functions_sha256,audit.other_functions_sha256);
 for(const k of ['function_contracts_valid','new_policies_disabled','private_schema','private_tables','new_tables_rls'])assert.equal(proof[k],true,k);
 assert.equal(proof.reviewed_functions,17);assert.equal(proof.new_policy_count,2);assert.equal(proof.binding_count,0);assert.equal(proof.observation_count,0);results.push({scenario:'readback_matches_preserved_old_fields_and_functions',passed:true});
 const duplicate=await run(sql);assert.equal(duplicate.code,3);assert.match(duplicate.err,/55000/);assert.match(duplicate.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused_without_change',passed:true});
 const state=value(await run("select jsonb_build_object('policies',(select count(*)from erp_fiscal_authorization.policy),'enabled',(select count(*)from erp_fiscal_authorization.policy where enabled),'attempts',(select count(*)from erp_fiscal_authorization.attempt),'finance',(select count(*)from erp_finance.title),'stock',(select count(*)from erp_stock.movement));"));assert.deepEqual(state,{policies:5,enabled:0,attempts:0,finance:0,stock:0});
 console.log(JSON.stringify({profile:'reviewed-authorization-069-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_SHA256,protected_tables:audit.protected_table_count,scenarios:results,state},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-reviewed-apply069-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
