import {captureClosureInput} from '../../../../packages/fiscal-authorization/src/closure-dto.mjs';
import type {ClosureInput,ClosureResult} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
import {bindReviewedAuthorizationResult,type DispatchResult,REVIEWED_AUTHORIZATION_BASE} from './fiscal-reviewed-authorization-model.ts';
import type {SignedCandidate} from './fiscal-signed-model.ts';
export type {ClosureInput,ClosureResult};
export function expiredClosureEligible(row:DispatchResult):boolean{
 const c=row.current;return Boolean(row.receipt&&c&&['prepared','request_ready'].includes(row.status)&&c.state===row.status&&c.lease_expired&&!c.grant_consumed&&c.used_at===null&&c.finished_at===null);
}
/** Call only after an explicit successful command GET, which proves ownership server-side. */
export function closureIntent(row:DispatchResult,candidate:SignedCandidate,commandId:string,confirmed:boolean):ClosureInput{
 bindReviewedAuthorizationResult(row,candidate);
 if(!confirmed||!row.read_only||!expiredClosureEligible(row))throw new Error('AUTHORIZATION_RESPONSE_INVALID');
 return captureClosureInput({command_id:commandId,authorization_command_id:row.command_id,expected_attempt_id:row.receipt!.attempt_id,expected_state:row.status,confirmed:true});
}
export function bindClosureResult(value:ClosureResult,body:ClosureInput,candidate:SignedCandidate,previous:ClosureResult|null=null,original:DispatchResult|null=null):ClosureResult{
 const r=value.receipt;
 if(original&&(r.origin!==original.receipt?.origin||r.policy_version!==original.receipt.policy_version||r.review_id!==(original.subset_review?.review_id??null)||Date.parse(r.lease_expired_at)!==Date.parse(original.current!.expires_at)))throw new Error('AUTHORIZATION_RESPONSE_INVALID');
 if(value.command_id!==body.command_id||r.command_id!==body.command_id||r.authorization_command_id!==body.authorization_command_id||r.attempt_id!==body.expected_attempt_id||r.previous_state!==body.expected_state||r.candidate_id!==candidate.candidate_id||r.signed_hash!==candidate.artifact?.sha256||r.model!==candidate.model||previous&&Object.entries(previous.receipt).some(([k,v])=>r[k as keyof typeof r]!==v))throw new Error('AUTHORIZATION_RESPONSE_INVALID');
 return value;
}
export const closureCommandPath=(body:ClosureInput)=>`${REVIEWED_AUTHORIZATION_BASE}/closure-commands/${body.command_id}`;
