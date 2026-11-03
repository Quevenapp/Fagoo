// Optional real PostgreSQL concurrency probe. Only synthetic metadata is loaded;
// no certificate bytes, network, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {PROTOCOL_RUNNER_PROFILE} from '../../packages/fiscal-schema-runner/src/protocol.mjs';

const name='brufap-reconciliation061-'+randomUUID(),database='brufap_synthetic';
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
 const first=session(),application='reconciliation061_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});
 }finally{if(!ended)first.end('rollback;');await first.done;if(second)await second;}
}
let contact,product,series=100;
const companyData={legal_name:'EMPRESA FICTICIA CONCORRENCIA',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'};
async function setCompany(data=companyData){
 const current=await rpc('erp_company_get',{p_user_id:admin,p_section:'identity'});
 return rpc('erp_company_save_identity',{p_user_id:admin,p_expected_version:current.record?.version??0,p_command_id:randomUUID(),p_data:data});
}
async function confirmRegime(){
 const identity=await rpc('erp_company_get',{p_user_id:admin,p_section:'identity'}),f=await rpc('erp_company_get',{p_user_id:admin,p_section:'fiscal'});
 await rpc('erp_company_confirm_fiscal',{p_user_id:admin,p_expected_version:f.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'REGIME FICTICIO PARA ENSAIO LOCAL'});
}
const completionArgs=(f,version=0,completion=f.completion)=>({p_user_id:fiscal,p_draft_id:f.draft.record.id,p_expected_draft_version:1,p_snapshot_hash:f.draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_expected_identity_version:f.draft.record.snapshot.company.identity_version,p_expected_fiscal_version:f.draft.record.snapshot.company.fiscal_version,p_expected_completion_version:version,p_completion:completion,p_command_id:randomUUID()});
async function fixture(model){
 const document=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'}]}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:fiscal,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const sample=businessFixture({model});await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:sample.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
 const{identity,...completion}=sample.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);
 const f={draft,completion};await rpc('erp_fiscal_completion_save',completionArgs(f));
 const configured=await rpc('erp_fiscal_numbering_configure',{p_user_id:admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:model,p_environment:'2',p_series:String(series++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'SERIE FICTICIA PARA ENSAIO LOCAL'});
 f.reservation=await rpc('erp_fiscal_numbering_reserve',{p_user_id:fiscal,p_command_id:randomUUID(),p_series_id:configured.current_series.id,p_expected_series_version:configured.current_series.version,p_expected_identity_version:configured.current_series.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});return f;
}
async function startArgs(f){
 const b=await rpc('erp_fiscal_unsigned_basis',{p_user_id:fiscal,p_draft_id:f.draft.record.id,p_completion_version:1});
 const now=value(await run(`select jsonb_build_object('now',to_char(clock_timestamp() at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00');`)).now;
 return{p_user_id:fiscal,p_command_id:randomUUID(),p_reservation_id:f.reservation.receipt.id,p_completion_version:1,p_completion_hash:b.proofs.completion_hash,p_basis_hash:b.basis_hash,p_builder_version:'brufap-business-builder-v1',p_seed:{cNF:'12345678',issuedAt:now}};
}
const unsignedBegin=args=>rpc('erp_fiscal_unsigned_begin',args);
async function uploaded(j){
 const v=j.execution.inputs,xml=buildBusinessXml({draft:v.draft,itemPreparation:v.itemPreparation,taxPreparation:v.taxPreparation,completion:{...v.completionPreparation.record.completion,identity:Object.fromEntries(['series','number','cNF','issuedAt'].map(k=>[k,j.execution.identity[k]]))}}).unsignedXml;
 const hash=createHash('sha256').update(xml).digest('hex'),size=Buffer.byteLength(xml);
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote('jobs/'+j.receipt.job_id+'/'+hash+'.xml')},${quote({size,mimetype:'application/octet-stream'})});`));
 return{p_user_id:fiscal,p_job_id:j.receipt.job_id,p_lease_id:j.execution.lease_id,p_xml_hash:hash,p_size_bytes:size,p_access_key:j.receipt.access_key};
}
const versions=async()=>value(await run("select jsonb_build_object('a1',(select version from erp_a1.head),'identity',coalesce((select version from erp_company.identity),0));"));
async function configure(){
 const v=await versions(),command=randomUUID(),r=await rpc('erp_a1_reserve',{p_user_id:admin,p_command_id:command,p_request_hash:hash(command),p_action:'configure',p_expected_version:v.a1,p_expected_identity_version:v.identity,p_reason:'CONFIGURACAO FICTICIA SEM CERTIFICADO'});
 const tag=hash(randomUUID()),metadata={profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:hash('synthetic certificate'),holder_cnpj:TEST_HOLDER,not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[hash('synthetic certificate')],validated_at:new Date().toISOString(),key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false};
 ok(await run(`insert into storage.objects values('brufap-a1-vault',${quote(`credentials/${r.credential_id}/${tag}.json`)},${quote({size:256,mimetype:'application/json'})});`));
 await rpc('erp_a1_finalize',{p_user_id:admin,p_command_id:command,p_lease_id:r.lease_id,p_metadata:metadata,p_object_hash:tag,p_size_bytes:256,p_key_id:'synthetic_key'});
}
async function identityArgs(){const v=await versions();return{p_user_id:admin,p_expected_version:v.identity,p_command_id:randomUUID(),p_data:{...companyData,trade_name:'TESTE '+randomUUID()}};}
async function disableArgs(){const id=randomUUID();return{p_user_id:admin,p_command_id:id,p_request_hash:hash(id),p_expected_version:(await versions()).a1,p_reason:'DESATIVACAO FICTICIA CONCORRENTE'};}
async function source(model){
 const j=await unsignedBegin(await startArgs(await fixture(model))),uploadedArgs=await uploaded(j);
 await rpc('erp_fiscal_unsigned_finish',uploadedArgs);
 const c=await rpc('erp_fiscal_signed_begin',{p_user_id:fiscal,p_command_id:randomUUID(),p_unsigned_job_id:j.receipt.job_id,p_unsigned_hash:uploadedArgs.p_xml_hash,p_basis_hash:j.receipt.basis_hash,p_expected_a1_version:(await versions()).a1});
 await rpc('erp_fiscal_signed_use',{p_user_id:fiscal,p_candidate_id:c.receipt.candidate_id,p_lease_id:c.execution.lease_id});
 const h=hash('synthetic signed candidate '+model),size=1024;
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote('candidates/'+c.receipt.candidate_id+'/'+h+'.xml')},${quote({size,mimetype:'application/octet-stream'})});`));
 return rpc('erp_fiscal_signed_finish',{p_user_id:fiscal,p_candidate_id:c.receipt.candidate_id,p_lease_id:c.execution.lease_id,p_signed_hash:h,p_size_bytes:size,p_evidence:{
  signature:{xml_hash:h,certificate_fingerprint:c.receipt.certificate_fingerprint,signed_content_hash:hash('synthetic infNFe'),reference_digest:Buffer.alloc(20,17).toString('base64'),profile:'nfe400-rsa-sha1-c14n-v1'},
  xsd:{xml_hash:h,schema_profile:'pl010f-v1.04',manifest_hash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validator_version:'fiscal-schema-runner-v1',validator_hash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6'},
  qr:{profile:model==='65'?'sp-homologation-online-qr-v3':null,verified:model==='65'}}});
}
async function beginArgs(s){const v=await versions();return{p_user_id:fiscal,p_command_id:randomUUID(),p_candidate_id:s.receipt.candidate_id,p_signed_hash:s.artifact.signed_hash,p_expected_identity_version:v.identity,p_expected_a1_version:v.a1,p_confirmed:true};}
const begin=args=>rpc('erp_fiscal_reconciliation_begin',args);
const command=b=>rpc('erp_fiscal_reconciliation_command',{p_user_id:fiscal,p_command_id:b.receipt.command_id});
async function useArgs(b){const h=hash('synthetic request '+b.receipt.attempt_id),size=32;
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote('reconciliation/'+b.receipt.attempt_id+'/requests/'+h+'.xml')},${quote({size,mimetype:'application/octet-stream'})}) on conflict do nothing;`));
 return{p_user_id:fiscal,p_attempt_id:b.receipt.attempt_id,p_lease_id:b.execution.context.lease_id,p_request_hash:h,p_request_size:size};
}
async function finishArgs(b,u){const h=hash('synthetic response '+b.receipt.attempt_id),size=64;
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote('reconciliation/'+b.receipt.attempt_id+'/responses/'+u.p_request_hash+'.xml')},${quote({size,mimetype:'application/octet-stream'})}) on conflict do nothing;`));
 return{p_user_id:fiscal,p_attempt_id:b.receipt.attempt_id,p_lease_id:b.execution.context.lease_id,p_response_hash:h,p_response_size:size,p_evidence:{origin:'synthetic',request_hash:u.p_request_hash,response_hash:h,payload_hash:hash('synthetic payload'),binding_profile:'sp-protocol-soap12-reviewed-v1',schema_profile:PROTOCOL_RUNNER_PROFILE.schemaProfile,validator_version:PROTOCOL_RUNNER_PROFILE.version,validator_hash:PROTOCOL_RUNNER_PROFILE.validatorHash,schema_manifest_hash:PROTOCOL_RUNNER_PROFILE.manifestHash,outcome:'validated',rejection_code:null,xsd_validated:true,context_matched:true,cstat:'217',received_at:'2026-10-16T04:00:00.000Z',protocol:null,event_count:0,legacy_cancellation_observed:false,event_reconciliation_required:false,verified:false,tls_origin_verified:false,signature_verified:false,sefaz_authorized:false,can_emit:false,can_query:false,can_transmit:false}};
}
async function counts(b){return value(await run(`select jsonb_build_object('attempts',(select count(*)from erp_fiscal_reconciliation.attempt where command_id=${quote(b.receipt.command_id)}),'commands',(select count(*)from erp_fiscal_reconciliation.command where id=${quote(b.receipt.command_id)}),'prepare',(select count(*)from erp_fiscal_reconciliation.audit where attempt_id=${quote(b.receipt.attempt_id)} and action='prepare'),'consume',(select count(*)from erp_fiscal_reconciliation.audit where attempt_id=${quote(b.receipt.attempt_id)} and action='consume'),'store',(select count(*)from erp_fiscal_reconciliation.audit where attempt_id=${quote(b.receipt.attempt_id)} and action='store'));`));}
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
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs','0041_a1_custody','0050_signed_fiscal_candidates','0051_fiscal_wsdl','0061_fiscal_reconciliation'])bootstrap+='\n'+await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(fiscal)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(fiscal)},'fiscal');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);`));
 await setCompany();await confirmRegime();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;

 await configure();
 const sources={55:await source('55'),65:await source('65')};
 for(const model of['55','65']){
  await configure();const s=sources[model];
  {
   const args=await beginArgs(s),sql=roleSql(rpcSql('erp_fiscal_reconciliation_begin',args));
   await race(`${model}_same_begin`,sql,sql,async(a,b)=>{const one=value(a),two=value(b);assert.equal(one.replayed,false);assert.equal(two.replayed,true);assert.deepEqual(two.receipt,one.receipt);assert.deepEqual(two.execution,one.execution);assert.deepEqual(await counts(one),{attempts:1,commands:1,prepare:1,consume:0,store:0});});
  }
  {
   const b=await begin(await beginArgs(s)),u=await useArgs(b),sql=roleSql(rpcSql('erp_fiscal_reconciliation_use',u));
   await race(`${model}_same_use`,sql,sql,async(a,result)=>{assert.equal(value(a).grant.nonce,b.execution.context.nonce);rejected(result,'40001');assert.deepEqual(await counts(b),{attempts:1,commands:1,prepare:1,consume:1,store:0});});
  }
  for(const useFirst of[false,true]){
   await configure();const b=await begin(await beginArgs(s)),unused=await begin(await beginArgs(s)),u=await useArgs(b),unusedUse=await useArgs(unused),disable=await disableArgs();
   const useSql=roleSql(rpcSql('erp_fiscal_reconciliation_use',u)),disableSql=roleSql(rpcSql('erp_a1_disable',disable));
   await race(`${model}_${useFirst?'use_before_disable':'disable_before_use'}`,useFirst?useSql:disableSql,useFirst?disableSql:useSql,async(a,result)=>{
    if(useFirst){assert.ok(value(a).grant);assert.equal(value(result).state,'committed');}else{assert.equal(value(a).state,'committed');rejected(result,'40001');}
    const current=await command(b);assert.equal(current.current.a1_changed,true);assert.equal(current.current.grant_consumed,useFirst);assert.equal((await counts(b)).consume,useFirst?1:0);
    rejected(await run(useSql),'40001');rejected(await run(roleSql(rpcSql('erp_fiscal_reconciliation_use',unusedUse))),'40001');assert.equal((await counts(unused)).consume,0);
    if(useFirst){const order=value(await run(`select jsonb_build_object('ordered',a.used_at<=c.finished_at)from erp_fiscal_reconciliation.attempt a cross join erp_a1.command c where a.id=${quote(b.receipt.attempt_id)} and c.command_id=${quote(disable.p_command_id)};`));assert.equal(order.ordered,true);const finished=await rpc('erp_fiscal_reconciliation_finish',await finishArgs(b,u));assert.equal(finished.current.state,'stored');assert.equal(finished.current.a1_changed,true);assert.equal(finished.sefaz_authorized,false);}
   });
  }
  for(const useFirst of[false,true]){
   await configure();const b=await begin(await beginArgs(s)),u=await useArgs(b),edit=await identityArgs();
   const useSql=roleSql(rpcSql('erp_fiscal_reconciliation_use',u)),editSql=roleSql(rpcSql('erp_company_save_identity',edit));
   await race(`${model}_${useFirst?'use_before_identity':'identity_before_use'}`,useFirst?useSql:editSql,useFirst?editSql:useSql,async(a,result)=>{
    if(useFirst){assert.ok(value(a).grant);assert.equal(value(result).record.version,edit.p_expected_version+1);}else{assert.equal(value(a).record.version,edit.p_expected_version+1);rejected(result,'40001');}
    const current=await command(b);assert.equal(current.current.company_changed,true);assert.equal(current.current.grant_consumed,useFirst);assert.equal((await counts(b)).consume,useFirst?1:0);rejected(await run(useSql),'40001');
    if(useFirst){const stored=await rpc('erp_fiscal_reconciliation_finish',await finishArgs(b,u));assert.equal(stored.current.state,'stored');assert.deepEqual(stored.receipt,b.receipt);assert.equal(stored.current.company_changed,true);}
   });
  }
  await configure();
  {
   const b=await begin(await beginArgs(s)),u=await useArgs(b);await rpc('erp_fiscal_reconciliation_use',u);const f=await finishArgs(b,u),sql=roleSql(rpcSql('erp_fiscal_reconciliation_finish',f));
   await race(`${model}_same_finish`,sql,sql,async(a,result)=>{const one=value(a),two=value(result);assert.equal(one.replayed,false);assert.equal(two.replayed,true);assert.deepEqual(two.artifact,one.artifact);assert.deepEqual(await counts(b),{attempts:1,commands:1,prepare:1,consume:1,store:1});});
  }
  for(const action of['use','finish']){
   const b=await begin(await beginArgs(s)),u=await useArgs(b);if(action==='finish')await rpc('erp_fiscal_reconciliation_use',u);
   const args=action==='use'?u:await finishArgs(b,u),sql=roleSql(rpcSql('erp_fiscal_reconciliation_'+action,args));
   try{await race(`${model}_membership_revoked_before_${action}`,`update erp_access.membership set active=false where user_id=${quote(fiscal)};`,sql,async(a,result)=>{rejected(result,'42501');const c=await counts(b);assert.equal(c.consume,action==='finish'?1:0);assert.equal(c.store,0);});}
   finally{ok(await run(`update erp_access.membership set active=true where user_id=${quote(fiscal)};`));}
  }
  {
   const b=await begin(await beginArgs(s)),u=await useArgs(b),f=await finishArgs(b,u),failure={p_user_id:fiscal,p_attempt_id:b.receipt.attempt_id,p_lease_id:b.execution.context.lease_id,p_error_code:'PREPARATION_FAILED'};
   await race(`${model}_failed_before_dispatch_cannot_finish`,roleSql(rpcSql('erp_fiscal_reconciliation_fail',failure)),roleSql(rpcSql('erp_fiscal_reconciliation_finish',f)),async(a,result)=>{assert.equal(value(a).current.state,'failed_before_dispatch');rejected(result,'40001');assert.equal((await counts(b)).consume,0);assert.equal((await counts(b)).store,0);});
  }
  {
   const b=await begin(await beginArgs(s)),u=await useArgs(b);await rpc('erp_fiscal_reconciliation_use',u);const f=await finishArgs(b,u),failure={p_user_id:fiscal,p_attempt_id:b.receipt.attempt_id,p_lease_id:b.execution.context.lease_id,p_error_code:'JOURNAL_UNAVAILABLE'};
   // Fixture-only clock shift preserves used_at < expires_at. Neither concurrent RPC bypasses a guard.
   ok(await run(`alter table erp_fiscal_reconciliation.attempt disable trigger guard_attempt;update erp_fiscal_reconciliation.attempt set expires_at=used_at+interval'1 microsecond'where id=${quote(b.receipt.attempt_id)};alter table erp_fiscal_reconciliation.attempt enable trigger guard_attempt;`));
   await race(`${model}_expired_uncertain_recovers_without_grant`,roleSql(rpcSql('erp_fiscal_reconciliation_fail',failure)),roleSql(rpcSql('erp_fiscal_reconciliation_finish',f)),async(a,result)=>{assert.equal(value(a).current.state,'uncertain');const stored=value(result);assert.equal(stored.current.state,'stored');assert.equal(stored.current.lease_expired,true);assert.equal(stored.current.retry_transport_allowed,false);assert.equal(stored.can_transmit,false);assert.deepEqual(stored.receipt,b.receipt);rejected(await run(roleSql(rpcSql('erp_fiscal_reconciliation_use',u))),'40001');assert.deepEqual(await counts(b),{attempts:1,commands:1,prepare:1,consume:1,store:1});});
  }
 }
 const totals=value(await run("select jsonb_build_object('attempts',(select count(*)from erp_fiscal_reconciliation.attempt),'commands',(select count(*)from erp_fiscal_reconciliation.command),'consume',(select count(*)from erp_fiscal_reconciliation.audit where action='consume'),'artifacts',(select count(*)from erp_fiscal_reconciliation.artifact),'reservations',(select count(*)from erp_fiscal_numbering.reservation),'unsigned_jobs',(select count(*)from erp_fiscal_unsigned.job),'signed_candidates',(select count(*)from erp_fiscal_signed.candidate),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title));"));
 assert.deepEqual(totals,{attempts:26,commands:26,consume:12,artifacts:8,reservations:2,unsigned_jobs:2,signed_candidates:2,stock:0,finance:0});
 console.log(JSON.stringify({synthetic:true,postgres:'17-alpine',multi_session:true,network:'none',memory_bytes:268435456,storage:'tmpfs',scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
