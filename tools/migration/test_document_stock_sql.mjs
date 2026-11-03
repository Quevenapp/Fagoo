import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { parseDocumentStockRoute, executeDocumentStockRoute, documentStockMethods } from '../../workers/erp-api/src/document-stock.mjs';

let db;
const users = Object.fromEntries(['admin','estoque','financeiro','consulta','vendas','fiscal'].map(role => [role,randomUUID()]));
const code = expected => error => error.code === expected;
const scalar = async (sql,args=[]) => (await db.query(sql,args)).rows[0].value;
async function rpc(name,args) {
 const pairs=Object.entries(args);await db.exec('set role service_role');
 try {return await scalar(`select public.${name}(${pairs.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,pairs.map(([,value])=>value!==null&&typeof value==='object'?JSON.stringify(value):value));}
 finally {await db.exec('reset role');}
}
const catalog=(entity,data)=>rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:entity,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:data});
const transition=async(d,status)=>(await rpc('erp_document_transition',{p_user_id:users.admin,p_kind:d.kind,p_id:d.id,p_expected_version:d.version,p_command_id:randomUUID(),p_status:status,p_reason:'Revisão sintética'})).document;
const scope=(f,user=users.estoque)=>({p_user_id:user,p_kind:f.doc.kind,p_document_id:f.doc.id,p_expected_version:f.doc.version});
const meta={p_occurred_on:'2026-10-15',p_reason:'Lançamento sintético revisado'};
async function preview(f,extra={}) {return (await rpc('erp_document_stock_preview',{...scope(f),...meta,...extra})).preview;}
async function post(f,{command=randomUUID(),prior,extra={}}={}) {
 const p=prior??await preview(f),args={...scope(f),...meta,p_command_id:command,p_preview_hash:p.preview_hash,p_ignored_item_ids:p.ignored.map(i=>i.id),...extra};
 const result=await rpc('erp_document_stock_post',args);f.doc.version=result.document_version;return {result,args,preview:p};
}
async function undo(f,posted,{command=randomUUID(),extra={}}={}) {
 const input={...scope(f),p_posting_id:posted.result.posting.id,p_posting_version:posted.result.posting.version,...meta};
 const {preview:p}=await rpc('erp_document_stock_reverse_preview',input);
 const args={...input,p_command_id:command,p_preview_hash:p.preview_hash,...extra},result=await rpc('erp_document_stock_reverse',args);
 f.doc.version=result.document_version;return {result,args,preview:p};
}
const balance=f=>scalar('select quantity::text value from erp_stock.balance where product_id=$1 and warehouse_id=$2',[f.product,f.warehouse]);
const stock=async(f,quantity,expected_version=0,kind='receipt',command=randomUUID())=>rpc('erp_stock_post',{p_user_id:users.estoque,p_command_id:command,p_kind:kind,p_occurred_on:'2026-10-14',p_reason:'Saldo sintético inicial',p_items:[{product_id:f.product,warehouse_id:f.warehouse,quantity,expected_version}]});
async function fixture({kind='purchase_orders',items,product={},seed=false}={}) {
 const contact=(await catalog('contacts',{name:'Pessoa fictícia documental'})).record.id;
 const productId=(await catalog('products',{name:'Peça fictícia',unit:'UN',kind:'P',format:'S',price:'99.0000',...product})).record.id;
 const warehouse=(await catalog('warehouses',{name:'Depósito fictício'})).record.id;
 const body={date:'2026-10-15',contact_id:contact,warehouse_id:warehouse,notes:'Não deve sair na projeção estoque',internal_notes:'Segredo de demonstração',items:items?items(productId):[{product_id:productId,description:'Peça fictícia',unit:'UN',quantity:'2.000001',unit_price:'99'}]};
 let doc=(await rpc('erp_document_save',{p_user_id:users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:body})).document;
 for(const state of kind==='sales_orders'?['open','verified']:kind==='purchase_orders'?['in_progress']:['quoted','approved']) doc=await transition(doc,state);
 const f={doc,contact,product:productId,warehouse,body};if(seed)await stock(f,'100');return f;
}
before(async()=>{
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));alter table storage.objects enable row level security;');
 for(const name of ['0001_origin_sync','0002_origin_quotes_nfce','0004_erp_access','0006_erp_catalog','0008_erp_documents','0009_erp_stock','0010_erp_finance','0011_catalog_stock_lock_order','0014_erp_cnab','0017_document_finance','0018_document_stock'])
  await db.exec(await readFile(new URL(`../../supabase/migrations/20261016${name}.sql`,import.meta.url),'utf8'));
 for(const [role,id] of Object.entries(users)){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into erp_access.membership(user_id,role)values($1,$2)',[id,role]);}
});
after(async()=>db?.close());

test('018 RLS/service-only grants and narrow OS projection permit only admin/estoque',async()=>{
 const f=await fixture({kind:'service_orders',seed:true});
 for(const role of ['anon','authenticated','service_role']) {
  await db.exec(`set role ${role}`);try {
   for(const table of ['document_posting','document_command','document_audit'])await assert.rejects(()=>db.query(`select * from erp_stock.${table}`),code('42501'));
   if(role!=='service_role')await assert.rejects(()=>scalar('select public.erp_document_stock_get($1,$2,$3) value',[users.admin,f.doc.kind,f.doc.id]),code('42501'));
  }finally{await db.exec('reset role');}
 }
 for(const user of [users.financeiro,users.consulta,users.vendas,users.fiscal])await assert.rejects(()=>rpc('erp_document_stock_get',{p_user_id:user,p_kind:f.doc.kind,p_document_id:f.doc.id}),code('42501'));
 const dto=await rpc('erp_document_stock_get',{p_user_id:users.estoque,p_kind:f.doc.kind,p_document_id:f.doc.id});
 assert.equal(dto.document.kind,'service_orders');assert.equal(dto.items[0].quantity,'2.000001');
 for(const field of ['price','total','notes','internal_notes','contact_snapshot','installments','equipment'])assert.equal(JSON.stringify(dto).includes(`"${field}"`),false);
 await assert.rejects(()=>rpc('erp_document_get',{p_user_id:users.estoque,p_kind:f.doc.kind,p_id:f.doc.id}),code('42501'));
 assert.equal(await scalar("select bool_and(relrowsecurity) value from pg_class join pg_namespace on pg_namespace.oid=relnamespace where nspname='erp_stock' and relname like 'document_%' and relkind='r'"),true);
});
test('preview makes no writes; repeated products aggregate exactly and retain source item identities',async()=>{
 const f=await fixture({items:p=>[{product_id:p,description:'Peça A',unit:'UN',quantity:'0.000001',unit_price:'1'},{product_id:p,description:'Peça B',unit:'UN',quantity:'2.123456',unit_price:'2'}]});
 const before=await scalar('select count(*)::int value from erp_stock.movement');const p=await preview(f);
 assert.equal(p.positions.length,1);assert.equal(p.positions[0].quantity,'2.123457');assert.equal(p.positions[0].sources.length,2);
 assert.equal(await scalar('select count(*)::int value from erp_stock.movement'),before);
 assert.equal(await scalar('select count(*)::int value from erp_stock.balance where product_id=$1',[f.product]),0);
 const created=await post(f,{prior:p});assert.equal(created.result.movement.items[0].quantity,'2.123457');assert.equal(await balance(f),'2.123457');
 assert.equal((await rpc('erp_document_stock_post',created.args)).replayed,true);
 assert.equal(await scalar('select count(*)::int value from erp_stock.document_posting where document_id=$1',[f.doc.id]),1);
 await assert.rejects(()=>rpc('erp_document_stock_post',{...created.args,p_reason:'Outro motivo'}),code('40001'));
 await assert.rejects(()=>preview(f),code('40001'));
});
test('free items and services require exact acknowledgment and never become stock products',async()=>{
 const service=(await catalog('products',{name:'Serviço fictício',unit:'HR',kind:'S'})).record.id;
 const f=await fixture({items:p=>[{product_id:p,description:'Peça',unit:'UN',quantity:'1',unit_price:'1'},{product_id:service,description:'Serviço',unit:'HR',quantity:'3',unit_price:'1'},{description:'Item livre',unit:'UN',quantity:'4',unit_price:'1'}]});
 const p=await preview(f);assert.deepEqual(p.ignored.map(i=>i.reason),['service','unlinked_item']);
 for(const ack of [[],[p.ignored[0].id],[...p.ignored.map(i=>i.id),p.ignored[0].id],[...p.ignored.map(i=>i.id),f.doc.items[0].id]])
  await assert.rejects(()=>post(f,{prior:p,extra:{p_ignored_item_ids:ack}}),code('22023'));
 const result=await post(f,{prior:p});assert.equal(result.result.movement.items.length,1);
 assert.equal(await scalar('select count(*)::int value from erp_stock.entry where product_id=$1',[service]),0);
});
test('eligible states and physical product/unit/format checks reject unsupported interpretation',async()=>{
 for(const product of [{format:'E'},{format:'V'},{kind:'N'},{unit:null}]) {const f=await fixture({product});await assert.rejects(()=>preview(f),code('22023'));}
 const f=await fixture({items:p=>[{product_id:p,description:'Peça',unit:'CX',quantity:'1',unit_price:'1'}]});await assert.rejects(()=>preview(f),code('22023'));
 const noStock=await fixture({items:()=>[{description:'Só livre',unit:'UN',quantity:'1',unit_price:'1'}]});await assert.rejects(()=>preview(noStock),code('22023'));
 const closed=await fixture();closed.doc=await transition(closed.doc,'cancelled');await assert.rejects(()=>preview(closed),code('40001'));
 const inactive=await fixture();await db.query('update erp_catalog.record set active=false where id=$1',[inactive.warehouse]);await assert.rejects(()=>preview(inactive),code('22023'));
});
test('catalog, document and balance versions invalidate preview without any partial posting',async()=>{
 const f=await fixture({kind:'sales_orders',seed:true}),p=await preview(f),before=await scalar('select count(*)::int value from erp_stock.movement');
 await stock(f,'1',1);await assert.rejects(()=>post(f,{prior:p}),code('40001'));
 assert.equal(await scalar('select count(*)::int value from erp_stock.movement'),before+1);
 const p2=await preview(f);await rpc('erp_catalog_save',{p_user_id:users.admin,p_entity:'products',p_id:f.product,p_expected_version:1,p_command_id:randomUUID(),p_data:{name:'Produto renomeado'}});
 await assert.rejects(()=>post(f,{prior:p2}),code('40001'));
 const p3=await preview(f);f.doc=await transition(f.doc,'in_progress');await assert.rejects(()=>post(f,{prior:p3}),code('40001'));
 const empty=await fixture({kind:'sales_orders'});await assert.rejects(()=>preview(empty),code('22023'));
 assert.equal(await scalar('select count(*)::int value from erp_stock.document_posting where document_id in($1,$2)',[f.doc.id,empty.doc.id]),0);
});
test('active linkage blocks document economics/items/cancellation and generic stock reversal',async()=>{
 const f=await fixture({kind:'sales_orders',seed:true}),posted=await post(f);
 for(const sql of ["update erp_documents.document set body=body||'{\"notes\":\"changed\"}' where id=$1","update erp_documents.document set status='cancelled' where id=$1","delete from erp_documents.document where id=$1"])
  await assert.rejects(()=>db.query(sql,[f.doc.id]),code('40001'));
 await assert.rejects(()=>db.query('delete from erp_documents.item where document_id=$1',[f.doc.id]),code('40001'));
 await assert.rejects(()=>db.query('update erp_documents.item set quantity=3 where document_id=$1',[f.doc.id]),code('40001'));
 await assert.rejects(()=>rpc('erp_stock_reverse',{p_user_id:users.estoque,p_movement_id:posted.result.movement.id,p_command_id:randomUUID(),p_occurred_on:'2026-10-15',p_reason:'Tentativa genérica',p_versions:[{product_id:f.product,warehouse_id:f.warehouse,expected_version:2}]}),code('40001'));
 f.doc=await transition(f.doc,'in_progress');assert.equal(f.doc.status,'in_progress');
 const reversed=await undo(f,posted);assert.equal(reversed.result.posting.state,'reversed');assert.equal(await balance(f),'100.000000');
 f.doc=await transition(f.doc,'cancelled');assert.equal(f.doc.status,'cancelled');
});
test('reversal is integral, allows archived records, preserves history and old replay cannot resurrect or reverse a later posting',async()=>{
 const f=await fixture(),first=await post(f);await db.query('update erp_catalog.record set active=false where id in($1,$2)',[f.product,f.warehouse]);
 const undone=await undo(f,first);assert.equal(await balance(f),'0.000000');
 await db.query('update erp_catalog.record set active=true where id in($1,$2)',[f.product,f.warehouse]);const second=await post(f);
 assert.notEqual(first.result.posting.id,second.result.posting.id);assert.equal((await rpc('erp_document_stock_post',first.args)).replayed,true);
 assert.equal((await rpc('erp_document_stock_reverse',undone.args)).replayed,true);
 assert.equal(await scalar("select id value from erp_stock.document_posting where document_id=$1 and state='active'",[f.doc.id]),second.result.posting.id);
 assert.equal(await balance(f),'2.000001');
 await assert.rejects(()=>db.query('delete from erp_stock.document_posting where id=$1',[first.result.posting.id]),code('40001'));
 await assert.rejects(()=>db.query('update erp_stock.document_posting set state=\'active\' where id=$1',[first.result.posting.id]),code('40001'));
});
test('consumed receipt, backdated reversal, future movement and balance overflow cannot pass preview',async()=>{
 const f=await fixture(),posted=await post(f);await stock(f,'-1',1,'issue');
 await assert.rejects(()=>undo(f,posted),code('22023'));
 await assert.rejects(()=>rpc('erp_document_stock_reverse_preview',{...scope(f),p_posting_id:posted.result.posting.id,p_posting_version:1,...meta,p_occurred_on:'2026-10-14'}),code('22023'));
 const other=await fixture();await assert.rejects(()=>preview(other,{p_occurred_on:'2199-01-01'}),code('22023'));
 await stock(other,'999999999999.999999');await assert.rejects(()=>preview(other),code('22023'));
 assert.equal(await scalar('select state value from erp_stock.document_posting where id=$1',[posted.result.posting.id]),'active');
});
test('command UUID collision with unrelated manual stock movement is rejected and revoked membership cannot replay',async()=>{
 const f=await fixture(),command=randomUUID();await stock(f,'1',0,'receipt',command);
 await assert.rejects(()=>post(f,{command}),code('40001'));
 const posted=await post(f);await db.query('update erp_access.membership set active=false where user_id=$1',[users.estoque]);
 try{await assert.rejects(()=>rpc('erp_document_stock_post',posted.args),code('42501'));}finally{await db.query('update erp_access.membership set active=true where user_id=$1',[users.estoque]);}
 await db.query("update erp_access.membership set role='vendas' where user_id=$1",[users.estoque]);
 try{await assert.rejects(()=>rpc('erp_document_stock_post',posted.args),code('42501'));}finally{await db.query("update erp_access.membership set role='estoque' where user_id=$1",[users.estoque]);}
});
test('list and posting history paginate with bounded minimal projection',async()=>{
 const f=await fixture(),posted=await post(f);await undo(f,posted);await post(f);
 const result=await rpc('erp_document_stock_get',{p_user_id:users.estoque,p_kind:f.doc.kind,p_document_id:f.doc.id,p_limit:1});
 assert.equal(result.postings.length,1);assert.equal(result.has_more,true);
 const next=await rpc('erp_document_stock_get',{p_user_id:users.estoque,p_kind:f.doc.kind,p_document_id:f.doc.id,p_limit:1,p_after:result.next_cursor});assert.equal(next.has_more,false);assert.notEqual(next.postings[0].id,result.postings[0].id);
 const listed=await rpc('erp_document_stock_list',{p_user_id:users.estoque,p_kind:f.doc.kind,p_limit:1});assert.equal(listed.items.length,1);assert.equal(listed.has_more,true);
});

async function api(path,body,user=users.estoque,decorate=v=>v){
 const request=new Request(`https://api.example.test${path}`,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const route=await parseDocumentStockRoute(request);return executeDocumentStockRoute(route,{userId:user,rpc:async(name,args)=>decorate(await rpc(name,args))});
}
test('HTTP contract exercises projected OS, posting and reversal against actual SQL without amount disclosure',async()=>{
 const f=await fixture({kind:'service_orders',seed:true}),path=`/v1/documentos-estoque/${f.doc.kind}/${f.doc.id}`;
 const detail=await api(path,undefined,users.estoque,value=>({...value,raw_payload:{secret:1},document:{...value.document,total:'999',notes:'hidden'},items:value.items.map(i=>({...i,unit_price:'999',product_snapshot:{secret:1}}))}));
 assert.equal(detail.document.kind,'service_orders');assert.equal(detail.document.total,undefined);assert.equal(detail.items[0].unit_price,undefined);
 const body={expected_document_version:f.doc.version,occurred_on:'2026-10-15',reason:'Conferência HTTP sintética'};
 const checked=await api(`${path}/preview`,body,users.estoque,value=>({...value,preview:{...value.preview,contact_snapshot:{secret:1},positions:value.preview.positions.map(i=>({...i,cost:'99'}))}}));
 assert.equal(checked.preview.contact_snapshot,undefined);assert.equal(checked.preview.positions[0].cost,undefined);
 const input={...body,command_id:randomUUID(),preview_hash:checked.preview.preview_hash,ignored_item_ids:[]};
 const created=await api(`${path}/post`,input);assert.equal(created.movement.kind,'issue');assert.equal(created.posting.document_id,f.doc.id);
 assert.equal((await api(`${path}/post`,input)).replayed,true);
 const reverseInput={...body,expected_document_version:created.document_version,expected_posting_version:created.posting.version};
 const reversePath=`${path}/${created.posting.id}`,checkedReverse=await api(`${reversePath}/reverse-preview`,reverseInput);
 const reversed=await api(`${reversePath}/reverse`,{...reverseInput,command_id:randomUUID(),preview_hash:checkedReverse.preview.preview_hash});assert.equal(reversed.posting.state,'reversed');assert.equal(await balance(f),'100.000000');
 const listed=await api(`/v1/documentos-estoque?kind=${f.doc.kind}&limit=1`);assert.equal(listed.items[0].kind,f.doc.kind);
});
test('HTTP parser rejects forged actors/products/quantities, duplicate query or acknowledgments and malformed dates',async()=>{
 const id=randomUUID(),base=`https://api.example.test/v1/documentos-estoque/sales_orders/${id}`,body={expected_document_version:1,occurred_on:'2026-10-15',reason:'Conferência sintética'};
 assert.equal(await parseDocumentStockRoute(new Request('https://api.example.test/v1/estoque/saldos')),null);
 assert.deepEqual(documentStockMethods(`${base}/preview`),['POST']);
 for(const suffix of ['?limit=26','?limit=1&limit=2','?after=bad','?raw=true'])await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}${suffix}`)),e=>e.status===400);
 for(const forged of [{...body,user_id:users.admin},{...body,items:[]},{...body,quantity:'1'},{...body,occurred_on:'2026-02-30'},{...body,expected_document_version:'1'},{...body,reason:'x\nsecret'}])
  await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(forged)})),e=>e.status===400);
 const posted={...body,command_id:randomUUID(),preview_hash:'a'.repeat(64),ignored_item_ids:[id,id]};
 await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}/post`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(posted)})),e=>e.status===400);
 await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}/preview`)),e=>e.status===405);
 await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}/bad`)),e=>e.status===404);
 await assert.rejects(()=>parseDocumentStockRoute(new Request(`${base}/preview`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,reason:'x'.repeat(70000)})})),e=>e.status===400);
});
test('HTTP rejects cross-document responses, incorrect source sums and mutated output scope',async()=>{
 const f=await fixture(),path=`/v1/documentos-estoque/${f.doc.kind}/${f.doc.id}`,body={expected_document_version:f.doc.version,occurred_on:'2026-10-15',reason:'Conferência sintética'};
 await assert.rejects(()=>api(path,undefined,users.estoque,v=>({...v,document:{...v.document,id:randomUUID()}})),e=>e.status===502);
 await assert.rejects(()=>api(`${path}/preview`,body,users.estoque,v=>({...v,preview:{...v.preview,positions:v.preview.positions.map(row=>({...row,sources:row.sources.map(s=>({...s,quantity:'1'}))}))}})),e=>e.status===502);
 await assert.rejects(()=>api(`${path}/preview`,body,users.estoque,v=>({...v,preview:{...v.preview,direction:'issue'}})),e=>e.status===502);
});
test('HTTP binds mutation direction, date and reason to request and canonicalizes UUID paths',async()=>{
 const f=await fixture(),p=await preview(f),body={expected_document_version:f.doc.version,occurred_on:meta.p_occurred_on,reason:meta.p_reason,command_id:randomUUID(),preview_hash:p.preview_hash,ignored_item_ids:[]};
 const request=new Request(`https://api.example.test/v1/documentos-estoque/${f.doc.kind}/${f.doc.id.toUpperCase()}/post`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const route=await parseDocumentStockRoute(request);assert.equal(route.args.p_document_id,f.doc.id);
 const result=await rpc(route.rpc,{...route.args,p_user_id:users.estoque});
 for(const value of [
  {...result,posting:{...result.posting,direction:'issue'},movement:{...result.movement,kind:'issue'}},
  {...result,movement:{...result.movement,occurred_on:'2026-10-14'}},
  {...result,movement:{...result.movement,reason:'Outro motivo'}},
  {...result,movement:{...result.movement,reverses_id:randomUUID()}}
 ]) await assert.rejects(()=>executeDocumentStockRoute(route,{userId:users.estoque,rpc:async()=>value}),e=>e.status===502);
});
test('101 distinct positions are rejected without splitting a 101-line document or writing any effect',async()=>{
 const products=[];for(let i=0;i<101;i++)products.push((await catalog('products',{name:`Peça limite ${i}`,unit:'UN',kind:'P',format:'S'})).record.id);
 const f=await fixture({items:()=>products.map(product_id=>({product_id,description:'Peça limite',unit:'UN',quantity:'1',unit_price:'1'}))});
 const before=await scalar('select count(*)::int value from erp_stock.entry');await assert.rejects(()=>preview(f),code('22023'));
 assert.equal(await scalar('select count(*)::int value from erp_stock.entry'),before);assert.equal(await scalar('select count(*)::int value from erp_stock.document_posting where document_id=$1',[f.doc.id]),0);
});
test('018 retains ordinary stock reversal, including idempotent retry, for unlinked movements',async()=>{
 const f=await fixture(),created=await stock(f,'5'),command=randomUUID();
 const args={p_user_id:users.estoque,p_movement_id:created.movement.id,p_command_id:command,p_occurred_on:'2026-10-15',p_reason:'Estorno manual permitido',p_versions:[{product_id:f.product,warehouse_id:f.warehouse,expected_version:1}]};
 const result=await rpc('erp_stock_reverse',args);assert.equal(result.movement.kind,'reversal');assert.equal((await rpc('erp_stock_reverse',args)).replayed,true);assert.equal(await balance(f),'0.000000');
});
