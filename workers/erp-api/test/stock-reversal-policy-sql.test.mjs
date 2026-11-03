import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneCFixture,migrationSql,fails} from './helpers/stock-lane-c-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 182 on PGlite (every published migration up to 152, then 181-182) with synthetic data only: the estorno after a Balanço with
// "Considerar estorno ... se houver balanço" off, and "Permite venda de produtos com estoque negativo" on sales order postings.
let f;
before(async()=>{f=await stockLaneCFixture({upto:2});});
beforeEach(async()=>{await f.setPreferences('suprimentos-estoque',{'estoque.estorno_balanco':false});});
after(()=>f?.close());
const COMPENSATION='Estorno anterior ao balanço: saldo atual mantido';
const reverseHttp=async(movement,command,sent=null)=>{
 const lines=await f.rows('select product_id,warehouse_id from erp_stock.entry where movement_id=$1 order by ordinal',[movement]);
 const body=sent??{command_id:command,occurred_on:await f.scalar('select occurred_on::text v from erp_stock.movement where id=$1',[movement]),reason:'Estorno sintético',
  versions:await Promise.all(lines.map(async l=>({product_id:l.product_id,warehouse_id:l.warehouse_id,expected_version:await f.version(l.product_id,l.warehouse_id)})))};
 reverseHttp.last=body;
 const url=new URL(`https://api.example.test/v1/estoque/movimentos/${movement}/estorno`),route=stockRoute(url.pathname);
 const operation=await stockOperation(new Request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),route,url.searchParams);
 return stockResponse(await f.rpc(operation.rpc,{p_user_id:f.users.estoque,...operation.args}),route,operation);};

test('182 redefinitions keep the published grants; the guard refuses a second run',async()=>{
 const signature='public.erp_stock_reverse(uuid,uuid,uuid,date,text,jsonb)';
 for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false);
 assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true);
 for(const internal of['erp_stock.post_physical_025(uuid,uuid,text,date,text,text,jsonb,uuid)','erp_stock.document_preview_data(erp_documents.document,date,text)','erp_stock.sales_negative_allowed()'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[internal]),false,internal);
 await assert.rejects(f.db.exec(await migrationSql('202610200182_stock_reversal_policy.sql')),/stock_reversal_182_previous_definition_changed/);await f.db.exec('rollback');
});

test('182 a reversed Balanço is no longer a later balanço: the estorno changes the balance as usual',async()=>{
 const p=await f.product('Estorno balanço estornado'),w=await f.warehouse('Depósito 182 A');
 const first=await f.launch(p.id,w.id,'receipt','10'),count=await f.launch(p.id,w.id,'balance','4');
 await f.reverse(count.movement.id);assert.equal(await f.balance(p.id,w.id),'10.000000');
 const result=await f.reverse(first.movement.id);
 assert.deepEqual([result.balance_adjustments,await f.balance(p.id,w.id)],[[],'0.000000']);
});

