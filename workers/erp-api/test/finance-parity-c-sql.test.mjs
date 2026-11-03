import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 172: estorno pela conciliação (baixas e transferências), exclusão da conta só com saldo inicial,
// Parcelada como recorrência, Ficha financeira paginada e contas em aberto do contato.
let env; let db; let users; let scalar; let rpc; let banco; let caixa; let alfa;
const code = expected => error => error.code === expected;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const balance = async account => scalar('SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1', [account]);
const account = data => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
const ofx = rows => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><DTSTART>20260301<DTEND>20260331
${rows.map(row => `<STMTTRN>\r\n<TRNTYPE>${row.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}\r\n<DTPOSTED>${row.date.replaceAll('-', '')}\r\n<TRNAMT>${row.amount}\r\n<FITID>${row.fitid}\r\n<MEMO>${row.memo}\r\n</STMTTRN>`).join('\r\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const savePreferences = async (pageId, changes) => {
  const current = await rpc('erp_preferences_page', { p_user_id: users.admin, p_page: pageId });
  return rpc('erp_preferences_save', { p_user_id: users.admin, p_command_id: randomUUID(), p_page: pageId, p_changes: JSON.stringify(Object.entries(changes).map(([key, value]) => ({ key, expected_version: current.items.find(item => item.key === key).version, value }))) });
};

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env);
  // Supabase Auth e-mail read by Preferências (absent from the shared bootstrap stub).
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text');
  await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-02-01', opening_cents: '100000' })).record;
  caixa = (await account({ account_type: 'cash', name: 'Caixa sintético', start_on: '2026-02-01', opening_cents: '0' })).record;
});
after(async () => db?.close());

test('172 new RPCs are service-only security definer functions', async () => {
  for (const name of ['erp_finance_contact_ledger_page', 'erp_finance_contact_open_titles']) {
    const fn = (await db.query("SELECT p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [name])).rows[0];
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']]);
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [fn.signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const name of ['settlement_reverse', 'transfer_reverse']) assert.equal(await scalar("SELECT has_function_privilege('service_role',p.oid,'EXECUTE') AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='erp_finance' AND p.proname=$1", [name]), false);
});

test('172 Reverter conciliação com estorno undoes the baixa (on its date) and the transferência of the line, in one command with Conferir resultado', async () => {
  await act('statement_import', { account_id: banco.id, file_name: 'marco.ofx', content: ofx([{ date: '2026-03-10', amount: '300.00', fitid: 'C1', memo: 'PIX ALFA' }, { date: '2026-03-11', amount: '-50.00', fitid: 'C2', memo: 'TED CAIXA' }]) });
  const queue = await call(`/v1/financeiro/conciliacao?account=${banco.id}&state=pending`, {}, users.consulta);
  const pix = queue.items.find(line => line.fitid === 'C1'), ted = queue.items.find(line => line.fitid === 'C2');
  const title = (await rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind: 'receivable', contact_id: alfa.id, description: 'Venda sintética', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '30000', installments: [{ amount_cents: '30000', due_on: '2026-03-10' }] } })).items[0];
  const settled = await act('line_settle_titles', { line_id: pix.id, expected_version: pix.version, items: [{ id: title.id, expected_version: 1, principal_cents: '30000' }] });
  const transfer = await act('line_create_transfer', { line_id: ted.id, expected_version: ted.version, other_account_id: caixa.id });
  const [bankBefore, cashBefore] = [await balance(banco.id), await balance(caixa.id)];
  assert.deepEqual([bankBefore, cashBefore], ['125000', '5000']);
  const command = randomUUID(), data = { line_id: pix.id, expected_version: settled.record.version, reverse: true };
  const undone = await act('line_unreconcile', data, users.financeiro, command);
  assert.equal(undone.record.state, 'pending');
  assert.equal((await act('line_unreconcile', data, users.financeiro, command)).replayed, true, 'Conferir resultado repeats the same command');
  const reversal = (await db.query("SELECT kind,posted_on::text AS day,principal_cents::text AS principal,note FROM erp_finance.settlement WHERE title_id=$1 ORDER BY created_at", [title.id])).rows;
  assert.deepEqual(reversal.map(row => [row.kind, row.day, row.principal]), [['payment', '2026-03-10', '30000'], ['reversal', '2026-03-10', '30000']]);
  assert.equal(reversal[1].note, 'Estornado ao reverter a conciliação');
  assert.equal(await scalar('SELECT settled_cents::text AS value FROM erp_finance.title WHERE id=$1', [title.id]), '0');
  assert.equal(await balance(banco.id), '95000');
  // The conta is free again: the line can settle it once more.
  const again = await act('line_settle_titles', { line_id: pix.id, expected_version: undone.record.version, items: [{ id: title.id, expected_version: 3, principal_cents: '30000' }] });
  assert.equal(again.record.state, 'reconciled');
  // Transferência: the inverse transfer on the dates of the original legs.
  const reverted = await act('line_unreconcile', { line_id: ted.id, expected_version: transfer.record.version, reverse: true });
  assert.equal(reverted.record.state, 'pending');
  assert.deepEqual([await balance(banco.id), await balance(caixa.id)], ['130000', '0']);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.transfer_deletion WHERE note=$1', ['Estornado ao reverter a conciliação']), 1);
  // Without the estorno the movements stay.
  const plain = await act('line_create_transfer', { line_id: ted.id, expected_version: reverted.record.version, other_account_id: caixa.id });
  await act('line_unreconcile', { line_id: ted.id, expected_version: plain.record.version });
  assert.equal(await balance(caixa.id), '5000');
  assert.ok(await scalar("SELECT count(*)::int AS value FROM erp_finance.audit WHERE action='line_unreconcile'") >= 3);
});

