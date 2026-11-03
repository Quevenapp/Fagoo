import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stockLaneFixture,fails} from './helpers/stock-lane-b-fixture.mjs';
import {stockRoute,stockOperation,stockResponse} from '../src/stock.mjs';

// 145 on PGlite with synthetic data only: Preferências > Suprimentos > Estoque applied to the stock RPCs.
let f;
before(async()=>{f=await stockLaneFixture({upto:1});});
beforeEach(async()=>{await f.resetPreferences();});
after(()=>f?.close());
const context=(product,user=f.users.estoque)=>f.rpc('erp_stock_launch_context',{p_user_id:user,p_product_id:product});
const costOf=async product=>(await f.scalar('select average_cost::text v from erp_stock.average_costs(array[$1::uuid])',[product]))??null;

test('145 entry points are SECURITY DEFINER for service_role only; internals stay private',async()=>{
 for(const signature of['public.erp_stock_launch_context(uuid,uuid)','public.erp_stock_balances(uuid,uuid,uuid)','public.erp_stock_totals(uuid,uuid)','public.erp_stock_product_reservations(uuid,uuid,uuid)',
  'public.erp_stock_dashboard_stock(uuid,text,text,uuid,text,integer,integer)','public.erp_stock_purchase_suggestion(uuid,date,date,integer,uuid,boolean,jsonb,jsonb,text)']){
  for(const role of['anon','authenticated','public'])assert.equal(await f.scalar(`select has_function_privilege('${role}',$1,'EXECUTE') v`,[signature]),false,signature);
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),true,signature);
  assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure',[signature]),true,signature);
  assert.deepEqual(await f.scalar('select proconfig v from pg_proc where oid=$1::regprocedure',[signature]),['search_path=pg_catalog'],signature);
 }
 for(const signature of['erp_stock.average_costs(uuid[])','erp_stock.last_purchase(uuid,boolean)','erp_stock.situation_reservations(uuid)','erp_stock.settings_dto()','erp_stock.cost_visible(uuid)'])
  assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v",[signature]),false,signature);
});

test('145 launch context: catalog defaults, last purchase with and without Balanços, reversals ignored, writers only',async()=>{
 const p=await f.product('Produto última compra'),w=await f.warehouse('Depósito última compra');
 let c=await context(p.id);
 assert.deepEqual(c.settings,{show_unit_price:false,price_type:'ultima_compra',consider_balances:false,average_cost_base:'preco_compra'});
 assert.deepEqual([c.last_purchase,c.average_cost,c.sale_price],[null,null,'10.0000000000']);
 await f.launch(p.id,w.id,'receipt','4',{price:'2.5',cost:'2.75'});
 const second=await f.launch(p.id,w.id,'receipt','1',{price:'3',cost:'3.5'});
 await f.launch(p.id,w.id,'balance','6',{price:'9',cost:'9.5'});
 c=await context(p.id);
 assert.deepEqual(c.last_purchase,{unit_price:'3.0000000000',unit_cost:'3.5000000000',occurred_on:second.occurred_on,movement_id:second.movement.id,source:'manual'},'the Balanço is not a purchase by default');
 await f.setPreferences({'estoque.considerar_balancos':true,'estoque.exibir_preco_unitario':true});
 c=await context(p.id);
 assert.equal(c.last_purchase.source,'balance');assert.equal(c.last_purchase.unit_price,'9.0000000000');assert.equal(c.settings.show_unit_price,true);
 await f.setPreferences({'estoque.considerar_balancos':false});
 // An estorno makes the reversed Entrada stop being the last purchase.
 const b=await f.scalar('select version v from erp_stock.balance where product_id=$1 and warehouse_id=$2',[p.id,w.id]);
 await f.rpc('erp_stock_reverse',{p_user_id:f.users.estoque,p_movement_id:second.movement.id,p_command_id:randomUUID(),p_occurred_on:second.occurred_on,p_reason:'Estorno sintético',p_versions:[{product_id:p.id,warehouse_id:w.id,expected_version:b}]});
 assert.equal((await context(p.id)).last_purchase.unit_price,'2.5000000000');
 // The supplier price types need the product suppliers, which Brufap does not have yet: nothing is suggested.
 await f.setPreferences({'estoque.tipo_preco_entrada':'custo_fornecedor'});
 c=await context(p.id);assert.equal(c.settings.price_type,'custo_fornecedor');assert.equal(c.last_purchase,null);
 await f.setPreferences({'estoque.tipo_preco_entrada':'ultima_compra'});
 for(const user of[f.users.consulta,f.users.vendas,f.users.fiscal,f.users.financeiro,randomUUID()])await assert.rejects(context(p.id,user),fails('42501'));
 await assert.rejects(context(randomUUID()),fails('P0002'));
});

