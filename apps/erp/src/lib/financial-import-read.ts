import {checkedFinancialImportAck,checkedFinancialImportBatch,financialImportBatchPath,type FinancialImportAck,type FinancialImportApply,type FinancialImportBatch,type FinancialImportPreview} from './financial-import-model.ts';

function invalid():never{throw new Error('financial_import_invalid_response');}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const asAck=(v:Record<string,unknown>)=>({data_mode:v.data_mode,policy:v.policy,creates_titles:v.creates_titles,cutoff_at:v.cutoff_at,coverage_certified:v.coverage_certified,settles_titles:v.settles_titles,changes_cash_balance:v.changes_cash_balance,bank_actions:v.bank_actions,dry_run:false,persisted:true,replayed:false,batch:v.batch});
/** An authenticated batch read is authoritative without a local POST. The derived
 * request is used only to reuse the closed receipt validator, never to submit. */
export function checkedStoredFinancialImportBatch(raw:unknown,commandId:string):FinancialImportBatch{
 financialImportBatchPath(commandId);
 if(!object(raw)||!object(raw.batch)||raw.batch.id!==commandId||!Array.isArray(raw.batch.items)||raw.batch.items.length<1||raw.batch.items.length>25)invalid();
 const b=raw.batch;
 const request={command_id:commandId,entity:b.entity,preview_hash:b.preview_hash,confirm_import:true,duplicate_reviewed:true,items:(b.items as unknown[]).map(value=>{
  if(!object(value))invalid();
  return{source_id:value.source_id,source_hash:value.source_hash,source_version:value.source_version,source_seen_at:value.source_seen_at,category_id:value.category_id,category_version:value.category_version};
 })} as FinancialImportApply;
 const ack=checkedFinancialImportAck(asAck(raw),request);
 return checkedFinancialImportBatch(raw,request,ack);
}

/** Recovery additionally binds the permanent receipt to the exact local intent
 * and reviewed proposal. A successful GET needs no repeated apply. */
export function checkedRecoveredFinancialImportBatch(raw:unknown,request:FinancialImportApply,preview:FinancialImportPreview,ack:FinancialImportAck|null):FinancialImportBatch{
 const batch=checkedStoredFinancialImportBatch(raw,request.command_id);
 const observed=checkedFinancialImportAck(asAck(batch),request,preview);
 return checkedFinancialImportBatch(batch,request,ack??observed);
}
