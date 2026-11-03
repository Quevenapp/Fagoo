import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';
import { financeParityDb } from './helpers/finance-parity-db.mjs';

// Synthetic only. 108 drawer commands and read through the real Worker: strict bodies, server actor, projected results.
const USER = 'a0000000-0000-4000-8000-000000000001', TITLE = 'b0000000-0000-4000-8000-000000000001', CONTACT = 'd0000000-0000-4000-8000-000000000001', ACCOUNT = 'e0000000-0000-4000-8000-000000000001', COMMAND = 'f0000000-0000-4000-8000-000000000001', REMITTANCE = 'c0000000-0000-4000-8000-000000000009';
const env = { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const record = { id: TITLE, created_at: '2026-10-19T12:00:00Z', group_id: TITLE, installment: 1, installments: 1, kind: 'receivable', contact_id: CONTACT, category_id: null, description: 'Conta sintética', source_reference: null, issued_on: '2026-10-01', due_on: '2026-10-20', amount_cents: '12345', settled_cents: '0', balance_cents: '12345', cancelled: false, version: 2, updated_at: '2026-10-19T12:00:00Z', contact_name: 'Cliente sintético', category_name: null, status: 'open', overdue: false, document_linked: false,
  competence_on: '2026-10-01', account_id: ACCOUNT, bank_number: '123', interest_month_bp: 100, penalty_bp: 200, original_due_on: '2026-10-15', deleted_at: null, deleted_by: USER, deleted_note: 'private' };
const detailBody = (extra = {}) => ({ entity: 'titles', record, origin: null, account: { id: ACCOUNT, name: 'Banco sintético', active: true, private: 'x' }, billing: { our_number: '12345678', document_number: 'D1', remittance_id: REMITTANCE, remittance_sequence: 3, remittance_state: 'ready', file_generated: true, private: 'x' }, imported: false, settled_before: false, original: { contact_name: 'Cliente sintético', due_on: '2026-10-15', amount_cents: '12345', description: 'Conta sintética', created_at: '2026-10-01T10:00:00Z' }, data_mode: 'erp_native', ...extra });
const request = (path, extra = {}) => new Request(`https://api.example.test${path}`, { headers: { Authorization: 'Bearer synthetic-user', ...(extra.body ? { 'Content-Type': 'application/json' } : {}) }, ...extra });
const post = (action, data, command = COMMAND) => request(`/v1/financeiro/actions/${action}`, { method: 'POST', body: JSON.stringify({ command_id: command, data }) });
function setup(value, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : value), { status: url.endsWith('/user') ? 200 : status }); } }) };
}
const create = extra => ({ kind: 'receivable', contact_id: CONTACT, description: 'Mensalidade', issued_on: '2026-10-01', competence_on: '2026-10-01', total_cents: '12345', installments: [{ amount_cents: '12345', due_on: '2026-10-20' }], ...extra });

test('108 drawer actions go to their own RPC with the server actor and the exact validated body', async () => {
  const created = setup({ entity: 'titles', group_id: TITLE, items: [record], action: 'title_create', replayed: false, data_mode: 'erp_native' });
  const data = create({ account_id: ACCOUNT, category_id: null, bank_number: '123', interest_month_bp: 100, penalty_bp: 0, source_reference: null });
  const response = await created.handler(post('title_create', data), env); assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(created.calls[1].url.endsWith('/rpc/erp_finance_title_execute'));
  assert.deepEqual(JSON.parse(created.calls[1].body), { p_user_id: USER, p_command_id: COMMAND, p_action: 'title_create', p_data: data });
  assert.deepEqual([value.items[0].competence_on, value.items[0].account_id, value.items[0].interest_month_bp, value.items[0].original_due_on, value.items[0].deleted_at], ['2026-10-01', ACCOUNT, 100, '2026-10-15', null]);
  assert.equal(value.items[0].deleted_by, undefined); assert.equal(value.items[0].deleted_note, undefined);
  const edited = setup({ entity: 'titles', record, note: null, action: 'title_edit', replayed: true, data_mode: 'erp_native' });
  const change = { id: TITLE, expected_version: 2, contact_id: CONTACT, issued_on: '2026-10-02', account_id: null, interest_month_bp: 0 };
  const edit = await edited.handler(post('title_edit', change), env); assert.equal(edit.status, 200); assert.equal((await edit.json()).replayed, true);
  assert.deepEqual(JSON.parse(edited.calls[1].body).p_data, change); assert.ok(edited.calls[1].url.endsWith('/rpc/erp_finance_title_execute'));
  const removed = setup({ entity: 'titles', record: { ...record, cancelled: true, status: 'cancelled', deleted_at: '2026-10-19T13:00:00Z' }, note: 'Duplicada', action: 'title_delete', replayed: false, data_mode: 'erp_native' });
  const remove = await removed.handler(post('title_delete', { id: TITLE, expected_version: 2, note: 'Duplicada' }), env);
  assert.equal(remove.status, 200); assert.equal((await remove.json()).record.deleted_at, '2026-10-19T13:00:00Z');
  // The 010 actions keep their RPC.
  const legacy = setup({ entity: 'titles', record, note: null, action: 'title_update', replayed: false, data_mode: 'erp_native' });
  await legacy.handler(post('title_update', { id: TITLE, expected_version: 2, due_on: '2026-10-21' }), env); assert.ok(legacy.calls[1].url.endsWith('/rpc/erp_finance_execute'));
});

