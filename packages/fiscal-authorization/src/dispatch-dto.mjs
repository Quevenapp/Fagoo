/** Backend069 composition only; no browser authority, implicit policy or network. */
import {data,need,freeze} from './service-common.mjs';
import {result,context} from './service-dto.mjs';
import {SUBSET_LEDGER_PROFILE,projectReviewedLedger,checkReviewedContext} from './reviewed-ledger-dto.mjs';
export const DISPATCH_PROFILE='authorization-reviewed-dispatch-v1';
export const DISPATCH_FLAGS=Object.freeze({tax_rules_validated:false,can_emit:false,can_transmit:false,production_authorized:false});
export function checkDispatchContext(raw){
 const c=context(raw,{},Object.hasOwn(raw,'issued_at'));checkReviewedContext(c);
 need(c.origin==='operational','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');return c;
}
function split(raw){
 const x=data(raw,['rule_review','observation'],Object.keys(raw).filter(k=>!['rule_review','observation'].includes(k)));
 const {rule_review,observation,...view}=x;return{view,rule_review,observation};
}
/** Revalidate the already projected HTTP adapter output at the injected-port boundary. */
export function projectDispatchLedger(action,raw,args){
 let envelope;
 if(action==='history'){
  const x=data(raw,['data_mode','environment','can_emit','can_transmit','production_authorized','legal_fiscal_value','financial_mutation_performed','stock_mutation_performed','retry_submission_allowed','read_only','candidate_id','items','limit','has_more','next_cursor']);
  need(Array.isArray(x.items)&&Object.getPrototypeOf(x.items)===Array.prototype&&x.items.length<=25);
  const ds=Object.getOwnPropertyDescriptors(x.items);need(Reflect.ownKeys(ds).length===x.items.length+1);
  const values=Array.from({length:x.items.length},(_,i)=>{need(ds[i]&&Object.hasOwn(ds[i],'value'));return split(ds[i].value);});
  envelope={ledger_profile:SUBSET_LEDGER_PROFILE,page:{...x,items:values.map(v=>v.view)},rule_reviews:values.map(v=>v.rule_review),observations:values.map(v=>v.observation)};
 }else envelope={ledger_profile:SUBSET_LEDGER_PROFILE,...split(raw)};
 const value=projectReviewedLedger(action,envelope,args);
 if(action!=='history')checkDispatchContext(action==='use'?value.grant:value.recovery);
 else need(value.items.every(v=>v.receipt.origin==='operational'),'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE');
 return value;
}
export function dispatchResult(value,options={}){
 const base=result(value,options),p=value?.rule_review;
 // A recorded homologation status is not permission to emit again or promote a
 // DANFE. Full tax validation and all production capabilities remain false.
 return freeze({...base,...DISPATCH_FLAGS,dispatch_profile:DISPATCH_PROFILE,
  authorized_in_homologation:base.status==='authorized_homologation'&&base.artifact?.tls_origin_verified===true,
  observation:value?.observation??null,
  subset_review:p?{candidate_version:p.candidate_version,profile:p.profile,profile_hash:p.profile_hash,review_id:p.review_id,review_version:p.review_version,review_hash:p.review_hash,coverage:p.coverage,tax_rules_validated:false}:null});
}
