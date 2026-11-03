import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Fixed read-only072 RPC. Current authenticated actor is provided by the runtime. */
import {data,need,id,scope,cancel,AuthorizationServiceError} from './service-common.mjs';
import {readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {capturePreflightInput,projectPreflightSnapshot,PREFLIGHT_MAX_BYTES} from './preflight-dto.mjs';
export const PREFLIGHT_RPC='erp_fiscal_reviewed_authorization_preflight';
export function createAuthorizationPreflightRpc(configuration){
 const c=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);need(isConfiguredBackendOrigin(c.projectUrl,c.supabaseDeployment)&&typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&/^[!-~]+$/.test(c.serviceKey)&&typeof c.fetchImpl==='function','AUTHORIZATION_PREFLIGHT_RPC_CONFIGURATION_INVALID');
 const {projectUrl,serviceKey,fetchImpl}=c,url=projectUrl+'/rest/v1/rpc/'+PREFLIGHT_RPC;
 return async(input,options={})=>{
  const x=data(input,['actor','candidateId','signedHash']);need(id(x.actor));const q=capturePreflightInput({candidate_id:x.candidateId,signed_hash:x.signedHash}),s=scope(options,10000);let response,bytes;
  const body=JSON.stringify({p_user_id:x.actor,p_candidate_id:q.candidate_id,p_signed_hash:q.signed_hash});
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity'},body,signal:s.signal,redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   s.check();need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&!(response.status>=300&&response.status<400),'AUTHORIZATION_PREFLIGHT_RPC_RESPONSE_INVALID');
   bytes=await readBounded(response,response.status===200?PREFLIGHT_MAX_BYTES:8192,s);s.check();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationServiceError('AUTHORIZATION_PREFLIGHT_RPC_RESPONSE_INVALID');}s.check();
   if(response.status!==200){const code=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'code')?.value:null;throw new AuthorizationServiceError(['22023','40001','42501','55000','P0002'].includes(code)?code:'AUTHORIZATION_PREFLIGHT_RPC_UNAVAILABLE');}
   const out=projectPreflightSnapshot(value,q);s.check();return out;
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_PREFLIGHT_RPC_RESPONSE_INVALID');}
  finally{bytes?.fill(0);cancel(response?.body);s.close();}
 };
}
