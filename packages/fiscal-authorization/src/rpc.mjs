import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Private064 RPC transport. No default network, environment lookup, credential opening or SEFAZ access. */
import {AuthorizationServiceError,need,data as capture,id,sha,integer} from './service-common.mjs';
import {FAILURES,preparationEvidence,resultEvidence,projectResponse,SQLSTATES} from './service-dto.mjs';
export {AuthorizationServiceError} from './service-common.mjs';
const fields=(v,r,o=[])=>{try{capture(v,r,o);return true;}catch{return false;}};
const MAX_REQUEST=16384,MAX_ERROR=8192,MAX_METADATA=131072,MAX_MS=45000;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* No driver error crosses cleanup. */}};
const RPCS=Object.freeze({
 erp_fiscal_signed_get:{keys:['p_user_id','p_candidate_id'],valid:v=>id(v.p_candidate_id)},
 erp_fiscal_authorization_preview:{keys:['p_user_id','p_candidate_id','p_signed_hash'],valid:v=>id(v.p_candidate_id)&&sha(v.p_signed_hash)},
 erp_fiscal_authorization_begin:{keys:['p_user_id','p_command_id','p_candidate_id','p_signed_hash','p_expected_identity_version','p_expected_a1_version','p_expected_policy_version','p_confirmed'],valid:v=>id(v.p_command_id)&&id(v.p_candidate_id)&&sha(v.p_signed_hash)&&integer(v.p_expected_identity_version)&&integer(v.p_expected_a1_version)&&integer(v.p_expected_policy_version)&&v.p_confirmed===true},
 erp_fiscal_authorization_prepare:{keys:['p_user_id','p_attempt_id','p_lease_id','p_request_hash','p_request_size','p_evidence'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&sha(v.p_request_hash)&&integer(v.p_request_size,512000)},
 erp_fiscal_authorization_use:{keys:['p_user_id','p_attempt_id','p_lease_id'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)},
 erp_fiscal_authorization_finish:{keys:['p_user_id','p_attempt_id','p_lease_id','p_response_hash','p_response_size','p_evidence','p_processed_hash','p_processed_size'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&sha(v.p_response_hash)&&integer(v.p_response_size,512000)&&(v.p_processed_hash===null&&v.p_processed_size===null||sha(v.p_processed_hash)&&integer(v.p_processed_size,512000))},
 erp_fiscal_authorization_fail:{keys:['p_user_id','p_attempt_id','p_lease_id','p_error_code'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&FAILURES.includes(v.p_error_code)},
 erp_fiscal_authorization_command:{keys:['p_user_id','p_command_id'],valid:v=>id(v.p_command_id)},
 erp_fiscal_authorization_history:{keys:['p_user_id','p_candidate_id'],optional:['p_limit','p_before'],valid:v=>id(v.p_candidate_id)&&(!Object.hasOwn(v,'p_limit')||integer(v.p_limit,25))&&(!Object.hasOwn(v,'p_before')||v.p_before===null||typeof v.p_before==='string'&&/^[1-9][0-9]{0,14}$/.test(v.p_before))},
});

/** Actor identity comes from the trusted caller's verified session, never an unauthenticated browser. */
export function createAuthorizationRpc(configuration){
 configuration=capture(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment'],'AUTHORIZATION_RPC_CONFIG_INVALID');
 const{projectUrl,supabaseDeployment='hosted',serviceKey,fetchImpl}=configuration;
 need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment),'AUTHORIZATION_RPC_PROJECT_INVALID');
 need(typeof serviceKey==='string'&&serviceKey.length>=20&&serviceKey.length<=8192&&/^[!-~]+$/.test(serviceKey),'AUTHORIZATION_RPC_CREDENTIAL_INVALID');
 need(typeof fetchImpl==='function','AUTHORIZATION_RPC_DRIVER_REQUIRED');
 return async function rpc(name,args,options){
  need(typeof name==='string'&&Object.hasOwn(RPCS,name),'AUTHORIZATION_RPC_UNSUPPORTED');const definition=RPCS[name];
  args=capture(args,definition.keys,definition.optional??[],'AUTHORIZATION_RPC_ARGUMENTS_INVALID');
  options=capture(options,['deadline'],['signal'],'AUTHORIZATION_RPC_OPTIONS_INVALID');
  need(fields(args,definition.keys,definition.optional)&&id(args.p_user_id)&&definition.valid(args),'AUTHORIZATION_RPC_ARGUMENTS_INVALID');
  need(fields(options,['deadline'],['signal'])&&(options.signal===undefined||options.signal instanceof AbortSignal),'AUTHORIZATION_RPC_OPTIONS_INVALID');
  const start=Date.now(),deadline=options.deadline,signal=options.signal;
  need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+MAX_MS,'AUTHORIZATION_RPC_DEADLINE_INVALID');
  need(!signal?.aborted,'AUTHORIZATION_RPC_ABORTED');
  const data=Object.fromEntries([...definition.keys,...(definition.optional??[])].filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]]));
  if(name.endsWith('_finish'))data.p_evidence=resultEvidence(args.p_evidence,{response_hash:args.p_response_hash});
  if(name.endsWith('_prepare'))data.p_evidence=preparationEvidence(args.p_evidence,{request_hash:args.p_request_hash});
  if(name.endsWith('_history')){data.p_limit??=25;data.p_before??=null;}
  const body=Buffer.from(JSON.stringify(data),'utf8');
  if(body.length>MAX_REQUEST){body.fill(0);throw new AuthorizationServiceError('AUTHORIZATION_RPC_REQUEST_LIMIT');}
  const url=projectUrl+'/rest/v1/rpc/'+name,controller=new AbortController();let response,reader,timer,rejectStop,stopCode;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const stop=code=>{if(stopCode)return;stopCode=code;controller.abort();rejectStop(new AuthorizationServiceError(code));};
  const onAbort=()=>stop('AUTHORIZATION_RPC_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});
  const check=()=>{need(!signal?.aborted,'AUTHORIZATION_RPC_ABORTED');need(!controller.signal.aborted&&Date.now()<deadline,stopCode??'AUTHORIZATION_RPC_TIMEOUT');};
  const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  timer=setTimeout(()=>stop('AUTHORIZATION_RPC_TIMEOUT'),Math.max(1,deadline-Date.now()));
  async function readJson(limit){
   const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
   need(/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(response.headers.get('content-type')??''),'AUTHORIZATION_RPC_RESPONSE_INVALID');
   need((encoding===null||encoding==='identity')&&(length===null||/^[0-9]+$/.test(length)&&Number(length)<=limit),'AUTHORIZATION_RPC_BODY_INVALID');
   need(response.body,'AUTHORIZATION_RPC_RESPONSE_INVALID');reader=response.body.getReader();const chunks=[];let size=0,bytes;
   try{
    while(true){const part=await bounded(()=>reader.read());if(part.done)break;
     need(part.value instanceof Uint8Array&&(size+=part.value.length)<=limit,'AUTHORIZATION_RPC_BODY_LIMIT');chunks.push(Buffer.from(part.value));
    }
    need(size>0&&(length===null||Number(length)===size),'AUTHORIZATION_RPC_BODY_INVALID');check();bytes=Buffer.concat(chunks,size);let decoded;
    try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new AuthorizationServiceError('AUTHORIZATION_RPC_JSON_INVALID');}
    need(isObject(decoded),'AUTHORIZATION_RPC_RESPONSE_INVALID');check();return decoded;
   }finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);if(reader){cancelReader(reader);reader=undefined;}}
  }
  try{
   const pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',signal:controller.signal,
    cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,
     'Content-Type':'application/json','Content-Length':String(body.length),Accept:'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'},body});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(result=>cancel(result?.body)).catch(()=>{});throw error;}
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url),'AUTHORIZATION_RPC_RESPONSE_INVALID');
   need(response.status<300||response.status>=400,'AUTHORIZATION_RPC_REDIRECT_REJECTED');
   if(response.status!==200){const failure=await readJson(MAX_ERROR);throw new AuthorizationServiceError(typeof failure.code==='string'&&SQLSTATES.includes(failure.code)?failure.code:'AUTHORIZATION_RPC_HTTP_REJECTED');}
   const value=await readJson(MAX_METADATA);const result=projectResponse(name,value,data);check();return result;
  }catch(error){if(error instanceof AuthorizationServiceError)throw error;throw new AuthorizationServiceError('AUTHORIZATION_RPC_IO_FAILED');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();if(reader)cancelReader(reader);else cancel(response?.body);body.fill(0);}
 };
}
function cancelReader(reader){try{void reader.cancel().catch(()=>{});}catch{/* Cleanup only. */}try{reader.releaseLock();}catch{/* Pending driver callbacks cannot replace the sanitized error. */}}
