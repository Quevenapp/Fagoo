import {publicResult,type AuthorizationPreview,type AuthorizationResult,type AuthorizationHistory} from '../../../../packages/fiscal-authorization-http/src/dto.mjs';
import {signedId,signedShape,type SignedCandidate} from './fiscal-signed-model.ts';
import type {NativeRequestOptions} from './real-access.ts';
export type {AuthorizationPreview,AuthorizationResult,AuthorizationHistory};
export const AUTHORIZATION_BASE='/v1/fiscal-authorization';
export type AuthorizationSelected={action:'preview';method:'POST';payload:Readonly<{candidate_id:string;signed_hash:string}>;signal?:AbortSignal}|{action:'history';method:'POST';id:string;payload:Readonly<{limit:number;before:string|null}>;signal?:AbortSignal}|{action:'command';method:'GET';id:string;signal?:AbortSignal};
function fail():never{throw new Error('AUTHORIZATION_RESPONSE_INVALID');}
/** This UI port deliberately has no run or recover route. Capture before any await. */
export function captureAuthorizationRequest(path:string,options:NativeRequestOptions={}):AuthorizationSelected{
 if(!signedShape(options,[],['method','body','signal'])||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||typeof path!=='string'||/[?#%\\]/.test(path))fail();
 const method=options.method??'GET',signal=options.signal,body=options.body;
 if(path===AUTHORIZATION_BASE+'/preview'){
  if(method!=='POST'||!signedShape(body,['candidate_id','signed_hash'])||!signedId(body.candidate_id)||typeof body.signed_hash!=='string'||!/^[a-f0-9]{64}$/.test(body.signed_hash))fail();
  return Object.freeze({action:'preview',method,payload:Object.freeze({candidate_id:body.candidate_id,signed_hash:body.signed_hash}),signal});
 }
 const command=new RegExp(`^${AUTHORIZATION_BASE}/commands/([a-f0-9-]+)$`).exec(path);
 if(command){if(!signedId(command[1])||method!=='GET'||Object.hasOwn(options,'body'))fail();return Object.freeze({action:'command',method,id:command[1],signal});}
 const history=new RegExp(`^${AUTHORIZATION_BASE}/candidates/([a-f0-9-]+)/history$`).exec(path);
 if(!history||!signedId(history[1])||method!=='POST'||!signedShape(body,['limit','before'])||typeof body.limit!=='number'||!Number.isInteger(body.limit)||body.limit<1||body.limit>25||body.before!==null&&(typeof body.before!=='string'||!/^[1-9][0-9]{0,14}$/.test(body.before)))fail();
 return Object.freeze({action:'history',method,id:history[1],payload:Object.freeze({limit:body.limit,before:body.before as string|null}),signal});
}
export function authorizationResponse(raw:unknown,selected:AuthorizationSelected):AuthorizationPreview|AuthorizationResult|AuthorizationHistory{
 if(selected.action==='preview')return publicResult(raw,{action:'preview',candidateId:selected.payload.candidate_id,signedHash:selected.payload.signed_hash});
 if(selected.action==='history')return publicResult(raw,{action:'history',candidateId:selected.id,limit:selected.payload.limit,before:selected.payload.before});
 return publicResult(raw,{action:'command',commandId:selected.id});
}
/** Historical signature/A1 bindings stay exact. Current certificate changes do not prevent a historical read. */
export function bindAuthorizationResult(value:AuthorizationResult,c:SignedCandidate,previous:AuthorizationResult|null=null):AuthorizationResult{
 const r=value.receipt;if(!r||r.candidate_id!==c.candidate_id||r.candidate_version!==c.candidate_version||r.signed_hash!==c.artifact?.sha256||r.signed_size!==c.artifact?.size_bytes||r.model!==c.model||r.unsigned_job_id!==c.unsigned_job_id||r.basis_hash!==c.basis_hash||r.completion_version!==c.completion_version||r.completion_hash!==c.completion_hash||r.signing_a1_version!==c.a1_version)fail();
 if(previous){if(value.command_id!==previous.command_id||previous.receipt&&Object.entries(previous.receipt).some(([k,v])=>r[k as keyof typeof r]!==v))fail();if(previous.artifact&&(!value.artifact||Object.entries(previous.artifact).some(([k,v])=>value.artifact![k as keyof typeof value.artifact]!==v)))fail();}
 return value;
}
export const AUTHORIZATION_LABELS:Record<string,string>={prepared:'Intenção registrada, ainda não enviada',request_ready:'Pedido preparado, ainda não enviado',dispatched:'Envio registrado; resultado pendente',submission_uncertain:'Resultado do envio ainda incerto',failed_before_dispatch:'Encerrada antes do envio',receipt_pending:'Recibo recebido; processamento pendente',rejected:'Resposta de rejeição registrada',review_required:'Resposta requer conferência',authorization_observed:'Autorização declarada em resposta sintética',authorized_homologation:'Autorização de homologação registrada',unconfirmed:'Resultado não confirmado'};
export const AUTHORIZATION_BLOCKERS:Record<string,string>={POLICY_DISABLED:'O perfil de autorização ainda está desativado.',BINDING_NOT_REVIEWED:'A comunicação de autorização ainda não foi revisada.',RULE_PROFILE_NOT_REVIEWED:'O perfil de regras fiscais ainda não foi revisado.',POLICY_TIME_INVALID:'A vigência do perfil precisa ser revisada.',CANDIDATE_NOT_CURRENT:'Esta assinatura não corresponde às bases atuais.',SUBMISSION_ALREADY_CONSUMED:'Já existe um envio registrado para esta intenção; não deve ser repetido.'};
