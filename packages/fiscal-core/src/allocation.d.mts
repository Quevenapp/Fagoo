export type AllocationKind = 'discount' | 'freight' | 'other';
export type AllocationBasis = {type:'amount'|'manual'|'equal'} | {type:'quantity';unit:string};
export interface AllocationInputItem {id:string;weight?:string;unit?:string;discount_capacity_cents?:string;}
export interface AllocationInput {kind:AllocationKind;total_cents:string;basis:AllocationBasis;items:readonly AllocationInputItem[];}
export interface AllocationOutputItem {id:string;weight_units:string;floor_cents:string;remainder_numerator:string;rounding_cent:'0'|'1';allocated_cents:string;discount_capacity_cents?:string;}
export interface AllocationOutput {
 data_mode:'mathematical_allocation';algorithm:'largest-remainder-uuid-v1';tie_break:'uuid_ascending';
 operational_effects:false;emission_enabled:false;can_emit:false;tax_rules_validated:false;xsd_validated:false;
 kind:AllocationKind;basis:AllocationBasis & {weight_scale:0|6;weight_total_units:string};
 total_cents:string;allocated_total_cents:string;undistributed_cents:'0';items:AllocationOutputItem[];
}
export class AllocationError extends Error {code:string;item_id:string|null;constructor(code:string,itemId?:string|null);}
export const ALLOCATION_ALGORITHM:'largest-remainder-uuid-v1';
export const ALLOCATION_MAX_ITEMS:250;
export const ALLOCATION_MAX_CENTS:'999999999999999';
export function allocateFiscalAmount(input:AllocationInput):AllocationOutput;
