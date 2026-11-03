import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 109: Origin "Opção", conta financeira, várias categorias, competência, Em remessa, valor exato,
// aggregated columns and the exclusion of deleted contas.
let db; let users; let scalar; let rpc; const t = {}; let bank; let cash; let revenue; let other;
const code = expected => error => error.code === expected;
const legacy = (action, data) => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const drawer = (action, data) => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const page = (args = {}, user = users.consulta) => rpc('erp_finance_title_page_v2', { p_user_id: user, p_kind: 'receivable', p_limit: 100, ...args });
const names = result => result.items.map(item => item.description).sort();
const today = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

before(async () => {
  const env = await financeParityDb({ through: '202610200109_finance_title_page_v2.sql' });
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  const alfa = await env.contact({ name: 'Alfa Sintética', document: '12.345.678/0001-90' }), beta = await env.contact({ name: 'Beta Sintética' });
  bank = (await legacy('account_save', { expected_version: 0, name: 'Banco sintético', kind: 'bank' })).record;
  cash = (await legacy('account_save', { expected_version: 0, name: 'Caixa sintético', kind: 'cash' })).record;
  revenue = (await legacy('category_save', { expected_version: 0, name: 'Serviços', kind: 'receivable' })).record;
  other = (await legacy('category_save', { expected_version: 0, name: 'Vendas', kind: 'both' })).record;
  const create = async (key, extra) => { t[key] = (await drawer('title_create', { kind: 'receivable', contact_id: alfa.id, issued_on: '2026-01-02', competence_on: '2026-01-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-02-10' }], ...extra })).items[0]; };
  await create('open', { description: 'Aberta banco', account_id: bank.id, category_id: revenue.id });
  await create('late', { description: 'Atrasada sem conta', installments: [{ amount_cents: '10000', due_on: '2026-01-10' }] });
  await create('future', { description: 'Futura caixa', account_id: cash.id, category_id: other.id, competence_on: '2026-03-01', installments: [{ amount_cents: '10000', due_on: '2099-01-10' }] });
  await create('paid', { description: 'Recebida com taxa', contact_id: beta.id, account_id: bank.id, total_cents: '20000', installments: [{ amount_cents: '20000', due_on: '2026-02-10' }] });
  await create('partial', { description: 'Parcial', contact_id: beta.id, bank_number: 'BOLETO-77' });
  await create('reversed', { description: 'Estornada' });
  await create('cancelled', { description: 'Cancelada' });
  await create('deleted', { description: 'Excluída' });
  t.payable = (await drawer('title_create', { kind: 'payable', contact_id: beta.id, description: 'Fornecedor', source_reference: 'NF 55', issued_on: '2026-01-02', competence_on: '2026-01-01', total_cents: '700', installments: [{ amount_cents: '700', due_on: '2026-02-10' }] })).items[0];
  await legacy('settle', { id: t.paid.id, expected_version: 1, account_id: bank.id, posted_on: '2026-02-11', principal_cents: '20000', interest_cents: '150', penalty_cents: '400', discount_cents: '50', fee_cents: '290' });
  await legacy('settle', { id: t.partial.id, expected_version: 1, account_id: cash.id, posted_on: '2026-02-12', principal_cents: '4000', fee_cents: '10' });
  const paid = await legacy('settle', { id: t.reversed.id, expected_version: 1, account_id: bank.id, posted_on: '2026-02-13', principal_cents: '10000', fee_cents: '99' });
  await legacy('reverse', { id: t.reversed.id, expected_version: 2, settlement_id: paid.settlement.id, posted_on: '2026-02-14', note: 'Estorno sintético' });
  await legacy('title_cancel', { id: t.cancelled.id, expected_version: 1, note: 'Cancelamento sintético' });
  await drawer('title_delete', { id: t.deleted.id, expected_version: 1 });
  // A boleto reserved for "Aberta banco" (Em remessa).
  const profile = randomUUID(), remittance = randomUUID();
  await db.query("INSERT INTO erp_cnab.profile(id,account_id,identity,settings,account_scope,next_sequence) VALUES($1,$2,'{}','{}','sintetico-109',2)", [profile, bank.id]);
  await db.query("INSERT INTO erp_cnab.remittance(id,profile_id,sequence,generated_on,snapshot,actor) VALUES($1,$2,1,'2026-01-10','{}',$3)", [remittance, profile, users.admin]);
  await db.query("INSERT INTO erp_cnab.billing_title(title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES($1,$2,$3,'C1','D1','12345678','{}')", [t.open.id, profile, remittance]);
  t.remittance = remittance;
});
after(async () => db?.close());

