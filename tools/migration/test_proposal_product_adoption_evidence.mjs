import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../../workers/origin-sync/src/client.mjs';
import {priceCapture} from '../../workers/origin-sync/src/price-json.mjs';
import {createAdoptionReaders,validateAdoptionEvidence,planProposalProductAdoption} from './plan_proposal_product_adoption.mjs';
test('SQL export→013/055 HTTP DTO→readonly planner selects only exact current unlinked products',async()=>{
 const db=new PGlite(),owner=randomUUID(),actor=randomUUID();
 const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
 async function rpc(name,args={}){const es=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${es.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,es.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
  for(const f of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0023_product_details','0032_proposal_service_conversion','0034_document_copy','0044_catalog_ncm_format','0052_origin_proposal_import','0054_document_commercial','0055_origin_proposal_import_v2','0056_origin_reference_fetch','0057_unit_price_precision','0059_origin_price_capture','0060_origin_proposal_price_refresh'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${f}.sql`,import.meta.url),'utf8'));
  await db.query('insert into auth.users values($1)',[actor]);await db.query("insert into erp_access.membership(user_id,role)values($1,'admin')",[actor]);
  async function apply(entity,records){const l=await rpc('origin_sync_claim',{p_resource:'synthetic_adoption',p_owner:owner,p_ttl_seconds:600});return rpc(records.some(r=>r.price_capture)?'origin_sync_apply_price_batch':'origin_sync_apply_batch',{p_resource:'synthetic_adoption',p_entity:entity,p_owner:owner,p_lease_token:l.lease_token,p_batch_id:randomUUID(),p_records:records,p_checkpoint:{},p_expected_checkpoint_version:l.checkpoint_version});}
  for(const id of ['1','2','3','4']){const client=new OriginClient('synthetic',{priceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(`{"data":{"id":"${id}","preco":12.1234567891,"nome":"PRIVATE SYNTHETIC PRODUCT","tipo":"P","formato":"S","unidade":"UN","situacao":"${id==='4'?'I':'A'}"}}`)});const payload=await client.get('/produtos/'+id);await apply('products',[{source_id:id,payload,...(id==='2'?{}:{price_capture:priceCapture(payload)})}]);}
  const linkedHash=await scalar("select version_hash v from origin_sync.raw_record where entity='products' and source_id='3'");
  await rpc('erp_catalog_import_origin',{p_user_id:actor,p_entity:'products',p_items:[{source_id:'3',source_hash:linkedHash}],p_command_id:randomUUID(),p_dry_run:false});
  await apply('sales_proposals',[{source_id:'99',payload:{id:'99',numero:99,situacao:'Rascunho',itens:['1','2','3','4'].map(id=>({produto:{id}}))}}]);
  const sql=await readFile(new URL('./proposal_product_adoption_evidence.sql',import.meta.url),'utf8');await db.exec('begin read only');let raw;
  try{raw=(await db.query(sql)).rows[0].evidence;}finally{await db.exec('rollback');}
  const evidence=validateAdoptionEvidence(raw);assert.deepEqual(evidence.items.map(x=>x.source_id),['1','4']);assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE SYNTHETIC PRODUCT|12\.1234567891|lexeme|document_links|payload/);
  const counts=()=>scalar("select jsonb_build_object('catalog',(select count(*) from erp_catalog.record),'commands',(select count(*) from erp_catalog.command),'review_commands',(select count(*) from erp_catalog.import_review_command),'documents',(select count(*) from erp_documents.document))v"),before=await counts(),calls=[];
  const readers=createAdoptionReaders((name,args)=>{assert.ok(['erp_catalog_import_preview','erp_origin_proposal_import_preview_v2'].includes(name));calls.push(name);return rpc(name,{...args,p_user_id:actor});});
  const plan=await planProposalProductAdoption({evidence,readers,actor});assert.equal(plan.summary.planned,1);assert.equal(plan.summary.blocked,1);assert.equal(plan.batches[0].mapper_review[0].changes.find(x=>x.field==='price').after,'12.1234567891');assert.deepEqual(await counts(),before);assert.equal(plan.apply_enabled,false);assert.equal(calls.length,2);
 }finally{await db.close();}
});
