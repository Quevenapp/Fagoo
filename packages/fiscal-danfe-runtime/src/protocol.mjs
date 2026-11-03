/** Read-only candidate preview boundary. No arbitrary URL, XML or credentials. */
export const MAX_HTML_BYTES=4*1024*1024,MAX_RESPONSE_BYTES=8*1024*1024,MAX_XML_BYTES=512000;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH=/^[a-f0-9]{64}$/;
export const ERROR_CODES=Object.freeze([
 'DANFE_NOT_STORED','DANFE_LAYOUT_UNSUPPORTED','DANFE_XML_INVALID','DANFE_STORAGE_INVALID',
 'DANFE_RUNTIME_UNAUTHORIZED','DANFE_INVALID_REQUEST','DANFE_NOT_FOUND','DANFE_METHOD_NOT_ALLOWED',
 'DANFE_CONTENT_TYPE_UNSUPPORTED','DANFE_RUNTIME_BUSY','DANFE_BODY_AUTHENTICATION_FAILED',
 'DANFE_FORBIDDEN','DANFE_CONFLICT','DANFE_RUNTIME_FAILED','DANFE_UPSTREAM_UNAVAILABLE','DANFE_RESPONSE_INVALID',
 'DANFE_BODY_TOO_LARGE','DANFE_BODY_INVALID','DANFE_ENCODING_UNSUPPORTED','DANFE_BODY_TIMEOUT',
 'DANFE_GATEWAY_UNAVAILABLE','DANFE_RUNTIME_CONFIGURATION_INVALID','DANFE_ORIGIN_FORBIDDEN','DANFE_UNAUTHENTICATED','DANFE_AUTH_SERVICE_UNAVAILABLE',
]);
export class DanfeRuntimeError extends Error{constructor(status,code){super(code);this.name='DanfeRuntimeError';this.status=status;this.code=code;}}
export const need=(condition,status,code)=>{if(!condition)throw new DanfeRuntimeError(status,code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(value,keys)=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sha256=value=>typeof value==='string'&&HASH.test(value);
export const version=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
export function route(path,method,prefix='/internal/v1/fiscal-danfe'){
 need(typeof path==='string'&&typeof method==='string'&&['/internal/v1/fiscal-danfe','/v1/fiscal-danfe'].includes(prefix),404,'DANFE_NOT_FOUND');
 const match=new RegExp('^'+prefix+'/candidates/([^/]+)/preview$').exec(path);
 need(match&&uuid(match[1]),404,'DANFE_NOT_FOUND');need(method==='GET',405,'DANFE_METHOD_NOT_ALLOWED');
 return Object.freeze({action:'preview',path,method,candidateId:match[1],limit:0});
}
export function parsePayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.length===0&&selected?.action==='preview'&&selected.method==='GET',400,'DANFE_BODY_INVALID');
 return Object.freeze({});
}
/** The absolute deadline covers every body chunk. Aborted readers are cancelled, including uncooperative streams. */
export async function readBounded(message,{limit,signal,deadline}={}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_RESPONSE_BYTES&&Number.isSafeInteger(deadline)
  &&(signal===undefined||signal instanceof AbortSignal),400,'DANFE_INVALID_REQUEST');
 need(!signal?.aborted,503,'DANFE_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'DANFE_BODY_TIMEOUT');
 const length=message.headers.get('content-length'),encoding=message.headers.get('content-encoding');
 need(encoding===null||encoding==='identity',400,'DANFE_ENCODING_UNSUPPORTED');
 need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'DANFE_BODY_TOO_LARGE');
 if(!message.body){need(length===null||Number(length)===0,400,'DANFE_BODY_INVALID');return new Uint8Array();}
 const reader=message.body.getReader(),chunks=[];let timer,size=0,ended=false,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(new DanfeRuntimeError(503,'DANFE_UPSTREAM_UNAVAILABLE'));
 const check=()=>{need(!signal?.aborted,503,'DANFE_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'DANFE_BODY_TIMEOUT');};
 signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>rejectStop(new DanfeRuntimeError(408,'DANFE_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{
  for(;;){check();const item=await Promise.race([reader.read(),stopped]);check();if(item.done)break;
   need(item.value instanceof Uint8Array,400,'DANFE_BODY_INVALID');size+=item.value.length;
   need(size<=limit,413,'DANFE_BODY_TOO_LARGE');chunks.push(new Uint8Array(item.value));
  }
  need(length===null||Number(length)===size,400,'DANFE_BODY_INVALID');check();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}ended=true;return bytes;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);
  if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
