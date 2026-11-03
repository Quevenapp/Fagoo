/** Stored-response revalidation only. Both historical IDs are covered by the path HMAC. */
import {AuthorizationHttpError,need,uuid,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
import {captureRevalidationInput,projectRevalidationPublic} from '../../fiscal-authorization/src/revalidation-public-dto.mjs';
export const MAX_REVALIDATION_REQUEST_BYTES=16384,MAX_REVALIDATION_RESPONSE_BYTES=262144;
const routes=new WeakSet();
export function revalidationRoute(path,method,prefix){
 const base=prefix+'/reviewed';
 const context=new RegExp('^'+base+'/commands/([^/]+)/revalidation-context/([^/]+)$').exec(path);
 const command=new RegExp('^'+base+'/revalidation-commands/([^/]+)$').exec(path);
 const run=path===base+'/revalidations';
 if(!context&&!command&&!run)return null;
 need(!context||(uuid(context[1])&&uuid(context[2])),404,'AUTHORIZATION_NOT_FOUND');
 need(!command||uuid(command[1]),404,'AUTHORIZATION_NOT_FOUND');
 need(method===(run?'POST':'GET'),405,'AUTHORIZATION_METHOD_NOT_ALLOWED');
 const selected=freeze({action:run?'revalidationRun':context?'revalidationContext':'revalidationCommand',path,method,revalidation:true,
  ...(context?{authorizationCommandId:context[1],expectedAttemptId:context[2]}:{}),...(command?{commandId:command[1]}:{}),
  limit:run?MAX_REVALIDATION_REQUEST_BYTES:0,responseLimit:MAX_REVALIDATION_RESPONSE_BYTES});
 routes.add(selected);return selected;
}
export function parseRevalidationPayload(bytes,selected){
 need(routes.has(selected)&&bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer&&bytes.length<=selected.limit);
 if(selected.method==='GET'){need(bytes.length===0);return Object.freeze({});}
 let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
 try{return captureRevalidationInput(raw);}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
}
export function revalidationBinding(selected,payload){
 need(routes.has(selected));
 if(selected.action==='revalidationContext')return freeze({action:selected.action,authorizationCommandId:selected.authorizationCommandId,expectedAttemptId:selected.expectedAttemptId});
 if(selected.action==='revalidationCommand')return freeze({action:selected.action,commandId:selected.commandId});
 return freeze({action:selected.action,commandId:payload.command_id,input:payload});
}
export const isRevalidationMutation=action=>action==='revalidationRun';
export const revalidationMutationPath=(path,method)=>method==='POST'&&path==='/internal/v1/fiscal-authorization/reviewed/revalidations';
export function projectRevalidationResult(value,binding){try{return projectRevalidationPublic(value,binding);}catch{throw new AuthorizationHttpError(502,'AUTHORIZATION_RESPONSE_INVALID');}}
