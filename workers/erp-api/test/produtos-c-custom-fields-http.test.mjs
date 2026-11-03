import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { productRegistryFixture } from './helpers/product-registry-fixture.mjs';
import { produtosFixture } from './helpers/produtos-c-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf } from './helpers/produtos-c-http.mjs';

// HTTP of the custom fields (migration 156): the definitions under /v1/cadastros/campos-customizados, the values in the product
// form (data.custom_values) and the fields linked from the category form. Strict input before the database, the worker
// against the real SQL in PGlite and closed shapes after it. Synthetic data only.
const uuid = 'c0000000-0000-4000-8000-000000000001', other = 'c0000000-0000-4000-8000-000000000002';
const field = (overrides = {}) => ({ id: uuid, module: 'products', field_type: 'integer', name: 'Voltagem', hint: null, info: null, required: false, min_length: null, max_length: null,
  width: 'medium', grouped: false, active: true, version: 1, created_at: '2026-10-20T12:00:00+00:00', updated_at: '2026-10-20T12:00:00+00:00', options: [], category_ids: [], products: 0, ...overrides });

test('156 routes: campos customizados under /v1/cadastros, with their methods', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/campos-customizados'), { product: 'custom-fields', entity: 'products', id: null, remove: false });
  assert.deepEqual(catalogRoute(`/v1/cadastros/campos-customizados/${uuid.toUpperCase()}`), { product: 'custom-fields', entity: 'products', id: uuid, remove: false });
  assert.deepEqual(catalogRoute(`/v1/cadastros/campos-customizados/${uuid}/excluir`), { product: 'custom-fields', entity: 'products', id: uuid, remove: true });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/campos-customizados')), ['GET', 'POST']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/campos-customizados/${uuid}`)), ['PATCH']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/campos-customizados/${uuid}/excluir`)), ['POST']);
  assert.equal(catalogRoute('/v1/cadastros/campos-customizados/x'), null);
});

test('156 strict input: definitions, product values and category links are refused before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const create = data => ['/v1/cadastros/campos-customizados', 'POST', { command_id: randomUUID(), data }];
  const product = data => [`/v1/cadastros/products/${uuid}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data }];
  const bad = [
    ['/v1/cadastros/campos-customizados?modulo=contatos', 'GET'], ['/v1/cadastros/campos-customizados?x=1', 'GET'],
    create({ name: 'Sem tipo' }), create({ field_type: 'integer' }), create({ field_type: 'money', name: 'A' }), create({ field_type: 'integer', name: ' ' }),
    create({ field_type: 'integer', name: 'A'.repeat(61) }), create({ field_type: 'integer', name: 'A', hint: 'x'.repeat(101) }), create({ field_type: 'integer', name: 'A', info: 'x'.repeat(301) }),
    create({ field_type: 'integer', name: 'A', min_length: 0 }), create({ field_type: 'integer', name: 'A', min_length: 5, max_length: 2 }), create({ field_type: 'boolean', name: 'A', max_length: 2 }),
    create({ field_type: 'integer', name: 'A', min_length: '2' }), create({ field_type: 'integer', name: 'A', width: 'huge' }), create({ field_type: 'integer', name: 'A', required: 'sim' }),
    create({ field_type: 'list', name: 'A' }), create({ field_type: 'list', name: 'A', options: [] }), create({ field_type: 'text', name: 'A', options: [{ label: 'x' }] }),
    create({ field_type: 'list', name: 'A', options: [{ label: 'Azul' }, { label: 'azul' }] }), create({ field_type: 'list', name: 'A', options: [{ id: 'x', label: 'Azul' }] }),
    create({ field_type: 'integer', name: 'A', category_ids: [uuid, uuid.toUpperCase()] }), create({ field_type: 'integer', name: 'A', extra: 1 }),
    ['/v1/cadastros/campos-customizados', 'POST', { data: { field_type: 'integer', name: 'A' } }],
    [`/v1/cadastros/campos-customizados/${uuid}`, 'PATCH', { command_id: randomUUID(), data: { name: 'A' } }],
    [`/v1/cadastros/campos-customizados/${uuid}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: {} }],
    [`/v1/cadastros/campos-customizados/${uuid}/excluir`, 'POST', { command_id: randomUUID() }],
    [`/v1/cadastros/campos-customizados/${uuid}`, 'DELETE', { command_id: randomUUID(), expected_version: 1 }],
    product({ custom_values: [] }), product({ custom_values: { x: '1' } }), product({ custom_values: { [uuid.toUpperCase()]: '1' } }), product({ custom_values: { [uuid]: 1 } }),
    product({ custom_values: { [uuid]: 'a\u0001b' } }), product({ custom_values: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '1'])) }),
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'A', custom_field_ids: ['x'] } }],
    ['/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'A', custom_field_ids: [uuid, uuid] } }],
    ['/v1/cadastros/taxonomias/tags', 'POST', { command_id: randomUUID(), data: { name: 'A', custom_field_ids: [] } }],
  ];
  for (const [path, method, body] of bad) assert.ok([400, 405].includes((await handler(request(path, method, body), env)).status), `${method} ${path} ${JSON.stringify(body?.data ?? '')}`);
  assert.equal(calls.filter(call => !call.url.endsWith('/auth/v1/user')).length, 0);
});

