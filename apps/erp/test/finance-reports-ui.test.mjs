import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { defaultReportPeriod, reportApiPath, reportParams, reportRoute, reportResult, bucketLabel, categoryLabel } from '../src/lib/finance-reports-model.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 212: Ver relatórios financeiros and "Desfazer vínculo" / "Múltiplos lançamentos" of the conciliação.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '40000000-0000-4000-8000-000000000001', BANK = id(1), TODAY = todaySP();
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const flow = (route, rows) => ({ entity: 'finance_report', report: route.report, from: route.from, to: route.to, account_id: route.account || null, group: route.group, page: 1, limit: 100, total: rows.length, items: rows, data_mode: 'erp_native',
  summary: route.report === 'cash_flow' ? { previous_cents: '100000', in_cents: '50000', out_cents: '20000', net_cents: '30000', closing_cents: '130000' }
    : { current_cents: '100000', receivable_cents: '40000', payable_cents: '10000', net_cents: '30000', projected_cents: '130000', overdue_receivable_cents: '500', overdue_payable_cents: '0' } });

test('212 report route: defaults by report, canonical URL and an API path the Worker accepts', async () => {
  const realized = defaultReportPeriod('cash_flow', '2026-03-15'), forecast = defaultReportPeriod('forecast', '2026-03-15');
  assert.deepEqual([realized, forecast], [{ from: '2026-03-01', to: '2026-03-31' }, { from: '2026-03-15', to: '2026-04-30' }]);
  const route = reportRoute(new URLSearchParams(`area=relatorios&relatorio=categories&de=2026-01-01&ate=2026-03-31&conta=${BANK}&page=2`), '2026-03-15');
  assert.deepEqual(route, { report: 'categories', from: '2026-01-01', to: '2026-03-31', account: BANK, group: 'month', page: 2 });
  assert.equal(reportParams(route, '2026-03-15').toString(), `area=relatorios&relatorio=categories&de=2026-01-01&ate=2026-03-31&conta=${BANK}&page=2`);
  const parsed = await parseFinanceRoute(new Request(`https://api.example.test${reportApiPath(route)}`));
  assert.deepEqual(parsed.args, { p_report: 'categories', p_from: '2026-01-01', p_to: '2026-03-31', p_account: BANK, p_group: 'month', p_page: 2, p_limit: 100 });
  const daily = reportRoute(new URLSearchParams('area=relatorios&agrupar=dia&de=2026-03-01&ate=2026-03-31'), '2026-03-15');
  assert.equal((await parseFinanceRoute(new Request(`https://api.example.test${reportApiPath(daily)}`))).args.p_group, 'day');
  for (const bad of ['area=relatorios&relatorio=x', 'area=relatorios&de=2026-03-31&ate=2026-03-01', 'area=relatorios&agrupar=dia&de=2025-01-01&ate=2026-06-01', 'area=relatorios&relatorio=contacts&agrupar=dia', 'area=relatorios&page=2', 'area=relatorios&conta=x'])
    assert.throws(() => reportRoute(new URLSearchParams(bad), '2026-03-15'), /Confira os filtros/, bad);
  assert.equal(bucketLabel({ start_on: '2026-03-01', end_on: '2026-03-31' }, 'month'), '03/2026'); assert.equal(bucketLabel({ start_on: '2026-03-02', end_on: '2026-03-02' }, 'day'), '02/03/2026');
  assert.equal(categoryLabel({ category_id: null, name: null, parent_name: null, kind: null, deleted: false, amount_cents: '1' }), 'Sem categoria');
  assert.equal(categoryLabel({ category_id: id(5), name: 'Juros', parent_name: 'Financeiras', kind: 'receivable', deleted: true, amount_cents: '1' }), 'Financeiras > Juros (excluída)');
  assert.throws(() => reportResult({ entity: 'finance_report', report: 'cash_flow', from: route.from }, daily), /conferir/);
});

