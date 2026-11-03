/** Separate signed-XML protocol. No environment, credentials or operational transport. */
export const MAX_JSON_BYTES=4096,MAX_RESPONSE_BYTES=131072;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH=/^[a-f0-9]{64}$/;
export const ERROR_CODES=Object.freeze([
 'SIGNED_RUNTIME_UNAUTHORIZED','SIGNED_INVALID_REQUEST','SIGNED_NOT_FOUND','SIGNED_METHOD_NOT_ALLOWED',
 'SIGNED_CONTENT_TYPE_UNSUPPORTED','SIGNED_RUNTIME_BUSY','SIGNED_BODY_AUTHENTICATION_FAILED',
 'SIGNED_FORBIDDEN','SIGNED_CONFLICT','SIGNED_RUNTIME_FAILED','SIGNED_UPSTREAM_UNAVAILABLE','SIGNED_RESPONSE_INVALID',
 'SIGNED_BODY_TOO_LARGE','SIGNED_BODY_INVALID','SIGNED_ENCODING_UNSUPPORTED','SIGNED_BODY_TIMEOUT',
 'SIGNED_GATEWAY_UNAVAILABLE','SIGNED_RUNTIME_CONFIGURATION_INVALID','SIGNED_ORIGIN_FORBIDDEN','SIGNED_UNAUTHENTICATED','SIGNED_AUTH_SERVICE_UNAVAILABLE',
]);
export class SignedRuntimeError extends Error{constructor(status,code){super(code);this.name='SignedRuntimeError';this.status=status;this.code=code;}}
export const need=(condition,status,code)=>{if(!condition)throw new SignedRuntimeError(status,code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(value,keys)=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sha256=value=>typeof value==='string'&&HASH.test(value);
export const version=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
export function route(path,method,prefix='/internal/v1/fiscal-signed'){
 need(typeof path==='string'&&typeof method==='string'&&['/internal/v1/fiscal-signed','/v1/fiscal-signed'].includes(prefix),404,'SIGNED_NOT_FOUND');
 let action,expected,jobId,commandId,candidateId;
 if(path===`${prefix}/run`){action='run';expected='POST';}
 for(const[kind,name]of[['candidates','candidate'],['commands','command']]){
  const base=`${prefix}/${kind}/`,tail=path.startsWith(base)?path.slice(base.length):null;
  if(uuid(tail)){action=name;expected='GET';if(name==='candidate')candidateId=tail;else commandId=tail;}
 }
 const history=new RegExp(`^${prefix}/jobs/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/history$`).exec(path);
 if(history){action='history';expected='POST';jobId=history[1];}
 need(action,404,'SIGNED_NOT_FOUND');need(method===expected,405,'SIGNED_METHOD_NOT_ALLOWED');
 return Object.freeze({action,path,method,...(jobId?{jobId}:{}),...(commandId?{commandId}:{}),...(candidateId?{candidateId}:{}),limit:method==='POST'?MAX_JSON_BYTES:0});
}
export function parsePayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.length<=MAX_JSON_BYTES,400,'SIGNED_BODY_INVALID');
 if(selected?.method==='GET'){need(bytes.length===0,400,'SIGNED_BODY_INVALID');return Object.freeze({});}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new SignedRuntimeError(400,'SIGNED_BODY_INVALID');}
 if(selected?.action==='run')need(exact(value,['command_id','unsigned_job_id','unsigned_hash','basis_hash','expected_a1_version'])
  &&uuid(value.command_id)&&uuid(value.unsigned_job_id)&&sha256(value.unsigned_hash)&&sha256(value.basis_hash)&&version(value.expected_a1_version),400,'SIGNED_INVALID_REQUEST');
 else if(selected?.action==='history')need(exact(value,['limit','before'])&&Number.isInteger(value.limit)&&value.limit>=1&&value.limit<=25
  &&(value.before===null||version(value.before)),400,'SIGNED_INVALID_REQUEST');
 else throw new SignedRuntimeError(400,'SIGNED_INVALID_REQUEST');
 return Object.freeze(value);
}
/** The absolute deadline covers every body chunk. Aborted readers are cancelled, including uncooperative streams. */
export async function readBounded(message,{limit,signal,deadline}={}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_RESPONSE_BYTES&&Number.isSafeInteger(deadline)
  &&(signal===undefined||signal instanceof AbortSignal),400,'SIGNED_INVALID_REQUEST');
 need(!signal?.aborted,503,'SIGNED_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'SIGNED_BODY_TIMEOUT');
 const length=message.headers.get('content-length'),encoding=message.headers.get('content-encoding');
 need(encoding===null||encoding==='identity',400,'SIGNED_ENCODING_UNSUPPORTED');
 need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'SIGNED_BODY_TOO_LARGE');
 if(!message.body){need(length===null||Number(length)===0,400,'SIGNED_BODY_INVALID');return new Uint8Array();}
 const reader=message.body.getReader(),chunks=[];let timer,size=0,ended=false,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(new SignedRuntimeError(503,'SIGNED_UPSTREAM_UNAVAILABLE'));
 const check=()=>{need(!signal?.aborted,503,'SIGNED_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'SIGNED_BODY_TIMEOUT');};
 signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>rejectStop(new SignedRuntimeError(408,'SIGNED_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{
  for(;;){check();const item=await Promise.race([reader.read(),stopped]);check();if(item.done)break;
   need(item.value instanceof Uint8Array,400,'SIGNED_BODY_INVALID');size+=item.value.length;
   need(size<=limit,413,'SIGNED_BODY_TOO_LARGE');chunks.push(new Uint8Array(item.value));
  }
  need(length===null||Number(length)===size,400,'SIGNED_BODY_INVALID');check();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}ended=true;return bytes;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);
  if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
