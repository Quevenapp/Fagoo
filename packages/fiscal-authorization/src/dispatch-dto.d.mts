import type {PrivateJson,ReviewedAction} from './reviewed-ledger-dto.mjs';
export const DISPATCH_PROFILE:'authorization-reviewed-dispatch-v1';
export const DISPATCH_FLAGS:Readonly<{tax_rules_validated:false;can_emit:false;can_transmit:false;production_authorized:false}>;
export function checkDispatchContext(value:unknown):PrivateJson;
export function projectDispatchLedger(action:ReviewedAction,value:unknown,args:PrivateJson):PrivateJson;
export function dispatchResult(value:PrivateJson|null,options?:{readOnly?:boolean;recovered?:boolean;failureCode?:string|null;commandId?:string|null}):PrivateJson;