function reportServer() {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: 'consulta' } } };
  const controller = {
    getSnapshot: () => state.session, subscribe: () => () => {},
    async finance(path, options = {}) {
      calls.push(path); const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [{ id: BANK, name: 'Banco sintético', kind: 'bank', active: true, version: 1 }] };
      if (url.pathname === '/v1/financeiro/relatorios') {
        const p = url.searchParams, route = { report: p.get('report'), from: p.get('from'), to: p.get('to'), account: p.get('account') ?? '', group: p.get('group') ?? 'month' };
        if (route.report === 'categories') return { entity: 'finance_report', report: 'categories', from: route.from, to: route.to, account_id: route.account || null, group: 'month', page: Number(p.get('page')), limit: 100, total: 2, data_mode: 'erp_native',
          items: [{ category_id: id(7), name: 'Vendas', parent_name: null, kind: 'receivable', deleted: false, amount_cents: '50000' }, { category_id: null, name: null, parent_name: null, kind: null, deleted: false, amount_cents: '-20000' }], summary: { in_cents: '50000', out_cents: '20000', net_cents: '30000' } };
        return flow(route, [{ start_on: route.from, end_on: route.to, [route.report === 'cash_flow' ? 'in_cents' : 'receivable_cents']: '50000', [route.report === 'cash_flow' ? 'out_cents' : 'payable_cents']: '20000', net_cents: '30000', balance_cents: '130000' }]);
      }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, reports: () => calls.filter(path => path.startsWith('/v1/financeiro/relatorios')) };
}

test('212 Ver relatórios financeiros: Fluxo de caixa realizado by default, the other reports and Gerar relatório with the filters', async () => {
  const source = reportServer(), period = defaultReportPeriod('cash_flow', TODAY);
  const view = await mountComponent('FinanceReports.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=relatorios', expandChildren: ['Field', 'ReportTable', 'Summary'] });
  try {
    assert.equal(source.reports()[0], `/v1/financeiro/relatorios?report=cash_flow&from=${period.from}&to=${period.to}&group=month`);
    assert.match(view.text(), /Saldo anterior/); assert.match(view.text(), /Entradas/); assert.match(view.text(), /Saldo final/);
    assert.match(view.text(), /transferências entre elas não entram/);
    await view.change(field(view, 'Conta financeira').props.id, BANK); await view.change(field(view, 'Agrupar por').props.id, 'day');
    await view.submit();
    assert.equal(view.location().search, `?area=relatorios&conta=${BANK}&agrupar=dia`);
    assert.equal(source.reports().at(-1), `/v1/financeiro/relatorios?report=cash_flow&from=${period.from}&to=${period.to}&account=${BANK}&group=day`);
    await view.click('Receitas e despesas por categoria');
    assert.match(view.location().search, /relatorio=categories/); assert.match(source.reports().at(-1), /report=categories.*page=1&limit=100/);
    assert.match(view.text(), /Vendas/); assert.match(view.text(), /Sem categoria/); assert.match(view.text(), /Categorização para DRE/);
    await view.click('Fluxo de caixa previsto'); assert.match(view.text(), /Saldo previsto/); assert.match(view.text(), /A receber atrasadas/);
    await view.click('Imprimir'); assert.ok(view.nodes().some(node => typeof node.type === 'function' && node.type.name === 'StockPrintPreview'));
  } finally { view.unmount(); }
});

const candidate = (n, extra = {}) => ({ kind: 'entry', id: id(200 + n), line_kind: 'entry', posted_on: '2026-03-04', amount_cents: '-15000', note: `Lançamento ${n}`, contact_name: null, entry_origin: 'manual', ...extra });
const bankLine = (n, extra = {}) => ({ id: id(100 + n), statement_id: id(90), account_id: BANK, fitid: `F${n}`, posted_on: '2026-03-05', amount_cents: '-15000', memo: `TARIFA ${n}`, trntype: 'DEBIT', state: 'pending', version: 1, links: [], suggestion: null, ...extra });
const account = { id: BANK, name: 'Itaú sintético', kind: 'bank', account_type: 'checking', institution_code: null, institution_name: null, agency: null, account_number: null, account_digit: null, start_on: '2026-01-01', active: true,
  default_movements: false, default_boleto: false, boleto: 'none', opening_recorded: true, opening_cents: '0', balance_cents: '0', first_movement_on: null, in_use: true, cnab: null, version: 1, created_at: 'x', updated_at: 'x' };
