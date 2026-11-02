/** Private adapter primitives. No network, credential loading or public HTTP. */
import {createHash} from 'node:crypto';
export class AuthorizationServiceError extends Error {
 constructor(code){super(code);this.name='AuthorizationServiceError';this.code=code;}
}
export const need=(v,c='AUTHORIZATION_SERVICE_RESPONSE_INVALID')=>{if(!v)throw new AuthorizationServiceError(c);};
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const integer=(v,max=2147483647,min=1)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function data(v,required,optional=[],code='AUTHORIZATION_SERVICE_INPUT_INVALID'){
 try{
  need(v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),code);
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d),allowed=[...required,...optional];
  need(keys.every(k=>typeof k==='string'&&allowed.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value'))&&required.every(k=>Object.hasOwn(d,k)),code);
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{throw new AuthorizationServiceError(code);}
}
const p=Object.getPrototypeOf(Uint8Array.prototype),get=Object.fromEntries(['byteLength','byteOffset','buffer'].map(k=>[k,Object.getOwnPropertyDescriptor(p,k).get]));
export function copy(v,max=512000){
 try{need(ArrayBuffer.isView(v)&&v instanceof Uint8Array,'AUTHORIZATION_SERVICE_BYTES_INVALID');
  const length=get.byteLength.call(v),offset=get.byteOffset.call(v),buffer=get.buffer.call(v);
  need(buffer instanceof ArrayBuffer&&length>0&&length<=max,'AUTHORIZATION_SERVICE_BYTES_INVALID');return Buffer.from(new Uint8Array(buffer,offset,length));
 }catch{throw new AuthorizationServiceError('AUTHORIZATION_SERVICE_BYTES_INVALID');}
}
export const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
export function scope(options={},max=45000){
 const o=data(options,[],['signal','deadline']);need(o.signal===undefined||o.signal instanceof AbortSignal);const now=Date.now();
 need(o.deadline===undefined||Number.isSafeInteger(o.deadline));const deadline=Math.min(o.deadline??now+max,now+max),parent=o.signal,controller=new AbortController();let rejectStop,code=null;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
 const stop=c=>{if(code)return;code=c;controller.abort();rejectStop(new AuthorizationServiceError(c));};
 const onAbort=()=>stop('AUTHORIZATION_SERVICE_ABORTED');parent?.addEventListener('abort',onAbort,{once:true});
 const timer=setTimeout(()=>stop('AUTHORIZATION_SERVICE_TIMEOUT'),Math.max(1,deadline-now));
 const check=()=>{if(parent?.aborted)onAbort();if(Date.now()>=deadline)stop('AUTHORIZATION_SERVICE_TIMEOUT');need(!code,code);};
 return{signal:controller.signal,deadline,check,stop,bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);},close(){clearTimeout(timer);parent?.removeEventListener('abort',onAbort);controller.abort();}};
}
export async function readBody(response,s,{max=512000,expectedHash,expectedSize,types=['application/octet-stream'],statuses=[200]}={}){
 need(response instanceof Response&&!response.redirected&&statuses.includes(response.status)&&types.includes(response.headers.get('content-type')),'AUTHORIZATION_SERVICE_BODY_INVALID');
 const length=response.headers.get('content-length'),coding=response.headers.get('content-encoding');
 need((coding===null||coding==='identity')&&(length===null||/^\d+$/.test(length)&&Number(length)<=max)&&response.body,'AUTHORIZATION_SERVICE_BODY_INVALID');
 const reader=response.body.getReader(),buffer=Buffer.alloc(max);let size=0;
 try{for(;;){const part=await s.bounded(()=>reader.read());if(part.done)break;need(part.value instanceof Uint8Array&&part.value.length<=max-size,'AUTHORIZATION_SERVICE_BODY_LIMIT');buffer.set(part.value,size);size+=part.value.length;}
  s.check();need(size>0&&(length===null||Number(length)===size)&&(expectedSize===undefined||size===expectedSize),'AUTHORIZATION_SERVICE_BODY_INVALID');
  const result=Buffer.from(buffer.subarray(0,size));if(expectedHash!==undefined&&hash(result)!==expectedHash){result.fill(0);throw new AuthorizationServiceError('AUTHORIZATION_SERVICE_HASH_MISMATCH');}return result;
 }finally{buffer.fill(0);try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}
