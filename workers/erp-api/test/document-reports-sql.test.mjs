import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { documentsFixture } from './helpers/documents-b-fixture.mjs';

// 202610200130 relatórios de vendas e de serviço on PGlite (published chain + lane), through the real Worker. Synthetic data only.
let f, service, beto, ana;
before(async () => {
  f = await documentsFixture({ upto: '202610200130' });
  service = await f.catalog('products', { name: 'Mão de obra sintética', unit: 'H', kind: 'S', format: 'S', price: '50' });
  ana = f.contact.id;
  beto = (await f.catalog('contacts', { name: 'Beto Sintético', district: 'Centro', city: 'Piracicaba', state: 'SP' })).id;
});
after(() => f?.close());
const ok = async (path, user) => { const r = await f.call(path, 'GET', undefined, user); assert.equal(r.status, 200, `${path} ${JSON.stringify(r.value)}`); return r.value; };
const seller = label => ({ introduction: null, attention_to: null, seller_reference: { system: 'origin', source_id: '7', label }, store_reference: null, business_unit_reference: null, transport: null });
const order = async (kind, extra, status) => {
  let doc = (await f.call(`/v1/documentos/${kind}`, 'POST', { command_id: randomUUID(), data: f.data(kind, extra) })).value.document;
  if (status) doc = (await f.call(`/v1/documentos/${kind}/${doc.id}/status`, 'POST', { command_id: randomUUID(), expected_version: doc.version, status, reason: 'Motivo sintético' })).value.document;
  return doc;
};
const q = params => new URLSearchParams({ from: '2026-10-01', to: '2026-10-31', ...params });

