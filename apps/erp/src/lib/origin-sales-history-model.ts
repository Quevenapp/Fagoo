import {parseSalesHistoryDetail,type HistorySummary,type HistoryObserved,type HistoryBinding,type HistoryCapture,type HistoryCurrent} from '../../../../packages/erp-domain/src/origin-sales-history-dto.mjs';
export {parseSalesHistoryPage,parseSalesHistoryDetail} from '../../../../packages/erp-domain/src/origin-sales-history-dto.mjs';
export type {SalesHistoryId,SalesHistoryPage,SalesHistoryDetail,HistorySummary,HistoryObserved,HistoryBinding} from '../../../../packages/erp-domain/src/origin-sales-history-dto.mjs';
export {captureSalesHistoryRequest,salesHistoryListPath,salesHistoryDetailPath,SALES_HISTORY_RESPONSE_BYTES} from './origin-sales-history-request.ts';

/** Observed numbers remain strings; no rounding, conversion, or reconciliation. */
export function historyObserved(value:HistoryObserved,format:'text'|'decimal'|'money'='text'){
 if(value.state==='absent')return 'Não informado na origem';
 if(value.state==='null')return 'Sem valor declarado';
 if(value.state==='invalid')return value.value===null?'Formato não conferido':`Formato não conferido: ${value.value}`;
 const text=value.value!;
 if(format==='text')return text||'Campo vazio na origem';
 if(value.kind!=='number'||text.length>256||! /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)||/[\r\n]/.test(text))throw new Error('SALES_HISTORY_VALUE_INVALID');
 const [integer,fraction]=text.split('.');return(format==='money'?'R$ ':'')+integer.replace(/\B(?=(\d{3})+(?!\d))/g,'.')+(format==='money'?','+(fraction??'').padEnd(2,'0'):fraction===undefined?'':','+fraction);
}
export const historyCaptureLabels:Record<HistoryCapture['state'],string>={bound:'Texto numérico dos preços unitários preservado e conferido',absent:'Captura exata de preços ausente neste registro',invalid:'Captura exata de preços não vinculada a este registro'};
export const historyBindingLabels:Record<HistoryBinding['state'],string>={current:'Correspondência atual conferida',invalid_id:'Identificador de origem ausente ou inválido',missing_staging:'Cadastro da origem não disponível',missing_native:'Sem cadastro correspondente no FAGOO',needs_review:'Correspondência atual precisa de revisão'};
export const historyCurrentSourceLabels:Record<HistoryCurrent['source']['state'],string>={same:'Conteúdo e versão da origem iguais aos da captura',changed:'Conteúdo ou versão da origem mudaram após a captura',missing:'Origem não disponível na coleta atual'};
export function historyMoment(value:string|null){return value===null?'Não informada':new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});}
/** The row comes from the closed page parser; its immutable capture must match the detail. */
export function historyDetailForRow(raw:unknown,row:HistorySummary){
 const value=parseSalesHistoryDetail(raw,{historyId:row.history_id});
 const ordered=(v:unknown):unknown=>v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,ordered(v)])):v;
 if(JSON.stringify(ordered(value.snapshot))!==JSON.stringify(ordered(row)))throw new Error('SALES_HISTORY_SNAPSHOT_MISMATCH');
 return value;
}
