import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Private061 RPC transport. No default network, environment lookup, credential opening or SEFAZ access. */
import {ReconciliationError,need,fields,id,sha,integer,FAILURES,evidence,projectResponse,SQLSTATES} from './dto.mjs';
export {ReconciliationError} from './dto.mjs';
const MAX_REQUEST=16384,MAX_ERROR=8192,MAX_METADATA=131072,MAX_MS=45000;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* No driver error crosses cleanup. */}};
const DEFINITIONS={
 erp_fiscal_reconciliation_begin:{keys:['p_user_id','p_command_id','p_candidate_id','p_signed_hash','p_expected_identity_version','p_expected_a1_version','p_confirmed'],valid:v=>id(v.p_command_id)&&id(v.p_candidate_id)&&sha(v.p_signed_hash)&&integer(v.p_expected_identity_version)&&integer(v.p_expected_a1_version)&&v.p_confirmed===true},
 erp_fiscal_reconciliation_use:{keys:['p_user_id','p_attempt_id','p_lease_id','p_request_hash','p_request_size'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&sha(v.p_request_hash)&&integer(v.p_request_size,512000)},
 erp_fiscal_reconciliation_finish:{keys:['p_user_id','p_attempt_id','p_lease_id','p_response_hash','p_response_size','p_evidence'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&sha(v.p_response_hash)&&integer(v.p_response_size,512000)},
 erp_fiscal_reconciliation_fail:{keys:['p_user_id','p_attempt_id','p_lease_id','p_error_code'],valid:v=>id(v.p_attempt_id)&&id(v.p_lease_id)&&FAILURES.includes(v.p_error_code)},
 erp_fiscal_reconciliation_command:{keys:['p_user_id','p_command_id'],valid:v=>id(v.p_command_id)},
 erp_fiscal_reconciliation_history:{keys:['p_user_id','p_candidate_id'],optional:['p_limit','p_before'],valid:v=>id(v.p_candidate_id)&&(!Object.hasOwn(v,'p_limit')||integer(v.p_limit,25))&&(!Object.hasOwn(v,'p_before')||v.p_before===null||typeof v.p_before==='string'&&/^[1-9][0-9]{0,18}$/.test(v.p_before)&&BigInt(v.p_before)<=9223372036854775807n)},
};
const RPCS=Object.freeze({...DEFINITIONS,...Object.fromEntries(Object.entries(DEFINITIONS).map(([name,value])=>[name.replace('erp_fiscal_reconciliation_','erp_fiscal_protocol_'),value]))});

/** Actor identity comes from the trusted caller's verified session, never an unauthenticated browser. */
export function createReconciliationRpc(configuration){
 need(fields(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']),'RECONCILIATION_RPC_CONFIG_INVALID');
 const{projectUrl,supabaseDeployment='hosted',serviceKey,fetchImpl}=configuration;
 need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment),'RECONCILIATION_RPC_PROJECT_INVALID');
 need(typeof serviceKey==='string'&&serviceKey.length>=20&&serviceKey.length<=8192&&/^[!-~]+$/.test(serviceKey),'RECONCILIATION_RPC_CREDENTIAL_INVALID');
 need(typeof fetchImpl==='function','RECONCILIATION_RPC_DRIVER_REQUIRED');
 return async function rpc(name,args,options){
  need(typeof name==='string'&&Object.hasOwn(RPCS,name),'RECONCILIATION_RPC_UNSUPPORTED');const definition=RPCS[name];
  need(fields(args,definition.keys,definition.optional)&&id(args.p_user_id)&&definition.valid(args),'RECONCILIATION_RPC_ARGUMENTS_INVALID');
  need(fields(options,['deadline'],['signal'])&&(options.signal===undefined||options.signal instanceof AbortSignal),'RECONCILIATION_RPC_OPTIONS_INVALID');
  const start=Date.now(),deadline=options.deadline,signal=options.signal;
  need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+MAX_MS,'RECONCILIATION_RPC_DEADLINE_INVALID');
  need(!signal?.aborted,'RECONCILIATION_RPC_ABORTED');
  const data=Object.fromEntries([...definition.keys,...(definition.optional??[])].filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]]));
  if(name.endsWith('_finish'))data.p_evidence=evidence(args.p_evidence,{response_hash:args.p_response_hash});
  if(name.endsWith('_history')){data.p_limit??=25;data.p_before??=null;}
  const body=Buffer.from(JSON.stringify(data),'utf8');
  if(body.length>MAX_REQUEST){body.fill(0);throw new ReconciliationError('RECONCILIATION_RPC_REQUEST_LIMIT');}
  const url=projectUrl+'/rest/v1/rpc/'+name,controller=new AbortController();let response,reader,timer,rejectStop,stopCode;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const stop=code=>{if(stopCode)return;stopCode=code;controller.abort();rejectStop(new ReconciliationError(code));};
  const onAbort=()=>stop('RECONCILIATION_RPC_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});
  const check=()=>{need(!signal?.aborted,'RECONCILIATION_RPC_ABORTED');need(!controller.signal.aborted&&Date.now()<deadline,stopCode??'RECONCILIATION_RPC_TIMEOUT');};
  const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  timer=setTimeout(()=>stop('RECONCILIATION_RPC_TIMEOUT'),Math.max(1,deadline-Date.now()));
  async function readJson(limit){
   const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
   need(/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(response.headers.get('content-type')??''),'RECONCILIATION_RPC_RESPONSE_INVALID');
   need((encoding===null||encoding==='identity')&&(length===null||/^[0-9]+$/.test(length)&&Number(length)<=limit),'RECONCILIATION_RPC_BODY_INVALID');
   need(response.body,'RECONCILIATION_RPC_RESPONSE_INVALID');reader=response.body.getReader();const chunks=[];let size=0,bytes;
   try{
    while(true){const part=await bounded(()=>reader.read());if(part.done)break;
     need(part.value instanceof Uint8Array&&(size+=part.value.length)<=limit,'RECONCILIATION_RPC_BODY_LIMIT');chunks.push(Buffer.from(part.value));
    }
    need(size>0&&(length===null||Number(length)===size),'RECONCILIATION_RPC_BODY_INVALID');check();bytes=Buffer.concat(chunks,size);let decoded;
    try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ReconciliationError('RECONCILIATION_RPC_JSON_INVALID');}
    need(isObject(decoded),'RECONCILIATION_RPC_RESPONSE_INVALID');check();return decoded;
   }finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);if(reader){cancelReader(reader);reader=undefined;}}
  }
  try{
   const pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',signal:controller.signal,
    cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,
     'Content-Type':'application/json','Content-Length':String(body.length),Accept:'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'},body});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(result=>cancel(result?.body)).catch(()=>{});throw error;}
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url),'RECONCILIATION_RPC_RESPONSE_INVALID');
   need(response.status<300||response.status>=400,'RECONCILIATION_RPC_REDIRECT_REJECTED');
   if(response.status!==200){const failure=await readJson(MAX_ERROR);throw new ReconciliationError(typeof failure.code==='string'&&SQLSTATES.includes(failure.code)?failure.code:'RECONCILIATION_RPC_HTTP_REJECTED');}
   const value=await readJson(MAX_METADATA);const result=projectResponse(name,value,data);check();return result;
  }catch(error){if(error instanceof ReconciliationError)throw error;throw new ReconciliationError('RECONCILIATION_RPC_IO_FAILED');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();if(reader)cancelReader(reader);else cancel(response?.body);body.fill(0);}
 };
}
function cancelReader(reader){try{void reader.cancel().catch(()=>{});}catch{/* Cleanup only. */}try{reader.releaseLock();}catch{/* Pending driver callbacks cannot replace the sanitized error. */}}
