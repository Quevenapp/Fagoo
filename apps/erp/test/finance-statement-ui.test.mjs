import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { runBatch } from '../src/lib/origin-batch.ts';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { presetRange } from '../src/lib/origin-list.ts';
import { statementApiPath, statementRoute, statementRows, statementPage } from '../src/lib/finance-statement-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 136: Caixas e bancos (extrato, lançamento, transferência, ajuste, exclusão, categorias) e Ficha financeira.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', TODAY = todaySP(), MONTH = presetRange('este-mes', TODAY);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const children = (view, name) => view.nodes().filter(node => typeof node.type === 'function' && node.type.name === name);
// Modal is rendered (expanded); its action buttons come after the list, so the last button with the label is the modal one.
const modalButton = async (view, label) => { const found = view.nodes().filter(node => node.type === 'button' && text(node) === label).at(-1); assert.ok(found, `modal button ${label}`); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const menuOf = (view, label) => children(view, 'RowMenu').find(menu => menu.props.label === label);
const tool = (view, title) => view.find(node => typeof node.type === 'function' && node.type.name === 'ToolButton' && node.props.title === title);
const CAIXA = id(1), BANCO = id(2), RECEITA = id(10), DESPESA = id(20);
const account = (n, extra = {}) => ({ id: id(n), name: n === 1 ? 'Caixa da loja' : 'Banco sintético', kind: n === 1 ? 'cash' : 'bank', account_type: n === 1 ? 'cash' : 'checking', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, start_on: '2026-01-01', active: true,
  default_movements: n === 1, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: n === 1 ? '50000' : '1000', first_movement_on: '2026-01-01', in_use: true, cnab: null, version: 1, created_at: 'x', updated_at: 'x', ...extra });
const line = (n, extra = {}) => ({ line_id: id(100 + n), line_kind: 'entry', posted_on: MONTH.from, competence_on: MONTH.from, account_id: CAIXA, account_name: 'Caixa da loja', amount_cents: '-1500', category_id: DESPESA, category_name: 'Limpeza', contact_id: null, contact_name: null, note: `Lançamento ${n}`,
  title_id: null, title_kind: null, document: null, transfer_id: null, entry_id: id(100 + n), entry_version: 2, entry_origin: 'manual', ...extra });
const LINES = [line(1), line(2, { line_kind: 'settlement', amount_cents: '3000', category_id: RECEITA, category_name: 'Vendas', contact_name: 'Alfa', title_id: id(300), title_kind: 'receivable', document: { kind: 'sales_orders', number: '77' }, entry_id: null, entry_version: null, entry_origin: null, note: 'Venda 77' }),
  line(3, { line_kind: 'transfer', amount_cents: '-500', transfer_id: id(400), entry_id: null, entry_version: null, entry_origin: null, note: 'Transferência Caixa da loja -> Banco sintético', posted_on: MONTH.to }),
  line(4, { line_kind: 'opening', amount_cents: '10000', category_id: null, category_name: null, entry_id: null, entry_version: null, entry_origin: null, note: 'Saldo inicial', posted_on: MONTH.to })];
function server({ role = 'financeiro', post = call => ({ action: call.path.split('/').at(-1), replayed: false, entity: 'cash_entries', record: { id: id(900), note: call.body.data.note ?? 'x' }, data_mode: 'erp_native' }), before, lines = LINES } = {}) {
  const calls = [], listeners = new Set(), state = { session: { phase: 'ready', membership: { user_id: actor, role } } };
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async catalog(path) { if (path === '/v1/cadastros') return { write: ['contacts'] }; return { entity: 'contacts', items: [], limit: 10, has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      const injected = await before?.(call); if (injected !== undefined) return injected;
      if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 2, items: [account(1), account(2)], data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), [{ id: RECEITA, name: 'Vendas', kind: 'receivable' }, { id: DESPESA, name: 'Limpeza', kind: 'payable' }]);
      if (url.pathname === '/v1/financeiro/extrato') {
        const tab = url.searchParams.get('tab'), deleted = url.searchParams.get('deleted') === 'true', items = lines.filter(item => (tab === 'all' || (tab === 'in') === !item.amount_cents.startsWith('-')) && (!url.searchParams.get('account') || item.account_id === url.searchParams.get('account')));
        const shown = deleted ? items.filter(item => ['entry', 'transfer'].includes(item.line_kind)) : items, days = [...new Set(shown.map(item => item.posted_on))];
        return { entity: 'statement', account_id: url.searchParams.get('account'), from: url.searchParams.get('from'), to: url.searchParams.get('to'), tab, deleted, order: url.searchParams.get('order'), page: Number(url.searchParams.get('page')), limit: Number(url.searchParams.get('limit')), total: shown.length,
          items: structuredClone(shown), day_balances: deleted ? {} : Object.fromEntries(days.map((day, index) => [day, String(40000 + index * 1000)])), summary: { before_cents: '39000', previous_cents: '39000', in_cents: '13000', out_cents: '2000', closing_cents: '50000', current_cents: '50000' }, data_mode: 'erp_native' };
      }
      const entry = /^\/v1\/financeiro\/lancamentos\/(.+)$/.exec(url.pathname);
      if (entry) return { entity: 'cash_entries', record: { id: entry[1], account_id: CAIXA, account_name: 'Caixa da loja', kind: 'out', amount_cents: '1500', posted_on: MONTH.from, competence_on: MONTH.from, category_id: DESPESA, category_name: 'Limpeza', contact_id: null, contact_name: null, note: 'Lançamento 1', origin: 'manual', version: 2, deleted: false, created_at: 'x', updated_at: 'x' }, data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/ficha') return { entity: 'contact_ledger', contact_id: url.searchParams.get('contact'), contact_name: 'Alfa Sintética', scope: url.searchParams.get('scope'), from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        items: [{ day: `${TODAY.slice(0, 4)}-02-01`, line_kind: 'title', ref_id: id(300), kind: 'receivable', note: 'Venda 77', due_on: `${TODAY.slice(0, 4)}-03-01`, side: 'debit', amount_cents: '3000', situation: 'paid', origin: { kind: 'sales_orders', number: '77' }, version: null },
          { day: `${TODAY.slice(0, 4)}-03-01`, line_kind: 'payment', ref_id: id(301), kind: 'receivable', note: 'Venda 77', due_on: null, side: 'credit', amount_cents: '3000', situation: null, origin: null, version: null },
          { day: `${TODAY.slice(0, 4)}-04-01`, line_kind: 'entry', ref_id: id(302), kind: 'receivable', note: 'Adiantamento', due_on: null, side: 'credit', amount_cents: '700', situation: null, origin: null, version: 1 }],
        totals: { debit_cents: '3000', credit_cents: '3700', balance_cents: '700' }, page: Number(url.searchParams.get('page')), limit: Number(url.searchParams.get('limit')), total: 3, data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), statements: () => calls.filter(call => call.path.startsWith('/v1/financeiro/extrato')), setSession(next) { state.session = next; for (const listener of listeners) listener(); } };
}
const EXPAND = ['NativeListLayout', 'Field', 'BusyGuard', 'CashEntryDrawer', 'TransferModal', 'AdjustModal', 'Modal', 'CategoryTreePicker', 'TreeList', 'CategoryTreeFilter'];
const mount = (source, location = '/financeiro-empresa?area=accounts') => mountComponent('FinanceStatement.tsx', { controller: source.controller }, { location, expandChildren: EXPAND });

