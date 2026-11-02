/** Browser-safe075 binding. Discovery never turns absence into permission to mutate. */
import {data,need,uuid,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
import {projectClosurePublic,projectClosureLedger,closurePublicFromLedger} from './closure-dto.mjs';
export const MAX_CLOSURE_LOOKUP_REQUEST_BYTES=4096,MAX_CLOSURE_LOOKUP_RESPONSE_BYTES=16384;
export function captureClosureLookupInput(raw){
 const v=data(raw,['authorization_command_id','expected_attempt_id']);need(uuid(v.authorization_command_id)&&uuid(v.expected_attempt_id));return freeze(v);
}
function project(raw,input,privateHash){
 const q=captureClosureLookupInput(input);need(raw!==null&&typeof raw==='object',502,'AUTHORIZATION_RESPONSE_INVALID');
 const d=Object.getOwnPropertyDescriptor(raw,'command_id');need(d&&Object.hasOwn(d,'value')&&uuid(d.value),502,'AUTHORIZATION_RESPONSE_INVALID');
 const out=(privateHash?projectClosureLedger:projectClosurePublic)(raw,{action:'closureCommand',commandId:d.value});
 need(out.receipt.authorization_command_id===q.authorization_command_id&&out.receipt.attempt_id===q.expected_attempt_id,502,'AUTHORIZATION_RESPONSE_INVALID');return out;
}
export const projectClosureLookupPublic=(raw,input)=>project(raw,input,false);
export const projectClosureLookupLedger=(raw,input)=>project(raw,input,true);
export function closureLookupPublicFromLedger(raw,input){
 const v=projectClosureLookupLedger(raw,input);return projectClosureLookupPublic(closurePublicFromLedger(v,{action:'closureCommand',commandId:v.command_id}),input);
}
