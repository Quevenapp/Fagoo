import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** One fixed read-only075 RPC. No closure/write fallback or default network. */
import {data,need,id,scope,cancel,AuthorizationServiceError} from './service-common.mjs';
import {readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {captureClosureLookupInput,projectClosureLookupLedger,MAX_CLOSURE_LOOKUP_REQUEST_BYTES,MAX_CLOSURE_LOOKUP_RESPONSE_BYTES} from './closure-lookup-dto.mjs';
export const CLOSURE_LOOKUP_RPC='erp_fiscal_reviewed_authorization_closure_lookup';
export function createAuthorizationClosureLookupRpc(configuration){
 const c=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);need(isConfiguredBackendOrigin(c.projectUrl,c.supabaseDeployment)&&typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&/^[!-~]+$/.test(c.serviceKey)&&typeof c.fetchImpl==='function','AUTHORIZATION_CLOSURE_LOOKUP_CONFIGURATION_INVALID');
 const {projectUrl,serviceKey,fetchImpl}=c,url=projectUrl+'/rest/v1/rpc/'+CLOSURE_LOOKUP_RPC;
 return async(args,options={})=>{
  const x=data(args,['p_user_id','p_authorization_command_id','p_expected_attempt_id']);need(id(x.p_user_id));const input=captureClosureLookupInput({authorization_command_id:x.p_authorization_command_id,expected_attempt_id:x.p_expected_attempt_id}),body=JSON.stringify(x);need(Buffer.byteLength(body)<=MAX_CLOSURE_LOOKUP_REQUEST_BYTES);
  const s=scope(options,10000);let response,bytes;
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity'},body,signal:s.signal,redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   s.check();need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&!(response.status>=300&&response.status<400),'AUTHORIZATION_CLOSURE_LOOKUP_RESPONSE_INVALID');
   bytes=await readBounded(response,response.status===200?MAX_CLOSURE_LOOKUP_RESPONSE_BYTES:8192,s);s.check();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationServiceError('AUTHORIZATION_CLOSURE_LOOKUP_RESPONSE_INVALID');}s.check();
   if(response.status!==200){const code=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'code')?.value:null;throw new AuthorizationServiceError(['22023','40001','42501','55000','P0002'].includes(code)?code:'AUTHORIZATION_CLOSURE_LOOKUP_UNAVAILABLE');}
   const out=projectClosureLookupLedger(value,input);s.check();return out;
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_CLOSURE_LOOKUP_RESPONSE_INVALID');}
  finally{bytes?.fill(0);cancel(response?.body);s.close();}
 };
}
