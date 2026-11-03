/** Private local prototype: all ports are mandatory; no network, environment or credential adapter. */
import {createHash} from 'node:crypto';
import {prepareDistributionExchange} from '../../fiscal-dfe-transport/src/distribution-transport.mjs';
import {parseDistributionResponse,planDistributionContinuation} from '../../fiscal-xml/src/distribution.mjs';

const BUCKET='brufap-received-dfe',MAX=8388608,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const FLAGS=Object.freeze({offline_prototype:true,can_query:false,can_manifest:false,can_emit:false,operation_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false});
const hash=v=>createHash('sha256').update(v).digest('hex'),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&UUID.test(v),nsu=v=>typeof v==='string'&&/^\d{15}$/.test(v),ver=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
export class DfeBatchError extends Error{constructor(code){super(code);this.name='DfeBatchError';this.code=code;}}
const need=(v,code)=>{if(!v)throw new DfeBatchError(code);};
const fixedError=e=>e instanceof DfeBatchError?e.code:['42501','40001','22023','55000','P0002'].includes(e?.code)?`DFE_RPC_${e.code}`:'DFE_PORT_FAILED';
function noTrust(v){need(object(v)&&v.data_mode==='received_dfe'&&v.model==='55'&&['transport_enabled','can_query','can_manifest','can_emit','origin_authenticated','signature_verified','xsd_validated','sefaz_authorized','financial_mutation_performed','stock_mutation_performed'].every(k=>v[k]===false),'DFE_RPC_INVALID');}
function current(v,job){need(object(v)&&v.id===job.channelId&&ver(v.version)&&ver(v.identity_version)&&['1','2'].includes(v.environment)&&['unconfirmed','external','brufap'].includes(v.coordinator)&&typeof v.other_consumers_reviewed==='boolean'&&typeof v.checkpoint_confirmed==='boolean'&&typeof v.collection_requested==='boolean'&&typeof v.paused==='boolean'&&typeof v.company_changed==='boolean'&&(v.checkpoint===null||nsu(v.checkpoint))&&(v.active_attempt_id===null||id(v.active_attempt_id)),'DFE_RPC_INVALID');return v;}
function terminal(v,job){noTrust(v);need(v.command_id===job.commandId&&v.action==='collect'&&['stored','review','abandoned'].includes(v.state)&&typeof v.replayed==='boolean'&&object(v.receipt)&&v.receipt.attempt_id===job.commandId&&v.receipt.state===v.state,'DFE_RPC_INVALID');current(v.current,job);return{...FLAGS,status:v.state,command_id:job.commandId,receipt:structuredClone(v.receipt),current:structuredClone(v.current),replayed:v.replayed};}
function reservation(v,job){
 noTrust(v);need(v.attempt_id===job.commandId&&['reserved','dispatched','uncertain'].includes(v.state)&&id(v.lease_id)&&typeof v.lease_until==='string'&&Number.isFinite(Date.parse(v.lease_until))&&typeof v.recovery_only==='boolean'&&typeof v.replayed==='boolean'&&object(v.request)&&typeof v.request_hash==='string'&&SHA.test(v.request_hash),'DFE_RESERVATION_INVALID');
 const c=current(v.current,job),p=prepareDistributionExchange(v.request);
 need(p.request_hash===v.request_hash&&p.environment===c.environment&&v.request.lastNsu===c.checkpoint&&c.active_attempt_id===job.commandId&&c.version===job.expectedVersion&&c.coordinator==='brufap'&&c.collection_requested&&c.checkpoint_confirmed&&c.other_consumers_reviewed&&!c.paused&&!c.company_changed,'DFE_RESERVATION_CONTEXT_CHANGED');
 return structuredClone(v);
}
function manifest(parsed,size){return{request_hash:parsed.requestHash,response_hash:parsed.responseHash,response_size:size,status:parsed.status,last_nsu:parsed.lastNsu,max_nsu:parsed.maxNsu,documents:parsed.documents.map(d=>({nsu:d.nsu,schema:d.schema,kind:d.kind,access_key:d.accessKey,recipient_match:d.recipientMatch,quarantined:d.quarantined,hash:d.sha256,size:d.sizeBytes,compressed_hash:d.compressedSha256})),issues:[...parsed.issues]};}

