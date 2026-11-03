import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { todaySP, financePermitted, titlePermission } from '../src/lib/real-finance-model.ts';
import { defaultTitlePeriod } from '../src/lib/finance-list-route.ts';
import { statementApiPath, statementParams, statementRoute, statementRows } from '../src/lib/finance-statement-model.ts';
import { returnNumberLabel, returnPage } from '../src/lib/finance-cnab-lists-model.ts';
import { bankShortName, bankTitle } from '../src/lib/finance-banks.ts';
import { titleRowActions } from '../src/lib/finance-title-list.ts';
import { parseFinanceRoute } from '../../../workers/erp-api/src/finance.mjs';

// Synthetic data only. 246: "sem vendedor" and the whole Histórico on Clonar in the gaveta, the bank of the forma in the listagem,
// the permissions of Finanças in the screens, Nº Retorno and the Situação Cancelados of the extrato.
globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), CONTACT = id(800), SELLER = id(400), PROFILE = id(9);
const TODAY = todaySP(), PERIOD = defaultTitlePeriod(TODAY);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 1, group_id: id(9000), installment: 1, installments: 1, contact_id: CONTACT, contact_name: `Cliente ${n}`, category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null,
  issued_on: PERIOD.from, due_on: TODAY, amount_cents: '1000', settled_cents: '0', balance_cents: '1000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null, competence_on: PERIOD.from, account_id: null, account_name: null,
  bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: TODAY, deleted_at: null, remittance: null, imported: false, payments: { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false },
  payment_method_id: null, payment_method_name: null, payment_type: null, seller_id: null, seller_name: null, seller_source: null, long_history: false, seller_cleared: false, ...extra });

function listServer(rows, access = { read: true, write: true, data_mode: 'erp_native' }) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {}, retry() {},
    async financialImportOrigin(path) { return { data_mode: 'erp_native', read_only: true, title_id: path.split('/')[4], origin: null }; },
    async catalog(path) { throw new Error(`Unexpected ${path}`); },
    async finance(path, options = {}) {
      calls.push({ path, ...options });
      if (path === '/v1/financeiro') return structuredClone(access);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [] };
      if (url.pathname === '/v1/financeiro/titles' && url.searchParams.has('page'))
        return { entity: 'titles', data_mode: 'erp_native', kind: 'receivable', option: url.searchParams.get('option'), page: 1, limit: 100, order: 'due_asc', total: rows.length, totals: { count: rows.length, amount_cents: '0', balance_cents: '0', fee_cents: '0' }, items: structuredClone(rows) };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, lists: () => calls.filter(call => call.path.startsWith('/v1/financeiro/titles?')) };
}
const mountList = source => mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field', 'OriginPagination'] });

test('246 permission keys: the SQL list decides; a key needs its module; without the list every key of the profile', () => {
  assert.equal(financePermitted({}, 'financas.contas_receber.ex'), true, 'older answers have no list');
  const access = { permitted: ['financas.contas_receber', 'financas.contas_receber.ie', 'financas.contas_pagar.ie'] };
  assert.deepEqual(['financas.contas_receber', 'financas.contas_receber.ie', 'financas.contas_receber.ex', 'financas.contas_pagar.ie'].map(key => financePermitted(access, key)), [true, true, false, false], 'contas_pagar.ie without its module');
  assert.equal(titlePermission('payable', 'baixar'), 'financas.contas_pagar.baixar');
  const row = title(1, { settled_cents: '0' });
  assert.deepEqual(titleRowActions(row, true, action => action === 'ie').map(entry => entry.action), ['edit', 'clone']);
  assert.deepEqual(titleRowActions(row, true).map(entry => entry.action), ['edit', 'settle', 'settle_partial', 'cancel', 'clone', 'delete']);
});