test('145 custo médio: weighted by the balance with the chosen base; exits, transfers, unpriced entries and reversals keep it',async()=>{
 const p=await f.product('Produto custo médio'),w=await f.warehouse('Depósito custo A'),o=await f.warehouse('Depósito custo B');
 assert.equal(await costOf(p.id),null);
 await f.launch(p.id,w.id,'receipt','10',{price:'2',cost:'2.5'});
 assert.equal(await costOf(p.id),'2');
 await f.launch(p.id,w.id,'receipt','10',{price:'4',cost:'4.5'});
 assert.equal(await costOf(p.id),'3.0000000000');
 await f.setPreferences({'estoque.custo_medio_base':'custo_lancamento'});
 assert.equal(await costOf(p.id),'3.5000000000','Custo Lançamento recalculates the same ledger with the costs');
 await f.setPreferences({'estoque.custo_medio_base':'preco_compra'});
 await f.launch(p.id,w.id,'issue','5',{price:'20'});
 await f.launch(p.id,w.id,'transfer','3',{price:'7',cost:'7',destination:o.id});
 await f.launch(p.id,o.id,'receipt','5');
 assert.equal(await costOf(p.id),'3.0000000000','exit, transfer and an entry without price keep the average');
 // 20 units at 3, then a Balanço of the first warehouse from 12 to 22 at 6: (20 × 3 + 10 × 6) ÷ 30 = 4.
 await f.launch(p.id,w.id,'balance','22',{price:'6',cost:'6'});
 assert.equal(await costOf(p.id),'4.0000000000');
 // Thirds stay exact to 10 decimals: (30 × 4 + 3 × 5) ÷ 33.
 await f.launch(p.id,o.id,'receipt','3',{price:'5',cost:'5'});
 assert.equal(await costOf(p.id),'4.0909090909');
 // A document lançamento (purchase order) brings the item price.
 const today=await f.scalar("select (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text v");
 const purchase=await f.order('purchase_orders',[f.item(p,'7','1.125')],w.id);
 const preview=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_occurred_on:today,p_reason:'Compra sintética'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'purchase_orders',p_document_id:purchase.id,p_expected_version:purchase.version,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_occurred_on:today,p_reason:'Compra sintética',p_ignored_item_ids:[]});
 assert.equal(await costOf(p.id),'3.5718750000','(33 × 4.0909090909 + 7 × 1.125) ÷ 40, rounded to 10 decimals');
 assert.deepEqual([(await context(p.id)).last_purchase.source,(await context(p.id)).last_purchase.unit_price,(await context(p.id)).last_purchase.unit_cost],['purchase_order','1.1250000000',null]);
 // Restart after the stock goes to zero.
 const q=await f.product('Produto custo reinício');
 await f.launch(q.id,w.id,'receipt','2',{price:'10',cost:'10'});await f.launch(q.id,w.id,'issue','2',{price:'12'});await f.launch(q.id,w.id,'receipt','1',{price:'1',cost:'1'});
 assert.equal(await costOf(q.id),'1');
});

