export type ItemPreparationField='ncm'|'origin'|'cest'|'gtin'|'gtin_tax';
export type FiscalFieldChoice={source:'manual';value:string|null}|{source:'catalog';expected_product_id:string;expected_version:number};
export interface ItemPreparationInput{
 basis:unknown;expected:{draft_id:string;draft_version:number;snapshot_hash:string};
 decisions:{item_id:string;fields:Partial<Record<ItemPreparationField,FiscalFieldChoice>>}[];
}
export interface PreparedFiscalField{
 value:string|null;provenance:{source:'unreviewed'|'manual'}|{source:'catalog';product_id:string;product_version:number;active:boolean};check_digit_verified:boolean;
}
export interface FiscalItemPreparation{
 data_mode:'fiscal_item_preparation';profile:string;schema_profile:string;operational_effects:false;emission_enabled:false;can_emit:false;tax_rules_validated:false;xsd_validated:false;catalog_registry_verified:false;
 binding:{draft_id:string;draft_version:number;snapshot_hash:string;model:'55'|'65';environment:'2';source_document_id:string;source_document_version:number};observed_at:string;
 commercial:{number:string;date:string;discount_mode:string;discount_value:string;totals:Record<string,string>;items:{id:string;position:number;product_id:string|null;description:string;code:string|null;unit:string;quantity:string;unit_price:string;discount_percent:string;gross:string;discount:string;total:string}[]};
 items:{item_id:string;position:number;product_id:string|null;fields:Record<ItemPreparationField,PreparedFiscalField>;pending:string[]}[];pending:string[];
 snapshot_findings:import('./review.mjs').ReviewFinding[];
}
export const ITEM_PREPARATION_PROFILE:string;
export const ITEM_PREPARATION_SCHEMA:string;
export const ITEM_PREPARATION_FIELDS:readonly ItemPreparationField[];
export const ITEM_PREPARATION_ORIGINS:readonly string[];
export const ITEM_PREPARATION_FLAGS:Readonly<Record<string,boolean>>;
export class ItemPreparationError extends Error{code:string;item_id:string|null;field:ItemPreparationField|null;}
export function gtinCheckDigitMatches(value:unknown):boolean;
export function prepareFiscalItems(input:ItemPreparationInput):FiscalItemPreparation;
