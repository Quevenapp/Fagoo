/** Synthetic browser/test fixture only; never imported by production entries. */
import {FLAGS,type AuthorizationPreview,type AuthorizationResult,type AuthorizationHistory} from '../../../../packages/fiscal-authorization-http/src/dto.mjs';
import {SIGNED_FLAGS,type SignedCandidate} from '../lib/fiscal-signed-model.ts';
export const AUTHORIZATION_QA_ACTOR='e0000000-0000-4000-8000-000000000001';
const id=(n:number)=>`a6400000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function authorizationQaCandidate(model:'55'|'65'='55'):SignedCandidate{
 const candidate_id=id(model==='55'?1:2);return {...SIGNED_FLAGS,status:'stored',candidate_id,candidate_version:1,unsigned_job_id:id(10),unsigned_hash:'f'.repeat(64),basis_hash:'b'.repeat(64),model,completion_version:1,completion_hash:'c'.repeat(64),a1_version:2,error_code:null,signed:true,signature_verified:true,xsd_validated:true,artifact:{sha256:(model==='55'?'a':'e').repeat(64),size_bytes:10000,created_at:'2026-10-16T12:00:00Z'},current:{state:'stored',attempt_count:1,unsigned_artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,series_enabled:true,a1_version:2,a1_changed:false,certificate_time_valid_now:true,latest_candidate_id:candidate_id,latest_candidate_version:1,is_latest_candidate:true,artifact_current:true},read_only:true};
}
export function authorizationQaPreview(c=authorizationQaCandidate()):AuthorizationPreview{return {...FLAGS,read_only:true,candidate_id:c.candidate_id,signed_hash:c.artifact!.sha256,model:c.model,policy:{model:c.model,version:1,origin:'synthetic',enabled:false,binding_profile:null,rule_profile:null,binding_reviewed:false,tax_rules_reviewed:false,source_manifest_hash:null,valid_from:'2026-10-16T00:00:00Z',valid_until:'2099-01-01T00:00:00Z',created_at:'2026-10-16T00:00:00Z'},blockers:['POLICY_DISABLED','BINDING_NOT_REVIEWED','RULE_PROFILE_NOT_REVIEWED'],can_prepare:false,signature_checked:true,certificate_pin_checked:true,operational_binding_available:false,service_enabled:false};}
export function authorizationQaResult(c=authorizationQaCandidate(),terminal=false,ordinal='2'):AuthorizationResult{
 const command_id=id((c.model==='55'?100:200)+Number(ordinal)),state=terminal?'authorization_observed':'submission_uncertain';
 return {...FLAGS,status:state,command_id,receipt:{candidate_id:c.candidate_id,candidate_version:c.candidate_version,unsigned_job_id:c.unsigned_job_id,reservation_id:id(20),draft_id:id(30),model:c.model,signed_hash:c.artifact!.sha256,signed_size:c.artifact!.size_bytes,signing_a1_version:c.a1_version,basis_hash:c.basis_hash,completion_version:c.completion_version,completion_hash:c.completion_hash,attempt_id:command_id,intent_id:id(40),ordinal,command_id,batch_id:ordinal,environment:'2',origin:'synthetic',policy_version:1,identity_version:1,a1_version:2,created_at:'2026-10-16T12:00:00Z'},current:{state,grant_consumed:true,used_at:'2026-10-16T12:00:01Z',expires_at:'2026-10-16T12:01:00Z',lease_expired:true,finished_at:'2026-10-16T12:00:02Z',identity_changed:false,a1_changed:false,policy_changed:false,policy_enabled:false,candidate:{...c.current,state:'stored',lease_until:null},recovery_required:!terminal,authorized_in_homologation:false},error_code:terminal?null:'TRANSPORT_UNCONFIRMED',artifact:terminal?{response_hash:'d'.repeat(64),response_size:2000,processed_hash:'e'.repeat(64),processed_size:12000,outcome:'authorization_declared',rejection_code:null,cstat:'104',protocol_cstat:'100',protocol_number:'13526000000000001',received_at:'2026-10-16T12:00:02Z',receipt_number:null,tls_origin_verified:false,created_at:'2026-10-16T12:00:02Z'}:null,read_only:true,recovered:false,failure_code:null,recovery_required:!terminal,recoverable_by_actor:!terminal};
}
export function authorizationQaHistory(c=authorizationQaCandidate()):AuthorizationHistory{return {...FLAGS,read_only:true,candidate_id:c.candidate_id,items:[authorizationQaResult(c),authorizationQaResult(c,true,'1')],limit:25,has_more:false,next_cursor:null};}
export function createAuthorizationQaFixture(){
 const counts={preview:0,history:0,command:0,forbidden:0};const failed=new Set<string>();
 return {counts,candidate:authorizationQaCandidate,async fetch(input:RequestInfo|URL,init:RequestInit={}):Promise<Response>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),path=url.pathname,method=init.method??'GET';
  const candidate=path.includes('/candidates/')?path.split('/candidates/')[1].split('/')[0]:undefined;
  if(method==='POST'&&path==='/v1/fiscal-authorization/preview'){
   counts.preview++;const body=JSON.parse(String(init.body)),c=authorizationQaCandidate(body.candidate_id===id(1)?'55':'65');
   if(body.candidate_id!==c.candidate_id||body.signed_hash!==c.artifact!.sha256)throw Error('SYNTHETIC_BINDING_MISMATCH');return Response.json(authorizationQaPreview(c));
  }
  if(method==='POST'&&path===`/v1/fiscal-authorization/candidates/${candidate}/history`){counts.history++;return Response.json(authorizationQaHistory(authorizationQaCandidate(candidate===id(1)?'55':'65')));}
  if(method==='GET'&&/^\/v1\/fiscal-authorization\/commands\/[a-f0-9-]+$/.test(path)){
   counts.command++;const command=path.split('/').at(-1)!;if(!failed.has(command)){failed.add(command);return Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,command_id:command},{status:503});}
   const c=authorizationQaCandidate(command===id(102)?'55':'65'),value=authorizationQaResult(c,true);if(value.command_id!==command)throw Error('SYNTHETIC_COMMAND_MISMATCH');return Response.json(value);
  }
  counts.forbidden++;throw Error('SYNTHETIC_WRITE_FORBIDDEN');
 }};
}
