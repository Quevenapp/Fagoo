import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse, chooseCategory } from './helpers/finance-category-tree-fixture.mjs';
import { runBatch } from '../src/lib/origin-batch.ts';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { presetRange } from '../src/lib/origin-list.ts';
import { borderoApiPath, borderoPage, borderoParams, borderoPath, borderoRoute } from '../src/lib/finance-bordero-route.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 110 "Gerenciar recebimentos / pagamentos": borderôs, read-only borderô and "Excluir borderôs selecionados".
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', BANK = id(500), CATEGORY = id(600), TODAY = todaySP(), MONTH = presetRange('este-mes', TODAY);
const totals = cents => ({ paid_cents: cents, interest_cents: '100', penalty_cents: '200', discount_cents: '50', fee_cents: '30', net_cash_cents: cents });
const bordero = (n, extra = {}) => ({ id: id(n), kind: 'receivable', posted_on: TODAY, account_id: BANK, account_name: 'Banco sintético', category_id: null, category_name: null, note: `Recebimento ${n}`, grouped: false, version: 1, created_at: '2026-10-20T10:00:00Z', deleted_at: null, active: true, contact_name: `Cliente ${n}`, contacts: 1, items: 1, totals: totals(String(1000 * n)), ...extra });
const line = n => ({ settlement_id: id(700 + n), title_id: id(800 + n), contact_name: `Cliente ${n}`, document_number: `NF ${n}`, description: `Conta ${n}`, principal_cents: '1000', interest_cents: '100', penalty_cents: '200', discount_cents: '50', fee_cents: '30', paid_cents: '1250', net_cash_cents: '1220', reversed: false, category_id: null, category_name: null });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const buttons = (view, label) => view.nodes().filter(node => node.type === 'button' && text(node) === label);
// Modal actions are a prop, not children: press them through the Modal element.
const modalButton = async (view, label) => { const modal = child(view, 'Modal'), found = [modal.props.actions].flat().flatMap(node => node?.props?.children !== undefined && node.type !== 'button' ? [node.props.children].flat() : [node]).find(node => node?.type === 'button' && text(node) === label); found.props.onClick(); await view.flush(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function server({ write = true, rows = [bordero(3), bordero(2), bordero(1, { grouped: true, contacts: 2, contact_name: null, items: 2 })], post, before, permitted } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: write ? 'financeiro' : 'consulta' } } }, listeners = new Set();
  const controller = {
    getSnapshot: () => state.session, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, retry() {},
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      const injected = await before?.(call); if (injected !== undefined) return injected;
      if (path === '/v1/financeiro') return { read: true, write, ...(permitted ? { permitted } : {}), data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: BANK, name: 'Banco sintético', kind: 'bank', active: true }] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), [{ id: CATEGORY, name: 'Serviços', kind: 'receivable' }]);
      if (url.pathname === '/v1/financeiro/borderos') { const kind = url.searchParams.get('kind'), items = rows.filter(row => row.kind === kind); return { entity: 'borderos', data_mode: 'erp_native', kind, page: 1, limit: 100, total: items.length, totals: { count: items.length, paid_cents: '6000', interest_cents: '300', penalty_cents: '600', discount_cents: '150', fee_cents: '90' }, items: structuredClone(items) }; }
      const match = /^\/v1\/financeiro\/borderos\/(.+)$/.exec(url.pathname);
      if (match) { const row = rows.find(item => item.id === match[1]); return { entity: 'borderos', data_mode: 'erp_native', record: { ...structuredClone(row), lines: Array.from({ length: row.items }, (_, index) => line(index + 1)) } }; }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, setSession(next) { state.session = next; for (const listener of listeners) listener(); }, lists: () => calls.filter(call => call.path.startsWith('/v1/financeiro/borderos?')), posts: () => calls.filter(call => call.method === 'POST') };
}
const mount = (source, location = '/financeiro-empresa?area=borderos&tipo=R') => mountComponent('FinanceBorderos.tsx', { controller: source.controller }, { location, expandChildren: ['NativeListLayout', 'BorderoField', 'ToolButton', 'CategoryTreeFilter', 'TreeList'] });

