import {dispatchRoute,captureDispatchInput,dispatchBinding,isDispatchMutation,type DispatchRoute,type DispatchPayload} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-protocol.mjs';
import {projectDispatchPublic,type DispatchBinding,type DispatchResult,type DispatchHistory,type DispatchStatus,type DispatchRunInput,type PreflightResult,type ClosureResult} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
import {SELECTED_RUN_PROFILE} from '../../../../packages/fiscal-authorization/src/selected-run-dto.mjs';
import {revalidationRoute,revalidationBinding,isRevalidationMutation,type RevalidationRoute,type RevalidationPayload} from '../../../../packages/fiscal-authorization-runtime/src/revalidation-protocol.mjs';
import {captureRevalidationInput,projectRevalidationPublic,type RevalidationBinding,type RevalidationContext,type RevalidationResult} from '../../../../packages/fiscal-authorization/src/revalidation-public-dto.mjs';
import {bindAuthorizationResult} from './fiscal-authorization-model.ts';
import {signedShape,type SignedCandidate} from './fiscal-signed-model.ts';
import type {NativeRequestOptions} from './real-access.ts';
import {evaluateNfceEmissionWindow} from '../../../../packages/fiscal-authorization/src/emission-window.mjs';
export type {DispatchResult,DispatchHistory,DispatchStatus,DispatchRunInput,PreflightResult};
export const REVIEWED_AUTHORIZATION_BASE='/v1/fiscal-authorization/reviewed';
export type ReviewedAuthorizationRequest=Readonly<{body?:string;signal?:AbortSignal;mutation:boolean}&({revalidation:false;route:DispatchRoute;payload:DispatchPayload;binding:DispatchBinding}|{revalidation:true;route:RevalidationRoute;payload:RevalidationPayload;binding:RevalidationBinding})>;
function invalid():never{throw new Error('AUTHORIZATION_RESPONSE_INVALID');}
/** Capture all own data before token refresh/import. Only the versioned family is accepted. */
export function captureReviewedAuthorizationRequest(path:string,options:NativeRequestOptions={}):ReviewedAuthorizationRequest{
 if(!signedShape(options,[],['method','body','signal'])||typeof path!=='string'||/[?#%\\]/.test(path)||options.signal!==undefined&&!(options.signal instanceof AbortSignal))invalid();
 const historical=revalidationRoute(path,options.method??'GET','/v1/fiscal-authorization');
 if(historical){
  if(historical.method==='GET'&&Object.hasOwn(options,'body'))invalid();
  const payload=historical.method==='POST'?captureRevalidationInput(options.body):Object.freeze({});
  return Object.freeze({revalidation:true,route:historical,payload,binding:revalidationBinding(historical,payload),...(historical.method==='POST'?{body:JSON.stringify(payload)}:{}),signal:options.signal,mutation:isRevalidationMutation(historical.action)});
 }
 const route=dispatchRoute(path,options.method??'GET','/v1/fiscal-authorization');if(!route)invalid();
 if(route.method==='GET'&&Object.hasOwn(options,'body'))invalid();
 const payload=captureDispatchInput(route.action,route.method==='GET'?{}:options.body),binding=dispatchBinding(route,payload);
 return Object.freeze({revalidation:false,route,payload,binding,...(route.method==='POST'?{body:JSON.stringify(payload)}:{}),signal:options.signal,mutation:isDispatchMutation(route.action)});
}
export function reviewedAuthorizationResponse(raw:unknown,request:ReviewedAuthorizationRequest):DispatchResult|DispatchHistory|DispatchStatus|PreflightResult|ClosureResult|RevalidationContext|RevalidationResult{
 if(request.revalidation)return projectRevalidationPublic(raw,request.binding);
 const b=request.binding;
 if(b.action==='status')return projectDispatchPublic(raw,b);
 if(b.action==='history')return projectDispatchPublic(raw,b);
 if(b.action==='preflight')return projectDispatchPublic(raw,b);
 if(b.action==='closeExpired'||b.action==='closureCommand')return projectDispatchPublic(raw,b);
 if(b.action==='closureLookup')return projectDispatchPublic(raw,b);
 if(b.action==='run'||b.action==='recover'||b.action==='command')return projectDispatchPublic(raw,b);
 return invalid();
}
/** Receipt, original review and immutable artifacts cannot be replaced by a later current-state read. */
export function bindReviewedAuthorizationResult(value:DispatchResult,candidate:SignedCandidate,previous:DispatchResult|null=null,selection:DispatchRunInput|null=null):DispatchResult{
 if(selection)value=projectDispatchPublic(value,{action:value.read_only?'command':'run',commandId:selection.command_id,input:selection});
 bindAuthorizationResult(value,candidate,previous);
 for(const key of ['subset_review','observation'] as const){const old=previous?.[key],next=value[key];if(old&&(!next||Object.entries(old).some(([k,v])=>next[k as keyof typeof next]!==v)))invalid();}
 return value;
}
export function bindReviewedPreflight(value:PreflightResult,candidate:SignedCandidate):PreflightResult{
 if(value.candidate.candidate_id!==candidate.candidate_id||value.candidate.candidate_version!==candidate.candidate_version||value.candidate.signed_hash!==candidate.artifact?.sha256||value.candidate.model!==candidate.model)invalid();
 return value;
}
/** No inferred versions or proof: copy only the closed backend selection after explicit confirmation. */
export function reviewedPreflightWindow(value:PreflightResult,now=Date.now()){
 if(value.candidate.model==='55')return null;
 if(!value.emission_window)invalid();
 return evaluateNfceEmissionWindow({model:'65',environment:'2',emissionType:'1',issuedAt:value.emission_window.issued_at,now,safetyMarginMs:30000});
}
export function reviewedAuthorizationRun(value:PreflightResult,candidate:SignedCandidate,confirmed:boolean,commandId:string,now=Date.now()):DispatchRunInput{
 bindReviewedPreflight(value,candidate);const window=reviewedPreflightWindow(value,now);if(!confirmed||!value.can_run||!value.selection||window&&window.status!=='valid')invalid();
 return captureDispatchInput('dispatchRun',{request_profile:SELECTED_RUN_PROFILE,command_id:commandId,...value.selection,confirmed:true}) as DispatchRunInput;
}
export const REVIEWED_PREFLIGHT_BLOCKERS:Record<string,string>={
 CANDIDATE_NOT_CURRENT:'A assinatura não corresponde mais à nota atual. Confira a preparação e gere a assinatura atual.',
 IDENTITY_MISMATCH:'Os dados da empresa mudaram. Confira a nota e a assinatura antes de continuar.',
 A1_UNAVAILABLE:'Confira a configuração e a validade do certificado da empresa.',
 REVIEWED_POLICY_MISMATCH:'Esta operação ainda não possui um perfil de autorização compatível.',
 POLICY_DISABLED:'O perfil de autorização está desativado. O envio permanece indisponível.',
 POLICY_TIME_INVALID:'A vigência do perfil de autorização precisa ser atualizada.',
 PROFILE_TIME_INVALID:'As regras de conferência do FAGOO precisam de nova revisão de vigência.',
 REVIEW_MISSING_OR_MISMATCHED:'Abra a revisão fiscal desta assinatura, confira as escolhas e salve a revisão atual.',
 REVIEWER_INACTIVE:'A revisão precisa ser refeita por um usuário com acesso fiscal ativo.',
 REVIEW_TIME_INVALID:'A validade da revisão fiscal terminou ou ainda não começou. Atualize a revisão.',
 SUBMISSION_ALREADY_CONSUMED:'Já existe envio registrado para esta nota. Consulte o histórico; não repita o envio.',
 ATTEMPT_ALREADY_EXISTS:'Há uma tentativa pendente. Consulte o histórico; a consulta não autoriza um novo envio.',
 RULE_EVALUATION_PENDING:'Resolva as divergências ou conferências pendentes apresentadas na revisão fiscal.',
 RUNTIME_DISABLED:'O envio está desativado neste ambiente. A conferência não habilita emissão.',
 AUTHORIZATION_NFCE_EMISSION_EXPIRED:'A data de emissão deste XML de NFC-e passou do prazo de 5 minutos. Este arquivo não pode ser enviado. Preserve a preparação e confira um novo documento.',
 AUTHORIZATION_NFCE_EMISSION_FUTURE:'A data de emissão deste XML de NFC-e está mais de 5 minutos à frente. Confira a data e o horário da preparação antes de continuar.',
 AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT:'O prazo deste XML de NFC-e está terminando. O FAGOO interrompe novas tentativas 30 segundos antes do limite para reservar tempo ao envio. Este arquivo não pode iniciar o envio.',
};
export const REVIEWED_AUTHORIZATION_LABELS:Record<string,string>={prepared:'Intenção registrada, ainda não enviada',request_ready:'Pedido preparado, ainda não enviado',dispatched:'Envio registrado; resultado pendente',submission_uncertain:'Resultado do envio ainda incerto',failed_before_dispatch:'Encerrada antes do envio',receipt_pending:'Recibo recebido; processamento pendente',rejected:'Resposta de rejeição registrada',review_required:'Resposta requer conferência',authorized_homologation:'Autorização de homologação registrada',unconfirmed:'Resultado não confirmado'};
