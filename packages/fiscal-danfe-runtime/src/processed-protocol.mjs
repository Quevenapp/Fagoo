/** Separate, read-only historical document routes. The candidate-preview contract is unchanged. */
import {need,uuid} from './protocol.mjs';
export {DanfeRuntimeError,need,exact,plain,uuid,sha256,version,readBounded} from './protocol.mjs';
export const MAX_XML_BYTES=512000,MAX_XML_RESPONSE_BYTES=1048576,MAX_HTML_BYTES=4194304,MAX_RESPONSE_BYTES=8388608;
export {ERROR_CODES} from './protocol.mjs';
export function route(path,method,prefix='/internal/v1/fiscal-danfe'){
 need(typeof path==='string'&&['/internal/v1/fiscal-danfe','/v1/fiscal-danfe'].includes(prefix),404,'DANFE_NOT_FOUND');
 const m=new RegExp('^'+prefix+'/(authorizations|revalidations|receipt-queries)/([^/]+)/(xml|print)$').exec(path);
 need(m&&uuid(m[2]),404,'DANFE_NOT_FOUND');need(method==='GET',405,'DANFE_METHOD_NOT_ALLOWED');
 return Object.freeze({action:m[3],sourceKind:m[1]==='authorizations'?'authorization':m[1]==='revalidations'?'revalidation':'receipt_query',commandId:m[2],path,method,limit:0,responseLimit:m[3]==='xml'?MAX_XML_RESPONSE_BYTES:MAX_RESPONSE_BYTES});
}
export function parsePayload(bytes,selected){need(bytes instanceof Uint8Array&&bytes.length===0&&['xml','print'].includes(selected?.action)&&selected.method==='GET',400,'DANFE_BODY_INVALID');return Object.freeze({});}
