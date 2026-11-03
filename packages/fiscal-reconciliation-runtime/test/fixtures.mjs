import {randomUUID} from 'node:crypto';
import {FLAGS} from '../src/dto.mjs';
export const actor=randomUUID(),command=randomUUID(),attempt=randomUUID(),candidate=randomUUID();
const job=randomUUID(),reservation=randomUUID(),draft=randomUUID();
export const payload=()=>({command_id:command,candidate_id:candidate,signed_hash:'a'.repeat(64),expected_a1_version:1,expected_identity_version:2,confirmed:true});
export function result(state='stored',p=payload(),readOnly=false){
 const consumed=['dispatched','stored','uncertain'].includes(state),finished=['stored','failed_before_dispatch','uncertain'].includes(state);
 return {...FLAGS,status:state,command_id:p.command_id,recovery_required:['dispatched','uncertain'].includes(state),read_only:readOnly,recovered:false,failure_code:null,
  retry_transport_allowed:false,recoverable_by_actor:['dispatched','uncertain'].includes(state),
  receipt:{candidate_id:p.candidate_id,candidate_version:1,unsigned_job_id:job,reservation_id:reservation,draft_id:draft,model:'55',signed_hash:p.signed_hash,signed_size:12000,
   signing_a1_version:1,basis_hash:'b'.repeat(64),completion_version:1,completion_hash:'c'.repeat(64),attempt_id:attempt,ordinal:1,command_id:p.command_id,profile:FLAGS.profile,environment:'2',
   identity_version:p.expected_identity_version,a1_version:p.expected_a1_version,confirmed:true,created_at:'2026-10-16T12:00:00.000Z'},
  current:{state,identity_version:p.expected_identity_version,a1_version:p.expected_a1_version,a1_changed:false,company_changed:false,grant_consumed:consumed,lease_expired:false,
   expires_at:'2026-10-16T12:01:00.000Z',used_at:consumed?'2026-10-16T12:00:01.000Z':null,finished_at:finished?'2026-10-16T12:00:02.000Z':null,
   recovery_required:['dispatched','uncertain'].includes(state),retry_transport_allowed:false,
   candidate:{state:'stored',attempt_count:1,lease_until:null,unsigned_artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,series_enabled:true,
    a1_version:1,a1_changed:false,certificate_time_valid_now:true,latest_candidate_id:p.candidate_id,latest_candidate_version:1,is_latest_candidate:true,artifact_current:true}},
  error_code:['failed_before_dispatch','uncertain'].includes(state)?'TRANSPORT_UNCONFIRMED':null,
  artifact:state==='stored'?{sha256:'d'.repeat(64),size_bytes:500,outcome:'validated',rejection_code:null,cstat:'217',event_reconciliation_required:false,created_at:'2026-10-16T12:00:02.000Z',tls_origin_verified:true}:null};
}
export const history=()=>({...FLAGS,read_only:true,candidate_id:candidate,items:[result('stored',payload(),true)],limit:25,has_more:false,next_cursor:null});
export const unconfirmed=()=>({...FLAGS,status:'unconfirmed',command_id:command,recovery_required:true,read_only:false,recovered:false,failure_code:'RECONCILIATION_TIMEOUT',receipt:null,current:null,error_code:null,artifact:null,retry_transport_allowed:false,recoverable_by_actor:true});
