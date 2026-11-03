import {FLAGS} from '../../../../packages/fiscal-authorization-runtime/src/dispatch-public-dto.mjs';
import {candidate,result,history,setup} from './fiscal-reviewed-authorization-fixtures.mjs';
export {candidate};
export const B='/v1/fiscal-authorization/reviewed';
export const closureId='a7400000-0000-4000-8000-000000000001';
export const original=(c=candidate(),state='prepared')=>{const r=result(c,{state});r.current.lease_expired=true;return r;};
export const input=r=>({command_id:closureId,authorization_command_id:r.command_id,expected_attempt_id:r.receipt.attempt_id,expected_state:r.status,confirmed:true});
export function closed(r,body=input(r),reading=true){
 const at=new Date(Date.parse(r.current.expires_at)+60000).toISOString();
 return{...FLAGS,closure_profile:'reviewed-expired-unconsumed-v1',tax_rules_validated:false,command_id:body.command_id,
 receipt:{command_id:body.command_id,authorization_command_id:body.authorization_command_id,attempt_id:body.expected_attempt_id,candidate_id:r.receipt.candidate_id,signed_hash:r.receipt.signed_hash,model:r.receipt.model,origin:r.receipt.origin,policy_version:r.receipt.policy_version,previous_state:body.expected_state,review_id:r.subset_review?.review_id??null,lease_expired_at:r.current.expires_at,closed_at:at,reason:'LEASE_EXPIRED_UNCONSUMED',state:'failed_before_dispatch',grant_consumed:false,tax_rules_validated:false},
 current:{state:'failed_before_dispatch',grant_consumed:false,finished_at:at,successor_exists:false,intent_consumed:false},replayed:reading,read_only:reading};
}
export function closureFixture({model='55',state='prepared',before=()=>{}}={}){
 let saved;
 const s=setup({model,before:async(call,s)=>{
  if(call.path.endsWith('/close-expired')){call.kind='close';saved=call.body;}
  if(call.path.includes('/closure-commands/'))call.kind='closureCommand';
  const custom=await before(call,s);if(custom!==undefined)return custom;
  if(call.kind==='close')return closed(s.original,call.body,false);
  if(call.kind==='closureCommand')return closed(s.original,saved);
  if(call.kind==='history')return history(s.candidate,[s.original]);
  if(call.kind==='command')return structuredClone(s.original);
 }});s.original=original(s.candidate,state);return s;
}
