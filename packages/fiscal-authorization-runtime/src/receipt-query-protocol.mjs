/** Receipt-query089 routes: context/history POSTs are reads; run and local recovery are mutations. */
import {AuthorizationHttpError,need,uuid,freeze} from '../../fiscal-authorization-http/src/protocol.mjs';
import {captureReceiptQueryContextInput,captureReceiptQueryHistoryInput,captureReceiptQueryRunInput,captureReceiptQueryRecoverInput,projectReceiptQueryPublic,MAX_RECEIPT_QUERY_INPUT_BYTES,MAX_RECEIPT_QUERY_PUBLIC_BYTES} from '../../fiscal-authorization/src/receipt-query-public-dto.mjs';
export const MAX_RECEIPT_QUERY_REQUEST_BYTES=MAX_RECEIPT_QUERY_INPUT_BYTES;
export const MAX_RECEIPT_QUERY_RESPONSE_BYTES=MAX_RECEIPT_QUERY_PUBLIC_BYTES;
const routes=new WeakSet();
export function receiptQueryRoute(path,method,prefix){
 const base=prefix+'/reviewed';
 const context=path===base+'/receipt-query-context',history=path===base+'/receipt-query-history',run=path===base+'/receipt-queries';
 const command=new RegExp('^'+base+'/receipt-query-commands/([^/]+)(/recover)?$').exec(path);
 if(!context&&!history&&!run&&!command)return null;
 need(!command||uuid(command[1]),404,'AUTHORIZATION_NOT_FOUND');
 const recover=Boolean(command?.[2]),expected=command&&!recover?'GET':'POST';
 need(method===expected,405,'AUTHORIZATION_METHOD_NOT_ALLOWED');
 const selected=freeze({action:context?'receiptQueryContext':history?'receiptQueryHistory':run?'receiptQueryRun':recover?'receiptQueryRecover':'receiptQueryCommand',path,method,receiptQuery:true,
  ...(command?{commandId:command[1]}:{}),limit:expected==='GET'?0:MAX_RECEIPT_QUERY_REQUEST_BYTES,responseLimit:MAX_RECEIPT_QUERY_RESPONSE_BYTES});
 routes.add(selected);return selected;
}
export function parseReceiptQueryPayload(bytes,selected){
 need(routes.has(selected)&&bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer&&bytes.length<=selected.limit);
 if(selected.method==='GET'){need(bytes.length===0);return Object.freeze({});}
 let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
 const capture=selected.action==='receiptQueryContext'?captureReceiptQueryContextInput:selected.action==='receiptQueryHistory'?captureReceiptQueryHistoryInput:selected.action==='receiptQueryRun'?captureReceiptQueryRunInput:captureReceiptQueryRecoverInput;
 try{return capture(raw);}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
}
export function receiptQueryBinding(selected,payload){
 need(routes.has(selected));
 if(selected.action==='receiptQueryCommand')return freeze({action:selected.action,commandId:selected.commandId});
 if(selected.action==='receiptQueryRecover')return freeze({action:selected.action,commandId:selected.commandId,input:payload});
 if(selected.action==='receiptQueryRun')return freeze({action:selected.action,commandId:payload.command_id,input:payload});
 return freeze({action:selected.action,input:payload});
}
export const isReceiptQueryMutation=action=>action==='receiptQueryRun'||action==='receiptQueryRecover';
export function receiptQueryMutationPath(path,method){
 if(method!=='POST')return false;
 if(path==='/internal/v1/fiscal-authorization/reviewed/receipt-queries')return true;
 const recover=/^\/internal\/v1\/fiscal-authorization\/reviewed\/receipt-query-commands\/([^/]+)\/recover$/.exec(path);
 return Boolean(recover&&uuid(recover[1]));
}
export function projectReceiptQueryResult(value,binding){try{return projectReceiptQueryPublic(value,binding);}catch{throw new AuthorizationHttpError(502,'AUTHORIZATION_RESPONSE_INVALID');}}
