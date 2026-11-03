/** Private069 contract. Not exported from the package index or a public runtime. */
export const SUBSET_LEDGER_PROFILE:'authorization-reviewed-ledger-v1';
export const SUBSET_COVERAGE:'listed_rules_only_not_full_tax_validation';
export const SUBSET_POLICY_HASHES:Readonly<{'55':string;'65':string}>;
export const REVIEW_KEYS:readonly string[];
export type SubsetReviewProof=Readonly<{
 candidate_id:string;candidate_version:number;signed_hash:string;facts_hash:string;profile:string;profile_hash:string;
 review_id:string;review_version:number;review_hash:string;reviewed_by:string;reviewed_at:string;valid_until:string;
 coverage:typeof SUBSET_COVERAGE;tax_rules_validated:false;
}>;
export type ObservationProof=Readonly<{sha256:string;size_bytes:number}>;
export type PrivateJson=Readonly<Record<string,unknown>>;
export type ReviewedAction='begin'|'prepare'|'use'|'finish'|'fail'|'command'|'history';
export function reviewProof(raw:unknown,expected?:Partial<SubsetReviewProof>):SubsetReviewProof;
export function checkReviewedContext(context:PrivateJson):void;
export function projectReviewedLedger(action:ReviewedAction,raw:unknown,args:PrivateJson):PrivateJson;
export function reviewedPreparationEvidence(raw:unknown,expected?:PrivateJson):PrivateJson;