export function createDfeBatchOrchestrator({rpc,transport,storage,withAuthorizedCredential}={}){
 need(typeof rpc==='function'&&typeof transport?.exchange==='function'&&typeof storage?.putImmutable==='function'&&typeof storage?.read==='function'&&typeof withAuthorizedCredential==='function','DFE_PORTS_REQUIRED');
 const running=new Set();
 return Object.freeze({async run(input,options={}){
  need(object(input)&&Object.keys(input).length===4&&Object.keys(input).every(k=>['actor','commandId','channelId','expectedVersion'].includes(k))&&id(input.actor)&&id(input.commandId)&&id(input.channelId)&&ver(input.expectedVersion),'DFE_JOB_INVALID');
  need(object(options)&&Object.keys(options).every(k=>['signal','deadline'].includes(k))&&(options.signal===undefined||options.signal instanceof AbortSignal),'DFE_JOB_OPTIONS_INVALID');
  const job=Object.freeze({...input}),signal=options.signal,end=options.deadline??Date.now()+90000,start=Date.now();
  need(Number.isSafeInteger(end)&&end>start&&end<=start+90000,'DFE_JOB_DEADLINE_INVALID');need(!signal?.aborted,'DFE_JOB_ABORTED');
  need(!running.has(job.commandId),'DFE_JOB_ALREADY_RUNNING');running.add(job.commandId);
  const deadline=end-Math.min(5000,Math.floor((end-start)/4)),abort=new AbortController();let timer,lease=null,phase='reserve',possiblyDispatched=false,finalizeStarted=false,callbackClosed=false,renewals=0,storageCalls=0;
  let rejectWait;
  const cancel=()=>{abort.abort();rejectWait?.(new DfeBatchError('DFE_JOB_ABORTED'));};signal?.addEventListener('abort',cancel,{once:true});
  const timeout=new Promise((_,reject)=>{rejectWait=reject;timer=setTimeout(()=>{abort.abort();reject(new DfeBatchError('DFE_JOB_TIMEOUT'));},Math.max(1,deadline-Date.now()));});
  const check=()=>{need(!abort.signal.aborted,'DFE_JOB_ABORTED');need(Date.now()<deadline,'DFE_JOB_TIMEOUT');};
  const bounded=async(fn)=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),timeout]);};
  const call=(name,args)=>bounded(()=>rpc(`erp_dfe_${name}`,{...args,p_user_id:job.actor},{signal:abort.signal,deadline}));
  const leased=()=>({p_attempt_id:job.commandId,p_lease_id:lease.lease_id});
  const journal=()=>`responses/${job.commandId}/${lease.request_hash}.xml`;
  const storageOptions=()=>({signal:abort.signal,deadline});
  const read=async(key,expected)=>{
   need(++storageCalls<=160,'DFE_STORAGE_BUDGET');let result,reader;
   const pending=Promise.resolve().then(()=>{check();return storage.read({bucket:BUCKET,key,...storageOptions()});});
   try{result=await bounded(()=>pending);}catch(e){void pending.then(r=>r?.body?.cancel()).catch(()=>{});throw e;}
   if(result===null)return null;
   try{
    need(result instanceof Response&&result.status===200&&!result.redirected&&result.body,'DFE_STORAGE_READ_INVALID');
    const mime=result.headers.get('content-type'),encoding=result.headers.get('content-encoding'),length=result.headers.get('content-length');
    need(mime==='application/octet-stream'&&(encoding===null||encoding==='identity')&&(length===null||/^\d+$/.test(length)&&Number(length)>=1&&Number(length)<=MAX),'DFE_STORAGE_READ_INVALID');
    reader=result.body.getReader();const chunks=[];let used=0;
    try{while(true){const item=await bounded(()=>reader.read());if(item.done)break;need(item.value instanceof Uint8Array&&(used+=item.value.length)<=MAX,'DFE_STORAGE_SIZE_INVALID');chunks.push(Buffer.from(item.value));}
     need(used>0&&(length===null||Number(length)===used),'DFE_STORAGE_SIZE_INVALID');const bytes=Buffer.concat(chunks,used);need(!expected||bytes.length===expected.size&&hash(bytes)===expected.hash,'DFE_STORAGE_HASH_CONFLICT');return bytes;
    }finally{for(const part of chunks)part.fill(0);}
   }finally{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}else void result?.body?.cancel().catch(()=>{});}
  };
  const ensure=async(key,bytes)=>{
   check();need(bytes instanceof Uint8Array&&bytes.length>0&&bytes.length<=MAX,'DFE_STORAGE_INPUT_INVALID');const content=Buffer.from(bytes),expected={hash:hash(content),size:content.length};
   try{
    need(++storageCalls<=160,'DFE_STORAGE_BUDGET');
    // A lost PUT response is recovered only by reading this immutable path.
    try{const result=await bounded(()=>storage.putImmutable({bucket:BUCKET,key,bytes:content,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',...storageOptions()}));need(object(result)&&[200,201,409].includes(result.status),'DFE_STORAGE_WRITE_INVALID');}
    catch(e){check();if(e instanceof DfeBatchError&&e.code==='DFE_STORAGE_WRITE_INVALID')throw e;}
    const stored=await read(key,expected);need(stored!==null,'DFE_STORAGE_OBJECT_MISSING');stored.fill(0);
   }finally{content.fill(0);}
  };
  const freshLease=async()=>{if(Date.parse(lease.lease_until)>Math.min(deadline,Date.now()+30000)+1000)return;need(++renewals<=3,'DFE_LEASE_BUDGET');const before=lease;lease=reservation(await call('renew',leased()),job);need(lease.lease_id===before.lease_id&&lease.request_hash===before.request_hash,'DFE_LEASE_CHANGED');};
  try{
   const first=await call('reserve',{p_command_id:job.commandId,p_channel_id:job.channelId,p_expected_version:job.expectedVersion});
   if(['stored','review','abandoned'].includes(first?.state))return terminal(first,job);
   lease=reservation(first,job);possiblyDispatched=lease.state!=='reserved';
   if(Date.parse(lease.lease_until)<=Date.now()){
    need(possiblyDispatched,'DFE_LEASE_EXPIRED');lease=reservation(await call('recover',{p_attempt_id:job.commandId}),job);need(lease.recovery_only,'DFE_RECOVERY_INVALID');
   }
   await freshLease();phase='journal';let bytes=await read(journal());
   if(lease.state==='reserved'){
    need(bytes===null,'DFE_JOURNAL_BEFORE_DISPATCH');need(!lease.recovery_only,'DFE_RECOVERY_CANNOT_SEND');phase='authorization';let invoked=false,callbackDone=false;
    const callback=options=>{
     const task=(async({secureContext}={})=>{
     need(!callbackClosed&&!invoked,'DFE_AUTHORIZATION_CALLBACK_INVALID');invoked=true;check();await freshLease();phase='dispatch';possiblyDispatched=true;
     const ticket=await call('dispatch',leased());noTrust(ticket);need(ticket.attempt_id===job.commandId&&typeof ticket.dispatch_ticket_issued==='boolean'&&['dispatched','uncertain'].includes(ticket.state),'DFE_DISPATCH_INVALID');
     if(!ticket.dispatch_ticket_issued)throw new DfeBatchError('DFE_DISPATCH_ALREADY_CONSUMED');
     lease.state='dispatched';phase='transport';const plan=prepareDistributionExchange(lease.request);
     const response=await bounded(()=>transport.exchange(plan,{secureContext,signal:abort.signal,deadline:Math.min(deadline,Date.now()+20000)}));
     need(response?.bytes instanceof Uint8Array&&response.bytes.length>0&&response.bytes.length<=MAX&&response.request_hash===lease.request_hash&&response.wire_hash===plan.wire_hash&&response.response_hash===hash(response.bytes),'DFE_TRANSPORT_RESULT_INVALID');bytes=Buffer.from(response.bytes);
     // Preserve every complete transport response before parsing, including invalid XML.
     // No query can be repeated if parsing or any later operation fails.
     phase='journal';await ensure(journal(),bytes);callbackDone=true;
     })(options);
     // A broken authority port must not create an unhandled background rejection.
     void task.catch(()=>{});return task;
    };
    try{await bounded(()=>withAuthorizedCredential(Object.freeze({actor:job.actor,command_id:job.commandId,channel_id:job.channelId,channel_version:lease.current.version,identity_version:lease.current.identity_version,request:Object.freeze({...lease.request}),request_hash:lease.request_hash,lease_until:lease.lease_until}),callback,storageOptions()));need(invoked&&callbackDone&&bytes!==null,'DFE_AUTHORIZATION_NOT_COMPLETED');}finally{callbackClosed=true;}
   }else need(bytes!==null,'DFE_RESPONSE_JOURNAL_MISSING');
   phase='parse';const parsed=await bounded(()=>parseDistributionResponse(bytes,{request:lease.request,signal:abort.signal,deadline:Math.min(deadline,Date.now()+10000)}));
   need(parsed.requestHash===lease.request_hash&&parsed.responseHash===hash(bytes),'DFE_RESPONSE_CONTEXT_CHANGED');
   const proposal=planDistributionContinuation({response:parsed,coordination:{coordinator:lease.current.coordinator,checkpointConfirmed:lease.current.checkpoint_confirmed,otherConsumersReviewed:lease.current.other_consumers_reviewed,lastNsu:lease.request.lastNsu},receivedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')});
   need(proposal.action!=='coordination_required','DFE_COORDINATION_NOT_READY');const m=manifest(parsed,bytes.length);
   phase='storage';await freshLease();const objects=new Map([[m.response_hash,bytes]]);
   for(const d of parsed.documents){const content=Buffer.from(d.xml,'utf8');need(content.length===d.sizeBytes&&hash(content)===d.sha256,'DFE_DOCUMENT_BYTES_CHANGED');if(objects.has(d.sha256))need(objects.get(d.sha256).equals(content),'DFE_DOCUMENT_HASH_CONFLICT');else objects.set(d.sha256,content);}
   for(const [h,content]of [...objects].sort(([a],[b])=>a.localeCompare(b))){await freshLease();await ensure(`objects/${h}.xml`,content);}
   check();await freshLease();phase='finalize';finalizeStarted=true;
   const saved=terminal(await call('finalize',{...leased(),p_manifest:m}),job);
   need(saved.receipt.response_hash===m.response_hash&&saved.receipt.documents===m.documents.length,'DFE_FINALIZE_RECEIPT_INVALID');
   return{...saved,recovered:first.state!=='reserved',storage_operations:storageCalls};
  }catch(e){
   callbackClosed=true;const code=fixedError(e);let failureRecorded=false;
   // Never mark a siorigin worker uncertain merely because it won the same ticket.
   if(possiblyDispatched&&lease&&!signal?.aborted&&Date.now()<end&&code!=='DFE_DISPATCH_ALREADY_CONSUMED'){
    const report=new AbortController();let reportTimer;
    try{
     const reportTimeout=new Promise((_,reject)=>{reportTimer=setTimeout(()=>{report.abort();reject(new DfeBatchError('DFE_REPORT_TIMEOUT'));},Math.max(1,end-Date.now()));});
     const attempt=async()=>{
      if(finalizeStarted){const result=await rpc('erp_dfe_command',{p_user_id:job.actor,p_command_id:job.commandId},{signal:report.signal,deadline:end});if(['stored','review','abandoned'].includes(result?.state))return terminal(result,job);}
      const errorCode=phase==='transport'?'NETWORK_TIMEOUT':phase==='parse'?'RESPONSE_INVALID':['journal','storage'].includes(phase)?'STORAGE_UNCERTAIN':'RESPONSE_LOST';
      const result=await rpc('erp_dfe_uncertain',{p_user_id:job.actor,...leased(),p_error_code:errorCode},{signal:report.signal,deadline:end});reservation(result,job);failureRecorded=true;return null;
     };
     const recovered=await Promise.race([attempt(),reportTimeout]);if(recovered)return{...recovered,recovered:true,storage_operations:storageCalls};
    }catch{/* Best effort only; a failure never releases the active attempt or re-sends. */}finally{clearTimeout(reportTimer);report.abort();}
   }
   return{...FLAGS,status:possiblyDispatched?'review_required':'blocked',command_id:job.commandId,code,phase,outcome:possiblyDispatched?'uncertain':'not_dispatched',failure_recorded:failureRecorded,retry_transport:false};
  }finally{callbackClosed=true;clearTimeout(timer);cancel();signal?.removeEventListener('abort',cancel);running.delete(job.commandId);}
 }});
}
