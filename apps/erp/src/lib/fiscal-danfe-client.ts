import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {publicResult,type DanfePreview} from '../../../../packages/fiscal-danfe-runtime/src/dto.mjs';
import {ERROR_CODES,MAX_RESPONSE_BYTES} from '../../../../packages/fiscal-danfe-runtime/src/protocol.mjs';

export const DANFE_BASE='/v1/fiscal-danfe';
export class DanfeClientError extends AccessError {constructor(status:number,code:string){super(status,code);this.name='DanfeClientError';}}
type Ports={origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch};
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const fail=(status:number,code:string):never=>{throw new DanfeClientError(status,code);};
const data=(value:unknown,keys:string[]):Record<string,unknown>=>{
 if(value===null||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail(400,'DANFE_INVALID_REQUEST');
 const descriptors=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(descriptors);
 if(own.some(k=>typeof k!=='string'||!keys.includes(k)||!Object.hasOwn(descriptors[k],'value')||!descriptors[k].enumerable))return fail(400,'DANFE_INVALID_REQUEST');
 return Object.fromEntries(own.map(k=>[k,descriptors[k as string].value]));
};

/** Read-only, bounded preview. A session change discards the whole HTML and no request retries automatically. */
export function createFiscalDanfeClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:Ports){
 let base:URL;try{base=new URL(origin);}catch{return fail(503,'DANFE_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password)return fail(503,'DANFE_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<DanfePreview>=>{
  const own=data(options,['method','signal']);
  const match=typeof path==='string'&&new RegExp(`^${DANFE_BASE}/candidates/([a-f0-9-]+)/preview$`).exec(path);
  if(!match||!UUID.test(match[1])||own.method!==undefined&&own.method!=='GET'||own.signal!==undefined&&!(own.signal instanceof AbortSignal))return fail(400,'DANFE_INVALID_REQUEST');
  const candidateId=match[1],signal=own.signal as AbortSignal|undefined,initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  if(initial.phase!=='ready'||!actor||!UUID.test(actor))return fail(401,'DANFE_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))return fail(403,'DANFE_FORBIDDEN');
  const controller=new AbortController(),deadline=Date.now()+65000;let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined,rejectStop:(e:unknown)=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const changed=()=>{const s=getSnapshot();return s.phase!=='ready'||s.membership?.user_id!==actor||!['admin','fiscal'].includes(s.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const abortError=()=>new DOMException('Request cancelled','AbortError');
  const abort=()=>{controller.abort();rejectStop(abortError());};
  const check=()=>{if(changed()||signal?.aborted)throw abortError();if(Date.now()>=deadline)fail(504,'DANFE_UPSTREAM_UNAVAILABLE');if(controller.signal.aborted)throw abortError();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  timer=setTimeout(()=>{controller.abort();rejectStop(new DanfeClientError(504,'DANFE_UPSTREAM_UNAVAILABLE'));},65000);
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!/^[A-Za-z0-9_.-]{20,8192}$/.test(token))return fail(401,'DANFE_UNAUTHENTICATED');
   const url=base.origin+path,pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},cache:'no-store',credentials:'omit',redirect:'manual',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||!response.body)return fail(502,'DANFE_RESPONSE_INVALID');
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?MAX_RESPONSE_BYTES:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))return fail(502,'DANFE_RESPONSE_INVALID');
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.length)>limit)return fail(502,'DANFE_RESPONSE_INVALID');text+=decoder.decode(item.value,{stream:true});}
   if(identity&&length!==null&&Number(length)!==count)return fail(502,'DANFE_RESPONSE_INVALID');check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{return fail(502,'DANFE_RESPONSE_INVALID');}text='';
   if(!response.ok){
    const v=value as {error?:unknown;recovery_required?:unknown};
    if(!HTTP.has(response.status)||v===null||typeof v!=='object'||Object.keys(v).length!==2||typeof v.error!=='string'||!ERROR_CODES.includes(v.error)||v.recovery_required!==false)return fail(502,'DANFE_RESPONSE_INVALID');
    return fail(response.status,v.error);
   }
   try{const result=await bounded(()=>publicResult(value,{candidateId}));check();return result;}
   catch(error){if(error instanceof DOMException&&error.name==='AbortError'||error instanceof DanfeClientError)throw error;return fail(502,'DANFE_RESPONSE_INVALID');}
  }catch(error){
   if(changed()||signal?.aborted)throw abortError();if(error instanceof DanfeClientError||error instanceof AccessError)throw error;
   if(error instanceof DOMException&&error.name==='AbortError')throw error;return fail(503,'DANFE_UPSTREAM_UNAVAILABLE');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else try{void response?.body?.cancel().catch(()=>{});}catch{}}
 };
}
