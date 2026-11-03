// Saldo de abertura do estoque (Origin) e política "Permitir estoque negativo": textos, formatos e vínculos da tela.
import {captureStockPolicyInput,type StockOpeningBatch,type StockOpeningGroup,type StockOpeningReason,type StockOpeningResult,type StockOpeningRow,type StockOpeningStatus,type StockPolicy} from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
import {quantityText,stockDate} from './stock-model.ts';
import type {BatchResult} from './origin-batch';
export {parseStockOpeningWarehouses,parseStockOpeningPage,parseStockOpeningBatch,parseStockOpeningResult,parseStockPolicy,parseStockPolicyResult,stockOpeningIntent,stockOpeningUuid,stockOpeningDay,STOCK_OPENING_GROUPS} from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
export type {StockOpeningWarehouses,StockOpeningWarehouse,StockOpeningPage,StockOpeningBatch,StockOpeningRow,StockOpeningResult,StockOpeningApplyInput,StockPolicy,StockPolicyView,StockPolicyInput,StockPolicyResult,StockOpeningGroup,StockOpeningCounts} from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
export {captureStockOpeningRequest,stockOpeningWarehousesPath,stockOpeningPagePath,stockOpeningActionPath,stockOpeningCommandPath,stockPolicyPath,stockPolicyCommandPath,STOCK_OPENING_ROUTE} from './stock-opening-request.ts';

export const OPENING_GROUP_LABELS:Readonly<Record<StockOpeningGroup,string>>={positive:'Positivos',zero:'Zerados',negative:'Negativos',no_native_product:'Sem produto nativo',
 no_observation:'Sem observação ou depósito ausente',invalid:'Inválidos',adopted:'Já adotados',native_movements:'Com lançamentos nativos'};
export const OPENING_STATUS_LABELS:Readonly<Record<StockOpeningStatus,string>>={positive:'A adotar',zero:'A registrar (zero)',negative:'A adotar (negativo)',negative_blocked:'Ignorado',
 no_native_product:'Sem produto nativo',no_observation:'Sem observação',invalid:'Inválido',adopted:'Adotado',adopted_zero:'Adotado (zero)',adopted_reversed:'Adoção estornada',native_movements:'Com lançamentos nativos'};
export const OPENING_REASON_LABELS:Readonly<Record<StockOpeningReason,string>>={
 NATIVE_PRODUCT_MISSING:'O produto do Origin ainda não foi importado para o FAGOO.',ALREADY_ADOPTED:'O saldo de abertura deste produto neste depósito já foi adotado.',
 NATIVE_MOVEMENTS:'Já existem lançamentos no FAGOO para este produto neste depósito; o saldo não é sobrescrito.',OBSERVATION_MISSING:'O Origin ainda não informou o estoque deste produto.',
 WAREHOUSE_LIST_MISSING:'A observação do Origin não traz a lista de depósitos.',WAREHOUSE_ABSENT:'O depósito escolhido não aparece no estoque informado pelo Origin. Ausência não vira zero.',
 SOURCE_INVALID:'A observação do Origin precisa de conferência.',WAREHOUSE_LIST_INVALID:'A lista de depósitos informada pelo Origin é inválida ou repetida.',
 PHYSICAL_ABSENT:'O saldo físico não foi informado pelo Origin.',PHYSICAL_NULL:'O Origin informou saldo físico vazio.',PHYSICAL_INVALID:'O saldo físico do Origin não é um número válido.',
 PHYSICAL_PRECISION:'O saldo físico do Origin tem mais de 6 casas decimais.',PHYSICAL_RANGE:'O saldo físico do Origin excede o limite do estoque.',
 PRODUCT_UNAVAILABLE:'O cadastro no FAGOO está inativo, é serviço, composição ou não tem unidade.',NEGATIVE_NOT_ALLOWED:'Estoque negativo não permitido',
 SOURCE_CHANGED:'O estoque do Origin mudou depois da prévia. Confira o próximo lote.',PRODUCT_CHANGED:'O vínculo do produto mudou depois da prévia.',
 UNIT_CHANGED:'A unidade do cadastro no FAGOO mudou depois da prévia. Confira o próximo lote.'};
