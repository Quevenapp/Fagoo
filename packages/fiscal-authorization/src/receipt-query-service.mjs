/**089: one deliberate consReciNFe, a durable grant before transport, and offline-only recovery. */
import {data,need,id,hash,freeze,scope,cancel,readBody} from './service-common.mjs';
import {same,SQLSTATES} from './service-dto.mjs';
import {captureReceiptQueryRpc,projectReceiptQueryLedger} from './receipt-query-ledger-dto.mjs';
import {isReceiptQuerySqlFailure} from './receipt-query-rpc.mjs';
import {captureReceiptQueryContextInput,captureReceiptQueryHistoryInput,captureReceiptQueryRunInput} from './receipt-query-public-dto.mjs';
import {projectReceiptQueryContext,projectReceiptQueryHistory,projectReceiptQueryResult} from './receipt-query-public-view.mjs';
import {receiptQuerySource,disposeReceiptQuerySource} from './receipt-query-source.mjs';
import {prepareReceiptQuery,receiptRequestBytes} from './receipt-core.mjs';
import {prepareReviewedReceiptSoap,encodeReviewedReceiptSoap} from './receipt-soap-binding.mjs';
import {createReceiptQueryJournal,receiptQueryPath,receiptQuerySidecar} from './receipt-query-journal.mjs';
import {receiptQueryEvidenceBase,validateReceiptQueryBytes,processReceiptQueryResponse} from './receipt-query-processing.mjs';
import {SP_RECEIPT_QUERY_SERVER_TRUST,SP_RECEIPT_QUERY_ROOT_HASH} from './receipt-query-server-trust.mjs';
export class ReceiptQueryServiceError extends Error{
 constructor(code,commandId=null,recoveryRequired=false){super(code);this.name='ReceiptQueryServiceError';this.code=code;this.command_id=commandId;this.recovery_required=recoveryRequired;}
}
const codeOf=e=>{try{const d=Object.getOwnPropertyDescriptor(e,'code');return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&(SQLSTATES.includes(d.value)||/^(?:RECEIPT_QUERY|AUTHORIZATION_SERVICE)_[A-Z_]{1,90}$/.test(d.value))?d.value:'RECEIPT_QUERY_RESULT_UNCONFIRMED';}catch{return'RECEIPT_QUERY_RESULT_UNCONFIRMED';}};
const contextArgs=(actor,i)=>({p_user_id:actor,p_source_kind:i.source_kind,p_source_command_id:i.source_command_id,p_expected_attempt_id:i.expected_attempt_id});
const queryArgs=(actor,c)=>({p_user_id:actor,p_query_id:c.query_id,p_lease_id:c.lease_id});
const contextInput=i=>({source_kind:i.source_kind,source_command_id:i.source_command_id,expected_attempt_id:i.expected_attempt_id});
const withoutTime=v=>{const {observed_at,...rest}=v;return rest;};
const dispose=h=>{try{if(h)disposeReceiptQuerySource(h);}catch{}};
export function createReceiptQueryService(configuration){
 const p=data(configuration,['rpc','readSource','storage','validate','validateProcessed','withPreparedSession','transport'],['enabled']);
 need(['rpc','readSource','validate','validateProcessed','withPreparedSession','transport'].every(k=>typeof p[k]==='function')&&(p.enabled===undefined||typeof p.enabled==='boolean'));
 const {rpc,readSource,validate,validateProcessed,withPreparedSession:custody,transport}=p,enabled=p.enabled===true,journal=createReceiptQueryJournal(p.storage),running=new Set();
 const call=async(action,args,s)=>{const captured=captureReceiptQueryRpc(action,args),out=await s.bounded(()=>rpc(action,captured,{signal:s.signal,deadline:s.deadline}));s.check();return projectReceiptQueryLedger(action,out,captured);};
 const query=(actor,commandId,s)=>call('command',{p_user_id:actor,p_command_id:commandId},s);
 async function checkedCommand(actor,commandId,s){const before=await query(actor,commandId,s);await journal.verify(before,s);const after=await query(actor,commandId,s);need(same(before.receipt,after.receipt)&&same(before.source,after.source)&&same(before.artifact,after.artifact),'RECEIPT_QUERY_STORED_CHANGED');return after;}
 async function source(actor,view,s){
  const x=view.source??view,input={actor,sourceKind:x.source_kind,sourceCommandId:x.source_command_id,authorizationCommandId:x.authorization_command_id,authorizationAttemptId:x.authorization_attempt_id};
  let handle;const pending=Promise.resolve().then(()=>{s.check();return readSource(freeze(input),{signal:s.signal,deadline:s.deadline});});
  try{try{handle=await s.bounded(()=>pending);}catch(e){void pending.then(dispose).catch(()=>{});throw e;}s.check();need(same(receiptQuerySource(handle).source,x),'RECEIPT_QUERY_SOURCE_CHANGED');return handle;}catch(e){dispose(handle);throw e;}
 }
 async function attestedContext(actor,i,s){let handle;
  try{const args=contextArgs(actor,i),before=await call('context',args,s);handle=await source(actor,before,s);const after=await call('context',args,s);need(same(withoutTime(before),withoutTime(after)),'40001');return{view:after,handle,validation:receiptQuerySource(handle).validation};}catch(e){dispose(handle);throw e;}
 }
 async function context(input,options={}){const x=data(input,['actor','request']);need(id(x.actor));const i=captureReceiptQueryContextInput(x.request),s=scope(options);let handle;
  try{const v=await attestedContext(x.actor,i,s);handle=v.handle;return projectReceiptQueryContext(v.view,{action:'receiptQueryContext',input:i},{enabled,verified:true,validation:v.validation});}
  catch(e){throw new ReceiptQueryServiceError(codeOf(e));}finally{dispose(handle);s.close();}
 }
 async function history(input,options={}){const x=data(input,['actor','request']);need(id(x.actor));const i=captureReceiptQueryHistoryInput(x.request),s=scope(options);
  try{const v=await call('history',{p_user_id:x.actor,p_authorization_command_id:i.authorization_command_id,p_expected_attempt_id:i.expected_attempt_id,p_limit:i.limit,p_before:i.before},s);return projectReceiptQueryHistory(v,{action:'receiptQueryHistory',input:i});}catch(e){throw new ReceiptQueryServiceError(codeOf(e));}finally{s.close();}
 }
 async function command(input,options={}){const x=data(input,['actor','commandId']);need(id(x.actor)&&id(x.commandId));const s=scope(options);
  try{return projectReceiptQueryResult(await checkedCommand(x.actor,x.commandId,s),{action:'receiptQueryCommand',commandId:x.commandId});}catch(e){throw new ReceiptQueryServiceError(codeOf(e),x.commandId);}finally{s.close();}
 }
 async function perform(actor,commandId,i,options,recoveryOnly){
  const key=actor+':'+commandId;need(!running.has(key),'RECEIPT_QUERY_ALREADY_RUNNING');running.add(key);const s=scope(options);let handle=null,wire=null,raw=null,processed=null,known=null,uncertain=false,useStarted=false,callbackError=null,stage='prepare';
  const binding=recoveryOnly?{action:'receiptQueryRecover',commandId,input:{confirmed:true}}:{action:'receiptQueryRun',commandId,input:i};
  const output=v=>projectReceiptQueryResult(v,binding,{readOnly:false,replayed:recoveryOnly||v.replayed===true});
  const matching=v=>{if(!i)return;const r=v.receipt;need(r.query_id===commandId&&r.source_kind===i.source_kind&&r.source_command_id===i.source_command_id&&r.authorization_command_id===i.expected_authorization_command_id&&r.authorization_attempt_id===i.expected_attempt_id&&r.candidate_id===i.expected_candidate_id&&r.candidate_version===i.expected_candidate_version&&r.signed_hash===i.expected_signed_hash&&r.source_binding_hash===i.expected_source_binding_hash&&r.identity_version===i.expected_identity_version&&r.a1_version===i.expected_a1_version&&r.query_policy_version===i.expected_query_policy_version,'40001');};
  try{
   try{known=await query(actor,commandId,s);}catch(e){if(codeOf(e)!=='P0002'||recoveryOnly)throw e;}
   if(known){
    matching(known);
    if(!recoveryOnly){
     // Durable SQL replay validates the entire original selection, including its chain hash.
     // A GET by UUID alone cannot authorize a changed body. Replay never returns a grant.
     const {command_id,confirmed,...selection}=i;
     known=await call('begin',{p_user_id:actor,p_command_id:commandId,p_selection:selection,p_source_validation:known.source_validation,p_confirmed:true},s);
     need(known.replayed===true&&known.execution===null,'RECEIPT_QUERY_REPLAY_INVALID');
     return output(await checkedCommand(actor,commandId,s));
    }
    if(known.artifact||!known.current.grant_consumed)return output(await checkedCommand(actor,commandId,s));
    need(known.current.lease_expired,'55000');uncertain=true;
    handle=await source(actor,known,s);
   }else{
    const selected=await attestedContext(actor,contextInput(i),s);handle=selected.handle;
    const publicContext=projectReceiptQueryContext(selected.view,{action:'receiptQueryContext',input:contextInput(i)},{enabled,verified:true,validation:selected.validation});
    const {command_id,confirmed,...selection}=i;need(publicContext.can_query&&same(publicContext.selection,selection),'40001');
    const request=prepareReceiptQuery({evidence:receiptQuerySource(handle).evidence}),payload=receiptRequestBytes(request);
    try{need((await validateReceiptQueryBytes(validate,request,payload,'request',s)).ok,'RECEIPT_QUERY_PREPARATION_FAILED');}finally{payload.fill(0);}
    // No callback, credential or transport can run before begin returns a fresh execution.
    uncertain=true;try{known=await call('begin',{p_user_id:actor,p_command_id:commandId,p_selection:selection,p_source_validation:selected.validation,p_confirmed:true},s);}catch(e){if(isReceiptQuerySqlFailure(e))uncertain=false;throw e;}
    if(known.execution===null){need(known.replayed===true,'RECEIPT_QUERY_REPLAY_INVALID');matching(known);return output(await checkedCommand(actor,commandId,s));}
    need(!known.replayed&&known.current.state==='prepared'&&!known.current.grant_consumed,'RECEIPT_QUERY_PREPARATION_FAILED');
   }
   const request=prepareReceiptQuery({evidence:receiptQuerySource(handle).evidence}),soap=prepareReviewedReceiptSoap({request});wire=Buffer.from(encodeReviewedReceiptSoap(soap));
   const c=freeze({...known.recovery,request_hash:hash(wire),request_size:wire.length});
   let httpStatus,observationHash,observationSize;
   if(recoveryOnly){
    need(known.recovery.request_hash===c.request_hash&&known.recovery.request_size===c.request_size,'RECEIPT_QUERY_JOURNAL_CONFLICT');
    const saved=await journal.read(receiptQueryPath(c,'requests'),s,{expectedHash:c.request_hash,expectedSize:c.request_size});need(saved!==null,'RECEIPT_QUERY_JOURNAL_MISSING');saved.fill(0);
    const savedResponse=await journal.response(c,s);raw=savedResponse.bytes;({httpStatus,observationHash,observationSize}=savedResponse);
   }else{
    await journal.persist(receiptQueryPath(c,'requests'),wire,s);
    const evidence={...receiptQueryEvidenceBase(c),payload_hash:request.requestHash,signature_verified:true,xsd_validated:true,context_matched:true};
    known=await call('prepare',{...queryArgs(actor,c),p_request_hash:c.request_hash,p_request_size:c.request_size,p_evidence:evidence},s);
    need(same(known.recovery,c)&&known.current.state==='request_ready'&&!known.current.grant_consumed,'RECEIPT_QUERY_PREPARATION_FAILED');
    const end=Math.min(s.deadline-15000,Date.now()+20000,Date.parse(c.expires_at));need(end>Date.now(),'RECEIPT_QUERY_PREPARATION_FAILED');const tls=scope({signal:s.signal,deadline:end},20000);let calls=0,complete=false,closed=false;
    try{
     await tls.bounded(()=>custody({actor,context:c,source:handle,request},async session=>{
      need(!closed&&++calls===1,'RECEIPT_QUERY_CALLBACK_INVALID');
      try{tls.check();s.check();stage='use';useStarted=true;
       const used=await call('use',queryArgs(actor,c),tls);need(!closed,'RECEIPT_QUERY_CALLBACK_INVALID');tls.check();s.check();const {issued_at,...grant}=used.grant;need(same(grant,c),'RECEIPT_QUERY_GRANT_MISMATCH');
       stage='transport';let response,transportProof;
       const pending=Promise.resolve().then(()=>{tls.check();s.check();return transport({request:soap,used},session,{signal:tls.signal,deadline:tls.deadline});});
       try{let received;try{received=await tls.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.response?.body)).catch(()=>{});throw e;}
        const v=data(received,['response','tls']),t=data(v.tls,['origin','protocol','server_identity_verified','server_trust_profile','server_trust_anchor_sha256']);
        need(t.origin==='operational'&&['TLSv1.2','TLSv1.3'].includes(t.protocol)&&t.server_identity_verified===true&&t.server_trust_profile===SP_RECEIPT_QUERY_SERVER_TRUST&&t.server_trust_anchor_sha256===SP_RECEIPT_QUERY_ROOT_HASH,'RECEIPT_QUERY_TRANSPORT_INVALID');transportProof=t;response=v.response;
        need(response instanceof Response&&response.url==='','RECEIPT_QUERY_TRANSPORT_INVALID');httpStatus=response.status;raw=await readBody(response,tls,{statuses:[200,500],types:['application/soap+xml; charset=utf-8']});
       }finally{cancel(response?.body);}
       tls.check();s.check();stage='journal';await journal.persist(receiptQueryPath(c,'responses'),raw,s);
       const meta=Buffer.from(JSON.stringify(receiptQuerySidecar({profile:'receipt-query-journal-089-v1',origin:'operational',...Object.fromEntries(['query_id','nonce','authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','signed_hash','request_hash'].map(k=>[k,c[k]])),response_hash:hash(raw),response_size:raw.length,http_status:httpStatus,received_at:new Date().toISOString(),tls_peer_verified:true,tls_origin_verified:true,tls_protocol:transportProof.protocol,server_trust_profile:transportProof.server_trust_profile,server_trust_anchor_sha256:transportProof.server_trust_anchor_sha256},c,hash(raw),raw.length)));
       try{observationHash=await journal.persist(receiptQueryPath(c,'observations'),meta,s);observationSize=meta.length;}finally{meta.fill(0);}complete=true;
      }catch(e){callbackError=e;throw e;}
     },{signal:tls.signal,deadline:tls.deadline}));tls.check();s.check();if(callbackError)throw callbackError;need(calls===1&&complete&&raw!==null,'RECEIPT_QUERY_CALLBACK_INVALID');
    }finally{closed=true;tls.stop('AUTHORIZATION_SERVICE_ABORTED');tls.close();}
   }
   stage='validate';const checked=await processReceiptQueryResponse({context:c,source:handle,request,bytes:raw,httpStatus,observationHash,observationSize,validate,validateProcessed},s);processed=checked.processed;
   const processedHash=processed?await journal.persist(receiptQueryPath(c,'processed',hash(processed)),processed,s):null;
   stage='finish';const done=await call('finish',{...queryArgs(actor,c),p_response_hash:hash(raw),p_response_size:raw.length,p_observation_hash:observationHash,p_observation_size:observationSize,p_evidence:checked.evidence,p_processed_hash:processedHash,p_processed_size:processed?.length??null},s);
   const final=await checkedCommand(actor,commandId,s);need(same(done.receipt,final.receipt)&&same(done.source,final.source)&&same(done.artifact,final.artifact),'RECEIPT_QUERY_STORED_CHANGED');return output({...final,replayed:done.replayed});
  }catch(error){
   const original=callbackError??error,code=codeOf(original);
   // Explicit denial is final for access: never try a private read, fail or artifact fallback.
   if(code==='42501')throw new ReceiptQueryServiceError(code,commandId,uncertain);
   if(uncertain){
    try{s.check();const current=await checkedCommand(actor,commandId,s);matching(current);
     if(current.artifact)return output(current);
     if(!recoveryOnly&&!useStarted&&current.current.state!=='failed_before_dispatch'){
      const failed=await call('fail',{...queryArgs(actor,current.recovery),p_error_code:stage==='prepare'?'RECEIPT_QUERY_PREPARATION_FAILED':'RECEIPT_QUERY_CUSTODY_FAILED'},s);return output(failed);
     }
    }catch(e){if(codeOf(e)==='42501')throw new ReceiptQueryServiceError('42501',commandId,true);}
   }
   throw new ReceiptQueryServiceError(code,commandId,uncertain);
  }finally{dispose(handle);wire?.fill(0);raw?.fill(0);processed?.fill(0);s.close();running.delete(key);}
 }
 return Object.freeze({context,history,command,
  run(input,options={}){if(!enabled)throw new ReceiptQueryServiceError('AUTHORIZATION_SERVICE_DISABLED');const x=data(input,['actor','request']);need(id(x.actor));const i=captureReceiptQueryRunInput(x.request);return perform(x.actor,i.command_id,i,options,false);},
  recover(input,options={}){const x=data(input,['actor','commandId','confirmed']);need(id(x.actor)&&id(x.commandId)&&x.confirmed===true);return perform(x.actor,x.commandId,null,options,true);}
 });
}
