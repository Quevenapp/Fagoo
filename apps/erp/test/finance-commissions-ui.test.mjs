import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { commissionApiPath, commissionPage, commissionParams, commissionRoute, commissionStatement, percentInput, shiftMonth } from '../src/lib/finance-commissions-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 171: Financeiro > Comissões (listagem do mês, extrato do vendedor, Pagamento, Outro lançamento,
// Comissão manual e exclusão), with "Conferir resultado" and the session checks.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', SELLER = id(10), OTHER = id(11), CAIXA = id(30);
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()), MONTH = TODAY.slice(0, 7);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node).startsWith(label)).props.htmlFor);
const lastButton = async (view, label) => { const found = view.nodes().filter(node => node.type === 'button' && text(node) === label).at(-1); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const press = async (view, label) => { view.find(node => node.type === 'button' && node.props['aria-label'] === label).props.onClick(); await view.flush(); };
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const sums = (extra = {}) => ({ billed_cents: '3200', previous_cents: '-100', commission_cents: '160', credit_cents: '50', debit_cents: '20', payment_cents: '10', pending_cents: '320', balance_cents: '80', ...extra });
const row = (seller, name, extra = {}) => ({ seller_id: seller, name, situation: 'A', ...sums(), ...extra });
const listing = (url, items = [row(SELLER, 'Vendedora Sintética'), row(OTHER, 'Vendedor Inativo', { situation: 'I', ...sums({ billed_cents: '0', previous_cents: '0', commission_cents: '0', credit_cents: '0', debit_cents: '0', payment_cents: '0', pending_cents: '0', balance_cents: '0' }) })]) => ({
  entity: 'commissions', month: url.searchParams.get('month'), situation: url.searchParams.get('situation') ?? 'all', with_idle: url.searchParams.get('idle') === 'true', page: Number(url.searchParams.get('page') ?? 1), limit: 100,
  total: items.length, items, totals: sums({ billed_cents: '3200', previous_cents: '-100', commission_cents: '160', credit_cents: '50', debit_cents: '20', payment_cents: '10', pending_cents: '320', balance_cents: '80' }), data_mode: 'erp_native' });
const entry = (n, kind, extra = {}) => ({ id: id(n), seller_id: SELLER, kind, month: `${MONTH}-01`, posted_on: TODAY, amount_cents: kind === 'payment' ? '10' : kind === 'credit' ? '50' : '20', description: kind === 'payment' ? 'Pagamento de comissões' : 'Outro lançamento',
  category_id: null, account_id: kind === 'payment' ? CAIXA : null, account_name: kind === 'payment' ? 'Caixa sintético' : null, source: kind === 'payment' ? 'cash' : null, title_id: null, counts: true, deleted: false, version: 1, created_at: '2026-10-20T12:00:00Z', ...extra });
const statement = (month, payable = false) => ({ entity: 'commission_statement', month, payable,
  seller: { id: SELLER, contact_id: id(12), name: 'Vendedora Sintética', code: null, situation: 'A', rule: 'primeira_parcela', mode: 'fixa', rate: '5.0000' },
  commissions: { total: 1, parcel_cents: '3200', base_cents: '3200', commission_cents: '160', items: [{ id: id(40), origin: 'document', day: `${month}-05`, description: 'Pedido de venda nº 7 · parcela 1/3', parcel_cents: '3200', base_cents: '3200', rate: '5.00', commission_cents: '160', document: { id: id(41), kind: 'sales_orders', number: '7' }, title_id: id(42), version: 1 }] },
  credits: { total: 1, amount_cents: '50', items: [entry(50, 'credit')] }, debits: { total: 1, amount_cents: '20', items: [entry(51, 'debit')] }, payments: { total: 1, amount_cents: '10', items: [entry(52, 'payment')] },
  pending: { total: 1, commission_cents: '320', items: [{ id: id(43), due_on: '2020-01-10', description: 'Pedido de venda nº 7 · parcela 2/3', situation: 'overdue', commission_cents: '320' }] },
  summary: { previous_cents: '-100', commission_cents: '160', credit_cents: '50', debit_cents: '20', payment_cents: '10', pending_cents: '320', balance_cents: '80' }, data_mode: 'erp_native' });
const role = state => ({ phase: 'ready', membership: { user_id: actor, role: state } });

function server({ post = () => { throw new Error('no post'); }, session = role('financeiro'), payable = false, hold = null } = {}) {
  const calls = [], state = { session }, listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async catalog() { return {}; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') { if (state.session.membership.role === 'vendas') throw new AccessError(403); } if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, calls.filter(item => item.method === 'POST' && item.path === path).length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 1, data_mode: 'erp_native', items: [{ id: CAIXA, name: 'Caixa sintético', kind: 'cash', account_type: 'cash', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, start_on: '2020-01-01', active: true, default_movements: true, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: '0', first_movement_on: null, in_use: true, cnab: null, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] };
      if (url.pathname === '/v1/financeiro/comissoes') { if (hold) await hold(call); return listing(url); }
      if (url.pathname === `/v1/financeiro/comissoes/${SELLER}`) return statement(url.searchParams.get('month'), payable);
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST'), setRole(next) { state.session = role(next); for (const listener of listeners) listener(); } };
}
const EXPAND = ['BusyGuard', 'Modal', 'NativeListLayout', 'AppliedChips', 'Field', 'MonthNav', 'PaymentModal', 'EntryModal', 'ManualModal', 'DeleteModal', 'CategoryTreePicker'];
const mount = (source, location = '/financeiro-empresa?area=comissoes') => mountComponent('FinanceCommissions.tsx', { controller: source.controller }, { location, expandChildren: EXPAND });

test('171 Comissões model: URL, Worker paths and the checked answers', async () => {
  const route = commissionRoute(new URLSearchParams('area=comissoes&mes=2026-09&situacao=I&todos=1&q=Ana&pagina=2'), TODAY);
  assert.deepEqual(route, { mes: '2026-09', situacao: 'I', todos: true, q: 'Ana', page: 2, vendedor: null });
  assert.equal(commissionParams(route, TODAY).toString(), 'area=comissoes&mes=2026-09&situacao=I&todos=1&q=Ana&pagina=2');
  assert.equal(commissionParams({ ...route, mes: MONTH, situacao: 'all', todos: false, q: '', page: 1 }, TODAY).toString(), 'area=comissoes', 'Este mês is the default');
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${commissionApiPath(route)}`));
  assert.deepEqual(parsed.args, { p_month: '2026-09-01', p_situation: 'I', p_with_idle: true, p_query: 'Ana', p_page: 2, p_limit: 100 });
  const extrato = await parseFinanceRoute(new Request(`https://api.example.test${commissionApiPath({ ...route, vendedor: SELLER })}`));
  assert.deepEqual([extrato.rpc, extrato.args], ['erp_finance_commission_statement', { p_seller: SELLER, p_month: '2026-09-01' }]);
  for (const bad of ['mes=2026-13', 'situacao=X', 'todos=0', 'pagina=0', 'vendedor=1', 'extra=1']) assert.throws(() => commissionRoute(new URLSearchParams(bad), TODAY), /inválidos/, bad);
  assert.deepEqual([shiftMonth('2026-01', -1), shiftMonth('2026-12', 1)], ['2025-12', '2027-01']);
  assert.deepEqual([percentInput('5,5'), percentInput('100'), percentInput('')], ['5.5', '100', null]);
  assert.throws(() => percentInput('101'), /até 100%/);
  const listRoute = { mes: MONTH, situacao: 'all', todos: false, q: '', page: 1, vendedor: null };
  const good = listing(new URL(`https://x.test/v1/financeiro/comissoes?month=${MONTH}`));
  assert.equal(commissionPage(good, listRoute).items.length, 2);
  assert.throws(() => commissionPage({ ...good, items: [{ ...good.items[0], balance_cents: '81' }, good.items[1]] }, listRoute), /Não foi possível/, 'a saldo that does not add up is refused');
  assert.throws(() => commissionStatement({ ...statement(MONTH), summary: { ...statement(MONTH).summary, payment_cents: '11', balance_cents: '79' } }, { ...listRoute, vendedor: SELLER }), /Não foi possível/, 'the summary must match the sections');
});

test('171 the list shows the Origin columns and the Total; the row opens the extrato and the month moves; a late answer of another session is ignored', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const source = server(), view = await mount(source);
  try {
    await settle(view);
    const heads = view.nodes().filter(node => node.type === 'th').map(text);
    assert.deepEqual(heads, ['Vendedor', 'Faturado', 'Saldo ant.', '(+)Comis. mês', '(+)Out. créditos', '(-)Out. débitos', '(-)Pgtos', '(*)Comis. pend.', '(=)Saldo']);
    assert.equal(view.find(node => node.type === 'th' && text(node) === 'Faturado').props.title, 'Somatório total das vendas faturadas que originaram as comissões');
    assert.match(view.text(), /Total/); assert.match(view.text(), /- R\$ 1,00/); assert.match(view.text(), /Quantidade de comissões2/);
    assert.equal(source.calls.find(call => call.path.startsWith('/v1/financeiro/comissoes')).path, `/v1/financeiro/comissoes?month=${MONTH}`);
    await press(view, 'Mês anterior');
    assert.equal(view.location().search, `?area=comissoes&mes=${shiftMonth(MONTH, -1)}`);
    await press(view, 'Próximo mês'); await view.click('Vendedora Sintética');
    assert.equal(view.location().search, `?area=comissoes&vendedor=${SELLER}`);
  } finally { view.unmount(); }
  const slow = server({ hold: () => gate }), late = await mount(slow);
  try {
    slow.setRole('vendas'); await late.flush(); release(); await settle(late);
    assert.doesNotMatch(late.text(), /Vendedora Sintética/, 'the answer read for the previous profile is not shown');
  } finally { late.unmount(); }
});

test('171 extrato: Tipos de comissões with the seller rule in bold, the sections and the Resumo; Pagamento recovers with the same command', async () => {
  const paid = call => ({ action: 'commission_payment', replayed: false, entity: 'commission_entries', record: entry(60, 'payment', { amount_cents: call.body.data.amount_cents }), data_mode: 'erp_native' });
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return paid(call); } });
  const view = await mount(source, `/financeiro-empresa?area=comissoes&vendedor=${SELLER}`);
  try {
    await settle(view);
    const bold = view.nodes().filter(node => node.type === 'strong').map(text);
    assert.ok(bold.includes('Liberação integral após o pagamento da primeira parcela'));
    for (const label of ['Comissões do mês', '(+) Créditos', '(-) Débitos', '(-) Pagamentos efetuados', 'Comissões ainda pendentes', 'Resumo']) assert.match(view.text(), new RegExp(label.replace(/[()+-]/g, '\\$&')));
    assert.match(view.text(), /Total de comissões do mês/); assert.match(view.text(), /5,00%/);
    assert.doesNotMatch(view.text(), /Parcela atrasada/, 'the pending ones start hidden'); await view.click('Exibir'); assert.match(view.text(), /Parcela atrasada/);
    await view.click('Pagamento');
    assert.equal(field(view, 'Conta origem').props.value, CAIXA, 'the default movement account is preselected');
    assert.equal(field(view, 'Descrição').props.value, 'Pagamento de comissões');
    await view.change(field(view, 'Valor').props.id, '12,34');
    await lastButton(view, 'Salvar'); await settle(view);
    assert.match(view.text(), /Conferir resultado/);
    await lastButton(view, 'Conferir resultado'); await settle(view);
    const [first, second] = source.posts();
    assert.deepEqual(second.body, first.body, 'the same command_id and body are replayed');
    assert.deepEqual(first.body.data, { seller_id: SELLER, month: `${MONTH}-01`, posted_on: TODAY, category_id: null, account_id: CAIXA, amount_cents: '1234', description: 'Pagamento de comissões' });
    const parsed = await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/commission_payment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }));
    assert.equal(parsed.rpc, 'erp_finance_commission_execute');
    assert.match(view.text(), /Pagamento registrado com o lançamento no caixa/);
  } finally { view.unmount(); }
});

