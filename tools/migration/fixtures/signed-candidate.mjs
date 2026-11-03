// Synthetic SQL050 fixture. No real certificate, network, fiscal transmission or disk database.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {fixture as unsignedFixture,hash} from '../../../packages/fiscal-unsigned-orchestrator/test/fixture.mjs';
export {hash};
export async function signedFixture(){
 const f=await unsignedFixture();
 let queue=Promise.resolve();
 const callSql=(name,args)=>{
  assert.match(name,/^erp_[a-z0-9_]+$/);for(const key of Object.keys(args))assert.match(key,/^p_[a-z0-9_]+$/);
  const run=async()=>{await f.db.exec('set role service_role');let error;try{const entries=Object.entries(args);return await f.scalar(`select public.${name}(${entries.map(([k],i)=>k+'=>$'+(i+1)).join(',')})value`,entries.map(([k,v])=>v!==null&&(typeof v==='object'||k==='p_evidence'||k==='p_metadata')?JSON.stringify(v):v));}catch(e){error=e;throw e;}finally{try{await f.db.exec('reset role');}catch(e){if(!error)throw e;}}};
  const result=queue.then(run,run);queue=result.catch(()=>{});return result;
 };
 const close=async()=>{await queue;await f.close();};
 try{
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160041_a1_custody.sql',import.meta.url),'utf8'));
 await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160050_signed_fiscal_candidates.sql',import.meta.url),'utf8'));
 await f.db.exec("insert into storage.buckets values('brufap-a1-vault','brufap-a1-vault',false,1500000,array['application/json']);");
 const call=(name,args)=>callSql('erp_fiscal_signed_'+name,{p_user_id:f.users.fiscal,...args});
 const configure=async(patch={})=>{
  const current=await callSql('erp_a1_metadata',{p_user_id:f.users.admin});
  const company=await callSql('erp_company_get',{p_user_id:f.users.admin,p_section:'identity'});
  const args={p_user_id:f.users.admin,p_command_id:randomUUID(),p_request_hash:hash(randomUUID()),p_action:'configure',p_expected_version:current.current.version,p_expected_identity_version:company.record.version,p_reason:'Certificado fictício para testes locais'};
  const r=await callSql('erp_a1_reserve',args),fp=hash(randomUUID());
  const metadata={profile:'openssl3-pkcs12',legacy_provider_enabled:false,pfx_mac:'sha256',pfx_mac_iterations:2048,fingerprint_sha256:fp,holder_cnpj:company.record.data.cnpj,
   not_before:new Date(Date.now()-86400000).toISOString(),not_after:new Date(Date.now()+86400000).toISOString(),rsa_bits:2048,presented_chain:[fp],validated_at:new Date().toISOString(),
   key_matches_certificate:true,presented_chain_links_checked:true,icp_brasil_chain_validated:false,revocation_checked:false,a1_policy_verified:false,client_auth_eku_verified:false,can_transmit:false,...patch};
  const objectHash=hash(randomUUID());
  await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)',['brufap-a1-vault',`credentials/${r.credential_id}/${objectHash}.json`,JSON.stringify({size:256,mimetype:'application/json'})]);
  const result=await callSql('erp_a1_finalize',{p_user_id:f.users.admin,p_command_id:args.p_command_id,p_lease_id:r.lease_id,p_metadata:metadata,p_object_hash:objectHash,p_size_bytes:256,p_key_id:'synthetic_kek_v1'});
  return{...result,metadata,objectHash};
 };
 const selected=await configure();
 const stored=async(options={})=>{const source=await f.prepare(options),input=await f.input(source),result=await f.orchestrator().run(input);if(result.status!=='stored')throw Error('SYNTHETIC_UNSIGNED_NOT_STORED');return{source,input,result};};
 const beginArgs=async(s,patch={})=>({p_command_id:randomUUID(),p_unsigned_job_id:s.result.job_id,p_unsigned_hash:s.result.artifact.sha256,p_basis_hash:s.result.basis_hash,p_expected_a1_version:(await callSql('erp_a1_metadata',{p_user_id:f.users.admin})).current.version,...patch});
 const begin=async(s,patch={})=>{const args=await beginArgs(s,patch);return{args,value:await call('begin',args)};};
 const use=(r,actor=f.users.fiscal)=>call('use',{p_user_id:actor,p_candidate_id:r.value.receipt.candidate_id,p_lease_id:r.value.execution.lease_id});
 const proof=(r,h=hash('synthetic signed bytes'))=>({signature:{xml_hash:h,certificate_fingerprint:r.value.receipt.certificate_fingerprint,signed_content_hash:hash('synthetic authenticated infNFe'),reference_digest:Buffer.alloc(20,17).toString('base64'),profile:'nfe400-rsa-sha1-c14n-v1'},
  xsd:{xml_hash:h,schema_profile:'pl010f-v1.04',manifest_hash:'6099e1ce8a90a079609f986ab0b9783744d2fbb10151fab0b5e7a3549c82d9a0',validator_version:'fiscal-schema-runner-v1',validator_hash:'1da9dba6f75bca015fd7bd114a9fa030e57bb11d46a8f4b248cc3214dcbc53c6'},
  qr:{profile:r.value.receipt.model==='65'?'sp-homologation-online-qr-v3':null,verified:r.value.receipt.model==='65'}});
 const object=async(r,h=hash('synthetic signed bytes'),size=1024)=>{await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)on conflict do nothing',['brufap-fiscal-artifacts',`candidates/${r.value.receipt.candidate_id}/${h}.xml`,JSON.stringify({size,mimetype:'application/octet-stream'})]);return{hash:h,size};};
 const finish=(r,options={})=>{const h=options.hash??hash('synthetic signed bytes');return call('finish',{p_candidate_id:r.value.receipt.candidate_id,p_lease_id:r.value.execution.lease_id,p_signed_hash:h,p_size_bytes:options.size??1024,p_evidence:options.evidence??proof(r,h),...(options.actor?{p_user_id:options.actor}:{})});};
 const fail=(r,error='XSD_INVALID')=>call('fail',{p_candidate_id:r.value.receipt.candidate_id,p_lease_id:r.value.execution.lease_id,p_error_code:error});
 const get=(r,actor=f.users.fiscal)=>call('get',{p_user_id:actor,p_candidate_id:r.value.receipt.candidate_id});
 const command=(r,actor=f.users.fiscal)=>call('command',{p_user_id:actor,p_command_id:r.args.p_command_id});
 const disable=async()=>callSql('erp_a1_disable',{p_user_id:f.users.admin,p_command_id:randomUUID(),p_request_hash:hash(randomUUID()),p_expected_version:(await callSql('erp_a1_metadata',{p_user_id:f.users.admin})).current.version,p_reason:'Desativação fictícia para teste'});
 const expire=async r=>{await f.db.exec('alter table erp_fiscal_signed.candidate disable trigger guard_candidate');try{await f.db.query("update erp_fiscal_signed.candidate set lease_until=clock_timestamp()-interval'1 second'where id=$1",[r.value.receipt.candidate_id]);}finally{await f.db.exec('alter table erp_fiscal_signed.candidate enable trigger guard_candidate');}};
 return{...f,callSql,close,selected,configure,stored,beginArgs,begin,use,proof,object,finish,fail,get,command,disable,expire,call};
 }catch(error){await close();throw error;}
}
