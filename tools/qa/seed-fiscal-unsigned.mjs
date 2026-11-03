/** Complete fictitious inputs for browser QA. No reservation, XML, certificate or network at bootstrap. */
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {businessFixture,TEST_RECIPIENT} from '../../packages/fiscal-core/test/business-fixtures.mjs';
import {resolveBusinessContent} from '../../packages/fiscal-core/src/business-document.mjs';
export async function seedFiscalUnsigned({db,uid}){
 if(!(db instanceof PGlite))throw Error('QA_UNSIGNED_PGLITE_REQUIRED');
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
 const rpc=(name,args)=>{const entries=Object.entries(args);return scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')})value`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));};
 const identity=(await rpc('erp_company_get',{p_user_id:uid,p_section:'identity'})).record,fiscal=(await rpc('erp_company_get',{p_user_id:uid,p_section:'fiscal'})).record;
 if(identity?.data.cnpj!=='11222333000181'||fiscal?.crt!=='1'||!identity.data.ie)throw Error('QA_UNSIGNED_FICTITIOUS_IDENTITY_REQUIRED');
 const counts=()=>scalar('select jsonb_build_array((select count(*)from erp_fiscal_numbering.reservation),(select count(*)from erp_fiscal_unsigned.job),(select count(*)from erp_finance.title),(select count(*)from erp_stock.movement))value');
 const before=await counts();
 const contact=(await rpc('erp_catalog_save',{p_user_id:uid,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Cliente fictício XML 048',code:'QA048-C01',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'Piracicaba',state:'SP'}})).record;
 const product=(await rpc('erp_catalog_save',{p_user_id:uid,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Produto fictício XML 048',code:'QA048-P01',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 for(const model of['55','65']){
  const sample=businessFixture({model,count:1});
  const doc=(await rpc('erp_document_save',{p_user_id:uid,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:`Produto fictício XML ${model}`,code:'QA048-P01',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'}],notes:'QA048 · SOMENTE TESTE LOCAL'}})).document;
  const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:uid,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:doc.id,expected_source_version:doc.version,model,preparation:{operation_nature:'VENDA FICTICIA DE QA',notes:null}}});
  const base={p_user_id:uid,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
  await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
  await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:sample.taxPreparation.record.items.map((item,i)=>({...item.decisions,item_id:draft.record.snapshot.items[i].id}))});
  const{identity:unused,...completion}=sample.completion;completion.items.forEach((item,i)=>item.item_id=draft.record.snapshot.items[i].id);
  await rpc('erp_fiscal_completion_save',{p_user_id:uid,p_draft_id:draft.record.id,p_expected_draft_version:1,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:1,p_tax_preparation_version:1,p_expected_identity_version:identity.version,p_expected_fiscal_version:fiscal.version,p_expected_completion_version:0,p_completion:completion,p_command_id:randomUUID()});
  const basis=await rpc('erp_fiscal_unsigned_basis',{p_user_id:uid,p_draft_id:draft.record.id,p_completion_version:1});resolveBusinessContent(basis.inputs);
 }
 if(JSON.stringify(await counts())!==JSON.stringify(before))throw Error('QA_UNSIGNED_BOOTSTRAP_EFFECTS');
}
