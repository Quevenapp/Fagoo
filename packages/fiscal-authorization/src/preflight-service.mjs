/** Read-only072→050/068 bytes/evaluation→072. No mutation, grant, custody or transport port. */
import {createSubsetReviewService} from './subset-review-service.mjs';
import {data,need,id,sha,freeze,scope} from './service-common.mjs';
import {projectPreflightSnapshot,projectPreflightPublic,preflightSelection,EMISSION_WINDOW_BLOCKERS} from './preflight-dto.mjs';
import {evaluateNfceEmissionWindow} from './emission-window.mjs';
import {reviewProof} from './reviewed-ledger-dto.mjs';
const canonical=v=>JSON.stringify(sort(v));
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
const comparable=({observed_at,...v})=>canonical(v);
export function createAuthorizationPreflightService(configuration){
 const p=data(configuration,['rpc','signedRpc','reviewRpc','storage'],['enabled','profileHash']);need(typeof p.rpc==='function'&&(p.enabled===undefined||typeof p.enabled==='boolean'));
 const rpc=p.rpc,enabled=p.enabled===true,review=createSubsetReviewService({signedRpc:p.signedRpc,reviewRpc:p.reviewRpc,storage:p.storage,...(p.profileHash===undefined?{}:{profileHash:p.profileHash})});
 async function inspect(input,options={},selected=false){
  const x=data(input,['actor','candidateId','signedHash']);need(id(x.actor)&&id(x.candidateId)&&sha(x.signedHash));freeze(x);const q={candidate_id:x.candidateId,signed_hash:x.signedHash},s=scope(options);
  const read=async()=>{const v=await s.bounded(()=>rpc(x,{signal:s.signal,deadline:s.deadline}));s.check();return projectPreflightSnapshot(v,q);};
  try{
   const before=await read(),ctx=await review.context({actor:x.actor,candidateId:x.candidateId},{signal:s.signal,deadline:s.deadline}),after=await read();
   need(comparable(before)===comparable(after),'40001');const c=after.candidate,r=after.review,v=ctx.candidate;
   need(v.candidate_id===c.candidate_id&&v.candidate_version===c.candidate_version&&v.signed_hash===c.signed_hash&&v.model===c.model,'40001');
   const receipt=ctx.review.receipt;need((r===null)===(receipt===null),'40001');
   if(r)need(['review_id','review_version','review_hash','candidate_version','signed_hash','facts_hash','profile_hash','reviewed_by','reviewed_at','valid_until'].every(k=>k==='reviewed_at'||k==='valid_until'?Date.parse(r[k])===Date.parse(receipt[k]):r[k]===receipt[k]),'40001');
   if(ctx.report.status==='reviewed_subset')need(r!==null&&ctx.report.review?.id===r.review_id&&ctx.report.review?.version===r.review_version&&ctx.report.review?.hash===r.review_hash&&ctx.report.factsHash===r.facts_hash&&ctx.report.profileHash===r.profile_hash,'40001');
   const now=Date.now();if(after.checks.policy_within_validity)need(now<Date.parse(after.policy.valid_until),'40001');if(after.checks.review_within_validity)need(now<Date.parse(r.valid_until),'40001');if(after.checks.profile_within_validity)need(now<Date.parse('2026-10-26T00:00:00-03:00'),'40001');
   const evaluation={status:ctx.report.status,invalid_count:ctx.report.invalidCombinations.length,unsupported_count:ctx.report.unsupportedScope.length,pending_count:ctx.report.pendingClassification.length};
   const emissionWindow=evaluateNfceEmissionWindow({model:c.model,environment:ctx.facts.environment,emissionType:ctx.facts.ide.tpEmis,issuedAt:ctx.facts.ide.dhEmi,now,safetyMarginMs:30000});
   const blockers=[...after.blockers];if(evaluation.status!=='reviewed_subset')blockers.push('RULE_EVALUATION_PENDING');if(emissionWindow&&emissionWindow.status!=='valid')blockers.push(EMISSION_WINDOW_BLOCKERS[emissionWindow.status]);if(!enabled)blockers.push('RUNTIME_DISABLED');
   const selection=preflightSelection(after),out=projectPreflightPublic({...after,evaluation,blockers,selection,emission_window:emissionWindow,runtime_enabled:enabled,can_run:blockers.length===0&&selection!==null},q);s.check();
   if(!selected)return out;
   if(emissionWindow&&emissionWindow.status!=='valid')need(false,EMISSION_WINDOW_BLOCKERS[emissionWindow.status]);
   need(out.can_run,'40001');
   const proof=reviewProof({...r,reviewed_at:new Date(r.reviewed_at).toISOString(),valid_until:new Date(r.valid_until).toISOString(),candidate_id:c.candidate_id,profile:ctx.candidate.profile,coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false});
   s.check();return freeze({selection:out.selection,proof,emission_window:out.emission_window});
  }finally{s.close();}
 }
 return Object.freeze({preflight:(input,options)=>inspect(input,options),select:(input,options)=>inspect(input,options,true)});
}
