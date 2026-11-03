import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 136: Caixas e bancos (lançamentos, ajuste, transferências com float, exclusão), extrato e Ficha financeira.
let env; let db; let users; let scalar; let rpc; let caixa; let banco; let alfa; let despesa; let receita;
const code = expected => error => error.code === expected;
const cash = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_cash_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const statement = (args = {}, user = users.consulta) => rpc('erp_finance_statement_page', { p_user_id: user, p_from: '2026-01-01', p_to: '2026-12-31', ...args });
const balance = async (account, until = '2100-01-01') => scalar('SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1 AND posted_on<=$2', [account, until]);
const entry = (extra = {}) => ({ expected_version: 0, account_id: caixa.id, kind: 'out', amount_cents: '1500', posted_on: '2026-03-10', competence_on: '2026-03-01', note: 'Material de limpeza', ...extra });
const worker = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  const account = (data) => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
  caixa = (await account({ account_type: 'cash', name: 'Caixa sintético', start_on: '2026-01-01', opening_cents: '10000' })).record;
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Banco sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-02-01', opening_cents: '0' })).record;
  const category = data => rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: data });
  despesa = (await category({ kind: 'payable', name: 'Limpeza' })).record; receita = (await category({ kind: 'receivable', name: 'Vendas' })).record;
});
after(async () => db?.close());

test('136 RPCs are service-only security definer functions; cash tables are closed; consulta reads and cannot write', async () => {
  const names = ['erp_finance_statement_page', 'erp_finance_cash_entry_get', 'erp_finance_cash_execute', 'erp_finance_contact_ledger'];
  const fns = (await db.query("SELECT p.proname,p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1)", [names])).rows;
  assert.equal(fns.length, 4);
  for (const fn of fns) {
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.cash_entry', 'erp_finance.transfer_deletion']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  await assert.rejects(() => cash('entry_save', entry(), users.consulta), code('42501'));
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => statement({}, users[role]), code('42501'));
});

test('136 lançamento: incluir, editar, excluir e restaurar keep an append-only ledger whose daily sums equal the visible lines', async () => {
  const command = randomUUID();
  const created = await cash('entry_save', entry({ category_id: despesa.id, contact_id: alfa.id }), users.financeiro, command);
  assert.deepEqual([created.record.kind, created.record.amount_cents, created.record.category_name, created.record.contact_name, created.record.version], ['out', '1500', 'Limpeza', 'Alfa Sintética', 1]);
  assert.equal((await cash('entry_save', entry({ category_id: despesa.id, contact_id: alfa.id }), users.financeiro, command)).replayed, true);
  await assert.rejects(() => cash('entry_save', entry({ note: 'Outro' }), users.financeiro, command), code('40001'));
  assert.equal(await balance(caixa.id), '8500');
  for (const bad of [{ amount_cents: '0' }, { kind: 'x' }, { note: '' }, { posted_on: '2025-12-31' }, { category_id: randomUUID() }, { account_id: randomUUID() }]) await assert.rejects(() => cash('entry_save', entry(bad)), error => ['22023'].includes(error.code), JSON.stringify(bad));
  // Editing the value and the date compensates the old posting on its own date and posts again.
  const edited = await cash('entry_save', entry({ id: created.record.id, expected_version: 1, amount_cents: '2000', posted_on: '2026-03-12', category_id: despesa.id, contact_id: alfa.id }));
  assert.equal(edited.record.version, 2);
  assert.equal(await balance(caixa.id, '2026-03-11'), '10000', 'the old posting nets to zero on its date');
  assert.equal(await balance(caixa.id), '8000');
  await assert.rejects(() => cash('entry_save', entry({ id: created.record.id, expected_version: 1, note: 'Velho' })), code('40001'));
  const movements = (await db.query('SELECT kind,delta_cents::text AS delta,posted_on::text AS day FROM erp_finance.movement WHERE entry_id=$1 ORDER BY created_at', [created.record.id])).rows;
  assert.deepEqual(movements.map(row => [row.kind, row.delta, row.day]), [['entry', '-1500', '2026-03-10'], ['entry_reversal', '1500', '2026-03-10'], ['entry', '-2000', '2026-03-12']]);
  // Only the category and the note change: no new posting.
  await cash('entry_save', entry({ id: created.record.id, expected_version: 2, amount_cents: '2000', posted_on: '2026-03-12', note: 'Material de limpeza e café', category_id: null }));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.movement WHERE entry_id=$1', [created.record.id]), 3);
  await assert.rejects(() => db.query('UPDATE erp_finance.movement SET delta_cents=0 WHERE entry_id=$1', [created.record.id]), code('55000'), 'postings are immutable');
  const removed = await cash('entry_delete', { id: created.record.id, expected_version: 3, note: 'Lançado em duplicidade' });
  assert.equal(removed.record.deleted, true); assert.equal(await balance(caixa.id), '10000');
  const registered = await statement({ p_account: caixa.id });
  assert.equal(registered.items.some(line => line.entry_id === created.record.id), false);
  const deleted = await statement({ p_account: caixa.id, p_deleted: true });
  assert.deepEqual(deleted.items.map(line => [line.line_kind, line.amount_cents, line.note]), [['entry', '-2000', 'Material de limpeza e café']]);
  await assert.rejects(() => cash('entry_delete', { id: created.record.id, expected_version: 4 }), code('40001'));
  const restored = await cash('entry_restore', { id: created.record.id, expected_version: 4 });
  assert.equal(restored.record.deleted, false); assert.equal(await balance(caixa.id), '8000');
});

