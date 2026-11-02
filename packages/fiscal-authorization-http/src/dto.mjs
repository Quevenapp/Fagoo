/** Public064 contract only. No private execution, journal, certificate or transport fields. */
import {data,need,uuid,hash,version,ordinal,timestamp,snapshot,freeze} from './protocol.mjs';
export const FLAGS=Object.freeze({data_mode:'fiscal_authorization',environment:'2',can_emit:false,can_transmit:false,production_authorized:false,legal_fiscal_value:false,financial_mutation_performed:false,stock_mutation_performed:false,retry_submission_allowed:false});
export const SERVICE_FAILURE_CODES=Object.freeze(['AUTHORIZATION_SERVICE_DISABLED','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE','AUTHORIZATION_ALREADY_RUNNING','AUTHORIZATION_SOURCE_INVALID','AUTHORIZATION_SERVICE_BYTES_INVALID','AUTHORIZATION_SERVICE_HASH_MISMATCH','AUTHORIZATION_SERVICE_BODY_INVALID','AUTHORIZATION_SERVICE_BODY_LIMIT','AUTHORIZATION_SERVICE_ABORTED','AUTHORIZATION_SERVICE_TIMEOUT','AUTHORIZATION_SERVICE_RESPONSE_INVALID','AUTHORIZATION_COMMAND_MISMATCH','AUTHORIZATION_PREPARATION_CHANGED','AUTHORIZATION_CALLBACK_INVALID','AUTHORIZATION_GRANT_MISMATCH','AUTHORIZATION_REQUEST_INVALID','AUTHORIZATION_BINDING_INVALID','AUTHORIZATION_JOURNAL_MISSING','AUTHORIZATION_JOURNAL_CONFLICT','AUTHORIZATION_VALIDATOR_INVALID','AUTHORIZATION_PORT_FAILED','AUTHORIZATION_STORED_MISMATCH','AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH','AUTHORIZATION_PINNED_CERTIFICATE_INVALID','42501','40001','22023','55000','P0002']);
const STATES=['prepared','request_ready','dispatched','submission_uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorization_observed','authorized_homologation'];
const TERMINAL=['receipt_pending','rejected','review_required','authorization_observed','authorized_homologation'];
const FAILURES=['PREPARATION_FAILED','REQUEST_INVALID','TRANSPORT_UNCONFIRMED','JOURNAL_UNAVAILABLE','VALIDATOR_UNAVAILABLE'];
const requireValue=v=>need(v,502,'AUTHORIZATION_RESPONSE_INVALID');
const exact=(v,keys)=>data(v,keys,[],502,'AUTHORIZATION_RESPONSE_INVALID');
const boolean=v=>typeof v==='boolean';
const size=v=>version(v)&&v<=512000;
const model=v=>v==='55'||v==='65';
const origin=v=>v==='synthetic'||v==='operational';
const label=v=>typeof v==='string'&&/^[A-Za-z0-9._-]{1,120}$/.test(v);
const cstat=v=>typeof v==='string'&&/^\d{3,4}$/.test(v);
const protocolNumber=v=>typeof v==='string'&&/^(?:\d{15}|\d{17})$/.test(v)&&!/^0+$/.test(v);
const receiptNumber=v=>typeof v==='string'&&/^\d{15}$/.test(v)&&!/^0+$/.test(v);
const flags=v=>requireValue(Object.entries(FLAGS).every(([k,x])=>v[k]===x));
const R=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','intent_id','ordinal','command_id','batch_id','environment','origin','policy_version','identity_version','a1_version','created_at'];
function receipt(raw,binding){
 const v=exact(raw,R);
 requireValue(['candidate_id','unsigned_job_id','reservation_id','draft_id','attempt_id','intent_id','command_id'].every(k=>uuid(v[k]))&&['candidate_version','signing_a1_version','completion_version','policy_version','identity_version','a1_version'].every(k=>version(v[k]))&&['signed_hash','basis_hash','completion_hash'].every(k=>hash(v[k]))&&size(v.signed_size)&&model(v.model)&&origin(v.origin)&&v.environment==='2'&&ordinal(v.ordinal)&&v.batch_id===v.ordinal&&timestamp(v.created_at));
 if(binding.commandId!==undefined)requireValue(v.command_id===binding.commandId);
 if(binding.candidateId!==undefined)requireValue(v.candidate_id===binding.candidateId);
 return v;
}
function current(raw,r){
 const v=exact(raw,['state','grant_consumed','used_at','expires_at','lease_expired','finished_at','identity_changed','a1_changed','policy_changed','policy_enabled','candidate','recovery_required','authorized_in_homologation']);
 requireValue(STATES.includes(v.state)&&['grant_consumed','lease_expired','identity_changed','a1_changed','policy_changed','policy_enabled','recovery_required','authorized_in_homologation'].every(k=>boolean(v[k]))&&timestamp(v.expires_at)&&(v.used_at===null||timestamp(v.used_at))&&(v.finished_at===null||timestamp(v.finished_at)));
 requireValue(v.grant_consumed===(v.used_at!==null)&&v.grant_consumed===!['prepared','request_ready','failed_before_dispatch'].includes(v.state)&&v.recovery_required===['dispatched','submission_uncertain'].includes(v.state)&&v.authorized_in_homologation===(v.state==='authorized_homologation')&&(!v.authorized_in_homologation||r.origin==='operational')&&(['prepared','request_ready','dispatched'].includes(v.state)===(v.finished_at===null))&&Date.parse(v.expires_at)>Date.parse(r.created_at));
 if(v.used_at!==null)requireValue(Date.parse(v.used_at)>=Date.parse(r.created_at)&&Date.parse(v.used_at)<Date.parse(v.expires_at));
 if(v.finished_at!==null)requireValue(Date.parse(v.finished_at)>=Date.parse(v.used_at??r.created_at));
 const c=exact(v.candidate,['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current']);
 requireValue(c.state==='stored'&&version(c.attempt_count)&&c.attempt_count<=100&&c.lease_until===null&&version(c.a1_version,0)&&uuid(c.latest_candidate_id)&&version(c.latest_candidate_version)&&c.latest_candidate_version>=r.candidate_version&&['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'].every(k=>boolean(c[k])));
 requireValue(c.is_latest_candidate===(c.latest_candidate_id===r.candidate_id)&&c.is_latest_candidate===(c.latest_candidate_version===r.candidate_version)&&c.a1_changed===(c.a1_version!==r.signing_a1_version)&&c.artifact_current===(c.is_latest_candidate&&!c.a1_changed&&c.certificate_time_valid_now&&c.unsigned_artifact_current&&c.series_enabled));
 return {...v,candidate:c};
}
function artifact(raw,r,c){
 if(!TERMINAL.includes(c.state)){requireValue(raw===null);return null;}
 const v=exact(raw,['response_hash','response_size','processed_hash','processed_size','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','receipt_number','tls_origin_verified','created_at']);
 requireValue(hash(v.response_hash)&&size(v.response_size)&&timestamp(v.created_at)&&Date.parse(v.created_at)>=Date.parse(c.used_at)&&v.tls_origin_verified===(r.origin==='operational'));
 const declared=v.outcome==='authorization_declared';
 requireValue(declared?hash(v.processed_hash)&&size(v.processed_size):v.processed_hash===null&&v.processed_size===null);
 if(v.outcome==='invalid_response')requireValue(['SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID'].includes(v.rejection_code)&&['cstat','protocol_cstat','protocol_number','received_at','receipt_number'].every(k=>v[k]===null));
 else{
  requireValue(v.rejection_code===null&&cstat(v.cstat)&&(v.protocol_cstat===null||cstat(v.protocol_cstat)&&v.cstat==='104')&&(v.protocol_number===null||protocolNumber(v.protocol_number))&&timestamp(v.received_at));
  if(declared)requireValue(v.cstat==='104'&&['100','150'].includes(v.protocol_cstat)&&protocolNumber(v.protocol_number)&&v.receipt_number===null);
  else if(v.outcome==='receipt_pending')requireValue(v.cstat==='103'&&receiptNumber(v.receipt_number)&&v.protocol_cstat===null&&v.protocol_number===null);
  else{requireValue(v.receipt_number===null);if(v.outcome==='rejected')requireValue(Number(v.protocol_cstat??v.cstat)>=200&&!['204','217','539'].includes(v.protocol_cstat??v.cstat));else requireValue(v.outcome==='review_required'&&!['100','150'].includes(v.protocol_cstat)&&!['100','150'].includes(v.cstat));}
 }
 requireValue(c.state===(declared?(r.origin==='synthetic'?'authorization_observed':'authorized_homologation'):v.outcome==='invalid_response'?'review_required':v.outcome));return v;
}
function result(raw,binding,reading){
 const v=exact(raw,[...Object.keys(FLAGS),'status','command_id','receipt','current','error_code','artifact','read_only','recovered','failure_code','recovery_required','recoverable_by_actor']);flags(v);
 requireValue(uuid(v.command_id)&&v.read_only===reading&&['recovered','recovery_required','recoverable_by_actor'].every(k=>boolean(v[k]))&&(v.failure_code===null||SERVICE_FAILURE_CODES.includes(v.failure_code)));
 if(binding.commandId!==undefined)requireValue(v.command_id===binding.commandId);
 if(reading)requireValue(v.recovered===false&&v.failure_code===null);
 if(v.receipt===null){requireValue(!reading&&v.current===null&&v.artifact===null&&v.error_code===null&&v.status==='unconfirmed'&&v.failure_code!==null&&v.recovery_required===true&&v.recovered===false&&v.recoverable_by_actor===false);return v;}
 const r=receipt(v.receipt,binding),c=current(v.current,r),a=artifact(v.artifact,r,c);
 requireValue(v.command_id===r.command_id&&(['failed_before_dispatch','submission_uncertain'].includes(c.state)?FAILURES.includes(v.error_code):v.error_code===null)&&(!v.recoverable_by_actor||c.grant_consumed&&c.recovery_required));
 if(v.failure_code===null)requireValue(v.status===c.state&&v.recovery_required===c.recovery_required);
 else requireValue(!reading&&v.status==='unconfirmed'&&v.recovery_required===true&&v.recovered===false&&!TERMINAL.includes(c.state));
 return {...v,receipt:r,current:c,artifact:a};
}
function preview(raw,binding){
 const v=exact(raw,[...Object.keys(FLAGS),'read_only','candidate_id','signed_hash','model','policy','blockers','can_prepare','signature_checked','certificate_pin_checked','operational_binding_available','service_enabled']);flags(v);
 requireValue(v.read_only===true&&v.candidate_id===binding.candidateId&&v.signed_hash===binding.signedHash&&uuid(v.candidate_id)&&hash(v.signed_hash)&&model(v.model)&&v.can_prepare===false&&v.signature_checked===true&&v.certificate_pin_checked===true&&v.operational_binding_available===false&&boolean(v.service_enabled));
 const p=exact(v.policy,['model','version','origin','enabled','binding_profile','rule_profile','binding_reviewed','tax_rules_reviewed','source_manifest_hash','valid_from','valid_until','created_at']);
 requireValue(p.model===v.model&&version(p.version)&&origin(p.origin)&&['enabled','binding_reviewed','tax_rules_reviewed'].every(k=>boolean(p[k]))&&(p.binding_profile===null||label(p.binding_profile))&&(p.rule_profile===null||label(p.rule_profile))&&(p.source_manifest_hash===null||hash(p.source_manifest_hash))&&['valid_from','valid_until','created_at'].every(k=>timestamp(p[k]))&&Date.parse(p.valid_from)<Date.parse(p.valid_until));
 requireValue(Array.isArray(v.blockers)&&v.blockers.length<=6&&new Set(v.blockers).size===v.blockers.length&&v.blockers.every(x=>['POLICY_DISABLED','BINDING_NOT_REVIEWED','RULE_PROFILE_NOT_REVIEWED','POLICY_TIME_INVALID','CANDIDATE_NOT_CURRENT','SUBMISSION_ALREADY_CONSUMED'].includes(x)));return {...v,policy:p};
}
export function publicResult(raw,binding){
 const b=data(binding,['action'],['commandId','candidateId','signedHash','limit','before']);requireValue(['preview','command','history','recover'].includes(b.action));const v=snapshot(raw);let out;
 if(b.action==='preview')out=preview(v,b);
 else if(b.action==='history'){
  const h=exact(v,[...Object.keys(FLAGS),'read_only','candidate_id','items','limit','has_more','next_cursor']);flags(h);
  requireValue(h.read_only===true&&uuid(h.candidate_id)&&h.candidate_id===b.candidateId&&Number.isInteger(h.limit)&&h.limit>=1&&h.limit<=25&&h.limit===b.limit&&Array.isArray(h.items)&&h.items.length<=h.limit&&boolean(h.has_more));
  let before=b.before??'1000000000000000';requireValue(b.before===null||ordinal(b.before));const commands=new Set(),attempts=new Set();
  const items=h.items.map(x=>{const item=result(x,{candidateId:b.candidateId},true);requireValue(BigInt(item.receipt.ordinal)<BigInt(before)&&!commands.has(item.command_id)&&!attempts.has(item.receipt.attempt_id));before=item.receipt.ordinal;commands.add(item.command_id);attempts.add(item.receipt.attempt_id);return item;});
  requireValue(h.has_more?items.length===h.limit&&h.next_cursor===items.at(-1)?.receipt.ordinal:h.next_cursor===null);out={...h,items};
 }else out=result(v,b,b.action==='command');
 return freeze(out);
}
