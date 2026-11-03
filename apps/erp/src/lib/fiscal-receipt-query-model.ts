import {captureReceiptQueryContextInput,captureReceiptQueryHistoryInput,captureReceiptQueryRunInput,projectReceiptQueryPublic,type ReceiptQueryPublicContext,type ReceiptQueryPublicResult,type ReceiptQueryPublicHistory,type ReceiptQueryPublicSource,type ReceiptQueryRunInput,type ReceiptQueryHistoryInput,type ReceiptQueryPublicBlocker,type ReceiptQueryPublicState} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import {projectRevalidationPublic,type RevalidationResult} from '../../../../packages/fiscal-authorization/src/revalidation-public-dto.mjs';
import {bindReviewedAuthorizationResult,type DispatchResult} from './fiscal-reviewed-authorization-model.ts';
import type {SignedCandidate} from './fiscal-signed-model';
export type {ReceiptQueryPublicContext,ReceiptQueryPublicResult,ReceiptQueryPublicHistory,ReceiptQueryRunInput,ReceiptQueryHistoryInput};
export type ReceiptQueryReference=Readonly<Omit<ReceiptQueryPublicSource,'source_binding_hash'>>;
export const RECEIPT_QUERY_BASE='/v1/fiscal-authorization/reviewed';
const invalid=():never=>{throw new Error('RECEIPT_QUERY_RESPONSE_INVALID');};
function frozen<T>(x:T):T{if(x!==null&&typeof x==='object'){Object.values(x).forEach(frozen);Object.freeze(x);}return x;}
const same=(a:unknown,b:unknown):boolean=>{
 if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
};
/** Only offers a context read. Current original-actor access and verified103 are checked by the server. */
export function receiptQueryAuthorizationReference(value:DispatchResult,candidate:SignedCandidate):ReceiptQueryReference|null{
 const row=bindReviewedAuthorizationResult(value,candidate),r=row.receipt,a=row.artifact;
 if(!r||!a||r.origin!=='operational'||row.status!=='receipt_pending'||a.outcome!=='receipt_pending'||a.cstat!=='103')return null;
 return frozen({source_kind:'authorization',source_command_id:row.command_id,authorization_command_id:r.command_id,authorization_attempt_id:r.attempt_id,candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash,signed_size:r.signed_size,model:r.model,environment:'2',origin:'operational',original:{state:'receipt_pending',outcome:'receipt_pending',rejection_code:null,cstat:'103',protocol_cstat:null,response_hash:a.response_hash,response_size:a.response_size,recorded_at:a.created_at},revalidation:null});
}
export function receiptQueryRevalidationReference(value:RevalidationResult,candidate:SignedCandidate,original:DispatchResult):ReceiptQueryReference|null{
 const old=bindReviewedAuthorizationResult(original,candidate),r=old.receipt,a=old.artifact;
 const v=projectRevalidationPublic(value,{action:'revalidationCommand',commandId:value.command_id});if(v.kind!=='result')return null;
 if(!r||!a||r.origin!=='operational'||old.status!=='review_required'||a.outcome!=='invalid_response'||a.rejection_code!=='SOAP_INVALID'||v.receipt.state!=='receipt_pending'||v.receipt.artifact.cstat!=='103')return null;
 const q=v.receipt;if(q.authorization_command_id!==old.command_id||q.attempt_id!==r.attempt_id||q.candidate_id!==r.candidate_id||q.candidate_version!==r.candidate_version||q.signed_hash!==r.signed_hash||q.model!==r.model||q.artifact.response_hash!==a.response_hash||q.artifact.response_size!==a.response_size)invalid();
 return frozen({source_kind:'revalidation',source_command_id:v.command_id,authorization_command_id:r.command_id,authorization_attempt_id:r.attempt_id,candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash,signed_size:r.signed_size,model:r.model,environment:'2',origin:'operational',original:{state:'review_required',outcome:'invalid_response',rejection_code:'SOAP_INVALID',cstat:null,protocol_cstat:null,response_hash:a.response_hash,response_size:a.response_size,recorded_at:a.created_at},revalidation:{command_id:v.command_id,state:'receipt_pending',cstat:'103',protocol_cstat:null,recorded_at:q.created_at}});
}
/** Includes immutable response provenance; an old handler cannot cross a changed source/candidate. */
export const receiptQueryReferenceKey=(r:ReceiptQueryReference)=>[r.source_kind,r.source_command_id,r.authorization_command_id,r.authorization_attempt_id,r.candidate_id,r.candidate_version,r.signed_hash,r.signed_size,r.model,r.original.state,r.original.response_hash,r.original.response_size,r.original.recorded_at,r.revalidation?.recorded_at].join(':');
export const receiptQueryContextInput=(r:ReceiptQueryReference)=>captureReceiptQueryContextInput({source_kind:r.source_kind,source_command_id:r.source_command_id,expected_attempt_id:r.authorization_attempt_id});
export const receiptQueryHistoryInput=(r:ReceiptQueryReference,before:number|null=null)=>captureReceiptQueryHistoryInput({authorization_command_id:r.authorization_command_id,expected_attempt_id:r.authorization_attempt_id,limit:25,before});
export const receiptQueryCommandPath=(id:string)=>`${RECEIPT_QUERY_BASE}/receipt-query-commands/${id}`;
function bindSource(source:ReceiptQueryPublicSource,ref:ReceiptQueryReference,exact:boolean){
 if(!['authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin'].every(k=>source[k as keyof ReceiptQueryPublicSource]===ref[k as keyof ReceiptQueryReference]))invalid();
 if(exact&&(source.source_kind!==ref.source_kind||source.source_command_id!==ref.source_command_id||!same({...source.original,recorded_at:new Date(source.original.recorded_at).toISOString()},{...ref.original,recorded_at:new Date(ref.original.recorded_at).toISOString()})||!same(source.revalidation?{...source.revalidation,recorded_at:new Date(source.revalidation.recorded_at).toISOString()}:null,ref.revalidation?{...ref.revalidation,recorded_at:new Date(ref.revalidation.recorded_at).toISOString()}:null)))invalid();
}
export function receiptQueryContext(raw:unknown,ref:ReceiptQueryReference):ReceiptQueryPublicContext{
 const value=projectReceiptQueryPublic(raw,{action:'receiptQueryContext',input:receiptQueryContextInput(ref)});bindSource(value.source,ref,true);return value;
}
export function receiptQueryHistory(raw:unknown,ref:ReceiptQueryReference,input:ReceiptQueryHistoryInput):ReceiptQueryPublicHistory{
 const value=projectReceiptQueryPublic(raw,{action:'receiptQueryHistory',input});if(input.authorization_command_id!==ref.authorization_command_id||input.expected_attempt_id!==ref.authorization_attempt_id)invalid();for(const r of value.items)bindSource(r.source,ref,false);return value;
}
export function receiptQueryIntent(context:ReceiptQueryPublicContext,ref:ReceiptQueryReference,commandId:string,confirmed:boolean):ReceiptQueryRunInput{
 const checked=receiptQueryContext(context,ref);if(!confirmed||!checked.can_query||!checked.selection)invalid();return captureReceiptQueryRunInput({...checked.selection,command_id:commandId,confirmed:true});
}
export function receiptQueryResult(raw:unknown,ref:ReceiptQueryReference,commandId:string,{input=null,previous=null,mode='read'}:{input?:ReceiptQueryRunInput|null;previous?:ReceiptQueryPublicResult|null;mode?:'read'|'run'|'recover'}={}):ReceiptQueryPublicResult{
 if(mode==='run'&&!input)invalid();const value=projectReceiptQueryPublic(raw,mode==='run'?{action:'receiptQueryRun',commandId,input:input!}:mode==='recover'?{action:'receiptQueryRecover',commandId,input:{confirmed:true}}:{action:'receiptQueryCommand',commandId});bindSource(value.source,ref,Boolean(input));
 if(input){const r=value.receipt;if(r.authorization_command_id!==input.expected_authorization_command_id||r.authorization_attempt_id!==input.expected_attempt_id||r.candidate_id!==input.expected_candidate_id||r.candidate_version!==input.expected_candidate_version||r.signed_hash!==input.expected_signed_hash||r.source_kind!==input.source_kind||r.source_command_id!==input.source_command_id||r.source_binding_hash!==input.expected_source_binding_hash||r.identity_version!==input.expected_identity_version||r.a1_version!==input.expected_a1_version||r.query_policy_version!==input.expected_query_policy_version)invalid();}
 // current/resolution may evolve; the receipt, source and an already stored observation cannot.
 if(previous&&(!same(previous.receipt,value.receipt)||!same(previous.source,value.source)||previous.observation!==null&&!same(previous.observation,value.observation)))invalid();return value;
}
export const receiptQueryStateLabel:Record<ReceiptQueryPublicState,string>={prepared:'Consulta preparada',request_ready:'Consulta pronta',dispatched:'Resultado ainda não confirmado',uncertain:'Resultado ainda não confirmado',failed_before_dispatch:'Consulta não enviada',receipt_pending:'Processamento pendente',rejected:'Rejeição registrada',review_required:'Resposta requer conferência',authorized_homologation:'Autorizada em homologação'};
export const receiptQueryBlockerLabel:Record<ReceiptQueryPublicBlocker,string>={SOURCE_VALIDATION_REQUIRED:'A resposta que contém o recibo ainda precisa ser conferida.',POLICY_DISABLED:'A consulta de processamento não está habilitada para este modelo.',POLICY_TIME_INVALID:'A janela habilitada para consultar o processamento terminou ou ainda não começou.',POLICY_PROFILE_INVALID:'A configuração da consulta precisa ser conferida.',IDENTITY_MISMATCH:'O emitente configurado precisa ser conferido.',A1_UNAVAILABLE:'O certificado necessário à consulta não está disponível.',A1_INVALID:'O certificado necessário à consulta precisa ser conferido.',A1_STORAGE_INVALID:'Não foi possível confirmar o certificado guardado.',RESOLUTION_CLOSED:'Esta cadeia já tem uma resolução registrada; confira o resultado abaixo.',QUERY_ACTIVE:'Há uma consulta em andamento. Consulte o comando já registrado.',CADENCE_REQUIRED:'Aguarde o horário indicado e atualize as condições antes de confirmar outra consulta.',RATE_LIMIT:'O limite de consultas deste período foi atingido.',RUNTIME_DISABLED:'A consulta de processamento está desabilitada neste ambiente.'};
