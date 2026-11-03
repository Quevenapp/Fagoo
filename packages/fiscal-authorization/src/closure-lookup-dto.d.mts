import type {ClosureResult,ClosureLedgerResult} from './closure-dto.mjs';
export type ClosureLookupInput=Readonly<{authorization_command_id:string;expected_attempt_id:string}>;
export const MAX_CLOSURE_LOOKUP_REQUEST_BYTES:4096,MAX_CLOSURE_LOOKUP_RESPONSE_BYTES:16384;
export function captureClosureLookupInput(value:unknown):ClosureLookupInput;
export function projectClosureLookupPublic(value:unknown,input:ClosureLookupInput):ClosureResult;
export function projectClosureLookupLedger(value:unknown,input:ClosureLookupInput):ClosureLedgerResult;
export function closureLookupPublicFromLedger(value:unknown,input:ClosureLookupInput):ClosureResult;