test('172 a conta whose only movement is the saldo inicial is excluded like an unused Origin account; any other use keeps Inativar', async () => {
  const lonely = (await account({ account_type: 'checking', institution_code: '001', institution_name: 'Banco do Brasil', name: 'Conta só com saldo inicial', agency: '9', account_number: '8', account_digit: '7', start_on: '2026-01-01', opening_cents: '12345' })).record;
  const view = await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: lonely.id });
  assert.equal(view.record.in_use, false, 'the saldo inicial alone is not a use');
  const command = randomUUID();
  const removed = await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: command, p_action: 'account_delete', p_data: { id: lonely.id, expected_version: lonely.version } });
  assert.equal(removed.record.deleted, true);
  assert.equal(await balance(lonely.id), '0', 'the saldo inicial is compensated on its date');
  assert.deepEqual((await db.query('SELECT kind,delta_cents::text AS delta,posted_on::text AS day FROM erp_finance.movement WHERE account_id=$1 ORDER BY created_at', [lonely.id])).rows.map(row => [row.kind, row.delta, row.day]), [['opening', '12345', '2026-01-01'], ['opening_reversal', '-12345', '2026-01-01']]);
  await assert.rejects(() => rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: lonely.id }), code('P0002'));
  // A lançamento, a forma de pagamento or the cobrança keep the conta in use.
  const busy = (await account({ account_type: 'cash', name: 'Caixa com lançamento', start_on: '2026-01-01', opening_cents: '0' })).record;
  await rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { expected_version: 0, account_id: busy.id, kind: 'in', amount_cents: '100', posted_on: '2026-03-01', competence_on: '2026-03-01', note: 'Venda balcão' } });
  const fresh = await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: busy.id });
  assert.equal(fresh.record.in_use, true);
  await assert.rejects(() => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_delete', p_data: { id: busy.id, expected_version: fresh.record.version } }), code('40001'));
  const linked = (await account({ account_type: 'cash', name: 'Caixa da forma', start_on: '2026-01-01', opening_cents: '0' })).record;
  await db.query("INSERT INTO erp_catalog.payment_method(description,payment_type,destination,account_id,applicable,created_by,updated_by) VALUES('Dinheiro sintético','01','caixa',$1,'ambos',$2,$2)", [linked.id, users.admin]);
  assert.equal((await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: linked.id })).record.in_use, true, 'a forma de pagamento points to it');
});

test('172 Parcelada is a recurrence with the nº de parcelas: each parcela has the Valor, the first is created now and Gerar contas stops at the last', async () => {
  const exec = (action, data, command = randomUUID()) => act(action, data, users.financeiro, command);
  const base = { kind: 'receivable', contact_id: alfa.id, description: 'Curso sintético', issued_on: '2026-03-01', competence_on: '2026-03-01', due_on: '2026-03-10', amount_cents: '25000', frequency: 'installments', due_day: 10, installments: 3, business_days: false };
  for (const bad of [{ installments: 1 }, { installments: 121 }, { installments: undefined }, { end_on: '2026-12-31' }, { frequency: 'monthly' }]) await assert.rejects(() => exec('recurrence_create', { ...base, ...bad }), http(400), JSON.stringify(bad));
  const created = await exec('recurrence_create', base);
  assert.deepEqual([created.record.frequency, created.record.installments, created.record.next_on, created.title.installment, created.title.installments, created.title.amount_cents, created.title.group_id], ['installments', 3, '2026-04-10', 1, 3, '25000', created.record.id]);
  const second = await exec('recurrence_generate', { id: created.record.id, expected_version: created.record.version });
  const third = await exec('recurrence_generate', { id: created.record.id, expected_version: second.record.version });
  assert.deepEqual([second.title.installment, second.title.due_on, third.title.installment, third.title.due_on, third.record.next_on], [2, '2026-04-10', 3, '2026-05-10', null]);
  await assert.rejects(() => exec('recurrence_generate', { id: created.record.id, expected_version: third.record.version }), http(409), 'the last parcela was generated');
  const listed = await call('/v1/financeiro/recorrentes?kind=receivable&situacao=todas', {}, users.consulta);
  assert.equal(listed.items.find(item => item.id === created.record.id).installments, 3);
  assert.deepEqual((await db.query('SELECT installment,installments FROM erp_finance.title WHERE group_id=$1 ORDER BY installment', [created.record.id])).rows.map(row => [row.installment, row.installments]), [[1, 3], [2, 3], [3, 3]]);
});

