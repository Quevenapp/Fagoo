// 089 receipt-query concurrency checker: synthetic disposable PostgreSQL17, Unix socket only.
// Exclusively synthetic metadata, no TLS handshake or SOAP dispatch.
// Only synthetic metadata is loaded;
// no certificate bytes, network, host ports, bind mounts or persistent volumes.
import {spawn,execFileSync} from 'node:child_process';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {bootstrap} from './helpers/stock-reservation-fixture.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../../packages/fiscal-authorization/src/receipt-query-manifest.mjs';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE} from '../../packages/fiscal-authorization/src/validator.mjs';
import {canonical,SUBSET_SCHEMA} from '../../packages/fiscal-authorization/src/subset-review-dto.mjs';
import {RULE_PROFILE_V2_HASH as SP_CRT1_RULE_MANIFEST_HASH} from '../../packages/fiscal-authorization/src/rule-profile-registry.mjs';

const name='brufap-receipt-query089-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),fiscal=randomUUID(),sessions=new Set(),results=[];
let container=null;
const nativeBin=process.env.BRUFAP_TEST_PG17_BIN??null;
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
let nativeRoot=null,nativeStarted=false;
const nativePort='56589';
assert.ok(nativeBin && isAbsolute(nativeBin),'Explicit native PG17 binaries required; no Docker fallback is used.');
const hash=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>v===null?'NULL':typeof v==='boolean'||typeof v==='number'?String(v):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const rpcSql=(rpc,args)=>{assert.match(rpc,/^erp_[a-z0-9_]+$/);return`select public.${rpc}(${Object.entries(args).map(([key,value])=>{assert.match(key,/^p_[a-z0-9_]+$/);return key+'=>'+quote(value);}).join(',')});`;};
const roleSql=sql=>`set role service_role; ${sql}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function session(){
 assert.ok(nativeStarted&&nativeRoot);
 const client=['-XAtq','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'];
 const child=spawn(join(nativeBin,'psql'),['-h',join(nativeRoot,'socket'),'-p',nativePort,...client],{env:childEnv,stdio:['pipe','pipe','pipe']});
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
 const first=session(),application='receipt_query089_'+randomUUID();let ended=false,second;
 first.write(`begin;set local lock_timeout='12s';set local statement_timeout='20s';${firstSql}\n\\echo FIRST_DONE`);
 try{
  await first.marker('FIRST_DONE');
  second=run(`set application_name=${quote(application)};set lock_timeout='12s';set statement_timeout='20s';${secondSql}`);
  await waiting(application);if(typeof waitMs==='function')await waitMs();else if(waitMs)await pause(waitMs);first.end('commit;');ended=true;
  const [a,b]=await Promise.all([first.done,second]);ok(a);await check(a,b);
  results.push({scenario,lock_wait_observed:true,passed:true});process.stderr.write('PASS '+scenario+'\n');
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

const Q='erp_fiscal_receipt_query_',S='erp_fiscal_receipt_query',exports089=[];
const query=(action,args)=>rpc(Q+action,args),querySql=(action,args)=>roleSql(rpcSql(Q+action,args));
const scalar=async s=>ok(await run(s)).stdout.trim();
const commandLock=id=>`select pg_advisory_xact_lock(174852989,hashtext(${quote(id)}));`;
const globalLock="select pg_advisory_xact_lock(174852920,1);";
const userLock=`select id from auth.users where id='${fiscal}' for update;`;
const memberLock=`select user_id from erp_access.membership where user_id='${fiscal}' for update;`;
const revoke=`update erp_access.membership set active=false where user_id='${fiscal}';`;
const restore=()=>run(`update erp_access.membership set active=true where user_id='${fiscal}';`).then(ok);
const pending=e=>({...e,outcome:'receipt_pending',cstat:'103',receipt_number:'035000000000001',protocol_cstat:null,protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false});
async function querySource(model='55',kind='authorization'){
 let f,selected;
 if(kind==='revalidation'){
  f=await freshRevalidation(model);
  selected=await revalidation('finish',{...f.args,p_evidence:pending(f.good.p_evidence),p_processed_hash:null,p_processed_size:null});
 }else{
  f=await authorized(model,{reviewActor:admin});await auth('use',f.use);const good=await finishArgs(f);
  await auth('finish',{...good,p_evidence:pending(good.p_evidence),p_processed_hash:null,p_processed_size:null});
 }
 const contextArgs={p_user_id:fiscal,p_source_kind:kind,p_source_command_id:kind==='authorization'?f.beginArgs.p_command_id:selected.command_id,p_expected_attempt_id:f.c.attempt_id};
 const context=await query('context',contextArgs),s=context.source,e=kind==='authorization'?s.original_source.artifact.evidence:s.selected_revalidation.receipt.evidence;
 const validation={profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,source_binding_hash:s.source_binding_hash,payload_hash:e.payload_hash,receipt_number:e.receipt_number,tmed_seconds:0,received_at:e.received_at,observed_at:new Date(Date.now()-120000).toISOString(),signature_verified:true,xsd_validated:true,context_matched:true,tls_origin_verified:true,tax_rules_validated:false,can_query:false,can_emit:false,can_transmit:false};
 return{f,contextArgs,context,validation};
}
const beginArgs=async x=>({p_user_id:fiscal,p_command_id:randomUUID(),p_selection:(await query('context',x.contextArgs)).selection,p_source_validation:x.validation,p_confirmed:true});
const begin=async x=>{const args=await beginArgs(x);return{args,value:await query('begin',args)};};
const ids=b=>({p_user_id:fiscal,p_query_id:b.value.query_id,p_lease_id:b.value.recovery.lease_id});
const queryKey=(b,kind,tag)=>`receipt-queries/${b.value.query_id}/${kind}/${tag}.${kind==='observations'?'json':'xml'}`;
async function queryObject(b,kind,tag,size=32){const key=queryKey(b,kind,tag);ok(await run(`insert into storage.objects values('brufap-fiscal-artifacts',${quote(key)},${quote({size,mimetype:'application/octet-stream'})})on conflict do nothing;`));return key;}
async function prepare(b){const c=b.value.recovery,sha=hash('same SOAP '+c.receipt_number),args={...ids(b),p_request_hash:sha,p_request_size:32,p_evidence:{profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,...Object.fromEntries(['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]])),request_hash:sha,payload_hash:hash('consReci '+c.receipt_number),signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false}};await queryObject(b,'requests',sha);return{args,value:await query('prepare',args)};}
const use=b=>query('use',ids(b));
async function queryFinishArgs(b,p,variant='105'){
 const c=b.value.recovery,authorized=['100','150'].includes(variant),rejected=variant==='245',rh=hash('response '+c.query_id+variant),oh=hash('observation '+c.query_id),ph=authorized?hash('processed '+c.query_id):null;
 const evidence={profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,...Object.fromEntries(['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]])),request_hash:p.args.p_request_hash,response_hash:rh,payload_hash:hash('retCons '+variant),outcome:authorized?'authorization_declared':rejected?'rejected':variant==='106'?'review_required':'receipt_pending',rejection_code:null,cstat:authorized||rejected?'104':variant,protocol_cstat:authorized||rejected?variant:null,protocol_number:authorized?'135260000000001':null,received_at:'2026-10-17T12:00:00.000Z',reference_digest:authorized?c.reference_digest:null,signature_verified:authorized,xsd_validated:true,context_matched:true,processed_xsd_validated:authorized,tls_origin_verified:true,observation_hash:oh,observation_size:128,tax_rules_validated:false,can_emit:false,can_transmit:false};
 await queryObject(b,'responses',p.args.p_request_hash);await queryObject(b,'observations',p.args.p_request_hash,128);if(ph)await queryObject(b,'processed',ph);
 return{...ids(b),p_response_hash:rh,p_response_size:32,p_observation_hash:oh,p_observation_size:128,p_evidence:evidence,p_processed_hash:ph,p_processed_size:ph?32:null};
}
async function age(b,seconds=120){ok(await run(`begin;alter table ${S}.query disable trigger guard_query;update ${S}.query set created_at=created_at-interval'${seconds}seconds',expires_at=expires_at-interval'${seconds}seconds',used_at=used_at-interval'${seconds}seconds',finished_at=finished_at-interval'${seconds}seconds',receipt=jsonb_set(jsonb_set(receipt,'{created_at}',to_jsonb(created_at-interval'${seconds}seconds')),'{expires_at}',to_jsonb(expires_at-interval'${seconds}seconds'))where id=${quote(b.value.query_id)};alter table ${S}.query enable trigger guard_query;commit;`));}
async function expiresSoon(b,seconds=1.5){ok(await run(`begin;alter table ${S}.query disable trigger guard_query;with at as(select clock_timestamp()+interval'${seconds}seconds' expires)update ${S}.query q set created_at=at.expires-interval'60seconds',expires_at=at.expires,receipt=jsonb_set(jsonb_set(receipt,'{created_at}',to_jsonb(at.expires-interval'60seconds')),'{expires_at}',to_jsonb(at.expires))from at where q.id=${quote(b.value.query_id)};alter table ${S}.query enable trigger guard_query;commit;`));}
const state=async b=>value(await run(`select jsonb_build_object('state',q.state,'used_at',q.used_at,'finalize_hash',q.finalize_hash,'consumes',(select count(*)from ${S}.audit where query_id=q.id and action='consume'),'results',(select count(*)from ${S}.result where query_id=q.id))from ${S}.query q where id=${quote(b.value.query_id)};`));
const originalTables="(n.nspname~'^(erp|origin)_'or n.nspname in('auth','storage','public'))and n.nspname<>'erp_fiscal_receipt_query'";
async function dataSnapshot(){return value(await run(`create function pg_temp.snapshot()returns jsonb language plpgsql as $$declare r record;v jsonb;out jsonb:='{}';begin for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${originalTables}and c.relkind='r'order by n.nspname,c.relname loop execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(t)::text,E''\\n''order by to_jsonb(t)::text),'''')))from %I.%I t',r.nspname,r.relname)into v;out:=out||jsonb_build_object(r.nspname||'.'||r.relname,v);end loop;return out;end$$;select pg_temp.snapshot();`));}
async function catalogSnapshot(){return value(await run(`select jsonb_build_object('functions',(select jsonb_build_object('count',count(*),'hash',md5(coalesce(jsonb_agg(to_jsonb(p)order by p.oid)::text,'')))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${originalTables}and not(n.nspname='public'and p.proname like '${Q}%')),'defaults',(select coalesce(jsonb_agg(to_jsonb(d)order by d.oid),'[]')from pg_default_acl d where d.defaclnamespace is distinct from to_regnamespace('${S}')),'schemas',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl)order by nspname)from pg_namespace where nspname~'^(erp|origin)_'and nspname<>'${S}'),'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${originalTables}and c.relkind='r'));`));}
async function preserved(before){assert.deepEqual(await dataSnapshot(),before);}
async function checkAcl(){const a=value(await run(`select jsonb_build_object('rpcs',(select count(*)from pg_proc p where pronamespace='public'::regnamespace and proname like '${Q}%'),'invalid_rpcs',(select count(*)from pg_proc p where pronamespace='public'::regnamespace and proname like '${Q}%'and(not prosecdef or proconfig is distinct from array['search_path=pg_catalog','TimeZone=UTC']or has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE')or not has_function_privilege('service_role',p.oid,'EXECUTE')or exists(select 1 from aclexplode(proacl)where is_grantable))),'exposed_helpers',(select count(*)from pg_proc p where pronamespace='${S}'::regnamespace and(has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE')or has_function_privilege('service_role',p.oid,'EXECUTE'))),'tables',(select count(*)from pg_class where relnamespace='${S}'::regnamespace and relkind='r'),'bad_tables',(select count(*)from pg_class c where relnamespace='${S}'::regnamespace and relkind='r'and(not relrowsecurity or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')or exists(select 1 from aclexplode(relacl)where is_grantable))),'enabled',(select count(*)from ${S}.policy where enabled));`));assert.deepEqual(a,{rpcs:8,invalid_rpcs:0,exposed_helpers:0,tables:5,bad_tables:0,enabled:0});}
async function policy(enabled=true){ok(await run(`insert into ${S}.policy select model,(select max(version)+1 from ${S}.policy),${enabled},profile,manifest_hash,origin,binding_profile,lease_seconds,cadence_seconds,max_queries_per_hour,clock_timestamp()-interval'1day',clock_timestamp()+interval'1day',clock_timestamp()from ${S}.policy where version=1;`));}
function cleanup(){for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}if(nativeRoot&&existsSync(join(nativeRoot,'data','postmaster.pid')))execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-m','immediate','-w','stop'],{env:childEnv,stdio:'pipe',timeout:15000});nativeStarted=false;if(nativeRoot){assert.match(nativeRoot,/^\/Volumes\/Dev\/tmp\/brufap-receipt-query089-[A-Za-z0-9]+$/);rmSync(nativeRoot,{recursive:true});nativeRoot=null;}}
const interrupt=()=>{try{cleanup();}finally{process.exit(130);}};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 assert.match(execFileSync(join(nativeBin,'postgres'),['--version'],{env:childEnv,encoding:'utf8',timeout:5000}),/^postgres \(PostgreSQL\) 17\./);
 nativeRoot=mkdtempSync('/Volumes/Dev/tmp/brufap-receipt-query089-');chmodSync(nativeRoot,0o700);mkdirSync(join(nativeRoot,'socket'),{mode:0o700});
 execFileSync(join(nativeBin,'initdb'),['-D',join(nativeRoot,'data'),'-U','postgres','-A','trust','--encoding=UTF8','--locale=C'],{env:childEnv,stdio:'pipe',timeout:30000});
 nativeStarted=true;execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-l',join(nativeRoot,'postgres.log'),'-o',`-c listen_addresses='' -k ${join(nativeRoot,'socket')} -p ${nativePort} -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -c timezone=UTC`,'-w','start'],{env:childEnv,stdio:'pipe',timeout:15000});
 execFileSync(join(nativeBin,'createdb'),['-h',join(nativeRoot,'socket'),'-p',nativePort,'-U','postgres',database],{env:childEnv,stdio:'pipe',timeout:5000});assert.equal(await scalar('show listen_addresses;'),'');
 ok(await run(bootstrap));const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=88).sort();assert.equal(files.length,88);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 const catalogBefore=await catalogSnapshot(),emptyBefore=await dataSnapshot(),source=await readFile(new URL('202610160089_fiscal_receipt_query.sql',dir),'utf8');
 const sourceHash=hash(source);assert.equal(sourceHash,process.env.BRUFAP_TEST_RECEIPT_SQL_SHA,'Pass the frozen author SQL hash explicitly');
 ok(await run(source));assert.deepEqual(await catalogSnapshot(),catalogBefore);await preserved(emptyBefore);await checkAcl();results.push({scenario:'DDL_159_prior_relations_and_routine_OIDs_ACLs_defaults_preserved',passed:true,prior_relations:Object.keys(emptyBefore).length});
 ok(await run(`insert into auth.users values('${admin}'),('${fiscal}');insert into erp_access.membership(user_id,role)values('${admin}','admin'),('${fiscal}','fiscal');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream'])on conflict do nothing;`));
 await setCompany();await confirmRegime();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)select m,4,'operational',true,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile',true,false,erp_fiscal_reviewed_authorization.manifest(m,erp_fiscal_subset_review.current_profile_hash()),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m;`));await policy();
 for(const model of['55','65'])for(const kind of['authorization','revalidation']){
  const x=await querySource(model,kind),a=await beginArgs(x),before=await dataSnapshot();
  let b;await race(`${model}_${kind}_same_UUID_single_grant`,querySql('begin',a),querySql('begin',a),async(one,two)=>{const v=value(one),r=value(two);assert.equal(v.replayed,false);assert.equal(r.replayed,true);assert.equal(r.execution,null);assert.deepEqual(r.receipt,v.receipt);b={args:a,value:v};});
  const p=await prepare(b);await use(b);const f=await queryFinishArgs(b,p,model==='55'?'100':'150');
  // Metadata was inserted after snapshot, so preservation below captures all original rows at this point.
  const beforeFinish=await dataSnapshot();await race(`${model}_${kind}_finish_ACK_replay`,querySql('finish',f),querySql('finish',f),async(one,two)=>{assert.equal(value(one).replayed,false);assert.equal(value(two).replayed,true);assert.deepEqual(value(one).artifact,value(two).artifact);});await preserved(beforeFinish);
  const cmd=await query('command',{p_user_id:fiscal,p_command_id:a.p_command_id});assert.equal(cmd.read_only,true);assert.equal(cmd.execution,null);assert.equal(cmd.current.state,'authorized_homologation');
  exports089.push({model,source_kind:kind,context:x.context,command:cmd,history:await query('history',{p_user_id:fiscal,p_authorization_command_id:x.f.beginArgs.p_command_id,p_expected_attempt_id:x.f.c.attempt_id,p_limit:25,p_before:null})});
  rejected(await run(querySql('begin',{...a,p_source_validation:{...a.p_source_validation,tmed_seconds:1}})),'40001');
  rejected(await run(querySql('command',{p_user_id:admin,p_command_id:a.p_command_id})),'42501');
  assert.equal((await dataSnapshot())['erp_fiscal_authorization.attempt'].count,before['erp_fiscal_authorization.attempt'].count);
 }
 {
  const x=await querySource(),a=await beginArgs(x),other={...a,p_command_id:randomUUID()},before=await dataSnapshot();
  await race('same_source_different_UUID_chain_CAS',querySql('begin',a),querySql('begin',other),async(_,r)=>rejected(r,'40001'));await preserved(before);
 }
 for(const [label,lock]of[['command',a=>commandLock(a.p_command_id)],['global',()=>globalLock],['auth_user',()=>userLock]]){
  const x=await querySource(),a=await beginArgs(x),before=await dataSnapshot();
  await race(`begin_revoked_after_${label}`,lock(a),querySql('begin',a),async(_,r)=>rejected(r,'42501'),async()=>ok(await run(revoke)));await restore();await preserved(before);
 }
 {
  const x=await querySource(),a=await beginArgs(x),before=await dataSnapshot();
  await race('begin_membership_update_commits_revocation',revoke,querySql('begin',a),async(_,r)=>rejected(r,'42501'));await restore();await preserved(before);
 }
 {
  const x=await querySource(),a=await beginArgs(x),b={args:a,value:await query('begin',a)},before=await dataSnapshot();
  await race('begin_replay_rechecks_revocation_after_command',commandLock(a.p_command_id),querySql('begin',a),async(_,r)=>rejected(r,'42501'),async()=>ok(await run(revoke)));await restore();await preserved(before);
  assert.equal((await query('command',{p_user_id:fiscal,p_command_id:a.p_command_id})).execution,null);
 }
 for(const [label,lock]of[['command',b=>commandLock(b.value.query_id)],['global',()=>globalLock],['auth_user',()=>userLock],['request_storage',(b,p)=>`select name from storage.objects where name=${quote(queryKey(b,'requests',p.args.p_request_hash))}for update;`]]){
  const x=await querySource(),b=await begin(x),p=await prepare(b);await expiresSoon(b);const before=await dataSnapshot();
  await race(`use_lease_expires_while_${label}`,lock(b,p),querySql('use',ids(b)),async(_,r)=>rejected(r,'40001'),1700);
  assert.deepEqual(await state(b),{state:'request_ready',used_at:null,finalize_hash:null,consumes:0,results:0});await preserved(before);
 }
 {
  const x=await querySource(),b=await begin(x);await prepare(b);await expiresSoon(b);const before=await dataSnapshot(),s=session();
  s.write(`begin;${querySql('use',ids(b))}\n\\echo USE_RETURNED`);try{await s.marker('USE_RETURNED');await pause(1700);s.end('commit;');rejected(await s.done,'40001');}finally{if(!s.done)s.end('rollback;');}
  assert.deepEqual(await state(b),{state:'request_ready',used_at:null,finalize_hash:null,consumes:0,results:0});await preserved(before);results.push({scenario:'deferred_use_commit_expiry_rolls_back_grant_and_audit',passed:true});
 }
 {
  const x=await querySource(),b=await begin(x),p=await prepare(b),key=queryKey(b,'requests',p.args.p_request_hash);
  await race('use_storage_changed_while_waiting',`update storage.objects set metadata=jsonb_set(metadata,'{size}','33')where name=${quote(key)};`,querySql('use',ids(b)),async(_,r)=>rejected(r,'40001'));
  assert.equal((await state(b)).used_at,null);ok(await run(`update storage.objects set metadata=jsonb_set(metadata,'{size}','32')where name=${quote(key)};`));
 }
 // A predecessor may finish after its lease; its finalization must invalidate a successor's old chain at use.
 for(const variant of['105','100']){
  const x=await querySource(),a=await begin(x),pa=await prepare(a);await use(a);await age(a);const b=await begin(x);await prepare(b);const fa=await queryFinishArgs(a,pa,variant),before=await dataSnapshot();
  await race(`predecessor_${variant}_finish_before_successor_use`,querySql('finish',fa),querySql('use',ids(b)),async(_,r)=>rejected(r,'40001'));
  assert.equal((await state(b)).used_at,null);assert.equal((await state(a)).results,1);await preserved(before);
 }
 {
  const x=await querySource(),a=await begin(x),pa=await prepare(a);await use(a);await age(a);const b=await begin(x),pb=await prepare(b),fa=await queryFinishArgs(a,pa,'100'),fb=await queryFinishArgs(b,pb,'105'),before=await dataSnapshot();
  await race('successor_use_before_predecessor_finish',querySql('use',ids(b)),querySql('finish',fa),async(_,r)=>assert.equal(value(r).current.state,'authorized_homologation'));
  await query('finish',fb);assert.equal((await query('context',x.contextArgs)).resolution.state,'authorized_homologation');await preserved(before);
 }
 {
  const x=await querySource(),a=await begin(x),p=await prepare(a);await use(a);await age(a);const stale=await beginArgs(x),f=await queryFinishArgs(a,p),before=await dataSnapshot();
  await race('late_105_invalidates_waiting_begin_selection',querySql('finish',f),querySql('begin',stale),async(_,r)=>rejected(r,'40001'));await preserved(before);
 }
 {
  const x=await querySource(),b=await begin(x),p=await prepare(b);await use(b);await age(b);const f=await queryFinishArgs(b,p,'100');
  await configure();await policy(false);ok(await run(`update erp_access.membership set active=false where user_id='${admin}';`));const before=await dataSnapshot();
  const out=await query('finish',f);assert.equal(out.current.state,'authorized_homologation');assert.equal((await query('command',{p_user_id:fiscal,p_command_id:b.value.query_id})).read_only,true);
  const replay=await query('begin',b.args);assert.equal(replay.replayed,true);assert.equal(replay.execution,null);await preserved(before);
  ok(await run(`update erp_access.membership set active=true where user_id='${admin}';`));await policy();results.push({scenario:'historical_finish_replay_after_lease_A1_policy_reviewer_changed',passed:true});
 }
 for(const [label,lock]of[['command',b=>commandLock(b.value.query_id)],['global',()=>globalLock],['auth_user',()=>userLock]]){
  const x=await querySource(),b=await begin(x),p=await prepare(b);await use(b);const f=await queryFinishArgs(b,p,'100'),before=await dataSnapshot();
  await race(`finish_revoked_after_${label}`,lock(b),querySql('finish',f),async(_,r)=>rejected(r,'42501'),async()=>ok(await run(revoke)));await restore();assert.equal((await state(b)).results,0);await preserved(before);
 }
 {
  const x=await querySource(),b=await begin(x),p=await prepare(b);await use(b);const f=await queryFinishArgs(b,p,'100'),key=queryKey(b,'responses',p.args.p_request_hash);
  await race('finish_storage_metadata_CAS_after_wait',`update storage.objects set metadata=jsonb_set(metadata,'{size}','33')where name=${quote(key)};`,querySql('finish',f),async(_,r)=>rejected(r,'40001'));assert.equal((await state(b)).results,0);
 }
 {
  const x=await querySource(),b=await begin(x);await prepare(b);const before=await dataSnapshot();
  await race('membership_revocation_waits_for_use_commit',querySql('use',ids(b)),revoke,async(_,r)=>ok(r));await restore();assert.notEqual((await state(b)).used_at,null);await preserved(before);
 }
 assert.deepEqual(await catalogSnapshot(),catalogBefore);
 const totals=value(await run(`select jsonb_build_object('queries',(select count(*)from ${S}.query),'results',(select count(*)from ${S}.result),'consumes',(select count(*)from ${S}.audit where action='consume'),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.movement));`));assert.equal(totals.stock,0);assert.equal(totals.finance,0);
 const exportPath='/Volumes/Dev/tmp/brufap-receipt-query089-synthetic-exports.json';await writeFile(exportPath,JSON.stringify({contract:'receipt-query089-synthetic-exports-v1',source_sha256:sourceHash,synthetic:true,items:exports089},null,2)+'\n',{mode:0o600});chmodSync(exportPath,0o600);
 console.log(JSON.stringify({contract:'receipt-query-089-postgres17-v1',source_sha256:sourceHash,source_manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,backend:'native_postgresql17_unix_socket_no_tcp',passed:results.length,lock_waits:results.filter(x=>x.lock_wait_observed).length,results,totals,original_tables_preserved_per_operation:true,previous_routines_oids_acls_defaults_preserved:true,real_data:false,network:false,cleanup:'finally'},null,2));
}finally{cleanup();}
