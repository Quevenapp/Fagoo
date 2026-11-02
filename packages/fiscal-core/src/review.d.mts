export type ReviewScope='document'|'issuer'|'recipient'|'item'|'payments'|'dependencies';
export interface ReviewFinding {code:string;scope:ReviewScope;field:string;severity:'blocking'|'review';source:'snapshot'|'current_catalog'|'comparison'|'pipeline';item_id:string|null;position:number|null;}
export interface ReviewProduct {id:string;version:number;active:boolean;name:string;code:string|null;unit:string|null;kind:string|null;format:string|null;ncm:string|null;gtin:string|null;origin:string|null;cest:string|null;gtin_tax:string|null;}
export interface ReviewItem {item_id:string;position:number;quantity_lexical:string|null;unit_price_lexical:string|null;catalog_state:'unlinked'|'unavailable'|'same_version'|'changed';}
export interface FiscalReview {
 data_mode:'fiscal_review';read_only:true;operational_effects:false;emission_enabled:false;can_emit:false;tax_rules_validated:false;xsd_validated:false;
 basis:{draft:unknown;catalog:{product_id:string;record:ReviewProduct|null}[];observed_at:string};
 report:{profile:string;schema_profile:string;summary:{items:number;blocking:number;review:number};findings:ReviewFinding[];items:ReviewItem[]};
}
export const FISCAL_REVIEW_LABELS:Readonly<Record<string,string>>;
export const FISCAL_REVIEW_FLAGS:Readonly<Record<string,boolean>>;
export const FISCAL_REVIEW_LIMITS:Readonly<{description:number;code:number;unit:number;name:number;quantity_scale:number;quantity_integers:number;price_scale:number;price_integers:number}>;
export const FISCAL_REVIEW_PROFILE:string;
export const FISCAL_REVIEW_SCHEMA:string;
export function fiscalExactDecimal(value:unknown,scale:number,integers:number):string|null;
export function buildFiscalReview(input:unknown):FiscalReview;
export function validateFiscalReview(input:unknown,expectedId:string,expectedRevision:number):FiscalReview;
