export const COMPLETION_PROFILE:'sn-sp-business-completion-v1';
export const COMPLETION_FLAGS:Readonly<Record<string,string|false>>;
export const COMPLETION_TOTAL_FIELDS:readonly string[];
export const COMPLETION_EXCLUDED_FIELDS:readonly string[];
export class BusinessCompletionError extends Error{code:'BUSINESS_COMPLETION_INVALID';}
export interface CompletionItemBasis{item_id:string;position:number;cest:string|null;csosn:'101'|'102'|'500'|null;}
export function resolveBusinessCompletion(value:unknown,basis:{model:'55'|'65';items:CompletionItemBasis[]}):{
 completion:Record<string,unknown>;pending:{general:string[];items:Array<{item_id:string;position:number;codes:string[]}>};
};
