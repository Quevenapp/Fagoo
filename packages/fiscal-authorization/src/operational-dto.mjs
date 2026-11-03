/** Local contract for the proposed068 subset-review ledger. Not a deployed RPC adapter. */
import {AUTHORIZATION_SOAP_MANIFEST_HASHES,reviewedAuthorizationBinding} from './authorization-soap-binding.mjs';
import {SP_CRT1_RULE_MANIFEST,SP_CRT1_RULE_MANIFEST_HASH} from './sp-crt1-rule-manifest.mjs';
import {data,need,id,sha,integer,freeze,hash} from './service-common.mjs';
import {projectResponse,same,stamp,result} from './service-dto.mjs';
export const SUBSET_LEDGER_PROFILE='authorization-subset-ledger-local-v1';
export const SUBSET_COVERAGE='listed_rules_only_not_full_tax_validation';
export const LOCAL_OPERATIONAL_FLAGS=Object.freeze({operational_binding_enabled:false,tax_rules_validated:false,sefaz_authorized:false});
export const SUBSET_POLICY_HASHES=Object.freeze(Object.fromEntries(['55','65'].map(model=>[model,hash(JSON.stringify([SUBSET_LEDGER_PROFILE,model,AUTHORIZATION_SOAP_MANIFEST_HASHES[model],SP_CRT1_RULE_MANIFEST_HASH]))])));
export const REVIEW_KEYS=Object.freeze(['candidate_id','candidate_version','signed_hash','facts_hash','profile','profile_hash','review_id','review_version','review_hash','reviewed_by','reviewed_at','valid_until','coverage','tax_rules_validated']);
export function reviewProof(raw,expected={}){
 const v=data(raw,REVIEW_KEYS,[],'AUTHORIZATION_SUBSET_REVIEW_INVALID');
 need(['candidate_id','review_id','reviewed_by'].every(k=>id(v[k]))&&['candidate_version','review_version'].every(k=>integer(v[k]))&&['signed_hash','facts_hash','profile_hash','review_hash'].every(k=>sha(v[k]))&&v.profile===SP_CRT1_RULE_MANIFEST.profile&&v.profile_hash===SP_CRT1_RULE_MANIFEST_HASH&&stamp(v.reviewed_at)&&stamp(v.valid_until)&&Date.parse(v.reviewed_at)<Date.parse(v.valid_until)&&v.coverage===SUBSET_COVERAGE&&v.tax_rules_validated===false,'AUTHORIZATION_SUBSET_REVIEW_INVALID');
 for(const [k,value]of Object.entries(expected))need(v[k]===value,'AUTHORIZATION_SUBSET_REVIEW_CHANGED');return freeze(v);
}
export function checkLocalContext(c){
 need(c.origin==='synthetic'&&c.binding_profile===reviewedAuthorizationBinding(c.model).profile&&c.rule_profile===SP_CRT1_RULE_MANIFEST.profile&&c.policy_manifest_hash===SUBSET_POLICY_HASHES[c.model],'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
}
function observation(raw,required){if(raw===null){need(!required,'AUTHORIZATION_JOURNAL_CONFLICT');return null;}const v=data(raw,['sha256','size_bytes']);need(required&&sha(v.sha256)&&integer(v.size_bytes,8192),'AUTHORIZATION_JOURNAL_CONFLICT');return freeze(v);}
const proofFor=(p,r)=>p===null?null:reviewProof(p,{candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash});
/** The authenticated backend port owns ACL, issuer and atomic review CAS. A hash is not authentication. */
export function projectSubsetLedger(action,raw,args){
 if(action==='history'){
  const x=data(raw,['ledger_profile','page','rule_reviews','observations']);need(x.ledger_profile===SUBSET_LEDGER_PROFILE&&Array.isArray(x.rule_reviews)&&Array.isArray(x.observations));
  const page=projectResponse('erp_fiscal_authorization_history',x.page,args);need(page.items.length===x.rule_reviews.length&&page.items.length===x.observations.length);
  return freeze({...page,items:page.items.map((v,i)=>{
   need(v.receipt.origin==='synthetic','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');const proof=proofFor(x.rule_reviews[i],v.receipt);
   need(proof!==null||['prepared','failed_before_dispatch'].includes(v.current.state),'AUTHORIZATION_SUBSET_REVIEW_INVALID');
   if(v.artifact)need(v.artifact.evidence.binding_profile===reviewedAuthorizationBinding(v.receipt.model).profile&&v.artifact.evidence.rule_profile===proof.profile,'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
   return{...v,rule_review:proof,observation:observation(x.observations[i],v.artifact!==null)};
  })});
 }
 const x=data(raw,['ledger_profile','view','rule_review','observation']);need(x.ledger_profile===SUBSET_LEDGER_PROFILE);
 const {p_rule_review,p_observation_hash,p_observation_size,...baseArgs}=args,v=projectResponse('erp_fiscal_authorization_'+action,x.view,baseArgs);
 const r=action==='use'?{...v.grant,candidate_version:p_rule_review?.candidate_version}:v.receipt;
 const proof=proofFor(x.rule_review,r);if(action==='use'||action==='prepare')need(proof!==null&&same(proof,reviewProof(p_rule_review)),'AUTHORIZATION_SUBSET_REVIEW_CHANGED');
 if(action!=='use'){checkLocalContext(v.recovery);need(proof!==null||['prepared','failed_before_dispatch'].includes(v.current.state),'AUTHORIZATION_SUBSET_REVIEW_INVALID');}
 else checkLocalContext(v.grant);
 const obs=observation(x.observation,action!=='use'&&v.artifact!==null);if(action==='finish')need(obs.sha256===p_observation_hash&&obs.size_bytes===p_observation_size,'AUTHORIZATION_JOURNAL_CONFLICT');
 return freeze({...v,rule_review:proof,observation:obs});
}
export function subsetResult(v,options={}){
 const p=v?.rule_review;
 return freeze({...result(v,options),...LOCAL_OPERATIONAL_FLAGS,observation:v?.observation??null,subset_review:p?{candidate_version:p.candidate_version,profile:p.profile,profile_hash:p.profile_hash,review_id:p.review_id,review_version:p.review_version,review_hash:p.review_hash,coverage:p.coverage,tax_rules_validated:false}:null});
}
