import type {SpCrt1ReviewQuery} from './sp-crt1-rule-profile.mjs';
import type {SubsetReviewRpc} from './subset-review-rpc.mjs';
/** Authenticated actor/version are supplied by the backend, never taken from browser attestations. */
export type PersistedSubsetReviewQuery=SpCrt1ReviewQuery&Readonly<{actor:string;candidateVersion:number}>;
export type PersistedSubsetReviewReader=(query:PersistedSubsetReviewQuery,options:Readonly<{signal:AbortSignal;deadline:number;maxBytes:number}>)=>Promise<Uint8Array|null>;
export function createPersistedSubsetReviewReader(configuration:Readonly<{rpc:SubsetReviewRpc}>):PersistedSubsetReviewReader;
