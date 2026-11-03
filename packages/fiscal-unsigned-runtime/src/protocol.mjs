/** Separate unsigned-XML protocol. No environment, credentials or operational transport. */
export const MAX_JSON_BYTES=4096,MAX_RESPONSE_BYTES=131072;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH=/^[a-f0-9]{64}$/;
export const ERROR_CODES=Object.freeze([
 'UNSIGNED_RUNTIME_UNAUTHORIZED','UNSIGNED_INVALID_REQUEST','UNSIGNED_NOT_FOUND','UNSIGNED_METHOD_NOT_ALLOWED',
 'UNSIGNED_CONTENT_TYPE_UNSUPPORTED','UNSIGNED_RUNTIME_BUSY','UNSIGNED_BODY_AUTHENTICATION_FAILED',
 'UNSIGNED_FORBIDDEN','UNSIGNED_CONFLICT','UNSIGNED_RUNTIME_FAILED','UNSIGNED_UPSTREAM_UNAVAILABLE','UNSIGNED_RESPONSE_INVALID',
 'UNSIGNED_BODY_TOO_LARGE','UNSIGNED_BODY_INVALID','UNSIGNED_ENCODING_UNSUPPORTED','UNSIGNED_BODY_TIMEOUT',
 'UNSIGNED_GATEWAY_UNAVAILABLE','UNSIGNED_RUNTIME_CONFIGURATION_INVALID','UNSIGNED_ORIGIN_FORBIDDEN','UNSIGNED_UNAUTHENTICATED','UNSIGNED_AUTH_SERVICE_UNAVAILABLE',
]);
export class UnsignedRuntimeError extends Error{constructor(status,code){super(code);this.name='UnsignedRuntimeError';this.status=status;this.code=code;}}
export const need=(condition,status,code)=>{if(!condition)throw new UnsignedRuntimeError(status,code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sha256=value=>typeof value==='string'&&HASH.test(value);
export const version=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
export function route(path,method,prefix='/internal/v1/fiscal-unsigned'){
 need(typeof path==='string'&&typeof method==='string'&&['/internal/v1/fiscal-unsigned','/v1/fiscal-unsigned'].includes(prefix),404,'UNSIGNED_NOT_FOUND');
 let action,expected,jobId,commandId;
 for(const name of['preview','generate','history'])if(path===`${prefix}/${name}`){action=name;expected='POST';}
 for(const[kind,name]of[['jobs','job'],['commands','command']]){
  const base=`${prefix}/${kind}/`,tail=path.startsWith(base)?path.slice(base.length):null;
  if(uuid(tail)){action=name;expected='GET';if(name==='job')jobId=tail;else commandId=tail;}
 }
 need(action,404,'UNSIGNED_NOT_FOUND');need(method===expected,405,'UNSIGNED_METHOD_NOT_ALLOWED');
 return Object.freeze({action,path,method,...(jobId?{jobId}:{}),...(commandId?{commandId}:{}),limit:method==='POST'?MAX_JSON_BYTES:0});
}
export function parsePayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.length<=MAX_JSON_BYTES,400,'UNSIGNED_BODY_INVALID');
 if(selected?.method==='GET'){need(bytes.length===0,400,'UNSIGNED_BODY_INVALID');return Object.freeze({});}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new UnsignedRuntimeError(400,'UNSIGNED_BODY_INVALID');}
 const action=selected?.action;
 if(action==='preview')need(exact(value,['draft_id','completion_version'])&&uuid(value.draft_id)&&version(value.completion_version),400,'UNSIGNED_INVALID_REQUEST');
 else if(action==='generate')need(exact(value,['command_id','reservation_id','draft_id','completion_version','completion_hash','basis_hash'])
  &&['command_id','reservation_id','draft_id'].every(k=>uuid(value[k]))&&version(value.completion_version)
  &&sha256(value.completion_hash)&&sha256(value.basis_hash),400,'UNSIGNED_INVALID_REQUEST');
 else if(action==='history')need(exact(value,['reservation_id','limit','before'])&&uuid(value.reservation_id)&&Number.isInteger(value.limit)&&value.limit>=1&&value.limit<=25
  &&(value.before===null||version(value.before)),400,'UNSIGNED_INVALID_REQUEST');
 else throw new UnsignedRuntimeError(400,'UNSIGNED_INVALID_REQUEST');
 return Object.freeze(value);
}
/** The absolute deadline covers every body chunk. Aborted readers are cancelled, including uncooperative streams. */
export async function readBounded(message,{limit,signal,deadline}={}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_RESPONSE_BYTES&&Number.isSafeInteger(deadline)
  &&(signal===undefined||signal instanceof AbortSignal),400,'UNSIGNED_INVALID_REQUEST');
 need(!signal?.aborted,503,'UNSIGNED_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'UNSIGNED_BODY_TIMEOUT');
 const length=message.headers.get('content-length'),encoding=message.headers.get('content-encoding');
 need(encoding===null||encoding==='identity',400,'UNSIGNED_ENCODING_UNSUPPORTED');
 need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'UNSIGNED_BODY_TOO_LARGE');
 if(!message.body){need(length===null||Number(length)===0,400,'UNSIGNED_BODY_INVALID');return new Uint8Array();}
 const reader=message.body.getReader(),chunks=[];let timer,size=0,ended=false,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(new UnsignedRuntimeError(503,'UNSIGNED_UPSTREAM_UNAVAILABLE'));
 const check=()=>{need(!signal?.aborted,503,'UNSIGNED_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'UNSIGNED_BODY_TIMEOUT');};
 signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>rejectStop(new UnsignedRuntimeError(408,'UNSIGNED_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{
  for(;;){check();const item=await Promise.race([reader.read(),stopped]);check();if(item.done)break;
   need(item.value instanceof Uint8Array,400,'UNSIGNED_BODY_INVALID');size+=item.value.length;
   need(size<=limit,413,'UNSIGNED_BODY_TOO_LARGE');chunks.push(new Uint8Array(item.value));
  }
  need(length===null||Number(length)===size,400,'UNSIGNED_BODY_INVALID');check();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}ended=true;return bytes;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);
  if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
