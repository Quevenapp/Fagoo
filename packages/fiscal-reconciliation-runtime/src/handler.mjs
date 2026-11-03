/** Private RECONCILIATION boundary. Owns no network driver, environment or credential store. */
import {ReconciliationRuntimeError,need,route,readBounded,parsePayload,MAX_RESPONSE_BYTES,ERROR_CODES} from './protocol.mjs';
import {digest,verifyRuntimeRequest} from './auth.mjs';
import {publicResult} from './dto.mjs';

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const reply=(body,status=200)=>{
 const text=JSON.stringify(body);
 need(new TextEncoder().encode(text).length<=MAX_RESPONSE_BYTES,502,'RECONCILIATION_RESPONSE_INVALID');
 return new Response(text,{status,headers:HEADERS});
};
function sanitized(error){
 if(error?.code==='RECONCILIATION_DISABLED')return {status:409,error:'RECONCILIATION_DISABLED'};
 if(error instanceof ReconciliationRuntimeError&&ERROR_CODES.includes(error.code)&&[400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(error.status))return {status:error.status,error:error.code};
 const codes={'42501':[403,'RECONCILIATION_FORBIDDEN'],'40001':[409,'RECONCILIATION_CONFLICT'],'55000':[409,'RECONCILIATION_CONFLICT'],
  P0002:[404,'RECONCILIATION_NOT_FOUND'],'22023':[400,'RECONCILIATION_INVALID_REQUEST']};
 if(Object.hasOwn(codes,error?.code??'')){const[status,code]=codes[error.code];return {status,error:code};}
 return {status:503,error:error?.code==='RECONCILIATION_ALREADY_RUNNING'?'RECONCILIATION_RUNTIME_BUSY':'RECONCILIATION_RUNTIME_FAILED'};
}
export function createReconciliationRuntimeHandler({service,transportSecret,transportKeyId,audience,now=Date.now,concurrency=2}={}){
 need(['run','command','history','recover'].every(k=>typeof service?.[k]==='function')&&typeof now==='function'
  &&transportSecret instanceof Uint8Array&&transportSecret.length===32
  &&typeof transportKeyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(transportKeyId)
  &&typeof audience==='string'&&/^[A-Za-z0-9_-]{1,64}-reconciliation$/.test(audience)
  &&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=2,503,'RECONCILIATION_RUNTIME_CONFIGURATION_INVALID');
 transportSecret=new Uint8Array(transportSecret);
 const stops=new Set();let active=0,disposed=false;
 const handler=async request=>{
  let bytes,controller,timer,admitted=false,onAbort,commandId=null,selected,stopped=false;
  try{
   need(!disposed,503,'RECONCILIATION_RUNTIME_FAILED');
   const url=new URL(request.url);
   need(url.origin==='http://runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'RECONCILIATION_INVALID_REQUEST');
   selected=route(url.pathname,request.method);
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:transportSecret,
    keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()});
   need(!disposed,503,'RECONCILIATION_RUNTIME_FAILED');need(active<concurrency,503,'RECONCILIATION_RUNTIME_BUSY');active++;admitted=true;
   controller=new AbortController();const deadline=Date.now()+45000;let rejectStop;
   const stop=new Promise((_,reject)=>{rejectStop=reject;});stop.catch(()=>{});
   const abort=()=>{if(stopped)return;stopped=true;controller.abort();rejectStop(new ReconciliationRuntimeError(503,'RECONCILIATION_UPSTREAM_UNAVAILABLE'));};
   onAbort=abort;stops.add(abort);request.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(abort,45000);if(request.signal.aborted)abort();
   const check=()=>need(!stopped&&!controller.signal.aborted&&Date.now()<deadline,503,'RECONCILIATION_UPSTREAM_UNAVAILABLE');
   const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);};
   const opts={signal:controller.signal,deadline};
   if(selected.method==='POST')need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),415,'RECONCILIATION_CONTENT_TYPE_UNSUPPORTED');
   bytes=await bounded(()=>readBounded(request,{signal:controller.signal,deadline:Math.min(deadline,Date.now()+10000),limit:selected.limit}));
   need(await digest(bytes)===claims.body_hash,401,'RECONCILIATION_BODY_AUTHENTICATION_FAILED');check();
   const payload=parsePayload(bytes,selected),actor=claims.actor;
   commandId=selected.commandId??payload?.command_id??null;
   let value;
   if(selected.action==='run')value=await bounded(()=>service.run({actor,commandId:payload.command_id,candidateId:payload.candidate_id,
    signedHash:payload.signed_hash,expectedA1Version:payload.expected_a1_version,expectedIdentityVersion:payload.expected_identity_version,confirmed:true},opts));
   else if(selected.action==='recover')value=await bounded(()=>service.recover({actor,commandId:payload.command_id},opts));
   else if(selected.action==='history')value=await bounded(()=>service.history({actor,candidateId:selected.candidateId,limit:payload.limit,before:payload.before},opts));
   else value=await bounded(()=>service.command({actor,commandId:selected.commandId},opts));
   check();return reply(publicResult(value,{action:selected.action,payload,commandId,candidateId:selected.candidateId}));
  }catch(error){const failure=sanitized(error);return reply({error:failure.error,recovery_required:failure.error!=='RECONCILIATION_DISABLED'&&Boolean(commandId&&['run','recover'].includes(selected?.action))},failure.status);}
  finally{
   clearTimeout(timer);if(onAbort){request.signal.removeEventListener('abort',onAbort);stops.delete(onAbort);}controller?.abort();bytes?.fill(0);
   try{void request.body?.cancel().catch(()=>{});}catch{/* Cleanup never exposes an exception or changes a result. */}
   if(admitted)active--;
  }
 };
 // Disposal cancels admission/work. It cannot undo an already consumed SQL
 // grant or repeat a remote protocol query; the client recovers through its command ID.
 handler.dispose=()=>{if(disposed)return;disposed=true;transportSecret.fill(0);for(const stop of stops)stop();stops.clear();};
 return handler;
}
