/** Public projection only; callers may narrow the result after validating it. */
export const FLAGS: Readonly<{
 data_mode:'fiscal_reconciliation';environment:'2';profile:'sefaz-sp-protocol-homologation-v1';origin:'operational';
 operation_authorized:false;can_query:false;can_emit:false;can_transmit:false;sefaz_authorized:false;
 financial_mutation_performed:false;stock_mutation_performed:false;
}>;
export const SERVICE_FAILURE_CODES:readonly string[];
export const FAILURES:readonly string[];
export const REJECTION_CODES:readonly string[];
export interface ProjectionContext {action?:'run'|'command'|'recover'|'history'|'history_item';payload?:unknown;commandId?:string;candidateId?:string;}
export function publicResult(value:unknown,context?:ProjectionContext):unknown;
