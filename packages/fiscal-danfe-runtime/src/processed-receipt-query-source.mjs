/** Read-only089 artifact source. No grant, current credential, custody, transport or writer port. */
import {data,id,hash,freeze,scope,readBody,cancel,copy} from '../../fiscal-authorization/src/service-common.mjs';
import {same} from '../../fiscal-authorization/src/service-dto.mjs';
import {projectReceiptQueryLedger} from '../../fiscal-authorization/src/receipt-query-ledger-dto.mjs';
import {receiptQuerySource,disposeReceiptQuerySource} from '../../fiscal-authorization/src/receipt-query-source.mjs';
import {prepareReceiptQuery} from '../../fiscal-authorization/src/receipt-core.mjs';
import {prepareReviewedReceiptSoap,encodeReviewedReceiptSoap} from '../../fiscal-authorization/src/receipt-soap-binding.mjs';
import {receiptQueryPath,receiptQuerySidecar} from '../../fiscal-authorization/src/receipt-query-journal.mjs';
import {processReceiptQueryResponse} from '../../fiscal-authorization/src/receipt-query-processing.mjs';
import {DanfeRuntimeError,need} from './processed-protocol.mjs';
const handles=new WeakMap(),BUCKET='brufap-fiscal-artifacts';
const required=v=>need(v,502,'DANFE_STORAGE_INVALID');
const discard=h=>{try{if(h)disposeReceiptQuerySource(h);}catch{}};
const stable=v=>freeze({receipt:v.receipt,source:v.source,source_validation:v.source_validation,request:v.request,artifact:v.artifact,recovery:v.recovery,resolution:v.resolution});
function caught(error){
 if(error instanceof DanfeRuntimeError)return error;
 let code;try{code=Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{}
 const map={P0002:[404,'DANFE_NOT_FOUND'],'42501':[403,'DANFE_FORBIDDEN'],'40001':[409,'DANFE_CONFLICT'],'55000':[409,'DANFE_NOT_STORED'],AUTHORIZATION_SERVICE_ABORTED:[503,'DANFE_UPSTREAM_UNAVAILABLE'],AUTHORIZATION_SERVICE_TIMEOUT:[503,'DANFE_UPSTREAM_UNAVAILABLE']};
 return Object.hasOwn(map,code??'')?new DanfeRuntimeError(...map[code]):new DanfeRuntimeError(502,'DANFE_STORAGE_INVALID');
}
function attested(handle){need(handles.has(handle),400,'DANFE_INVALID_REQUEST');return handles.get(handle);}
export const isProcessedReceiptQuerySource=handle=>handles.has(handle);
export function processedReceiptQuerySource(handle){const x=attested(handle);return Object.freeze({metadata:x.metadata,signedBytes:copy(x.signed),processedBytes:copy(x.processed)});}
export function disposeProcessedReceiptQuerySource(handle){const x=attested(handle);handles.delete(handle);x.signed.fill(0);x.processed.fill(0);}
export async function reauthorizeProcessedReceiptQuerySource(handle,options={}){const x=attested(handle);try{await x.reauthorize(options);need(handles.has(handle),409,'DANFE_CONFLICT');}catch(e){throw caught(e);}}
export function createProcessedReceiptQuerySource(configuration){
 const p=data(configuration,['rpc','readSource','storage','validate','validateProcessed']),storage=data(p.storage,['read']);
 required(['rpc','readSource','validate','validateProcessed'].every(k=>typeof p[k]==='function')&&typeof storage.read==='function');
 const {rpc,readSource,validate,validateProcessed}=p,readObject=storage.read;
 return function readProcessedReceiptQuerySource(input,options={}){
  const x=data(input,['actor','sourceKind','commandId']);need(id(x.actor)&&id(x.commandId)&&x.sourceKind==='receipt_query',400,'DANFE_INVALID_REQUEST');freeze(x);const s=scope(options);
  const command=async session=>{
   const args=Object.freeze({p_user_id:x.actor,p_command_id:x.commandId}),raw=await session.bounded(()=>rpc('command',args,{signal:session.signal,deadline:session.deadline}));session.check();
   const v=projectReceiptQueryLedger('command',raw,args),r=v.resolution,a=v.artifact;
   need(v.receipt.origin==='operational'&&v.current.state==='authorized_homologation'&&v.current.grant_consumed===true&&a!==null&&a.processed_hash!==null
    &&r.state==='authorized_homologation'&&r.selected_query_id===x.commandId&&r.query_ids.includes(x.commandId),409,'DANFE_NOT_STORED');return v;
  };
  return(async()=>{
   const owned=[];let sourceHandle=null,handle;
   const read=async(key,expected)=>{let response;const pending=Promise.resolve().then(()=>{s.check();return readObject({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
    try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}const bytes=await readBody(response,s,expected);owned.push(bytes);return bytes;}finally{cancel(response?.body);}};
   try{
    const before=await command(s),c=before.recovery,a=before.artifact;
    const sourceInput=freeze({actor:x.actor,sourceKind:c.source_kind,sourceCommandId:c.source_command_id,authorizationCommandId:c.authorization_command_id,authorizationAttemptId:c.authorization_attempt_id});
    const pending=Promise.resolve().then(()=>{s.check();return readSource(sourceInput,{signal:s.signal,deadline:s.deadline});});
    try{sourceHandle=await s.bounded(()=>pending);}catch(e){void pending.then(discard).catch(()=>{});throw e;}s.check();
    const source=receiptQuerySource(sourceHandle);required(same(source.source,before.source)&&same(source.validation,before.source_validation));
    const request=prepareReceiptQuery({evidence:source.evidence}),soap=prepareReviewedReceiptSoap({request}),rebuilt=Buffer.from(encodeReviewedReceiptSoap(soap));owned.push(rebuilt);
    const savedRequest=await read(receiptQueryPath(c,'requests'),{expectedHash:c.request_hash,expectedSize:c.request_size});required(rebuilt.equals(savedRequest));
    const response=await read(receiptQueryPath(c,'responses'),{expectedHash:a.response_hash,expectedSize:a.response_size});
    const meta=await read(receiptQueryPath(c,'observations'),{expectedHash:a.observation_hash,expectedSize:a.observation_size,max:8192});
    let decoded;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(meta));}catch{required(false);}
    const observation=receiptQuerySidecar(decoded,c,a.response_hash,a.response_size);required(observation.http_status===200);
    const processed=await read(receiptQueryPath(c,'processed',a.processed_hash),{expectedHash:a.processed_hash,expectedSize:a.processed_size});
    const signed=await read(`candidates/${c.candidate_id}/${c.signed_hash}.xml`,{expectedHash:c.signed_hash,expectedSize:c.signed_size});
    const checked=await processReceiptQueryResponse({context:c,source:sourceHandle,request,bytes:response,httpStatus:observation.http_status,observationHash:hash(meta),observationSize:meta.length,validate,validateProcessed},s);
    if(checked.processed)owned.push(checked.processed);
    required(same(checked.evidence,a.evidence)&&checked.processed!==null&&processed.equals(checked.processed));
    const snapshot=stable(before),after=await command(s);need(same(snapshot,stable(after)),409,'DANFE_CONFLICT');s.check();
    const e=a.evidence,metadata=freeze({source_kind:'receipt_query',source_command_id:x.commandId,authorization_command_id:c.authorization_command_id,attempt_id:c.authorization_attempt_id,candidate_id:c.candidate_id,candidate_version:c.candidate_version,signed_hash:c.signed_hash,signed_size:c.signed_size,model:c.model,environment:'2',processed_hash:a.processed_hash,processed_size:a.processed_size,protocol:{cstat:e.protocol_cstat,number:e.protocol_number,received_at:new Date(e.received_at).toISOString()},resolution_hash:before.resolution.resolution_hash});
    handle=Object.freeze({profile:'processed-receipt-query-source-089-v1'});handles.set(handle,{metadata,signed:copy(signed),processed:copy(processed),reauthorize:async opts=>{const next=scope(opts);try{const current=await command(next);need(same(snapshot,stable(current)),409,'DANFE_CONFLICT');next.check();}finally{next.close();}}});return handle;
   }catch(error){if(handle&&handles.has(handle))disposeProcessedReceiptQuerySource(handle);throw caught(error);}
   finally{discard(sourceHandle);for(const b of owned)b.fill(0);s.close();}
  })();
 };
}
