import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../packages/database/migrate.mjs';
import { createBusinessService } from '../src/business/service.mjs';
import { handleBusinessRequest } from '../src/business/router.mjs';
import { lineTotal, baseQuantity } from '../../../packages/domain/decimal.mjs';
import { assertCommittedEventOrdering } from './support/event-ordering.mjs';

let db, pool, service, actor, warehouse, supplier, customer;
const command = () => randomUUID();
before(async () => {
  if(process.env.BUSINESS_TEST_DATABASE_URL){
    const url=new URL(process.env.BUSINESS_TEST_DATABASE_URL);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.endsWith('_test'),'Only a local explicitly named test database may be reset');
    const {Pool}=await import('pg');pool=new Pool({connectionString:url.href});await migrate(pool);await migrate(pool);service=createBusinessService(pool);return;
  }
  db = new PGlite(); let pending = Promise.resolve();
  pool = { query: (...args) => db.query(...args), async connect() {
    const previous = pending; let unlock; pending = new Promise(resolve => { unlock = resolve; }); await previous;
    return { query: (...args) => db.query(...args), exec: (...args) => db.exec(...args), release: unlock };
  } };
  await migrate(pool); await migrate(pool); service = createBusinessService(pool);
});
after(async () => { await db?.close(); await pool?.end?.(); });
beforeEach(async () => {
  await pool.query('TRUNCATE TABLE fagoo.company CASCADE');
  actor = { id: 'test-admin', companyId: randomUUID(), scopes: ['*'] };
  await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)', [actor.companyId, 'Empresa de teste']);
  warehouse = (await service.createWarehouse(actor, { command_id: command(), name: 'Principal' })).warehouse;
  supplier = (await service.saveContact(actor, { command_id: command(), name: 'Fornecedor de teste', kind: 'supplier' })).contact;
  customer = (await service.saveContact(actor, { command_id: command(), name: 'Cliente de teste', kind: 'customer', payment_terms: '30 dias' })).contact;
});
const product = async (overrides = {}) => (await service.saveProduct(actor, { command_id: command(), code: randomUUID().slice(0,8), name: 'Produto de teste', sale_price: '12.50', cost_price: '8.00', stock_min: '2', stock_max: '20', ...overrides })).product;
async function purchase(p, q = '2', factor = '1', unitPrice = '8') {
  const result = await service.createOrder(actor, { command_id: command(), kind: 'purchase', contact_id: supplier.id, warehouse_id: warehouse.id, items: [{ product_id: p.id, quantity: q, unit_factor: factor, unit_price: unitPrice }] });
  const confirmed = await service.confirmOrder(actor, result.order.id, { command_id: command(), expected_version: 1 }); return { order: confirmed.order, items: result.items };
}
async function opening(p, q) { return service.adjustStock(actor, { command_id: command(), product_id: p.id, warehouse_id: warehouse.id, quantity: q, reason: 'Contagem inicial conferida', expected_version: 0 }); }

test('exact unit price rounding and unit conversions preserve decimal quantities', () => {
  assert.equal(lineTotal('3','0.1000000000'),'0.30');
  assert.equal(lineTotal('0.333333','0.0450000000'),'0.01');
  assert.equal(baseQuantity('2','12'),'24.000000');
  assert.throws(() => baseQuantity('0.000001','0.000001'), /UNIT_CONVERSION_PRECISION/);
});

test('commands are replayed once and cannot be changed or reused by another actor', async () => {
  const input = { command_id: command(), code:'P-001',name:'Produto único' };
  const results = await Promise.all([service.saveProduct(actor,input),service.saveProduct(actor,input)]);
  assert.equal(results[0].product.id,results[1].product.id);assert.equal(results[1].replayed,true);
  assert.equal((await service.products(actor)).total,1);
  await assert.rejects(service.saveProduct(actor,{...input,name:'Outra descrição'}), /COMMAND_REUSED/);
  await assert.rejects(service.saveProduct({...actor,id:'other-admin'},input), /COMMAND_REUSED/);
});

