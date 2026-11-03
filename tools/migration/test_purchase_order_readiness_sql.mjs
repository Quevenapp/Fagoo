import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {OriginClient} from '../../workers/origin-sync/src/client.mjs';
import {purchasePriceCapture} from '../../workers/origin-sync/src/purchase-price-json.mjs';
test('purchase readiness reads one snapshot, distinguishes exact IDs/capture/types and never claims eligibility',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);');
  for(const name of ['001_origin_sync','002_origin_quotes_nfce','004_erp_access','005_origin_auxiliary_catalogs','006_erp_catalog','056_origin_reference_fetch','059_origin_price_capture','063_origin_extra_resources','071_origin_purchase_price_capture'])await db.exec(await readFile(new URL(`../../supabase/migrations/202610160${name}.sql`,import.meta.url),'utf8'));
  const q=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
  const stage=async(entity,id,payload)=>{const resource=entity==='products'?'products_zero':entity;await db.query('insert into origin_sync.resource_state(resource)values($1)on conflict do nothing',[resource]);await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) values($1,$2,$3,$4::jsonb,repeat('a',64))",[entity,resource,id,JSON.stringify(payload)]);};
  await stage('contacts','1',{id:1,nome:'PRIVATE_CONTACT_SENTINEL'});await stage('products','2',{id:2,nome:'PRIVATE_PRODUCT_SENTINEL'});
  for(const[entity,id]of[['contacts','1'],['products','2']]){
   const uuid=await q('insert into erp_catalog.record(entity,name)values($1,$2)returning id v',[entity,'PRIVATE_NATIVE_SENTINEL']);
   if(entity==='contacts')await db.query('insert into erp_catalog.contact(record_id)values($1)',[uuid]);else await db.query("insert into erp_catalog.product(record_id,kind,format,unit)values($1,'P','S','UN')",[uuid]);
   await db.query("insert into erp_catalog.source_snapshot(entity,source_id,source_hash,source_version,payload,document_links) values($1,$2,repeat('a',64),1,'{}','[]')",[entity,id]);
   await db.query("insert into erp_catalog.origin(entity,source_id,record_id,applied_hash,latest_hash,state) values($1,$2,$3,repeat('a',64),repeat('a',64),'synced')",[entity,id,uuid]);
  }
  const text='{"data":{"id":11,"situacao":{"id":7,"valor":0},"fornecedor":{"id":1},"itens":[{"produto":{"id":2},"valor":99999999.1234567891,"quantidade":1,"unidade":"UN","notaFiscal":{"id":99,"quantidade":1}},{"produto":{"id":3},"valor":"1.23","quantidade":1,"unidade":"UN"}],"desconto":{"valor":0,"unidade":"REAL"},"transporte":{"frete":0},"totalProdutos":10,"total":10,"parcelas":[]}}';
  const client=new OriginClient('synthetic',{purchasePriceCaptureEnabled:true,intervalMs:0,fetchImpl:async()=>new Response(text)}),p=await client.get('/pedidos/compras/11');await stage('purchase_orders','11',p);
  await db.query("update origin_sync.raw_record set price_capture=$1::jsonb||jsonb_build_object('source_hash',version_hash,'source_version',version::text) where entity='purchase_orders' and source_id='11'",[JSON.stringify(purchasePriceCapture(p))]);
  await stage('purchase_orders','12',{id:12,situacao:{id:8,valor:3},fornecedor:{id:'01'},itens:[{produto:{id:'2'},valor:1,quantidade:1,unidade:'CX'}],desconto:null});
  const fingerprint=()=>q("select jsonb_build_object('raw',(select jsonb_agg(to_jsonb(x) order by entity,source_id)from origin_sync.raw_record x),'records',(select jsonb_agg(to_jsonb(x)order by id)from erp_catalog.record x),'origins',(select jsonb_agg(to_jsonb(x)order by entity,source_id)from erp_catalog.origin x),'commands',(select count(*)from erp_catalog.command),'audit',(select count(*)from erp_catalog.audit))v");
  const before=await fingerprint(),sql=await readFile(new URL('./purchase_order_readiness.sql',import.meta.url),'utf8');
  assert.doesNotMatch(sql,/\b(?:insert|update|delete|create|alter|grant|for\s+update)\b/i);
  const result=await db.exec(sql),report=result.find(x=>x.rows?.[0]?.report)?.rows[0].report;assert.ok(report);assert.equal(report.can_import,false);assert.equal(report.native_effects,false);assert.equal(report.coverage_certified,false);assert.equal(report.source_total,2);assert.equal(report.sources_inspected,2);assert.equal(report.truncated,false);
  const product=report.reference_counts.find(x=>x.purpose==='product'),supplier=report.reference_counts.find(x=>x.purpose==='supplier');assert.equal(product.exact_current_binding,2);assert.equal(product.missing_staging,1);assert.equal(supplier.invalid_id,1);assert.equal(supplier.exact_current_binding,1);
  assert.equal(report.shape_counts.price_capture_current_missing,1);assert.equal(report.shape_counts.discount_explicit_zero,1);assert.equal(report.shape_counts.discount_null,1);assert.equal(report.line_counts.price_missing_or_nonnumeric,1);assert.equal(report.line_counts.invoice_reference_present,1);assert.equal(report.line_counts.unit_differs_from_exact_link,1);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|99999999|lexeme|"source_id"|"record_id"/);assert.deepEqual(await fingerprint(),before);
  await db.exec("update erp_catalog.record set human_edited=true where entity='products'");const changed=(await db.exec(sql)).find(x=>x.rows?.[0]?.report)?.rows[0].report;assert.equal(changed.reference_counts.find(x=>x.purpose==='product').current_binding_needs_review,2);assert.equal(changed.reference_counts.find(x=>x.purpose==='product').exact_current_binding,0);
  await db.exec("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash) select 'purchase_orders','purchase_orders',i::text,jsonb_build_object('id',i),repeat('b',64)from generate_series(1000,5999)i");
  const limited=(await db.exec(sql)).find(x=>x.rows?.[0]?.report)?.rows[0].report;assert.equal(limited.source_total,5002);assert.equal(limited.sources_inspected,5000);assert.equal(limited.truncated,true);assert.equal(limited.can_import,false);assert.equal(limited.coverage_certified,false);
 }finally{await db.close();}
});
