// 080 NFC-e temporal consumption concurrency checker. Docker by default; an explicit local PG17 binary is optional.
// Exclusively synthetic metadata, no TLS handshake or SOAP dispatch.
// Only synthetic metadata is loaded;
// no certificate bytes, network, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE} from '../../packages/fiscal-authorization/src/validator.mjs';
import {canonical,SUBSET_SCHEMA} from '../../packages/fiscal-authorization/src/subset-review-dto.mjs';
import {RULE_PROFILE_V2_HASH as SP_CRT1_RULE_MANIFEST_HASH} from '../../packages/fiscal-authorization/src/rule-profile-registry.mjs';

const name='brufap-emission080-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),fiscal=randomUUID(),sessions=new Set(),results=[];
let container=null;
const nativeBin=process.env.BRUFAP_TEST_PG17_BIN??null;
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
let nativeRoot=null,nativeStarted=false;
const nativePort='56480';
const hash=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+quote(value);}).join(',')});`;};
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
async function race(scenario,firstSql,secondSql,check,waitMs=0){
 const first=session(),application='emission080_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);if(waitMs)await pause(waitMs);first.end('commit;');ended=true;
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

const review=(action,args)=>rpc('erp_fiscal_subset_review_'+action,args);
const sql=(action,args)=>roleSql(rpcSql('erp_fiscal_subset_review_'+action,args));
const declaration={document:{operation:'internal_normal_sale',recipient_regime:'noncontributor',acquisition_purpose:'final_consumption',payment:'matches_signed_document',excluded_groups:'not_applicable'},items:[{position:1,item_hash:hash('synthetic item'),classification:'reviewed_physical_goods',benefit:'not_applicable',pis_cofins:'normal_unified_simples',gtin:'reviewed_absent',st:'not_applicable',fcp:'not_applicable',credit:null}]};
async function fresh(model){await confirmRegime();await configure();const s=await source(model);return{p_user_id:fiscal,p_command_id:randomUUID(),p_candidate_id:s.receipt.candidate_id,p_expected_candidate_version:s.receipt.version,p_signed_hash:s.artifact.signed_hash,p_expected_review_version:0,p_facts_hash:hash('synthetic facts'),p_profile_hash:SP_CRT1_RULE_MANIFEST_HASH,p_schema:{xml_hash:s.artifact.signed_hash,...SUBSET_SCHEMA},p_valid_until:'2026-10-25T23:59:59.000Z',p_declaration_text:canonical(declaration)};}
const count=async args=>value(await run(`select jsonb_build_object('n',count(*))from erp_fiscal_subset_review.review where candidate_id=${quote(args.p_candidate_id)};`));

const auth=(action,args)=>rpc('erp_fiscal_reviewed_authorization_'+action,args);
const authSql=(action,args)=>roleSql(rpcSql('erp_fiscal_reviewed_authorization_'+action,args));
async function authorized(model,{prepare=true,reviewActor=fiscal,expiresIn=null}={}){
 const reviewArgs=await fresh(model);reviewArgs.p_user_id=reviewActor;if(expiresIn!==null)reviewArgs.p_valid_until=new Date(Date.now()+expiresIn).toISOString();
 const saved=await review('save',reviewArgs),{command_id,schema,...r}=saved.receipt,proof={...r,tax_rules_validated:false};
 const v=await versions(),beginArgs={p_user_id:fiscal,p_command_id:randomUUID(),p_candidate_id:reviewArgs.p_candidate_id,p_signed_hash:reviewArgs.p_signed_hash,p_expected_identity_version:v.identity,p_expected_a1_version:v.a1,p_expected_policy_version:4,p_confirmed:true};
 const begun=await auth('begin',beginArgs),b=begun.view,c=b.execution;
 const ids={p_user_id:fiscal,p_attempt_id:c.attempt_id,p_lease_id:c.lease_id};
 const requestHash=hash('synthetic request '+c.batch_id);
 await object(c,'requests',requestHash,32);
 const prep={...ids,p_request_hash:requestHash,p_request_size:32,p_rule_review:proof,p_evidence:{
  ...Object.fromEntries(['origin','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','binding_profile','rule_profile'].map(k=>[k,c[k]])),request_hash:requestHash,payload_hash:hash('synthetic payload'),
  schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,
  signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false}};
 if(prepare)await auth('prepare',prep);
 return{reviewArgs,proof,b,c,ids,prep,beginArgs,use:{...ids,p_rule_review:proof}};
}
const counts=async f=>value(await run(`select jsonb_build_object('bindings',(select count(*)from erp_fiscal_reviewed_authorization.review_binding where attempt_id=${quote(f.c.attempt_id)}),'consumes',(select count(*)from erp_fiscal_authorization.audit where attempt_id=${quote(f.c.attempt_id)}and action='consume'),'results',(select count(*)from erp_fiscal_authorization.result where attempt_id=${quote(f.c.attempt_id)}),'observations',(select count(*)from erp_fiscal_reviewed_authorization.observation where attempt_id=${quote(f.c.attempt_id)}));`));
async function object(c,kind,tag,size){ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote(`authorization/${c.attempt_id}/${kind}/${tag}.${kind==='observations'?'json':'xml'}`)},${quote({size,mimetype:'application/octet-stream'})})on conflict do nothing;`));}
async function finishArgs(f){const c=f.c,response=hash('synthetic response '+c.batch_id),processed=hash('synthetic processed '+c.batch_id),observation=hash('synthetic observation '+c.batch_id);await object(c,'responses',f.prep.p_request_hash,32);await object(c,'processed',processed,32);await object(c,'observations',f.prep.p_request_hash,128);
 return{...f.ids,p_response_hash:response,p_response_size:32,p_processed_hash:processed,p_processed_size:32,p_observation_hash:observation,p_observation_size:128,p_evidence:{origin:'operational',request_hash:f.prep.p_request_hash,response_hash:response,payload_hash:hash('synthetic response payload'),schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,binding_profile:c.binding_profile,rule_profile:c.rule_profile,outcome:'authorization_declared',rejection_code:null,cstat:'104',protocol_cstat:'100',protocol_number:'135260000000001',received_at:new Date().toISOString(),receipt_number:null,reference_digest:c.reference_digest,signature_verified:true,xsd_validated:true,context_matched:true,processed_xsd_validated:true,tls_origin_verified:true,transport_hash:observation,transport_size:128,can_emit:false,can_transmit:false}};
}
const priorSchemas="(n.nspname like 'erp\\_%' escape '\\' or n.nspname like 'origin\\_%' escape '\\' or n.nspname in('auth','storage','public'))";
async function schemaSnapshot(){
 return value(await run(`select jsonb_build_object(
 'schemas',(select jsonb_agg(jsonb_build_array(n.nspname,n.nspowner,n.nspacl)order by n.nspname)from pg_namespace n where ${priorSchemas}),
 'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}and c.relkind in('r','p','S','v','m')),
 'columns',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,a.attnum,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,pg_get_expr(d.adbin,d.adrelid))order by n.nspname,c.relname,a.attnum)from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where ${priorSchemas}and c.relkind in('r','p','v','m')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,k.contype,k.condeferrable,k.condeferred,k.convalidated,pg_get_constraintdef(k.oid))order by n.nspname,c.relname,k.conname)from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}and not(n.nspname='erp_fiscal_authorization'and c.relname='attempt'and k.conname='reviewed_use_time_commit'and k.contype='t')),
 'indexes',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_indexdef(i.indexrelid))order by n.nspname,c.relname,i.indexrelid)from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}),
 'policies',(select jsonb_agg(to_jsonb(p)order by p.schemaname,p.tablename,p.policyname)from pg_policies p where p.schemaname<>'erp_fiscal_authorization_revalidation'),
 'functions',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(jsonb_agg(to_jsonb(p)order by n.nspname,p.proname,p.oid)::text,'')))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${priorSchemas}and not(n.nspname='erp_fiscal_reviewed_authorization'and p.proname in('check_nfce_emission_window','guard_nfce_emission_window'))),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid))order by n.nspname,c.relname,t.tgname),'[]'::jsonb)from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and t.tgname not in('reviewed_use_time_guard','reviewed_use_time_commit')and (n.nspname like 'erp_%'or n.nspname='public')),
 'defaults',(select coalesce(jsonb_agg(to_jsonb(d)order by d.oid),'[]'::jsonb)from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace ));`));
}
async function dataSnapshot(){
 return value(await run(`create function pg_temp.snapshot()returns jsonb language plpgsql as $$declare r record;v jsonb;out jsonb:='{}';begin
 for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}and c.relkind='r'order by n.nspname,c.relname loop
 execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''order by to_jsonb(t)::text),'''')))from %I.%I t',r.nspname,r.relname)into v;
 out:=out||jsonb_build_object(r.nspname||'.'||r.relname,v);end loop;return out;end$$;select pg_temp.snapshot();`));
}
function cleanup(){
 for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}
 if(container){const own=container;container=null;execFileSync('docker',['rm','--force',own],{stdio:'pipe',timeout:15000});}
 if(nativeRoot&&existsSync(join(nativeRoot,'data','postmaster.pid'))){execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-m','immediate','-w','stop'],{env:childEnv,stdio:'pipe',timeout:15000});}
 nativeStarted=false;
 if(nativeRoot){const own=nativeRoot;nativeRoot=null;assert.match(own,/^\/Volumes\/Dev\/tmp\/brufap-emission080-[A-Za-z0-9]+$/);rmSync(own,{recursive:true});}
}
const interrupt=()=>{try{cleanup();}finally{process.exitCode=130;process.exit();}};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 if(nativeBin){
  assert.ok(isAbsolute(nativeBin));assert.match(execFileSync(join(nativeBin,'postgres'),['--version'],{env:childEnv,encoding:'utf8',timeout:5000}),/^postgres \(PostgreSQL\) 17\./);
  nativeRoot=mkdtempSync('/Volumes/Dev/tmp/brufap-emission080-');chmodSync(nativeRoot,0o700);mkdirSync(join(nativeRoot,'socket'),{mode:0o700});
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
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs','0041_a1_custody','0050_signed_fiscal_candidates','0051_fiscal_wsdl','0061_fiscal_reconciliation','0062_fiscal_protocol_operational','0064_fiscal_authorization','0068_fiscal_subset_review','0069_fiscal_reviewed_authorization','0072_fiscal_reviewed_preflight','0073_fiscal_reviewed_begin_selection','0077_fiscal_gtin_rule_profile_v2'])bootstrap+='\n'+await readFile(new URL('../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8');
 ok(await run(bootstrap));
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(fiscal)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(fiscal)},'fiscal');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);`));
 await setCompany();await confirmRegime();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;


 // Activation below exists only inside this disposable synthetic database.
 ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
 select m,4,'operational',true,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile',true,false,erp_fiscal_reviewed_authorization.manifest(m,erp_fiscal_subset_review.current_profile_hash()),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m;`));
 // Fixture-only aging simulates wall time. Production identity048 is immutable.
 const ageSql=(f,seconds)=>`alter table erp_fiscal_unsigned.identity disable trigger immutable_identity;
 update erp_fiscal_unsigned.identity i set identity=jsonb_set(identity,'{issuedAt}',to_jsonb(to_char((clock_timestamp()-interval'${seconds} seconds')at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00'))
 from erp_fiscal_unsigned.job j join erp_fiscal_signed.candidate c on c.unsigned_job_id=j.id where c.id=${quote(f.c.candidate_id)}and i.reservation_id=j.reservation_id;
 alter table erp_fiscal_unsigned.identity enable trigger immutable_identity;`;
 const age=async(f,seconds)=>ok(await run(ageSql(f,seconds)));
 const unconsumed=async f=>{
  const got=await auth('command',{p_user_id:fiscal,p_command_id:f.beginArgs.p_command_id});
  assert.equal(got.view.current.state,'request_ready');assert.equal(got.view.current.grant_consumed,false);
  assert.deepEqual(await counts(f),{bindings:1,consumes:0,results:0,observations:0});
  const intent=value(await run(`select jsonb_build_object('consumed',consumed_attempt_id)from erp_fiscal_authorization.intent where id=${quote(f.c.intent_id)};`));assert.equal(intent.consumed,null);
 };
 const expectTemporal=(r,message)=>{rejected(r,'40001');assert.ok(r.stderr.includes(message),r.stderr);};
 const old=await authorized('65');await auth('use',old.use);const oldFinish=await finishArgs(old);
 const schemaBefore=await schemaSnapshot(),dataBefore=await dataSnapshot();
 const migration=await readFile(new URL('../../supabase/migrations/202610160080_nfce_emission_window.sql',import.meta.url),'utf8');
 const body=migration.replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,'');
 ok(await run('begin;'+body+'rollback;'));assert.deepEqual(await schemaSnapshot(),schemaBefore);assert.deepEqual(await dataSnapshot(),dataBefore);
 assert.equal(ok(await run(`select count(*)from pg_trigger where tgname='reviewed_use_time_guard';`)).stdout.trim(),'0');
 ok(await run(migration));assert.deepEqual(await schemaSnapshot(),schemaBefore);assert.deepEqual(await dataSnapshot(),dataBefore);
 const acl=value(await run(`select jsonb_build_object('count',count(*),'exposed',count(*)filter(where has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE')or has_function_privilege('service_role',p.oid,'EXECUTE')or p.prosecdef is distinct from(p.proname='guard_nfce_emission_window')or p.proconfig is distinct from array['search_path=pg_catalog']or exists(select 1 from aclexplode(p.proacl)a where a.is_grantable)))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='erp_fiscal_reviewed_authorization'and p.proname in('check_nfce_emission_window','guard_nfce_emission_window');`));assert.deepEqual(acl,{count:2,exposed:0});
 results.push({scenario:'DDL_rollback_then_install_preserves_data_acl_defaults_and_old_routines',passed:true});
 {
  const f=await authorized('65');await age(f,268);const before=await dataSnapshot();
  await race('65_audit_actor_FK_wait_after_before_trigger_rolls_back_at_commit',`select id from auth.users where id=${quote(fiscal)}for update;`,authSql('use',f.use),async(_a,b)=>{
   expectTemporal(b,'nfce_emission_window_too_short');await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  },2500);
 }
 const locks={
  command:f=>`select pg_advisory_xact_lock(174852964,hashtext(${quote(f.c.command_id)}));`,
  company_mutex:()=>`select pg_advisory_xact_lock(174852920,1);`,
  membership:()=>`select user_id from erp_access.membership where user_id=${quote(fiscal)}for update;`,
  policy:f=>`select version from erp_fiscal_authorization.policy where model='65'and version=${f.c.policy_version} for update;`,
  intent:f=>`select id from erp_fiscal_authorization.intent where id=${quote(f.c.intent_id)}for update;`,
  attempt:f=>`select id from erp_fiscal_authorization.attempt where id=${quote(f.c.attempt_id)}for update;`,
  storage:f=>`select name from storage.objects where bucket_id='brufap-fiscal-artifacts'and name=${quote(`authorization/${f.c.attempt_id}/requests/${f.prep.p_request_hash}.xml`)}for update;`,
 };
 for(const [name,lock]of Object.entries(locks)){
  const f=await authorized('65');await age(f,268);const before=await dataSnapshot();
  await race('65_clock_advances_during_'+name,lock(f),authSql('use',f.use),async(_a,b)=>{
   expectTemporal(b,'nfce_emission_window_too_short');await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  },2500);
 }
 {
  const f=await authorized('65',{reviewActor:admin});await age(f,268);const before=await dataSnapshot();
  await race('direct064_reviewer_trigger_wait_precedes_final_clock',`select user_id from erp_access.membership where user_id=${quote(admin)}for update;`,roleSql(rpcSql('erp_fiscal_authorization_use',f.ids)),async(_a,b)=>{
   expectTemporal(b,'nfce_emission_window_too_short');await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  },2500);
 }
 {
  const f=await authorized('65');await age(f,268);const before=await dataSnapshot();
  await race('direct064_cannot_bypass_window_after_wait',locks.command(f),roleSql(rpcSql('erp_fiscal_authorization_use',f.ids)),async(_a,b)=>{
   expectTemporal(b,'nfce_emission_window_too_short');await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  },2500);
 }
 for(const [seconds,message]of[[301,'nfce_emission_time_expired'],[-302,'nfce_emission_time_future']]){
  const f=await authorized('65');await age(f,seconds);const before=await dataSnapshot();expectTemporal(await run(authSql('use',f.use)),message);await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  results.push({scenario:'65_'+message+'_atomic_rejection',passed:true});
 }
 {
  const f=await authorized('65');await age(f,260);const before=await dataSnapshot();
  ok(await run('begin;'+authSql('use',f.use)+'rollback;'));await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
  await auth('use',f.use);assert.equal((await counts(f)).consumes,1);rejected(await run(authSql('use',f.use)),'40001');
  await age(f,3600);const done=await auth('finish',await finishArgs(f));assert.equal(done.view.current.state,'authorized_homologation');
  results.push({scenario:'65_valid_once_explicit_transaction_rollback_and_late_finish',passed:true});
 }
 {
  const f=await authorized('55');await age(f,3600);
  await race('55_preserved_after_lock_wait',locks.command(f),authSql('use',f.use),async(_a,b)=>{ok(b);assert.equal((await counts(f)).consumes,1);});
 }
 {
  const f=await authorized('65'),before=await dataSnapshot();
  await race('65_revocation_after_wait_remains_authoritative',`update erp_access.membership set active=false where user_id=${quote(fiscal)};`,authSql('use',f.use),async(_a,b)=>{rejected(b,'42501');});
  ok(await run(`update erp_access.membership set active=true where user_id=${quote(fiscal)};`));await unconsumed(f);assert.deepEqual(await dataSnapshot(),before);
 }
 {
  await age(old,3600);await rpc('erp_a1_disable',await disableArgs());
  ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)select model,5,origin,false,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile from erp_fiscal_authorization.policy where model='65'and version=4;`));
  const stored=await auth('finish',oldFinish);assert.equal(stored.view.current.state,'authorized_homologation');assert.equal((await auth('finish',oldFinish)).view.replayed,true);
  assert.deepEqual((await auth('command',{p_user_id:fiscal,p_command_id:old.beginArgs.p_command_id})).view.artifact,stored.view.artifact);
  const history=await auth('history',{p_user_id:fiscal,p_candidate_id:old.c.candidate_id,p_limit:25,p_before:null});assert.deepEqual(history.page.items[0].artifact,stored.view.artifact);
  results.push({scenario:'pre080_consumption_historical_finish_read_replay_after_expiry_A1_policy_change',passed:true});
 }
 assert.deepEqual(await schemaSnapshot(),schemaBefore);
 const totals=value(await run(`select jsonb_build_object('attempts',(select count(*)from erp_fiscal_authorization.attempt),'consumes',(select count(*)from erp_fiscal_authorization.audit where action='consume'),'results',(select count(*)from erp_fiscal_authorization.result),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title));`));
 assert.equal(totals.attempts,16);assert.equal(totals.consumes,3);assert.equal(totals.results,2);assert.equal(totals.stock,0);assert.equal(totals.finance,0);
 console.log(JSON.stringify({synthetic_fixture:true,multi_session:true,postgres:nativeBin?'17-native':'17-alpine',network:nativeBin?'private_unix_socket_no_tcp':'none',source_sha256:hash(migration),prior_schema_unchanged_except_two_named_triggers:true,no_grant_option:true,scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
