import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { categoryTreeResponse } from './helpers/finance-category-tree-fixture.mjs';
import { todaySP } from '../src/lib/real-finance-model.ts';
import { defaultTitlePeriod, financeListRoute, financeListParams } from '../src/lib/finance-list-route.ts';
import { settlementDue, recurrenceChanges, drawerEditData, drawerInitial, drawerLocks, descriptionLimit } from '../src/lib/finance-title-drawer.ts';
import { sellerOptions, sellerOptionsPath } from '../src/lib/finance-sellers.ts';

// Synthetic data only. 210: Tipo de pagamento / Forma de pagamento / Vendedor filters, Vendedor and Prazo de recebimento in the
// gaveta, Histórico of 2.000 characters and the contacts picker in the legacy finance editor.
globalThis.document = { activeElement: null };
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(1), CARD = id(300), SLIP = id(301), SELLER = id(400), OTHER = id(401), CONTACT = id(800);
const TODAY = todaySP(), PERIOD = defaultTitlePeriod(TODAY);
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const child = (view, name) => view.nodes().find(node => typeof node.type === 'function' && node.type.name === name);
const field = (view, label) => view.input(view.find(node => node.type === 'label' && text(node) === label).props.htmlFor);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const methods = { entity: 'payment_methods', kind: 'receivable', data_mode: 'erp_native', items: [
  { id: CARD, description: 'Cartão sintético', payment_type: '03', account_id: null, interest_rate: null, fine_rate: null, fee_type: 'aliquota', fee_rate: null, fee_fixed: null, is_default: false, settlement_days: 30, business_days: false },
  { id: SLIP, description: 'Boleto sintético', payment_type: '15', account_id: null, interest_rate: '1.0000', fine_rate: null, fee_type: 'fixa', fee_rate: null, fee_fixed: '2.50', is_default: false, settlement_days: null, business_days: false }] };
const sellers = { scope: 'seller_options', data_mode: 'erp_native', users: [], items: [{ id: SELLER, name: 'Vendedora sintética', code: 'V1' }, { id: OTHER, name: 'Vendedor sintético', code: null }] };
const title = (n, extra = {}) => ({ id: id(n), kind: 'receivable', version: 1, group_id: id(9000), installment: 1, installments: 1, contact_id: CONTACT, contact_name: `Cliente ${n}`, category_id: null, category_name: null, description: `Conta ${n}`, source_reference: null,
  issued_on: PERIOD.from, due_on: TODAY, amount_cents: '1000', settled_cents: '0', balance_cents: '1000', cancelled: false, status: 'open', overdue: false, document_linked: false, origin: null, competence_on: PERIOD.from, account_id: null, account_name: null,
  bank_number: null, interest_month_bp: 0, penalty_bp: 0, original_due_on: TODAY, deleted_at: null, remittance: null, imported: false, payments: { settled_on: null, fee_cents: '0', interest_cents: '0', penalty_cents: '0', discount_cents: '0', settled_by_return: false },
  payment_method_id: null, payment_method_name: null, payment_type: null, seller_id: null, seller_name: null, seller_source: null, long_history: false, ...extra });

function listServer(data) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: 'financeiro' } } };
  const controller = {
    getSnapshot: () => state.session, subscribe: () => () => {}, retry() {},
    async financialImportOrigin(path) { return { data_mode: 'erp_native', read_only: true, title_id: path.split('/')[4], origin: null }; },
    async catalog(path) { calls.push({ path, catalog: true }); if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return structuredClone(sellers); throw new Error(`Unexpected ${path}`); },
    async finance(path, options = {}) {
      calls.push({ path, ...options });
      if (path === '/v1/financeiro') return { read: true, write: true, data_mode: 'erp_native' };
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/formas-pagamento') return structuredClone(methods);
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [] };
      if (url.pathname === '/v1/financeiro/titles' && url.searchParams.has('page')) {
        const p = url.searchParams, rows = data.filter(item => (!p.get('payment_type') || item.payment_type === p.get('payment_type')) && (!p.get('payment_method') || item.payment_method_id === p.get('payment_method')) && (!p.get('seller') || item.seller_id === p.get('seller')));
        return { entity: 'titles', data_mode: 'erp_native', kind: 'receivable', option: p.get('option'), page: 1, limit: 100, order: 'due_asc', total: rows.length, totals: { count: rows.length, amount_cents: '0', balance_cents: '0', fee_cents: '0' }, items: structuredClone(rows) };
      }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, lists: () => calls.filter(call => call.path.startsWith('/v1/financeiro/titles?')) };
}

