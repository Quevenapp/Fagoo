import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogRoute, catalogMethods } from '../src/catalog.mjs';
import { produtosDFixture } from './helpers/produtos-d-fixture.mjs';
import { env, fakeHandler, realHandler, request, rpcOf, upstream } from './helpers/produtos-c-http.mjs';

// HTTP of the price lists, wave D (migration 192): /:id/importar (planilha modelo) and /aplicaveis (lists valid for a document).
// Strict input before the database, closed answers after it, and the worker against the real SQL. Synthetic data only.
const uuid = 'e0000000-0000-4000-8000-000000000001', other = 'e0000000-0000-4000-8000-000000000002';
const header = (overrides = {}) => ({ id: uuid, name: 'Atacado', category: 'other', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null,
  start_time: null, end_time: null, version: 2, created_at: '2026-10-20T12:00:00+00:00', updated_at: '2026-10-20T12:00:00+00:00', rule: 'Customizada', products: 1, ...overrides });
const detail = (overrides = {}) => header({ contacts: [], sellers: [], payment_methods: [], regions: [], ...overrides });
const importAnswer = (overrides = {}) => ({ saved: true, list: detail(), added: 1, updated: 0, unchanged: 0, duplicates: 0, not_found: [], not_found_total: 0, ambiguous: [], ambiguous_total: 0, replayed: false, data_mode: 'erp_native', ...overrides });

test('192 routes and methods', () => {
  assert.deepEqual(catalogRoute('/v1/cadastros/listas-precos/aplicaveis'), { product: 'price-lists', scope: 'applicable', id: null, entity: 'products' });
  assert.deepEqual(catalogRoute(`/v1/cadastros/listas-precos/${uuid.toUpperCase()}/importar`), { product: 'price-lists', scope: 'importar', id: uuid, entity: 'products' });
  assert.deepEqual(catalogMethods(catalogRoute('/v1/cadastros/listas-precos/aplicaveis')), ['GET']);
  assert.deepEqual(catalogMethods(catalogRoute(`/v1/cadastros/listas-precos/${uuid}/importar`)), ['POST']);
});

test('192 strict input before the database', async () => {
  const { handler, calls } = fakeHandler({});
  const sheet = rows => [`/v1/cadastros/listas-precos/${uuid}/importar`, 'POST', { command_id: randomUUID(), expected_version: 1, rows }];
  const bad = [sheet([]), sheet([{}]), sheet([{ code: ' ' }]), sheet([{ code: 'x'.repeat(101) }]), sheet([{ code: 'A', price: '1,5' }]), sheet([{ code: 'A', price: 1 }]), sheet([{ code: 'A', other: 1 }]),
    sheet(Array.from({ length: 501 }, () => ({ code: 'A' }))), sheet([{ code: 'A\u0001' }]),
    [`/v1/cadastros/listas-precos/${uuid}/importar`, 'POST', { command_id: randomUUID(), rows: [{ code: 'A' }] }],
    [`/v1/cadastros/listas-precos/${uuid}/importar`, 'GET'],
    ['/v1/cadastros/listas-precos/aplicaveis?contato=x'], ['/v1/cadastros/listas-precos/aplicaveis?uf=sp'], ['/v1/cadastros/listas-precos/aplicaveis?outro=1'],
    [`/v1/cadastros/listas-precos/aplicaveis?contato=${uuid}&contato=${other}`], ['/v1/cadastros/listas-precos/aplicaveis', 'POST', {}]];
  for (const [path, method = 'GET', body] of bad) assert.ok([400, 405].includes((await handler(request(path, method, body), env)).status), `${method} ${path} ${JSON.stringify(body?.rows ?? '').slice(0, 60)}`);
  assert.equal(upstream(calls).length, 0);
  const ok = fakeHandler(importAnswer({ added: 1, unchanged: 1 }));
  const response = await ok.handler(request(`/v1/cadastros/listas-precos/${uuid}/importar`, 'POST', { command_id: randomUUID(), expected_version: 1, rows: [{ code: ' PAR-1 ', price: ' 7.5 ' }, { code: 'POR-1', price: '' }] }), env);
  assert.equal(response.status, 200);
  assert.equal(rpcOf(upstream(ok.calls)[0]), 'erp_pricing_list_import');
  assert.deepEqual(JSON.parse(upstream(ok.calls)[0].body).p_rows, [{ code: 'PAR-1', price: '7.5' }, { code: 'POR-1' }]);
});

