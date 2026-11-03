import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeParityDb } from './helpers/finance-parity-db.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../src/finance.mjs';

// Synthetic data only. 135: Cadastros > Contas Financeiras and Categorias Financeiras (tree, defaults, move, import, split of "both").
let env; let db; let users; let scalar; let rpc; let alfa; let legacyBank; let both; let payableTitle; let deletedPayable; let receivableTitle; let borderoId;
const code = expected => error => error.code === expected;
const legacy = (action, data, user = users.financeiro) => rpc('erp_finance_execute', { p_user_id: user, p_command_id: randomUUID(), p_action: action, p_data: data });
const drawer = (action, data) => rpc('erp_finance_title_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
const account = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_account_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const category = (action, data, user = users.financeiro, command = randomUUID()) => rpc('erp_finance_category_execute', { p_user_id: user, p_command_id: command, p_action: action, p_data: data });
const accounts = (args = {}, user = users.consulta) => rpc('erp_finance_account_page', { p_user_id: user, p_page: 1, p_limit: 100, ...args });
const tree = (kind, user = users.consulta) => rpc('erp_finance_category_tree', { p_user_id: user, p_kind: kind });
const title = async (kind, description, extra = {}) => (await drawer('title_create', { kind, contact_id: alfa.id, description, issued_on: '2026-01-02', competence_on: '2026-01-02', total_cents: '10000', installments: [{ amount_cents: '10000', due_on: '2026-02-10' }], ...extra })).items[0];
const bankData = (extra = {}) => ({ account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú sintético', agency: '1234', account_number: '56789', account_digit: '0', start_on: '2026-01-05', opening_cents: '150000', default_movements: false, ...extra });
const worker = async (path, init = {}, user = users.financeiro) => executeFinanceRoute(await parseFinanceRoute(new Request(`https://api.example.test${path}`, init.body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {})), { userId: user, rpc: (name, args) => rpc(name, args) });

before(async () => {
  env = await financeParityDb({ through: '202610200134' });
  ({ db, users, scalar, rpc } = env); await env.addUsers();
  alfa = await env.contact({ name: 'Alfa Sintética' });
  legacyBank = (await legacy('account_save', { expected_version: 0, name: 'Banco legado com um nome bem longo que passa dos cinquenta caracteres', kind: 'bank' })).record;
  both = (await legacy('category_save', { expected_version: 0, name: 'Serviços gerais', kind: 'both' })).record;
  payableTitle = await title('payable', 'Pagar com both', { category_id: both.id });
  receivableTitle = await title('receivable', 'Receber com both', { category_id: both.id });
  deletedPayable = await title('payable', 'Excluída', { category_id: both.id });
  await drawer('title_delete', { id: deletedPayable.id, expected_version: 1, note: 'Teste' });
  const settled = await rpc('erp_finance_bordero_execute', { p_user_id: users.financeiro, p_command_id: randomUUID(), p_action: 'settle_batch', p_data: { kind: 'payable', grouped: false, items: [{ id: payableTitle.id, expected_version: 1, account_id: legacyBank.id, category_id: both.id, posted_on: '2026-02-11', principal_cents: '10000', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }] } });
  borderoId = settled.items[0].bordero_id;
  await env.load('202610200135_finance_accounts_categories.sql');
});
after(async () => db?.close());

test('135 RPCs are service-only security definer functions; new tables are closed and roles are checked', async () => {
  const names = ['erp_finance_account_page', 'erp_finance_account_detail', 'erp_finance_account_execute', 'erp_finance_category_tree', 'erp_finance_category_execute', 'erp_finance_list'];
  const fns = (await db.query("SELECT p.proname,p.prosecdef,p.proconfig,p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1) ORDER BY 1", [names])).rows;
  assert.equal(fns.length, names.length);
  for (const fn of fns) {
    assert.deepEqual([fn.prosecdef, fn.proconfig], [true, ['search_path=pg_catalog']], fn.proname);
    for (const role of ['anon', 'authenticated', 'public']) assert.equal(await scalar(`SELECT has_function_privilege(${role === 'public' ? "'public'" : '$2'},$1,'EXECUTE') AS value`, role === 'public' ? [fn.signature] : [fn.signature, role]), false, `${fn.proname} ${role}`);
    assert.equal(await scalar("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS value", [fn.signature]), true);
  }
  for (const table of ['erp_finance.category_default', 'erp_finance.category_split']) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar("SELECT has_table_privilege($1,$2,'SELECT') AS value", [role, table]), false);
  for (const role of ['consulta', 'vendas', 'inactive']) {
    await assert.rejects(() => account('account_create', bankData(), users[role]), code('42501'));
    await assert.rejects(() => category('category_create', { kind: 'receivable', name: 'X' }, users[role]), code('42501'));
  }
  for (const role of ['vendas', 'estoque', 'fiscal', 'inactive']) { await assert.rejects(() => accounts({}, users[role]), code('42501')); await assert.rejects(() => tree('receivable', users[role]), code('42501')); }
});

test('135 splits every "both" category: the twin takes the other kind, titles and borderôs, including deleted contas', async () => {
  const split = (await db.query('SELECT * FROM erp_finance.category_split')).rows;
  assert.equal(split.length, 1); assert.equal(split[0].original_id, both.id);
  assert.deepEqual([split[0].original_kind, split[0].twin_kind, split[0].titles, split[0].borderos], ['receivable', 'payable', 2, 1]);
  const kinds = (await db.query('SELECT id,kind,name FROM erp_finance.category ORDER BY kind')).rows;
  assert.deepEqual(kinds.map(row => [row.kind, row.name]), [['payable', 'Serviços gerais'], ['receivable', 'Serviços gerais']]);
  const twin = split[0].twin_id;
  const titles = (await db.query('SELECT id,category_id,version FROM erp_finance.title ORDER BY description')).rows;
  assert.deepEqual(Object.fromEntries(titles.map(row => [row.id, row.category_id])), { [payableTitle.id]: twin, [receivableTitle.id]: both.id, [deletedPayable.id]: twin });
  assert.equal(await scalar('SELECT category_id::text AS value FROM erp_finance.bordero_item i JOIN erp_finance.settlement s ON s.id=i.settlement_id WHERE s.title_id=$1', [payableTitle.id]), twin);
  assert.equal(await scalar('SELECT category_id::text AS value FROM erp_finance.bordero WHERE id=$1', [borderoId]), twin);
  // From now on a category is Receita or Despesa; the 010 writer can no longer create "both".
  await assert.rejects(() => legacy('category_save', { expected_version: 0, name: 'Ambas', kind: 'both' }), error => error.code === '23514');
  // Borderôs stay immutable outside a reclassification.
  await assert.rejects(() => db.query('UPDATE erp_finance.bordero SET category_id=NULL WHERE id=$1', [borderoId]), code('55000'));
});

test('135 contas financeiras: create with opening on the start date, Origin types, default account swap, CAS and idempotent replay', async () => {
  // A legacy account becomes "Conta Corrente"; the 010 writer still works and keeps the type in step.
  const page = await accounts();
  assert.deepEqual(page.items.map(item => [item.name.slice(0, 11), item.account_type, item.boleto, item.start_on]), [['Banco legad', 'checking', 'none', null]]);
  const cash = (await legacy('account_save', { expected_version: 0, name: 'Caixa legado', kind: 'cash' })).record;
  assert.equal((await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: cash.id })).record.account_type, 'cash');
  for (const bad of [{ account_type: 'integration' }, { account_type: 'checking', agency: null }, { institution_code: null, institution_name: null }, { name: 'x'.repeat(51) },
    { start_on: '2999-01-01' }, { opening_cents: '1.00' }, { opening_cents: undefined }, { unknown: 1 }, { agency: '12/3' }]) {
    const data = bankData(bad); for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
    await assert.rejects(() => account('account_create', data), code('22023'), JSON.stringify(bad));
  }
  const command = randomUUID();
  const created = await account('account_create', bankData({ default_movements: true }), users.financeiro, command);
  assert.deepEqual([created.record.kind, created.record.account_type, created.record.opening_cents, created.record.balance_cents, created.record.start_on, created.record.default_movements, created.record.in_use],
    ['bank', 'checking', '150000', '150000', '2026-01-05', true, true]);
  assert.deepEqual(await scalar("SELECT jsonb_build_object('kind',kind,'delta',delta_cents::text,'on',posted_on::text,'note',note) AS value FROM erp_finance.movement WHERE account_id=$1", [created.record.id]), { kind: 'opening', delta: '150000', on: '2026-01-05', note: 'Saldo inicial' });
  assert.equal((await account('account_create', bankData({ default_movements: true }), users.financeiro, command)).replayed, true);
  await assert.rejects(() => account('account_create', bankData({ name: 'Outro' }), users.financeiro, command), code('40001'));
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.account WHERE name=$1', ['Itaú sintético']), 1);
  // A movement before the start date is refused for every writer (here the 010 baixa).
  const early = await title('receivable', 'Antes do início');
  await assert.rejects(() => legacy('settle', { id: early.id, expected_version: 1, account_id: created.record.id, posted_on: '2026-01-04', principal_cents: '100' }), code('22023'));
  await legacy('settle', { id: early.id, expected_version: 1, account_id: created.record.id, posted_on: '2026-01-05', principal_cents: '100' });
  // Only one "padrão de movimentações": marking another one swaps atomically.
  const savings = await account('account_create', bankData({ account_type: 'savings', name: 'Poupança', institution_code: '001', institution_name: 'Banco do Brasil', agency: '9', account_number: '1', account_digit: 'X', opening_cents: '-1', start_on: '2026-01-01' }));
  const swapped = await account('account_set_default', { id: savings.record.id, expected_version: 1, target: 'movements', value: true });
  assert.equal(swapped.record.default_movements, true);
  assert.equal(await scalar('SELECT count(*)::int AS value FROM erp_finance.account WHERE default_movements'), 1);
  assert.equal((await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: created.record.id })).record.default_movements, false);
  await assert.rejects(() => account('account_set_default', { id: savings.record.id, expected_version: 1, target: 'movements', value: false }), code('40001'));
  // Padrão boleto needs a CNAB profile of a bank account.
  await assert.rejects(() => account('account_set_default', { id: savings.record.id, expected_version: 2, target: 'boleto', value: true }), code('22023'));
});

