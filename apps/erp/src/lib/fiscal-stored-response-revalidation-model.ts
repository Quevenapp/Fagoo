import {captureRevalidationInput,projectRevalidationPublic,type RevalidationInput,type RevalidationContext,type RevalidationResult} from '../../../../packages/fiscal-authorization/src/revalidation-public-dto.mjs';
import {bindReviewedAuthorizationResult,type DispatchResult,REVIEWED_AUTHORIZATION_BASE as BASE} from './fiscal-reviewed-authorization-model.ts';
import type {SignedCandidate} from './fiscal-signed-model.ts';
export type {RevalidationInput,RevalidationContext,RevalidationResult};
const invalid=():never=>{throw new Error('AUTHORIZATION_RESPONSE_INVALID');};
/** This only offers a context read. Ownership and eligibility are determined by the server. */
export function revalidationContextAvailable(row:DispatchResult):boolean{
 return Boolean(row.receipt?.origin==='operational'&&row.status==='review_required'&&row.artifact?.outcome==='invalid_response'&&row.artifact.rejection_code==='SOAP_INVALID');
}
export const revalidationContextPath=(row:DispatchResult)=>`${BASE}/commands/${row.command_id}/revalidation-context/${row.receipt?.attempt_id}`;
export const revalidationCommandPath=(body:RevalidationInput)=>`${BASE}/revalidation-commands/${body.command_id}`;
function bindCandidate(r:{candidate_id:string;candidate_version:number;signed_hash:string;model:string},candidate:SignedCandidate){
 if(r.candidate_id!==candidate.candidate_id||r.candidate_version!==candidate.candidate_version||r.signed_hash!==candidate.artifact?.sha256||r.model!==candidate.model)invalid();
}
export function bindRevalidationContext(raw:unknown,candidate:SignedCandidate,original:DispatchResult):RevalidationContext{
 bindReviewedAuthorizationResult(original,candidate);if(!revalidationContextAvailable(original))invalid();
 const value=projectRevalidationPublic(raw,{action:'revalidationContext',authorizationCommandId:original.command_id,expectedAttemptId:original.receipt!.attempt_id});
 if(value.kind!=='context')return invalid();bindCandidate(value.candidate,candidate);
 if(value.original.response_hash!==original.artifact!.response_hash||value.original.response_size!==original.artifact!.response_size||Date.parse(value.original.recorded_at)!==Date.parse(original.artifact!.created_at))invalid();
 if(value.existing)bindRevalidationResult(value.existing,null,value,candidate);
 return value;
}
export function revalidationIntent(context:RevalidationContext,candidate:SignedCandidate,commandId:string,confirmed:boolean):RevalidationInput{
 bindCandidate(context.candidate,candidate);if(!confirmed||!context.can_revalidate||context.existing)invalid();
 return captureRevalidationInput({command_id:commandId,authorization_command_id:context.authorization_command_id,expected_attempt_id:context.attempt_id,expected_source_hash:context.source_hash,confirmed:true});
}
/** ACK and readback must keep the same historical source and the complete immutable receipt. */
export function bindRevalidationResult(raw:unknown,body:RevalidationInput|null,context:RevalidationContext,candidate:SignedCandidate,previous:RevalidationResult|null=null,reading=true):RevalidationResult{
 const commandId=body?.command_id??context.existing?.command_id;if(!commandId)return invalid();
 if(!reading&&!body)return invalid();
 const value=projectRevalidationPublic(raw,reading?{action:'revalidationCommand',commandId}:{action:'revalidationRun',commandId,input:body!});if(value.kind!=='result')return invalid();
 const r=value.receipt;bindCandidate(r,candidate);
 if(r.authorization_command_id!==context.authorization_command_id||r.attempt_id!==context.attempt_id||r.source_hash!==context.source_hash||r.parser_profile!==context.parser.profile||r.parser_manifest_hash!==context.parser.manifest_hash||r.artifact.response_hash!==context.original.response_hash||r.artifact.response_size!==context.original.response_size||previous&&JSON.stringify(previous.receipt)!==JSON.stringify(r))invalid();
 if(body&&(r.source_hash!==body.expected_source_hash||r.authorization_command_id!==body.authorization_command_id||r.attempt_id!==body.expected_attempt_id))invalid();
 return value;
}
