const BASE='/v1/system/updates';
const VERSION=/^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATES=new Set(['idle','checking','queued','running','succeeded','failed','interrupted']);
const PHASES=new Set(['idle','search','ready','download','preflight','build','backup','runtime','database','cloudflare','verification','complete','recovery']);
class UpdateError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
export const systemUpdateRoute=path=>path==='/v1/system/version'||path===BASE||path.startsWith(BASE+'/');
async function limitedJson(response,limit){
 if(Number(response.headers.get('content-length'))>limit||!response.body)throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function snapshot(value,withProgress=false){
 const installed=value?.installed,latest=value?.latest,status=value?.status;
 if(value?.protocol!==1||!VERSION.test(installed?.version||'')||!STATES.has(status?.state)||!PHASES.has(status?.phase)
   ||typeof value.update_available!=='boolean'||typeof value.cloudflare_configured!=='boolean'||typeof value.can_apply!=='boolean'
   ||typeof status.recovery_required!=='boolean')throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');
 const revision=v=>v===null||v===undefined?null:typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)?v:(()=>{throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');})();
 if(latest!==null&&(!VERSION.test(latest?.version||'')||!revision(latest.revision)||!/^[a-f0-9]{64}$/.test(latest?.manifest_sha256||'')||typeof latest.notes!=='string'||latest.notes.length>6000))throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');
 const time=v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))?v:null;
 const result={protocol:1,installed:{version:installed.version,revision:revision(installed.revision),installed_at:time(installed.installed_at)},
  latest:latest?{version:latest.version,revision:latest.revision,manifest_sha256:latest.manifest_sha256,notes:latest.notes}:null,
  update_available:value.update_available,cloudflare_configured:value.cloudflare_configured,can_apply:value.can_apply,
  status:{state:status.state,phase:status.phase,job_id:UUID.test(status.job_id||'')?status.job_id:null,version:VERSION.test(status.version||'')?status.version:null,
   updated_at:time(status.updated_at),error:typeof status.error==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(status.error)?status.error:null,
   recovery_required:status.recovery_required,backup_id:/^update-[a-f0-9-]{36}$/.test(status.backup_id||'')?status.backup_id:null}};
 if(withProgress){if(!/^[A-Za-z0-9_-]{43}$/.test(value.progress_token||''))throw new UpdateError(502,'ERP_UPDATE_INVALID_RESPONSE');result.progress_token=value.progress_token;}
 return result;
}
export async function handleSystemUpdate({request,env,settings,authenticate,fetchImpl=fetch}){
 const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'});
 const respond=(status,value)=>new Response(status===204?null:JSON.stringify(value),{status,headers});
 try{
  const url=new URL(request.url),origin=request.headers.get('Origin'),version=url.pathname==='/v1/system/version';
  const action=version?'version':url.pathname===BASE?'status':url.pathname.slice(BASE.length+1);
  if(!['version','status','check','apply','progress'].includes(action))throw new UpdateError(404,'ERP_NOT_FOUND');
  const method=['check','apply'].includes(action)?'POST':'GET';
  if(origin!==null){if(!settings.origins.includes(origin))throw new UpdateError(403,'ERP_ORIGIN_NOT_ALLOWED');headers.set('Access-Control-Allow-Origin',origin);}
  if(request.method==='OPTIONS'){
   const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
   if(!origin||request.headers.get('Access-Control-Request-Method')!==method||requested.some(v=>!['authorization','content-type'].includes(v)))throw new UpdateError(403,'ERP_PREFLIGHT_DENIED');
   headers.set('Access-Control-Allow-Methods',method);headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');return respond(204,null);
  }
  if(request.method!==method)throw new UpdateError(405,'ERP_METHOD_NOT_ALLOWED');
  if(version)return respond(200,{version:VERSION.test(env.FAGOO_VERSION||'')?env.FAGOO_VERSION:null,revision:/^[a-f0-9]{40}$/.test(env.FAGOO_REVISION||'')?env.FAGOO_REVISION:null});
  if(url.search)throw new UpdateError(400,'ERP_INVALID_QUERY');
  const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
  if(!token||token.length>8192)throw new UpdateError(401,'ERP_UNAUTHENTICATED');
  if(env.SUPABASE_DEPLOYMENT!=='self-hosted'||!/^[a-f0-9]{64}$/.test(env.FAGOO_UPDATE_AGENT_TOKEN||''))throw new UpdateError(503,'ERP_UPDATE_NOT_CONFIGURED');
  let actor;
  if(action==='progress'){
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new UpdateError(403,'ERP_UPDATE_ACCESS_DENIED');
  }else{
   actor=await authenticate(token);
   if(!UUID.test(actor||''))throw new UpdateError(403,'ERP_FORBIDDEN');
  }
  let body;
  if(method==='POST'){
   if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new UpdateError(400,'ERP_INVALID_INPUT');
   try{body=await limitedJson(request,4096);}catch{throw new UpdateError(400,'ERP_INVALID_INPUT');}
   if(action==='check'&&(!body||Array.isArray(body)||Object.keys(body).length!==0))throw new UpdateError(400,'ERP_INVALID_INPUT');
   if(action==='apply'&&(!body||Object.keys(body).sort().join(',')!=='manifest_sha256,request_id,version'||!VERSION.test(body.version||'')||!UUID.test(body.request_id||'')||!/^[a-f0-9]{64}$/.test(body.manifest_sha256||'')))throw new UpdateError(400,'ERP_INVALID_INPUT');
  }
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),12000);
  try{
   const upstream=await fetchImpl(settings.baseUrl+'/_fagoo/system/'+action,{method,redirect:'manual',signal:AbortSignal.any([request.signal,abort.signal]),
    headers:{Authorization:'Bearer '+env.FAGOO_UPDATE_AGENT_TOKEN,Accept:'application/json',...(actor?{'X-Fagoo-Actor':actor}:{'X-Fagoo-Progress':token}),...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
   if(upstream.redirected||upstream.status>=300&&upstream.status<400){void upstream.body?.cancel().catch(()=>{});throw new UpdateError(502,'ERP_UPDATE_UNAVAILABLE');}
   const result=await limitedJson(upstream,32768);
   if(!upstream.ok){const code=typeof result?.error==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(result.error)?'ERP_UPDATE_'+result.error:'ERP_UPDATE_UNAVAILABLE';throw new UpdateError([400,401,403,409].includes(upstream.status)?upstream.status:503,code);}
   return respond(upstream.status,snapshot(result,action==='apply'));
  }finally{clearTimeout(timer);}
 }catch(error){const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<600?error.status:503;
  const code=typeof error?.code==='string'&&/^ERP_[A-Z0-9_]{1,110}$/.test(error.code)?error.code:'ERP_UPDATE_UNAVAILABLE';
  return respond(status,{error:{code}});
 }
}
