import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseDocumentCopyRoute,executeDocumentCopyRoute,documentCopyResponse} from '../../workers/erp-api/src/document-copy.mjs';
let db,contact,product,warehouse;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value,code=value=>error=>error.code===value;
async function rpc(name,args){const entries=Object.entries(args);await db.exec('set role service_role');try{return await scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v));}finally{await db.exec('reset role');}}
const catalog=(entity,data,id=null,version=0)=>rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data});
const data=(extra={})=>({date:'2026-10-16',contact_id:contact.id,warehouse_id:warehouse.id,expected_date:'2026-11-10',valid_until:'2026-10-30',next_contact:'2026-10-20',items:[{product_id:product.id,description:'Item comercial sintético',unit:'UN',quantity:'0.123456',unit_price:'100',discount_percent:'0'}],discount_mode:'amount',discount_value:'0.20',freight:'0.30',other_expenses:'0.10',installments:[{due_date:'2026-11-01',amount:'12.55'}],payment_terms:'Condição a conferir',delivery_terms:'Entrega sintética',notes:'Pública sintética',internal_notes:'PRIVATE_INTERNAL_COPY',...extra});
const save=async(kind='sales_proposals',body=data())=>(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:body})).document;
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Conferência sintética'})).document;
const preview=(d,actor=users.admin)=>rpc('erp_document_copy_preview',{p_user_id:actor,p_kind:d.kind,p_source_id:d.id});
const copy=(d,body,command=randomUUID(),actor=users.admin)=>rpc('erp_document_copy',{p_user_id:actor,p_kind:d.kind,p_source_id:d.id,p_expected_source_version:d.version,p_command_id:command,p_body:body});
const tables=async names=>Promise.all(names.map(name=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${name} t`)));
const counter=kind=>scalar('select last_number::text value from erp_documents.numbering where kind=$1',[kind]);
const url=d=>`https://synthetic.invalid/v1/duplicacao-documentos/${d.kind}/${d.id}`;
const request=(d,body)=>new Request(url(d),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0012_erp_attachments','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0028_service_order_journal','0034_document_copy'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','consulta','estoque','fiscal','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 contact=(await catalog('contacts',{name:'Cliente sintético original'})).record;product=(await catalog('products',{name:'Produto sintético original',code:'COPY-SYNTHETIC',unit:'UN',kind:'P',format:'S',price:'100'})).record;warehouse=(await catalog('warehouses',{name:'Depósito sintético'})).record;
});
after(()=>db?.close());

test('034 GET has no persistence, uses the server Sao Paulo date and clears only the advertised preview fields',async()=>{
 const d=await save('service_orders',data({equipment:'Equipamento antigo',serial_number:'SERIAL-SYNTHETIC',technician:'Técnico antigo',defect:'Defeito antigo',solution:'Execução antiga'}));
 const names=['erp_documents.document','erp_documents.item','erp_documents.numbering','erp_documents.audit','erp_documents.command','erp_documents.copy_source'];const before=await tables(names);
 const zone=await scalar("select current_setting('TimeZone') value");await db.exec("set timezone='Pacific/Auckland'");const expected=await scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text value");const result=await preview(d);await db.query("select set_config('TimeZone',$1,false)",[zone]);
 assert.deepEqual(await tables(names),before);assert.equal(result.persisted,false);assert.equal(result.data.date,expected);assert.equal(result.source.version,d.version);assert.equal(result.source.id,d.id);
 for(const key of ['expected_date','valid_until','next_contact','equipment','serial_number','technician','defect','solution'])assert.equal(result.data[key],null);
 assert.equal(result.data.template,false);assert.deepEqual(result.data.installments,[]);assert.ok(result.data.items.every(line=>line.id===null));assert.equal(result.data.items[0].quantity,'0.123456');assert.equal(result.data.items[0].unit_price,'100.0000');
 for(const key of ['discount_mode','discount_value','freight','other_expenses','payment_terms','delivery_terms','notes','internal_notes'])assert.equal(result.data[key],d[key]);
 assert.doesNotMatch(JSON.stringify(result),/contact_snapshot|product_snapshot|effect_flags|created_by/);
 const template=await save('sales_proposals',data({template:true}));assert.equal((await preview(template)).data.template,false);
});
test('034 ACL matches each same-kind write policy and keeps lineage private/immutable',async()=>{
 for(const signature of ['erp_document_copy_preview(uuid,text,uuid)','erp_document_copy_origin(uuid,text,uuid)','erp_document_copy(uuid,text,uuid,integer,uuid,jsonb)'])for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE') value",[role,`public.${signature}`]),role==='service_role');
 assert.equal(await scalar("select relrowsecurity value from pg_class where oid='erp_documents.copy_source'::regclass"),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,'erp_documents.copy_source','SELECT,INSERT,UPDATE,DELETE') value",[role]),false);
 for(const kind of ['sales_proposals','sales_orders','purchase_orders','service_orders']){
  const d=await save(kind),body=(await preview(d)).data;
  for(const role of ['vendas','estoque','financeiro','consulta','fiscal','inactive']){
   const allowed=kind==='purchase_orders'?role==='estoque':role==='vendas';
   if(allowed){assert.equal((await preview(d,users[role])).source.id,d.id);assert.equal((await copy(d,body,randomUUID(),users[role])).document.kind,kind);}
   else{await assert.rejects(()=>preview(d,users[role]),code('42501'));await assert.rejects(()=>copy(d,body,randomUUID(),users[role]),code('42501'));}
  }
 }
 const row=await scalar('select destination_id value from erp_documents.copy_source limit 1');
 await assert.rejects(()=>db.query('update erp_documents.copy_source set source_version=source_version where destination_id=$1',[row]),code('55000'));
 await assert.rejects(()=>db.query('delete from erp_documents.copy_source where destination_id=$1',[row]),code('55000'));
});
test('034 POST honors confirmed dates/values, renews line UUIDs and captures current catalog snapshots without replacing prices',async()=>{
 const d=await save('purchase_orders'),suggestion=(await preview(d)).data;
 contact=(await catalog('contacts',{name:'Cliente atual conferido'},contact.id,contact.version)).record;
 product=(await catalog('products',{name:'Produto atual conferido',code:product.code,unit:'UN',kind:'P',format:'S',price:'999'},product.id,product.version)).record;
 const entered={...suggestion,date:'2026-09-10',expected_date:'2026-09-20',valid_until:'2026-10-01',next_contact:'2026-09-15',items:suggestion.items.map((line,index)=>({...line,id:d.items[index].id})),installments:[{due_date:'2026-10-10',amount:'12.55',method:'Conferida'}]};
 const before=await scalar('select to_jsonb(d) value from erp_documents.document d where id=$1',[d.id]),result=await copy(d,entered);
 assert.deepEqual(await scalar('select to_jsonb(d) value from erp_documents.document d where id=$1',[d.id]),before);assert.equal(result.document.status,'open');assert.equal(result.document.version,1);assert.equal(result.document.source_proposal_id,null);
 for(const key of ['date','expected_date','valid_until','next_contact'])assert.equal(result.document[key],entered[key]);assert.equal(result.document.installments[0].due_date,'2026-10-10');
 assert.equal(result.document.contact_snapshot.name,contact.name);assert.equal(result.document.items[0].product_snapshot.name,product.name);assert.equal(result.document.items[0].product_snapshot.price,'999.0000');assert.equal(result.document.items[0].unit_price,'100.0000');assert.equal(result.document.totals.total,'12.55');
 assert.notEqual(result.document.items[0].id,d.items[0].id);assert.deepEqual(result.copy_source,{id:d.id,kind:d.kind,number:d.number,version:d.version});
});
test('034 CAS and inactive/missing references reject atomically before any numbering or destination',async()=>{
 const d=await save(),body=(await preview(d)).data,changed=await transition(d,'open'),before=await counter(d.kind);
 await assert.rejects(()=>copy(d,body),code('40001'));
 for(const patch of [{contact_id:randomUUID()},{warehouse_id:randomUUID()},{items:[{...body.items[0],product_id:randomUUID()}]},{date:'2026-02-30'}])await assert.rejects(()=>copy(changed,{...body,...patch}),code('22023'));
 const oldProduct=product;product=(await rpc('erp_catalog_set_active',{p_user_id:users.admin,p_entity:'products',p_id:product.id,p_expected_version:product.version,p_command_id:randomUUID(),p_active:false})).record;
 await assert.rejects(()=>copy(changed,body),code('22023'));assert.equal(await counter(d.kind),before);
 product=(await rpc('erp_catalog_set_active',{p_user_id:users.admin,p_entity:'products',p_id:product.id,p_expected_version:product.version,p_command_id:randomUUID(),p_active:true})).record;assert.equal(oldProduct.id,product.id);
});
test('034 historical replay survives source and destination edits, but remains actor/body/kind bound and currently authorized',async()=>{
 const d=await save(),body=(await preview(d)).data,command=randomUUID(),first=await copy(d,body,command,users.vendas);
 const changed=await transition(d,'open');await transition(first.document,'open');
 assert.deepEqual(await copy(d,body,command,users.vendas),{...first,replayed:true});
 for(const call of [()=>copy(changed,body,command,users.vendas),()=>copy(d,{...body,notes:'Outro texto'},command,users.vendas),()=>copy(d,body,command,users.admin),()=>rpc('erp_document_save',{p_user_id:users.vendas,p_kind:d.kind,p_id:null,p_expected_version:0,p_command_id:command,p_body:body})])await assert.rejects(call,code('40001'));
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);await assert.rejects(()=>copy(d,body,command,users.vendas),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);
 const second=await copy(changed,body);assert.notEqual(second.document.id,first.document.id);assert.equal(await scalar('select count(*)::int value from erp_documents.copy_source where source_id=$1',[d.id]),2);
});
test('034 cancelled/empty service reception and maximum source version remain legitimate new documents',async()=>{
 let d=await save('service_orders',data({items:[],discount_value:'0',freight:'0',other_expenses:'0',installments:[]}));d=await transition(d,'cancelled');
 await db.query('update erp_documents.document set version=2147483647 where id=$1',[d.id]);d={...d,version:2147483647};
 const result=await copy(d,(await preview(d)).data);assert.equal(result.document.status,'open');assert.equal(result.document.version,1);assert.deepEqual(result.document.items,[]);assert.equal(result.document.totals.total,'0.00');assert.equal(result.copy_source.version,2147483647);
 assert.equal(await scalar('select status value from erp_documents.document where id=$1',[d.id]),'cancelled');
});
test('034 exhausted destination numbering rolls back copy lineage, audit and command atomically',async()=>{
 const d=await save('purchase_orders'),body=(await preview(d)).data,original=await counter(d.kind);
 const names=['erp_documents.document','erp_documents.item','erp_documents.audit','erp_documents.command','erp_documents.copy_source'],before=await tables(names);
 await db.query('update erp_documents.numbering set last_number=9999999999 where kind=$1',[d.kind]);
 try{await assert.rejects(()=>copy(d,body),code('40001'));assert.deepEqual(await tables(names),before);}
 finally{await db.query('update erp_documents.numbering set last_number=$1 where kind=$2',[original,d.kind]);}
});
test('034 copy of a converted document has only copy lineage, and none of the operational histories are duplicated',async()=>{
 let source=await save();source=await transition(source,'open');source=await transition(source,'approved');
 const conversion=await rpc('erp_proposal_convert',{p_user_id:users.admin,p_id:source.id,p_expected_version:source.version,p_command_id:randomUUID()});const d=conversion.sale;
 const names=(await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname in('erp_finance','erp_stock','erp_fiscal_drafts','erp_attachments','storage','origin_sync') or (n.nspname='erp_documents' and c.relname in('attachment','service_journal_entry','service_journal_command'))) order by name")).rows.map(row=>row.name);
 const before=await tables(names),result=await copy(d,(await preview(d)).data);assert.deepEqual(await tables(names),before);
 assert.equal(result.document.source_proposal_id,null);assert.equal(result.copy_source.id,d.id);assert.deepEqual(result.document.effect_flags,{finance_active:false,stock_active:false});assert.equal(result.operational_effects,false);
 assert.equal(await scalar('select count(*)::int value from erp_documents.document where source_proposal_id=$1',[source.id]),1);
});
test('034 preview/copy SQL satisfies isolated HTTP projection and rejects altered outcomes',async()=>{
 const d=await save('service_orders'),read=await parseDocumentCopyRoute(new Request(url(d)+'/preview'));
 const view=await executeDocumentCopyRoute(read,{userId:users.admin,rpc});assert.equal(view.persisted,false);assert.equal(view.source.id,d.id);
 const command=randomUUID(),route=await parseDocumentCopyRoute(request({...d,id:d.id.toUpperCase()},{command_id:command.toUpperCase(),expected_source_version:d.version,data:{...view.data,date:'2026-09-20'}}));
 const result=await executeDocumentCopyRoute(route,{userId:users.admin.toUpperCase(),rpc});assert.equal(result.document.date,'2026-09-20');assert.equal(result.document.status,'open');assert.equal((await executeDocumentCopyRoute(route,{userId:users.admin,rpc})).replayed,true);
 for(const mutate of [v=>v.copy_source.id=randomUUID(),v=>v.copy_source.version++,v=>v.document.id=d.id,v=>v.document.version++,v=>v.document.status='approved',v=>v.document.source_proposal_id=d.id,v=>v.document.date='2026-09-21',v=>v.operational_effects=true]){const wrong=structuredClone(result);mutate(wrong);assert.throws(()=>documentCopyResponse(wrong,route),e=>e.status===502);}
 for(const mutate of [v=>v.persisted=true,v=>v.source.id=randomUUID(),v=>v.data.template=true,v=>v.data.items[0].id=randomUUID(),v=>v.data.installments=[{due_date:'2026-11-01',amount:'12.55'}],v=>v.data.solution='Execução antiga',v=>v.reset_fields=[]]){const wrong=structuredClone(view);mutate(wrong);assert.throws(()=>documentCopyResponse(wrong,read),e=>e.status===502);}
 assert.equal(documentCopyResponse({...result,secret:'not projected'},route).secret,undefined);
});
test('034 HTTP refuses cross-kind paths, asserted metadata, computed money, bad dates and oversized transport',async()=>{
 const d=await save(),body=(await preview(d)).data,valid={command_id:randomUUID(),expected_source_version:d.version,data:body};
 for(const patch of [{command_id:[valid.command_id]},{expected_source_version:'1'},{expected_source_version:0},{actor:users.admin},{source_snapshot:{}},{data:{...body,totals:{total:'0'}}},{data:{...body,date:'2026-02-30'}},{data:{...body,items:[{...body.items[0],unit_price:100}]}}])await assert.rejects(()=>parseDocumentCopyRoute(request(d,{...valid,...patch})),e=>e.status===400);
 for(const [req,status]of [[new Request(url(d)),405],[request({...d,id:'invalid'},valid),404],[new Request(url(d)+'/preview?q=x'),400],[new Request(url(d)+'/preview',{method:'POST'}),405],[new Request(url(d),{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(262145)}),400]])await assert.rejects(()=>parseDocumentCopyRoute(req),e=>e.status===status);
 await assert.rejects(()=>preview({...d,kind:'purchase_orders'}),code('P0002'));
});
test('034 origin GET binds destination kind/id, exposes only immutable provenance and follows read ACL',async()=>{
 const d=await save(),created=await copy(d,(await preview(d)).data);
 const originalRoute=await parseDocumentCopyRoute(new Request(url(d)+'/origin'));
 assert.equal((await executeDocumentCopyRoute(originalRoute,{userId:users.admin,rpc})).copy_source,null);
 const route=await parseDocumentCopyRoute(new Request(url(created.document)+'/origin'));
 const result=await executeDocumentCopyRoute(route,{userId:users.consulta,rpc});
 assert.deepEqual(result,{document_id:created.document.id,kind:d.kind,copy_source:{id:d.id,kind:d.kind,number:d.number,version:d.version},data_mode:'erp_native',operational_effects:false});
 await transition(d,'open');assert.deepEqual(await executeDocumentCopyRoute(route,{userId:users.financeiro,rpc}),result);
 for(const role of ['estoque','fiscal','inactive'])await assert.rejects(()=>executeDocumentCopyRoute(route,{userId:users[role],rpc}),code('42501'));
 const cross=await parseDocumentCopyRoute(new Request(url({...created.document,kind:'purchase_orders'})+'/origin'));
 await assert.rejects(()=>executeDocumentCopyRoute(cross,{userId:users.admin,rpc}),code('P0002'));
 for(const mutate of [v=>v.document_id=d.id,v=>v.kind='purchase_orders',v=>delete v.copy_source,v=>v.copy_source.id=created.document.id,v=>v.copy_source.id=['not a uuid'],v=>v.copy_source.kind='purchase_orders',v=>v.copy_source.version=0]){const wrong=structuredClone(result);mutate(wrong);assert.throws(()=>documentCopyResponse(wrong,route),e=>e.status===502);}
 assert.doesNotMatch(JSON.stringify(documentCopyResponse({...result,notes:'PRIVATE'},route)),/PRIVATE|contact|actor|amount/);
 await assert.rejects(()=>parseDocumentCopyRoute(new Request(url(d)+'/origin',{method:'POST'})),e=>e.status===405);
});