test('182 inactive product, inactive warehouse or a composition after the Balanço do not block a valid estorno; the balance is kept',async()=>{
 // Inactive product.
 const p=await f.product('Estorno produto inativo'),w=await f.warehouse('Depósito 182 B');
 const first=await f.launch(p.id,w.id,'receipt','10');await f.launch(p.id,w.id,'balance','7');
 await f.setActive(p.id,false);
 const command=randomUUID(),result=await reverseHttp(first.movement.id,command);
 assert.deepEqual([result.movement.kind,result.balance_adjustments.length,result.balance_adjustments[0].reason,await f.balance(p.id,w.id)],['reversal',1,COMPENSATION,'7.000000']);
 const again=await reverseHttp(first.movement.id,command,reverseHttp.last);
 assert.deepEqual([again.replayed,again.movement.id,again.balance_adjustments[0].id],[true,result.movement.id,result.balance_adjustments[0].id],'the same command returns the same movements');
 // Inactive warehouse (not the default one); the estorno raises the balance, so the compensation comes after it.
 const q=await f.product('Estorno depósito inativo'),standard=await f.warehouse('Depósito 182 padrão'),closed=await f.warehouse('Depósito 182 C');await f.setDefault(standard.id);
 await f.launch(q.id,closed.id,'receipt','10');const out=await f.launch(q.id,closed.id,'issue','3');await f.launch(q.id,closed.id,'balance','5');
 await f.setActive(closed.id,false);
 const raised=await f.reverse(out.movement.id);
 assert.deepEqual([raised.balance_adjustments.length,raised.balance_adjustments[0].items[0].quantity,await f.balance(q.id,closed.id)],[1,'-3.000000','5.000000']);
 // A product that became a composition after the Balanço.
 const k=await f.product('Estorno composição'),first2=await f.launch(k.id,w.id,'receipt','6');await f.launch(k.id,w.id,'balance','2');
 await f.rpc('erp_catalog_save',{p_user_id:f.users.admin,p_entity:'products',p_id:k.id,p_expected_version:await f.scalar('select version v from erp_catalog.record where id=$1',[k.id]),p_command_id:randomUUID(),p_data:{format:'E'}});
 const kit=await f.reverse(first2.movement.id);assert.deepEqual([kit.balance_adjustments.length,await f.balance(k.id,w.id)],[1,'2.000000']);
 // The exemption is only for the compensation marked by the estorno itself: the same reason posted directly is refused.
 await assert.rejects(f.rpc('erp_stock_post',{p_user_id:f.users.estoque,p_command_id:randomUUID(),p_kind:'adjustment',p_occurred_on:'2026-10-15',p_reason:COMPENSATION,p_reference:null,
  p_items:[{product_id:p.id,warehouse_id:w.id,quantity:'1',expected_version:await f.version(p.id,w.id)}]}),fails('22023'));
 assert.equal(await f.scalar("select coalesce(current_setting('erp_stock.reversal_compensation',true),'') v"),'','no mark is left after the transaction');
});

test('182 with the option on (Origin default) the estorno changes the balance and is not compensated',async()=>{
 await f.setPreferences('suprimentos-estoque',{'estoque.estorno_balanco':true});
 const p=await f.product('Estorno opção ligada'),w=await f.warehouse('Depósito 182 D');
 const first=await f.launch(p.id,w.id,'receipt','10');await f.launch(p.id,w.id,'balance','12');await f.setActive(p.id,false);
 const result=await f.reverse(first.movement.id);assert.deepEqual([result.balance_adjustments,await f.balance(p.id,w.id)],[[],'2.000000']);
});

test('182 "Permite venda de produtos com estoque negativo": a sales order goes negative only with the company policy and this option',async()=>{
 const p=await f.product('Venda negativa'),w=await f.warehouse('Depósito 182 vendas');await f.launch(p.id,w.id,'receipt','1');
 const sale=await f.transition(await f.order('sales_orders',[f.item(p,'3','9')],w.id),'verified');
 const preview=()=>f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética'});
 await assert.rejects(preview(),fails('22023'),'policy off');
 await f.setPolicy(true);
 await assert.rejects(preview(),fails('22023'),'policy on, sales option off');
 await f.setPreferences('vendas-vendas',{'vendas.estoque_negativo':true});
 const ok=(await preview()).preview;assert.equal(ok.positions[0].balance_after,'-2.000000');
 const posted=await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:sale.id,p_expected_version:sale.version,p_command_id:randomUUID(),
  p_preview_hash:ok.preview_hash,p_occurred_on:'2026-10-20',p_reason:'Baixa sintética',p_ignored_item_ids:[]});
 assert.equal(posted.movement.items[0].balance_after,'-2.000000');
 // A purchase order reversal or a manual issue follows the company policy only.
 await f.setPreferences('vendas-vendas',{'vendas.estoque_negativo':false});
 await f.launch(p.id,w.id,'issue','1');assert.equal(await f.balance(p.id,w.id),'-3.000000');
 await f.setPolicy(false);
});
