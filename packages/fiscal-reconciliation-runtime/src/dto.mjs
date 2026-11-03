/** Web-safe public projection. No XML, credential reference, nonce or lease ID crosses this boundary. */
import {need,plain,uuid,sha256,version} from './protocol.mjs';
import {OPERATIONAL_FLAGS as FLAGS,SERVICE_FAILURE_CODES} from '../../fiscal-reconciliation/src/profiles.mjs';
import {timestamp} from '../../fiscal-wsdl-runtime/src/dto.mjs';
export {FLAGS,SERVICE_FAILURE_CODES};
export const FAILURES=Object.freeze(['PREPARATION_FAILED','REQUEST_INVALID','TRANSPORT_UNCONFIRMED','JOURNAL_UNAVAILABLE','VALIDATOR_UNAVAILABLE']);
export const REJECTION_CODES=Object.freeze(['SOAP_RESPONSE_REJECTED','XML_SIZE_OR_TYPE_INVALID','XML_ENCODING_INVALID','XML_DECLARATION_UNSUPPORTED','XML_MALFORMED','XML_QUERY_ROOT_INVALID','XML_TREE_LIMIT','XML_XSD_INVALID','XML_HOMOLOGATION_REQUIRED','XML_QUERY_KEY_MISMATCH','XML_QUERY_UF_MISMATCH','XML_QUERY_TIMESTAMP_INVALID','XML_PROTOCOL_CONTEXT_MISMATCH','XML_PROTOCOL_TIMESTAMP_INVALID','XML_PROTOCOL_DIGEST_INVALID','XML_AUTHORIZATION_PROTOCOL_INCOMPLETE','XML_PROTOCOL_DIGEST_MISMATCH','XML_EVENT_CONTEXT_MISMATCH']);
const RECEIPT=['candidate_id','candidate_version','unsigned_job_id','reservation_id','draft_id','model','signed_hash','signed_size','signing_a1_version','basis_hash','completion_version','completion_hash','attempt_id','ordinal','command_id','profile','environment','identity_version','a1_version','confirmed','created_at'];
const CURRENT=['state','identity_version','a1_version','company_changed','a1_changed','grant_consumed','lease_expired','expires_at','used_at','finished_at','recovery_required','retry_transport_allowed','candidate'];
const CANDIDATE=['state','attempt_count','lease_until','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
const ARTIFACT=['sha256','size_bytes','outcome','rejection_code','cstat','event_reconciliation_required','created_at','tls_origin_verified'];
const BASE=[...Object.keys(FLAGS),'status','command_id','receipt','current','error_code','artifact','recovered','failure_code','retry_transport_allowed','recovery_required','read_only','recoverable_by_actor'];
const STATES=['prepared','dispatched','stored','failed_before_dispatch','uncertain'];
const bad=value=>need(value,502,'RECONCILIATION_RESPONSE_INVALID');
const has=(v,keys)=>plain(v)&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const boolean=(v,keys)=>keys.every(k=>typeof v[k]==='boolean');
const size=v=>Number.isInteger(v)&&v>=1&&v<=512000;
const sameFlags=v=>Object.entries(FLAGS).every(([k,x])=>v[k]===x);

function currentView(c,r){
 bad(has(c,CURRENT)&&STATES.includes(c.state)&&(c.identity_version===null||version(c.identity_version))&&version(c.a1_version,0)
  &&boolean(c,['company_changed','a1_changed','grant_consumed','lease_expired','recovery_required'])&&c.retry_transport_allowed===false
  &&timestamp(c.expires_at)&&(c.used_at===null||timestamp(c.used_at))&&(c.finished_at===null||timestamp(c.finished_at)));
 bad((c.identity_version===r.identity_version||c.company_changed)&&(c.a1_version===r.a1_version||c.a1_changed)
  &&c.grant_consumed===(c.used_at!==null)&&c.grant_consumed===['dispatched','stored','uncertain'].includes(c.state)
  &&c.recovery_required===['dispatched','uncertain'].includes(c.state)&&(['prepared','dispatched'].includes(c.state)===(c.finished_at===null))
  &&Date.parse(c.expires_at)>Date.parse(r.created_at));
 if(c.used_at!==null)bad(Date.parse(c.used_at)>=Date.parse(r.created_at)&&Date.parse(c.used_at)<Date.parse(c.expires_at));
 if(c.finished_at!==null)bad(Date.parse(c.finished_at)>=Date.parse(c.used_at??r.created_at));
 const p=c.candidate;
 bad(has(p,CANDIDATE)&&p.state==='stored'&&version(p.attempt_count)&&p.attempt_count<=100&&p.lease_until===null&&version(p.a1_version,0)
  &&uuid(p.latest_candidate_id)&&version(p.latest_candidate_version)&&p.latest_candidate_version>=r.candidate_version
  &&boolean(p,['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current']));
 bad(p.is_latest_candidate===(p.latest_candidate_id===r.candidate_id)&&p.is_latest_candidate===(p.latest_candidate_version===r.candidate_version)
  &&p.artifact_current===(p.is_latest_candidate&&!p.a1_changed&&p.certificate_time_valid_now&&p.unsigned_artifact_current&&p.series_enabled));
 return {...pick(c,CURRENT),candidate:pick(p,CANDIDATE)};
}

function result(v,{action,payload,commandId,candidateId}={}){
 bad(['run','command','recover','history_item'].includes(action)&&has(v,BASE)&&sameFlags(v));
 const expected=['run','recover'].includes(action)?payload?.command_id:commandId;
 bad(uuid(expected)&&v.command_id===expected&&(commandId===undefined||commandId===expected));
 const reading=action==='command'||action==='history_item';
 bad([...STATES,'unconfirmed'].includes(v.status)&&v.read_only===reading&&boolean(v,['recovered','recovery_required','recoverable_by_actor'])
  &&v.retry_transport_allowed===false&&(v.failure_code===null||SERVICE_FAILURE_CODES.includes(v.failure_code)));
 if(reading)bad(v.failure_code===null&&!v.recovered&&v.status!=='unconfirmed');
 let receipt=null,current=null,artifact=null;
 const r=v.receipt;
 if(r===null){
  bad(!reading&&v.current===null&&v.artifact===null&&v.error_code===null&&v.status==='unconfirmed'&&v.failure_code!==null&&v.recovery_required&&!v.recovered);
 }else{
  bad(has(r,RECEIPT)&&['candidate_id','unsigned_job_id','reservation_id','draft_id','attempt_id','command_id'].every(k=>uuid(r[k]))
   &&['candidate_version','signing_a1_version','completion_version','identity_version','a1_version'].every(k=>version(r[k]))
   &&Number.isSafeInteger(r.ordinal)&&r.ordinal>0&&['signed_hash','basis_hash','completion_hash'].every(k=>sha256(r[k]))
   &&size(r.signed_size)&&['55','65'].includes(r.model)&&r.profile===FLAGS.profile&&r.environment==='2'&&r.confirmed===true&&timestamp(r.created_at)&&r.command_id===expected);
  if(candidateId!==undefined)bad(r.candidate_id===candidateId);
  if(action==='run')bad(r.candidate_id===payload.candidate_id&&r.signed_hash===payload.signed_hash&&r.a1_version===payload.expected_a1_version&&r.identity_version===payload.expected_identity_version&&payload.confirmed===true);
  current=currentView(v.current,r);
  bad(!v.recoverable_by_actor||current.grant_consumed&&current.recovery_required);
  bad(['failed_before_dispatch','uncertain'].includes(current.state)?FAILURES.includes(v.error_code):v.error_code===null);
  bad(v.status===current.state||!reading&&v.status==='unconfirmed'&&v.failure_code!==null);
  if(v.failure_code===null)bad(v.recovery_required===current.recovery_required);
  else bad(!v.recovered&&v.artifact===null&&v.status!=='stored'&&(current.state==='failed_before_dispatch'?!v.recovery_required:v.recovery_required));
  if(current.state==='stored'){
   const a=v.artifact;
   bad(v.status==='stored'&&v.failure_code===null&&has(a,ARTIFACT)&&sha256(a.sha256)&&size(a.size_bytes)&&timestamp(a.created_at)
    &&Date.parse(a.created_at)>=Date.parse(current.used_at)&&a.tls_origin_verified===true);
   bad(a.outcome==='validated'&&a.rejection_code===null&&typeof a.cstat==='string'&&/^\d{3,4}$/.test(a.cstat)&&typeof a.event_reconciliation_required==='boolean'
    ||a.outcome==='rejected'&&REJECTION_CODES.includes(a.rejection_code)&&a.cstat===null&&a.event_reconciliation_required===null);
   artifact=pick(a,ARTIFACT);
  }else bad(v.artifact===null);
  receipt=pick(r,RECEIPT);
 }
 return {...FLAGS,status:v.status,command_id:expected,receipt,current,error_code:v.error_code,artifact,recovered:v.recovered,failure_code:v.failure_code,
  retry_transport_allowed:false,recovery_required:v.recovery_required,read_only:reading,recoverable_by_actor:v.recoverable_by_actor};
}

/** Private extras are stripped here and rechecked independently at the public gateway. */
export function publicResult(v,context={}){
 if(context.action!=='history')return result(v,context);
 const {candidateId,payload}=context;
 bad(uuid(candidateId)&&has(v,[...Object.keys(FLAGS),'read_only','candidate_id','items','limit','has_more','next_cursor'])&&sameFlags(v)
  &&v.read_only===true&&v.candidate_id===candidateId&&v.limit===payload?.limit&&Array.isArray(v.items)&&v.items.length<=v.limit&&typeof v.has_more==='boolean');
 const items=v.items.map(item=>result(item,{action:'history_item',commandId:item?.command_id,candidateId}));
 bad(items.every((item,i)=>(i===0||item.receipt.ordinal<items[i-1].receipt.ordinal)&&(payload.before===null||BigInt(item.receipt.ordinal)<BigInt(payload.before))));
 bad(v.has_more?items.length===v.limit&&v.next_cursor===String(items.at(-1).receipt.ordinal):v.next_cursor===null);
 return {...FLAGS,read_only:true,candidate_id:candidateId,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
}
