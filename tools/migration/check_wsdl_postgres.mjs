// Optional real PostgreSQL concurrency probe. Only synthetic metadata is loaded;
// no certificate bytes, network, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const name='brufap-wsdl051-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),fiscal=randomUUID(),sessions=new Set(),results=[];
let container=null;
const hash=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+quote(value);}).join(',')});`;};
const roleSql=sql=>`set role service_role; ${sql}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function session(){
 assert.match(container,/^[a-f0-9]{64}$/);
 const child=spawn('docker',['exec','-i',container,'psql','-XAtq','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],{stdio:['pipe','pipe','pipe']});
 sessions.add(child);let stdout='',stderr='',ended=false;
 const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
 const done=new Promise((resolve,reject)=>{
  child.once('error',error=>{clearTimeout(timer);sessions.delete(child);ended=true;reject(error);});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',bytes=>{stdout+=bytes;if(stdout.length>2097152)child.kill('SIGKILL');});
  child.stderr.on('data',bytes=>{stderr+=bytes;if(stderr.length>65536)child.kill('SIGKILL');});
  child.once('close',code=>{ended=true;clearTimeout(timer);sessions.delete(child);resolve({code,stdout,stderr});});
 });
 done.catch(()=>{});
 return{done,write:sql=>child.stdin.write(sql+'\n'),end:sql=>child.stdin.end(sql+'\n'),async marker(marker){
  const deadline=Date.now()+10000;
  while(!stdout.includes(marker)){assert.equal(ended,false,stderr);assert.ok(Date.now()<deadline,'Transaction marker timed out');await pause(20);}
 }};
}
const run=async sql=>{const s=session();s.end(sql);return s.done;};
const ok=r=>{assert.equal(r.code,0,r.stderr);return r;};
const value=r=>JSON.parse(ok(r).stdout.trim().split('\n').filter(line=>line.startsWith('{')).at(-1));
const rpc=async(name,args)=>value(await run(roleSql(rpcSql(name,args))));
function rejected(r,code){assert.equal(r.code,3,r.stdout);assert.match(r.stderr,new RegExp('\\b'+code+'\\b'));assert.doesNotMatch(r.stderr,/\b40P01\b/);}
async function waiting(application){
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){
  const r=ok(await run(`select count(*) from pg_stat_activity where application_name=${quote(application)} and wait_event_type='Lock';`));
  if(r.stdout.trim()==='1')return;await pause(20);
 }assert.fail('Expected an observed PostgreSQL lock wait');
}
async function race(scenario,firstSql,secondSql,check){
 const first=session(),application='wsdl051_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{if(!ended)first.end('rollback;');await first.done;if(second)await second;}
}
const identityData={legal_name:'EMPRESA FICTICIA WSDL CONCORRENCIA',trade_name:null,cnpj:'11222333000181',ie:null,postal_code:'13400000',street:'RUA TESTE',number:'1',complement:null,district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP',phone:null,email:null};
const versions=async()=>value(await run("select jsonb_build_object('a1',(select version from erp_a1.head),'identity',coalesce((select version from erp_company.identity),0));"));
async function identityArgs(){const v=await versions();return{p_user_id:admin,p_expected_version:v.identity,p_command_id:randomUUID(),p_data:{...identityData,trade_name:'TESTE '+randomUUID()}};}
async function configure(){
 const v=await versions(),command=randomUUID(),r=await rpc('erp_a1_reserve',{p_user_id:admin,p_command_id:command,p_request_hash:hash(command),p_action:'configure',p_expected_version:v.a1,p_expected_identity_version:v.identity,p_reason:'CONFIGURACAO FICTICIA SEM CERTIFICADO'});
 const tag=hash(randomUUID()),metadata={profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:hash('synthetic certificate'),holder_cnpj:identityData.cnpj,not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[hash('synthetic certificate')],validated_at:new Date().toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false};
 ok(await run(`insert into storage.objects values('brufap-a1-vault',${quote(`credentials/${r.credential_id}/${tag}.json`)},${quote({size:256,mimetype:'application/json'})});`));
 await rpc('erp_a1_finalize',{p_user_id:admin,p_command_id:command,p_lease_id:r.lease_id,p_metadata:metadata,p_object_hash:tag,p_size_bytes:256,p_key_id:'synthetic_key'});
}
async function beginArgs(model){const v=await versions();return{p_user_id:fiscal,p_command_id:randomUUID(),p_model:model,p_operation:'status',p_expected_a1_version:v.a1,p_expected_identity_version:v.identity,p_confirmed:true};}
const begin=args=>rpc('erp_fiscal_wsdl_begin',args);
const useArgs=r=>({p_user_id:fiscal,p_attempt_id:r.receipt.attempt_id,p_lease_id:r.execution.lease_id});
const command=r=>rpc('erp_fiscal_wsdl_command',{p_user_id:fiscal,p_command_id:r.receipt.command_id});
async function disableArgs(){const id=randomUUID();return{p_user_id:admin,p_command_id:id,p_request_hash:hash(id),p_expected_version:(await versions()).a1,p_reason:'DESATIVACAO FICTICIA CONCORRENTE'};}
async function counts(r){return value(await run(`select jsonb_build_object('attempts',(select count(*)from erp_fiscal_wsdl.attempt where command_id=${quote(r.receipt.command_id)}),'commands',(select count(*)from erp_fiscal_wsdl.command where id=${quote(r.receipt.command_id)}),'prepare',(select count(*)from erp_fiscal_wsdl.audit where attempt_id=${quote(r.receipt.attempt_id)} and action='prepare'),'consume',(select count(*)from erp_fiscal_wsdl.audit where attempt_id=${quote(r.receipt.attempt_id)} and action='consume'));`));}
function cleanup(){
 for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}
 if(container){const own=container;container=null;execFileSync('docker',['rm','--force',own],{stdio:'pipe',timeout:15000});}
}
const interrupt=()=>{try{cleanup();}finally{process.exitCode=130;process.exit();}};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 // --pull=never avoids network even when the official image is absent locally.
 container=execFileSync('docker',['create','--pull=never','--name',name,'--network','none','--memory','256m','--memory-swap','256m','--cpus','1','--shm-size','32m','--tmpfs','/var/lib/postgresql/data:rw,size=128m','--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB='+database,'postgres:17-alpine','postgres','-c','shared_buffers=32MB','-c','work_mem=2MB','-c','maintenance_work_mem=16MB','-c','max_connections=12','-c','max_worker_processes=2','-c','max_parallel_workers=0','-c','huge_pages=off'],{encoding:'utf8',timeout:30000}).trim();
 assert.match(container,/^[a-f0-9]{64}$/);
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8',timeout:5000}))[0];
 assert.equal(info.Name,'/'+name);assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(info.HostConfig.Memory,268435456);assert.equal(info.HostConfig.MemorySwap,268435456);assert.ok(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);assert.equal(info.Mounts.some(m=>['bind','volume'].includes(m.Type)),false);assert.equal(Object.keys(info.HostConfig.PortBindings??{}).length,0);
 execFileSync('docker',['start',container],{stdio:'pipe',timeout:10000});
 const readyUntil=Date.now()+20000;
 while(true){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],{stdio:'pipe',timeout:2000});break;}catch(error){if(Date.now()>readyUntil)throw error;await pause(100);}}
 let bootstrap='create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;';
 for(const file of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0016_company','0041_a1_custody','0051_fiscal_wsdl'])bootstrap+='\n'+await readFile(new URL(`../../supabase/migrations/20261016${file}.sql`,import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(fiscal)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(fiscal)},'fiscal');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);`));
 await rpc('erp_company_save_identity',await identityArgs());
 for(const model of ['55','65']){
  await configure();
  {
   const args=await beginArgs(model),sql=roleSql(rpcSql('erp_fiscal_wsdl_begin',args));
   await race(`${model}_same_begin`,sql,sql,async(a,b)=>{
    const one=value(a),two=value(b);assert.equal(one.replayed,false);assert.equal(two.replayed,true);assert.deepEqual(two.receipt,one.receipt);assert.deepEqual(two.execution,one.execution);
    assert.deepEqual(await counts(one),{attempts:1,commands:1,prepare:1,consume:0});
   });
  }
  {
   const prepared=await begin(await beginArgs(model)),sql=roleSql(rpcSql('erp_fiscal_wsdl_use',useArgs(prepared)));
   await race(`${model}_same_use`,sql,sql,async(a,b)=>{assert.equal(value(a).grant.nonce,prepared.execution.scope.nonce);rejected(b,'40001');assert.deepEqual(await counts(prepared),{attempts:1,commands:1,prepare:1,consume:1});});
  }
  for(const useFirst of [false,true]){
   await configure();const prepared=await begin(await beginArgs(model)),unused=await begin(await beginArgs(model)),disable=await disableArgs();
   const useSql=roleSql(rpcSql('erp_fiscal_wsdl_use',useArgs(prepared))),disableSql=roleSql(rpcSql('erp_a1_disable',disable));
   await race(`${model}_${useFirst?'use_before_disable':'disable_before_use'}`,useFirst?useSql:disableSql,useFirst?disableSql:useSql,async(a,b)=>{
    if(useFirst){assert.ok(value(a).grant);assert.equal(value(b).state,'committed');}else{assert.equal(value(a).state,'committed');rejected(b,'40001');}
    const current=await command(prepared);assert.equal(current.current.a1_changed,true);assert.equal(current.current.grant_consumed,useFirst);assert.equal((await counts(prepared)).consume,useFirst?1:0);
    // An already-consumed grant cannot replay; an unused grant cannot dispatch after disable.
    rejected(await run(useSql),'40001');rejected(await run(roleSql(rpcSql('erp_fiscal_wsdl_use',useArgs(unused)))),'40001');assert.equal((await counts(unused)).consume,0);
    if(useFirst){const order=value(await run(`select jsonb_build_object('ordered',a.used_at<=c.finished_at)from erp_fiscal_wsdl.attempt a cross join erp_a1.command c where a.id=${quote(prepared.receipt.attempt_id)} and c.command_id=${quote(disable.p_command_id)};`));assert.equal(order.ordered,true);}
   });
  }
  for(const useFirst of [false,true]){
   await configure();const prepared=await begin(await beginArgs(model)),edit=await identityArgs();
   const useSql=roleSql(rpcSql('erp_fiscal_wsdl_use',useArgs(prepared))),editSql=roleSql(rpcSql('erp_company_save_identity',edit));
   await race(`${model}_${useFirst?'use_before_identity':'identity_before_use'}`,useFirst?useSql:editSql,useFirst?editSql:useSql,async(a,b)=>{
    if(useFirst){assert.ok(value(a).grant);assert.equal(value(b).record.version,edit.p_expected_version+1);}else{assert.equal(value(a).record.version,edit.p_expected_version+1);rejected(b,'40001');}
    const current=await command(prepared);assert.equal(current.current.company_changed,true);assert.equal(current.current.grant_consumed,useFirst);assert.equal((await counts(prepared)).consume,useFirst?1:0);rejected(await run(useSql),'40001');
   });
  }
 }
 const totals=value(await run("select jsonb_build_object('attempts',(select count(*)from erp_fiscal_wsdl.attempt),'commands',(select count(*)from erp_fiscal_wsdl.command),'consume',(select count(*)from erp_fiscal_wsdl.audit where action='consume'),'artifacts',(select count(*)from erp_fiscal_wsdl.artifact));"));
 assert.deepEqual(totals,{attempts:16,commands:16,consume:6,artifacts:0});
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',multi_session:true,network:'none',memory_bytes:268435456,storage:'tmpfs',scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
