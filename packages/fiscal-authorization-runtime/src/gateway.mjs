import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
import {dispatchBinding} from './dispatch-protocol.mjs';
import {projectDispatchPublic} from './dispatch-public-dto.mjs';
import {revalidationBinding,projectRevalidationResult} from './revalidation-protocol.mjs';
import {receiptQueryBinding,projectReceiptQueryResult} from './receipt-query-protocol.mjs';
/** Isolated gateway adapter. It authenticates the session; no KEK, signer, XML or generic proxy. */
import {AuthorizationRuntimeError,need,route,parsePayload,readBounded,uuid,plain,ERROR_CODES,MAX_RESPONSE_BYTES,captureRequest} from './protocol.mjs';
import {data} from '../../fiscal-authorization-http/src/protocol.mjs';
import {digest,signRuntimeRequest} from './auth.mjs';
import {publicResult} from '../../fiscal-authorization-http/src/dto.mjs';
import {projectReviewPublic} from './review-dto.mjs';
import {reviewBinding,isMutationAction} from './review-protocol.mjs';
import {resultBinding} from './protocol.mjs';
const SECURITY={'Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
const JSON_TYPE=/^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* Never expose driver cleanup errors. */}};
function exactError(v,commandId){const keys=Object.keys(v);return keys.every(k=>['error','recovery_required','command_id'].includes(k))&&(!Object.hasOwn(v,'command_id')||v.command_id===commandId);}
function secretKey(value){
 need(typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
 const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));need(bytes.length===32&&btoa(String.fromCharCode(...bytes))===value,503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');return bytes;
}
function allowedOrigins(value){
 const list=typeof value==='string'?value.split(',').map(v=>v.trim()):[];
 need(list.length>=1&&list.length<=5&&new Set(list).size===list.length&&list.every(v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password;}catch{return false;}}),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');return list;
}
function scope(signal,deadline){
 const abort=new AbortController();let rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;});
 stopped.catch(()=>{}); // Parent cancellation may happen while the Auth child scope owns the active race.
 const stop=()=>{abort.abort();rejectStop(new AuthorizationRuntimeError(503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE'));};
 const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));signal.addEventListener('abort',stop,{once:true});
 const check=()=>need(!signal.aborted&&!abort.signal.aborted&&Date.now()<deadline,503,'AUTHORIZATION_UPSTREAM_UNAVAILABLE');
 return{signal:abort.signal,deadline,check,async bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);},close(){clearTimeout(timer);signal.removeEventListener('abort',stop);abort.abort();}};
}
async function fetchBounded(s,fn){
 const pending=Promise.resolve().then(()=>{s.check();return fn();});
 try{const response=await s.bounded(()=>pending);s.check();return response;}
 catch(error){void pending.then(response=>cancel(response?.body)).catch(()=>{});throw error;}
}
function responseShape(response,url){
 need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)
  &&!(response.status>=300&&response.status<400)&&JSON_TYPE.test(response.headers.get('content-type')??''),502,'AUTHORIZATION_RESPONSE_INVALID');
}
async function responseJson(response,s,limit){
 const bytes=await s.bounded(()=>readBounded(response,{limit,signal:s.signal,deadline:s.deadline}));
 try{s.check();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
 catch(error){if(error instanceof AuthorizationRuntimeError)throw error;throw new AuthorizationRuntimeError(502,'AUTHORIZATION_RESPONSE_INVALID');}
 finally{bytes.fill(0);}
}
export function createAuthorizationGateway(configuration){
 const {fetchImpl,now,nonce}=data(configuration,['fetchImpl','now','nonce']);
 need(typeof fetchImpl==='function'&&typeof now==='function'&&typeof nonce==='function',503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
 return async(request,env)=>{
  let message,bytes,secret,allowedOrigin=null,total,authScope,runtimeSent=false,selected,payload,failure='AUTHORIZATION_GATEWAY_UNAVAILABLE';
  const reply=(value,status=200,extra={})=>new Response(value===null?null:JSON.stringify(value),{status,headers:{...SECURITY,...(value===null?{}:{'Content-Type':'application/json'}),
   ...(allowedOrigin?{'Access-Control-Allow-Origin':allowedOrigin,Vary:'Origin'}:{}),...extra}});
  try{
   message=captureRequest(request);
   const origin=message.headers.get('origin');need(origin&&allowedOrigins(env.ALLOWED_ORIGINS).includes(origin),403,'AUTHORIZATION_ORIGIN_FORBIDDEN');allowedOrigin=origin;
   const url=new URL(message.url);need(!url.search&&!url.hash&&!url.username&&!url.password,400,'AUTHORIZATION_INVALID_REQUEST');
   const method=message.method==='OPTIONS'?message.headers.get('access-control-request-method'):message.method;
   selected=route(url.pathname,method,'/v1/fiscal-authorization');
   if(message.method==='OPTIONS'){
    const requested=(message.headers.get('access-control-request-headers')??'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
    need(requested.every(v=>['authorization','content-type'].includes(v)),403,'AUTHORIZATION_ORIGIN_FORBIDDEN');
    return reply(null,204,{'Access-Control-Allow-Methods':method,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'300'});
   }
   need(env.A1_RUNTIME&&typeof env.A1_RUNTIME.fetch==='function',503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
   let base;try{base=new URL(env.SUPABASE_URL);}catch{throw new AuthorizationRuntimeError(503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');}
   need(isConfiguredBackendOrigin(env.SUPABASE_URL, env.SUPABASE_DEPLOYMENT, { allowTrailingSlash: true })&&typeof env.SUPABASE_ANON_KEY==='string'&&env.SUPABASE_ANON_KEY.length>=20&&env.SUPABASE_ANON_KEY.length<=4096
    &&/^[!-~]+$/.test(env.SUPABASE_ANON_KEY),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
   const bearer=message.headers.get('authorization');need(typeof bearer==='string'&&/^Bearer [A-Za-z0-9_.-]{20,8192}$/.test(bearer),401,'AUTHORIZATION_UNAUTHENTICATED');
   total=scope(message.signal,Date.now()+60000);authScope=scope(total.signal,Math.min(total.deadline,Date.now()+10000));
   const authUrl=`${base.origin}/auth/v1/user`;failure='AUTHORIZATION_AUTH_SERVICE_UNAVAILABLE';let actor,authResponse;
   try{
    authResponse=await fetchBounded(authScope,()=>fetchImpl(authUrl,{method:'GET',headers:{Authorization:bearer,apikey:env.SUPABASE_ANON_KEY,Accept:'application/json','Accept-Encoding':'identity'},
     redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:authScope.signal}));
    responseShape(authResponse,authUrl);
    if([401,403].includes(authResponse.status))throw new AuthorizationRuntimeError(401,'AUTHORIZATION_UNAUTHENTICATED');
    need(authResponse.status===200,503,'AUTHORIZATION_AUTH_SERVICE_UNAVAILABLE');const user=await responseJson(authResponse,authScope,MAX_RESPONSE_BYTES);
    need(plain(user)&&uuid(user.id)&&user.is_anonymous!==true,401,'AUTHORIZATION_UNAUTHENTICATED');actor=user.id;
   }finally{cancel(authResponse?.body);authScope.close();authScope=null;}
   total.check();if(message.method==='POST')need(JSON_TYPE.test(message.headers.get('content-type')??''),415,'AUTHORIZATION_CONTENT_TYPE_UNSUPPORTED');
   bytes=await total.bounded(()=>readBounded(message,{limit:selected.limit,signal:total.signal,deadline:Math.min(total.deadline,Date.now()+10000)}));payload=parsePayload(bytes,selected);
   if(selected.action==='run')return reply({error:'AUTHORIZATION_OPERATIONAL_BINDING_UNAVAILABLE',recovery_required:false,command_id:payload.command_id},503);
   if(selected.action==='receiptQueryRun'){need(env.FISCAL_RECEIPT_QUERY_ENABLED===undefined||['false','true'].includes(env.FISCAL_RECEIPT_QUERY_ENABLED),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');if(env.FISCAL_RECEIPT_QUERY_ENABLED!=='true')return reply({error:'AUTHORIZATION_SERVICE_DISABLED',recovery_required:false,command_id:payload.command_id},503);}
   if(selected.action==='dispatchRun'){need(env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED===undefined||['false','true'].includes(env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');if(env.FISCAL_AUTHORIZATION_REVIEWED_ENABLED!=='true')return reply({error:'AUTHORIZATION_SERVICE_DISABLED',recovery_required:false,command_id:payload.command_id},503);}
   total.check();need(typeof env.A1_AUDIENCE==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(env.A1_AUDIENCE),503,'AUTHORIZATION_GATEWAY_UNAVAILABLE');
   secret=secretKey(env.A1_TRANSPORT_SECRET);const path=`/internal${url.pathname}`;
   const bodyHash=await total.bounded(()=>digest(bytes));
   const authorization=await total.bounded(()=>signRuntimeRequest({secretBytes:secret,keyId:env.A1_TRANSPORT_KEY_ID,audience:`${env.A1_AUDIENCE}-authorization`,actor,nonce:nonce(),method:message.method,path,bodyHash,now:now()}));
   const internalUrl=`https://fiscal-runtime.internal${path}`,internal=new Request(internalUrl,{method:message.method,headers:{Authorization:authorization,...(message.method==='POST'?{'Content-Type':'application/json'}:{})},
    ...(message.method==='POST'?{body:bytes}:{}),redirect:'manual',signal:total.signal});
   failure='AUTHORIZATION_UPSTREAM_UNAVAILABLE';total.check();runtimeSent=true;let result;
   try{
    result=await fetchBounded(total,()=>env.A1_RUNTIME.fetch(internal));responseShape(result,internalUrl);const value=await responseJson(result,total,selected.responseLimit??MAX_RESPONSE_BYTES);total.check();
    if(result.status!==200){
     need([400,401,403,404,405,408,409,413,415,422,500,502,503,504].includes(result.status)&&plain(value)&&ERROR_CODES.includes(value.error)&&typeof value.recovery_required==='boolean',502,'AUTHORIZATION_RESPONSE_INVALID');
     const commandId=selected.commandId??payload.command_id;
     need(exactError(value,commandId)&&(!value.recovery_required||isMutationAction(selected.action)),502,'AUTHORIZATION_RESPONSE_INVALID');
     return reply({error:value.error,recovery_required:value.recovery_required||runtimeSent&&selected.action==='recover',...(commandId?{command_id:commandId}:{})},result.status);
    }
    return reply(selected.receiptQuery?projectReceiptQueryResult(value,receiptQueryBinding(selected,payload)):selected.revalidation?projectRevalidationResult(value,revalidationBinding(selected,payload)):selected.dispatch?projectDispatchPublic(value,dispatchBinding(selected,payload)):selected.review?projectReviewPublic(value,reviewBinding(selected,payload)):publicResult(value,resultBinding(selected,payload)));
   }finally{cancel(result?.body);}
  }catch(error){
   const known=error instanceof AuthorizationRuntimeError&&ERROR_CODES.includes(error.code),recovery=runtimeSent&&isMutationAction(selected?.action);
   // Preserve the command after an uncertain review save or recovery; no submission is admitted.
   const status=known?recovery&&error.status<500?503:error.status:503;
   return reply({error:known?error.code:failure,recovery_required:recovery,...(payload?.command_id||selected?.commandId?{command_id:payload?.command_id??selected.commandId}:{})},status);
  }finally{authScope?.close();total?.close();bytes?.fill(0);secret?.fill(0);cancel(message?.body);}
 };
}