test('145 Valor de Custo do Estoque and the Custo column: quantity × custo médio, ignored warehouses out, hidden from vendas',async()=>{
 const w=await f.warehouse('Depósito totais'),ignored=await f.warehouse('Depósito totais ignorado',true);
 const p=await f.product('Produto totais'),u=await f.product('Produto totais sem custo',{price:'3'});
 await f.launch(p.id,w.id,'receipt','4',{price:'2.5',cost:'2.5'});await f.launch(p.id,ignored.id,'receipt','6',{price:'2.5',cost:'2.5'});await f.launch(u.id,w.id,'receipt','2');
 const totals=await f.rpc('erp_stock_totals',{p_user_id:f.users.consulta,p_warehouse_id:w.id});
 assert.deepEqual([totals.cost_visible,totals.cost_value,totals.uncosted_products,totals.cost_basis,totals.sale_value],[true,'10.00',1,'preco_compra','46.00']);
 const all=await f.rpc('erp_stock_totals',{p_user_id:f.users.estoque,p_warehouse_id:null});
 assert.equal(all.cost_visible,true);
 const seller=await f.rpc('erp_stock_totals',{p_user_id:f.users.vendas,p_warehouse_id:w.id});
 assert.deepEqual([seller.cost_visible,seller.cost_value,seller.uncosted_products,seller.sale_value],[false,null,null,'46.00'],'purchase costs stay purchase data (008)');
 const dash=await f.rpc('erp_stock_dashboard_stock',{p_user_id:f.users.fiscal,p_query:'Produto totais',p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100});
 assert.deepEqual(dash.items.map(i=>[i.name,i.quantity,i.average_cost,i.cost,i.value]),[['Produto totais','4.000000','2.5000000000','10.00','40.00'],['Produto totais sem custo','2.000000',null,null,'6.00']]);
 assert.deepEqual([dash.cost_visible,dash.totals.cost,dash.totals.uncosted],[true,'10.00',1]);
 assert.deepEqual(dash.warehouses.map(x=>[x.name,x.ignored,x.cost]),[['Depósito totais',false,'10.00'],['Depósito totais ignorado',true,'15.00']]);
 const hidden=await f.rpc('erp_stock_dashboard_stock',{p_user_id:f.users.vendas,p_query:'Produto totais',p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100});
 assert.deepEqual([hidden.cost_visible,hidden.items[0].average_cost,hidden.items[0].cost,hidden.totals.cost,hidden.warehouses[0].cost,hidden.items[0].value],[false,null,null,null,null,'40.00']);
});

