import './helpers/synthetic-october-clock.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {subsetReviewQaContext} from '../src/qa/subset-review-fixture.ts';
import {reviewedQaPreflight} from '../src/qa/reviewed-authorization-fixture.ts';
import {authorizationQaCandidate} from '../src/qa/authorization-fixture.ts';
import {captureSubsetReviewRequest,subsetReviewResponse,subsetReviewInitialValues} from '../src/lib/fiscal-subset-review-model.ts';
import {captureReviewedAuthorizationRequest,reviewedAuthorizationResponse,reviewedAuthorizationRun} from '../src/lib/fiscal-reviewed-authorization-model.ts';
import {RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH,ruleProfileByHash} from '../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
const B='/v1/fiscal-authorization',clone=structuredClone;
const readContext=value=>subsetReviewResponse(value,captureSubsetReviewRequest(`${B}/candidates/${value.candidate.candidate_id}/review`));

test('077 previous declaration is immutable history; form reset does not change CAS head or source facts',()=>{
 for(const model of ['55','65']){const raw=subsetReviewQaContext(model,true),checked=readContext(raw),before=clone(checked),form=subsetReviewInitialValues(checked);assert.equal(checked.review.receipt.profile_hash,RULE_PROFILE_V1_HASH);assert.equal(checked.candidate.profile_hash,RULE_PROFILE_V2_HASH);assert.equal(checked.report.review,null);assert.equal(checked.report.status,'pending_classification');assert.equal(form.validUntil,null);assert.ok(Object.values(form.choices.document).every(v=>v==='unreviewed'));assert.equal(form.choices.items[0].credit,null);form.choices.document.operation='outside_scope';assert.deepEqual(checked,before);assert.equal(checked.review.current.latest_review_version,2);assert.ok(Object.isFrozen(checked.review.declaration));}
});

test('077 matching receipt may populate a detached form, but mismatched evidence can never satisfy the current report',()=>{
 const current=clone(subsetReviewQaContext('55',true));Object.assign(current.review.receipt,{profile:current.candidate.profile,profile_hash:current.candidate.profile_hash});current.review.matches_profile=true;const checked=readContext(current),form=subsetReviewInitialValues(checked);assert.equal(form.validUntil,checked.review.receipt.valid_until);assert.deepEqual(form.choices,checked.review.declaration);form.choices.items[0].classification='outside_scope';assert.equal(checked.review.declaration.items[0].classification,'reviewed_physical_goods');
 for(const mutate of [v=>v.review.matches_profile=true,v=>{v.report.review={id:v.review.receipt.review_id,version:v.review.receipt.review_version,hash:v.review.receipt.review_hash};v.report.pendingClassification=[];v.report.status='reviewed_subset';},v=>v.review.receipt.profile_hash=v.candidate.profile_hash,v=>v.candidate.profile_hash='a'.repeat(64)]){const bad=clone(subsetReviewQaContext('55',true));mutate(bad);assert.throws(()=>readContext(bad));}
});

test('077 old command projection stays readable without rewriting the captured profile or declaration',()=>{
 for(const model of ['55','65']){const c=subsetReviewQaContext(model,true),{kind,read_only,candidate,facts,labels,source_current,review,report,save_available,save_blockers,...flags}=c,raw={...flags,kind:'command',read_only:true,command_id:review.receipt.command_id,replayed:false,receipt:review.receipt,current:review.current,declaration:review.declaration},selected=captureSubsetReviewRequest(`${B}/review-commands/${raw.command_id}`),value=subsetReviewResponse(raw,selected);assert.equal(value.receipt.profile_hash,RULE_PROFILE_V1_HASH);assert.deepEqual(value.declaration,review.declaration);assert.equal(value.tax_rules_validated,false);assert.equal(value.can_transmit,false);const invalid=clone(raw);invalid.receipt.profile=ruleProfileByHash(RULE_PROFILE_V2_HASH).profile;assert.throws(()=>subsetReviewResponse(invalid,selected));}
});

test('077 preflight v1/v2 preserve their exact rule and policy identities; swapped envelope/profile fails closed',()=>{
 for(const model of ['55','65'])for(const version of [1,2]){const c=authorizationQaCandidate(model),value=reviewedQaPreflight(c,{enabled:true}),profile=ruleProfileByHash(version===1?RULE_PROFILE_V1_HASH:RULE_PROFILE_V2_HASH);value.preflight_profile=`authorization-reviewed-preflight-v${version}`;value.policy.rule_profile=profile.profile;value.policy.source_manifest_hash=profile.policyHashes[model];value.review.profile_hash=profile.profileHash;value.selection.expected_profile_hash=profile.profileHash;
  const request=captureReviewedAuthorizationRequest(B+'/reviewed/preflight',{method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}}),checked=reviewedAuthorizationResponse(value,request),body=reviewedAuthorizationRun(checked,c,true,'a7700000-0000-4000-8000-000000000099');assert.equal(body.expected_profile_hash,profile.profileHash);assert.equal(checked.tax_rules_validated,false);assert.equal(checked.can_transmit,false);
  for(const mutate of [v=>v.preflight_profile=`authorization-reviewed-preflight-v${version===1?2:1}`,v=>v.selection.expected_profile_hash='a'.repeat(64),v=>v.policy.source_manifest_hash='f'.repeat(64)]){const bad=clone(value);mutate(bad);assert.throws(()=>reviewedAuthorizationResponse(bad,request));}
 }
});

test('synthetic October clock does not relax expired fiscal policy/profile checks',()=>{
 const c=authorizationQaCandidate('55'),value=reviewedQaPreflight(c,{enabled:true});
 value.observed_at='2026-11-02T15:00:00.000Z';
 const request=captureReviewedAuthorizationRequest(B+'/reviewed/preflight',{method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact.sha256}});
 assert.throws(()=>reviewedAuthorizationResponse(value,request),error=>error.code==='AUTHORIZATION_RESPONSE_INVALID');
});
