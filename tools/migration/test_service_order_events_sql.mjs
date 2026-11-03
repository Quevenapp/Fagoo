import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

let db,contact,product,warehouse;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const code=expected=>error=>error.code===expected;
async function rpc(name,args){
 await db.exec('set role service_role');try{const entries=Object.entries(args);
  return await scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v));
 }finally{await db.exec('reset role');}
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0012_erp_attachments','0014_erp_cnab','0017_document_finance','0018_document_stock','0019_document_effect_flags','0028_service_order_journal','0049_service_order_events'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','consulta','estoque','fiscal','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 const save=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 contact=await save('contacts',{name:'Cliente fictício da OS',document:'PRIVATE_CONTACT_DOCUMENT',email:'synthetic@example.invalid'});
 product=await save('products',{name:'Peça fictícia',code:'QA-EVENTS',unit:'UN',kind:'P',format:'S',price:'1'});
 warehouse=await save('warehouses',{name:'Depósito fictício'});
 await db.exec("insert into storage.buckets values('erp-attachments','erp-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','application/xml','text/plain']);");
});
after(()=>db?.close());
const body=(extra={})=>({date:'2026-10-16',contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Peça fictícia',quantity:'1.250000',unit:'UN',unit_price:'10.0000'}],internal_notes:'PRIVATE_INTERNAL_NOTE',equipment:'Equipamento fictício',serial_number:'SYNTHETIC-001',technician:'Técnico fictício',...extra});
const save=(d,values)=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:d?.kind??'service_orders',p_id:d?.id??null,p_expected_version:d?.version??0,p_command_id:randomUUID(),p_body:values}).then(v=>v.document);
const make=(extra={})=>save(null,body(extra));
const transition=(d,status)=>rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Motivo fictício de teste'}).then(v=>v.document);
const data=(type='reception',extra={})=>({type,occurred_on:'2026-10-16',declarant_name:'Pessoa fictícia',declarant_role:'customer',details:type==='reception'?{accessories:null,apparent_condition:'Carcaça com marcas declaradas'}:type==='customer_decision'?{decision:'approved',channel:'phone'}:{delivered_condition:'Equipamento entregue conforme observação',tests_summary:null},notes:null,attachment_id:null,corrects_event_id:null,correction_reason:null,confirm_record:true,...extra});
const append=(d,value=data(),command=randomUUID(),actor=users.admin)=>rpc('erp_service_event_append',{p_user_id:actor,p_document_id:d.id,p_expected_document_version:d.version,p_command_id:command,p_data:value});
const list=(d,actor=users.admin,limit=25,before=null)=>rpc('erp_service_event_list',{p_user_id:actor,p_document_id:d.id,p_limit:limit,p_before:before});
const get=(d,id,actor=users.admin)=>rpc('erp_service_event_get',{p_user_id:actor,p_document_id:d.id,p_event_id:id});
const counts=()=>scalar("select jsonb_build_object('events',(select count(*)from erp_documents.service_event),'commands',(select count(*)from erp_documents.service_event_command),'stock',(select count(*)from erp_stock.movement),'finance',(select count(*)from erp_finance.title))value");

