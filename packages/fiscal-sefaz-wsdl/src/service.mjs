/** Local/private051 orchestration. All effects are mandatory injected ports; no default network, cofre or credentials. */
import {createHash} from 'node:crypto';
import {SERVICE_FAILURE_CODES} from './service-errors.mjs';
export {SERVICE_FAILURE_CODES} from './service-errors.mjs';
import {SecureContext} from 'node:tls';
import {createWsdlEvidenceClient} from './fetch-wsdl.mjs';
import {inspectWsdl} from './inspect-wsdl.mjs';
import {prepareWsdlRequest,WsdlEvidenceError} from './profile.mjs';
import {WsdlServiceError,need,fields,id,integer,stamp,FLAGS,SQLSTATES,projectResponse,publicView,evidence,same,freeze} from './service-dto.mjs';
export {WsdlServiceError} from './service-dto.mjs';
const BUCKET='brufap-fiscal-artifacts',MAX=512000,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function copy(v,depth=0){try{
 need(depth<=8,'WSDL_SERVICE_INPUT_INVALID');if(v===null||typeof v==='boolean'||typeof v==='number')return v;if(typeof v==='string'){need(v.length<=16384,'WSDL_SERVICE_INPUT_INVALID');return v;}
 need(v&&typeof v==='object','WSDL_SERVICE_INPUT_INVALID');const a=Array.isArray(v),ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);
 need(a?Object.getPrototypeOf(v)===Array.prototype&&v.length<=32&&keys.length===v.length+1:[Object.prototype,null].includes(Object.getPrototypeOf(v))&&keys.length<=64,'WSDL_SERVICE_INPUT_INVALID');
 need(keys.every(k=>typeof k==='string'&&Object.hasOwn(ds[k],'value')),'WSDL_SERVICE_INPUT_INVALID');
 return freeze(a?Array.from({length:v.length},(_,i)=>copy(ds[i]?.value,depth+1)):Object.fromEntries(keys.map(k=>[k,copy(ds[k].value,depth+1)])));
}catch(error){throw error instanceof WsdlServiceError?error:new WsdlServiceError('WSDL_SERVICE_INPUT_INVALID');}}
function scope(options={}){
 need(fields(options,[],['signal','deadline']),'WSDL_SERVICE_OPTIONS_INVALID');const signal=options.signal,start=Date.now(),deadline=options.deadline??start+45000;
 need(signal===undefined||signal instanceof AbortSignal,'WSDL_SERVICE_OPTIONS_INVALID');need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+45000,'WSDL_SERVICE_DEADLINE_INVALID');need(!signal?.aborted,'WSDL_SERVICE_ABORTED');
 const controller=new AbortController();let code='WSDL_SERVICE_ABORTED',rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
 const stop=()=>{controller.abort();rejectStop(new WsdlServiceError(code));};const abort=()=>{code='WSDL_SERVICE_ABORTED';stop();};const timer=setTimeout(()=>{code='WSDL_SERVICE_TIMEOUT';stop();},deadline-start);signal?.addEventListener('abort',abort,{once:true});
 const check=()=>{need(!controller.signal.aborted,code);need(Date.now()<deadline,'WSDL_SERVICE_TIMEOUT');};
 return{signal:controller.signal,deadline,check,bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);},close(){clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}};
}
const rpcArgs=input=>({p_user_id:input.actor,p_command_id:input.commandId,p_model:input.model,p_operation:input.operation,p_expected_a1_version:input.expectedA1Version,p_expected_identity_version:input.expectedIdentityVersion,p_confirmed:input.confirmed});
function bind(v,input,receipt){need(v.command_id===input.commandId,'WSDL_SERVICE_COMMAND_MISMATCH');if(receipt)need(same(v.receipt,receipt),'WSDL_SERVICE_RECEIPT_MISMATCH');for(const[k,x]of Object.entries({model:input.model,operation:input.operation,a1_version:input.expectedA1Version,identity_version:input.expectedIdentityVersion}))if(x!==undefined)need(v.receipt[k]===x,'WSDL_SERVICE_RECEIPT_MISMATCH');return v;}
function ready(v){need(v.current.state==='prepared'&&!v.current.a1_changed&&!v.current.company_changed&&v.current.certificate_time_valid_now&&!v.current.grant_consumed&&!v.current.lease_expired&&v.execution,'WSDL_SERVICE_PREPARATION_STALE');need(Date.parse(v.current.expires_at)>Date.now()+1000,'WSDL_SERVICE_LEASE_EXPIRED');}
function safeFailure(error){if(SQLSTATES.includes(error?.code))return'WSDL_SERVICE_RPC_'+error.code;if(error instanceof WsdlEvidenceError)return'WSDL_SERVICE_GET_FAILED';if(error instanceof WsdlServiceError&&SERVICE_FAILURE_CODES.includes(error.code))return error.code;return'WSDL_SERVICE_PORT_FAILED';}
function result(v,extra={}){return freeze({...publicView(v),status:v.current.state,recovery_required:v.current.recovery_required,read_only:extra.read_only??false,recovered:extra.recovered??false,failure_code:null});}
function inspectContext(context,execution,actor){
 need(fields(context,['purpose','environment','model','operation','request_id','method','endpoint','deadline']),'WSDL_SERVICE_CONTEXT_INVALID');const g=execution.scope;
 need(g.actor===actor&&context.purpose===g.purpose&&context.environment===g.environment&&context.model===g.model&&context.operation===g.operation&&context.request_id===g.attempt_id&&context.method===g.method&&context.endpoint===g.endpoint&&Number.isSafeInteger(context.deadline)&&context.deadline<=Date.parse(g.expires_at),'WSDL_SERVICE_CONTEXT_INVALID');
}