test('110 Recebimentos list this month by default, newest first, with the Origin Informações of the filter', async () => {
  const source = server(), view = await mount(source);
  try {
    assert.equal(source.lists()[0].path, `/v1/financeiro/borderos?page=1&limit=100&kind=receivable&from=${MONTH.from}&to=${MONTH.to}`);
    assert.match(view.text(), /Recebimentos/); assert.match(view.text(), /Quantidade de Borderôs3/);
    for (const [label, value] of [['Valor Total', 'R\\$ 60,00'], ['Acréscimos', 'R\\$ 6,00'], ['Descontos', 'R\\$ 1,50'], ['Juros', 'R\\$ 3,00'], ['Tarifas', 'R\\$ 0,90']]) assert.match(view.text(), new RegExp(`${label}${value}`));
    assert.doesNotMatch(view.text(), /Marketplace/);
    assert.deepEqual(view.nodes().filter(node => node.type === 'th').map(text).slice(1), ['Data', 'Cliente', 'Histórico', 'Valor']);
    assert.match(view.text(), /2 clientes · agrupado/);
    assert.ok(source.calls.every(call => !call.method), 'reading never writes');
  } finally { view.unmount(); }
  const pay = server({ rows: [bordero(4, { kind: 'payable' })] }), payable = await mount(pay, '/financeiro-empresa?area=borderos&tipo=P');
  try { assert.match(payable.text(), /Pagamentos/); assert.match(payable.text(), /Quantidade de Pagamentos1/); assert.match(pay.lists()[0].path, /kind=payable/); } finally { payable.unmount(); }
});

