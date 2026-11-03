import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {parseDocumentFinanceRoute,executeDocumentFinanceRoute} from '../../workers/erp-api/src/document-finance.mjs';
let db,contact;const users={};const day='2026-10-16';const code=expected=>error=>error.code===expected;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
async function rpc(name,args){await db.exec('set role service_role');try{const entries=Object.entries(args);return await scalar(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([key,value])=>['p_data','p_body','p_plan','p_title_versions'].includes(key)&&value!==null?JSON.stringify(value):value));}finally{await db.exec('reset role');}}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0010_erp_finance','0014_erp_cnab','0017_document_finance'])await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const role of ['admin','financeiro','consulta','vendas','estoque','fiscal','inactive']){users[role]=randomUUID();await db.query('insert into auth.users values($1)',[users[role]]);await db.query('insert into erp_access.membership(user_id,role,active)values($1,$2,$3)',[users[role],role==='inactive'?'admin':role,role!=='inactive']);}
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Contato sintético de vínculo',document:'PRIVATE_DOCUMENT_NOT_PROJECTED'}})).record;
});
after(()=>db?.close());
const body=(installments=true)=>({date:day,contact_id:contact.id,items:[{description:'Item sintético',unit:'UN',quantity:'3',unit_price:'1.005'}],installments:installments?[{due_date:'2026-11-01',amount:'1.01',method:'Prazo fictício'},{due_date:'2026-12-01',amount:'2.01'}]:[],internal_notes:'PRIVATE_NOTE_NOT_PROJECTED'});
const save=(kind='sales_orders',data=body(),id=null,version=0)=>rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:id,p_expected_version:version,p_command_id:randomUUID(),p_body:data});
const transition=(d,status)=>rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Correção de teste'});
const current=async d=>(await rpc('erp_document_get',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id})).document;
async function eligible(kind='sales_orders',data=body()){let d=(await save(kind,data)).document;for(const status of kind==='sales_orders'?['open','verified']:kind==='purchase_orders'?['in_progress']:['quoted','approved'])d=(await transition(d,status)).document;return d;}
const scope=d=>({p_kind:d.kind,p_document_id:d.id,p_expected_version:d.version});
const preview=(d,plan=null,category=null,user=users.admin)=>rpc('erp_document_finance_preview',{p_user_id:user,...scope(d),p_category_id:category,p_plan:plan});
const post=(d,p,command=randomUUID(),plan=null,category=null,user=users.admin)=>rpc('erp_document_finance_post',{p_user_id:user,...scope(d),p_command_id:command,p_preview_hash:p.preview.preview_hash,p_category_id:category,p_plan:plan});
const list=(d,user=users.admin,limit=25,after=null)=>rpc('erp_document_finance_list',{p_user_id:user,p_kind:d.kind,p_document_id:d.id,p_limit:limit,p_after:after});
const get=(d,id,user=users.admin)=>rpc('erp_document_finance_get',{p_user_id:user,p_kind:d.kind,p_document_id:d.id,p_posting_id:id});
const reversePreview=(d,p,user=users.admin)=>rpc('erp_document_finance_reverse_preview',{p_user_id:user,...scope(d),p_posting_id:p.id,p_posting_version:p.version});
const reverse=(d,p,r,command=randomUUID(),overrides={})=>rpc('erp_document_finance_reverse',{p_user_id:users.admin,...scope(d),p_posting_id:p.id,p_posting_version:p.version,p_command_id:command,p_preview_hash:r.preview.preview_hash,p_title_versions:r.preview.titles.map(t=>({id:t.id,version:t.version})),p_reason:'Estorno integral sintético',...overrides});
const finance=(action,data)=>rpc('erp_finance_execute',{p_user_id:users.admin,p_command_id:randomUUID(),p_action:action,p_data:data});
const count=table=>scalar(`select count(*)::int value from ${table}`);
const writeBody=d=>({date:d.date,contact_id:d.contact_id,warehouse_id:d.warehouse_id,items:d.items.map(i=>({id:i.id,product_id:i.product_id,description:i.description,code:i.code,unit:i.unit,quantity:i.quantity,unit_price:i.unit_price,discount_percent:i.discount_percent})),installments:d.installments.map(p=>({due_date:p.due_date,amount:p.amount,method:p.method})),internal_notes:d.internal_notes});

