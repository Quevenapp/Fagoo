/** HTTP syntax only. No session/HMAC verification, credentials, URLs or fiscal grant. */
export const PREFIX='/v1/fiscal-authorization',MAX_JSON_BYTES=4096,MAX_RESPONSE_BYTES=131072;
export class AuthorizationHttpError extends Error{constructor(status,code){super(code);this.name='AuthorizationHttpError';this.status=status;this.code=code;}}
export const need=(value,status=400,code='AUTHORIZATION_INVALID_REQUEST')=>{if(!value)throw new AuthorizationHttpError(status,code);};
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export const version=(v,min=1)=>Number.isSafeInteger(v)&&v>=min&&v<=2147483647;
export const ordinal=v=>typeof v==='string'&&/^[1-9][0-9]{0,14}$/.test(v);
export const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function data(value,keys,optional=[],status=400,code='AUTHORIZATION_INVALID_REQUEST'){
 try{need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),status,code);
  const d=Object.getOwnPropertyDescriptors(value),own=Reflect.ownKeys(d);
  need(own.every(k=>typeof k==='string'&&[...keys,...optional].includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value'))&&keys.every(k=>Object.hasOwn(d,k)),status,code);
  return Object.fromEntries(own.map(k=>[k,d[k].value]));
 }catch{throw new AuthorizationHttpError(status,code);}
}
const routes=new WeakSet();
export function route(path,method){
 need(typeof path==='string'&&typeof method==='string',404,'AUTHORIZATION_NOT_FOUND');
 let action,expected,commandId,candidateId;
 for(const name of ['preview','run','recover'])if(path===`${PREFIX}/${name}`){action=name;expected='POST';}
 const command=new RegExp('^'+PREFIX+'/commands/([^/]+)$').exec(path),history=new RegExp('^'+PREFIX+'/candidates/([^/]+)/history$').exec(path);
 if(command&&uuid(command[1])){action='command';expected='GET';commandId=command[1];}
 if(history&&uuid(history[1])){action='history';expected='POST';candidateId=history[1];}
 need(action,404,'AUTHORIZATION_NOT_FOUND');need(method===expected,405,'AUTHORIZATION_METHOD_NOT_ALLOWED');
 const out=Object.freeze({action,path,method,...(commandId?{commandId}:{}),...(candidateId?{candidateId}:{}),limit:method==='POST'?MAX_JSON_BYTES:0});routes.add(out);return out;
}
export function parsePayload(bytes,selected){
 need(routes.has(selected)&&bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer&&bytes.length<=MAX_JSON_BYTES);
 if(selected.method==='GET'){need(bytes.length===0);return Object.freeze({});}
 let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(400,'AUTHORIZATION_BODY_INVALID');}
 let p;
 if(selected.action==='preview'){p=data(raw,['candidate_id','signed_hash']);need(uuid(p.candidate_id)&&hash(p.signed_hash));}
 else if(selected.action==='run'){p=data(raw,['command_id','candidate_id','signed_hash','expected_identity_version','expected_a1_version','expected_policy_version','confirmed']);need(uuid(p.command_id)&&uuid(p.candidate_id)&&hash(p.signed_hash)&&['expected_identity_version','expected_a1_version','expected_policy_version'].every(k=>version(p[k]))&&p.confirmed===true);}
 else if(selected.action==='recover'){p=data(raw,['command_id']);need(uuid(p.command_id));}
 else{p=data(raw,['limit','before']);need(Number.isInteger(p.limit)&&p.limit>=1&&p.limit<=25&&(p.before===null||ordinal(p.before)));}
 return Object.freeze(p);
}
export function scope(context,requestSignal){
 const c=data(context,['actor'],['signal','deadline']);need(uuid(c.actor),401,'AUTHORIZATION_UNAUTHENTICATED');need(c.signal===undefined||c.signal instanceof AbortSignal);need(c.deadline===undefined||Number.isSafeInteger(c.deadline));
 const actor=c.actor,parent=c.signal,deadline=Math.min(c.deadline??Date.now()+45000,Date.now()+45000),abort=new AbortController();let stopped=false,reject;
 const end=new Promise((_,r)=>{reject=r;});end.catch(()=>{});
 const stop=()=>{if(stopped)return;stopped=true;abort.abort();reject(new AuthorizationHttpError(503,'AUTHORIZATION_REQUEST_UNCONFIRMED'));};
 parent?.addEventListener('abort',stop,{once:true});requestSignal.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));
 const check=()=>{if(parent?.aborted||requestSignal.aborted||Date.now()>=deadline)stop();need(!stopped,503,'AUTHORIZATION_REQUEST_UNCONFIRMED');};
 return{actor,signal:abort.signal,deadline,check,bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),end]);},close(){clearTimeout(timer);parent?.removeEventListener('abort',stop);requestSignal.removeEventListener('abort',stop);abort.abort();}};
}
export async function readBounded(message,limit,s){
 let reader,done=false,timer;const chunks=[];let size=0;
 try{
  const length=message.headers.get('content-length'),coding=message.headers.get('content-encoding');
  need(coding===null||coding==='identity',400,'AUTHORIZATION_ENCODING_UNSUPPORTED');
  need(length===null||/^\d+$/.test(length)&&Number(length)<=limit,413,'AUTHORIZATION_BODY_TOO_LARGE');
  if(!message.body){need(length===null||Number(length)===0);return new Uint8Array();}
  reader=message.body.getReader();const bodyDeadline=Math.min(Date.now()+10000,s.deadline),timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AuthorizationHttpError(408,'AUTHORIZATION_BODY_TIMEOUT')),Math.max(1,bodyDeadline-Date.now()));});
  for(;;){need(Date.now()<bodyDeadline,408,'AUTHORIZATION_BODY_TIMEOUT');const part=await Promise.race([s.bounded(()=>reader.read()),timeout]);s.check();need(Date.now()<bodyDeadline,408,'AUTHORIZATION_BODY_TIMEOUT');if(part.done)break;
   need(part.value instanceof Uint8Array&&part.value.buffer instanceof ArrayBuffer&&part.value.byteLength>0,400,'AUTHORIZATION_BODY_INVALID');size+=part.value.byteLength;need(size<=limit,413,'AUTHORIZATION_BODY_TOO_LARGE');chunks.push(new Uint8Array(part.value));
  }
  need(length===null||Number(length)===size,400,'AUTHORIZATION_BODY_INVALID');const result=new Uint8Array(size);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.length;}done=true;return result;
 }finally{clearTimeout(timer);chunks.forEach(c=>c.fill(0));if(!done){try{void(reader?reader.cancel():message.body?.cancel())?.catch(()=>{});}catch{}}try{reader?.releaseLock();}catch{}}
}
/** Copy only inert, bounded JSON before inspecting an untrusted service result. */
export function snapshot(value){
 let nodes=0,total=0;
 function visit(v,depth){
  need(++nodes<=10000&&depth<=12,502,'AUTHORIZATION_RESPONSE_INVALID');
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;
  if(typeof v==='string'){need(v.length<=MAX_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');total+=new TextEncoder().encode(v).length;need(total<=MAX_RESPONSE_BYTES,502,'AUTHORIZATION_RESPONSE_INVALID');return v;}
  need(v!==null&&typeof v==='object',502,'AUTHORIZATION_RESPONSE_INVALID');
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);
  if(Array.isArray(v)){need(v.length<=100&&keys.length===v.length+1&&keys.includes('length'),502,'AUTHORIZATION_RESPONSE_INVALID');return Array.from({length:v.length},(_,i)=>{const p=d[i];need(p?.enumerable&&Object.hasOwn(p,'value'),502,'AUTHORIZATION_RESPONSE_INVALID');return visit(p.value,depth+1);});}
  need([Object.prototype,null].includes(Object.getPrototypeOf(v)),502,'AUTHORIZATION_RESPONSE_INVALID');
  return Object.fromEntries(keys.map(k=>{const p=d[k];need(typeof k==='string'&&k.length<=120&&p.enumerable&&Object.hasOwn(p,'value'),502,'AUTHORIZATION_RESPONSE_INVALID');return[k,visit(p.value,depth+1)];}));
 }
 try{return visit(value,0);}catch{throw new AuthorizationHttpError(502,'AUTHORIZATION_RESPONSE_INVALID');}
}
export function timestamp(v){
 if(typeof v!=='string')return false;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(v);
 if(!m||+m[1]<1900||+m[1]>2199||+m[4]>23||+m[5]>59||+m[6]>59||+m[10]>14||+m[11]>59||+m[10]===14&&+m[11]!==0)return false;
 return Number.isFinite(Date.parse(v))&&new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toISOString().slice(0,10)===m.slice(1,4).join('-');
}
