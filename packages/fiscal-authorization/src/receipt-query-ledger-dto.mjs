/** Private089 RPC boundary. Opaque SQL hashes are compared, never reconstructed. No I/O or grant creation. */
import {AuthorizationServiceError,data,need,id,sha,integer,freeze} from './service-common.mjs';
import {same,stamp} from './service-dto.mjs';
import {isValidCnpj} from '../../fiscal-core/src/identity.mjs';
import {projectReceiptQuerySource,receiptQuerySourceEvidence} from './receipt-query-evidence.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST as MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH as MANIFEST_HASH} from './receipt-query-manifest.mjs';
export const RECEIPT_QUERY_RPC_PREFIX='erp_fiscal_receipt_query_';
export const RECEIPT_QUERY_RPC_LIMITS=Object.freeze({request:32768,response:524288});
export const RECEIPT_QUERY_LEDGER_FLAGS=Object.freeze({data_mode:'fiscal_receipt_query',environment:'2',can_query:false,can_emit:false,can_transmit:false,tax_rules_validated:false,production_authorized:false,retry_submission_allowed:false,financial_mutation_performed:false,stock_mutation_performed:false});
const actions=['context','begin','prepare','use','finish','fail','command','history'];
const errors=['RECEIPT_QUERY_PREPARATION_FAILED','RECEIPT_QUERY_CUSTODY_FAILED','RECEIPT_QUERY_TRANSPORT_FAILED','RECEIPT_QUERY_TRANSPORT_TIMEOUT','RECEIPT_QUERY_STORAGE_FAILED','RECEIPT_QUERY_RESULT_UNCONFIRMED','RECEIPT_QUERY_CANCELLED'];
const blockers=['SOURCE_VALIDATION_REQUIRED','POLICY_DISABLED','POLICY_TIME_INVALID','POLICY_PROFILE_INVALID','IDENTITY_MISMATCH','A1_UNAVAILABLE','A1_INVALID','A1_STORAGE_INVALID','RESOLUTION_CLOSED','QUERY_ACTIVE','CADENCE_REQUIRED','RATE_LIMIT'];
const states=['prepared','request_ready','dispatched','uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorized_homologation'];
const selectionKeys=['source_kind','source_command_id','expected_authorization_command_id','expected_attempt_id','expected_candidate_id','expected_candidate_version','expected_signed_hash','expected_source_binding_hash','expected_chain_hash','expected_identity_version','expected_a1_version','expected_query_policy_version'];
const identityKeys=['authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin'];
const receiptKeys=['query_id','actor',...identityKeys,'ordinal','identity_version','a1_version','query_policy_version','created_at','expires_at'];
const recoveryKeys=['private_executor_only','purpose','query_id','actor',...identityKeys,'signed_size','lease_id','nonce','created_at','expires_at','policy','identity_version','a1_version','credential_id','envelope_hash','certificate_fingerprint','receipt_number','access_key','reference_digest','issuer_cnpj','request_hash','request_size'];
const validationKeys=['profile','manifest_hash','source_binding_hash','payload_hash','receipt_number','tmed_seconds','received_at','observed_at','signature_verified','xsd_validated','context_matched','tls_origin_verified','tax_rules_validated','can_query','can_emit','can_transmit'];
const preparationKeys=['profile','manifest_hash','query_id','nonce','source_binding_hash','request_hash','payload_hash','signed_hash','model','environment','receipt_number','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit'];
const resultKeys=['profile','manifest_hash','query_id','nonce','source_binding_hash','request_hash','response_hash','payload_hash','signed_hash','model','environment','receipt_number','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','reference_digest','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','observation_hash','observation_size','tax_rules_validated','can_emit','can_transmit'];
const exact=(v,k)=>data(v,k,[],'RECEIPT_QUERY_LEDGER_RESPONSE_INVALID');
const version=v=>integer(v,999999999);
const bool=v=>typeof v==='boolean';
const model=v=>['55','65'].includes(v);
const kind=v=>['authorization','revalidation'].includes(v);
const label=v=>typeof v==='string'&&/^[a-zA-Z0-9._-]{1,120}$/.test(v);
const iso=v=>stamp(v)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);
const status=v=>typeof v==='string'&&/^\d{3,4}$/.test(v);
const nrec=v=>typeof v==='string'&&/^\d{15}$/.test(v)&&!/^0+$/.test(v);
const protocolNumber=v=>typeof v==='string'&&/^(?:\d{15}|\d{17})$/.test(v)&&!/^0+$/.test(v);
const digest=v=>typeof v==='string'&&/^[A-Za-z0-9+/]{27}=$/.test(v)&&Buffer.from(v,'base64').toString('base64')===v;
const flags=x=>need(Object.entries(RECEIPT_QUERY_LEDGER_FLAGS).every(([k,v])=>x[k]===v));
const flagsKeys=Object.keys(RECEIPT_QUERY_LEDGER_FLAGS);
const profile=x=>need(x.profile===MANIFEST.profile&&x.manifest_hash===MANIFEST_HASH);
const bound=(x,expected)=>{for(const[k,v]of Object.entries(expected))need(Object.hasOwn(x,k)&&same(x[k],v));};
const array=(x,max=25)=>{need(Array.isArray(x)&&x.length<=max);return x;};
/** Copy only own data descriptors; bounded before stringify, no getters/toJSON/prototype hooks. */
function snapshot(raw,max){
 let nodes=0,units=0;const seen=new WeakSet();
 const copy=(v,depth)=>{
  need(++nodes<=100000&&depth<=32);if(v===null||typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isFinite(v));return v;}if(typeof v==='string'){need((units+=v.length)<=max);return v;}
  need(v!==null&&typeof v==='object'&&!seen.has(v));seen.add(v);const a=Array.isArray(v);need(a?Object.getPrototypeOf(v)===Array.prototype:[Object.prototype,null].includes(Object.getPrototypeOf(v)));
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);let out;
  if(a){need(Object.hasOwn(d.length??{},'value')&&integer(d.length.value,100000,0)&&keys.length===d.length.value+1);out=[];for(let i=0;i<d.length.value;i++){const p=d[String(i)];need(p&&p.enumerable&&Object.hasOwn(p,'value'));out.push(copy(p.value,depth+1));}}
  else{out={};for(const k of keys){need(typeof k==='string'&&k!=='__proto__'&&d[k].enumerable&&Object.hasOwn(d[k],'value'));need((units+=k.length)<=max);Object.defineProperty(out,k,{value:copy(d[k].value,depth+1),enumerable:true,writable:true,configurable:true});}}
  seen.delete(v);return out;
 };
 const v=copy(raw,0);need(Buffer.byteLength(JSON.stringify(v))<=max);return v;
}
function policy(raw,strict=false){
 if(raw===null){need(!strict);return null;}
 const p=exact(raw,['model','version','enabled','profile','manifest_hash','origin','binding_profile','lease_seconds','cadence_seconds','max_queries_per_hour','valid_from','valid_until','created_at']);
 need(model(p.model)&&version(p.version)&&bool(p.enabled)&&label(p.profile)&&(p.manifest_hash===null||sha(p.manifest_hash))&&p.origin==='operational'&&label(p.binding_profile)&&p.lease_seconds===60&&p.cadence_seconds===60&&p.max_queries_per_hour===10&&['valid_from','valid_until','created_at'].every(k=>stamp(p[k]))&&Date.parse(p.valid_from)<Date.parse(p.valid_until));
 if(strict){profile(p);need(p.enabled&&p.binding_profile===`sp${p.model}-receipt-soap12-reviewed-20261016-v1`);}return p;
}
function selection(raw,nullableHeads=false){
 const x=exact(raw,selectionKeys);need(kind(x.source_kind)&&['source_command_id','expected_authorization_command_id','expected_attempt_id','expected_candidate_id'].every(k=>id(x[k]))&&version(x.expected_candidate_version)&&['expected_signed_hash','expected_source_binding_hash','expected_chain_hash'].every(k=>sha(x[k])));
 need(['expected_identity_version','expected_a1_version','expected_query_policy_version'].every(k=>version(x[k])||nullableHeads&&x[k]===null));need(x.source_kind==='authorization'?x.source_command_id===x.expected_authorization_command_id:x.source_command_id!==x.expected_authorization_command_id);return x;
}
function selectionSource(x,s){bound(x,{source_kind:s.source_kind,source_command_id:s.source_command_id,expected_authorization_command_id:s.authorization_command_id,expected_attempt_id:s.authorization_attempt_id,expected_candidate_id:s.candidate_id,expected_candidate_version:s.candidate_version,expected_signed_hash:s.signed_hash,expected_source_binding_hash:s.source_binding_hash});}
function source(raw,actor){const s=exact(raw,['source_kind','source_command_id','authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin','source_binding_hash','original_source','selected_revalidation']);return projectReceiptQuerySource(s,{actor,sourceKind:s.source_kind,sourceCommandId:s.source_command_id,authorizationCommandId:s.authorization_command_id,authorizationAttemptId:s.authorization_attempt_id});}
function validation(raw,s){
 const v=exact(raw,validationKeys);profile(v);need(sha(v.source_binding_hash)&&sha(v.payload_hash)&&nrec(v.receipt_number)&&integer(v.tmed_seconds,9999,0)&&iso(v.received_at)&&iso(v.observed_at)&&['signature_verified','xsd_validated','context_matched','tls_origin_verified'].every(k=>v[k]===true)&&['tax_rules_validated','can_query','can_emit','can_transmit'].every(k=>v[k]===false));
 if(s){const e=receiptQuerySourceEvidence(s);bound(v,{source_binding_hash:s.source_binding_hash,payload_hash:e.payload_hash,receipt_number:e.receipt_number,received_at:new Date(e.received_at).toISOString()});}return v;
}
function recovery(raw,expected={},issued=false){
 const x=exact(raw,[...recoveryKeys,...(issued?['issued_at']:[])]);need(x.private_executor_only===true&&x.purpose==='sp-receipt-query-homologation-v1'&&kind(x.source_kind)&&model(x.model)&&x.environment==='2'&&x.origin==='operational');
 need(['query_id','actor','authorization_command_id','authorization_attempt_id','source_command_id','candidate_id','lease_id','nonce','credential_id'].every(k=>id(x[k]))&&['source_binding_hash','signed_hash','envelope_hash','certificate_fingerprint'].every(k=>sha(x[k]))&&['candidate_version','identity_version','a1_version'].every(k=>version(x[k]))&&integer(x.signed_size,512000));
 need(x.query_id!==x.source_command_id&&x.query_id!==x.authorization_command_id&&(x.source_kind==='authorization'?x.source_command_id===x.authorization_command_id:x.source_command_id!==x.authorization_command_id));
 need(stamp(x.created_at)&&stamp(x.expires_at)&&Date.parse(x.expires_at)-Date.parse(x.created_at)===60000&&nrec(x.receipt_number)&&digest(x.reference_digest)&&isValidCnpj(x.issuer_cnpj));
 need(typeof x.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(x.access_key)&&x.access_key.slice(0,2)==='35'&&x.access_key.slice(6,20)===x.issuer_cnpj&&x.access_key.slice(20,22)===x.model);
 need(x.request_hash===null&&x.request_size===null||sha(x.request_hash)&&integer(x.request_size,512000));x.policy=policy(x.policy,true);need(x.policy.model===x.model&&Date.parse(x.created_at)>=Date.parse(x.policy.valid_from)&&Date.parse(x.created_at)<Date.parse(x.policy.valid_until));
 if(issued)need(stamp(x.issued_at)&&Date.parse(x.issued_at)>=Date.parse(x.created_at)&&Date.parse(x.issued_at)<Date.parse(x.expires_at)&&Date.parse(x.issued_at)<Date.parse(x.policy.valid_until)&&sha(x.request_hash));
 bound(x,expected);return x;
}
const requestBinding=c=>Object.fromEntries(['query_id','nonce','source_binding_hash','request_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]]));
function preparation(raw,expected={}){const x=exact(raw,preparationKeys);profile(x);need(['query_id','nonce'].every(k=>id(x[k]))&&['source_binding_hash','request_hash','payload_hash','signed_hash'].every(k=>sha(x[k]))&&model(x.model)&&x.environment==='2'&&nrec(x.receipt_number)&&['signature_verified','xsd_validated','context_matched'].every(k=>x[k]===true)&&['tax_rules_validated','can_emit','can_transmit'].every(k=>x[k]===false));bound(x,expected);return x;}
function resultEvidence(raw,expected={}){
 const x=exact(raw,resultKeys);profile(x);need(['query_id','nonce'].every(k=>id(x[k]))&&['source_binding_hash','request_hash','response_hash','signed_hash','observation_hash'].every(k=>sha(x[k]))&&integer(x.observation_size,8192)&&model(x.model)&&x.environment==='2'&&nrec(x.receipt_number)&&x.tls_origin_verified===true&&['tax_rules_validated','can_emit','can_transmit'].every(k=>x[k]===false));
 if(x.outcome==='invalid_response')need(['SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID'].includes(x.rejection_code)&&['cstat','protocol_cstat','protocol_number','received_at','reference_digest'].every(k=>x[k]===null)&&['signature_verified','xsd_validated','context_matched','processed_xsd_validated'].every(k=>x[k]===false)&&(x.payload_hash===null||sha(x.payload_hash)));
 else{
  need(sha(x.payload_hash)&&x.rejection_code===null&&status(x.cstat)&&iso(x.received_at)&&x.xsd_validated===true&&x.context_matched===true&&(x.protocol_cstat===null||status(x.protocol_cstat)&&x.cstat==='104'));
  if(x.outcome==='authorization_declared')need(x.cstat==='104'&&['100','150'].includes(x.protocol_cstat)&&protocolNumber(x.protocol_number)&&digest(x.reference_digest)&&x.signature_verified===true&&x.processed_xsd_validated===true);
  else{need(x.signature_verified===false&&x.processed_xsd_validated===false&&x.protocol_number===null&&x.reference_digest===null);
   if(x.outcome==='receipt_pending')need(x.cstat==='105'&&x.protocol_cstat===null);
   else if(x.outcome==='rejected')need(x.cstat==='104'&&status(x.protocol_cstat)&&Number(x.protocol_cstat)>=200&&!['204','217','539'].includes(x.protocol_cstat));
   else need(x.outcome==='review_required'&&!['100','150','105'].includes(x.cstat)&&!['100','150'].includes(x.protocol_cstat));
  }
 }bound(x,expected);return x;
}
function resolution(raw,s){
 const x=exact(raw,['state','query_ids','selected_query_id','protocol','resolution_hash']);need(['pending','authorized_homologation','rejected','review_required','conflict'].includes(x.state)&&sha(x.resolution_hash));array(x.query_ids,10000);need(x.query_ids.every(id)&&new Set(x.query_ids).size===x.query_ids.length);
 if(['pending','review_required'].includes(x.state))need(x.query_ids.length===0&&x.selected_query_id===null&&x.protocol===null);
 else{
  const p=exact(x.protocol,['state','access_key','receipt_number','reference_digest','cstat','protocol_cstat','protocol_number','received_at']);need(['authorized_homologation','rejected'].includes(p.state)&&typeof p.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(p.access_key)&&nrec(p.receipt_number)&&p.cstat==='104'&&status(p.protocol_cstat)&&stamp(p.received_at));
  if(p.state==='authorized_homologation')need(['100','150'].includes(p.protocol_cstat)&&protocolNumber(p.protocol_number)&&digest(p.reference_digest));else need(Number(p.protocol_cstat)>=200&&!['204','217','539'].includes(p.protocol_cstat)&&p.protocol_number===null&&p.reference_digest===null);
  if(s){need(p.access_key===s.original_source.recovery.access_key&&p.receipt_number===receiptQuerySourceEvidence(s).receipt_number);if(p.reference_digest!==null)need(p.reference_digest===s.original_source.recovery.reference_digest);}
  if(x.state==='conflict')need(x.query_ids.length>=2&&x.selected_query_id===null);else need(x.query_ids.length>=1&&id(x.selected_query_id)&&x.query_ids.includes(x.selected_query_id)&&p.state===x.state);
 }return x;
}
function view(raw,actor,extras=[]){
 const x=exact(raw,[...flagsKeys,'query_id','receipt','source','source_validation','current','request','artifact','recovery','resolution','error_code',...extras]);flags(x);const s=source(x.source,actor),r=exact(x.receipt,receiptKeys);need(id(x.query_id)&&x.query_id===r.query_id&&r.actor===actor&&integer(r.ordinal)&&['identity_version','a1_version','query_policy_version'].every(k=>version(r[k])));bound(r,Object.fromEntries(identityKeys.map(k=>[k,s[k]])));
 const c=recovery(x.recovery,{query_id:x.query_id,actor,...Object.fromEntries(identityKeys.map(k=>[k,r[k]])),created_at:r.created_at,expires_at:r.expires_at,identity_version:r.identity_version,a1_version:r.a1_version,signed_size:s.signed_size});need(c.policy.version===r.query_policy_version);bound(c,Object.fromEntries(['access_key','reference_digest','issuer_cnpj'].map(k=>[k,s.original_source.recovery[k]])));
 const v=validation(x.source_validation,s);need(c.receipt_number===v.receipt_number);
 const current=exact(x.current,['state','grant_consumed','used_at','expires_at','lease_expired','finished_at','recovery_required']);need(states.includes(current.state)&&['grant_consumed','lease_expired','recovery_required'].every(k=>bool(current[k]))&&current.expires_at===r.expires_at&&current.grant_consumed===(current.used_at!==null)&&current.grant_consumed===!['prepared','request_ready','failed_before_dispatch'].includes(current.state)&&current.recovery_required===['dispatched','uncertain'].includes(current.state)&&(['prepared','request_ready','dispatched'].includes(current.state)===(current.finished_at===null)));
 if(current.used_at!==null)need(stamp(current.used_at)&&Date.parse(current.used_at)>=Date.parse(r.created_at)&&Date.parse(current.used_at)<Date.parse(r.expires_at));if(current.finished_at!==null)need(stamp(current.finished_at)&&Date.parse(current.finished_at)>=Date.parse(current.used_at??r.created_at));
 need(['failed_before_dispatch','uncertain'].includes(current.state)?errors.includes(x.error_code):x.error_code===null);
 if(x.request!==null){const q=exact(x.request,['query_id','sha256','size_bytes','evidence','created_at']);need(q.query_id===x.query_id&&q.sha256===c.request_hash&&q.size_bytes===c.request_size&&stamp(q.created_at)&&Date.parse(q.created_at)>=Date.parse(r.created_at)&&Date.parse(q.created_at)<Date.parse(r.expires_at));preparation(q.evidence,requestBinding(c));}else need(c.request_hash===null&&c.request_size===null&&['prepared','failed_before_dispatch'].includes(current.state));
 need(current.state!=='prepared'||x.request===null);
 if(x.artifact!==null){const a=exact(x.artifact,['query_id','response_hash','response_size','observation_hash','observation_size','evidence','processed_hash','processed_size','created_at']);need(a.query_id===x.query_id&&sha(a.response_hash)&&integer(a.response_size,512000)&&sha(a.observation_hash)&&integer(a.observation_size,8192)&&stamp(a.created_at)&&current.used_at!==null&&Date.parse(a.created_at)>=Date.parse(current.used_at)&&Date.parse(a.created_at)<=Date.parse(current.finished_at));
  const e=resultEvidence(a.evidence,{...requestBinding(c),response_hash:a.response_hash,observation_hash:a.observation_hash,observation_size:a.observation_size}),authorized=e.outcome==='authorization_declared';need(current.state===(authorized?'authorized_homologation':e.outcome==='invalid_response'?'review_required':e.outcome));need(authorized?sha(a.processed_hash)&&integer(a.processed_size,512000)&&e.reference_digest===c.reference_digest:a.processed_hash===null&&a.processed_size===null);
 }else need(['prepared','request_ready','dispatched','uncertain','failed_before_dispatch'].includes(current.state));
 const resolved=resolution(x.resolution,s);if(['authorized_homologation','rejected'].includes(current.state))need(resolved.query_ids.includes(x.query_id)&&['authorized_homologation','rejected','conflict'].includes(resolved.state));if(resolved.selected_query_id===x.query_id){need(x.artifact!==null&&resolved.state===current.state);const e=x.artifact.evidence,p=resolved.protocol;need(['cstat','protocol_cstat','protocol_number','reference_digest'].every(k=>e[k]===p[k])&&Date.parse(e.received_at)===Date.parse(p.received_at));}
 return{...x,source:s,receipt:r,recovery:c,source_validation:v};
}
function capture(action,raw){
 need(actions.includes(action));let x;
 if(action==='context'){x=exact(raw,['p_user_id','p_source_kind','p_source_command_id','p_expected_attempt_id']);need(kind(x.p_source_kind)&&id(x.p_source_command_id)&&id(x.p_expected_attempt_id));}
 else if(action==='history'){x=exact(raw,['p_user_id','p_authorization_command_id','p_expected_attempt_id','p_limit','p_before']);need(id(x.p_authorization_command_id)&&id(x.p_expected_attempt_id)&&integer(x.p_limit,25)&&(x.p_before===null||integer(x.p_before)));}
 else if(action==='command'){x=exact(raw,['p_user_id','p_command_id']);need(id(x.p_command_id));}
 else if(action==='begin'){x=exact(raw,['p_user_id','p_command_id','p_selection','p_source_validation','p_confirmed']);need(id(x.p_command_id)&&x.p_confirmed===true);x.p_selection=selection(x.p_selection);x.p_source_validation=validation(x.p_source_validation);need(x.p_selection.expected_source_binding_hash===x.p_source_validation.source_binding_hash&&x.p_command_id!==x.p_selection.source_command_id&&x.p_command_id!==x.p_selection.expected_authorization_command_id);}
 else{
  const extra=action==='use'?[]:action==='prepare'?['p_request_hash','p_request_size','p_evidence']:action==='fail'?['p_error_code']:['p_response_hash','p_response_size','p_observation_hash','p_observation_size','p_evidence','p_processed_hash','p_processed_size'];
  x=exact(raw,['p_user_id','p_query_id','p_lease_id',...extra]);need(id(x.p_query_id)&&id(x.p_lease_id));
  if(action==='prepare'){need(sha(x.p_request_hash)&&integer(x.p_request_size,512000));x.p_evidence=preparation(x.p_evidence,{query_id:x.p_query_id,request_hash:x.p_request_hash});}
  if(action==='fail')need(errors.includes(x.p_error_code));
  if(action==='finish'){need(sha(x.p_response_hash)&&integer(x.p_response_size,512000)&&sha(x.p_observation_hash)&&integer(x.p_observation_size,8192));x.p_evidence=resultEvidence(x.p_evidence,{query_id:x.p_query_id,response_hash:x.p_response_hash,observation_hash:x.p_observation_hash,observation_size:x.p_observation_size});need(x.p_evidence.outcome==='authorization_declared'?sha(x.p_processed_hash)&&integer(x.p_processed_size,512000):x.p_processed_hash===null&&x.p_processed_size===null);}
 }need(id(x.p_user_id));return x;
}
export function captureReceiptQueryRpc(action,raw){try{return freeze(capture(action,snapshot(raw,RECEIPT_QUERY_RPC_LIMITS.request)));}catch{throw new AuthorizationServiceError('RECEIPT_QUERY_LEDGER_INPUT_INVALID');}}
function items(raw,actor,resolved,attempt,command,before=null,limit=25){let n=before??2147483648;const seen=new Set();return array(raw,limit).map(row=>{const x=view(row,actor);need(x.receipt.ordinal<n&&!seen.has(x.query_id)&&x.receipt.authorization_attempt_id===attempt&&x.receipt.authorization_command_id===command&&same(x.resolution,resolved));n=x.receipt.ordinal;seen.add(x.query_id);return x;});}
function project(action,x,a){
 if(action==='use'){exact(x,[...flagsKeys,'private_executor_only','grant']);flags(x);need(x.private_executor_only===true);x.grant=recovery(x.grant,{actor:a.p_user_id,query_id:a.p_query_id,lease_id:a.p_lease_id},true);return x;}
 if(action==='context'){
  exact(x,[...flagsKeys,'read_only','source','observed_at','chain_hash','resolution','policy','heads','selection','next_query_at','blockers','source_validation_required','private_eligible_for_attested_source','history']);flags(x);need(x.read_only===true&&stamp(x.observed_at)&&sha(x.chain_hash)&&x.source_validation_required===true&&bool(x.private_eligible_for_attested_source));x.source=source(x.source,a.p_user_id);bound(x.source,{source_kind:a.p_source_kind,source_command_id:a.p_source_command_id,authorization_attempt_id:a.p_expected_attempt_id});
  x.policy=policy(x.policy);const h=exact(x.heads,['identity_version','a1_version']);need([h.identity_version,h.a1_version].every(v=>v===null||version(v)));x.selection=selection(x.selection,true);selectionSource(x.selection,x.source);bound(x.selection,{expected_identity_version:h.identity_version,expected_a1_version:h.a1_version,expected_query_policy_version:x.policy?.version??null,expected_chain_hash:x.chain_hash});
  array(x.blockers,blockers.length);need(new Set(x.blockers).size===x.blockers.length&&x.blockers.every(b=>blockers.includes(b))&&x.blockers.includes('SOURCE_VALIDATION_REQUIRED')&&x.private_eligible_for_attested_source===(x.blockers.length===1));
  if(x.policy){need(x.policy.model===x.source.model);if(!x.policy.enabled)need(x.blockers.includes('POLICY_DISABLED'));if(Date.parse(x.observed_at)<Date.parse(x.policy.valid_from)||Date.parse(x.observed_at)>=Date.parse(x.policy.valid_until))need(x.blockers.includes('POLICY_TIME_INVALID'));if(x.policy.profile!==MANIFEST.profile||x.policy.manifest_hash!==MANIFEST_HASH||x.policy.binding_profile!==`sp${x.source.model}-receipt-soap12-reviewed-20261016-v1`)need(x.blockers.includes('POLICY_PROFILE_INVALID'));}else need(x.blockers.includes('POLICY_DISABLED'));
  if(h.identity_version===null)need(x.blockers.includes('IDENTITY_MISMATCH'));if(h.a1_version===null)need(x.blockers.includes('A1_UNAVAILABLE'));
  x.resolution=resolution(x.resolution,x.source);need(x.blockers.includes('RESOLUTION_CLOSED')===(x.resolution.state!=='pending')&&(x.next_query_at===null||stamp(x.next_query_at)));if(x.next_query_at!==null&&Date.parse(x.observed_at)<Date.parse(x.next_query_at))need(x.blockers.includes('CADENCE_REQUIRED'));
  x.history=items(x.history,a.p_user_id,x.resolution,x.source.authorization_attempt_id,x.source.authorization_command_id);return x;
 }
 if(action==='history'){
  exact(x,[...flagsKeys,'read_only','authorization_command_id','authorization_attempt_id','observed_at','chain_hash','resolution','items','next_before','limit']);flags(x);need(x.read_only===true&&x.authorization_command_id===a.p_authorization_command_id&&x.authorization_attempt_id===a.p_expected_attempt_id&&stamp(x.observed_at)&&sha(x.chain_hash)&&x.limit===a.p_limit);x.resolution=resolution(x.resolution);x.items=items(x.items,a.p_user_id,x.resolution,x.authorization_attempt_id,x.authorization_command_id,a.p_before,a.p_limit);need(x.next_before===null||x.items.length===a.p_limit&&x.next_before===x.items.at(-1)?.receipt.ordinal);return x;
 }
 const extra=action==='begin'?['replayed','execution']:action==='command'?['read_only','replayed','execution']:['replayed'];x=view(x,a.p_user_id,extra);need(bool(x.replayed)&&x.query_id===(a.p_command_id??a.p_query_id));if(a.p_lease_id!==undefined)need(x.recovery.lease_id===a.p_lease_id);
 if(action==='command')need(x.read_only===true&&x.replayed===true&&x.execution===null);
 if(action==='begin'){selectionSource(a.p_selection,x.source);need(same(x.source_validation,a.p_source_validation));bound(x.receipt,{identity_version:a.p_selection.expected_identity_version,a1_version:a.p_selection.expected_a1_version,query_policy_version:a.p_selection.expected_query_policy_version});if(x.replayed)need(x.execution===null);else need(x.current.state==='prepared'&&!x.current.lease_expired&&same(x.execution,x.recovery));}
 if(action==='prepare')need(x.request!==null&&x.request.sha256===a.p_request_hash&&x.request.size_bytes===a.p_request_size&&same(x.request.evidence,a.p_evidence)&&(x.replayed||x.current.state==='request_ready'));
 if(action==='finish'){need(x.artifact!==null);bound(x.artifact,{response_hash:a.p_response_hash,response_size:a.p_response_size,observation_hash:a.p_observation_hash,observation_size:a.p_observation_size,processed_hash:a.p_processed_hash,processed_size:a.p_processed_size,evidence:a.p_evidence});}
 if(action==='fail')need(x.error_code===a.p_error_code&&['failed_before_dispatch','uncertain'].includes(x.current.state));return x;
}
export function projectReceiptQueryLedger(action,raw,args){try{const a=captureReceiptQueryRpc(action,args);return freeze(project(action,snapshot(raw,RECEIPT_QUERY_RPC_LIMITS.response),a));}catch{throw new AuthorizationServiceError('RECEIPT_QUERY_LEDGER_RESPONSE_INVALID');}}
/** Parsing is not proof of SQL provenance. Only trusted RPC/reader ports may supply these private values. */
export function receiptQueryRecovery(raw,expected={}){try{const e=data(snapshot(expected,8192),[],recoveryKeys,'RECEIPT_QUERY_LEDGER_RESPONSE_INVALID');return freeze(recovery(snapshot(raw,32768),e));}catch{throw new AuthorizationServiceError('RECEIPT_QUERY_LEDGER_RESPONSE_INVALID');}}
export function receiptQueryGrant(raw,args){return projectReceiptQueryLedger('use',raw,args);}
