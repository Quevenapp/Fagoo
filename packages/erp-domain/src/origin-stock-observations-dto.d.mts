export interface StockObservedValue {readonly state:'absent'|'null'|'value'|'invalid';readonly value:string|null}
export interface StockObservationStamp {readonly source_hash:string;readonly source_version:string;readonly last_seen_at:string}
export interface StockWarehouseContext {
 readonly source_id:string;readonly record_id:string;readonly imported_at:string;
 readonly binding_source_hash:string;readonly binding_source_version:string;
 readonly source_state:'same'|'changed'|'missing';readonly record_state:'same'|'changed';
 readonly source:(StockObservationStamp&{readonly name:string|null;readonly status:0|1|null;readonly is_default:boolean|null;readonly exclude_balance:boolean|null;readonly valid:boolean})|null;
 readonly record:{readonly name:string;readonly active:boolean;readonly human_edited:boolean;readonly version:number};
}
export interface StockProductContext {readonly source_known:boolean;readonly source_name:StockObservedValue;readonly source_code:StockObservedValue;readonly record_id:string|null;readonly record_name:string|null;readonly record_unit:string|null;readonly active:boolean|null;readonly human_edited:boolean|null;readonly binding_state:'missing_staging'|'missing_native'|'needs_review'|'current'}
export type StockObservationIssue='STOCK_SOURCE_INVALID'|'STOCK_SOURCE_TOO_LARGE'|'WAREHOUSE_LIST_INVALID'|'WAREHOUSE_ID_INVALID'|'WAREHOUSE_DUPLICATE'|'OBSERVED_NUMBER_INVALID';
export interface StockObservationRow {
 readonly product_source_id:string;readonly product:StockProductContext;
 readonly observation:{readonly state:'missing'|'invalid'|'available';readonly source:StockObservationStamp|null;readonly product_code:StockObservedValue;readonly physical_total:StockObservedValue;readonly virtual_total:StockObservedValue;readonly warehouse:{readonly state:'unavailable'|'absent'|'present'|'invalid';readonly physical:StockObservedValue;readonly virtual:StockObservedValue};readonly issues:readonly StockObservationIssue[]};
}
export interface StockObservationsFlags {readonly profile:'origin-stock-observations-v1';readonly read_only:true;readonly can_import_balance:false;readonly coverage_certified:false;readonly lexical_precision_certified:false;readonly reconciled:false;readonly native_effects:false;readonly numeric_representation:'parsed_json_number';readonly units_compared:false;readonly observed_at:string}
export interface StockObservationsCounts {readonly scope:'exact_staging_product_ids';readonly product_ids:string;readonly known_product_ids:string;readonly stock_observation_ids:string;readonly known_without_observation:string;readonly observation_without_product:string;readonly invalid_product_ids:string;readonly invalid_stock_ids:string}
export interface StockObservationsPage extends StockObservationsFlags {readonly warehouse:StockWarehouseContext;readonly counts:StockObservationsCounts;readonly items:readonly StockObservationRow[];readonly limit:number;readonly has_more:boolean;readonly next_cursor:string|null}
export interface StockObservationsDetail extends StockObservationsFlags {readonly warehouse:StockWarehouseContext;readonly item:StockObservationRow}
export const STOCK_OBSERVATIONS_MAX_BYTES:262144;
export const STOCK_OBSERVATION_ISSUES:readonly StockObservationIssue[];
export class StockObservationsError extends Error {status:number;code:string;constructor(status:number,code:string)}
export function stockObservationSourceId(value:unknown):value is string;
export function parseStockObservationsPage(raw:unknown,binding:{warehouseSourceId:string;limit:number;after:string|null}):StockObservationsPage;
export function parseStockObservationsDetail(raw:unknown,binding:{warehouseSourceId:string;productSourceId:string}):StockObservationsDetail;
