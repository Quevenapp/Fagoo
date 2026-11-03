import {randomUUID} from 'node:crypto';
import {FLAGS} from '../src/dto.mjs';
export const actor=randomUUID(),command=randomUUID(),attempt=randomUUID();
export const payload=()=>({command_id:command,model:'55',operation:'protocol',expected_a1_version:1,expected_identity_version:2,confirmed:true});
export function result(state='stored',p=payload(),readOnly=false){
 const consumed=['dispatched','stored','uncertain'].includes(state),finished=['stored','failed','uncertain'].includes(state);
 return{...FLAGS,status:state,command_id:p.command_id,recovery_required:['dispatched','uncertain'].includes(state),read_only:readOnly,recovered:false,failure_code:null,
  receipt:{attempt_id:attempt,command_id:p.command_id,profile:FLAGS.profile,model:p.model,operation:p.operation,environment:'2',a1_version:p.expected_a1_version,identity_version:p.expected_identity_version,confirmed:true,created_at:'2026-10-16T12:00:00.000Z'},
  current:{state,a1_version:p.expected_a1_version,identity_version:p.expected_identity_version,a1_changed:false,company_changed:false,certificate_time_valid_now:true,grant_consumed:consumed,lease_expired:false,expires_at:'2026-10-16T12:01:00.000Z',used_at:consumed?'2026-10-16T12:00:01.000Z':null,finished_at:finished?'2026-10-16T12:00:02.000Z':null,recovery_required:['dispatched','uncertain'].includes(state),retry_get_allowed:false},
  error_code:['failed','uncertain'].includes(state)?'WSDL_TLS_FAILED':null,
  artifact:state==='stored'?{sha256:'a'.repeat(64),size_bytes:500,inspection_status:'supported',inspection_code:null,created_at:'2026-10-16T12:00:02.000Z'}:null};
}
export const unconfirmed=(p=payload())=>({...FLAGS,status:'unconfirmed',command_id:p.command_id,recovery_required:true,read_only:false,recovered:false,failure_code:'WSDL_SERVICE_TIMEOUT',receipt:null,current:null,error_code:null,artifact:null});
