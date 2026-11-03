/** Reauthorizes one already prepared089 query before opening its captured041 envelope. */
import {data,need,id,hash,scope,freeze} from './service-common.mjs';
import {same} from './service-dto.mjs';
import {receiptQueryRecovery,projectReceiptQueryLedger} from './receipt-query-ledger-dto.mjs';
import {receiptQuerySource} from './receipt-query-source.mjs';
import {assertReceiptQueryEvidence} from './receipt-core.mjs';
import {prepareReviewedReceiptSoap,encodeReviewedReceiptSoap} from './receipt-soap-binding.mjs';
export function captureReceiptQueryPreparation(raw){
 const v=data(raw,['actor','context','source','request']),c=receiptQueryRecovery(v.context),s=receiptQuerySource(v.source);
 need(id(v.actor)&&v.actor===c.actor&&c.purpose==='sp-receipt-query-homologation-v1'&&c.request_hash!==null,'RECEIPT_QUERY_PREPARATION_INVALID');
 const source=s.source;need(['source_kind','source_command_id','authorization_command_id','authorization_attempt_id','candidate_id','candidate_version','signed_hash','signed_size','model','environment','origin','source_binding_hash'].every(k=>source[k]===c[k]),'RECEIPT_QUERY_PREPARATION_CHANGED');
 assertReceiptQueryEvidence({evidence:s.evidence,request:v.request});
 const soap=prepareReviewedReceiptSoap({request:v.request}),bytes=encodeReviewedReceiptSoap(soap);
 try{need(hash(bytes)===c.request_hash&&bytes.length===c.request_size&&soap.binding.profile===c.policy.binding_profile,'RECEIPT_QUERY_PREPARATION_CHANGED');}finally{bytes.fill(0);}
 return Object.freeze({actor:v.actor,context:c,source:v.source,request:v.request});
}
export function createReceiptQueryPreparationAuthorizer(configuration){
 const p=data(configuration,['rpc']);need(typeof p.rpc==='function');const rpc=p.rpc;
 return async(raw,options)=>{
  const v=captureReceiptQueryPreparation(raw),c=v.context,s=scope(options,20000);
  const call=async(action,args)=>{const out=await s.bounded(()=>rpc(action,freeze(args),{signal:s.signal,deadline:s.deadline}));s.check();return projectReceiptQueryLedger(action,out,args);};
  try{
   need(Date.now()<Date.parse(c.expires_at),'RECEIPT_QUERY_LEASE_EXPIRED');
   const known=await call('command',{p_user_id:v.actor,p_command_id:c.query_id});
   need(known.current.state==='request_ready'&&!known.current.grant_consumed&&same(known.recovery,c),'RECEIPT_QUERY_PREPARATION_CHANGED');
   const fresh=await call('context',{p_user_id:v.actor,p_source_kind:c.source_kind,p_source_command_id:c.source_command_id,p_expected_attempt_id:c.authorization_attempt_id});
   need(same(fresh.source,receiptQuerySource(v.source).source)&&same(fresh.policy,c.policy)&&fresh.heads.identity_version===c.identity_version&&fresh.heads.a1_version===c.a1_version&&fresh.resolution.state==='pending','RECEIPT_QUERY_PREPARATION_CHANGED');
   // These describe this query itself in a read context. SQL use excludes itself
   // and authoritatively rechecks predecessors, cadence, current heads and lease.
   need(fresh.blockers.every(k=>['SOURCE_VALIDATION_REQUIRED','QUERY_ACTIVE','CADENCE_REQUIRED','RATE_LIMIT'].includes(k)),'RECEIPT_QUERY_PREPARATION_CHANGED');
   s.check();need(Date.now()<Date.parse(c.expires_at),'RECEIPT_QUERY_LEASE_EXPIRED');return c;
  }finally{s.stop('AUTHORIZATION_SERVICE_ABORTED');s.close();}
 };
}
