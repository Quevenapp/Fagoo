import * as v1 from './proposal-import-fixtures.mjs';
export {actor,contact,product,document,item,time,hash,previewHash,source,row,state} from './proposal-import-fixtures.mjs';
export const BASE='/v1/importacao-orcamentos-origin-v2',POLICY='origin-open-proposal-v2',flags={...v1.flags,policy:POLICY};
export const page=(rows,after)=>({...v1.page(rows,after),...flags});
export function preview(id){
 const p={...v1.preview(id),...flags},b=p.proposed;
 b.commercial={introduction:'Introdução sintética\nSegunda linha',attention_to:'Setor sintético',seller_reference:{system:'origin',source_id:'9555000001',label:'Vendedor declarado'},store_reference:null,business_unit_reference:null,transport:{freight_mode:'0',volume_count:'2.000000',gross_weight:'0.125000',delivery_days:'3',carrier_reference:null,service_reference:null,tracking_code:'QA-SEM-URL'}};
 b.items[0].detailed_description='Detalhe sintético <literal>';
 b.installments[0].note='Nota da parcela';b.installments[0].payment_reference={system:'origin',source_id:'9555000002',label:'Forma declarada'};
 p.source_evidence={schema_version:1,price_basis:'source_net',discount_semantics:'original_line_unit_unspecified',products_total:b.totals.gross,global_discount_observed:b.discount_value,freight:b.freight,other_expenses:b.other_expenses,total:b.totals.total,items:b.items.map(x=>({position:x.position,quantity:x.quantity,unit_price:x.unit_price,discount_observed:'5.000000',discount_unit:'unspecified'})),next_contact:{state:'zero_date',value:'0000-00-00'}};
 p.transformations=['UNIT_PRICES_ARE_SOURCE_NET','SOURCE_LINE_DISCOUNTS_NOT_REAPPLIED','GLOBAL_DISCOUNT_RECONCILED_AS_AMOUNT','EXTERNAL_REFERENCES_ARE_UNLINKED','ZERO_NEXT_CONTACT_PRESERVED_AS_UNSPECIFIED'];return p;
}
export function ack(body,p=preview(body.source_id)){const a=v1.ack(body,p);return{...a,...flags,receipt:{...a.receipt,policy:POLICY}};}
export function current(a,p=preview(a.receipt.source_id)){const c=v1.current(a,p);return{...c,...flags,historical_evidence:{source_evidence:structuredClone(p.source_evidence),normalized_body:structuredClone(p.proposed),transformations:[...p.transformations],item_links:[{source_position:1,native_item_id:v1.item}]}};}
export function originMetadata(policy=POLICY){return{data_mode:'erp_native',read_only:true,document_id:v1.document,kind:'sales_proposals',origin:{system:'origin',entity:'sales_proposals',source_id:'9520000001',source_number:'52',source_hash:v1.hash,source_version:'9223372036854775807',command_id:'f0000000-0000-4000-8000-000000000001',imported_at:v1.time,policy}};}
export function blocked(p,issues){return{...p,can_apply:false,proposed:null,source_evidence:null,transformations:[],issues};}
