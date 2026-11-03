/** Authenticated backend review is mandatory. Browser attestations are not an input. */
import {inspectSpCrt1Candidate,createSpCrt1ReviewReader,evaluateSpCrt1Rules,assertSpCrt1RuleReport} from './sp-crt1-rule-profile.mjs';
import {data,need,id,integer,copy,freeze,scope,AuthorizationServiceError} from './service-common.mjs';
import {reviewProof,SUBSET_COVERAGE} from './operational-dto.mjs';
export function createAuthorizationRuleGate(configuration){
 const p=data(configuration,['readReview']);need(typeof p.readReview==='function');const readReview=p.readReview;
 return async function inspect(input,options={}){
  const x=data(input,['actor','candidateId','candidateVersion','request']);need(id(x.actor)&&id(x.candidateId)&&integer(x.candidateVersion));
  const candidate=inspectSpCrt1Candidate({candidateId:x.candidateId,request:x.request}),s=scope(options);let captured=null;
  try{
   const reader=createSpCrt1ReviewReader({readReview:async(query,opts)=>{
    // Candidate version and actor are authenticated outside the old review record.
    const raw=await s.bounded(()=>readReview(freeze({...query,actor:x.actor,candidateVersion:x.candidateVersion}),opts));
    if(raw===null)return null;const bytes=copy(raw,131072);try{captured=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));return new Uint8Array(bytes);}finally{bytes.fill(0);}
   }});
   const evidence=await reader({candidate,now:new Date(),signal:s.signal,deadline:s.deadline});s.check();
   const report=assertSpCrt1RuleReport(evaluateSpCrt1Rules({candidate,reviewEvidence:evidence,now:new Date()}),candidate);
   need(report.status==='reviewed_subset'&&evidence&&captured,'AUTHORIZATION_SUBSET_REVIEW_PENDING');
   const proof=reviewProof({candidate_id:x.candidateId,candidate_version:x.candidateVersion,signed_hash:candidate.signedHash,facts_hash:candidate.factsHash,
    profile:candidate.profile,profile_hash:candidate.profileHash,review_id:evidence.id,review_version:evidence.version,review_hash:evidence.reviewHash,
    reviewed_by:captured.reviewed_by,reviewed_at:evidence.reviewedAt,valid_until:evidence.validUntil,coverage:SUBSET_COVERAGE,tax_rules_validated:false});
   s.check();return freeze({proof,report});
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_SUBSET_REVIEW_INVALID');}
  finally{captured=null;s.close();}
 };
}