test('156 closed answers: unexpected shapes from the database become 502', async () => {
  const cases = [
    [{ module: 'products', items: [field({ extra: 1 })], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
    [{ module: 'products', items: [field({ field_type: 'list', options: [] })], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
    [{ module: 'products', items: [field({ category_ids: [other] })], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
    [{ module: 'products', items: [field({ field_type: 'boolean', max_length: 3 })], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
    [{ module: 'products', items: [field(), field()], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
    [{ module: 'contacts', items: [], data_mode: 'erp_native' }, '/v1/cadastros/campos-customizados'],
  ];
  for (const [answer, path] of cases) { const { handler } = fakeHandler(answer); assert.equal((await handler(request(path), env)).status, 502, JSON.stringify(answer).slice(0, 120)); }
  const saveCases = [{ saved: false, reason: 'other', data_mode: 'erp_native' }, { saved: false, reason: 'option_in_use', data_mode: 'erp_native' }, { saved: true, field: field({ id: other }), data_mode: 'erp_native' }];
  for (const answer of saveCases) { const { handler } = fakeHandler(answer); assert.equal((await handler(request(`/v1/cadastros/campos-customizados/${uuid}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { active: false } }), env)).status, 502); }
  const { handler } = fakeHandler({ id: uuid, deleted: false, reason: 'in_use', products: 0, data_mode: 'erp_native' });
  assert.equal((await handler(request(`/v1/cadastros/campos-customizados/${uuid}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 1 }), env)).status, 502);
  const ok = fakeHandler({ module: 'products', items: [field({ field_type: 'list', options: [{ id: other, label: 'Azul' }] })], data_mode: 'erp_native' });
  const response = await ok.handler(request('/v1/cadastros/campos-customizados?modulo=produtos'), env);
  assert.equal(response.status, 200);
  assert.equal(rpcOf(ok.calls.at(-1)), 'erp_catalog_custom_fields');
  assert.deepEqual(JSON.parse(ok.calls.at(-1).body), { p_user_id: 'a0000000-0000-4000-8000-000000000001', p_module: 'products' });
});

test('156 worker and SQL agree: definitions, the category form, product values with replay and the refusals', async () => {
  const f = await produtosFixture(); const { call } = realHandler(f);
  try {
    const created = await call('/v1/cadastros/campos-customizados', 'POST', { command_id: randomUUID(), data: { field_type: 'list', name: ' Cor ', info: 'Cor principal\ndo produto', required: true, width: 'large', options: [{ label: 'Azul' }, { label: 'Verde' }] } });
    assert.equal(created.status, 200);
    const color = created.data.field;
    assert.deepEqual([color.name, color.info, color.width, color.options.map(option => option.label)], ['Cor', 'Cor principal\ndo produto', 'large', ['Azul', 'Verde']]);
    assert.deepEqual((await call('/v1/cadastros/campos-customizados', 'POST', { command_id: randomUUID(), data: { field_type: 'text', name: 'cor' } })).data, { saved: false, reason: 'duplicate_name', data_mode: 'erp_native', replayed: false });
    assert.equal((await call('/v1/cadastros/campos-customizados', 'POST', { command_id: randomUUID(), data: { field_type: 'text', name: 'Outro' } }, 'consulta')).status, 403);
    assert.equal((await call('/v1/cadastros/campos-customizados', 'GET', undefined, 'consulta')).data.items.length, 1);
    const category = (await call('/v1/cadastros/taxonomias/categorias-produtos', 'POST', { command_id: randomUUID(), data: { name: 'Móveis', custom_field_ids: [color.id.toUpperCase()] } })).data.item;
    const listed = (await call('/v1/cadastros/campos-customizados')).data.items[0];
    assert.deepEqual([listed.grouped, listed.category_ids, listed.version], [true, [category.id], 2]);
    const product = (await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Cadeira', kind: 'P', format: 'S', unit: 'UN', category_id: category.id, custom_values: { [color.id]: color.options[0].id } } })).data.record;
    assert.deepEqual(product.custom_values, { [color.id]: color.options[0].id });
    assert.equal((await call(`/v1/cadastros/products/${product.id}/completo`)).data.record.custom_values[color.id], color.options[0].id);
    assert.equal((await call(`/v1/cadastros/products/${product.id}/completo`, 'PATCH', { command_id: randomUUID(), expected_version: product.version, data: { custom_values: { [color.id]: null } } })).status, 400, 'a required value cannot be cleared');
    const command = randomUUID(), body = { command_id: command, expected_version: product.version, data: { custom_values: { [color.id]: color.options[1].id } } };
    const changed = await call(`/v1/cadastros/products/${product.id}/completo`, 'PATCH', body);
    assert.deepEqual([changed.status, changed.data.record.version, changed.data.record.custom_values[color.id]], [200, product.version + 1, color.options[1].id]);
    assert.equal((await call(`/v1/cadastros/products/${product.id}/completo`, 'PATCH', body)).data.replayed, true);
    const refused = await call(`/v1/cadastros/campos-customizados/${color.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 2, data: { options: [{ id: color.options[0].id, label: 'Azul' }] } });
    assert.deepEqual(refused.data, { saved: false, reason: 'option_in_use', products: 1, data_mode: 'erp_native', replayed: false });
    assert.equal((await call(`/v1/cadastros/campos-customizados/${color.id}/excluir`, 'POST', { command_id: randomUUID(), expected_version: 2 })).data.reason, 'in_use');
    assert.equal((await call(`/v1/cadastros/campos-customizados/${color.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 1, data: { active: false } })).status, 409);
    const off = await call(`/v1/cadastros/campos-customizados/${color.id}`, 'PATCH', { command_id: randomUUID(), expected_version: 2, data: { active: false } });
    assert.deepEqual([off.data.field.active, off.data.field.version], [false, 3]);
    const exported = await call('/v1/cadastros/products/exportacao?limit=10');
    assert.deepEqual(exported.data.items[0].custom_values, { [color.id]: color.options[1].id });
  } finally { await f.close(); }
});

test('156 deploy order: the new worker against the production SQL (before 156) answers the product form without custom values', async () => {
  const f = await productRegistryFixture({ lane: [] }); const { call } = realHandler(f);
  try {
    const created = await call('/v1/cadastros/products/completo', 'POST', { command_id: randomUUID(), data: { name: 'Antes de 156', kind: 'P', format: 'S', unit: 'UN' } });
    assert.deepEqual([created.status, created.data.record.custom_values], [200, null]);
    assert.notEqual((await call('/v1/cadastros/campos-customizados')).status, 200);
  } finally { await f.close(); }
});
