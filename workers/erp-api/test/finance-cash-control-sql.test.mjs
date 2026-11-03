import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 173: Controle de caixa (abrir, sangria, suprimento, valores informados, fechar, reabrir, conferido, excluir).
let env; let db; let users; let scalar; let rpc; let caixa; let banco; let dinheiro; let cartao;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const balance = async account => scalar('SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1', [account]);

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  const account = data => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
  caixa = (await account({ account_type: 'cash', name: 'Caixa loja', start_on: '2020-01-01', opening_cents: '10000' })).record;
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Banco', agency: '1', account_number: '2', account_digit: '3', start_on: '2020-01-01', opening_cents: '0' })).record;
  const method = async (description, type) => (await db.query("INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,created_by,updated_by) VALUES($1,$2,'caixa','ambos',$3,$3) RETURNING id", [description, type, users.admin])).rows[0].id;
  dinheiro = await method('Dinheiro', '01'); cartao = await method('Cartão de débito', '04');
});
after(async () => db?.close());

test('173 RPCs are service-only security definer functions; tables closed; consulta reads and cannot write', async () => {
  for (const name of ['erp_finance_cash_session_page', 'erp_finance_cash_session_get', 'erp_finance_cash_session_execute']) {
    const fn = (await db.query("SELECT p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows[0];
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.cash_session', 'erp_finance.cash_session_value', 'erp_finance.cash_session_move']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  await assert.rejects(() => act('session_open', { account_id: caixa.id, change_cents: '0' }, users.consulta), http(403));
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => call('/v1/financeiro/controle-caixa', {}, users[role]), http(403));
});

test('173 Abrir Caixa, sangria and suprimento in the conta of the caixa, Valores informados, Fechar, Reabrir and Conferido, with the version as CAS', async () => {
  await assert.rejects(() => act('session_open', { account_id: banco.id, change_cents: '0' }), http(400), 'only a conta do tipo Caixa');
  const command = randomUUID();
  const opened = await act('session_open', { account_id: caixa.id, change_cents: '5000' }, users.financeiro, command);
  assert.deepEqual([opened.record.state, opened.record.change_cents, opened.record.account_name, opened.record.opened_on, opened.record.expected_cash_cents], ['open', '5000', 'Caixa loja', today, '5000']);
  assert.equal((await act('session_open', { account_id: caixa.id, change_cents: '5000' }, users.financeiro, command)).replayed, true);
  await assert.rejects(() => act('session_open', { account_id: caixa.id, change_cents: '0' }), http(409), 'one open caixa per operator in the conta');
  let session = opened.record;
  const supply = await act('session_move', { id: session.id, expected_version: session.version, kind: 'supply', amount_cents: '2000', note: 'Troco do banco' });
  await assert.rejects(() => act('session_move', { id: session.id, expected_version: session.version, kind: 'withdrawal', amount_cents: '700' }), http(409), 'stale version');
  const withdrawal = await act('session_move', { id: session.id, expected_version: supply.record.version, kind: 'withdrawal', amount_cents: '700' });
  session = withdrawal.record;
  assert.deepEqual([session.supply_cents, session.withdrawal_cents, session.expected_cash_cents, session.moves.map(move => [move.kind, move.amount_cents, move.note])], ['2000', '700', '6300', [['supply', '2000', 'Troco do banco'], ['withdrawal', '700', null]]]);
  assert.equal(await balance(caixa.id), '11300', 'sangria and suprimento are lançamentos of the caixa');
  const entry = (await db.query("SELECT id,version,origin,note FROM erp_finance.cash_entry WHERE source_key=$1", [`cash_session:${session.moves[1].id}`])).rows[0];
  assert.deepEqual([entry.origin, entry.note], ['cash_session', 'Sangria de caixa']);
  await assert.rejects(() => rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_delete', p_data: { id: entry.id, expected_version: entry.version } }), error => error.code === '40001', 'the extrato does not exclude it');
  const removed = await act('session_move_delete', { id: session.id, expected_version: session.version, move_id: session.moves[1].id });
  session = removed.record; assert.equal(await balance(caixa.id), '12000'); assert.equal(session.moves.length, 1);
  await assert.rejects(() => act('session_save', { id: session.id, expected_version: session.version, checked: true }), http(409), 'Conferido only after closing');
  await assert.rejects(() => act('session_close', { id: session.id, expected_version: session.version, values: [{ payment_method_id: randomUUID(), amount_cents: '1' }] }), http(400), 'unknown forma');
  const saved = await act('session_save', { id: session.id, expected_version: session.version, checked: false, values: [{ payment_method_id: dinheiro, amount_cents: '6900' }] });
  const closed = await act('session_close', { id: session.id, expected_version: saved.record.version, values: [{ payment_method_id: dinheiro, amount_cents: '6900' }, { payment_method_id: cartao, amount_cents: '1500' }] });
  session = closed.record;
  assert.deepEqual([session.state, session.informed_cents, session.methods.map(method => [method.name, method.registered_cents, method.informed_cents, method.difference_cents])], ['closed', '8400', [['Cartão de débito', '0', '1500', '1500'], ['Dinheiro', '0', '6900', '6900']]]);
  await assert.rejects(() => act('session_move', { id: session.id, expected_version: session.version, kind: 'supply', amount_cents: '1' }), http(409), 'a closed caixa takes no movement');
  const reopened = await act('session_reopen', { id: session.id, expected_version: session.version });
  const closedAgain = await act('session_close', { id: session.id, expected_version: reopened.record.version, values: [{ payment_method_id: dinheiro, amount_cents: '7000' }] });
  const checked = await act('session_save', { id: session.id, expected_version: closedAgain.record.version, checked: true });
  assert.equal(checked.record.checked, true);
  await assert.rejects(() => act('session_reopen', { id: session.id, expected_version: checked.record.version }), http(409), 'a conferido caixa is not reopened');
  await assert.rejects(() => act('session_delete', { id: session.id, expected_version: checked.record.version }), http(409));
  const listed = await call('/v1/financeiro/controle-caixa?state=checked', {}, users.consulta);
  assert.equal(listed.total, 0, 'without "Listar todos os caixas" only the caixas of the user');
  const all = await call('/v1/financeiro/controle-caixa?state=checked&all=true', {}, users.consulta);
  assert.deepEqual(all.items.map(item => [item.id, item.checked]), [[session.id, true]]);
  const read = await call(`/v1/financeiro/controle-caixa/${session.id}`, {}, users.consulta);
  assert.deepEqual(read.record.values.map(value => [value.payment_method_name, value.amount_cents]), [['Dinheiro', '7000']]);
  assert.equal((await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: caixa.id })).record.in_use, true);
});

test('173 Excluir a caixa without movements; the Worker refuses unknown keys and filters', async () => {
  const other = await act('session_open', { account_id: caixa.id, change_cents: '0' }, users.admin);
  const gone = await act('session_delete', { id: other.record.id, expected_version: other.record.version }, users.admin);
  assert.equal(gone.record.deleted, true);
  await assert.rejects(() => call(`/v1/financeiro/controle-caixa/${other.record.id}`, {}, users.consulta), http(404));
  for (const bad of ['/v1/financeiro/controle-caixa?state=x', '/v1/financeiro/controle-caixa?all=1', '/v1/financeiro/controle-caixa?from=2026-02-01&to=2026-01-01', '/v1/financeiro/controle-caixa?x=1'])
    await assert.rejects(() => call(bad, {}, users.consulta), http(400), bad);
  for (const data of [{ account_id: caixa.id, change_cents: '1,00' }, { account_id: caixa.id, change_cents: '1', extra: 1 }])
    await assert.rejects(() => act('session_open', data), http(400));
});
