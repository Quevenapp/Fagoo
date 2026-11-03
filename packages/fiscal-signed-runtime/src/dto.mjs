/** Web-safe public whitelist. No XML, fiscal key, credential reference, fingerprint or lease. */
import {need,plain,uuid,sha256,version} from './protocol.mjs';
export const FLAGS=Object.freeze({offline_prototype:true,environment:'2',candidate_profile:'signed-homologation-sp-v1',tax_rules_validated:false,
 icp_brasil_chain_validated:false,revocation_checked:false,authorized:false,can_emit:false,can_transmit:false,financial_mutation_performed:false,stock_mutation_performed:false});
const TERMINAL=new Set(['XML_INPUT_INVALID','SIGNATURE_INVALID','XSD_INVALID','QR_INVALID','XML_SIZE_LIMIT','CERTIFICATE_INVALID']);
const CODES=new Set(["SIGNED_ABORTED", "SIGNED_ALREADY_RUNNING", "SIGNED_BYTES_CHANGED", "SIGNED_CERTIFICATE_TIME_INVALID", "SIGNED_COMMAND_BINDING_INVALID", "SIGNED_CUSTODY_BINDING_INVALID", "SIGNED_CUSTODY_CALLBACK_INVALID", "SIGNED_CUSTODY_NOT_COMPLETED", "SIGNED_DEADLINE_INVALID", "SIGNED_EXECUTION_INVALID", "SIGNED_FAILURE_INVALID", "SIGNED_FINISH_INVALID", "SIGNED_IDENTITY_INVALID", "SIGNED_INPUT_INVALID", "SIGNED_LEASE_EXPIRED", "SIGNED_OPTIONS_INVALID", "SIGNED_PORTS_REQUIRED", "SIGNED_PORT_FAILED", "SIGNED_RECEIPT_BINDING_INVALID", "SIGNED_RESPONSE_INVALID", "SIGNED_RPC_22023", "SIGNED_RPC_40001", "SIGNED_RPC_42501", "SIGNED_RPC_55000", "SIGNED_RPC_P0002", "SIGNED_SIGNATURE_RESPONSE_INVALID", "SIGNED_STORAGE_ACK_INVALID", "SIGNED_STORAGE_HASH_CONFLICT", "SIGNED_STORAGE_LIMIT", "SIGNED_STORAGE_MISSING", "SIGNED_STORAGE_RESPONSE_INVALID", "SIGNED_STORAGE_SIZE_INVALID", "SIGNED_TIMEOUT", "SIGNED_UNSIGNED_ENCODING_INVALID", "SIGNED_UNSIGNED_IDENTITY_CONFLICT", "SIGNED_UNSIGNED_MISSING", "SIGNED_UNSIGNED_OBJECT_INVALID", "SIGNED_USE_BINDING_INVALID", "SIGNED_XSD_REJECTED", "SIGNED_XSD_RESPONSE_INVALID"]);
const bad=v=>need(v,502,'SIGNED_RESPONSE_INVALID');
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
export function timestamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v))return false;
 const t=Date.parse(v);if(!Number.isFinite(t))return false;const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return new Date(t+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
const flags=v=>bad(plain(v)&&Object.entries(FLAGS).every(([k,value])=>v[k]===value));
const CURRENT=['state','attempt_count','unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_version','a1_changed','certificate_time_valid_now','latest_candidate_id','latest_candidate_version','is_latest_candidate','artifact_current'];
export function compact(value,{commandId,candidateId,jobId,payload,readOnly=false}={}){
 flags(value);bad(['pending','stored','failed'].includes(value.status)&&uuid(value.candidate_id)&&uuid(value.unsigned_job_id)
  &&version(value.candidate_version)&&version(value.completion_version)&&version(value.a1_version)&&['55','65'].includes(value.model)
  &&['unsigned_hash','basis_hash','completion_hash'].every(k=>sha256(value[k])));
 if(commandId!==undefined)bad(uuid(commandId)&&value.command_id===commandId);
 if(candidateId!==undefined)bad(uuid(candidateId)&&value.candidate_id===candidateId);
 if(jobId!==undefined)bad(uuid(jobId)&&value.unsigned_job_id===jobId);
 if(payload)bad(value.command_id===payload.command_id&&value.unsigned_job_id===payload.unsigned_job_id&&value.unsigned_hash===payload.unsigned_hash
  &&value.basis_hash===payload.basis_hash&&value.a1_version===payload.expected_a1_version);
 const c=value.current,a=value.artifact,stored=value.status==='stored';
 bad(plain(c)&&c.state===value.status&&Number.isInteger(c.attempt_count)&&c.attempt_count>=1&&c.attempt_count<=100&&version(c.a1_version,0)
  &&uuid(c.latest_candidate_id)&&version(c.latest_candidate_version)&&c.latest_candidate_version>=value.candidate_version
  &&['unsigned_artifact_current','basis_changed','draft_archived','source_cancelled','series_enabled','a1_changed','certificate_time_valid_now','is_latest_candidate','artifact_current'].every(k=>typeof c[k]==='boolean'));
 bad(c.is_latest_candidate===(c.latest_candidate_id===value.candidate_id)&&c.is_latest_candidate===(c.latest_candidate_version===value.candidate_version)
  &&c.a1_changed===(c.a1_version!==value.a1_version));
 bad(c.artifact_current===(stored&&c.is_latest_candidate&&!c.a1_changed&&c.certificate_time_valid_now&&c.unsigned_artifact_current&&c.series_enabled));
 bad(!c.artifact_current||!c.basis_changed&&!c.draft_archived&&!c.source_cancelled);
 bad(['signed','signature_verified','xsd_validated'].every(k=>value[k]===stored)&&(value.status==='failed'?TERMINAL.has(value.error_code):value.error_code===null));
 bad(stored?plain(a)&&sha256(a.sha256)&&Number.isInteger(a.size_bytes)&&a.size_bytes>=1&&a.size_bytes<=512000&&timestamp(a.created_at):a===null);
 if(readOnly)bad(value.read_only===true);
 const result={...FLAGS,status:value.status,...(commandId!==undefined||payload?{command_id:value.command_id}:{}),
  ...pick(value,['candidate_id','candidate_version','unsigned_job_id','unsigned_hash','basis_hash','model','completion_version','completion_hash','a1_version','error_code']),
  signed:stored,signature_verified:stored,xsd_validated:stored,current:pick(c,CURRENT),artifact:a?pick(a,['sha256','size_bytes','created_at']):null,...(readOnly?{read_only:true}:{})};
 if(!readOnly){
  if(Object.hasOwn(value,'recovered')){bad(typeof value.recovered==='boolean');result.recovered=value.recovered;}
  if(Object.hasOwn(value,'storage_operations')){bad(Number.isInteger(value.storage_operations)&&value.storage_operations>=0&&value.storage_operations<=5);result.storage_operations=value.storage_operations;}
  if(Object.hasOwn(value,'code')){bad(value.status==='failed'&&CODES.has(value.code));result.code=value.code;}
 }return result;
}
export function publicResult(value,{action,payload,commandId,candidateId,jobId}={}){
 if(action==='candidate')return compact(value,{candidateId,readOnly:true});
 if(action==='command')return compact(value,{commandId,readOnly:true});
 flags(value);
 if(action==='history'){
  bad(value.read_only===true&&uuid(jobId)&&value.unsigned_job_id===jobId&&value.limit===payload?.limit&&Number.isInteger(value.limit)&&value.limit>=1&&value.limit<=25
   &&Array.isArray(value.items)&&value.items.length<=value.limit&&typeof value.has_more==='boolean');
  let prior=payload.before??2147483648;const seen=new Set();const items=value.items.map(v=>{const row=compact(v,{jobId,readOnly:true});bad(row.candidate_version<prior&&!seen.has(row.candidate_id));prior=row.candidate_version;seen.add(row.candidate_id);return row;});
  bad(value.has_more?items.length===value.limit&&items.length>0&&value.next_cursor===items.at(-1).candidate_version:value.next_cursor===null);
  return{...FLAGS,read_only:true,unsigned_job_id:jobId,items,limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor};
 }
 bad(action==='run'&&uuid(payload?.command_id));
 if(['pending','stored','failed'].includes(value.status))return compact(value,{payload});
 bad(['blocked','recoverable'].includes(value.status)&&value.command_id===payload.command_id&&CODES.has(value.code)
  &&['recover','begin','use','read_unsigned','inspect','custody','xsd','storage','finish','readback'].includes(value.phase)
  &&Number.isInteger(value.storage_operations)&&value.storage_operations>=0&&value.storage_operations<=5
  &&value.signature_verified===false&&value.xsd_validated===false
  &&(value.status==='blocked'?value.outcome==='not_started'&&value.signed===false:value.outcome==='unconfirmed'&&value.signed===null));
 return{...FLAGS,...pick(value,['status','command_id','code','phase','signed','outcome','storage_operations']),signature_verified:false,xsd_validated:false};
}