test('172 the Ficha financeira is paged (100 lines) with the totals of the whole period, so a large contact never exceeds the answer bound', async () => {
  const beta = await env.contact({ name: 'Beta Sintética' });
  for (let index = 0; index < 130; index++) await db.query("INSERT INTO erp_finance.cash_entry(account_id,kind,amount_cents,posted_on,competence_on,contact_id,note,origin,actor,command_id) VALUES($1,'in',100,'2026-03-05','2026-03-05',$2,$3,'ledger',$4,gen_random_uuid())", [caixa.id, beta.id, `Lançamento ${index}`, users.financeiro]);
  const first = await call(`/v1/financeiro/ficha?contact=${beta.id}&scope=all&from=2026-01-01&to=2026-12-31&page=1&limit=100`, {}, users.consulta);
  const second = await call(`/v1/financeiro/ficha?contact=${beta.id}&scope=all&from=2026-01-01&to=2026-12-31&page=2&limit=100`, {}, users.consulta);
  assert.deepEqual([first.total, first.items.length, second.items.length, first.totals.credit_cents, second.totals.credit_cents], [130, 100, 30, '13000', '13000']);
  assert.equal(new Set([...first.items, ...second.items].map(line => line.ref_id)).size, 130, 'pages never repeat a line');
  for (const bad of ['page=0', 'limit=101', 'page=1&page=2']) await assert.rejects(() => call(`/v1/financeiro/ficha?contact=${beta.id}&from=2026-01-01&to=2026-12-31&${bad}`, {}, users.consulta), http(400), bad);
  const legacy = await call(`/v1/financeiro/ficha?contact=${beta.id}&from=2026-01-01&to=2026-12-31`, {}, users.consulta);
  assert.equal(legacy.items.length, 130, 'the 136 read keeps working for older ERPs');
});

test('172 contas em aberto do contato: the financeiro always reads them; the pedidos profiles only while Preferências allow', async () => {
  const gama = await env.contact({ name: 'Gama Sintética' });
  const create = (kind, due) => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'title_create', p_data: { kind, contact_id: gama.id, description: `Conta ${kind}`, issued_on: '2020-01-01', competence_on: '2020-01-01', total_cents: '5000', installments: [{ amount_cents: '2000', due_on: due }, { amount_cents: '3000', due_on: '2099-01-01' }] } });
  await create('receivable', '2020-02-01'); await create('payable', '2099-02-01');
  const path = kind => `/v1/financeiro/contato-em-aberto?contact=${gama.id}&kind=${kind}`;
  const open = await call(path('receivable'), {}, users.consulta);
  assert.deepEqual([open.total, open.balance_cents, open.overdue, open.overdue_cents, open.items.map(item => item.description)], [2, '5000', 1, '2000', ['Conta receivable 1/2', 'Conta receivable 2/2']]);
  await assert.rejects(() => call(path('receivable'), {}, users.vendas), http(403));
  await savePreferences('vendas-vendas', { 'vendas.ver_contas_receber': true });
  assert.equal((await call(path('receivable'), {}, users.vendas)).total, 2);
  await assert.rejects(() => call(path('payable'), {}, users.vendas), http(403), 'vendas never reads payables');
  await assert.rejects(() => call(path('payable'), {}, users.estoque), http(403));
  await savePreferences('suprimentos-compras', { 'compras.ver_contas_pagar': true });
  assert.equal((await call(path('payable'), {}, users.estoque)).balance_cents, '5000');
  await assert.rejects(() => call(path('receivable'), {}, users.inactive), http(403));
  for (const bad of [`/v1/financeiro/contato-em-aberto?contact=${gama.id}`, `/v1/financeiro/contato-em-aberto?contact=x&kind=receivable`, `${path('receivable')}&extra=1`]) await assert.rejects(() => call(bad, {}, users.consulta), http(400), bad);
});
