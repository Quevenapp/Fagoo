/** Leva H, lane acesso (migration 202610210310), under /v1/seguranca:
 * - GET politica: the MFA policy of the company, who is in its scope and whether the caller has a factor and an aal2 session;
 * - POST politica: turn the policy on or off (administrador in an aal2 session, checked by the database through the session id);
 *   the Worker then writes the Auth gate flag of every member, so each request of theirs is checked by erp_access_gate_v2;
 * - POST usuarios/:id/redefinir-mfa: remove the second factor of another user who lost the device (same rules).
 * A database answer whose Auth follow-up was lost is "unconfirmed": the same command, sent again, replays the receipt and
 * repeats the follow-up. Factor ids never leave the Worker. */
import{SECURITY_BASE,SECURITY_BODY_BYTES,parseSecurityPolicy,captureSecurityPolicySave,parseSecurityPolicyResult,captureMfaReset,parseMfaReset,
 securityUuid,AccessSecurityContractError}from'../../../packages/erp-domain/src/access-security.mjs';
export class SecurityError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const need=(v,status,code)=>{if(!v)throw new SecurityError(status,code);};
const RESET=/^usuarios\/([a-f0-9-]{36})\/redefinir-mfa$/;
export const securityRoute=path=>path===SECURITY_BASE||path.startsWith(`${SECURITY_BASE}/`);
export function securityMethods(path){
 const rest=path.slice(SECURITY_BASE.length+1);
 return rest==='politica'?['GET','POST']:RESET.test(rest)?['POST']:['GET'];
}
async function body(request){
 const type=request.headers.get('content-type')||'';need(/^application\/json(?:;\s*charset=utf-8)?$/i.test(type),415,'ERP_UNSUPPORTED_MEDIA_TYPE');
 const text=await request.text();need(new TextEncoder().encode(text).byteLength<=SECURITY_BODY_BYTES,413,'ERP_PAYLOAD_TOO_LARGE');
 try{return JSON.parse(text);}catch{throw new SecurityError(400,'ERP_INVALID_INPUT');}
}
const contract=fn=>{try{return fn();}catch(e){if(e instanceof AccessSecurityContractError)throw new SecurityError(e.status,e.code);throw e;}};
export async function parseSecurityRoute(request){
 const url=new URL(request.url);need(!url.search,400,'ERP_INVALID_QUERY');
 const rest=url.pathname.slice(SECURITY_BASE.length+1);
 if(rest==='politica'){
  if(request.method==='GET'){need(request.body===null,400,'ERP_INVALID_INPUT');return{action:'policy'};}
  const sent=await body(request);return{action:'policy-save',input:contract(()=>captureSecurityPolicySave(sent))};
 }
 const reset=RESET.exec(rest);
 if(reset){need(securityUuid(reset[1]),404,'ERP_NOT_FOUND');const sent=await body(request);return{action:'mfa-reset',target:reset[1],input:contract(()=>captureMfaReset(sent))};}
 throw new SecurityError(404,'ERP_NOT_FOUND');
}
export async function executeSecurityRoute(route,{userId,sessionId,rpc,authAdmin,deleteFactor}){
 const map=e=>{if(e instanceof AccessSecurityContractError)throw new SecurityError(502,'ERP_UPSTREAM_INVALID_RESPONSE');throw e;};
 if(route.action==='policy'){
  const raw=await rpc('erp_access_security_policy_get',{p_user_id:userId,p_session_id:sessionId});
  try{return parseSecurityPolicy(raw);}catch(e){return map(e);}
 }
 if(route.action==='policy-save'){
  const raw=await rpc('erp_access_security_policy_save',{p_user_id:userId,p_session_id:sessionId,p_command_id:route.input.command_id,p_expected_version:route.input.expected_version,p_mfa_required:route.input.mfa_required});
  let value;try{value=parseSecurityPolicyResult(raw,route.input);}catch(e){return map(e);}
  for(const gate of value.gates){try{await authAdmin(gate.user_id,{brufap_access_gate:gate.gate_required});}catch{throw new SecurityError(503,'ERP_RESULT_UNCONFIRMED');}}
  const{gates,...answer}=value;return answer;
 }
 const raw=await rpc('erp_access_mfa_reset',{p_user_id:userId,p_session_id:sessionId,p_command_id:route.input.command_id,p_target:route.target});
 let value;try{value=parseMfaReset(raw,{commandId:route.input.command_id,target:route.target});}catch(e){return map(e);}
 for(const factor of value.factors){try{await deleteFactor(route.target,factor);}catch{throw new SecurityError(503,'ERP_RESULT_UNCONFIRMED');}}
 const{factors,...answer}=value;return{...answer,removed:factors.length};
}
