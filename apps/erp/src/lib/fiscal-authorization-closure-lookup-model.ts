import {captureClosureLookupInput,projectClosureLookupPublic,type ClosureLookupInput} from '../../../../packages/fiscal-authorization/src/closure-lookup-dto.mjs';
import type {ClosureResult} from '../../../../packages/fiscal-authorization/src/closure-dto.mjs';
import {bindReviewedAuthorizationResult,REVIEWED_AUTHORIZATION_BASE,type DispatchResult} from './fiscal-reviewed-authorization-model.ts';
import type {SignedCandidate} from './fiscal-signed-model.ts';
export type {ClosureLookupInput,ClosureResult};
/** A terminal failure alone does not prove that074 recorded a closure. Query explicitly. */
export function closureLookupEligible(row:DispatchResult):boolean{
 return Boolean(row.receipt&&row.current&&row.status==='failed_before_dispatch'&&row.current.state===row.status&&!row.current.grant_consumed&&row.current.used_at===null&&row.current.finished_at!==null);
}
export function closureLookupInput(row:DispatchResult,candidate:SignedCandidate):ClosureLookupInput{
 bindReviewedAuthorizationResult(row,candidate);if(!closureLookupEligible(row))throw new Error('AUTHORIZATION_RESPONSE_INVALID');
 return captureClosureLookupInput({authorization_command_id:row.command_id,expected_attempt_id:row.receipt!.attempt_id});
}
export const closureLookupPath=(input:ClosureLookupInput)=>{const q=captureClosureLookupInput(input);return`${REVIEWED_AUTHORIZATION_BASE}/commands/${q.authorization_command_id}/attempts/${q.expected_attempt_id}/closure`;};
export function bindClosureLookupResult(raw:unknown,input:ClosureLookupInput,candidate:SignedCandidate,original:DispatchResult):ClosureResult{
 const expected=closureLookupInput(original,candidate),value=projectClosureLookupPublic(raw,input),r=value.receipt;
 if(expected.authorization_command_id!==input.authorization_command_id||expected.expected_attempt_id!==input.expected_attempt_id||r.candidate_id!==candidate.candidate_id||r.signed_hash!==candidate.artifact?.sha256||r.model!==candidate.model||r.origin!==original.receipt!.origin||r.policy_version!==original.receipt!.policy_version||r.review_id!==(original.subset_review?.review_id??null)||Date.parse(r.lease_expired_at)!==Date.parse(original.current!.expires_at)||Date.parse(r.closed_at)!==Date.parse(original.current!.finished_at!))throw new Error('AUTHORIZATION_RESPONSE_INVALID');
 return value;
}
