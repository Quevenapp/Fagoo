/** Web-safe whitelist. WSDL bytes, TLS evidence and custody references never cross this boundary. */
import {need,plain,uuid,sha256,version} from './protocol.mjs';
export const FLAGS=Object.freeze({data_mode:'fiscal_wsdl_evidence',profile:'sp-homologation-wsdl-evidence-v1',purpose:'sefaz-sp-wsdl-readonly-v1',environment:'2',
 binding_verified:false,operation_authorized:false,can_query:false,can_emit:false,can_transmit:false,sefaz_authorized:false});
export const INSPECTION_CODES=Object.freeze(['WSDL_ROOT_UNSUPPORTED','WSDL_EXTERNAL_DEPENDENCY_UNSUPPORTED','WSDL_STRUCTURE_AMBIGUOUS','WSDL_NAME_INVALID','WSDL_URI_INVALID','WSDL_QNAME_INVALID','WSDL_QNAME_NAMESPACE_INVALID','WSDL_DUPLICATE_NAME','WSDL_EXTENSION_UNSUPPORTED','WSDL_STRUCTURE_INVALID','WSDL_REFERENCE_MISSING','WSDL_BINDING_UNSUPPORTED','WSDL_HEADER_OR_EXTENSION_UNSUPPORTED','WSDL_ENDPOINT_MISMATCH','WSDL_UNBOUND_BINDING']);
export const FAILURES=Object.freeze(['WSDL_CERTIFICATE_REJECTED','WSDL_AUTHORIZATION_REJECTED','WSDL_TLS_FAILED','WSDL_TIMEOUT','WSDL_ABORTED','WSDL_RESPONSE_REJECTED','WSDL_STORAGE_FAILED','WSDL_RUNTIME_FAILED']);
import {SERVICE_FAILURE_CODES} from '../../fiscal-sefaz-wsdl/src/service-errors.mjs';
export {SERVICE_FAILURE_CODES};
const RECEIPT=['attempt_id','command_id','profile','model','operation','environment','a1_version','identity_version','confirmed','created_at'];
const CURRENT=['state','a1_version','identity_version','a1_changed','company_changed','certificate_time_valid_now','grant_consumed','lease_expired','expires_at','used_at','finished_at','recovery_required','retry_get_allowed'];
const BASE=[...Object.keys(FLAGS),'status','command_id','recovery_required','read_only','recovered','failure_code','receipt','current','error_code','artifact'];
const ARTIFACT=['sha256','size_bytes','inspection_status','inspection_code','created_at'];
const bad=v=>need(v,502,'WSDL_RESPONSE_INVALID');
function has(v,keys){return plain(v)&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));}
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
export function timestamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v))return false;
 const t=Date.parse(v);if(!Number.isFinite(t))return false;const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return new Date(t+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
/** Both the service and the gateway call this projector; private extras are omitted, never serialized. */
export function publicResult(v,{action,payload,commandId}={}){
 bad(['run','command'].includes(action)&&has(v,BASE)&&Object.entries(FLAGS).every(([k,x])=>v[k]===x));
 const expected=action==='run'?payload?.command_id:commandId;
 bad(uuid(expected)&&v.command_id===expected&&(commandId===undefined||commandId===expected));
 bad(['prepared','dispatched','stored','failed','uncertain','unconfirmed'].includes(v.status)&&typeof v.recovery_required==='boolean'
  &&v.read_only===(action==='command')&&typeof v.recovered==='boolean'&&(v.failure_code===null||SERVICE_FAILURE_CODES.includes(v.failure_code)));
 bad(action!=='command'||v.failure_code===null&&!v.recovered&&v.status!=='unconfirmed');
 const r=v.receipt,c=v.current;let receipt=null,current=null,artifact=null;
 if(r===null){bad(c===null&&v.artifact===null&&v.error_code===null&&v.status==='unconfirmed'&&action==='run'&&v.failure_code!==null&&v.recovery_required&&!v.recovered);}
 else{
  bad(has(r,RECEIPT)&&uuid(r.attempt_id)&&r.command_id===expected&&r.profile===FLAGS.profile&&r.environment==='2'
   &&['55','65'].includes(r.model)&&['protocol','status','authorization','receipt'].includes(r.operation)&&version(r.a1_version)&&version(r.identity_version)&&r.confirmed===true&&timestamp(r.created_at));
  if(action==='run')bad(r.model===payload.model&&r.operation===payload.operation&&r.a1_version===payload.expected_a1_version&&r.identity_version===payload.expected_identity_version&&payload.confirmed===true);
  bad(has(c,CURRENT)&&['prepared','dispatched','stored','failed','uncertain'].includes(c.state)&&version(c.a1_version,0)&&(c.identity_version===null||version(c.identity_version))
   &&['a1_changed','company_changed','certificate_time_valid_now','grant_consumed','lease_expired','recovery_required'].every(k=>typeof c[k]==='boolean')
   &&timestamp(c.expires_at)&&(c.used_at===null||timestamp(c.used_at))&&(c.finished_at===null||timestamp(c.finished_at))&&c.retry_get_allowed===false);
  bad(c.a1_changed===(c.a1_version!==r.a1_version)&&(c.identity_version===r.identity_version||c.company_changed)
   &&c.grant_consumed===(c.used_at!==null)&&c.grant_consumed===['dispatched','stored','uncertain'].includes(c.state)
   &&c.recovery_required===['dispatched','uncertain'].includes(c.state)&&(['prepared','dispatched'].includes(c.state)===(c.finished_at===null))
   &&Date.parse(c.expires_at)>Date.parse(r.created_at));
  if(c.used_at!==null)bad(Date.parse(c.used_at)>=Date.parse(r.created_at)&&Date.parse(c.used_at)<Date.parse(c.expires_at));
  if(c.finished_at!==null)bad(Date.parse(c.finished_at)>=Date.parse(r.created_at)&&(c.used_at===null||Date.parse(c.finished_at)>=Date.parse(c.used_at)));
  const diagnostic=c.state==='prepared'&&c.lease_expired?'WSDL_GRANT_EXPIRED':c.state==='dispatched'&&c.lease_expired?'WSDL_RESULT_UNCONFIRMED':null;
  bad(['failed','uncertain'].includes(c.state)?FAILURES.includes(v.error_code):v.error_code===diagnostic);
  bad(v.status===c.state||v.status==='unconfirmed'&&action==='run'&&v.failure_code!==null);
  bad(v.failure_code===null?v.recovery_required===c.recovery_required:v.recovery_required&&!v.recovered&&v.artifact===null&&v.status!=='stored');
  if(c.state==='stored'){
   const a=v.artifact;bad(v.status==='stored'&&v.failure_code===null&&has(a,ARTIFACT)&&sha256(a.sha256)&&Number.isInteger(a.size_bytes)&&a.size_bytes>=1&&a.size_bytes<=512000
    &&timestamp(a.created_at)&&['supported','unsupported'].includes(a.inspection_status)&&(a.inspection_status==='supported'?a.inspection_code===null:INSPECTION_CODES.includes(a.inspection_code)));
   artifact=pick(a,ARTIFACT);
  }else bad(v.artifact===null);
  receipt=pick(r,RECEIPT);current=pick(c,CURRENT);
 }
 return{...FLAGS,status:v.status,command_id:expected,recovery_required:v.recovery_required,read_only:v.read_only,recovered:v.recovered,failure_code:v.failure_code,
  receipt,current,error_code:v.error_code,artifact};
}
