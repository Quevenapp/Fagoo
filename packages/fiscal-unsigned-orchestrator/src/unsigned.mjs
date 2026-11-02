/** Private local orchestration. Mandatory ports; no network, environment, A1 or number allocator. */
import {createHash,randomInt} from 'node:crypto';
import {resolveBusinessContent,BusinessDocumentError,BUSINESS_BUILDER} from '../../fiscal-core/src/business-document.mjs';
import {bindResolvedBusinessContent,buildBoundBusinessXml} from '../../fiscal-xml/src/bound-business.mjs';

const BUCKET='fagoo-fiscal-artifacts',MAX=480000;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,SHA=/^[a-f0-9]{64}$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),digest=v=>typeof v==='string'&&SHA.test(v),version=v=>Number.isInteger(v)&&v>0&&v<=2147483647;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const FLAGS=Object.freeze({offline_prototype:true,unsigned:true,numbering_reserved:false,can_emit:false,can_transmit:false,
  tax_rules_validated:false,xsd_validated:false,signature_verified:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false});
const deterministic=new Map([
 ['BUSINESS_INPUT_INVALID','CONTENT_INVALID'],['BUSINESS_TEXT_INVALID','CONTENT_INVALID'],['BUSINESS_ADDRESS_INVALID','CONTENT_INCOMPLETE'],
 ['BUSINESS_RECIPIENT_INVALID','CONTENT_INCOMPLETE'],['BUSINESS_ITEM_UNPREPARED','CONTENT_INCOMPLETE'],['BUSINESS_QUANTITY_PRECISION','CONTENT_INVALID'],
 ['BUSINESS_DECIMAL_INVALID','CONTENT_INVALID'],['BUSINESS_TAX_UNPREPARED','CONTENT_INCOMPLETE'],['BUSINESS_GROUP_DECISION_REQUIRED','CONTENT_INCOMPLETE'],
 ['BUSINESS_PROFILE_UNSUPPORTED','PROFILE_UNSUPPORTED'],['BUSINESS_PAYMENT_UNSUPPORTED','PROFILE_UNSUPPORTED'],
 ['BUSINESS_ARITHMETIC_MISMATCH','ARITHMETIC_MISMATCH'],['BUSINESS_XML_SIZE_LIMIT','XML_SIZE_LIMIT']]);
export class UnsignedXmlError extends Error{constructor(code){super(code);this.name='UnsignedXmlError';this.code=code;}}
const need=(ok,code='UNSIGNED_RESPONSE_INVALID')=>{if(!ok)throw new UnsignedXmlError(code);};
const safeCode=e=>e instanceof UnsignedXmlError?e.code:e instanceof BusinessDocumentError?e.code:
 e?.code==='BUSINESS_XML_SIZE_LIMIT'?'BUSINESS_XML_SIZE_LIMIT':
 ['42501','40001','22023','55000','P0002'].includes(e?.code)?`UNSIGNED_RPC_${e.code}`:'UNSIGNED_PORT_FAILED';
function noTrust(v){need(object(v)&&v.data_mode==='fiscal_unsigned_job'&&v.environment==='2'&&v.profile==='sn-sp-internal-business-v1'
 &&v.schema_profile==='pl010f-v1.04'&&v.unsigned===true&&['arithmetic_verified','tax_rules_validated','xsd_validated','signature_verified','authorized','can_emit','can_transmit','financial_mutation_performed','stock_mutation_performed'].every(k=>v[k]===false));}
