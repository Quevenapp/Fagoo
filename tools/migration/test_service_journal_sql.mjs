import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {parseServiceJournalRoute,executeServiceJournalRoute,serviceJournalResponse} from '../../workers/erp-api/src/service-journal.mjs';
import {journalEnvelope,journalPage} from '../../apps/erp/src/lib/service-journal-model.ts';
let db,contact,product,warehouse;const users={};
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
const code=expected=>error=>error.code===expected;
async function rpc(name,args){await db.exec('set role service_role');try{const entries=Object.entries(args);return await scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([key,value])=>['p_body','p_data','p_items','p_ignored_item_ids'].includes(key)&&value!==null?JSON.stringify(value):value));}finally{await db.exec('reset role');}}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0014_erp_cnab','0017_document_finance','0018_document_stock','0028_service_order_journal'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','vendas','financeiro','consulta','estoque','fiscal','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 const save=async(entity,data)=>(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data})).record;
 contact=await save('contacts',{name:'Contato fictício de OS',document:'PRIVATE_CONTACT_DOCUMENT'});
 product=await save('products',{name:'Peça fictícia',code:'QA-JOURNAL',unit:'UN',kind:'P',format:'S',price:'1'});
 warehouse=await save('warehouses',{name:'Depósito fictício'});
});
after(()=>db?.close());
const make=async(kind='service_orders')=>(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-16',contact_id:contact.id,warehouse_id:warehouse.id,items:[{product_id:product.id,description:'Peça fictícia',quantity:'1',unit:'UN',unit_price:'1'}],internal_notes:'PRIVATE_INTERNAL_NOTE',installments:[{due_date:'2026-11-01',amount:'1'}]}})).document;
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Motivo fictício'})).document;
const list=(d,actor=users.admin,limit=25,before=null)=>rpc('erp_service_journal_list',{p_user_id:actor,p_document_id:d.id,p_limit:limit,p_before:before});
const append=(d,text='Diagnóstico sintético',command=randomUUID(),actor=users.admin)=>rpc('erp_service_journal_append',{p_user_id:actor,p_document_id:d.id,p_expected_document_version:d.version,p_command_id:command,p_text:text});
const get=(d,id,actor=users.admin)=>rpc('erp_service_journal_get',{p_user_id:actor,p_document_id:d.id,p_entry_id:id});

test('028 RPC grants/RLS and original OS role matrix apply to reads, writes and replays',async()=>{
 const d=await make();
 for(const table of ['service_journal_entry','service_journal_command']){
  assert.equal(await scalar('select relrowsecurity value from pg_class where oid=$1::regclass',[`erp_documents.${table}`]),true);
  for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[role,`erp_documents.${table}`]),false);
 }
 for(const role of ['anon','authenticated'])for(const signature of ['erp_service_journal_list(uuid,uuid,integer,text)','erp_service_journal_get(uuid,uuid,uuid)','erp_service_journal_append(uuid,uuid,integer,uuid,text)'])assert.equal(await scalar("select has_function_privilege($1,$2,'EXECUTE')value",[role,`public.${signature}`]),false);
 for(const role of ['admin','vendas','financeiro','consulta'])assert.equal((await list(d,users[role])).can_write,['admin','vendas'].includes(role));
 for(const role of ['estoque','fiscal','inactive'])await assert.rejects(()=>list(d,users[role]),code('42501'));
 for(const role of ['financeiro','consulta','estoque','fiscal','inactive'])await assert.rejects(()=>append(d,'Não permitido',randomUUID(),users[role]),code('42501'));
 const command=randomUUID(),result=await append(d,'Texto de vendas',command,users.vendas);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.vendas]);
 await assert.rejects(()=>append(d,'Texto de vendas',command,users.vendas),code('42501'));await assert.rejects(()=>get(d,result.entry.id,users.vendas),code('42501'));
 await db.query('update erp_access.membership set active=true where user_id=$1',[users.vendas]);
 for(const kind of ['sales_proposals','sales_orders','purchase_orders']){const other=await make(kind);await assert.rejects(()=>append(other),code('P0002'));await assert.rejects(()=>list(other),code('P0002'));}
});
test('028 appends have server actor/time, exact text, atomic per-OS sequence and immutable history',async()=>{
 const d=await make(),before=await scalar('select to_jsonb(d) value from erp_documents.document d where id=$1',[d.id]);
 const first=await append(d,'  Recebido\nCom acessórios\tconferidos.  '),second=await append(d,'Teste concluído');
 assert.equal(first.entry.text,'Recebido\nCom acessórios\tconferidos.');assert.equal(first.entry.sequence,'1');assert.equal(second.entry.sequence,'2');assert.equal(first.entry.actor_id,users.admin);assert.ok(Date.parse(first.entry.recorded_at));
 assert.equal(first.entry.document_version,d.version);assert.equal(second.document_version,d.version);
 assert.deepEqual(await scalar('select to_jsonb(d) value from erp_documents.document d where id=$1',[d.id]),before);
 assert.doesNotMatch(JSON.stringify(await list(d)),/PRIVATE_|contact|total|price|installment|internal_notes/);
 for(const table of ['service_journal_entry','service_journal_command']){
  await assert.rejects(()=>db.query(`delete from erp_documents.${table} where ${table.endsWith('entry')?'document_id':'entry_id'}=$1`,[table.endsWith('entry')?d.id:first.entry.id]),code('55000'));
  await assert.rejects(()=>db.query(`update erp_documents.${table} set ${table.endsWith('entry')?'text=text':'request_hash=request_hash'} where ${table.endsWith('entry')?'document_id':'entry_id'}=$1`,[table.endsWith('entry')?d.id:first.entry.id]),code('55000'));
 }
});
test('028 CAS and exact command replay remain safe after status changes without reactivating anything',async()=>{
 let d=await make();const original=d,command=randomUUID(),first=await append(d,'Aprovação relatada pelo operador',command);
 d=await transition(d,'quoted');await assert.rejects(()=>append(original),code('40001'));
 const replay=await append(original,'Aprovação relatada pelo operador',command);assert.equal(replay.replayed,true);assert.deepEqual(replay.entry,first.entry);assert.equal(replay.document_version,d.version);
 await assert.rejects(()=>append(original,'Outro texto',command),code('40001'));await assert.rejects(()=>append(original,'Aprovação relatada pelo operador',command,users.vendas),code('40001'));
 const other=await make();await assert.rejects(()=>get(other,first.entry.id),code('P0002'));
 d=await transition(d,'cancelled');assert.equal((await append(d,'Complemento após cancelamento')).entry.sequence,'2');
 assert.equal((await scalar('select status value from erp_documents.document where id=$1',[d.id])),'cancelled');
});
test('028 journal remains writable with both active bridges, without changing documents, movements or titles',async()=>{
 let d=await make();d=await transition(d,'quoted');d=await transition(d,'approved');
 // Initialize one synthetic unit before the OS consumes it.
 await rpc('erp_stock_post',{p_user_id:users.admin,p_command_id:randomUUID(),p_kind:'receipt',p_occurred_on:'2026-10-16',p_reason:'Saldo inicial fictício',p_items:[{product_id:product.id,warehouse_id:warehouse.id,quantity:'1',expected_version:0}]});
 const fin=await rpc('erp_document_finance_preview',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_category_id:null,p_plan:null});
 await rpc('erp_document_finance_post',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_preview_hash:fin.preview.preview_hash,p_category_id:null,p_plan:null});
 d=(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
 const stock=await rpc('erp_document_stock_preview',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_occurred_on:'2026-10-16',p_reason:'Consumo fictício'});
 await rpc('erp_document_stock_post',{p_user_id:users.admin,p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_preview_hash:stock.preview.preview_hash,p_occurred_on:'2026-10-16',p_reason:'Consumo fictício',p_ignored_item_ids:[]});
 d=(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
 const tables=['erp_documents.document','erp_documents.item','erp_stock.movement','erp_stock.balance','erp_stock.document_posting','erp_finance.title','erp_finance.document_posting'];
 const snapshot=async()=>Promise.all(tables.map(t=>scalar(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${t} t`)));
 const before=await snapshot();await append(d,'Teste da peça e entrega registrados, sem novo consumo');assert.deepEqual(await snapshot(),before);
});
test('028 text boundaries, paging and append during paging preserve history without empty or synthetic entries',async()=>{
 const d=await make();for(const text of ['', ' \n\t\r ', 'x\u0001', 'x\u007f', 'x'.repeat(4001)])await assert.rejects(()=>append(d,text),code('22023'));
 await assert.rejects(()=>append(d,'x\u0000'),code('22021'));
 await append(d,'😀'.repeat(4000));for(let i=2;i<=5;i++)await append(d,`Atividade ${i}`);
 const page=await list(d,users.admin,2);assert.deepEqual(page.items.map(e=>e.sequence),['5','4']);assert.equal(page.next_before,'4');
 await append(d,'Atividade 6');const next=await list(d,users.admin,2,page.next_before);assert.deepEqual(next.items.map(e=>e.sequence),['3','2']);
 const last=await list(d,users.admin,2,next.next_before);assert.equal(last.items[0].sequence,'1');assert.equal(last.has_more,false);assert.equal(last.next_before,null);
 for(const cursor of ['0','01','-1','1.0','10000000000'])await assert.rejects(()=>list(d,users.admin,2,cursor),code('22023'));
});
test('028 actual SQL and HTTP bind document/entry/actor/version, strip extras and reject unsafe transport',async()=>{
 const d=await make(),path=`https://synthetic.invalid/v1/ordens-servico/${d.id}/diario`;
 const request=new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),expected_document_version:d.version,text:'Conferência sintética'})});
 const route=await parseServiceJournalRoute(request),saved=await executeServiceJournalRoute(route,{userId:users.admin,rpc});assert.equal(saved.entry.text,'Conferência sintética');
 const read=await parseServiceJournalRoute(new Request(`${path}/${saved.entry.id.toUpperCase()}`));assert.equal((await executeServiceJournalRoute(read,{userId:users.consulta,rpc})).entry.id,saved.entry.id);
 const listRoute=await parseServiceJournalRoute(new Request(path)),page=await executeServiceJournalRoute(listRoute,{userId:users.admin,rpc});assert.equal(page.items.length,1);
 assert.equal(journalPage(page,d.id).items.length,1);assert.equal(journalEnvelope(saved,d.id,{entryId:saved.entry.id}).entry.id,saved.entry.id);
 assert.equal(serviceJournalResponse({...saved,private_secret:'never'},route,users.admin).private_secret,undefined);
 for(const mutate of [v=>v.document_id=randomUUID(),v=>v.entry.actor_id=randomUUID(),v=>v.entry.actor_id=[users.admin],v=>v.entry.sequence=1,v=>v.entry.id=[saved.entry.id],v=>v.entry.document_version++,v=>v.entry.text='trocado',v=>v.operational_effects=true]){const bad=structuredClone(saved);mutate(bad);assert.throws(()=>serviceJournalResponse(bad,route,users.admin),error=>error.status===502);}
 for(const suffix of ['?limit=0','?before=01','?actor=x','?limit=2&limit=3','/invalid'])await assert.rejects(()=>parseServiceJournalRoute(new Request(path+suffix)));
 for(const extra of [{actor_id:users.admin},{recorded_at:'2026-10-16'},{status:'finalized'}])await assert.rejects(()=>parseServiceJournalRoute(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),expected_document_version:d.version,text:'Texto',...extra})})));
 for(const command_id of [[randomUUID()],{},null])await assert.rejects(()=>parseServiceJournalRoute(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id,expected_document_version:d.version,text:'Texto'})})),error=>error.status===400);
 await assert.rejects(()=>parseServiceJournalRoute(new Request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(32769)})),error=>error.status===400);
 await assert.rejects(()=>parseServiceJournalRoute(new Request(`${path}/${saved.entry.id}`,{method:'POST'})));
});
