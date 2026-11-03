/** Node-only boundary: validate the private SQL envelope before stripping it. */
import {projectResponse} from '../../fiscal-signed-rpc/src/dto.mjs';
import {FLAGS,compact,publicResult} from './dto.mjs';
import {SignedRuntimeError} from './protocol.mjs';
const CURRENT=['state','attempt_count','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
function project(v,{commandId,candidateId,jobId}={}){
 const r=v.receipt,c=v.current,a=v.artifact;
 return compact({...FLAGS,status:c.state,...(commandId?{command_id:commandId}:{}),candidate_id:r.candidate_id,candidate_version:r.version,
  unsigned_job_id:r.unsigned_job_id,unsigned_hash:r.unsigned_hash,basis_hash:r.basis_hash,model:r.model,completion_version:r.completion_version,
  completion_hash:r.completion_hash,a1_version:r.a1_version,signed:v.signed,signature_verified:v.signature_verified,xsd_validated:v.xsd_validated,
  error_code:v.error_code,current:Object.fromEntries(CURRENT.map(k=>[k,c[k]])),artifact:a?{sha256:a.signed_hash,size_bytes:a.size_bytes,created_at:a.created_at}:null,read_only:true},
  {commandId,candidateId,jobId,readOnly:true});
}
export function projectSqlView(raw,{commandId,candidateId}={}){
 try{
  const name=commandId?'erp_fiscal_signed_command':'erp_fiscal_signed_get',args=commandId?{p_command_id:commandId}:{p_candidate_id:candidateId};
  return project(projectResponse(name,raw,args),{commandId,candidateId});
 }catch{throw new SignedRuntimeError(502,'SIGNED_RESPONSE_INVALID');}
}
export function projectSqlHistory(raw,{jobId,payload}){
 try{
  const v=projectResponse('erp_fiscal_signed_history',raw,{p_unsigned_job_id:jobId,p_limit:payload.limit,p_before:payload.before});
  return publicResult({...FLAGS,read_only:true,unsigned_job_id:v.unsigned_job_id,items:v.items.map(item=>project(item,{jobId})),limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor},
   {action:'history',jobId,payload});
 }catch{throw new SignedRuntimeError(502,'SIGNED_RESPONSE_INVALID');}
}
