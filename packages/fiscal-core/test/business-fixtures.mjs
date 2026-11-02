// Only fictional domain data. No real company, XML, banking or certificate material.
import { normalizeDocument } from '../../erp-domain/src/index.mjs';
import { cnpjCheckDigits } from '../src/identity.mjs';
import { ITEM_PREPARATION_FLAGS } from '../src/item-preparation.mjs';
import { TAX_PREPARATION_FLAGS, resolveTaxItems } from '../src/tax-preparation.mjs';
import { TOTAL_FIELDS } from '../src/business-document.mjs';
export const businessIds={draft:'a0000000-0000-4000-8000-000000000001',order:'b0000000-0000-4000-8000-000000000001',contact:'c0000000-0000-4000-8000-000000000001',product:'d0000000-0000-4000-8000-000000000001'};
export const TEST_HOLDER='990000000001'+cnpjCheckDigits('990000000001');
export const TEST_RECIPIENT='880000000001'+cnpjCheckDigits('880000000001');
const money=n=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
export function refreshTaxProof(input) {
  const old=input.taxPreparation.record.items;
  input.taxPreparation.record.items=resolveTaxItems({model:input.draft.record.model,items:old.map(v=>({item_id:v.item_id,position:v.position,product_id:v.product_id,identifiers:v.identifiers})),decisions:old.map(v=>v.decisions)});
}
export function businessFixture({model='55',csosn='102',count=1,quantity='1.250000',unit_price='10.0000',discount='0.00',freight='0.00',other='0.00'}={}) {
  const id=businessIds,product={id:id.product,version:1,name:'Produto fictício',code:'FICT-001',unit:'UN',kind:'P',format:'S',ncm:'82032090',gtin:'SEM GTIN'};
  const doc=normalizeDocument('sales_orders',{date:'2026-10-16',contact_id:id.contact,
    items:Array.from({length:count},(_,n)=>({id:'e0000000-0000-4000-8000-'+String(n+1).padStart(12,'0'),product_id:id.product,description:'PRODUTO FICTICIO & TESTE',code:'FICT-'+(n+1),unit:'UN',quantity,unit_price,discount_percent:'0'})),
    discount_mode:'amount',discount_value:discount,freight,other_expenses:other});
  const contact={id:id.contact,version:1,name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,ie:null,postal_code:'13400000',street:'RUA FICTICIA',number:'1',complement:null,district:'CENTRO',city:'PIRACICABA',state:'SP'};
  const company={identity_version:1,fiscal_version:1,crt:'1',regime_confirmed:true,identity:{legal_name:'EMPRESA FICTICIA SEM VALOR FISCAL',trade_name:null,cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',complement:null,district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}};
  const snapshot={catalog_basis:'document_snapshot',document_id:id.order,document_version:1,kind:'sales_orders',number:'1',status:'open',date:doc.date,contact_id:id.contact,contact,
    items:doc.items.map(v=>({...v,product})),discount_mode:doc.discount_mode,discount_value:doc.discount_value,totals:doc.totals,installments:doc.installments,notes:doc.notes,payment_terms:doc.payment_terms,delivery_terms:doc.delivery_terms,company};
  const draft={data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false,record:{id:id.draft,model,environment:'2',status:'draft',version:1,source_document_id:id.order,source_document_version:1,
    snapshot,snapshot_hash:'a'.repeat(64),preparation:{operation_nature:'VENDA FICTICIA',notes:null},created_at:'2026-10-16T12:00:00Z',updated_at:'2026-10-16T12:00:00Z',archived_at:null,archive_reason:null},
    current:{version:1,status:'draft',source_document_version:1,source_status:'open',identity_version:1,fiscal_version:1,source_changed:false,company_changed:false},pending:[]};
  const headers={draft_id:id.draft,version:1,draft_version:1,snapshot_hash:'a'.repeat(64),model,environment:'2',source_document_id:id.order,source_document_version:1,created_at:'2026-10-16T12:00:00Z'};
  const identifiers={ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'};
  const itemPreparation={data_mode:'fiscal_item_preparation',profile:'item-identification-v1',schema_profile:'pl010f-v1.04',...ITEM_PREPARATION_FLAGS,
    record:{...headers,items:snapshot.items.map(v=>({item_id:v.id,position:v.position,product_id:v.product_id,fields:Object.fromEntries(Object.entries(identifiers).map(([k,value])=>[k,{value,provenance:{source:'manual'},check_digit_verified:false}])),pending:[]}))},
    current:{preparation_version:1,draft_version:1,matches_current_draft:true}};
  const taxPreparation={data_mode:'fiscal_tax_preparation',profile:'sn-internal-sale-preparation-v1',schema_profile:'pl010f-v1.04',...TAX_PREPARATION_FLAGS,
    record:{...headers,item_preparation_version:1,operation:'internal_normal_sale',crt:'1',company_identity_version:1,company_fiscal_version:1,
      items:snapshot.items.map(v=>({item_id:v.id,position:v.position,product_id:v.product_id,identifiers:{...identifiers},decisions:{item_id:v.id,cfop:csosn==='500'?'5405':'5102',
        icms:csosn==='102'?{csosn}:csosn==='101'?{csosn,credit_rate:'4.00',credit_period:'2026-10',credit_evidence:'BASE FICTICIA A CONFERIR'}:{csosn,retention:{base:null,rate:null,substitute_icms:null,retained_icms:null},fcp:{base:null,rate:null,amount:null},effective:{reduction_rate:null,base:null,rate:null,amount:null}},
        pis:{cst:'49',base:v.gross,rate:'0.00',amount:'0.00'},cofins:{cst:'49',base:v.gross,rate:'0.00',amount:'0.00'},review_note:'ESCOLHA EXCLUSIVAMENTE SINTETICA'}}))},
    current:{tax_version:1,draft_version:1,item_preparation_version:1,draft_status:'draft',source_status:'open',source_changed:false,company_changed:false,matches_current_draft:true,matches_current_item_preparation:true}};
  const totals=Object.fromEntries(TOTAL_FIELDS.map(k=>[k,'0.00']));Object.assign(totals,{vProd:doc.totals.gross,vDesc:doc.totals.discount,vFrete:doc.totals.freight,vOutro:doc.totals.other_expenses,vNF:doc.totals.total});
  const completion={identity:{series:'1',number:'1',cNF:'12345678',issuedAt:'2026-10-16T09:00:00-03:00'},operation:{tpNF:'1',idDest:'1',finNFe:'1',indFinal:'1',indPres:'1'},recipient:{municipality_code:'3538709',indIEDest:'9'},
    items:snapshot.items.map((v,n)=>({item_id:v.id,tributary:{unit:v.unit,quantity:v.quantity,unit_price:v.unit_price},allocations:{global_discount:n===0?discount:'0.00',freight:n===0?freight:'0.00',other:n===0?other:'0.00'},cest_absence:'omit',
      icms:{credit:csosn==='101'?{base:v.gross,amount:money((BigInt(v.gross.replace('.',''))*4n+50n)/100n)}:null,groups500:csosn==='500'?{retention:'omit',fcp:'omit',effective:'omit'}:null}})),
    totals,payments:{items:[{type:'01',timing:'0',amount:doc.totals.total}],change:'0.00'},transport_mode:freight==='0.00'?'9':'0',
    excluded_groups:Object.fromEntries(['ipi','ii','issqn','ibs_cbs','is','monophase','destination_icms'].map(k=>[k,'not_included_in_profile'])),homologation_labels:'apply_test_labels',additional_information:'DOCUMENTO SINTETICO SEM VALOR FISCAL'};
  const result={draft,itemPreparation,taxPreparation,completion};refreshTaxProof(result);return result;
}
