import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {signedId,signedShape} from './fiscal-signed-model.ts';
import {captureSubsetReviewRequest,subsetReviewResponse,type SubsetReviewSelected} from './fiscal-subset-review-model.ts';

export interface FiscalSubsetReviewClientPorts {origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch;}
export class SubsetReviewClientError extends AccessError {
 readonly recovery_required:boolean;
 readonly upstream_status:number|null;
 constructor(status:number,code:string,recoveryRequired=false,upstreamStatus:number|null=null){super(recoveryRequired&&status<500?503:status,code);this.name='SubsetReviewClientError';this.recovery_required=recoveryRequired;this.upstream_status=upstreamStatus;}
}
import {ERROR_CODES as CODES} from '../../../../packages/fiscal-authorization-runtime/src/protocol.mjs';
import {MAX_REVIEW_REQUEST_BYTES,MAX_REVIEW_RESPONSE_BYTES} from '../../../../packages/fiscal-authorization-runtime/src/review-protocol.mjs';
const ERROR_CODES=new Set<string>(CODES);
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
function invalid():never {throw new SubsetReviewClientError(400,'AUTHORIZATION_INVALID_REQUEST');}
/** No automatic invocation or retry. The caller retains the original command when recovery_required is true. */
export function createFiscalSubsetReviewClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:FiscalSubsetReviewClientPorts){
 let base:URL;try{base=new URL(origin);}catch{throw new SubsetReviewClientError(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getToken!=='function'||typeof getSnapshot!=='function'||getEpoch!==undefined&&typeof getEpoch!=='function'||typeof fetchImpl!=='function')throw new SubsetReviewClientError(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  // Capture the route, signal and serialized body before the first asynchronous boundary.
  let selected:SubsetReviewSelected;try{selected=captureSubsetReviewRequest(path,options);}catch(error){if(error instanceof SubsetReviewClientError)throw error;return invalid();}
  const body=selected.action==='reviewSave'?JSON.stringify(selected.payload):undefined;
  if(body!==undefined&&new TextEncoder().encode(body).length>MAX_REVIEW_REQUEST_BYTES)invalid();
  const initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  if(initial.phase!=='ready'||!signedId(actor))throw new SubsetReviewClientError(401,'AUTHORIZATION_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))throw new SubsetReviewClientError(403,'AUTHORIZATION_FORBIDDEN');
  const controller=new AbortController();let sent=false,timeout=false,rejectStop:(error:unknown)=>void=()=>{},response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const deadline=Date.now()+65000;
  const uncertain=()=>sent&&selected.action==='reviewSave';
  const sessionChanged=()=>{const state=getSnapshot();return state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','fiscal'].includes(state.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const cancelled=()=>sessionChanged()?new DOMException('Session changed','AbortError'):uncertain()?new SubsetReviewClientError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',true):new DOMException('Request cancelled','AbortError');
  const onAbort=()=>{controller.abort();rejectStop(cancelled());};
  const timer=setTimeout(()=>{timeout=true;controller.abort();rejectStop(new SubsetReviewClientError(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain()));},65000);
  selected.signal?.addEventListener('abort',onAbort,{once:true});if(selected.signal?.aborted)onAbort();
  const check=()=>{if(sessionChanged())throw new DOMException('Session changed','AbortError');if(selected.signal?.aborted)throw cancelled();if(timeout||Date.now()>=deadline)throw new SubsetReviewClientError(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain());if(controller.signal.aborted)throw cancelled();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!token||token.length>8192||!/^[-A-Za-z0-9_.]+$/.test(token))throw new SubsetReviewClientError(401,'AUTHORIZATION_UNAUTHENTICATED');
   const url=base.origin+path;
   const pending=Promise.resolve().then(()=>{check();sent=true;return fetchImpl(url,{method:selected.method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body,credentials:'omit',cache:'no-store',redirect:'manual',referrerPolicy:'no-referrer',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!JSON_TYPE.test(response.headers.get('content-type')??'')||!response.body)throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());
   // Browser Fetch decodes HTTP compression. Bound decoded bytes and compare length only for identity coding.
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?MAX_REVIEW_RESPONSE_BYTES:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.byteLength)>limit)throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());text+=decoder.decode(item.value,{stream:true});}
   if(identity&&length!==null&&Number(length)!==count)throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());}
   if(!response.ok){
    if(!HTTP.has(response.status)||!signedShape(value,['error','recovery_required'],['command_id'])||typeof value.error!=='string'||!ERROR_CODES.has(value.error)||typeof value.recovery_required!=='boolean')throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain(),response.status);
    if(value.recovery_required&&selected.action!=='reviewSave'||Object.hasOwn(value,'command_id')&&(selected.action==='reviewContext'||value.command_id!==(selected.action==='reviewSave'?selected.payload.command_id:selected.commandId)))throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain(),response.status);
    throw new SubsetReviewClientError(response.status,value.error,value.recovery_required,response.status);
   }
   try{
    const result=subsetReviewResponse(value,selected);check();return result;
   }catch(error){if(error instanceof SubsetReviewClientError||error instanceof DOMException&&error.name==='AbortError')throw error;throw new SubsetReviewClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());}
  }catch(error){
   if(sessionChanged())throw new DOMException('Session changed','AbortError');
   if(error instanceof SubsetReviewClientError)throw error;
   if(selected.signal?.aborted)throw cancelled();
   if(error instanceof AccessError){const recover=uncertain();throw new SubsetReviewClientError(error.status,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recover,error.status);}
   if(error instanceof DOMException&&error.name==='AbortError'&&!uncertain())throw error;
   throw new SubsetReviewClientError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain());
  }finally{clearTimeout(timer);selected.signal?.removeEventListener('abort',onAbort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Late body read is fenced. */}}else try{void response?.body?.cancel().catch(()=>{});}catch{/* Cleanup only. */}}
 };
}
