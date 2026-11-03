import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {purchaseReceiptsFixture} from '../../../tools/migration/helpers/purchase-receipts-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// Migration 098 on top of 009/018/070/090 (PGlite, migration files executed in order by the shared fixture).
const MIGRATION=new URL('../../../supabase/migrations/202610190098_stock_ledger_parity.sql',import.meta.url);
let f,s;const fails=code=>error=>error.code===code;
const ledger=(args={})=>f.rpc('erp_stock_ledger',{p_user_id:f.users.consulta,p_product_id:s.product.id,...args});
const version=(product,warehouse)=>f.scalar('select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0)value',[product,warehouse]);
const post=async(kind,lines,{date='2026-10-10',reason='Lançamento sintético098',reference=null,command=randomUUID()}={})=>(await f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:command,p_kind:kind,p_occurred_on:date,p_reason:reason,p_reference:reference,
 p_items:await Promise.all(lines.map(async([product,warehouse,quantity])=>({product_id:product,warehouse_id:warehouse,quantity,expected_version:await version(product,warehouse)})))})).movement;
const reverse=async(movement,date='2026-10-12')=>(await f.rpc('erp_stock_reverse',{p_user_id:f.users.estoque,p_movement_id:movement.id,p_command_id:randomUUID(),p_occurred_on:date,p_reason:'Estorno sintético098',
 p_versions:await Promise.all(movement.items.map(async item=>({product_id:item.product_id,warehouse_id:item.warehouse_id,expected_version:await version(item.product_id,item.warehouse_id)})))})).movement;
