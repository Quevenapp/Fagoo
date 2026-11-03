/** Internal051 boundary. Execution/grant contain private custody references, never public HTTP DTOs. */
import {isValidCnpj} from '../../fiscal-core/src/identity.mjs';
import {prepareWsdlRequest,WSDL_FLAGS} from './profile.mjs';
import {WSDL_UNSUPPORTED_CODES} from './inspect-wsdl.mjs';
export class WsdlServiceError extends Error{constructor(code){super(code);this.name='WsdlServiceError';this.code=code;this.retry_automatically=false;}}
export const need=(v,c='WSDL_SERVICE_RESPONSE_INVALID')=>{if(!v)throw new WsdlServiceError(c);};
export function fields(v,keys,optional=[]){try{return v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...keys,...optional].includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'))&&keys.every(k=>Object.hasOwn(v,k));}catch{return false;}}
export const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const integer=(v,max=2147483647,min=1)=>Number.isInteger(v)&&v>=min&&v<=max;
export function stamp(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(v)||!Number.isFinite(Date.parse(v)))return false;const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;return new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);}
export const FLAGS=Object.freeze({data_mode:'fiscal_wsdl_evidence',profile:'sp-homologation-wsdl-evidence-v1',purpose:'sefaz-sp-wsdl-readonly-v1',environment:'2',...WSDL_FLAGS});
export const FAILURES=Object.freeze(['WSDL_CERTIFICATE_REJECTED','WSDL_AUTHORIZATION_REJECTED','WSDL_TLS_FAILED','WSDL_TIMEOUT','WSDL_ABORTED','WSDL_RESPONSE_REJECTED','WSDL_STORAGE_FAILED','WSDL_RUNTIME_FAILED']);
export const SQLSTATES=Object.freeze(['42501','40001','22023','55000','P0002']);
const flag=v=>need(Object.entries(FLAGS).every(([k,x])=>v[k]===x));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export const same=(a,b)=>canonical(a)===canonical(b);
export const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const RECEIPT=['attempt_id','command_id','profile','model','operation','environment','a1_version','identity_version','confirmed','created_at'];
const CURRENT=['state','a1_version','identity_version','a1_changed','company_changed','certificate_time_valid_now','grant_consumed','lease_expired','expires_at','used_at','finished_at','recovery_required','retry_get_allowed'];
const SCOPE=['attempt_id','command_id','actor','nonce','expires_at','purpose','effective_profile','environment','model','operation','method','endpoint','identity_version','issuer_cnpj','a1_version','credential_id','envelope_hash','certificate_fingerprint'];
const CONTEXT=['vault_id','credential_id','credential_version','company_identity_version','holder_cnpj','environment','purpose'];
const META=['profile','legacy_provider_enabled','pfx_mac','pfx_mac_iterations','fingerprint_sha256','holder_cnpj','not_before','not_after','rsa_bits','presented_chain','validated_at','key_matches_certificate','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'];
export function scope(v,args={},issued=false){
 need(fields(v,issued?[...SCOPE,'issued_at']:SCOPE)&&['attempt_id','command_id','actor','nonce','credential_id'].every(k=>id(v[k]))&&['identity_version','a1_version'].every(k=>integer(v[k]))&&['envelope_hash','certificate_fingerprint'].every(k=>sha(v[k]))&&isValidCnpj(v.issuer_cnpj)&&stamp(v.expires_at));
 need(v.purpose===FLAGS.purpose&&v.effective_profile==='wsdl-mtls-client-v1'&&v.environment==='2'&&v.method==='GET'&&['55','65'].includes(v.model)&&['protocol','status','authorization','receipt'].includes(v.operation));
 need(v.endpoint===prepareWsdlRequest({model:v.model,operation:v.operation,requestId:v.attempt_id}).url);
 if(issued)need(stamp(v.issued_at)&&Date.parse(v.issued_at)<Date.parse(v.expires_at));
 for(const [arg,key]of [['p_user_id','actor'],['p_attempt_id','attempt_id'],['p_command_id','command_id'],['p_model','model'],['p_operation','operation'],['p_expected_a1_version','a1_version'],['p_expected_identity_version','identity_version']])if(args[arg]!==undefined)need(v[key]===args[arg]);
 return pick(v,issued?[...SCOPE,'issued_at']:SCOPE);
}
export function evidence(v,expected={}){
 need(fields(v,['profile','request_id','model','operation','environment','wsdl_hash','size_bytes','received_at','tls','inspection','binding_verified'])&&v.profile===FLAGS.profile&&id(v.request_id)&&['55','65'].includes(v.model)&&['protocol','status','authorization','receipt'].includes(v.operation)&&v.environment==='2'&&sha(v.wsdl_hash)&&integer(v.size_bytes,512000)&&stamp(v.received_at)&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.received_at)&&v.binding_verified===false);
 for(const[k,x]of Object.entries(expected))need(v[k]===x);
 const t=v.tls,i=v.inspection;need(fields(t,['protocol','server_identity_verified','client_fingerprint','client_chain','client_profile','revocation'])&&['TLSv1.2','TLSv1.3'].includes(t.protocol)&&t.server_identity_verified===true&&sha(t.client_fingerprint)&&['verified_offline','not_evaluated'].includes(t.client_chain)&&['compatible','not_evaluated'].includes(t.client_profile)&&['unknown_offline','not_revoked_in_supplied_crls'].includes(t.revocation));
 need(fields(i,['inspection_status','code','validation','target_namespace','bindings_count','operations_count','addresses_count'])&&i.validation==='structural_evidence_only');
 if(i.inspection_status==='supported')need(i.code===null&&typeof i.target_namespace==='string'&&i.target_namespace.length<=2048&&/^https?:\/\/[!-~]+$/.test(i.target_namespace)&&integer(i.bindings_count,8)&&integer(i.operations_count,128)&&integer(i.addresses_count,32));
 else need(i.inspection_status==='unsupported'&&WSDL_UNSUPPORTED_CODES.includes(i.code)&&['target_namespace','bindings_count','operations_count','addresses_count'].every(k=>i[k]===null));
 const out={...v,tls:{...t},inspection:{...i}};need(Buffer.byteLength(JSON.stringify(out))<=8192);return out;
}
function execution(v,args,r,c){
 if(v===null)return null;need(fields(v,['private_executor_only','lease_id','scope','credential'])&&v.private_executor_only===true&&id(v.lease_id)&&c.state==='prepared'&&!c.grant_consumed&&!c.lease_expired);
 const s=scope(v.scope,args),k=v.credential;need(s.attempt_id===r.attempt_id&&s.expires_at===c.expires_at&&fields(k,['id','context','metadata','object'])&&k.id===s.credential_id);
 const ctx=k.context,m=k.metadata,o=k.object;need(fields(ctx,CONTEXT)&&id(ctx.vault_id)&&ctx.credential_id===s.credential_id&&ctx.credential_version===1&&ctx.company_identity_version===s.identity_version&&ctx.holder_cnpj===s.issuer_cnpj&&ctx.environment==='2'&&ctx.purpose==='offline-homologation');
 need(fields(m,META)&&m.profile==='openssl3-pkcs12'&&typeof m.legacy_provider_enabled==='boolean'&&['sha1','sha224','sha256','sha384','sha512'].includes(m.pfx_mac)&&integer(m.pfx_mac_iterations,1000000)&&m.fingerprint_sha256===s.certificate_fingerprint&&m.holder_cnpj===s.issuer_cnpj&&[2048,3072,4096].includes(m.rsa_bits)&&['not_before','not_after','validated_at'].every(x=>stamp(m[x]))&&Date.parse(m.not_before)<=Date.parse(m.validated_at)&&Date.parse(m.validated_at)<=Date.parse(m.not_after)&&Array.isArray(m.presented_chain)&&m.presented_chain.length>=1&&m.presented_chain.length<=10&&m.presented_chain.every(sha)&&new Set(m.presented_chain).size===m.presented_chain.length&&m.presented_chain[0]===s.certificate_fingerprint&&m.key_matches_certificate===true&&m.presented_chain_links_checked===true&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','client_auth_eku_verified','can_transmit'].every(x=>m[x]===false));
 need(fields(o,['bucket','key','hash','size_bytes','key_id'])&&o.bucket==='brufap-a1-vault'&&o.hash===s.envelope_hash&&o.key===`credentials/${s.credential_id}/${s.envelope_hash}.json`&&integer(o.size_bytes,1500000)&&typeof o.key_id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(o.key_id));
 return{private_executor_only:true,lease_id:v.lease_id,scope:s,credential:{id:k.id,context:{...ctx},metadata:{...m,presented_chain:[...m.presented_chain]},object:{...o}}};
}
export function projectResponse(name,v,args){
 const action=name.replace(/^erp_fiscal_wsdl_/,'');flag(v);
 if(action==='use'){need(fields(v,[...Object.keys(FLAGS),'private_executor_only','grant'])&&v.private_executor_only===true);return freeze({...FLAGS,private_executor_only:true,grant:scope(v.grant,args,true)});}
 need(['begin','finish','fail','command'].includes(action));const extra=action==='begin'?['replayed','execution']:action==='command'?['read_only']:['replayed'];
 need(fields(v,[...Object.keys(FLAGS),'command_id','receipt','current','error_code','artifact',...extra]));
 const r=v.receipt,c=v.current;need(fields(r,RECEIPT)&&id(r.attempt_id)&&id(r.command_id)&&r.profile===FLAGS.profile&&r.environment==='2'&&['55','65'].includes(r.model)&&['protocol','status','authorization','receipt'].includes(r.operation)&&integer(r.a1_version)&&integer(r.identity_version)&&r.confirmed===true&&stamp(r.created_at)&&v.command_id===r.command_id);
 for(const[arg,key]of [['p_command_id','command_id'],['p_attempt_id','attempt_id'],['p_model','model'],['p_operation','operation'],['p_expected_a1_version','a1_version'],['p_expected_identity_version','identity_version']])if(args[arg]!==undefined)need(r[key]===args[arg]);
 need(fields(c,CURRENT)&&['prepared','dispatched','stored','failed','uncertain'].includes(c.state)&&integer(c.a1_version,2147483647,0)&&(c.identity_version===null||integer(c.identity_version))&&['a1_changed','company_changed','certificate_time_valid_now','grant_consumed','lease_expired','recovery_required'].every(k=>typeof c[k]==='boolean')&&stamp(c.expires_at)&&(c.used_at===null||stamp(c.used_at))&&(c.finished_at===null||stamp(c.finished_at))&&c.retry_get_allowed===false);
 need(c.grant_consumed===(c.used_at!==null)&&c.grant_consumed===['dispatched','stored','uncertain'].includes(c.state)&&c.recovery_required===['dispatched','uncertain'].includes(c.state)&&(['prepared','dispatched'].includes(c.state)===(c.finished_at===null))&&Date.parse(c.expires_at)>Date.parse(r.created_at));
 need(c.a1_changed===(c.a1_version!==r.a1_version));if(c.identity_version!==r.identity_version)need(c.company_changed);
 if(c.used_at!==null)need(Date.parse(c.used_at)>=Date.parse(r.created_at)&&Date.parse(c.used_at)<Date.parse(c.expires_at));
 const err=c.state==='prepared'&&c.lease_expired?'WSDL_GRANT_EXPIRED':c.state==='dispatched'&&c.lease_expired?'WSDL_RESULT_UNCONFIRMED':null;
 need(['failed','uncertain'].includes(c.state)?FAILURES.includes(v.error_code):v.error_code===err);
 let a=null;if(c.state==='stored'){need(fields(v.artifact,['wsdl_hash','size_bytes','evidence','created_at'])&&sha(v.artifact.wsdl_hash)&&integer(v.artifact.size_bytes,512000)&&stamp(v.artifact.created_at));a={...v.artifact,evidence:evidence(v.artifact.evidence,{request_id:r.attempt_id,model:r.model,operation:r.operation,wsdl_hash:v.artifact.wsdl_hash,size_bytes:v.artifact.size_bytes})};}else need(v.artifact===null);
 const out={...FLAGS,command_id:v.command_id,receipt:{...r},current:{...c},error_code:v.error_code,artifact:a};
 if(action==='command'){need(v.read_only===true);out.read_only=true;}else{need(typeof v.replayed==='boolean');out.replayed=v.replayed;}
 if(action==='begin')out.execution=execution(v.execution,args,r,c);
 if(action==='finish')need(c.state==='stored'&&a.wsdl_hash===args.p_wsdl_hash&&a.size_bytes===args.p_size_bytes&&same(a.evidence,args.p_evidence));
 if(action==='fail')need(['failed','uncertain'].includes(c.state)&&v.error_code===args.p_error_code);
 return freeze(out);
}
export function publicView(v){return freeze({...FLAGS,command_id:v.command_id,receipt:{...v.receipt},current:{...v.current},error_code:v.error_code,artifact:v.artifact?{sha256:v.artifact.wsdl_hash,size_bytes:v.artifact.size_bytes,inspection_status:v.artifact.evidence.inspection.inspection_status,inspection_code:v.artifact.evidence.inspection.code,created_at:v.artifact.created_at}:null});}