test('130 grants: the report RPCs are only for service_role', async () => {
  for (const fn of ['public.erp_document_sales_report(uuid,jsonb)', 'public.erp_document_sales_abc(uuid,text,text)', 'public.erp_document_service_report(uuid,jsonb)', 'public.erp_document_service_occurrence_report(uuid,text,text,text)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await f.scalar('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
    assert.equal(await f.scalar("select has_function_privilege('service_role',$1,'EXECUTE') v", [fn]), true, fn);
    assert.equal(await f.scalar('select prosecdef v from pg_proc where oid=$1::regprocedure', [fn]), true, fn);
  }
  assert.equal(await f.scalar("select has_function_privilege('service_role','erp_documents.report_seller(jsonb)','EXECUTE') v"), false);
});

test('Relatório de Vendas groups by cliente, produto, vendedor and bairro with exact values, frete and situação filters', async () => {
  const p = f.product.id;
  await order('sales_orders', { date: '2026-10-05', freight: '5', items: [f.line({ product_id: p, description: 'Produto sintético B', quantity: '2', unit_price: '10' })], commercial: seller('Carla') });
  await order('sales_orders', { date: '2026-10-06', items: [f.line({ product_id: p, description: 'Produto sintético B', quantity: '1.5', unit_price: '10' }), f.line({ description: 'Frete avulso', quantity: '1', unit_price: '3.33' })], commercial: seller('Carla') });
  await order('sales_orders', { date: '2026-10-07', contact_id: beto, items: [f.line({ product_id: p, description: 'Produto sintético B', quantity: '1', unit_price: '10' })], delivery_address: { name: null, postal_code: null, state: 'SP', city: 'Piracicaba', district: 'Vila Rezende', street: 'Rua Um', number: '1', complement: null, country: null } });
  await order('sales_orders', { date: '2026-10-08', contact_id: beto, items: [f.line({ quantity: '9', unit_price: '9' })] }, 'cancelled');
  await order('sales_orders', { date: '2026-09-30', items: [f.line({ quantity: '1', unit_price: '99' })] });
  const byContact = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', order: 'amount' })}`);
  assert.deepEqual(byContact.groups.map(g => [g.label, g.sales, g.items, g.amount]), [['Beto Sintético', 2, '10.000000', '91.00'], ['Contato sintético B', 2, '4.500000', '43.33']]);
  // 271: the Worker adds Custo and Lucro (null without Exibir lucro), also for a database before 271.
  assert.deepEqual(byContact.totals, { sales: 4, items: '14.500000', amount: '134.33', cost: null, profit: null, items_without_cost: 0 });
  const open = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', status: 'open', include_freight: 'false' })}`);
  assert.deepEqual(open.groups.map(g => [g.label, g.amount]), [['Beto Sintético', '10.00'], ['Contato sintético B', '38.33']], 'without the cancelled pedido and without the frete');
  const byProduct = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'product', subgroup: 'contact', status: 'open', order: 'name' })}`);
  assert.equal(byProduct.item_values, true);
  assert.deepEqual(byProduct.groups.map(g => [g.label, g.sales, g.items, g.amount, g.subgroups.map(s => [s.label, s.amount])]),
    [['Frete avulso', 1, '1.000000', '3.33', [['Contato sintético B', '3.33']]], ['Produto sintético B', 3, '4.500000', '45.00', [['Beto Sintético', '10.00'], ['Contato sintético B', '35.00']]]]);
  const bySeller = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'seller', status: 'open' })}`);
  assert.deepEqual(bySeller.groups.map(g => [g.label, g.sales]), [['Carla', 2], ['Sem vendedor', 1]]);
  const byDistrict = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'district', status: 'open' })}`);
  assert.deepEqual(byDistrict.groups.map(g => g.label), ['Sem bairro', 'Vila Rezende'], 'the delivery address comes first');
  const first = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', first_purchase: 'true', date_type: 'date' })}`);
  assert.deepEqual(first.groups.map(g => [g.label, g.sales]), [['Beto Sintético', 1]], 'the first non-cancelled pedido of each client in the period (Ana bought in September)');
  const product = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', product_id: p, state: 'SP' })}`);
  assert.deepEqual(product.groups.map(g => g.label), ['Beto Sintético'], 'UF is the client state; the product filter keeps only pedidos with that product');
  const invoiced = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', without_invoice: 'true' })}`);
  assert.equal(invoiced.totals.sales, 4, 'no pedido has a nota fiscal yet');
  // The Brufap notas are read only by admin and fiscal (113): the other readers of pedidos cannot filter by them.
  assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', without_invoice: 'true' })}`, 'GET', undefined, f.users.fiscal)).status, 200);
  for (const user of [f.users.vendas, f.users.estoque, f.users.consulta, f.users.financeiro])
    assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', without_invoice: 'true' })}`, 'GET', undefined, user)).status, 403);
  assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q({ group: 'contact', without_invoice: 'false' })}`, 'GET', undefined, f.users.vendas)).status, 200);
  for (const bad of [{ group: 'x' }, { group: 'contact', subgroup: 'contact' }, { status: 'open,open' }, { from: '2024-01-01', to: '2026-10-31' }, { include_freight: 'yes' }, { contact_id: 'x' }, { extra: '1' }, { state: 'XX' }])
    assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q(bad)}`)).status, 400, JSON.stringify(bad));
  assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q({})}`, 'GET', undefined, f.users.estoque)).status, 200, 'estoque reads pedidos de venda');
  assert.equal((await f.call(`/v1/documentos/service_orders/relatorio-vendas?${q({})}`)).status, 404);
  assert.equal((await f.call(`/v1/documentos/sales_orders/relatorio-vendas?${q({})}`, 'POST', {})).status, 405);
});

test('curva ABC ranks the items of the period by value: A up to 80%, B up to 95%, C the rest', async () => {
  const abc = await ok('/v1/documentos/sales_orders/curva-abc?from=2026-10-01&to=2026-10-31');
  assert.deepEqual(abc.items.map(i => [i.position, i.description, i.amount, i.percent, i.accumulated, i.class]), [[1, 'Produto sintético B', '45.00', '93.11', '93.11', 'A'], [2, 'Frete avulso', '3.33', '6.89', '100.00', 'B']]);
  assert.deepEqual([abc.total, abc.item_count, abc.truncated], ['48.33', 2, false], 'cancelled pedidos are out');
  assert.equal((await f.call('/v1/documentos/sales_orders/curva-abc?from=2026-10-31&to=2026-10-01')).status, 400);
  assert.equal((await f.call('/v1/documentos/sales_orders/curva-abc?from=2026-10-01&to=2026-10-31', 'GET', undefined, f.users.financeiro)).status, 200);
});

test('Relatório de Ordem de Serviço: peças and serviços totals, Coluna + Valor conditions; ocorrências by period', async () => {
  const os = await order('service_orders', { date: '2026-10-10', items: [f.line({ product_id: f.product.id, description: 'Peça', quantity: '2', unit_price: '10' }), f.line({ product_id: service.id, description: 'Serviço', quantity: '1.5', unit_price: '50' })] });
  await order('service_orders', { date: '2026-10-11', contact_id: beto, items: [] }, 'approved');
  const all = await ok('/v1/documentos/service_orders/relatorio-os');
  assert.deepEqual(all.rows.map(r => [r.name, r.parts, r.services, r.total, r.status]), [['Beto Sintético', '0.00', '0.00', '0.00', 'approved'], ['Contato sintético B', '20.00', '75.00', '95.00', 'open']]);
  const conditions = encodeURIComponent(JSON.stringify([{ column: 'name', value: 'contato' }, { column: 'services', value: '75' }]));
  assert.deepEqual((await ok(`/v1/documentos/service_orders/relatorio-os?condicoes=${conditions}`)).rows.map(r => r.number), [os.number]);
  assert.equal((await ok(`/v1/documentos/service_orders/relatorio-os?condicoes=${encodeURIComponent(JSON.stringify([{ column: 'status', value: 'cancelled' }]))}`)).row_count, 0);
  for (const bad of [[{ column: 'x', value: '1' }], [{ column: 'number', value: '01' }], [{ column: 'date', value: '20/10/2026' }], [{ column: 'name', value: 'a', extra: 1 }], 'x'])
    assert.equal((await f.call(`/v1/documentos/service_orders/relatorio-os?condicoes=${encodeURIComponent(typeof bad === 'string' ? bad : JSON.stringify(bad))}`)).status, 400, JSON.stringify(bad));
  // Situação changes are dated by the database clock (America/Sao_Paulo); the period is built around today.
  const today = await f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date)::text v"), range = await f.scalar("select ((clock_timestamp() at time zone 'America/Sao_Paulo')::date-10)::text||','||((clock_timestamp() at time zone 'America/Sao_Paulo')::date+10)::text v");
  const [from, to] = range.split(',');
  await f.call(`/v1/documentos/service_orders/${os.id}/ocorrencias`, 'POST', { command_id: randomUUID(), expected_version: os.version, occurred_on: today, occurred_time: '09:30', text: 'Peça encomendada' });
  const report = await ok(`/v1/documentos/service_orders/relatorio-ocorrencias?from=${from}&to=${to}`);
  assert.ok(report.rows.some(r => r.number === os.number && r.text === 'Peça encomendada' && r.occurred_on === today));
  assert.ok(report.rows.some(r => r.status_after === 'approved'), 'situação changes are occurrences too');
  assert.deepEqual((await ok(`/v1/documentos/service_orders/relatorio-ocorrencias?from=${from}&to=${to}&status=approved`)).rows.map(r => r.name), ['Beto Sintético']);
  assert.equal((await f.call(`/v1/documentos/service_orders/relatorio-ocorrencias?from=${from}&to=${to}`, 'GET', undefined, f.users.estoque)).status, 403, 'estoque does not read OS');
});

test('more than 500 sub groups: the 500 first in the chosen order are returned, not an arbitrary 500', async () => {
  const many = (await f.catalog('contacts', { name: 'Cliente de muitos itens' })).id;
  const line = n => f.line({ description: `Item ${String(n).padStart(3, '0')}`, quantity: '1', unit_price: String(n) });
  for (const [from, to] of [[1, 250], [251, 500], [501, 501]])
    await order('sales_orders', { date: '2026-11-03', contact_id: many, items: Array.from({ length: to - from + 1 }, (_, index) => line(from + index)) });
  const report = await ok(`/v1/documentos/sales_orders/relatorio-vendas?${new URLSearchParams({ from: '2026-11-01', to: '2026-11-30', group: 'contact', subgroup: 'product', order: 'amount', contact_id: many })}`);
  const subs = report.groups[0].subgroups;
  assert.equal(subs.length, 500);
  assert.deepEqual([subs[0].label, subs[0].amount, subs.at(-1).label], ['Item 501', '501.00', 'Item 002'], 'the smallest one is the one left out');
  assert.equal(report.groups[0].amount, '125751.00', 'the group total still counts every item');
});
