import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {signedId,signedShape} from './fiscal-signed-model.ts';
import {captureFiscalReceiptQueryRequest} from './fiscal-receipt-query-request.ts';
import {projectReceiptQueryPublic} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import {ERROR_CODES} from '../../../../packages/fiscal-authorization-runtime/src/protocol.mjs';

export interface FiscalReceiptQueryClientPorts {origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch;}
export class ReceiptQueryClientError extends AccessError {
 readonly recovery_required:boolean;
 readonly upstream_status:number|null;
 constructor(status:number,code:string,recoveryRequired=false,upstreamStatus:number|null=null){super(recoveryRequired&&status<500?503:status,code);this.name='ReceiptQueryClientError';this.recovery_required=recoveryRequired;this.upstream_status=upstreamStatus;}
}
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
function invalid():never {throw new ReceiptQueryClientError(400,'AUTHORIZATION_INVALID_REQUEST');}
/** No automatic invocation or retry. The caller retains the original command when recovery_required is true. */
export function createFiscalReceiptQueryClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:FiscalReceiptQueryClientPorts){
 let base:URL;try{base=new URL(origin);}catch{throw new ReceiptQueryClientError(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getToken!=='function'||typeof getSnapshot!=='function'||getEpoch!==undefined&&typeof getEpoch!=='function'||typeof fetchImpl!=='function')throw new ReceiptQueryClientError(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  // Capture the route, signal and serialized body before the first asynchronous boundary.
  let selected:ReturnType<typeof captureFiscalReceiptQueryRequest>;try{selected=captureFiscalReceiptQueryRequest(path,options);}catch(error){if(error instanceof ReceiptQueryClientError)throw error;return invalid();}
  const body=selected.options.body===undefined?undefined:JSON.stringify(selected.options.body);
  if(body!==undefined&&new TextEncoder().encode(body).length>selected.requestLimit)invalid();
  const initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  if(initial.phase!=='ready'||!signedId(actor))throw new ReceiptQueryClientError(401,'AUTHORIZATION_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))throw new ReceiptQueryClientError(403,'AUTHORIZATION_FORBIDDEN');
  const controller=new AbortController();let sent=false,timeout=false,rejectStop:(error:unknown)=>void=()=>{},response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const deadline=Date.now()+selected.timeoutMs;
  const uncertain=()=>sent&&selected.mutation;
  const sessionChanged=()=>{const state=getSnapshot();return state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','fiscal'].includes(state.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const cancelled=()=>sessionChanged()?new DOMException('Session changed','AbortError'):uncertain()?new ReceiptQueryClientError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',true):new DOMException('Request cancelled','AbortError');
  const onAbort=()=>{controller.abort();rejectStop(cancelled());};
  const timer=setTimeout(()=>{timeout=true;controller.abort();rejectStop(new ReceiptQueryClientError(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain()));},selected.timeoutMs);
  selected.options.signal?.addEventListener('abort',onAbort,{once:true});if(selected.options.signal?.aborted)onAbort();
  const check=()=>{if(sessionChanged())throw new DOMException('Session changed','AbortError');if(selected.options.signal?.aborted)throw cancelled();if(timeout||Date.now()>=deadline)throw new ReceiptQueryClientError(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain());if(controller.signal.aborted)throw cancelled();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!token||token.length>8192||!/^[-A-Za-z0-9_.]+$/.test(token))throw new ReceiptQueryClientError(401,'AUTHORIZATION_UNAUTHENTICATED');
   const url=base.origin+path;
   const pending=Promise.resolve().then(()=>{check();sent=true;return fetchImpl(url,{method:selected.options.method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body,credentials:'omit',cache:'no-store',redirect:'manual',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!JSON_TYPE.test(response.headers.get('content-type')??'')||!response.body)throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());
   // Browser Fetch decodes HTTP compression. Bound decoded bytes and compare length only for identity coding.
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?selected.responseLimit:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.byteLength)>limit)throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());try{text+=decoder.decode(item.value,{stream:true});}catch{throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());}}
   if(identity&&length!==null&&Number(length)!==count)throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());}
   if(!response.ok){
    if(!HTTP.has(response.status)||!signedShape(value,['error','recovery_required'],['command_id'])||typeof value.error!=='string'||!ERROR_CODES.includes(value.error)||typeof value.recovery_required!=='boolean'||value.recovery_required&&!selected.mutation||Object.hasOwn(value,'command_id')&&(!('commandId' in selected.binding)||value.command_id!==selected.binding.commandId))throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain(),response.status);
    throw new ReceiptQueryClientError(response.status,value.error,value.recovery_required&&selected.mutation,response.status);
   }
   try{
    const result=projectReceiptQueryPublic(value,selected.binding);check();return result;
   }catch(error){if(error instanceof ReceiptQueryClientError||error instanceof DOMException&&error.name==='AbortError')throw error;throw new ReceiptQueryClientError(502,'AUTHORIZATION_RESPONSE_INVALID',uncertain());}
  }catch(error){
   if(sessionChanged())throw new DOMException('Session changed','AbortError');
   if(error instanceof ReceiptQueryClientError)throw error;
   if(selected.options.signal?.aborted)throw cancelled();
   if(error instanceof AccessError){const recover=uncertain();throw new ReceiptQueryClientError(error.status,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',recover,error.status);}
   if(error instanceof DOMException&&error.name==='AbortError'&&!uncertain())throw error;
   throw new ReceiptQueryClientError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE',uncertain());
  }finally{clearTimeout(timer);selected.options.signal?.removeEventListener('abort',onAbort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Late body read is fenced. */}}else try{void response?.body?.cancel().catch(()=>{});}catch{/* Cleanup only. */}}
 };
}
