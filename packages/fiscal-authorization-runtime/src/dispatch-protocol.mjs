import {captureClosureLookupInput} from '../../fiscal-authorization/src/closure-lookup-dto.mjs';
import {captureSelectedRun} from '../../fiscal-authorization/src/selected-run-dto.mjs';
import {capturePreflightInput} from '../../fiscal-authorization/src/preflight-dto.mjs';
import {captureClosureInput,MAX_CLOSURE_RESPONSE_BYTES} from '../../fiscal-authorization/src/closure-dto.mjs';
/** Web-safe versioned069 routing. No actor, review proof, endpoint or grant in input. */
import {data,need,uuid,hash,version,ordinal,freeze,AuthorizationHttpError} from '../../fiscal-authorization-http/src/protocol.mjs';
export const DISPATCH_PROFILE='authorization-reviewed-dispatch-v1';
export const MAX_DISPATCH_REQUEST_BYTES=4096,MAX_DISPATCH_RESPONSE_BYTES=262144;
const routes=new WeakSet();
export function dispatchRoute(path,method,prefix){
 const base=prefix+'/reviewed';if(path!==base&&!path.startsWith(base+'/'))return null;
 let action,expected,commandId,candidateId,authorizationCommandId,expectedAttemptId;
 if(path===base+'/status'){action='dispatchStatus';expected='GET';}
 if(path===base+'/preflight'){action='dispatchPreflight';expected='POST';}
 if(path===base+'/run'){action='dispatchRun';expected='POST';}
 if(path===base+'/recover'){action='dispatchRecover';expected='POST';}
 if(path===base+'/close-expired'){action='dispatchCloseExpired';expected='POST';}
 const command=new RegExp('^'+base+'/commands/([^/]+)$').exec(path),history=new RegExp('^'+base+'/candidates/([^/]+)/history$').exec(path);
 if(command&&uuid(command[1])){action='dispatchCommand';expected='GET';commandId=command[1];}
 const closure=new RegExp('^'+base+'/closure-commands/([^/]+)$').exec(path);
 if(closure&&uuid(closure[1])){action='dispatchClosureCommand';expected='GET';commandId=closure[1];}
 const lookup=new RegExp('^'+base+'/commands/([^/]+)/attempts/([^/]+)/closure$').exec(path);
 if(lookup&&uuid(lookup[1])&&uuid(lookup[2])){action='dispatchClosureLookup';expected='GET';authorizationCommandId=lookup[1];expectedAttemptId=lookup[2];}
 if(history&&uuid(history[1])){action='dispatchHistory';expected='POST';candidateId=history[1];}
 need(action,404,'AUTHORIZATION_NOT_FOUND');need(method===expected,405,'AUTHORIZATION_METHOD_NOT_ALLOWED');
 const out=freeze({action,path,method,dispatch:true,...(commandId?{commandId}:{}),...(candidateId?{candidateId}:{}),...(authorizationCommandId?{authorizationCommandId,expectedAttemptId}:{}),limit:method==='POST'?MAX_DISPATCH_REQUEST_BYTES:0,responseLimit:['dispatchCloseExpired','dispatchClosureCommand','dispatchClosureLookup'].includes(action)?MAX_CLOSURE_RESPONSE_BYTES:MAX_DISPATCH_RESPONSE_BYTES});routes.add(out);return out;
}
export function captureDispatchInput(action,raw){
 let v;
 if(action==='dispatchRun'){
  v=captureSelectedRun(raw);
 }else if(action==='dispatchPreflight'){v=capturePreflightInput(raw);
 }else if(action==='dispatchCloseExpired'){v=captureClosureInput(raw);
 }else if(action==='dispatchRecover'){v=data(raw,['command_id']);need(uuid(v.command_id));}
 else if(action==='dispatchHistory'){v=data(raw,['limit','before']);need(Number.isInteger(v.limit)&&v.limit>=1&&v.limit<=25&&(v.before===null||ordinal(v.before)));}
 else{need(['dispatchStatus','dispatchCommand','dispatchClosureCommand','dispatchClosureLookup'].includes(action));v=data(raw,[]);}
 return freeze(v);
}
export function parseDispatchPayload(bytes,selected){
 need(routes.has(selected)&&bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer&&bytes.length<=selected.limit);
 if(selected.method==='GET'){need(bytes.length===0);return captureDispatchInput(selected.action,{});}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
 return captureDispatchInput(selected.action,value);
}
export function dispatchBinding(selected,payload){
 if(selected.action==='dispatchClosureLookup')return{action:'closureLookup',input:captureClosureLookupInput({authorization_command_id:selected.authorizationCommandId,expected_attempt_id:selected.expectedAttemptId})};
 if(selected.action==='dispatchCloseExpired')return{action:'closeExpired',commandId:payload.command_id,input:payload};
 if(selected.action==='dispatchClosureCommand')return{action:'closureCommand',commandId:selected.commandId};
 if(selected.action==='dispatchPreflight')return{action:'preflight',input:payload};
 if(selected.action==='dispatchStatus')return{action:'status'};
 if(selected.action==='dispatchHistory')return{action:'history',candidateId:selected.candidateId,limit:payload.limit,before:payload.before};
 return{action:selected.action==='dispatchRun'?'run':selected.action==='dispatchRecover'?'recover':'command',commandId:selected.commandId??payload.command_id,...(selected.action==='dispatchRun'?{input:payload}:{})};
}
export const isDispatchMutation=action=>['dispatchRun','dispatchRecover','dispatchCloseExpired'].includes(action);
export const dispatchMutationPath=(path,method)=>method==='POST'&&['/internal/v1/fiscal-authorization/reviewed/run','/internal/v1/fiscal-authorization/reviewed/recover','/internal/v1/fiscal-authorization/reviewed/close-expired'].includes(path);
