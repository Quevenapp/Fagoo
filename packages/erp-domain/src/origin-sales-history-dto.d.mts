/** 083: captured commercial observations. These identifiers are never native document IDs. */
export type SalesHistoryId = `bsh_${string}`;
export interface HistoryObserved {state:'absent'|'null'|'value'|'invalid';kind:'string'|'number'|'boolean'|'object'|'array'|null;value:string|null}
export interface HistoryCapture {state:'absent'|'invalid'|'bound';reason:null|'OTHER_PROFILE'|'UNBOUND_OR_INVALID';profile:'origin-sales-price-json-v1'|null;observed_at:string|null;response_sha256:string|null;numeric_tokens:number|null;scope:'numeric_itens_valor_only'}
export interface HistorySource {namespace:'origin_api';entity:'sales_orders';source_id:string;source_hash:string;source_version:string;last_seen_at:string;source_updated_at:string|null}
export interface HistorySummary {history_id:SalesHistoryId;source:HistorySource;snapshot_hash:string;captured_at:string;number:HistoryObserved;date:HistoryObserved;situation:{id:HistoryObserved;value:HistoryObserved};item_count:number|null;capture:HistoryCapture}
export interface HistoryBinding {state:'invalid_id'|'missing_staging'|'missing_native'|'needs_review'|'current';source_id:string|null;record_id:string|null;record_version:number|null;unit:string|null}
export interface HistoryCurrent {source:{state:'same'|'changed'|'missing';source_hash:string|null;source_version:string|null;last_seen_at:string|null};customer:HistoryBinding;products:{position:number;binding:HistoryBinding}[]}
export interface HistoryItem {position:number;item_state:'object'|'invalid';source_product_id:HistoryObserved;code:HistoryObserved;description:HistoryObserved;unit:HistoryObserved;quantity:HistoryObserved;unit_price:HistoryObserved;discount:HistoryObserved;list_price:HistoryObserved;ipi:HistoryObserved;price_lexeme:string|null}
export interface SalesHistoryFlags {profile:'origin-sales-history-v1';read_only:true;can_convert:false;native_effects:false;commercial_math_reconciled:false;coverage_certified:false;observed_at:string}
export interface SalesHistoryPage extends SalesHistoryFlags {items:HistorySummary[];limit:number;has_more:boolean;next_cursor:SalesHistoryId|null}
export interface SalesHistoryDetail extends SalesHistoryFlags {snapshot:HistorySummary;customer:{source_id:HistoryObserved;name:HistoryObserved};invoice_reference:{structure_present:boolean;source_id:HistoryObserved};items_state:'absent'|'null'|'array'|'invalid';items:HistoryItem[];commercial:{total:HistoryObserved;total_products:HistoryObserved;freight:HistoryObserved;other_expenses:HistoryObserved;discount_value:HistoryObserved;discount_unit:HistoryObserved;installment_count:number|null};current:HistoryCurrent}
export interface SalesHistoryReceipt {command_id:string;history_id:SalesHistoryId;source:HistorySource;snapshot_hash:string;captured_at:string}
export interface SalesHistoryCommand extends SalesHistoryFlags {receipt:SalesHistoryReceipt}
/** Server-only administration. No HTTP write route is provided in this release. */
export interface SalesHistoryCapturePreview extends SalesHistoryFlags {source:HistorySource;snapshot_hash:string;capture:HistoryCapture;existing:SalesHistoryReceipt|null}
export interface SalesHistoryCaptureIntent {source_id:string;source_hash:string;source_version:string;snapshot_hash:string;command_id:string}
export const SALES_HISTORY_MAX_BYTES:number;
export class SalesHistoryError extends Error {status:number;code:string;constructor(status:number,code:string)}
export function parseSalesHistoryPage(raw:unknown,binding:{limit:number;after:SalesHistoryId|null}):SalesHistoryPage;
export function parseSalesHistoryDetail(raw:unknown,binding:{historyId:SalesHistoryId}):SalesHistoryDetail;
export function parseSalesHistoryCommand(raw:unknown,binding:{commandId:string}):SalesHistoryCommand;
export function parseSalesHistoryCapturePreview(raw:unknown,binding:{sourceId:string}):SalesHistoryCapturePreview;
