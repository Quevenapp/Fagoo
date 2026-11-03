/** Private Worker handler. Unsigned jobs never open the A1 container or receive its KEK. */
import {createUnsignedXmlOrchestrator} from '../../fiscal-unsigned-orchestrator/src/unsigned.mjs';
import {createFiscalUnsignedRpc} from '../../fiscal-unsigned-rpc/src/rpc.mjs';
import {createFiscalArtifactStorage} from '../../fiscal-artifact-storage/src/storage.mjs';
import {UnsignedRuntimeError,need,route,readBounded,parsePayload} from './protocol.mjs';
import {digest,verifyRuntimeRequest} from './auth.mjs';
import {publicResult,projectSqlView,projectSqlHistory} from './dto.mjs';

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
function sanitized(error){
 if(error instanceof UnsignedRuntimeError)return {status:error.status,error:error.code};
 const codes={'42501':[403,'UNSIGNED_FORBIDDEN'],'40001':[409,'UNSIGNED_CONFLICT'],'55000':[409,'UNSIGNED_CONFLICT'],
  P0002:[404,'UNSIGNED_NOT_FOUND'],'22023':[400,'UNSIGNED_INVALID_REQUEST']};
 if(Object.hasOwn(codes,error?.code??'')){const[status,code]=codes[error.code];return {status,error:code};}
 return {status:503,error:'UNSIGNED_RUNTIME_FAILED'};
}
export function createUnsignedRuntimeHandler({rpc,storage,transportSecret,transportKeyId,audience,now=Date.now,concurrency=2}={}){
 need(typeof rpc==='function'&&typeof storage?.read==='function'&&typeof storage?.putImmutable==='function'
  &&transportSecret instanceof Uint8Array&&transportSecret.length===32&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,
  503,'UNSIGNED_RUNTIME_CONFIGURATION_INVALID');
 const orchestrator=createUnsignedXmlOrchestrator({rpc,storage});let active=0;
 return async request=>{
  let bytes,controller,timer,admitted=false,onAbort,commandId=null,selected,stopped=false,rejectStop;
  try{
   const url=new URL(request.url);
   need(url.origin==='https://fiscal-runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'UNSIGNED_INVALID_REQUEST');
   selected=route(url.pathname,request.method);
   const claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:transportSecret,
    keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()});
   need(active<concurrency,503,'UNSIGNED_RUNTIME_BUSY');active++;admitted=true;
   controller=new AbortController();const deadline=Date.now()+45000;
   const stop=new Promise((_,reject)=>{rejectStop=reject;});
   const abort=()=>{if(stopped)return;stopped=true;controller.abort();rejectStop(new UnsignedRuntimeError(503,'UNSIGNED_UPSTREAM_UNAVAILABLE'));};
   // A race always observes stop before cancellation can reject it.
   stop.catch(()=>{});onAbort=abort;request.signal.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(abort,45000);if(request.signal.aborted)abort();
   const check=()=>need(!stopped&&!controller.signal.aborted&&Date.now()<deadline,503,'UNSIGNED_UPSTREAM_UNAVAILABLE');
   const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);};
   const opts={signal:controller.signal,deadline};
   if(selected.method==='POST')need(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()==='application/json',415,'UNSIGNED_CONTENT_TYPE_UNSUPPORTED');
   bytes=await bounded(()=>readBounded(request,{...opts,limit:selected.limit}));
   need(await digest(bytes)===claims.body_hash,401,'UNSIGNED_BODY_AUTHENTICATION_FAILED');check();
   const payload=parsePayload(bytes,selected),actor=claims.actor;
   commandId=selected.commandId??payload?.command_id??null;
   let value;
   if(selected.action==='preview')value=await bounded(()=>orchestrator.preview({actor,draftId:payload.draft_id,completionVersion:payload.completion_version},opts));
   else if(selected.action==='generate')value=await bounded(()=>orchestrator.run({actor,commandId:payload.command_id,reservationId:payload.reservation_id,
    draftId:payload.draft_id,completionVersion:payload.completion_version,completionHash:payload.completion_hash,basisHash:payload.basis_hash},opts));
   else if(selected.action==='history')value=projectSqlHistory(await bounded(()=>rpc('erp_fiscal_unsigned_history',{
    p_user_id:actor,p_reservation_id:payload.reservation_id,p_limit:payload.limit,p_before:payload.before},opts)),
    {reservationId:payload.reservation_id,limit:payload.limit,before:payload.before});
   else {
    const lookup=selected.action==='job'?{name:'get',args:{p_job_id:selected.jobId},binding:{jobId:selected.jobId}}:
     {name:'command',args:{p_command_id:selected.commandId},binding:{commandId:selected.commandId}};
    value=projectSqlView(await bounded(()=>rpc(`erp_fiscal_unsigned_${lookup.name}`,{p_user_id:actor,...lookup.args},opts)),lookup.binding);
   }
   check();return reply(publicResult(value,{action:selected.action,payload,jobId:selected.jobId,commandId:selected.commandId}));
  }catch(error){const failure=sanitized(error);return reply({error:failure.error,recovery_required:Boolean(commandId&&selected?.action==='generate')},failure.status);}
  finally{clearTimeout(timer);if(onAbort)request.signal.removeEventListener('abort',onAbort);controller?.abort();bytes?.fill(0);
   try{void request.body?.cancel().catch(()=>{});}catch{/* Cleanup must not replace a sanitized response. */}
   if(admitted)active--;}
 };
}
/** Uses only the already-authorized transport key and Supabase credential; no vault keys. */
export function createUnsignedExecutor(env,fetchImpl){
 need(env&&typeof fetchImpl==='function'&&typeof env.A1_TRANSPORT_SECRET==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(env.A1_TRANSPORT_SECRET),503,'UNSIGNED_RUNTIME_CONFIGURATION_INVALID');
 const secret=Uint8Array.from(atob(env.A1_TRANSPORT_SECRET),char=>char.charCodeAt(0));
 need(secret.length===32&&btoa(String.fromCharCode(...secret))===env.A1_TRANSPORT_SECRET,503,'UNSIGNED_RUNTIME_CONFIGURATION_INVALID');
 const config={projectUrl:env.SUPABASE_URL,serviceKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl};
 const rpc=createFiscalUnsignedRpc(config),storage=createFiscalArtifactStorage(config);
 return createUnsignedRuntimeHandler({rpc,storage,transportSecret:secret,transportKeyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-unsigned`});
}