test('136 Ajustar saldos records the difference on the date; the balance the user saw is the CAS', async () => {
  const current = await balance(caixa.id);
  await assert.rejects(() => cash('balance_adjust', { account_id: caixa.id, desired_cents: '9000', current_cents: '1', posted_on: '2026-04-01' }), code('40001'));
  await assert.rejects(() => cash('balance_adjust', { account_id: caixa.id, desired_cents: current, current_cents: current, posted_on: '2026-04-01' }), code('22023'));
  const adjusted = await cash('balance_adjust', { account_id: caixa.id, desired_cents: '9000', current_cents: current, posted_on: '2026-04-01' });
  assert.deepEqual([adjusted.record.kind, adjusted.record.amount_cents, adjusted.record.origin, adjusted.record.note, adjusted.balance_cents], ['in', '1000', 'adjustment', 'Ajuste de saldo', '9000']);
  assert.equal(await balance(caixa.id), '9000');
  const negative = await cash('balance_adjust', { account_id: caixa.id, desired_cents: '-100', current_cents: '9000', posted_on: '2026-04-02' });
  assert.deepEqual([negative.record.kind, negative.record.amount_cents], ['out', '9100']);
  await cash('balance_adjust', { account_id: caixa.id, desired_cents: '9000', current_cents: '-100', posted_on: '2026-04-02' });
});