test('145 reserva pelas situações de venda: by warehouse or global, no double count with 070 reservations or posted stock',async()=>{
 const w=await f.warehouse('Depósito reserva'),x=await f.warehouse('Depósito reserva sem padrão',true),p=await f.product('Produto reserva');
 await f.setDefault(w.id);
 await f.launch(p.id,w.id,'receipt','20');await f.launch(p.id,x.id,'receipt','5');
 const open=await f.order('sales_orders',[f.item(p,'3')],w.id,['open']);
 const draft=await f.order('sales_orders',[f.item(p,'2')],null,[]);
 const verified=await f.order('sales_orders',[f.item(p,'4')],x.id,['open','verified']);
 const balances=async()=>f.rpc('erp_stock_balances',{p_user_id:f.users.vendas,p_product_id:p.id});
 const reserved=async target=>(await balances()).items.find(i=>i.warehouse_id===target).reserved_quantity;
 let b=await balances();
 assert.deepEqual(b.reservation,{by_situation:false,by_warehouse:true,statuses:[],unassigned_quantity:'0.000000'});
 assert.equal(await reserved(w.id),'0.000000','the option starts off: nothing changes');
 await f.setPreferences({'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['em_aberto','em_digitacao','verificado']});
 b=await balances();
 assert.deepEqual(b.reservation,{by_situation:true,by_warehouse:true,statuses:['draft','open','verified'],unassigned_quantity:'0.000000'});
 assert.deepEqual([await reserved(w.id),await reserved(x.id)],['5.000000','4.000000'],'the draft without warehouse goes to the depósito padrão');
 assert.equal(b.items.find(i=>i.warehouse_id===w.id).situation_reserved_quantity,'5.000000');
 let list=await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.consulta,p_product_id:p.id,p_warehouse_id:null});
 assert.deepEqual(list.items.map(i=>[i.document_number,i.source,i.reservation_id,i.warehouse_id,i.quantity,i.warehouse_ignored]),
  [[String(verified.number),'situation',null,x.id,'4.000000',true],[String(draft.number),'situation',null,w.id,'2.000000',false],[String(open.number),'situation',null,w.id,'3.000000',false]]);
 assert.deepEqual([list.total,list.quantity,list.reservation.by_situation],[3,'9.000000',true]);
 // An explicit 070 reservation of the verified order replaces its situation reservation; it is never counted twice.
 const prev=(await f.rpc('erp_stock_reservation_preview',{p_user_id:f.users.estoque,p_document_id:verified.id,p_expected_version:verified.version,p_action:'reserve',p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_reservation_id:null,p_reservation_version:null})).preview;
 await f.rpc('erp_stock_reservation_apply',{p_user_id:f.users.estoque,p_document_id:verified.id,p_expected_version:verified.version,p_command_id:randomUUID(),p_action:'reserve',p_preview_hash:prev.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Reserva sintética',p_ignored_item_ids:[],p_reservation_id:null,p_reservation_version:null});
 assert.equal(await reserved(x.id),'4.000000');
 list=await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.consulta,p_product_id:p.id,p_warehouse_id:x.id});
 assert.deepEqual(list.items.map(i=>[i.source,i.quantity]),[['reservation','4.000000']]);assert.match(list.items[0].reservation_id,/^[0-9a-f-]{36}$/);
 // Posted stock leaves the reservation: the order is no longer reserved by its situation.
 const doc=await f.transition(open,'verified');assert.equal(await reserved(w.id),'5.000000');
 const preview=(await f.rpc('erp_document_stock_preview',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:open.id,p_expected_version:doc.version,p_occurred_on:'2026-10-15',p_reason:'Venda sintética'})).preview;
 await f.rpc('erp_document_stock_post',{p_user_id:f.users.estoque,p_kind:'sales_orders',p_document_id:open.id,p_expected_version:doc.version,p_command_id:randomUUID(),p_preview_hash:preview.preview_hash,p_occurred_on:'2026-10-15',p_reason:'Venda sintética',p_ignored_item_ids:[]});
 assert.equal(await reserved(w.id),'2.000000');
 // Reserva por depósito desligada: the situation reservation counts for every considered warehouse (unassigned).
 await f.setPreferences({'estoque.reserva_por_deposito':false});
 b=await balances();
 assert.deepEqual([b.reservation.by_warehouse,b.reservation.unassigned_quantity,await reserved(w.id)],[false,'2.000000','0.000000']);
 list=await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.consulta,p_product_id:p.id,p_warehouse_id:w.id});
 assert.deepEqual(list.items.map(i=>[i.source,i.warehouse_id,i.quantity]),[['situation',null,'2.000000']],'a global reservation shows under every warehouse');
 // The situation reservation is informative: a Saída is never refused for it, and the 070 reservation still protects its position.
 await f.launch(p.id,w.id,'issue','17',{price:'1'});assert.equal(await f.balance(p.id,w.id),'0.000000');
 await assert.rejects(f.launch(p.id,x.id,'issue','2',{price:'1'}),fails('40001'),'the explicit 070 reservation of 4 still protects 5 units');
 await f.setPreferences({'estoque.reserva_por_situacao':false,'estoque.reserva_por_deposito':true});
 assert.deepEqual((await balances()).reservation,{by_situation:false,by_warehouse:true,statuses:[],unassigned_quantity:'0.000000'});
});

