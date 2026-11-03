import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseFiscalDraftRoute,executeFiscalDraftRoute} from '../src/fiscal-drafts.mjs';
import {parseFiscalItemRoute,executeFiscalItemRoute} from '../src/fiscal-item-preparation.mjs';
import {parseFiscalTaxRoute,executeFiscalTaxRoute} from '../src/fiscal-tax-preparation.mjs';
import {buildBusinessXml} from '../../../packages/fiscal-xml/src/business-builder.mjs';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../../packages/fiscal-core/test/business-fixtures.mjs';

// No external service: this proves compatibility with actual SQL JSONB projection,
// not multi-session concurrency, authorization to emit or current fiscal rules.
test('022/035/040 real SQL → public HTTP projections → pure builder, including JSONB key order',async()=>{
 const db=new PGlite(),uid=randomUUID();
 const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
 async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
 const saveCatalog=(entity,data)=>rpc('erp_catalog_save',{p_user_id:uid,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data});
 const api=async(prefix,id,parse,execute)=>execute(await parse(new Request(`https://synthetic.invalid/v1/${prefix}/${id}`)),{userId:uid,rpc});
 const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_tax.revision),(select count(*)from erp_fiscal_tax.command),(select count(*)from erp_fiscal_items.revision),(select count(*)from erp_fiscal_drafts.revision),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title),(select sum(last_number)from erp_documents.numbering)) value");
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1)',[uid]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[uid]);
  const identity=(await rpc('erp_company_save_identity',{p_user_id:uid,p_expected_version:0,p_command_id:randomUUID(),p_data:{legal_name:'EMPRESA FICTICIA SEM VALOR FISCAL',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}})).record;
  const fiscal=await rpc('erp_company_get',{p_user_id:uid,p_section:'fiscal'});
  await rpc('erp_company_confirm_fiscal',{p_user_id:uid,p_expected_version:fiscal.record.version,p_expected_identity_version:identity.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Confirmacao inteiramente ficticia'});
  const contact=(await saveCatalog('contacts',{name:'CLIENTE FICTICIO',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'})).record;
  const product=(await saveCatalog('products',{name:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'})).record;
  for(const model of['55','65']){
   const order=(await rpc('erp_document_save',{p_user_id:uid,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:[{product_id:product.id,description:'PRODUTO FICTICIO',code:'FICT-001',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'}],internal_notes:'PRIVATE-SYNTHETIC-INTERNAL-NOTES'}})).document;
   const created=await rpc('erp_fiscal_draft_execute',{p_user_id:uid,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:order.id,expected_source_version:order.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
   const item=created.record.snapshot.items[0],basis={p_user_id:uid,p_draft_id:created.record.id,p_expected_draft_version:created.record.version,p_snapshot_hash:created.record.snapshot_hash,p_expected_version:0};
   await rpc('erp_fiscal_item_save',{...basis,p_command_id:randomUUID(),p_decisions:[{item_id:item.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}]});
   await rpc('erp_fiscal_tax_save',{...basis,p_item_preparation_version:1,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:[{item_id:item.id,cfop:'5102',icms:{csosn:'102'},pis:{cst:'49',base:'12.50',rate:'0.00',amount:'0.00'},cofins:{cst:'49',base:'12.50',rate:'0.00',amount:'0.00'},review_note:'SYNTHETIC-TAX-PRIVATE-NOTE'}]});
   const draft=await api('rascunhos-fiscais',created.record.id,parseFiscalDraftRoute,executeFiscalDraftRoute);
   const itemPreparation=await api('preparacao-itens-fiscais',created.record.id,parseFiscalItemRoute,executeFiscalItemRoute);
   const taxPreparation=await api('preparacao-tributaria',created.record.id,parseFiscalTaxRoute,executeFiscalTaxRoute);
   const completion=businessFixture({model}).completion;completion.items[0].item_id=item.id;
   const before=await counts(),input={draft,itemPreparation,taxPreparation,completion},result=buildBusinessXml(input);
   assert.match(result.unsignedXml,new RegExp(`<mod>${model}</mod>`));assert.match(result.unsignedXml,/<vNF>12\.50<\/vNF>/);assert.equal(result.binding.draft_id,created.record.id);
   assert.equal(result.can_emit,false);assert.equal(result.can_transmit,false);assert.equal(result.numbering_reserved,false);
   assert.doesNotMatch(JSON.stringify(result),/PRIVATE-SYNTHETIC|SYNTHETIC-TAX-PRIVATE/);assert.deepEqual(await counts(),before);
   const reversed=v=>Array.isArray(v)?v.map(reversed):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reversed(x)])):v;
   assert.deepEqual(buildBusinessXml(reversed(input)),result);
   // A saved 040 receipt is historical, not a license to use a stale 022 source.
   await rpc('erp_document_transition',{p_user_id:uid,p_kind:'sales_orders',p_id:order.id,p_expected_version:order.version,p_command_id:randomUUID(),p_status:'open',p_reason:'Mudanca sintetica'});
   input.draft=await api('rascunhos-fiscais',created.record.id,parseFiscalDraftRoute,executeFiscalDraftRoute);
   assert.throws(()=>buildBusinessXml(input),e=>e.code==='BUSINESS_SOURCE_CHANGED');
  }
 }finally{await db.close();}
});
