/** Authenticated protocol-query boundary. No arbitrary key, URL, XML or credentials. */
export const MAX_JSON_BYTES=4096,MAX_RESPONSE_BYTES=131072;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH=/^[a-f0-9]{64}$/;
export const ERROR_CODES=Object.freeze([
 'RECONCILIATION_DISABLED',
 'RECONCILIATION_RUNTIME_UNAUTHORIZED','RECONCILIATION_INVALID_REQUEST','RECONCILIATION_NOT_FOUND','RECONCILIATION_METHOD_NOT_ALLOWED',
 'RECONCILIATION_CONTENT_TYPE_UNSUPPORTED','RECONCILIATION_RUNTIME_BUSY','RECONCILIATION_BODY_AUTHENTICATION_FAILED',
 'RECONCILIATION_FORBIDDEN','RECONCILIATION_CONFLICT','RECONCILIATION_RUNTIME_FAILED','RECONCILIATION_UPSTREAM_UNAVAILABLE','RECONCILIATION_RESPONSE_INVALID',
 'RECONCILIATION_BODY_TOO_LARGE','RECONCILIATION_BODY_INVALID','RECONCILIATION_ENCODING_UNSUPPORTED','RECONCILIATION_BODY_TIMEOUT',
 'RECONCILIATION_GATEWAY_UNAVAILABLE','RECONCILIATION_RUNTIME_CONFIGURATION_INVALID','RECONCILIATION_ORIGIN_FORBIDDEN','RECONCILIATION_UNAUTHENTICATED','RECONCILIATION_AUTH_SERVICE_UNAVAILABLE',
]);
export class ReconciliationRuntimeError extends Error{constructor(status,code){super(code);this.name='ReconciliationRuntimeError';this.status=status;this.code=code;}}
export const need=(condition,status,code)=>{if(!condition)throw new ReconciliationRuntimeError(status,code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(value,keys)=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sha256=value=>typeof value==='string'&&HASH.test(value);
export const version=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
export function route(path,method,prefix='/internal/v1/fiscal-reconciliation'){
 need(typeof path==='string'&&typeof method==='string'&&['/internal/v1/fiscal-reconciliation','/v1/fiscal-reconciliation'].includes(prefix),404,'RECONCILIATION_NOT_FOUND');
 let action,expected,commandId,candidateId;
 if(path===`${prefix}/run`){action='run';expected='POST';}
 if(path===`${prefix}/recover`){action='recover';expected='POST';}
 const command=new RegExp('^'+prefix+'/commands/([^/]+)$').exec(path);
 if(command&&uuid(command[1])){action='command';expected='GET';commandId=command[1];}
 const history=new RegExp('^'+prefix+'/candidates/([^/]+)/history$').exec(path);
 if(history&&uuid(history[1])){action='history';expected='POST';candidateId=history[1];}
 need(action,404,'RECONCILIATION_NOT_FOUND');need(method===expected,405,'RECONCILIATION_METHOD_NOT_ALLOWED');
 return Object.freeze({action,path,method,...(commandId?{commandId}:{}),...(candidateId?{candidateId}:{}),limit:method==='POST'?MAX_JSON_BYTES:0});
}
export function parsePayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.length<=MAX_JSON_BYTES,400,'RECONCILIATION_BODY_INVALID');
 if(selected?.method==='GET'){need(selected.action==='command'&&bytes.length===0,400,'RECONCILIATION_BODY_INVALID');return Object.freeze({});}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ReconciliationRuntimeError(400,'RECONCILIATION_BODY_INVALID');}
 if(selected?.action==='run')need(exact(value,['command_id','candidate_id','signed_hash','expected_a1_version','expected_identity_version','confirmed'])
  &&uuid(value.command_id)&&uuid(value.candidate_id)&&sha256(value.signed_hash)
  &&version(value.expected_a1_version)&&version(value.expected_identity_version)&&value.confirmed===true,400,'RECONCILIATION_INVALID_REQUEST');
 else if(selected?.action==='recover')need(exact(value,['command_id'])&&uuid(value.command_id),400,'RECONCILIATION_INVALID_REQUEST');
 else if(selected?.action==='history')need(exact(value,['limit','before'])&&Number.isInteger(value.limit)&&value.limit>=1&&value.limit<=25
  &&(value.before===null||typeof value.before==='string'&&/^[1-9][0-9]{0,18}$/.test(value.before)&&BigInt(value.before)<=9223372036854775807n),400,'RECONCILIATION_INVALID_REQUEST');
 else throw new ReconciliationRuntimeError(400,'RECONCILIATION_INVALID_REQUEST');
 return Object.freeze(value);
}
/** The absolute deadline covers every body chunk. Aborted readers are cancelled, including uncooperative streams. */
export async function readBounded(message,{limit,signal,deadline}={}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_RESPONSE_BYTES&&Number.isSafeInteger(deadline)
  &&(signal===undefined||signal instanceof AbortSignal),400,'RECONCILIATION_INVALID_REQUEST');
 need(!signal?.aborted,503,'RECONCILIATION_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'RECONCILIATION_BODY_TIMEOUT');
 const length=message.headers.get('content-length'),encoding=message.headers.get('content-encoding');
 need(encoding===null||encoding==='identity',400,'RECONCILIATION_ENCODING_UNSUPPORTED');
 need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'RECONCILIATION_BODY_TOO_LARGE');
 if(!message.body){need(length===null||Number(length)===0,400,'RECONCILIATION_BODY_INVALID');return new Uint8Array();}
 const reader=message.body.getReader(),chunks=[];let timer,size=0,ended=false,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(new ReconciliationRuntimeError(503,'RECONCILIATION_UPSTREAM_UNAVAILABLE'));
 const check=()=>{need(!signal?.aborted,503,'RECONCILIATION_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'RECONCILIATION_BODY_TIMEOUT');};
 signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>rejectStop(new ReconciliationRuntimeError(408,'RECONCILIATION_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{
  for(;;){check();const item=await Promise.race([reader.read(),stopped]);check();if(item.done)break;
   need(item.value instanceof Uint8Array,400,'RECONCILIATION_BODY_INVALID');size+=item.value.length;
   need(size<=limit,413,'RECONCILIATION_BODY_TOO_LARGE');chunks.push(new Uint8Array(item.value));
  }
  need(length===null||Number(length)===size,400,'RECONCILIATION_BODY_INVALID');check();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}ended=true;return bytes;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);
  if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
