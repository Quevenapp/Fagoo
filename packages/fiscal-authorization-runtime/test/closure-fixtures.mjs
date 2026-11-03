import {FLAGS} from '../../fiscal-authorization-http/src/dto.mjs';
import {candidateId,commandId} from './fixtures.mjs';
export const closureBody=Object.freeze({command_id:'8ce056ba-d801-4ffd-a411-3ca7adf7c4e4',authorization_command_id:commandId,expected_attempt_id:'de6d8adb-7a93-4d60-aa7f-7ac51a39dc9c',expected_state:'request_ready',confirmed:true});
export function closureResult(reading=false,{privateHash=false}={}){
 const receipt={command_id:closureBody.command_id,authorization_command_id:commandId,attempt_id:closureBody.expected_attempt_id,candidate_id:candidateId,signed_hash:'a'.repeat(64),model:'55',origin:'operational',policy_version:3,previous_state:'request_ready',review_id:'d7290715-9e40-4b4e-9430-e2d5d8c6c7ec',lease_expired_at:'2026-10-16T12:00:00.000Z',closed_at:'2026-10-16T12:01:00.000Z',reason:'LEASE_EXPIRED_UNCONSUMED',state:'failed_before_dispatch',grant_consumed:false,tax_rules_validated:false,...(privateHash?{request_hash:'b'.repeat(64)}:{})};
 return{...FLAGS,closure_profile:'reviewed-expired-unconsumed-v1',tax_rules_validated:false,command_id:closureBody.command_id,receipt,current:{state:'failed_before_dispatch',grant_consumed:false,finished_at:receipt.closed_at,successor_exists:false,intent_consumed:false},replayed:reading,read_only:reading};
}
