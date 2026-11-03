/** Closed contract of leva H (migration 202610210310): Preferências › Segurança, the MFA policy of the company and the reset of
 * another user's second factor. The Worker answers under /v1/seguranca; the factor ids returned by the database stay in the
 * Worker (it removes them through the Auth admin API) and never reach the browser. */
import{ACCESS_ROLES}from'./access-users.mjs';
export const SECURITY_BASE='/v1/seguranca';
export const SECURITY_BODY_BYTES=2048;
export const SECURITY_RESPONSE_BYTES=131072;
export class AccessSecurityContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new AccessSecurityContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};
export const securityUuid=v=>typeof v==='string'&&UUID.test(v);

function policy(v){
 exact(v,['mfa_required','version','updated_at','members']);
 need(typeof v.mfa_required==='boolean'&&int(v.version)&&(v.updated_at===null)===(v.version===0)&&(v.updated_at===null||stamp(v.updated_at))&&Array.isArray(v.members)&&v.members.length<=500);
 const ids=new Set();
 for(const m of v.members){exact(m,['user_id','name','role','factor']);
  need(securityUuid(m.user_id)&&!ids.has(m.user_id)&&typeof m.name==='string'&&m.name.length>=1&&m.name.length<=254&&ACCESS_ROLES.includes(m.role)&&typeof m.factor==='boolean');ids.add(m.user_id);}
 return v;
}
export function parseSecurityPolicy(raw){
 const v=snapshot(raw);exact(v,['scope','data_mode','policy','self']);
 need(v.scope==='access_security_policy'&&v.data_mode==='erp_native');policy(v.policy);
 exact(v.self,['factor','aal2']);need(typeof v.self.factor==='boolean'&&typeof v.self.aal2==='boolean');
 return v;
}
export function captureSecurityPolicySave(raw){
 exact(raw,['command_id','expected_version','mfa_required'],400,'ERP_INVALID_INPUT');
 need(securityUuid(raw.command_id)&&int(raw.expected_version)&&typeof raw.mfa_required==='boolean',400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:raw.command_id,expected_version:raw.expected_version,mfa_required:raw.mfa_required});
}
/** The database answer, with the Auth gate flag of every member (the Worker writes them before answering). */
export function parseSecurityPolicyResult(raw,input){
 const sent=captureSecurityPolicySave(input),v=snapshot(raw);exact(v,['scope','data_mode','receipt','policy','replayed','gates']);
 need(v.scope==='access_security_command'&&v.data_mode==='erp_native'&&typeof v.replayed==='boolean');
 exact(v.receipt,['command_id','from_version','to_version','changed_at']);
 need(v.receipt.command_id===sent.command_id&&v.receipt.from_version===sent.expected_version&&v.receipt.to_version===sent.expected_version+1&&stamp(v.receipt.changed_at));
 policy(v.policy);need(v.replayed||v.policy.mfa_required===sent.mfa_required&&v.policy.version===v.receipt.to_version);
 need(Array.isArray(v.gates)&&v.gates.length<=1000);const ids=new Set();
 for(const g of v.gates){exact(g,['user_id','gate_required']);need(securityUuid(g.user_id)&&!ids.has(g.user_id)&&typeof g.gate_required==='boolean');ids.add(g.user_id);}
 return v;
}
/** What the browser receives for a policy command (no gate list). */
export function parseSecurityPolicyAnswer(raw,input){
 const sent=captureSecurityPolicySave(input),v=snapshot(raw);exact(v,['scope','data_mode','receipt','policy','replayed']);
 return parseSecurityPolicyResult({...v,gates:[]},sent);
}
export function captureMfaReset(raw){
 exact(raw,['command_id'],400,'ERP_INVALID_INPUT');need(securityUuid(raw.command_id),400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:raw.command_id});
}
export function parseMfaReset(raw,{commandId,target}){
 const v=snapshot(raw);exact(v,['scope','data_mode','command_id','target','factors','changed_at','replayed']);
 need(v.scope==='access_mfa_reset'&&v.data_mode==='erp_native'&&v.command_id===commandId&&v.target===target&&stamp(v.changed_at)&&typeof v.replayed==='boolean');
 need(Array.isArray(v.factors)&&v.factors.length<=20&&v.factors.every(securityUuid)&&new Set(v.factors).size===v.factors.length);
 return v;
}
/** What the browser receives for a reset: the receipt and how many factors were removed (never their ids). */
export function parseMfaResetAnswer(raw,{commandId,target}){
 const v=snapshot(raw);exact(v,['scope','data_mode','command_id','target','removed','changed_at','replayed']);
 need(v.scope==='access_mfa_reset'&&v.data_mode==='erp_native'&&v.command_id===commandId&&v.target===target&&int(v.removed,0,20)&&stamp(v.changed_at)&&typeof v.replayed==='boolean');
 return v;
}