test('108 drawer bodies are strict before any RPC', async () => {
  const { handler, calls } = setup({});
  const bad = [
    ['title_create', create({ interest_month_bp: 1.5 })], ['title_create', create({ interest_month_bp: '100' })], ['title_create', create({ penalty_bp: 10001 })], ['title_create', create({ penalty_bp: -1 })],
    ['title_create', create({ bank_number: 'x'.repeat(61) })], ['title_create', create({ competence_on: undefined })], ['title_create', create({ competence_on: '2026-02-30' })], ['title_create', create({ account_id: 'conta' })],
    ['title_create', create({ expected_version: 0 })], ['title_create', create({ seller_id: 'vendedor' })], ['title_create', create({ vendedor_id: CONTACT })], ['title_create', create({ description: 'x'.repeat(2001) })], ['title_create', create({ installments: [] })],
    ['title_edit', { id: TITLE, expected_version: 0 }], ['title_edit', { id: TITLE }], ['title_edit', { id: TITLE, expected_version: 1, contact_id: null }], ['title_edit', { id: TITLE, expected_version: 1, competence_on: null }],
    ['title_edit', { id: TITLE, expected_version: 1, interest_month_bp: null }], ['title_edit', { id: TITLE, expected_version: 1, deleted_at: '2026-01-01' }], ['title_edit', { id: TITLE, expected_version: 1, description: 'x'.repeat(2001) }],
    ['title_delete', { id: TITLE, expected_version: 1, note: 'x'.repeat(501) }], ['title_delete', { id: TITLE, expected_version: 1, reason: 'x' }], ['title_delete', { id: 'x', expected_version: 1 }],
  ];
  for (const [action, data] of bad) assert.equal((await handler(post(action, data), env)).status, 400, `${action} ${JSON.stringify(data)}`);
  assert.equal((await handler(post('title_create', create(), 'not-a-uuid'), env)).status, 400);
  assert.equal((await handler(request('/v1/financeiro/actions/title_create?x=1', { method: 'POST', body: JSON.stringify({ command_id: COMMAND, data: create() }) }), env)).status, 400);
  assert.ok(calls.every(call => call.url.endsWith('/auth/v1/user')));
});

