// Exclusively synthetic local SQL. No certificate bytes, socket, service credential or remote adapter.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture as reconciliationFixture,hash} from '../../../packages/fiscal-reconciliation/test/fixture.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE} from '../../../packages/fiscal-authorization/src/validator.mjs';
export {hash};
export async function authorizationFixture({installSynthetic=true}={}) {
 const f=await reconciliationFixture();
 try {
  await f.db.exec(await readFile(new URL('../../../supabase/migrations/202610160064_fiscal_authorization.sql',import.meta.url),'utf8'));
  const install=async(version=2)=>f.db.query(`insert into erp_fiscal_authorization.policy(model,version,origin,enabled,binding_profile,rule_profile,binding_reviewed,tax_rules_reviewed,source_manifest_hash,valid_from,valid_until)
   select m,$1,'synthetic',true,'synthetic-authorization-binding','synthetic-rules-only',false,false,$2,clock_timestamp()-interval'1 day',clock_timestamp()+interval'1 day'from unnest(array['55','65'])m`,[version,hash('synthetic policy')]);
  if(installSynthetic)await install();
  const call=(name,args)=>f.callSql('erp_fiscal_authorization_'+name,{p_user_id:f.users.fiscal,...args});
  const args=async(s,patch={})=>({p_command_id:randomUUID(),p_candidate_id:s.receipt.candidate_id,p_signed_hash:s.artifact.signed_hash,p_expected_identity_version:(await f.callSql('erp_company_get',{p_user_id:f.users.admin,p_section:'identity'})).record.version,p_expected_a1_version:(await f.callSql('erp_a1_metadata',{p_user_id:f.users.admin})).current.version,p_expected_policy_version:2,p_confirmed:true,...patch});
  const begin=async(s,patch={})=>{const input=await args(s,patch);return{args:input,value:await call('begin',input)};};
  const id=b=>({p_attempt_id:b.value.receipt.attempt_id,p_lease_id:b.value.execution.lease_id});
  const object=async(b,kind,tag,size=32)=>{
   const key=`authorization/${b.value.receipt.attempt_id}/${kind}/${tag}.${kind==='observations'?'json':'xml'}`;
   await f.db.query('insert into storage.objects values($1,$2,$3::jsonb)on conflict do nothing',['brufap-fiscal-artifacts',key,JSON.stringify({size,mimetype:'application/octet-stream'})]);return key;
  };
  const preparation=(b,requestHash=hash('synthetic request'))=>{
   const c=b.value.execution;
   return{...Object.fromEntries(['origin','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','binding_profile','rule_profile'].map(k=>[k,c[k]])),request_hash:requestHash,payload_hash:hash('synthetic enviNFe payload '+c.batch_id),
    schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,
    signature_verified:true,xsd_validated:true,context_matched:true,tax_rules_validated:false,can_emit:false,can_transmit:false};
  };
  const prepare=async(b,patch={})=>{const requestHash=hash('synthetic request '+b.value.receipt.batch_id);await object(b,'requests',requestHash);const input={...id(b),p_request_hash:requestHash,p_request_size:32,p_evidence:preparation(b,requestHash),...patch};return{args:input,value:await call('prepare',input)};};
  const use=b=>call('use',id(b));
  const responseEvidence=(b,requestHash,responseHash,patch={})=>({origin:b.value.execution.origin,request_hash:requestHash,response_hash:responseHash,payload_hash:hash('synthetic fiscal response'),
   schema_profile:AUTHORIZATION_VALIDATOR_PROFILE.profile,schema_manifest_hash:AUTHORIZATION_VALIDATOR_PROFILE.manifestHash,validator_hash:AUTHORIZATION_VALIDATOR_PROFILE.validatorHash,binding_profile:b.value.execution.binding_profile,rule_profile:b.value.execution.rule_profile,
   outcome:'authorization_declared',rejection_code:null,cstat:'104',protocol_cstat:'100',protocol_number:'135260000000001',received_at:new Date().toISOString(),receipt_number:null,reference_digest:b.value.execution.reference_digest,
   signature_verified:true,xsd_validated:true,context_matched:true,processed_xsd_validated:true,tls_origin_verified:false,transport_hash:null,transport_size:null,can_emit:false,can_transmit:false,...patch});
  const finishArgs=async(b,p,patch={})=>{
   const responseHash=hash('synthetic response '+b.value.receipt.batch_id),processedHash=hash('synthetic processed '+b.value.receipt.batch_id);
   await object(b,'responses',p.args.p_request_hash);await object(b,'processed',processedHash);
   return{...id(b),p_response_hash:responseHash,p_response_size:32,p_processed_hash:processedHash,p_processed_size:32,p_evidence:responseEvidence(b,p.args.p_request_hash,responseHash),...patch};
  };
  const command=b=>call('command',{p_command_id:b.args.p_command_id});
  const expire=async b=>{
   await f.db.exec('alter table erp_fiscal_authorization.attempt disable trigger guard_attempt');
   try{await f.db.query("update erp_fiscal_authorization.attempt set expires_at=clock_timestamp()-interval'1 second'where id=$1",[b.value.receipt.attempt_id]);}
   finally{await f.db.exec('alter table erp_fiscal_authorization.attempt enable trigger guard_attempt');}
  };
  return{...f,install,call,args,begin,id,object,preparation,prepare,use,responseEvidence,finishArgs,command,expire};
 }catch(e){await f.close();throw e;}
}
