import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';
import { productStockMirrorResponse, withProductStockMirror, PRODUCT_STOCK_FILTERS } from '../src/product-stock-mirror.mjs';

// Synthetic data only. The product page and export read the Origin summary in one batch per page, after the native page.
const USER = 'a0000000-0000-4000-8000-000000000001';
const P1 = 'b0000000-0000-4000-8000-000000000001', P2 = 'b0000000-0000-4000-8000-000000000002', P3 = 'b0000000-0000-4000-8000-000000000003';
const WAREHOUSE = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const stamp = '2026-10-22T12:00:00Z';
const item = (id, stock = { state: 'no_movements', quantity: null, warehouse: null }) => ({ id, entity: 'products', version: 1, active: true, name: 'Produto ' + id.slice(-1), code: 'S-' + id.slice(-1), unit: 'UN',
  price: '2.0000', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null, stock, stock_min: null, stock_max: null, location: null, cost_price: null, thumbnail: null, category_id: null, expiry_date: null, deleted: false });
const nativePage = (items, patch = {}) => ({ entity: 'products', items, page: 1, size: 100, total: items.length, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native', ...patch });
const observed = (id, patch = {}) => ({ product_id: id, product_source_id: '201', state: 'observed', warehouse_source_id: '900', warehouse_name: 'Geral', physical: '10', virtual: '8',
  physical_state: 'value', virtual_state: 'value', observed_at: '2026-10-22T11:59:00+00:00', source_version: 3, positions: 1, issues: [], ...patch });
const empty = (id, state, patch = {}) => ({ product_id: id, product_source_id: state === 'unlinked' ? null : '202', state, warehouse_source_id: null, warehouse_name: null, physical: null, virtual: null,
  physical_state: null, virtual_state: null, observed_at: null, source_version: null, positions: state === 'multiple_warehouses' ? 2 : 0, issues: [], ...patch });
const summary = (items, warehouse = null) => ({ scope: 'product_stock_mirror', data_mode: 'origin_mirror', origin: 'origin', read_only: true, warehouse, items });

function server({ page = nativePage([item(P1, { state: 'recorded', quantity: '2.000000', warehouse: null }), item(P2), item(P3)]), mirror, mirrorStatus = 200 } = {}) {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/user')) return new Response(JSON.stringify({ id: USER }));
    if (url.endsWith('/rpc/erp_stock_mirror_product_summary')) return mirrorStatus === 200 ? new Response(JSON.stringify(mirror ?? summary([observed(P1), empty(P2, 'not_observed'), empty(P3, 'unlinked')])))
      : new Response(JSON.stringify(mirrorStatus === 403 ? { code: '42501', message: 'erp_stock_access_denied' } : { code: 'XX000', message: 'synthetic' }), { status: mirrorStatus });
    return new Response(JSON.stringify(page));
  } });
  const get = path => handler(new Request(`https://api.example.test${path}`, { headers: { Authorization: 'Bearer synthetic-user' } }), env);
  return { calls, get };
}

test('product page: one summary call per page, Origin and native side by side, exact decimals', async () => {
  const s = server(), response = await s.get('/v1/cadastros/products?page=1&situation=latest');
  assert.equal(response.status, 200);
  const body = await response.json();
  const rpcs = s.calls.filter(call => call.url.includes('/rpc/')).map(call => call.url.split('/rpc/')[1]);
  assert.deepEqual(rpcs, ['erp_catalog_product_page_v2', 'erp_stock_mirror_product_summary']);
  assert.deepEqual(s.calls.at(-1).body, { p_product_ids: [P1, P2, P3], p_warehouse_id: null, p_user_id: USER });
  assert.deepEqual(body.origin_stock, { origin: 'origin', status: 'ok', warehouse: null });
  assert.deepEqual(body.items[0].stock, { state: 'recorded', quantity: '2.000000', warehouse: null });
  assert.deepEqual([body.items[0].origin_stock.physical, body.items[0].origin_stock.virtual, body.items[0].origin_stock.origin], ['10', '8', 'origin']);
  assert.equal(body.items[1].origin_stock.state, 'not_observed'); assert.equal(body.items[1].origin_stock.physical, null);
  assert.equal(body.items[2].origin_stock.state, 'unlinked'); assert.equal(body.data_mode, 'erp_native');
});

test('product page: the warehouse goes to the summary; an unmatched warehouse is reported, never guessed', async () => {
  const page = nativePage([item(P1, { state: 'no_movements', quantity: null, warehouse: { id: WAREHOUSE, state: 'no_movements', quantity: null } })]);
  const s = server({ page, mirror: summary([empty(P1, 'warehouse_unlinked')], { id: WAREHOUSE, source_id: null, linked: false }) });
  const body = await (await s.get(`/v1/cadastros/products?page=1&situation=latest&stock=origin_positive&warehouse_id=${WAREHOUSE}`)).json();
  assert.equal(s.calls.find(call => call.url.endsWith('erp_catalog_product_page_v2')).body.p_stock, 'origin_positive');
  assert.equal(s.calls.at(-1).body.p_warehouse_id, WAREHOUSE);
  assert.deepEqual(body.origin_stock.warehouse, { id: WAREHOUSE, source_id: null, linked: false });
  assert.equal(body.items[0].origin_stock.state, 'warehouse_unlinked');
});

