import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.mjs';

// Synthetic only. Page route (SQL 109) through the real Worker handler: authenticated actor, strict query, projected response.
const USER = 'a0000000-0000-4000-8000-000000000001', TITLE = 'b0000000-0000-4000-8000-000000000001', DOC = 'c0000000-0000-4000-8000-000000000001', CONTACT = 'd0000000-0000-4000-8000-000000000001', ACCOUNT = 'e0000000-0000-4000-8000-000000000001', REMITTANCE = 'f0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path, extra = {}) => new Request(`https://api.example.test${path}`, { headers: { Authorization: 'Bearer synthetic-user' }, ...extra });
const record = { id: TITLE, created_at: '2026-10-19T12:00:00Z', group_id: TITLE, installment: 1, installments: 1, kind: 'receivable', contact_id: CONTACT, category_id: null, description: 'Conta sintética', source_reference: null, issued_on: '2026-10-01', due_on: '2026-10-20', amount_cents: '12345', settled_cents: '0', balance_cents: '12345', cancelled: false, version: 2, updated_at: '2026-10-19T12:00:00Z', contact_name: 'Cliente sintético', category_name: null, status: 'open', overdue: false, document_linked: true,
  competence_on: '2026-10-01', account_id: ACCOUNT, bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: '2026-10-20', deleted_at: null };
const payments = { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false };
const row = (extra = {}) => ({ ...record, actor: 'private', deleted_by: 'private', origin: { document_id: DOC, kind: 'sales_orders', number: '42', snapshot: 'private' }, account_name: 'Banco sintético', remittance: { id: REMITTANCE, sequence: 3, state: 'reserved', our_number: null, private: 'x' }, payments: { ...payments, private: 'x' }, imported: false, ...extra });
const body = (extra = {}) => ({ entity: 'titles', kind: 'receivable', option: 'open', page: 1, limit: 100, order: 'due_asc', total: 1, totals: { count: 1, amount_cents: '12345', balance_cents: '12345', fee_cents: '0' }, data_mode: 'erp_native', private: 'never', items: [row()], ...extra });
function setup(value, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : value), { status: url.endsWith('/user') ? 200 : status }); } }) };
}

test('109 page route authenticates, sends the server-side actor and strict filters, and projects only the contract', async () => {
  const { handler, calls } = setup(body());
  assert.equal((await handler(request('/v1/financeiro/titles?page=1&kind=receivable', { headers: {} }), env)).status, 401); assert.equal(calls.length, 0);
  const response = await handler(request(`/v1/financeiro/titles?page=1&kind=receivable&option=open&q=${encodeURIComponent('12.345.678/0001-90')}&account=${ACCOUNT.toUpperCase()}&category=none,${DOC}&remittance=yes&amount_cents=12345&document=NF&from=2026-10-01&to=2026-10-31`), env);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(Object.keys(value), ['entity', 'kind', 'option', 'items', 'page', 'limit', 'order', 'total', 'totals', 'data_mode']);
  assert.deepEqual(value.items[0].origin, { document_id: DOC, kind: 'sales_orders', number: '42' }); assert.equal(value.items[0].actor, undefined); assert.equal(value.items[0].deleted_by, undefined);
  assert.deepEqual(value.items[0].remittance, { id: REMITTANCE, sequence: 3, state: 'reserved', our_number: null }); assert.deepEqual(value.items[0].payments, payments); assert.equal(value.items[0].imported, false);
  assert.ok(calls[1].url.endsWith('/rpc/erp_finance_title_page_v2'));
  assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: USER, p_kind: 'receivable', p_page: 1, p_limit: 100, p_order: 'due_asc', p_query: '12.345.678/0001-90', p_option: 'open', p_statuses: null, p_date_field: 'due', p_from: '2026-10-01', p_to: '2026-10-31', p_account: ACCOUNT, p_categories: ['none', DOC], p_remittance: 'yes', p_amount_cents: '12345', p_document: 'NF' });
  assert.equal(calls[1].headers.Authorization, 'Bearer synthetic-service');
  const emitted = setup(body({ option: 'issued', items: [row({ status: 'open' })] }));
  await emitted.handler(request('/v1/financeiro/titles?page=1&kind=receivable&status=paid,open&date=competence'), env);
  assert.deepEqual(JSON.parse(emitted.calls[1].body).p_option, 'issued', 'without Opção the page is Emitidas'); assert.deepEqual(JSON.parse(emitted.calls[1].body).p_statuses, ['paid', 'open']);
  assert.equal(JSON.parse(emitted.calls[1].body).p_date_field, 'competence');
  const settled = setup(body({ option: 'settled', items: [row({ settled_cents: '12345', balance_cents: '0', status: 'paid', payments: { ...payments, settled_on: '2026-10-21' } })] }));
  assert.equal((await settled.handler(request('/v1/financeiro/titles?page=1&kind=receivable&option=settled'), env)).status, 200);
  assert.equal(JSON.parse(settled.calls[1].body).p_date_field, 'settled', 'Recebidas filters by the date of the baixa');
});

