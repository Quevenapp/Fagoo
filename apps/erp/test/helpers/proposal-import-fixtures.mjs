import {calculateDocument} from '../../../../packages/erp-domain/src/index.mjs';
export const actor='a0000000-0000-4000-8000-000000000001',contact='b0000000-0000-4000-8000-000000000001',product='b0000000-0000-4000-8000-000000000002',document='c0000000-0000-4000-8000-000000000001',item='d0000000-0000-4000-8000-000000000001';
export const time='2026-10-16T12:00:00.123456+00:00',hash='a'.repeat(64),previewHash='b'.repeat(64),BASE='/v1/importacao-orcamentos-origin';
export const flags={data_mode:'proposal_import_review',policy:'origin-open-proposal-v1',entity:'sales_proposals',creates_draft:true,stock_effects:false,financial_effects:false,fiscal_effects:false,coverage_certified:false,cutoff_at:null};
export const source=(id='9520000001')=>({source_id:id,source_hash:hash,source_version:'9223372036854775807',source_seen_at:time,source_number:'52',source_status:'Pendente'});
export const row=(id='9520000001')=>({...source(id),document_id:null,requires_preview:true});
export function page(rows=[row()],after=null){const visible=rows.filter(x=>after===null||x.source_id>after).slice(0,26),items=visible.slice(0,25),has_more=visible.length>25;return{...flags,read_only:true,items,limit:25,has_more,next_cursor:has_more?items.at(-1).source_id:null};}
export function preview(id='9520000001'){
 const line={id:null,product_id:product,description:'Produto sintético',code:'QA-052',unit:'UN',quantity:'2.000000',unit_price:'12.8500',discount_percent:'0.0000',position:1};
 const proposed={date:'2026-10-16',contact_id:contact,warehouse_id:null,expected_date:null,valid_until:null,next_contact:null,template:false,discount_mode:'amount',discount_value:'0.00',freight:'0.00',other_expenses:'1.01',notes:'Texto\ncomercial',internal_notes:'Nota interna sintética',payment_terms:null,delivery_terms:null,equipment:null,serial_number:null,technician:null,defect:null,solution:null,items:[line],installments:[{position:1,due_date:'2026-11-15',amount:'26.71',method:null}]};
 proposed.totals=calculateDocument(proposed);Object.assign(line,proposed.totals.items[0]);
 const binding=(entity,id,source_id,name,unit)=>({entity,source_id,record_id:id,record_version:1,name,unit,active:true,human_edited:false,origin_state:'synced',candidate_pending:false,applied_hash:hash,latest_hash:hash,source_hash:hash,source_version:'1',valid:true});
 return{...flags,...source(id),source_changed_at:time,dry_run:true,persisted:false,preview_hash:previewHash,can_apply:true,issues:[],bindings:[binding('contacts',contact,'9521000001','Contato sintético',null),{...binding('products',product,'9521000002','Produto sintético','UN'),position:1}],warnings:['SOURCE_FRESHNESS_NOT_CERTIFIED','MANUAL_DUPLICATES_NOT_DETECTABLE','NATIVE_NUMBER_ASSIGNED_ON_APPLY'],proposed,existing:null};
}
export function ack(body,p=preview(body.source_id)){
 return{...flags,dry_run:false,persisted:true,replayed:false,receipt:{command_id:body.command_id,entity:'sales_proposals',...source(body.source_id),preview_hash:body.preview_hash,duplicate_reviewed:true,imported_at:time,document:{id:document,kind:'sales_proposals',number:'1',version:1,status:'draft',date:p.proposed.date,total:p.proposed.totals.total,contact_id:contact,contact_name:'Contato sintético',created_at:time,updated_at:time}}};
}
export function current(a,p=preview(a.receipt.source_id)){
 return{...flags,read_only:true,receipt:structuredClone(a.receipt),current_document:{...structuredClone(p.proposed),...a.receipt.document,source_proposal_id:null,effect_flags:{finance_active:false,stock_active:false},contact_snapshot:{id:contact,version:1,name:'Contato sintético'},items:p.proposed.items.map(line=>({...line,id:item,product_snapshot:{id:product,version:1,name:'Produto sintético',code:'QA-052',unit:'UN',price:'12.8500',kind:'P',format:'S'}}))}};
}
export const state=()=>({phase:'ready',membership:{user_id:actor,role:'admin',resources:['sales_proposals'],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false});