test('246 listagem: the Forma de pagamento shows the bank of the forma, and actions follow the permissions of Finanças', async () => {
  assert.deepEqual([bankShortName({ code: '341', name: 'Itaú Unibanco' }), bankShortName({ code: '999', name: 'Banco sintético' }), bankTitle({ code: '341', name: 'Itaú Unibanco' })], ['Itaú', '999', '341 - Itaú Unibanco']);
  const rows = [title(1, { payment_method_id: id(300), payment_method_name: 'Boleto Itaú', payment_type: '15', payment_bank: { code: '341', name: 'Itaú Unibanco' } }), title(2, { payment_method_id: id(301), payment_method_name: 'Dinheiro', payment_type: '01' })];
  const source = listServer(rows, { read: true, write: true, permitted: ['financas.contas_receber', 'financas.contas_receber.ie'], data_mode: 'erp_native' });
  const view = await mountList(source);
  try {
    const badge = view.nodes().find(node => node.props?.className === 'finance-bank-badge');
    assert.ok(badge, 'the bank badge is in the column'); assert.equal(badge.props.title, '341 - Itaú Unibanco'); assert.match(text(badge), /Itaú/);
    assert.equal(view.nodes().filter(node => node.props?.className === 'finance-bank-badge').length, 1, 'a forma without conta financeira keeps the tPag icon');
    assert.ok(view.nodes().some(node => node.type === 'button' && text(node).endsWith('Incluir conta')), 'Incluir needs .ie, which the user has');
    for (const label of ['Baixar selecionados', 'Cancelar selecionadas', 'Gerar remessa']) assert.ok(!view.nodes().some(node => node.type === 'button' && text(node).endsWith(label)), `${label} is not offered without its key`);
    assert.ok(view.nodes().some(node => node.type === 'button' && text(node).endsWith('Alterar categorias')));
    const menu = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RowMenu');
    assert.deepEqual(menu.props.items.map(item => item.label).filter(label => ['Editar', 'Excluir', 'Cancelar conta a receber', 'Baixa total do recebimento'].includes(label)), ['Editar']);
  } finally { view.unmount(); }
  const denied = listServer(rows, { read: true, write: true, permitted: ['financas.contas_pagar'], data_mode: 'erp_native' });
  const blocked = await mountList(denied);
  try {
    assert.equal(denied.lists().length, 0, 'the list is not asked without Contas a Receber');
    assert.match(blocked.text(), /Seu usuário não tem a permissão Contas a Receber \(Sistema › Usuários › Permissões › Finanças\)\./);
  } finally { blocked.unmount(); }
});

function drawerServer({ detail = {}, history = null } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }),
    async catalog(path) { calls.push({ path, catalog: true }); if (path === '/v1/cadastros') return { read: ['contacts'], write: ['contacts'] }; if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return { scope: 'seller_options', data_mode: 'erp_native', users: [], items: [{ id: SELLER, name: 'Vendedora sintética', code: null }] }; throw new Error(`Unexpected ${path}`); },
    async finance(path, options = {}) {
      calls.push({ path, ...options });
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [] };
      if (url.pathname === '/v1/financeiro/formas-pagamento') return { entity: 'payment_methods', kind: 'receivable', data_mode: 'erp_native', items: [] };
      if (url.pathname === '/v1/financeiro/categorias-arvore') return { entity: 'category_tree', kind: url.searchParams.get('kind'), items: [], data_mode: 'erp_native' };
      const match = /^\/v1\/financeiro\/titles\/([^/]+)\/detalhe$/.exec(url.pathname);
      if (match) return { entity: 'titles', data_mode: 'erp_native', record: detail.record ?? title(Number(match[1].slice(-4)), detail.extra), origin: null, account: null, billing: null, imported: false, settled_before: false, original: null, history };
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller };
}

