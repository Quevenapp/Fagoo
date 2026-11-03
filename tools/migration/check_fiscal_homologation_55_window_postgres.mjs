// Policy55 window checker: disposable PostgreSQL17, Unix socket only, synthetic metadata.
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
import {createFiscal55WindowDraft,finalizeFiscal55Window,prepareFiscal55WindowSql,prepareFiscal55WindowReadback,prepareFiscal55PreflightRead} from './prepare_fiscal_homologation_55_window.mjs';
import {prepareFiscalHomologation55Baseline} from './prepare_fiscal_homologation_55_baseline.mjs';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {buildBusinessXml} from '../../packages/fiscal-xml/src/business-builder.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE} from '../../packages/fiscal-authorization/src/validator.mjs';
import {canonical,SUBSET_SCHEMA} from '../../packages/fiscal-authorization/src/subset-review-dto.mjs';
import {RULE_PROFILE_V2_HASH as SP_CRT1_RULE_MANIFEST_HASH} from '../../packages/fiscal-authorization/src/rule-profile-registry.mjs';

const name='brufap-fiscal55-window-'+randomUUID(),database='brufap_synthetic';
const admin=randomUUID(),fiscal=admin,sessions=new Set(),results=[];
let container=null;
const nativeBin=process.env.BRUFAP_TEST_PG17_BIN??null;
const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));
let nativeRoot=null,nativeStarted=false;
const nativePort='56555';
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
let contact,product;const testSeries=new Map();
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
 const document=(await rpc('erp_document_save',{p_user_id:admin,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'PRODUTO FICTICIO',code:'345121',unit:'CX',quantity:'1',unit_price:'84.8062444176',discount_percent:'0'}]}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:fiscal,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:document.id,expected_source_version:document.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:fiscal,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'40082100',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const sample=businessFixture({model,quantity:'1',unit_price:'84.8062444176'});await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:sample.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
 const{identity,...completion}=sample.completion;completion.items.forEach((i,n)=>{i.item_id=draft.record.snapshot.items[n].id;i.tributary.unit='CX';});
 const f={draft,completion};await rpc('erp_fiscal_completion_save',completionArgs(f));
 let configured;
 if(!testSeries.has(model)){
  configured=await rpc('erp_fiscal_numbering_configure',{p_user_id:admin,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:model,p_environment:'2',p_series:'2',p_initial_number:model==='55'?'42194':'4351',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'SERIE FICTICIA PARA ENSAIO LOCAL'});
  testSeries.set(model,configured.current_series.id);
 }
 const row=value(await run(`select to_jsonb(s)from erp_fiscal_numbering.series s where id=${quote(testSeries.get(model))};`));
 f.reservation=await rpc('erp_fiscal_numbering_reserve',{p_user_id:fiscal,p_command_id:randomUUID(),p_series_id:row.id,p_expected_series_version:row.version,p_expected_identity_version:row.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_confirm_reserve:true});return f;
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
async function fresh(model){const s=await source(model);return{p_user_id:fiscal,p_command_id:randomUUID(),p_candidate_id:s.receipt.candidate_id,p_expected_candidate_version:s.receipt.version,p_signed_hash:s.artifact.signed_hash,p_expected_review_version:0,p_facts_hash:hash('synthetic facts'),p_profile_hash:SP_CRT1_RULE_MANIFEST_HASH,p_schema:{xml_hash:s.artifact.signed_hash,...SUBSET_SCHEMA},p_valid_until:'2026-10-25T23:59:59.000Z',p_declaration_text:canonical(declaration)};}
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


