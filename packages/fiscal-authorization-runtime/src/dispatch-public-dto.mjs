import {projectClosureLookupPublic} from '../../fiscal-authorization/src/closure-lookup-dto.mjs';
import {projectPreflightPublic} from '../../fiscal-authorization/src/preflight-dto.mjs';
import {projectClosurePublic} from '../../fiscal-authorization/src/closure-dto.mjs';
/** Closed browser-safe069 view. Reuses064 validation only for its unchanged fields. */
import {data,need,uuid,hash,version,ordinal,freeze,snapshot} from '../../fiscal-authorization-http/src/protocol.mjs';
import {FLAGS,publicResult,SERVICE_FAILURE_CODES as LEGACY_FAILURES} from '../../fiscal-authorization-http/src/dto.mjs';
import {DISPATCH_PROFILE,MAX_DISPATCH_RESPONSE_BYTES,captureDispatchInput} from './dispatch-protocol.mjs';
import {matchesRuleProfile} from '../../fiscal-authorization/src/rule-profile-registry.mjs';
export {FLAGS};
export const DISPATCH_FAILURE_CODES=Object.freeze([...LEGACY_FAILURES,'AUTHORIZATION_SUBSET_REVIEW_INVALID','AUTHORIZATION_SUBSET_REVIEW_PENDING','AUTHORIZATION_SUBSET_REVIEW_CHANGED','AUTHORIZATION_TRANSPORT_INVALID','AUTHORIZATION_NFCE_EMISSION_EXPIRED','AUTHORIZATION_NFCE_EMISSION_FUTURE','AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT','AUTHORIZATION_NFCE_EMISSION_INPUT_INVALID']);
const exact=(v,keys)=>data(v,keys,[],502,'AUTHORIZATION_RESPONSE_INVALID');
const requireValue=v=>need(v,502,'AUTHORIZATION_RESPONSE_INVALID');
const baseKeys=[...Object.keys(FLAGS),'status','command_id','receipt','current','error_code','artifact','read_only','recovered','failure_code','recovery_required','recoverable_by_actor'];
const extraKeys=['tax_rules_validated','dispatch_profile','authorized_in_homologation','observation','subset_review'];
const flags=v=>requireValue(Object.entries(FLAGS).every(([k,x])=>v[k]===x)&&v.tax_rules_validated===false);
function result(raw,binding,reading){
 const v=snapshot(exact(raw,[...baseKeys,...extraKeys]));flags(v);requireValue(v.dispatch_profile===DISPATCH_PROFILE&&typeof v.authorized_in_homologation==='boolean'&&(v.failure_code===null||DISPATCH_FAILURE_CODES.includes(v.failure_code)));
 const base=Object.fromEntries(baseKeys.map(k=>[k,v[k]]));
 // Extension codes are checked above. The old validator checks the unchanged
 // result invariants with the equivalent generic failure, never the new proof.
 if(base.failure_code!==null&&!LEGACY_FAILURES.includes(base.failure_code))base.failure_code='AUTHORIZATION_PORT_FAILED';
 const checked=publicResult(base,{action:reading?'command':'recover',...(binding.commandId?{commandId:binding.commandId}:{}),...(binding.candidateId?{candidateId:binding.candidateId}:{})});
 requireValue(checked.receipt===null||checked.receipt.origin==='operational');
 requireValue(v.authorized_in_homologation===(checked.status==='authorized_homologation'&&checked.artifact?.tls_origin_verified===true));
 let proof=null,observation=null;
 if(v.subset_review!==null){
  proof=exact(v.subset_review,['candidate_version','profile','profile_hash','review_id','review_version','review_hash','coverage','tax_rules_validated']);
  requireValue(checked.receipt!==null&&proof.candidate_version===checked.receipt.candidate_version&&matchesRuleProfile(proof.profile,proof.profile_hash)&&uuid(proof.review_id)&&version(proof.review_version)&&hash(proof.review_hash)&&proof.coverage==='listed_rules_only_not_full_tax_validation'&&proof.tax_rules_validated===false);
 }
 if(checked.current&& !['prepared','failed_before_dispatch'].includes(checked.current.state))requireValue(proof!==null);
 if(v.observation!==null){observation=exact(v.observation,['sha256','size_bytes']);requireValue(hash(observation.sha256)&&Number.isInteger(observation.size_bytes)&&observation.size_bytes>=1&&observation.size_bytes<=8192);}
 requireValue((checked.artifact!==null)===(observation!==null));
 if(checked.receipt===null)requireValue(proof===null);
 if(binding.input&&checked.receipt){const p=captureDispatchInput('dispatchRun',binding.input),r=checked.receipt;requireValue(r.candidate_id===p.candidate_id&&r.signed_hash===p.signed_hash&&r.identity_version===p.expected_identity_version&&r.a1_version===p.expected_a1_version&&r.policy_version===p.expected_policy_version&&r.candidate_version===p.expected_candidate_version&&proof!==null&&proof.review_id===p.expected_review_id&&proof.review_version===p.expected_review_version&&proof.review_hash===p.expected_review_hash&&proof.profile_hash===p.expected_profile_hash);}
 return{...checked,failure_code:v.failure_code,tax_rules_validated:false,dispatch_profile:DISPATCH_PROFILE,authorized_in_homologation:v.authorized_in_homologation,observation,subset_review:proof};
}
export function projectDispatchPublic(raw,binding){
 const b=data(binding,['action'],['commandId','candidateId','limit','before','input']);requireValue(['status','preflight','run','recover','command','history','closeExpired','closureCommand','closureLookup'].includes(b.action));let out;
 if(b.action==='closureLookup'){out=projectClosureLookupPublic(raw,b.input);
 }else if(['closeExpired','closureCommand'].includes(b.action)){out=projectClosurePublic(raw,b);
 }else if(b.action==='preflight'){out=projectPreflightPublic(raw,b.input);
 }else if(b.action==='status'){
  const v=snapshot(exact(raw,[...Object.keys(FLAGS),'tax_rules_validated','dispatch_profile','read_only','runtime_enabled','policy_checked']));flags(v);requireValue(v.dispatch_profile===DISPATCH_PROFILE&&v.read_only===true&&typeof v.runtime_enabled==='boolean'&&v.policy_checked===false);out=v;
 }else if(b.action==='history'){
  const v=exact(raw,[...Object.keys(FLAGS),'tax_rules_validated','read_only','candidate_id','items','limit','has_more','next_cursor']);flags(v);
  requireValue(v.read_only===true&&uuid(v.candidate_id)&&v.candidate_id===b.candidateId&&Number.isInteger(v.limit)&&v.limit>=1&&v.limit<=25&&v.limit===b.limit&&(b.before===null||ordinal(b.before))&&typeof v.has_more==='boolean');
  requireValue(Array.isArray(v.items)&&Object.getPrototypeOf(v.items)===Array.prototype&&v.items.length<=v.limit);const ds=Object.getOwnPropertyDescriptors(v.items);requireValue(Reflect.ownKeys(ds).length===v.items.length+1);
  let before=b.before??'1000000000000000';const commands=new Set(),attempts=new Set();
  const items=Array.from({length:v.items.length},(_,i)=>{requireValue(ds[i]?.enumerable&&Object.hasOwn(ds[i],'value'));const item=result(ds[i].value,{candidateId:b.candidateId},true);requireValue(item.receipt!==null&&BigInt(item.receipt.ordinal)<BigInt(before)&&!commands.has(item.command_id)&&!attempts.has(item.receipt.attempt_id));before=item.receipt.ordinal;commands.add(item.command_id);attempts.add(item.receipt.attempt_id);return item;});
  requireValue(v.has_more?items.length===v.limit&&v.next_cursor===items.at(-1)?.receipt.ordinal:v.next_cursor===null);out={...v,items};
 }else{requireValue(uuid(b.commandId));out=result(raw,b,b.action==='command');}
 requireValue(new TextEncoder().encode(JSON.stringify(out)).length<=MAX_DISPATCH_RESPONSE_BYTES);return freeze(out);
}
