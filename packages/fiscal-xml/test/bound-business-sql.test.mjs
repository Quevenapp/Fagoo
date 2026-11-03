import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {businessFixture,TEST_HOLDER,TEST_RECIPIENT} from '../../fiscal-core/test/business-fixtures.mjs';
import {resolveBusinessContent} from '../../fiscal-core/src/business-document.mjs';
import {bindResolvedBusinessContent,buildBoundBusinessXml} from '../src/bound-business.mjs';
import {buildBusinessXml} from '../src/business-builder.mjs';

// This separate interop fixture uses real migrations and RPCs only in memory.
// No remote adapter, Storage upload, certificate or fiscal transport is present.
let db,contact,product;const actor=randomUUID();let nextSeries=300;
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args){const pairs=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${pairs.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,pairs.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const digest=v=>createHash('sha256').update(v).digest('hex');
const counts=()=>scalar("select jsonb_build_array((select count(*)from erp_fiscal_unsigned.identity),(select count(*)from erp_fiscal_unsigned.job),(select count(*)from erp_fiscal_unsigned.attempt),(select count(*)from erp_fiscal_unsigned.artifact),(select count(*)from erp_fiscal_numbering.reservation),(select sum(next_number)from erp_fiscal_numbering.series),(select count(*)from erp_stock.movement),(select count(*)from erp_finance.title))value");
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0023_product_details','0029_fiscal_review','0035_fiscal_item_preparation','0040_fiscal_tax_preparation','0046_fiscal_numbering','0047_business_completion','0048_unsigned_xml_jobs'])await db.exec(await readFile(new URL('../../../supabase/migrations/20261016'+name+'.sql',import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
 contact=(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'DESTINATARIO FICTICIO BINDER',person_type:'J',document:TEST_RECIPIENT,postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',state:'SP'}})).record;
 product=(await rpc('erp_catalog_save',{p_user_id:actor,p_entity:'products',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'PRODUTO FICTICIO BINDER',unit:'UN',kind:'P',format:'S',ncm:'82032090',origin:'0',gtin:'SEM GTIN'}})).record;
 const identity=await rpc('erp_company_save_identity',{p_user_id:actor,p_command_id:randomUUID(),p_expected_version:0,p_data:{legal_name:'EMITENTE FICTICIO BINDER',cnpj:TEST_HOLDER,ie:'123456789012',postal_code:'13400000',street:'RUA FICTICIA',number:'1',district:'CENTRO',city:'PIRACICABA',municipality_code:'3538709',state:'SP'}});
 const fiscal=await rpc('erp_company_get',{p_user_id:actor,p_section:'fiscal'});
 await rpc('erp_company_confirm_fiscal',{p_user_id:actor,p_expected_version:fiscal.record.version,p_expected_identity_version:identity.record.version,p_command_id:randomUUID(),p_crt:'1',p_confirmed:true,p_reason:'Configuracao exclusivamente ficticia'});
});
after(()=>db?.close());
async function fixture(model,count=2){
 const example=businessFixture({model,count});
 const order=(await rpc('erp_document_save',{p_user_id:actor,p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,items:Array.from({length:count},()=>({product_id:product.id,description:'PRODUTO FICTICIO BINDER',code:'BINDER-FICT',unit:'UN',quantity:'1.250000',unit_price:'10.0000',discount_percent:'0'}))}})).document;
 const draft=await rpc('erp_fiscal_draft_execute',{p_user_id:actor,p_command_id:randomUUID(),p_action:'create',p_data:{source_document_id:order.id,expected_source_version:order.version,model,preparation:{operation_nature:'VENDA FICTICIA',notes:null}}});
 const base={p_user_id:actor,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_expected_version:0};
 const item=await rpc('erp_fiscal_item_save',{...base,p_command_id:randomUUID(),p_decisions:draft.record.snapshot.items.map(i=>({item_id:i.id,fields:Object.fromEntries(Object.entries({ncm:'82032090',origin:'0',cest:null,gtin:'SEM GTIN',gtin_tax:'SEM GTIN'}).map(([k,value])=>[k,{source:'manual',value}]))}))});
 const tax=await rpc('erp_fiscal_tax_save',{...base,p_item_preparation_version:item.record.version,p_operation:'internal_normal_sale',p_command_id:randomUUID(),p_decisions:example.taxPreparation.record.items.map((i,n)=>({...i.decisions,item_id:draft.record.snapshot.items[n].id}))});
 const {identity,...completion}=example.completion;completion.items.forEach((i,n)=>i.item_id=draft.record.snapshot.items[n].id);
 const completed=await rpc('erp_fiscal_completion_save',{p_user_id:actor,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:item.record.version,p_tax_preparation_version:tax.record.version,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_expected_fiscal_version:draft.record.snapshot.company.fiscal_version,p_expected_completion_version:0,p_completion:completion,p_command_id:randomUUID()});
 const basis=await rpc('erp_fiscal_unsigned_basis',{p_user_id:actor,p_draft_id:draft.record.id,p_completion_version:completed.record.version});
 const configured=await rpc('erp_fiscal_numbering_configure',{p_user_id:actor,p_command_id:randomUUID(),p_id:null,p_expected_version:0,p_expected_identity_version:draft.record.snapshot.company.identity_version,p_model:model,p_environment:'2',p_series:String(nextSeries++),p_initial_number:'1',p_enabled:true,p_exclusive_use_confirmed:true,p_reference:'Serie ficticia para teste do binder'});
 const s=configured.current_series,reserved=await rpc('erp_fiscal_numbering_reserve',{p_user_id:actor,p_command_id:randomUUID(),p_series_id:s.id,p_expected_series_version:s.version,p_expected_identity_version:s.identity_version,p_draft_id:draft.record.id,p_expected_draft_version:draft.record.version,p_snapshot_hash:draft.record.snapshot_hash,p_item_preparation_version:item.record.version,p_tax_preparation_version:tax.record.version,p_confirm_reserve:true});
 const seed={cNF:'01234567',issuedAt:await scalar(`select to_char(clock_timestamp() at time zone interval'-03:00','YYYY-MM-DD"T"HH24:MI:SS')||'-03:00' value`)};
 const args={p_user_id:actor,p_command_id:randomUUID(),p_reservation_id:reserved.receipt.id,p_completion_version:completed.record.version,p_completion_hash:basis.proofs.completion_hash,p_basis_hash:basis.basis_hash,p_builder_version:'brufap-business-builder-v1',p_seed:seed};
 return{job:await rpc('erp_fiscal_unsigned_begin',args),args};
}
test('SQL048 captures actual JSONB proofs and persisted identity that bind and serialize identically for55/65/250items',async()=>{
 for(const [model,count]of[['55',2],['65',2],['65',250]]){
  const {job}=await fixture(model,count),before=await counts(),inputs=job.execution.inputs;
  const content=resolveBusinessContent(inputs),bound=bindResolvedBusinessContent({content,receipt:job.receipt}),xml=buildBoundBusinessXml(bound);
  const legacy=buildBusinessXml({draft:inputs.draft,itemPreparation:inputs.itemPreparation,taxPreparation:inputs.taxPreparation,completion:{...inputs.completionPreparation.record.completion,identity:Object.fromEntries(['series','number','cNF','issuedAt'].map(k=>[k,job.execution.identity[k]]))}});
  assert.equal(job.receipt.basis_hash,digest(content.basis_fingerprint_text));assert.equal(xml.unsignedXml,legacy.unsignedXml);assert.equal(xml.access_key,job.receipt.access_key);assert.equal(xml.unsigned_xml_sha256,digest(xml.unsignedXml));
  assert.equal(xml.binding.completion_record_hash,job.receipt.completion_hash);assert.equal(xml.identity.model,model);assert.equal((xml.unsignedXml.match(/<det /g)||[]).length,count);assert.equal(xml.numbering_reserved,false);assert.equal(xml.can_emit,false);assert.equal(xml.can_transmit,false);assert.deepEqual(await counts(),before);
 }
});
test('SQL048 replay retains original identity; parsing persisted records again restores local attestation without consuming another number',async()=>{
 const {job,args}=await fixture('55'),first=buildBoundBusinessXml(bindResolvedBusinessContent({content:resolveBusinessContent(job.execution.inputs),receipt:job.receipt}));
 const replay=await rpc('erp_fiscal_unsigned_begin',{...args,p_seed:{cNF:'99999999',issuedAt:'2000-01-01T00:00:00-03:00'}});
 assert.equal(replay.execution,null);assert.equal(replay.replayed,true);assert.equal(replay.receipt.identity.cNF,'01234567');assert.deepEqual(replay.receipt,job.receipt);
 const before=await counts(),second=buildBoundBusinessXml(bindResolvedBusinessContent({content:resolveBusinessContent(JSON.parse(JSON.stringify(job.execution.inputs))),receipt:replay.receipt}));
 assert.equal(second.unsignedXml,first.unsignedXml);assert.deepEqual(await counts(),before);
 const changed=structuredClone(replay.receipt);changed.proofs.tax_preparation_version++;assert.throws(()=>bindResolvedBusinessContent({content:resolveBusinessContent(job.execution.inputs),receipt:changed}),e=>e.code==='BUSINESS_JOB_BASIS_CONFLICT');
});
