import test from 'node:test'; import assert from 'node:assert/strict'; import { randomUUID } from 'node:crypto';
import { financeiroHFixture, fails } from './helpers/financeiro-h-fixture.mjs';
import { captureBusinessQuery, businessArgs, parseBusinessPanel } from '../../../packages/erp-domain/src/business-dashboards.mjs';

// Leva H, lane financeiro (374: PRF-268, VND-269): frete cobrado and frete pago apart, the cost applied on each operation and the cost
// history of the cadastro, so the margin and the sales report never use the current cost for an old sale. Synthetic data only.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('H 374: margin = products + frete cobrado − cost applied − frete pago; changing the cost later keeps old sales', async () => {
  const f = await financeiroHFixture(); try {
    const client = (await f.catalog('contacts', { name: 'Cliente Sintético Margem' })).id, supplier = await f.catalog('contacts', { name: 'Fornecedor Sintético', document: '11222333000181' });
    const product = await f.catalog('products', { name: 'Produto Margem', code: 'MRG-1', unit: 'UN', kind: 'P', format: 'S', price: '200' });
    const setCost = async cost => { const version = Number(await f.scalar('select version v from erp_catalog.record where id=$1', [product.id]));
      await f.rpc('erp_catalog_product_save', { p_user_id: f.users.admin, p_id: product.id, p_expected_version: version, p_command_id: randomUUID(), p_data: { suppliers: [{ supplier_id: supplier.id, cost_price: cost, is_default: true }] }, p_acknowledged: null }); };
    await setCost('120');
    const confirm = async d => f.transition(d.status === 'draft' ? await f.transition(d, 'open') : d, 'verified');
    const order = await confirm(await f.document('sales_orders', { contact: client, date: today, body: { freight: '10' }, items: [{ product_id: product.id, description: 'Produto Margem', quantity: '1', unit_price: '200' }] }));
    const applied = (await f.db.query('select trim_scale(unit_cost)::text c,basis from erp_documents.item_cost_applied where document_id=$1', [order.id])).rows;
    assert.deepEqual(applied, [{ c: '120', basis: 'preco_custo' }], 'the cost of the confirmation is kept on the operation');
    // The cost changes afterwards: history keeps both; the confirmed sale keeps 120, a new draft of today uses 150.
    await setCost('150'); await setCost('150');
    assert.deepEqual((await f.db.query('select trim_scale(cost_price)::text c,source from erp_catalog.product_cost_history where product_id=$1 order by id', [product.id])).rows.map(r => [r.c, r.source]),
      [['120', 'cadastro'], ['150', 'cadastro']], 'equal saves are not a change');
    const draft = await f.document('sales_orders', { contact: client, date: today, items: [{ product_id: product.id, description: 'Produto Margem', quantity: '1', unit_price: '200' }] });
    const old = await f.document('sales_orders', { contact: client, date: shift(today, -400), items: [{ product_id: product.id, description: 'Produto Margem', quantity: '1', unit_price: '200' }] });
    const costs = Object.fromEntries((await f.db.query("select document_id::text d,trim_scale(unit_cost)::text c from erp_home.biz_lines($1,$2,array['draft','open','verified'])", [shift(today, -400), today])).rows.map(r => [r.d, r.c]));
    assert.deepEqual([costs[order.id], costs[draft.id], costs[old.id]], ['120', '150', null], 'before the history starts the cost is pending, never today\'s');
    assert.equal(await f.scalar('select erp_catalog.product_cost_at($1,$2)::text v', [product.id, shift(today, -1)]), null);
    // Frete pago pela empresa: informed per pedido, apart from the frete cobrado do cliente; no conta is created.
    const titles = Number(await f.scalar('select count(*) v from erp_finance.title'));
    const fp = await f.call(`/v1/documentos/sales_orders/${order.id}/frete-pago`);
    assert.deepEqual([fp.status, fp.value.item.freight_charged, fp.value.item.freight_paid, fp.value.item.applied_costs.length], [200, '10.00', null, 1]);
    const saved = await f.call(`/v1/documentos/sales_orders/${order.id}/frete-pago`, 'POST', { command_id: randomUUID(), expected_version: 0, data: { amount: '25.00', note: 'Transportadora sintética' } });
    assert.deepEqual([saved.status, saved.value.item.freight_paid, saved.value.item.version], [200, '25.00', 1]);
    assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/frete-pago`, 'POST', { command_id: randomUUID(), expected_version: 0, data: { amount: '30', note: null } })).status, 409);
    assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/frete-pago`, 'POST', { command_id: randomUUID(), expected_version: 1, data: { amount: '-1', note: null } })).status, 400);
    assert.equal((await f.call(`/v1/documentos/sales_orders/${order.id}/frete-pago`, 'GET', undefined, f.users.vendas)).status, 403, 'vendas does not read costs');
    assert.equal(Number(await f.scalar('select count(*) v from erp_finance.title')), titles);
    // Margem por pedido: 200 + 10 − 120 − 25 = 65 (no tax rate configured).
    const q = captureBusinessQuery('margem-pedido', { situacoes: 'verified', de: shift(today, -1), ate: today, aba: 'todos' });
    const m = parseBusinessPanel(await f.rpc('erp_home_business_panel', { p_user_id: f.users.admin, p_panel: 'margem-pedido', p_args: businessArgs(q) }), q);
    const row = m.orders.find(o => o.id === order.id);
    assert.deepEqual([row.freight, row.freight_paid, row.cost, row.contribution], ['10.00', '25.00', '120.00', '65.00']);
    assert.deepEqual([m.indicators.freight_buyer, m.indicators.freight_seller, m.indicators.freight_paid_pending], ['10.00', '25.00', 0]);
    // Relatório de vendas: Custo aplicado and Preço de custo até a data do pedido; Preço de custo is today's (150).
    const report = async base => (await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${new URLSearchParams({ from: today, to: today, group: 'product', show_profit: 'true', profit_base: base, status: 'verified' })}`)).value;
    const [appliedReport, untilReport, current] = [await report('applied'), await report('cost_until'), await report('cost')];
    assert.deepEqual([appliedReport.totals.cost, untilReport.totals.cost, current.totals.cost], ['120.00', '150.00', '150.00']);
    await fails(assert, () => f.db.query('update erp_documents.item_cost_applied set unit_cost=1'), '55000');
    await fails(assert, () => f.db.query('delete from erp_catalog.product_cost_history'), '55000');
  } finally { await f.close(); }
});

test('H 374 refuses to replace a margin function that changed since it was written', async () => {
  const g = await financeiroHFixture({ before: '202610210374' }); try {
    await g.db.exec("create or replace function erp_documents.report_unit_cost(p_product uuid,p_base text,p_until date,p_balances boolean) returns numeric language sql stable set search_path=pg_catalog as $$ select 0::numeric $$");
    await assert.rejects(() => g.migrate('202610210374_cost_history_freight.sql'), e => e.code === '55000' && /previous_definition_changed/.test(e.message));
  } finally { await g.close(); }
});
