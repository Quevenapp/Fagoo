import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { produtosFixture } from './helpers/produtos-c-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf, upstream } from './helpers/produtos-c-http.mjs';

// HTTP of the price tools (migration 155). Synthetic data only.
const uuid = 'b0000000-0000-4000-8000-000000000001', other = 'b0000000-0000-4000-8000-000000000002';
const rule = { action: 'increase', unit: 'percent', value: '10' };

test('155 routes and strict input before the database', async () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/products/reajuste'), { product: 'prices', scope: 'adjust', entity: 'products', id: null });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/compras')), ['GET']);
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/reajuste/previa')), ['POST']);
  assert.equal(catalogRoute(`/v1/cadastros/products/${uuid}`).product, undefined, 'the 006 route is unchanged');
  const { handler, calls } = fakeHandler({});
  for (const [path, method, body] of [
    ['/v1/cadastros/products/reajuste/previa', 'POST', { rule: { ...rule, value: '1,5' }, ids: [uuid] }], ['/v1/cadastros/products/reajuste/previa', 'POST', { rule: { action: 'fix', unit: 'percent', value: '1' }, ids: [uuid] }],
    ['/v1/cadastros/products/reajuste/previa', 'POST', { rule, ids: [] }], ['/v1/cadastros/products/reajuste/previa', 'POST', { rule, ids: [uuid, uuid] }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, items: [{ id: uuid, expected_version: 1 }], filters: {} }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule }], ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, filters: { situation: 'deleted' } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, filters: { situation: 'latest', period: 'updated' } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, filters: { color: 'red' } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, items: [{ id: uuid, expected_version: 0 }] }],
    ['/v1/cadastros/products/compras', 'GET'], [`/v1/cadastros/products/compras?ids=${uuid}&fornecedor=x`, 'GET'], [`/v1/cadastros/products/compras?ids=${uuid}&x=1`, 'GET'],
    ['/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: null, items: [{ product_id: uuid, expected_version: 1, cost_price: '1.0000' }] }],
    ['/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: null, items: [{ product_id: uuid, expected_version: 1, price: '1.5' }] }],
    ['/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: null, items: [{ product_id: uuid, expected_version: 1 }] }],
  ]) assert.equal((await handler(request(path, method, body), env)).status, 400, `${method} ${path} ${JSON.stringify(body)}`);
  assert.equal((await handler(request('/v1/cadastros/products/compras', 'POST', {}), env)).status, 405);
  assert.equal(upstream(calls).length, 0);
  const ok = fakeHandler({ entity: 'products', total: 0, applied: 0, unchanged: 0, skipped_total: 0, skipped: [], rule, replayed: false, data_mode: 'erp_native' });
  assert.equal((await ok.handler(request('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, filters: { situation: 'active', q: ' paraf ', tag: 'none', period: 'expiry', from: '2026-01-01' } }), env)).status, 200);
  assert.deepEqual(JSON.parse(upstream(ok.calls)[0].body).p_filters, { situation: 'active', query: 'paraf', tag: 'none', period: 'expiry', from: '2026-01-01' });
});

test('155 closed shapes', async () => {
  const preview = value => fakeHandler(value).handler(request('/v1/cadastros/products/reajuste/previa', 'POST', { rule, ids: [uuid] }), env);
  const item = { id: uuid, price: '10.0000', status: 'ok', new_price: '11.0000' };
  assert.equal((await preview({ entity: 'products', items: [item], data_mode: 'erp_native' })).status, 200);
  for (const wrong of [{ ...item, new_price: '11' }, { ...item, status: 'no_price' }, { ...item, status: 'unchanged' }, { ...item, id: other }, { ...item, extra: 1 }])
    assert.equal((await preview({ entity: 'products', items: [wrong], data_mode: 'erp_native' })).status, 502, JSON.stringify(wrong));
  const adjust = value => fakeHandler(value).handler(request('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, items: [{ id: uuid, expected_version: 1 }] }), env);
  const result = { entity: 'products', total: 1, applied: 1, unchanged: 0, skipped_total: 0, skipped: [], rule, replayed: false, data_mode: 'erp_native' };
  assert.equal((await adjust(result)).status, 200);
  for (const wrong of [{ ...result, applied: 0 }, { ...result, skipped: [{ id: uuid, name: 'x', reason: 'broken' }], skipped_total: 1 }, { ...result, applied: -1 }])
    assert.equal((await adjust(wrong)).status, 502, JSON.stringify(wrong));
  const prices = value => fakeHandler(value).handler(request('/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: other, items: [{ product_id: uuid, expected_version: 1, price: '1.5000', cost_price: '1.0000' }] }), env);
  const updated = { entity: 'products', supplier_id: other, items: [{ product_id: uuid, version: 2, price: '1.5000', cost_price: '1.0000' }], replayed: false, data_mode: 'erp_native' };
  assert.equal((await prices(updated)).status, 200);
  for (const wrong of [{ ...updated, items: [{ ...updated.items[0], version: 3 }] }, { ...updated, items: [{ ...updated.items[0], price: '1.6000' }] }, { ...updated, supplier_id: uuid }])
    assert.equal((await prices(wrong)).status, 502, JSON.stringify(wrong));
});

test('155 worker and SQL agree: preview, the filtered adjust, purchase information and Atualizar preços', async () => {
  const f = await produtosFixture();
  try {
    const { call, calls } = realHandler(f);
    const supplier = await f.contact({ name: 'Fornecedor HTTP' });
    const a = await f.product({ name: 'Parafuso HTTP', price: '10' }), b = await f.product({ name: 'Porca HTTP', price: '4' });
    const preview = await call('/v1/cadastros/products/reajuste/previa', 'POST', { rule, ids: [a.id, b.id] }, 'consulta');
    assert.equal(preview.status, 200, JSON.stringify(preview.data)); assert.deepEqual(preview.data.items.map(item => item.new_price), ['11.0000', '4.4000']);
    const adjusted = await call('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'fix', unit: 'amount', value: '7' }, filters: { situation: 'latest', q: 'HTTP' } });
    assert.equal(adjusted.status, 200, JSON.stringify(adjusted.data)); assert.deepEqual([adjusted.data.total, adjusted.data.applied], [2, 2]);
    assert.equal(calls.at(-1).name, 'erp_catalog_product_price_adjust');
    assert.equal((await call('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule, filters: { situation: 'latest' } }, 'vendas')).status, 403);
    const info = await call(`/v1/cadastros/products/compras?ids=${a.id}&fornecedor=${supplier.id}`, 'GET', undefined, 'estoque');
    assert.equal(info.status, 200, JSON.stringify(info.data)); assert.deepEqual([info.data.items[0].version, info.data.items[0].price, info.data.mode], [2, '7.0000', 'last_purchase']);
    const prices = await call('/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: supplier.id, items: [{ product_id: a.id, expected_version: 2, price: '13.5500', cost_price: '10.0000' }] }, 'estoque');
    assert.equal(prices.status, 200, JSON.stringify(prices.data)); assert.deepEqual(prices.data.items[0], { product_id: a.id, version: 3, price: '13.5500', cost_price: '10.0000' });
    assert.equal((await call('/v1/cadastros/products/precos', 'POST', { command_id: randomUUID(), supplier_id: null, items: [{ product_id: a.id, expected_version: 2, price: '1.0000' }] })).status, 409);
  } finally { await f.close(); }
});
