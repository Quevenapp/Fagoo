// 079 stored-response revalidation concurrency checker. Docker by default; an explicit local PG17 binary is optional.
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

const name='brufap-revalidation079-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),fiscal=randomUUID(),sessions=new Set(),results=[];
let container=null;
const nativeBin=process.env.BRUFAP_TEST_PG17_BIN??null;
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
let nativeRoot=null,nativeStarted=false;
const nativePort='56479';
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
 const first=session(),application='revalidation079_'+randomUUID();let ended=false,second;
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
async function object(c,kind,tag,size){ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote(`authorization/${c.attempt_id}/${kind}/${tag}.${kind==='observations'?'json':'xml'}`)},${quote({size,mimetype:'application/octet-stream'})})on conflict do nothing;`));}
async function finishArgs(f){const c=f.c,response=hash('synthetic response '+c.batch_id),processed=hash('synthetic processed '+c.batch_id),observation=hash('synthetic observation '+c.batch_id);await object(c,'responses',f.prep.p_request_hash,32);await object(c,'processed',processed,32);await object(c,'observations',f.prep.p_request_hash,128);
 return{...f.ids,p_response_hash:response,p_response_size:32,p_processed_hash:processed,p_processed_size:32,p_observation_hash:observation,p_observation_size:128,p_evidence:{origin:'operational',request_hash:f.prep.p_request_hash,response_hash:response,payload_hash:hash('synthetic response payload'),schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,binding_profile:c.binding_profile,rule_profile:c.rule_profile,outcome:'authorization_declared',rejection_code:null,cstat:'104',protocol_cstat:'100',protocol_number:'135260000000001',received_at:new Date().toISOString(),receipt_number:null,reference_digest:c.reference_digest,signature_verified:true,xsd_validated:true,context_matched:true,processed_xsd_validated:true,tls_origin_verified:true,transport_hash:observation,transport_size:128,can_emit:false,can_transmit:false}};
}
const nextReview=f=>({...f.reviewArgs,p_command_id:randomUUID(),p_expected_review_version:1});
const counts=async f=>value(await run(`select jsonb_build_object('bindings',(select count(*) from erp_fiscal_reviewed_authorization.review_binding where attempt_id=${quote(f.c.attempt_id)}),'consumes',(select count(*)from erp_fiscal_authorization.audit where attempt_id=${quote(f.c.attempt_id)}and action='consume'),'results',(select count(*)from erp_fiscal_authorization.result where attempt_id=${quote(f.c.attempt_id)}),'observations',(select count(*)from erp_fiscal_reviewed_authorization.observation where attempt_id=${quote(f.c.attempt_id)}));`));
const REVALIDATION='erp_fiscal_reviewed_authorization_revalidation_';
const PRIVATE='erp_fiscal_authorization_revalidation';
const revalidation=(action,args)=>rpc(REVALIDATION+action,args);
const revalidationSql=(action,args)=>roleSql(rpcSql(REVALIDATION+action,args));
const priorSchemas="(n.nspname like 'erp\\_%' escape '\\' or n.nspname like 'origin\\_%' escape '\\' or n.nspname in('auth','storage','public'))and n.nspname<>'erp_fiscal_authorization_revalidation'";
async function schemaSnapshot(){
 return value(await run(`select jsonb_build_object(
 'schemas',(select jsonb_agg(jsonb_build_array(n.nspname,n.nspowner,n.nspacl)order by n.nspname)from pg_namespace n where ${priorSchemas}),
 'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.reloptions)order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}and c.relkind in('r','p','S','v','m')),
 'columns',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,a.attnum,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,pg_get_expr(d.adbin,d.adrelid))order by n.nspname,c.relname,a.attnum)from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where ${priorSchemas}and c.relkind in('r','p','v','m')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,k.contype,k.condeferrable,k.condeferred,k.convalidated,pg_get_constraintdef(k.oid))order by n.nspname,c.relname,k.conname)from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}),
 'indexes',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_indexdef(i.indexrelid))order by n.nspname,c.relname,i.indexrelid)from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}),
 'policies',(select jsonb_agg(to_jsonb(p)order by p.schemaname,p.tablename,p.policyname)from pg_policies p where p.schemaname<>'erp_fiscal_authorization_revalidation'),
 'functions',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(jsonb_agg(to_jsonb(p)order by n.nspname,p.proname,p.oid)::text,'')))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${priorSchemas}and not(n.nspname='public'and p.proname like '${REVALIDATION}%')),
 'defaults',(select coalesce(jsonb_agg(to_jsonb(d)order by d.oid),'[]'::jsonb)from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where n.nspname is distinct from '${PRIVATE}'));`));
}
async function dataSnapshot(){
 return value(await run(`create function pg_temp.snapshot()returns jsonb language plpgsql as $$declare r record;v jsonb;out jsonb:='{}';begin
 for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${priorSchemas}and c.relkind='r'order by n.nspname,c.relname loop
 execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''order by to_jsonb(t)::text),'''')))from %I.%I t',r.nspname,r.relname)into v;
 out:=out||jsonb_build_object(r.nspname||'.'||r.relname,v);end loop;return out;end$$;select pg_temp.snapshot();`));
}
async function checkAcl(){
 const a=value(await run(`select jsonb_build_object(
 'rpc_count',(select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like '${REVALIDATION}%'),
 'invalid_rpc',(select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname like '${REVALIDATION}%'and(not p.prosecdef or p.proconfig is distinct from array['search_path=pg_catalog']or has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE')or not has_function_privilege('service_role',p.oid,'EXECUTE')or exists(select 1 from aclexplode(p.proacl)g where g.is_grantable))),
 'helper_exposed',(select count(*)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='${PRIVATE}'and(has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE')or has_function_privilege('service_role',p.oid,'EXECUTE'))),
 'table_private',(select c.relrowsecurity and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')from pg_class c where c.oid='${PRIVATE}.command'::regclass),
 'schema_private',not has_schema_privilege('anon','${PRIVATE}','USAGE')and not has_schema_privilege('authenticated','${PRIVATE}','USAGE')and not has_schema_privilege('service_role','${PRIVATE}','USAGE'));`));
 assert.deepEqual(a,{rpc_count:3,invalid_rpc:0,helper_exposed:0,table_private:true,schema_private:true});
 ok(await run(`begin;create table ${PRIVATE}.default_probe(id integer);create function ${PRIVATE}.default_probe()returns int language sql as $$select 1$$;do $$begin
 if has_table_privilege('anon','${PRIVATE}.default_probe','SELECT,INSERT,UPDATE,DELETE')or has_table_privilege('authenticated','${PRIVATE}.default_probe','SELECT,INSERT,UPDATE,DELETE')or has_table_privilege('service_role','${PRIVATE}.default_probe','SELECT,INSERT,UPDATE,DELETE')then raise exception'private table default privileges widened';end if;end$$;rollback;`));
 // Schema-local REVOKE cannot subtract the global PUBLIC EXECUTE default.
 // Explicit existing helper revokes are checked above; future helpers remain
 // inaccessible through the private schema, while global defaults stay intact.
 for(const role of ['anon','authenticated','service_role'])rejected(await run(`begin;create function ${PRIVATE}.future_probe()returns int language sql as $$select 1$$;set local role ${role};select ${PRIVATE}.future_probe();rollback;`),'42501');
}
const newCount=async f=>Number(ok(await run(`select count(*)from ${PRIVATE}.command where attempt_id=${quote(f.c.attempt_id)};`)).stdout.trim());
async function freshRevalidation(model){
 const f=await authorized(model);await auth('use',f.use);const good=await finishArgs(f);
 const bad={...good,p_processed_hash:null,p_processed_size:null,p_evidence:{...good.p_evidence,outcome:'invalid_response',rejection_code:'SOAP_INVALID',payload_hash:null,cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null,reference_digest:null,signature_verified:false,xsd_validated:false,context_matched:false,processed_xsd_validated:false}};
 const old=await auth('finish',bad),contextArgs={p_user_id:fiscal,p_authorization_command_id:f.beginArgs.p_command_id,p_expected_attempt_id:f.c.attempt_id};
 const context=await revalidation('context',contextArgs),parser=context.parser_profile,manifest=context.parser_manifest_hash;
 const args={p_user_id:fiscal,p_command_id:randomUUID(),p_authorization_command_id:f.beginArgs.p_command_id,p_expected_attempt_id:f.c.attempt_id,p_expected_source_hash:context.source_hash,p_parser_profile:parser,p_parser_manifest_hash:manifest,p_evidence:good.p_evidence,p_processed_hash:good.p_processed_hash,p_processed_size:good.p_processed_size,p_confirmed:true};
 const key=`revalidations/${f.c.attempt_id}/${manifest}/processed/${good.p_processed_hash}.xml`;
 ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote(key)},${quote({size:good.p_processed_size,mimetype:'application/octet-stream'})});`));
 return{...f,good,bad,old,args,key,context,contextArgs};
}
async function preserved(before){assert.deepEqual(await dataSnapshot(),before);}
function cleanup(){
 for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}
 if(container){const own=container;container=null;execFileSync('docker',['rm','--force',own],{stdio:'pipe',timeout:15000});}
 if(nativeRoot&&existsSync(join(nativeRoot,'data','postmaster.pid'))){execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-m','immediate','-w','stop'],{env:childEnv,stdio:'pipe',timeout:15000});}
 nativeStarted=false;
 if(nativeRoot){const own=nativeRoot;nativeRoot=null;assert.match(own,/^\/Volumes\/Dev\/tmp\/brufap-revalidation079-[A-Za-z0-9]+$/);rmSync(own,{recursive:true});}
}
const interrupt=()=>{try{cleanup();}finally{process.exitCode=130;process.exit();}};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 if(nativeBin){
  assert.ok(isAbsolute(nativeBin));assert.match(execFileSync(join(nativeBin,'postgres'),['--version'],{env:childEnv,encoding:'utf8',timeout:5000}),/^postgres \(PostgreSQL\) 17\./);
  nativeRoot=mkdtempSync('/Volumes/Dev/tmp/brufap-revalidation079-');chmodSync(nativeRoot,0o700);mkdirSync(join(nativeRoot,'socket'),{mode:0o700});
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
 const schemaBefore=await schemaSnapshot(),dataBefore=await dataSnapshot();
 const migration=await readFile(new URL('../../supabase/migrations/202610160079_fiscal_stored_response_revalidation.sql',import.meta.url),'utf8');
 ok(await run(migration));assert.deepEqual(await schemaSnapshot(),schemaBefore);assert.deepEqual(await dataSnapshot(),dataBefore);
 await checkAcl();results.push({scenario:'DDL_preserves_existing_schema_data_and_acl',passed:true});
 ok(await run(`insert into auth.users values(${quote(admin)}),(${quote(fiscal)});insert into erp_access.membership(user_id,role)values(${quote(admin)},'admin'),(${quote(fiscal)},'fiscal');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream']);`));
 await setCompany();await confirmRegime();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;


 // Activation below exists only inside this disposable synthetic database.
 ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)
 select m,4,'operational',true,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile',true,false,erp_fiscal_reviewed_authorization.manifest(m,erp_fiscal_subset_review.current_profile_hash()),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m;`));
 for(const model of ['55','65']){
  const commandLock=f=>`select pg_advisory_xact_lock(174852979,hashtext(${quote(f.args.p_command_id)}));`;
  {
   const f=await freshRevalidation(model),before=await dataSnapshot();
   await race(`${model}_same_UUID_one_append`,revalidationSql('finish',f.args),revalidationSql('finish',f.args),async(a,b)=>{
    const first=value(a),second=value(b);assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.deepEqual(first.receipt,second.receipt);assert.equal(await newCount(f),1);
    const read=await revalidation('command',{p_user_id:fiscal,p_command_id:f.args.p_command_id}),context=await revalidation('context',f.contextArgs);assert.equal(read.read_only,true);assert.deepEqual(read.receipt,first.receipt);assert.equal(context.can_revalidate,false);assert.deepEqual(context.existing.receipt,first.receipt);
   });await preserved(before);
   for(const statement of[`update ${PRIVATE}.command set source_hash=${quote(hash('tamper'))}where id=${quote(f.args.p_command_id)};`,`delete from ${PRIVATE}.command where id=${quote(f.args.p_command_id)};`])rejected(await run(statement),'42501');
   for(const action of ['context','command']){
    const args=action==='context'?{...f.contextArgs,p_user_id:admin}:{p_user_id:admin,p_command_id:f.args.p_command_id};rejected(await run(revalidationSql(action,args)),'42501');
   }
   await preserved(before);
  }
  {
   const f=await freshRevalidation(model),before=await dataSnapshot(),changed={...f.args,p_evidence:{...f.args.p_evidence,protocol_number:'135260000000002'}};
   await race(`${model}_same_UUID_different_evidence_conflicts`,revalidationSql('finish',f.args),revalidationSql('finish',changed),async(_a,b)=>{rejected(b,'40001');assert.equal(await newCount(f),1);});await preserved(before);
  }
  {
   const f=await freshRevalidation(model),before=await dataSnapshot();
   await race(`${model}_different_UUID_same_attempt_profile_conflicts`,revalidationSql('finish',f.args),revalidationSql('finish',{...f.args,p_command_id:randomUUID()}),async(_a,b)=>{rejected(b,'40001');assert.equal(await newCount(f),1);});await preserved(before);
  }
  for(const patch of ['source_hash','attempt_id']){
   const f=await freshRevalidation(model),before=await dataSnapshot(),bad={...f.args,...(patch==='source_hash'?{p_expected_source_hash:hash('different source')}:{p_expected_attempt_id:randomUUID()})};
   await race(`${model}_${patch}_CAS_after_wait`,commandLock(f),revalidationSql('finish',bad),async(_a,b)=>{rejected(b,'40001');assert.equal(await newCount(f),0);});await preserved(before);
  }
  for(const boundary of ['command','global','membership','replay']){
   const f=await freshRevalidation(model);if(boundary==='replay')await revalidation('finish',f.args);
   const before=await dataSnapshot(),lock=boundary==='global'?'select pg_advisory_xact_lock(174852920,1);':boundary==='membership'?'':commandLock(f);
   const revoke=`update erp_access.membership set active=false where user_id=${quote(fiscal)};`;
   try{await race(`${model}_ACL_after_${boundary}_wait`,lock+revoke,revalidationSql('finish',f.args),async(_a,b)=>{rejected(b,'42501');assert.equal(await newCount(f),boundary==='replay'?1:0);});}
   finally{ok(await run(`update erp_access.membership set active=true where user_id=${quote(fiscal)};`));}
   await preserved(before);
  }
  for(const part of ['processed','response']){
   const f=await freshRevalidation(model),before=await dataSnapshot(),key=part==='processed'?f.key:`authorization/${f.c.attempt_id}/responses/${f.prep.p_request_hash}.xml`,size=part==='processed'?f.good.p_processed_size:f.good.p_response_size;
   const original=value(await run(`select jsonb_build_object('metadata',metadata)from storage.objects where bucket_id='brufap-fiscal-artifacts'and name=${quote(key)};`)).metadata;
   try{await race(`${model}_${part}_metadata_changed_during_storage_wait`,`update storage.objects set metadata=jsonb_set(metadata,'{size}',to_jsonb(${size+1}))where bucket_id='brufap-fiscal-artifacts'and name=${quote(key)};`,revalidationSql('finish',f.args),async(_a,b)=>{rejected(b,'40001');assert.equal(await newCount(f),0);});}
   finally{ok(await run(`update storage.objects set metadata=${quote(original)}where bucket_id='brufap-fiscal-artifacts'and name=${quote(key)};`));}
   await preserved(before);
  }
  {
   const f=await freshRevalidation(model),before=await dataSnapshot();
   try{await race(`${model}_finish_holds_membership_until_commit`,revalidationSql('finish',f.args),`update erp_access.membership set active=false where user_id=${quote(fiscal)};`,async(a,b)=>{assert.equal(value(a).receipt.state,'authorized_homologation');ok(b);assert.equal(await newCount(f),1);rejected(await run(revalidationSql('command',{p_user_id:fiscal,p_command_id:f.args.p_command_id})),'42501');});}
   finally{ok(await run(`update erp_access.membership set active=true where user_id=${quote(fiscal)};`));}
   await preserved(before);assert.equal((await revalidation('command',{p_user_id:fiscal,p_command_id:f.args.p_command_id})).receipt.state,'authorized_homologation');
  }
  {
   const f=await freshRevalidation(model);await review('save',nextReview(f));await rpc('erp_a1_disable',await disableArgs());
   ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)select model,5,origin,false,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile from erp_fiscal_authorization.policy where model=${quote(model)}and version=4;`));
   const before=await dataSnapshot();assert.deepEqual((await revalidation('context',f.contextArgs)).source,f.context.source);
   const saved=await revalidation('finish',f.args);assert.equal(saved.receipt.state,'authorized_homologation');assert.deepEqual((await revalidation('finish',f.args)).receipt,saved.receipt);assert.deepEqual((await revalidation('command',{p_user_id:fiscal,p_command_id:f.args.p_command_id})).receipt,saved.receipt);await preserved(before);
   results.push({scenario:`${model}_historical_read_replay_after_new_review_A1_and_policy_disable`,passed:true});
  }
 }
 await checkAcl();assert.deepEqual(await schemaSnapshot(),schemaBefore);
 const totals=value(await run(`select jsonb_build_object('revalidations',(select count(*)from ${PRIVATE}.command),'attempts',(select count(*)from erp_fiscal_authorization.attempt),'original_results',(select count(*)from erp_fiscal_authorization.result),'original_review_required',(select count(*)from erp_fiscal_authorization.attempt where state='review_required'),'consumes',(select count(*)from erp_fiscal_authorization.audit where action='consume'),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title));`));
 assert.equal(totals.attempts,26);assert.equal(totals.original_results,26);assert.equal(totals.original_review_required,26);assert.equal(totals.consumes,26);assert.equal(totals.revalidations,12);assert.equal(totals.stock,0);assert.equal(totals.finance,0);
 console.log(JSON.stringify({synthetic_fixture:true,multi_session:true,postgres:nativeBin?'17-native':'17-alpine',network:nativeBin?'private_unix_socket_no_tcp':'none',storage:nativeBin?'private_temporary_cluster':'tmpfs',tls_performed:false,source_sha256:hash(migration),prior_schema_unchanged:true,prior_tables_unchanged_per_operation:true,no_grant_option:true,future_function_global_execute_default_not_overridden:true,private_schema_blocks_future_helpers:true,scenarios:results,totals},null,2));
}finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);cleanup();}
