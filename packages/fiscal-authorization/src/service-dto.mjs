/** Private064 projection. execution/recovery and evidence never cross a public boundary. */
import {isValidCnpj} from '../../fiscal-core/src/identity.mjs';
import {timestamp as stamp,projectResponse as signedResponse} from '../../fiscal-signed-rpc/src/dto.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as PROFILE} from './validator.mjs';
import {data,need,id,sha,integer,freeze} from './service-common.mjs';
export {stamp};
export const FLAGS=Object.freeze({data_mode:'fiscal_authorization',environment:'2',can_emit:false,can_transmit:false,production_authorized:false,legal_fiscal_value:false,financial_mutation_performed:false,stock_mutation_performed:false,retry_submission_allowed:false});
export const SQLSTATES=Object.freeze(['42501','40001','22023','55000','P0002']);
export const FAILURES=Object.freeze(['PREPARATION_FAILED','REQUEST_INVALID','TRANSPORT_UNCONFIRMED','JOURNAL_UNAVAILABLE','VALIDATOR_UNAVAILABLE']);
export const STATES=Object.freeze(['prepared','request_ready','dispatched','submission_uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorization_observed','authorized_homologation']);
export const TERMINAL=Object.freeze(['receipt_pending','rejected','review_required','authorization_observed','authorized_homologation']);
const exact=(v,k,o=[])=>data(v,k,o,'AUTHORIZATION_SERVICE_RESPONSE_INVALID');
const flag=v=>need(Object.entries(FLAGS).every(([k,x])=>v[k]===x));
const ordinal=v=>typeof v==='string'&&/^[1-9]\d{0,14}$/.test(v);
const digest=v=>typeof v==='string'&&/^[A-Za-z0-9+/]{27}=$/.test(v)&&Buffer.from(v,'base64').toString('base64')===v;
const model=v=>['55','65'].includes(v),origin=v=>['synthetic','operational'].includes(v);
const label=v=>typeof v==='string'&&/^[a-zA-Z0-9._-]{1,120}$/.test(v);
const iso=v=>stamp(v)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);
const status=v=>typeof v==='string'&&/^\d{3,4}$/.test(v);
const number=v=>typeof v==='string'&&/^(?:\d{15}|\d{17})$/.test(v)&&!/^0+$/.test(v);
export const same=(a,b)=>a===b||a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
function binds(v,args){for(const[a,k]of [['p_user_id','actor'],['p_command_id','command_id'],['p_attempt_id','attempt_id'],['p_lease_id','lease_id'],['p_candidate_id','candidate_id'],['p_signed_hash','signed_hash'],['p_expected_identity_version','identity_version'],['p_expected_a1_version','a1_version'],['p_expected_policy_version','policy_version'],['p_request_hash','request_hash'],['p_request_size','request_size']])if(Object.hasOwn(args,a)&&Object.hasOwn(v,k))need(v[k]===args[a]);}
const CONTEXT=['private_executor_only','attempt_id','intent_id','command_id','actor','lease_id','nonce','expires_at','purpose','environment','model','origin','policy_version','binding_profile','rule_profile','policy_manifest_hash','candidate_id','signed_hash','signed_size','batch_id','access_key','reference_digest','issuer_cnpj','identity_version','a1_version','credential_id','envelope_hash','certificate_fingerprint','request_hash','request_size'];
export function context(raw,args={},issued=false){
 const v=exact(raw,issued?[...CONTEXT,'issued_at']:CONTEXT);
 need(v.private_executor_only===true&&['attempt_id','intent_id','command_id','actor','lease_id','nonce','candidate_id','credential_id'].every(k=>id(v[k]))&&['signed_hash','envelope_hash','certificate_fingerprint','policy_manifest_hash'].every(k=>sha(v[k]))&&['identity_version','a1_version','policy_version'].every(k=>integer(v[k]))&&integer(v.signed_size,512000)&&stamp(v.expires_at)&&model(v.model)&&origin(v.origin)&&v.environment==='2'&&v.purpose==='sp-authorization-homologation-v1'&&label(v.binding_profile)&&label(v.rule_profile)&&ordinal(v.batch_id)&&digest(v.reference_digest));
 need(typeof v.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(v.access_key)&&isValidCnpj(v.issuer_cnpj)&&v.access_key.slice(6,20)===v.issuer_cnpj&&v.access_key.slice(20,22)===v.model&&v.access_key.slice(0,2)==='35');
 need(v.request_hash===null&&v.request_size===null||sha(v.request_hash)&&integer(v.request_size,512000));
 if(issued)need(stamp(v.issued_at)&&Date.parse(v.issued_at)<Date.parse(v.expires_at)&&sha(v.request_hash));binds(v,args);return freeze(v);
}
const R=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','intent_id','ordinal','command_id','batch_id','environment','origin','policy_version','identity_version','a1_version','created_at'];
function receipt(raw,args){const v=exact(raw,R);need(['candidate_id','unsigned_job_id','reservation_id','draft_id','attempt_id','intent_id','command_id'].every(k=>id(v[k]))&&['candidate_version','signing_a1_version','completion_version','identity_version','a1_version','policy_version'].every(k=>integer(v[k]))&&['signed_hash','basis_hash','completion_hash'].every(k=>sha(v[k]))&&integer(v.signed_size,512000)&&model(v.model)&&origin(v.origin)&&v.environment==='2'&&ordinal(v.ordinal)&&v.batch_id===v.ordinal&&stamp(v.created_at));binds(v,args);return v;}
const C=['state','grant_consumed','used_at','expires_at','lease_expired','finished_at','identity_changed','a1_changed','policy_changed','policy_enabled','candidate','recovery_required','authorized_in_homologation'];
function current(raw,r){const v=exact(raw,C);need(STATES.includes(v.state)&&['grant_consumed','lease_expired','identity_changed','a1_changed','policy_changed','policy_enabled','recovery_required','authorized_in_homologation'].every(k=>typeof v[k]==='boolean')&&stamp(v.expires_at)&&(v.used_at===null||stamp(v.used_at))&&(v.finished_at===null||stamp(v.finished_at)));
 need(v.grant_consumed===(v.used_at!==null)&&v.grant_consumed===!['prepared','request_ready','failed_before_dispatch'].includes(v.state)&&v.recovery_required===['dispatched','submission_uncertain'].includes(v.state)&&v.authorized_in_homologation===(v.state==='authorized_homologation')&&(!v.authorized_in_homologation||r.origin==='operational')&&(['prepared','request_ready','dispatched'].includes(v.state)===(v.finished_at===null))&&Date.parse(v.expires_at)>Date.parse(r.created_at));
 if(v.used_at!==null)need(Date.parse(v.used_at)>=Date.parse(r.created_at)&&Date.parse(v.used_at)<Date.parse(v.expires_at));if(v.finished_at!==null)need(Date.parse(v.finished_at)>=Date.parse(v.used_at??r.created_at));
 const p=exact(v.candidate,['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current']);
 need(p.state==='stored'&&integer(p.attempt_count,100)&&p.lease_until===null&&integer(p.a1_version,2147483647,0)&&id(p.latest_candidate_id)&&integer(p.latest_candidate_version)&&p.latest_candidate_version>=r.candidate_version&&['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'].every(k=>typeof p[k]==='boolean'));
 need(p.is_latest_candidate===(p.latest_candidate_id===r.candidate_id)&&p.is_latest_candidate===(p.latest_candidate_version===r.candidate_version)&&p.a1_changed===(p.a1_version!==r.signing_a1_version)&&p.artifact_current===(p.is_latest_candidate&&!p.a1_changed&&p.certificate_time_valid_now&&p.unsigned_artifact_current&&p.series_enabled));return{...v,candidate:p};
}
function profiles(v){need(origin(v.origin)&&sha(v.request_hash)&&v.schema_profile===PROFILE.profile&&v.schema_manifest_hash===PROFILE.manifestHash&&v.validator_hash===PROFILE.validatorHash&&label(v.binding_profile)&&label(v.rule_profile)&&v.can_emit===false&&v.can_transmit===false);}
export function preparationEvidence(raw,expected={}){
 const v=exact(raw,['origin','request_hash','payload_hash','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit']);profiles(v);
 need(sha(v.payload_hash)&&sha(v.signed_hash)&&sha(v.certificate_fingerprint)&&model(v.model)&&v.environment==='2'&&ordinal(v.batch_id)&&typeof v.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(v.access_key)&&digest(v.reference_digest)&&v.signature_verified===true&&v.xsd_validated===true&&v.context_matched===true&&v.tax_rules_validated===(v.origin==='operational'));
 for(const[k,x]of Object.entries(expected))need(v[k]===x);return freeze(v);
}
export function resultEvidence(raw,expected={}){
 const v=exact(raw,['origin','request_hash','response_hash','payload_hash','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','receipt_number','reference_digest','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','transport_hash','transport_size','can_emit','can_transmit']);profiles(v);
 need(sha(v.response_hash)&&(v.payload_hash===null||sha(v.payload_hash))&&v.tls_origin_verified===(v.origin==='operational')&&(v.origin==='synthetic'?v.transport_hash===null&&v.transport_size===null:sha(v.transport_hash)&&integer(v.transport_size,8192)));
 if(v.outcome==='invalid_response')need(['SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID'].includes(v.rejection_code)&&['cstat','protocol_cstat','protocol_number','received_at','receipt_number','reference_digest'].every(k=>v[k]===null)&&['signature_verified','xsd_validated','context_matched','processed_xsd_validated'].every(k=>v[k]===false));
 else{
  need(sha(v.payload_hash)&&v.rejection_code===null&&v.xsd_validated===true&&v.context_matched===true&&status(v.cstat)&&(v.protocol_cstat===null||status(v.protocol_cstat)&&v.cstat==='104')&&(v.protocol_number===null||number(v.protocol_number))&&iso(v.received_at));
  if(v.outcome==='authorization_declared')need(v.cstat==='104'&&['100','150'].includes(v.protocol_cstat)&&number(v.protocol_number)&&digest(v.reference_digest)&&v.signature_verified===true&&v.processed_xsd_validated===true&&v.receipt_number===null);
  else{need(v.signature_verified===false&&v.processed_xsd_validated===false&&v.reference_digest===null);
   if(v.outcome==='receipt_pending')need(v.cstat==='103'&&typeof v.receipt_number==='string'&&/^\d{15}$/.test(v.receipt_number)&&!/^0+$/.test(v.receipt_number)&&v.protocol_cstat===null&&v.protocol_number===null);
   else{need(v.receipt_number===null);if(v.outcome==='rejected')need(Number(v.protocol_cstat??v.cstat)>=200&&!['204','217','539'].includes(v.protocol_cstat??v.cstat));else need(v.outcome==='review_required'&&!['100','150'].includes(v.protocol_cstat)&&!['100','150'].includes(v.cstat));}
  }
 }
 for(const[k,x]of Object.entries(expected))need(v[k]===x);return freeze(v);
}
function view(raw,args,extra=[],history=false){
 const v=exact(raw,[...Object.keys(FLAGS),'command_id','receipt','current','artifact','error_code',...(history?['recoverable_by_actor']:['recovery']),...extra]);flag(v);
 const r=receipt(v.receipt,args),c=current(v.current,r);need(v.command_id===r.command_id&&(['failed_before_dispatch','submission_uncertain'].includes(c.state)?FAILURES.includes(v.error_code):v.error_code===null));
 let a=null;if(TERMINAL.includes(c.state)){const x=exact(v.artifact,['response_hash','response_size','evidence','processed_hash','processed_size','created_at']);need(sha(x.response_hash)&&integer(x.response_size,512000)&&stamp(x.created_at)&&Date.parse(x.created_at)>=Date.parse(c.used_at));const e=resultEvidence(x.evidence,{origin:r.origin,response_hash:x.response_hash});
  const declared=e.outcome==='authorization_declared';need(declared?sha(x.processed_hash)&&integer(x.processed_size,512000):x.processed_hash===null&&x.processed_size===null);need(c.state===(declared?(r.origin==='synthetic'?'authorization_observed':'authorized_homologation'):e.outcome==='invalid_response'?'review_required':e.outcome));a={...x,evidence:e};
 }else need(v.artifact===null);
 const out={...FLAGS,command_id:r.command_id,receipt:r,current:c,artifact:a,error_code:v.error_code};
 if(history){need(typeof v.recoverable_by_actor==='boolean'&&(!v.recoverable_by_actor||c.recovery_required));out.recoverable_by_actor=v.recoverable_by_actor;}
 else{const ctx=context(v.recovery,args);for(const k of ['attempt_id','intent_id','command_id','candidate_id','signed_hash','signed_size','model','origin','policy_version','identity_version','a1_version','batch_id'])need(ctx[k]===r[k]);need(ctx.expires_at===c.expires_at&&(ctx.request_hash!==null||['prepared','failed_before_dispatch'].includes(c.state)));if(a)need(a.evidence.request_hash===ctx.request_hash&&a.evidence.binding_profile===ctx.binding_profile&&a.evidence.rule_profile===ctx.rule_profile&&(!a.evidence.reference_digest||a.evidence.reference_digest===ctx.reference_digest));out.recovery=ctx;}
 return out;
}
export function projectResponse(name,raw,args){
 if(name==='erp_fiscal_signed_get'){try{return freeze(signedResponse(name,raw,args));}catch{need(false);}}
 need(typeof name==='string'&&name.startsWith('erp_fiscal_authorization_'));const action=name.slice('erp_fiscal_authorization_'.length);
 if(action==='preview'){
  const v=exact(raw,[...Object.keys(FLAGS),'read_only','candidate_id','signed_hash','model','policy','blockers','can_prepare']);flag(v);need(v.read_only===true&&v.candidate_id===args.p_candidate_id&&v.signed_hash===args.p_signed_hash&&model(v.model));
  const p=exact(v.policy,['model','version','origin','enabled','binding_profile','rule_profile','binding_reviewed','tax_rules_reviewed','source_manifest_hash','valid_from','valid_until','created_at']);need(p.model===v.model&&integer(p.version)&&origin(p.origin)&&['enabled','binding_reviewed','tax_rules_reviewed'].every(k=>typeof p[k]==='boolean')&&(p.binding_profile===null||label(p.binding_profile))&&(p.rule_profile===null||label(p.rule_profile))&&(p.source_manifest_hash===null||sha(p.source_manifest_hash))&&['valid_from','valid_until','created_at'].every(k=>stamp(p[k]))&&Date.parse(p.valid_from)<Date.parse(p.valid_until));
  need(Array.isArray(v.blockers)&&v.blockers.length<=6&&new Set(v.blockers).size===v.blockers.length&&v.blockers.every(x=>['POLICY_DISABLED','BINDING_NOT_REVIEWED','RULE_PROFILE_NOT_REVIEWED','POLICY_TIME_INVALID','CANDIDATE_NOT_CURRENT','SUBMISSION_ALREADY_CONSUMED'].includes(x))&&v.can_prepare===(v.blockers.length===0));return freeze({...v,policy:p,blockers:[...v.blockers]});
 }
 if(action==='use'){const v=exact(raw,[...Object.keys(FLAGS),'private_executor_only','grant']);flag(v);need(v.private_executor_only===true);return freeze({...FLAGS,private_executor_only:true,grant:context(v.grant,args,true)});}
 if(action==='history'){
  const v=exact(raw,[...Object.keys(FLAGS),'read_only','candidate_id','items','limit','has_more','next_cursor']);flag(v);need(v.read_only===true&&v.candidate_id===args.p_candidate_id&&v.limit===(args.p_limit??25)&&integer(v.limit,25)&&Array.isArray(v.items)&&v.items.length<=v.limit&&typeof v.has_more==='boolean');
  let before=args.p_before??'1000000000000000';const items=v.items.map(x=>{const row=view(x,{p_candidate_id:args.p_candidate_id},['read_only'],true);need(x.read_only===true&&BigInt(row.receipt.ordinal)<BigInt(before));before=row.receipt.ordinal;return{...row,read_only:true};});need(v.has_more?items.length===v.limit&&v.next_cursor===items.at(-1)?.receipt.ordinal:v.next_cursor===null);return freeze({...FLAGS,read_only:true,candidate_id:v.candidate_id,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor});
 }
 need(['begin','prepare','finish','fail','command'].includes(action));const out=view(raw,args,action==='begin'?['replayed','execution']:action==='command'?['read_only']:['replayed']);
 if(action==='command'){need(raw.read_only===true);out.read_only=true;}else{need(typeof raw.replayed==='boolean');out.replayed=raw.replayed;}
 if(action==='begin'){out.execution=null;if(raw.execution!==null){out.execution=context(raw.execution,args);need(same(out.execution,out.recovery)&&['prepared','request_ready'].includes(out.current.state)&&!out.current.lease_expired);}}
 if(action==='prepare')need(out.recovery.request_hash===args.p_request_hash&&out.recovery.request_size===args.p_request_size);
 if(action==='finish')need(out.artifact&&out.artifact.response_hash===args.p_response_hash&&out.artifact.response_size===args.p_response_size&&out.artifact.processed_hash===args.p_processed_hash&&out.artifact.processed_size===args.p_processed_size&&same(out.artifact.evidence,resultEvidence(args.p_evidence)));
 return freeze(out);
}
/** Backend result with compact public-safe fields; no evidence, XML, key, issuer, credential or lease IDs. */
export function result(v,{readOnly=false,recovered=false,failureCode=null,commandId=null}={}){
 const a=v?.artifact,e=a?.evidence;
 return freeze({...FLAGS,status:failureCode?'unconfirmed':v?.current.state??'unconfirmed',command_id:v?.command_id??commandId,receipt:v?.receipt??null,current:v?.current??null,error_code:v?.error_code??null,
  artifact:a?{response_hash:a.response_hash,response_size:a.response_size,processed_hash:a.processed_hash,processed_size:a.processed_size,outcome:e.outcome,rejection_code:e.rejection_code,cstat:e.cstat,protocol_cstat:e.protocol_cstat,protocol_number:e.protocol_number,received_at:e.received_at,receipt_number:e.receipt_number,tls_origin_verified:e.tls_origin_verified,created_at:a.created_at}:null,
  read_only:readOnly,recovered,failure_code:failureCode,recovery_required:failureCode!==null||v?.current.recovery_required===true,recoverable_by_actor:v?.recoverable_by_actor??Boolean(v?.recovery&&v.current.recovery_required)});
}
