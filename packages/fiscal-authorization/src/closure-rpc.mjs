import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Fixed074 RPCs only. No Storage, credential access or default network. */
import {data,need,id,scope,cancel,AuthorizationServiceError} from './service-common.mjs';
import {readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {captureClosureInput,projectClosureLedger,MAX_CLOSURE_REQUEST_BYTES,MAX_CLOSURE_RESPONSE_BYTES} from './closure-dto.mjs';
export const CLOSURE_RPC='erp_fiscal_reviewed_authorization_close_expired',CLOSURE_COMMAND_RPC='erp_fiscal_reviewed_authorization_closure_command';
export function createAuthorizationClosureRpc(configuration){
 const c=data(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);need(isConfiguredBackendOrigin(c.projectUrl,c.supabaseDeployment)&&typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&/^[!-~]+$/.test(c.serviceKey)&&typeof c.fetchImpl==='function','AUTHORIZATION_CLOSURE_RPC_CONFIGURATION_INVALID');
 const {projectUrl,serviceKey,fetchImpl}=c;
 return async(name,args,options={})=>{
  need([CLOSURE_RPC,CLOSURE_COMMAND_RPC].includes(name),'AUTHORIZATION_CLOSURE_RPC_UNSUPPORTED');const writing=name===CLOSURE_RPC;
  const x=data(args,writing?['p_user_id','p_command_id','p_authorization_command_id','p_expected_attempt_id','p_expected_state','p_expected_request_hash','p_confirmed']:['p_user_id','p_command_id']);need(id(x.p_user_id)&&id(x.p_command_id));
  const input=writing?captureClosureInput({command_id:x.p_command_id,authorization_command_id:x.p_authorization_command_id,expected_attempt_id:x.p_expected_attempt_id,expected_state:x.p_expected_state,confirmed:x.p_confirmed}):null;
  if(writing)need(x.p_expected_state==='prepared'?x.p_expected_request_hash===null:typeof x.p_expected_request_hash==='string'&&/^[a-f0-9]{64}$/.test(x.p_expected_request_hash));
  const binding={action:writing?'closeExpired':'closureCommand',commandId:x.p_command_id,...(input?{input}:{})},body=JSON.stringify(x);need(Buffer.byteLength(body)<=MAX_CLOSURE_REQUEST_BYTES);
  const s=scope(options,10000),url=projectUrl+'/rest/v1/rpc/'+name;let response,bytes;
  try{
   const pending=Promise.resolve().then(()=>{s.check();return fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity'},body,signal:s.signal,redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});});
   try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   s.check();need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url)&&/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&!(response.status>=300&&response.status<400),'AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');
   bytes=await readBounded(response,response.status===200?MAX_CLOSURE_RESPONSE_BYTES:8192,s);s.check();let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationServiceError('AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');}s.check();
   if(response.status!==200){const code=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'code')?.value:null;throw new AuthorizationServiceError(['22023','40001','42501','55000','P0002'].includes(code)?code:'AUTHORIZATION_CLOSURE_RPC_UNAVAILABLE');}
   const out=projectClosureLedger(value,binding);if(writing)need(out.receipt.request_hash===x.p_expected_request_hash,'AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');s.check();return out;
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;throw new AuthorizationServiceError('AUTHORIZATION_CLOSURE_RPC_RESPONSE_INVALID');}
  finally{bytes?.fill(0);cancel(response?.body);s.close();}
 };
}