test('109 page route rejects out-of-contract queries before any RPC and maps database errors', async () => {
  const { handler, calls } = setup(body());
  for (const query of ['page=1', 'page=1&kind=receivable&p_user_id=' + USER, 'page=1&kind=receivable&status=open,open', 'page=0&kind=receivable', 'page=1&kind=receivable&limit=500', 'page=1&kind=receivable&order=valor',
    'page=1&kind=receivable&date=competencia', 'page=1&kind=receivable&category=x', 'page=1&kind=receivable&min_cents=1', 'page=1&kind=receivable&after=' + TITLE,
    'page=1&page=2&kind=receivable', 'page=abc&kind=receivable', 'page=100001&kind=receivable', 'page=1&kind=both', 'page=1&kind=receivable&status=', 'page=1&kind=receivable&status=open,',
    'page=1&kind=receivable&status=overdue', 'page=1&kind=receivable&option=open&status=open', 'page=1&kind=receivable&option=all', 'page=1&kind=receivable&option=open&date=issued', 'page=1&kind=receivable&option=settled&date=due',
    'page=1&kind=receivable&account=x', 'page=1&kind=receivable&remittance=yes', 'page=1&kind=receivable&option=open&remittance=sim', 'page=1&kind=receivable&amount_cents=0', 'page=1&kind=receivable&amount_cents=1.5',
    `page=1&kind=receivable&category=${'none,'.repeat(2)}none`, `page=1&kind=receivable&category=${Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`).join(',')}`,
    'page=1&kind=receivable&from=2026-02-01&to=2026-01-01', 'page=1&kind=receivable&from=2026-02-30', `page=1&kind=receivable&document=${'x'.repeat(61)}`, 'page=1&kind=receivable&q=a%01b', `page=1&kind=receivable&q=${'x'.repeat(121)}`, 'page=1&kind=receivable&parent_id=' + TITLE])
    assert.equal((await handler(request(`/v1/financeiro/titles?${query}`), env)).status, 400, query);
  for (const path of ['/v1/financeiro/accounts?page=1', '/v1/financeiro/categories?page=1&kind=receivable', `/v1/financeiro/titles/${TITLE}?page=1`])
    assert.equal((await handler(request(path), env)).status, 400, path);
  assert.ok(calls.every(call => call.url.endsWith('/auth/v1/user')));
  for (const [code, expected] of [['42501', 403], ['22023', 400]]) {
    const denied = setup({ code, message: 'private database error' }, 400), response = await denied.handler(request('/v1/financeiro/titles?page=1&kind=payable'), env);
    assert.equal(response.status, expected); assert.doesNotMatch(await response.text(), /private database/);
  }
  const path = `/v1/financeiro/titles?page=1&kind=receivable&option=open&account=${ACCOUNT}&remittance=yes`;
  for (const value of [body({ total: 2 }), body({ page: 2 }), body({ option: 'issued' }), body({ totals: { count: 1, amount_cents: '12345', balance_cents: '12345' } }), body({ items: [row({ origin: null })] }),
    body({ items: [row({ kind: 'payable', origin: { document_id: DOC, kind: 'purchase_orders', number: '42' } })] }), body({ items: [row({ deleted_at: '2026-10-20T10:00:00Z' })] }),
    body({ items: [row({ settled_cents: '12345', balance_cents: '0', status: 'paid' })] }), body({ items: [row({ account_id: null, account_name: null })] }), body({ items: [row({ remittance: null })] }),
    body({ items: [row({ account_name: null })] }), body({ items: [row({ payments: { ...payments, fee_cents: 1 } })] }), body({ items: [row({ remittance: { id: REMITTANCE, sequence: 3, state: 'sent', our_number: null } })] }),
    body({ items: [row({ imported: undefined })] }), body({ items: [row({ imported: 'false' })] })])
    assert.equal((await setup(value).handler(request(path), env)).status, 502, JSON.stringify(value.items?.[0]?.status));
});
