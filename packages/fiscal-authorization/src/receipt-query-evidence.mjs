/** Private089 source projection. The SQL source_binding_hash is opaque, never recreated in JS. */
import {data,need,id,sha,integer,freeze} from './service-common.mjs';
import {context,resultEvidence,same,stamp} from './service-dto.mjs';
import {checkReviewedContext,reviewProof} from './reviewed-ledger-dto.mjs';
import {projectRevalidationLedger,revalidationSource} from './revalidation-dto.mjs';
import {REVALIDATION_FLAGS} from './revalidation-public-dto.mjs';
const keys=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','intent_id','ordinal','command_id','batch_id','environment','origin','policy_version','identity_version','a1_version','created_at'];
function pendingSource(raw,actor){
 const x=data(raw,['receipt','recovery','artifact','rule_review','observation']),r=data(x.receipt,keys),c=context(x.recovery,{p_user_id:actor});checkReviewedContext(c);
 need(c.origin==='operational'&&sha(c.request_hash)&&integer(c.request_size,512000));
 need(['candidate_id','unsigned_job_id','reservation_id','draft_id','attempt_id','intent_id','command_id'].every(k=>id(r[k]))&&['candidate_version','signing_a1_version','completion_version','identity_version','a1_version','policy_version'].every(k=>integer(r[k]))&&['signed_hash','basis_hash','completion_hash'].every(k=>sha(r[k]))&&integer(r.signed_size,512000)&&stamp(r.created_at)&&Date.parse(r.created_at)<Date.parse(c.expires_at));
 need(typeof r.ordinal==='string'&&/^[1-9]\d{0,14}$/.test(r.ordinal)&&r.batch_id===r.ordinal&&r.environment==='2'&&['attempt_id','intent_id','command_id','candidate_id','signed_hash','signed_size','model','origin','policy_version','identity_version','a1_version','batch_id'].every(k=>r[k]===c[k]));
 const proof=reviewProof(x.rule_review,{candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash});need(proof.profile===c.rule_profile);
 const o=data(x.observation,['sha256','size_bytes']);need(sha(o.sha256)&&integer(o.size_bytes,8192));
 const a=data(x.artifact,['response_hash','response_size','evidence','processed_hash','processed_size','created_at']);need(sha(a.response_hash)&&integer(a.response_size,512000)&&stamp(a.created_at)&&Date.parse(a.created_at)>=Date.parse(r.created_at)&&a.processed_hash===null&&a.processed_size===null);
 const e=resultEvidence(a.evidence,{origin:'operational',request_hash:c.request_hash,response_hash:a.response_hash,binding_profile:c.binding_profile,rule_profile:c.rule_profile,transport_hash:o.sha256,transport_size:o.size_bytes,outcome:'receipt_pending',cstat:'103'});
 return freeze({receipt:r,recovery:c,artifact:{...a,evidence:e},rule_review:proof,observation:o});
}
export function captureReceiptQuerySourceInput(raw){
 const x=data(raw,['actor','sourceKind','sourceCommandId','authorizationCommandId','authorizationAttemptId']);
 need(['authorization','revalidation'].includes(x.sourceKind)&&['actor','sourceCommandId','authorizationCommandId','authorizationAttemptId'].every(k=>id(x[k])));
 need(x.sourceKind==='authorization'?x.sourceCommandId===x.authorizationCommandId:x.sourceCommandId!==x.authorizationCommandId);return freeze(x);
}
export function projectReceiptQuerySource(raw,input){
 const v=captureReceiptQuerySourceInput(input),x=data(raw,['source_kind','source_command_id','authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin','source_binding_hash','original_source','selected_revalidation']);
 need(x.source_kind===v.sourceKind&&x.source_command_id===v.sourceCommandId&&x.authorization_command_id===v.authorizationCommandId&&x.authorization_attempt_id===v.authorizationAttemptId&&sha(x.source_binding_hash));
 const s=x.source_kind==='authorization'?pendingSource(x.original_source,v.actor):revalidationSource(x.original_source,{p_user_id:v.actor,p_authorization_command_id:v.authorizationCommandId,p_expected_attempt_id:v.authorizationAttemptId});
 need(x.authorization_command_id===s.receipt.command_id&&x.authorization_attempt_id===s.receipt.attempt_id&&['candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin'].every(k=>x[k]===s.receipt[k]));
 let selected=null;if(x.source_kind==='authorization')need(x.selected_revalidation===null);
 else{
  const q=data(x.selected_revalidation,['receipt','source']);
  // Only the079 projection envelope is supplied here. Its persisted receipt/source are literal;
  // in particular the original064 SOAP_INVALID outcome is never rewritten to receipt_pending.
  const r=projectRevalidationLedger('command',{...REVALIDATION_FLAGS,command_id:x.source_command_id,...q,read_only:true,replayed:true},{p_user_id:v.actor,p_command_id:x.source_command_id});
  need(same(r.source,s)&&r.receipt.state==='receipt_pending'&&r.receipt.evidence.outcome==='receipt_pending'&&r.receipt.evidence.cstat==='103');selected=freeze({receipt:r.receipt,source:r.source});
 }
 return freeze({...x,original_source:s,selected_revalidation:selected});
}
export const receiptQuerySourceEvidence=s=>s.source_kind==='authorization'?s.original_source.artifact.evidence:s.selected_revalidation.receipt.evidence;
