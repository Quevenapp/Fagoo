import {REVALIDATION_FLAGS as FLAGS,REVALIDATION_PROFILE,REVALIDATION_PARSER_HASH} from '../../../../packages/fiscal-authorization/src/revalidation-public-dto.mjs';
import {candidate,result,history,setup} from './fiscal-reviewed-authorization-fixtures.mjs';
export {candidate};
export const B='/v1/fiscal-authorization/reviewed',revalidationId='a7900000-0000-4000-8000-000000000001';
export function original(c=candidate()){
 const r=result(c,{state:'review_required'});Object.assign(r.artifact,{outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,protocol_number:null,received_at:null,receipt_number:null});return r;
}
export function context(r=original(),existing=null){return{...FLAGS,kind:'context',read_only:true,authorization_command_id:r.command_id,attempt_id:r.receipt.attempt_id,candidate:{candidate_id:r.receipt.candidate_id,candidate_version:r.receipt.candidate_version,signed_hash:r.receipt.signed_hash,model:r.receipt.model,origin:'operational'},source_hash:'9'.repeat(64),parser:{profile:REVALIDATION_PROFILE,manifest_hash:REVALIDATION_PARSER_HASH},original:{state:'review_required',outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,response_hash:r.artifact.response_hash,response_size:r.artifact.response_size,recorded_at:r.artifact.created_at},can_revalidate:existing===null,existing};}
export const input=(r=original())=>({command_id:revalidationId,authorization_command_id:r.command_id,expected_attempt_id:r.receipt.attempt_id,expected_source_hash:context(r).source_hash,confirmed:true});
export function revalidated(r=original(),body=input(r),reading=true,state='authorized_homologation'){
 const authorized=state==='authorized_homologation';return{...FLAGS,kind:'result',read_only:reading,command_id:body.command_id,replayed:reading,receipt:{command_id:body.command_id,authorization_command_id:r.command_id,attempt_id:r.receipt.attempt_id,...context(r).candidate,source_hash:body.expected_source_hash,parser_profile:REVALIDATION_PROFILE,parser_manifest_hash:REVALIDATION_PARSER_HASH,original_state:'review_required',state,artifact:{response_hash:r.artifact.response_hash,response_size:r.artifact.response_size,payload_hash:'4'.repeat(64),outcome:authorized?'authorization_declared':state,cstat:authorized?'104':state==='receipt_pending'?'103':state==='rejected'?'215':'217',protocol_cstat:authorized?'100':null,protocol_number:authorized?'13526000000000001':null,received_at:'2026-10-16T12:00:02.000Z',receipt_number:state==='receipt_pending'?'350000000000001':null,tls_origin_verified:true,signature_verified:authorized,xsd_validated:true,context_matched:true,processed_xsd_validated:authorized},processed_hash:authorized?'5'.repeat(64):null,processed_size:authorized?12000:null,created_at:'2026-10-17T12:00:00.000Z',tax_rules_validated:false}};
}
export function revalidationFixture({model='55',existing=false,before=()=>{}}={}){
 let saved;
 const s=setup({model,before:async(call,s)=>{
  if(call.path.includes('/revalidation-context/'))call.kind='revalidationContext';
  if(call.path.endsWith('/revalidations')){call.kind='revalidationRun';saved=call.body;}
  if(call.path.includes('/revalidation-commands/'))call.kind='revalidationCommand';
  const custom=await before(call,s);if(custom!==undefined)return custom;
  if(call.kind==='history')return history(s.candidate,[s.original]);
  if(call.kind==='revalidationContext')return context(s.original,existing?revalidated(s.original):null);
  if(call.kind==='revalidationRun')return revalidated(s.original,call.body,false);
  if(call.kind==='revalidationCommand')return revalidated(s.original,saved);
 }});s.original=original(s.candidate);return s;
}
