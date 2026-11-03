/** Shared request plumbing of the Preferências and Sistema routes (migrations 115-118): bounded JSON bodies, frozen route
 * objects and one execution path with timeout, cancellation and the uncertain-outcome rule for dispatched mutations. */
export class PreferencesError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
export const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new PreferencesError(status,code);};
export const need=(v,...e)=>{if(!v)fail(...e);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const uuid=v=>typeof v==='string'&&v.length===36&&UUID.test(v);
const routes=new WeakSet();
export function freezeRoute(route){const frozen=Object.freeze({...route,args:Object.freeze({...route.args})});routes.add(frozen);return frozen;}
export const knownRoute=route=>routes.has(route);

/** application/json only, identity encoding, size-bounded and time-bounded; never echoes the body. */
export async function readJsonBody(request,limit){
 need(/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')&&request.body,400,'ERP_INVALID_INPUT');
 const length=request.headers.get('content-length');need(length===null||/^[0-9]+$/.test(length)&&Number(length)<=limit,400,'ERP_INVALID_INPUT');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),deadline=Date.now()+5000;let timer,buffer='',size=0,rejectAbort;
 const abort=()=>rejectAbort?.(new PreferencesError(408,'ERP_REQUEST_TIMEOUT'));
 const wait=new Promise((_,reject)=>{rejectAbort=reject;timer=setTimeout(abort,5000);request.signal.addEventListener('abort',abort,{once:true});});wait.catch(()=>{});
 try{const check=()=>need(!request.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');check();
  for(;;){check();const r=await Promise.race([reader.read(),wait]);check();if(r.done)break;need(r.value instanceof Uint8Array&&r.value.byteLength>0,400,'ERP_INVALID_INPUT');size+=r.value.byteLength;need(size<=limit,400,'ERP_INVALID_INPUT');buffer+=decoder.decode(r.value,{stream:true});}
  const value=JSON.parse(buffer+decoder.decode());check();return value;}
 catch(e){if(e instanceof PreferencesError)throw e;return fail(400,'ERP_INVALID_INPUT');}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);try{void reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
}
export function baseChecks(request){
 need(request instanceof Request);const url=new URL(request.url);
 need(request.url.length<=4096&&!url.hash&&(!request.headers.has('content-encoding')||request.headers.get('content-encoding')==='identity'));
 return url;
}
export function getWithoutBody(request){need(request.body===null&&(!request.headers.has('content-length')||request.headers.get('content-length')==='0'));}

const KNOWN={42501:[403,'ERP_ACCESS_DENIED'],22023:[400,'ERP_INVALID_INPUT'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],
 ERP_ACCESS_DENIED:[403,'ERP_ACCESS_DENIED'],ERP_FORBIDDEN:[403,'ERP_ACCESS_DENIED'],ERP_NOT_FOUND:[404,'ERP_NOT_FOUND'],ERP_CONFLICT:[409,'ERP_CONFLICT'],
 ERP_INVALID_INPUT:[400,'ERP_INVALID_INPUT'],ERP_INVALID_QUERY:[400,'ERP_INVALID_INPUT'],ERP_USERS_INVITE_REFUSED:[422,'ERP_USERS_INVITE_REFUSED']};
/**
 * Runs one RPC for a route created by freezeRoute. A mutation whose request may have reached the database and has no
 * validated answer is reported as ERP_RESULT_UNCONFIRMED: only reading the same command can tell whether it committed.
 */
export async function executeRoute(route,context,parse,{maxTimeoutMs=20000,extra=[],invoke=null}={}){
 need(context&&typeof context==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(context)));const c={};
 for(const k of Reflect.ownKeys(context)){const d=Object.getOwnPropertyDescriptor(context,k);need(typeof k==='string'&&['userId','rpc','signal','timeoutMs',...extra].includes(k)&&d.enumerable&&Object.hasOwn(d,'value'));c[k]=d.value;}
 const{userId,rpc,signal,timeoutMs=maxTimeoutMs}=c;
 need(knownRoute(route),404,'ERP_NOT_FOUND');need(uuid(userId)&&typeof rpc==='function',403,'ERP_ACCESS_DENIED');need(signal===undefined||signal instanceof AbortSignal);need(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=maxTimeoutMs);
 const args=Object.freeze({...route.args,p_user_id:userId}),controller=new AbortController(),deadline=Date.now()+timeoutMs;let timer,dispatched=false;
 const cancel=()=>controller.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const timeout=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new PreferencesError(408,'ERP_REQUEST_TIMEOUT')),{once:true});timer=setTimeout(cancel,timeoutMs);});timeout.catch(()=>{});
 try{
  need(!controller.signal.aborted,408,'ERP_REQUEST_TIMEOUT');
  const result=await Promise.race([Promise.resolve().then(()=>{need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');dispatched=true;const options={signal:controller.signal,deadline};return invoke?invoke(route,args,{rpc,options,context:c}):rpc(route.rpc,args,options);}),timeout]);
  need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');
  const value=parse(route,args,result,c);need(!controller.signal.aborted&&Date.now()<deadline,408,'ERP_REQUEST_TIMEOUT');return value;
 }catch(e){
  const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,code=d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;
  const contract=e&&typeof e==='object'&&e.status===502;
  if(code&&Object.hasOwn(KNOWN,code)&&!contract)throw new PreferencesError(...KNOWN[code]);
  if(route.mutation&&dispatched)throw new PreferencesError(503,'ERP_RESULT_UNCONFIRMED');
  if(e instanceof PreferencesError)throw e;
  if(e&&typeof e==='object'&&Number.isInteger(e.status)&&typeof e.code==='string'&&/^ERP_[A-Z_]+$/.test(e.code))throw new PreferencesError(e.status,e.code);
  throw new PreferencesError(502,'ERP_UPSTREAM_UNAVAILABLE');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
}
