/** Browser-safe073 selection. It is a CAS request, never an approval or a review proof. */
import {data,need,uuid,hash,version,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
export const SELECTED_RUN_PROFILE='authorization-reviewed-selection-v1';
export const SELECTION_KEYS=Object.freeze(['candidate_id','signed_hash','expected_candidate_version','expected_identity_version','expected_a1_version','expected_policy_version','expected_review_id','expected_review_version','expected_review_hash','expected_facts_hash','expected_profile_hash']);
export function captureReviewedSelection(value){
 const v=data(value,SELECTION_KEYS);need(uuid(v.candidate_id)&&uuid(v.expected_review_id)&&['signed_hash','expected_review_hash','expected_facts_hash','expected_profile_hash'].every(k=>hash(v[k]))&&['expected_candidate_version','expected_identity_version','expected_a1_version','expected_policy_version','expected_review_version'].every(k=>version(v[k])));return freeze(v);
}
export function captureSelectedRun(value){
 const v=data(value,['request_profile','command_id',...SELECTION_KEYS,'confirmed']);need(v.request_profile===SELECTED_RUN_PROFILE&&uuid(v.command_id)&&v.confirmed===true);captureReviewedSelection(Object.fromEntries(SELECTION_KEYS.map(k=>[k,v[k]])));return freeze(v);
}