test('136 transferência com float bancário, categorias automáticas e exclusão pela transferência inversa', async () => {
  await assert.rejects(() => cash('transfer_create', { from_account_id: caixa.id, to_account_id: banco.id, amount_cents: '500', posted_on: '2026-01-15' }), code('22023'), 'before the start date of the bank account');
  const command = randomUUID();
  const created = await cash('transfer_create', { from_account_id: caixa.id, to_account_id: banco.id, amount_cents: '500', posted_on: '2026-04-10', float_days: 2 }, users.financeiro, command);
  assert.deepEqual([created.record.note, created.record.in_posted_on, created.record.float_days], ['Transferência Caixa sintético -> Banco sintético', '2026-04-12', 2]);
  const legs = (await db.query("SELECT m.kind,m.posted_on::text AS day,c.name FROM erp_finance.movement m LEFT JOIN erp_finance.category c ON c.id=m.category_id WHERE m.transfer_id=$1 ORDER BY m.kind DESC", [created.record.id])).rows;
  assert.deepEqual(legs.map(row => [row.kind, row.day, row.name]), [['transfer_out', '2026-04-10', 'Transferências de saída'], ['transfer_in', '2026-04-12', 'Transferências de entrada']]);
  assert.equal((await cash('transfer_create', { from_account_id: caixa.id, to_account_id: banco.id, amount_cents: '500', posted_on: '2026-04-10', float_days: 2 }, users.financeiro, command)).replayed, true);
  await assert.rejects(() => cash('transfer_create', { from_account_id: caixa.id, to_account_id: caixa.id, amount_cents: '500', posted_on: '2026-04-10' }), code('22023'));
  await assert.rejects(() => cash('transfer_create', { from_account_id: caixa.id, to_account_id: banco.id, amount_cents: '500', posted_on: '2026-04-10', float_days: 31 }), code('22023'));
  assert.deepEqual([await balance(caixa.id), await balance(banco.id)], ['8500', '500']);
  const deleted = await cash('transfer_delete', { transfer_id: created.record.id, note: 'Conta errada' });
  assert.equal(deleted.record.deleted, true);
  assert.deepEqual([await balance(caixa.id, '2026-04-10'), await balance(banco.id, '2026-04-12')], ['9000', '0'], 'each leg is undone on its own date');
  await assert.rejects(() => cash('transfer_delete', { transfer_id: created.record.id }), code('40001'));
  await assert.rejects(() => cash('transfer_delete', { transfer_id: deleted.record.reversal_id }), code('40001'), 'the inverse transfer is not excluded again');
  assert.equal((await statement({ p_account: banco.id })).items.some(line => line.line_kind === 'transfer'), false);
  assert.deepEqual((await statement({ p_account: banco.id, p_deleted: true })).items.map(line => [line.line_kind, line.amount_cents, line.posted_on]), [['transfer', '500', '2026-04-12']]);
  // The 053 transfer immutability stays: legs and transfers never change.
  await assert.rejects(() => db.query('UPDATE erp_finance.transfer SET note=$2 WHERE id=$1', [created.record.id, 'x']), code('55000'));
});