test('145 Sugestão de Compras with Reserva = Sim takes the situation reservation off the current stock',async()=>{
 const w=await f.warehouse('Depósito sugestão B'),p=await f.product('Produto sugestão B');
 await f.launch(p.id,w.id,'receipt','10');
 await f.order('sales_orders',[f.item(p,'6')],w.id,['open','verified','in_progress','fulfilled'],{date:'2026-10-10'});
 await f.order('sales_orders',[f.item(p,'4')],w.id,['open'],{date:'2026-10-12'});
 const suggest=async reserve=>(await f.rpc('erp_stock_purchase_suggestion',{p_user_id:f.users.estoque,p_date_from:'2026-10-01',p_date_to:'2026-10-10',p_coverage:30,p_warehouse_id:w.id,
  p_reserve:reserve,p_purchase_statuses:['open'],p_sales_statuses:['fulfilled'],p_brand:null})).items.find(i=>i.product_id===p.id);
 assert.deepEqual([(await suggest(true)).reserved,(await suggest(true)).suggestion],['0.000000','8'],'off: 6 ÷ 10 × 30 − 10 = 8');
 await f.setPreferences({'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['em_aberto','atendido']});
 const row=await suggest(true);
 assert.deepEqual([row.reserved,row.suggestion],['10.000000','18'],'both unposted orders reserve: 18 − (10 − 10)');
 assert.deepEqual([(await suggest(false)).reserved,(await suggest(false)).suggestion],['0.000000','8']);
 await f.setPreferences({'estoque.reserva_por_situacao':false});
});

test('145 estorno após balanço: off keeps the current balance with compensations; on keeps the previous behavior; replay is exact',async()=>{
 const w=await f.warehouse('Depósito estorno balanço'),p=await f.product('Produto estorno balanço'),q=await f.product('Produto estorno sem balanço');
 const reverse=async(movement,item,{command=randomUUID(),user=f.users.estoque}={})=>({command,out:await f.rpc('erp_stock_reverse',{p_user_id:user,p_movement_id:movement.movement.id,p_command_id:command,
  p_occurred_on:movement.occurred_on,p_reason:'Estorno sintético',p_versions:[{product_id:item,warehouse_id:w.id,expected_version:await f.version(item,w.id)}]})});
 const entry=await f.launch(p.id,w.id,'receipt','10',{price:'1',cost:'1'});
 await f.launch(p.id,w.id,'balance','4',{price:'1',cost:'1'});
 await assert.rejects(reverse(entry,p.id),fails('22023'),'on (default): the reversal changes the balance and 4 − 10 is refused without negative stock');
 await f.setPreferences({'estoque.estorno_balanco':false});
 const first=await reverse(entry,p.id);
 assert.equal(await f.balance(p.id,w.id),'4.000000','the Balanço keeps the current balance');
 assert.equal(first.out.movement.reverses_id,entry.movement.id);
 assert.deepEqual(first.out.balance_adjustments.map(m=>[m.kind,m.reason,m.items[0].quantity,m.items[0].balance_after]),[['adjustment','Estorno anterior ao balanço: saldo atual mantido','10.000000','14.000000']]);
 assert.equal(first.out.movement.items[0].balance_after,'4.000000');
 const again=await f.rpc('erp_stock_reverse',{p_user_id:f.users.estoque,p_movement_id:entry.movement.id,p_command_id:first.command,p_occurred_on:entry.occurred_on,p_reason:'Estorno sintético',
  p_versions:[{product_id:p.id,warehouse_id:w.id,expected_version:5}]}).catch(e=>e);
 assert.equal(again.code,'40001','the same command with another body is a conflict');
 const replay=await f.rpc('erp_stock_reverse',{p_user_id:f.users.estoque,p_movement_id:entry.movement.id,p_command_id:first.command,p_occurred_on:entry.occurred_on,p_reason:'Estorno sintético',
  p_versions:[{product_id:p.id,warehouse_id:w.id,expected_version:2}]});
 assert.equal(replay.replayed,true);assert.deepEqual(replay.balance_adjustments,first.out.balance_adjustments);
 // A Saída reversed after a Balanço: the reversal raises the position and the compensation brings it back.
 const exit=await f.launch(p.id,w.id,'issue','1',{price:'2'});await f.launch(p.id,w.id,'balance','6',{price:'1',cost:'1'});
 const raised=await reverse(exit,p.id);
 assert.equal(await f.balance(p.id,w.id),'6.000000');
 assert.deepEqual(raised.out.balance_adjustments.map(m=>[m.items[0].quantity,m.items[0].balance_after]),[['-1.000000','6.000000']]);
 // Without a later Balanço the reversal changes the balance as before, even with the option off.
 const plain=await f.launch(q.id,w.id,'receipt','3',{price:'1',cost:'1'});
 const normal=await reverse(plain,q.id);
 assert.deepEqual([await f.balance(q.id,w.id),normal.out.balance_adjustments],['0.000000',[]]);
 await assert.rejects(reverse(plain,q.id),fails('40001'),'a reversed lançamento is never reversed twice');
 await assert.rejects(reverse(entry,p.id,{user:f.users.consulta}),fails('42501'));
});

test('145 SQL → HTTP → DTO: real answers pass the strict projections of the worker',async()=>{
 const project=async(path,value,method='GET',body)=>{const req=new Request(`https://api.example.test${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),url=new URL(req.url);
  const op=await stockOperation(req,stockRoute(url.pathname),url.searchParams);return stockResponse(value,stockRoute(url.pathname),op);};
 const w=await f.warehouse('Depósito DTO'),p=await f.product('Produto DTO');await f.setDefault(w.id);
 await f.launch(p.id,w.id,'receipt','3',{price:'0.3333333333',cost:'0.5'});
 await f.order('sales_orders',[f.item(p,'1')],w.id,['open']);await f.order('sales_orders',[f.item(p,'2')],null,[]);
 await f.setPreferences({'estoque.reserva_por_situacao':true,'estoque.reserva_situacoes':['em_aberto','em_digitacao']});
 const ctx=await project(`/v1/estoque/sugestao?product_id=${p.id}`,await f.rpc('erp_stock_launch_context',{p_user_id:f.users.estoque,p_product_id:p.id}));
 assert.deepEqual([ctx.last_purchase.unit_price,ctx.average_cost],['0.3333333333','0.3333333333']);
 const balances=await project(`/v1/estoque/saldos?product_id=${p.id}`,await f.rpc('erp_stock_balances',{p_user_id:f.users.vendas,p_product_id:p.id,p_warehouse_id:null}));
 assert.equal(balances.items.find(i=>i.warehouse_id===w.id).reserved_quantity,'3.000000');
 const list=await project(`/v1/estoque/reservas?product_id=${p.id}`,await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.vendas,p_product_id:p.id,p_warehouse_id:null}));
 assert.deepEqual(list.items.map(i=>i.source),['situation','situation']);
 await f.setPreferences({'estoque.reserva_por_deposito':false});
 const global=await project(`/v1/estoque/reservas?product_id=${p.id}&warehouse_id=${w.id}`,await f.rpc('erp_stock_product_reservations',{p_user_id:f.users.vendas,p_product_id:p.id,p_warehouse_id:w.id}));
 assert.deepEqual(global.items.map(i=>i.warehouse_id),[null,null]);
 assert.equal((await project(`/v1/estoque/saldos?product_id=${p.id}`,await f.rpc('erp_stock_balances',{p_user_id:f.users.vendas,p_product_id:p.id,p_warehouse_id:null}))).reservation.unassigned_quantity,'3.000000');
 for(const user of[f.users.vendas,f.users.estoque]){
  await project(`/v1/estoque/totais?warehouse_id=${w.id}`,await f.rpc('erp_stock_totals',{p_user_id:user,p_warehouse_id:w.id}));
  const dash=await project('/v1/estoque/painel/estoque?q=Produto+DTO',await f.rpc('erp_stock_dashboard_stock',{p_user_id:user,p_query:'Produto DTO',p_search_by:'description',p_warehouse_id:null,p_brand:null,p_page:1,p_size:100}));
  assert.equal(dash.items[0].cost,user===f.users.vendas?null:'1.00');
 }
 await f.setPreferences({'estoque.estorno_balanco':false});
 const entry=await f.launch(p.id,w.id,'receipt','5',{price:'1',cost:'1'});await f.launch(p.id,w.id,'balance','6',{price:'1',cost:'1'});
 const body={command_id:randomUUID(),occurred_on:entry.occurred_on,reason:'Estorno sintético',versions:[{product_id:p.id,warehouse_id:w.id,expected_version:await f.version(p.id,w.id)}]};
 const raw=await f.rpc('erp_stock_reverse',{p_user_id:f.users.estoque,p_movement_id:entry.movement.id,p_command_id:body.command_id,p_occurred_on:body.occurred_on,p_reason:body.reason,p_versions:body.versions});
 const reversed=await project(`/v1/estoque/movimentos/${entry.movement.id}/estorno`,raw,'POST',body);
 assert.deepEqual([reversed.balance_adjustments.length,await f.balance(p.id,w.id)],[1,'6.000000']);
});