/** Revalidate the already-captured preparation before opening custody; this never consumes use051. */
export function createWsdlPreparationAuthorizer(config){
 need(fields(config,['rpc'])&&typeof config.rpc==='function','WSDL_SERVICE_PORTS_REQUIRED');const rpc=config.rpc;
 return async(input,options)=>{
  need(fields(input,['actor','execution','context'])&&id(input.actor),'WSDL_SERVICE_INPUT_INVALID');
  const expected=copy(input.execution),context=copy(input.context),actor=input.actor;inspectContext(context,expected,actor);const s=scope(options);
  try{
   need(s.deadline<=context.deadline&&s.deadline<=Date.now()+30000,'WSDL_SERVICE_CONTEXT_INVALID');const g=expected.scope;
   const args={p_user_id:actor,p_command_id:g.command_id,p_model:g.model,p_operation:g.operation,p_expected_a1_version:g.a1_version,p_expected_identity_version:g.identity_version,p_confirmed:true};
   const response=projectResponse('erp_fiscal_wsdl_begin',await s.bounded(()=>rpc('erp_fiscal_wsdl_begin',args,{signal:s.signal,deadline:s.deadline})),args);
   ready(response);need(response.replayed===true&&same(response.execution,expected),'WSDL_SERVICE_PREPARATION_STALE');s.check();return response.execution;
  }finally{s.close();}
 };
}

