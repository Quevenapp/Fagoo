// Disposable PostgreSQL17 cluster, private Unix socket only; never opens a project database.
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
import {prepareFiscalAuthorizationApply} from './prepare_fiscal_authorization_apply.mjs';

const bin=process.env.BRUFAP_TEST_PG17_BIN;
assert.ok(typeof bin==='string'&&isAbsolute(bin),'An explicit local PostgreSQL17 binary directory is required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('PG')));
assert.match(execFileSync(join(bin,'postgres'),['--version'],{env,encoding:'utf8'}),/PostgreSQL\) 17\./);
const root=await mkdtemp('/Volumes/Dev/tmp/brufap-auth-apply064-'),socket=join(root,'s'),port='56464';
await mkdir(socket,{mode:0o700});let started=false;const children=new Set(),results=[];
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
 execFileSync(join(bin,'initdb'),['-D',join(root,'data'),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],{env,stdio:'ignore',timeout:20000});
 execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'server.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -p ${port}`,'-w','start'],{env,stdio:'ignore',timeout:20000});started=true;
 ok(await run('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;'));
 const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&(+n.slice(9,12)<=63||[65,66].includes(+n.slice(9,12)))).sort();
 assert.equal(files.length,65);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 const sql=await prepareFiscalAuthorizationApply();
 // Hold a writer lock on an existing table. The applicator must fail immediately,
 // roll back its temp objects, and leave all proposed064 objects absent.
 const writer=session();writer.write('begin;lock table erp_finance.title in row exclusive mode;\n\\echo WRITER_READY');
 try{
  await writer.marker('WRITER_READY');const at=Date.now(),r=await run(sql),elapsed=Date.now()-at;
  assert.equal(r.code,3);assert.match(r.err,/55P03/);assert.doesNotMatch(r.err,/40P01/);assert.ok(elapsed<5000);
  const state=value(await run("select jsonb_build_object('absent',to_regnamespace('erp_fiscal_authorization')is null,'public_count',(select count(*)from pg_proc where proname like 'erp_fiscal_authorization_%'));"));
  assert.deepEqual(state,{absent:true,public_count:0});results.push({scenario:'writer_refused_without_wait_or_partial_apply',passed:true});
 }finally{writer.end('rollback;');ok(await writer.done);}
 // An ordinary reader remains open while the migration adds FKs to existing parents.
 // The pre-acquired lock mode must not upgrade into an incompatible reader lock.
 const reader=session();reader.write('begin;lock table erp_fiscal_signed.candidate in access share mode;\n\\echo READER_READY');
 let audit;
 try{await reader.marker('READER_READY');audit=value(await run(sql));results.push({scenario:'reader_does_not_block_foreign_key_creation',passed:true});}
 finally{reader.end('rollback;');ok(await reader.done);}
 assert.equal(audit.protected_table_count,136);assert.deepEqual(audit.before,audit.after);assert.equal(audit.seeded_disabled_policies,2);assert.equal(audit.operation_activated,false);
 const state=value(await run("select jsonb_build_object('policies',(select count(*)from erp_fiscal_authorization.policy),'enabled',(select count(*)from erp_fiscal_authorization.policy where enabled),'attempts',(select count(*)from erp_fiscal_authorization.attempt),'finance',(select count(*)from erp_finance.title),'stock',(select count(*)from erp_stock.movement));"));
 assert.deepEqual(state,{policies:2,enabled:0,attempts:0,finance:0,stock:0});results.push({scenario:'committed_disabled_readback_preserves_existing_state',passed:true});
 const duplicate=await run(sql);assert.equal(duplicate.code,3);assert.match(duplicate.err,/55000/);results.push({scenario:'reapply_refused',passed:true});
 console.log(JSON.stringify({profile:'authorization-064-applicator-postgres-v1',postgres:'17-native',private_unix_socket:true,tcp:false,remote_executed:false,source_sha256:audit.source_sha256,protected_tables:audit.protected_table_count,scenarios:results,state},null,2));
}finally{
 for(const p of children)p.kill('SIGKILL');
 // pg_ctl may time out after the daemon started. Do not remove a live cluster.
 if(started||existsSync(join(root,'data','postmaster.pid')))execFileSync(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','immediate','-w','stop'],{env,stdio:'ignore',timeout:15000});
 await rm(root,{recursive:true,force:true});
}
