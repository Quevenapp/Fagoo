import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 175: Forma de pagamento nas contas (gaveta, listagem, Líquido e Ficha financeira).
let env; let db; let users; let scalar; let rpc; let alfa; let cartao; let boleto; let pagamento; let caixa;
const SQL = { 400: ['22023'], 403: ['42501'], 404: ['P0002'], 409: ['40001', '23505', '55000'] };
const http = status => error => error.status === status || (SQL[status] ?? []).includes(error.code);
const call = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });
const act = (action, data, user = users.financeiro, command = randomUUID()) => call(`/v1/financeiro/actions/${action}`, { body: { command_id: command, data } }, user);
const method = async (description, values) => (await db.query(`INSERT INTO erp_catalog.payment_method(description,payment_type,destination,applicable,fee_type,fee_rate,fee_fixed,interest_rate,fine_rate,account_id,created_by,updated_by)
  VALUES($1,$2,'contas',$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`, [description, values.type ?? '03', values.applicable ?? 'ambos', values.fee_type ?? 'aliquota', values.fee_rate ?? null, values.fee_fixed ?? null, values.interest ?? null, values.fine ?? null, values.account ?? null, users.admin])).rows[0].id;

before(async () => {
  env = await financeParityDb({});
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  caixa = (await rpc('erp_finance_account_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'account_create', p_data: { account_type: 'cash', name: 'Caixa', start_on: '2020-01-01', opening_cents: '0' } })).record;
  cartao = await method('Cartão de crédito sintético', { fee_type: 'aliquota_fixa', fee_rate: '3.5', fee_fixed: '0.40', interest: '1', fine: '2', account: caixa.id });
  boleto = await method('Boleto sintético', { type: '15', applicable: 'recebimentos', fee_type: 'fixa', fee_fixed: '2.50' });
  pagamento = await method('Transferência a fornecedor', { type: '18', applicable: 'pagamentos' });
});
after(async () => db?.close());

test('175 the formas of the kind; the conta keeps its forma, the taxa it takes and the Forma de pagamento in the Ficha', async () => {
  const offered = await call('/v1/financeiro/formas-pagamento?kind=receivable', {}, users.consulta);
  assert.deepEqual(offered.items.map(item => item.description).sort(), ['Boleto sintético', 'Cartão de crédito sintético']);
  assert.equal(offered.items.find(item => item.id === cartao).interest_rate, '1.0000');
  for (const bad of ['/v1/financeiro/formas-pagamento', '/v1/financeiro/formas-pagamento?kind=x', '/v1/financeiro/formas-pagamento?kind=receivable&x=1']) await assert.rejects(() => call(bad, {}, users.consulta), http(400), bad);
  await assert.rejects(() => call('/v1/financeiro/formas-pagamento?kind=payable', {}, users.vendas), http(403));
  const data = { kind: 'receivable', contact_id: alfa.id, description: 'Venda no cartão', issued_on: '2026-03-01', competence_on: '2026-03-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-03-31' }], payment_method_id: cartao };
  await assert.rejects(() => act('title_create', { ...data, payment_method_id: pagamento }), http(400), 'a forma de pagamentos is not offered to a conta a receber');
  const created = await act('title_create', data);
  const title = created.items[0];
  // 3,5% of 100,00 = 3,50 plus 0,40.
  assert.deepEqual([title.payment_method_id, title.payment_method_name, title.payment_fee_cents], [cartao, 'Cartão de crédito sintético', '390']);
  const edited = await act('title_edit', { id: title.id, expected_version: title.version, payment_method_id: boleto });
  assert.deepEqual([edited.record.payment_method_name, edited.record.payment_fee_cents], ['Boleto sintético', '250']);
  // An inactive forma stays on the conta that has it, but is never chosen again.
  await db.query('UPDATE erp_catalog.payment_method SET active=false WHERE id=$1', [boleto]);
  const kept = await act('title_edit', { id: title.id, expected_version: edited.record.version, description: 'Venda no boleto' });
  assert.equal(kept.record.payment_method_id, boleto);
  await assert.rejects(() => act('title_create', { ...data, payment_method_id: boleto }), http(400));
  const page = await call('/v1/financeiro/titles?page=1&kind=receivable&option=issued', {}, users.consulta);
  assert.equal(page.items.find(item => item.id === title.id).payment_method_name, 'Boleto sintético');
  const ledger = await call(`/v1/financeiro/ficha?contact=${alfa.id}&from=2026-01-01&to=2026-12-31&page=1&limit=100`, {}, users.consulta);
  assert.equal(ledger.items.find(line => line.ref_id === title.id).payment_method, 'Boleto sintético');
  const plain = await act('title_create', { ...data, payment_method_id: null, description: 'Sem forma' });
  assert.deepEqual([plain.items[0].payment_method_id, plain.items[0].payment_fee_cents], [null, null]);
});

test('172/175 a Parcelada (or any recurrence) keeps the Forma de pagamento of the inclusion in every conta it generates', async () => {
  const data = { kind: 'payable', contact_id: alfa.id, description: 'Aluguel parcelado', issued_on: '2026-05-01', competence_on: '2026-05-01', due_on: '2026-05-10', amount_cents: '50000',
    frequency: 'installments', due_day: 10, installments: 3, payment_method_id: pagamento };
  await assert.rejects(() => act('recurrence_create', { ...data, payment_method_id: boleto }), http(400), 'a forma de recebimentos is not offered to a conta a pagar');
  await assert.rejects(() => act('recurrence_create', { ...data, payment_method_id: 'not-a-uuid' }), http(400));
  const created = await act('recurrence_create', data);
  assert.deepEqual([created.title.payment_method_id, created.title.payment_method_name, created.title.installment, created.title.installments], [pagamento, 'Transferência a fornecedor', 1, 3]);
  const next = await act('recurrence_generate', { id: created.record.id, expected_version: created.record.version });
  assert.deepEqual([next.title.payment_method_id, next.title.installment], [pagamento, 2]);
  assert.equal(await scalar('SELECT payment_method_id::text AS value FROM erp_finance.recurrence WHERE id=$1', [created.record.id]), pagamento);
  const monthly = await act('recurrence_create', { ...data, frequency: 'monthly', installments: undefined, payment_method_id: undefined, description: 'Mensal sem forma' });
  assert.equal(monthly.title.payment_method_id, null);
});

test('175 Buscar of the conciliação shows the Forma de pagamento and finds contas by forma, vencimento and valor (FIN-169)', async () => {
  const data = { kind: 'receivable', contact_id: alfa.id, description: 'Venda buscada', issued_on: '2026-04-01', competence_on: '2026-04-01', total_cents: '12345', installments: [{ amount_cents: '12345', due_on: '2026-04-10' }], payment_method_id: cartao };
  const title = (await act('title_create', data)).items[0];
  const search = async q => (await call(`/v1/financeiro/conciliacao/candidatos?account=${caixa.id}&from=2026-04-01&to=2026-04-30&q=${encodeURIComponent(q)}`, {}, users.consulta)).titles.map(item => [item.id, item.payment_method_name]);
  for (const q of ['cartão de crédito', '10/04/2026', '123,45']) assert.deepEqual(await search(q), [[title.id, 'Cartão de crédito sintético']], q);
  assert.deepEqual(await search('boleto'), []);
  const all = await call(`/v1/financeiro/conciliacao/candidatos?account=${caixa.id}&from=2026-03-01&to=2026-04-30`, {}, users.consulta);
  assert.deepEqual(all.titles.map(item => item.payment_method_name).sort(), ['Boleto sintético', 'Cartão de crédito sintético', null].sort());
});