test('049 inherits exact OS ACL, service-only RPC/RLS, and reauthorizes replay',async()=>{
 const d=await make();
 for(const table of ['service_event','service_event_command']){
  assert.equal(await scalar('select relrowsecurity value from pg_class where oid=$1::regclass',[`erp_documents.${table}`]),true);
  for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[role,`erp_documents.${table}`]),false);
 }
 for(const signature of ['erp_service_event_list(uuid,uuid,integer,text)','erp_service_event_get(uuid,uuid,uuid)','erp_service_event_append(uuid,uuid,integer,uuid,jsonb)']){
  for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')value",[role,`public.${signature}`]),false);
  assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')value",[`public.${signature}`]),true);
 }
 for(const role of ['admin','vendas','financeiro','consulta'])assert.equal((await list(d,users[role])).can_record,['admin','vendas'].includes(role));
 for(const role of ['estoque','fiscal','inactive'])await assert.rejects(()=>list(d,users[role]),code('42501'));
 for(const role of ['financeiro','consulta','estoque','fiscal','inactive'])await assert.rejects(()=>append(d,data(),randomUUID(),users[role]),code('42501'));
 const command=randomUUID(),first=await append(d,data(),command,users.vendas);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);
 await assert.rejects(()=>append(d,data(),command,users.vendas),code('42501'));await assert.rejects(()=>get(d,first.record.id,users.vendas),code('42501'));
 await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);
 for(const kind of ['sales_proposals','sales_orders','purchase_orders']){
  const other=await save({kind},body({equipment:null,serial_number:null,technician:null}));await assert.rejects(()=>append(other),code('P0002'));
 }
});
test('049 records declared date/person separately from server actor/time and captures exact immutable commercial evidence',async()=>{
 const d=await make(),before=await scalar('select to_jsonb(d)value from erp_documents.document d where id=$1',[d.id]);
 const one=await append(d,data('reception',{occurred_on:'2026-10-01',declarant_name:'  Declarante fictício  ',notes:'Texto\nSem marcação'})),two=await append(d);
 assert.equal(one.record.sequence,'1');assert.equal(two.record.sequence,'2');assert.equal(one.record.declarant_name,'Declarante fictício');assert.equal(one.record.occurred_on,'2026-10-01');assert.equal(one.record.actor_id,users.admin);assert.ok(Date.parse(one.record.recorded_at));
 assert.equal(one.record.total,'12.50');assert.equal(one.record.document_version,d.version);assert.equal(one.record.document_status,'open');assert.equal(one.record.snapshot.contact.name,contact.name);assert.equal(one.record.details.accessories,null);
 assert.match(one.record.commercial_hash,/^[a-f0-9]{64}$/);assert.equal(one.current.approval_basis_matches_current,false);
 for(const flag of ['signature_verified','consent_verified','changes_document_status','financial_mutation_performed','stock_mutation_performed'])assert.equal(one[flag],false);
 assert.doesNotMatch(JSON.stringify(one),/PRIVATE_|example\.invalid|object_key|bucket|lease|product_snapshot|internal_notes/);
 assert.deepEqual(await scalar('select to_jsonb(d)value from erp_documents.document d where id=$1',[d.id]),before);
 for(const table of ['service_event','service_event_command'])for(const operation of ['update','delete']){
  const id=table==='service_event'?one.record.id:one.record.id;
  await assert.rejects(()=>db.query(operation==='delete'?`delete from erp_documents.${table} where ${table==='service_event'?'id':'event_id'}=$1`:`update erp_documents.${table} set ${table==='service_event'?'notes=notes':'request_hash=request_hash'} where ${table==='service_event'?'id':'event_id'}=$1`,[id]),code('55000'));
 }
});
test('049 explicit decision never changes status; status-only progress and subsequent edits retain historical approval without reuse',async()=>{
 let d=await make();await assert.rejects(()=>append(d,data('customer_decision')),code('40001'));
 d=await transition(d,'quoted');const captured=d,command=randomUUID(),approval=await append(d,data('customer_decision'),command);
 assert.equal(approval.current.approval_basis_matches_current,true);assert.equal((await list(d)).document.status,'quoted');
 d=await transition(d,'approved');let found=await get(d,approval.record.id);
 assert.equal(found.current.document_version_changed,true);assert.equal(found.current.commercial_content_changed,false);assert.equal(found.current.total_changed,false);assert.equal(found.current.approval_basis_matches_current,false);
 await assert.rejects(()=>save(d,body()),code('40001'));
 // Existing commercial rules permit returning to execution and editing; the event does not add an implicit approval.
 d=await transition(d,'in_progress');d=await save(d,body({items:[{product_id:product.id,description:'Peça alterada',quantity:'2',unit:'UN',unit_price:'10'}]}));
 found=await get(d,approval.record.id);assert.equal(found.record.total,'12.50');assert.equal(found.document.total,'20.00');assert.equal(found.current.commercial_content_changed,true);assert.equal(found.current.total_changed,true);assert.equal(found.current.approval_basis_matches_current,false);
 const replay=await append(captured,data('customer_decision'),command);assert.equal(replay.replayed,true);assert.deepEqual(replay.record,approval.record);assert.equal(replay.document.version,d.version);
 await assert.rejects(()=>append(captured,data()),code('40001'));await assert.rejects(()=>append(captured,data('customer_decision',{notes:'Alterado'}),command),code('40001'));
 await assert.rejects(()=>append(captured,data('customer_decision'),command,users.vendas),code('40001'));
 d=await transition(d,'cancelled');const count=await counts();await assert.rejects(()=>append(d),code('40001'));assert.deepEqual(await counts(),count);assert.deepEqual((await list(d)).allowed_event_types,[]);
 assert.equal((await append(captured,data('customer_decision'),command)).replayed,true);
});
test('049 delivery is explicit only in closing states, does not conclude OS or register payment/stock, and templates stay read-only',async()=>{
 let d=await make();await assert.rejects(()=>append(d,data('delivery')),code('40001'));d=await transition(d,'quoted');d=await transition(d,'approved');d=await transition(d,'in_progress');d=await transition(d,'service_done');
 const before=await counts(),delivered=await append(d,data('delivery'));assert.equal(delivered.record.document_status,'service_done');assert.equal(delivered.document.version,d.version);assert.equal(delivered.document.status,'service_done');
 const after=await counts();assert.equal(after.stock,before.stock);assert.equal(after.finance,before.finance);
 d=await transition(d,'finalized');assert.equal((await append(d,data('delivery'))).record.document_status,'finalized');
 let unrepaired=await make();unrepaired=await transition(unrepaired,'no_repair');assert.equal((await append(unrepaired,data('delivery'))).record.document_status,'no_repair');
 // The existing commercial contract itself forbids an OS template.
 await assert.rejects(()=>make({template:true}),code('22023'));
});
test('049 corrections append a new same-type declaration under current CAS, preserve original evidence and cannot fork/cross documents',async()=>{
 let d=await make();d=await transition(d,'quoted');const first=await append(d,data('customer_decision'));
 const corrected=await append(d,data('customer_decision',{details:{decision:'rejected',channel:'message'},corrects_event_id:first.record.id,correction_reason:'Corrige o relato inicial'}));
 assert.equal(corrected.record.sequence,'2');assert.equal(corrected.record.corrects_event_id,first.record.id);assert.equal(corrected.current.approval_basis_matches_current,false);
 const original=await get(d,first.record.id);assert.deepEqual(original.record,first.record);assert.equal(original.current.corrected_by_event_id,corrected.record.id);assert.equal(original.current.approval_basis_matches_current,false);
 await assert.rejects(()=>append(d,data('customer_decision',{corrects_event_id:first.record.id,correction_reason:'Outra correção'})),code('40001'));
 await assert.rejects(()=>append(d,data('reception',{corrects_event_id:corrected.record.id,correction_reason:'Tipo incorreto'})),code('40001'));
 const another=await make();await assert.rejects(()=>append(another,data('reception',{corrects_event_id:corrected.record.id,correction_reason:'OS incorreta'})),code('40001'));
 await assert.rejects(()=>get(another,first.record.id),code('P0002'));
 const next=await append(d,data('customer_decision',{corrects_event_id:corrected.record.id,correction_reason:'Nova declaração conferida'}));assert.equal(next.record.sequence,'3');assert.equal(next.current.approval_basis_matches_current,true);
});
test('049 a newer declared decision supersedes earlier approval context without rewriting either receipt or inferring consent',async()=>{
 let d=await make();d=await transition(d,'quoted');
 const approved=await append(d,data('customer_decision'));assert.equal(approved.current.approval_basis_matches_current,true);
 const rejected=await append(d,data('customer_decision',{details:{decision:'rejected',channel:'email'}}));
 const old=await get(d,approved.record.id);assert.deepEqual(old.record,approved.record);assert.equal(old.current.approval_basis_matches_current,false);assert.equal(old.current.corrected_by_event_id,null);
 assert.equal(rejected.current.approval_basis_matches_current,false);assert.equal(rejected.consent_verified,false);assert.equal(rejected.document.status,'quoted');
 const newer=await append(d,data('customer_decision'));assert.equal(newer.current.approval_basis_matches_current,true);
 await append(d,data('reception'));assert.equal((await get(d,newer.record.id)).current.approval_basis_matches_current,true);
 assert.equal((await get(d,approved.record.id)).current.approval_basis_matches_current,false);
});
async function attachment(d,ready=true){
 const hash='a'.repeat(64),reserved=await rpc('erp_attachment_reserve',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_command_id:randomUUID(),p_filename:'anexo-sintetico.txt',p_mime_type:'text/plain',p_size_bytes:10,p_sha256:hash});
 if(!ready)return reserved.attachment;
 const id=reserved.attachment.id,lease=randomUUID();await rpc('erp_attachment_claim',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_id:id,p_lease:lease});
 await db.query('insert into storage.objects values($1,$2,$3)',['erp-attachments',`documents/${d.id}/${id}/${hash}`,{size:10,mimetype:'text/plain'}]);
 return (await rpc('erp_attachment_finish',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_id:id,p_lease:lease,p_sha256:hash,p_size_bytes:10})).attachment;
}
test('049 optional evidence attachment must be ready and belong to this OS; only immutable minimal metadata is captured',async()=>{
 const d=await make(),other=await make(),pending=await attachment(d,false),foreign=await attachment(other),ready=await attachment(d);
 for(const a of [pending,foreign,{id:randomUUID()}])await assert.rejects(()=>append(d,data('reception',{attachment_id:a.id})),code('40001'));
 const result=await append(d,data('reception',{attachment_id:ready.id}));assert.deepEqual(result.record.attachment,{id:ready.id,filename:ready.filename,mime_type:'text/plain',size_bytes:10,sha256:'a'.repeat(64)});
 assert.doesNotMatch(JSON.stringify(result),/object_key|storage|bucket|lease|request_hash/);
});
test('049 strict bounded plain text, explicit confirmation, dates and scalar schemas reject malformed declarations atomically',async()=>{
 const d=await make(),count=await counts();
 for(const change of [v=>v.confirm_record=false,v=>delete v.confirm_record,v=>v.confirm_record='true',v=>v.actor_id=users.admin,v=>v.total='0.01',v=>v.type='signature',v=>v.declarant_name='\u00a0\u200b',v=>v.declarant_name='😀'.repeat(201),v=>v.declarant_name='<b>Nome</b>',v=>v.declarant_name='Nome\nQuebra',v=>v.notes='\u0001',v=>v.notes='x'.repeat(2001),v=>v.occurred_on='2026-02-30',v=>v.occurred_on='2099-12-31',v=>v.occurred_on=null,v=>v.occurred_on=['2026-10-16'],v=>v.details.accessories={},v=>v.details.extra='bad',v=>delete v.details.apparent_condition,v=>v.correction_reason='Sem referência',v=>v.corrects_event_id=randomUUID(),v=>v.attachment_id=[]]){
  const value=data();change(value);await assert.rejects(()=>append(d,value),e=>['22023','22008','22007'].includes(e.code));
 }
 assert.deepEqual(await counts(),count);
 const long=await append(d,data('reception',{declarant_name:'😀'.repeat(200),notes:'😀'.repeat(2000),details:{accessories:'😀'.repeat(1000),apparent_condition:'😀'.repeat(1000)}}));assert.equal(Array.from(long.record.declarant_name).length,200);
});
test('049 exact maximum total, internal-only changes and seek pagination remain unambiguous',async()=>{
 let d=await make({items:[{product_id:product.id,description:'Valor máximo fictício',quantity:'1000',unit:'UN',unit_price:'999999999.9999'}],other_expenses:'0.09'});
 const original=await append(d);assert.equal(original.record.total,'999999999999.99');
 d=await save(d,body({items:[{id:d.items[0].id,product_id:product.id,description:'Valor máximo fictício',quantity:'1000',unit:'UN',unit_price:'999999999.9999'}],other_expenses:'0.09',internal_notes:'Outra observação privada'}));
 const historical=await get(d,original.record.id);assert.equal(historical.current.document_version_changed,true);assert.equal(historical.current.commercial_content_changed,false);
 for(let i=2;i<=5;i++)await append(d,data('reception',{notes:`Registro ${i}`}));
 const first=await list(d,users.consulta,2);assert.deepEqual(first.items.map(v=>v.record.sequence),['5','4']);await append(d,data('reception',{notes:'Durante paginação'}));
 const second=await list(d,users.consulta,2,first.next_before);assert.deepEqual(second.items.map(v=>v.record.sequence),['3','2']);
 const last=await list(d,users.consulta,2,second.next_before);assert.equal(last.items[0].record.sequence,'1');assert.equal(last.has_more,false);assert.equal(last.next_before,null);
 for(const limit of [0,26,null])await assert.rejects(()=>list(d,users.admin,limit),code('22023'));
 for(const cursor of ['0','01','-1','1.0','10000000000'])await assert.rejects(()=>list(d,users.admin,25,cursor),code('22023'));
});
test('049 append remains independent of active financial/stock bridges and does not mutate their ledgers or document',async()=>{
 let d=await make();d=await transition(d,'quoted');d=await transition(d,'approved');
 await rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-16',p_reason:'Saldo fictício',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity:'1.25',expected_version:0}]});
 const plan=[{due_on:'2026-11-01',amount_cents:'1250',method:null}];
 const fin=await rpc('erp_document_finance_preview',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_category_id:null,p_plan:plan});
 await rpc('erp_document_finance_post',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_preview_hash:fin.preview.preview_hash,p_category_id:null,p_plan:plan});
 d=(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
 const stock=await rpc('erp_document_stock_preview',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_occurred_on:'2026-10-16',p_reason:'Consumo fictício'});
 await rpc('erp_document_stock_post',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_preview_hash:stock.preview.preview_hash,p_occurred_on:'2026-10-16',p_reason:'Consumo fictício',p_ignored_item_ids:[]});
 d=(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
 const tables=['erp_documents.document','erp_documents.item','erp_documents.audit','erp_stock.movement','erp_stock.balance','erp_stock.document_posting','erp_finance.title','erp_finance.document_posting'];
 const snapshot=async()=>Promise.all(tables.map(t=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]')value from ${t} t`)));
 const before=await snapshot();await append(d,data('customer_decision'));assert.deepEqual(await snapshot(),before);
});
test('049 failure after event insertion rolls back sequence/command; authorization is checked again after document wait',async()=>{
 const d=await make(),count=await counts();
 await db.exec("create function public.test_event_failure()returns trigger language plpgsql as $$begin raise exception 'synthetic rollback';end$$;create trigger test_event_failure before insert on erp_documents.service_event_command for each row execute function public.test_event_failure();");
 try{await assert.rejects(()=>append(d),/synthetic rollback/);}finally{await db.exec('drop trigger test_event_failure on erp_documents.service_event_command;drop function public.test_event_failure();');}
 assert.deepEqual(await counts(),count);assert.equal((await append(d)).record.sequence,'1');
 const definition=await scalar("select pg_get_functiondef('erp_documents.require_access(uuid,text,boolean)'::regprocedure)value");
 // Single-session fault models revocation committed during a lock wait; no production helper is replaced remotely.
 await db.exec(`create temporary table test_access_count(n int);insert into test_access_count values(0);create or replace function erp_documents.require_access(p_user_id uuid,p_kind text,p_write boolean)returns void language plpgsql set search_path=pg_catalog as $$declare n int;begin update pg_temp.test_access_count set n=test_access_count.n+1 returning test_access_count.n into n;if n>=2 then raise exception 'denied after wait'using errcode='42501';end if;end$$;`);
 try{const before=await counts();await assert.rejects(()=>append(d),code('42501'));assert.deepEqual(await counts(),before);}finally{await db.exec(definition);}
});
