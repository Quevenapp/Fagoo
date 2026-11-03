export type PurchaseReceiptAction='receive'|'reverse';
export interface PurchaseReceiptSelection{item_id:string;quantity:string}
export interface PurchaseReceiptDocument{id:string;kind:'purchase_orders';number:string;version:number;status:string;date:string;warehouse_id:string|null;eligible:boolean;mode:'available'|'legacy_full'|'item_receipts';chain_hash:string;active_receipts:number}
export interface PurchaseReceiptCurrentItem{item_id:string;position:number;product_id:string|null;description:string;unit:string;ordered_quantity:string;received_quantity:string;remaining_quantity:string;catalog_version:number|null;eligibility:'eligible'|'unlinked_item'|'service'|'inactive_product'|'unsupported_product'|'unit_mismatch'}
export interface PurchaseReceiptCurrent{document:PurchaseReceiptDocument;items:PurchaseReceiptCurrentItem[]}
export interface PurchaseReceiptLine{item_id:string;position:number;product_id:string;unit:string;ordered_quantity:string;quantity:string;received_before:string;received_after:string;remaining_after:string}
export interface PurchaseReceiptPosition{product_id:string;product_name:string;warehouse_id:string;unit:string;quantity:string;catalog_version:number;physical_version:number;reservation_hash:string;physical_before:string;reserved_before:string;available_before:string;physical_after:string;available_after:string;balance_kept?:true}
export interface PurchaseReceiptPreview{action:PurchaseReceiptAction;document:PurchaseReceiptDocument;receipt_id:string|null;occurred_on:string;reason:string;warehouse:{id:string;name:string;version:number;active:boolean};items:PurchaseReceiptLine[];positions:PurchaseReceiptPosition[];preview_hash:string}
export interface PurchaseReceiptSummary{id:string;document_id:string;source_document_version:number;document_version:number;command_id:string;movement_id:string;occurred_on:string;reason:string;created_at:string;warehouse_id:string;item_count:number;position_count:number;preview_hash:string}
export interface PurchaseReceipt extends PurchaseReceiptSummary{items:PurchaseReceiptLine[];positions:PurchaseReceiptPosition[]}
export interface PurchaseReceiptReversal extends PurchaseReceipt{receipt_id:string}
export interface PurchaseReceiptCommand{command_id:string;action:PurchaseReceiptAction;document_id:string;document_version:number;receipt:PurchaseReceipt;reversal:PurchaseReceiptReversal|null}
export interface PurchaseReceiptsPage{scope:'purchase_receipts';data_mode:'erp_native';current:PurchaseReceiptCurrent;items:{receipt:PurchaseReceiptSummary;reversal:(PurchaseReceiptSummary&{receipt_id:string})|null}[];selected:{receipt:PurchaseReceipt;reversal:PurchaseReceiptReversal|null}|null;limit:number;has_more:boolean;next_cursor:string|null}
export interface PurchaseReceiptPreviewResult{scope:'purchase_receipts';data_mode:'erp_native';preview:PurchaseReceiptPreview}
export interface PurchaseReceiptResult{scope:'purchase_receipts';data_mode:'erp_native';receipt:PurchaseReceiptCommand;current:PurchaseReceiptCurrent;replayed:boolean}
export interface PurchaseReceiptsRoute{action:'get'|'command'|'preview'|'receive'|'reverse_preview'|'reverse';args:Record<string,unknown>}
export const PURCHASE_RECEIPTS_LIMITS:Readonly<{requestBytes:131072;responseBytes:1048576;items:250;positions:100;page:25}>;
export class PurchaseReceiptsError extends Error{status:number;code:string;constructor(status:number,code:string)}
/** Closed, detached, immutable projection, bound to the exact RPC arguments. */
export function purchaseReceiptsResponse(value:unknown,route:PurchaseReceiptsRoute):PurchaseReceiptsPage|PurchaseReceiptPreviewResult|PurchaseReceiptResult;
