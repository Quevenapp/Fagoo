export const TAX_PREPARATION_PROFILE:'sn-internal-sale-preparation-v1';
export const TAX_PREPARATION_FLAGS:Readonly<Record<'operational_effects'|'calculation_performed'|'xml_generated'|'transmitted'|'can_emit'|'tax_rules_validated'|'xsd_validated',false>>;
export const TAX_MONEY:RegExp;
export const TAX_RATE:RegExp;
export class TaxPreparationError extends Error{code:string;}
export type TaxOther={cst:'49';base:string|null;rate:string|null;amount:string|null};
export type TaxIcms={csosn:'102'}|{csosn:'101';credit_rate:string|null;credit_period:string|null;credit_evidence:string|null}|{csosn:'500';retention:{base:string|null;rate:string|null;substitute_icms:string|null;retained_icms:string|null};fcp:{base:string|null;rate:string|null;amount:string|null};effective:{reduction_rate:string|null;base:string|null;rate:string|null;amount:string|null}};
export interface TaxDecision{item_id:string;cfop:'5102'|'5405'|null;icms:TaxIcms|null;pis:TaxOther|null;cofins:TaxOther|null;review_note:string|null;}
export interface TaxBasisItem{item_id:string;position:number;product_id:string|null;identifiers:{ncm:string|null;origin:string|null;cest:string|null;gtin:string|null;gtin_tax:string|null};}
export interface TaxResolvedItem extends TaxBasisItem{decisions:TaxDecision;provenance:Record<'cfop'|'icms'|'pis'|'cofins','manual'|'unreviewed'>;pending:string[];}
export function validateTaxDecisions(value:unknown,model?:'55'|'65'|null):TaxDecision[];
export function resolveTaxItems(input:{model:'55'|'65';items:TaxBasisItem[];decisions:unknown}):TaxResolvedItem[];
