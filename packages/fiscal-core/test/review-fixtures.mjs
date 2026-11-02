import {normalizeDocument} from '../../erp-domain/src/index.mjs';
const FISCAL_DRAFT_PENDING=['TAX_REVIEW_REQUIRED','CATALOG_SNAPSHOTS_REQUIRE_REVIEW','RECIPIENT_FISCAL_MAPPING_REQUIRED','ITEM_FISCAL_MAPPING_REQUIRED','PAYMENT_FISCAL_MAPPING_REQUIRED','FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED','TRANSPORT_UNAVAILABLE','HOMOLOGATION_NOT_PERFORMED'];
export const reviewIds={draft:'a0000000-0000-4000-8000-000000000001',order:'b0000000-0000-4000-8000-000000000001',contact:'c0000000-0000-4000-8000-000000000001',product:'d0000000-0000-4000-8000-000000000001',item:'e0000000-0000-4000-8000-000000000001'};
export function reviewBasis({model='55',item={},product={},free=false,itemCount=1}={}){
 const p={id:reviewIds.product,version:1,name:'Produto sintético',code:'FICT-1',unit:'UN',kind:'P',format:'S',ncm:'00000000',gtin:'SEM GTIN',...product};
 const n=normalizeDocument('sales_orders',{date:'2026-10-16',contact_id:reviewIds.contact,items:Array.from({length:itemCount},(_,index)=>({id:'e0000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),product_id:free?null:p.id,description:'Produto sintético',code:'FICT-1',unit:'UN',quantity:'1.230000',unit_price:'10.0000',discount_percent:'0',...item}))});
 const snapshot={catalog_basis:'document_snapshot',document_id:reviewIds.order,document_version:1,kind:'sales_orders',number:'1',status:'draft',date:n.date,contact_id:reviewIds.contact,
  contact:{id:reviewIds.contact,version:1,name:'Contato sintético',person_type:'J',document:'11222333000181',ie:null,postal_code:'13400000',street:'Rua exemplo',number:'1',complement:null,district:'Centro',city:'Piracicaba',state:'SP'},
  items:n.items.map(i=>({...i,product:free?null:p})),discount_mode:n.discount_mode,discount_value:n.discount_value,totals:n.totals,installments:n.installments,notes:n.notes,payment_terms:n.payment_terms,delivery_terms:n.delivery_terms,company:null};
 const pending=[...FISCAL_DRAFT_PENDING.slice(0,10),'COMPANY_IDENTITY_MISSING','REGIME_UNCONFIRMED','PAYMENT_PLAN_MISSING'];
 if(free)pending.push('ITEM_WITHOUT_CATALOG_LINK','ITEM_KIND_REQUIRES_REVIEW','ITEM_NCM_MISSING');
 else{if(p.kind!=='P')pending.push('ITEM_KIND_REQUIRES_REVIEW');if(!p.ncm)pending.push('ITEM_NCM_MISSING');}
 return{draft:{data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,record:{id:reviewIds.draft,model,environment:'2',status:'draft',version:1,source_document_id:reviewIds.order,source_document_version:1,
  snapshot,snapshot_hash:'a'.repeat(64),preparation:{operation_nature:'Venda fictícia',notes:null},created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z',archived_at:null,archive_reason:null},
  current:{version:1,status:'draft',source_document_version:1,source_status:'draft',identity_version:null,fiscal_version:null,source_changed:false,company_changed:false},pending},
  catalog:free?[]:[{product_id:p.id,record:{...p,active:true,origin:'0',cest:'1234567',gtin_tax:'SEM GTIN'}}],observed_at:'2026-10-16T12:00:00Z'};
}