test('246 gaveta: Clonar fills the whole Histórico, and "sem vendedor" says why the conta has no seller', async () => {
  const long = `${'Histórico longo sintético '.repeat(12)}fim`.trim();
  const source = title(70, { description: long.slice(0, 240).trimEnd(), long_history: true });
  const files = drawerServer({ record: undefined, history: long, detail: { record: source } });
  const view = await mountComponent('FinanceTitleDrawer.tsx', { controller: files.controller, kind: 'receivable', mode: 'create', title: null, clone: source, onClose: () => {}, onSaved: () => {} }, { expandChildren: ['DrawerField', 'FinanceSellerSelect'] });
  try {
    assert.ok(files.calls.some(call => call.path === `/v1/financeiro/titles/${source.id}/detalhe`), 'the clone reads the whole Histórico of its source');
    const area = view.nodes().find(node => node.type === 'textarea');
    assert.equal(area.props.value, long);
    assert.equal(view.guard().changed, false, 'filling the Histórico is not an unsaved change');
  } finally { view.unmount(); }
  const short = title(71);
  const quiet = drawerServer();
  const plain = await mountComponent('FinanceTitleDrawer.tsx', { controller: quiet.controller, kind: 'receivable', mode: 'create', title: null, clone: short, onClose: () => {}, onSaved: () => {} }, { expandChildren: ['DrawerField'] });
  try { assert.ok(!quiet.calls.some(call => call.path.endsWith('/detalhe')), 'a short Histórico is already whole'); } finally { plain.unmount(); }
  const cleared = title(72, { seller_cleared: true });
  const edit = drawerServer({ detail: { record: cleared } });
  const drawer = await mountComponent('FinanceTitleDrawer.tsx', { controller: edit.controller, kind: 'receivable', mode: 'edit', title: cleared, onClose: () => {}, onSaved: () => {} }, { expandChildren: ['DrawerField', 'FinanceSellerSelect'] });
  try { await drawer.click('Pagamento'); assert.match(drawer.text(), /Sem vendedor: esta conta não usa o vendedor do documento de origem\./); } finally { drawer.unmount(); }
});

test('246 extrato: Situação Cancelados is a URL filter sent as cancelled=true, with its chip and without saldo rows', async () => {
  const route = statementRoute(new URLSearchParams('area=accounts&situacao=cancelados'), TODAY);
  assert.equal(route.situacao, 'cancelados');
  assert.equal(statementParams(route, TODAY).get('situacao'), 'cancelados');
  const path = statementApiPath(route);
  assert.match(path, /cancelled=true/); assert.match(path, /deleted=false/);
  assert.equal((await parseFinanceRoute(new Request(`https://api.example.test${path}`))).args.p_cancelled, true);
  assert.equal(Object.hasOwn((await parseFinanceRoute(new Request(`https://api.example.test${statementApiPath(statementRoute(new URLSearchParams(), TODAY))}`))).args, 'p_cancelled'), false, 'Registrados does not send it');
  assert.throws(() => statementRoute(new URLSearchParams('situacao=cancelados&conciliacao=conciliados'), TODAY), /Filtros inválidos/);
  const line = { line_id: id(5), line_kind: 'settlement', posted_on: route.from, competence_on: null, account_id: id(6), account_name: 'Caixa', amount_cents: '-3000', category_id: null, category_name: null, contact_id: null, contact_name: null, note: 'Estorno', title_id: id(7), title_kind: 'receivable', document: null, transfer_id: null, entry_id: null, entry_version: null, entry_origin: null, reconciled: false };
  const rows = statementRows({ items: [line], total: 1, page: 1, day_balances: {}, summary: { before_cents: '0', previous_cents: '0', in_cents: '0', out_cents: '3000', closing_cents: '0', current_cents: '0' } }, route, 1);
  assert.deepEqual(rows.map(row => row.type), ['line'], 'Cancelados has no Saldo em rows');
});

test('246 Retornos: Nº Retorno without the leading zeros, and — for the files read before it was kept', async () => {
  assert.deepEqual([returnNumberLabel('00042'), returnNumberLabel(null), returnNumberLabel(undefined), returnNumberLabel('x')], ['42', '—', '—', '—']);
  const row = (n, number) => ({ id: id(50 + n), profile_id: PROFILE, purpose: 'operational', generated_on: '2026-05-02', created_at: '2026-05-02T12:00:00Z', filename: `RETORNO_${id(50 + n)}.RET`, bank: '341', bank_name: 'Itaú', number, excludable: false, titles: 1, total_cents: '100' });
  assert.throws(() => returnPage({ entity: 'cnab_returns', data_mode: 'erp_native', total: 1, page: 1, items: [row(1, 'abc')] }));
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {},
    async finance(path) { if (path === '/v1/financeiro') return { read: true, write: true, data_mode: 'erp_native' }; return { entity: 'cnab_returns', page: 1, limit: 50, total: 2, items: [row(1, '00042'), row(2, null)], data_mode: 'erp_native' }; },
  };
  const view = await mountComponent('FinanceReturns.tsx', { controller }, { location: '/financeiro-empresa?area=retornos', expandChildren: ['NativeListLayout'] });
  try {
    assert.ok(view.nodes().some(node => node.type === 'th' && text(node) === 'Nº Retorno'));
    const cells = view.nodes().filter(node => node.type === 'td' && node.props.className === 'numeric').map(text);
    assert.ok(cells.includes('42') && cells.includes('—'));
  } finally { view.unmount(); }
});

