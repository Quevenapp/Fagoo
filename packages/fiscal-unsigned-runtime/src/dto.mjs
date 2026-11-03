/** Public whitelist; execution inputs, identity, access key, XML, leases and paths never leave these projections. */
import {need,plain,uuid,sha256,version} from './protocol.mjs';
export const FLAGS=Object.freeze({offline_prototype:true,unsigned:true,numbering_reserved:false,can_emit:false,can_transmit:false,
 tax_rules_validated:false,xsd_validated:false,signature_verified:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false});
const BUILDER='brufap-business-builder-v1',TERMINAL=['CONTENT_INVALID','CONTENT_INCOMPLETE','PROFILE_UNSUPPORTED','ARITHMETIC_MISMATCH','XML_SIZE_LIMIT'];
const PENDING=['ACCOUNTING_REVIEW_REQUIRED','TAX_APPLICABILITY_UNVERIFIED','RTC_APPLICABILITY_UNVERIFIED','PAYMENT_FISCAL_REVIEW_REQUIRED',
 'NUMBERING_NOT_RESERVED','SCHEMA_VALIDATION_REQUIRED','SIGNATURE_REQUIRED','NFCE_SUPPLEMENT_REQUIRED','CREDENTIAL_AND_TRANSPORT_NOT_AUTHORIZED'];
const CODES=new Set([
 'UNSIGNED_RESPONSE_INVALID','UNSIGNED_BASIS_CONFLICT','UNSIGNED_ABORTED','UNSIGNED_TIMEOUT','UNSIGNED_LEASE_EXPIRED','UNSIGNED_STORAGE_LIMIT',
 'UNSIGNED_STORAGE_RESPONSE_INVALID','UNSIGNED_STORAGE_SIZE_INVALID','UNSIGNED_STORAGE_HASH_CONFLICT','UNSIGNED_EXECUTION_INVALID',
 'UNSIGNED_XML_INVALID','UNSIGNED_STORAGE_ACK_INVALID','UNSIGNED_STORAGE_MISSING','UNSIGNED_FINISH_INVALID','UNSIGNED_FAILURE_INVALID','UNSIGNED_PORT_FAILED',
 'UNSIGNED_RPC_42501','UNSIGNED_RPC_40001','UNSIGNED_RPC_22023','UNSIGNED_RPC_55000','UNSIGNED_RPC_P0002',
 'BUSINESS_INPUT_INVALID','BUSINESS_TEXT_INVALID','BUSINESS_ADDRESS_INVALID','BUSINESS_RECIPIENT_INVALID','BUSINESS_ITEM_UNPREPARED',
 'BUSINESS_QUANTITY_PRECISION','BUSINESS_DECIMAL_INVALID','BUSINESS_TAX_UNPREPARED','BUSINESS_GROUP_DECISION_REQUIRED','BUSINESS_PROFILE_UNSUPPORTED',
 'BUSINESS_PAYMENT_UNSUPPORTED','BUSINESS_ARITHMETIC_MISMATCH','BUSINESS_XML_SIZE_LIMIT','BUSINESS_BASIS_CONFLICT','BUSINESS_CONTENT_UNATTESTED','BUSINESS_SOURCE_CHANGED',
]);
const bad=condition=>need(condition,502,'UNSIGNED_RESPONSE_INVALID');
const keys=(v,names)=>Object.fromEntries(names.map(k=>[k,v[k]]));
export function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value))return false;
 const time=Date.parse(value);if(!Number.isFinite(time))return false;const match=/([+-])(\d{2}):(\d{2})$/.exec(value);
 const offset=match?(match[1]==='+'?1:-1)*(Number(match[2])*60+Number(match[3])):0;
 return new Date(time+offset*60000).toISOString().slice(0,19)===value.slice(0,19);
}
function flags(value){bad(plain(value)&&Object.entries(FLAGS).every(([key,expected])=>value[key]===expected));}
function sqlFlags(value){bad(plain(value)&&value.data_mode==='fiscal_unsigned_job'&&value.environment==='2'&&value.profile==='sn-sp-internal-business-v1'
 &&value.schema_profile==='pl010f-v1.04'&&value.unsigned===true&&['arithmetic_verified','tax_rules_validated','xsd_validated','signature_verified','authorized','can_emit','can_transmit','financial_mutation_performed','stock_mutation_performed'].every(k=>value[k]===false));}