test('210 list route: tipo, forma and vendedor are canonical URL filters (vendedor only in contas a receber)', () => {
  const route = financeListRoute(new URLSearchParams(`area=receivable&tipo=03&forma=${CARD}&vendedor=${SELLER}`));
  assert.deepEqual([route.paymentType, route.paymentMethod, route.seller], ['03', CARD, SELLER]);
  assert.equal(financeListParams(route).toString(), `area=receivable&tipo=03&forma=${CARD}&vendedor=${SELLER}`);
  assert.equal(Object.hasOwn(financeListRoute(new URLSearchParams('area=receivable')), 'paymentType'), false, 'absent filters stay out of the route');
  for (const bad of ['area=receivable&tipo=3', 'area=receivable&forma=x', `area=payable&vendedor=${SELLER}`, 'area=accounts&tipo=03', 'area=receivable&tipo=03&tipo=15'])
    assert.throws(() => financeListRoute(new URLSearchParams(bad)), /Confira os filtros/, bad);
});

test('210 Filtrar sends Tipo de pagamento, Forma de pagamento and Vendedor, shows their chips and removes each one', async () => {
  const source = listServer([title(1, { payment_method_id: CARD, payment_method_name: 'Cartão sintético', payment_type: '03', seller_id: SELLER, seller_name: 'Vendedora sintética', seller_source: 'conta' }), title(2)]);
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field', 'OriginPagination', 'FinanceSellerSelect'] });
  try {
    assert.ok(source.calls.every(call => !call.path.includes('formas-pagamento') && !call.catalog), 'no forma or vendedor is read before the fields are used');
    await view.change(field(view, 'Tipo de pagamento').props.id, '03');
    const forma = field(view, 'Forma de pagamento'); forma.props.onFocus(); await view.flush();
    assert.deepEqual(view.nodes().filter(node => node.type === 'option' && [CARD, SLIP].includes(node.props.value)).map(text), ['Cartão sintético', 'Boleto sintético']);
    await view.change(field(view, 'Forma de pagamento').props.id, CARD);
    field(view, 'Vendedor').props.onFocus(); await view.flush(); await wait(300); await view.flush();
    assert.ok(source.calls.some(call => call.catalog && call.path === '/v1/cadastros/vendedores/opcoes'));
    await view.change(field(view, 'Vendedor').props.id, SELLER);
    await view.submit();
    assert.equal(view.location().search, `?area=receivable&tipo=03&forma=${CARD}&vendedor=${SELLER}`);
    assert.equal(source.lists().at(-1).path, `/v1/financeiro/titles?page=1&limit=100&kind=receivable&option=open&from=${PERIOD.from}&to=${PERIOD.to}&payment_type=03&payment_method=${CARD}&seller=${SELLER}`);
    const chips = () => child(view, 'AppliedChips').props.chips;
    assert.deepEqual(chips().map(chip => chip.label), ['Tipo de pagamento: Cartão de Crédito', 'Forma de pagamento: Cartão sintético', 'Vendedor: Vendedora sintética']);
    assert.match(view.text(), /Cliente 1/); assert.doesNotMatch(view.text(), /Cliente 2/);
    chips()[2].onRemove(); await view.flush();
    assert.equal(view.location().search, `?area=receivable&tipo=03&forma=${CARD}`);
    chips()[0].onRemove(); await view.flush();
    assert.equal(view.location().search, `?area=receivable&forma=${CARD}`);
  } finally { view.unmount(); }
});