test('192 closed answers become 502', async () => {
  const path = `/v1/cadastros/listas-precos/${uuid}/importar`, body = () => ({ command_id: randomUUID(), expected_version: 1, rows: [{ code: 'A' }] });
  for (const answer of [importAnswer({ added: 2 }), importAnswer({ not_found: ['A'], not_found_total: 0, added: 1 }), importAnswer({ list: detail({ id: other }) }), importAnswer({ saved: false }), { ...importAnswer(), extra: 1, list: header() }]) {
    const { handler } = fakeHandler(answer);
    assert.equal((await handler(request(path, 'POST', body()), env)).status, 502, JSON.stringify(answer).slice(0, 100));
  }
  const applicable = items => ({ data_mode: 'erp_native', contact_id: null, seller_id: null, payment_method_id: null, state: null, items });
  for (const answer of [applicable([header({ contacts: [] })]), applicable([header(), header()]), { ...applicable([]), state: 'XX' }, { ...applicable([]), contact_id: uuid }]) {
    const { handler } = fakeHandler(answer);
    assert.equal((await handler(request('/v1/cadastros/listas-precos/aplicaveis'), env)).status, 502, JSON.stringify(answer).slice(0, 100));
  }
  const ok = fakeHandler({ ...applicable([header()]), state: 'SP' });
  const response = await ok.handler(request('/v1/cadastros/listas-precos/aplicaveis?uf=SP'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(upstream(ok.calls)[0].body), { p_user_id: 'a0000000-0000-4000-8000-000000000001', p_contact_id: null, p_seller_id: null, p_payment_method_id: null, p_state: 'SP' });
});

test('192 worker and SQL agree: the planilha modelo and the applicable lists', async () => {
  const f = await produtosDFixture(); const { call } = realHandler(f);
  try {
    await f.product({ name: 'Parafuso', code: 'PAR-1', price: '10' });
    const customer = await f.contact({ name: 'Cliente', state: 'MG' });
    const list = (await call('/v1/cadastros/listas-precos', 'POST', { command_id: randomUUID(), data: { name: 'Mineira', category: 'region', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: ['MG'] } })).data.list;
    const command = randomUUID(), body = { command_id: command, expected_version: list.version, rows: [{ code: 'par-1', price: '9.9' }, { code: 'NADA' }] };
    const imported = await call(`/v1/cadastros/listas-precos/${list.id}/importar`, 'POST', body);
    assert.deepEqual([imported.status, imported.data.added, imported.data.not_found, imported.data.list.products, imported.data.replayed], [200, 1, ['NADA'], 1, false]);
    assert.equal((await call(`/v1/cadastros/listas-precos/${list.id}/importar`, 'POST', body)).data.replayed, true);
    assert.equal((await call(`/v1/cadastros/listas-precos/${list.id}/importar`, 'POST', { ...body, command_id: randomUUID() })).status, 409, 'expected version');
    assert.equal((await call(`/v1/cadastros/listas-precos/${list.id}/importar`, 'POST', { ...body, command_id: randomUUID(), expected_version: imported.data.list.version }, 'vendas')).status, 403);
    const applicable = await call(`/v1/cadastros/listas-precos/aplicaveis?contato=${customer.id}`, 'GET', undefined, 'vendas');
    assert.deepEqual([applicable.status, applicable.data.state, applicable.data.items.map(item => item.name)], [200, 'MG', ['Mineira']]);
    assert.deepEqual((await call('/v1/cadastros/listas-precos/aplicaveis?uf=SP', 'GET', undefined, 'vendas')).data.items, []);
  } finally { await f.close(); }
});
