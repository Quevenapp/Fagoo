import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {captureAuthorizationRequest,authorizationResponse,type AuthorizationSelected} from './fiscal-authorization-model.ts';
import {ERROR_CODES,MAX_RESPONSE_BYTES} from '../../../../packages/fiscal-authorization-runtime/src/protocol.mjs';

export class AuthorizationClientError extends AccessError {constructor(status:number,code:string){super(status,code);this.name='AuthorizationClientError';}}
type Ports={origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch};
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const fail=(status:number,code:string):never=>{throw new AuthorizationClientError(status,code);};
/** Read-only, bounded preview/history. A session change discards the whole result and no request retries automatically. */
export function createFiscalAuthorizationClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:Ports){
 let base:URL;try{base=new URL(origin);}catch{return fail(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password)return fail(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  let selected:AuthorizationSelected;try{selected=captureAuthorizationRequest(path,options);}catch{return fail(400,'AUTHORIZATION_INVALID_REQUEST');}
  const signal=selected.signal,initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  const body=selected.action==='command'?undefined:JSON.stringify(selected.payload);
  if(initial.phase!=='ready'||typeof actor!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(actor))return fail(401,'AUTHORIZATION_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))return fail(403,'AUTHORIZATION_FORBIDDEN');
  const controller=new AbortController(),deadline=Date.now()+65000;let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined,rejectStop:(e:unknown)=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const changed=()=>{const s=getSnapshot();return s.phase!=='ready'||s.membership?.user_id!==actor||!['admin','fiscal'].includes(s.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const abortError=()=>new DOMException('Request cancelled','AbortError');
  const abort=()=>{controller.abort();rejectStop(abortError());};
  const check=()=>{if(changed()||signal?.aborted)throw abortError();if(Date.now()>=deadline)fail(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');if(controller.signal.aborted)throw abortError();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>{controller.abort();rejectStop(new AuthorizationClientError(504,'AUTHORIZATION_UPSTREAM_UNAVAILABLE'));},65000);
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!/^[A-Za-z0-9_.-]{20,8192}$/.test(token))return fail(401,'AUTHORIZATION_UNAUTHENTICATED');
   const url=base.origin+path,pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:selected.method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body,cache:'no-store',credentials:'omit',redirect:'manual',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||!response.body)return fail(502,'AUTHORIZATION_RESPONSE_INVALID');
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?MAX_RESPONSE_BYTES:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))return fail(502,'AUTHORIZATION_RESPONSE_INVALID');
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.length)>limit)return fail(502,'AUTHORIZATION_RESPONSE_INVALID');text+=decoder.decode(item.value,{stream:true});}
   if(identity&&length!==null&&Number(length)!==count)return fail(502,'AUTHORIZATION_RESPONSE_INVALID');check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{return fail(502,'AUTHORIZATION_RESPONSE_INVALID');}text='';
   if(!response.ok){
    const v=value as {error?:unknown;recovery_required?:unknown;command_id?:unknown};
    if(!HTTP.has(response.status)||v===null||typeof v!=='object'||Object.keys(v).some(k=>!['error','recovery_required','command_id'].includes(k))||Object.hasOwn(v,'command_id')&&(selected.action!=='command'||v.command_id!==selected.id)||typeof v.error!=='string'||!ERROR_CODES.includes(v.error)||v.recovery_required!==false)return fail(502,'AUTHORIZATION_RESPONSE_INVALID');
    return fail(response.status,v.error);
   }
   try{const result=await bounded(()=>authorizationResponse(value,selected));check();return result;}
   catch(error){if(error instanceof DOMException&&error.name==='AbortError'||error instanceof AuthorizationClientError)throw error;return fail(502,'AUTHORIZATION_RESPONSE_INVALID');}
  }catch(error){
   if(changed()||signal?.aborted)throw abortError();if(error instanceof AuthorizationClientError||error instanceof AccessError)throw error;
   if(error instanceof DOMException&&error.name==='AbortError')throw error;return fail(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else try{void response?.body?.cancel().catch(()=>{});}catch{}}
 };
}
