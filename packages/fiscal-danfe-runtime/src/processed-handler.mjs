/** Node facade for immutable processed documents. No SQL writer, custody or transport port. */
import {DanfeRuntimeError,need,route,readBounded,parsePayload,MAX_RESPONSE_BYTES,ERROR_CODES} from './processed-protocol.mjs';
import {digest,verifyRuntimeRequest} from './processed-auth.mjs';
import {FLAGS,publicProcessedResult,downloadFilename} from './processed-dto.mjs';
import {processedSource,disposeProcessedSource,reauthorizeProcessedSource} from './processed-source.mjs';
import {FiscalPrintError} from '../../fiscal-danfe/src/extract.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
const discard=h=>{try{disposeProcessedSource(h);}catch{}};
const reply=(body,status=200,limit=MAX_RESPONSE_BYTES)=>{const text=JSON.stringify(body);need(Buffer.byteLength(text)<=limit,502,'DANFE_RESPONSE_INVALID');return new Response(text,{status,headers:HEADERS});};
function sanitized(error){
 if(error instanceof DanfeRuntimeError&&ERROR_CODES.includes(error.code)&&[400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(error.status))return{status:error.status,error:error.code};
 if(error instanceof FiscalPrintError)return{status:422,error:'DANFE_LAYOUT_UNSUPPORTED'};
 return{status:503,error:'DANFE_RUNTIME_FAILED'};
}
export function createProcessedRuntimeHandler({readSource,render,transportSecret,transportKeyId,audience,now=Date.now,concurrency=2}={}){
 need(typeof readSource==='function'&&typeof render==='function'&&typeof now==='function'&&transportSecret instanceof Uint8Array&&transportSecret.length===32
  &&!(transportSecret.buffer instanceof SharedArrayBuffer)&&typeof transportKeyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(transportKeyId)
  &&typeof audience==='string'&&/^[A-Za-z0-9_-]{1,64}-danfe$/.test(audience)&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=2,503,'DANFE_RUNTIME_CONFIGURATION_INVALID');
 transportSecret=new Uint8Array(transportSecret);const stops=new Set();let active=0,disposed=false;
 const handler=async request=>{
  let body,handle,captured,controller,timer,onAbort,admitted=false,stopped=false;
  try{
   need(!disposed,503,'DANFE_RUNTIME_FAILED');const url=new URL(request.url);need(url.origin==='http://runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'DANFE_INVALID_REQUEST');
   const selected=route(url.pathname,request.method),claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:transportSecret,keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()});
   need(!disposed,503,'DANFE_RUNTIME_FAILED');need(active<concurrency,503,'DANFE_RUNTIME_BUSY');active++;admitted=true;
   controller=new AbortController();const deadline=Date.now()+45000;let rejectStop;const stop=new Promise((_,reject)=>rejectStop=reject);stop.catch(()=>{});
   const abort=()=>{if(stopped)return;stopped=true;controller.abort();rejectStop(new DanfeRuntimeError(503,'DANFE_UPSTREAM_UNAVAILABLE'));};
   onAbort=abort;stops.add(abort);request.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,45000);if(request.signal.aborted)abort();
   const check=()=>need(!stopped&&!controller.signal.aborted&&Date.now()<deadline,503,'DANFE_UPSTREAM_UNAVAILABLE');
   const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);};const opts=Object.freeze({signal:controller.signal,deadline});
   body=await bounded(()=>readBounded(request,{...opts,limit:0}));need(await digest(body)===claims.body_hash,401,'DANFE_BODY_AUTHENTICATION_FAILED');check();parsePayload(body,selected);
   const pending=Promise.resolve().then(()=>{check();return readSource(Object.freeze({actor:claims.actor,sourceKind:selected.sourceKind,commandId:selected.commandId}),opts);});
   try{handle=await bounded(()=>pending);}catch(e){void pending.then(discard).catch(()=>{});throw e;}check();captured=processedSource(handle);
   need(captured.metadata.source_kind===selected.sourceKind&&captured.metadata.source_command_id===selected.commandId,409,'DANFE_CONFLICT');
   let output;
   if(selected.action==='xml')output={...FLAGS,action:'xml',source:captured.metadata,xml_base64:Buffer.from(captured.processedBytes).toString('base64'),filename:downloadFilename(captured.metadata)};
   else{const value=await bounded(()=>render(handle));check();output={...FLAGS,action:'print',source:captured.metadata,html:value.html,html_sha256:value.sha256,html_size_bytes:Buffer.byteLength(value.html),profile:value.profile,page_count:value.page_count};}
   const checked=await bounded(()=>publicProcessedResult(output,{sourceKind:selected.sourceKind,commandId:selected.commandId,action:selected.action}));check();
   // This final ACL read happens after rendering and digest awaits; a revoked actor receives no artifact.
   await bounded(()=>reauthorizeProcessedSource(handle,opts));check();return reply(checked,200,selected.responseLimit);
  }catch(error){const failure=sanitized(error);return reply({error:failure.error,recovery_required:false},failure.status);}
  finally{clearTimeout(timer);if(onAbort){request.signal.removeEventListener('abort',onAbort);stops.delete(onAbort);}controller?.abort();body?.fill(0);captured?.signedBytes.fill(0);captured?.processedBytes.fill(0);if(handle)discard(handle);cancel(request.body);if(admitted)active--;}
 };
 handler.dispose=()=>{if(disposed)return;disposed=true;transportSecret.fill(0);for(const stop of stops)stop();stops.clear();};return handler;
}
