import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { normalizeDocument } from '../../packages/erp-domain/src/index.mjs';
import { documentsResponse } from '../../workers/erp-api/src/documents.mjs';
import { parseDocumentServiceConversionRoute,executeDocumentServiceConversionRoute,documentServiceConversionResponse,documentServiceConversionMethods } from '../../workers/erp-api/src/document-service-conversion.mjs';

// Local synthetic data only. PGlite serializes statements and is not a test of
// multiple PostgreSQL sessions; both winner orderings and the SQL lock are checked.
let db,contact,product,warehouse,legacy,source032;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const code=value=>error=>error.code===value;
async function rpc(name,args){
 const entries=Object.entries(args);await db.exec('set role service_role');
 try{return await scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value!==null&&typeof value==='object'?JSON.stringify(value):value));}
 finally{await db.exec('reset role');}
}
const catalog=(entity,data,id=null,version=0)=>rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_data:data});
const body=()=>({date:'2026-10-16',contact_id:contact.id,warehouse_id:warehouse.id,expected_date:'2026-11-01',valid_until:'2026-10-30',next_contact:'2026-10-20',
 items:[{product_id:product.id,description:'Produto histórico sintético',code:'SYNTHETIC-032',unit:'UN',quantity:'1.234567',unit_price:'2.3456',discount_percent:'1.2345'},
  {description:'Serviço livre sintético',unit:'H',quantity:'0.333333',unit_price:'0.0300',discount_percent:'0'}],
 discount_mode:'amount',discount_value:'0.12',freight:'0.23',other_expenses:'0.04',installments:[{due_date:'2026-11-01',amount:'1.01'},{due_date:'2026-12-01',amount:'2.01'}],
 payment_terms:'Condições comerciais sintéticas',delivery_terms:'Entrega combinada',notes:'Observação pública fictícia',internal_notes:'PRIVATE_INTERNAL_NOTE_032'});