function drawerServer({ detail = {}, post } = {}) {
  const calls = [], state = { session: { phase: 'ready', membership: { user_id: actor, role: 'financeiro' } } };
  const controller = {
    getSnapshot: () => state.session,
    async catalog(path) { calls.push({ path, catalog: true }); if (path === '/v1/cadastros') return { read: ['contacts'], write: ['contacts'] }; if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return structuredClone(sellers); if (path.startsWith('/v1/cadastros/contatos/opcoes')) return { scope: 'contact_options', items: [], has_more: false }; throw new Error(`Unexpected ${path}`); },
    async finance(path, options = {}) {
      const call = { path, ...options, body: options.body ? structuredClone(options.body) : undefined }; calls.push(call);
      if (options.method === 'POST') return post(call);
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.pathname === '/v1/financeiro/accounts') return { entity: 'accounts', data_mode: 'erp_native', limit: 100, has_more: false, next_cursor: null, items: [] };
      if (url.pathname === '/v1/financeiro/formas-pagamento') return structuredClone(methods);
      if (url.pathname === '/v1/financeiro/categorias-arvore') return categoryTreeResponse(url.searchParams.get('kind'), []);
      const match = /^\/v1\/financeiro\/titles\/([^/]+)\/detalhe$/.exec(url.pathname);
      if (match) { const record = detail.record; return { entity: 'titles', data_mode: 'erp_native', record, origin: null, account: null, billing: null, imported: false, settled_before: false, original: null, history: null, ...detail }; }
      throw new Error(`Unexpected ${path}`);
    },
  };
  return { calls, controller, posts: () => calls.filter(call => call.method === 'POST') };
}
const mountDrawer = (source, props) => mountComponent('FinanceTitleDrawer.tsx', { controller: source.controller, kind: 'receivable', mode: 'create', title: null, onClose: () => {}, onSaved: () => {}, ...props },
  { expandChildren: ['DrawerField', 'FinanceSellerSelect'] });

test('210 gaveta: the forma sets the vencimento by its Prazo de recebimento, the Vendedor is chosen and saved with the conta', async () => {
  assert.equal(settlementDue('2026-03-02', 30, false), '2026-04-01'); assert.equal(settlementDue('2026-03-02', null, false), null);
  assert.equal(settlementDue('2026-04-03', 1, true), '2026-04-06', 'Saturday 04/04 moves to Monday 06/04'); assert.equal(settlementDue('2026-03-02', 366, false), null);
  const source = drawerServer({ post: call => ({ entity: 'titles', data_mode: 'erp_native', action: 'title_create', replayed: false, group_id: id(50), items: [title(50, { seller_id: SELLER, seller_name: 'Vendedora sintética', seller_source: 'conta' })] }) });
  const saved = [];
  const view = await mountDrawer(source, { onSaved: value => saved.push(value) });
  try {
    const issued = view.find(node => node.type === 'label' && text(node) === 'Emissão *').props.htmlFor;
    await view.change(issued, '2026-03-02');
    await view.change(field(view, 'Valor (R$) *').props.id, '100,00');
    await view.change(field(view, 'Histórico').props.id, 'Venda no cartão');
    await view.click('Pagamento');
    await view.change(field(view, 'Forma de Pagamento').props.id, CARD);
    assert.match(view.text(), /Vencimento pelo prazo de recebimento da forma: 30 dia\(s\) após a emissão\./);
    field(view, 'Vendedor').props.onFocus(); await view.flush(); await wait(300); await view.flush();
    await view.change(field(view, 'Vendedor').props.id, SELLER);
    await view.click('Cabeçalho');
    assert.equal(view.find(node => node.type === 'label' && text(node) === 'Vencimento *').props.htmlFor && field(view, 'Vencimento *').props.value, '2026-04-01');
    // Contact chosen through the picker answer (the drawer requires it).
    view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CatalogPicker').props.onSelect({ id: CONTACT, name: 'Cliente sintético' }); await view.flush();
    await view.submit();
    const body = source.posts()[0].body;
    assert.equal(source.posts()[0].path, '/v1/financeiro/actions/title_create');
    assert.deepEqual([body.data.seller_id, body.data.payment_method_id, body.data.installments], [SELLER, CARD, [{ amount_cents: '10000', due_on: '2026-04-01' }]]);
  } finally { view.unmount(); }
});