export const POLICY_CONFIRMATION={
 enable:'Entendo que, com a política ligada, saídas, vendas, transferências e estornos poderão deixar o saldo abaixo de zero. Reservas continuam exigindo saldo disponível e nunca são consumidas por outra saída.',
 disable:'Entendo que, com a política desligada, novas baixas que deixem ou mantenham o saldo abaixo de zero serão recusadas. Saldos negativos existentes não são alterados; entradas continuam permitidas.',
} as const;
export const openingToday=()=>stockDate();
export const openingNegative=(value:string|null|undefined)=>typeof value==='string'&&value.startsWith('-');
export const openingQuantity=(value:string|null|undefined)=>value===null||value===undefined?'—':quantityText(value);
export const openingStatusTone=(status:StockOpeningStatus)=>['positive','zero','negative'].includes(status)?'info':status==='native_movements'||status==='negative_blocked'?'warning':['adopted','adopted_zero'].includes(status)?'success':status==='adopted_reversed'?'neutral':'danger';
export const openingProductLabel=(row:Pick<StockOpeningRow,'product'|'source'|'product_source_id'>)=>row.product?.name??row.source.name??`Produto ${row.product_source_id} no Origin`;
export const openingCode=(row:Pick<StockOpeningRow,'product'|'source'>)=>row.product?.code??row.source.code??'—';
export const openingPolicyLabel=(policy:StockPolicy)=>policy.allow_negative?'Permitido':'Não permitido';
export function openingDateProblem(day:string,today=openingToday()){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<'1900-01-01')return 'Informe a data de corte.';
 const d=new Date(`${day}T00:00:00Z`);if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==day)return 'Informe uma data de corte válida.';
 if(day>today)return 'A data de corte não pode estar no futuro.';return null;
}
/** Exactly what the administrator confirms; the server re-checks the version and the administrador role. */
export function policyIntent(policy:StockPolicy,allow:boolean,reason:string,commandId:string,confirmed:boolean){
 if(!confirmed||allow===policy.allow_negative)throw Error('STOCK_POLICY_CONFIRMATION_REQUIRED');
 return captureStockPolicyInput({command_id:commandId,expected_version:policy.version,allow_negative:allow,reason:reason.trim(),confirmed:true});
}
const rowLabel=(row:StockOpeningRow)=>`${openingCode(row)} · ${openingProductLabel(row)}`;
/** Preview lines of a pinned batch, in the BatchDialog vocabulary. */
export function openingBatchPreview(batch:StockOpeningBatch):BatchResult[]{
 return batch.items.map(row=>({id:row.product_source_id,label:rowLabel(row),outcome:'ok' as const,
  message:`Origin ${openingQuantity(row.target)} · atual ${row.current.quantity===null?'sem lançamentos':openingQuantity(row.current.quantity)} · ajuste ${openingQuantity(row.adjustment)} ${row.product?.unit??''}`.trim()}));
}
/** Per-item results of an adoption command; labels come from the batch the administrator confirmed when available. */
export function openingResults(result:StockOpeningResult,batch?:StockOpeningBatch|null):BatchResult[]{
 const rows=new Map((batch?.items??[]).map(row=>[row.product_source_id,row]));
 return result.receipt.items.map(item=>{const row=rows.get(item.product_source_id);const label=row?rowLabel(row):`Produto ${item.product_source_id} no Origin`;const unit=row?.product?.unit??'';
  return item.outcome==='skipped'?{id:item.product_source_id,label,outcome:'skipped' as const,message:OPENING_REASON_LABELS[item.reason!]}
   :{id:item.product_source_id,label,outcome:'ok' as const,message:item.outcome==='adopted_zero'?'Saldo zero registrado, sem movimento de estoque.':`Saldo ajustado para ${openingQuantity(item.target)} ${unit}`.trim()};});
}
