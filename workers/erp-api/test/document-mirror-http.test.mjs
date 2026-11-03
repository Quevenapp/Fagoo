import test from 'node:test';
import assert from 'node:assert/strict';
import { documentsRoute, documentsOperation, documentsResponse } from '../src/documents.mjs';
import { createHandler } from '../src/index.mjs';

const ID = 'b0000000-0000-4000-8000-000000000001', ITEM = 'b0000000-0000-4000-8000-000000000002', USER = 'a0000000-0000-4000-8000-000000000001';
const kinds = ['sales_orders', 'sales_proposals', 'purchase_orders', 'service_orders'];
const meta = kind => ({ entity: kind, source_id: '9001', source_version: '2', source_hash: 'a'.repeat(64), mapper_version: 1,
  source_number: '45', source_status: '6', source_status_label: 'Situação na origem', observed_at: '2026-10-22T12:00:00Z', source_updated_at: null,
  source_deleted: false, state: 'synced', partial: true, issues: ['STATUS_UNMAPPED'],
  reconciliation: { source_total: '123.4567', source_products_total: '120', calculated_total: null, difference: null, state: 'unknown' },
  effects: { stock: 'unobservable', finance_count: null, invoice_source_id: null }, private: 'never exposed' });
const row = (kind, patch = {}) => ({ id: ID, kind, version: 1, number: '45', status: 'source_unknown', origin: 'origin', authority: 'origin', readonly: true,
  mirror: meta(kind), created_at: '2026-10-22T12:00:00Z', updated_at: '2026-10-22T12:00:00Z', date: null, total: '123.4567', contact_id: null, contact_name: null,
  private: 'never exposed', ...patch });
const detail = (kind, patch = {}) => row(kind, { contact_snapshot: null, items: [{ id: ITEM, position: 1, source_id: null, product_id: null, description: 'Item observado', code: null,
  unit: null, quantity: '3', unit_price: '4.123456789', discount_percent: null, total: null, private: 'never exposed' }], ...patch });
const operation = async (kind, suffix = '?page=1&limit=100') => {
  const url = new URL(`https://api.example.test/v1/documentos/${kind}${suffix}`), route = documentsRoute(url.pathname);
  return { route, op: await documentsOperation(new Request(url), route, url.searchParams) };
};
const envelope = (kind, items) => ({ kind, data_mode: 'erp_native', operational_effects: false, items, limit: 100, page: 1, order: 'date_desc', has_more: false,
  next_cursor: null, total_count: items.length, total_amount: null, origin_totals: { brufap: { count: 0, known_total_count: 0, total: null }, origin: { count: items.length, known_total_count: 0, total: null } } });

test('quatro tipos: contrato espelhado preserva valores exatos e ausentes sem cálculo nativo', async () => {
  for (const kind of kinds) {
    const { route, op } = await operation(kind, `/${ID}`);
    const result = documentsResponse({ kind, data_mode: 'erp_native', operational_effects: false, document: detail(kind) }, route, op).document;
    assert.equal(result.total, '123.4567'); assert.equal(result.items[0].unit_price, '4.123456789');
    assert.equal(result.items[0].total, null); assert.equal(result.date, null); assert.equal(result.contact_id, null);
    assert.equal(result.private, undefined); assert.equal(result.mirror.private, undefined); assert.equal(result.items[0].private, undefined);
    assert.equal(result.readonly, true); assert.equal(result.mirror.effects.finance_count, null);
  }
});

test('listagem valida origem e totais separados; não aceita filtro de identidade do usuário', async () => {
  const kind = 'sales_orders';
  for (const origin of ['all', 'brufap', 'origin']) assert.equal((await operation(kind, `?origin=${origin}`)).op.args.p_origin, origin);
  assert.equal(Object.hasOwn((await operation(kind)).op.args, 'p_origin'), false);
  for (const suffix of ['?origin=other', '?origin=origin&origin=brufap', '?p_user_id=' + USER]) await assert.rejects(operation(kind, suffix), { code: 'ERP_INVALID_QUERY' });
  const { route, op } = await operation(kind);
  const result = documentsResponse(envelope(kind, [row(kind)]), route, op);
  assert.equal(result.items[0].origin, 'origin'); assert.equal(result.origin_totals.origin.total, null);
  const mixed = envelope(kind, [row(kind)]); mixed.origin_totals.brufap.count = 1;
  assert.throws(() => documentsResponse(mixed, route, op), { code: 'ERP_UPSTREAM_INVALID_RESPONSE' });
  const filtered = await operation(kind, '?origin=brufap&page=1&limit=100');
  assert.throws(() => documentsResponse(envelope(kind, [row(kind)]), filtered.route, filtered.op), { code: 'ERP_UPSTREAM_INVALID_RESPONSE' });
});

test('espelho malformado não relaxa contrato nativo nem pode afirmar efeitos nativos', async () => {
  const kind = 'sales_orders', { route, op } = await operation(kind);
  for (const patch of [{ readonly: false }, { authority: 'brufap' }, { total: 123.4 }, { date: '2026-02-31' }, { finance_active: true }, { mirror: { ...meta(kind), source_version: 2 } }])
    assert.throws(() => documentsResponse(envelope(kind, [row(kind, patch)]), route, op), { code: 'ERP_UPSTREAM_INVALID_RESPONSE' });
  assert.throws(() => documentsResponse(envelope(kind, [row(kind, { origin: 'brufap', authority: 'brufap', readonly: false })]), route, op), { code: 'ERP_UPSTREAM_INVALID_RESPONSE' });
});

test('handler lê espelho pela RPC nativa com identidade autenticada e sem cache', async () => {
  const calls = [], kind = 'service_orders';
  const handler = createHandler({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : { kind, data_mode: 'erp_native', operational_effects: false, document: detail(kind) }));
  } });
  const response = await handler(new Request(`https://api.example.test/v1/documentos/${kind}/${ID}`, { headers: { Authorization: 'Bearer synthetic' } }),
    { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).document.mirror.source_id, '9001');
  assert.ok(calls.at(-1).url.endsWith('/rpc/erp_document_get')); assert.equal(JSON.parse(calls.at(-1).body).p_user_id, USER);
});

test('comando recusado pelo banco informa que o documento pertence ao Origin sem expor SQL', async () => {
  const handler = createHandler({ fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } :
    { code: '42501', message: 'erp_document_mirror_readonly', details: 'private database details' }), { status: url.endsWith('/user') ? 200 : 403 }) });
  const response = await handler(new Request(`https://api.example.test/v1/documentos/sales_orders/${ID}/status`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', Origin: 'https://erp.example.test' },
    body: JSON.stringify({ command_id: ITEM, expected_version: 1, status: 'open' }) }),
  { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' });
  assert.equal(response.status, 409); const value = await response.json();
  assert.equal(value.error.code, 'MODULE_OWNED_BY_ORIGIN'); assert.deepEqual(Object.keys(value.error).sort(), ['code', 'request_id']);
});
