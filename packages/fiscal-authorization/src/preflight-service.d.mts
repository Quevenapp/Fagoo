import type {createSubsetReviewService} from './subset-review-service.mjs';
import type {PreflightRpc,PreflightServiceInput,PreflightOptions} from './preflight-rpc.mjs';
import type {PreflightResult,PreflightSelection} from './preflight-dto.mjs';
import type {SubsetReviewProof} from './reviewed-ledger-dto.mjs';
export type SelectedReview=Readonly<{selection:PreflightSelection;proof:SubsetReviewProof;emission_window:PreflightResult['emission_window']}>;
export type SelectReview=(input:PreflightServiceInput,options?:PreflightOptions)=>Promise<SelectedReview>;
export function createAuthorizationPreflightService(configuration:Parameters<typeof createSubsetReviewService>[0]&Readonly<{rpc:PreflightRpc;enabled?:boolean}>):Readonly<{preflight(input:PreflightServiceInput,options?:PreflightOptions):Promise<PreflightResult>;select:SelectReview}>;