test('171 Outro lançamento, Comissão manual and Excluir go to the Worker as validated; consulta only reads', async () => {
  const answers = { commission_entry: call => ({ action: 'commission_entry', replayed: false, entity: 'commission_entries', record: entry(61, call.body.data.kind), data_mode: 'erp_native' }),
    commission_manual: call => ({ action: 'commission_manual', replayed: false, entity: 'commissions', record: { id: id(62), seller_id: SELLER, origin: 'manual', due_on: call.body.data.due_on, credit_on: call.body.data.credit_on, parcel_cents: call.body.data.parcel_cents, rate: '5.00', commission_cents: '50', description: 'Comissão manual', version: 1, deleted: false }, data_mode: 'erp_native' }),
    commission_delete: call => ({ action: 'commission_delete', replayed: false, entity: 'commission_entries', record: entry(52, 'payment', { deleted: true, counts: false, version: 2, id: call.body.data.id }), data_mode: 'erp_native' }) };
  const source = server({ post: call => answers[call.path.split('/').at(-1)](call) });
  const view = await mount(source, `/financeiro-empresa?area=comissoes&vendedor=${SELLER}`);
  try {
    await settle(view);
    await view.click('Outro lançamento');
    await view.change(field(view, 'Valor').props.id, '5,00'); await view.change(field(view, 'Tipo').props.id, 'debit');
    await lastButton(view, 'Salvar'); await settle(view);
    await view.click('Comissão manual');
    assert.equal(field(view, 'Alíquota de comissão').props.value, '5', 'the fixed rate of the seller is suggested');
    await view.change(field(view, 'Valor parcela').props.id, '100,00');
    await lastButton(view, 'Salvar'); await settle(view);
    const menu = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'RowMenu').map(node => node.props).find(props => props.label === 'Pagamento de comissões');
    menu.items.find(item => item.label === 'Excluir').onClick(); await view.flush();
    await lastButton(view, 'Excluir'); await settle(view);
    const [outro, manual, removal] = source.posts();
    assert.deepEqual(outro.body.data, { seller_id: SELLER, month: `${MONTH}-01`, posted_on: TODAY, amount_cents: '500', kind: 'debit', description: 'Outro lançamento' });
    assert.deepEqual(manual.body.data, { seller_id: SELLER, due_on: TODAY, credit_on: TODAY, parcel_cents: '10000', rate: '5' });
    assert.deepEqual(removal.body.data, { target: 'entry', id: id(52), expected_version: 1 });
    for (const call of [outro, manual, removal]) await parseFinanceRoute(new Request(`https://api.example.test${call.path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call.body) }));
  } finally { view.unmount(); }
  const reader = server({ session: role('consulta') }), readOnly = await mount(reader, `/financeiro-empresa?area=comissoes&vendedor=${SELLER}`);
  try {
    await settle(readOnly);
    assert.match(readOnly.text(), /Somente consulta/);
    assert.equal(readOnly.nodes().some(node => node.type === 'button' && ['Pagamento', 'Outro lançamento', 'Comissão manual'].includes(text(node))), false);
  } finally { readOnly.unmount(); }
});
