import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';

// Synthetic data only. 110: every baixa belongs to a borderô; Baixa de lançamentos grouped or not; Excluir borderô reverses it.
let db; let users; let scalar; let rpc; let alfa; let beta; let bank; let cash; let revenue; let legacyBaixa;
const code = expected => error => error.code === expected;
const legacy = (action, data) => rpc('erp_finance_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const drawer = (action, data) => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const bordero = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_bordero_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const page = (args = {}, user = users.consulta) => rpc('erp_finance_bordero_page', { p_user_id: user, p_kind: 'receivable', p_limit: 100, ...args });
const create = async (description, extra = {}) => (await drawer('title_create', { kind: 'receivable', contact_id: alfa.id, description, issued_on: '2026-01-02', competence_on: '2026-01-01', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-02-10' }], ...extra })).items[0];
const line = (title, extra = {}) => ({ id: title.id, expected_version: title.version, account_id: bank.id, category_id: null, posted_on: '2026-02-15', principal_cents: title.balance_cents, interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0', ...extra });
const balance = async account => scalar('SELECT coalesce(sum(delta_cents),0)::text AS value FROM erp_finance.movement WHERE account_id=$1', [account]);

before(async () => {
  const env = await financeParityDb({ through: '202610200109_finance_title_page_v2.sql' });
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' }); beta = await env.contact({ name: 'Beta Sintética' });
  bank = (await legacy('account_save', { expected_version: 0, name: 'Banco sintético', kind: 'bank' })).record;
  cash = (await legacy('account_save', { expected_version: 0, name: 'Caixa sintético', kind: 'cash' })).record;
  revenue = (await legacy('category_save', { expected_version: 0, name: 'Serviços', kind: 'receivable' })).record;
  // A baixa made before 110 becomes a borderô of its own.
  const old = await create('Antes da 110');
  legacyBaixa = (await legacy('settle', { id: old.id, expected_version: 1, account_id: cash.id, posted_on: '2026-02-01', principal_cents: '10000', note: 'Baixa antiga' })).settlement;
  await env.load('202610200110_finance_bordero.sql');
});
after(async () => db?.close());

test('110 borderô RPCs are service-only security definer functions; tables are closed and roles rechecked', async () => {
  const fns = (await db.query("SELECT p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'erp_finance_bordero_%' ORDER BY 1")).rows;
  assert.deepEqual(fns.map(fn => [fn.proname, fn.prosecdef, fn.proconfig]), ['execute', 'get', 'page'].map(name => [`erp_finance_bordero_${name}`, true, ['search_path=pg_catalog']]));
  for (const signature of ['public.erp_finance_bordero_execute(uuid,uuid,text,jsonb)', 'public.erp_finance_bordero_page(uuid,text,integer,integer,text,uuid,text[],date,date,bigint,uuid)', 'public.erp_finance_bordero_get(uuid,uuid)']) {
    for (const role of ['anon', 'authenticated']) assert.equal(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') AS value", [role, signature]), false);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [signature]), true);
  }
  for (const table of ['erp_finance.bordero', 'erp_finance.bordero_item']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  for (const role of ['consulta', 'vendas', 'inactive']) await assert.rejects(() => bordero('settle_batch', { kind: 'receivable', grouped: false, items: [] }, users[role]), code('42501'));
  for (const role of ['vendas', 'estoque', 'inactive']) await assert.rejects(() => page({}, users[role]), code('42501'));
});

test('110 a baixa made before the migration and a 010 settle each get their own borderô', async () => {
  const listed = await page();
  const old = listed.items.find(item => item.id === legacyBaixa.id);
  assert.deepEqual([old.posted_on, old.account_name, old.note, old.grouped, old.items, old.contact_name, old.totals.paid_cents], ['2026-02-01', 'Caixa sintético', 'Baixa antiga', false, 1, 'Alfa Sintética', '10000']);
  const title = await create('Settle 010');
  const settled = await legacy('settle', { id: title.id, expected_version: 1, account_id: bank.id, posted_on: '2026-02-03', principal_cents: '4000', interest_cents: '100' });
  const item = (await db.query('SELECT bordero_id FROM erp_finance.bordero_item WHERE settlement_id=$1', [settled.settlement.id])).rows[0];
  const read = await rpc('erp_finance_bordero_get', { p_user_id: users.consulta, p_id: item.bordero_id });
  assert.deepEqual(read.record.lines.map(row => [row.contact_name, row.principal_cents, row.interest_cents, row.paid_cents, row.reversed]), [['Alfa Sintética', '4000', '100', '4100', false]]);
  await legacy('reverse', { id: title.id, expected_version: 2, settlement_id: settled.settlement.id, posted_on: '2026-02-04', note: 'Estorno sintético' });
  assert.equal((await page()).items.some(row => row.id === item.bordero_id), false, 'a fully reversed borderô leaves Gerenciar recebimentos');
  await assert.rejects(() => db.query("UPDATE erp_finance.bordero SET note='x' WHERE id=$1", [item.bordero_id]), /erp_finance_bordero_immutable/);
  await assert.rejects(() => db.query('DELETE FROM erp_finance.bordero_item WHERE settlement_id=$1', [settled.settlement.id]), /erp_finance_bordero_immutable/);
});

test('110 Baixa de lançamentos without grouping: one borderô and one movement per conta, with juros, multa, desconto and tarifa', async () => {
  const one = await create('Lote 1'), two = await create('Lote 2', { contact_id: beta.id, total_cents: '5000', installments: [{ amount_cents: '5000', due_on: '2026-02-10' }] });
  const before = await balance(bank.id), command = randomUUID();
  const data = { kind: 'receivable', grouped: false, note: 'Recebimento sintético', items: [line(one, { interest_cents: '150', penalty_cents: '200', discount_cents: '50', fee_cents: '290', category_id: revenue.id }), line(two, { account_id: cash.id, principal_cents: '2000' })] };
  const result = await bordero('settle_batch', data, users.financeiro, command);
  assert.equal(result.replayed, false); assert.equal(result.borderos.length, 2); assert.equal(result.items.length, 2);
  const [first, second] = [result.items.find(row => row.title.id === one.id), result.items.find(row => row.title.id === two.id)];
  assert.deepEqual([first.title.status, first.settlement.net_cash_cents, second.title.status, second.title.balance_cents], ['paid', '10010', 'partial', '3000']);
  assert.notEqual(first.bordero_id, second.bordero_id);
  assert.equal(BigInt(await balance(bank.id)) - BigInt(before), 10010n, 'principal + juros + multa − desconto − tarifa');
  const again = await bordero('settle_batch', data, users.financeiro, command);
  assert.equal(again.replayed, true); assert.deepEqual(again.items.map(row => row.settlement.id), result.items.map(row => row.settlement.id));
  await assert.rejects(() => bordero('settle_batch', { ...data, note: 'Outra' }, users.financeiro, command), code('40001'));
  const read = await rpc('erp_finance_bordero_get', { p_user_id: users.consulta, p_id: first.bordero_id });
  assert.deepEqual([read.record.category_name, read.record.lines[0].category_name, read.record.totals.paid_cents, read.record.totals.fee_cents, read.record.totals.net_cash_cents], ['Serviços', 'Serviços', '10300', '290', '10010']);
});

test('110 Lançamento agrupado: one borderô with one destino, date and categoria; refusals change nothing', async () => {
  const titles = [await create('Agrupada 1'), await create('Agrupada 2', { contact_id: beta.id })];
  const grouped = { kind: 'receivable', grouped: true, account_id: bank.id, category_id: revenue.id, note: 'Borderô agrupado', items: titles.map(title => line(title, { category_id: revenue.id })) };
  const count = async () => scalar('SELECT (SELECT count(*) FROM erp_finance.settlement)+(SELECT count(*) FROM erp_finance.bordero)+(SELECT count(*) FROM erp_finance.command) AS value');
  const baseline = await count();
  for (const bad of [{ ...grouped, items: [grouped.items[0]] }, { ...grouped, account_id: null }, { ...grouped, items: [grouped.items[0], { ...grouped.items[1], account_id: cash.id }] }, { ...grouped, items: [grouped.items[0], { ...grouped.items[1], posted_on: '2026-02-16' }] },
    { ...grouped, grouped: false }, { ...grouped, items: [grouped.items[0], grouped.items[0]] }, { ...grouped, items: [grouped.items[0], { ...grouped.items[1], principal_cents: '10001' }] }, { ...grouped, items: [grouped.items[0], { ...grouped.items[1], expected_version: 9 }] },
    { ...grouped, items: [grouped.items[0], { ...grouped.items[1], posted_on: '2099-01-01' }] }, { ...grouped, kind: 'payable' }, { ...grouped, items: Array.from({ length: 101 }, () => grouped.items[0]) }, { ...grouped, extra: true }])
    await assert.rejects(() => bordero('settle_batch', bad), error => ['22023', '40001', 'P0002'].includes(error.code), JSON.stringify(bad).slice(0, 80));
  assert.equal(await scalar('SELECT (SELECT count(*) FROM erp_finance.settlement)+(SELECT count(*) FROM erp_finance.bordero)+(SELECT count(*) FROM erp_finance.command) AS value'), baseline, 'a refused batch is atomic');
  const result = await bordero('settle_batch', grouped);
  assert.equal(result.borderos.length, 1); assert.deepEqual(new Set(result.items.map(row => row.bordero_id)).size, 1);
  const summary = result.borderos[0];
  assert.deepEqual([summary.grouped, summary.items, summary.contacts, summary.contact_name, summary.category_name, summary.account_name, summary.totals.paid_cents], [true, 2, 2, null, 'Serviços', 'Banco sintético', '20000']);
  const movements = await scalar('SELECT count(*)::int AS value FROM erp_finance.movement m JOIN erp_finance.bordero_item i ON i.settlement_id=m.settlement_id WHERE i.bordero_id=$1', [summary.id]);
  assert.equal(movements, 2, 'each baixa keeps its own movement, grouped by the borderô');
  const listed = await page({ p_account: bank.id, p_categories: [revenue.id] });
  assert.ok(listed.items.some(row => row.id === summary.id));
  assert.deepEqual((await page({ p_query: 'agrupado' })).items.map(row => row.id), [summary.id]);
  assert.deepEqual((await page({ p_title: titles[1].id })).items.map(row => row.id), [summary.id]);
  assert.deepEqual((await page({ p_amount_cents: '20000' })).items.map(row => row.id), [summary.id]);
});

test('110 Excluir borderô reverses each baixa with CAS and keeps the history', async () => {
  const titles = [await create('Excluir 1'), await create('Excluir 2')];
  const result = await bordero('settle_batch', { kind: 'receivable', grouped: true, account_id: bank.id, note: 'Para excluir', items: titles.map(title => line(title, { fee_cents: '100' })) });
  const target = result.borderos[0], before = await balance(bank.id);
  await assert.rejects(() => bordero('bordero_delete', { id: target.id, expected_version: 1, posted_on: '2026-02-20' }), code('22023'), 'a reason is required');
  await assert.rejects(() => bordero('bordero_delete', { id: target.id, expected_version: 2, posted_on: '2026-02-20', note: 'x' }), code('40001'));
  await assert.rejects(() => bordero('bordero_delete', { id: target.id, expected_version: 1, posted_on: '2026-02-14', note: 'Antes da baixa' }), code('22023'));
  await assert.rejects(() => bordero('bordero_delete', { id: target.id, expected_version: 1, posted_on: '2026-02-20', note: 'x' }, users.consulta), code('42501'));
  const removed = await bordero('bordero_delete', { id: target.id, expected_version: 1, posted_on: '2026-02-20', note: 'Baixa em duplicidade' });
  assert.equal(removed.items.length, 2); assert.ok(removed.items.every(row => row.title.status === 'open' && row.settlement.kind === 'reversal'));
  assert.equal(await balance(bank.id), (BigInt(before) - 19800n).toString(), 'the net cash of both baixas leaves the conta');
  assert.equal(removed.borderos[0].active, false); assert.match(removed.borderos[0].deleted_at, /^\d{4}-/);
  assert.equal((await page()).items.some(row => row.id === target.id), false);
  const read = await rpc('erp_finance_bordero_get', { p_user_id: users.consulta, p_id: target.id });
  assert.ok(read.record.lines.every(row => row.reversed)); assert.equal(read.record.totals.paid_cents, '0');
  await assert.rejects(() => bordero('bordero_delete', { id: target.id, expected_version: 2, posted_on: '2026-02-20', note: 'De novo' }), code('40001'));
  assert.equal(await scalar("SELECT count(*)::int AS value FROM erp_finance.audit WHERE action='bordero_delete'"), 1);
  // The titles can be settled again afterwards.
  const again = await bordero('settle_batch', { kind: 'receivable', grouped: false, items: [line({ ...titles[0], version: 3 })] });
  assert.equal(again.items[0].title.status, 'paid');
});

test('110 page totals and refusals', async () => {
  const all = await page();
  assert.equal(all.total, all.items.length); assert.deepEqual(Object.keys(all.totals).sort(), ['count', 'discount_cents', 'fee_cents', 'interest_cents', 'paid_cents', 'penalty_cents']);
  const days = all.items.map(row => row.posted_on); assert.deepEqual(days, [...days].sort().reverse(), 'newest first');
  assert.equal((await page({ p_kind: 'payable' })).total, 0);
  for (const args of [{ p_kind: 'both' }, { p_page: 0 }, { p_limit: 101 }, { p_query: 'a\u0001' }, { p_amount_cents: '0' }, { p_from: '2026-02-02', p_to: '2026-02-01' }, { p_categories: [] }, { p_categories: ['x'] }])
    await assert.rejects(() => page(args), code('22023'), JSON.stringify(args));
  await assert.rejects(() => rpc('erp_finance_bordero_get', { p_user_id: users.consulta, p_id: randomUUID() }), code('P0002'));
});
