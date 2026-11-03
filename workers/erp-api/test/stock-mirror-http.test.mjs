import test from 'node:test';
import assert from 'node:assert/strict';
import { stockRoute, stockOperation, stockResponse } from '../src/stock.mjs';
import { createHandler, createScheduled } from '../src/index.mjs';

const USER = 'a0000000-0000-4000-8000-000000000001';
const PRODUCT = 'b0000000-0000-4000-8000-000000000001';
const env = { ERP_SCHEDULED_TASKS_ENABLED: 'true', ORIGIN_ENABLED: 'true', ORIGIN_TWO_WAY_ENABLED: 'true', SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const route = stockRoute('/v1/estoque/espelho');
const parse = async (query = '', method = 'GET') => {
  const url = new URL(`https://api.example.test/v1/estoque/espelho?${query}`);
  return stockOperation(new Request(url, { method }), route, url.searchParams);
};
const row = (patch = {}) => ({ id: 1, product_source_id: '123', product_id: PRODUCT, product_name: 'Produto sintético', product_code: 'S-1', unit: 'UN',
  warehouse_source_id: '99', warehouse_id: null, warehouse_name: 'Depósito sintético', physical: '2.500000', virtual: null, reserved: null,
  physical_state: 'value', virtual_state: 'absent', issues: ['MISSING_VIRTUAL'], source_version: 1, source_hash: 'a'.repeat(64), observed_at: '2026-10-22T11:00:00Z',
  source_deleted: false, origin: 'origin', read_only: true, private: 'must not leak', ...patch });
const page = (patch = {}) => ({ scope: 'stock_mirror', data_mode: 'origin_mirror', items: [row()], limit: 50, next_after: null, has_more: false,
  coverage: { positions: 1, products: 1, raw_products: 1, pending_products: 1, partial: true }, warehouses: [{ source_id: '99', id: null, name: 'Depósito sintético' }],
  native: { positions: 0, movements: 0 }, private: 'must not leak', ...patch });
const project = async (value, query = '') => stockResponse(value, route, await parse(query));

test('espelho: leitura paginada estrita sem aceitar identidade do usuário nem comando de escrita', async () => {
  assert.deepEqual((await parse(`q=parafuso&product_id=${PRODUCT}&warehouse_source_id=99&state=negative&limit=10&after=12`)).args,
    { p_query: 'parafuso', p_product_id: PRODUCT, p_warehouse_source_id: '99', p_state: 'negative', p_limit: 10, p_after: 12 });
  for (const query of ['p_user_id=' + USER, 'q=', 'limit=0', 'limit=101', 'limit=01', 'after=9007199254740992', 'after=0', 'state=all', 'q=a&q=b', 'product_id=12'])
    await assert.rejects(parse(query), error => error.status === 400, query);
  await assert.rejects(parse('', 'POST'), error => error.status === 405);
});

test('espelho: valores exatos, origem e ausência preservados, campos privados removidos', async () => {
  const value = await project(page());
  assert.equal(value.items[0].physical, '2.500000');
  assert.equal(value.items[0].virtual, null);
  assert.equal(value.items[0].origin, 'origin');
  assert.equal(value.coverage.partial, true);
  assert.equal(value.private, undefined); assert.equal(value.items[0].private, undefined);
  for (const patch of [{ physical: 2.5 }, { read_only: false }, { origin: 'brufap' }, { source_version: 9007199254740992 }, { observed_at: 'ontem' }])
    await assert.rejects(project(page({ items: [row(patch)] })), error => error.status === 502);
  await assert.rejects(project(page(), 'product_id=a0000000-0000-4000-8000-000000000099'), error => error.status === 502);
  await assert.rejects(project(page({ items: [row({ id: 2 }), row()] })), error => error.status === 502);
  await assert.rejects(project(page({ has_more: true, next_after: 1 })), error => error.status === 502);
  assert.equal((await project(page({ limit: 1, has_more: true, next_after: 1 }), 'limit=1')).next_after, 1);
});

test('espelho: handler autentica, envia ator real à RPC e aplica permissões do banco', async () => {
  const calls = [];
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : page()));
  } });
  const request = query => new Request(`https://api.example.test/v1/estoque/espelho?${query}`, { headers: { Authorization: 'Bearer synthetic-user' } });
  const response = await handler(request(''), env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).items[0].read_only, true);
  assert.ok(calls.at(-1).url.endsWith('/rest/v1/rpc/erp_stock_mirror_list'));
  assert.equal(JSON.parse(calls.at(-1).body).p_user_id, USER);
  const before = calls.length;
  assert.equal((await handler(request('p_user_id=' + USER), env)).status, 400);
  assert.equal(calls.length, before);
  const forbidden = createHandler({ fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : { code: '42501' }), { status: url.endsWith('/user') ? 200 : 403 }) });
  assert.equal((await forbidden(request(''), env)).status, 403);
});

test('espelho: cron a cada dois minutos executa um lote limitado por frente, sem Origin nem tarefas horárias', async () => {
  const calls = [];
  const scheduled = createScheduled({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify({ processed: 0 })); } });
  await scheduled({ cron: '*/2 * * * *' }, env);
  // Depois dos espelhos, a mão dupla (009-011) recebe do Origin e procura a rodada do botão; sem segredos do Origin não envia nada.
  assert.equal(calls.length, 5);
  assert.ok(calls[3].url.endsWith('/rest/v1/rpc/erp_sync_pull'));
  assert.ok(calls[4].url.endsWith('/rest/v1/rpc/erp_sync_run_get'));
  assert.ok(calls.every(call => !call.url.includes('provider.example')));
  assert.ok(calls[0].url.endsWith('/rest/v1/rpc/erp_stock_mirror_project'));
  assert.deepEqual(JSON.parse(calls[0].body), { p_limit: 100 });
  assert.ok(calls[1].url.endsWith('/rest/v1/rpc/erp_fiscal_mirror_project'));
  assert.deepEqual(JSON.parse(calls[1].body), { p_limit: 100 });
  assert.ok(calls[2].url.endsWith('/rest/v1/rpc/erp_document_mirror_project'));
  assert.deepEqual(JSON.parse(calls[2].body), { p_limit: 100 });
});

test('espelhos: falha em uma frente não impede o lote independente da outra', async () => {
  const calls = [];
  const scheduled = createScheduled({ fetchImpl: async url => {
    calls.push(url);
    if (url.endsWith('/erp_stock_mirror_project')) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ processed: 0, applied: 0, xml_processed: 0, pending: 0 }));
  } });
  await assert.rejects(scheduled({ cron: '*/2 * * * *' }, env));
  assert.equal(calls.length, 5);
  assert.ok(calls.some(url => url.endsWith('/erp_fiscal_mirror_project')));
});
