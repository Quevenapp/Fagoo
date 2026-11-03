export interface ObservedValue {state:'absent'|'null'|'value'|'invalid';value:string|null}
export interface PurchaseReadinessCapture {state:'absent'|'other_profile'|'unbound'|'bound';profile:'origin-purchase-price-json-v1'|null;observed_at:string|null;response_sha256:string|null}
export interface PurchaseReadinessSource {source_id:string;source_hash:string;source_version:string;last_seen_at:string;number:ObservedValue;date:ObservedValue;situation:{id:string|null;value:ObservedValue};item_count:number|null;capture:PurchaseReadinessCapture}
export interface PurchaseReadinessBinding {entity:'contacts'|'products';source_id:string|null;record_id:string|null;record_version:number|null;name:string|null;unit:string|null;active:boolean|null;human_edited:boolean|null;origin_state:'synced'|'local_modified'|'source_changed'|'source_deleted'|null;candidate_pending:boolean;applied_hash:string|null;latest_hash:string|null;source_hash:string|null;source_version:string|null;valid:boolean;state:'invalid_id'|'missing_staging'|'missing_native'|'needs_review'|'current'}
export interface PurchaseReadinessIssue {code:string;field:string|null;position:number|null}
export interface PurchaseReadinessItem {position:number;code:ObservedValue;description:ObservedValue;unit:ObservedValue;quantity:ObservedValue;unit_price:ObservedValue;quantity_supported:boolean;unit_price_supported:boolean;product:PurchaseReadinessBinding;ipi:ObservedValue;invoice_reference:{state:'absent'|'null'|'empty'|'zero'|'declared'|'invalid';source_id:string|null}}
export interface PurchaseReadinessHistory {comparison:'not_available';reason:'PURCHASE_BACKUP_HAS_NO_API_ID';backup_rows:string;backup_batches:string;backup_rows_without_source_id:string;exact_id_rows_uncompared:string;last_backup_stored_at:string|null;current_capture_is_history:false}
export interface PurchaseReadinessFlags {profile:'origin-purchase-readiness-v1';read_only:true;can_import:false;coverage_certified:false;native_effects:false;observed_at:string;pending_contracts:string[]}
export interface PurchaseReadinessPage extends PurchaseReadinessFlags {items:PurchaseReadinessSource[];limit:number;has_more:boolean;next_cursor:string|null}
export interface PurchaseReadinessDetail extends PurchaseReadinessFlags {source:PurchaseReadinessSource;supplier:PurchaseReadinessBinding;items:PurchaseReadinessItem[];commercial:{total:ObservedValue;total_products:ObservedValue;freight:ObservedValue;discount_value:ObservedValue;discount_unit:ObservedValue;installment_count:number|null;taxation_present:boolean};history:PurchaseReadinessHistory;issues:PurchaseReadinessIssue[]}
export const PURCHASE_READINESS_MAX_BYTES:number;
export const PURCHASE_READINESS_PENDING:readonly string[];
export const PURCHASE_READINESS_ISSUES:readonly string[];
export class PurchaseReadinessError extends Error {status:number;code:string;constructor(status:number,code:string)}
export function parsePurchaseReadinessPage(raw:unknown,binding:{limit:number;after:string|null}):PurchaseReadinessPage;
export function parsePurchaseReadinessDetail(raw:unknown,binding:{sourceId:string}):PurchaseReadinessDetail;