test('136 extrato: lines of every origin, filters, order, pages, daily balances and Informações consistent with the ledger', async () => {
  // A baixa of a conta a receber is a line with the conta, the contact and the categoria of the baixa.
  const title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, category_id: receita.id, description: 'Venda sintética', issued_on: '2026-04-01', competence_on: '2026-04-01', total_cents: '3000', installments: [{ amount_cents: '3000', due_on: '2026-04-20' }] } })).items[0];
  await rpc('erp_finance_bordero_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle_batch', p_data: { kind: 'receivable', grouped: false, items: [{ id: title.id, expected_version: 1, account_id: caixa.id, category_id: null, posted_on: '2026-04-20', principal_cents: '3000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }] } });
  const page = await statement({ p_account: caixa.id, p_from: '2026-04-01', p_to: '2026-04-30' });
  const settlement = page.items.find(line => line.line_kind === 'settlement');
  assert.deepEqual([settlement.amount_cents, settlement.contact_name, settlement.category_name, settlement.title_kind], ['3000', 'Alfa Sintética', 'Vendas', 'receivable']);
  assert.deepEqual(page.summary.previous_cents, await balance(caixa.id, '2026-03-31'));
  assert.equal(BigInt(page.summary.previous_cents) + BigInt(page.summary.in_cents) - BigInt(page.summary.out_cents), BigInt(page.summary.closing_cents));
  for (const [day, cents] of Object.entries(page.day_balances)) assert.equal(cents, await balance(caixa.id, day), day);
  assert.equal(page.summary.current_cents, await balance(caixa.id));
  assert.ok((await statement({ p_account: caixa.id, p_tab: 'in' })).items.every(line => BigInt(line.amount_cents) > 0n));
  assert.ok((await statement({ p_account: caixa.id, p_tab: 'out' })).items.every(line => BigInt(line.amount_cents) < 0n));
  assert.deepEqual((await statement({ p_categories: [receita.id] })).items.map(line => line.line_kind), ['settlement']);
  assert.deepEqual((await statement({ p_query: 'alfa' })).items.map(line => line.line_kind), ['settlement'], 'the contact of the baixa');
  assert.deepEqual((await statement({ p_query: 'LIMPEZA' })).items.map(line => line.note), ['Material de limpeza e café'], 'the histórico of a lançamento');
  assert.deepEqual((await statement({ p_amount_cents: 3000 })).items.length, 1);
  const desc = await statement({ p_account: caixa.id, p_order: 'desc', p_limit: 2 });
  assert.equal(desc.items.length, 2); assert.ok(desc.items[0].posted_on >= desc.items[1].posted_on);
  const all = await statement({});
  assert.equal(all.summary.current_cents, (BigInt(await balance(caixa.id)) + BigInt(await balance(banco.id))).toString(), 'Saldo atual de todas as contas');
  await assert.rejects(() => statement({ p_from: '2026-02-01', p_to: '2026-01-01' }), code('22023'));
  await assert.rejects(() => statement({ p_account: randomUUID() }), code('P0002'));
});

test('136 Alterar categorias of a line uses the category seen as CAS: lançamento, transferência and baixa (in its borderô)', async () => {
  const lines = (await statement({ p_account: caixa.id })).items;
  const entryLine = lines.find(line => line.line_kind === 'entry' && line.entry_origin === 'manual'), settlementLine = lines.find(line => line.line_kind === 'settlement');
  await assert.rejects(() => cash('line_categorize', { line_kind: 'entry', line_id: entryLine.line_id, expected_category_id: despesa.id, category_id: receita.id }), code('40001'));
  const changed = await cash('line_categorize', { line_kind: 'entry', line_id: entryLine.line_id, expected_category_id: entryLine.category_id, category_id: despesa.id });
  assert.equal(changed.record.category_id, despesa.id);
  await assert.rejects(() => cash('line_categorize', { line_kind: 'settlement', line_id: settlementLine.line_id, expected_category_id: settlementLine.category_id, category_id: despesa.id }), code('22023'), 'a baixa a receber takes a receita');
  const other = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Outras receitas' } })).record;
  await cash('line_categorize', { line_kind: 'settlement', line_id: settlementLine.line_id, expected_category_id: settlementLine.category_id, category_id: other.id });
  assert.equal((await statement({ p_account: caixa.id })).items.find(line => line.line_id === settlementLine.line_id).category_name, 'Outras receitas');
  // Mover categorias (135) also moves the category of the lançamentos de caixa.
  const moved = await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_move', p_data: { id: despesa.id, expected_version: 1, target_id: (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'payable', name: 'Despesas gerais' } })).record.id, confirmed: true } });
  assert.ok(moved.moved.movements >= 1);
});

test('136 Ficha financeira: contas, baixas e lançamentos da ficha do contato com débitos, créditos e saldo', async () => {
  await cash('entry_save', entry({ kind: 'in', amount_cents: '700', posted_on: '2026-05-02', competence_on: '2026-05-02', note: 'Adiantamento', contact_id: alfa.id, origin: 'ledger' }));
  const ledger = await rpc('erp_finance_contact_ledger', { p_user_id: users.consulta, p_contact: alfa.id, p_from: '2026-01-01', p_to: '2026-12-31' });
  const kinds = ledger.items.map(line => [line.line_kind, line.side, line.amount_cents]);
  assert.ok(kinds.some(row => row[0] === 'title' && row[1] === 'debit' && row[2] === '3000'));
  assert.ok(kinds.some(row => row[0] === 'payment' && row[1] === 'credit' && row[2] === '3000'));
  assert.ok(kinds.some(row => row[0] === 'entry' && row[1] === 'credit' && row[2] === '700'));
  assert.equal(BigInt(ledger.totals.credit_cents) - BigInt(ledger.totals.debit_cents), BigInt(ledger.totals.balance_cents));
  assert.equal(ledger.items.find(line => line.line_kind === 'title').situation, 'paid');
  assert.equal((await rpc('erp_finance_contact_ledger', { p_user_id: users.consulta, p_contact: alfa.id, p_scope: 'payable', p_from: '2026-01-01', p_to: '2026-12-31' })).items.every(line => line.kind === 'payable'), true);
  await assert.rejects(() => rpc('erp_finance_contact_ledger', { p_user_id: users.consulta, p_contact: randomUUID(), p_from: '2026-01-01', p_to: '2026-12-31' }), code('P0002'));
});

test('136 Worker contract: strict queries and bodies before any RPC; statement, entry and ficha responses are checked', async () => {
  for (const path of ['/v1/financeiro/extrato', '/v1/financeiro/extrato?from=2026-01-01&to=2025-01-01', '/v1/financeiro/extrato?from=2026-01-01&to=2026-01-31&tab=x', '/v1/financeiro/extrato?from=2026-01-01&to=2026-01-31&deleted=1',
    '/v1/financeiro/extrato?from=2026-01-01&to=2026-01-31&x=1', '/v1/financeiro/ficha?contact=x&from=2026-01-01&to=2026-01-31', `/v1/financeiro/ficha?contact=${alfa.id}&from=2026-01-01`]) {
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test${path}`)), error => error.status === 400, path);
  }
  const page = await worker(`/v1/financeiro/extrato?account=${caixa.id}&from=2026-01-01&to=2026-12-31`, {}, users.consulta);
  assert.ok(page.items.length > 0 && page.items.every(line => line.account_id === caixa.id));
  const ficha = await worker(`/v1/financeiro/ficha?contact=${alfa.id}&from=2026-01-01&to=2026-12-31`, {}, users.consulta);
  assert.equal(ficha.contact_name, 'Alfa Sintética');
  const created = await worker('/v1/financeiro/actions/entry_save', { body: { command_id: randomUUID(), data: entry({ amount_cents: '100', posted_on: '2026-06-01', competence_on: '2026-06-01', note: 'Pela API' }) } });
  assert.equal(created.record.note, 'Pela API');
  const read = await worker(`/v1/financeiro/lancamentos/${created.record.id}`, {}, users.consulta); assert.equal(read.record.version, 1);
  for (const body of [{ command_id: randomUUID(), data: entry({ amount_cents: '1.00' }) }, { command_id: randomUUID(), data: entry({ note: 'x'.repeat(2001) }) }, { command_id: randomUUID(), data: { ...entry(), extra: 1 } },
    { command_id: randomUUID(), data: { line_kind: 'opening', line_id: randomUUID(), expected_category_id: null, category_id: null } }, { command_id: randomUUID(), data: { account_id: caixa.id, desired_cents: '1', current_cents: '1', posted_on: '2026-01-01' } }]) {
    const action = body.data.line_kind ? 'line_categorize' : body.data.desired_cents ? 'balance_adjust' : 'entry_save';
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/actions/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })), error => error.status === 400);
  }
  const route = await parseFinanceRoute(new Request(`https://api.example.test/v1/financeiro/extrato?account=${caixa.id}&from=2026-01-01&to=2026-12-31&tab=in`));
  const real = await rpc(route.rpc, { p_user_id: users.consulta, ...route.args });
  const tampered = structuredClone(real); tampered.items[0].amount_cents = '-1';
  await assert.rejects(() => executeFinanceRoute(route, { userId: users.consulta, rpc: async () => tampered }), error => error.status === 502);
  const unbalanced = structuredClone(real); unbalanced.summary.in_cents = (BigInt(unbalanced.summary.in_cents) + 1n).toString();
  await assert.rejects(() => executeFinanceRoute(route, { userId: users.consulta, rpc: async () => unbalanced }), error => error.status === 502);
});