export function createWsdlService(config){
 need(fields(config,['rpc','storage','requestImpl','withPreparedTlsSession'])&&typeof config.rpc==='function'&&fields(config.storage,['read','putImmutable'])&&typeof config.storage.read==='function'&&typeof config.storage.putImmutable==='function'&&typeof config.requestImpl==='function'&&typeof config.withPreparedTlsSession==='function','WSDL_SERVICE_PORTS_REQUIRED');
 const rpc=config.rpc,readPort=config.storage.read.bind(config.storage),putPort=config.storage.putImmutable.bind(config.storage),requestImpl=config.requestImpl,withPrepared=config.withPreparedTlsSession,running=new Set();
 async function command(input,options){
  need(fields(input,['actor','commandId'])&&id(input.actor)&&id(input.commandId),'WSDL_SERVICE_INPUT_INVALID');const actor=input.actor,commandId=input.commandId,s=scope(options);
  try{const args={p_user_id:actor,p_command_id:commandId};const value=projectResponse('erp_fiscal_wsdl_command',await s.bounded(()=>rpc('erp_fiscal_wsdl_command',args,{signal:s.signal,deadline:s.deadline})),args);s.check();return result(value,{read_only:true});}finally{s.close();}
 }
 async function run(input,options){
  need(fields(input,['actor','commandId','model','operation','expectedA1Version','expectedIdentityVersion','confirmed'])&&id(input.actor)&&id(input.commandId)&&['55','65'].includes(input.model)&&['protocol','status','authorization','receipt'].includes(input.operation)&&integer(input.expectedA1Version)&&integer(input.expectedIdentityVersion)&&input.confirmed===true,'WSDL_SERVICE_INPUT_INVALID');
  const job=copy(input);need(!running.has(job.commandId),'WSDL_SERVICE_ALREADY_RUNNING');const s=scope(options);running.add(job.commandId);
  let known=null,claimed=null,bytes=null,expected=null,phase='command',beginSent=false,useSent=false,finishSent=false,callbackClosed=false,callbackCalled=false,callbackDone=false,callbackInvalid=false,callbackError=null,storageOperations=0;
  const invoke=async(action,args)=>{const full={p_user_id:job.actor,...args},name='erp_fiscal_wsdl_'+action;const raw=await s.bounded(()=>rpc(name,full,{signal:s.signal,deadline:s.deadline}));s.check();return projectResponse(name,raw,full);};
  const checkLease=()=>{s.check();if(claimed)need(Date.parse(claimed.execution.scope.expires_at)>Date.now()+500,'WSDL_SERVICE_LEASE_EXPIRED');};
  const verifyStored=v=>{if(expected)need(v.current.state==='stored'&&v.artifact.wsdl_hash===expected.hash&&v.artifact.size_bytes===expected.size&&same(v.artifact.evidence,expected.evidence),'WSDL_SERVICE_STORED_MISMATCH');};
  const read=async key=>{
   checkLease();need(++storageOperations<=5,'WSDL_SERVICE_STORAGE_LIMIT');let response,reader,buffer,success=false;
   const pending=Promise.resolve().then(()=>{checkLease();return readPort({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
   try{
    try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>r?.body?.cancel()).catch(()=>{});throw e;}
    if(response===null)return null;
    need(response instanceof Response&&response.status===200&&!response.redirected&&response.body,'WSDL_SERVICE_STORAGE_INVALID');
    const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');need(response.headers.get('content-type')==='application/octet-stream'&&(encoding===null||encoding==='identity')&&(length===null||/^\d+$/.test(length)&&Number(length)===expected.size),'WSDL_SERVICE_STORAGE_INVALID');
    buffer=Buffer.alloc(expected.size);reader=response.body.getReader();let used=0;
    while(true){const part=await s.bounded(()=>reader.read());if(part.done)break;need(part.value instanceof Uint8Array&&used+part.value.length<=expected.size,'WSDL_SERVICE_STORAGE_INVALID');buffer.set(part.value,used);used+=part.value.length;}
    need(used===expected.size&&sha(buffer)===expected.hash,'WSDL_SERVICE_STORAGE_HASH_MISMATCH');checkLease();success=true;return buffer;
   }finally{if(!success)buffer?.fill(0);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else void response?.body?.cancel().catch(()=>{});}
  };
  try{
   try{known=bind(await invoke('command',{p_command_id:job.commandId}),job);}catch(e){if(e?.code!=='P0002')throw e;}
   if(known&&(known.current.state!=='prepared'||known.current.lease_expired))return result(known,{recovered:true});
   phase='begin';beginSent=true;const started=bind(await invoke('begin',rpcArgs(job)),job,known?.receipt);known=started;
   if(started.execution===null)return result(started,{recovered:started.replayed});ready(started);claimed=started;checkLease();
   const plan=prepareWsdlRequest({model:job.model,operation:job.operation,requestId:started.receipt.attempt_id});
   // Leave budget for immutable Storage/readback/finalization. The loader/GET never receives more than30s.
   const acquisitionDeadline=Math.min(s.deadline-1000,Date.now()+30000,Date.parse(started.current.expires_at)-1000);need(acquisitionDeadline>Date.now(),'WSDL_SERVICE_TIMEOUT');
   let clientMetadata;
   const client=createWsdlEvidenceClient({requestImpl,withAuthorizedTlsSession:async(context,action,clientOptions)=>{
    inspectContext(context,claimed.execution,job.actor);phase='prepare_tls';
    try{
     const returned=await withPrepared(freeze({actor:job.actor,execution:claimed.execution,context}),session=>{
      const task=(async()=>{
       if(callbackClosed||callbackCalled){callbackInvalid=true;need(false,'WSDL_SERVICE_CALLBACK_INVALID');}callbackCalled=true;checkLease();
       need(fields(session,['secureContext','metadata','signal','deadline'])&&session.secureContext instanceof SecureContext&&session.signal instanceof AbortSignal&&!session.signal.aborted&&Number.isSafeInteger(session.deadline)&&session.deadline>Date.now()&&session.deadline<=clientOptions.deadline,'WSDL_SERVICE_CUSTODY_INVALID');
       const m=session.metadata,base=claimed.execution.credential.metadata;need(fields(m,['fingerprint_sha256','holder_cnpj','not_before','not_after','client_auth_usage','presented_chain_links_checked','icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit'])&&m.fingerprint_sha256===base.fingerprint_sha256&&m.holder_cnpj===base.holder_cnpj&&m.not_before===base.not_before&&m.not_after===base.not_after&&['unrestricted_absent','explicit_client_auth','unrestricted_any'].includes(m.client_auth_usage)&&m.presented_chain_links_checked===true&&['icp_brasil_chain_validated','revocation_checked','a1_policy_verified','can_emit','can_transmit'].every(k=>m[k]===false)&&Date.now()>=Date.parse(m.not_before)&&Date.now()<=Date.parse(m.not_after),'WSDL_SERVICE_CUSTODY_INVALID');
       clientMetadata=copy(m);phase='consume';useSent=true;
       const used=await invoke('use',{p_attempt_id:started.receipt.attempt_id,p_lease_id:claimed.execution.lease_id});const{issued_at,...grantScope}=used.grant;
       need(same(grantScope,claimed.execution.scope)&&stamp(issued_at),'WSDL_SERVICE_GRANT_MISMATCH');checkLease();need(!callbackClosed&&!callbackInvalid&&!session.signal.aborted&&Date.now()<session.deadline&&Date.now()<=Date.parse(clientMetadata.not_after),'WSDL_SERVICE_CALLBACK_INVALID');
       phase='get';await action(session.secureContext);checkLease();need(!session.signal.aborted,'WSDL_SERVICE_ABORTED');callbackDone=true;
      })();task.catch(e=>{callbackError=e;});return task;
     },clientOptions);
     need(returned===undefined&&callbackCalled&&callbackDone&&!callbackInvalid,'WSDL_SERVICE_CALLBACK_NOT_AWAITED');if(callbackError)throw callbackError;
    }catch(error){callbackError??=error;throw error;}finally{callbackClosed=true;}
   }});
   phase='obtain';const obtaining=client.obtain(plan,{signal:s.signal,deadline:acquisitionDeadline});let received;try{received=await s.bounded(()=>obtaining);}catch(error){void obtaining.then(v=>v.bytes?.fill(0)).catch(()=>{});throw error;}try{checkLease();}catch(error){received.bytes?.fill(0);throw error;}
   need(received.private_evidence_only===true&&received.request_id===started.receipt.attempt_id&&received.endpoint===plan.url&&received.bytes instanceof Uint8Array&&received.bytes.length>0&&received.bytes.length<=MAX&&received.size_bytes===received.bytes.length&&received.wsdl_hash===sha(received.bytes),'WSDL_SERVICE_GET_RESPONSE_INVALID');
   bytes=Buffer.from(received.bytes);received.bytes.fill(0);const inspected=inspectWsdl(bytes,plan,{deadline:s.deadline});need(same(inspected,received.inspection),'WSDL_SERVICE_INSPECTION_MISMATCH');
   const i=inspected,summary={inspection_status:i.inspection_status,code:i.code,validation:i.validation,target_namespace:i.target_namespace,bindings_count:i.bindings?.length??null,operations_count:i.bindings?.reduce((n,b)=>n+b.operations.length,0)??null,addresses_count:i.addresses?.length??null};
   const proof=evidence({profile:FLAGS.profile,request_id:started.receipt.attempt_id,model:job.model,operation:job.operation,environment:'2',wsdl_hash:sha(bytes),size_bytes:bytes.length,received_at:received.received_at,tls:{...received.tls,client_fingerprint:clientMetadata.fingerprint_sha256,client_chain:'not_evaluated',client_profile:'compatible',revocation:'unknown_offline'},inspection:summary,binding_verified:false});
   expected={hash:proof.wsdl_hash,size:proof.size_bytes,evidence:proof};const key=`wsdl/${started.receipt.attempt_id}/${expected.hash}.xml`;phase='storage';
   const existing=await read(key);if(existing)existing.fill(0);else{
    checkLease();need(++storageOperations<=5,'WSDL_SERVICE_STORAGE_LIMIT');
    try{const ack=await s.bounded(()=>putPort({bucket:BUCKET,key,bytes,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));need(fields(ack,['status','requires_readback'])&&ack.requires_readback===true&&[200,201,409].includes(ack.status),'WSDL_SERVICE_STORAGE_ACK_INVALID');}catch{checkLease();}
    need(sha(bytes)===expected.hash,'WSDL_SERVICE_BYTES_CHANGED');const verified=await read(key);need(verified,'WSDL_SERVICE_STORAGE_MISSING');verified.fill(0);
   }
   checkLease();phase='finish';finishSent=true;const stored=bind(await invoke('finish',{p_attempt_id:started.receipt.attempt_id,p_lease_id:claimed.execution.lease_id,p_wsdl_hash:expected.hash,p_size_bytes:expected.size,p_evidence:proof}),job,started.receipt);verifyStored(stored);known=stored;
   phase='readback';const latest=bind(await invoke('command',{p_command_id:job.commandId}),job,started.receipt);verifyStored(latest);return result(latest,{recovered:started.replayed,storage_operations:storageOperations});
  }catch(error){
   let recovered=null,reported=callbackError??error;try{s.check();const candidate=bind(await invoke('command',{p_command_id:job.commandId}),job,claimed?.receipt??known?.receipt);if(candidate.current.state==='stored'&&expected)verifyStored(candidate);recovered=candidate;}catch(recoveryError){if(SQLSTATES.includes(recoveryError?.code))reported=recoveryError;}
   if(recovered?.current.state==='stored')return result(recovered,{recovered:true});
   // A verified finish ACK already proves this immutable artifact was stored.
   // Its SQL snapshot remains evidence if a subsequent command read is unavailable.
   if(known?.current.state==='stored'){verifyStored(known);return result(known,{recovered:true});}
   // Only close a confirmed still-open attempt after a completed failed phase. Lost begin/use/finish ACKs are queried, never inferred.
   if(claimed&&!finishSent&&recovered&&['prepared','dispatched'].includes(recovered.current.state)&&['prepare_tls','get','storage'].includes(phase)){
    const failure=phase==='storage'?'WSDL_STORAGE_FAILED':phase==='get'?'WSDL_RESPONSE_REJECTED':'WSDL_RUNTIME_FAILED';
    try{s.check();recovered=bind(await invoke('fail',{p_attempt_id:claimed.receipt.attempt_id,p_lease_id:claimed.execution.lease_id,p_error_code:failure}),job,claimed.receipt);}catch(failError){if(SQLSTATES.includes(failError?.code))reported=failError;}
   }
   const recovery=true;
   return freeze({...FLAGS,status:recovered?.current.state??'unconfirmed',command_id:job.commandId,recovery_required:recovery,failure_code:safeFailure(reported),read_only:false,recovered:false,
    receipt:recovered?.receipt??known?.receipt??null,current:recovered?.current??known?.current??null,error_code:recovered?.error_code??null,artifact:null});
  }finally{callbackClosed=true;s.close();running.delete(job.commandId);bytes?.fill(0);}
 }
 return Object.freeze({run,command});
}