function view(v,input){
 noTrust(v);const r=v.receipt,c=v.current,a=v.artifact;
 need(object(r)&&id(r.job_id)&&r.reservation_id===input.reservationId&&r.draft_id===input.draftId&&version(r.version)
  &&r.completion_version===input.completionVersion&&r.completion_hash===input.completionHash&&r.basis_hash===input.basisHash&&r.builder_version===BUSINESS_BUILDER);
 need(object(c)&&['pending','stored','failed'].includes(c.state)&&Number.isInteger(c.attempt_count)&&c.attempt_count>=1&&c.attempt_count<=100
  &&version(c.completion_version)&&id(c.latest_job_id)&&version(c.latest_job_version)
  &&['basis_changed','draft_archived','source_cancelled','is_latest_job','artifact_current','series_enabled'].every(k=>typeof c[k]==='boolean')
  &&(c.state==='pending'?typeof c.lease_until==='string'&&Number.isFinite(Date.parse(c.lease_until)):c.lease_until===null)
  &&v.xml_generated===(c.state==='stored')&&(c.state==='failed'?new Set(deterministic.values()).has(v.error_code):v.error_code===null));
 need(c.is_latest_job===(c.latest_job_id===r.job_id)&&(!c.artifact_current||c.state==='stored'&&!c.basis_changed&&!c.draft_archived&&!c.source_cancelled&&c.is_latest_job));
 need(c.state==='stored'?object(a)&&digest(a.xml_hash)&&Number.isInteger(a.size_bytes)&&a.size_bytes>0&&a.size_bytes<=MAX
  &&typeof a.created_at==='string'&&Number.isFinite(Date.parse(a.created_at))&&a.access_key===r.access_key:a===null);
 if(Object.hasOwn(v,'command_id'))need(v.command_id===input.commandId);
 return v;
}
function result(v,input,extra={}){
 const c=v.current,r=v.receipt,a=v.artifact;
 // Do not return execution inputs, identities, lease tokens, XML or arbitrary RPC fields.
 return {...FLAGS,status:c.state,command_id:input.commandId,job_id:r.job_id,reservation_id:r.reservation_id,job_version:r.version,
  draft_id:r.draft_id,completion_version:r.completion_version,completion_hash:r.completion_hash,basis_hash:r.basis_hash,xml_generated:v.xml_generated,error_code:v.error_code,
  current:{basis_changed:c.basis_changed,draft_archived:c.draft_archived,source_cancelled:c.source_cancelled,is_latest_job:c.is_latest_job,
   artifact_current:c.artifact_current,series_enabled:c.series_enabled,completion_version:c.completion_version,attempt_count:c.attempt_count,
   lease_until:c.lease_until,latest_job_id:c.latest_job_id,latest_job_version:c.latest_job_version},
  artifact:a?{sha256:a.xml_hash,size_bytes:a.size_bytes,created_at:a.created_at}:null,...extra};
}
function contentBasis(raw,input){
 noTrust(raw);need(raw.private_executor_only===true&&raw.persisted===false&&digest(raw.basis_hash)
  &&raw.basis_fingerprint_profile==='fagoo-business-content-basis-v1'&&typeof raw.basis_fingerprint_text==='string');
 const content=resolveBusinessContent(raw.inputs);
 need(content.binding.draft_id===input.draftId&&content.binding.completion_version===input.completionVersion
  &&content.basis_fingerprint_text===raw.basis_fingerprint_text&&hash(content.basis_fingerprint_text)===raw.basis_hash
  &&object(raw.proofs)&&raw.proofs.completion_hash===content.binding.completion_record_hash,'UNSIGNED_BASIS_CONFLICT');
 if(Object.hasOwn(input,'basisHash'))need(input.basisHash===raw.basis_hash&&input.completionHash===raw.proofs.completion_hash,'UNSIGNED_BASIS_CONFLICT');
 return content;
}
function scope(options={}){
 need(object(options)&&Object.keys(options).every(k=>['signal','deadline'].includes(k))&&(options.signal===undefined||options.signal instanceof AbortSignal),'UNSIGNED_OPTIONS_INVALID');
 const start=Date.now(),deadline=options.deadline??start+45000;
 need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+45000,'UNSIGNED_DEADLINE_INVALID');need(!options.signal?.aborted,'UNSIGNED_ABORTED');
 const controller=new AbortController();let reason='UNSIGNED_ABORTED',rejectStop;
 const stop=new Promise((_,reject)=>{rejectStop=reject;});
 const cancel=()=>{controller.abort();rejectStop(new UnsignedXmlError(reason));};
 const timer=setTimeout(()=>{reason='UNSIGNED_TIMEOUT';cancel();},deadline-start);
 options.signal?.addEventListener('abort',cancel,{once:true});
 const check=()=>{need(!controller.signal.aborted,reason);need(Date.now()<deadline,'UNSIGNED_TIMEOUT');};
 return {deadline,signal:controller.signal,check,async bounded(fn){check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stop]);},
  close(){clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);controller.abort();}};
}
export function createUnsignedXmlOrchestrator({rpc,storage}={}){
 need(typeof rpc==='function'&&typeof storage?.read==='function'&&typeof storage?.putImmutable==='function','UNSIGNED_PORTS_REQUIRED');
 const running=new Set();
 const call=(s,actor,name,args)=>s.bounded(()=>rpc(`erp_fiscal_unsigned_${name}`,{...args,p_user_id:actor},{signal:s.signal,deadline:s.deadline}));
 return Object.freeze({
  async preview(input,options){
   need(exact(input,['actor','draftId','completionVersion'])&&id(input.actor)&&id(input.draftId)&&version(input.completionVersion),'UNSIGNED_INPUT_INVALID');
   const s=scope(options);
   try{const raw=await call(s,input.actor,'basis',{p_draft_id:input.draftId,p_completion_version:input.completionVersion}),c=contentBasis(raw,input);s.check();
    return {...FLAGS,status:'checked',draft_id:input.draftId,completion_version:input.completionVersion,basis_hash:raw.basis_hash,
     completion_hash:c.binding.completion_record_hash,builder_version:BUSINESS_BUILDER,model:c.model,environment:'2',items:c.items.length,
     arithmetic_verified:true,identity_assigned:false,numbering_bound:false,xml_generated:false,pending:[...c.pending]};
   }catch(e){return {...FLAGS,status:'blocked',draft_id:input.draftId,code:safeCode(e),xml_generated:false};}finally{s.close();}
  },
  async run(input,options){
   need(exact(input,['actor','commandId','reservationId','draftId','completionVersion','completionHash','basisHash'])
    &&['actor','commandId','reservationId','draftId'].every(k=>id(input[k]))&&version(input.completionVersion)
    &&digest(input.completionHash)&&digest(input.basisHash),'UNSIGNED_INPUT_INVALID');
   need(!running.has(input.commandId),'UNSIGNED_ALREADY_RUNNING');const s=scope(options),job=Object.freeze({...input});running.add(job.commandId);
   let phase='recover',claimed=null,priorKnown=false,beginSent=false,finishSent=false,storageOperations=0,xmlBytes=null,builtProof=null;
   const invoke=(name,args)=>call(s,job.actor,name,args);
   const leaseCheck=()=>{s.check();if(claimed)need(Date.parse(claimed.execution.lease_until)>Date.now()+1000,'UNSIGNED_LEASE_EXPIRED');};
   const read=async(key,expected)=>{
    leaseCheck();need(++storageOperations<=4,'UNSIGNED_STORAGE_LIMIT');let response,reader;const chunks=[];
    const pending=Promise.resolve().then(()=>{leaseCheck();return storage.read({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
    try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>r?.body?.cancel()).catch(()=>{});throw e;}
     if(response===null)return false;
     need(response instanceof Response&&response.status===200&&!response.redirected&&response.body,'UNSIGNED_STORAGE_RESPONSE_INVALID');
     const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
     need(response.headers.get('content-type')==='application/octet-stream'&&(encoding===null||encoding==='identity')
      &&(length===null||/^\d+$/.test(length)&&Number(length)===expected.size),'UNSIGNED_STORAGE_RESPONSE_INVALID');
     reader=response.body.getReader();let used=0;
     while(true){const item=await s.bounded(()=>reader.read());if(item.done)break;need(item.value instanceof Uint8Array&&(used+=item.value.length)<=MAX,'UNSIGNED_STORAGE_SIZE_INVALID');chunks.push(Buffer.from(item.value));}
     const bytes=Buffer.concat(chunks,used);try{need(used===expected.size&&hash(bytes)===expected.hash,'UNSIGNED_STORAGE_HASH_CONFLICT');}finally{bytes.fill(0);}
     leaseCheck();return true;
    }finally{for(const part of chunks)part.fill(0);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}else void response?.body?.cancel().catch(()=>{});}
   };
   try{
    let prior=null;try{prior=view(await invoke('command',{p_command_id:job.commandId}),job);priorKnown=true;}catch(e){if(e?.code!=='P0002')throw e;}
    if(prior&&(prior.current.state!=='pending'||Date.parse(prior.current.lease_until)>Date.now()))return result(prior,job,{recovered:true});
    phase='preflight';contentBasis(await invoke('basis',{p_draft_id:job.draftId,p_completion_version:job.completionVersion}),job);
    phase='begin';beginSent=true;
    const seed={cNF:String(randomInt(0,100000000)).padStart(8,'0'),issuedAt:new Date(Date.now()-10800000).toISOString().slice(0,19)+'-03:00'};
    const started=view(await invoke('begin',{p_command_id:job.commandId,p_reservation_id:job.reservationId,p_completion_version:job.completionVersion,
     p_completion_hash:job.completionHash,p_basis_hash:job.basisHash,p_builder_version:BUSINESS_BUILDER,p_seed:seed}),job);
    if(started.execution===null)return result(started,job,{recovered:Boolean(prior)});
    need(started.current.state==='pending'&&exact(started.execution,['private_executor_only','lease_id','lease_until','inputs','identity','access_key'])
     &&started.execution.private_executor_only===true&&id(started.execution.lease_id)&&started.execution.lease_until===started.current.lease_until,'UNSIGNED_EXECUTION_INVALID');
    claimed=started;leaseCheck();phase='build';
    const content=resolveBusinessContent(started.execution.inputs),bound=bindResolvedBusinessContent({content,receipt:started.receipt});
    need(['cUF','cnpj','model','environment','series','number','tpEmis','cNF','issuedAt'].every(k=>started.execution.identity?.[k]===bound.identity[k])
     &&started.execution.access_key===bound.access_key,'UNSIGNED_EXECUTION_INVALID');
    const built=buildBoundBusinessXml(bound);xmlBytes=Buffer.from(built.unsignedXml,'utf8');
    need(xmlBytes.length>0&&xmlBytes.length<=MAX&&hash(xmlBytes)===built.unsigned_xml_sha256&&built.access_key===started.receipt.access_key,'UNSIGNED_XML_INVALID');
    const expected={hash:built.unsigned_xml_sha256,size:xmlBytes.length},key=`jobs/${started.receipt.job_id}/${expected.hash}.xml`;
    builtProof={jobId:started.receipt.job_id,...expected};
    phase='storage';
    if(!await read(key,expected)){
     leaseCheck();need(++storageOperations<=4,'UNSIGNED_STORAGE_LIMIT');
     try{const ack=await s.bounded(()=>storage.putImmutable({bucket:BUCKET,key,bytes:xmlBytes,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));
      need(object(ack)&&[200,201,409].includes(ack.status),'UNSIGNED_STORAGE_ACK_INVALID');
     }catch{leaseCheck();/* A missing ACK is not absence: only read these exact immutable bytes. */}
     need(await read(key,expected),'UNSIGNED_STORAGE_MISSING');
    }
    leaseCheck();phase='finish';finishSent=true;
    const done=view(await invoke('finish',{p_job_id:started.receipt.job_id,p_lease_id:started.execution.lease_id,p_xml_hash:expected.hash,p_size_bytes:expected.size,p_access_key:built.access_key}),job);
    need(done.current.state==='stored'&&done.receipt.job_id===started.receipt.job_id&&done.artifact.xml_hash===expected.hash&&done.artifact.size_bytes===expected.size,'UNSIGNED_FINISH_INVALID');
    phase='readback';const latest=view(await invoke('get',{p_job_id:started.receipt.job_id}),job);
    need(latest.current.state==='stored'&&latest.receipt.job_id===done.receipt.job_id&&latest.artifact.xml_hash===expected.hash&&latest.artifact.size_bytes===expected.size,'UNSIGNED_FINISH_INVALID');
    return result(latest,job,{recovered:Boolean(prior),storage_operations:storageOperations});
   }catch(e){
    const code=safeCode(e);
    // Only a deterministic builder failure can be terminal. Port errors and lost ACKs remain recoverable.
    if(claimed&&phase==='build'&&deterministic.has(e?.code)&&!s.signal.aborted){
     try{leaseCheck();const failed=view(await invoke('fail',{p_job_id:claimed.receipt.job_id,p_lease_id:claimed.execution.lease_id,p_error_code:deterministic.get(e.code)}),job);
      need(failed.current.state==='failed','UNSIGNED_FAILURE_INVALID');return result(failed,job,{code});}catch{/* Preserve the command; never presume rollback. */}
    }
    if(finishSent&&!s.signal.aborted){
     try{const known=view(await invoke('command',{p_command_id:job.commandId}),job);
      need(builtProof&&known.receipt.job_id===builtProof.jobId&&known.current.state==='stored'
       &&known.artifact.xml_hash===builtProof.hash&&known.artifact.size_bytes===builtProof.size,'UNSIGNED_FINISH_INVALID');
      return result(known,job,{recovered:true,storage_operations:storageOperations});
     }catch{/* A later call will read the same command again. */}
    }
    const unconfirmed=priorKnown||beginSent;
    return {...FLAGS,status:unconfirmed?'recoverable':'blocked',command_id:job.commandId,code,phase,xml_generated:unconfirmed?null:false,
     outcome:unconfirmed?'unconfirmed':'not_started',storage_operations:storageOperations};
   }finally{xmlBytes?.fill(0);s.close();running.delete(job.commandId);}
  },
 });
}
