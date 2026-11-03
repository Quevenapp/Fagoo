import {purchaseReceiptsResponse,type PurchaseReceiptAction,type PurchaseReceiptCurrent,type PurchaseReceiptPreview,type PurchaseReceiptResult,type PurchaseReceiptsPage,type PurchaseReceiptPreviewResult,type PurchaseReceiptSelection} from '../../../../packages/erp-domain/src/purchase-receipts-dto.mjs';
import {capturePurchaseReceiptsRequest} from './purchase-receipts-request.ts';
export type {PurchaseReceiptAction,PurchaseReceiptCurrent,PurchaseReceiptPreview,PurchaseReceiptResult,PurchaseReceiptsPage,PurchaseReceiptSelection};
export const PURCHASE_RECEIPTS_BASE='/v1/recebimentos-compras';
export const purchaseReceiptsAllowed=(role:string)=>['admin','estoque'].includes(role);
// 277 (estoque): a receive preview without a date (null) is dated by Preferências › Suprimentos › Estoque; its confirmation sends that day.
export interface PurchaseReceiptPreviewBody{expected_document_version:number;occurred_on:string|null;reason:string;items?:readonly PurchaseReceiptSelection[];warehouse_id?:string}
export interface PurchaseReceiptIntent{readonly documentId:string;readonly action:PurchaseReceiptAction;readonly receiptId:string|null;readonly path:string;readonly body:Readonly<PurchaseReceiptPreviewBody&{command_id:string;preview_hash:string;confirmed:true}>}
export function purchaseQuantity(value:string){return value.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1').replace('.',',');}
export function purchaseQuantityUnits(value:string):bigint{if(!/^(0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value))throw Error('PURCHASE_QUANTITY_INVALID');const [i,f='']=value.split('.');return BigInt(i+f.padEnd(6,'0'));}
export function purchaseReceiptItems(current:PurchaseReceiptCurrent,values:Readonly<Record<string,string>>):PurchaseReceiptSelection[]{
 const out:PurchaseReceiptSelection[]=[];for(const [item_id,raw]of Object.entries(values)){if(raw==='')continue;const i=current.items.find(i=>i.item_id===item_id),quantity=raw.replace(',','.');if(!i||i.eligibility!=='eligible'||purchaseQuantityUnits(quantity)<=0n||purchaseQuantityUnits(quantity)>purchaseQuantityUnits(i.remaining_quantity))throw Error('PURCHASE_QUANTITY_INVALID');out.push({item_id,quantity});}
 if(!out.length)throw Error('PURCHASE_QUANTITY_REQUIRED');return out;
}
export function purchaseReceiptsPage(raw:unknown,documentId:string,after:string|null=null,receiptId:string|null=null):PurchaseReceiptsPage{return purchaseReceiptsResponse(raw,{action:'get',args:{p_document_id:documentId,p_limit:25,p_after:after,p_receipt_id:receiptId}}) as PurchaseReceiptsPage;}
function previewArgs(documentId:string,body:PurchaseReceiptPreviewBody,receiptId:string|null){return{p_document_id:documentId,p_expected_version:body.expected_document_version,p_occurred_on:body.occurred_on,p_reason:body.reason,...(receiptId?{p_receipt_id:receiptId}:{p_items:body.items}),...(body.warehouse_id?{p_warehouse_id:body.warehouse_id}:{})};}
export function purchaseReceiptPreview(raw:unknown,documentId:string,body:PurchaseReceiptPreviewBody,receiptId:string|null):PurchaseReceiptPreview{return(purchaseReceiptsResponse(raw,{action:receiptId?'reverse_preview':'preview',args:previewArgs(documentId,body,receiptId)}) as PurchaseReceiptPreviewResult).preview;}
export function purchaseReceiptIntent(document:{id:string;version:number},preview:PurchaseReceiptPreview,commandId:string,confirmed:boolean):PurchaseReceiptIntent{
 if(!confirmed||preview.document.id!==document.id||preview.document.version!==document.version)throw Error('PURCHASE_RECEIPT_CONFIRMATION_REQUIRED');
 const path=`${PURCHASE_RECEIPTS_BASE}/${document.id}/${preview.receipt_id?preview.receipt_id+'/':''}${preview.action}`;
 // 184 (estoque): a receive previewed in a chosen warehouse (order without warehouse) is confirmed in the same warehouse.
 const chosen=preview.action==='receive'&&preview.document.warehouse_id===null?{warehouse_id:preview.warehouse.id}:{};
 const body={expected_document_version:document.version,occurred_on:preview.occurred_on,reason:preview.reason,...(preview.action==='receive'?{items:preview.items.map(i=>({item_id:i.item_id,quantity:i.quantity}))}:{}),...chosen,command_id:commandId,preview_hash:preview.preview_hash,confirmed:true as const};
 const captured=capturePurchaseReceiptsRequest(path,{method:'POST',body});
 return Object.freeze({documentId:document.id,action:preview.action,receiptId:preview.receipt_id,path,body:captured.options.body as unknown as PurchaseReceiptIntent['body']});
}
export function purchaseReceiptResult(raw:unknown,intent:PurchaseReceiptIntent,query=false):PurchaseReceiptResult{
 const args={...previewArgs(intent.documentId,intent.body,intent.receiptId),p_command_id:intent.body.command_id,p_preview_hash:intent.body.preview_hash,p_confirm:true};
 const result=purchaseReceiptsResponse(raw,{action:query?'command':intent.action,args}) as PurchaseReceiptResult;
 // A command GET carries no mutation parameters; bind its immutable receipt to this exact intent too.
 purchaseReceiptsResponse(result,{action:intent.action,args});return result;
}
export const purchaseReceiptCommandPath=(intent:PurchaseReceiptIntent)=>`${PURCHASE_RECEIPTS_BASE}/comandos/${intent.body.command_id}`;
export function purchaseReceiptCommand(raw:unknown,documentId:string,commandId:string):PurchaseReceiptResult{const result=purchaseReceiptsResponse(raw,{action:'command',args:{p_command_id:commandId}}) as PurchaseReceiptResult;if(result.receipt.document_id!==documentId)throw Error('PURCHASE_RECEIPT_DOCUMENT_MISMATCH');return result;}
export const purchaseItemIssue=(value:string)=>({unlinked_item:'Vincule um produto ao item.',service:'Serviço: não recebe estoque.',inactive_product:'Produto arquivado.',unsupported_product:'Tipo de produto não suportado.',unit_mismatch:'Confira a unidade do item e do produto.'}[value]??'');