test('246 Retornos follow Sistema › Usuários › Permissões: Incluir Retorno with .ie, Excluir selecionados only with .ex', async () => {
  const row = { id: id(51), profile_id: PROFILE, purpose: 'operational', generated_on: '2026-05-02', created_at: '2026-05-02T12:00:00Z', filename: `RETORNO_${id(51)}.RET`, bank: '341', bank_name: 'Itaú', number: '00042', excludable: true, titles: 1, total_cents: '100' };
  const mount = permitted => mountComponent('FinanceReturns.tsx', { controller: {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {},
    async finance(path) { if (path === '/v1/financeiro') return { read: true, write: true, permitted, data_mode: 'erp_native' }; return { entity: 'cnab_returns', page: 1, limit: 50, total: 1, items: [row], data_mode: 'erp_native' }; },
  } }, { location: '/financeiro-empresa?area=retornos', expandChildren: ['NativeListLayout'] });
  const limited = await mount(['financas.retornos', 'financas.retornos.ie']);
  try {
    assert.ok(limited.nodes().some(node => text(node).endsWith('Incluir Retorno')));
    assert.ok(!limited.nodes().some(node => node.type === 'button' && text(node).endsWith('Excluir selecionados')), 'Excluir needs financas.retornos.ex');
  } finally { limited.unmount(); }
  const full = await mount(['financas.retornos', 'financas.retornos.ie', 'financas.retornos.ex']);
  try { assert.ok(full.nodes().some(node => node.type === 'button' && text(node).endsWith('Excluir selecionados'))); } finally { full.unmount(); }
});

test('246 Ficha financeira: Excluir a lançamento follows Caixas e Bancos > Excluir, as the server checks', async () => {
  const year = TODAY.slice(0, 4), entry = { day: `${year}-03-05`, line_kind: 'entry', ref_id: id(1001), kind: 'receivable', note: 'Lançamento sintético', due_on: null, side: 'credit', amount_cents: '100', situation: null, origin: null, version: 1 };
  const mount = permitted => mountComponent('FinanceContactLedger.tsx', { controller: { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'financeiro' } }), subscribe: () => () => {}, retry() {}, async catalog() { return {}; },
    async finance(path) {
      if (path === '/v1/financeiro') return { read: true, write: true, permitted, data_mode: 'erp_native' };
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/ficha') return { entity: 'contact_ledger', contact_id: url.searchParams.get('contact'), contact_name: 'Alfa Sintética', scope: 'all', from: url.searchParams.get('from'), to: url.searchParams.get('to'),
        page: 1, limit: 100, total: 1, items: [structuredClone(entry)], totals: { debit_cents: '0', credit_cents: '100', balance_cents: '100' }, data_mode: 'erp_native' };
      throw new Error(path);
    } } }, { location: `/financeiro-empresa?area=ficha&contato=${CONTACT}`, expandChildren: ['BusyGuard'] });
  const labels = view => view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'RowMenu')?.props.items.map(item => item.label);
  const settled = async view => { for (let i = 0; i < 3; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await view.flush(); } return view; };
  const editor = await settled(await mount(['financas.caixas_bancos', 'financas.caixas_bancos.ie']));
  try { assert.deepEqual(labels(editor), ['Editar']); } finally { editor.unmount(); }
  const full = await settled(await mount(['financas.caixas_bancos', 'financas.caixas_bancos.ie', 'financas.caixas_bancos.ex']));
  try { assert.deepEqual(labels(full), ['Editar', 'Excluir']); } finally { full.unmount(); }
});
