import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneDFixture,migrationSql,fails} from './helpers/stock-lane-d-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 225 on PGlite (published migrations up to 190, then 222-225) with synthetic data only: Pedidos de compra > ⋮ "Estornar estoque"
// reverses every active receipt of the order in one command, with today's date and the automatic reason.
let f;
before(async()=>{f=await stockLaneDFixture({upto:4});});
after(()=>f?.close());
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
const receive=async(order,quantity)=>{const current=(await f.rpc('erp_purchase_receipts_get',{p_user_id:f.users.estoque,p_document_id:order.id,p_limit:1})).current;
 const items=current.items.filter(i=>!/^0(\.0+)?$/.test(i.remaining_quantity)).map(i=>({item_id:i.item_id,quantity:quantity??i.remaining_quantity}));const version=current.document.version,reason='Recebimento sintético';
 const preview=(await f.rpc('erp_purchase_receipts_preview',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:version,p_occurred_on:'2026-10-15',p_reason:reason,p_items:items})).preview;
 return f.rpc('erp_purchase_receipts_receive',{p_user_id:f.users.estoque,p_document_id:order.id,p_expected_version:version,p_occurred_on:'2026-10-15',p_reason:reason,p_items:items,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_confirm:true});};
const docVersion=id=>f.scalar('select version v from erp_documents.document where id=$1',[id]);
const run=async(path,body,user=f.users.estoque)=>{const url=new URL(`https://api.example.test${path}`),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),route,url.searchParams);
 const raw=await f.rpc(operation.rpc,{p_user_id:user,...operation.args});return{raw,route,operation,out:stockResponse(raw,route,operation)};};

test('225 guards: service_role only, the constraint guard refuses a second run',async()=>{
 const signature='public.erp_stock_purchase_reverse_all(uuid,uuid,uuid,integer)';
 for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true);
 assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog','TimeZone=UTC']);
 await assert.rejects(f.db.exec(await migrationSql('202610200225_stock_purchase_reverse_all.sql')),/stock_purchase_reverse_all_225_already_applied/);await f.db.exec('rollback');
});

test('225 one confirmation reverses every active receipt: all or nothing, replay, conflict and the Worker projection',async()=>{
 const depot=await f.warehouse('Estorno total'),p=await f.product('Estornado total'),q=await f.product('Estornado total B');
 const order=await f.order('purchase_orders',[f.item(p,'6','2'),f.item(q,'2','3')],depot.id);
 await receive(order,'2');await receive(order);
 assert.deepEqual([await f.balance(p.id,depot.id),await f.balance(q.id,depot.id)],['6.000000','2.000000']);
 const version=await docVersion(order.id),command=randomUUID();
 const {out,raw,route,operation}=await run(`/v1/estoque/compras/${order.id}/estorno`,{command_id:command,expected_version:version});
 assert.equal(out.reversed.length,2);assert.equal(out.reason,`Estorno do pedido de compra ${order.number}`);assert.equal(out.occurred_on,day());
 assert.equal(out.document_version,version+2);
 assert.deepEqual([await f.balance(p.id,depot.id),await f.balance(q.id,depot.id)],['0.000000','0.000000']);
 const forged=structuredClone(raw);forged.document_version=version+5;assert.throws(()=>stockResponse(forged,route,operation),error=>error.status===502);
 // Conferir resultado: the same command returns the stored result; another body is a conflict.
 const again=await run(`/v1/estoque/compras/${order.id}/estorno`,{command_id:command,expected_version:version});assert.equal(again.out.replayed,true);
 await assert.rejects(f.rpc('erp_stock_purchase_reverse_all',{p_user_id:f.users.estoque,p_command_id:command,p_document_id:order.id,p_expected_version:version+2}),fails('40001'));
 // Nothing left to reverse, stale version and profiles without stock writing.
 await assert.rejects(f.rpc('erp_stock_purchase_reverse_all',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_document_id:order.id,p_expected_version:version+2}),fails('22023'));
 const other=await f.order('purchase_orders',[f.item(p,'1','2')],depot.id);await receive(other);
 await assert.rejects(f.rpc('erp_stock_purchase_reverse_all',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_document_id:other.id,p_expected_version:other.version}),fails('40001'));
 for(const user of[f.users.vendas,f.users.consulta,f.users.fiscal])await assert.rejects(f.rpc('erp_stock_purchase_reverse_all',{p_user_id:user,p_command_id:randomUUID(),p_document_id:other.id,p_expected_version:await docVersion(other.id)}),fails('42501'));
 // All or nothing: a receipt that cannot be reversed (stock already issued, negative stock not allowed) keeps every receipt active.
 const third=await f.order('purchase_orders',[f.item(q,'3','3')],depot.id);await receive(third,'1');await receive(third);await f.launch(q.id,depot.id,'issue','3');
 await assert.rejects(f.rpc('erp_stock_purchase_reverse_all',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_document_id:third.id,p_expected_version:await docVersion(third.id)}),fails('40001'));
 assert.equal(await f.scalar('select count(*)::integer v from erp_purchase_receipts.reversal where document_id=$1',[third.id]),0);
 // Strict body before the database.
 const url=new URL(`https://api.example.test/v1/estoque/compras/${order.id}/estorno`);
 await assert.rejects(stockOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:randomUUID(),expected_version:0})}),stockRoute(url.pathname),url.searchParams),error=>error.status===400);
});
