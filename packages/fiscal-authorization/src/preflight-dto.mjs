/** Closed, browser-safe072 metadata. No XML, credential or grant is projected. */
import {data,need,uuid,hash,version,timestamp,snapshot,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
import {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
import {ruleProfileByHash,RULE_PROFILE_V1_HASH,RULE_PROFILE_V2_HASH} from './rule-profile-registry.mjs';
import {evaluateNfceEmissionWindow} from './emission-window.mjs';
export const PREFLIGHT_PROFILE='authorization-reviewed-preflight-v1';
export const PREFLIGHT_V2_PROFILE='authorization-reviewed-preflight-v2';
export const PREFLIGHT_MAX_BYTES=32768;
const profiles={[PREFLIGHT_PROFILE]:RULE_PROFILE_V1_HASH,[PREFLIGHT_V2_PROFILE]:RULE_PROFILE_V2_HASH};
const PAIRS=Object.freeze({artifact_current:'CANDIDATE_NOT_CURRENT',identity_matches:'IDENTITY_MISMATCH',a1_usable:'A1_UNAVAILABLE',policy_matches:'REVIEWED_POLICY_MISMATCH',policy_enabled:'POLICY_DISABLED',policy_within_validity:'POLICY_TIME_INVALID',profile_within_validity:'PROFILE_TIME_INVALID',review_matches:'REVIEW_MISSING_OR_MISMATCHED',reviewer_active:'REVIEWER_INACTIVE',review_within_validity:'REVIEW_TIME_INVALID'});
const CHECKS=[...Object.keys(PAIRS),'submission_consumed','attempt_in_progress'];
const KEYS=[...Object.keys(FLAGS),'tax_rules_validated','preflight_profile','read_only','candidate','versions','policy','review','checks','blockers','observed_at'];
const exact=(v,keys)=>data(v,keys,[],502,'AUTHORIZATION_RESPONSE_INVALID'),check=v=>need(v,502,'AUTHORIZATION_RESPONSE_INVALID');
const nullableVersion=v=>v===null||version(v),label=v=>v===null||typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,120}$/.test(v);
const within=(at,from,until)=>Date.parse(at)>=Date.parse(from)&&Date.parse(at)<Date.parse(until);
export const EMISSION_WINDOW_BLOCKERS=Object.freeze({expired:'AUTHORIZATION_NFCE_EMISSION_EXPIRED',future:'AUTHORIZATION_NFCE_EMISSION_FUTURE',too_short:'AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT'});
const windowKeys=['issued_at','observed_at','expires_at','send_before','max_age_seconds','safety_margin_seconds','status'];
function emissionWindow(raw,model){
 if(model==='55'){check(raw===null);return null;}
 const w=exact(raw,windowKeys);check(timestamp(w.issued_at)&&timestamp(w.observed_at)&&w.safety_margin_seconds===30);
 let expected;try{expected=evaluateNfceEmissionWindow({model,environment:'2',emissionType:'1',issuedAt:w.issued_at,now:Date.parse(w.observed_at),safetyMarginMs:30000});}catch{check(false);}
 check(expected&&windowKeys.every(k=>w[k]===expected[k]));return expected;
}
export function capturePreflightInput(raw){const v=data(raw,['candidate_id','signed_hash']);need(uuid(v.candidate_id)&&hash(v.signed_hash));return freeze(v);}
export function projectPreflightSnapshot(raw,input){
 const q=capturePreflightInput(input),v=snapshot(exact(raw,KEYS));check(Object.entries(FLAGS).every(([k,x])=>v[k]===x)&&v.tax_rules_validated===false&&Object.hasOwn(profiles,v.preflight_profile)&&v.read_only===true&&timestamp(v.observed_at));
 const active=ruleProfileByHash(profiles[v.preflight_profile]);
 const c=exact(v.candidate,['candidate_id','candidate_version','model','signed_hash']);check(c.candidate_id===q.candidate_id&&c.signed_hash===q.signed_hash&&version(c.candidate_version)&&['55','65'].includes(c.model));
 const versions=exact(v.versions,['identity','a1','policy']);check(Object.values(versions).every(nullableVersion));
 let p=null,r=null;
 if(v.policy!==null){p=exact(v.policy,['authorization_profile','origin','enabled','binding_profile','rule_profile','binding_reviewed','tax_rules_reviewed','source_manifest_hash','valid_from','valid_until']);check(['legacy_v1','reviewed_subset_v1'].includes(p.authorization_profile)&&['synthetic','operational'].includes(p.origin)&&['enabled','binding_reviewed','tax_rules_reviewed'].every(k=>typeof p[k]==='boolean')&&label(p.binding_profile)&&label(p.rule_profile)&&(p.source_manifest_hash===null||hash(p.source_manifest_hash))&&timestamp(p.valid_from)&&timestamp(p.valid_until)&&Date.parse(p.valid_from)<Date.parse(p.valid_until));}
 check((p===null)===(versions.policy===null));
 if(v.review!==null){r=exact(v.review,['review_id','review_version','review_hash','candidate_version','signed_hash','facts_hash','profile_hash','reviewed_by','reviewed_at','valid_until']);check(uuid(r.review_id)&&uuid(r.reviewed_by)&&version(r.review_version)&&version(r.candidate_version)&&['review_hash','signed_hash','facts_hash','profile_hash'].every(k=>hash(r[k]))&&timestamp(r.reviewed_at)&&timestamp(r.valid_until)&&Date.parse(r.reviewed_at)<Date.parse(r.valid_until));}
 const checks=exact(v.checks,CHECKS);check(Object.values(checks).every(x=>typeof x==='boolean'));
 check(checks.policy_enabled===(p?.enabled??false)&&checks.policy_within_validity===(p!==null&&within(v.observed_at,p.valid_from,p.valid_until))&&checks.profile_within_validity===within(v.observed_at,active.validFrom,active.reviewBefore));
 check(checks.policy_matches===(p!==null&&p.authorization_profile==='reviewed_subset_v1'&&p.origin==='operational'&&!p.tax_rules_reviewed&&p.binding_reviewed&&p.binding_profile===`sp${c.model}-authorization-soap12-reviewed-20261016-v1`&&p.rule_profile===active.profile&&p.source_manifest_hash===active.policyHashes[c.model]));
 check(checks.review_within_validity===(r!==null&&within(v.observed_at,r.reviewed_at,r.valid_until)));
 if(checks.review_matches)check(r!==null&&r.candidate_version===c.candidate_version&&r.signed_hash===c.signed_hash&&r.profile_hash===active.profileHash);
 if(checks.reviewer_active)check(r!==null);if(checks.identity_matches)check(versions.identity!==null);if(checks.a1_usable)check(versions.identity!==null&&versions.a1!==null);
 const blockers=Object.entries(PAIRS).filter(([k])=>!checks[k]).map(([,code])=>code);if(checks.submission_consumed)blockers.push('SUBMISSION_ALREADY_CONSUMED');if(checks.attempt_in_progress)blockers.push('ATTEMPT_ALREADY_EXISTS');
 check(JSON.stringify(v.blockers)===JSON.stringify(blockers));
 const out={...v,candidate:c,versions,policy:p,review:r,checks,blockers};check(new TextEncoder().encode(JSON.stringify(out)).length<=PREFLIGHT_MAX_BYTES);return freeze(out);
}
export function preflightSelection(v){
 const c=v.candidate,r=v.review,n=v.versions;if(!r||!v.checks.review_matches||Object.values(n).some(x=>x===null))return null;
 return freeze({candidate_id:c.candidate_id,signed_hash:c.signed_hash,expected_candidate_version:c.candidate_version,expected_identity_version:n.identity,expected_a1_version:n.a1,expected_policy_version:n.policy,expected_review_id:r.review_id,expected_review_version:r.review_version,expected_review_hash:r.review_hash,expected_facts_hash:r.facts_hash,expected_profile_hash:r.profile_hash});
}
export function projectPreflightPublic(raw,input){
 const v=snapshot(exact(raw,[...KEYS,'evaluation','selection','runtime_enabled','can_run','emission_window']));check(Array.isArray(v.blockers));const base=projectPreflightSnapshot(Object.fromEntries(KEYS.map(k=>[k,k==='blockers'?v.blockers.filter(x=>!['RUNTIME_DISABLED','RULE_EVALUATION_PENDING',...Object.values(EMISSION_WINDOW_BLOCKERS)].includes(x)):v[k]])),input);
 const e=exact(snapshot(v.evaluation),['status','invalid_count','unsupported_count','pending_count']);check(['invalid_combinations','unsupported_scope','pending_classification','reviewed_subset'].includes(e.status)&&['invalid_count','unsupported_count','pending_count'].every(k=>Number.isSafeInteger(e[k])&&e[k]>=0&&e[k]<=4096));
 check(e.status===(e.invalid_count?'invalid_combinations':e.unsupported_count?'unsupported_scope':e.pending_count?'pending_classification':'reviewed_subset'));
 if(e.status==='reviewed_subset')check(base.review!==null&&base.checks.review_matches&&base.checks.reviewer_active&&base.checks.review_within_validity);
 const window=emissionWindow(v.emission_window,base.candidate.model);
 check(typeof v.runtime_enabled==='boolean');const blockers=[...base.blockers];if(e.status!=='reviewed_subset')blockers.push('RULE_EVALUATION_PENDING');if(window&&window.status!=='valid')blockers.push(EMISSION_WINDOW_BLOCKERS[window.status]);if(!v.runtime_enabled)blockers.push('RUNTIME_DISABLED');
 const selection=preflightSelection(base);if(selection===null)check(v.selection===null);else{const selected=exact(v.selection,Object.keys(selection));check(Object.entries(selection).every(([k,x])=>selected[k]===x));}check(JSON.stringify(v.blockers)===JSON.stringify(blockers)&&v.can_run===(blockers.length===0&&selection!==null));
 const out={...base,blockers,evaluation:e,selection,emission_window:window,runtime_enabled:v.runtime_enabled,can_run:v.can_run};check(new TextEncoder().encode(JSON.stringify(out)).length<=PREFLIGHT_MAX_BYTES);return freeze(out);
}