test('109 is a service-only security definer read with roles rechecked, writing nothing', async () => {
  const fn = (await db.query("SELECT p.prosecdef,p.proconfig,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='erp_finance_title_page_v2'")).rows;
  assert.deepEqual(fn.map(row => [row.prosecdef, row.proconfig, row.provolatile]), [[true, ['search_path=pg_catalog'], 's']]);
  const signature = 'public.erp_finance_title_page_v2(uuid,text,integer,integer,text,text,text,text[],text,date,date,text,text[],text,bigint,text)';
  for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, signature]), false);
  assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_function_privilege($1,'erp_finance.title_payments(uuid)','EXECUTE') AS value", [role]), false);
  for (const role of ['admin', 'financeiro', 'consulta']) assert.equal((await page({}, users[role])).total, 7);
  for (const role of ['vendas', 'estoque', 'fiscal', 'inactive']) await assert.rejects(() => page({}, users[role]), code('42501'));
  const before = await scalar('SELECT (SELECT count(*) FROM erp_finance.command)+(SELECT count(*) FROM erp_finance.audit) AS value');
  await page({ p_option: 'settled', p_date_field: 'settled' });
  assert.equal(await scalar('SELECT (SELECT count(*) FROM erp_finance.command)+(SELECT count(*) FROM erp_finance.audit) AS value'), before);
});

test('109 Opção: Em aberto, Atrasadas, Recebidas and Emitidas with Situação; deleted contas never appear', async () => {
  assert.deepEqual(names(await page()), ['Aberta banco', 'Atrasada sem conta', 'Cancelada', 'Estornada', 'Futura caixa', 'Parcial', 'Recebida com taxa'], 'Emitidas is every conta but the excluded one');
  assert.deepEqual(names(await page({ p_option: 'open' })), ['Aberta banco', 'Atrasada sem conta', 'Estornada', 'Futura caixa', 'Parcial']);
  assert.deepEqual(names(await page({ p_option: 'overdue' })), ['Aberta banco', 'Atrasada sem conta', 'Estornada', 'Parcial'], 'with balance and vencimento before today');
  assert.deepEqual(names(await page({ p_option: 'settled', p_date_field: 'settled' })), ['Parcial', 'Recebida com taxa'], 'a reversed baixa is not a recebimento');
  assert.deepEqual(names(await page({ p_option: 'settled', p_date_field: 'settled', p_from: '2026-02-12', p_to: '2026-02-12' })), ['Parcial']);
  assert.deepEqual(names(await page({ p_statuses: ['cancelled', 'paid'] })), ['Cancelada', 'Recebida com taxa']);
  assert.deepEqual(names(await page({ p_statuses: ['partial'] })), ['Parcial']);
  const open = await page({ p_option: 'open' });
  assert.deepEqual(open.totals, { count: 5, amount_cents: '50000', balance_cents: '46000', fee_cents: '10' });
  assert.equal(open.option, 'open'); assert.equal(open.total, 5);
  const settled = await page({ p_option: 'settled', p_date_field: 'settled' });
  assert.deepEqual(settled.totals, { count: 2, amount_cents: '30000', balance_cents: '6000', fee_cents: '300' }, 'Taxa total sums the tarifas of effective baixas');
  assert.equal((await page({ p_kind: 'payable' })).total, 1);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.title WHERE deleted_at IS NOT NULL'), 1);
});

test('109 conta financeira, categorias with Sem categoria, competência, Em remessa, valor exato and search', async () => {
  assert.deepEqual(names(await page({ p_account: bank.id })), ['Aberta banco', 'Recebida com taxa']);
  assert.deepEqual(names(await page({ p_account: bank.id.toUpperCase() })), ['Aberta banco', 'Recebida com taxa']);
  assert.equal((await page({ p_account: 'none' })).total, 4);
  assert.deepEqual(names(await page({ p_categories: [revenue.id, other.id] })), ['Aberta banco', 'Futura caixa']);
  assert.deepEqual(names(await page({ p_categories: ['none', other.id] })).length, 6);
  assert.deepEqual(names(await page({ p_date_field: 'competence', p_from: '2026-02-01', p_to: '2026-03-31' })), ['Futura caixa']);
  assert.deepEqual(names(await page({ p_option: 'open', p_remittance: 'yes' })), ['Aberta banco']);
  assert.equal((await page({ p_option: 'open', p_remittance: 'no' })).total, 4);
  assert.deepEqual(names(await page({ p_amount_cents: '20000' })), ['Recebida com taxa']);
  assert.deepEqual(names(await page({ p_query: 'boleto-77' })), ['Parcial'], 'the nº no banco is searchable');
  assert.equal((await page({ p_query: '12345678000190' })).total, 5);
  assert.deepEqual((await page({ p_kind: 'payable', p_document: 'nf 55' })).items.map(item => item.description), ['Fornecedor']);
});

