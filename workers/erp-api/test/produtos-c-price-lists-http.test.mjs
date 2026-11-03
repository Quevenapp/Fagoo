import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { productRegistryFixture } from './helpers/product-registry-fixture.mjs';
import { produtosFixture } from './helpers/produtos-c-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf, upstream } from './helpers/produtos-c-http.mjs';

// HTTP of the price lists, wave C (migration 154): Vendedor and Forma de pagamento, add_products on the inclusion, the period
// filter and the list prices of a product set. Synthetic data only.
const uuid = 'b0000000-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002';
const listData = { name: 'Atacado', category: 'other', list_type: 'rates', factor: '10', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [] };
const header = extra => ({ id: uuid, name: 'Atacado', category: 'seller', list_type: 'rates', factor: '10.0000', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null,
  start_time: null, end_time: null, version: 1, created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z', rule: 'Desconto 10 %', products: 0, contacts: [], sellers: [{ id: other, name: 'Vendedora' }], payment_methods: [], regions: [], ...extra });

test('154 routes and strict input before the database', async () => {
  assert.deepEqual(catalogRoute(`/v1/cadastros/listas-precos/${uuid}/precos`), { product: 'price-lists', scope: 'precos', id: uuid, entity: 'products' });
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/listas-precos/${uuid}/precos`)), ['GET']);
  const { handler, calls } = fakeHandler({});
  for (const [path, method, body] of [
    ['/v1/cadastros/listas-precos?categoria=store', 'GET'], ['/v1/cadastros/listas-precos?from=2026-02-30', 'GET'], ['/v1/cadastros/listas-precos?from=2026-10-02&to=2026-10-01', 'GET'],
    ['/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, sellers: ['x'] } }],
    ['/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, payment_methods: Array.from({ length: 31 }, () => randomUUID()) } }],
    ['/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, add_products: [uuid, uuid.toUpperCase()] } }],
    [`/v1/cadastros/listas-precos/${uuid}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { ...listData, add_products: [uuid] } }],
    [`/v1/cadastros/listas-precos/${uuid}/precos`, 'GET'], [`/v1/cadastros/listas-precos/${uuid}/precos?produtos=x`, 'GET'], [`/v1/cadastros/listas-precos/${uuid}/precos?produtos=${uuid},${uuid}`, 'GET'],
    [`/v1/cadastros/listas-precos/${uuid}/precos?produtos=${uuid}&x=1`, 'GET'],
  ]) assert.equal((await handler(request(path, method, body), env)).status, 400, `${method} ${path}`);
  assert.equal(upstream(calls).length, 0);
  const ok = fakeHandler({ items: [], data_mode: 'erp_native' });
  assert.equal((await ok.handler(request('/v1/cadastros/listas-precos?categoria=payment_method&from=2026-10-01&to=2026-10-20'), env)).status, 200);
  const args = JSON.parse(upstream(ok.calls)[0].body);
  assert.deepEqual([args.p_category, args.p_from, args.p_to], ['payment_method', '2026-10-01', '2026-10-20']);
  assert.equal((await ok.handler(request('/v1/cadastros/listas-precos'), env)).status, 200);
  assert.equal(Object.hasOwn(JSON.parse(upstream(ok.calls)[1].body), 'p_from'), false, 'without a period the call keeps the 121 arguments');
});

test('154 closed shapes: the detail needs the new links and the list prices are exact cents', async () => {
  const detail = value => fakeHandler({ list: value, items: [], total: 0, offset: 0, limit: 100, data_mode: 'erp_native' }).handler(request(`/v1/cadastros/listas-precos/${uuid}`), env);
  assert.equal((await detail(header())).status, 200);
  for (const wrong of [(({ sellers, ...rest }) => rest)(header()), header({ sellers: [{ id: 'x', name: 'V' }] }), header({ category: 'store' }), header({ payment_methods: Array.from({ length: 31 }, () => ({ id: other, name: 'P' })) })])
    assert.equal((await detail(wrong)).status, 502, JSON.stringify(wrong));
  const prices = value => fakeHandler(value).handler(request(`/v1/cadastros/listas-precos/${uuid}/precos?produtos=${other}`), env);
  const list = { id: uuid, name: 'Atacado', list_type: 'rates', rule: 'Desconto 10 %', valid_now: true, version: 1 };
  assert.equal((await prices({ list, items: [{ product_id: other, in_list: true, list_price: '9.11' }], data_mode: 'erp_native' })).status, 200);
  for (const items of [[{ product_id: other, in_list: true, list_price: '9.1' }], [{ product_id: other, in_list: false, list_price: '9.11' }], [{ product_id: uuid, in_list: true, list_price: null }]])
    assert.equal((await prices({ list, items, data_mode: 'erp_native' })).status, 502, JSON.stringify(items));
  assert.equal((await prices({ list: { ...list, id: other }, items: [], data_mode: 'erp_native' })).status, 502);
});

test('154 the worker before the migration: the list detail without the new links is a documented 502', async () => {
  const f = await productRegistryFixture({ lane: [] });
  try {
    const { call } = realHandler(f);
    const created = await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: listData });
    assert.equal(created.status, 502, 'the API is published after migration 154 (banco -> API -> ERP)');
  } finally { await f.close(); }
});

test('154 worker and SQL agree: a seller list with the selected products, the period filter and the list prices', async () => {
  const f = await produtosFixture();
  try {
    const { call, calls } = realHandler(f);
    const sellerContact = await f.contact({ name: 'Vendedora HTTP' });
    const seller = await f.scalar('insert into erp_catalog.seller(contact_id,created_by,updated_by) values($1,$2,$2) returning id v', [sellerContact.id, f.users.admin]);
    const a = await f.product({ name: 'Parafuso', price: '10' }), b = await f.product({ name: 'Porca', price: '1' });
    const created = await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { ...listData, category: 'seller', sellers: [seller], add_products: [a.id, b.id.toUpperCase()] } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.deepEqual([created.data.list.products, created.data.list.sellers.map(item => item.name)], [2, ['Vendedora HTTP']]);
    assert.deepEqual((await call(`/v1/cadastros/listas-precos?categoria=seller&from=2026-01-01`)).data.items.map(item => item.name), ['Atacado']);
    const prices = await call(`/v1/cadastros/listas-precos/${created.data.list.id}/precos?produtos=${a.id},${b.id}`, 'GET', undefined, 'vendas');
    assert.equal(prices.status, 200, JSON.stringify(prices.data));
    assert.deepEqual(prices.data.items.map(item => item.list_price), ['9.00', '0.90']);
    assert.equal(calls.at(-1).name, 'erp_pricing_list_prices');
    assert.equal((await call(`/v1/cadastros/listas-precos/${created.data.list.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { ...listData, category: 'seller', sellers: [seller] } }, 'consulta')).status, 403);
  } finally { await f.close(); }
});