const save=(kind='sales_proposals',data=body())=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:data});
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Motivo sintético'})).document;
async function proposal(){let d=(await save()).document;d=await transition(d,'open');return transition(d,'approved');}
const input=(d,command=randomUUID(),actor=users.admin)=>({p_user_id:actor,p_id:d.id,p_expected_version:d.version,p_command_id:command});
const convert=(d,command=randomUUID(),actor=users.admin)=>rpc('erp_proposal_convert_to_service',input(d,command,actor));
const sale=(d,command=randomUUID(),actor=users.admin)=>rpc('erp_proposal_convert',input(d,command,actor));
const get=async d=>(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
const number=()=>scalar("select last_number::text value from erp_documents.numbering where kind='service_orders'");
const snapshot=async tables=>Promise.all(tables.map(name=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${name} t`)));
const request=(id,payload,options={})=>new Request(`https://synthetic.invalid/v1/documentos/sales_proposals/${id}/convert-service`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),...options});

before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0012_erp_attachments','0014_erp_cnab','0016_company','0017_document_finance','0018_document_stock','0019_document_effect_flags','0022_fiscal_drafts','0028_service_order_journal'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','consulta','estoque','fiscal','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 contact=(await catalog('contacts',{name:'Cliente sintético 032',document:'PRIVATE_CONTACT_032'})).record;
 product=(await catalog('products',{name:'Produto sintético 032',code:'SYNTHETIC-032',unit:'UN',kind:'P',format:'S',price:'2.3456'})).record;
 warehouse=(await catalog('warehouses',{name:'Depósito sintético 032'})).record;
 const source=await proposal();legacy={input:input(source),result:null};legacy.result=await rpc('erp_proposal_convert',legacy.input);
 source032=await readFile(new URL('../../supabase/migrations/202610160032_proposal_service_conversion.sql',import.meta.url),'utf8');await db.exec(source032);
});
after(()=>db?.close());

test('032 is service-only and rechecks the existing sales/OS role matrix even on replay',async()=>{
 const signature='public.erp_proposal_convert_to_service(uuid,uuid,integer,uuid)';
 for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE') value",[role,signature]),false);
 assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE') value",[signature]),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,'erp_documents.document','SELECT,INSERT,UPDATE,DELETE') value",[role]),false);
 const d=await proposal();for(const role of ['financeiro','consulta','estoque','fiscal','inactive'])await assert.rejects(()=>convert(d,randomUUID(),users[role]),code('42501'));
 const command=randomUUID(),result=await convert(d,command,users.vendas);assert.equal(result.service_order.kind,'service_orders');
 await db.query("update erp_access.membership set role='consulta' where user_id=$1",[users.vendas]);await assert.rejects(()=>convert(d,command,users.vendas),code('42501'));
 await db.query("update erp_access.membership set role='vendas',active=false where user_id=$1",[users.vendas]);await assert.rejects(()=>convert(d,command,users.vendas),code('42501'));
 await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);assert.equal((await convert(d,command,users.vendas)).replayed,true);
});
test('032 copies exact approved snapshots, decimal values, terms and independent line identities',async()=>{
 const d=await proposal();assert.equal(normalizeDocument('sales_proposals',body()).totals.total,'3.02');
 const changed=(await catalog('products',{name:'Nome atual diferente',code:product.code,kind:'P',format:'S',unit:'UN',price:'999'},product.id,product.version)).record;
 const currentContact=(await catalog('contacts',{name:'Nome atual do cliente'},contact.id,contact.version)).record;
 // Current inactive records do not silently rewrite the approved commercial snapshot.
 await rpc('erp_catalog_set_active',{p_user_id:users.admin,p_entity:'products',p_id:changed.id,p_expected_version:changed.version,p_command_id:randomUUID(),p_active:false});
 const result=await convert(d),order=result.service_order;
 assert.equal(order.status,'open');assert.equal(order.version,1);assert.equal(order.source_proposal_id,d.id);assert.equal(result.proposal.status,'completed');assert.equal(result.proposal.version,d.version+1);
 assert.deepEqual(order.contact_snapshot,d.contact_snapshot);assert.notEqual(order.contact_snapshot.name,currentContact.name);
 assert.deepEqual(order.items.map(({id,...line})=>line),d.items.map(({id,...line})=>line));assert.equal(new Set(order.items.map(line=>line.id)).size,2);assert.ok(order.items.every(line=>!d.items.some(old=>old.id===line.id)));
 assert.deepEqual(order.totals,d.totals);assert.deepEqual(order.installments,d.installments);
 for(const field of ['date','expected_date','valid_until','next_contact','payment_terms','delivery_terms','notes','internal_notes','discount_mode','discount_value','freight','other_expenses'])assert.deepEqual(order[field],d[field]);
 for(const field of ['equipment','serial_number','technician','defect','solution'])assert.equal(order[field],null);
 // Restore active fixtures for subsequent independent cases.
 product=(await rpc('erp_catalog_set_active',{p_user_id:users.admin,p_entity:'products',p_id:changed.id,p_expected_version:changed.version+1,p_command_id:randomUUID(),p_active:true})).record;contact=currentContact;
});
test('032 rejects wrong kinds, unapproved/templates, stale CAS and version overflow without reserving a number',async()=>{
 const wrongKinds=[];for(const kind of ['sales_orders','purchase_orders','service_orders'])wrongKinds.push((await save(kind)).document);
 const start=await number(),draft=(await save()).document,approved=await proposal();
 await assert.rejects(()=>convert(draft),code('22023'));await assert.rejects(()=>convert({...approved,version:approved.version-1}),code('40001'));
 for(const wrong of wrongKinds)await assert.rejects(()=>convert(wrong),code('P0002'));
 let template=(await save('sales_proposals',{...body(),template:true})).document;template=await transition(template,'open');
 await assert.rejects(()=>convert(template),code('22023'));await assert.rejects(()=>transition(template,'approved'),code('22023'));
 await db.query('update erp_documents.document set version=2147483647 where id=$1',[approved.id]);await assert.rejects(()=>convert({...approved,version:2147483647}),code('40001'));
 for(const value of [null,0,-1])await assert.rejects(()=>rpc('erp_proposal_convert_to_service',{...input(draft),p_expected_version:value}),code('22023'));
 assert.equal(await number(),start);
});
test('032 and legacy sale conversion share parent lock and UNIQUE: either winner excludes the other',async()=>{
 assert.match(source032,/command_replay[\s\S]+kind='sales_proposals' for update[\s\S]+next_number\('service_orders'\)/);
 assert.equal(await scalar("select count(*)::int value from pg_constraint where conrelid='erp_documents.document'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (source_proposal_id)'"),1);
 for(const winner of ['sale','service']){
  const d=await proposal(),first=await(winner==='sale'?sale(d):convert(d));
  await assert.rejects(()=>winner==='sale'?convert(d):sale(d),code('40001'));
  await assert.rejects(()=>winner==='sale'?convert(first.proposal):sale(first.proposal),code('40001'));
  assert.equal(await scalar('select count(*)::int value from erp_documents.document where source_proposal_id=$1',[d.id]),1);
 }
});
test('032 replay keeps the original result after OS edits, rejects command reuse, and preserves legacy sale replay',async()=>{
 const d=await proposal(),command=randomUUID(),first=await convert(d,command),order=await transition(first.service_order,'quoted');
 const replay=await convert(d,command);assert.deepEqual(replay,{...first,replayed:true});assert.equal((await get(order)).status,'quoted');
 await assert.rejects(()=>convert({...d,version:d.version+1},command),code('40001'));
 await assert.rejects(()=>convert(d,command,users.vendas),code('40001'));await assert.rejects(()=>sale(d,command),code('40001'));
 await assert.rejects(()=>convert(d),code('40001'));assert.equal(await scalar('select count(*)::int value from erp_documents.document where source_proposal_id=$1',[d.id]),1);
 const legacyReplay=await rpc('erp_proposal_convert',legacy.input);assert.deepEqual(legacyReplay,{...legacy.result,replayed:true});
 const projected=documentsResponse(legacyReplay,{kind:'sales_proposals',id:legacy.input.p_id},{type:'conversion'});assert.equal(projected.sale.id,legacy.result.sale.id);
});
test('032 creates no financial/stock/fiscal/journal/storage effects and audits exactly both documents',async()=>{
 const d=await proposal(),command=randomUUID();
 const names=(await db.query("select quote_ident(n.nspname)||'.'||quote_ident(c.relname) name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and (n.nspname in('erp_finance','erp_stock','erp_fiscal_drafts','erp_attachments','storage','origin_sync') or (n.nspname='erp_documents' and c.relname in('attachment','service_journal_entry','service_journal_command'))) order by name")).rows.map(row=>row.name);
 const before=await snapshot(names),result=await convert(d,command);assert.deepEqual(await snapshot(names),before);
 assert.equal(result.operational_effects,false);assert.deepEqual(result.service_order.effect_flags,{finance_active:false,stock_active:false});
 const audits=(await db.query('select action,document_id from erp_documents.audit where command_id=$1 order by id',[command])).rows;
 assert.deepEqual(audits,[{action:'convert_to_service',document_id:d.id},{action:'create_from_proposal',document_id:result.service_order.id}]);
});
test('032 replay refreshes only current effect flags without rewriting stored historical results',async()=>{
 const d=await proposal(),command=randomUUID(),first=await convert(d,command);let order=await transition(first.service_order,'quoted');order=await transition(order,'approved');
 const before=await scalar('select result value from erp_documents.command where command_id=$1',[command]);
 const args={p_user_id:users.admin,p_kind:order.kind,p_document_id:order.id,p_expected_version:order.version};
 const {preview}=await rpc('erp_document_finance_preview',args);await rpc('erp_document_finance_post',{...args,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash});
 const replay=await convert(d,command);assert.deepEqual(replay.service_order,{...first.service_order,effect_flags:{finance_active:true,stock_active:false}});
 assert.equal(replay.service_order.status,'open');assert.equal(replay.service_order.version,1);assert.deepEqual(await scalar('select result value from erp_documents.command where command_id=$1',[command]),before);
 const route=await parseDocumentServiceConversionRoute(request(d.id,{command_id:command,expected_version:d.version}));assert.equal(documentServiceConversionResponse(replay,route).service_order.effect_flags.finance_active,true);
});
test('032 actual SQL/HTTP agree, UUIDs are canonical and returned DTOs are bound to the exact conversion',async()=>{
 const d=await proposal(),command=randomUUID(),route=await parseDocumentServiceConversionRoute(request(d.id.toUpperCase(),{command_id:command.toUpperCase(),expected_version:d.version}));
 const result=await executeDocumentServiceConversionRoute(route,{userId:users.admin.toUpperCase(),rpc});assert.equal(result.service_order.totals.total,'3.02');assert.equal(result.service_order.source_proposal_id,d.id);
 const current=await rpc('erp_document_get',{p_user_id:users.vendas,p_kind:'service_orders',p_id:result.service_order.id});
 assert.equal(documentsResponse(current,{kind:'service_orders',id:result.service_order.id},{type:'document'}).document.source_proposal_id,d.id);
 assert.equal((await executeDocumentServiceConversionRoute(route,{userId:users.admin,rpc})).replayed,true);
 assert.equal(documentServiceConversionResponse({...result,private_secret:'never'},route).private_secret,undefined);
 for(const mutate of [v=>v.proposal.id=randomUUID(),v=>v.proposal.version++,v=>v.service_order.id=[v.service_order.id],v=>v.service_order.kind='sales_orders',v=>v.service_order.version++,v=>v.service_order.status='approved',v=>v.service_order.source_proposal_id=randomUUID(),v=>v.service_order.contact_snapshot.name='Trocado',v=>v.service_order.items[0].id=v.proposal.items[0].id,v=>v.service_order.items[0].product_snapshot.name='Trocado',v=>v.service_order.notes='Trocado',v=>v.operational_effects=true]){
  const wrong=structuredClone(result);mutate(wrong);assert.throws(()=>documentServiceConversionResponse(wrong,route),error=>error.status===502);
 }
});
test('032 HTTP rejects untrusted attributes, malformed transport and excessive bodies before RPC',async()=>{
 const id=randomUUID(),command_id=randomUUID(),valid={command_id,expected_version:3},url=request(id,valid).url;
 assert.deepEqual(documentServiceConversionMethods(new URL(url).pathname),['POST']);assert.equal(await parseDocumentServiceConversionRoute(new Request('https://synthetic.invalid/v1/other')),null);
 for(const change of [{command_id:[command_id]},{expected_version:'3'},{expected_version:0},{expected_version:2147483647},{expected_version:1.5},{actor_id:users.admin},{target_kind:'sales_orders'},{data:{}}])await assert.rejects(()=>parseDocumentServiceConversionRoute(request(id,{...valid,...change})),error=>error.status===400);
 for(const [req,status]of [[new Request(url),405],[request('invalid',valid),404],[new Request(url+'?q=x',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(valid)}),400],[request(id,valid,{headers:{'Content-Type':'text/plain'}}),400],[request(id,valid,{headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}}),400],[request(id,valid,{body:' '.repeat(4097)}),400],[request(id,valid,{body:new Uint8Array([0xff])}),400]])await assert.rejects(()=>parseDocumentServiceConversionRoute(req),error=>error.status===status);
 await assert.rejects(async()=>executeDocumentServiceConversionRoute(await parseDocumentServiceConversionRoute(request(id,valid)),{userId:[users.admin],rpc}),error=>error.status===401);
});
