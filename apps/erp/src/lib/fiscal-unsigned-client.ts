import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {UNSIGNED_BASE,unsignedId} from './fiscal-unsigned-model.ts';

export interface UnsignedClientPorts {origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch;}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const version=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=2147483647;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function allowed(path:string,options:NativeRequestOptions):string|undefined{
 const method=options.method??'GET',data=options.body;
 if(typeof path!=='string'||/[?#%\\]/.test(path)||path.startsWith('//'))throw new AccessError(400);
 if(new RegExp(`^${UNSIGNED_BASE}/(?:jobs|commands)/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(path)){
  if(method!=='GET'||data!==undefined)throw new AccessError(400);return;
 }
 if(method!=='POST')throw new AccessError(400);
 if(path===`${UNSIGNED_BASE}/preview`){if(!exact(data,['draft_id','completion_version'])||!unsignedId(data.draft_id)||!version(data.completion_version))throw new AccessError(400);}
 else if(path===`${UNSIGNED_BASE}/generate`){if(!exact(data,['command_id','reservation_id','draft_id','completion_version','completion_hash','basis_hash'])||!['command_id','reservation_id','draft_id'].every(k=>unsignedId(data[k]))||!version(data.completion_version)||!hash(data.completion_hash)||!hash(data.basis_hash))throw new AccessError(400);}
 else if(path===`${UNSIGNED_BASE}/history`){if(!exact(data,['reservation_id','limit','before'])||!unsignedId(data.reservation_id)||!Number.isInteger(data.limit)||(data.limit as number)<1||(data.limit as number)>25||data.before!==null&&!version(data.before))throw new AccessError(400);}
 else throw new AccessError(400);
 const body=JSON.stringify(data);if(new TextEncoder().encode(body).byteLength>4096)throw new AccessError(400);return body;
}

/** Isolated gateway port. Does not create an Auth client, persist a token or change the shared controller. */
export function createFiscalUnsignedClient(ports:UnsignedClientPorts){
 let base:URL;try{base=new URL(ports.origin);}catch{throw new AccessError(503);}
 if(base.protocol!=='https:'||base.origin!==ports.origin||base.username||base.password)throw new AccessError(503);
 const fetcher=ports.fetchImpl??fetch;
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  const body=allowed(path,options),initial=ports.getSnapshot(),actor=initial.membership?.user_id,epoch=ports.getEpoch?.();
  if(initial.phase!=='ready'||!actor||!['admin','fiscal'].includes(initial.membership!.role))throw new AccessError(initial.phase==='ready'?403:401);
  const pending=new AbortController();let reason=503,rejectStop:(error:unknown)=>void=()=>{};
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});
  const abort=()=>{pending.abort();rejectStop(new DOMException('Request cancelled','AbortError'));};
  const timer=setTimeout(()=>{reason=504;pending.abort();rejectStop(new AccessError(504));},65000);
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const check=()=>{const state=ports.getSnapshot();if(pending.signal.aborted)throw options.signal?.aborted?new DOMException('Request cancelled','AbortError'):new AccessError(reason);if(state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','fiscal'].includes(state.membership.role)||ports.getEpoch&&ports.getEpoch()!==epoch)throw new DOMException('Session changed','AbortError');};
  const bounded=<T,>(fn:()=>Promise<T>)=>Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);
  let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const token=await bounded(async()=>ports.getToken());check();if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw new AccessError(401);
   const request=Promise.resolve().then(()=>{check();return fetcher(`${base.origin}${path}`,{method:options.method??'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body,cache:'no-store',credentials:'omit',redirect:'manual',signal:pending.signal});});
   try{response=await bounded(()=>request);}catch(error){void request.then(r=>r.body?.cancel()).catch(()=>{});throw error;}
   check();if(response.redirected||response.status>=300&&response.status<400||response.status===0)throw new AccessError(502);
   if(!response.ok)throw new AccessError([400,401,403,404,409,413,429,500,502,503,504].includes(response.status)?response.status:502);
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||!response.body)throw new AccessError(502);
   const length=response.headers.get('content-length');if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>131072))throw new AccessError(502);
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const part=await bounded(()=>reader!.read());if(part.done)break;if(!(part.value instanceof Uint8Array)||(count+=part.value.byteLength)>131072)throw new AccessError(502);text+=decoder.decode(part.value,{stream:true});}
   if(length!==null&&Number(length)!==count)throw new AccessError(502);check();return JSON.parse(text+decoder.decode());
  }catch(error){if(error instanceof AccessError||error instanceof DOMException&&error.name==='AbortError')throw error;throw new AccessError(503);}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);pending.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Pending read is already fenced. */}}else void response?.body?.cancel().catch(()=>{});}
 };
}
