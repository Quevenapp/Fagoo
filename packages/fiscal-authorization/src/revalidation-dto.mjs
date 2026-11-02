/** Private079 projection. SQL's source hash is opaque; no JSONB hash is recreated in JS. */
import {data,need,id,sha,integer,freeze} from './service-common.mjs';
import {context,resultEvidence,same,stamp} from './service-dto.mjs';
import {checkReviewedContext,reviewProof} from './reviewed-ledger-dto.mjs';
import {STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from './stored-response-manifest.mjs';
import {REVALIDATION_FLAGS,REVALIDATION_PROFILE,REVALIDATION_PARSER_HASH,captureRevalidationInput,projectRevalidationPublic} from './revalidation-public-dto.mjs';
need(REVALIDATION_PROFILE===STORED_RESPONSE_MANIFEST.profile&&REVALIDATION_PARSER_HASH===STORED_RESPONSE_MANIFEST_HASH,'AUTHORIZATION_REVALIDATION_PROFILE_MISMATCH');
export const REVALIDATION_RPC_PREFIX='erp_fiscal_reviewed_authorization_revalidation_';
export const REVALIDATION_RPC_LIMITS=Object.freeze({request:32768,response:262144});
const flag=x=>need(Object.entries(REVALIDATION_FLAGS).every(([k,v])=>x[k]===v));
const receiptKeys=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','intent_id','ordinal','command_id','batch_id','environment','origin','policy_version','identity_version','a1_version','created_at'];
export function revalidationSource(raw,args={}){
 const x=data(raw,['receipt','recovery','artifact','rule_review','observation']),r=data(x.receipt,receiptKeys),c=context(x.recovery,args);checkReviewedContext(c);
 need(c.origin==='operational'&&sha(c.request_hash)&&integer(c.request_size,512000));
 need(['candidate_id','unsigned_job_id','reservation_id','draft_id','attempt_id','intent_id','command_id'].every(k=>id(r[k]))&&['candidate_version','signing_a1_version','completion_version','identity_version','a1_version','policy_version'].every(k=>integer(r[k]))&&['signed_hash','basis_hash','completion_hash'].every(k=>sha(r[k]))&&integer(r.signed_size,512000)&&stamp(r.created_at)&&Date.parse(r.created_at)<Date.parse(c.expires_at));
 need(typeof r.ordinal==='string'&&/^[1-9]\d{0,14}$/.test(r.ordinal)&&r.batch_id===r.ordinal&&r.environment==='2'&&['attempt_id','intent_id','command_id','candidate_id','signed_hash','signed_size','model','origin','policy_version','identity_version','a1_version','batch_id'].every(k=>r[k]===c[k]));
 const proof=reviewProof(x.rule_review,{candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash});need(proof.profile===c.rule_profile);
 const o=data(x.observation,['sha256','size_bytes']);need(sha(o.sha256)&&integer(o.size_bytes,8192));
 const a=data(x.artifact,['response_hash','response_size','evidence','processed_hash','processed_size','created_at']);need(sha(a.response_hash)&&integer(a.response_size,512000)&&stamp(a.created_at)&&Date.parse(a.created_at)>=Date.parse(r.created_at)&&a.processed_hash===null&&a.processed_size===null);
 const e=resultEvidence(a.evidence,{origin:'operational',request_hash:c.request_hash,response_hash:a.response_hash,binding_profile:c.binding_profile,rule_profile:c.rule_profile,transport_hash:o.sha256,transport_size:o.size_bytes,outcome:'invalid_response',rejection_code:'SOAP_INVALID'});
 if(args.p_authorization_command_id!==undefined)need(r.command_id===args.p_authorization_command_id);if(args.p_expected_attempt_id!==undefined)need(r.attempt_id===args.p_expected_attempt_id);
 return freeze({receipt:r,recovery:c,artifact:{...a,evidence:e},rule_review:proof,observation:o});
}
export function captureRevalidationRpc(action,raw){
 let x;if(action==='context')x=data(raw,['p_user_id','p_authorization_command_id','p_expected_attempt_id']);
 else if(action==='command')x=data(raw,['p_user_id','p_command_id']);
 else{need(action==='finish');x=data(raw,['p_user_id','p_command_id','p_authorization_command_id','p_expected_attempt_id','p_expected_source_hash','p_parser_profile','p_parser_manifest_hash','p_evidence','p_processed_hash','p_processed_size','p_confirmed']);
  captureRevalidationInput({command_id:x.p_command_id,authorization_command_id:x.p_authorization_command_id,expected_attempt_id:x.p_expected_attempt_id,expected_source_hash:x.p_expected_source_hash,confirmed:x.p_confirmed});
  need(x.p_parser_profile===REVALIDATION_PROFILE&&x.p_parser_manifest_hash===REVALIDATION_PARSER_HASH);x.p_evidence=resultEvidence(x.p_evidence);need(x.p_evidence.origin==='operational'&&x.p_evidence.outcome!=='invalid_response');
  need(x.p_evidence.outcome==='authorization_declared'?sha(x.p_processed_hash)&&integer(x.p_processed_size,512000):x.p_processed_hash===null&&x.p_processed_size===null);
 }
 need(id(x.p_user_id));for(const k of ['p_command_id','p_authorization_command_id','p_expected_attempt_id'])if(k in x)need(id(x[k]));return freeze(x);
}
function ledgerResult(raw,args,action){
 const x=data(raw,[...Object.keys(REVALIDATION_FLAGS),'command_id','receipt','source','read_only','replayed']);flag(x);
 need(id(x.command_id)&&typeof x.replayed==='boolean'&&x.read_only===(action==='command')&&(!x.read_only||x.replayed));
 const s=revalidationSource(x.source,{p_user_id:args.p_user_id}),r=data(x.receipt,['command_id','authorization_command_id','attempt_id','candidate_id','candidate_version','signed_hash','model','origin','source_hash','parser_profile','parser_manifest_hash','original_state','state','evidence','processed_hash','processed_size','created_at','tax_rules_validated']);
 need(x.command_id===r.command_id&&id(r.command_id)&&r.command_id!==r.authorization_command_id&&r.authorization_command_id===s.receipt.command_id&&['attempt_id','candidate_id','candidate_version','signed_hash','model','origin'].every(k=>r[k]===s.receipt[k])&&sha(r.source_hash)&&r.parser_profile===REVALIDATION_PROFILE&&r.parser_manifest_hash===REVALIDATION_PARSER_HASH&&r.original_state==='review_required'&&r.tax_rules_validated===false&&stamp(r.created_at)&&Date.parse(r.created_at)>=Date.parse(s.artifact.created_at));
 r.evidence=resultEvidence(r.evidence,{origin:'operational',request_hash:s.recovery.request_hash,response_hash:s.artifact.response_hash,binding_profile:s.recovery.binding_profile,rule_profile:s.recovery.rule_profile,transport_hash:s.observation.sha256,transport_size:s.observation.size_bytes});
 const a=r.evidence.outcome==='authorization_declared';need(r.evidence.outcome!=='invalid_response'&&r.state===(a?'authorized_homologation':r.evidence.outcome));need(a?sha(r.processed_hash)&&integer(r.processed_size,512000)&&r.evidence.reference_digest===s.recovery.reference_digest:r.processed_hash===null&&r.processed_size===null);
 if(args.p_command_id!==undefined)need(x.command_id===args.p_command_id);
 if(action==='finish')need(r.authorization_command_id===args.p_authorization_command_id&&r.attempt_id===args.p_expected_attempt_id&&r.source_hash===args.p_expected_source_hash&&same(r.evidence,args.p_evidence)&&r.processed_hash===args.p_processed_hash&&r.processed_size===args.p_processed_size);
 return freeze({...x,receipt:r,source:s});
}
export function projectRevalidationLedger(action,raw,args){
 if(action!=='context')return ledgerResult(raw,args,action);
 const x=data(raw,[...Object.keys(REVALIDATION_FLAGS),'read_only','authorization_command_id','attempt_id','source','source_hash','parser_profile','parser_manifest_hash','can_revalidate','existing']);flag(x);
 need(x.read_only===true&&x.authorization_command_id===args.p_authorization_command_id&&x.attempt_id===args.p_expected_attempt_id&&sha(x.source_hash)&&x.parser_profile===REVALIDATION_PROFILE&&x.parser_manifest_hash===REVALIDATION_PARSER_HASH&&typeof x.can_revalidate==='boolean'&&x.can_revalidate===(x.existing===null));
 const s=revalidationSource(x.source,args);let e=null;if(x.existing!==null){e=ledgerResult(x.existing,{p_user_id:args.p_user_id},'command');need(e.receipt.source_hash===x.source_hash&&same(e.source,s));}return freeze({...x,source:s,existing:e});
}
const publicResult=x=>{const r=x.receipt,e=r.evidence,{evidence,...receipt}=r;return{...REVALIDATION_FLAGS,kind:'result',read_only:x.read_only,command_id:x.command_id,replayed:x.replayed,receipt:{...receipt,artifact:{response_hash:e.response_hash,response_size:x.source.artifact.response_size,...Object.fromEntries(['payload_hash','outcome','cstat','protocol_cstat','protocol_number','received_at','receipt_number','tls_origin_verified','signature_verified','xsd_validated','context_matched','processed_xsd_validated'].map(k=>[k,e[k]]))}}};};
export function revalidationPublicFromLedger(x,binding){
 if(binding.action!=='revalidationContext')return projectRevalidationPublic(publicResult(x),binding);
 const s=x.source;return projectRevalidationPublic({...REVALIDATION_FLAGS,kind:'context',read_only:true,authorization_command_id:x.authorization_command_id,attempt_id:x.attempt_id,candidate:Object.fromEntries(['candidate_id','candidate_version','signed_hash','model','origin'].map(k=>[k,s.receipt[k]])),source_hash:x.source_hash,parser:{profile:x.parser_profile,manifest_hash:x.parser_manifest_hash},original:{state:'review_required',outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,response_hash:s.artifact.response_hash,response_size:s.artifact.response_size,recorded_at:s.artifact.created_at},can_revalidate:x.can_revalidate,existing:x.existing?publicResult(x.existing):null},binding);
}
