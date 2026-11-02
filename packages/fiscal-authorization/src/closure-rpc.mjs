import {data,need,id} from './service-common.mjs';
import {createLedgerPort} from '../../fiscal-engine/ledger-port.mjs';
import {captureClosureInput,projectClosureLedger,MAX_CLOSURE_REQUEST_BYTES} from './closure-dto.mjs';
export const CLOSURE_RPC='erp_fiscal_reviewed_authorization_close_expired',CLOSURE_COMMAND_RPC='erp_fiscal_reviewed_authorization_closure_command';
function binding(name,args){
  const writing=name===CLOSURE_RPC;
  const x=data(args,writing?['p_user_id','p_command_id','p_authorization_command_id','p_expected_attempt_id','p_expected_state','p_expected_request_hash','p_confirmed']:['p_user_id','p_command_id']);need(id(x.p_user_id)&&id(x.p_command_id));
  const input=writing?captureClosureInput({command_id:x.p_command_id,authorization_command_id:x.p_authorization_command_id,expected_attempt_id:x.p_expected_attempt_id,expected_state:x.p_expected_state,confirmed:x.p_confirmed}):null;
  if(writing)need(x.p_expected_state==='prepared'?x.p_expected_request_hash===null:typeof x.p_expected_request_hash==='string'&&/^[a-f0-9]{64}$/.test(x.p_expected_request_hash));
  return{action:writing?'closeExpired':'closureCommand',commandId:x.p_command_id,...(input?{input}:{})};
}
export function createAuthorizationClosureRpc(configuration){
  const{execute}=data(configuration,['execute']);
  return createLedgerPort({execute,actions:[CLOSURE_RPC,CLOSURE_COMMAND_RPC],limit:MAX_CLOSURE_REQUEST_BYTES,
    capture(name,args){binding(name,args);return structuredClone(args);},
    project(name,value,args){const out=projectClosureLedger(value,binding(name,args));if(name===CLOSURE_RPC)need(out.receipt.request_hash===args.p_expected_request_hash,'AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');return out;},failure:'AUTHORIZATION_CLOSURE_RPC_UNAVAILABLE'});
}