test('private schema/RPC grants and role matrix protect posting, preview and read without side effects',async()=>{
 const d=await eligible();const beforeTitles=await count('erp_finance.title');
 for(const table of ['document_posting','document_title','document_command']){
  assert.equal(await scalar("select relrowsecurity value from pg_class where oid=$1::regclass",[`erp_finance.${table}`]),true);
  for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')value",[role,`erp_finance.${table}`]),false);
 }
 for(const role of ['admin','financeiro'])assert.equal((await preview(d,null,null,users[role])).preview.total_cents,'302');
 for(const role of ['consulta','vendas','estoque','fiscal','inactive'])await assert.rejects(()=>preview(d,null,null,users[role]),code('42501'));
 assert.deepEqual((await list(d,users.consulta)).items,[]);
 for(const role of ['vendas','estoque','fiscal','inactive'])await assert.rejects(()=>list(d,users[role]),code('42501'));
 for(const role of ['anon','authenticated'])assert.equal(await scalar("select has_function_privilege($1,'public.erp_document_finance_preview(uuid,text,uuid,integer,uuid,jsonb)','EXECUTE')value",[role]),false);
 assert.equal(await count('erp_finance.title'),beforeTitles);assert.equal(await count('erp_finance.movement'),0);
});
test('saved installments derive exact amounts/contact/direction and permanent active uniqueness rejects other commands',async()=>{
 for(const kind of ['sales_orders','purchase_orders','service_orders']){
  const d=await eligible(kind),p=await preview(d),command=randomUUID(),result=await post(d,p,command);
  assert.equal(result.posting.direction,kind==='purchase_orders'?'payable':'receivable');assert.equal(result.posting.total_cents,'302');
  assert.deepEqual(result.titles.map(t=>t.amount_cents),['101','201']);assert.equal(result.document_version,d.version+1);assert.equal(result.cash_movement_performed,false);
  assert.equal((await post(d,p,command)).replayed,true);assert.equal((await post(d,p,command)).posting.id,result.posting.id);
  await assert.rejects(()=>post(d,p),code('40001'));await assert.rejects(async()=>preview(await current(d)),code('40001'));
  assert.equal((await list(d)).active_posting.id,result.posting.id);assert.equal((await get(d,result.posting.id)).titles.length,2);
  const ids=(await db.query('select contact_id,kind,source_reference from erp_finance.title where group_id=$1',[result.posting.group_id])).rows;
  assert.ok(ids.every(row=>row.contact_id===contact.id&&row.kind===result.posting.direction&&row.source_reference===null));
 }
 assert.equal(await count('erp_finance.movement'),0);assert.equal(await count('erp_finance.settlement'),0);
});
test('eligibility and explicit plans reject quotations, unsaved dates, totals, overrides and invented default due dates',async()=>{
 const quote=(await save('sales_proposals')).document;await assert.rejects(()=>preview(quote),code('40001'));
 const draft=(await save()).document;await assert.rejects(()=>preview(draft),code('40001'));
 const d=await eligible('sales_orders',body(false));await assert.rejects(()=>preview(d),code('22023'));
 for(const plan of [[],[{amount_cents:302,due_on:'2026-11-01'}],[{amount_cents:'301',due_on:'2026-11-01'}],[{amount_cents:'302',due_on:'2026-10-15'}],[{amount_cents:'302',due_on:'2026-02-30'}],[{amount_cents:'302',due_on:'2026-11-01',contact_id:contact.id}]])await assert.rejects(()=>preview(d,plan),code('22023'));
 const plan=[{amount_cents:'302',due_on:'2026-11-01',method:'Conferido manualmente'}],p=await preview(d,plan);assert.equal(p.preview.plan_source,'explicit');
 assert.equal((await post(d,p,randomUUID(),plan)).titles.length,1);
 await assert.rejects(async()=>preview(await eligible(),plan),code('22023'));
 const zero=await eligible('service_orders',{...body(false),items:[]});await assert.rejects(()=>preview(zero,plan),code('22023'));
});
test('active effect freezes document body/items/cancellation while permitting safe progress; source principal is permanent',async()=>{
 let d=await eligible('sales_orders',body(false));const plan=[{amount_cents:'302',due_on:'2026-11-01'}],result=await post(d,await preview(d,plan),randomUUID(),plan);d=await current(d);
 await assert.rejects(()=>save(d.kind,{...writeBody(d),internal_notes:'Even private edits need reversal'},d.id,d.version),code('40001'));
 await assert.rejects(()=>transition(d,'cancelled'),code('40001'));await assert.rejects(()=>transition(d,'open'),code('40001'));
 await assert.rejects(()=>db.query("update erp_documents.item set data=data||'{\"code\":\"changed\"}' where document_id=$1",[d.id]),code('40001'));
 d=(await transition(d,'in_progress')).document;d=(await transition(d,'partially_fulfilled')).document;d=(await transition(d,'fulfilled')).document;
 await assert.rejects(()=>transition(d,'open'),code('40001'));
 const t=result.titles[0];await assert.rejects(()=>finance('title_update',{id:t.id,expected_version:t.version,amount_cents:'999'}),code('40001'));
 const edit=await finance('title_update',{id:t.id,expected_version:t.version,due_on:'2026-12-01',source_reference:'Human annotation, not a foreign key'});
 assert.equal(edit.record.due_on,'2026-12-01');assert.equal((await get(d,result.posting.id)).titles[0].due_on,'2026-12-01');
 await finance('title_cancel',{id:t.id,expected_version:edit.record.version,note:'Correção financeira explícita'});
 assert.equal((await list(d)).active_posting.id,result.posting.id);await assert.rejects(()=>transition(d,'open'),code('40001'));
 const rp=await reversePreview(d,result.posting);assert.equal((await reverse(d,result.posting,rp)).posting.state,'reversed');
});
test('correction reverses the whole unpaid group, permits editing and creates a new group without replay duplication',async()=>{
 let d=await eligible(),source=d;const p=await preview(d),command=randomUUID(),first=await post(d,p,command);d=await current(d);
 const rp=await reversePreview(d,first.posting),reverseCommand=randomUUID();
 const reversed=await reverse(d,first.posting,rp,reverseCommand);assert.ok(reversed.titles.every(t=>t.cancelled));assert.equal(reversed.posting.version,2);assert.equal((await reverse(d,first.posting,rp,reverseCommand)).replayed,true);
 const titleCount=await count('erp_finance.title');assert.equal((await post(source,p,command)).replayed,true);assert.equal((await list(d)).active_posting,null);assert.equal(await count('erp_finance.title'),titleCount);
 d=await current(d);const updated={...writeBody(d),items:[{...writeBody(d).items[0],quantity:'4'}],installments:[{amount:'4.02',due_date:'2026-11-30'}]};
 d=(await save(d.kind,updated,d.id,d.version)).document;
 const next=await post(d,await preview(d));assert.notEqual(next.posting.group_id,first.posting.group_id);assert.equal(next.posting.total_cents,'402');
 assert.equal((await post(source,p,command)).posting.id,first.posting.id);
 assert.equal((await get(d,first.posting.id)).posting.state,'reversed');assert.equal((await list(d)).active_posting.id,next.posting.id);
 const page=await list(d,users.admin,1);assert.equal(page.has_more,true);const page2=await list(d,users.admin,1,page.next_cursor);assert.equal(page2.has_more,false);assert.notEqual(page.items[0].id,page2.items[0].id);
 assert.equal(await scalar("select count(*)::int value from erp_finance.document_posting where document_id=$1 and state='active'",[d.id]),1);
 await db.query('update erp_access.membership set active=false where user_id=$1',[users.admin]);await assert.rejects(()=>post(source,p,command),code('42501'));await db.query('update erp_access.membership set active=true where user_id=$1',[users.admin]);
});
test('reversal validates every title version and hash, and rejects partial group correction atomically',async()=>{
 let d=await eligible();const result=await post(d,await preview(d));d=await current(d);const rp=await reversePreview(d,result.posting),before=await get(d,result.posting.id);
 await assert.rejects(()=>reverse(d,result.posting,rp,randomUUID(),{p_title_versions:[{id:result.titles[0].id,version:1}]}),code('40001'));
 await assert.rejects(()=>reverse(d,result.posting,rp,randomUUID(),{p_reason:'a'}),code('22023'));
 await assert.rejects(()=>reverse(d,result.posting,rp,randomUUID(),{p_preview_hash:'0'.repeat(64)}),code('40001'));
 assert.deepEqual(await get(d,result.posting.id),before);
 await finance('title_update',{id:result.titles[1].id,expected_version:1,description:'Conferido após prévia'});
 await assert.rejects(()=>reverse(d,result.posting,rp),code('40001'));assert.ok((await get(d,result.posting.id)).titles.every(t=>!t.cancelled));
});
test('active settlements block reverse, historical reversed settlements survive and no new cash effect is created',async()=>{
 let d=await eligible();const result=await post(d,await preview(d));d=await current(d);
 const account=await finance('account_save',{expected_version:0,name:'Conta fictícia de teste',kind:'cash'});
 const paid=await finance('settle',{id:result.titles[0].id,expected_version:1,account_id:account.record.id,posted_on:day,principal_cents:'100'});
 await assert.rejects(()=>reversePreview(d,result.posting),code('40001'));
 await finance('reverse',{id:paid.record.id,expected_version:paid.record.version,settlement_id:paid.settlement.id,posted_on:day,note:'Estorno sintético da baixa'});
 const movements=await count('erp_finance.movement'),settlements=await count('erp_finance.settlement');
 const reversed=await reverse(d,result.posting,await reversePreview(d,result.posting));assert.ok(reversed.titles.every(t=>t.cancelled&&t.settled_cents==='0'));
 assert.equal(await count('erp_finance.movement'),movements);assert.equal(await count('erp_finance.settlement'),settlements);
 assert.equal(await scalar('select sum(delta_cents)::text value from erp_finance.movement where account_id=$1',[account.record.id]),'0');
});
test('any persistent CNAB link blocks group reversal, including a reserved file, without deleting bank evidence',async()=>{
 let d=await eligible();const result=await post(d,await preview(d));d=await current(d);
 const a=(await finance('account_save',{expected_version:0,name:'Banco fictício CNAB',kind:'bank'})).record;
 const profile=randomUUID(),remittance=randomUUID();
 await db.query("insert into erp_cnab.profile(id,account_id,identity,settings,account_scope,next_sequence)values($1,$2,'{}','{}',$3,1)",[profile,a.id,randomUUID()]);
 await db.query("insert into erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor)values($1,$2,1,$3,'{}',$4)",[remittance,profile,day,users.admin]);
 await db.query("insert into erp_cnab.billing_title(title_id,profile_id,remittance_id,control,document_number,snapshot)values($1,$2,$3,'SYNTHETIC','QA-01','{}')",[result.titles[0].id,profile,remittance]);
 await assert.rejects(()=>reversePreview(d,result.posting),code('40001'));assert.equal((await get(d,result.posting.id)).titles[0].cnab_linked,true);assert.ok((await get(d,result.posting.id)).titles.every(t=>!t.cancelled));
});
test('contact/category changes invalidate the reviewed hash and output excludes raw contact and document notes',async()=>{
 const d=await eligible(),p=await preview(d);assert.doesNotMatch(JSON.stringify(p),/PRIVATE_DOCUMENT|PRIVATE_NOTE/);
 contact=(await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'contacts',p_id:contact.id,p_expected_version:contact.version,p_command_id:randomUUID(),p_data:{name:'Nome atualizado após a prévia'}})).record;
 await assert.rejects(()=>post(d,p),code('40001'));const fresh=await preview(d);assert.equal(fresh.preview.contact_name,'Contato sintético de vínculo');assert.notEqual(fresh.preview.preview_hash,p.preview.preview_hash);
 const category=(await finance('category_save',{expected_version:0,name:'Categoria AR',kind:'receivable'})).record;
 const cp=await preview(d,null,category.id);await finance('category_save',{id:category.id,expected_version:category.version,name:'Renomeada',kind:'receivable'});
 await assert.rejects(()=>post(d,cp,randomUUID(),null,category.id),code('40001'));assert.equal((await list(d)).active_posting,null);
});
test('HTTP bridge executes against real SQL, binds actor/scope and projects only safe source/title summaries',async()=>{
 const d=await eligible();const base=`/v1/documentos/${d.kind}/${d.id}/financeiro`;
 const api=async(path,method='GET',body)=>{const route=await parseDocumentFinanceRoute(new Request(`https://api.example.test${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}));return executeDocumentFinanceRoute(route,{userId:users.financeiro,rpc});};
 const p=await api(`${base}/preview`,'POST',{expected_document_version:d.version});
 const posted=await api(`${base}/post`,'POST',{expected_document_version:d.version,preview_hash:p.preview.preview_hash,command_id:randomUUID()});
 assert.equal(posted.posting.total_cents,'302');assert.equal((await api(base)).active_posting.id,posted.posting.id);
 const detail=await api(`${base}/${posted.posting.id}`);assert.deepEqual(detail.titles.map(t=>t.amount_cents),['101','201']);assert.equal(detail.posting.actor,undefined);
 assert.deepEqual(await api(`/v1/documentos/${d.kind}/${d.id.toUpperCase()}/financeiro/${posted.posting.id.toUpperCase()}`),detail);
 const rp=await api(`${base}/${posted.posting.id}/reverse-preview`,'POST',{expected_document_version:posted.document_version,expected_posting_version:1});
 const reversed=await api(`${base}/${posted.posting.id}/reverse`,'POST',{expected_document_version:posted.document_version,expected_posting_version:1,preview_hash:rp.preview.preview_hash,title_versions:rp.preview.titles.map(t=>({id:t.id,version:t.version})),reason:'Correção via API sintética',command_id:randomUUID()});
 assert.equal(reversed.posting.state,'reversed');assert.equal(reversed.cash_movement_performed,false);
});
