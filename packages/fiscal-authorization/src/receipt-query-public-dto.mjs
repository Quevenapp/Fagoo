/** Browser-safe089 boundary. Accepts only an already sanitized service envelope, never a raw SQL view. */
export const RECEIPT_QUERY_PUBLIC_PROFILE='receipt-query-public-089-v1';
export const RECEIPT_QUERY_SOURCE_PROFILE='receipt-query-source-089-v1';
export const RECEIPT_QUERY_SOURCE_MANIFEST_HASH='748e9ebf8d01b10d098e0bf010016a9c4b30a00169e93c9c5bb1491c48d69098';
export const MAX_RECEIPT_QUERY_INPUT_BYTES=16384;
export const MAX_RECEIPT_QUERY_PUBLIC_BYTES=262144;
export const RECEIPT_QUERY_PUBLIC_FLAGS=Object.freeze({data_mode:'fiscal_receipt_query',profile:RECEIPT_QUERY_PUBLIC_PROFILE,environment:'2',tax_rules_validated:false,can_emit:false,can_transmit:false,production_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false,retry_submission_allowed:false});
export class ReceiptQueryPublicError extends Error {constructor(code='RECEIPT_QUERY_RESPONSE_INVALID'){super(code);this.name='ReceiptQueryPublicError';this.code=code;}}
const need=v=>{if(!v)throw new ReceiptQueryPublicError();};
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,max=2147483647)=>Number.isSafeInteger(v)&&v>0&&v<=max;
const version=v=>integer(v,999999999);
const code=v=>typeof v==='string'&&/^\d{3,4}$/.test(v);
const protocol=v=>typeof v==='string'&&/^(?:\d{15}|\d{17})$/.test(v)&&!/^0+$/.test(v);
const bool=v=>typeof v==='boolean';
const kinds=['authorization','revalidation'];
const states=['prepared','request_ready','dispatched','uncertain','failed_before_dispatch','receipt_pending','rejected','review_required','authorized_homologation'];
const rejectionCodes=['SOAP_FAULT','SOAP_INVALID','XML_INVALID','XSD_INVALID','CONTEXT_MISMATCH','DIGEST_MISMATCH','PROCESSED_INVALID'];
const errorCodes=['RECEIPT_QUERY_PREPARATION_FAILED','RECEIPT_QUERY_CUSTODY_FAILED','RECEIPT_QUERY_TRANSPORT_FAILED','RECEIPT_QUERY_TRANSPORT_TIMEOUT','RECEIPT_QUERY_STORAGE_FAILED','RECEIPT_QUERY_RESULT_UNCONFIRMED','RECEIPT_QUERY_CANCELLED'];
const blockers=['SOURCE_VALIDATION_REQUIRED','POLICY_DISABLED','POLICY_TIME_INVALID','POLICY_PROFILE_INVALID','IDENTITY_MISMATCH','A1_UNAVAILABLE','A1_INVALID','A1_STORAGE_INVALID','RESOLUTION_CLOSED','QUERY_ACTIVE','CADENCE_REQUIRED','RATE_LIMIT','RUNTIME_DISABLED'];
const selectionKeys=['source_kind','source_command_id','expected_authorization_command_id','expected_attempt_id','expected_candidate_id','expected_candidate_version','expected_signed_hash','expected_source_binding_hash','expected_chain_hash','expected_identity_version','expected_a1_version','expected_query_policy_version'];
const sourceKeys=['source_kind','source_command_id','authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin','source_binding_hash','original','revalidation'];
const receiptKeys=['query_id','authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin','ordinal','identity_version','a1_version','query_policy_version','created_at','expires_at'];
const flagKeys=Object.keys(RECEIPT_QUERY_PUBLIC_FLAGS);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function stamp(v,canonical=false){
 if(typeof v!=='string'||!(canonical?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/:/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/).test(v))return false;
 const t=Date.parse(v);return Number.isFinite(t)&&new Date(t).toISOString().slice(0,19)===v.slice(0,19);
}
function fields(x,keys){need(x!==null&&typeof x==='object'&&!Array.isArray(x));const actual=Object.keys(x);need(actual.length===keys.length&&actual.every(k=>keys.includes(k)));return x;}
function list(x,max=25){need(Array.isArray(x)&&x.length<=max);return x;}
/** Bounds are independent of legacy128KiB DTOs. Capture own data without invoking accessors/toJSON. */
function snapshot(raw,max){
 let nodes=0,units=0;const seen=new WeakSet();
 const charge=n=>{units+=n;need(units<=max);};
 const copy=(x,depth)=>{
  need(++nodes<=25000&&depth<=20);
  if(x===null||typeof x==='boolean')return x;
  if(typeof x==='number'){need(Number.isFinite(x));return x;}
  if(typeof x==='string'){charge(x.length);return x;}
  need(x!==null&&typeof x==='object'&&!seen.has(x));seen.add(x);
  const array=Array.isArray(x),proto=Object.getPrototypeOf(x);need(array?proto===Array.prototype:[Object.prototype,null].includes(proto));
  const d=Object.getOwnPropertyDescriptors(x),keys=Reflect.ownKeys(d);let out;
  if(array){need(Object.hasOwn(d.length??{},'value')&&Number.isSafeInteger(d.length.value)&&d.length.value<=25000);out=[];need(keys.length===d.length.value+1);
   for(let i=0;i<d.length.value;i++){const v=d[String(i)];need(v&&Object.hasOwn(v,'value')&&v.enumerable);out.push(copy(v.value,depth+1));}
  }else{out={};for(const k of keys){need(typeof k==='string'&&k!=='__proto__'&&Object.hasOwn(d[k],'value')&&d[k].enumerable);charge(k.length);Object.defineProperty(out,k,{value:copy(d[k].value,depth+1),enumerable:true,writable:true,configurable:true});}}
  seen.delete(x);return out;
 };
 const out=copy(raw,0);need(new TextEncoder().encode(JSON.stringify(out)).byteLength<=max);return out;
}
function capture(raw,parse){try{return freeze(parse(snapshot(raw,MAX_RECEIPT_QUERY_INPUT_BYTES)));}catch{throw new ReceiptQueryPublicError('RECEIPT_QUERY_INPUT_INVALID');}}
function contextInput(x){fields(x,['source_kind','source_command_id','expected_attempt_id']);need(kinds.includes(x.source_kind)&&id(x.source_command_id)&&id(x.expected_attempt_id));return x;}
function historyInput(x){fields(x,['authorization_command_id','expected_attempt_id','limit','before']);need(id(x.authorization_command_id)&&id(x.expected_attempt_id)&&integer(x.limit,25)&&(x.before===null||integer(x.before)));return x;}
function selection(x){fields(x,selectionKeys);need(kinds.includes(x.source_kind)&&['source_command_id','expected_authorization_command_id','expected_attempt_id','expected_candidate_id'].every(k=>id(x[k]))&&['expected_candidate_version','expected_identity_version','expected_a1_version','expected_query_policy_version'].every(k=>version(x[k]))&&['expected_signed_hash','expected_source_binding_hash','expected_chain_hash'].every(k=>hash(x[k])));need(x.source_kind==='authorization'?x.source_command_id===x.expected_authorization_command_id:x.source_command_id!==x.expected_authorization_command_id);return x;}
function runInput(x){fields(x,[...selectionKeys,'command_id','confirmed']);need(id(x.command_id)&&x.confirmed===true&&x.command_id!==x.source_command_id&&x.command_id!==x.expected_authorization_command_id);selection(Object.fromEntries(selectionKeys.map(k=>[k,x[k]])));return x;}
function recoverInput(x){fields(x,['confirmed']);need(x.confirmed===true);return x;}
export const captureReceiptQueryContextInput=raw=>capture(raw,contextInput);
export const captureReceiptQueryHistoryInput=raw=>capture(raw,historyInput);
export const captureReceiptQueryRunInput=raw=>capture(raw,runInput);
export const captureReceiptQueryRecoverInput=raw=>capture(raw,recoverInput);
function binding(raw){
 const b=snapshot(raw,MAX_RECEIPT_QUERY_INPUT_BYTES);
 if(b.action==='receiptQueryContext'){fields(b,['action','input']);b.input=contextInput(b.input);}
 else if(b.action==='receiptQueryHistory'){fields(b,['action','input']);b.input=historyInput(b.input);}
 else if(b.action==='receiptQueryCommand'){fields(b,['action','commandId']);need(id(b.commandId));}
 else if(b.action==='receiptQueryRun'){fields(b,['action','commandId','input']);b.input=runInput(b.input);need(b.commandId===b.input.command_id);}
 else{fields(b,['action','commandId','input']);need(b.action==='receiptQueryRecover'&&id(b.commandId));b.input=recoverInput(b.input);}
 return b;
}
function flags(x){need(flagKeys.every(k=>x[k]===RECEIPT_QUERY_PUBLIC_FLAGS[k]));}
function source(x){
 fields(x,sourceKeys);need(kinds.includes(x.source_kind)&&['source_command_id','authorization_command_id','authorization_attempt_id','candidate_id'].every(k=>id(x[k]))&&version(x.candidate_version)&&hash(x.signed_hash)&&integer(x.signed_size,512000)&&['55','65'].includes(x.model)&&x.environment==='2'&&x.origin==='operational'&&hash(x.source_binding_hash));
 const o=fields(x.original,['state','outcome','rejection_code','cstat','protocol_cstat','response_hash','response_size','recorded_at']);need(o.protocol_cstat===null&&hash(o.response_hash)&&integer(o.response_size,512000)&&stamp(o.recorded_at));
 if(x.source_kind==='authorization')need(x.source_command_id===x.authorization_command_id&&x.revalidation===null&&o.state==='receipt_pending'&&o.outcome==='receipt_pending'&&o.cstat==='103'&&o.rejection_code===null);
 else{need(x.source_command_id!==x.authorization_command_id&&o.state==='review_required'&&o.outcome==='invalid_response'&&o.cstat===null&&o.rejection_code==='SOAP_INVALID');
  const r=fields(x.revalidation,['command_id','state','cstat','protocol_cstat','recorded_at']);need(r.command_id===x.source_command_id&&r.state==='receipt_pending'&&r.cstat==='103'&&r.protocol_cstat===null&&stamp(r.recorded_at)&&Date.parse(r.recorded_at)>=Date.parse(o.recorded_at));}
 return x;
}
function publicProtocol(x){
 fields(x,['state','cstat','protocol_cstat','protocol_number','received_at']);need(['authorized_homologation','rejected'].includes(x.state)&&x.cstat==='104'&&code(x.protocol_cstat)&&stamp(x.received_at));
 if(x.state==='authorized_homologation')need(['100','150'].includes(x.protocol_cstat)&&protocol(x.protocol_number));
 else need(Number(x.protocol_cstat)>=200&&!['204','217','539'].includes(x.protocol_cstat)&&x.protocol_number===null);
 return x;
}
function resolution(x){
 fields(x,['state','resolution_hash','query_ids','selected_query_id','protocol']);need(['pending','authorized_homologation','rejected','review_required','conflict'].includes(x.state)&&hash(x.resolution_hash));
 list(x.query_ids,25000);need(x.query_ids.every(id)&&new Set(x.query_ids).size===x.query_ids.length);
 if(['authorized_homologation','rejected'].includes(x.state)){need(id(x.selected_query_id)&&x.query_ids.includes(x.selected_query_id));publicProtocol(x.protocol);need(x.protocol.state===x.state);}
 else{need(x.selected_query_id===null&&x.protocol===null);need(x.state==='conflict'?x.query_ids.length>=2:x.query_ids.length===0);}
 return x;
}
function observation(x){
 fields(x,['response_hash','response_size','recorded_at','outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified','processed_hash','processed_size']);
 need(hash(x.response_hash)&&integer(x.response_size,512000)&&stamp(x.recorded_at)&&x.tls_origin_verified===true&&['signature_verified','xsd_validated','context_matched','processed_xsd_validated'].every(k=>bool(x[k])));
 if(x.outcome==='invalid_response'){need(rejectionCodes.includes(x.rejection_code)&&['cstat','protocol_cstat','protocol_number','received_at','processed_hash','processed_size'].every(k=>x[k]===null)&&['signature_verified','xsd_validated','context_matched','processed_xsd_validated'].every(k=>x[k]===false));return x;}
 need(x.rejection_code===null&&code(x.cstat)&&stamp(x.received_at,true)&&x.xsd_validated&&x.context_matched&&(x.protocol_cstat===null||code(x.protocol_cstat)&&x.cstat==='104'));
 if(x.outcome==='authorization_declared')need(x.cstat==='104'&&['100','150'].includes(x.protocol_cstat)&&protocol(x.protocol_number)&&x.signature_verified&&x.processed_xsd_validated&&hash(x.processed_hash)&&integer(x.processed_size,512000));
 else{
  need(x.signature_verified===false&&x.processed_xsd_validated===false&&x.protocol_number===null&&x.processed_hash===null&&x.processed_size===null);
  if(x.outcome==='receipt_pending')need(x.cstat==='105'&&x.protocol_cstat===null);
  else if(x.outcome==='rejected')need(x.cstat==='104'&&code(x.protocol_cstat)&&Number(x.protocol_cstat)>=200&&!['204','217','539'].includes(x.protocol_cstat));
  else need(x.outcome==='review_required'&&!['100','150','105'].includes(x.cstat)&&!['100','150'].includes(x.protocol_cstat));
 }
 return x;
}
function result(x,b){
 fields(x,[...flagKeys,'kind','can_query','read_only','replayed','command_id','source','receipt','current','observation','resolution','error_code']);flags(x);
 need(x.kind==='result'&&x.can_query===false&&bool(x.read_only)&&bool(x.replayed)&&(!x.read_only||x.replayed)&&id(x.command_id));source(x.source);
 const r=fields(x.receipt,receiptKeys),s=x.source;need(r.query_id===x.command_id&&r.query_id!==s.source_command_id&&r.query_id!==s.authorization_command_id&&['authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin'].every(k=>r[k]===s[k])&&integer(r.ordinal)&&['identity_version','a1_version','query_policy_version'].every(k=>version(r[k]))&&stamp(r.created_at)&&stamp(r.expires_at)&&Date.parse(r.expires_at)-Date.parse(r.created_at)===60000);
 const c=fields(x.current,['state','grant_consumed','used_at','expires_at','lease_expired','finished_at','recovery_required','can_recover']);need(states.includes(c.state)&&['grant_consumed','lease_expired','recovery_required','can_recover'].every(k=>bool(c[k]))&&c.expires_at===r.expires_at&&(c.used_at===null||stamp(c.used_at)&&Date.parse(c.used_at)>=Date.parse(r.created_at))&&(c.finished_at===null||stamp(c.finished_at)&&Date.parse(c.finished_at)>=Date.parse(c.used_at??r.created_at))&&c.grant_consumed===(c.used_at!==null));
 need(c.recovery_required===['dispatched','uncertain'].includes(c.state)&&(!c.can_recover||c.recovery_required));
 need(x.error_code===null||errorCodes.includes(x.error_code));
 if(['prepared','request_ready'].includes(c.state))need(!c.grant_consumed&&c.finished_at===null&&x.observation===null&&x.error_code===null);
 else if(c.state==='failed_before_dispatch')need(!c.grant_consumed&&c.finished_at!==null&&x.observation===null&&x.error_code!==null);
 else if(c.state==='dispatched')need(c.grant_consumed&&c.finished_at===null&&x.observation===null&&x.error_code===null);
 else if(c.state==='uncertain')need(c.grant_consumed&&c.finished_at!==null&&x.observation===null&&x.error_code!==null);
 else{need(c.grant_consumed&&c.finished_at!==null&&x.error_code===null);observation(x.observation);const expected=x.observation.outcome==='authorization_declared'?'authorized_homologation':x.observation.outcome==='invalid_response'?'review_required':x.observation.outcome;need(c.state===expected&&Date.parse(x.observation.recorded_at)>=Date.parse(c.used_at));}
 resolution(x.resolution);selectedObservation(x);
 if(b){need(x.command_id===b.commandId);if(b.action==='receiptQueryCommand')need(x.read_only);else need(!x.read_only);if(b.action==='receiptQueryRun'){const i=b.input;selectionMatchesSource(i,s);need(r.identity_version===i.expected_identity_version&&r.a1_version===i.expected_a1_version&&r.query_policy_version===i.expected_query_policy_version);}}
 return x;
}
function selectedObservation(x){
 if(x.resolution.selected_query_id!==x.command_id)return;
 const o=x.observation,p=x.resolution.protocol;need(o!==null&&p!==null&&x.current.state===x.resolution.state&&['cstat','protocol_cstat','protocol_number'].every(k=>o[k]===p[k])&&Date.parse(o.received_at)===Date.parse(p.received_at));
}
function selectionMatchesSource(i,s){need(i.source_kind===s.source_kind&&i.source_command_id===s.source_command_id&&i.expected_authorization_command_id===s.authorization_command_id&&i.expected_attempt_id===s.authorization_attempt_id&&i.expected_candidate_id===s.candidate_id&&i.expected_candidate_version===s.candidate_version&&i.expected_signed_hash===s.signed_hash&&i.expected_source_binding_hash===s.source_binding_hash);}
function chainItems(items,{authorization_command_id,authorization_attempt_id,resolution:resolved,source:bound,before=null,max=25}){
 list(items,max);let ordinal=before??2147483648;const ids=new Set();for(const item of items){result(item);const r=item.receipt;need(item.read_only&&r.authorization_command_id===authorization_command_id&&r.authorization_attempt_id===authorization_attempt_id&&r.ordinal<ordinal&&!ids.has(r.query_id)&&same(item.resolution,resolved));ids.add(r.query_id);ordinal=r.ordinal;
  if(bound)need(['authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin'].every(k=>item.source[k]===bound[k]));
 }
 return items;
}
function context(x,b){
 fields(x,[...flagKeys,'kind','read_only','source','observed_at','chain_hash','source_validation','eligibility','policy','can_query','selection','next_query_at','blockers','resolution','history']);flags(x);need(x.kind==='context'&&x.read_only===true&&stamp(x.observed_at)&&hash(x.chain_hash)&&bool(x.can_query)&&(x.next_query_at===null||stamp(x.next_query_at)));source(x.source);need(x.source.source_kind===b.input.source_kind&&x.source.source_command_id===b.input.source_command_id&&x.source.authorization_attempt_id===b.input.expected_attempt_id);
 const v=fields(x.source_validation,['profile','manifest_hash','verified']);need(v.profile===RECEIPT_QUERY_SOURCE_PROFILE&&v.manifest_hash===RECEIPT_QUERY_SOURCE_MANIFEST_HASH&&bool(v.verified));
 list(x.blockers,blockers.length);need(x.blockers.every(k=>blockers.includes(k))&&new Set(x.blockers).size===x.blockers.length&&x.blockers.includes('SOURCE_VALIDATION_REQUIRED')===!v.verified);
 const eligibility=fields(x.eligibility,['ledger_eligible','runtime_enabled']);need(bool(eligibility.ledger_eligible)&&bool(eligibility.runtime_enabled)&&x.blockers.includes('RUNTIME_DISABLED')===!eligibility.runtime_enabled);
 if(!eligibility.ledger_eligible)need(x.blockers.some(k=>!['SOURCE_VALIDATION_REQUIRED','RUNTIME_DISABLED'].includes(k)));
 if(x.policy!==null){const p=fields(x.policy,['version','enabled','valid_from','valid_until','cadence_seconds','max_queries_per_hour']);need(version(p.version)&&bool(p.enabled)&&stamp(p.valid_from)&&stamp(p.valid_until)&&Date.parse(p.valid_from)<Date.parse(p.valid_until)&&p.cadence_seconds===60&&p.max_queries_per_hour===10);need(p.enabled||x.blockers.includes('POLICY_DISABLED'));if(Date.parse(x.observed_at)<Date.parse(p.valid_from)||Date.parse(x.observed_at)>=Date.parse(p.valid_until))need(x.blockers.includes('POLICY_TIME_INVALID'));}
 else need(x.blockers.includes('POLICY_DISABLED'));
 resolution(x.resolution);need(x.blockers.includes('RESOLUTION_CLOSED')===(x.resolution.state!=='pending'));
 if(x.next_query_at!==null&&Date.parse(x.observed_at)<Date.parse(x.next_query_at))need(x.blockers.includes('CADENCE_REQUIRED'));
 need(x.can_query===(eligibility.ledger_eligible&&eligibility.runtime_enabled&&v.verified&&x.blockers.length===0));
 if(x.can_query){need(v.verified&&x.policy?.enabled);selection(x.selection);selectionMatchesSource(x.selection,x.source);need(x.selection.expected_chain_hash===x.chain_hash&&x.selection.expected_query_policy_version===x.policy.version);}
 else need(x.selection===null);
 chainItems(x.history,{authorization_command_id:x.source.authorization_command_id,authorization_attempt_id:x.source.authorization_attempt_id,resolution:x.resolution,source:x.source});return x;
}
function history(x,b){
 fields(x,[...flagKeys,'kind','can_query','read_only','authorization_command_id','authorization_attempt_id','observed_at','chain_hash','resolution','items','next_before','limit']);flags(x);const i=b.input;need(x.kind==='history'&&x.can_query===false&&x.read_only===true&&x.authorization_command_id===i.authorization_command_id&&x.authorization_attempt_id===i.expected_attempt_id&&stamp(x.observed_at)&&hash(x.chain_hash)&&x.limit===i.limit);resolution(x.resolution);
 chainItems(x.items,{authorization_command_id:x.authorization_command_id,authorization_attempt_id:x.authorization_attempt_id,resolution:x.resolution,before:i.before,max:i.limit});need(x.next_before===null||x.items.length===i.limit&&x.next_before===x.items.at(-1).receipt.ordinal);return x;
}
/** Closed output, bound to the requested operation; safe to use in the browser and HMAC gateway. */
export function projectReceiptQueryPublic(raw,selected){
 try{const b=binding(selected),x=snapshot(raw,MAX_RECEIPT_QUERY_PUBLIC_BYTES);return freeze(b.action==='receiptQueryContext'?context(x,b):b.action==='receiptQueryHistory'?history(x,b):result(x,b));}
 catch{throw new ReceiptQueryPublicError();}
}
