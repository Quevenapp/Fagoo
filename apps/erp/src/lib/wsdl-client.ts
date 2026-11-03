import {AccessError,type AccessState,type NativeRequestOptions} from './real-access.ts';
import {WSDL_BASE,wsdlId,wsdlShape,validWsdlRun,wsdlResult,type WsdlRun} from './wsdl-model.ts';

export interface FiscalWsdlClientPorts {origin:string;getToken:()=>string|null|Promise<string|null>;getSnapshot:()=>AccessState;getEpoch?:()=>unknown;fetchImpl?:typeof fetch;}
export class WsdlClientError extends AccessError {
 readonly recovery_required:boolean;
 readonly upstream_status:number|null;
 constructor(status:number,code:string,recoveryRequired=false,upstreamStatus:number|null=null){super(recoveryRequired&&status<500?503:status,code);this.name='WsdlClientError';this.recovery_required=recoveryRequired;this.upstream_status=upstreamStatus;}
}
const ERROR_CODES=new Set(['WSDL_RUNTIME_UNAUTHORIZED','WSDL_INVALID_REQUEST','WSDL_NOT_FOUND','WSDL_METHOD_NOT_ALLOWED','WSDL_CONTENT_TYPE_UNSUPPORTED','WSDL_RUNTIME_BUSY','WSDL_BODY_AUTHENTICATION_FAILED','WSDL_FORBIDDEN','WSDL_CONFLICT','WSDL_RUNTIME_FAILED','WSDL_UPSTREAM_UNAVAILABLE','WSDL_RESPONSE_INVALID','WSDL_BODY_TOO_LARGE','WSDL_BODY_INVALID','WSDL_ENCODING_UNSUPPORTED','WSDL_BODY_TIMEOUT','WSDL_GATEWAY_UNAVAILABLE','WSDL_RUNTIME_CONFIGURATION_INVALID','WSDL_ORIGIN_FORBIDDEN','WSDL_UNAUTHENTICATED','WSDL_AUTH_SERVICE_UNAVAILABLE']);
const HTTP=new Set([400,401,403,404,405,408,409,413,415,422,429,500,502,503,504]);
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
function invalid():never {throw new WsdlClientError(400,'WSDL_INVALID_REQUEST');}
type Selected={action:'run'|'command';method:'GET'|'POST';body?:string;payload?:WsdlRun;id?:string;signal?:AbortSignal;};
function select(path:string,options:NativeRequestOptions):Selected {
 if(!wsdlShape(options,[],['method','body','signal'])||options.signal!==undefined&&!(options.signal instanceof AbortSignal)||typeof path!=='string'||/[?#%\\]/.test(path))invalid();
 const method=options.method??'GET',signal=options.signal,data=options.body;
 if(path===WSDL_BASE+'/run'){
  if(method!=='POST'||!validWsdlRun(data))invalid();
  const payload=Object.freeze({command_id:data.command_id,model:data.model,operation:data.operation,expected_a1_version:data.expected_a1_version,expected_identity_version:data.expected_identity_version,confirmed:true as const});
  return{action:'run',method,payload,body:JSON.stringify(payload),signal};
 }
 const base=WSDL_BASE+'/commands/',id=path.startsWith(base)?path.slice(base.length):null;
 if(!wsdlId(id)||method!=='GET'||data!==undefined)invalid();return{action:'command',method:'GET',id,signal};
}
/** No automatic invocation or retry. The caller retains the original command when recovery_required is true. */
export function createWsdlClient({origin,getToken,getSnapshot,getEpoch,fetchImpl=fetch}:FiscalWsdlClientPorts){
 let base:URL;try{base=new URL(origin);}catch{throw new WsdlClientError(503,'WSDL_GATEWAY_UNAVAILABLE');}
 if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password||typeof getToken!=='function'||typeof getSnapshot!=='function'||getEpoch!==undefined&&typeof getEpoch!=='function'||typeof fetchImpl!=='function')throw new WsdlClientError(503,'WSDL_GATEWAY_UNAVAILABLE');
 return async(path:string,options:NativeRequestOptions={}):Promise<unknown>=>{
  // Capture the route, signal and serialized body before the first asynchronous boundary.
  let selected:Selected;try{selected=select(path,options);}catch(error){if(error instanceof WsdlClientError)throw error;return invalid();}
  if(selected.body!==undefined&&new TextEncoder().encode(selected.body).length>4096)invalid();
  const initial=getSnapshot(),actor=initial.membership?.user_id,epoch=getEpoch?.();
  if(initial.phase!=='ready'||!wsdlId(actor))throw new WsdlClientError(401,'WSDL_UNAUTHENTICATED');
  if(!['admin','fiscal'].includes(initial.membership!.role))throw new WsdlClientError(403,'WSDL_FORBIDDEN');
  const controller=new AbortController();let sent=false,timeout=false,rejectStop:(error:unknown)=>void=()=>{},response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const stopped=new Promise<never>((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const deadline=Date.now()+65000;
  const uncertain=()=>sent&&selected.action==='run';
  const sessionChanged=()=>{const state=getSnapshot();return state.phase!=='ready'||state.membership?.user_id!==actor||!['admin','fiscal'].includes(state.membership.role)||getEpoch!==undefined&&getEpoch()!==epoch;};
  const cancelled=()=>sessionChanged()?new DOMException('Session changed','AbortError'):uncertain()?new WsdlClientError(503,'WSDL_UPSTREAM_UNAVAILABLE',true):new DOMException('Request cancelled','AbortError');
  const onAbort=()=>{controller.abort();rejectStop(cancelled());};
  const timer=setTimeout(()=>{timeout=true;controller.abort();rejectStop(new WsdlClientError(504,'WSDL_UPSTREAM_UNAVAILABLE',uncertain()));},65000);
  selected.signal?.addEventListener('abort',onAbort,{once:true});if(selected.signal?.aborted)onAbort();
  const check=()=>{if(sessionChanged())throw new DOMException('Session changed','AbortError');if(selected.signal?.aborted)throw cancelled();if(timeout||Date.now()>=deadline)throw new WsdlClientError(504,'WSDL_UPSTREAM_UNAVAILABLE',uncertain());if(controller.signal.aborted)throw cancelled();};
  const bounded=<T,>(fn:()=>T|Promise<T>)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  try{
   const token=await bounded(getToken);check();if(typeof token!=='string'||!token||token.length>8192||!/^[-A-Za-z0-9_.]+$/.test(token))throw new WsdlClientError(401,'WSDL_UNAUTHENTICATED');
   const url=base.origin+path;
   const pending=Promise.resolve().then(()=>{check();sent=true;return fetchImpl(url,{method:selected.method,headers:{Authorization:`Bearer ${token}`,Accept:'application/json',...(selected.body===undefined?{}:{'Content-Type':'application/json'})},body:selected.body,credentials:'omit',cache:'no-store',redirect:'manual',signal:controller.signal});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>v.body?.cancel()).catch(()=>{});throw error;}
   check();if(!(response instanceof Response)||response.redirected||response.status===0||response.status>=300&&response.status<400||response.url!==''&&response.url!==url||!JSON_TYPE.test(response.headers.get('content-type')??'')||!response.body)throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());
   // Browser Fetch decodes HTTP compression. Bound decoded bytes and compare length only for identity coding.
   const encoding=response.headers.get('content-encoding'),identity=encoding===null||encoding==='identity',length=response.headers.get('content-length'),limit=response.ok?131072:8192;
   if(!identity&&!['gzip','br','deflate'].includes(encoding!)||length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)>limit))throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let count=0,text='';
   for(;;){const item=await bounded(()=>reader!.read());if(item.done)break;if(!(item.value instanceof Uint8Array)||(count+=item.value.byteLength)>limit)throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());text+=decoder.decode(item.value,{stream:true});}
   if(identity&&length!==null&&Number(length)!==count)throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());check();
   let value:unknown;try{value=JSON.parse(text+decoder.decode());}catch{throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());}
   if(!response.ok){
    if(!HTTP.has(response.status)||!wsdlShape(value,['error','recovery_required'])||typeof value.error!=='string'||!ERROR_CODES.has(value.error)||typeof value.recovery_required!=='boolean')throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain(),response.status);
    throw new WsdlClientError(response.status,value.error,value.recovery_required&&selected.action==='run',response.status);
   }
   try{
    const result=wsdlResult(value,selected.action==='run'?{body:selected.payload!}:{commandId:selected.id!});check();return result;
   }catch(error){if(error instanceof WsdlClientError||error instanceof DOMException&&error.name==='AbortError')throw error;throw new WsdlClientError(502,'WSDL_RESPONSE_INVALID',uncertain());}
  }catch(error){
   if(sessionChanged())throw new DOMException('Session changed','AbortError');
   if(error instanceof WsdlClientError)throw error;
   if(selected.signal?.aborted)throw cancelled();
   if(error instanceof AccessError){const recover=uncertain();throw new WsdlClientError(error.status,'WSDL_UPSTREAM_UNAVAILABLE',recover,error.status);}
   if(error instanceof DOMException&&error.name==='AbortError'&&!uncertain())throw error;
   throw new WsdlClientError(503,'WSDL_UPSTREAM_UNAVAILABLE',uncertain());
  }finally{clearTimeout(timer);selected.signal?.removeEventListener('abort',onAbort);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Late body read is fenced. */}}else try{void response?.body?.cancel().catch(()=>{});}catch{/* Cleanup only. */}}
 };
}
