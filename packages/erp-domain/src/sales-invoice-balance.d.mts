export declare class SalesInvoiceBalanceError extends Error{status:number;code:string;constructor(status:number,code:string);}
export interface BalanceItem{document_item_id:string;position:number;product_id:string|null;description:string|null;unit:string|null;ordered:string;invoiced:string;remaining:string}
export interface BalanceInvoice{id:string;number:number|null;series:number;model:'55'|'65';status:number;partial:boolean;counts:boolean}
export interface InvoiceBalance{document_id:string;full_invoice_id:string|null;items:BalanceItem[];invoices:BalanceInvoice[];scope?:'document_invoice_balance';data_mode?:'erp_native'}
export interface PartialItem{position:number;document_item_id:string;quantity:string}
export declare function balanceUuid(value:unknown):value is string;
export declare function parseInvoiceBalance(raw:unknown,documentId:string,options?:{scoped?:boolean}):InvoiceBalance;
export declare function capturePartialItems(raw:unknown):PartialItem[];
