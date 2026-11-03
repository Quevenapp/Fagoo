// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareStockReservationsApply,prepareStockReservationsReadback,SOURCE_SHA256} from './prepare_stock_reservations_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-reservations-apply070-'),socket=join(root,'s'),port='56571';
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
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=69).sort();assert.equal(files.length,69);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run("create table erp_stock.fixture070(id integer primary key,payload jsonb);insert into erp_stock.fixture070 values(1,'{\"synthetic\":true}');alter table erp_stock.fixture070 enable row level security;"));
 const sql=await prepareStockReservationsApply(),readback=await prepareStockReservationsReadback();
 const holder=session();holder.write('begin;lock table erp_stock.balance in row exclusive mode;\n\\echo WRITER_HELD');
 try{await holder.marker('WRITER_HELD');const at=Date.now(),r=await run(sql);assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(Date.now()-at<5000);assert.equal(ok(await run("select to_regclass('erp_stock.reservation')is null;")).out.trim(),'t');results.push({scenario:'active_writer_refused_nowait_without_partial_ddl',passed:true});}
 finally{holder.end('rollback;');ok(await holder.done);}
 const reader=session();reader.write('begin;lock table erp_stock.balance in access share mode;lock table erp_documents.document in access share mode;\n\\echo READER_HELD');let audit;
 try{await reader.marker('READER_HELD');audit=value(await run(sql));assert.deepEqual(audit.before,audit.after);assert.equal(audit.source_sha256,SOURCE_SHA256);assert.equal(audit.replaced_functions,1);assert.equal(audit.new_service_only_rpcs,5);assert.equal(audit.new_tables,3);assert.equal(audit.reservations_created,0);results.push({scenario:'existing_readers_compatible_with_trigger_and_fk_locks',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 const proof=value(await run(readback));assert.deepEqual(proof.legacy_rows,audit.after);for(const k of['legacy_table_security_sha256','schema_security_sha256','other_functions_sha256','default_privileges_sha256','replaced_function_security_sha256'])assert.equal(proof[k],audit[k]);results.push({scenario:'commit_readback_preserves_all_rows_acl_functions',passed:true});
 const again=await run(sql);assert.equal(again.code,3);assert.match(again.err,/already_present/);assert.deepEqual(value(await run(readback)),proof);results.push({scenario:'reapply_refused',passed:true});
 console.log(JSON.stringify({profile:'stock-reservations-070-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:SOURCE_SHA256,protected_tables:audit.protected_table_count,scenarios:results,reservations_created:0,movements_created:0},null,2));

}finally{
 for(const p of children)p.kill('SIGKILL');
 // If startup timed out after daemon launch, stop only this owned cluster before removal.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 assert.match(root,/^\/Volumes\/Dev\/tmp\/brufap-reservations-apply070-[A-Za-z0-9]+$/);await rm(root,{recursive:true,force:true});
}
