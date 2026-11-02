/** Browser-safe079 projection. XML and backend attestation never enter public input. */
export const REVALIDATION_PROFILE='authorization-stored-response-utf8-v1';
export const REVALIDATION_PARSER_HASH='26a4ba4dcc9dbad2e196ae76136fbe8465f5dd235ca7aa30c468c192a8cce033';
export const MAX_REVALIDATION_REQUEST_BYTES=16384;
export const MAX_REVALIDATION_RESPONSE_BYTES=262144;
export const REVALIDATION_FLAGS=Object.freeze({data_mode:'fiscal_authorization_revalidation',environment:'2',tax_rules_validated:false,can_emit:false,can_transmit:false,production_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false,retry_submission_allowed:false});
export class RevalidationDtoError extends Error{constructor(code='AUTHORIZATION_REVALIDATION_RESPONSE_INVALID'){super(code);this.name='RevalidationDtoError';this.code=code;}}
const need=(v,code)=>{if(!v)throw new RevalidationDtoError(code);};
const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,max=2147483647)=>Number.isSafeInteger(v)&&v>=1&&v<=max;
const stamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const code=v=>typeof v==='string'&&/^\d{3,4}$/.test(v);
const proto=v=>typeof v==='string'&&/^(?:\d{15}|\d{17})$/.test(v)&&!/^0+$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function fields(value,keys,error){try{need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),error);const d=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(d);need(actual.length===keys.length&&actual.every(k=>typeof k==='string'&&keys.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')),error);return Object.fromEntries(keys.map(k=>[k,d[k].value]));}catch(e){throw e instanceof RevalidationDtoError?e:new RevalidationDtoError(error);}}
const flags=x=>need(Object.entries(REVALIDATION_FLAGS).every(([k,v])=>x[k]===v));
export function captureRevalidationInput(raw){const err='AUTHORIZATION_REVALIDATION_INPUT_INVALID',x=fields(raw,['command_id','authorization_command_id','expected_attempt_id','expected_source_hash','confirmed'],err);need([x.command_id,x.authorization_command_id,x.expected_attempt_id].every(id)&&x.command_id!==x.authorization_command_id&&hash(x.expected_source_hash)&&x.confirmed===true,err);return freeze(x);}
function binding(raw){
 need(raw!==null&&typeof raw==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(raw)));
 const d=Object.getOwnPropertyDescriptor(raw??{},'action');need(d&&Object.hasOwn(d,'value'));
 if(d.value==='revalidationContext'){const x=fields(raw,['action','authorizationCommandId','expectedAttemptId']);need(id(x.authorizationCommandId)&&id(x.expectedAttemptId));return x;}
 if(d.value==='revalidationCommand'){const x=fields(raw,['action','commandId']);need(id(x.commandId));return x;}
 need(d.value==='revalidationRun');const x=fields(raw,['action','commandId','input']);x.input=captureRevalidationInput(x.input);need(x.commandId===x.input.command_id);return x;
}
function artifact(raw){
 const x=fields(raw,['response_hash','response_size','payload_hash','outcome','cstat','protocol_cstat','protocol_number','received_at','receipt_number','tls_origin_verified','signature_verified','xsd_validated','context_matched','processed_xsd_validated']);
 need(hash(x.response_hash)&&integer(x.response_size,512000)&&hash(x.payload_hash)&&code(x.cstat)&&stamp(x.received_at)&&['authorization_declared','receipt_pending','rejected','review_required'].includes(x.outcome));
 need((x.protocol_cstat===null||code(x.protocol_cstat))&&(x.protocol_number===null||proto(x.protocol_number))&&(x.protocol_cstat===null||x.cstat==='104'));
 need(x.tls_origin_verified===true&&x.xsd_validated===true&&x.context_matched===true&&typeof x.signature_verified==='boolean'&&typeof x.processed_xsd_validated==='boolean');
 const authorized=x.outcome==='authorization_declared';need(x.signature_verified===authorized&&x.processed_xsd_validated===authorized);
 if(authorized)need(x.cstat==='104'&&['100','150'].includes(x.protocol_cstat)&&proto(x.protocol_number)&&x.receipt_number===null);
 else if(x.outcome==='receipt_pending')need(x.cstat==='103'&&typeof x.receipt_number==='string'&&/^\d{15}$/.test(x.receipt_number)&&!/^0+$/.test(x.receipt_number)&&x.protocol_cstat===null&&x.protocol_number===null);
 else{need(x.receipt_number===null);const c=x.protocol_cstat??x.cstat;if(x.outcome==='rejected')need(Number(c)>=200&&!['204','217','539'].includes(c));else need(!['100','150'].includes(c));}
 return x;
}
function result(raw,b){
 const x=fields(raw,[...Object.keys(REVALIDATION_FLAGS),'kind','read_only','command_id','replayed','receipt']);flags(x);need(x.kind==='result'&&id(x.command_id)&&typeof x.read_only==='boolean'&&typeof x.replayed==='boolean'&&(!x.read_only||x.replayed));
 const r=fields(x.receipt,['command_id','authorization_command_id','attempt_id','candidate_id','candidate_version','signed_hash','model','origin','source_hash','parser_profile','parser_manifest_hash','original_state','state','artifact','processed_hash','processed_size','created_at','tax_rules_validated']);
 need(['command_id','authorization_command_id','attempt_id','candidate_id'].every(k=>id(r[k]))&&r.command_id===x.command_id&&r.command_id!==r.authorization_command_id&&integer(r.candidate_version)&&hash(r.signed_hash)&&['55','65'].includes(r.model)&&r.origin==='operational'&&hash(r.source_hash)&&r.parser_profile===REVALIDATION_PROFILE&&r.parser_manifest_hash===REVALIDATION_PARSER_HASH&&r.original_state==='review_required'&&stamp(r.created_at)&&r.tax_rules_validated===false);
 r.artifact=artifact(r.artifact);const authorized=r.artifact.outcome==='authorization_declared';need(r.state===(authorized?'authorized_homologation':r.artifact.outcome));need(authorized?hash(r.processed_hash)&&integer(r.processed_size,512000):r.processed_hash===null&&r.processed_size===null);x.receipt=r;
 if(b){need(x.command_id===b.commandId);if(b.action==='revalidationCommand')need(x.read_only===true);else{need(x.read_only===false);const i=b.input;need(r.authorization_command_id===i.authorization_command_id&&r.attempt_id===i.expected_attempt_id&&r.source_hash===i.expected_source_hash);}}
 return x;
}
export function projectRevalidationPublic(raw,selected){
 const b=binding(selected);if(b.action!=='revalidationContext')return freeze(result(raw,b));
 const x=fields(raw,[...Object.keys(REVALIDATION_FLAGS),'kind','read_only','authorization_command_id','attempt_id','candidate','source_hash','parser','original','can_revalidate','existing']);flags(x);
 need(x.kind==='context'&&x.read_only===true&&x.authorization_command_id===b.authorizationCommandId&&x.attempt_id===b.expectedAttemptId&&hash(x.source_hash)&&typeof x.can_revalidate==='boolean');
 const c=fields(x.candidate,['candidate_id','candidate_version','signed_hash','model','origin']);need(id(c.candidate_id)&&integer(c.candidate_version)&&hash(c.signed_hash)&&['55','65'].includes(c.model)&&c.origin==='operational');x.candidate=c;
 const p=fields(x.parser,['profile','manifest_hash']);need(p.profile===REVALIDATION_PROFILE&&p.manifest_hash===REVALIDATION_PARSER_HASH);x.parser=p;
 const o=fields(x.original,['state','outcome','rejection_code','cstat','protocol_cstat','response_hash','response_size','recorded_at']);need(o.state==='review_required'&&o.outcome==='invalid_response'&&o.rejection_code==='SOAP_INVALID'&&o.cstat===null&&o.protocol_cstat===null&&hash(o.response_hash)&&integer(o.response_size,512000)&&stamp(o.recorded_at));x.original=o;
 need(x.can_revalidate===(x.existing===null));if(x.existing!==null){const e=result(x.existing);need(e.read_only&&e.replayed);const r=e.receipt;need(r.authorization_command_id===x.authorization_command_id&&r.attempt_id===x.attempt_id&&r.source_hash===x.source_hash&&['candidate_id','candidate_version','signed_hash','model','origin'].every(k=>r[k]===c[k])&&r.artifact.response_hash===o.response_hash&&r.artifact.response_size===o.response_size);x.existing=e;}
 return freeze(x);
}
