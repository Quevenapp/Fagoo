import {evaluateNfceEmissionWindow} from '../../../../packages/fiscal-authorization/src/emission-window.mjs';
import {EMISSION_WINDOW_BLOCKERS} from '../../../../packages/fiscal-authorization/src/preflight-dto.mjs';
import {revalidationQaOriginal,revalidationQaContext,revalidationQaResult} from './revalidation-fixture.ts';
import type {RevalidationInput} from '../../../../packages/fiscal-authorization/src/revalidation-public-dto.mjs';
/** Developer-only synthetic069 results. No transport fallback, A1, signing or SEFAZ. */
import {FLAGS,type DispatchResult,type DispatchHistory,type DispatchStatus,type PreflightResult,type DispatchRunInput,type ClosureInput,type ClosureResult} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
import {REVIEW_PROFILE,REVIEW_PROFILE_HASH} from '../../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
import {ruleProfileByHash} from '../../../../packages/fiscal-authorization/src/rule-profile-registry.mjs';
import {authorizationQaCandidate,authorizationQaResult,AUTHORIZATION_QA_ACTOR} from './authorization-fixture.ts';
import {captureReviewedAuthorizationRequest} from '../lib/fiscal-reviewed-authorization-model.ts';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
export const REVIEWED_QA_ORIGIN='https://reviewed.qa.invalid',REVIEWED_QA_API='https://erp.reviewed.qa.invalid';
export {AUTHORIZATION_QA_ACTOR as REVIEWED_QA_ACTOR,authorizationQaCandidate as reviewedQaCandidate};
export function reviewedQaStatus():DispatchStatus{return {...FLAGS,tax_rules_validated:false,dispatch_profile:'authorization-reviewed-dispatch-v1',read_only:true,runtime_enabled:false,policy_checked:false};}
export function reviewedQaPreflight(c:SignedCandidate,{enabled=false,consumed=false,issuedAt=new Date(Date.now()-60000).toISOString()}={}):PreflightResult{
 const now=Date.now(),emission=evaluateNfceEmissionWindow({model:c.model,environment:'2',emissionType:'1',issuedAt,now,safetyMarginMs:30000});
 const review={review_id:'a6900000-0000-4000-8000-000000000001',review_version:1,review_hash:'2'.repeat(64),candidate_version:c.candidate_version,signed_hash:c.artifact!.sha256,facts_hash:'3'.repeat(64),profile_hash:REVIEW_PROFILE_HASH,reviewed_by:AUTHORIZATION_QA_ACTOR,reviewed_at:'2026-10-16T03:00:00.000Z',valid_until:'2026-10-26T03:00:00.000Z'};
 return {...FLAGS,tax_rules_validated:false,preflight_profile:'authorization-reviewed-preflight-v2',read_only:true,candidate:{candidate_id:c.candidate_id,candidate_version:c.candidate_version,model:c.model,signed_hash:c.artifact!.sha256},versions:{identity:1,a1:2,policy:1},policy:{authorization_profile:'reviewed_subset_v1',origin:'operational',enabled,binding_profile:`sp${c.model}-authorization-soap12-reviewed-20261016-v1`,rule_profile:REVIEW_PROFILE,binding_reviewed:true,tax_rules_reviewed:false,source_manifest_hash:ruleProfileByHash(REVIEW_PROFILE_HASH)!.policyHashes[c.model],valid_from:'2026-10-16T03:00:00.000Z',valid_until:'2026-10-26T03:00:00.000Z'},review,checks:{artifact_current:true,identity_matches:true,a1_usable:true,policy_matches:true,policy_enabled:enabled,policy_within_validity:true,profile_within_validity:true,review_matches:true,reviewer_active:true,review_within_validity:true,submission_consumed:consumed,attempt_in_progress:false},blockers:[...(!enabled?['POLICY_DISABLED']:[]),...(consumed?['SUBMISSION_ALREADY_CONSUMED']:[]),...(emission&&emission.status!=='valid'?[EMISSION_WINDOW_BLOCKERS[emission.status]]:[]),...(!enabled?['RUNTIME_DISABLED']:[])],observed_at:new Date(now).toISOString(),evaluation:{status:'reviewed_subset',invalid_count:0,unsupported_count:0,pending_count:0},selection:{candidate_id:c.candidate_id,signed_hash:c.artifact!.sha256,expected_candidate_version:c.candidate_version,expected_identity_version:1,expected_a1_version:2,expected_policy_version:1,expected_review_id:review.review_id,expected_review_version:review.review_version,expected_review_hash:review.review_hash,expected_facts_hash:review.facts_hash,expected_profile_hash:review.profile_hash},emission_window:emission,runtime_enabled:enabled,can_run:enabled&&!consumed&&(!emission||emission.status==='valid')};
}
export function reviewedQaRunResult(c:SignedCandidate,body:DispatchRunInput,reading=true):DispatchResult{
 const v=reviewedQaResult(c,true,'3',reading);v.command_id=body.command_id;Object.assign(v.receipt!,{command_id:body.command_id,attempt_id:body.command_id,identity_version:body.expected_identity_version,a1_version:body.expected_a1_version,policy_version:body.expected_policy_version});Object.assign(v.subset_review!,{review_id:body.expected_review_id,review_version:body.expected_review_version,review_hash:body.expected_review_hash,profile_hash:body.expected_profile_hash});return v;
}
export function reviewedQaResult(candidate:SignedCandidate,terminal=false,ordinal='2',reading=true):DispatchResult{
 const v=authorizationQaResult(candidate,terminal,ordinal),state=terminal?'authorized_homologation':'submission_uncertain';
 return {...v,status:state,receipt:{...v.receipt!,origin:'operational'},current:{...v.current!,state,authorized_in_homologation:terminal},artifact:v.artifact?{...v.artifact,tls_origin_verified:true}:null,read_only:reading,tax_rules_validated:false,dispatch_profile:'authorization-reviewed-dispatch-v1',authorized_in_homologation:terminal,observation:terminal?{sha256:'1'.repeat(64),size_bytes:1500}:null,subset_review:{candidate_version:candidate.candidate_version,profile:REVIEW_PROFILE,profile_hash:REVIEW_PROFILE_HASH,review_id:'a6900000-0000-4000-8000-000000000001',review_version:1,review_hash:'2'.repeat(64),coverage:'listed_rules_only_not_full_tax_validation',tax_rules_validated:false}};
}
export function reviewedQaExpired(c:SignedCandidate,closed=false):DispatchResult{
 const r=reviewedQaResult(c),state=closed?'failed_before_dispatch':'request_ready';
 return {...r,status:state,recoverable_by_actor:false,recovery_required:false,error_code:closed?'PREPARATION_FAILED':null,artifact:null,observation:null,authorized_in_homologation:false,current:{...r.current!,state,grant_consumed:false,lease_expired:true,recovery_required:false,used_at:null,finished_at:closed?new Date(Date.parse(r.current!.expires_at)+60000).toISOString():null,authorized_in_homologation:false}};
}
export function reviewedQaClosure(r:DispatchResult,body:ClosureInput,reading=true):ClosureResult{
 const at=new Date(Date.parse(r.current!.expires_at)+60000).toISOString();
 return {...FLAGS,tax_rules_validated:false,closure_profile:'reviewed-expired-unconsumed-v1',command_id:body.command_id,receipt:{command_id:body.command_id,authorization_command_id:body.authorization_command_id,attempt_id:body.expected_attempt_id,candidate_id:r.receipt!.candidate_id,signed_hash:r.receipt!.signed_hash,model:r.receipt!.model,origin:r.receipt!.origin,policy_version:r.receipt!.policy_version,previous_state:body.expected_state,review_id:r.subset_review?.review_id??null,lease_expired_at:r.current!.expires_at,closed_at:at,reason:'LEASE_EXPIRED_UNCONSUMED',state:'failed_before_dispatch',grant_consumed:false,tax_rules_validated:false},current:{state:'failed_before_dispatch',grant_consumed:false,finished_at:at,successor_exists:false,intent_consumed:false},replayed:reading,read_only:reading};
}
export function createReviewedAuthorizationQaFixture({allowRun=false,allowClosure=false,lookupOnly=false,allowRevalidation=false,revalidationLookupOnly=false}={}){
 const counts={status:0,preflight:0,run:0,history:0,recover:0,command:0,close:0,closureCommand:0,closureLookup:0,revalidationContext:0,revalidationRun:0,revalidationCommand:0,forbidden:0},recovered=new Set<string>(),missingAck=new Set<string>(),missingGet=new Set<string>(),runs=new Map<string,DispatchRunInput>(),closures=new Map<string,ClosureInput>(),revalidations=new Map<string,RevalidationInput>();
 if(revalidationLookupOnly)for(const model of ['55','65'] as const){const r=revalidationQaOriginal(reviewedQaResult(authorizationQaCandidate(model),true)),id=`a7900000-0000-4000-8000-0000000000${model}`;revalidations.set(id,{command_id:id,authorization_command_id:r.command_id,expected_attempt_id:r.receipt!.attempt_id,expected_source_hash:revalidationQaContext(r).source_hash,confirmed:true});}
 if(lookupOnly)for(const model of ['55','65'] as const){const r=reviewedQaExpired(authorizationQaCandidate(model)),id=`a7500000-0000-4000-8000-0000000000${model}`;closures.set(id,{command_id:id,authorization_command_id:r.command_id,expected_attempt_id:r.receipt!.attempt_id,expected_state:'request_ready',confirmed:true});}
 const fail=(command_id:string)=>Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:true,command_id},{status:503});
 return {counts,candidate:authorizationQaCandidate,async fetch(input:RequestInfo|URL,init:RequestInit={}):Promise<Response>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),method=init.method??'GET';
  if(url.origin===REVIEWED_QA_API&&url.pathname==='/v1/me'&&method==='GET')return Response.json({user_id:AUTHORIZATION_QA_ACTOR,role:'fiscal',resources:['nfe','nfce'],data_mode:'staging_readonly'});
  if(url.origin!==REVIEWED_QA_ORIGIN||url.search||url.hash){counts.forbidden++;throw Error('QA_REVIEWED_NETWORK_FORBIDDEN');}
  let selected;try{selected=captureReviewedAuthorizationRequest(url.pathname,{method:method as 'GET'|'POST',...(init.body===undefined?{}:{body:JSON.parse(String(init.body))})});}catch{counts.forbidden++;throw Error('QA_REVIEWED_ROUTE_FORBIDDEN');}
  if(selected.binding.action==='status'){counts.status++;return Response.json(reviewedQaStatus());}
  if(selected.binding.action==='preflight'){counts.preflight++;const c=authorizationQaCandidate(selected.binding.input.candidate_id===authorizationQaCandidate('55').candidate_id?'55':'65');if(c.candidate_id!==selected.binding.input.candidate_id||c.artifact!.sha256!==selected.binding.input.signed_hash)throw Error('QA_REVIEWED_BINDING_MISMATCH');return Response.json(reviewedQaPreflight(c,{enabled:allowRun,consumed:[...runs.values()].some(r=>r.candidate_id===c.candidate_id)}));}
  if(selected.binding.action==='run'){
   if(!allowRun){counts.forbidden++;throw Error('QA_REVIEWED_SUBMISSION_FORBIDDEN');}
   const body=selected.binding.input!,c=authorizationQaCandidate(body.candidate_id===authorizationQaCandidate('55').candidate_id?'55':'65');counts.run++;runs.set(body.command_id,body);
   if(c.model==='55'){missingGet.add(body.command_id);return fail(body.command_id);}return Response.json(reviewedQaRunResult(c,body,false));
  }
  if(selected.revalidation){
   if(!allowRevalidation&&!revalidationLookupOnly){counts.forbidden++;throw Error('QA_REVIEWED_REVALIDATION_NOT_CONFIGURED');}
   const binding=selected.binding,body=binding.action==='revalidationRun'?binding.input:binding.action==='revalidationCommand'?revalidations.get(binding.commandId):undefined;
   const c=[authorizationQaCandidate('55'),authorizationQaCandidate('65')].find(c=>revalidationQaOriginal(reviewedQaResult(c,true)).command_id===(binding.action==='revalidationContext'?binding.authorizationCommandId:body?.authorization_command_id));
   if(!c){counts.forbidden++;throw Error('QA_REVALIDATION_BINDING_INVALID');}
   const original=revalidationQaOriginal(reviewedQaResult(c,true));
   if(binding.action==='revalidationContext'){
    if(binding.expectedAttemptId!==original.receipt!.attempt_id){counts.forbidden++;throw Error('QA_REVALIDATION_ATTEMPT_INVALID');}
    counts.revalidationContext++;const existing=[...revalidations.values()].find(b=>b.authorization_command_id===original.command_id);return Response.json(revalidationQaContext(original,existing?revalidationQaResult(original,existing):null));
   }
   if(!body||body.expected_attempt_id!==original.receipt!.attempt_id||body.expected_source_hash!==revalidationQaContext(original).source_hash){counts.forbidden++;throw Error('QA_REVALIDATION_SOURCE_INVALID');}
   if(binding.action==='revalidationRun'){
    if(!allowRevalidation){counts.forbidden++;throw Error('QA_REVALIDATION_WRITE_FORBIDDEN');}
    counts.revalidationRun++;revalidations.set(body.command_id,body);if(c.model==='55'){missingGet.add(body.command_id);return fail(body.command_id);}
   }else{counts.revalidationCommand++;if(missingGet.delete(body.command_id))return Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,command_id:body.command_id},{status:503});}
   return Response.json(revalidationQaResult(original,body,binding.action==='revalidationCommand'));
  }
  const candidates=[authorizationQaCandidate('55'),authorizationQaCandidate('65')],binding=selected.binding;
  if(binding.action==='closeExpired'||binding.action==='closureCommand'){
   if(!allowClosure){counts.forbidden++;throw Error('QA_REVIEWED_CLOSURE_FORBIDDEN');}
   const body=binding.action==='closeExpired'?binding.input:closures.get(binding.commandId);
   const c=candidates.find(c=>reviewedQaExpired(c).command_id===body?.authorization_command_id);
   if(!body||!c){counts.forbidden++;throw Error('QA_REVIEWED_CLOSURE_MISMATCH');}
   if(binding.action==='closeExpired'){counts.close++;closures.set(body.command_id,body);if(c.model==='55'){missingGet.add(body.command_id);return fail(body.command_id);}}
   else{counts.closureCommand++;if(missingGet.delete(body.command_id))return Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,command_id:body.command_id},{status:503});}
   return Response.json(reviewedQaClosure(reviewedQaExpired(c),body,binding.action==='closureCommand'));
  }

  if(binding.action==='closureLookup'){
   counts.closureLookup++;const body=[...closures.values()].find(v=>v.authorization_command_id===binding.input.authorization_command_id&&v.expected_attempt_id===binding.input.expected_attempt_id),c=candidates.find(c=>reviewedQaExpired(c).command_id===body?.authorization_command_id);
   if(!body||!c)return Response.json({error:'AUTHORIZATION_NOT_FOUND',recovery_required:false},{status:404});
   return Response.json(reviewedQaClosure(reviewedQaExpired(c),body));
  }
  const run=binding.action==='command'?runs.get(binding.commandId):undefined;
  const c=candidates.find(c=>binding.action==='history'?binding.candidateId===c.candidate_id:run?run.candidate_id===c.candidate_id:reviewedQaResult(c).command_id===binding.commandId);
  if(!c){counts.forbidden++;throw Error('QA_REVIEWED_BINDING_MISMATCH');}
  const pending=reviewedQaResult(c),commandId=pending.command_id,wasClosed=[...closures.values()].some(body=>body.authorization_command_id===commandId);
  if(binding.action==='history'){
   counts.history++;const rows=(allowRevalidation||revalidationLookupOnly?[revalidationQaOriginal(reviewedQaResult(c,true))]:allowClosure||lookupOnly?[reviewedQaExpired(c,wasClosed)]:allowRun?[...runs.values()].filter(r=>r.candidate_id===c.candidate_id).map(r=>reviewedQaRunResult(c,r)):[reviewedQaResult(c,recovered.has(commandId)),reviewedQaResult(c,true,'1')]).filter(row=>binding.before===null||BigInt(row.receipt!.ordinal)<BigInt(binding.before));
   const page:DispatchHistory={...FLAGS,tax_rules_validated:false,read_only:true,candidate_id:c.candidate_id,items:rows,limit:binding.limit,has_more:false,next_cursor:null};return Response.json(page);
  }
  if(binding.action==='recover'){
   counts.recover++;recovered.add(commandId);if(c.model==='55'&&!missingAck.has(commandId)){missingAck.add(commandId);missingGet.add(commandId);return fail(commandId);}return Response.json(reviewedQaResult(c,true,'2',false));
  }
  counts.command++;const queried=run?run.command_id:commandId;if(missingGet.delete(queried))return Response.json({error:'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recovery_required:false,command_id:queried},{status:503});return Response.json(allowClosure||lookupOnly?reviewedQaExpired(c,wasClosed):run?reviewedQaRunResult(c,run):reviewedQaResult(c,recovered.has(commandId)));
 }};
}
