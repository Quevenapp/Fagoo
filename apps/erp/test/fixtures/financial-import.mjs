import{financialRow,financialPage,financialFilters}from'./financial-cutover.mjs';
export{financialRow,financialPage,financialFilters};
export const importFlags={data_mode:'financial_import_review',policy:'origin-open-unique-v1',creates_titles:true,cutoff_at:null,coverage_certified:false,settles_titles:false,changes_cash_balance:false,bank_actions:false};
export const importCommand='30000000-0000-4000-8000-000000000001';
export const importCategory={id:'40000000-0000-4000-8000-000000000001',name:'Categoria sintética',version:3,kind:'both',active:true};
export const importRequest=(rows=[financialRow()])=>({entity:rows[0].entity,duplicate_reviewed:true,items:rows.map(r=>({source_id:r.source_id,source_hash:r.source_hash,source_version:r.source_version,source_seen_at:r.observed_at,category_id:null,category_version:null}))});
export const applyRequest=request=>({...request,command_id:importCommand,preview_hash:'b'.repeat(64),confirm_import:true});
export function importPreview(request=importRequest(),amount='12345'){
 const items=request.items.map(i=>({source_id:i.source_id,source_hash:i.source_hash,source_version:i.source_version,source_seen_at:i.source_seen_at,status:'eligible',blockers:[],evidence:{status_code:'1',amount_cents:amount,balance_cents:amount,occurrence_type:'1',contact_source_id:'00099',refresh_finished_at:'2026-10-16T14:50:00Z'},proposed:{kind:request.entity==='receivables'?'receivable':'payable',contact_id:'11111111-1111-4111-8111-111111111111',contact_version:2,contact_name:'Contato exclusivamente sintético',category_id:i.category_id,category_version:i.category_version,category_name:i.category_id?importCategory.name:null,description:'Título sintético para conferência',source_reference:`Origin ${request.entity==='receivables'?'AR':'AP'} ${i.source_id}`,issued_on:'2026-10-10',due_on:'2026-10-31',amount_cents:amount,settled_cents:'0',installment:1,installments:1},existing:null}));
 return{...importFlags,dry_run:true,persisted:false,entity:request.entity,duplicate_reviewed:true,preview_hash:'b'.repeat(64),valid_until:'2026-10-16T15:50:00Z',can_apply:true,items,summary:{selected:items.length,eligible:items.length,blocked:0,total_cents:(BigInt(amount)*BigInt(items.length)).toString()}};
}
export function importAck(request=applyRequest(importRequest()),preview=importPreview(request)){
 const items=preview.items.map((i,index)=>({source_id:i.source_id,title_id:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,source_hash:i.source_hash,source_version:i.source_version,source_seen_at:i.source_seen_at,refresh_finished_at:i.evidence.refresh_finished_at,...Object.fromEntries(['contact_id','contact_version','category_id','category_version','kind','description','source_reference','issued_on','due_on','amount_cents'].map(k=>[k,i.proposed[k]]))}));
 return{...importFlags,dry_run:false,persisted:true,replayed:false,batch:{id:request.command_id,entity:request.entity,created_at:'2026-10-16T15:00:00Z',preview_hash:request.preview_hash,duplicate_reviewed:true,items,total_cents:preview.summary.total_cents}};
}
export function importBatch(ack=importAck()){
 return{...importFlags,read_only:true,batch:structuredClone(ack.batch),current_titles:ack.batch.items.map(i=>({id:i.title_id,version:1,kind:i.kind,contact_id:i.contact_id,category_id:i.category_id,description:i.description,source_reference:i.source_reference,issued_on:i.issued_on,due_on:i.due_on,amount_cents:i.amount_cents,settled_cents:'0',balance_cents:i.amount_cents,cancelled:false,status:'open'}))};
}
