import type {SubsetReviewArgs,SubsetReviewRpcName,SubsetReviewView} from './subset-review-dto.mjs';
export {SubsetReviewError} from './subset-review-dto.mjs';
export const SUBSET_RPC_ENVELOPE_BYTES:294912;
export type SubsetReviewOptions=Readonly<{signal?:AbortSignal;deadline:number}>;
/** Private service-role RPC port. No environment or implicit fetch, public endpoint or fiscal transport. */
export type SubsetReviewRpc=(name:SubsetReviewRpcName,args:SubsetReviewArgs,options:SubsetReviewOptions)=>Promise<SubsetReviewView>;
export function createSubsetReviewRpc(configuration:Readonly<{projectUrl:string;supabaseDeployment?:'hosted'|'self-hosted';serviceKey:string;fetchImpl:typeof fetch}>):SubsetReviewRpc;