test('109 rows carry liquidação, taxa, juros, acréscimos, descontos, conta financeira and remessa', async () => {
  const all = await page(), row = key => all.items.find(item => item.id === t[key].id);
  assert.deepEqual(row('paid').payments, { settled_on: '2026-02-11', fee_cents: '290', interest_cents: '150', penalty_cents: '400', discount_cents: '50', settled_by_return: false });
  assert.deepEqual(row('reversed').payments, { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false });
  assert.equal(row('paid').account_name, 'Banco sintético'); assert.equal(row('late').account_name, null);
  assert.deepEqual(row('open').remittance, { id: t.remittance, sequence: 1, state: 'reserved', our_number: '12345678' }); assert.equal(row('late').remittance, null);
  assert.equal(row('open').competence_on, '2026-01-01'); assert.equal(row('partial').bank_number, 'BOLETO-77');
  const keys = all.items.map(item => `${item.due_on}:${item.id}`); assert.deepEqual(keys, [...keys].sort());
  assert.ok(row('late').overdue && row('open').overdue && !row('future').overdue);
  assert.ok(today() > '2026-02-10');
  // A conta adopted from Origin (039) is flagged, so the list never offers Excluir for it.
  assert.ok(all.items.every(item => item.imported === false));
  const receipt = randomUUID();
  await db.query("INSERT INTO erp_finance.command(id,actor,request_hash,result) VALUES($1,$2,'sintetico','{}')", [receipt, users.admin]);
  await db.query("INSERT INTO erp_finance.origin_import_origin(entity,source_id,title_id,command_id,evidence) VALUES('receivables','9109',$1,$2,'{}')", [t.future.id, receipt]);
  const flagged = await page();
  assert.deepEqual(flagged.items.filter(item => item.imported).map(item => item.id), [t.future.id]);
});

test('109 refuses out-of-contract combinations before reading', async () => {
  for (const args of [{ p_option: 'all' }, { p_option: null }, { p_option: 'open', p_date_field: 'issued' }, { p_option: 'overdue', p_date_field: 'settled' }, { p_option: 'settled' },
    { p_option: 'open', p_statuses: ['open'] }, { p_statuses: ['overdue'] }, { p_statuses: ['open', 'open'] }, { p_date_field: 'paid' }, { p_account: 'x' }, { p_account: '' },
    { p_categories: [] }, { p_categories: ['none', 'none'] }, { p_categories: ['x'] }, { p_categories: Array.from({ length: 51 }, () => randomUUID()) },
    { p_remittance: 'yes' }, { p_option: 'open', p_remittance: 'sim' }, { p_amount_cents: '0' }, { p_amount_cents: '1000000000000000' },
    { p_from: '2026-02-01', p_to: '2026-01-01' }, { p_query: 'a\u0001' }, { p_document: 'x'.repeat(61) }, { p_kind: 'both' }, { p_page: 0 }, { p_limit: 101 }, { p_order: 'name' }])
    await assert.rejects(() => page(args), code('22023'), JSON.stringify(args));
});

test('109 API contract runs against real SQL and refuses inconsistent rows', async () => {
  const api = async (path, port = rpc) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`)), { userId: users.consulta, rpc: port });
  const value = await api(`/v1/financeiro/titles?page=1&kind=receivable&option=settled&date=settled&account=${bank.id}`);
  assert.deepEqual(value.items.map(item => item.description), ['Recebida com taxa']); assert.equal(value.option, 'settled'); assert.deepEqual(value.totals.fee_cents, '290');
  assert.deepEqual(value.items[0].payments, { settled_on: '2026-02-11', fee_cents: '290', interest_cents: '150', penalty_cents: '400', discount_cents: '50', settled_by_return: false });
  const open = await api(`/v1/financeiro/titles?page=1&kind=receivable&option=open&remittance=yes&category=${revenue.id},none`);
  assert.deepEqual(open.items.map(item => [item.description, item.remittance?.our_number]), [['Aberta banco', '12345678']]);
  const tamper = mutate => async (name, args) => { const result = await rpc(name, args); mutate(result); return result; };
  for (const mutate of [v => { v.option = 'open'; }, v => { v.totals.fee_cents = '1.5'; }, v => { v.items[0].payments.fee_cents = 1; }, v => { v.items[0].payments.settled_on = null; }, v => { v.items[0].account_name = 7; }, v => { v.items[0].remittance = { id: 'x' }; }, v => { v.items[0].status = 'cancelled'; v.items[0].cancelled = true; }])
    await assert.rejects(() => api('/v1/financeiro/titles?page=1&kind=receivable&option=settled&date=settled', tamper(mutate)), error => error.status === 502);
});
