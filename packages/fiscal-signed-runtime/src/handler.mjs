/** Private Node handler. Composition owns dependencies; this module reads no environment or secrets. */
import {createSignedFiscalOrchestrator} from '../../fiscal-signed-orchestrator/src/signed.mjs';
import {SignedRuntimeError,need,route,readBounded,parsePayload,MAX_RESPONSE_BYTES,ERROR_CODES} from './protocol.mjs';
import {digest,verifyRuntimeRequest} from './auth.mjs';
import {publicResult} from './dto.mjs';
import {projectSqlView,projectSqlHistory} from './sql-dto.mjs';

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const reply=(body,status=200)=>{
 const text=JSON.stringify(body);
 need(new TextEncoder().encode(text).length<=MAX_RESPONSE_BYTES,502,'SIGNED_RESPONSE_INVALID');
 return new Response(text,{status,headers:HEADERS});
};
function sanitized(error){
 if(error instanceof SignedRuntimeError&&ERROR_CODES.includes(error.code)&&[400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(error.status))return {status:error.status,error:error.code};
 const codes={'42501':[403,'SIGNED_FORBIDDEN'],'40001':[409,'SIGNED_CONFLICT'],'55000':[409,'SIGNED_CONFLICT'],
  P0002:[404,'SIGNED_NOT_FOUND'],'22023':[400,'SIGNED_INVALID_REQUEST']};
 if(Object.hasOwn(codes,error?.code??'')){const[status,code]=codes[error.code];return {status,error:code};}
 return {status:503,error:error?.code==='SIGNED_ALREADY_RUNNING'?'SIGNED_RUNTIME_BUSY':'SIGNED_RUNTIME_FAILED'};
}
export function createSignedRuntimeHandler({rpc,storage,withAuthorizedSigner,validateXsd,transportSecret,transportKeyId,audience,now=Date.now,concurrency=2}={}){
 need(typeof rpc==='function'&&typeof storage?.read==='function'&&typeof storage?.putImmutable==='function'
  &&typeof withAuthorizedSigner==='function'&&typeof validateXsd==='function'&&typeof now==='function'
  &&transportSecret instanceof Uint8Array&&transportSecret.length===32
  &&typeof transportKeyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(transportKeyId)
  &&typeof audience==='string'&&/^[A-Za-z0-9_-]{1,64}-signed$/.test(audience)
  &&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=2,
  503,'SIGNED_RUNTIME_CONFIGURATION_INVALID');
 // Own the transport bytes for this handler's lifetime; caller cleanup cannot rotate the key mid-request.
 transportSecret=new Uint8Array(transportSecret);
 const orchestrator=createSignedFiscalOrchestrator({rpc,storage,withAuthorizedSigner,validateXsd}),stops=new Set();let active=0,disposed=false;
 const handler=async request=>{
  let bytes,controller,timer,admitted=false,onAbort,commandId=null,selected,stopped=false;
  try{
   need(!disposed,503,'SIGNED_RUNTIME_FAILED');
   const url=new URL(request.url);
   need(url.origin==='http://runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'SIGNED_INVALID_REQUEST');
   selected=route(url.pathname,request.method);
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:transportSecret,
    keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()});
   need(!disposed,503,'SIGNED_RUNTIME_FAILED');
   need(active<concurrency,503,'SIGNED_RUNTIME_BUSY');active++;admitted=true;
   controller=new AbortController();const deadline=Date.now()+45000;let rejectStop;
   const stop=new Promise((_,reject)=>{rejectStop=reject;});stop.catch(()=>{});
   const abort=()=>{if(stopped)return;stopped=true;controller.abort();rejectStop(new SignedRuntimeError(503,'SIGNED_UPSTREAM_UNAVAILABLE'));};
   onAbort=abort;stops.add(abort);request.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(abort,45000);if(request.signal.aborted)abort();
   const check=()=>need(!stopped&&!controller.signal.aborted&&Date.now()<deadline,503,'SIGNED_UPSTREAM_UNAVAILABLE');
   const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);};
   const opts={signal:controller.signal,deadline};
   if(selected.method==='POST')need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),415,'SIGNED_CONTENT_TYPE_UNSUPPORTED');
   bytes=await bounded(()=>readBounded(request,{signal:controller.signal,deadline:Math.min(deadline,Date.now()+10000),limit:selected.limit}));
   need(await digest(bytes)===claims.body_hash,401,'SIGNED_BODY_AUTHENTICATION_FAILED');check();
   const payload=parsePayload(bytes,selected),actor=claims.actor;
   commandId=selected.commandId??payload?.command_id??null;let value;
   if(selected.action==='run')value=await bounded(()=>orchestrator.run({actor,commandId:payload.command_id,unsignedJobId:payload.unsigned_job_id,
    unsignedHash:payload.unsigned_hash,basisHash:payload.basis_hash,expectedA1Version:payload.expected_a1_version},opts));
   else if(selected.action==='history')value=projectSqlHistory(await bounded(()=>rpc('erp_fiscal_signed_history',{
    p_user_id:actor,p_unsigned_job_id:selected.jobId,p_limit:payload.limit,p_before:payload.before},opts)),{jobId:selected.jobId,payload});
   else{
    const lookup=selected.action==='candidate'?{name:'get',args:{p_candidate_id:selected.candidateId},binding:{candidateId:selected.candidateId}}:
     {name:'command',args:{p_command_id:selected.commandId},binding:{commandId:selected.commandId}};
    value=projectSqlView(await bounded(()=>rpc(`erp_fiscal_signed_${lookup.name}`,{p_user_id:actor,...lookup.args},opts)),lookup.binding);
   }
   check();return reply(publicResult(value,{action:selected.action,payload,jobId:selected.jobId,commandId:selected.commandId,candidateId:selected.candidateId}));
  }catch(error){const failure=sanitized(error);return reply({error:failure.error,recovery_required:Boolean(commandId&&selected?.action==='run')},failure.status);}
  finally{
   clearTimeout(timer);if(onAbort){request.signal.removeEventListener('abort',onAbort);stops.delete(onAbort);}controller?.abort();bytes?.fill(0);
   try{void request.body?.cancel().catch(()=>{});}catch{/* Never replace a sanitized response during cleanup. */}
   if(admitted)active--;
  }
 };
 // Shutdown does not undo remote work. It stops admission and discards late responses while callers recover by command.
 handler.dispose=()=>{if(disposed)return;disposed=true;transportSecret.fill(0);for(const stop of stops)stop();stops.clear();};
 return handler;
}
