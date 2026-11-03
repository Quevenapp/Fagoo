import type {AuthorizationRequest} from './index.mjs';
import type {PrivateJson,SubsetReviewProof} from './reviewed-ledger-dto.mjs';
import type {ReviewedRpc} from './reviewed-ledger-rpc.mjs';
import type {ReadSubsetReview} from './operational-rule-gate.mjs';
export type DispatchPreparation=Readonly<{actor:string;execution:PrivateJson;context:PrivateJson;rule_review:SubsetReviewProof;request:AuthorizationRequest}>;
export type PreparationAuthorizer=(value:DispatchPreparation,options:{signal:AbortSignal;deadline:number})=>Promise<PrivateJson>;
export function captureDispatchPreparation(input:unknown):DispatchPreparation;
export function createAuthorizationPreparationAuthorizer(configuration:{rpc:ReviewedRpc;readReview:ReadSubsetReview}):PreparationAuthorizer;
