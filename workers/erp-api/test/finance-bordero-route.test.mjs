import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../src/index.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';
import { financeParityDb } from './helpers/finance-parity-db.mjs';

// Synthetic only. 110 borderôs through the real Worker: strict bodies and queries, server actor, projected results.
const USER = 'a0000000-0000-4000-8000-000000000001', TITLE = 'b0000000-0000-4000-8000-000000000001', TITLE2 = 'b0000000-0000-4000-8000-000000000002', ACCOUNT = 'e0000000-0000-4000-8000-000000000001', COMMAND = 'f0000000-0000-4000-8000-000000000001', BORDERO = 'c0000000-0000-4000-8000-000000000001';
const env = { SUPABASE_URL: 'https://exampleproject.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', ALLOWED_ORIGINS: 'https://erp.example.test' };
const request = (path, extra = {}) => new Request(`https://api.example.test${path}`, { headers: { Authorization: 'Bearer synthetic-user', ...(extra.body ? { 'Content-Type': 'application/json' } : {}) }, ...extra });
const post = (action, data) => request(`/v1/financeiro/actions/${action}`, { method: 'POST', body: JSON.stringify({ command_id: COMMAND, data }) });
const item = (extra = {}) => ({ id: TITLE, expected_version: 2, account_id: ACCOUNT, category_id: null, posted_on: '2026-10-19', principal_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', ...extra });
const totals = { paid_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', net_cash_cents: '1000' };
const summary = (extra = {}) => ({ id: BORDERO, kind: 'receivable', posted_on: '2026-10-19', account_id: ACCOUNT, account_name: 'Banco', category_id: null, category_name: null, note: null, grouped: false, version: 1, created_at: '2026-10-19T12:00:00Z', deleted_at: null, active: true, contact_name: 'Cliente', contacts: 1, items: 1, totals, private: 'x', ...extra });
function setup(value, status = 200) {
  const calls = [];
  return { calls, handler: createHandler({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify(url.endsWith('/user') ? { id: USER } : value), { status: url.endsWith('/user') ? 200 : status }); } }) };
}

test('110 batch bodies and borderô queries are strict before any RPC', async () => {
  const { handler, calls } = setup({});
  const batch = extra => ({ kind: 'receivable', grouped: false, items: [item()], ...extra });
  for (const data of [batch({ items: [] }), batch({ items: Array.from({ length: 101 }, (_, i) => item({ id: `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}` })) }), batch({ items: [item(), item()] }), batch({ grouped: true }),
    batch({ grouped: true, account_id: ACCOUNT, items: [item(), item({ id: TITLE2, posted_on: '2026-10-18' })] }), batch({ grouped: true, account_id: ACCOUNT, items: [item(), item({ id: TITLE2, account_id: TITLE })] }),
    batch({ account_id: ACCOUNT }), batch({ items: [item({ principal_cents: '0' })] }), batch({ items: [item({ fee_cents: 1 })] }), batch({ items: [item({ posted_on: '2026-02-30' })] }), batch({ items: [item({ expected_version: 0 })] }),
    batch({ items: [item({ extra: 1 })] }), batch({ kind: 'both' }), batch({ note: 'x'.repeat(2001) }), batch({ grouped: 'no' }), { kind: 'receivable', items: [item()] }])
    assert.equal((await handler(post('settle_batch', data), env)).status, 400, JSON.stringify(data).slice(0, 100));
  for (const data of [{ id: BORDERO, expected_version: 1, posted_on: '2026-10-19' }, { id: BORDERO, expected_version: 1, posted_on: '2026-10-19', note: ' ' }, { id: 'x', expected_version: 1, posted_on: '2026-10-19', note: 'Motivo' }, { id: BORDERO, expected_version: 1, posted_on: '2026-10-19', note: 'Motivo', extra: 1 }])
    assert.equal((await handler(post('bordero_delete', data), env)).status, 400);
  for (const query of ['', 'page=1', 'page=1&kind=both', 'page=0&kind=receivable', 'page=1&kind=receivable&limit=101', 'page=1&kind=receivable&account=x', 'page=1&kind=receivable&category=none,none', 'page=1&kind=receivable&amount_cents=0',
    'page=1&kind=receivable&from=2026-02-01&to=2026-01-01', 'page=1&kind=receivable&q=a%01', 'page=1&kind=receivable&status=open', 'page=1&page=2&kind=receivable', 'page=1&kind=receivable&title=x'])
    assert.equal((await handler(request(`/v1/financeiro/borderos?${query}`), env)).status, 400, query);
  assert.equal((await handler(request(`/v1/financeiro/borderos/${BORDERO}?x=1`), env)).status, 400);
  assert.equal((await handler(request('/v1/financeiro/borderos/x'), env)).status, 404);
  assert.ok(calls.every(call => call.url.endsWith('/auth/v1/user')));
});

test('110 batch and page routes send the server actor and project only the contract', async () => {
  const title = { id: TITLE, created_at: '2026-10-19T12:00:00Z', group_id: TITLE, installment: 1, installments: 1, kind: 'receivable', contact_id: TITLE2, category_id: null, description: 'Conta', source_reference: null, issued_on: '2026-10-01', due_on: '2026-10-20', amount_cents: '1000', settled_cents: '1000', balance_cents: '0', cancelled: false, version: 3, updated_at: '2026-10-19T12:00:00Z', contact_name: 'Cliente', category_name: null, status: 'paid', overdue: false, document_linked: false };
  const settlement = { id: COMMAND, created_at: '2026-10-19T12:00:00Z', title_id: TITLE, account_id: ACCOUNT, kind: 'payment', reverses_id: null, posted_on: '2026-10-19', principal_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', net_cash_cents: '1000', note: null, reversed: false };
  const ok = setup({ entity: 'borderos', action: 'settle_batch', replayed: false, data_mode: 'erp_native', items: [{ title, settlement, bordero_id: BORDERO }], borderos: [summary()] });
  const data = { kind: 'receivable', grouped: false, note: 'Lote', items: [item()] };
  const response = await ok.handler(post('settle_batch', data), env); assert.equal(response.status, 200);
  const value = await response.json(); assert.ok(ok.calls[1].url.endsWith('/rpc/erp_finance_bordero_execute'));
  assert.deepEqual(JSON.parse(ok.calls[1].body), { p_user_id: USER, p_command_id: COMMAND, p_action: 'settle_batch', p_data: data });
  assert.equal(value.borderos[0].private, undefined); assert.equal(value.items[0].bordero_id, BORDERO);
  for (const bad of [{ borderos: [] }, { items: [{ title, settlement, bordero_id: TITLE2 }] }, { items: [{ title, settlement: { ...settlement, title_id: TITLE2 }, bordero_id: BORDERO }] }, { items: [{ title, settlement: { ...settlement, kind: 'reversal' }, bordero_id: BORDERO }] }, { borderos: [summary({ contacts: 2 })] }, { action: 'bordero_delete' }])
    assert.equal((await setup({ entity: 'borderos', action: 'settle_batch', replayed: false, data_mode: 'erp_native', items: [{ title, settlement, bordero_id: BORDERO }], borderos: [summary()], ...bad }).handler(post('settle_batch', data), env)).status, 502);
  const listed = setup({ entity: 'borderos', kind: 'payable', page: 1, limit: 100, total: 1, totals: { count: 1, paid_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }, items: [summary({ kind: 'payable' })], data_mode: 'erp_native' });
  const list = await listed.handler(request(`/v1/financeiro/borderos?page=1&kind=payable&q=x&account=${ACCOUNT}&category=none&from=2026-10-01&to=2026-10-31&amount_cents=1000&title=${TITLE}`), env);
  assert.equal(list.status, 200); assert.deepEqual(JSON.parse(listed.calls[1].body), { p_user_id: USER, p_kind: 'payable', p_page: 1, p_limit: 100, p_query: 'x', p_account: ACCOUNT, p_categories: ['none'], p_from: '2026-10-01', p_to: '2026-10-31', p_amount_cents: '1000', p_title: TITLE });
  assert.equal((await list.json()).items[0].private, undefined);
  for (const bad of [{ total: 2 }, { items: [summary({ kind: 'receivable' })] }, { items: [summary({ active: false })] }, { totals: { count: 1 } }])
    assert.equal((await setup({ entity: 'borderos', kind: 'payable', page: 1, limit: 100, total: 1, totals: { count: 1, paid_cents: '1000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }, items: [summary({ kind: 'payable' })], data_mode: 'erp_native', ...bad }).handler(request('/v1/financeiro/borderos?page=1&kind=payable'), env)).status, 502);
  // SQL 249: a Histórico of up to 2,000 characters goes as typed; the settlement brings it whole in history, note keeps its beginning.
  const long = `${'h'.repeat(500)} fim`, full = setup({ entity: 'borderos', action: 'settle_batch', replayed: false, data_mode: 'erp_native', items: [{ title, settlement: { ...settlement, note: 'h'.repeat(500), history: long }, bordero_id: BORDERO }], borderos: [summary({ note: 'h'.repeat(500) })] });
  const fullResponse = await full.handler(post('settle_batch', { ...data, note: `${long}${'.'.repeat(2000 - long.length)}` }), env); assert.equal(fullResponse.status, 200);
  assert.equal((await fullResponse.json()).items[0].settlement.history, long);
  for (const history of ['h'.repeat(500), `x${'h'.repeat(600)}`, 'h'.repeat(2001)])
    assert.equal((await setup({ entity: 'borderos', action: 'settle_batch', replayed: false, data_mode: 'erp_native', items: [{ title, settlement: { ...settlement, note: 'h'.repeat(500), history }, bordero_id: BORDERO }], borderos: [summary()] }).handler(post('settle_batch', data), env)).status, 502, history.slice(0, 3));
  const removal = history => setup({ entity: 'borderos', action: 'bordero_delete', replayed: false, data_mode: 'erp_native', items: [{ title, settlement: { ...settlement, kind: 'reversal', reverses_id: TITLE2, note: 'Motivo', history }, bordero_id: BORDERO }], borderos: [summary({ active: false, deleted_at: '2026-10-19T13:00:00Z' })] })
    .handler(post('bordero_delete', { id: BORDERO, expected_version: 1, posted_on: '2026-10-19', note: 'Motivo' }), env);
  assert.equal((await removal(null)).status, 200, 'an estorno without history');
  assert.equal((await removal(`Motivo${'h'.repeat(600)}`)).status, 502, 'history only on baixas');
  const denied = setup({ code: '42501', message: 'private' }, 400);
  assert.equal((await denied.handler(request('/v1/financeiro/borderos?page=1&kind=payable'), env)).status, 403);
});

let db; let users; let rpc; let alfa; let bank;
before(async () => {
  const fixture = await financeParityDb({ through: '202610200110_finance_bordero.sql' });
  ({ db, users, rpc } = fixture); await fixture.addUsers();
  alfa = await fixture.contact({ name: 'Alfa Sintética' });
  bank = (await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_save', p_data: { expected_version: 0, name: 'Banco sintético', kind: 'bank' } })).record;
});
after(async () => db?.close());

test('110 API contract runs against real SQL: grouped baixa, page, read and Excluir borderô', async () => {
  const api = async (path, init = {}, user = users.financeiro, port = rpc) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init)), { userId: user, rpc: port });
  const body = data => ({ method: 'POST', body: JSON.stringify({ command_id: randomUUID(), data }) });
  const titles = [];
  for (const n of [1, 2]) titles.push((await api('/v1/financeiro/actions/title_create', body({ kind: 'receivable', contact_id: alfa.id, description: `Conta ${n}`, issued_on: '2026-01-02', competence_on: '2026-01-01', total_cents: '5000', installments: [{ amount_cents: '5000', due_on: '2026-02-10' }] }))).items[0]);
  const settled = await api('/v1/financeiro/actions/settle_batch', body({ kind: 'receivable', grouped: true, account_id: bank.id, note: 'Agrupado', items: titles.map(title => item({ id: title.id, expected_version: 1, account_id: bank.id, posted_on: '2026-02-15', principal_cents: '5000' })) }));
  assert.equal(settled.borderos.length, 1); assert.ok(settled.items.every(row => row.title.status === 'paid'));
  const listed = await api('/v1/financeiro/borderos?page=1&kind=receivable', {}, users.consulta);
  assert.equal(listed.total, 1); assert.deepEqual(listed.totals.paid_cents, '10000');
  const read = await api(`/v1/financeiro/borderos/${settled.borderos[0].id}`, {}, users.consulta);
  assert.equal(read.record.lines.length, 2); assert.equal(read.record.note, 'Agrupado');
  const removed = await api('/v1/financeiro/actions/bordero_delete', body({ id: read.record.id, expected_version: 1, posted_on: '2026-02-16', note: 'Desfeito' }));
  assert.equal(removed.borderos[0].active, false); assert.ok(removed.items.every(row => row.title.status === 'open'));
  assert.equal((await api('/v1/financeiro/borderos?page=1&kind=receivable', {}, users.consulta)).total, 0);
  const tamper = mutate => async (name, args) => { const result = await rpc(name, args); mutate(result); return result; };
  await assert.rejects(() => api(`/v1/financeiro/borderos/${read.record.id}`, {}, users.consulta, tamper(v => { v.record.lines.pop(); })), error => error.status === 502);
});