function compact(value,{commandId,jobId,reservationId,readOnly=false,payload}={}){
 flags(value);bad(['pending','stored','failed'].includes(value.status)&&uuid(value.job_id)&&uuid(value.reservation_id)&&uuid(value.draft_id)
  &&version(value.job_version)&&version(value.completion_version)&&sha256(value.completion_hash)&&sha256(value.basis_hash));
 if(commandId!==undefined)bad(uuid(commandId)&&value.command_id===commandId);
 if(jobId!==undefined)bad(uuid(jobId)&&value.job_id===jobId);
 if(reservationId!==undefined)bad(uuid(reservationId)&&value.reservation_id===reservationId);
 if(payload)bad(value.command_id===payload.command_id&&value.reservation_id===payload.reservation_id&&value.draft_id===payload.draft_id
  &&value.completion_version===payload.completion_version&&value.completion_hash===payload.completion_hash&&value.basis_hash===payload.basis_hash);
 const c=value.current,a=value.artifact;
 bad(plain(c)&&['basis_changed','draft_archived','source_cancelled','is_latest_job','artifact_current','series_enabled'].every(k=>typeof c[k]==='boolean')
  &&version(c.completion_version)&&c.completion_version>=value.completion_version&&Number.isInteger(c.attempt_count)&&c.attempt_count>=1&&c.attempt_count<=100
  &&uuid(c.latest_job_id)&&version(c.latest_job_version)&&c.latest_job_version>=value.job_version
  &&c.is_latest_job===(c.latest_job_id===value.job_id)&&c.is_latest_job===(c.latest_job_version===value.job_version)
  &&(value.status==='pending'?timestamp(c.lease_until):c.lease_until===null));
 bad(c.artifact_current===(value.status==='stored'&&!c.basis_changed&&!c.draft_archived&&!c.source_cancelled&&c.is_latest_job));
 bad(value.xml_generated===(value.status==='stored')&&(value.status==='failed'?TERMINAL.includes(value.error_code):value.error_code===null));
 bad(value.status==='stored'?plain(a)&&sha256(a.sha256)&&Number.isInteger(a.size_bytes)&&a.size_bytes>=1&&a.size_bytes<=480000&&timestamp(a.created_at):a===null);
 if(readOnly)bad(value.read_only===true);
 const result={...FLAGS,status:value.status,...(commandId!==undefined||payload?{command_id:value.command_id}:{}),
  ...keys(value,['job_id','reservation_id','job_version','draft_id','completion_version','completion_hash','basis_hash','xml_generated','error_code']),
  current:keys(c,['basis_changed','draft_archived','source_cancelled','is_latest_job','artifact_current','series_enabled','completion_version','attempt_count','lease_until','latest_job_id','latest_job_version']),
  artifact:a?keys(a,['sha256','size_bytes','created_at']):null,...(readOnly?{read_only:true}:{})};
 if(!readOnly){
  if(Object.hasOwn(value,'recovered')){bad(typeof value.recovered==='boolean');result.recovered=value.recovered;}
  if(Object.hasOwn(value,'storage_operations')){bad(Number.isInteger(value.storage_operations)&&value.storage_operations>=0&&value.storage_operations<=4);result.storage_operations=value.storage_operations;}
  if(Object.hasOwn(value,'code')){bad(value.status==='failed'&&CODES.has(value.code));result.code=value.code;}
 }return result;
}
export function projectSqlView(value,{jobId,commandId}={}){
 sqlFlags(value);const r=value.receipt,c=value.current,a=value.artifact;
 bad(plain(r)&&plain(c)&&r.builder_version===BUILDER&&typeof r.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(r.access_key));
 if(commandId!==undefined)bad(value.command_id===commandId);
 bad(a===null||plain(a)&&a.access_key===r.access_key);
 return compact({...FLAGS,status:c.state,...(commandId!==undefined?{command_id:value.command_id}:{}),job_id:r.job_id,reservation_id:r.reservation_id,
  job_version:r.version,draft_id:r.draft_id,completion_version:r.completion_version,completion_hash:r.completion_hash,basis_hash:r.basis_hash,
  xml_generated:value.xml_generated,error_code:value.error_code,current:c,artifact:a?{sha256:a.xml_hash,size_bytes:a.size_bytes,created_at:a.created_at}:null,read_only:true},{jobId,commandId,readOnly:true});
}
function history(value,{reservationId,limit,before}){
 flags(value);bad(value.read_only===true&&uuid(reservationId)&&value.reservation_id===reservationId&&Number.isInteger(limit)&&limit>=1&&limit<=25
  &&value.limit===limit&&(before===null||version(before))&&Array.isArray(value.items)&&value.items.length<=limit&&typeof value.has_more==='boolean');
 let previous=before??2147483648;const seen=new Set();
 const items=value.items.map(item=>{const out=compact(item,{reservationId,readOnly:true});bad(out.job_version<previous&&!seen.has(out.job_id));previous=out.job_version;seen.add(out.job_id);return out;});
 bad(value.has_more?items.length===limit&&items.length>0&&value.next_cursor===items.at(-1).job_version:value.next_cursor===null);
 return {...FLAGS,read_only:true,reservation_id:reservationId,items,limit,has_more:value.has_more,next_cursor:value.next_cursor};
}
export function projectSqlHistory(value,{reservationId,limit,before}){
 sqlFlags(value);bad(Array.isArray(value.items)&&value.items.length<=25&&value.read_only===true);
 return history({...FLAGS,read_only:true,reservation_id:value.reservation_id,items:value.items.map(item=>projectSqlView(item)),limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor},{reservationId,limit,before});
}
export function publicResult(value,{action,payload,jobId,commandId}={}){
 if(action==='job')return compact(value,{jobId,readOnly:true});
 if(action==='command')return compact(value,{commandId,readOnly:true});
 if(action==='history')return history(value,{reservationId:payload?.reservation_id,limit:payload?.limit,before:payload?.before});
 flags(value);
 if(action==='preview'){
  bad(uuid(payload?.draft_id)&&version(payload?.completion_version)&&value.draft_id===payload.draft_id&&value.xml_generated===false);
  if(value.status==='blocked'){bad(CODES.has(value.code));return{...FLAGS,status:'blocked',draft_id:value.draft_id,code:value.code,xml_generated:false};}
  bad(value.status==='checked'&&value.completion_version===payload.completion_version&&sha256(value.basis_hash)&&sha256(value.completion_hash)
   &&value.builder_version===BUILDER&&['55','65'].includes(value.model)&&value.environment==='2'&&Number.isInteger(value.items)&&value.items>=1&&value.items<=250
   &&value.arithmetic_verified===true&&value.identity_assigned===false&&value.numbering_bound===false&&Array.isArray(value.pending)
   &&value.pending.length<=PENDING.length&&new Set(value.pending).size===value.pending.length&&value.pending.every(code=>PENDING.includes(code)));
  return{...FLAGS,...keys(value,['status','draft_id','completion_version','basis_hash','completion_hash','builder_version','model','environment','items']),
   arithmetic_verified:true,identity_assigned:false,numbering_bound:false,xml_generated:false,pending:[...value.pending]};
 }
 bad(action==='generate'&&uuid(payload?.command_id));
 if(['pending','stored','failed'].includes(value.status))return compact(value,{payload});
 bad(['blocked','recoverable'].includes(value.status)&&value.command_id===payload.command_id&&CODES.has(value.code)
  &&['recover','preflight','begin','build','storage','finish','readback'].includes(value.phase)
  &&Number.isInteger(value.storage_operations)&&value.storage_operations>=0&&value.storage_operations<=4
  &&(value.status==='blocked'?value.outcome==='not_started'&&value.xml_generated===false:value.outcome==='unconfirmed'&&value.xml_generated===null));
 return{...FLAGS,...keys(value,['status','command_id','code','phase','xml_generated','outcome','storage_operations'])};
}
