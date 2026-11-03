import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 249: the Histórico of the "Baixa de lançamentos" takes 2,000 characters; settlement.note, the borderô and
// the movimento keep the first 500 (UTF-16 units, as the screens count them) and the extrato shows the whole text.
let env; let db; let users; let scalar; let rpc; let alfa; let caixa;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const conta = async description => (await act('title_create', { kind: 'receivable', contact_id: alfa.id, description, issued_on: '2026-04-01', competence_on: '2026-04-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-04-30' }] })).items[0];
const batch = (title, note, extra = {}) => ({ kind: 'receivable', grouped: false, note, items: [{ id: title.id, expected_version: title.version, account_id: caixa.id, category_id: null, posted_on: '2026-04-10', principal_cents: '10000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }], ...extra });
const utf16 = text => text.length;

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa 249', start_on: '2020-01-01', opening_cents: '0' } })).record;
});
after(async () => db?.close());

test('249 helper stays closed; the borderô RPC it replaces stays service-only', async () => {
  const signature = 'public.erp_finance_bordero_execute(uuid,uuid,text,jsonb)';
  for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [signature, role]), false, role);
  assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
  assert.deepEqual((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)', [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  for (const helper of ['erp_finance.settlement_text(jsonb)', 'erp_finance.statement_lines(uuid,date,date,boolean)'])
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [helper, role]), false, `${role} ${helper}`);
});

test('249 a Histórico of 2,000 characters: the baixa keeps it whole, the borderô and the movimento its first 500', async () => {
  const title = await conta('Conta com histórico longo');
  // 499 letters and an emoji (two UTF-16 units) straddle the 500 limit: the cut never splits the pair nor passes 500 units.
  const long = `${'a'.repeat(499)}\u{1F600}${' b'.repeat(749)}c`;
  assert.equal(utf16(long), 2000);
  const command = randomUUID();
  const result = await act('settle_batch', batch(title, long), users.financeiro, command);
  const settlement = result.items[0].settlement;
  assert.equal(settlement.history, long);
  assert.equal(settlement.note, 'a'.repeat(499), 'note keeps the beginning without the half emoji');
  const row = (await db.query('SELECT s.note,s.history,m.note AS movement,b.note AS bordero FROM erp_finance.settlement s JOIN erp_finance.movement m ON m.settlement_id=s.id JOIN erp_finance.bordero_item i ON i.settlement_id=s.id JOIN erp_finance.bordero b ON b.id=i.bordero_id WHERE s.id=$1', [settlement.id])).rows[0];
  assert.deepEqual(row, { note: 'a'.repeat(499), history: long, movement: 'a'.repeat(499), bordero: 'a'.repeat(499) });
  assert.equal(result.borderos[0].note, 'a'.repeat(499));
  // Conferir resultado repeats the same command and returns the same baixa.
  const replay = await act('settle_batch', batch(title, long), users.financeiro, command);
  assert.equal(replay.replayed, true); assert.equal(replay.items[0].settlement.id, settlement.id); assert.equal(replay.items[0].settlement.history, long);
  // The histórico de baixas of the conta and the extrato read the whole text.
  const listed = await call(`/v1/financeiro/settlements?limit=10&parent_id=${title.id}`, {}, users.consulta);
  assert.equal(listed.items.find(item => item.id === settlement.id).history, long);
  const extrato = await call(`/v1/financeiro/extrato?account=${caixa.id}&from=2026-04-01&to=2026-04-30`, {}, users.consulta);
  assert.equal(extrato.items.find(line => line.title_id === title.id && line.amount_cents === '10000').note, long);
  assert.equal((await call(`/v1/financeiro/extrato?account=${caixa.id}&from=2026-04-01&to=2026-04-30&q=${encodeURIComponent('b bc')}`, {}, users.consulta)).items.length, 1, 'Pesquisar reads the whole histórico');
});

test('249 up to 500 characters nothing changes; past 2,000 the API and the database refuse', async () => {
  const short = await conta('Conta com histórico curto');
  const result = await act('settle_batch', batch(short, `${'x'.repeat(499)} `));
  assert.equal(result.items[0].settlement.history, null); assert.equal(result.items[0].settlement.note, 'x'.repeat(499));
  const exact = await conta('Conta com 500');
  assert.equal((await act('settle_batch', batch(exact, 'y'.repeat(500)))).items[0].settlement.history, null);
  const refused = await conta('Conta recusada');
  await assert.rejects(() => act('settle_batch', batch(refused, 'z'.repeat(2001))), http(400));
  await assert.rejects(() => rpc('erp_finance_bordero_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle_batch', p_data: batch(refused, `${'z'.repeat(1999)}\u{1F600}`) }), http(400), '2,001 UTF-16 units');
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.settlement WHERE title_id=$1', [refused.id]), 0);
  // The estorno of a borderô keeps the 500 characters of its motivo.
  const bordero = result.borderos[0];
  await assert.rejects(() => act('bordero_delete', { id: bordero.id, expected_version: bordero.version, posted_on: '2026-04-11', note: 'm'.repeat(501) }), http(400));
  const removed = await act('bordero_delete', { id: bordero.id, expected_version: bordero.version, posted_on: '2026-04-11', note: 'Estorno sintético' });
  assert.equal(removed.items[0].settlement.history, null);
});

test('249 the database keeps history only on baixas, past 500 and starting with the note', async () => {
  const title = await conta('Conta da trava');
  const settled = (await act('settle_batch', batch(title, 'k'.repeat(800)))).items[0].settlement;
  assert.equal(settled.history.length, 800);
  const constraint = await scalar("SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint WHERE conrelid='erp_finance.settlement'::regclass AND conname='settlement_history_check'");
  assert.match(constraint, /utf16_length\(history\)/);
  const insert = (note, history, kind = 'payment', reverses = null) => db.query(`INSERT INTO erp_finance.settlement(title_id,account_id,kind,reverses_id,posted_on,principal_cents,interest_cents,penalty_cents,discount_cents,fee_cents,net_cash_cents,note,history,actor,command_id)
    VALUES($1,$2,$3,$4,'2026-04-12',1,0,0,0,0,1,$5,$6,$7,$8)`, [title.id, caixa.id, kind, reverses, note, history, users.financeiro, randomUUID()]);
  await assert.rejects(() => insert('curto', 'curto'), /settlement_history_check/, 'history under 501');
  await assert.rejects(() => insert('outro', 'k'.repeat(600)), /settlement_history_check/, 'history must start with the note');
  await assert.rejects(() => insert(null, 'k'.repeat(600)), /settlement_history_check/, 'history needs the note');
  await assert.rejects(() => insert('k', 'k'.repeat(600), 'reversal', settled.id), /settlement_history_check/, 'only baixas');
});
