/** Private069 projection. Neither an operational service nor a public/browser contract. */
import {AUTHORIZATION_SOAP_MANIFEST_HASHES,reviewedAuthorizationBinding} from './authorization-soap-binding.mjs';
import {ruleProfileByName,matchesRuleProfile,RULE_PROFILES,RULE_PROFILE_V1_HASH,ruleProfileByHash} from './rule-profile-registry.mjs';
import {data,need,id,sha,integer,freeze,hash} from './service-common.mjs';
import {projectResponse,same,stamp} from './service-dto.mjs';
export const SUBSET_LEDGER_PROFILE='authorization-reviewed-ledger-v1';
export const SUBSET_COVERAGE='listed_rules_only_not_full_tax_validation';
export const SUBSET_POLICY_HASHES=ruleProfileByHash(RULE_PROFILE_V1_HASH).policyHashes;
for(const p of RULE_PROFILES)for(const model of ['55','65'])need(p.policyHashes[model]===hash(JSON.stringify([SUBSET_LEDGER_PROFILE,model,AUTHORIZATION_SOAP_MANIFEST_HASHES[model],p.profileHash])),'AUTHORIZATION_PROFILE_PIN_MISMATCH');
export const REVIEW_KEYS=Object.freeze(['candidate_id','candidate_version','signed_hash','facts_hash','profile','profile_hash','review_id','review_version','review_hash','reviewed_by','reviewed_at','valid_until','coverage','tax_rules_validated']);
export function reviewProof(raw,expected={}){
 const v=data(raw,REVIEW_KEYS,[],'AUTHORIZATION_SUBSET_REVIEW_INVALID');
 need(['candidate_id','review_id','reviewed_by'].every(k=>id(v[k]))&&['candidate_version','review_version'].every(k=>integer(v[k]))&&['signed_hash','facts_hash','profile_hash','review_hash'].every(k=>sha(v[k]))&&matchesRuleProfile(v.profile,v.profile_hash)&&stamp(v.reviewed_at)&&stamp(v.valid_until)&&Date.parse(v.reviewed_at)<Date.parse(v.valid_until)&&v.coverage===SUBSET_COVERAGE&&v.tax_rules_validated===false,'AUTHORIZATION_SUBSET_REVIEW_INVALID');
 for(const [k,value]of Object.entries(expected))need(v[k]===value,'AUTHORIZATION_SUBSET_REVIEW_CHANGED');return freeze(v);
}
export function checkReviewedContext(c){
 need(['synthetic','operational'].includes(c.origin)&&c.binding_profile===reviewedAuthorizationBinding(c.model).profile&&ruleProfileByName(c.rule_profile)!==null&&c.policy_manifest_hash===ruleProfileByName(c.rule_profile).policyHashes[c.model],'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
}
function observation(raw,required){if(raw===null){need(!required,'AUTHORIZATION_JOURNAL_CONFLICT');return null;}const v=data(raw,['sha256','size_bytes']);need(required&&sha(v.sha256)&&integer(v.size_bytes,8192),'AUTHORIZATION_JOURNAL_CONFLICT');return freeze(v);}
const proofFor=(p,r)=>p===null?null:reviewProof(p,{candidate_id:r.candidate_id,candidate_version:r.candidate_version,signed_hash:r.signed_hash});
/** The authenticated backend port owns ACL, issuer and atomic review CAS. A hash is not authentication. */
export function projectReviewedLedger(action,raw,args){
 if(action==='history'){
  const x=data(raw,['ledger_profile','page','rule_reviews','observations']);need(x.ledger_profile===SUBSET_LEDGER_PROFILE&&Array.isArray(x.rule_reviews)&&Array.isArray(x.observations));
  const page=projectResponse('erp_fiscal_authorization_history',x.page,args);need(page.items.length===x.rule_reviews.length&&page.items.length===x.observations.length);
  return freeze({...page,items:page.items.map((v,i)=>{
   const proof=proofFor(x.rule_reviews[i],v.receipt);
   need(proof!==null||['prepared','failed_before_dispatch'].includes(v.current.state),'AUTHORIZATION_SUBSET_REVIEW_INVALID');
   if(v.artifact)need(v.artifact.evidence.binding_profile===reviewedAuthorizationBinding(v.receipt.model).profile&&v.artifact.evidence.rule_profile===proof.profile,'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
   const obs=observation(x.observations[i],v.artifact!==null);if(v.artifact?.evidence.origin==='operational')need(v.artifact.evidence.transport_hash===obs.sha256&&v.artifact.evidence.transport_size===obs.size_bytes,'AUTHORIZATION_JOURNAL_CONFLICT');
   return{...v,rule_review:proof,observation:obs};
  })});
 }
 const x=data(raw,['ledger_profile','view','rule_review','observation']);need(x.ledger_profile===SUBSET_LEDGER_PROFILE);
 const {p_rule_review,p_observation_hash,p_observation_size,...baseArgs}=args,v=projectResponse('erp_fiscal_authorization_'+action,x.view,baseArgs);
 const r=action==='use'?{...v.grant,candidate_version:p_rule_review?.candidate_version}:v.receipt;
 const proof=proofFor(x.rule_review,r);if(action==='use'||action==='prepare')need(proof!==null&&same(proof,reviewProof(p_rule_review)),'AUTHORIZATION_SUBSET_REVIEW_CHANGED');
 if(action!=='use'){checkReviewedContext(v.recovery);need(proof!==null||['prepared','failed_before_dispatch'].includes(v.current.state),'AUTHORIZATION_SUBSET_REVIEW_INVALID');}
 else checkReviewedContext(v.grant);
 const obs=observation(x.observation,action!=='use'&&v.artifact!==null);
 if(v.artifact?.evidence.origin==='operational')need(v.artifact.evidence.transport_hash===obs.sha256&&v.artifact.evidence.transport_size===obs.size_bytes,'AUTHORIZATION_JOURNAL_CONFLICT');if(action==='finish')need(obs.sha256===p_observation_hash&&obs.size_bytes===p_observation_size,'AUTHORIZATION_JOURNAL_CONFLICT');
 return freeze({...v,rule_review:proof,observation:obs});
}

/** Backend attestation from the pinned validator + rule gate. A saved human review alone is not a passing evaluation. */
export function reviewedPreparationEvidence(raw,expected={}){
 const v=data(raw,['origin','request_hash','payload_hash','signed_hash','model','environment','batch_id','access_key','reference_digest','certificate_fingerprint','schema_profile','schema_manifest_hash','validator_hash','binding_profile','rule_profile','signature_verified','xsd_validated','context_matched','tax_rules_validated','can_emit','can_transmit']);
 need(['synthetic','operational'].includes(v.origin)&&['55','65'].includes(v.model)&&['request_hash','payload_hash','signed_hash','certificate_fingerprint'].every(k=>sha(v[k]))&&v.environment==='2'&&typeof v.batch_id==='string'&&/^[1-9]\d{0,14}$/.test(v.batch_id)&&typeof v.access_key==='string'&&/^\d{6}[A-Z0-9]{12}\d{26}$/.test(v.access_key)&&typeof v.reference_digest==='string'&&/^[A-Za-z0-9+/]{27}=$/.test(v.reference_digest)&&Buffer.from(v.reference_digest,'base64').toString('base64')===v.reference_digest);
 need(v.schema_profile==='fagoo-authorization-pl010f-v1.04'&&v.schema_manifest_hash==='4870615c92cc8425a15ff5b1fe764d3c896c458cdbe46f9d550e18fb608c8605'&&v.validator_hash==='55fa80c35bc18f3340ac9cdb7be339205c491f54ba12ce465a890acb8e8d5a02'&&v.binding_profile===reviewedAuthorizationBinding(v.model).profile&&ruleProfileByName(v.rule_profile)!==null&&v.signature_verified===true&&v.xsd_validated===true&&v.context_matched===true&&v.tax_rules_validated===false&&v.can_emit===false&&v.can_transmit===false);
 for(const[k,x]of Object.entries(expected))need(v[k]===x);return freeze(v);
}
