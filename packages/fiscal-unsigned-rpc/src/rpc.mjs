import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Internal 048 RPC transport. Explicit dependencies only; no environment or default network. */
const MAX_REQUEST=16384,MAX_ERROR=8192,MAX_BASIS=8388608,MAX_METADATA=131072,MAX_MS=45000;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const SQLSTATES=new Set(['42501','40001','22023','55000','P0002']);
const FAILURES=new Set(['CONTENT_INVALID','CONTENT_INCOMPLETE','PROFILE_UNSUPPORTED','ARITHMETIC_MISMATCH','XML_SIZE_LIMIT']);
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const fields=(v,required,optional=[])=>isObject(v)&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&[...required,...optional].includes(k)
 &&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'))&&required.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),sha=v=>typeof v==='string'&&SHA.test(v),integer=(v,max=2147483647)=>Number.isInteger(v)&&v>=1&&v<=max;
const issuedAt=value=>{
 if(typeof value!=='string'||!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}-03:00$/.test(value))return false;
 const milliseconds=Date.parse(value);return Number.isFinite(milliseconds)&&new Date(milliseconds-10800000).toISOString().slice(0,19)+'-03:00'===value;
};
const seed=v=>fields(v,['cNF','issuedAt'])&&typeof v.cNF==='string'&&/^[0-9]{8}$/.test(v.cNF)&&issuedAt(v.issuedAt);
export class FiscalUnsignedRpcError extends Error{
 constructor(code){super(code);this.name='FiscalUnsignedRpcError';this.code=code;}
}
const need=(value,code)=>{if(!value)throw new FiscalUnsignedRpcError(code);};
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{/* No driver error crosses cleanup. */}};
const RPCS=Object.freeze({
 erp_fiscal_unsigned_basis:{keys:['p_user_id','p_draft_id','p_completion_version'],large:true,valid:v=>id(v.p_draft_id)&&integer(v.p_completion_version)},
 erp_fiscal_unsigned_begin:{keys:['p_user_id','p_command_id','p_reservation_id','p_completion_version','p_completion_hash','p_basis_hash','p_builder_version','p_seed'],large:true,
  valid:v=>id(v.p_command_id)&&id(v.p_reservation_id)&&integer(v.p_completion_version)&&sha(v.p_completion_hash)&&sha(v.p_basis_hash)&&v.p_builder_version==='brufap-business-builder-v1'&&seed(v.p_seed)},
 erp_fiscal_unsigned_finish:{keys:['p_user_id','p_job_id','p_lease_id','p_xml_hash','p_size_bytes','p_access_key'],
  valid:v=>id(v.p_job_id)&&id(v.p_lease_id)&&sha(v.p_xml_hash)&&integer(v.p_size_bytes,480000)&&typeof v.p_access_key==='string'&&/^[0-9]{6}[A-Z0-9]{12}[0-9]{26}$/.test(v.p_access_key)},
 erp_fiscal_unsigned_fail:{keys:['p_user_id','p_job_id','p_lease_id','p_error_code'],valid:v=>id(v.p_job_id)&&id(v.p_lease_id)&&FAILURES.has(v.p_error_code)},
 erp_fiscal_unsigned_get:{keys:['p_user_id','p_job_id'],valid:v=>id(v.p_job_id)},
 erp_fiscal_unsigned_command:{keys:['p_user_id','p_command_id'],valid:v=>id(v.p_command_id)},
 erp_fiscal_unsigned_history:{keys:['p_user_id','p_reservation_id'],optional:['p_limit','p_before'],valid:v=>id(v.p_reservation_id)
  &&(!Object.hasOwn(v,'p_limit')||integer(v.p_limit,25))&&(!Object.hasOwn(v,'p_before')||v.p_before===null||integer(v.p_before))},
});

