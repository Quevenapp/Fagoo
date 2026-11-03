// Synthetic two-session CNAB067 checks. No bank, secrets or persistent state.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PROFILES,CNPJ} from '../../packages/cnab-core/test/fixtures.mjs';
import {generateOperationalRemittanceV2} from '../../packages/cnab-core/src/index.mjs';
const name='brufap-cnab067-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),finance=randomUUID(),sessions=new Set(),results=[];
let container=null;
const nativeBin=process.env.BRUFAP_TEST_PG17_BIN??null;
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
let nativeRoot=null,nativeStarted=false;
const nativePort='56467';
const hash=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+(['p_allowed_encoding_profiles','p_zero_daily_title_ids'].includes(key)?'ARRAY['+value.map(quote).join(',')+']::'+(key==='p_zero_daily_title_ids'?'uuid[]':'text[]'):quote(value));}).join(',')});`;};
const roleSql=sql=>`set role service_role; ${sql}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function session(){
 if(!nativeBin)assert.match(container,/^[a-f0-9]{64}$/);
 else assert.ok(nativeStarted&&nativeRoot);
 const client=['-XAtq','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
 const child=nativeBin
  ?spawn(join(nativeBin,'psql'),['-h',join(nativeRoot,'socket'),'-p',nativePort,...client],{env:childEnv,stdio:['pipe','pipe','pipe']})
  :spawn('docker',['exec','-i',container,'psql',...client],{stdio:['pipe','pipe','pipe']});
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
 const first=session(),application='cnab067_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{if(!ended)first.end('rollback;');await first.done;if(second)await second;}
}
function cleanup(){
 for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}
 if(container){const own=container;container=null;execFileSync('docker',['rm','--force',own],{stdio:'pipe',timeout:15000});}
 if(nativeStarted&&existsSync(join(nativeRoot,'data','postmaster.pid'))){execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-m','immediate','-w','stop'],{env:childEnv,stdio:'pipe',timeout:15000});}
 nativeStarted=false;
 if(nativeRoot){const own=nativeRoot;nativeRoot=null;assert.match(own,/^\/Volumes\/Dev\/tmp\/brufap-cnab067-[A-Za-z0-9]+$/);rmSync(own,{recursive:true});}
}
const interrupt=()=>{try{cleanup();}finally{process.exitCode=130;process.exit();}};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 if(nativeBin){
  assert.ok(isAbsolute(nativeBin));assert.match(execFileSync(join(nativeBin,'postgres'),['--version'],{env:childEnv,encoding:'utf8',timeout:5000}),/^postgres \(PostgreSQL\) 17\./);
  nativeRoot=mkdtempSync('/Volumes/Dev/tmp/brufap-cnab067-');chmodSync(nativeRoot,0o700);mkdirSync(join(nativeRoot,'socket'),{mode:0o700});
  execFileSync(join(nativeBin,'initdb'),['-D',join(nativeRoot,'data'),'-U','postgres','-A','trust','--encoding=UTF8','--locale=C'],{env:childEnv,stdio:'pipe',timeout:30000});
  const options=`-c listen_addresses='' -k ${join(nativeRoot,'socket')} -p ${nativePort} -c shared_buffers=32MB -c work_mem=2MB -c maintenance_work_mem=16MB -c max_connections=12 -c max_worker_processes=2 -c max_parallel_workers=0 -c huge_pages=off`;
  nativeStarted=true;execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-l',join(nativeRoot,'postgres.log'),'-o',options,'-w','start'],{env:childEnv,stdio:'pipe',timeout:15000});
  execFileSync(join(nativeBin,'createdb'),['-h',join(nativeRoot,'socket'),'-p',nativePort,'-U','postgres',database],{env:childEnv,stdio:'pipe',timeout:5000});
  assert.equal(ok(await run('show listen_addresses;')).stdout.trim(),'');
 }else{
 // --pull=never avoids network even when the official image is absent locally.
 container=execFileSync('docker',['create','--pull=never','--name',name,'--network','none','--memory','256m','--memory-swap','256m','--cpus','1','--shm-size','32m','--tmpfs','/var/lib/postgresql/data:rw,size=128m','--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB='+database,'postgres:17-alpine','postgres','-c','shared_buffers=32MB','-c','work_mem=2MB','-c','maintenance_work_mem=16MB','-c','max_connections=12','-c','max_worker_processes=2','-c','max_parallel_workers=0','-c','huge_pages=off'],{encoding:'utf8',timeout:30000}).trim();
 assert.match(container,/^[a-f0-9]{64}$/);
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8',timeout:5000}))[0];
 assert.equal(info.Name,'/'+name);assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(info.HostConfig.Memory,268435456);assert.equal(info.HostConfig.MemorySwap,268435456);assert.ok(info.HostConfig.Tmpfs['/var/lib/postgresql/data']);assert.equal(info.Mounts.some(m=>['bind','volume'].includes(m.Type)),false);assert.equal(Object.keys(info.HostConfig.PortBindings??{}).length,0);
 execFileSync('docker',['start',container],{stdio:'pipe',timeout:10000});
 const readyUntil=Date.now()+20000;
 while(true){try{execFileSync('docker',['exec',container,'pg_isready','-h','127.0.0.1','-U','postgres','-d',database],{stdio:'pipe',timeout:2000});break;}catch(error){if(Date.now()>readyUntil)throw error;await pause(100);}}
 }
 let bootstrap='create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;';
 for(const suffix of['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0024_cnab_human_review','0030_origin_finance_refresh','0038_financial_cutover_review','0039_origin_financial_import','0042_cnab_operational','0043_cnab_operational_returns','0053_finance_transfers','0058_itau_net_credit','0066_itau_boleto_preview','0067_itau_operational_encoding'])bootstrap+='\n'+await readFile(new URL('../../supabase/migrations/20261016'+suffix+'.sql',import.meta.url),'utf8');
 ok(await run(bootstrap));ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(finance)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(finance)},'financeiro');insert into storage.buckets values('brufap-cnab','brufap-cnab',false,4020000,ARRAY['application/octet-stream']);`));
 const today=value(await run("select jsonb_build_object('date',(clock_timestamp()at time zone'America/Sao_Paulo')::date::text); ")).date;
 await rpc('erp_company_save_identity',{p_user_id:admin,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'EMPRESA SINTETICA',cnpj:CNPJ,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
 const contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PAGADOR SINTETICO',person_type:'F',document:'12345678909',street:'RUA FICTICIA',number:'1',district:'TESTE',city:'PIRACICABA',state:'SP',postal_code:'13400000',roles:['customer']}})).record;
 const observed='itau109-origin-observed-v1';let ordinal=0;
 const native=(action,data)=>rpc('erp_finance_execute',{p_user_id:finance,p_command_id:randomUUID(),p_action:action,p_data:data});
 const postSql=args=>roleSql(rpcSql('erp_cnab_operational_reserve_v2',args));
 const approval=(p,enabled=true)=>({p_user_id:admin,p_profile_id:p.id,p_command_id:randomUUID(),p_expected_approval:p.approval_version??0,p_expected_profile:p.version,p_expected_identity:1,p_enabled:enabled,p_confirmed_on:today,p_reference:'SYNTHETIC EXPLICIT PROFILE',p_allowed_encoding_profiles:enabled?[observed]:[],p_compatibility_confirmed:enabled,p_permanent_instructions_acknowledged:enabled});
 async function profile(){const account=(await native('account_save',{expected_version:0,name:'SYNTHETIC '+(++ordinal),kind:'bank'})).record,{accountId,...base}=PROFILES.itau;
  const p=(await rpc('erp_cnab_profile_save',{p_user_id:admin,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{...base,account:String(40000+ordinal),simpleCollectionPolicyVerified:false,account_id:account.id,ourNumberStart:'00000001',remittanceSequenceStart:'1'}})).profile;
  await rpc('erp_cnab_operational_approve_v2',approval(p));return{...p,approval_version:1};}
 async function title(){return(await native('title_create_group',{kind:'receivable',contact_id:contact.id,description:'SYNTHETIC TITLE',issued_on:today,total_cents:'12345',installments:[{amount_cents:'12345',due_on:today}]})).items[0];}
 async function selection(p,tt=[null]){const titles=tt[0]===null?[await title()]:tt;
  const args={p_user_id:finance,p_command_id:randomUUID(),p_profile_id:p.id,p_expected_version:p.version,p_generated_on:today,p_titles:titles.map(t=>({title_id:t.id,expected_version:1,document_number:'C'+String(++ordinal).padStart(8,'0')})),p_preview:true,p_expected_approval:p.approval_version,p_preview_hash:null,p_encoding_profile:observed,p_confirm_encoding_profile:false,p_zero_daily_title_ids:[],p_confirm_operational:false};
  const preview=await rpc('erp_cnab_operational_reserve_v2',args);return{...args,p_preview:false,p_preview_hash:preview.preview_hash,p_confirm_encoding_profile:true,p_confirm_operational:true};}
 const get=id=>rpc('erp_cnab_operational_command_v2',{p_user_id:finance,p_command_id:id});
 async function assertOne(id){const v=await get(id);const totals=value(await run(`select jsonb_build_object('remittances',(select count(*)from erp_cnab.remittance where id=${quote(v.current.id)}),'billing',(select count(*)from erp_cnab.billing_title where remittance_id=${quote(v.current.id)}),'commands',(select count(*)from erp_cnab.command where id=${quote(id)}),'audit',(select count(*)from erp_cnab.audit where command_id=${quote(id)}));`));assert.equal(totals.remittances,1);assert.equal(totals.commands,1);assert.equal(totals.audit,1);return v;}
 {
  const p=await profile(),a=await selection(p);await race('same_command_one_reservation',postSql(a),postSql(a),async(x,y)=>{assert.equal(value(x).replayed,false);assert.equal(value(y).replayed,true);assert.equal(value(x).id,value(y).id);await assertOne(a.p_command_id);});
 }
 {
  const p=await profile(),a=await selection(p),b={...a,p_command_id:randomUUID()};await race('different_command_same_CAS_one_winner',postSql(a),postSql(b),async(x,y)=>{rejected(y,'40001');await assertOne(a.p_command_id);});
 }
 {
  const a=await profile(),b=await profile(),t1=await title(),t2=await title(),one=await selection(a,[t1,t2]),two=await selection(b,[t2,t1]);
  await race('opposite_title_order_two_profiles_no_deadlock',postSql(one),postSql(two),async(x,y)=>{rejected(y,'40001');assert.equal((await assertOne(one.p_command_id)).current.profile_id,a.id);});
 }
 for(const mode of['fresh','replay']){
  const p=await profile(),a=await selection(p);if(mode==='replay')await rpc('erp_cnab_operational_reserve_v2',a);
  const hold=session(),application='cnab067_'+randomUUID();let pending,released=false;
  hold.write(`begin;select pg_advisory_xact_lock(hashtextextended(${quote(a.p_command_id)},814));\n\\echo FIRST_DONE`);
  try{await hold.marker('FIRST_DONE');pending=run(`set application_name=${quote(application)};set lock_timeout='12s';${postSql(a)}`);await waiting(application);
   ok(await run(`update erp_access.membership set active=false where user_id=${quote(finance)};`));hold.end('commit;');released=true;ok(await hold.done);rejected(await pending,'42501');
   results.push({scenario:mode+'_actor_revoked_while_command_waits',lock_wait_observed:true,passed:true});
  }finally{if(!released)hold.end('rollback;');await hold.done;if(pending)await pending;ok(await run(`update erp_access.membership set active=true where user_id=${quote(finance)};`));}
 }
 {
  const p=await profile(),a=await selection(p),disable=approval(p,false);await race('approval_disabled_before_reserve',roleSql(rpcSql('erp_cnab_operational_approve_v2',disable)),postSql(a),async(x,y)=>{assert.equal(value(x).approval.enabled,false);rejected(y,'40001');});
 }
 {
  const p=await profile(),a=await selection(p);await rpc('erp_cnab_operational_reserve_v2',a);const c=await get(a.p_command_id),r=await rpc('erp_cnab_operational_reservation_v2',{p_user_id:finance,p_id:c.current.id,p_expected_approval:1}),g=await generateOperationalRemittanceV2(r.snapshot),path=`profiles/${p.id}/remittances/${g.fileHash}.rem`;
  ok(await run(`insert into storage.objects values('brufap-cnab',${quote(path)},${quote({size:g.bytes.length,mimetype:'application/octet-stream'})});`));
  const args={p_user_id:finance,p_command_id:randomUUID(),p_id:c.current.id,p_hash:g.fileHash,p_size:g.bytes.length,p_path:path,p_manifest:g.manifest,p_expected_approval:1};
  const sql=roleSql(rpcSql('erp_cnab_operational_finalize_v2',args));await race('same_finalize_one_ready_receipt',sql,sql,async(x,y)=>{assert.equal(value(x).replayed,false);assert.equal(value(y).replayed,true);assert.equal((await get(a.p_command_id)).current.state,'ready');});
  const disable=approval({...p,version:2},false);await race('disable_precedes_ready_replay',roleSql(rpcSql('erp_cnab_operational_approve_v2',disable)),sql,async(x,y)=>{rejected(y,'40001');assert.equal((await get(a.p_command_id)).current.state,'ready');});
 }
 const totals=value(await run("select jsonb_build_object('remittances',(select count(*)from erp_cnab.remittance),'billing_titles',(select count(*)from erp_cnab.billing_title),'ready',(select count(*)from erp_cnab.remittance where state='ready'),'settlements',(select count(*)from erp_finance.settlement),'movements',(select count(*)from erp_finance.movement),'stock',(select count(*)from erp_stock.movement),'settled_titles',(select count(*)from erp_finance.title where settled_cents<>0));"));
 assert.equal(totals.settlements,0);assert.equal(totals.movements,0);assert.equal(totals.stock,0);assert.equal(totals.settled_titles,0);
 console.log(JSON.stringify({synthetic_fixture:true,postgres:nativeBin?'17-native':'17-alpine',network:nativeBin?'private_unix_socket_no_tcp':'none',bank_transmission_performed:false,scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