test('optimistic product edits reject a stale version', async () => {
  const p = await product();
  const results = await Promise.allSettled([
    service.saveProduct(actor,{command_id:command(),expected_version:p.version,stock_min:'3'},p.id),
    service.saveProduct(actor,{command_id:command(),expected_version:p.version,stock_min:'4'},p.id)
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'VERSION_CONFLICT');
});

test('company isolation and scopes are enforced independently of HTTP authentication', async () => {
  const p = await product(); const other={...actor,companyId:randomUUID()};
  await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[other.companyId,'Segunda empresa']);
  assert.equal((await service.products(other)).items.length,0);
  await assert.rejects(service.product(other,p.id),/NOT_FOUND/);
  await assert.rejects(service.saveProduct({...actor,scopes:['catalog:read']},{command_id:command(),code:'NO',name:'Negado'}),/FORBIDDEN/);
  await assert.rejects(service.createOrder(other,{command_id:command(),kind:'purchase',contact_id:supplier.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1'}]}),/NOT_FOUND/);
});

test('partial purchase receipts convert packages, replay safely and finance only once', async () => {
  const p=await product();const order=await purchase(p,'2','12','120');
  const input={command_id:command(),expected_version:2,confirmed:true,items:[{item_id:order.items[0].id,quantity:'1'}]};
  const first=await service.receiveOrder(actor,order.order.id,input);assert.equal(first.order.status,'partial');
  assert.equal((await service.receiveOrder(actor,order.order.id,input)).replayed,true);
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'12.000000');
  const finance=await service.postFinance(actor,order.order.id,{command_id:command(),expected_version:3,installments:[{due_on:'2026-12-01',amount:'120'},{due_on:'2027-01-01',amount:'120'}]});
  assert.equal(finance.cash_movement_performed,false);assert.equal(finance.posting.total,'240.00');
  await assert.rejects(service.postFinance(actor,order.order.id,{command_id:command(),expected_version:4,installments:[{due_on:'2026-12-01',amount:'240'}]}),/FINANCE_ALREADY_POSTED/);
  const complete=await service.receiveOrder(actor,order.order.id,{command_id:command(),expected_version:4,confirmed:true,items:[{item_id:order.items[0].id,quantity:'1'}]});
  assert.equal(complete.order.status,'completed');assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'24.000000');
  assert.equal((await service.finance(actor)).items.length,2);
  const movements=await service.stockMovements(actor,{product_id:p.id});assert.equal(movements.items.length,2);assert.equal(movements.items[0].purchase_unit_price,'120.0000000000');assert.equal(movements.items[0].purchase_unit_factor,'12.000000');
  const eventRows=await service.events(actor);assert.equal(eventRows.items.filter(x=>x.type==='purchase.received').length,2);
});

test('purchase packaging requires its explicit price and never reuses the base-unit cost',async()=>{
  const p=await product({cost_price:'8'}),input={command_id:command(),kind:'purchase',contact_id:supplier.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1',unit_factor:'12'}]};
  await assert.rejects(service.createOrder(actor,input),/PURCHASE_PACKAGE_PRICE_REQUIRED/);
  assert.equal((await service.orders(actor)).total,0);
  const boxed=await service.createOrder(actor,{...input,items:[{...input.items[0],unit_price:'96'}]});assert.equal(boxed.order.total,'96.00');assert.equal(boxed.items[0].unit_factor,'12.000000');
  const base=await service.createOrder(actor,{...input,command_id:command(),items:[{product_id:p.id,quantity:'1',unit_factor:'1.000000'}]});assert.equal(base.order.total,'8.00');
});

test('excess or unconfirmed receipt rolls back all stock changes', async () => {
  const p=await product();const order=await purchase(p,'1');
  const body={command_id:command(),expected_version:2,confirmed:true,items:[{item_id:order.items[0].id,quantity:'2'}]};
  await assert.rejects(service.receiveOrder(actor,order.order.id,body),/RECEIPT_EXCEEDS_ORDER/);
  await assert.rejects(service.receiveOrder(actor,order.order.id,{...body,command_id:command(),confirmed:false}),/PHYSICAL_CONFIRMATION_REQUIRED/);
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'0.000000');
  assert.equal((await service.order(actor,order.order.id)).order.version,2);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM fagoo.receipt')).rows[0].n,0);
});

test('sales reserve stock, completion consumes once and history excludes drafts', async () => {
  const p=await product({sale_price:'0.10'});await opening(p,'3');
  const draft=await service.createOrder(actor,{command_id:command(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'3'}]});
  assert.equal(draft.order.total,'0.30');assert.equal((await service.salesSeries(actor,{from:'2000-01-01',to:'2099-12-31'})).items.length,0);
  const confirmed=await service.confirmOrder(actor,draft.order.id,{command_id:command(),expected_version:1});
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].reserved,'3.000000');
  await assert.rejects(service.adjustStock(actor,{command_id:command(),warehouse_id:warehouse.id,product_id:p.id,quantity:'-1',expected_version:3,reason:'Ajuste indevido'}),/INSUFFICIENT_STOCK/);
  const input={command_id:command(),expected_version:confirmed.order.version,confirmed:true};await service.fulfillOrder(actor,draft.order.id,input);assert.equal((await service.fulfillOrder(actor,draft.order.id,input)).replayed,true);
  const stock=(await service.stock(actor,{warehouse_id:warehouse.id})).items[0];assert.equal(stock.quantity,'0.000000');assert.equal(stock.reserved,'0.000000');
  const history=await service.salesSeries(actor,{from:'2000-01-01',to:'2099-12-31',group:'customer_product_month'});assert.equal(history.items[0].quantity,'3.000000');assert.equal(history.items[0].revenue,'0.30');
  const context=await service.commercialContext(actor,customer.id,p.id);assert.equal(context.last_purchase.order_id,draft.order.id);assert.equal(context.current_price,'0.1000000000');
});

