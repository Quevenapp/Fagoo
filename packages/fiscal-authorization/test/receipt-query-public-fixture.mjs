/** Synthetic public089 records only; no customer, certificate, private key or remote port. */
import {RECEIPT_QUERY_PUBLIC_FLAGS as FLAGS,RECEIPT_QUERY_SOURCE_PROFILE,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from '../src/receipt-query-public-dto.mjs';
export const uuid=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const digest=n=>n.toString(16).padStart(64,'0');
export const time='2026-10-17T12:00:00.000Z';
export const later='2026-10-17T12:01:00.000Z';
export function publicSource({kind='authorization',model='55'}={}){
 return {source_kind:kind,source_command_id:uuid(kind==='authorization'?1:2),authorization_command_id:uuid(1),authorization_attempt_id:uuid(3),candidate_id:uuid(4),candidate_version:1,signed_hash:digest(1),signed_size:12000,model,environment:'2',origin:'operational',source_binding_hash:digest(kind==='authorization'?2:3),
  original:{state:kind==='authorization'?'receipt_pending':'review_required',outcome:kind==='authorization'?'receipt_pending':'invalid_response',rejection_code:kind==='authorization'?null:'SOAP_INVALID',cstat:kind==='authorization'?'103':null,protocol_cstat:null,response_hash:digest(4),response_size:1000,recorded_at:'2026-10-17T11:58:00.000Z'},
  revalidation:kind==='authorization'?null:{command_id:uuid(2),state:'receipt_pending',cstat:'103',protocol_cstat:null,recorded_at:'2026-10-17T11:59:00.000Z'}};
}
export function publicSelection(source=publicSource()){
 return {source_kind:source.source_kind,source_command_id:source.source_command_id,expected_authorization_command_id:source.authorization_command_id,expected_attempt_id:source.authorization_attempt_id,expected_candidate_id:source.candidate_id,expected_candidate_version:source.candidate_version,expected_signed_hash:source.signed_hash,expected_source_binding_hash:source.source_binding_hash,expected_chain_hash:digest(5),expected_identity_version:1,expected_a1_version:2,expected_query_policy_version:1};
}
export function pendingResolution(){return {state:'pending',resolution_hash:digest(6),query_ids:[],selected_query_id:null,protocol:null};}
export function publicResult({source=publicSource(),state='prepared',ordinal=1,queryId=uuid(10+ordinal),readOnly=true,protocolCstat='100'}={}){
 const consumed=!['prepared','request_ready','failed_before_dispatch'].includes(state),terminal=!['prepared','request_ready','dispatched'].includes(state),observed=['authorized_homologation','receipt_pending','review_required','rejected'].includes(state),authorized=state==='authorized_homologation';
 const response=observed?{response_hash:digest(10+ordinal),response_size:1500,recorded_at:'2026-10-17T12:00:03.000Z',outcome:authorized?'authorization_declared':state,rejection_code:null,cstat:state==='receipt_pending'?'105':state==='review_required'?'106':'104',protocol_cstat:authorized?protocolCstat:state==='rejected'?'245':null,protocol_number:authorized?'13526000000000001':null,received_at:'2026-10-17T12:00:02.000Z',signature_verified:authorized,xsd_validated:true,context_matched:true,processed_xsd_validated:authorized,tls_origin_verified:true,processed_hash:authorized?digest(99):null,processed_size:authorized?13500:null}:null;
 const result={...FLAGS,kind:'result',can_query:false,read_only:readOnly,replayed:readOnly,command_id:queryId,source:structuredClone(source),receipt:{query_id:queryId,...Object.fromEntries(['authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','candidate_version','signed_hash','model','environment','origin'].map(k=>[k,source[k]])),ordinal,identity_version:1,a1_version:2,query_policy_version:1,created_at:time,expires_at:later},current:{state,grant_consumed:consumed,used_at:consumed?'2026-10-17T12:00:01.000Z':null,expires_at:later,lease_expired:true,finished_at:terminal?'2026-10-17T12:00:03.000Z':null,recovery_required:['dispatched','uncertain'].includes(state),can_recover:['dispatched','uncertain'].includes(state)},observation:response,resolution:pendingResolution(),error_code:['uncertain','failed_before_dispatch'].includes(state)?'RECEIPT_QUERY_TRANSPORT_FAILED':null};
 if(authorized||state==='rejected')result.resolution={state,resolution_hash:digest(7),query_ids:[queryId],selected_query_id:queryId,protocol:{state,cstat:response.cstat,protocol_cstat:response.protocol_cstat,protocol_number:response.protocol_number,received_at:response.received_at}};
 if(state==='review_required')result.resolution={...pendingResolution(),state:'review_required'};
 return result;
}
export function publicContext({source=publicSource(),history=[],canQuery=true,resolution=history[0]?.resolution??pendingResolution()}={}){
 const blockers=canQuery?[]:['RUNTIME_DISABLED'];if(resolution.state!=='pending')blockers.push('RESOLUTION_CLOSED');
 return {...FLAGS,kind:'context',read_only:true,source:structuredClone(source),observed_at:'2026-10-17T12:02:00.000Z',chain_hash:digest(5),source_validation:{profile:RECEIPT_QUERY_SOURCE_PROFILE,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,verified:true},eligibility:{ledger_eligible:resolution.state==='pending',runtime_enabled:canQuery},policy:{version:1,enabled:true,valid_from:'2026-10-17T00:00:00.000Z',valid_until:'2026-10-18T00:00:00.000Z',cadence_seconds:60,max_queries_per_hour:10},can_query:canQuery,selection:canQuery?publicSelection(source):null,next_query_at:later,blockers,resolution:structuredClone(resolution),history:structuredClone(history)};
}
export function publicHistory(items=[],{before=null,limit=25,resolution=items[0]?.resolution??pendingResolution()}={}){
 const x={...FLAGS,kind:'history',can_query:false,read_only:true,authorization_command_id:uuid(1),authorization_attempt_id:uuid(3),observed_at:'2026-10-17T12:02:00.000Z',chain_hash:digest(5),resolution:structuredClone(resolution),items:structuredClone(items),next_before:null,limit};
 return {raw:x,binding:{action:'receiptQueryHistory',input:{authorization_command_id:uuid(1),expected_attempt_id:uuid(3),limit,before}}};
}
export const contextBinding=x=>({action:'receiptQueryContext',input:{source_kind:x.source.source_kind,source_command_id:x.source.source_command_id,expected_attempt_id:x.source.authorization_attempt_id}});
export const commandBinding=x=>({action:'receiptQueryCommand',commandId:x.command_id});
