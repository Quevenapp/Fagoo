import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Service-only current membership read for status; Auth profile metadata is never RBAC. */
import {data,need,uuid,freeze,AuthorizationHttpError,readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {requestScope} from './protocol.mjs';
export function createDispatchAccessReader(configuration){
 const p=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);let base;try{base=new URL(p.projectUrl);}catch{}
 need(base&&isConfiguredBackendOrigin(p.projectUrl,p.supabaseDeployment,{allowTrailingSlash:true})&&typeof p.serviceKey==='string'&&p.serviceKey.length>=20&&p.serviceKey.length<=4096&&/^[!-~]+$/.test(p.serviceKey)&&typeof p.fetchImpl==='function',503,'AUTHORIZATION_RUNTIME_CONFIGURATION_INVALID');
 const url=base.origin+'/rest/v1/rpc/erp_access_me',key=p.serviceKey,fetchImpl=p.fetchImpl;
 return async(actor,options)=>{
  need(uuid(actor));const o=data(options,['signal','deadline']);need(o.signal instanceof AbortSignal&&Number.isSafeInteger(o.deadline));const s=requestScope(o.signal,Math.min(o.deadline,Date.now()+10000));let response,bytes;
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+key,apikey:key,'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity'},body:JSON.stringify({p_user_id:actor}),redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:s.signal});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>v?.body?.cancel()).catch(()=>{});throw e;}s.check();
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??''),503,'AUTHORIZATION_SERVICE_UNAVAILABLE');
   bytes=await readBounded(response,8192,s);s.check();let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationHttpError(503,'AUTHORIZATION_SERVICE_UNAVAILABLE');}
   if(response.status!==200){const code=raw&&typeof raw==='object'?Object.getOwnPropertyDescriptor(raw,'code')?.value:null;need(code!=='42501'&&![401,403].includes(response.status),403,'AUTHORIZATION_FORBIDDEN');throw new AuthorizationHttpError(503,'AUTHORIZATION_SERVICE_UNAVAILABLE');}
   const v=data(raw,['user_id','role','resources','data_mode'],[],503,'AUTHORIZATION_SERVICE_UNAVAILABLE');need(v.user_id===actor&&v.data_mode==='staging_readonly'&&Array.isArray(v.resources)&&v.resources.length<=10&&v.resources.every(x=>typeof x==='string'),503,'AUTHORIZATION_SERVICE_UNAVAILABLE');need(['admin','fiscal'].includes(v.role),403,'AUTHORIZATION_FORBIDDEN');s.check();return freeze({actor,role:v.role});
  }finally{bytes?.fill(0);s.close();try{void response?.body?.cancel().catch(()=>{});}catch{}}
 };
}
