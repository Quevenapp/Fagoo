import {stockReservationsResponse,type StockReservationAction,type StockReservation,type StockReservationPreview,type StockReservationResult,type StockReservationPage,type StockReservationPreviewResult,type StockAvailability} from '../../../../packages/erp-domain/src/stock-reservations-dto.mjs';
export type {StockReservationAction,StockReservation,StockReservationPreview,StockReservationResult,StockReservationPage,StockAvailability};
export const STOCK_RESERVATIONS_BASE='/v1/reservas-estoque';
export const reservationCanRead=(role:string)=>['admin','estoque','vendas','fiscal','consulta'].includes(role);
export const reservationCanWrite=(role:string)=>['admin','estoque'].includes(role);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export interface ReservationPreviewBody{expected_document_version:number;occurred_on:string;reason:string;expected_reservation_version?:number}
export interface ReservationIntent{readonly documentId:string;readonly action:StockReservationAction;readonly path:string;readonly body:Readonly<ReservationPreviewBody&{command_id:string;preview_hash:string;ignored_item_ids?:readonly string[]}>;readonly reservationId:string|null}
export function reservationPage(raw:unknown,documentId:string,limit=25,after:string|null=null):StockReservationPage{return stockReservationsResponse(raw,{action:'get',args:{p_document_id:documentId,p_limit:limit,p_after:after}}) as StockReservationPage;}
export function reservationPreview(raw:unknown,documentId:string,action:StockReservationAction,body:ReservationPreviewBody,reservationId:string|null=null):StockReservationPreview{
 return (stockReservationsResponse(raw,{action:action==='reserve'?'preview':`${action}-preview`,args:{p_document_id:documentId,p_expected_version:body.expected_document_version,p_action:action,p_occurred_on:body.occurred_on,p_reason:body.reason,p_reservation_id:reservationId,p_reservation_version:body.expected_reservation_version??null}}) as StockReservationPreviewResult).preview;
}
export function reservationIntent(document:{id:string;version:number},preview:StockReservationPreview,commandId:string,confirmed:boolean,ignoredConfirmed=false):ReservationIntent{
 if(!confirmed||!id(commandId)||!id(preview.document.id)||document.id!==preview.document.id||document.version!==preview.document.version||(preview.action==='reserve'&&preview.ignored.length>0&&!ignoredConfirmed))throw new Error('RESERVATION_CONFIRMATION_REQUIRED');
 const body={expected_document_version:preview.document.version,occurred_on:preview.occurred_on,reason:preview.reason,command_id:commandId,preview_hash:preview.preview_hash,
  ...(preview.reservation_id?{expected_reservation_version:preview.reservation_version!}:{}),...(preview.action==='reserve'?{ignored_item_ids:Object.freeze(preview.ignored.map(i=>i.id).sort())}:{})};
 const path=`${STOCK_RESERVATIONS_BASE}/pedidos/${preview.document.id}/${preview.reservation_id?`${preview.reservation_id}/`:''}${preview.action}`;
 return Object.freeze({documentId:preview.document.id,action:preview.action,path,body:Object.freeze(body),reservationId:preview.reservation_id});
}
export function reservationResult(raw:unknown,intent:ReservationIntent,query=false):StockReservationResult{
 const result=stockReservationsResponse(raw,{action:query?'command':intent.action,args:{p_document_id:intent.documentId,p_expected_version:intent.body.expected_document_version,p_command_id:intent.body.command_id,p_action:intent.action,p_reservation_id:intent.reservationId}}) as StockReservationResult;
 if(result.receipt.document_id!==intent.documentId||result.receipt.action!==intent.action||result.receipt.document_version!==intent.body.expected_document_version+1||(intent.reservationId!==null&&result.receipt.reservation.id!==intent.reservationId))throw new Error('RESERVATION_RESULT_MISMATCH');return result;
}
export function reservationAvailability(raw:unknown,productId:string,warehouseId:string):StockAvailability{return stockReservationsResponse(raw,{action:'availability',args:{p_product_id:productId,p_warehouse_id:warehouseId}}) as StockAvailability;}
export function reservationCommandPath(intent:ReservationIntent){return `${STOCK_RESERVATIONS_BASE}/comandos/${intent.body.command_id}`;}
