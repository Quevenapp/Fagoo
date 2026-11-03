import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {SIGNED_BASE,signedId,signedShape,validSignedRun,signedCandidate,signedOutcome,signedHistory,type SignedRun} from './fiscal-signed-model.ts';

export interface FiscalSignedClientPorts {origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch;}
export class SignedClientError extends AccessError {
 readonly recovery_required:boolean;
 readonly upstream_status:number|null;
 constructor(status:number,code:string,recoveryRequired=false,upstreamStatus:number|null=null){super(recoveryRequired&&status<500?503:status,code);this.name='SignedClientError';this.recovery_required=recoveryRequired;this.upstream_status=upstreamStatus;}
}
const ERROR_CODES=new Set(['SIGNED_RUNTIME_UNAUTHORIZED','SIGNED_INVALID_REQUEST','SIGNED_NOT_FOUND','SIGNED_METHOD_NOT_ALLOWED','SIGNED_CONTENT_TYPE_UNSUPPORTED','SIGNED_RUNTIME_BUSY','SIGNED_BODY_AUTHENTICATION_FAILED','SIGNED_FORBIDDEN','SIGNED_CONFLICT','SIGNED_RUNTIME_FAILED','SIGNED_UPSTREAM_UNAVAILABLE','SIGNED_RESPONSE_INVALID','SIGNED_BODY_TOO_LARGE','SIGNED_BODY_INVALID','SIGNED_ENCODING_UNSUPPORTED','SIGNED_BODY_TIMEOUT','SIGNED_GATEWAY_UNAVAILABLE','SIGNED_RUNTIME_CONFIGURATION_INVALID','SIGNED_ORIGIN_FORBIDDEN','SIGNED_UNAUTHENTICATED','SIGNED_AUTH_SERVICE_UNAVAILABLE']);
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
function invalid():never {throw new SignedClientError(400,'SIGNED_INVALID_REQUEST');}
type Selected={action:'run'|'history'|'candidate'|'command';method:'GET'|'POST';body?:string;payload?:SignedRun;query?:{limit:number;before:number|null};id?:string;signal?:AbortSignal;};
function select(path:string,options:NativeRequestOptions):Selected {
 if(!signedShape(options,[],['method','body','signal'])||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||typeof path!=='string'||/[?#%\\]/.test(path))invalid();
 const method=options.method??'GET',signal=options.signal,data=options.body;
 if(path===SIGNED_BASE+'/run'){
  if(method!=='POST'||!validSignedRun(data))invalid();
  const payload=Object.freeze({command_id:data.command_id,unsigned_job_id:data.unsigned_job_id,unsigned_hash:data.unsigned_hash,basis_hash:data.basis_hash,expected_a1_version:data.expected_a1_version});
  return{action:'run',method,payload,body:JSON.stringify(payload),signal};
 }
 const history=new RegExp(`^${SIGNED_BASE}/jobs/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/history$`).exec(path);
 if(history){
  if(method!=='POST'||!signedShape(data,['limit','before'])||typeof data.limit!=='number'||!Number.isInteger(data.limit)||data.limit<1||data.limit>25||data.before!==null&&(typeof data.before!=='number'||!Number.isInteger(data.before)||data.before<1||data.before>2147483647))invalid();
  const query=Object.freeze({limit:data.limit,before:data.before as number|null});return{action:'history',method,id:history[1],query,body:JSON.stringify(query),signal};
 }
 const read=new RegExp(`^${SIGNED_BASE}/(candidates|commands)/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$`).exec(path);
 if(!read||method!=='GET'||data!==undefined)invalid();return{action:read[1]==='candidates'?'candidate':'command',method:'GET',id:read[2],signal};
}
/** No automatic invocation or retry. The caller retains the original command when recovery_required is true. */
export function createFiscalSignedClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:FiscalSignedClientPorts){
 let base:URL;try{base=new URL(origin);}catch{throw new SignedClientError(503,'SIGNED_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getToken!=='function'||typeof getSnapshot!=='function'||getEpoch!==undefined&&typeof getEpoch!=='function'||typeof fetchImpl!=='function')throw new SignedClientError(503,'SIGNED_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  // Capture the route, signal and serialized body before the first asynchronous boundary.
  let selected:Selected;try{selected=select(path,options);}catch(error){if(error instanceof SignedClientError)throw error;return invalid();}
  if(selected.body!==undefined&&new TextEncoder().encode(selected.body).length>4096)invalid();
  const initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  if(initial.phase!=='ready'||!signedId(actor))throw new SignedClientError(401,'SIGNED_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))throw new SignedClientError(403,'SIGNED_FORBIDDEN');
  const controller=new AbortController();let sent=false,timeout=false,rejectStop:(error:unknown)=>void=()=>{},response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const deadline=Date.now()+65000;
  const uncertain=()=>sent&&selected.action==='run';
  const sessionChanged=()=>{const state=getSnapshot();return state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','fiscal'].includes(state.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const cancelled=()=>sessionChanged()?new DOMException('Session changed','AbortError'):uncertain()?new SignedClientError(503,'SIGNED_UPSTREAM_UNAVAILABLE',true):new DOMException('Request cancelled','AbortError');
  const onAbort=()=>{controller.abort();rejectStop(cancelled());};
  const timer=setTimeout(()=>{timeout=true;controller.abort();rejectStop(new SignedClientError(504,'SIGNED_UPSTREAM_UNAVAILABLE',uncertain()));},65000);
  selected.signal?.addEventListener('abort',onAbort,{once:true});if(selected.signal?.aborted)onAbort();
  const check=()=>{if(sessionChanged())throw new DOMException('Session changed','AbortError');if(selected.signal?.aborted)throw cancelled();if(timeout||Date.now()>=deadline)throw new SignedClientError(504,'SIGNED_UPSTREAM_UNAVAILABLE',uncertain());if(controller.signal.aborted)throw cancelled();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!token||token.length>8192||!/^[-A-Za-z0-9_.]+$/.test(token))throw new SignedClientError(401,'SIGNED_UNAUTHENTICATED');
   const url=base.origin+path;
   const pending=Promise.resolve().then(()=>{check();sent=true;return fetchImpl(url,{method:selected.method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(selected.body===undefined?{}:{'Content-Type':'application/json'})},body:selected.body,credentials:'omit',cache:'no-store',redirect:'manual',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!JSON_TYPE.test(response.headers.get('content-type')??'')||!response.body)throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());
   // Browser Fetch decodes HTTP compression. Bound decoded bytes and compare length only for identity coding.
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?131072:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.byteLength)>limit)throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());text+=decoder.decode(item.value,{stream:true});}
   if(identity&&length!==null&&Number(length)!==count)throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());}
   if(!response.ok){
    if(!HTTP.has(response.status)||!signedShape(value,['error','recovery_required'])||typeof value.error!=='string'||!ERROR_CODES.has(value.error)||typeof value.recovery_required!=='boolean')throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain(),response.status);
    throw new SignedClientError(response.status,value.error,value.recovery_required&&selected.action==='run',response.status);
   }
   try{
    const result=selected.action==='run'?signedOutcome(value,selected.payload!):selected.action==='history'?signedHistory(value,selected.id!,selected.query):signedCandidate(value,{...(selected.action==='command'?{command_id:selected.id}:{candidate_id:selected.id}),read_only:true});check();return result;
   }catch(error){if(error instanceof SignedClientError||error instanceof DOMException&&error.name==='AbortError')throw error;throw new SignedClientError(502,'SIGNED_RESPONSE_INVALID',uncertain());}
  }catch(error){
   if(sessionChanged())throw new DOMException('Session changed','AbortError');
   if(error instanceof SignedClientError)throw error;
   if(selected.signal?.aborted)throw cancelled();
   if(error instanceof AccessError){const recover=uncertain();throw new SignedClientError(error.status,'SIGNED_UPSTREAM_UNAVAILABLE',recover,error.status);}
   if(error instanceof DOMException&&error.name==='AbortError'&&!uncertain())throw error;
   throw new SignedClientError(503,'SIGNED_UPSTREAM_UNAVAILABLE',uncertain());
  }finally{clearTimeout(timer);selected.signal?.removeEventListener('abort',onAbort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Late body read is fenced. */}}else try{void response?.body?.cancel().catch(()=>{});}catch{/* Cleanup only. */}}
 };
}
