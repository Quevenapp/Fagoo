/** Dedicated WSDL protocol. No arbitrary URL, XML, credentials or fiscal transmission. */
export const MAX_JSON_BYTES=4096,MAX_RESPONSE_BYTES=131072;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HASH=/^[a-f0-9]{64}$/;
export const ERROR_CODES=Object.freeze([
 'WSDL_RUNTIME_UNAUTHORIZED','WSDL_INVALID_REQUEST','WSDL_NOT_FOUND','WSDL_METHOD_NOT_ALLOWED',
 'WSDL_CONTENT_TYPE_UNSUPPORTED','WSDL_RUNTIME_BUSY','WSDL_BODY_AUTHENTICATION_FAILED',
 'WSDL_FORBIDDEN','WSDL_CONFLICT','WSDL_RUNTIME_FAILED','WSDL_UPSTREAM_UNAVAILABLE','WSDL_RESPONSE_INVALID',
 'WSDL_BODY_TOO_LARGE','WSDL_BODY_INVALID','WSDL_ENCODING_UNSUPPORTED','WSDL_BODY_TIMEOUT',
 'WSDL_GATEWAY_UNAVAILABLE','WSDL_RUNTIME_CONFIGURATION_INVALID','WSDL_ORIGIN_FORBIDDEN','WSDL_UNAUTHENTICATED','WSDL_AUTH_SERVICE_UNAVAILABLE',
]);
export class WsdlRuntimeError extends Error{constructor(status,code){super(code);this.name='WsdlRuntimeError';this.status=status;this.code=code;}}
export const need=(condition,status,code)=>{if(!condition)throw new WsdlRuntimeError(status,code);};
export const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
export const exact=(value,keys)=>plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
export const uuid=value=>typeof value==='string'&&UUID.test(value);
export const sha256=value=>typeof value==='string'&&HASH.test(value);
export const version=(value,min=1)=>Number.isInteger(value)&&value>=min&&value<=2147483647;
export function route(path,method,prefix='/internal/v1/fiscal-wsdl'){
 need(typeof path==='string'&&typeof method==='string'&&['/internal/v1/fiscal-wsdl','/v1/fiscal-wsdl'].includes(prefix),404,'WSDL_NOT_FOUND');
 let action,expected,commandId;
 if(path===`${prefix}/run`){action='run';expected='POST';}
 const base=`${prefix}/commands/`,tail=path.startsWith(base)?path.slice(base.length):null;
 if(uuid(tail)){action='command';expected='GET';commandId=tail;}
 need(action,404,'WSDL_NOT_FOUND');need(method===expected,405,'WSDL_METHOD_NOT_ALLOWED');
 return Object.freeze({action,path,method,...(commandId?{commandId}:{}),limit:method==='POST'?MAX_JSON_BYTES:0});
}
export function parsePayload(bytes,selected){
 need(bytes instanceof Uint8Array&&bytes.length<=MAX_JSON_BYTES,400,'WSDL_BODY_INVALID');
 if(selected?.method==='GET'){need(bytes.length===0,400,'WSDL_BODY_INVALID');return Object.freeze({});}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new WsdlRuntimeError(400,'WSDL_BODY_INVALID');}
 if(selected?.action==='run')need(exact(value,['command_id','model','operation','expected_a1_version','expected_identity_version','confirmed'])
  &&uuid(value.command_id)&&['55','65'].includes(value.model)&&['protocol','status','authorization','receipt'].includes(value.operation)
  &&version(value.expected_a1_version)&&version(value.expected_identity_version)&&value.confirmed===true,400,'WSDL_INVALID_REQUEST');
 else throw new WsdlRuntimeError(400,'WSDL_INVALID_REQUEST');
 return Object.freeze(value);
}
/** The absolute deadline covers every body chunk. Aborted readers are cancelled, including uncooperative streams. */
export async function readBounded(message,{limit,signal,deadline}={}){
 need(Number.isSafeInteger(limit)&&limit>=0&&limit<=MAX_RESPONSE_BYTES&&Number.isSafeInteger(deadline)
  &&(signal===undefined||signal instanceof AbortSignal),400,'WSDL_INVALID_REQUEST');
 need(!signal?.aborted,503,'WSDL_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'WSDL_BODY_TIMEOUT');
 const length=message.headers.get('content-length'),encoding=message.headers.get('content-encoding');
 need(encoding===null||encoding==='identity',400,'WSDL_ENCODING_UNSUPPORTED');
 need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'WSDL_BODY_TOO_LARGE');
 if(!message.body){need(length===null||Number(length)===0,400,'WSDL_BODY_INVALID');return new Uint8Array();}
 const reader=message.body.getReader(),chunks=[];let timer,size=0,ended=false,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 const abort=()=>rejectStop(new WsdlRuntimeError(503,'WSDL_UPSTREAM_UNAVAILABLE'));
 const check=()=>{need(!signal?.aborted,503,'WSDL_UPSTREAM_UNAVAILABLE');need(Date.now()<deadline,408,'WSDL_BODY_TIMEOUT');};
 signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>rejectStop(new WsdlRuntimeError(408,'WSDL_BODY_TIMEOUT')),Math.max(1,deadline-Date.now()));
 try{
  for(;;){check();const item=await Promise.race([reader.read(),stopped]);check();if(item.done)break;
   need(item.value instanceof Uint8Array,400,'WSDL_BODY_INVALID');size+=item.value.length;
   need(size<=limit,413,'WSDL_BODY_TOO_LARGE');chunks.push(new Uint8Array(item.value));
  }
  need(length===null||Number(length)===size,400,'WSDL_BODY_INVALID');check();
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}ended=true;return bytes;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);
  if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