test('136 extrato model: URL of Caixas e bancos, API path accepted by the Worker and the Origin balance rows', async () => {
  const route = statementRoute(new URLSearchParams('area=accounts&aba=saidas&categoria=none&ordem=desc'), TODAY);
  assert.deepEqual([route.from, route.to, route.aba, route.situacao, route.categoria, route.ordem], [MONTH.from, MONTH.to, 'saidas', 'registrados', ['none'], 'desc']);
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${statementApiPath(route)}`));
  assert.deepEqual([parsed.args.p_tab, parsed.args.p_categories, parsed.args.p_order, parsed.args.p_deleted], ['out', ['none'], 'desc', false]);
  for (const bad of ['aba=x', 'situacao=x', 'conta=1', 'from=2026-02-30', 'valor=0', 'ordem=x']) assert.throws(() => statementRoute(new URLSearchParams(bad), TODAY), /inválidos/, bad);
  const asc = statementRoute(new URLSearchParams(''), TODAY), source = server(), value = await source.controller.finance(statementApiPath(asc));
  const page = statementPage(value, asc);
  assert.deepEqual(statementRows(page, asc, 1).map(row => row.type === 'balance' ? row.label : row.line.note), ['Saldo anterior', 'Lançamento 1', 'Venda 77', `Saldo em ${MONTH.from.split('-').reverse().join('/')}`, 'Transferência Caixa da loja -> Banco sintético', 'Saldo inicial', `Saldo em ${MONTH.to.split('-').reverse().join('/')}`]);
  assert.throws(() => statementPage({ ...value, tab: 'in' }, asc), /conferir/);
});

test('136 Caixas e bancos lists this month with badges, balances, Informações and the ⋮ by origin; tabs and filters go to the URL', async () => {
  const source = server(), view = await mount(source);
  try {
    assert.equal(source.statements()[0].path, `/v1/financeiro/extrato?from=${MONTH.from}&to=${MONTH.to}&tab=all&deleted=false&order=asc&page=1&limit=100`);
    assert.match(view.text(), /Saldo anterior: R\$ 390,00/); assert.match(view.text(), /- R\$ 15,00/); assert.match(view.text(), /Saldo atual de todas as contasR\$ 500,00/);
    assert.equal(children(view, 'IndicatorLetter')[0].props.text, 'V', 'baixa of a pedido de venda');
    assert.deepEqual(menuOf(view, 'Lançamento 1').props.items.map(item => item.label), ['Imprimir comprovante', 'Excluir']);
    assert.deepEqual(menuOf(view, 'Venda 77').props.items.map(item => item.label), ['Imprimir comprovante', 'Abrir conta'], 'a baixa is undone in the conta');
    assert.deepEqual(menuOf(view, 'Saldo inicial da conta').props.items.map(item => item.label), ['Imprimir comprovante']);
    assert.equal(view.nodes().some(node => node.type === 'button' && text(node).includes('Ajustar saldos') && !node.disabled), false, 'Ajustar saldos needs one conta');
    await view.click('Entradas'); assert.equal(view.location().search, '?area=accounts&aba=entradas'); assert.match(source.statements().at(-1).path, /tab=in/);
    await view.change('statement-situation-excluidos', true); await view.submit();
    assert.equal(view.location().search, '?area=accounts&aba=entradas&situacao=excluidos'); assert.match(source.statements().at(-1).path, /deleted=true/);
    assert.ok(source.calls.every(call => !call.method), 'reading never writes');
  } finally { view.unmount(); }
});

test('136 + Incluir lançamento: categories follow the Tipo, the conta padrão is suggested, Salvar with "Conferir resultado"', async () => {
  let fail = 1; const source = server({ post: call => { if (fail-- > 0) throw new AccessError(503); return { action: 'entry_save', replayed: false, entity: 'cash_entries', record: { id: id(900), note: call.body.data.note }, data_mode: 'erp_native' }; } }), view = await mount(source);
  try {
    await view.click('Incluir lançamento'); assert.match(view.text(), /Lançamento caixa/);
    assert.equal(field(view, 'Conta financeira').props.value, CAIXA, 'the conta padrão de movimentações');
    await view.change(field(view, 'Tipo').props.id, 'in'); await chooseCategory(view, field(view, 'Categoria').props.id, 'Vendas');
    await view.change(field(view, 'Valor (R$) *').props.id, '1.000'); await view.submit(1); assert.match(view.text(), /vírgula/); assert.equal(source.posts().length, 0);
    await view.change(field(view, 'Valor (R$) *').props.id, '1000,00'); await view.change(field(view, 'Histórico *').props.id, 'Venda balcão');
    await view.submit(1);
    const first = source.posts()[0];
    assert.equal(first.path, '/v1/financeiro/actions/entry_save');
    assert.deepEqual(first.body.data, { expected_version: 0, account_id: CAIXA, kind: 'in', amount_cents: '100000', posted_on: TODAY, competence_on: TODAY, category_id: RECEITA, contact_id: null, note: 'Venda balcão' });
    assert.match(view.text(), /Conferir resultado/);
    await view.submit(1); assert.equal(source.posts()[1].body.command_id, first.body.command_id);
    assert.match(view.text(), /Lançamento incluído: Venda balcão\./);
  } finally { view.unmount(); }
  // Row click on a lançamento reads it again and opens the edition with its version.
  const edit = server(), editing = await mount(edit);
  try {
    await editing.click('Lançamento 1'); assert.ok(edit.calls.some(call => call.path === `/v1/financeiro/lancamentos/${id(101)}`));
    await editing.change(field(editing, 'Histórico *').props.id, 'Lançamento 1 corrigido'); await editing.submit(1);
    assert.deepEqual([edit.posts()[0].body.data.id, edit.posts()[0].body.data.expected_version, edit.posts()[0].body.data.note], [id(101), 2, 'Lançamento 1 corrigido']);
  } finally { editing.unmount(); }
});

test('136 Transferência shows the balances and sends float bancário; Ajustar saldos sends the balance seen as CAS', async () => {
  const source = server(), view = await mount(source, `/financeiro-empresa?area=accounts&conta=${CAIXA}`);
  try {
    assert.match(source.statements()[0].path, new RegExp(`account=${CAIXA}`));
    await view.click('Transferência entre contas'); assert.equal(field(view, 'Conta Origem *').props.value, CAIXA); assert.match(view.text(), /Saldo: R\$ 500,00/);
    await view.change(field(view, 'Conta Destino *').props.id, BANCO); await view.change(field(view, 'Valor (R$) *').props.id, '50,00'); await view.change(field(view, 'Float bancário (dias)').props.id, '2');
    await modalButton(view, 'Transferir');
    assert.deepEqual(source.posts()[0].body.data, { from_account_id: CAIXA, to_account_id: BANCO, amount_cents: '5000', posted_on: TODAY, float_days: 2 });
    await view.click('Ajustar saldos'); assert.match(view.text(), /Ajuste de saldo/);
    await view.change(field(view, 'Saldo desejado (R$)').props.id, '450,00'); assert.match(view.text(), /Diferença do saldo atual: - R\$ 50,00/);
    await modalButton(view, 'Salvar Ajuste');
    assert.deepEqual(source.posts()[1].body.data, { account_id: CAIXA, desired_cents: '45000', current_cents: '50000', posted_on: TODAY });
  } finally { view.unmount(); }
});

test('136 Excluir and Restaurar selecionadas skip baixas and the saldo inicial; Alterar categorias needs the confirmation and sends the category seen', async () => {
  const source = server(), view = await mount(source);
  try {
    for (const label of ['Selecionar Lançamento 1', 'Selecionar Venda 77', 'Selecionar Transferência Caixa da loja -> Banco sintético', 'Selecionar Saldo inicial da conta']) { view.find(node => node.type === 'input' && node.props['aria-label'] === label).props.onClick({ shiftKey: false }); await view.flush(); }
    tool(view, 'Excluir selecionadas').props.onClick(); await view.flush();
    const dialog = child(view, 'BatchDialog');
    assert.deepEqual(dialog.props.plan.eligible.map(item => item.line.line_kind).sort(), ['entry', 'transfer']);
    assert.deepEqual(dialog.props.plan.skipped.map(item => item.message).sort(), ['Lançamento de baixa: desfaça pela conta ou pelo borderô.', 'O saldo inicial é corrigido por “Ajustar saldos”.']);
    await runBatch(dialog.props.plan, dialog.props.run);
    assert.deepEqual(source.posts().map(call => [call.path.split('/').at(-1), call.body.data]), [['entry_delete', { id: id(101), expected_version: 2 }], ['transfer_delete', { transfer_id: id(400) }]]);
    dialog.props.onClose([]); await view.flush();
    for (const label of ['Selecionar Lançamento 1', 'Selecionar Venda 77', 'Selecionar Saldo inicial da conta']) { view.find(node => node.type === 'input' && node.props['aria-label'] === label).props.onClick({ shiftKey: false }); await view.flush(); }
    await view.click('Alterar categorias'); assert.match(view.text(), /Nem todos os lançamentos poderão ser atualizados/);
    await chooseCategory(view, field(view, 'Categoria financeira').props.id, 'Limpeza');
    const confirm = () => view.nodes().filter(node => node.type === 'button' && text(node) === 'Alterar categorias').at(-1);
    assert.equal(confirm().disabled, true, 'the confirmation is required');
    await view.change('statement-categorize-confirm', true); assert.equal(confirm().disabled, false); confirm().props.onClick(); await view.flush();
    const categorize = child(view, 'BatchDialog');
    assert.deepEqual(categorize.props.plan.eligible.map(item => item.line.line_kind), []);
    assert.deepEqual(categorize.props.plan.skipped.map(item => item.message).sort(), ['A baixa de conta a receber pede uma categoria de receita.', 'Já está nesta categoria.', 'O saldo inicial não tem categoria.']);
  } finally { view.unmount(); }
  const deleted = server(), excluded = await mount(deleted, '/financeiro-empresa?area=accounts&situacao=excluidos');
  try {
    for (const label of ['Selecionar Lançamento 1', 'Selecionar Transferência Caixa da loja -> Banco sintético']) { excluded.find(node => node.type === 'input' && node.props['aria-label'] === label).props.onClick({ shiftKey: false }); await excluded.flush(); }
    tool(excluded, 'Restaurar selecionadas').props.onClick(); await excluded.flush();
    const restore = child(excluded, 'BatchDialog');
    assert.deepEqual(restore.props.plan.eligible.map(item => item.id), [id(101)]); assert.equal(restore.props.plan.skipped[0].message, 'Transferência excluída: inclua a transferência novamente.');
    await runBatch(restore.props.plan, restore.props.run); assert.deepEqual(deleted.posts()[0].body.data, { id: id(101), expected_version: 2 });
  } finally { excluded.unmount(); }
});

test('136 a late statement cannot replace the next one and nothing is sent after a role change', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const source = server({ before: async call => { if (call.path.includes('tab=in')) { await gate; } } }), view = await mount(source);
  try {
    await view.click('Entradas'); await view.click('Saídas');
    release(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 10)); await view.flush();
    assert.equal(view.location().search, '?area=accounts&aba=saidas');
    assert.doesNotMatch(view.text(), /Venda 77/, 'the late Entradas page is discarded');
    await view.click('Incluir lançamento');
    source.setSession({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }); await view.flush();
    assert.equal(source.posts().length, 0); assert.equal(view.nodes().some(node => node.type === 'button' && text(node) === 'Incluir lançamento'), false);
  } finally { view.unmount(); }
});

test('136 Ficha financeira: empty state without contato; débitos, créditos and saldo; Lançamento da ficha with the contato fixed; ⋮ Excluir', async () => {
  const empty = server(), none = await mountComponent('FinanceContactLedger.tsx', { controller: empty.controller }, { location: '/financeiro-empresa?area=ficha', expandChildren: ['BusyGuard'] });
  try { assert.match(none.text(), /Selecione um cliente/); assert.match(none.text(), /Para realizar a consulta você deve informar um cliente/); assert.equal(empty.calls.some(call => call.path.startsWith('/v1/financeiro/ficha')), false); } finally { none.unmount(); }
  const source = server(), view = await mountComponent('FinanceContactLedger.tsx', { controller: source.controller }, { location: `/financeiro-empresa?area=ficha&contato=${id(50)}&nome=Alfa`, expandChildren: ['BusyGuard', 'CashEntryDrawer', 'Field', 'Modal', 'CategoryTreePicker', 'TreeList'] });
  try {
    const year = TODAY.slice(0, 4);
    assert.equal(source.calls.find(call => call.path.startsWith('/v1/financeiro/ficha')).path, `/v1/financeiro/ficha?contact=${id(50)}&scope=all&from=${year}-01-01&to=${year}-12-31&page=1&limit=100`, 'the ficha is read by page (SQL 172)');
    assert.match(view.text(), /Débitos: R\$ 30,00/); assert.match(view.text(), /Créditos: R\$ 37,00/); assert.match(view.text(), /Saldo: R\$ 7,00/);
    assert.match(view.text(), /Venda nº 77/); assert.match(view.text(), /Pago/);
    assert.deepEqual(menuOf(view, 'Adiantamento').props.items.map(item => item.label), ['Editar', 'Excluir']);
    assert.equal(menuOf(view, 'Venda 77'), undefined, 'contas and baixas are changed in their screens');
    await view.click('Lançamento'); assert.match(view.text(), /Lançamento da ficha/); assert.match(view.text(), /Alfa Sintética/);
    await view.change(field(view, 'Valor (R$) *').props.id, '20,00'); await view.change(field(view, 'Histórico *').props.id, 'Pagamento em dinheiro'); await view.change(field(view, 'Origem deste pagamento').props.id, CAIXA);
    await view.submit(0);
    assert.deepEqual(source.posts()[0].body.data, { expected_version: 0, account_id: CAIXA, kind: 'out', amount_cents: '2000', posted_on: TODAY, competence_on: TODAY, category_id: null, contact_id: id(50), note: 'Pagamento em dinheiro', origin: 'ledger' });
    menuOf(view, 'Adiantamento').props.items[1].onClick(); await view.flush();
    await modalButton(view, 'Excluir');
    assert.deepEqual(source.posts()[1].body.data, { id: id(302), expected_version: 1 });
  } finally { view.unmount(); }
});

test('136 deep link #add/ajuste-saldo opens Ajuste de saldo for the conta of the topo once the contas are read', async () => {
  const source = server(), view = await mount(source, `/financeiro-empresa?area=accounts&conta=${CAIXA}&incluir=ajuste-saldo`);
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    assert.match(view.text(), /Ajuste de saldo/); assert.equal(source.posts().length, 0, 'opening never writes');
  } finally { view.unmount(); }
  const all = await mount(server(), '/financeiro-empresa?area=accounts&incluir=ajuste-saldo');
  try { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await all.flush(); } assert.doesNotMatch(all.text(), /Ajuste de saldo/, 'Todas contas has no saldo to adjust'); } finally { all.unmount(); }
});

test('136 review: an edited lançamento keeps its category while the tree is not read; a reconciled line waits for Desvincular', async () => {
  const lines = [line(1), line(5, { reconciled: true, entry_origin: 'reconciliation', note: 'Lançamento 5' })];
  const source = server({ lines, before: call => { if (call.path.startsWith('/v1/financeiro/categorias-arvore')) throw new AccessError(503); } }), view = await mount(source);
  try {
    await view.click('Lançamento 1');
    await view.change(field(view, 'Histórico *').props.id, 'Lançamento 1 sem árvore'); await view.submit(1);
    assert.deepEqual([source.posts()[0].body.data.note, source.posts()[0].body.data.category_id], ['Lançamento 1 sem árvore', DESPESA], 'the current category is not cleared');
    assert.deepEqual(menuOf(view, 'Lançamento 5').props.items.map(item => item.label), ['Imprimir comprovante'], 'a reconciled lançamento has no Excluir');
    for (const label of ['Selecionar Lançamento 1', 'Selecionar Lançamento 5']) { view.find(node => node.type === 'input' && node.props['aria-label'] === label).props.onClick({ shiftKey: false }); await view.flush(); }
    tool(view, 'Excluir selecionadas').props.onClick(); await view.flush();
    const dialog = child(view, 'BatchDialog');
    assert.deepEqual(dialog.props.plan.eligible.map(item => item.id), [id(101)]);
    assert.deepEqual(dialog.props.plan.skipped.map(item => item.message), ['Lançamento conciliado: desvincule-o na aba Conciliação antes de excluir.']);
  } finally { view.unmount(); }
});

test('136 review: the Ficha keeps the name of the contato out of the address', async () => {
  const source = server(), view = await mountComponent('FinanceContactLedger.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=ficha', expandChildren: ['BusyGuard'] });
  try {
    child(view, 'CatalogPicker').props.onSelect({ id: id(50), name: 'Alfa Sintética' }); await view.flush();
    assert.equal(view.location().search, `?area=ficha&contato=${id(50)}`);
    assert.equal(child(view, 'CatalogPicker').props.selected.name, 'Alfa Sintética');
  } finally { view.unmount(); }
});

test('FIN-147 Imprimir saldos opens the prévia of the whole period of the filter; the prévia reads every page with the daily balances', async () => {
  const source = server(), view = await mount(source);
  try {
    tool(view, 'Imprimir saldos').props.onClick(); await view.flush();
    const preview = child(view, 'FinanceStatementPrint');
    assert.ok(preview, 'prévia opened'); assert.deepEqual([preview.props.route.from, preview.props.route.to, preview.props.accountName], [MONTH.from, MONTH.to, 'Todas contas']);
    preview.props.onClose(); await view.flush(); assert.equal(child(view, 'FinanceStatementPrint'), undefined);
  } finally { view.unmount(); }
  const many = Array.from({ length: 130 }, (_, index) => line(10 + index, { posted_on: index < 100 ? MONTH.from : MONTH.to, line_id: id(2000 + index), note: `Lançamento ${10 + index}` }));
  const calls = [], company = { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 1, data: { legal_name: 'FAGOO Sintética Ltda', cnpj: '00.000.000/0001-91' } } };
  const base = server({ lines: many }).controller;
  const controller = { finance: async (path, options) => { calls.push(path); const value = await base.finance(path, options); const number = value.page; return { ...value, items: value.items.slice((number - 1) * 100, number * 100) }; }, company: async () => structuredClone(company) };
  const route = statementRoute(new URLSearchParams('area=accounts'), TODAY);
  const print = await mountComponent('FinanceStatementPrint.tsx', { controller, route, accountName: 'Todas contas', onClose() {} }, {});
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await print.flush(); }
    assert.deepEqual(calls.map(path => new URL(path, 'https://x.invalid').searchParams.get('page')), ['1', '2']);
    const output = print.text();
    assert.match(output, /Extrato · Todas contas/); assert.match(output, /130 lançamentos/); assert.match(output, /FAGOO Sintética Ltda/);
    assert.match(output, /Saldo anterior/); assert.match(output, new RegExp(`Saldo em ${MONTH.from.split('-').reverse().join('/')}`)); assert.match(output, new RegExp(`Saldo em ${MONTH.to.split('-').reverse().join('/')}`));
    assert.match(output, /Lançamento 10.*Lançamento 139/s); assert.match(output, /Saldo finalR\$ 500,00/);
    assert.equal(print.nodes().find(node => node.type === 'button' && text(node) === 'Imprimir').props.disabled, false);
  } finally { print.unmount(); }
  const huge = await mountComponent('FinanceStatementPrint.tsx', { controller: { finance: async (path, options) => ({ ...(await base.finance(path, options)), total: 5001 }), company: async () => structuredClone(company) }, route, accountName: 'Todas contas', onClose() {} }, {});
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await huge.flush(); }
    assert.match(huge.text(), /O extrato tem 5\.001 lançamentos no período/); assert.equal(huge.nodes().find(node => node.type === 'button' && text(node) === 'Imprimir').props.disabled, true);
  } finally { huge.unmount(); }
});
