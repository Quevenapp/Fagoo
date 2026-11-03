import type {StockObservedValue,StockObservationRow,StockObservationIssue,StockProductContext} from '../../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
export {parseStockObservationsPage,parseStockObservationsDetail} from '../../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
export type {StockObservedValue,StockObservationRow,StockObservationsPage,StockObservationsDetail,StockWarehouseContext} from '../../../../packages/erp-domain/src/origin-stock-observations-dto.mjs';
export {captureStockObservationsRequest,stockObservationsListPath,stockObservationsDetailPath,stockObservationSourceId} from './origin-stock-observations-request.ts';
const missing={absent:'Não informado',null:'Sem valor declarado',invalid:'Valor não conferido'} as const;
/** Display only. The upstream values already passed through JSON-number parsing. */
export function stockObserved(value:StockObservedValue,numeric=false){return value.state==='value'?(numeric?value.value!.replace('.',','):value.value!):missing[value.state];}
export const stockObservedMoment=(value:string|null)=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Sem observação';
export const stockProductName=(row:StockObservationRow)=>row.product.source_name.state==='value'&&row.product.source_name.value?row.product.source_name.value:`Produto ${row.product_source_id}`;
export const stockProductBinding:Record<StockProductContext['binding_state'],string>={current:'Correspondência atual',needs_review:'Correspondência precisa de conferência',missing_native:'Sem cadastro correspondente no FAGOO',missing_staging:'Produto não disponível na coleta atual'};
export function stockObservationLabel(row:StockObservationRow){
 if(row.observation.state==='missing')return 'Estoque ainda não observado';
 if(row.observation.state==='invalid')return 'Observação precisa de conferência';
 return {unavailable:'Depósitos não informados nesta observação',absent:'Depósito ausente nesta observação',present:'Depósito informado',invalid:'Depósito precisa de conferência'}[row.observation.warehouse.state];
}
export const stockObservationIssues:Record<StockObservationIssue,string>={STOCK_SOURCE_INVALID:'A observação de estoque não está em formato válido.',STOCK_SOURCE_TOO_LARGE:'A observação excede o tamanho aceito para conferência.',WAREHOUSE_LIST_INVALID:'A relação de depósitos precisa de conferência.',WAREHOUSE_ID_INVALID:'Há um depósito sem identificação válida na observação.',WAREHOUSE_DUPLICATE:'O depósito aparece mais de uma vez; as quantidades não foram escolhidas nem somadas.',OBSERVED_NUMBER_INVALID:'Há uma quantidade em formato não suportado.'};