test('108 drawer read projects the title, conta financeira, boleto and creation snapshot only', async () => {
  const { handler, calls } = setup(detailBody());
  const response = await handler(request(`/v1/financeiro/titles/${TITLE}/detalhe`), env); assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(calls[1].url.endsWith('/rpc/erp_finance_title_detail')); assert.deepEqual(JSON.parse(calls[1].body), { p_user_id: USER, p_id: TITLE });
  // SQL 210 adds the whole Histórico (null while it fits in the 240 characters of description).
  assert.deepEqual(Object.keys(value), ['entity', 'record', 'history', 'origin', 'account', 'billing', 'imported', 'settled_before', 'original', 'data_mode']); assert.equal(value.history, null);
  assert.deepEqual(value.account, { id: ACCOUNT, name: 'Banco sintético', active: true }); assert.equal(value.billing.private, undefined); assert.equal(value.billing.our_number, '12345678');
  assert.equal(value.record.deleted_by, undefined);
  for (const path of [`/v1/financeiro/titles/${TITLE}/detalhe?x=1`, `/v1/financeiro/titles/x/detalhe`]) assert.ok([400, 404].includes((await handler(request(path), env)).status), path);
  assert.equal((await handler(request(`/v1/financeiro/titles/${TITLE}/detalhe`, { method: 'POST', body: '{}' }), env)).status, 405);
  for (const value of [detailBody({ account: null }), detailBody({ account: { id: CONTACT, name: 'Outra', active: true } }), detailBody({ billing: { ...detailBody().billing, file_generated: false } }),
    detailBody({ billing: { ...detailBody().billing, remittance_state: 'sent' } }), detailBody({ imported: 'no' }), detailBody({ original: { due_on: '2026-10-15' } }), detailBody({ record: { ...record, id: CONTACT } }),
    detailBody({ record: { ...record, interest_month_bp: 1.5 } }), detailBody({ record: { ...record, competence_on: '01/10/2026' } }), detailBody({ origin: { document_id: TITLE, kind: 'sales_orders', number: '1' } })])
    assert.equal((await setup(value).handler(request(`/v1/financeiro/titles/${TITLE}/detalhe`), env)).status, 502);
  const denied = setup({ code: '42501', message: 'private' }, 400);
  assert.equal((await denied.handler(request(`/v1/financeiro/titles/${TITLE}/detalhe`), env)).status, 403);
});

let db; let users; let rpc; let alfa; let account;
before(async () => {
  const fixture = await financeParityDb({ through: '202610200108_finance_title_drawer.sql' });
  ({ db, users, rpc } = fixture); await fixture.addUsers();
  alfa = await fixture.contact({ name: 'Alfa Sintética' });
  account = (await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_save', p_data: { expected_version: 0, name: 'Banco sintético', kind: 'bank' } })).record;
});
after(async () => db?.close());

test('108 API contract runs against real SQL: create, edit, read and delete with replay', async () => {
  const api = async (path, init = {}, user = users.financeiro, port = rpc) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init)), { userId: user, rpc: port });
  const body = (data, command = randomUUID()) => ({ method: 'POST', body: JSON.stringify({ command_id: command, data }) });
  const command = randomUUID(), data = { kind: 'payable', contact_id: alfa.id, description: 'Aluguel sintético', issued_on: '2026-10-01', competence_on: '2026-09-01', account_id: account.id, bank_number: '34191.79001', interest_month_bp: 100, penalty_bp: 200, total_cents: '50000', installments: [{ amount_cents: '50000', due_on: '2026-10-10' }] };
  const created = await api('/v1/financeiro/actions/title_create', body(data, command));
  const title = created.items[0];
  assert.deepEqual([title.kind, title.competence_on, title.account_id, title.bank_number, title.interest_month_bp, title.penalty_bp, title.original_due_on], ['payable', '2026-09-01', account.id, '34191.79001', 100, 200, '2026-10-10']);
  assert.equal((await api('/v1/financeiro/actions/title_create', body(data, command))).replayed, true);
  const read = await api(`/v1/financeiro/titles/${title.id}/detalhe`, {}, users.consulta);
  assert.deepEqual(read.account, { id: account.id, name: 'Banco sintético', active: true }); assert.equal(read.billing, null); assert.equal(read.original.due_on, '2026-10-10');
  const edited = await api('/v1/financeiro/actions/title_edit', body({ id: title.id, expected_version: 1, due_on: '2026-10-12', account_id: null }));
  assert.equal(edited.record.due_on, '2026-10-12'); assert.equal(edited.record.original_due_on, '2026-10-10'); assert.equal(edited.record.account_id, null);
  await assert.rejects(() => api('/v1/financeiro/actions/title_edit', body({ id: title.id, expected_version: 1, due_on: '2026-10-13' })), error => error.status === 409 || error.code === '40001');
  await assert.rejects(() => api('/v1/financeiro/actions/title_delete', body({ id: title.id, expected_version: 2 }), users.consulta), error => error.code === '42501');
  const deleted = await api('/v1/financeiro/actions/title_delete', body({ id: title.id, expected_version: 2 }));
  assert.equal(deleted.record.status, 'cancelled'); assert.match(deleted.record.deleted_at, /^\d{4}-/);
  const tamper = mutate => async (name, args) => { const result = await rpc(name, args); mutate(result); return result; };
  await assert.rejects(() => api(`/v1/financeiro/titles/${title.id}/detalhe`, {}, users.consulta, tamper(v => { v.record.penalty_bp = '200'; })), error => error.status === 502);
});
