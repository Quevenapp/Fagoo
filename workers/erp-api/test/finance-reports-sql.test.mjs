import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 212: Relatórios financeiros (fluxo realizado e previsto, categorias com a Categorização para DRE, contatos)
// and "Desfazer vínculo" of the conciliação.
let env; let db; let users; let scalar; let rpc; let banco; let caixa; let alfa; let beta; let vendas; let aluguel; let juros; let tarifas;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const report = (query, user = users.consulta) => call(`/v1/financeiro/relatorios?${query}`, {}, user);
const category = async (kind, name) => (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind, name } })).record;
const title = async (kind, contact, cents, due, extra = {}) => (await act('title_create', { kind, contact_id: contact, description: `Conta ${cents}`, issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: cents, installments: [{ amount_cents: cents, due_on: due }], ...extra })).items[0];
const settle = (item, values) => act('settle', { id: item.id, expected_version: item.version, account_id: banco.id, principal_cents: item.amount_cents, interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', note: null, ...values });
const ofx = rows => `OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST><DTSTART>20260301000000[-3:BRT]<DTEND>20260331000000[-3:BRT]
${rows.map(row => `<STMTTRN>\r\n<TRNTYPE>${row.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}\r\n<DTPOSTED>${row.date.replaceAll('-', '')}120000[-3:BRT]\r\n<TRNAMT>${row.amount}\r\n<FITID>${row.fitid}\r\n<MEMO>${row.memo}\r\n</STMTTRN>`).join('\r\n')}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' }); beta = await env.contact({ name: 'Beta Sintética' });
  const account = data => rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: data });
  banco = (await account({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú sintético', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-02-01', opening_cents: '100000' })).record;
  caixa = (await account({ account_type: 'cash', name: 'Caixa sintético', start_on: '2026-02-01', opening_cents: '5000' })).record;
  vendas = await category('receivable', 'Vendas sintéticas'); aluguel = await category('payable', 'Aluguel sintético');
  juros = await category('receivable', 'Juros recebidos'); tarifas = await category('payable', 'Tarifas sintéticas');
  for (const [key, id] of [['receipt_interest', juros.id], ['receipt_fees', tarifas.id]]) {
    const version = await scalar('SELECT version AS value FROM erp_finance.category_default WHERE key=$1', [key]);
    await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_set_default', p_data: { key, category_id: id, expected_version: version } });
  }
  // March: a recebimento of 1.000,00 with 15,00 juros and 5,00 tarifa (banco), a pagamento of 300,00 (banco), a lançamento of 50,00 out (caixa).
  const income = await title('receivable', alfa.id, '100000', '2026-03-10', { category_id: vendas.id });
  await settle(income, { posted_on: '2026-03-12', interest_cents: '1500', fee_cents: '500' });
  const rent = await title('payable', beta.id, '30000', '2026-03-05', { category_id: aluguel.id });
  const paid = await settle(rent, { posted_on: '2026-03-05' });
  await rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { account_id: caixa.id, kind: 'out', amount_cents: '5000', posted_on: '2026-03-20', competence_on: '2026-03-20', category_id: aluguel.id, contact_id: beta.id, note: 'Lançamento sintético', expected_version: 0 } });
  // An estorno in April takes the pagamento back out of the realizado of April, with its category.
  await act('reverse', { id: rent.id, expected_version: paid.record.version, settlement_id: paid.settlement.id, posted_on: '2026-04-02', note: 'Estorno sintético' });
  // Open contas for the previsto.
  await title('receivable', alfa.id, '20000', '2026-04-15'); await title('payable', beta.id, '7000', '2026-05-10'); await title('receivable', beta.id, '1000', '2026-02-20', { issued_on: '2026-02-01', competence_on: '2026-02-01' });
});
after(async () => db?.close());

test('212 the report and dismissal RPCs are service-only, consulta reads, other profiles do not', async () => {
  for (const signature of ['public.erp_finance_report(uuid,text,date,date,uuid,text,integer,integer)', 'public.erp_finance_reconciliation_dismiss(uuid,uuid,jsonb)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($2,$1,'EXECUTE') AS value", [signature, role]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
    assert.deepEqual((await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=to_regprocedure($1)', [signature])).rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog'] });
  }
  for (const helper of ['erp_finance.report_settlement_parts(uuid[],date,date)', 'erp_finance.report_entry_parts(uuid[],date,date)', 'erp_finance.report_buckets(date,date,text)'])
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [helper]), false, helper);
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => report('report=cash_flow&from=2026-03-01&to=2026-03-31', users[role]), http(403), role);
  for (const bad of ['report=x&from=2026-03-01&to=2026-03-31', 'report=cash_flow&from=2026-03-31&to=2026-03-01', 'report=cash_flow&from=2026-01-01&to=2027-06-01&group=day',
    'report=cash_flow&from=2026-01-01&to=2037-06-01', 'report=cash_flow&from=2026-03-01&to=2026-03-31&page=1', 'report=categories&from=2026-03-01&to=2026-03-31&group=day',
    'report=contacts&from=2026-03-01&to=2026-03-31&limit=101', 'report=cash_flow&from=2026-03-01&to=2026-03-31&account=x', 'report=cash_flow&from=2026-03-01&to=2026-03-31&x=1'])
    await assert.rejects(() => report(bad), http(400), bad);
  await assert.rejects(() => report(`report=cash_flow&from=2026-03-01&to=2026-03-31&account=${randomUUID()}`), http(404));
});

test('212 Fluxo de caixa realizado: entradas, saídas and the saldo of each month, without the internal transfers of every conta', async () => {
  await act('transfer_create', { from_account_id: banco.id, to_account_id: caixa.id, amount_cents: '10000', posted_on: '2026-03-15', float_days: 0 });
  const flow = await report('report=cash_flow&from=2026-03-01&to=2026-04-30');
  assert.deepEqual(flow.items.map(item => [item.start_on, item.end_on, item.in_cents, item.out_cents, item.balance_cents]),
    [['2026-03-01', '2026-03-31', '101000', '35000', '171000'], ['2026-04-01', '2026-04-30', '30000', '0', '201000']]);
  assert.deepEqual(flow.summary, { previous_cents: '105000', in_cents: '131000', out_cents: '35000', net_cents: '96000', closing_cents: '201000' });
  const bank = await report(`report=cash_flow&from=2026-03-01&to=2026-03-31&account=${banco.id}`);
  assert.deepEqual([bank.items[0].in_cents, bank.items[0].out_cents, bank.items[0].balance_cents], ['101000', '40000', '161000'], 'one conta sees its transfer');
  const daily = await report(`report=cash_flow&from=2026-03-11&to=2026-03-13&group=day&account=${banco.id}`);
  assert.deepEqual(daily.items.map(item => [item.start_on, item.net_cents, item.balance_cents]), [['2026-03-11', '0', '70000'], ['2026-03-12', '101000', '171000'], ['2026-03-13', '0', '171000']]);
});

test('212 Fluxo de caixa previsto: contas em aberto by vencimento over the saldo atual, with the atrasadas apart', async () => {
  const forecast = await report('report=forecast&from=2026-04-01&to=2026-05-31');
  assert.deepEqual(forecast.items.map(item => [item.start_on, item.receivable_cents, item.payable_cents, item.balance_cents]), [['2026-04-01', '20000', '0', '221000'], ['2026-05-01', '0', '7000', '214000']]);
  // 246: atrasadas are the contas em aberto vencidas antes de hoje (São Paulo), whatever the period.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const late = (cents, due) => due < today ? cents : 0;
  assert.deepEqual([forecast.summary.current_cents, forecast.summary.projected_cents, forecast.summary.overdue_receivable_cents, forecast.summary.overdue_payable_cents],
    ['201000', '214000', String(1000 + late(20000, '2026-04-15')), String(30000 + late(7000, '2026-05-10'))],
    'the estorno reopened the aluguel: it is overdue, as the conta a receber of fevereiro (and the contas of the period once their vencimento passed)');
});

test('212 Receitas e despesas por categoria: juros and tarifa in the Categorização para DRE, the estorno undoes its baixa', async () => {
  const march = await report('report=categories&from=2026-03-01&to=2026-03-31');
  assert.deepEqual(march.items.map(item => [item.name, item.kind, item.amount_cents]), [['Juros recebidos', 'receivable', '1500'], ['Vendas sintéticas', 'receivable', '100000'], ['Aluguel sintético', 'payable', '-35000'], ['Tarifas sintéticas', 'payable', '-500']]);
  assert.deepEqual(march.summary, { in_cents: '101500', out_cents: '35500', net_cents: '66000' });
  const april = await report('report=categories&from=2026-04-01&to=2026-04-30');
  assert.deepEqual(april.items.map(item => [item.name, item.amount_cents]), [['Aluguel sintético', '30000']]);
  const contacts = await report('report=contacts&from=2026-03-01&to=2026-04-30&limit=1');
  assert.deepEqual([contacts.total, contacts.items.map(item => [item.name, item.received_cents, item.paid_cents])], [2, [['Alfa Sintética', '101000', '0']]]);
  const second = await report('report=contacts&from=2026-03-01&to=2026-04-30&limit=1&page=2');
  assert.deepEqual(second.items.map(item => [item.name, item.received_cents, item.paid_cents, item.net_cents]), [['Beta Sintética', '0', '5000', '-5000']], 'pagamento estornado and the lançamento de caixa of Beta');
});

test('212 Desfazer vínculo discards the sugestão of a pending line once; the next one takes its place', async () => {
  const first = (await rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { account_id: banco.id, kind: 'out', amount_cents: '1234', posted_on: '2026-03-25', competence_on: '2026-03-25', note: 'Primeira opção', expected_version: 0 } })).record;
  const second = (await rpc('erp_finance_cash_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'entry_save', p_data: { account_id: banco.id, kind: 'out', amount_cents: '1234', posted_on: '2026-03-27', competence_on: '2026-03-27', note: 'Segunda opção', expected_version: 0 } })).record;
  await act('statement_import', { account_id: banco.id, file_name: 'extrato.ofx', content: ofx([{ date: '2026-03-25', amount: '-12.34', fitid: 'F1', memo: 'DEBITO' }]) });
  let line = (await call(`/v1/financeiro/conciliacao?account=${banco.id}&state=pending`, {}, users.consulta)).items.find(item => item.fitid === 'F1');
  assert.deepEqual([line.suggestion.kind, line.suggestion.id], ['entry', first.id]);
  await assert.rejects(() => act('line_dismiss', { line_id: line.id, expected_version: line.version, target: { kind: 'entry', id: second.id } }), http(409), 'only the current sugestão is discarded');
  await assert.rejects(() => act('line_dismiss', { line_id: line.id, expected_version: line.version, target: { kind: 'entry', id: first.id } }, users.consulta), http(403));
  await assert.rejects(() => act('line_dismiss', { line_id: line.id, expected_version: line.version, target: { kind: 'x', id: first.id } }), http(400));
  const command = randomUUID(), data = { line_id: line.id, expected_version: line.version, target: { kind: 'entry', id: first.id } };
  const dismissed = await act('line_dismiss', data, users.financeiro, command);
  assert.deepEqual([dismissed.record.state, dismissed.record.suggestion.id, dismissed.record.version], ['pending', second.id, line.version + 1]);
  assert.equal((await act('line_dismiss', data, users.financeiro, command)).replayed, true);
  await assert.rejects(() => act('line_dismiss', data), http(409), 'the old version is stale');
  line = (await call(`/v1/financeiro/conciliacao?account=${banco.id}&state=pending`, {}, users.consulta)).items.find(item => item.fitid === 'F1');
  assert.equal(line.suggestion.id, second.id);
  await act('line_dismiss', { line_id: line.id, expected_version: line.version, target: { kind: 'entry', id: second.id } });
  line = (await call(`/v1/financeiro/conciliacao?account=${banco.id}&state=pending`, {}, users.consulta)).items.find(item => item.fitid === 'F1');
  assert.equal(line.suggestion, null, 'with every sugestão discarded the line waits for Buscar');
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.audit WHERE action='line_dismiss'"), 2);
  await assert.rejects(() => db.query('DELETE FROM erp_finance.bank_line_dismissal'), /immutable/);
});