/** Actor identity comes from the trusted caller's verified session, never an unauthenticated browser. */
export function createFiscalUnsignedRpc(configuration){
 need(fields(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']),'FISCAL_UNSIGNED_RPC_CONFIG_INVALID');
 const{projectUrl,supabaseDeployment='hosted',serviceKey,fetchImpl}=configuration;
 need(isConfiguredBackendOrigin(projectUrl,supabaseDeployment),'FISCAL_UNSIGNED_RPC_PROJECT_INVALID');
 need(typeof serviceKey==='string'&&serviceKey.length>=20&&serviceKey.length<=8192&&/^[!-~]+$/.test(serviceKey),'FISCAL_UNSIGNED_RPC_CREDENTIAL_INVALID');
 need(typeof fetchImpl==='function','FISCAL_UNSIGNED_RPC_DRIVER_REQUIRED');
 return async function rpc(name,args,options){
  need(typeof name==='string'&&Object.hasOwn(RPCS,name),'FISCAL_UNSIGNED_RPC_UNSUPPORTED');const definition=RPCS[name];
  need(fields(args,definition.keys,definition.optional)&&id(args.p_user_id)&&definition.valid(args),'FISCAL_UNSIGNED_RPC_ARGUMENTS_INVALID');
  need(fields(options,['deadline'],['signal'])&&(options.signal===undefined||options.signal instanceof AbortSignal),'FISCAL_UNSIGNED_RPC_OPTIONS_INVALID');
  const start=Date.now(),deadline=options.deadline,signal=options.signal;
  need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+MAX_MS,'FISCAL_UNSIGNED_RPC_DEADLINE_INVALID');
  need(!signal?.aborted,'FISCAL_UNSIGNED_RPC_ABORTED');
  const data=Object.fromEntries([...definition.keys,...(definition.optional??[])].filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]]));
  if(name==='erp_fiscal_unsigned_begin')data.p_seed={cNF:args.p_seed.cNF,issuedAt:args.p_seed.issuedAt};
  if(name==='erp_fiscal_unsigned_history'){data.p_limit??=25;data.p_before??=null;}
  const body=Buffer.from(JSON.stringify(data),'utf8');
  if(body.length>MAX_REQUEST){body.fill(0);throw new FiscalUnsignedRpcError('FISCAL_UNSIGNED_RPC_REQUEST_LIMIT');}
  const url=projectUrl+'/rest/v1/rpc/'+name,controller=new AbortController();let response,reader,timer,rejectStop,stopCode;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const stop=code=>{if(stopCode)return;stopCode=code;controller.abort();rejectStop(new FiscalUnsignedRpcError(code));};
  const onAbort=()=>stop('FISCAL_UNSIGNED_RPC_ABORTED');signal?.addEventListener('abort',onAbort,{once:true});
  const check=()=>{need(!signal?.aborted,'FISCAL_UNSIGNED_RPC_ABORTED');need(!controller.signal.aborted&&Date.now()<deadline,stopCode??'FISCAL_UNSIGNED_RPC_TIMEOUT');};
  const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  timer=setTimeout(()=>stop('FISCAL_UNSIGNED_RPC_TIMEOUT'),Math.max(1,deadline-Date.now()));
  async function readJson(limit){
   const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
   need(/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(response.headers.get('content-type')??''),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
   need((encoding===null||encoding==='identity')&&(length===null||/^[0-9]+$/.test(length)&&Number(length)<=limit),'FISCAL_UNSIGNED_RPC_BODY_INVALID');
   need(response.body,'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');reader=response.body.getReader();const chunks=[];let size=0,bytes;
   try{
    while(true){const part=await bounded(()=>reader.read());if(part.done)break;
     need(part.value instanceof Uint8Array&&(size+=part.value.length)<=limit,'FISCAL_UNSIGNED_RPC_BODY_LIMIT');chunks.push(Buffer.from(part.value));
    }
    need(size>0&&(length===null||Number(length)===size),'FISCAL_UNSIGNED_RPC_BODY_INVALID');check();bytes=Buffer.concat(chunks,size);let decoded;
    try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new FiscalUnsignedRpcError('FISCAL_UNSIGNED_RPC_JSON_INVALID');}
    need(isObject(decoded),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');check();return decoded;
   }finally{bytes?.fill(0);for(const chunk of chunks)chunk.fill(0);if(reader){cancelReader(reader);reader=undefined;}}
  }
  try{
   const pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',signal:controller.signal,
    cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,
     'Content-Type':'application/json','Content-Length':String(body.length),Accept:'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'},body});});
   try{response=await bounded(()=>pending);}catch(error){void pending.then(result=>cancel(result?.body)).catch(()=>{});throw error;}
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url),'FISCAL_UNSIGNED_RPC_RESPONSE_INVALID');
   need(response.status<300||response.status>=400,'FISCAL_UNSIGNED_RPC_REDIRECT_REJECTED');
   if(response.status!==200){const failure=await readJson(MAX_ERROR);throw new FiscalUnsignedRpcError(typeof failure.code==='string'&&SQLSTATES.has(failure.code)?failure.code:'FISCAL_UNSIGNED_RPC_HTTP_REJECTED');}
   return await readJson(definition.large?MAX_BASIS:MAX_METADATA);
  }catch(error){if(error instanceof FiscalUnsignedRpcError)throw error;throw new FiscalUnsignedRpcError('FISCAL_UNSIGNED_RPC_IO_FAILED');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);controller.abort();if(reader)cancelReader(reader);else cancel(response?.body);body.fill(0);}
 };
}
function cancelReader(reader){try{void reader.cancel().catch(()=>{});}catch{/* Cleanup only. */}try{reader.releaseLock();}catch{/* Pending driver callbacks cannot replace the sanitized error. */}}