test('agent cannot override sale prices without the dedicated permission', async () => {
  const p=await product();const limited={...actor,scopes:['orders:write','catalog:read']};
  await assert.rejects(service.createOrder(limited,{command_id:command(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1',unit_price:'1'}]}),/FORBIDDEN/);
});

test('replenishment data paginates all products beyond dashboard-sized limits', async () => {
  for(let i=0;i<305;i++)await pool.query('INSERT INTO fagoo.product(company_id,id,code,name,sale_price,cost_price,stock_min,stock_max) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actor.companyId,randomUUID(),`SKU-${String(i).padStart(4,'0')}`,`Produto ${String(i).padStart(4,'0')}`,'5','3','2','10']);
  const seen=new Set();let cursor;let pages=0;
  do {const result=await service.replenishment(actor,{from:'2026-01-01',to:'2026-12-31',limit:'100',...(cursor?{cursor}:{})});assert.equal(result.total,305);assert.equal(result.coverage.partial,false);for(const row of result.items){assert(!seen.has(row.product_id));seen.add(row.product_id);assert.equal(row.sold,'0.000000');}cursor=result.next_cursor;pages++;}while(cursor);
  assert.equal(seen.size,305);assert.equal(pages,4);
});

test('API rejects unexpected fields, invalid content types and cross-filter cursors', async () => {
  let response=await handleBusinessRequest(new Request('https://erp.example/api/v1/products',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'}),{pool,actor});assert.equal(response.status,415);
  response=await handleBusinessRequest(new Request('https://erp.example/api/v1/products?company_id=other'),{pool,actor});assert.equal(response.status,400);
  await product({code:'A'});await product({code:'B'});
  const listed=await service.products(actor,{limit:'1'});await assert.rejects(service.products(actor,{limit:'1',q:'different',cursor:listed.next_cursor}),/CURSOR_INVALID/);
  response=await handleBusinessRequest(new Request('https://erp.example/api/v1/analytics/overview'),{pool,actor});assert.equal(response.status,200);assert.equal((await response.json()).products,2);
});

test('event acknowledgements are isolated per consumer and cannot move past available data', async () => {
  await product();const events=await service.events(actor);const last=events.items.at(-1).sequence;
  assert.equal((await service.acknowledgeEvents(actor,{command_id:command(),sequence:last})).acknowledged,last);
  await assert.rejects(service.acknowledgeEvents(actor,{command_id:command(),sequence:(BigInt(last)+100n).toString()}),/EVENT_CURSOR_AHEAD/);
  const other={...actor,id:'integration-two'};await service.acknowledgeEvents(other,{command_id:command(),sequence:'0'});
  const rows=(await pool.query('SELECT consumer_id,sequence::text FROM fagoo.event_ack ORDER BY consumer_id')).rows;assert.equal(rows.length,2);assert.equal(rows.find(x=>x.consumer_id==='integration-two').sequence,'0');
});

test('PostgreSQL event cursors cannot skip an earlier commercial transaction delayed before commit',{skip:!process.env.BUSINESS_TEST_DATABASE_URL},async()=>{
  await assertCommittedEventOrdering({pool,actor,
    startEarlier:connectionPool=>createBusinessService(connectionPool).saveProduct(actor,{command_id:command(),code:'EARLIER',name:'Earlier product'}),
    startLater:connectionPool=>createBusinessService(connectionPool).saveProduct(actor,{command_id:command(),code:'LATER',name:'Later product'})
  });
});

test('customer price rules use quantity, payment terms and validity, and ambiguous rules fail closed', async () => {
  const p=await product({sale_price:'15'});await opening(p,'100');
  await service.savePriceRule(actor,{command_id:command(),name:'Cliente recorrente',product_id:p.id,contact_id:customer.id,payment_terms:'30 dias',minimum_quantity:'5',unit_price:'12.25',priority:10,valid_from:'2000-01-01',valid_until:'2099-12-31'});
  assert.equal((await service.commercialContext(actor,customer.id,p.id,{quantity:'4'})).current_price,'15.0000000000');
  const context=await service.commercialContext(actor,customer.id,p.id,{quantity:'5'});assert.equal(context.current_price,'12.2500000000');assert.equal(context.price_source,'price_rule');
  const limited={...actor,scopes:['orders:write','stock:write','catalog:read']};const order=await service.createOrder(limited,{command_id:command(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'5'}]});assert.equal(order.order.total,'61.25');assert.equal(order.items[0].price_rule_id,context.price_rule_id);
  await service.confirmOrder(limited,order.order.id,{command_id:command(),expected_version:1});
  await service.savePriceRule(actor,{command_id:command(),name:'Regra conflitante',product_id:p.id,contact_id:customer.id,payment_terms:'30 dias',minimum_quantity:'5',unit_price:'11',priority:10});
  await assert.rejects(service.commercialContext(actor,customer.id,p.id,{quantity:'5'}),/PRICE_RULE_AMBIGUOUS/);
});

test('receipt reversal requires available stock and does not implicitly reverse obligations', async () => {
  const p=await product();const purchaseOrder=await purchase(p,'2');const receipt=await service.receiveOrder(actor,purchaseOrder.order.id,{command_id:command(),expected_version:2,confirmed:true,items:[{item_id:purchaseOrder.items[0].id,quantity:'2'}]});
  const posted=await service.postFinance(actor,purchaseOrder.order.id,{command_id:command(),expected_version:3,installments:[{due_on:'2026-12-01',amount:'16'}]});
  const reversed=await service.reverseReceipt(actor,purchaseOrder.order.id,receipt.receipt.id,{command_id:command(),expected_version:4,confirmed:true,reason:'Conferência anulada antes da utilização'});assert.equal(reversed.order.status,'confirmed');assert.equal(reversed.financial_effects_performed,false);assert.equal((await service.finance(actor)).items[0].status,'open');
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'0.000000');
  const reversal=await service.reverseFinance(actor,purchaseOrder.order.id,posted.posting.id,{command_id:command(),expected_version:5,expected_posting_version:1,confirmed:true,reason:'Obrigação cancelada'});assert.equal(reversal.posting.status,'reversed');assert.equal((await service.finance(actor)).items[0].status,'cancelled');
});

test('stock reversal cannot remove stock already committed to a sale', async () => {
  const p=await product();const po=await purchase(p,'1');const receipt=await service.receiveOrder(actor,po.order.id,{command_id:command(),expected_version:2,confirmed:true,items:[{item_id:po.items[0].id,quantity:'1'}]});
  const sale=await service.createOrder(actor,{command_id:command(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1'}]});await service.confirmOrder(actor,sale.order.id,{command_id:command(),expected_version:1});
  await assert.rejects(service.reverseReceipt(actor,po.order.id,receipt.receipt.id,{command_id:command(),expected_version:3,confirmed:true,reason:'Conferência incorreta'}),/INSUFFICIENT_STOCK_FOR_REVERSAL/);
  await service.cancelOrder(actor,sale.order.id,{command_id:command(),expected_version:2,reason:'Cliente cancelou'});
  await service.reverseReceipt(actor,po.order.id,receipt.receipt.id,{command_id:command(),expected_version:3,confirmed:true,reason:'Conferência incorreta'});
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'0.000000');
});

test('completed sales reversal preserves audit and restores inventory exactly once', async () => {
  const p=await product();await opening(p,'2');const sale=await service.createOrder(actor,{command_id:command(),kind:'sale',contact_id:customer.id,warehouse_id:warehouse.id,items:[{product_id:p.id,quantity:'1'}]});await service.confirmOrder(actor,sale.order.id,{command_id:command(),expected_version:1});await service.fulfillOrder(actor,sale.order.id,{command_id:command(),expected_version:2,confirmed:true});
  const reversal={command_id:command(),expected_version:3,confirmed:true,reason:'Entrega anulada com retorno físico confirmado'};
  await service.reverseFulfillment(actor,sale.order.id,reversal);assert.equal((await service.reverseFulfillment(actor,sale.order.id,reversal)).replayed,true);
  assert.equal((await service.stock(actor,{warehouse_id:warehouse.id})).items[0].quantity,'2.000000');assert.equal((await service.salesSeries(actor,{from:'2000-01-01',to:'2099-12-31'})).items.length,0);
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM fagoo.stock_movement WHERE kind='sale_reversal'")).rows[0].n,1);
});