test('110 a conta followed from the ⋮ shows every date; filters go to the URL and chips', async () => {
  const source = server(), view = await mount(source, `/financeiro-empresa?area=borderos&tipo=R&titulo=${id(801)}`);
  try {
    assert.equal(source.lists()[0].path, `/v1/financeiro/borderos?page=1&limit=100&kind=receivable&title=${id(801)}`);
    assert.deepEqual(child(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Conta selecionada na listagem']);
    await view.change(`bordero-category-${CATEGORY}`, true); await view.change(view.find(node => node.type === 'label' && text(node) === 'Valor').props.htmlFor, '12,50'); await view.submit();
    assert.equal(view.location().search, `?area=borderos&tipo=R&category=${CATEGORY}&valor=1250&titulo=${id(801)}`);
    child(view, 'OriginSelector').props.onChange('Banco sintético'); await view.flush(); assert.match(view.location().search, new RegExp(`conta=${BANK}`));
    child(view, 'PeriodPicker').props.onApply({ from: '2026-01-01', to: '2026-01-31' }); await view.flush(); assert.match(view.location().search, /from=2026-01-01&to=2026-01-31/);
    assert.deepEqual(child(view, 'AppliedChips').props.chips.map(chip => chip.label), ['Conta financeira: Banco sintético', 'Categoria: Serviços', 'Valor: R$ 12,50', 'Conta selecionada na listagem']);
  } finally { view.unmount(); }
});

test('110 the row opens the read-only Borderô; a late answer cannot replace the next one', async () => {
  const late = deferred(), source = server({ before: call => call.path === `/v1/financeiro/borderos/${id(3)}` ? late.promise : undefined }), view = await mount(source);
  try {
    await view.click('Cliente 3'); assert.match(view.text(), /Carregando borderô/);
    await view.click('Cliente 2'); await view.flush();
    late.resolve({ entity: 'borderos', data_mode: 'erp_native', record: { ...bordero(3), lines: [line(9)] } }); await view.flush();
    const record = child(view, 'BorderoView').props.record; assert.equal(record.id, id(2));
    assert.deepEqual(record.lines.map(row => [row.contact_name, row.document_number, row.paid_cents]), [['Cliente 1', 'NF 1', '1250']]); assert.equal(record.totals.paid_cents, '2000');
    child(view, 'BorderoView').props.onClose(); await view.flush(); assert.equal(child(view, 'BorderoView'), undefined);
  } finally { view.unmount(); }
});

test('110 Excluir borderôs selecionados asks the motivo, sends one versioned command per borderô and recovers the uncertain one', async () => {
  const sent = []; const source = server({ post: call => { sent.push(call); const target = call.body.data.id; const tries = sent.filter(item => item.body.data.id === target).length; if (target === id(2) && tries === 1) throw new AccessError(503); return { entity: 'borderos', action: 'bordero_delete', replayed: tries > 1, items: [], borderos: [] }; } });
  const view = await mount(source);
  try {
    const trash = () => view.find(node => node.type === 'button' && node.props.title === 'Excluir borderôs selecionados');
    assert.equal(trash().disabled, true);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    trash().props.onClick(); await view.flush();
    await modalButton(view, 'Continuar'); assert.match(view.text(), /Informe o motivo da exclusão/);
    await view.change('bordero-delete-note', 'Baixa em duplicidade'); await modalButton(view, 'Continuar');
    const dialog = child(view, 'BatchDialog'); assert.equal(dialog.props.plan.eligible.length, 3);
    const results = await runBatch(dialog.props.plan, dialog.props.run);
    assert.deepEqual(results.map(result => result.outcome), ['ok', 'uncertain', 'ok']);
    assert.deepEqual(sent.map(call => [call.path, call.body.data]), [3, 2, 1].map(n => ['/v1/financeiro/actions/bordero_delete', { id: id(n), expected_version: 1, posted_on: TODAY, note: 'Baixa em duplicidade' }]));
    dialog.props.onClose(results); await view.flush();
    assert.match(view.text(), /1 borderô sem resultado confirmado/); assert.equal(child(view, 'BusyGuard') !== undefined, true);
    await view.click('Conferir resultado'); const recovery = child(view, 'BatchDialog');
    assert.deepEqual(recovery.props.plan.eligible.map(item => item.id), [id(2)]);
    const again = await runBatch(recovery.props.plan, recovery.props.run); assert.deepEqual(again.map(result => result.outcome), ['ok']);
    assert.deepEqual(sent.at(-1).body, sent[1].body, 'the same command is replayed'); recovery.props.onClose(again); await view.flush();
    assert.doesNotMatch(view.text(), /sem resultado confirmado/);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    trash().props.onClick(); await view.flush(); await view.change('bordero-delete-note', 'Outra'); await modalButton(view, 'Continuar');
    const third = child(view, 'BatchDialog'); source.setSession({ phase: 'ready', membership: { user_id: actor, role: 'consulta' } }); await view.flush();
    await assert.rejects(() => third.props.run(third.props.plan.eligible[0]), /Seu acesso a esta operação foi alterado/); assert.equal(sent.length, 4, 'nothing is sent after the role change');
  } finally { view.unmount(); }
});

test('110 consulta reads borderôs without selection or exclusion; the route and API stay strict', async () => {
  const source = server({ write: false }), view = await mount(source);
  try {
    assert.throws(() => view.find(node => node.type === 'button' && node.props.title === 'Excluir borderôs selecionados'));
    assert.throws(() => view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos')); assert.match(view.text(), /Somente consulta/);
  } finally { view.unmount(); }
  const invalid = await mount(server(), '/financeiro-empresa?area=borderos&tipo=X');
  try { assert.match(invalid.text(), /Confira os filtros dos borderôs/); } finally { invalid.unmount(); }
  const route = borderoRoute(new URLSearchParams(`area=borderos&tipo=P&q=Fornecedor&conta=${BANK}&category=${CATEGORY},none&from=2026-01-01&to=2026-01-31&valor=100&page=2`));
  assert.equal(route.category, `none,${CATEGORY}`); assert.deepEqual(borderoRoute(borderoParams(route)), route);
  const parsed = await parseFinanceRoute(new Request(`https://synthetic.invalid${borderoApiPath(route, TODAY)}`));
  assert.deepEqual(parsed.args, { p_kind: 'payable', p_page: 2, p_limit: 100, p_query: 'Fornecedor', p_account: BANK, p_categories: ['none', CATEGORY], p_from: '2026-01-01', p_to: '2026-01-31', p_amount_cents: '100', p_title: null });
  assert.equal(borderoPath('payable', id(9)), `/financeiro-empresa?area=borderos&tipo=P&titulo=${id(9)}`);
  for (const params of ['area=borderos&tipo=X', 'area=borderos&conta=x', 'area=borderos&valor=0', 'area=borderos&from=2026-02-01&to=2026-01-01', 'area=borderos&page=0', 'area=receivable', 'area=borderos&status=open'])
    assert.throws(() => borderoRoute(new URLSearchParams(params)), params);
  const base = borderoRoute(new URLSearchParams('area=borderos&tipo=R&from=2026-01-01&to=2026-01-31'));
  const value = { entity: 'borderos', data_mode: 'erp_native', kind: 'receivable', page: 1, limit: 100, total: 2, totals: { count: 2, paid_cents: '1', interest_cents: '0', penalty_cents: '0', discount_cents: '0', fee_cents: '0' }, items: [bordero(2, { posted_on: '2026-01-20' }), bordero(1, { posted_on: '2026-01-10' })] };
  assert.equal(borderoPage(value, base, TODAY).items.length, 2);
  for (const mutate of [v => { v.items.reverse(); }, v => { v.items[0].posted_on = '2026-02-01'; }, v => { v.items[0].active = false; }, v => { v.total = 3; }, v => { v.items[0].kind = 'payable'; }, v => { v.totals.fee_cents = 1; }])
    { const bad = structuredClone(value); mutate(bad); assert.throws(() => borderoPage(bad, base, TODAY)); }
});

test('110 painel Imprimir previews every borderô of the filter with the Informações, never the browser page', async () => {
  const source = server(), view = await mount(source, `/financeiro-empresa?area=borderos&tipo=R&conta=${BANK}`);
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); }
    await view.click('Imprimir'); const preview = child(view, 'FinanceBorderoPrint');
    assert.ok(preview); assert.deepEqual([preview.props.route.kind, preview.props.route.account, preview.props.route.page], ['receivable', BANK, 1]); assert.equal(source.posts().length, 0);
    preview.props.onClose(); await view.flush(); assert.equal(child(view, 'FinanceBorderoPrint'), undefined);
  } finally { view.unmount(); }
  const many = Array.from({ length: 100 }, (_, index) => bordero(300 - index)), calls = [];
  const controller = {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: { version: 1, data: { legal_name: 'FAGOO Sintética Ltda', cnpj: '00.000.000/0001-91' } } }; },
    async finance(path) { calls.push(path); const url = new URL(path, 'https://synthetic.invalid'), page = Number(url.searchParams.get('page')), items = page === 1 ? many : [bordero(200)];
      return { entity: 'borderos', data_mode: 'erp_native', kind: 'receivable', page, limit: 100, total: 101, totals: { count: 101, paid_cents: '6000', interest_cents: '300', penalty_cents: '600', discount_cents: '150', fee_cents: '90' }, items: structuredClone(items) }; },
  };
  const route = borderoRoute(new URLSearchParams("area=borderos&tipo=R"));
  const print = await mountComponent('FinanceBorderoPrint.tsx', { controller, route, onClose() {} }, {});
  try {
    for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await print.flush(); }
    assert.deepEqual(calls.map(path => new URL(path, 'https://x.invalid').searchParams.get('page')), ['1', '2']);
    assert.match(print.text(), /101 borderôs/); assert.match(print.text(), /Recebimento 200/); assert.match(print.text(), /Valor TotalR\$ 60,00/); assert.match(print.text(), /TarifasR\$ 0,90/);
    assert.equal(buttons(print, 'Imprimir')[0].disabled, false);
  } finally { print.unmount(); }
});

test('246 Excluir borderôs estorna baixas: it needs Baixar of Contas a receber (Sistema › Usuários › Permissões), as the server checks', async () => {
  const source = server({ permitted: ['financas.contas_receber', 'financas.contas_receber.ie'] }), view = await mount(source);
  try {
    assert.throws(() => view.find(node => node.type === 'button' && node.props.title === 'Excluir borderôs selecionados'));
    assert.throws(() => view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos'));
  } finally { view.unmount(); }
  const allowed = await mount(server({ permitted: ['financas.contas_receber', 'financas.contas_receber.baixar'] }));
  try { assert.ok(allowed.find(node => node.type === 'button' && node.props.title === 'Excluir borderôs selecionados')); } finally { allowed.unmount(); }
});
