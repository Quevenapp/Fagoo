import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { produtosDFixture } from './helpers/produtos-d-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf, upstream } from './helpers/produtos-c-http.mjs';

// HTTP of the produtos lane, wave D (migration 191): the "Campos customizados" filter of the v2 page and of the price adjust, the
// form context (CRT) and the decimal Itens p/ caixa in the product form. Strict input before the database, the worker against
// the real SQL in PGlite and closed shapes after it. Synthetic data only.
const uuid = 'd0000000-0000-4000-8000-000000000001';
const page = custom => `/v1/cadastros/products?page=1&situation=latest&custom=${encodeURIComponent(typeof custom === 'string' ? custom : JSON.stringify(custom))}`;

test('191 routes: the form context is GET only', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/products/contexto'), { product: 'context', entity: 'products', id: null });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/products/contexto')), ['GET']);
});

test('191 strict input: the custom filter, the context and Itens p/ caixa are refused before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const bad = [
    [page('x')], [page([])], [page({ field_id: uuid })], [page([{ field_id: 'x', value: 'a' }])], [page([{ field_id: uuid }])], [page([{ field_id: uuid, value: 'a', from: '1' }])],
    [page([{ field_id: uuid, value: 1 }])], [page([{ field_id: uuid, value: 'a\u0001' }])], [page([{ field_id: uuid, value: 'a'.repeat(256) }])], [page([{ field_id: uuid, value: 'a', other: 1 }])],
    [page(Array.from({ length: 11 }, () => ({ field_id: uuid, value: 'a' })))], [`${page([{ field_id: uuid, value: 'a' }])}&custom=x`],
    ['/v1/cadastros/products/contexto?x=1'], ['/v1/cadastros/products/contexto', 'POST', {}],
    [`/v1/cadastros/products/${uuid}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { items_per_box_decimal: '2,5' } }],
    [`/v1/cadastros/products/${uuid}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { items_per_box_decimal: '1000000' } }],
    [`/v1/cadastros/products/${uuid}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { items_per_box_decimal: 2 } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'increase', unit: 'amount', value: '1' }, filters: { custom: 'x' } }],
    ['/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'increase', unit: 'amount', value: '1' }, filters: { custom: [{ field_id: uuid }] } }],
    // The export does not take the custom filter (Origin ignores it too).
    [`/v1/cadastros/products/exportacao?custom=${encodeURIComponent(JSON.stringify([{ field_id: uuid, value: 'a' }]))}`],
  ];
  for (const [path, method = 'GET', body] of bad) assert.ok([400, 405].includes((await handler(request(path, method, body), env)).status), `${method} ${path}`);
  assert.equal(upstream(calls).length, 0);
  // A valid filter reaches the custom page with canonical ids; without it the v2 page answers.
  const ok = fakeHandler({});
  await ok.handler(request(page([{ field_id: uuid.toUpperCase(), value: 'Aço' }, { field_id: uuid, from: '1.5', to: '' }])), env);
  assert.equal(rpcOf(upstream(ok.calls)[0]), 'erp_catalog_product_page_custom');
  assert.deepEqual(JSON.parse(upstream(ok.calls)[0].body).p_custom, [{ field_id: uuid, value: 'Aço' }, { field_id: uuid, from: '1.5' }]);
  await ok.handler(request('/v1/cadastros/products?page=1&situation=latest'), env);
  assert.equal(rpcOf(upstream(ok.calls)[1]), 'erp_catalog_product_page_v2');
  await ok.handler(request('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'increase', unit: 'amount', value: '1' }, filters: { situation: 'active', custom: [{ field_id: uuid.toUpperCase(), value: 'true' }] } }), env);
  assert.deepEqual(JSON.parse(upstream(ok.calls)[2].body).p_filters, { situation: 'active', custom: [{ field_id: uuid, value: 'true' }] });
});

test('191 closed answers: an unexpected context shape becomes 502', async () => {
  for (const answer of [{ crt: '9', data_mode: 'erp_native' }, { crt: 3, data_mode: 'erp_native' }, { crt: '3', extra: 1, data_mode: 'erp_native' }, { crt: '3' }]) {
    const { handler } = fakeHandler(answer);
    assert.equal((await handler(request('/v1/cadastros/products/contexto'), env)).status, 502, JSON.stringify(answer));
  }
  const ok = fakeHandler({ crt: '1', data_mode: 'erp_native' });
  const response = await ok.handler(request('/v1/cadastros/products/contexto'), env);
  assert.deepEqual([response.status, await response.json()], [200, { crt: '1', data_mode: 'erp_native' }]);
  assert.deepEqual(JSON.parse(upstream(ok.calls)[0].body), { p_user_id: 'a0000000-0000-4000-8000-000000000001' });
});

test('191 worker and SQL agree: decimal Itens p/ caixa, the custom page, the filtered adjust and the context', async () => {
  const f = await produtosDFixture(); const { call } = realHandler(f);
  try {
    const created = await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Caixa', kind: 'P', format: 'S', unit: 'UN', price: '10', items_per_box_decimal: '2.5' } });
    assert.deepEqual([created.status, created.data.record.items_per_box, created.data.record.items_per_box_decimal], [200, null, '2.500000']);
    const read = await call(`/v1/cadastros/products/${created.data.record.id}`);
    assert.deepEqual([read.status, read.data.record.items_per_box], [200, null], 'the old route reads the integer mirror');
    const field = (await call('/v1/cadastros/campos-customizados', 'POST', { command_id: randomUUID(), data: { field_type: 'text', name: 'Material' } })).data.field;
    const saved = await call(`/v1/cadastros/products/${created.data.record.id}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: created.data.record.version, data: { custom_values: { [field.id]: 'Aço' } } });
    assert.equal(saved.status, 200);
    await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Outro', kind: 'P', format: 'S', unit: 'UN', price: '10' } });
    const filtered = await call(page([{ field_id: field.id, value: 'aco' }]), 'GET', undefined, 'consulta');
    assert.deepEqual([filtered.status, filtered.data.total, filtered.data.items.map(item => item.name)], [200, 1, ['Caixa']]);
    assert.equal(typeof filtered.data.items[0].deleted, 'boolean', 'the v2 extras are projected');
    assert.equal((await call(page([{ field_id: randomUUID(), value: 'a' }]))).status, 400);
    const adjusted = await call('/v1/cadastros/products/reajuste', 'POST', { command_id: randomUUID(), rule: { action: 'fix', unit: 'amount', value: '12' }, filters: { situation: 'latest', custom: [{ field_id: field.id, value: 'aço' }] } });
    assert.deepEqual([adjusted.status, adjusted.data.total, adjusted.data.applied], [200, 1, 1]);
    const context = await call('/v1/cadastros/products/contexto', 'GET', undefined, 'vendas');
    assert.deepEqual([context.status, context.data], [200, { crt: null, data_mode: 'erp_native' }]);
    assert.equal((await call('/v1/cadastros/products/contexto', 'GET', undefined, 'financeiro')).status, 403);
    const exported = await call('/v1/cadastros/products/exportacao?limit=10');
    assert.deepEqual(exported.data.items.map(item => item.items_per_box_decimal).sort(), ['2.500000', null].sort());
  } finally { await f.close(); }
});