test('product page: a refused or failed summary keeps the native list and says why; no extra call without stock access', async () => {
  for (const [status, expected] of [[403, 'forbidden'], [500, 'unavailable']]) {
    const body = await (await server({ mirrorStatus: status }).get('/v1/cadastros/products?page=1&situation=latest')).json();
    assert.equal(body.origin_stock.status, expected); assert.ok(body.items.every(row => row.origin_stock === null)); assert.equal(body.items.length, 3);
  }
  const hidden = server({ page: nativePage([{ ...item(P1), stock: null }], { stock_visible: false }) });
  const body = await (await hidden.get('/v1/cadastros/products?page=1&situation=latest')).json();
  assert.equal(body.origin_stock, null); assert.equal(body.items[0].origin_stock, null);
  assert.ok(!hidden.calls.some(call => call.url.endsWith('erp_stock_mirror_product_summary')));
});

test('product page: an invalid summary is a 502, never a silent zero or a native balance', async () => {
  for (const mirror of [summary([observed(P1, { physical: 10 }), empty(P2, 'not_observed'), empty(P3, 'unlinked')]), summary([observed(P1)]),
    summary([observed(P2), empty(P1, 'not_observed'), empty(P3, 'unlinked')]), summary([observed(P1, { physical_state: 'null' }), empty(P2, 'not_observed'), empty(P3, 'unlinked')]),
    summary([observed(P1), empty(P2, 'not_observed', { physical: '0' }), empty(P3, 'unlinked')]), summary([observed(P1), empty(P2, 'not_observed'), empty(P3, 'unlinked', { product_source_id: '1' })]),
    { ...summary([observed(P1), empty(P2, 'not_observed'), empty(P3, 'unlinked')]), origin: 'brufap' }])
    assert.equal((await server({ mirror }).get('/v1/cadastros/products?page=1&situation=latest')).status, 502);
});

test('stock filter values are explicit and shared by the page, the export and the price tools', async () => {
  assert.deepEqual(PRODUCT_STOCK_FILTERS.filter(value => value.startsWith('origin_')), ['origin_zero', 'origin_negative', 'origin_positive', 'origin_not_observed', 'origin_unlinked']);
  assert.equal((await server().get('/v1/cadastros/products?page=1&situation=latest&stock=origin_other')).status, 400);
});

test('export: the summary uses the default warehouse of the native export and stays in its own field', async () => {
  const exportItem = { id: P1, version: 1, code: 'S-1', name: 'Produto 1', unit: 'UN', kind: 'P', format: 'S', active: true, stock: '2.000000', source_id: '201', tags: [], images: [] };
  const s = server({ page: { entity: 'products', items: [exportItem], offset: 0, limit: 40, total: 1, stock_visible: true, stock_scope: 'default_warehouse', stock_warehouse: { id: WAREHOUSE, name: 'Geral' }, data_mode: 'erp_native' },
    mirror: summary([observed(P1, { physical: '-3', virtual: '-5' })], { id: WAREHOUSE, source_id: '900', linked: true }) });
  const response = await s.get('/v1/cadastros/products/exportacao?offset=0&limit=40');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(s.calls.at(-1).body.p_warehouse_id, WAREHOUSE);
  assert.equal(body.items[0].stock, '2.000000'); assert.equal(body.items[0].origin_stock.physical, '-3');
});

test('merge helper never calls the summary for an empty page and rejects batches above 250', async () => {
  let called = 0;
  const empty = await withProductStockMirror({ stock_visible: true, items: [] }, null, async () => { called++; });
  assert.equal(called, 0); assert.equal(empty.origin_stock.status, 'ok');
  await assert.rejects(withProductStockMirror({ stock_visible: true, items: Array.from({ length: 251 }, (_, n) => ({ id: `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}` })) }, null, async () => ({})));
  assert.throws(() => productStockMirrorResponse(summary([observed(P1)], { id: WAREHOUSE, source_id: '900', linked: true }), [P1], null));
  assert.throws(() => productStockMirrorResponse(summary([observed(P1, { warehouse_source_id: '901' })], { id: WAREHOUSE, source_id: '900', linked: true }), [P1], WAREHOUSE));
  assert.equal(productStockMirrorResponse(summary([observed(P1)], { id: WAREHOUSE, source_id: '900', linked: true }), [P1], WAREHOUSE).items.get(P1).physical, '10');
});
