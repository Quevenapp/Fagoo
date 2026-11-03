import type {DocumentKind} from './real-documents-model';
import type {StockMovement} from './stock-model';

export type StockDocumentKind=Exclude<DocumentKind,'sales_proposals'>;
export interface StockDocumentSummary {id:string;kind:StockDocumentKind;number:string;version:number;status:string;date:string;warehouse_id:string|null;eligible:boolean;active_posting_id:string|null}
export interface DocumentStockPosting {id:string;document_id:string;source_document_version:number;movement_id:string;state:'active'|'reversed';version:number;created_at:string;reversal_movement_id:string|null;reversed_at:string|null;reason:string|null;occurred_on:string;direction:'receipt'|'issue';positions:number;ignored_items:number}
export interface OperationalItem {id:string;position:number;product_id:string|null;description:string;unit:string;quantity:string;code?:string|null}
export interface DocumentStockPage {document:StockDocumentSummary;items:OperationalItem[];active_posting:DocumentStockPosting|null;postings:DocumentStockPosting[];limit:number;has_more:boolean;next_cursor:string|null;data_mode:'erp_native'}
// 222: a composition item reaches its components with the item quantity and the quantity of the component per composition.
export interface DocumentStockSource {id:string;position:number;quantity:string;kit_product_id?:string;kit_quantity?:string;component_quantity?:string}
// 296 (estoque): the lots informed on the items ("Informar lotes" of the documentos lane), with the items of each lot in the lançamento.
export interface DocumentStockLot {lot_id:string;code:string;expires_on:string|null;quantity:string;balance_before:string;balance_after:string;sources?:{id:string;position:number;quantity:string}[]}
export interface DocumentStockPreview {action:'post'|'reverse';document:StockDocumentSummary;direction:'receipt'|'issue'|'reversal';occurred_on:string;reason:string;warehouse:{id:string;name:string;version:number;active:boolean};positions:{product_id:string;product_name:string;catalog_version:number;warehouse_id:string;unit:string;quantity:string;balance_before:string;balance_after:string;expected_version:number;sources:DocumentStockSource[];balance_kept?:true;lots?:DocumentStockLot[]}[];ignored:(OperationalItem&{catalog_version:number|null;reason:'service'|'unlinked_item'})[];preview_hash:string;posting?:DocumentStockPosting}
export interface DocumentStockResult {document_id:string;document_version:number;posting:DocumentStockPosting;movement:StockMovement;action:'post'|'reverse';replayed:boolean;data_mode:'erp_native'}

export function documentStockPreviewInput(document:Pick<StockDocumentSummary,'version'>,occurred_on:string,reason:string,today:string,posting?:DocumentStockPosting){
 if(!Number.isInteger(document.version)||document.version<1||document.version>=2147483647)throw new Error('Atualize a versão do documento antes de conferir o estoque.');
 const parsed=new Date(`${occurred_on}T00:00:00Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)||occurred_on<'1900-01-01'||occurred_on>today||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==occurred_on)
  throw new Error('Informe uma data válida até hoje.');
 if(reason.trim().length<3||reason.length>500||/[\x00-\x1f\x7f]/.test(reason))throw new Error('Informe um motivo de 3 a 500 caracteres.');
 if(posting&&(posting.state!=='active'||occurred_on<posting.occurred_on))throw new Error('O estorno deve ser de um lançamento ativo e não pode preceder sua data.');
 return {expected_document_version:document.version,occurred_on,reason:reason.trim(),...(posting?{expected_posting_version:posting.version}:{})};
}
export function documentStockMutationInput(document:Pick<StockDocumentSummary,'id'|'kind'|'version'>,preview:DocumentStockPreview,confirmed:boolean,ignoredConfirmed:boolean){
 if(!confirmed)throw new Error('Confira os saldos e confirme esta movimentação.');
 if(preview.document.id!==document.id||preview.document.kind!==document.kind||preview.document.version!==document.version||!/^[a-f0-9]{64}$/.test(preview.preview_hash))throw new Error('Atualize o documento e faça uma nova conferência.');
 if(preview.ignored.length&&!ignoredConfirmed)throw new Error('Confirme os itens que ficarão fora do estoque.');
 if(preview.action==='reverse'&&(!preview.posting||preview.posting.document_id!==document.id||preview.posting.state!=='active'))throw new Error('Confira o lançamento ativo antes de estornar.');
 return {expected_document_version:document.version,occurred_on:preview.occurred_on,reason:preview.reason,preview_hash:preview.preview_hash,
  ...(preview.action==='post'?{ignored_item_ids:preview.ignored.map(row=>row.id).sort()}:{expected_posting_version:preview.posting!.version})};
}
/**
 * Preferências › Estoque "Ao lançar estoque utilizar data atual ou data entrada/saída" (202610200164): the date first
 * offered by Lançar estoque. Data entrada/saída is the Data saída of pedidos and OS, the Data prevista of the pedido de
 * compra, or the date of the document; a future date becomes today (the stock never records ahead).
 */
export function stockLaunchDay(mode:'data_atual'|'data_documento'|null|undefined,document:{kind:DocumentKind;date?:string|null;ship_date?:string|null;expected_date?:string|null},today:string):string{
 if(mode!=='data_documento')return today;
 const chosen=(document.kind==='purchase_orders'?document.expected_date:document.ship_date)||document.date||today;
 return /^\d{4}-\d{2}-\d{2}$/.test(chosen)&&chosen<today?chosen:today;
}

const lotUnits=(value:string)=>{const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const result=BigInt(whole||'0')*1000000n+BigInt((fraction+'000000').slice(0,6));return negative?-result:result;};
const lotText=(value:bigint)=>{const v=value<0n?-value:value,whole=v/1000000n,fraction=(v%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
 return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${fraction?`,${fraction}`:''}`;};
/** 296: "Lotes: A-1 (3,5), B-2 (1); sem lote: 1" in the conferência of the lançamento; "Lotes devolvidos: ..." in the estorno. */
export function documentStockLotsText(row:{quantity:string;lots?:DocumentStockLot[]},action:'post'|'reverse'):string|null{
 if(!row.lots?.length)return null;
 const total=lotUnits(row.quantity),informed=row.lots.reduce((sum,lot)=>sum+(lotUnits(lot.quantity)<0n?-lotUnits(lot.quantity):lotUnits(lot.quantity)),0n),rest=(total<0n?-total:total)-informed;
 const list=row.lots.map(lot=>`${lot.code} (${lotText(lotUnits(lot.quantity))})`).join(', ');
 return `${action==='reverse'?'Lotes devolvidos':'Lotes'}: ${list}${rest>0n?`; sem lote: ${lotText(rest)}`:''}`;
}