test('135 contas financeiras: update rules, inactivate, delete only unused, filters, total and pages', async () => {
  const page = await accounts({ p_query: 'itaú sint' });
  const itau = page.items[0];
  // Old long names stay until edited; a new name has at most 50 characters (Origin Descrição).
  const legacyRow = (await accounts({ p_query: 'legado com' })).items[0];
  const kept = await account('account_update', { id: legacyRow.id, expected_version: legacyRow.version, account_type: 'checking', institution_code: '237', institution_name: 'Bradesco', name: legacyRow.name, agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-01', opening_cents: '500' });
  assert.deepEqual([kept.record.name, kept.record.opening_cents, kept.record.institution_name, kept.record.start_on], [legacyRow.name, '500', 'Bradesco', '2026-01-01']);
  await assert.rejects(() => account('account_update', { id: legacyRow.id, expected_version: kept.record.version, account_type: 'checking', institution_code: '237', institution_name: 'Bradesco', name: `${legacyRow.name}!`, agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-01' }), code('22023'));
  await assert.rejects(() => account('account_update', { id: legacyRow.id, expected_version: kept.record.version, account_type: 'checking', institution_code: '237', institution_name: 'Bradesco', name: 'Bradesco', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-01', opening_cents: '1' }), code('40001'));
  // The start date cannot pass the first movement (the legacy baixa of 11/02 and the opening of 01/01).
  await assert.rejects(() => account('account_update', { id: legacyRow.id, expected_version: kept.record.version, account_type: 'checking', institution_code: '237', institution_name: 'Bradesco', name: 'Bradesco', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-02' }), code('22023'));
  await assert.rejects(() => account('account_update', { id: itau.id, expected_version: itau.version + 5, account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: 'Itaú', agency: '1', account_number: '2', account_digit: '3', start_on: '2026-01-01' }), code('40001'));
  // Inativar removes the account from the defaults.
  const inactive = await account('account_set_active', { id: itau.id, expected_version: itau.version, active: false });
  assert.deepEqual([inactive.record.active, inactive.record.default_movements], [false, false]);
  assert.deepEqual((await accounts({ p_active: false })).items.map(item => item.id), [itau.id]);
  assert.deepEqual((await accounts({ p_types: ['savings'] })).items.map(item => item.name), ['Poupança']);
  await assert.rejects(() => accounts({ p_types: ['bank'] }), code('22023'));
  // Excluir: only an account without any use; it then leaves the lists, also the 010 cursor list.
  await assert.rejects(() => account('account_delete', { id: itau.id, expected_version: inactive.record.version }), code('40001'));
  const empty = await account('account_create', bankData({ account_type: 'other', name: 'Outra', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, opening_cents: '0' }));
  assert.equal(empty.record.in_use, true, 'the opening movement is a use');
  const loose = (await legacy('account_save', { expected_version: 0, name: 'Sem uso', kind: 'other' })).record;
  const deleted = await account('account_delete', { id: loose.id, expected_version: 1 });
  assert.deepEqual(deleted.record, { id: loose.id, deleted: true });
  assert.equal((await accounts({ p_query: 'sem uso' })).total, 0);
  await assert.rejects(() => rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: loose.id }), code('P0002'));
  const listed = await rpc('erp_finance_list', { p_user_id: users.consulta, p_entity: 'accounts', p_limit: 100 });
  assert.equal(listed.items.some(item => item.id === loose.id), false);
  await assert.rejects(() => legacy('account_save', { id: loose.id, expected_version: 2, name: 'Volta', kind: 'other' }), code('40001'));
  const all = await accounts({ p_limit: 2 });
  assert.equal(all.items.length, 2); const second = await accounts({ p_page: 2, p_limit: 2 });
  assert.equal(all.total, second.total); assert.equal(new Set([...all.items, ...second.items].map(item => item.id)).size, all.items.length + second.items.length);
});

test('135 categorias: tree depth per tab, DRE group on main categories, unique siorigins, inactivate subtree and delete rules', async () => {
  const sales = await category('category_create', { kind: 'receivable', name: 'Vendas', dre_group: 'gross_revenue' });
  const products = await category('category_create', { kind: 'receivable', parent_id: sales.record.id, name: 'Vendas de produtos' });
  assert.deepEqual([products.record.depth, products.record.parent_id, products.record.dre_group], [2, sales.record.id, null]);
  await assert.rejects(() => category('category_create', { kind: 'receivable', parent_id: products.record.id, name: 'Neta' }), code('22023'));
  await assert.rejects(() => category('category_create', { kind: 'receivable', parent_id: sales.record.id, name: 'X', dre_group: 'gross_revenue' }), code('22023'));
  await assert.rejects(() => category('category_create', { kind: 'receivable', name: 'vendas' }), code('23505'));
  await assert.rejects(() => category('category_create', { kind: 'payable', parent_id: sales.record.id, name: 'Outro tipo' }), code('22023'));
  await assert.rejects(() => category('category_create', { kind: 'payable', name: 'Despesa', dre_group: 'gross_revenue' }), code('22023'));
  const admin = await category('category_create', { kind: 'payable', name: 'Despesas administrativas', dre_group: 'operating_expenses' });
  const rent = await category('category_create', { kind: 'payable', parent_id: admin.record.id, name: 'Aluguel' });
  const office = await category('category_create', { kind: 'payable', parent_id: rent.record.id, name: 'Escritório' });
  assert.equal(office.record.depth, 3, 'despesas allow one more level');
  await assert.rejects(() => category('category_create', { kind: 'payable', parent_id: office.record.id, name: 'Quarto nível' }), code('22023'));
  // Inativar a categoria inativa as subcategorias; reativar uma subcategoria exige o pai ativo.
  await category('category_set_active', { id: admin.record.id, expected_version: 1, active: false });
  const payable = await tree('payable');
  assert.deepEqual(payable.items.filter(item => [admin, rent, office].some(row => row.record.id === item.id)).map(item => item.active), [false, false, false]);
  await assert.rejects(() => category('category_set_active', { id: rent.record.id, expected_version: 2, active: true }), code('40001'));
  await assert.rejects(() => category('category_create', { kind: 'payable', parent_id: admin.record.id, name: 'Sob inativa' }), code('40001'));
  // Excluir: only without subcategorias and without use; then it leaves the tree.
  await assert.rejects(() => category('category_delete', { id: rent.record.id, expected_version: 2 }), code('40001'));
  const removed = await category('category_delete', { id: office.record.id, expected_version: 2 });
  assert.deepEqual(removed.record, { id: office.record.id, deleted: true });
  assert.equal((await tree('payable')).items.some(item => item.id === office.record.id), false);
  const used = (await tree('receivable')).items.find(item => item.id === both.id);
  assert.equal(used.in_use, true);
  await assert.rejects(() => category('category_delete', { id: both.id, expected_version: used.version }), code('40001'));
  const renamed = await category('category_update', { id: sales.record.id, expected_version: 1, name: 'Vendas e serviços', dre_group: 'other_revenue' });
  assert.deepEqual([renamed.record.name, renamed.record.dre_group, renamed.record.version], ['Vendas e serviços', 'other_revenue', 2]);
  await assert.rejects(() => category('category_update', { id: products.record.id, expected_version: 1, name: 'X', dre_group: 'gross_revenue' }), code('22023'));
});

test('135 categorias: mover lançamentos, categorias padrão por tipo and import with parents first', async () => {
  const receivable = await tree('receivable');
  const target = await category('category_create', { kind: 'receivable', name: 'Destino' });
  await assert.rejects(() => category('category_move', { id: both.id, expected_version: receivable.items.find(item => item.id === both.id).version, target_id: target.record.id }), code('22023'));
  const moved = await category('category_move', { id: both.id, expected_version: receivable.items.find(item => item.id === both.id).version, target_id: target.record.id, confirmed: true });
  assert.deepEqual(moved.moved, { titles: 1, borderos: 0, settlements: 0, movements: 0 });
  assert.equal(await scalar('SELECT category_id::text AS value FROM erp_finance.title WHERE id=$1', [receivableTitle.id]), target.record.id);
  const twin = (await db.query('SELECT twin_id FROM erp_finance.category_split')).rows[0].twin_id;
  const expense = await category('category_create', { kind: 'payable', name: 'Destino despesa' });
  await assert.rejects(() => category('category_move', { id: twin, expected_version: 1, target_id: target.record.id, confirmed: true }), code('22023'), 'different tab');
  const movedPayable = await category('category_move', { id: twin, expected_version: 1, target_id: expense.record.id, confirmed: true });
  assert.deepEqual(movedPayable.moved, { titles: 1, borderos: 1, settlements: 1, movements: 0 }, 'deleted contas keep their category');
  assert.equal(await scalar('SELECT category_id::text AS value FROM erp_finance.title WHERE id=$1', [deletedPayable.id]), twin);
  // Categorias padrão: one category per key, of the kind of the key.
  const defaults = (await tree('payable')).defaults;
  await assert.rejects(() => category('category_set_default', { key: 'receipt_fees', category_id: target.record.id, expected_version: defaults.receipt_fees.version }), code('22023'));
  const set = await category('category_set_default', { key: 'receipt_fees', category_id: expense.record.id, expected_version: defaults.receipt_fees.version });
  assert.deepEqual(set.record, { key: 'receipt_fees', category_id: expense.record.id, version: 2 });
  assert.deepEqual((await tree('payable')).items.find(item => item.id === expense.record.id).defaults, ['receipt_fees']);
  await assert.rejects(() => category('category_delete', { id: expense.record.id, expected_version: 1 }), code('40001'));
  await assert.rejects(() => category('category_set_default', { key: 'receipt_fees', category_id: null, expected_version: 1 }), code('40001'));
  // Importar: parents before children; a name that already exists at the same level is skipped; an unknown parent fails the whole file.
  const imported = await category('category_import', { kind: 'payable', rows: [{ name: 'Despesas com pessoal', dre_group: 'operating_expenses' }, { name: 'Salários', parent: 'Despesas com pessoal' }, { name: 'Destino despesa' }] });
  assert.deepEqual([imported.created.length, imported.skipped], [2, 1]);
  await assert.rejects(() => category('category_import', { kind: 'payable', rows: [{ name: 'Nova' }, { name: 'Filha', parent: 'Inexistente' }] }), code('22023'));
  assert.equal((await tree('payable')).items.some(item => item.name === 'Nova'), false, 'all or nothing');
});

test('135 Worker contract: strict queries and bodies before any RPC; responses are projected and checked against SQL', async () => {
  for (const path of ['/v1/financeiro/contas-financeiras?page=0', '/v1/financeiro/contas-financeiras?page=1&tipos=bank', '/v1/financeiro/contas-financeiras?page=1&situacao=todos',
    '/v1/financeiro/contas-financeiras?page=1&page=2', '/v1/financeiro/contas-financeiras?page=1&x=1', '/v1/financeiro/categorias-arvore?kind=both', '/v1/financeiro/categorias-arvore']) {
    await assert.rejects(() => parseFinanceRoute(new Request(`https://api.example.test${path}`)), error => error.status === 400, path);
  }
  const page = await worker('/v1/financeiro/contas-financeiras?page=1&situacao=ativo&tipos=checking,savings');
  assert.ok(page.items.length >= 1 && page.items.every(item => item.active && ['checking', 'savings'].includes(item.account_type)));
  const detail = await worker(`/v1/financeiro/contas-financeiras/${page.items[0].id}`);
  assert.equal(detail.record.id, page.items[0].id);
  const receivable = await worker('/v1/financeiro/categorias-arvore?kind=receivable', {}, users.consulta);
  assert.ok(receivable.items.length > 0 && receivable.items.every(item => item.kind === 'receivable'));
  assert.equal(Object.keys(receivable.defaults).length, 11);
  const created = await worker('/v1/financeiro/actions/category_create', { body: { command_id: randomUUID(), data: { kind: 'receivable', name: 'Pela API' } } });
  assert.deepEqual([created.action, created.record.name, created.record.depth], ['category_create', 'Pela API', 1]);
  for (const body of [{ command_id: randomUUID(), data: { kind: 'receivable', name: 'x'.repeat(101) } }, { command_id: randomUUID(), data: { kind: 'receivable', name: 'A', parent_id: 'x' } },
    { command_id: 'x', data: { kind: 'receivable', name: 'A' } }, { command_id: randomUUID(), data: { kind: 'receivable', name: 'A' }, extra: 1 }]) {
    await assert.rejects(() => parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/category_create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })), error => error.status === 400);
  }
  await assert.rejects(() => parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/account_unknown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command_id: randomUUID(), data: {} }) })), error => error.status === 404);
  // A tampered upstream answer is refused.
  const route = await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/contas-financeiras?page=1&situacao=inativo'));
  const real = await rpc(route.rpc, { p_user_id: users.consulta, ...route.args });
  const tampered = structuredClone(real); tampered.items.push({ ...structuredClone(page.items[0]) }); tampered.total += 1;
  await assert.rejects(() => executeFinanceRoute(route, { userId: users.consulta, rpc: async () => tampered }), error => error.status === 502);
  const treeRoute = await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/categorias-arvore?kind=payable'));
  const orphan = await rpc(treeRoute.rpc, { p_user_id: users.consulta, ...treeRoute.args }); orphan.items[0].parent_id = randomUUID(); orphan.items[0].depth = 2;
  await assert.rejects(() => executeFinanceRoute(treeRoute, { userId: users.consulta, rpc: async () => orphan }), error => error.status === 502);
});

test('135 padrão boleto needs the cobrança bancária of the account; agência, conta and DV must match its CNAB profile', async () => {
  const one = await account('account_create', bankData({ name: 'Cobrança 1', agency: '0001', account_number: '11111', account_digit: '1', start_on: '2026-01-01', opening_cents: '0' }));
  const two = await account('account_create', bankData({ name: 'Cobrança 2', agency: '0002', account_number: '22222', account_digit: '2', start_on: '2026-01-01', opening_cents: '0' }));
  for (const [row, n] of [[one, 1], [two, 2]]) await db.query("INSERT INTO erp_cnab.profile(account_id,identity,settings,account_scope,next_sequence) VALUES($1,$2,'{}'::jsonb,$3,1)", [row.record.id, JSON.stringify({ bank: '341', agency: `000${n}`, account: `${n}`.repeat(5), accountDigit: `${n}` }), `scope-${n}`]);
  const base = (row, extra = {}) => ({ id: row.record.id, expected_version: row.record.version, account_type: 'checking', institution_code: '341', institution_name: 'Itaú Unibanco', name: row.record.name, agency: row.record.agency, account_number: row.record.account_number, account_digit: row.record.account_digit, start_on: '2026-01-01', ...extra });
  await assert.rejects(() => account('account_update', base(one, { agency: '9999', default_boleto: true })), code('22023'), 'agência different from the CNAB profile');
  const first = await account('account_update', base(one, { default_boleto: true }));
  assert.deepEqual([first.record.default_boleto, first.record.boleto, first.record.cnab.agency], [true, 'default', '0001']);
  const second = await account('account_set_default', { id: two.record.id, expected_version: two.record.version, target: 'boleto', value: true });
  assert.equal(second.record.boleto, 'default');
  assert.deepEqual((await rpc('erp_finance_account_detail', { p_user_id: users.consulta, p_id: one.record.id })).record.boleto, 'active', 'only one padrão boleto');
  await assert.rejects(() => account('account_update', base(two, { expected_version: second.record.version, account_type: 'other', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null })), code('22023'), 'a cobrança account stays a bank account');
});
