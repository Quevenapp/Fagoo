import type {SelectReview} from './preflight-service.mjs';
import type {SelectedRunInput} from './selected-run-dto.mjs';
import type {AuthorizationRequest} from './index.mjs';
import type {RunInput,CommandInput,HistoryInput,Options,Storage,PrivateJson} from './service.mjs';
import type {ValidationReport} from './validator.mjs';
import type {ReadSubsetReview} from './operational-rule-gate.mjs';
import type {ReviewedRpc} from './reviewed-ledger-rpc.mjs';
import type {DispatchPreparation} from './dispatch-preparation.mjs';
import type {DispatchTransport} from './dispatch-transport.mjs';
import type {PreparedSession} from './operational-transport.mjs';
export {AuthorizationServiceError} from './service.mjs';
export const SERVICE_FAILURE_CODES:readonly string[];
export type AuthorizationCustody=(value:DispatchPreparation,action:(session:PreparedSession)=>Promise<void>,options:{signal:AbortSignal;deadline:number})=>Promise<void>;
/** All ports are private and mandatory; enabled defaults to false. */
export function createAuthorizationDispatchService(configuration:{
 rpc:ReviewedRpc;storage:Storage;readReview:ReadSubsetReview;enabled?:boolean;selectReview?:SelectReview;
 validate:(input:{request:AuthorizationRequest;xmlBytes:Uint8Array;kind:'request'|'response'|'processed'},options:{signal:AbortSignal;deadline:number})=>Promise<ValidationReport>;
 withPreparedSession:AuthorizationCustody;transport:DispatchTransport;
}):Readonly<{
 runReviewed(input:{actor:string;request:SelectedRunInput},options?:Options):Promise<PrivateJson>;
 run(input:RunInput,options?:Options):Promise<PrivateJson>;
 recover(input:CommandInput,options?:Options):Promise<PrivateJson>;
 command(input:CommandInput,options?:Options):Promise<PrivateJson>;
 history(input:HistoryInput,options?:Options):Promise<PrivateJson>;
}>;
