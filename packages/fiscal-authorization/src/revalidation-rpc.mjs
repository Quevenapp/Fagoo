import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Three fixed079 RPCs; no default network or authorization-send operation. */
import {data,need,scope,cancel,AuthorizationServiceError} from './service-common.mjs';
import {readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {captureRevalidationRpc,projectRevalidationLedger,REVALIDATION_RPC_PREFIX,REVALIDATION_RPC_LIMITS} from './revalidation-dto.mjs';
const sqlFailures=new WeakSet();
/** Only a bounded, parsed error response from this fixed RPC port is definitive. */
export const isRevalidationSqlFailure=error=>error!==null&&typeof error==='object'&&sqlFailures.has(error);
export function createAuthorizationRevalidationRpc(configuration){
 const c=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);need(isConfiguredBackendOrigin(c.projectUrl,c.supabaseDeployment)&&typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&/^[!-~]+$/.test(c.serviceKey)&&typeof c.fetchImpl==='function','AUTHORIZATION_REVALIDATION_CONFIGURATION_INVALID');
 const {projectUrl,serviceKey,fetchImpl}=c;
 return async(action,raw,options={})=>{
  need(['context','finish','command'].includes(action),'AUTHORIZATION_REVALIDATION_RPC_INVALID');const args=captureRevalidationRpc(action,raw),body=JSON.stringify(args);need(Buffer.byteLength(body)<=REVALIDATION_RPC_LIMITS.request);const url=projectUrl+'/rest/v1/rpc/'+REVALIDATION_RPC_PREFIX+action,s=scope(options,30000);let response,bytes;
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity'},body,signal:s.signal,redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   s.check();need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&!(response.status>=300&&response.status<400),'AUTHORIZATION_REVALIDATION_RESPONSE_INVALID');
   bytes=await readBounded(response,response.status===200?REVALIDATION_RPC_LIMITS.response:8192,s);s.check();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationServiceError('AUTHORIZATION_REVALIDATION_RESPONSE_INVALID');}s.check();
   if(response.status!==200){const code=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'code')?.value:null,error=new AuthorizationServiceError(['22023','40001','42501','55000','P0002'].includes(code)?code:'AUTHORIZATION_REVALIDATION_UNAVAILABLE');if(['22023','40001','42501','55000','P0002'].includes(code))sqlFailures.add(error);throw error;}
   const out=projectRevalidationLedger(action,value,args);s.check();return out;
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_REVALIDATION_RESPONSE_INVALID');}
  finally{bytes?.fill(0);cancel(response?.body);s.close();}
 };
}