async function documentPost(document,date='2026-10-11'){
 const preview=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:document.kind,p_document_id:document.id,p_expected_version:document.version,p_occurred_on:date,p_reason:'Documento sintético098'})).preview;
 const out=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:document.kind,p_document_id:document.id,p_expected_version:document.version,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_occurred_on:date,p_reason:'Documento sintético098',p_ignored_item_ids:preview.ignored.map(item=>item.id)});
 document.version=out.document_version;return out;
}
async function documentReverse(document,posting,date='2026-10-12'){
 const preview=(await f.rpc('erp_document_stock_reverse_preview',{p_user_id:f.users.estoque,p_kind:document.kind,p_document_id:document.id,p_expected_version:document.version,p_posting_id:posting.id,p_posting_version:posting.version,p_occurred_on:date,p_reason:'Estorno documento sintético098'})).preview;
 const out=await f.rpc('erp_document_stock_reverse',{p_user_id:f.users.estoque,p_kind:document.kind,p_document_id:document.id,p_expected_version:document.version,p_posting_id:posting.id,p_posting_version:posting.version,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_occurred_on:date,p_reason:'Estorno documento sintético098'});
 document.version=out.document_version;return out;
}
const save=async(kind,items,body={})=>(await f.rpc('erp_document_save',{p_user_id:f.users.admin,p_kind:kind,p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-10',contact_id:f.contact.id,warehouse_id:s.a,items,...body}})).document;
const line=(product,quantity)=>({product_id:product,description:'Linha sintética098',unit:'UN',quantity,unit_price:'1'});
const fingerprint=()=>f.scalar("select jsonb_build_array((select count(*)from erp_stock.movement),(select count(*)from erp_stock.entry),(select count(*)from erp_stock.command),(select jsonb_agg(to_jsonb(b) order by product_id,warehouse_id)from erp_stock.balance b),(select count(*)from erp_stock.document_posting),(select count(*)from erp_purchase_receipts.receipt))value");

test.before(async()=>{
 f=await purchaseReceiptsFixture();await f.db.exec(await readFile(MIGRATION,'utf8'));
 const product=await f.catalog('products',{name:'Produto extrato098',unit:'UN',kind:'P',format:'S',price:'1'}),other=await f.catalog('products',{name:'Outro produto098',unit:'UN',kind:'P',format:'S',price:'1'});
 const a=(await f.catalog('warehouses',{name:'Depósito A098'})).id,b=(await f.catalog('warehouses',{name:'Depósito B098'})).id;
 s={product,other,a,b,movements:{}};const m=s.movements;
 m.opening=await post('receipt',[[product.id,a,'10.000001'],[other.id,a,'5']],{date:'2026-10-01',reference:'Conferência inicial'});
 m.issue=await post('issue',[[product.id,a,'-0.000001']],{date:'2026-10-02'});
 m.adjust=await post('adjustment',[[product.id,b,'2.5']],{date:'2026-10-03'});
 m.transfer=await post('transfer',[[product.id,a,'-3'],[product.id,b,'3']],{date:'2026-10-04'});
 m.transferBack=await reverse(m.transfer,'2026-10-05');
 m.manual=await post('receipt',[[product.id,b,'1']],{date:'2026-10-05'});
 m.manualReversal=await reverse(m.manual,'2026-10-06');
 s.sale=await f.transition(await f.transition(await save('sales_orders',[line(product.id,'2'),line(other.id,'1')]),'open'),'verified');
 m.sale=(await documentPost(s.sale,'2026-10-07')).movement;
 s.salePosting=(await f.scalar('select jsonb_build_object(\'id\',id,\'version\',version)value from erp_stock.document_posting where movement_id=$1',[m.sale.id]));
 m.saleReversal=(await documentReverse(s.sale,s.salePosting,'2026-10-08')).movement;
 s.service=await f.transition(await f.transition(await save('service_orders',[line(product.id,'1')]),'quoted'),'approved');
 m.service=(await documentPost(s.service,'2026-10-09')).movement;
 s.purchase=await f.transition(await save('purchase_orders',[line(product.id,'4')]),'in_progress');
 const received=await f.receive(s.purchase,await f.selection(s.purchase,'4'));m.receipt=received.receipt.receipt;
 s.receiptMovement=await f.scalar('select movement_id::text value from erp_purchase_receipts.receipt where id=$1',[received.receipt.receipt.id]);
 await f.reverse(s.purchase,received.receipt.receipt);
 s.receiptReversalMovement=await f.scalar('select movement_id::text value from erp_purchase_receipts.reversal where receipt_id=$1',[received.receipt.receipt.id]);
 // Back-dated: registered last, dated before every other lançamento.
 m.backdated=await post('receipt',[[product.id,a,'0.5']],{date:'2026-09-30'});
});
test.after(async()=>f?.close());

test('098 grants: only service_role executes the public RPC; private helpers stay closed; definer and search_path are fixed',async()=>{
 for(const role of['anon','authenticated','service_role']){
  assert.equal(await f.scalar("select has_function_privilege($1,'public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer)','execute')value",[role]),role==='service_role');
  for(const fn of['erp_stock.ledger_origin(uuid)','erp_stock.ledger_row(uuid,uuid)'])assert.equal(await f.scalar('select has_function_privilege($1,$2,\'execute\')value',[role,fn]),false);
 }
 assert.deepEqual(await f.scalar("select jsonb_build_object('definer',prosecdef,'volatility',provolatile,'config',proconfig)value from pg_proc where oid='public.erp_stock_ledger(uuid,uuid,uuid,text,text,date,date,integer,integer)'::regprocedure"),{definer:true,volatility:'s',config:['search_path=pg_catalog']});
 assert.equal(await f.scalar("select count(*)::int value from pg_indexes where schemaname='erp_stock' and indexname='erp_stock_movement_ledger_order'"),1);
 await f.db.exec('set role authenticated');try{await assert.rejects(()=>f.db.query('select public.erp_stock_ledger($1::uuid,$2::uuid)',[f.users.admin,s.product.id]),fails('42501'));}finally{await f.db.exec('reset role');}
});

test('098 read roles match the 009 stock reader; financeiro and revoked members are refused at the database',async()=>{
 for(const role of['admin','consulta','estoque','vendas','fiscal'])assert.equal((await ledger({p_user_id:f.users[role],p_limit:1})).product_id,s.product.id);
 await assert.rejects(()=>ledger({p_user_id:f.users.financeiro}),fails('42501'));
 await f.db.query('update erp_access.membership set active=false where user_id=$1',[f.users.consulta]);
 try{await assert.rejects(()=>ledger(),fails('42501'));}finally{await f.db.query('update erp_access.membership set active=true where user_id=$1',[f.users.consulta]);}
});

test('098 orders newest first by date, then registration time, then UUID; back-dated rows keep their informed date',async()=>{
 const page=await ledger();const m=s.movements;
 assert.equal(page.total,13);assert.equal(page.items.length,13);assert.equal(page.has_more,false);assert.equal(page.next_offset,null);
 assert.deepEqual(page.items.map(item=>item.id),[s.receiptReversalMovement,s.receiptMovement,m.service.id,m.saleReversal.id,m.sale.id,m.manualReversal.id,m.manual.id,m.transferBack.id,m.transfer.id,m.adjust.id,m.issue.id,m.opening.id,m.backdated.id]);
 const last=page.items.at(-1);assert.equal(last.occurred_on,'2026-09-30');
 assert.equal(last.recorded_at_local,await f.scalar("select to_char(created_at at time zone 'America/Sao_Paulo','YYYY-MM-DD\"T\"HH24:MI:SS')value from erp_stock.movement where id=$1",[last.id]));
 assert.equal(last.items[0].balance_after,'9.500000','the saldo of a back-dated row follows the registration order');
 // UUID tiebreaker: same date and same registration instant (direct inserts; the ledger tables are append-only).
 const [low,high]=['00000000-0000-4000-8000-0000000000a1','ffffffff-0000-4000-8000-0000000000a1'];
 const product=(await f.catalog('products',{name:'Produto empate098',unit:'UN',kind:'P',format:'S',price:'1'})).id;
 for(const [id,ordinal] of [[low,1],[high,2]]){
  await f.db.query("insert into erp_stock.movement(id,kind,occurred_on,reason,actor,command_id,created_at)values($1,'receipt','2026-10-01','Empate sintético',$2,$3,'2026-10-01 12:00:00+00')",[id,f.users.estoque,randomUUID()]);
  await f.db.query('insert into erp_stock.entry(movement_id,ordinal,product_id,warehouse_id,quantity,unit,balance_after,balance_version)values($1,1,$2,$3,1,\'UN\',$4,$5)',[id,product,s.a,ordinal,ordinal]);
 }
 const tie=await ledger({p_product_id:product});assert.deepEqual(tie.items.map(item=>item.id),[high,low]);assert.equal(tie.items[0].recorded_at_local,'2026-10-01T09:00:00');
 const first=await ledger({p_product_id:product,p_limit:1}),second=await ledger({p_product_id:product,p_limit:1,p_offset:1});
 assert.deepEqual([first.items[0].id,second.items[0].id,first.next_offset,second.has_more],[high,low,1,false]);
});

test('098 origin comes from the real 018/090 links, never from the free reference text',async()=>{
 const byId=Object.fromEntries((await ledger()).items.map(item=>[item.id,item]));const m=s.movements;
 const doc=(document,via='document_stock')=>({type:{sales_orders:'sales',purchase_orders:'purchases',service_orders:'services'}[document.kind],document_id:document.id,document_kind:document.kind,document_number:String(document.number),via});
 const none={type:'none',document_id:null,document_kind:null,document_number:null,via:null};
 assert.deepEqual(byId[m.sale.id].origin,doc(s.sale));assert.deepEqual(byId[m.saleReversal.id].origin,doc(s.sale));
 assert.deepEqual(byId[m.service.id].origin,doc(s.service));
 assert.deepEqual(byId[s.receiptMovement].origin,doc(s.purchase,'purchase_receipt'));assert.deepEqual(byId[s.receiptReversalMovement].origin,doc(s.purchase,'purchase_receipt'));
 for(const id of[m.transfer.id,m.transferBack.id])assert.deepEqual(byId[id].origin,{...none,type:'transfers'});
 for(const id of[m.opening.id,m.issue.id,m.adjust.id,m.manual.id,m.manualReversal.id,m.backdated.id])assert.deepEqual(byId[id].origin,none);
 assert.equal(byId[m.sale.id].reference,`Documento sales_orders ${s.sale.number}`,'the legacy reference text is preserved as stored');
 // Rows carry only this product's lines; other products are counted, never projected.
 assert.deepEqual([byId[m.sale.id].items.length,byId[m.sale.id].other_items,byId[m.opening.id].other_items,byId[m.transfer.id].items.length],[1,1,1,2]);
 assert.ok(Object.values(byId).every(item=>item.items.every(entry=>entry.product_id===s.product.id)));
 assert.equal(byId[m.manual.id].reversed_by,m.manualReversal.id);assert.equal(byId[m.manualReversal.id].reverses_id,m.manual.id);
});

test('098 filters by Tipo, Tipo de Origem, depósito and período combine with AND over the whole set',async()=>{
 const ids=async args=>(await ledger(args)).items.map(item=>item.id);const m=s.movements;
 assert.deepEqual(await ids({p_kind:'reversal'}),[s.receiptReversalMovement,m.saleReversal.id,m.manualReversal.id,m.transferBack.id]);
 assert.deepEqual(await ids({p_origin:'sales'}),[m.saleReversal.id,m.sale.id]);
 assert.deepEqual(await ids({p_origin:'purchases'}),[s.receiptReversalMovement,s.receiptMovement]);
 assert.deepEqual(await ids({p_origin:'services'}),[m.service.id]);
 assert.deepEqual(await ids({p_origin:'transfers'}),[m.transferBack.id,m.transfer.id]);
 assert.deepEqual(await ids({p_origin:'none',p_kind:'receipt'}),[m.manual.id,m.opening.id,m.backdated.id]);
 assert.deepEqual(await ids({p_warehouse_id:s.b}),[m.manualReversal.id,m.manual.id,m.transferBack.id,m.transfer.id,m.adjust.id]);
 assert.deepEqual(await ids({p_date_from:'2026-10-04',p_date_to:'2026-10-05'}),[m.manual.id,m.transferBack.id,m.transfer.id]);
 assert.deepEqual(await ids({p_date_to:'2026-09-30'}),[m.backdated.id]);
 const filtered=await ledger({p_warehouse_id:s.b,p_origin:'transfers',p_date_from:'2026-10-04'});
 assert.deepEqual(filtered.filters,{warehouse_id:s.b,kind:null,origin:'transfers',date_from:'2026-10-04',date_to:null});
 assert.deepEqual((await ledger({p_kind:'issue',p_origin:'purchases'})).items,[]);
});

test('098 totalizer: exact Entradas/Saídas over the filtered set (all pages) and the current registered saldo',async()=>{
 // A 10.000001, -0.000001, B +2.5, transfer -3/+3 and back, B +1/-1, sale -2/+2, OS -1, receipt +4/-4, back-dated +0.5.
 let page=await ledger({p_limit:1});
 assert.deepEqual(page.totals,{entries:'26.000001',exits:'14.000001',current_balance:'12.000000',unit:'UN'});
 assert.deepEqual([page.items.length,page.total,page.has_more,page.next_offset],[1,13,true,1]);
 page=await ledger({p_warehouse_id:s.b,p_limit:2,p_offset:2});
 assert.deepEqual(page.totals,{entries:'6.500000',exits:'4.000000',current_balance:'2.500000',unit:'UN'});
 assert.deepEqual([page.items.length,page.total,page.offset,page.next_offset],[2,5,2,4]);
 page=await ledger({p_kind:'issue',p_warehouse_id:s.a});
 assert.deepEqual(page.totals,{entries:'0.000000',exits:'3.000001',current_balance:'9.500000',unit:'UN'},'Saldo atual ignores tipo/origem/período');
 page=await ledger({p_offset:100});assert.deepEqual([page.items,page.total,page.has_more,page.next_offset],[[],13,false,null]);
 const empty=await f.catalog('products',{name:'Sem lançamentos098',unit:'KG',kind:'P',format:'S',price:'1'});
 assert.deepEqual(await ledger({p_product_id:empty.id}),{product_id:empty.id,items:[],limit:100,offset:0,total:0,has_more:false,next_offset:null,
  filters:{warehouse_id:null,kind:null,origin:null,date_from:null,date_to:null},totals:{entries:'0.000000',exits:'0.000000',current_balance:'0.000000',unit:'KG'},data_mode:'erp_native'});
});

test('098 rejects invalid pages and filters, unknown product or depósito, and never writes',async()=>{
 const before=await fingerprint();
 for(const args of[{p_limit:0},{p_limit:101},{p_limit:null},{p_offset:-1},{p_offset:100001},{p_kind:'balance'},{p_origin:'fiscal'},{p_origin:''},{p_date_from:'2026-10-05',p_date_to:'2026-10-04'},{p_date_from:'1899-12-31'},{p_date_to:'2101-01-01'},{p_product_id:null}])
  await assert.rejects(()=>ledger(args),fails('22023'));
 await assert.rejects(()=>ledger({p_product_id:randomUUID()}),fails('P0002'));
 await assert.rejects(()=>ledger({p_warehouse_id:randomUUID()}),fails('P0002'));
 await f.db.exec('begin read only');try{assert.equal((await ledger({p_origin:'sales'})).total,2);}finally{await f.db.exec('rollback');}
 assert.deepEqual(await fingerprint(),before);
});

test('098 SQL → HTTP → DTO: the 105 worker binds the query strictly and refuses a projection without the 105 fields',async()=>{
 // The API speaks the 105 contract (prices, observação revision, Balanço); deploy order is DB → API, so a 098-only
 // projection never reaches it in production. The real 105 projection is checked in stock-ledger-origin-sql.test.mjs.
 const url=new URL(`https://api.example.test/v1/estoque/movimentos?product_id=${s.product.id}&limit=2&offset=2&warehouse_id=${s.b.toUpperCase()}&origin=transfers&date_from=2026-10-01&date_to=2026-10-31`),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url),route,url.searchParams);assert.equal(operation.rpc,'erp_stock_ledger');
 assert.deepEqual(operation.args,{p_product_id:s.product.id,p_warehouse_id:s.b,p_kind:null,p_origin:'transfers',p_date_from:'2026-10-01',p_date_to:'2026-10-31',p_limit:2,p_offset:2,p_direction:null});
 const {p_direction,...legacyArgs}=operation.args;assert.equal(p_direction,null);
 const full=new URL(`https://api.example.test/v1/estoque/movimentos?product_id=${s.product.id}&offset=0`),fullOperation=await stockOperation(new Request(full),route,full.searchParams);
 const {p_direction:unused,...fullArgs}=fullOperation.args;assert.equal(unused,null);
 const legacyPage=await f.rpc('erp_stock_ledger',{...fullArgs,p_user_id:f.users.vendas});assert.equal(legacyPage.items.length,13);
 assert.throws(()=>stockResponse(legacyPage,route,fullOperation),error=>error.status===502);
 assert.equal((await f.rpc('erp_stock_ledger',{...legacyArgs,p_user_id:f.users.vendas})).total,2);
 const legacy=new URL(`https://api.example.test/v1/estoque/movimentos?product_id=${s.product.id}&limit=1`);
 assert.equal((await stockOperation(new Request(legacy),stockRoute(legacy.pathname),legacy.searchParams)).rpc,'erp_stock_movements','the 009 cursor mode is unchanged');
});
