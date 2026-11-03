/** Node-only read facade. The only RPC is signed_get; only immutable candidate XML is read. */
import {createHash} from 'node:crypto';
import {extractCandidatePreview,renderCandidateHtml,FiscalPrintError} from '../../fiscal-danfe/src/index.mjs';
import {projectResponse} from '../../fiscal-signed-rpc/src/dto.mjs';
import {DanfeRuntimeError,need,route,readBounded,parsePayload,MAX_RESPONSE_BYTES,MAX_XML_BYTES,ERROR_CODES} from './protocol.mjs';
import {digest,verifyRuntimeRequest} from './auth.mjs';
import {FLAGS,CURRENT_KEYS,publicResult} from './dto.mjs';
const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* No cleanup diagnostics leave this boundary. */}};
const reply=(body,status=200)=>{const text=JSON.stringify(body);need(Buffer.byteLength(text)<=MAX_RESPONSE_BYTES,502,'DANFE_RESPONSE_INVALID');return new Response(text,{status,headers:HEADERS});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function sanitized(error){
 if(error instanceof DanfeRuntimeError&&ERROR_CODES.includes(error.code)&&[400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(error.status))return{status:error.status,error:error.code};
 const states={'42501':[403,'DANFE_FORBIDDEN'],'40001':[409,'DANFE_CONFLICT'],'55000':[409,'DANFE_CONFLICT'],P0002:[404,'DANFE_NOT_FOUND'],'22023':[400,'DANFE_INVALID_REQUEST']};
 if(Object.hasOwn(states,error?.code??'')){const[status,code]=states[error.code];return{status,error:code};}
 if(error instanceof FiscalPrintError)return{status:422,error:['PRINT_HEADER_TOO_LARGE','PRINT_OUTPUT_LIMIT','PRINT_PAGE_LIMIT','PRINT_ROW_TOO_TALL'].includes(error.code)?'DANFE_LAYOUT_UNSUPPORTED':'DANFE_XML_INVALID'};
 return{status:503,error:'DANFE_RUNTIME_FAILED'};
}
export function createDanfeRuntimeHandler({rpc,storage,transportSecret,transportKeyId,audience,now=Date.now,concurrency=2}={}){
 need(typeof rpc==='function'&&typeof storage?.read==='function'&&typeof now==='function'&&transportSecret instanceof Uint8Array&&transportSecret.length===32
  &&!(transportSecret.buffer instanceof SharedArrayBuffer)&&typeof transportKeyId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(transportKeyId)
  &&typeof audience==='string'&&/^[A-Za-z0-9_-]{1,64}-danfe$/.test(audience)&&Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=2,503,'DANFE_RUNTIME_CONFIGURATION_INVALID');
 const read=storage.read.bind(storage);transportSecret=new Uint8Array(transportSecret);const stops=new Set();let active=0,disposed=false;
 const handler=async request=>{
  let body,xml,controller,timer,onAbort,admitted=false,response,stopped=false;
  try{
   need(!disposed,503,'DANFE_RUNTIME_FAILED');const url=new URL(request.url);
   need(url.origin==='http://runtime.internal'&&!url.search&&!url.hash&&!url.username&&!url.password,400,'DANFE_INVALID_REQUEST');
   const selected=route(url.pathname,request.method),claims=await verifyRuntimeRequest({header:request.headers.get('authorization'),secretBytes:transportSecret,keyId:transportKeyId,audience,method:selected.method,path:selected.path,now:now()});
   need(!disposed,503,'DANFE_RUNTIME_FAILED');need(active<concurrency,503,'DANFE_RUNTIME_BUSY');active++;admitted=true;
   controller=new AbortController();const deadline=Date.now()+45000;let rejectStop;
   const stop=new Promise((_,reject)=>{rejectStop=reject;});stop.catch(()=>{});
   const abort=()=>{if(stopped)return;stopped=true;controller.abort();rejectStop(new DanfeRuntimeError(503,'DANFE_UPSTREAM_UNAVAILABLE'));};
   onAbort=abort;stops.add(abort);request.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,45000);if(request.signal.aborted)abort();
   const check=()=>need(!stopped&&!controller.signal.aborted&&Date.now()<deadline,503,'DANFE_UPSTREAM_UNAVAILABLE');
   const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);};
   const opts=Object.freeze({signal:controller.signal,deadline});
   body=await bounded(()=>readBounded(request,{...opts,limit:0}));need(await digest(body)===claims.body_hash,401,'DANFE_BODY_AUTHENTICATION_FAILED');check();parsePayload(body,selected);
   const args=Object.freeze({p_user_id:claims.actor,p_candidate_id:selected.candidateId});
   async function metadata(){
    const raw=await bounded(()=>rpc('erp_fiscal_signed_get',args,opts));check();let value;
    try{value=projectResponse('erp_fiscal_signed_get',raw,args);}catch{throw new DanfeRuntimeError(502,'DANFE_RESPONSE_INVALID');}
    need(value.current.state==='stored'&&value.artifact,409,'DANFE_NOT_STORED');return value;
   }
   const before=await metadata(),r=before.receipt,a=before.artifact,key=`candidates/${r.candidate_id}/${a.signed_hash}.xml`;
   const pending=Promise.resolve().then(()=>{check();return read(Object.freeze({bucket:'brufap-fiscal-artifacts',key,...opts}));});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw error;}
   check();need(response instanceof Response&&response.status===200&&!response.redirected&&response.headers.get('content-type')==='application/octet-stream',502,'DANFE_STORAGE_INVALID');
   xml=await bounded(()=>readBounded(response,{...opts,limit:Math.min(MAX_XML_BYTES,a.size_bytes)}));check();
   need(xml.length===a.size_bytes&&sha(xml)===a.signed_hash,502,'DANFE_STORAGE_INVALID');
   const projection=extractCandidatePreview(xml,{candidate_id:r.candidate_id,sha256:a.signed_hash,size_bytes:a.size_bytes,model:r.model,environment:'2'});
   const printed=renderCandidateHtml(projection);check();
   const after=await metadata();
   need(JSON.stringify(before.receipt)===JSON.stringify(after.receipt)&&JSON.stringify(before.artifact)===JSON.stringify(after.artifact),409,'DANFE_CONFLICT');
   const result=await bounded(()=>publicResult({...FLAGS,candidate_id:r.candidate_id,candidate_version:r.version,model:r.model,source_sha256:a.signed_hash,source_size_bytes:a.size_bytes,
    html:printed.html,html_sha256:printed.sha256,html_size_bytes:Buffer.byteLength(printed.html),page_count:printed.page_count,profile:printed.profile,
    current:Object.fromEntries(CURRENT_KEYS.map(k=>[k,after.current[k]]))},{candidateId:r.candidate_id}));
   check();return reply(result);
  }catch(error){const failure=sanitized(error);return reply({error:failure.error,recovery_required:false},failure.status);}
  finally{clearTimeout(timer);if(onAbort){request.signal.removeEventListener('abort',onAbort);stops.delete(onAbort);}controller?.abort();body?.fill(0);xml?.fill(0);cancel(response?.body);cancel(request.body);if(admitted)active--;}
 };
 handler.dispose=()=>{if(disposed)return;disposed=true;transportSecret.fill(0);for(const stop of stops)stop();stops.clear();};return handler;
}
