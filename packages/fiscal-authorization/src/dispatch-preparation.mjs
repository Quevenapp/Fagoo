/** Reauthorizes the existing preparation before any vault object is read. */
import {data,need,freeze,scope} from './service-common.mjs';
import {same} from './service-dto.mjs';
import {reviewProof} from './reviewed-ledger-dto.mjs';
import {checkDispatchContext,projectDispatchLedger} from './dispatch-dto.mjs';
import {createReviewedRuleGate} from './reviewed-rule-gate.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {hash} from './service-common.mjs';
import {authorizationRequestEmission} from './request-emission.mjs';
import {requireNfceEmissionWindow} from './emission-window.mjs';
export function captureDispatchPreparation(input){
 const x=data(input,['actor','execution','context','rule_review','request']),c=checkDispatchContext(x.context),e=checkDispatchContext(x.execution);
 const p=reviewProof(x.rule_review,{candidate_id:c.candidate_id,signed_hash:c.signed_hash});
 need(x.actor===c.actor&&same(c,e)&&c.request_hash!==null,'AUTHORIZATION_PREPARATION_CHANGED');
 const bytes=encodeReviewedAuthorizationSoap(prepareReviewedAuthorizationSoap({request:x.request}));
 try{need(hash(bytes)===c.request_hash&&bytes.length===c.request_size&&x.request.signedHash===c.signed_hash,'AUTHORIZATION_PREPARATION_CHANGED');}finally{bytes.fill(0);}
 return Object.freeze({actor:x.actor,execution:e,context:c,rule_review:p,request:x.request});
}
export function createAuthorizationPreparationAuthorizer(configuration){
 const p=data(configuration,['rpc','readReview']);need(typeof p.rpc==='function'&&typeof p.readReview==='function');
 const rpc=p.rpc,gate=createReviewedRuleGate({readReview:p.readReview});
 return async function authorizePreparation(input,options){
  const v=captureDispatchPreparation(input),c=v.context,s=scope(options,20000);
  try{
   const emission=authorizationRequestEmission(v.request);requireNfceEmissionWindow({...emission,now:Date.now(),safetyMarginMs:30000});
   const args=freeze({p_user_id:v.actor,p_command_id:c.command_id,p_candidate_id:c.candidate_id,p_signed_hash:c.signed_hash,p_expected_identity_version:c.identity_version,p_expected_a1_version:c.a1_version,p_expected_policy_version:c.policy_version,p_confirmed:true});
   const fresh=projectDispatchLedger('begin',await s.bounded(()=>rpc('erp_fiscal_reviewed_authorization_begin',args,{signal:s.signal,deadline:s.deadline})),args);
   need(fresh.current.state==='request_ready'&&!fresh.current.grant_consumed&&same(fresh.execution,c)&&same(fresh.rule_review,v.rule_review),'AUTHORIZATION_PREPARATION_CHANGED');
   const checked=await gate({actor:v.actor,candidateId:c.candidate_id,candidateVersion:v.rule_review.candidate_version,request:v.request,ruleProfile:c.rule_profile},{signal:s.signal,deadline:s.deadline});
   need(same(checked.proof,v.rule_review),'AUTHORIZATION_SUBSET_REVIEW_CHANGED');s.check();requireNfceEmissionWindow({...emission,now:Date.now(),safetyMarginMs:30000});return fresh.execution;
  }finally{s.stop('AUTHORIZATION_SERVICE_ABORTED');s.close();}
 };
}
