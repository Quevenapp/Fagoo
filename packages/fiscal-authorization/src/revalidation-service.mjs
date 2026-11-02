/**079 computes a new append-only observation. No custody, grant, authorization or receipt-query transport. */
import {data,need,id,hash,copy,scope,cancel} from './service-common.mjs';
import {readBounded} from '../../fiscal-authorization-http/src/protocol.mjs';
import {isRevalidationSqlFailure} from './revalidation-rpc.mjs';
import {same,SQLSTATES,resultEvidence} from './service-dto.mjs';
import {captureRevalidationInput,REVALIDATION_PROFILE,REVALIDATION_PARSER_HASH} from './revalidation-public-dto.mjs';
import {captureRevalidationRpc,projectRevalidationLedger,revalidationSource,revalidationPublicFromLedger} from './revalidation-dto.mjs';
export class AuthorizationRevalidationError extends Error{
 constructor(code,commandId=null,recoveryRequired=false){super(code);this.name='AuthorizationRevalidationError';this.code=code;this.command_id=commandId;this.recovery_required=recoveryRequired;}
}
const codeOf=e=>{try{const d=Object.getOwnPropertyDescriptor(e,'code');return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&(SQLSTATES.includes(d.value)||/^AUTHORIZATION_[A-Z_]{1,90}$/.test(d.value))?d.value:'AUTHORIZATION_REVALIDATION_FAILED';}catch{return'AUTHORIZATION_REVALIDATION_FAILED';}};
const keyOf=r=>`revalidations/${r.attempt_id}/${r.parser_manifest_hash}/processed/${r.processed_hash}.xml`;
const required=(condition,code='AUTHORIZATION_REVALIDATION_SOURCE_CHANGED')=>need(condition,code);
const erase=v=>{try{Uint8Array.prototype.fill.call(v,0);}catch{}};
const eraseLate=v=>{try{const d=Object.getOwnPropertyDescriptor(v,'processedBytes');if(d&&Object.hasOwn(d,'value'))erase(d.value);}catch{}};
export function createAuthorizationRevalidationService(configuration){
 const p=data(configuration,['rpc','readStoredResponse','storage']),storage=data(p.storage,['read','putImmutable']);need(typeof p.rpc==='function'&&typeof p.readStoredResponse==='function'&&typeof storage.read==='function'&&typeof storage.putImmutable==='function');
 const {rpc,readStoredResponse}=p,{read,putImmutable}=storage;
 const call=async(action,args,s)=>{const captured=captureRevalidationRpc(action,args);const raw=await s.bounded(()=>rpc(action,captured,{signal:s.signal,deadline:s.deadline}));s.check();return projectRevalidationLedger(action,raw,captured);};
 const readProcessed=async(r,s)=>{
  if(r.processed_hash===null)return;let response,bytes;
  const pending=Promise.resolve().then(()=>{s.check();return read({bucket:'fagoo-fiscal-artifacts',key:keyOf(r),signal:s.signal,deadline:s.deadline});});
  try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}
   required(response!==null,'AUTHORIZATION_REVALIDATION_PROCESSED_MISSING');required(response instanceof Response&&!response.redirected&&response.status===200&&response.headers.get('content-type')==='application/octet-stream','AUTHORIZATION_REVALIDATION_STORAGE_INVALID');bytes=await readBounded(response,512000,s);required(bytes.length===r.processed_size&&hash(bytes)===r.processed_hash,'AUTHORIZATION_REVALIDATION_PROCESSED_MISMATCH');s.check();
  }finally{bytes?.fill(0);cancel(response?.body);}
 };
 const query=async(actor,commandId,s)=>call('command',{p_user_id:actor,p_command_id:commandId},s);
 const checkedCommand=async(actor,commandId,s)=>{const v=await query(actor,commandId,s);await readProcessed(v.receipt,s);const after=await query(actor,commandId,s);required(same(v,after));return after;};
 const matchesInput=(v,i)=>required(v.command_id===i.command_id&&v.receipt.authorization_command_id===i.authorization_command_id&&v.receipt.attempt_id===i.expected_attempt_id&&v.receipt.source_hash===i.expected_source_hash,'40001');
 const runBinding=i=>({action:'revalidationRun',commandId:i.command_id,input:i});
 async function command(input,options={}){
  const x=data(input,['actor','commandId']);need(id(x.actor)&&id(x.commandId));const s=scope(options);
  try{const v=await checkedCommand(x.actor,x.commandId,s);s.check();return revalidationPublicFromLedger(v,{action:'revalidationCommand',commandId:x.commandId});}
  catch(e){throw new AuthorizationRevalidationError(codeOf(e),x.commandId,false);}finally{s.close();}
 }
 async function context(input,options={}){
  const x=data(input,['actor','authorizationCommandId','expectedAttemptId']);need(id(x.actor)&&id(x.authorizationCommandId)&&id(x.expectedAttemptId));const s=scope(options),args={p_user_id:x.actor,p_authorization_command_id:x.authorizationCommandId,p_expected_attempt_id:x.expectedAttemptId};
  try{let v=await call('context',args,s);if(v.existing){await readProcessed(v.existing.receipt,s);const next=await call('context',args,s);required(same(v,next));v=next;}s.check();return revalidationPublicFromLedger(v,{action:'revalidationContext',authorizationCommandId:x.authorizationCommandId,expectedAttemptId:x.expectedAttemptId});}
  catch(e){throw new AuthorizationRevalidationError(codeOf(e));}finally{s.close();}
 }
 async function revalidate(input,options={}){
  const x=data(input,['actor','request']);need(id(x.actor));const i=captureRevalidationInput(x.request),s=scope(options);let processed=null,readerBytes=null,readerResult=null,uncertain=false;
  const contextArgs={p_user_id:x.actor,p_authorization_command_id:i.authorization_command_id,p_expected_attempt_id:i.expected_attempt_id};
  const replay=async v=>{matchesInput(v,i);await readProcessed(v.receipt,s);const checked=await query(x.actor,i.command_id,s);required(same(v,checked));return revalidationPublicFromLedger({...checked,read_only:false,replayed:true},runBinding(i));};
  try{
   // GET first. A missing command never grants transmission; only this caller's
   // captured, deliberate revalidation may compute and append a new observation.
   let previous;try{previous=await query(x.actor,i.command_id,s);}catch(e){if(codeOf(e)!=='P0002')throw e;}if(previous)return await replay(previous);
   const before=await call('context',contextArgs,s);required(before.source_hash===i.expected_source_hash,'40001');
   if(before.existing)return await replay(before.existing);
   const pending=Promise.resolve().then(()=>{s.check();return readStoredResponse({actor:x.actor,authorizationCommandId:i.authorization_command_id},{signal:s.signal,deadline:s.deadline});});let raw;
   try{raw=await s.bounded(()=>pending);readerResult=raw;s.check();}catch(e){eraseLate(raw);void pending.then(eraseLate).catch(()=>{});throw e;}
   const captured=data(raw,['source','validation','processedBytes']);readerBytes=captured.processedBytes;
   const source=revalidationSource(captured.source,contextArgs);required(same(source,before.source));
   const v=data(captured.validation,['parser_profile','parser_manifest_hash','evidence','signed_hash','signed_size','response_size','processed_hash','processed_size','tax_rules_validated']);
   required(v.parser_profile===REVALIDATION_PROFILE&&v.parser_manifest_hash===REVALIDATION_PARSER_HASH&&v.signed_hash===source.receipt.signed_hash&&v.signed_size===source.receipt.signed_size&&v.response_size===source.artifact.response_size&&v.tax_rules_validated===false);
   const evidence=resultEvidence(v.evidence,{origin:'operational',request_hash:source.recovery.request_hash,response_hash:source.artifact.response_hash,binding_profile:source.recovery.binding_profile,rule_profile:source.recovery.rule_profile,transport_hash:source.observation.sha256,transport_size:source.observation.size_bytes});
   required(evidence.outcome!=='authorization_declared'||evidence.reference_digest===source.recovery.reference_digest);
   const args=captureRevalidationRpc('finish',{p_user_id:x.actor,p_command_id:i.command_id,p_authorization_command_id:i.authorization_command_id,p_expected_attempt_id:i.expected_attempt_id,p_expected_source_hash:i.expected_source_hash,p_parser_profile:v.parser_profile,p_parser_manifest_hash:v.parser_manifest_hash,p_evidence:evidence,p_processed_hash:v.processed_hash,p_processed_size:v.processed_size,p_confirmed:true});
   if(v.processed_hash!==null){processed=copy(readerBytes);required(processed.length===v.processed_size&&hash(processed)===v.processed_hash,'AUTHORIZATION_REVALIDATION_PROCESSED_MISMATCH');}else required(readerBytes===null,'AUTHORIZATION_REVALIDATION_PROCESSED_MISMATCH');
   const fresh=await call('context',contextArgs,s);required(fresh.source_hash===before.source_hash&&same(fresh.source,source));if(fresh.existing)return await replay(fresh.existing);
   if(processed){
    const receipt={attempt_id:i.expected_attempt_id,parser_manifest_hash:v.parser_manifest_hash,processed_hash:v.processed_hash,processed_size:v.processed_size},writing=Buffer.from(processed);
    try{const ack=await s.bounded(()=>putImmutable({bucket:'fagoo-fiscal-artifacts',key:keyOf(receipt),bytes:writing,sha256:v.processed_hash,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));s.check();const a=data(ack,['status','requires_readback']);required([200,201,409].includes(a.status)&&a.requires_readback===true&&hash(writing)===v.processed_hash,'AUTHORIZATION_REVALIDATION_STORAGE_INVALID');}
    finally{writing.fill(0);}
    await readProcessed(receipt,s);
   }
   // Exactly one finish invocation per call. Once its outcome is uncertain,
   // later SQL/read errors cannot turn that uncertainty into an authoritative rollback.
   let done;try{done=await call('finish',args,s);}catch(e){
    if(isRevalidationSqlFailure(e))throw e;uncertain=true;
    try{const recovered=await checkedCommand(x.actor,i.command_id,s);matchesInput(recovered,i);required(same(recovered.source,source)&&same(recovered.receipt.evidence,evidence)&&recovered.receipt.processed_hash===v.processed_hash&&recovered.receipt.processed_size===v.processed_size);return revalidationPublicFromLedger({...recovered,read_only:false,replayed:true},runBinding(i));}catch(readError){throw readError;}
   }
   uncertain=true;const after=await query(x.actor,i.command_id,s);required(same(done.source,after.source)&&same(done.receipt,after.receipt));s.check();return revalidationPublicFromLedger(done,runBinding(i));
  }catch(e){throw new AuthorizationRevalidationError(codeOf(e),i.command_id,uncertain);}
  finally{processed?.fill(0);erase(readerBytes);eraseLate(readerResult);s.close();}
 }
 return Object.freeze({context,revalidate,command});
}
