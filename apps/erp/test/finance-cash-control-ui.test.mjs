import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { cashControlApiPath, cashControlParams, cashControlRoute } from '../src/lib/finance-cash-control-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 173: Controle de caixa (listagem, Abrir Caixa, sangria, valores informados, fechar e conferido).
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', CAIXA = id(30), SESSION = id(40), DINHEIRO = id(50);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node).startsWith(label)).props.htmlFor);
const lastButton = async (view, label) => { const found = view.nodes().filter(node => node.type === 'button' && text(node) === label).at(-1); assert.ok(found, label); assert.equal(found.disabled, false, `${label} enabled`); found.props.onClick(); await view.flush(); };
const settle = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } };
const role = state => ({ phase: 'ready', membership: { user_id: actor, role: state } });
const session = (extra = {}) => ({ id: SESSION, account_id: CAIXA, account_name: 'Caixa loja', operator_id: actor, operator_name: 'Operadora Sintética', opened_at: '2026-10-20T12:00:00Z', opened_on: '2026-10-20', previous_change_cents: '0', change_cents: '5000',
  state: 'open', closed_by_name: null, closed_at: null, checked: false, supply_cents: '0', withdrawal_cents: '700', expected_cash_cents: '4300', informed_cents: '0', version: 3, created_at: '2026-10-20T12:00:00Z', ...extra });
const detail = (extra = {}) => session({ values: [], methods: [], moves: [{ id: id(41), kind: 'withdrawal', posted_on: '2026-10-20', note: null, amount_cents: '700', created_at: '2026-10-20T13:00:00Z' }], ...extra });

function server({ post = () => { throw new Error('no post'); }, session: auth = role('financeiro'), permitted } = {}) {
  const calls = [], state = { session: auth };
  const controller = {
    getSnapshot: () => state.session, subscribe: () => () => {}, retry() {},
    async catalog(path) { calls.push(path); if (path.startsWith('/v1/cadastros/formas-pagamento')) return { items: [{ id: DINHEIRO, description: 'Dinheiro', active: true }], page: 1, size: 100, total: 1, can_write: false, data_mode: 'erp_native' }; throw new Error(path); },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: state.session.membership.role !== 'consulta', ...(permitted ? { permitted } : {}), data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, calls.filter(item => item.method === 'POST' && item.path === path).length);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 1, data_mode: 'erp_native', items: [{ id: CAIXA, name: 'Caixa loja', kind: 'cash', account_type: 'cash', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, start_on: '2020-01-01', active: true, default_movements: true, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: '0', first_movement_on: null, in_use: true, cnab: null, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] };
      if (url.pathname === '/v1/financeiro/controle-caixa') return { entity: 'cash_sessions', state: url.searchParams.get('state') ?? 'all', all: url.searchParams.get('all') === 'true', from: null, to: null, page: 1, limit: 100, total: 1, items: [session({ state: 'closed', closed_at: '2026-10-20T18:00:00Z', closed_by_name: 'Operadora Sintética' })], data_mode: 'erp_native' };
      if (url.pathname === `/v1/financeiro/controle-caixa/${SESSION}`) return { entity: 'cash_sessions', record: detail(), data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST') };
}
const EXPAND = ['BusyGuard', 'Modal', 'NativeListLayout', 'AppliedChips', 'Field', 'CashSessionDetail', 'OpenModal', 'MoveModal', 'ConfirmModal'];
const mount = (source, location = '/financeiro-empresa?area=controle-caixa') => mountComponent('FinanceCashControl.tsx', { controller: source.controller }, { location, expandChildren: EXPAND });

test('173 Controle de caixa model: URL and Worker paths', async () => {
  const route = cashControlRoute(new URLSearchParams('area=controle-caixa&situacao=checked&todos=1&q=Ana&from=2026-10-01&to=2026-10-31&pagina=2'));
  assert.equal(cashControlParams(route).toString(), 'area=controle-caixa&situacao=checked&todos=1&q=Ana&from=2026-10-01&to=2026-10-31&pagina=2');
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${cashControlApiPath(route)}`));
  assert.deepEqual(parsed.args, { p_state: 'checked', p_all: true, p_query: 'Ana', p_from: '2026-10-01', p_to: '2026-10-31', p_page: 2, p_limit: 100 });
  assert.equal((await parseFinanceRoute(new Request(`https://api.example.test${cashControlApiPath({ ...route, caixa: SESSION })}`))).rpc, 'erp_finance_cash_session_get');
  for (const bad of ['situacao=x', 'todos=0', 'from=2026-10-31&to=2026-10-01', 'caixa=1', 'extra=1']) assert.throws(() => cashControlRoute(new URLSearchParams(bad)), /inválidos/, bad);
});

test('173 list: Loja, Operador, Data and Situação with ⋮ Reabrir Caixa; Abrir Caixa recovers with the same command and opens the caixa', async () => {
  const opened = { action: 'session_open', replayed: false, entity: 'cash_sessions', record: detail({ moves: [], withdrawal_cents: '0', expected_cash_cents: '5000', version: 1 }), data_mode: 'erp_native' };
  const source = server({ post: (call, count) => { if (count === 1) throw new AccessError(503); return opened; } }), view = await mount(source);
  try {
    await settle(view);
    assert.deepEqual(view.nodes().filter(node => node.type === 'th').map(text).filter(Boolean), ['Loja', 'Operador', 'Data', 'Situação', 'Ações']);
    assert.match(view.text(), /Caixa loja/); assert.match(view.text(), /Fechado/); assert.match(view.text(), /Quantidade de controle de caixa1/);
    const menu = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RowMenu').props.items;
    assert.deepEqual(menu.map(item => item.label), ['Reabrir Caixa', 'Excluir']);
    await view.click('Abrir Caixa');
    assert.equal(field(view, 'Loja').props.value, CAIXA);
    await view.change(field(view, 'Troco').props.id, '50,00');
    await lastButton(view, 'Abrir Caixa'); await settle(view);
    assert.match(view.text(), /Conferir resultado/);
    await lastButton(view, 'Conferir resultado'); await settle(view);
    const [first, second] = source.posts();
    assert.deepEqual(second.body, first.body); assert.deepEqual(first.body.data, { account_id: CAIXA, change_cents: '5000' });
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/session_open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first.body) }));
    assert.equal(view.location().search, `?area=controle-caixa&caixa=${SESSION}`);
  } finally { view.unmount(); }
});