test('210 gaveta: a recurring conta keeps 240 characters and no Vendedor; a long Histórico is read whole and only changes when edited', async () => {
  assert.equal(descriptionLimit('unica'), 2000); assert.equal(descriptionLimit('mensal'), 240); assert.equal(descriptionLimit('parcelada'), 240);
  assert.deepEqual(recurrenceChanges({ description: 'x'.repeat(241), amount_cents: '100' }), { amount_cents: '100' }, 'a long Histórico stays on the conta');
  const long = `${'Histórico longo sintético. '.repeat(20)}fim`, short = long.slice(0, 240).trimEnd();
  const current = title(60, { description: short, long_history: true, version: 3 });
  assert.equal(drawerEditData(current, { ...drawerInitial(TODAY, current), description: long }, drawerLocks(current, null), long), null, 'the whole Histórico unchanged is no change');
  assert.deepEqual(drawerEditData(current, { ...drawerInitial(TODAY, current), description: `${long} mais` }, drawerLocks(current, null), long), { id: current.id, expected_version: 3, description: `${long} mais` });
  const source = drawerServer({ detail: { record: current, history: long }, post: call => ({ entity: 'titles', data_mode: 'erp_native', action: 'title_edit', replayed: false, record: title(60, { version: 4 }) }) });
  const view = await mountDrawer(source, { mode: 'edit', title: current });
  try {
    await view.flush();
    assert.equal(field(view, 'Histórico').props.value, long); assert.equal(view.guard().changed, false, 'filling in the whole Histórico is not an unsaved change');
    assert.match(view.text(), new RegExp(`${long.length} de 2\\.000 caracteres`));
    await view.change(field(view, 'Histórico').props.id, `${long} mais`);
    assert.equal(view.guard().changed, true);
    await view.submit();
    assert.equal(source.posts()[0].body.data.description, `${long} mais`);
  } finally { view.unmount(); }
  const recurring = drawerServer({ post: () => { throw new Error('not sent'); } }), drawer = await mountDrawer(recurring);
  try {
    await drawer.click('Ocorrência'); await drawer.change(field(drawer, 'Ocorrência').props.id, 'mensal');
    await drawer.click('Cabeçalho'); assert.equal(field(drawer, 'Histórico').props.maxLength, 240); assert.match(drawer.text(), /0 de 240 caracteres/);
    await drawer.click('Pagamento'); assert.equal(field(drawer, 'Vendedor').disabled, true, 'a recurrence has no Vendedor');
  } finally { drawer.unmount(); }
});

test('210 seller options are bound to their contract', () => {
  assert.equal(sellerOptionsPath('  Ana  '), '/v1/cadastros/vendedores/opcoes?q=Ana'); assert.equal(sellerOptionsPath(''), '/v1/cadastros/vendedores/opcoes');
  assert.deepEqual(sellerOptions(sellers), [{ id: SELLER, name: 'Vendedora sintética', code: 'V1' }, { id: OTHER, name: 'Vendedor sintético', code: null }]);
  for (const bad of [null, { scope: 'x', items: [] }, { scope: 'seller_options', items: [{ id: 'x', name: 'A' }] }, { scope: 'seller_options', items: Array.from({ length: 26 }, (_, n) => ({ id: id(n), name: 'A' })) }])
    assert.throws(() => sellerOptions(bad), /vendedores/);
});

test('210 the contact search of the finance editor goes through the contacts picker (seller portfolio, no papel: Origin contacts have none)', async () => {
  const calls = [], picked = [];
  const controller = { async catalog(path) { calls.push(path); return { scope: 'contact_options', has_more: true, items: [{ id: CONTACT, name: 'Cliente sintético', code: null, document: null, trade_name: null, city: null, state: null, has_notes: false, persons: 0 }] }; }, async finance(path) { throw new Error(`Unexpected ${path}`); } };
  const view = await mountComponent('RealFinance.tsx', { controller, entity: 'contacts', label: 'Cliente', value: null, onChange: value => picked.push(value), kind: 'receivable' }, { componentName: 'Picker' });
  try {
    assert.deepEqual(calls, ['/v1/cadastros/contatos/opcoes?limit=10'], 'no papel filter: contacts mirrored from Origin have no papel');
    assert.match(view.text(), /Há mais contatos com este texto\. Refine a pesquisa\./);
    await view.click('Cliente sintético'); assert.deepEqual(picked, [{ id: CONTACT, name: 'Cliente sintético' }]);
  } finally { view.unmount(); }
});