const scalar=async sql=>ok(await run(sql)).stdout.trim();
const resultsPass=name=>{results.push({scenario:name,passed:true});process.stderr.write('PASS '+name+'\n');};
function cleanup(){for(const child of sessions){child.stdin.destroy();child.kill('SIGTERM');}if(nativeRoot&&existsSync(join(nativeRoot,'data','postmaster.pid')))execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-m','immediate','-w','stop'],{env:childEnv,stdio:'pipe',timeout:15000});nativeStarted=false;if(nativeRoot){assert.match(nativeRoot,/^\/Volumes\/Dev\/tmp\/brufap-fiscal55-window-[A-Za-z0-9]+$/);rmSync(nativeRoot,{recursive:true});nativeRoot=null;}}
const interrupt=()=>{try{cleanup();}finally{process.exit(130);}};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 assert.match(execFileSync(join(nativeBin,'postgres'),['--version'],{env:childEnv,encoding:'utf8',timeout:5000}),/^postgres \(PostgreSQL\) 17\./);
 nativeRoot=mkdtempSync('/Volumes/Dev/tmp/brufap-fiscal55-window-');chmodSync(nativeRoot,0o700);mkdirSync(join(nativeRoot,'socket'),{mode:0o700});
 execFileSync(join(nativeBin,'initdb'),['-D',join(nativeRoot,'data'),'-U','postgres','-A','trust','--encoding=UTF8','--locale=C'],{env:childEnv,stdio:'pipe',timeout:30000});
 nativeStarted=true;execFileSync(join(nativeBin,'pg_ctl'),['-D',join(nativeRoot,'data'),'-l',join(nativeRoot,'postgres.log'),'-o',`-c listen_addresses='' -k ${join(nativeRoot,'socket')} -p ${nativePort} -c shared_buffers=32MB -c max_connections=12 -c max_parallel_workers=0 -c timezone=UTC`,'-w','start'],{env:childEnv,stdio:'pipe',timeout:15000});
 execFileSync(join(nativeBin,'createdb'),['-h',join(nativeRoot,'socket'),'-p',nativePort,'-U','postgres',database],{env:childEnv,stdio:'pipe',timeout:5000});assert.equal(await scalar('show listen_addresses;'),'');
 ok(await run(bootstrap));const dir=new URL('../../supabase/migrations/',import.meta.url),files=(await readdir(dir)).filter(n=>/^202610160\d{3}_.+\.sql$/.test(n)&&+n.slice(9,12)<=89).sort();assert.equal(files.length,89);
 for(const file of files)ok(await run(await readFile(new URL(file,dir),'utf8')));
 ok(await run(`insert into auth.users values('${admin}');insert into erp_access.membership(user_id,role)values('${admin}','admin');insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']),('brufap-fiscal-artifacts','brufap-fiscal-artifacts',false,8388608,array['application/octet-stream'])on conflict do nothing;`));
 await setCompany();await confirmRegime();await configure();
 contact=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'CLIENTE FICTICIO',person_type:'F',document:'12345678909',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:admin,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO',code:'345121',unit:'CX',kind:'P',format:'S',ncm:'40082100',origin:'0',gtin:'SEM GTIN'}})).record;
 ok(await run(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until,authorization_profile)select m,4,'operational',true,'sp'||m||'-authorization-soap12-reviewed-20261016-v1',erp_fiscal_subset_review.profile_definition(erp_fiscal_subset_review.current_profile_hash())->>'profile',true,false,erp_fiscal_reviewed_authorization.manifest(m,erp_fiscal_subset_review.current_profile_hash()),'2026-10-16T00:00:00-03:00','2026-10-26T00:00:00-03:00','reviewed_subset_v1'from unnest(array['55','65'])m;`));
 const original=await freshRevalidation('55');await revalidation('finish',original.args);
 await source('65'); // Preserved4351 candidate, never consumed.
 const rejected65=await authorized('65');await auth('use',rejected65.use);const finish65=await finishArgs(rejected65);
 await auth('finish',{...finish65,p_processed_hash:null,p_processed_size:null,p_evidence:{...finish65.p_evidence,outcome:'rejected',protocol_cstat:'245',protocol_number:null,reference_digest:null,signature_verified:false,processed_xsd_validated:false}});
 ok(await run(`insert into erp_fiscal_authorization.policy select model,5,origin,false,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,clock_timestamp(),'2026-10-26T03:00:00Z',clock_timestamp(),authorization_profile from erp_fiscal_authorization.policy where version=4;`));
 const first=value(await run(await prepareFiscalHomologation55Baseline()));
 const draft=createFiscal55WindowDraft(first,{baselineSha256:hash(JSON.stringify(first))});
 assert.equal(first.checks.contact_active_pf_customer,false);assert.equal(first.counts.authorization_attempts,2);assert.equal(first.counts.receipt_queries,0);
 resultsPass('real_baseline_after_two_consumed_histories_and_079_closed089');
 const newReview=await fresh('55'),savedNew=await review('save',newReview);
 const target=value(await run(`select jsonb_build_object('order_id',r.source_document_id)from erp_fiscal_signed.candidate c join erp_fiscal_unsigned.job j on j.id=c.unsigned_job_id join erp_fiscal_numbering.reservation r on r.id=j.reservation_id where c.id=${quote(newReview.p_candidate_id)};`));
 const freshBaseline=value(await run(await prepareFiscalHomologation55Baseline({targetOrderId:target.order_id})));
 const wrapped=value(await run(prepareFiscal55PreflightRead({actor:admin,candidateId:newReview.p_candidate_id,signedHash:newReview.p_signed_hash}))),preflight=wrapped.preflight;
 assert.equal(wrapped.read_only,true);assert.equal(wrapped.selection.candidate_id,newReview.p_candidate_id);resultsPass('parameterized_preflight_wrapper_RR_readonly_ROLLBACK');
 const plan=finalizeFiscal55Window({draft,freshBaseline,freshBaselineSha256:hash(JSON.stringify(freshBaseline)),preflight,approvedAt:new Date().toISOString(),runtimeFlagsVerified:true});
 const enable=await prepareFiscal55WindowSql(plan),disable=await prepareFiscal55WindowSql(plan,'disable');
 resultsPass('fresh_exact_target_and_SQL_preflight_finalize_without_price_rounding');
 const noNewPolicy=async()=>assert.equal(await scalar("select count(*)from erp_fiscal_authorization.policy where model='55'and version>5;"),'0');
 const refuse=async(name,script,code,fragment)=>{const r=await run(script);rejected(r,code);if(fragment)assert.ok(r.stderr.includes(fragment),r.stderr);await noNewPolicy();resultsPass(name);};
 await refuse('source_catalog_change_rejected',enable.replace('DO $window55$',"update erp_catalog.record set active=false where id="+quote(contact.id)+";DO $window55$"),'40001','window_inventory_changed');
 await refuse('other_active_actor_rejected',enable.replace('DO $window55$',`insert into auth.users values(${quote(randomUUID())});update erp_access.membership set role='fiscal'where user_id=${quote(admin)};DO $window55$`),'40001','window_inventory_changed');
 await refuse('head_CAS_rejected',enable.replace('DO $window55$',"alter table erp_fiscal_authorization.policy disable trigger immutable;update erp_fiscal_authorization.policy set valid_until=valid_until-interval'1second'where model='55'and version=5;DO $window55$"),'40001','window_policy_head_changed');
 await refuse('data_change_after_append_rolls_back',enable.replace("after_rows:='{}';","UPDATE erp_documents.document SET total=total+1 WHERE id="+quote(target.order_id)+";after_rows:='{}';"),'40001','window_preservation_failed');
 await refuse('default_privilege_change_rolls_back',enable.replace("after_rows:='{}';","ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO authenticated;after_rows:='{}';"),'40001','window_preservation_failed');
 const expired=enable.replace("at:=clock_timestamp();","at:=clock_timestamp()+interval'6 minutes';");
 await refuse('stale_clock_rejected_before_append',expired,'55000','window_proof_expired');
 const holder=session();holder.write(`begin;lock table erp_documents.document in row exclusive mode;\\echo WRITER_HELD`);
 try{await holder.marker('WRITER_HELD');await refuse('writer_NOWAIT_no_lock_upgrade',enable,'55P03');}finally{holder.end('rollback;');ok(await holder.done);}
 const mutex=session();mutex.write('begin;select pg_advisory_xact_lock(174852920,1);\n\\echo MUTEX_HELD');
 try{await mutex.marker('MUTEX_HELD');await refuse('fiscal_mutex_BUSY_without_wait',enable,'55P03','window_fiscal_mutex_busy');}finally{mutex.end('rollback;');ok(await mutex.done);}
 const rollback=value(await run(enable.replace(/COMMIT;\n$/,'ROLLBACK;\n')));assert.equal(rollback.before_equals_after,true);await noNewPolicy();resultsPass('successful_enable_can_rollback_whole_transaction');
 const audit=value(await run(enable));assert.equal(audit.policy.version,6);assert.equal(audit.policy.enabled,true);assert.equal(audit.before_equals_after,true);assert.deepEqual(audit.before,audit.after_historical);assert.ok(audit.preserved_tables>=164);assert.equal(audit.policy.tax_rules_reviewed,false);
 resultsPass('append_only55v6_preserves_164_tables_security_and_history');
 const ack=value(await run(prepareFiscal55WindowReadback(plan)));assert.equal(ack.expected_policy_matches,true);assert.equal(ack.historical_preservation_proven_by_this_read,false);assert.equal(ack.policy65.enabled,false);resultsPass('lost_ACK_readback_finds_exact_policy_without_reapplying');
 const repeat=await run(enable);rejected(repeat,'40001');assert.ok(repeat.stderr.includes('window_policy_head_changed'));resultsPass('same_enable_is_not_reapplied_or_extended');
 const {command_id,schema,...savedProof}=savedNew.receipt,proof={...savedProof,tax_rules_validated:false},v=await versions();
 const began=await auth('begin',{p_user_id:admin,p_command_id:randomUUID(),p_candidate_id:newReview.p_candidate_id,p_signed_hash:newReview.p_signed_hash,p_expected_identity_version:v.identity,p_expected_a1_version:v.a1,p_expected_policy_version:6,p_confirmed:true});
 const c=began.view.execution,ids={p_user_id:admin,p_attempt_id:c.attempt_id,p_lease_id:c.lease_id},requestHash=hash('new synthetic window request');
 await object(c,'requests',requestHash,32);
 await auth('prepare',{...ids,p_request_hash:requestHash,p_request_size:32,p_rule_review:proof,p_evidence:{...Object.fromEntries(['origin','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','binding_profile','rule_profile'].map(k=>[k,c[k]])),request_hash:requestHash,payload_hash:hash('new synthetic payload'),schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false}});
 await auth('use',{...ids,p_rule_review:proof});resultsPass('new_synthetic_attempt_can_be_consumed_without_transport');
 ok(await run(`update erp_access.membership set active=false where user_id=${quote(admin)};update erp_a1.head set version=version+1;`));
 const off=value(await run(disable));assert.equal(off.policy.version,7);assert.equal(off.policy.enabled,false);assert.deepEqual(off.before,off.after_historical);assert.equal(off.security_preserved,true);
 const readOff=value(await run(prepareFiscal55WindowReadback(plan,'disable')));assert.equal(readOff.expected_policy_matches,true);assert.equal(readOff.authorization_consumed,3);assert.equal(readOff.receipt_queries,0);resultsPass('disable_after_new_consume_actor_revocation_and_A1_change_preserves_current_data');
 const beforeEnable=value(await run("select to_jsonb(p)from erp_fiscal_authorization.policy p where model='55'and version=6;"));assert.deepEqual(beforeEnable,audit.policy);resultsPass('original_enabled_row_and_two_original_outcomes_immutable');
 console.log(JSON.stringify({contract:'fiscal55-window-postgres17-v1',backend:'native_postgresql17_unix_socket_no_tcp',passed:results.length,results,synthetic:true,real_data:false,network:false,sql_remote:false,cleanup:'finally'},null,2));
}finally{cleanup();}