test('173 detail: header, Totais Registrados, Sangria, Valores informados and Fechar caixa; consulta only reads', async () => {
  const answers = { session_move: () => ({ action: 'session_move', replayed: false, entity: 'cash_sessions', record: detail({ version: 4 }), data_mode: 'erp_native' }),
    session_close: call => ({ action: 'session_close', replayed: false, entity: 'cash_sessions', record: detail({ state: 'closed', closed_at: '2026-10-20T18:00:00Z', closed_by_name: 'Operadora Sintética', version: 4, values: call.body.data.values.map(value => ({ ...value, payment_method_name: 'Dinheiro' })) }), data_mode: 'erp_native' }) };
  const source = server({ post: call => answers[call.path.split('/').at(-1)](call) }), view = await mount(source, `/financeiro-empresa?area=controle-caixa&caixa=${SESSION}`);
  try {
    await settle(view);
    for (const label of ['Loja', 'Operador da abertura', 'Abertura', 'Troco caixa anterior', 'Troco', 'Operador fechamento', 'Fechamento', 'Totais Registrados', 'Dinheiro esperado', 'Valores informados', 'Formas de pagamento', 'Sangrias/Suprimentos']) assert.match(view.text(), new RegExp(label));
    assert.match(view.text(), /R\$ 43,00/);
    await view.click('Sangria');
    await view.change(field(view, 'Valor').props.id, '10,00'); await lastButton(view, 'Salvar'); await settle(view);
    assert.deepEqual(source.posts()[0].body.data, { id: SESSION, expected_version: 3, kind: 'withdrawal', amount_cents: '1000', note: null });
    await view.click('Adicionar valor');
    await view.change('cash-value-method-0', DINHEIRO); await view.change('cash-value-amount-0', '43,00');
    assert.equal(view.guard().changed, true, 'the Valores informados are guarded until saved');
    await lastButton(view, 'Fechar caixa'); await settle(view);
    const close = source.posts().at(-1);
    assert.deepEqual(close.body.data, { id: SESSION, expected_version: 3, values: [{ payment_method_id: DINHEIRO, amount_cents: '4300' }] });
    await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/session_close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(close.body) }));
  } finally { view.unmount(); }
  const reader = server({ session: role('consulta') }), readOnly = await mount(reader, `/financeiro-empresa?area=controle-caixa&caixa=${SESSION}`);
  try {
    await settle(readOnly);
    assert.equal(readOnly.nodes().some(node => node.type === 'button' && ['Sangria', 'Suprimento', 'Fechar caixa', 'Salvar'].includes(text(node))), false);
  } finally { readOnly.unmount(); }
});

test('246 Controle de caixa > Excluir follows Sistema › Usuários › Permissões (vendas.controle_caixa.ex)', async () => {
  const source = server({ permitted: ['vendas.controle_caixa', 'vendas.controle_caixa.ie'] }), view = await mount(source);
  try {
    await settle(view);
    const menu = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RowMenu').props.items;
    assert.deepEqual(menu.map(item => item.label), ['Reabrir Caixa'], 'without excluir the ⋮ keeps Reabrir Caixa only');
    assert.equal(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'ToolButton' && /Excluir|excluir/.test(node.props.title ?? '')), false, 'no Excluir in the toolbar');
    assert.equal(view.nodes().some(node => ['th', 'td'].includes(node.type) && node.props.className === 'checkbox-cell'), false, 'no selection without an action for it');
    assert.equal(view.nodes().some(node => node.type === 'button' && text(node) === 'Abrir Caixa'), true, 'incluir/editar still opens a caixa');
  } finally { view.unmount(); }
});
