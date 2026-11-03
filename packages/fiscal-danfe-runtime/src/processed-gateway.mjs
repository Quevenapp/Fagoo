import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Isolated gateway adapter. It authenticates the session; no KEK, signer, raw XML or generic proxy. */
import {DanfeRuntimeError,need,route,parsePayload,readBounded,uuid,plain,ERROR_CODES,MAX_RESPONSE_BYTES} from './processed-protocol.mjs';
import {digest,signRuntimeRequest} from './processed-auth.mjs';
import {publicProcessedResult} from './processed-dto.mjs';
const SECURITY={'Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* Never expose driver cleanup errors. */}};
function secretKey(value){
 need(typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value),503,'DANFE_GATEWAY_UNAVAILABLE');
 const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));need(bytes.length===32&&btoa(String.fromCharCode(...bytes))===value,503,'DANFE_GATEWAY_UNAVAILABLE');return bytes;
}
function allowedOrigins(value){
 const list=typeof value==='string'?value.split(',').map(v=>v.trim()):[];
 need(list.length>=1&&list.length<=5&&new Set(list).size===list.length&&list.every(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password;}catch{return false;}}),503,'DANFE_GATEWAY_UNAVAILABLE');return list;
}
function scope(signal,deadline){
 const abort=new AbortController();let rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 stopped.catch(()=>{}); // Parent cancellation may happen while the Auth child scope owns the active race.
 const stop=()=>{abort.abort();rejectStop(new DanfeRuntimeError(503,'DANFE_UPSTREAM_UNAVAILABLE'));};
 const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));signal.addEventListener('abort',stop,{once:true});
 const check=()=>need(!signal.aborted&&!abort.signal.aborted&&Date.now()<deadline,503,'DANFE_UPSTREAM_UNAVAILABLE');
 return{signal:abort.signal,deadline,check,async bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);},close(){clearTimeout(timer);signal.removeEventListener('abort',stop);abort.abort();}};
}
async function fetchBounded(s,fn){
 const pending=Promise.resolve().then(()=>{s.check();return fn();});
 try{const response=await s.bounded(()=>pending);s.check();return response;}
 catch(error){void pending.then(response=>cancel(response?.body)).catch(()=>{});throw error;}
}
function responseShape(response,url){
 need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)
  &&!(response.status>=300&&response.status<400)&&JSON_TYPE.test(response.headers.get('content-type')??''),502,'DANFE_RESPONSE_INVALID');
}
async function responseJson(response,s,limit){
 const bytes=await s.bounded(()=>readBounded(response,{limit,signal:s.signal,deadline:s.deadline}));
 try{s.check();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch(error){if(error instanceof DanfeRuntimeError)throw error;throw new DanfeRuntimeError(502,'DANFE_RESPONSE_INVALID');}
 finally{bytes.fill(0);}
}
export function createProcessedGateway({fetchImpl,now,nonce}={}){
 need(typeof fetchImpl==='function'&&typeof now==='function'&&typeof nonce==='function',503,'DANFE_GATEWAY_UNAVAILABLE');
 return async(request,env)=>{
  let bytes,secret,allowedOrigin=null,total,authScope,selected,failure='DANFE_GATEWAY_UNAVAILABLE';
  const reply=(value,status=200,extra={})=>{const body=value===null?null:JSON.stringify(value);need(body===null||new TextEncoder().encode(body).length<=(selected?.responseLimit??MAX_RESPONSE_BYTES),502,'DANFE_RESPONSE_INVALID');return new Response(body,{status,headers:{...SECURITY,...(value===null?{}:{'Content-Type':'application/json'}),
   ...(allowedOrigin?{'Access-Control-Allow-Origin':allowedOrigin,Vary:'Origin'}:{}),...extra}});};
  try{
   const origin=request.headers.get('origin');need(origin&&allowedOrigins(env.ALLOWED_ORIGINS).includes(origin),403,'DANFE_ORIGIN_FORBIDDEN');allowedOrigin=origin;
   const url=new URL(request.url);need(!url.search&&!url.hash&&!url.username&&!url.password,400,'DANFE_INVALID_REQUEST');
   const method=request.method==='OPTIONS'?request.headers.get('access-control-request-method'):request.method;
   selected=route(url.pathname,method,'/v1/fiscal-danfe');
   if(request.method==='OPTIONS'){
    const requested=(request.headers.get('access-control-request-headers')??'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    need(requested.every(v=>['authorization','content-type'].includes(v)),403,'DANFE_ORIGIN_FORBIDDEN');
    return reply(null,204,{'Access-Control-Allow-Methods':method,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'300'});
   }
   need(env.A1_RUNTIME&&typeof env.A1_RUNTIME.fetch==='function',503,'DANFE_GATEWAY_UNAVAILABLE');
   let base;try{base=new URL(env.SUPABASE_URL);}catch{throw new DanfeRuntimeError(503,'DANFE_GATEWAY_UNAVAILABLE');}
   need(isConfiguredBackendOrigin(env.SUPABASE_URL, env.SUPABASE_DEPLOYMENT, { allowTrailingSlash: true })&&typeof env.SUPABASE_ANON_KEY==='string'&&env.SUPABASE_ANON_KEY.length>=20&&env.SUPABASE_ANON_KEY.length<=4096
    &&/^[!-~]+$/.test(env.SUPABASE_ANON_KEY),503,'DANFE_GATEWAY_UNAVAILABLE');
   const bearer=request.headers.get('authorization');need(typeof bearer==='string'&&/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(bearer),401,'DANFE_UNAUTHENTICATED');
   total=scope(request.signal,Date.now()+60000);authScope=scope(total.signal,Math.min(total.deadline,Date.now()+10000));
   const authUrl=`${base.origin}/auth/v1/user`;failure='DANFE_AUTH_SERVICE_UNAVAILABLE';let actor,authResponse;
   try{
    authResponse=await fetchBounded(authScope,()=>fetchImpl(authUrl,{method:'GET',headers:{Authorization:bearer,apikey:env.SUPABASE_ANON_KEY,Accept:'application/json','Accept-Encoding':'identity'},
     redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:authScope.signal}));
    responseShape(authResponse,authUrl);
    if([401,403].includes(authResponse.status))throw new DanfeRuntimeError(401,'DANFE_UNAUTHENTICATED');
    need(authResponse.status===200,503,'DANFE_AUTH_SERVICE_UNAVAILABLE');const user=await responseJson(authResponse,authScope,131072);
    need(plain(user)&&uuid(user.id)&&user.is_anonymous!==true,401,'DANFE_UNAUTHENTICATED');actor=user.id;
   }finally{cancel(authResponse?.body);authScope.close();authScope=null;}
   total.check();
   bytes=await total.bounded(()=>readBounded(request,{limit:selected.limit,signal:total.signal,deadline:Math.min(total.deadline,Date.now()+10000)}));parsePayload(bytes,selected);
   total.check();need(typeof env.A1_AUDIENCE==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(env.A1_AUDIENCE),503,'DANFE_GATEWAY_UNAVAILABLE');
   secret=secretKey(env.A1_TRANSPORT_SECRET);const path=`/internal${url.pathname}`;
   const bodyHash=await total.bounded(()=>digest(bytes));
   const authorization=await total.bounded(()=>signRuntimeRequest({secretBytes:secret,keyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-danfe`,actor,nonce:nonce(),method:request.method,path,bodyHash,now:now()}));
   const internalUrl=`https://fiscal-runtime.internal${path}`,internal=new Request(internalUrl,{method:'GET',headers:{Authorization:authorization},redirect:'manual',signal:total.signal});
   failure='DANFE_UPSTREAM_UNAVAILABLE';total.check();let result;
   try{
    result=await fetchBounded(total,()=>env.A1_RUNTIME.fetch(internal));responseShape(result,internalUrl);const value=await responseJson(result,total,selected.responseLimit);total.check();
    if(result.status!==200){
     need([400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(result.status)&&plain(value)&&ERROR_CODES.includes(value.error)&&typeof value.recovery_required==='boolean',502,'DANFE_RESPONSE_INVALID');
     need(value.recovery_required===false,502,'DANFE_RESPONSE_INVALID');return reply({error:value.error,recovery_required:false},result.status);
    }
    const checked=await total.bounded(()=>publicProcessedResult(value,{sourceKind:selected.sourceKind,commandId:selected.commandId,action:selected.action}));total.check();return reply(checked);
   }finally{cancel(result?.body);}
  }catch(error){
   const known=error instanceof DanfeRuntimeError&&ERROR_CODES.includes(error.code);
   return reply({error:known?error.code:failure,recovery_required:false},known?error.status:503);
  }finally{authScope?.close();total?.close();bytes?.fill(0);secret?.fill(0);cancel(request.body);}
 };
}
