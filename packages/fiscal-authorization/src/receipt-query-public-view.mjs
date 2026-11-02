/** Server-only mapping of a validated private089 ledger. SQL hashes stay opaque. */
import {RECEIPT_QUERY_PUBLIC_FLAGS as FLAGS,RECEIPT_QUERY_SOURCE_MANIFEST_HASH,projectReceiptQueryPublic} from './receipt-query-public-dto.mjs';
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
export function receiptQueryPublicSource(s){const a=s.original_source.artifact,e=a.evidence,r=s.selected_revalidation?.receipt;return{
 ...pick(s,['source_kind','source_command_id','authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin','source_binding_hash']),
 original:{state:s.original_source.receipt? (e.outcome==='receipt_pending'?'receipt_pending':'review_required'):'review_required',outcome:e.outcome,rejection_code:e.rejection_code,cstat:e.cstat,protocol_cstat:e.protocol_cstat,response_hash:a.response_hash,response_size:a.response_size,recorded_at:a.created_at},
 revalidation:r?{command_id:r.command_id,state:r.state,cstat:r.evidence.cstat,protocol_cstat:r.evidence.protocol_cstat,recorded_at:r.created_at}:null};}
export function receiptQueryPublicResolution(r){return{...pick(r,['state','resolution_hash','query_ids','selected_query_id']),protocol:['authorized_homologation','rejected'].includes(r.state)?pick(r.protocol,['state','cstat','protocol_cstat','protocol_number','received_at']):null};}
export function receiptQueryPublicResult(v,{readOnly=true,replayed=v.replayed??true}={}){
 const a=v.artifact,e=a?.evidence;
 return{...FLAGS,kind:'result',can_query:false,read_only:readOnly,replayed,command_id:v.query_id,source:receiptQueryPublicSource(v.source),
 receipt:pick(v.receipt,['query_id','authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin','ordinal','identity_version','a1_version','query_policy_version','created_at','expires_at']),
 current:{...v.current,can_recover:v.current.recovery_required&&v.current.lease_expired},
 observation:a?{response_hash:a.response_hash,response_size:a.response_size,recorded_at:a.created_at,...pick(e,['outcome','rejection_code','cstat','protocol_cstat','protocol_number','received_at','signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified']),processed_hash:a.processed_hash,processed_size:a.processed_size}:null,
 resolution:receiptQueryPublicResolution(v.resolution),error_code:v.error_code};
}
export function projectReceiptQueryResult(v,binding,options){return projectReceiptQueryPublic(receiptQueryPublicResult(v,options),binding);}
export function projectReceiptQueryHistory(v,binding){return projectReceiptQueryPublic({...FLAGS,kind:'history',can_query:false,read_only:true,...pick(v,['authorization_command_id','authorization_attempt_id','observed_at','chain_hash','next_before','limit']),resolution:receiptQueryPublicResolution(v.resolution),items:v.items.map(x=>receiptQueryPublicResult(x))},binding);}
export function projectReceiptQueryContext(v,binding,{verified,enabled,validation}){
 const next=validation?new Date(Math.max(Date.parse(validation.observed_at)+Math.max(60,validation.tmed_seconds)*1000,v.next_query_at===null?0:Date.parse(v.next_query_at))).toISOString():v.next_query_at;
 const blockers=v.blockers.filter(k=>!(verified&&k==='SOURCE_VALIDATION_REQUIRED'));
 if(next!==null&&Date.parse(v.observed_at)<Date.parse(next)&&!blockers.includes('CADENCE_REQUIRED'))blockers.push('CADENCE_REQUIRED');
 if(!enabled)blockers.push('RUNTIME_DISABLED');
 const canQuery=v.private_eligible_for_attested_source&&enabled&&verified&&blockers.length===0;
 return projectReceiptQueryPublic({...FLAGS,kind:'context',read_only:true,source:receiptQueryPublicSource(v.source),observed_at:v.observed_at,chain_hash:v.chain_hash,
 eligibility:{ledger_eligible:v.private_eligible_for_attested_source,runtime_enabled:enabled},source_validation:{profile:'receipt-query-source-089-v1',manifest_hash:validation?.manifest_hash??RECEIPT_QUERY_SOURCE_MANIFEST_HASH,verified},
 policy:v.policy?pick(v.policy,['version','enabled','valid_from','valid_until','cadence_seconds','max_queries_per_hour']):null,
 can_query:canQuery,selection:canQuery?v.selection:null,next_query_at:next,blockers,resolution:receiptQueryPublicResolution(v.resolution),history:v.history.map(x=>receiptQueryPublicResult(x))},binding);
}