test('213 ⋮ Acessar remessa of a conta with boleto opens the remessa in the Origin list of Remessas', async () => {
  const REMITTANCE = id(700), source = listServer([title(1, { remittance: { id: REMITTANCE, sequence: 3, state: 'ready', our_number: '12345678' } }), title(2)]);
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field'] });
  try {
    const menus = view.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'RowMenu');
    assert.equal(menus[0].props.items.find(item => item.label === 'Acessar remessa').to, `/financeiro-empresa?area=remessas&remessa=${REMITTANCE}`);
    assert.equal(menus[1].props.items.some(item => item.label === 'Acessar remessa'), false, 'only a conta in a remessa');
  } finally { view.unmount(); }
});

test('FIN-017 the padrão/customizada choice saved on the server opens the list in that view for the user', async () => {
  const source = listServer([title(1, { category_name: 'Categoria sintética' })]);
  source.controller.listPreferences = async () => ({ scope: 'list_preferences', data_mode: 'erp_native', list_id: 'financeiro.contas_receber', version: 3, columns: ['category', 'history'], filters: { listagem: 'customizada' }, updated_at: '2026-10-20T12:00:00Z' });
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field', 'ToolButton', 'ViewToggle'] });
  try {
    for (let i = 0; i < 3; i++) { await wait(5); await view.flush(); }
    const headers = view.nodes().filter(node => node.type === 'th').map(text);
    assert.deepEqual(headers.slice(1, 4), ['Cliente', 'Categoria', 'Histórico'], 'customizada without clicking, with the saved columns');
  } finally { view.unmount(); }
});

test('FIN-070 the Cliente of the gaveta has the contact tools: lupa "Pesquisar" (busca avançada) and Adicionar novo', async () => {
  const source = drawerServer({ post: () => { throw new Error('not sent'); } }), view = await mountDrawer(source);
  try {
    const picker = view.nodes().find(node => typeof node.type === 'function' && node.type.name === 'CatalogPicker');
    assert.equal(picker.props.entity, 'contacts'); assert.deepEqual(picker.props.contactTools, {}, 'the busca avançada (ENTER or lupa) of the contacts lane');
    assert.equal(typeof picker.props.onCreate, 'function', 'Adicionar novo opens the Contato rápido');
  } finally { view.unmount(); }
});

test('FIN-054 Gerar remessa (Em aberto) takes the selected contas to Incluir Remessa; contas already in a remessa block it', async () => {
  const source = listServer([title(1), title(2)]);
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field'] });
  try {
    assert.equal(view.button('Gerar remessa').disabled, true, 'nothing selected');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await view.flush();
    await view.click('Gerar remessa');
    assert.equal(view.location().pathname, '/cobranca-operacional');
    assert.equal(new URLSearchParams(view.location().search).get('titulos'), `${id(1)},${id(2)}`);
  } finally { view.unmount(); }
  const billed = listServer([title(1, { remittance: { id: id(700), sequence: 3, state: 'ready', our_number: '1' } })]);
  const other = await mountComponent('RealFinance.tsx', { controller: billed.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field'] });
  try {
    other.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar todos').props.onChange(); await other.flush();
    assert.equal(other.button('Gerar remessa').disabled, true); assert.equal(other.button('Gerar remessa').props.title, 'Há contas já incluídas em remessa.');
  } finally { other.unmount(); }
});

test('FIN-018 the Forma de pagamento column shows the kind of the forma (tPag) beside its name', async () => {
  const source = listServer([title(1, { payment_method_id: CARD, payment_method_name: 'Cartão sintético', payment_type: '03' }), title(2, { payment_method_id: SLIP, payment_method_name: 'Boleto sintético', payment_type: '15' })]);
  const view = await mountComponent('RealFinance.tsx', { controller: source.controller }, { location: '/financeiro-empresa?area=receivable', expandChildren: ['NativeListLayout', 'Field'] });
  try {
    const cells = view.nodes().filter(node => node.type === 'span' && node.props.className === 'finance-payment-method');
    assert.deepEqual(cells.map(cell => [cell.props.title, text(cell).trim()]), [['Cartão de Crédito', 'Cartão sintético'], ['Boleto Bancário', 'Boleto sintético']]);
    assert.deepEqual(cells.map(cell => (Array.isArray(cell.props.children) ? cell.props.children : [cell.props.children]).find(item => item && typeof item === 'object')?.props.name), ['credit-card', 'barcode']);
  } finally { view.unmount(); }
});
