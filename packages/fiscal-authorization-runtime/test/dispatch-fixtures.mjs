import {runBody as legacyRunBody} from './fixtures.mjs';
import {randomUUID} from 'node:crypto';
import {result as legacyResult,history as legacyHistory} from '../../fiscal-authorization-http/test/fixtures.mjs';
import {DISPATCH_PROFILE} from '../src/dispatch-protocol.mjs';
import {REVIEW_PROFILE,REVIEW_PROFILE_HASH} from '../src/review-protocol.mjs';
import {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
export const selectedRunBody={...legacyRunBody,request_profile:'authorization-reviewed-selection-v1',expected_candidate_version:1,expected_review_id:'d0000000-0000-4000-8000-000000000001',expected_review_version:1,expected_review_hash:'2'.repeat(64),expected_facts_hash:'3'.repeat(64),expected_profile_hash:REVIEW_PROFILE_HASH};
export function dispatchResult(options={}){
 const v=legacyResult(options);v.receipt.origin='operational';if(v.artifact)v.artifact.tls_origin_verified=true;
 return{...v,tax_rules_validated:false,dispatch_profile:DISPATCH_PROFILE,authorized_in_homologation:v.status==='authorized_homologation',observation:v.artifact?{sha256:'1'.repeat(64),size_bytes:1500}:null,subset_review:v.status==='prepared'?null:{candidate_version:v.receipt.candidate_version,profile:REVIEW_PROFILE,profile_hash:REVIEW_PROFILE_HASH,review_id:selectedRunBody.expected_review_id,review_version:1,review_hash:'2'.repeat(64),coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false}};
}
export const dispatchHistory=(items=[],limit=25)=>({...legacyHistory(items,limit),tax_rules_validated:false});
// Historical synthetic snapshot: this profile was valid in October 2026.
// HMAC request freshness still uses the real advancing test clock.
const preflightObservedAt='2026-10-20T15:00:00.000Z';
export function dispatchPreflight(){return{...FLAGS,tax_rules_validated:false,preflight_profile:'authorization-reviewed-preflight-v1',read_only:true,candidate:{candidate_id:selectedRunBody.candidate_id,candidate_version:1,model:'55',signed_hash:selectedRunBody.signed_hash},versions:{identity:1,a1:2,policy:null},policy:null,review:null,checks:{artifact_current:true,identity_matches:true,a1_usable:true,policy_matches:false,policy_enabled:false,policy_within_validity:false,profile_within_validity:true,review_matches:false,reviewer_active:false,review_within_validity:false,submission_consumed:false,attempt_in_progress:false},blockers:['REVIEWED_POLICY_MISMATCH','POLICY_DISABLED','POLICY_TIME_INVALID','REVIEW_MISSING_OR_MISMATCHED','REVIEWER_INACTIVE','REVIEW_TIME_INVALID','RULE_EVALUATION_PENDING','RUNTIME_DISABLED'],observed_at:preflightObservedAt,emission_window:null,evaluation:{status:'pending_classification',invalid_count:0,unsupported_count:0,pending_count:1},selection:null,runtime_enabled:false,can_run:false};}
export function dispatchService(overrides={}){return{preflight:async()=>dispatchPreflight(),runReviewed:overrides.run??(async()=>dispatchResult({state:'authorized_homologation',reading:false})),run:async()=>dispatchResult({state:'authorized_homologation',reading:false}),recover:async()=>dispatchResult({state:'authorized_homologation',reading:false}),command:async()=>dispatchResult(),history:async()=>dispatchHistory(),...overrides};}