function reconciliationServer(post) {
  const calls = [], lines = [bankLine(1, { suggestion: candidate(1) })];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {}, retry() {},
    async catalog() { return { entity: 'contacts', items: [], limit: 10, has_more: false, next_cursor: null, data_mode: 'erp_native' }; },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (path === '/v1/financeiro') return { read: true, write: true, data_mode: 'erp_native' };
      if (options.method === 'POST') return post(call, lines);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/contas-financeiras') return { entity: 'financial_accounts', page: 1, limit: 100, total: 1, items: [account], data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      if (url.pathname === '/v1/financeiro/conciliacao') return { entity: 'reconciliation', account_id: BANK, state: 'pending', page: 1, limit: 50, total: lines.length, items: structuredClone(lines), counts: { pending: lines.length, reconciled: 0, hidden: 0 },
        statements: [{ id: id(90), file_name: 'marco.ofx', created_at: '2026-03-31T12:00:00Z', period_from: '2026-03-01', period_to: '2026-03-31', lines: 1, reconciled: 0 }], data_mode: 'erp_native' };
      if (url.pathname === '/v1/financeiro/conciliacao/candidatos') return { entity: 'reconciliation_candidates', account_id: BANK, from: url.searchParams.get('from'), to: url.searchParams.get('to'), movements: [candidate(3, { amount_cents: '-10000' }), candidate(4, { amount_cents: '-5000' })], titles: [], data_mode: 'erp_native' };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST') };
}
const mountReconciliation = source => mountComponent('FinanceReconciliation.tsx', { controller: source.controller }, { location: `/financeiro-empresa?area=conciliacao&conta=${BANK}`, expandChildren: ['ReconciliationBusyGuard', 'ReconciliationField', 'Modal', 'SearchDrawer', 'CategoryTreePicker', 'TreeList'] });

test('212 Desfazer vínculo sends the sugestão shown with the version of the line; a lost answer keeps the same command', async () => {
  let attempts = 0;
  const source = reconciliationServer((call, lines) => {
    if (++attempts === 1) throw new AccessError(503);
    lines[0] = bankLine(1, { version: 2, suggestion: candidate(2, { posted_on: '2026-03-06' }) });
    return { action: 'line_dismiss', replayed: attempts > 2, entity: 'reconciliation', record: structuredClone(lines[0]), dismissed: { kind: 'entry', id: id(201) }, data_mode: 'erp_native' };
  }), view = await mountReconciliation(source);
  try {
    assert.match(view.text(), /Lançamento 1/);
    await view.click('Desfazer vínculo');
    const first = source.posts()[0];
    assert.equal(first.path, '/v1/financeiro/actions/line_dismiss');
    assert.deepEqual(first.body.data, { line_id: id(101), expected_version: 1, target: { kind: 'entry', id: id(201) } });
    assert.ok((await parseFinanceRoute(new Request('https://api.example.test/v1/financeiro/actions/line_dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(first.body) }))).rpc === 'erp_finance_reconciliation_dismiss');
    const retry = view.nodes().filter(node => node.type === 'button' && /Conferir resultado/.test(text(node))).at(-1); assert.ok(retry, 'the uncertain answer offers Conferir resultado');
    retry.props.onClick(); await view.flush();
    assert.equal(source.posts()[1].body.command_id, first.body.command_id, 'the same command is sent again');
    assert.match(view.text(), /Sugestão descartada/); assert.match(view.text(), /Lançamento 2/);
  } finally { view.unmount(); }
});

test('212 Múltiplos lançamentos opens the search to add several lançamentos up to the value of the line', async () => {
  const source = reconciliationServer(call => ({ action: 'line_reconcile', replayed: false, entity: 'reconciliation', record: bankLine(1, { state: 'reconciled', version: 2, links: [candidate(3, { amount_cents: '-10000' }), candidate(4, { amount_cents: '-5000' })] }), data_mode: 'erp_native' }));
  const view = await mountReconciliation(source);
  try {
    await view.click('Múltiplos lançamentos');
    assert.match(view.text(), /Selecione os lançamentos que, somados, correspondem ao valor do extrato/);
    for (const n of [3, 4]) { const box = view.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox' && String(node.props['aria-label'] ?? '').includes(`Lançamento ${n}`)) ?? view.nodes().filter(node => node.type === 'input' && node.props.type === 'checkbox')[n - 3]; box.props.onChange({ target: { checked: true } }); await view.flush(); }
    const conciliate = view.nodes().filter(node => node.type === 'button' && text(node) === 'Conciliar').at(-1); conciliate.props.onClick(); await view.flush();
    assert.deepEqual(source.posts()[0].body.data.links, [{ kind: 'entry', id: id(203) }, { kind: 'entry', id: id(204) }]);
  } finally { view.unmount(); }
});
