/** Adapter for the existing SP CRT1 readReview port. No writer, grant, Storage or custody. */
import {matchesRuleProfile} from './rule-profile-registry.mjs';
import {fields,need,id,int,sha,recordText,freeze,projectSubsetReview,MAX_SUBSET_RECORD_BYTES} from './subset-review-dto.mjs';
export function createPersistedSubsetReviewReader(configuration){
 const p=fields(configuration,['rpc']);need(typeof p.rpc==='function');const rpc=p.rpc;
 return async function readReview(input,options){
  const q=fields(input,['actor','candidateId','candidateVersion','signedHash','factsHash','profile','profileHash','items']),o=fields(options,['signal','deadline','maxBytes']);
  need(id(q.actor)&&id(q.candidateId)&&int(q.candidateVersion)&&sha(q.signedHash)&&sha(q.factsHash)&&matchesRuleProfile(q.profile,q.profileHash)&&Array.isArray(q.items)&&int(q.items.length,1,250));
  const ds=Object.getOwnPropertyDescriptors(q.items);need(Reflect.ownKeys(ds).length===q.items.length+1);const items=Array.from({length:q.items.length},(_,i)=>{
   const d=ds[String(i)];need(d?.enumerable&&Object.hasOwn(d,'value'));const x=fields(d.value,['position','itemHash']);need(x.position===i+1&&sha(x.itemHash));return x;
  });
  need(int(o.maxBytes,1,MAX_SUBSET_RECORD_BYTES)&&Number.isSafeInteger(o.deadline)&&o.deadline>Date.now()&&o.deadline<=Date.now()+45000&&o.signal instanceof AbortSignal&&!o.signal.aborted);
  const args=freeze({p_user_id:q.actor,p_candidate_id:q.candidateId,p_candidate_version:q.candidateVersion,p_signed_hash:q.signedHash,p_facts_hash:q.factsHash,p_profile_hash:q.profileHash});
  const opts=Object.freeze({signal:o.signal,deadline:o.deadline}),max=o.maxBytes;
  // The injected RPC is trusted for transport, but its result still crosses the strict DTO boundary.
  const value=projectSubsetReview('erp_fiscal_subset_review_get',await rpc('erp_fiscal_subset_review_get',args,opts),args);
  need(!opts.signal.aborted&&Date.now()<opts.deadline,'SUBSET_REVIEW_READER_EXPIRED');if(value.receipt===null)return null;
  need(value.current.is_latest&&value.current.reviewer_active&&value.current.within_validity,'SUBSET_REVIEW_NOT_CURRENT');
  const record=recordText(value.record_text),now=Date.now();need(Date.parse(record.reviewed_at)<=now&&Date.parse(record.valid_until)>now,'SUBSET_REVIEW_NOT_CURRENT');
  need(record.items.length===items.length&&record.items.every((x,i)=>x.position===items[i].position&&x.item_hash===items[i].itemHash),'SUBSET_REVIEW_FACTS_CHANGED');
  const bytes=Buffer.from(value.record_text,'utf8');try{need(bytes.length<=max,'SUBSET_REVIEW_LIMIT');need(!opts.signal.aborted&&Date.now()<opts.deadline,'SUBSET_REVIEW_READER_EXPIRED');return bytes;}catch(e){bytes.fill(0);throw e;}
 };
}
