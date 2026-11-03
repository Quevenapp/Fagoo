/** Own authenticated domain. Routes reuse the reviewed public HTTP syntax. */
import {AuthorizationHttpError,need,route as httpRoute,parsePayload as httpPayload,readBounded as httpRead,uuid,hash,data,MAX_JSON_BYTES,MAX_RESPONSE_BYTES} from '../../fiscal-authorization-http/src/protocol.mjs';
import {dispatchRoute,parseDispatchPayload} from './dispatch-protocol.mjs';
import {reviewRoute,parseReviewPayload,MAX_REVIEW_RESPONSE_BYTES} from './review-protocol.mjs';
import {revalidationRoute,parseRevalidationPayload} from './revalidation-protocol.mjs';
import {receiptQueryRoute,parseReceiptQueryPayload} from './receipt-query-protocol.mjs';
export {AuthorizationHttpError as AuthorizationRuntimeError,need,uuid,hash as sha256,MAX_JSON_BYTES,MAX_RESPONSE_BYTES};
export const PUBLIC_PREFIX='/v1/fiscal-authorization',INTERNAL_PREFIX='/internal/v1/fiscal-authorization';
export const ERROR_CODES=Object.freeze(['AUTHORIZATION_NFCE_EMISSION_EXPIRED','AUTHORIZATION_NFCE_EMISSION_FUTURE','AUTHORIZATION_NFCE_EMISSION_WINDOW_TOO_SHORT','AUTHORIZATION_SERVICE_DISABLED','AUTHORIZATION_INVALID_REQUEST','AUTHORIZATION_NOT_FOUND','AUTHORIZATION_METHOD_NOT_ALLOWED','AUTHORIZATION_UNAUTHENTICATED','AUTHORIZATION_BODY_INVALID','AUTHORIZATION_BODY_TOO_LARGE','AUTHORIZATION_ENCODING_UNSUPPORTED','AUTHORIZATION_BODY_TIMEOUT','AUTHORIZATION_CONTENT_TYPE_UNSUPPORTED','AUTHORIZATION_REQUEST_UNCONFIRMED','AUTHORIZATION_RESPONSE_INVALID','AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE','AUTHORIZATION_FORBIDDEN','AUTHORIZATION_CONFLICT','AUTHORIZATION_SERVICE_UNAVAILABLE','AUTHORIZATION_RUNTIME_UNAUTHORIZED','AUTHORIZATION_BODY_AUTHENTICATION_FAILED','AUTHORIZATION_RUNTIME_BUSY','AUTHORIZATION_UPSTREAM_UNAVAILABLE','AUTHORIZATION_RUNTIME_FAILED','AUTHORIZATION_GATEWAY_UNAVAILABLE','AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID','AUTHORIZATION_ORIGIN_FORBIDDEN','AUTHORIZATION_AUTH_SERVICE_UNAVAILABLE']);
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(v,keys)=>{try{data(v,keys);return true;}catch{return false;}};
// Workerd inherits Body accessors; Node keeps them on Request.prototype. Resolve only native prototypes.
const requestGetters=Object.fromEntries(['url','method','headers','body','signal'].map(k=>{let p=Request.prototype,d;while(p&&!d){d=Object.getOwnPropertyDescriptor(p,k);p=Object.getPrototypeOf(p);}return[k,d?.get];}));
export function captureRequest(request){
 try{need(request instanceof Request);const v=Object.fromEntries(Object.entries(requestGetters).map(([k,get])=>[k,get.call(request)]));v.headers=new Headers(v.headers);return Object.freeze(v);}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_INVALID_REQUEST');}
}
const originals=new WeakMap();
export function route(path,method,prefix=INTERNAL_PREFIX){
 need([PUBLIC_PREFIX,INTERNAL_PREFIX].includes(prefix)&&typeof path==='string'&&path.startsWith(prefix+'/'),404,'AUTHORIZATION_NOT_FOUND');
 const receiptQuery=receiptQueryRoute(path,method,prefix);if(receiptQuery){originals.set(receiptQuery,receiptQuery);return receiptQuery;}
 const revalidation=revalidationRoute(path,method,prefix);if(revalidation){originals.set(revalidation,revalidation);return revalidation;}
 const dispatch=dispatchRoute(path,method,prefix);if(dispatch){originals.set(dispatch,dispatch);return dispatch;}
 const review=reviewRoute(path,method,prefix);if(review){originals.set(review,review);return review;}
 const source=httpRoute(PUBLIC_PREFIX+path.slice(prefix.length),method),selected=Object.freeze({...source,path});originals.set(selected,source);return selected;
}
export function parsePayload(bytes,selected){need(originals.has(selected),400,'AUTHORIZATION_INVALID_REQUEST');return selected.receiptQuery?parseReceiptQueryPayload(bytes,selected):selected.revalidation?parseRevalidationPayload(bytes,selected):selected.dispatch?parseDispatchPayload(bytes,selected):selected.review?parseReviewPayload(bytes,selected):httpPayload(bytes,originals.get(selected));}
export function requestScope(signal,deadline){
 need(signal instanceof AbortSignal&&Number.isSafeInteger(deadline),400,'AUTHORIZATION_INVALID_REQUEST');
 const parent=signal,abort=new AbortController();let rejectStop,stopped=false;
 const end=new Promise((_,reject)=>{rejectStop=reject;});end.catch(()=>{});
 const stop=()=>{if(stopped)return;stopped=true;abort.abort();rejectStop(new AuthorizationHttpError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE'));};
 parent.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));
 const check=()=>{if(parent.aborted||Date.now()>=deadline)stop();need(!stopped,503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');};
 return{signal:abort.signal,deadline,check,stop,bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),end]);},close(){clearTimeout(timer);parent.removeEventListener('abort',stop);abort.abort();}};
}
export async function readBounded(message,{limit,signal,deadline}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_REVIEW_RESPONSE_BYTES,400,'AUTHORIZATION_INVALID_REQUEST');const s=requestScope(signal,deadline);
 try{return await httpRead(message,limit,s);}finally{s.close();}
}
export function resultBinding(selected,payload){
 if(selected.action==='preview')return {action:'preview',candidateId:payload.candidate_id,signedHash:payload.signed_hash};
 if(selected.action==='history')return {action:'history',candidateId:selected.candidateId,limit:payload.limit,before:payload.before};
 return {action:selected.action,commandId:selected.commandId??payload.command_id};
}
