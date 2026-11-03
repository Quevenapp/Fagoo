export type StockReservationAction='reserve'|'release'|'consume';
export interface StockReservationDocument{id:string;kind:'sales_orders';number:string;version:number;status:string;date:string;warehouse_id:string|null;eligible:boolean;active_posting_id:string|null}
export interface StockReservationSource{id:string;position:number;quantity:string}
export interface StockReservationIgnored extends StockReservationSource{product_id:string|null;description:string;unit:string;catalog_version:number|null;reason:'service'|'unlinked_item'}
export interface StockReservationPosition{product_id:string;product_name:string;warehouse_id:string;unit:string;quantity:string;sources:StockReservationSource[];catalog_version:number;physical_version:number;reservation_hash:string;physical_before:string;reserved_before:string;available_before:string;physical_after:string;reserved_after:string;available_after:string}
export interface StockReservationSummary{id:string;document_id:string;source_document_version:number;version:number;state:'active'|'released'|'consumed';created_at:string;occurred_on:string;reason:string;warehouse_id:string;closed_at:string|null;close_reason:string|null;movement_id:string|null;posting_id:string|null}
export interface StockReservation extends StockReservationSummary{positions:StockReservationPosition[];ignored:StockReservationIgnored[]}
export interface StockReservationCurrent{document:StockReservationDocument;active_reservation:StockReservation|null}
export interface StockReservationReceipt{command_id:string;action:StockReservationAction;document_id:string;document_version:number;reservation:StockReservation}
export interface StockReservationResult{receipt:StockReservationReceipt;current:StockReservationCurrent;replayed:boolean;data_mode:'erp_native';scope:'stock_reservations'}
export interface StockReservationPage{current:StockReservationCurrent;items:(StockReservationSummary&{positions_count:number;ignored_count:number})[];limit:number;has_more:boolean;next_cursor:string|null;data_mode:'erp_native';scope:'stock_reservations'}
export interface StockReservationPreview{action:StockReservationAction;document:StockReservationDocument;reservation_id:string|null;reservation_version:number|null;occurred_on:string;reason:string;positions:StockReservationPosition[];ignored:StockReservationIgnored[];preview_hash:string}
export interface StockReservationPreviewResult{preview:StockReservationPreview;data_mode:'erp_native';scope:'stock_reservations'}
export interface StockAvailability{position:{product_id:string;warehouse_id:string;unit:string|null;state:'recorded'|'no_movements'|'review_required';physical_version:number;physical_quantity:string|null;reserved_quantity:string;available_quantity:string|null;reservation_hash:string};data_mode:'erp_native';scope:'stock_availability'}
export interface StockReservationRoute{action:string;args:Record<string,unknown>}
export class StockReservationsError extends Error{status:number;code:string;constructor(status:number,code:string)}
export function stockReservationsResponse(value:unknown,route:StockReservationRoute):StockReservationResult|StockReservationPage|StockReservationPreviewResult|StockAvailability;
