import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createHandler} from '../src/index.mjs';
import {documentsResponse} from '../src/documents.mjs';
import {catalogResponse} from '../src/catalog.mjs';
import {parseOriginProposalImportRoute,originProposalImportResponse} from '../src/origin-proposal-import.mjs';
import {parseOriginProposalImportV2Route,originProposalImportV2Response} from '../src/origin-proposal-import-v2.mjs';
import {normalizeUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';

// Single in-memory database, including pre-migration receipts. No network or real sources.
let db,handler,contact,product,wideProduct,oldCatalog,oldDocument;const actor=randomUUID(),viewer=randomUUID(),saved=[],calls=[];
const env={SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',ALLOWED_ORIGINS:'https://synthetic.invalid'};
const base='/v1/importacao-orcamentos-origin';
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
const migration=async suffix=>db.exec(await readFile(new URL(`../../../supabase/migrations/20261016${suffix}.sql`,import.meta.url),'utf8'));
async function rpc(name,args){const fields=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${fields.map(([k],i)=>`${k}=>$${i+1}`).join(',')})v`,fields.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
async function call(path,method='GET',body,user=actor){const response=await handler(new Request('https://api.synthetic.invalid'+path,{method,headers:{Authorization:'Bearer '+user,Origin:'https://synthetic.invalid',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);return{status:response.status,value:await response.json()};}
async function ok(path,method='GET',body){const r=await call(path,method,body);assert.equal(r.status,200,JSON.stringify(r.value));return r.value;}
async function stage(entity,id,payload){await db.query("insert into origin_sync.raw_record(entity,last_resource,source_id,payload,version_hash)values($1,'synthetic_http_057',$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))",[entity,id,JSON.stringify(payload)]);}
const productPayload=(id,price)=>({id,nome:'Produto sintético 057',situacao:'A',tipo:'P',formato:'S',unidade:'UN',preco:price,tributacao:{ncm:'8205.59.00'}});
const sourceItems=async(entity,id)=>[{source_id:id,source_hash:await scalar('select version_hash v from origin_sync.raw_record where entity=$1 and source_id=$2',[entity,id])}];
async function importCatalog(entity,id,payload){await stage(entity,id,payload);return(await rpc('erp_catalog_import_origin',{p_user_id:actor,p_entity:entity,p_items:await sourceItems(entity,id),p_command_id:randomUUID(),p_dry_run:false})).items[0].record_id;}
const proposal=(id,price=1.2)=>({id,numero:57,data:'2026-10-16',situacao:'Rascunho',contato:{id:'9579000001'},total:2.4,totalProdutos:2.4,desconto:0,outrasDespesas:0,transporte:{frete:0,freteModalidade:9},itens:[{produto:{id:'9579000002',descricao:'Item de origem sintético'},unidade:'UN',quantidade:2,valor:price,desconto:0}],parcelas:[]});
const body=(price='1.2000',quantity='2')=>({date:'2026-10-16',contact_id:contact,items:[{product_id:product,description:'Item sintético',detailed_description:'Detalhe comercial 054',unit:'UN',quantity,unit_price:price,discount_percent:'0'}],discount_mode:'amount',discount_value:'0',freight:'0',other_expenses:'0',installments:[],commercial:null});
function editable(d){const v={};for(const k of ['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','discount_mode','discount_value','freight','other_expenses','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial'])if(Object.hasOwn(d,k))v[k]=d[k];v.items=d.items.map(({gross,discount,total,position,product_snapshot,...r})=>r);v.installments=d.installments.map(({position,...r})=>r);return v;}
const postDocument=(data,kind='sales_proposals')=>ok('/v1/documentos/'+kind,'POST',{command_id:randomUUID(),data});
const updateDocument=(d,data)=>ok(`/v1/documentos/${d.kind}/${d.id}`,'PATCH',{command_id:randomUUID(),expected_version:d.version,data});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const suffix of ['0001_origin_sync','0002_origin_quotes_nfce','0003_origin_backup_staging','0004_erp_access','0005_origin_auxiliary_catalogs','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0013_catalog_import_review','0014_erp_cnab','0015_document_filters','0017_document_finance','0018_document_stock','0019_document_effect_flags','0020_cutover_readiness','0023_product_details','0032_proposal_service_conversion','0034_document_copy','0044_catalog_ncm_format','0052_origin_proposal_import','0054_document_commercial','0055_origin_proposal_import_v2'])await migration(suffix);
 for(const[id,role]of[[actor,'admin'],[viewer,'consulta']]){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
 await db.exec("insert into origin_sync.resource_state(resource)values('synthetic_http_057')");
 handler=createHandler({fetchImpl:async(url,options)=>{calls.push({url,body:options.body});if(url.endsWith('/auth/v1/user'))return Response.json({id:options.headers.Authorization.slice(7)});try{return Response.json(await rpc(new URL(url).pathname.split('/').at(-1),JSON.parse(options.body)));}catch(e){return Response.json({code:e.code,message:'SANITIZE_SYNTHETIC_SQL_ERROR'},{status:400});}}});
 contact=await importCatalog('contacts','9579000001',{id:'9579000001',nome:'Contato sintético 057',situacao:'A',tipo:'J'});
 product=await importCatalog('products','9579000002',productPayload('9579000002','1.2000'));
 oldCatalog=await ok('/v1/cadastros/products/'+product);oldDocument=await postDocument(body());
 for(const[version,id]of[[1,'9579000011'],[2,'9579000012']]){
  const prefix=base+(version===2?'-v2':'');await stage('sales_proposals',id,proposal(id));
  const preview=await ok(prefix+'/preview','POST',{source_id:id});assert.equal(preview.can_apply,true);
  const request={source_id:id,preview_hash:preview.preview_hash,command_id:randomUUID(),confirm_import:true,duplicate_reviewed:true};
  const ack=await ok(prefix+'/apply','POST',request),current=await ok(prefix+'/commands/'+request.command_id);
  const other=id+'0';await stage('sales_proposals',other,proposal(other));const untouched=await ok(prefix+'/preview','POST',{source_id:other});
  saved.push({version,prefix,id,preview,request,ack,current,other,untouched});
 }
 await migration('0057_unit_price_precision');
 // The document list served by the worker is 095, which also reads the later effect tables (016/022/025/070/090).
 for(const suffix of ['0016_company','0022_fiscal_drafts','0025_stock_positions','0070_stock_reservations','0090_purchase_receipts'])await migration(suffix);
 await db.exec(await readFile(new URL('../../../supabase/migrations/202610190095_document_list_parity.sql',import.meta.url),'utf8'));
 wideProduct=(await ok('/v1/cadastros/products','POST',{command_id:randomUUID(),data:{name:'Preço cadastral amplo',kind:'P',format:'S',unit:'UN',price:'99999999999999.9999999999'}})).record;
});
after(()=>db?.close());

test('057 actual HTTP preserves legacy catalog/documents and both proposal previews, receipts and replays',async()=>{
 assert.deepEqual(await ok('/v1/cadastros/products/'+product),oldCatalog);
 assert.deepEqual((await ok('/v1/documentos/sales_proposals/'+oldDocument.document.id)).document,oldDocument.document);
 for(const s of saved){assert.deepEqual(await ok(s.prefix+'/preview','POST',{source_id:s.other}),s.untouched);assert.deepEqual(await ok(s.prefix+'/commands/'+s.request.command_id),s.current);assert.deepEqual(await ok(s.prefix+'/apply','POST',s.request),{...s.ack,replayed:true});}
});
test('057 native catalog HTTP accepts canonical four/ten outputs and 80-byte input without silently rounding',async()=>{
 for(const price of ['0.0000000001','1.2345678901','1.2345000000','1.'+'0'.repeat(78),null]){
  const request={command_id:randomUUID(),data:{name:'Preço sintético',price,net_weight:'1.123456'}};const result=await ok('/v1/cadastros/products','POST',request);
  assert.equal(result.record.price,price===null?null:normalizeUnitPrice(price,14));assert.equal(result.record.net_weight,'1.123456');assert.deepEqual(await ok('/v1/cadastros/products','POST',request),{...result,replayed:true});
  assert.equal((await ok('/v1/cadastros/products/'+result.record.id)).record.price,result.record.price);
 }
 const list=await ok('/v1/cadastros/products?limit=100');assert.equal(list.items.find(x=>x.id===wideProduct.id).price,wideProduct.price);
 for(const price of ['', '01','1.00000000001','100000000000000','1.'+'0'.repeat(79),1.1]){const n=calls.length;assert.equal((await call('/v1/cadastros/products','POST',{command_id:randomUUID(),data:{name:'Recusar',price}})).status,400);assert.equal(calls.length,n);}
 assert.equal((await call('/v1/cadastros/products','POST',{command_id:randomUUID(),data:{name:'Medida excessiva',net_weight:'1.1234567'}})).status,400);
});
test('057 all native document kinds retain exact unit prices, distinct catalog snapshots, and unchanged cents',async()=>{
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders']){
  const data=body('0.0000000001','100000000');data.items[0].product_id=wideProduct.id;data.installments=[{due_date:'2026-11-16',amount:'0.01',note:'Nota 054',payment_reference:null}];
  const result=await postDocument(data,kind),d=result.document;assert.equal(d.items[0].unit_price,'0.0000000001');assert.equal(d.items[0].product_snapshot.price,wideProduct.price);assert.equal(d.totals.total,'0.01');assert.equal(d.installments[0].note,'Nota 054');
  assert.deepEqual((await ok(`/v1/documentos/${kind}/${d.id}`)).document,d);
  const edit=editable(d);edit.items[0].quantity='1';edit.items[0].unit_price='0.0050000001';
  const changed=await updateDocument(d,edit);assert.equal(changed.document.items[0].unit_price,'0.0050000001');assert.equal(changed.document.totals.total,'0.01');
  assert.equal((await ok(`/v1/documentos/${kind}?limit=100`)).items.find(x=>x.id===d.id).total,'0.01');
 }
});
test('057 copy and proposal conversions preserve price/commercial strings and reset only documented fields',async()=>{
 for(const action of ['convert','convert-service']){
  let d=(await postDocument(body('0.1234567891','10'))).document;
  const prefix=`/v1/duplicacao-documentos/${d.kind}/${d.id}`,p=await ok(prefix+'/preview'),request={command_id:randomUUID(),expected_source_version:d.version,data:p.data};
  assert.equal(p.data.items[0].unit_price,'0.1234567891');assert.equal(p.data.items[0].detailed_description,'Detalhe comercial 054');assert.deepEqual(p.data.installments,[]);
  const copied=await ok(prefix,'POST',request);assert.equal(copied.document.items[0].unit_price,'0.1234567891');assert.deepEqual(await ok(prefix,'POST',request),{...copied,replayed:true});
  for(const status of ['open','approved'])d=(await ok(`/v1/documentos/${d.kind}/${d.id}/status`,'POST',{command_id:randomUUID(),expected_version:d.version,status,reason:'Conferência sintética'})).document;
  const converted=await ok(`/v1/documentos/${d.kind}/${d.id}/${action}`,'POST',{command_id:randomUUID(),expected_version:d.version}),target=converted.sale??converted.service_order;
  assert.equal(target.items[0].unit_price,'0.1234567891');assert.equal(target.items[0].detailed_description,'Detalhe comercial 054');assert.equal(target.totals.total,'1.23');assert.notEqual(target.items[0].id,d.items[0].id);
 }
});
test('057 proposal current edits use ten places while v1/v2 proof and original replay stay four-place',async()=>{
 for(const s of saved){
  const edit=editable(s.current.current_document);edit.items[0].unit_price='1.2345678901';edit.items[0].product_id=wideProduct.id;
  const changed=await updateDocument(s.current.current_document,edit);assert.equal(changed.document.totals.total,'2.47');
  for(const path of ['/commands/'+s.request.command_id,'/origins/'+s.id]){const current=await ok(s.prefix+path);assert.equal(current.current_document.items[0].unit_price,'1.2345678901');assert.equal(current.current_document.items[0].product_snapshot.price,wideProduct.price);assert.deepEqual(current.receipt,s.current.receipt);if(s.version===2){assert.deepEqual(current.historical_evidence,s.current.historical_evidence);assert.equal(current.historical_evidence.normalized_body.items[0].unit_price,'1.2000');}}
  assert.deepEqual(await ok(s.prefix+'/apply','POST',s.request),{...s.ack,replayed:true});
  const parse=s.version===1?parseOriginProposalImportRoute:parseOriginProposalImportV2Route,project=s.version===1?originProposalImportResponse:originProposalImportV2Response;
  const route=await parse(new Request('https://synthetic.invalid'+s.prefix+'/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_id:s.other})}));
  const forged=structuredClone(s.untouched);forged.proposed.items[0].unit_price='1.2000000001';if(s.version===2)forged.source_evidence.items[0].unit_price='1.2000000001';assert.throws(()=>project(forged,route),e=>e.status===502);
  const id=s.id+'9';await stage('sales_proposals',id,proposal(id,1.2345678901));const denied=await ok(s.prefix+'/preview','POST',{source_id:id});assert.equal(denied.can_apply,false);assert.ok(denied.issues.some(x=>x.code==='ITEM_DECIMAL_INVALID'));
 }
});
test('057 reviewed catalog import may expose a new exact price but requires explicit preview/apply and keeps staging untouched',async()=>{
 const id='9579000099';await stage('products',id,productPayload(id,'0.1234567890'));const raw=await scalar("select payload::text v from origin_sync.raw_record where entity='products' and source_id=$1",[id]),items=await sourceItems('products',id);
 const before=await scalar('select count(*)::int v from erp_catalog.record'),preview=await ok('/v1/importacao-cadastros/products/preview','POST',{items});assert.equal(preview.items[0].action,'create');assert.equal(preview.items[0].changes.find(x=>x.field==='price').after,'0.1234567890');assert.equal(await scalar('select count(*)::int v from erp_catalog.record'),before);
 const request={items,preview_hash:preview.preview_hash,command_id:randomUUID()},result=await ok('/v1/importacao-cadastros/products/apply','POST',request);assert.deepEqual(await ok('/v1/importacao-cadastros/products/apply','POST',request),{...result,replayed:true});
 const current=(await ok('/v1/cadastros/products/'+result.items[0].record_id)).record;assert.equal(current.price,'0.1234567890');assert.equal(current.ncm,'82055900');assert.equal(await scalar("select payload::text v from origin_sync.raw_record where entity='products' and source_id=$1",[id]),raw);
});
test('057 DTOs refuse noncanonical and numerically rounded prices; invalid inputs never reach SQL, ACL/CAS still hold',async()=>{
 const d=(await postDocument(body('1.0000000001','1'))).document;
 for(const price of ['1.0000000000','1.00000000001','1.00000',1,'10000000000.0000']){const doc=structuredClone(d);doc.items[0].unit_price=price;assert.throws(()=>documentsResponse({data_mode:'erp_native',operational_effects:false,kind:d.kind,document:doc},{kind:d.kind,id:d.id},{type:'document'}),e=>e.status===502);}
 for(const price of ['1.0000000000','1.00000000001',1]){const record={...wideProduct,price};assert.throws(()=>catalogResponse({data_mode:'erp_native',entity:'products',record},{entity:'products',id:record.id},{type:'record'}),e=>e.status===502);}
 for(const mutate of [v=>v.items[0].unit_price='1.00000000001',v=>v.items[0].unit_price='10000000000',v=>v.items[0].quantity='1.0000001',v=>v.items[0].discount_percent='1.00001',v=>v.freight='0.001']){const input=body();mutate(input);const n=calls.length;assert.equal((await call('/v1/documentos/sales_orders','POST',{command_id:randomUUID(),data:input})).status,400);assert.equal(calls.length,n);}
 assert.equal((await call('/v1/documentos/sales_orders','POST',{command_id:randomUUID(),data:body('1.0000000001')},viewer)).status,403);
 assert.equal((await call(`/v1/documentos/${d.kind}/${d.id}`,'PATCH',{command_id:randomUUID(),expected_version:d.version+1,data:editable(d)})).status,409);
 assert.equal(await scalar('select count(*)::int v from erp_stock.entry'),0);assert.equal(await scalar('select count(*)::int v from erp_finance.title'),0);
});
