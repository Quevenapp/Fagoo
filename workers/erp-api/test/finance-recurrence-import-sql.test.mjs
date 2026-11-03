import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 138: Contas recorrentes (schedule, dias úteis, Gerar contas, alterar em aberto) e Importação de registros financeiros.
let env; let db; let users; let scalar; let rpc; let alfa; let beta; let banco; let receita;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const recurrence = (extra = {}) => ({ kind: 'receivable', contact_id: alfa.id, description: 'Mensalidade sintética', issued_on: '2026-01-25', competence_on: '2026-01-01', due_on: '2026-01-31', amount_cents: '10000', frequency: 'monthly', due_day: 31, ...extra });

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética', document: '12.345.678/0001-90' }); beta = await env.contact({ name: 'Beta Sintética' });
  banco = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa sintético', start_on: '2026-01-01', opening_cents: '0' } })).record;
  receita = (await rpc('erp_finance_category_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'category_create', p_data: { kind: 'receivable', name: 'Mensalidades' } })).record;
});
after(async () => db?.close());

test('138 business days: weekends, fixed national holidays, Carnaval, Sexta-feira Santa and Corpus Christi', async () => {
  const next = async value => scalar('SELECT erp_finance.next_business_day($1::date)::text AS value', [value]);
  assert.equal(await next('2026-01-31'), '2026-02-02', 'Saturday');
  assert.equal(await next('2026-02-16'), '2026-02-18', 'Carnaval 2026 (Monday and Tuesday)');
  assert.equal(await next('2026-04-03'), '2026-04-06', 'Sexta-feira Santa and the weekend');
  assert.equal(await next('2026-06-04'), '2026-06-05', 'Corpus Christi');
  assert.equal(await next('2026-11-20'), '2026-11-23', 'Consciência Negra, then the weekend');
  assert.equal(await next('2023-11-20'), '2023-11-20', 'not a national holiday before 2024');
  for (const role of ['anon', 'authenticated', 'service_role']) for (const table of ['erp_finance.recurrence', 'erp_finance.import_row']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
});

test('138 recorrência mensal: the first conta, then one per Gerar contas until the data limite, never twice for a date', async () => {
  const command = randomUUID();
  const created = await act('recurrence_create', recurrence({ category_id: receita.id, business_days: true, end_on: '2026-04-30' }), users.financeiro, command);
  assert.deepEqual([created.record.frequency, created.record.next_on, created.title.due_on, created.title.issued_on, created.title.competence_on, created.title.recurrence_id], ['monthly', '2026-02-28', '2026-02-02', '2026-01-25', '2026-01-01', created.record.id]);
  assert.equal((await act('recurrence_create', recurrence({ category_id: receita.id, business_days: true, end_on: '2026-04-30' }), users.financeiro, command)).replayed, true);
  let record = created.record; const dues = [];
  for (let index = 0; index < 3; index++) { const next = await act('recurrence_generate', { id: record.id, expected_version: record.version }); dues.push([next.title.due_on, next.title.issued_on]); record = next.record; }
  assert.deepEqual(dues, [['2026-03-02', '2026-02-24'], ['2026-03-31', '2026-03-25'], ['2026-04-30', '2026-04-24']], 'Feb 28 2026 is a Saturday; the lead of the first conta is kept');
  assert.equal(record.next_on, null); assert.equal(record.generated, 4);
  await assert.rejects(() => act('recurrence_generate', { id: record.id, expected_version: record.version }), http(409), 'the data limite was reached');
  await assert.rejects(() => act('recurrence_generate', { id: record.id, expected_version: 1 }), http(409));
  await assert.rejects(() => db.query("INSERT INTO erp_finance.title(group_id,installment,installments,kind,contact_id,description,issued_on,due_on,amount_cents,recurrence_id,recurrence_on) VALUES(gen_random_uuid(),1,1,'receivable',$1,'x','2026-01-01','2026-03-31',1,$2,'2026-03-31')", [alfa.id, record.id]), http(409), 'one conta per date');
  assert.equal((await call(`/v1/financeiro/recorrentes/${record.id}`, {}, users.consulta)).record.generated, 4);
  const page = await call('/v1/financeiro/recorrentes?kind=receivable', {}, users.consulta);
  assert.deepEqual(page.items.map(item => [item.contact_name, item.category_name, item.open_titles]), [['Alfa Sintética', 'Mensalidades', 4]]);
  const titles = await call(`/v1/financeiro/titles?page=1&kind=receivable&option=issued`, {}, users.consulta);
  assert.ok(titles.items.every(item => item.recurrence_id === record.id), 'the list knows the recurrence of each conta');
});

test('138 Semanal, Quinzenal and Anual schedules; Inativar stops Gerar contas; invalid schedules are refused before SQL', async () => {
  const weekly = await act('recurrence_create', recurrence({ kind: 'payable', description: 'Semanal', issued_on: '2026-03-02', competence_on: '2026-03-02', due_on: '2026-03-06', frequency: 'weekly', due_day: undefined, weekday: 5 }));
  assert.equal(weekly.record.next_on, '2026-03-13');
  const biweekly = await act('recurrence_create', recurrence({ kind: 'payable', description: 'Quinzenal', issued_on: '2026-03-01', competence_on: '2026-03-01', due_on: '2026-03-05', frequency: 'biweekly', due_day: 5, second_day: 20 }));
  let record = biweekly.record; const dues = [];
  for (let index = 0; index < 3; index++) { const next = await act('recurrence_generate', { id: record.id, expected_version: record.version }); dues.push(next.title.due_on); record = next.record; }
  assert.deepEqual(dues, ['2026-03-20', '2026-04-05', '2026-04-20']);
  const annual = await act('recurrence_create', recurrence({ description: 'Anual', issued_on: '2026-02-01', competence_on: '2026-02-01', due_on: '2026-02-28', frequency: 'annual', due_day: 29 }));
  assert.equal(annual.record.next_on, '2027-02-28', 'capped at the last day of February');
  const inactive = await act('recurrence_set_active', { id: annual.record.id, expected_version: 1, active: false });
  assert.deepEqual([inactive.record.active, inactive.record.next_on], [false, null]);
  await assert.rejects(() => act('recurrence_generate', { id: annual.record.id, expected_version: 2 }), http(409));
  for (const bad of [{ frequency: 'weekly' }, { frequency: 'biweekly' }, { frequency: 'monthly', due_day: null }, { end_on: '2025-12-31' }, { frequency: 'daily' }, { amount_cents: '0' }]) {
    const data = recurrence(bad); for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
    await assert.rejects(() => act('recurrence_create', data), http(400), JSON.stringify(bad));
  }
  await assert.rejects(() => act('recurrence_create', recurrence({ frequency: 'weekly', due_day: undefined, weekday: 1 })), http(400), 'the weekday must be the one of the vencimento');
  await assert.rejects(() => act('recurrence_create', recurrence(), users.consulta), http(403));
});

test('138 Alterar contas em aberto (as seguintes ou todas) and the lançamentos de contas futuras; contas with baixa stay', async () => {
  const created = await act('recurrence_create', recurrence({ description: 'Aluguel sintético', issued_on: '2026-05-01', competence_on: '2026-05-01', due_on: '2026-05-10', due_day: 10 }));
  let record = created.record; const ids = [created.title.id];
  for (let index = 0; index < 3; index++) { const next = await act('recurrence_generate', { id: record.id, expected_version: record.version }); ids.push(next.title.id); record = next.record; }
  // The second conta was paid: it is never changed by the propagation.
  await rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle', p_data: { id: ids[1], expected_version: 1, account_id: banco.id, posted_on: '2026-06-10', principal_cents: '10000' } });
  const following = await act('recurrence_update', { id: record.id, expected_version: record.version, from_title_id: ids[0], scope: 'following', future: true, changes: { amount_cents: '12000', description: 'Aluguel reajustado' } });
  assert.equal(following.updated_titles, 2);
  const rows = (await db.query('SELECT id,amount_cents::text AS amount,description FROM erp_finance.title WHERE recurrence_id=$1 ORDER BY recurrence_on', [record.id])).rows;
  assert.deepEqual(rows.map(row => [row.amount, row.description]), [['10000', 'Aluguel sintético'], ['10000', 'Aluguel sintético'], ['12000', 'Aluguel reajustado'], ['12000', 'Aluguel reajustado']]);
  const next = await act('recurrence_generate', { id: following.record.id, expected_version: following.record.version });
  assert.deepEqual([next.title.amount_cents, next.title.description], ['12000', 'Aluguel reajustado'], 'future contas follow the model');
  await assert.rejects(() => act('recurrence_update', { id: next.record.id, expected_version: next.record.version, from_title_id: ids[0], scope: 'none', future: false, changes: { amount_cents: '1' } }), http(400));
});

test('138 Importação: prévia por linha, contato pelo CPF/CNPJ ou nome, categoria e conta pelo nome; só insere as linhas novas', async () => {
  const rows = [{ line: 2, issued_on: '2026-07-01', due_on: '2026-07-31', amount_cents: '5000', description: 'Venda importada', contact_document: '12345678000190', category: 'mensalidades' },
    { line: 3, issued_on: '2026-07-01', due_on: '2026-07-31', amount_cents: '7000', description: 'Outra venda', contact_name: 'beta sintética' },
    { line: 4, issued_on: '2026-07-01', due_on: '2026-06-30', amount_cents: '7000', description: 'Vencimento antes da emissão', contact_name: 'Ninguém' }];
  const preview = await act('records_import_preview', { kind: 'receivable', file_name: 'contas.csv', rows });
  assert.deepEqual(preview.rows.map(row => [row.line, row.status, row.errors]), [[2, 'new', []], [3, 'new', []], [4, 'error', ['vencimento', 'contato']]]);
  await assert.rejects(() => act('records_import', { kind: 'receivable', file_name: 'contas.csv', rows }), http(400), 'every line must be valid');
  const command = randomUUID();
  const imported = await act('records_import', { kind: 'receivable', file_name: 'contas.csv', rows: rows.slice(0, 2) }, users.financeiro, command);
  assert.deepEqual([imported.created, imported.skipped], [2, 0]);
  assert.equal((await act('records_import', { kind: 'receivable', file_name: 'contas.csv', rows: rows.slice(0, 2) }, users.financeiro, command)).replayed, true);
  const again = await act('records_import', { kind: 'receivable', file_name: 'contas-de-novo.csv', rows: rows.slice(0, 2) });
  assert.deepEqual([again.created, again.skipped], [0, 2], 'the same lines are not imported twice');
  assert.equal((await act('records_import_preview', { kind: 'receivable', file_name: 'x.csv', rows: rows.slice(0, 1) })).rows[0].status, 'duplicate');
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.title WHERE description IN ('Venda importada','Outra venda')"), 2);
  // Registros de caixa: tipo, conta financeira and the ledger posting.
  const cash = await act('records_import', { kind: 'cash', file_name: 'caixa.csv', rows: [{ line: 2, issued_on: '2026-07-05', amount_cents: '2500', side: 'out', description: 'Taxa importada', account: 'caixa sintético' }] });
  assert.equal(cash.created, 1);
  assert.equal(await scalar("SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1", [banco.id]), '7500', 'the earlier baixa of 100,00 and this saída of 25,00');
  const noAccount = await act('records_import_preview', { kind: 'cash', file_name: 'caixa.csv', rows: [{ line: 2, issued_on: '2026-07-05', amount_cents: '2500', description: 'Sem conta' }] });
  assert.deepEqual(noAccount.rows[0].errors, ['tipo', 'conta']);
  for (const body of [{ kind: 'x', file_name: 'a.csv', rows: [] }, { kind: 'cash', file_name: 'a.csv', rows: [{ line: 1, issued_on: '2026-01-01', amount_cents: '1', description: 'a' }] }, { kind: 'cash', file_name: 'a.csv', rows: [{ line: 2, issued_on: '2026-01-01', amount_cents: '1', description: 'a', extra: 'x' }] }]) {
    await assert.rejects(() => act('records_import_preview', body), http(400));
  }
  await assert.rejects(() => act('records_import_preview', { kind: 'cash', file_name: 'a.csv', rows: [{ line: 2, issued_on: '2026-01-01', amount_cents: '1', description: 'a' }] }, users.consulta), http(403));
});
