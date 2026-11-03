import type {AuthorizationRequest} from './index.mjs';
import type {RunInput,CommandInput,HistoryInput,Options,Storage,PrivateJson} from './service.mjs';
import type {ValidationReport} from './validator.mjs';
import type {ReadSubsetReview} from './operational-rule-gate.mjs';
import type {SubsetReviewProof} from './operational-dto.mjs';
import type {PreparedSession,ReviewedTransport} from './operational-transport.mjs';
export {AuthorizationServiceError} from './service.mjs';
export const SERVICE_FAILURE_CODES:readonly string[];
export type SubsetLedgerAction='begin'|'prepare'|'use'|'finish'|'fail'|'command'|'history';
/** Proposed068 private port. No implementation or remote RPC is bundled. use must compare review and consume atomically. */
export type SubsetLedger=(action:SubsetLedgerAction,args:PrivateJson,options:{signal:AbortSignal;deadline:number})=>Promise<unknown>;
export function createReviewedAuthorizationService(configuration:{
 ledger:SubsetLedger;storage:Storage;readReview:ReadSubsetReview;
 validate:(input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'request'|'response'|'processed'},options:{signal:AbortSignal;deadline:number})=>Promise<ValidationReport>;
 withPreparedSession:(value:Readonly<{actor:string;execution:PrivateJson;context:PrivateJson;rule_review:SubsetReviewProof}>,action:(session:PreparedSession)=>Promise<void>,options:{signal:AbortSignal;deadline:number})=>Promise<void>;
 transport:ReviewedTransport;syntheticDispatchEnabled?:boolean;
}):Readonly<{
 run(input:RunInput,options?:Options):Promise<PrivateJson>;
 recover(input:CommandInput,options?:Options):Promise<PrivateJson>;
 command(input:CommandInput,options?:Options):Promise<PrivateJson>;
 history(input:HistoryInput,options?:Options):Promise<PrivateJson>;
}>;
