import type {AccessState,NativeRequestOptions} from './real-access';
import type {FiscalAuthorizationState,FiscalDraftBasisDifference,FiscalDraftStatusRow,FiscalRecordedResult} from '../../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
export {parseFiscalDraftStatusPage} from '../../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
export type {FiscalDraftStatusPage,FiscalDraftStatusRow,FiscalRecordedResult} from '../../../../packages/erp-domain/src/fiscal-draft-status-dto.mjs';
export {captureFiscalDraftStatusRequest,fiscalDraftStatusPath,FISCAL_DRAFT_STATUS_PATH,FISCAL_DRAFT_STATUS_RESPONSE_BYTES} from './fiscal-draft-status-request.ts';

export interface FiscalDraftStatusController {
 getSnapshot():AccessState;
 subscribe(listener:()=>void):()=>void;
 fiscalDraftStatus(path:string,options?:NativeRequestOptions):Promise<unknown>;
}
export function fiscalDraftStatusCanRead(state:AccessState){return state.phase==='ready'&&Boolean(state.membership&&['admin','fiscal'].includes(state.membership.role));}
export const fiscalAuthorizationLabels:Record<FiscalAuthorizationState,string>={
 prepared:'Tentativa preparada; envio não confirmado',request_ready:'Preparação concluída; envio não confirmado',
 dispatched:'Tentativa em andamento; resultado não confirmado',submission_uncertain:'Resultado do envio não confirmado',
 failed_before_dispatch:'Preparação encerrada antes do envio',receipt_pending:'Lote recebido; processamento pendente',
 rejected:'Rejeitada em homologação',review_required:'Resposta guardada; requer conferência',
 authorization_observed:'Autorização observada; verificação local pendente',authorized_homologation:'Autorizada em homologação',
};
export const fiscalBasisDifferenceLabels:Record<FiscalDraftBasisDifference,string>={
 DRAFT_CHANGED:'A preparação do rascunho mudou.',ITEM_PREPARATION_CHANGED:'A preparação dos itens mudou.',
 TAX_PREPARATION_CHANGED:'A preparação dos tributos mudou.',COMPLETION_CHANGED:'O complemento fiscal mudou.',
 COMPANY_CHANGED:'Os dados da empresa mudaram.',SOURCE_CHANGED:'O pedido de origem mudou.',SOURCE_CANCELLED:'O pedido de origem foi cancelado.',
 DRAFT_ARCHIVED:'O rascunho foi arquivado.',NEWER_XML_JOB:'Existe uma geração de XML posterior.',NEWER_SIGNED_CANDIDATE:'Existe uma candidata assinada posterior.',
};
export function fiscalNumberingLabel(row:FiscalDraftStatusRow){
 const n=row.numbering;
 return n.visibility==='available'&&n.reservation?`Série ${n.reservation.series} · nº ${n.reservation.number}`
  :n.visibility==='none'?'Sem número reservado':n.visibility==='inconsistent'?'Vínculo da numeração não conferido':'Numeração não disponível neste acesso';
}
export function fiscalAuthorizationLabel(row:FiscalDraftStatusRow){
 const a=row.authorization;
 if(a.visibility!=='available'||!a.original)return a.visibility==='none'?'Sem tentativa de autorização registrada':a.visibility==='inconsistent'?'Vínculo do resultado não conferido':a.visibility==='unsupported'?'Resultado fora do escopo deste resumo':'Resultado não disponível neste acesso';
 return`${a.original.origin==='synthetic'?'Resultado sintético: ':''}${fiscalAuthorizationLabels[a.original.state]}`;
}
/** Summarizes a proven historical result, never the current SEFAZ situation. */
export function fiscalAuthorizationPresentation(row:FiscalDraftStatusRow){
 const a=row.authorization,original=a.visibility==='available'?a.original:null;
 if(!original)return{label:fiscalAuthorizationLabel(row),source:null,result:null};
 const later=a.revalidation.visibility==='available'?a.revalidation.result:null;
 if(later&&['authorized_homologation','rejected'].includes(later.state))return{label:fiscalAuthorizationLabels[later.state],source:'conferência posterior',result:later};
 return{label:fiscalAuthorizationLabel(row),source:original.result?'resposta original':'tentativa original',result:original.result};
}
export function fiscalResultCodes(result:FiscalRecordedResult){
 if(result.rejection_code)return `Falha local de validação: ${result.rejection_code}`;
 if(result.protocol_cstat)return `SEFAZ ${result.protocol_cstat}${result.cstat?` · lote ${result.cstat}`:''}`;
 return result.cstat?`SEFAZ ${result.cstat}`:'Código de resposta não disponível';
}
export function fiscalStatusMoment(value:string){return new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});}
export function fiscalStatusMoney(value:string){
 if(!/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/.test(value))throw new Error('FISCAL_DRAFT_STATUS_AMOUNT_INVALID');
 const [integer,decimal='']=value.split('.');return`R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${decimal.padEnd(2,'0')}`;
}