test('191 deploy order: the new worker against the production SQL (up to 190) keeps the product form and refuses only the new routes', async () => {
  const f = await produtosDFixture({ lane: [] }); const { call } = realHandler(f);
  try {
    const created = await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Antes de 191', kind: 'P', format: 'S', unit: 'UN', items_per_box: '6' } });
    assert.deepEqual([created.status, created.data.record.items_per_box, created.data.record.items_per_box_decimal], [200, '6', null]);
    assert.notEqual((await call(page([{ field_id: uuid, value: 'a' }]))).status, 200);
    assert.notEqual((await call('/v1/cadastros/products/contexto')).status, 200);
    assert.equal((await call('/v1/cadastros/products?page=1&situation=latest')).status, 200);
  } finally { await f.close(); }
});

test('191 the product detail contract: Itens p/ caixa is an exact six-place decimal in answers', async () => {
  const { checkProductDetail, ProductDetailError } = await import('../../../packages/erp-domain/src/product-detail.mjs');
  for (const ok of ['0', '2.5', '999999.999999']) assert.doesNotThrow(() => checkProductDetail('items_per_box_decimal', ok));
  for (const bad of ['-1', '1000000', '1.1234567', '1,5', '', 1]) assert.throws(() => checkProductDetail('items_per_box_decimal', bad), ProductDetailError);
  assert.doesNotThrow(() => checkProductDetail('items_per_box_decimal', '2.500000', { response: true }));
  for (const bad of ['2.5', '2', ' 2.500000']) assert.throws(() => checkProductDetail('items_per_box_decimal', bad, { response: true }), ProductDetailError);
});

test('191 worker and SQL agree: Controle de lote travels with the product form and is refused with variations', async () => {
  const f = await produtosDFixture(); const { call } = realHandler(f);
  try {
    const created = await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Leite', kind: 'P', format: 'S', unit: 'UN', lot_control: true } });
    assert.deepEqual([created.status, created.data.record.lot_control], [200, true]);
    assert.equal((await call(`/v1/cadastros/products/${created.data.record.id}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: created.data.record.version, data: { lot_control: 'sim' } })).status, 400);
    assert.equal((await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Grade', kind: 'P', format: 'V', unit: 'UN', lot_control: true } })).status, 400);
  } finally { await f.close(); }
});
