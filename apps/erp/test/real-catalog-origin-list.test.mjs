import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { badgeClass } from '../src/lib/origin-list.ts';

globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '91000000-0000-4000-8000-0000000000aa';
const warehouse = '91000000-0000-4000-8000-0000000000bb';
const active = { id: '91000000-0000-4000-8000-000000000001', entity: 'products', version: 1, active: true, name: 'Parafuso fictício', code: 'QA-1', unit: 'UN', price: '1.5000', kind: 'P', format: 'S', source: null, stock: { state: 'recorded', quantity: '7.500000', warehouse: null } };
const inactive = { ...active, id: '91000000-0000-4000-8000-000000000002', active: false, name: 'Porca fictícia', code: 'QA-2', stock: { state: 'no_movements', quantity: null, warehouse: null } };
const zero = { ...active, id: '91000000-0000-4000-8000-000000000003', name: 'Arruela fictícia', code: 'QA-3', format: 'V', stock: { state: 'recorded', quantity: '0.000000', warehouse: null } };
const contact = { id: '91000000-0000-4000-8000-000000000004', entity: 'contacts', version: 1, active: true, name: 'Cliente fictício', code: 'C-1', document: '00.000.000/0001-00', city: 'Piracicaba', phone: null, mobile: '(19) 90000-0000', roles: ['customer', 'carrier'], source: null };

function server(access, { products = [active, inactive, zero], contacts = [contact], total, stockVisible = true, role = 'admin' } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { data_mode: 'erp_native', ...access };
      const [route, search = ''] = path.split('?'), [, entity, id] = route.match(/^\/v1\/cadastros\/(\w+)(?:\/(.+))?$/);
      const items = entity === 'contacts' ? contacts : entity === 'products' ? products : [];
      if (id) return { entity, record: items.find(item => item.id === id), data_mode: 'erp_native' };
      const params = new URLSearchParams(search);
      return { entity, items, page: Number(params.get('page')), size: Number(params.get('size')), total: total ?? items.length, sort: params.get('sort') || 'created_desc', ...(entity === 'products' ? { stock_visible: stockVisible } : {}), data_mode: 'erp_native' };
    },
    async stockPositions(path) { calls.push({ path }); return { items: [{ id: warehouse, name: 'Geral', active: true }], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
  };
  return { calls, controller, lists: () => calls.filter(call => /^\/v1\/cadastros\/\w+\?/.test(call.path)).map(call => new URLSearchParams(call.path.split('?')[1])) };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const headers = view => view.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
const badge = (view, label) => view.find(node => node.type === 'span' && node.props.children === label && String(node.props.className).includes('status-badge'));
const component = (view, name) => view.find(node => node.type?.name === name);
const row = (view, id) => view.find(node => node.type === 'tr' && node.key === id);
const cells = (view, className) => view.nodes().filter(node => node.type === 'td' && String(node.props.className || '').includes(className)).map(node => textOf(node.props.children));

test('products open newest first in pages of 100 with total, Origin columns, stock and a clickable row that only reads', async () => {
  const { calls, controller, lists } = server({ read: ['products', 'contacts'], write: ['products'] }, { total: 250 });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.match(view.text(), /Produtos/);
    assert.ok(view.button('Incluir cadastro'));
    assert.equal(view.input('catalog-search').props.placeholder, 'Pesquisar por código, descrição ou GTIN');
    assert.deepEqual(Object.fromEntries(lists()[0]), { page: '1', size: '100', situation: 'latest' }, 'default: Situação Últimos Incluídos (v2 page, migration 120)');
    assert.deepEqual(headers(view), ['Seleção', 'Imagem', 'Descrição', 'Código', 'Unidade', 'Preço', 'Estoque', 'Marcadores', 'Situação', 'Origem', 'Ações']);
    assert.equal(badge(view, 'Ativo').props.className, badgeClass('Ativo'));
    assert.equal(badge(view, 'Inativo').props.className, badgeClass('Inativo'));
    assert.deepEqual(cells(view, 'catalog-stock'), ['7,5', 'Sem lançamentos', '0'], 'no movements stays distinct from a recorded zero');
    const pagination = component(view, 'OriginPagination').props;
    assert.deepEqual([pagination.page, pagination.pages, pagination.size, pagination.total], [1, 3, 100, 250]);
    assert.match(view.text(), /Quantidade de Produtos250/);
    assert.match(view.text(), /250 cadastros encontrados/);
    assert.ok(view.button(active.name), 'the first-cell button stays available for keyboard users');
    assert.ok(calls.some(call => call.path === '/v1/posicoes-estoque/depositos?limit=100'), 'depósito options for the Estoque filter');

    row(view, inactive.id).props.onClick({ button: 0 }); await view.flush();
    assert.equal(calls.at(-1).path, `/v1/cadastros/products/${inactive.id}`);
    assert.equal(component(view, 'Editor').props.record.id, inactive.id);
    assert.equal(calls.some(call => call.method), false, 'opening a row only reads');
  } finally { view.unmount(); }
});

test('numbered pages, column ordering and the inclusion-order chip reset to page 1 and never write', async () => {
  const { calls, controller, lists } = server({ read: ['products'], write: [] }, { total: 250 });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    const chips = () => component(view, 'AppliedChips').props.chips;
    // Products (Origin): the chip "Situação: Últimos Incluídos" stands where the order chip was; the order is the column headers.
    assert.deepEqual(chips().map(chip => chip.label), ['Situação: Últimos Incluídos']);
    component(view, 'OriginPagination').props.onPage(3); await view.flush();
    assert.equal(lists().at(-1).get('page'), '3');
    const sortButton = label => view.find(node => node.type === 'th' && textOf(node.props.children) === label).props.children;
    sortButton('Descrição').props.onClick(); await view.flush();
    assert.deepEqual([lists().at(-1).get('sort'), lists().at(-1).get('page')], ['name_asc', '1']);
    assert.equal(view.find(node => node.type === 'th' && textOf(node.props.children) === 'Descrição').props['aria-sort'], 'ascending');
    sortButton('Descrição').props.onClick(); await view.flush();
    assert.equal(lists().at(-1).get('sort'), 'name_desc');
    sortButton('Código').props.onClick(); await view.flush();
    assert.equal(lists().at(-1).get('sort'), 'code_asc');
    assert.deepEqual(chips().map(chip => chip.label), ['Situação: Últimos Incluídos']);
    chips()[0].onRemove(); await view.flush();
    assert.deepEqual([lists().at(-1).get('situation'), lists().at(-1).get('active'), lists().at(-1).get('page')], ['active', null, '1'], 'removing the Situação chip changes the situation and returns to page 1');
    assert.deepEqual(chips().map(chip => chip.label), ['Situação: Ativos']);
    component(view, 'AppliedChips').props.onClear(); await view.flush();
    assert.deepEqual(Object.fromEntries(lists().at(-1)), { page: '1', size: '100', situation: 'latest' });
    assert.equal(calls.some(call => call.method), false);
  } finally { view.unmount(); }
});

// The contacts list (types, situations, filters and the URL contact type) is covered by contacts-ui.test.mjs.
test('product Estoque, Depósito and NCM number filters; hidden stock removes the column and the filter', async () => {
  const { controller, lists } = server({ read: ['products'], write: ['products'] });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(view.input('catalog-stock-filter').props.children[1].map(option => option.props.children), ['Igual à zero', 'Menor que zero', 'Maior que zero', 'Sem lançamentos']);
    await view.change('catalog-stock-filter', 'positive');
    await view.change('catalog-warehouse-filter', warehouse);
    await view.change('catalog-ncm-filter', 'present');
    await view.change('catalog-ncm-number-filter', '73.18');
    await view.submit();
    assert.deepEqual(Object.fromEntries(lists().at(-1)), { page: '1', size: '100', situation: 'latest', ncm_presence: 'present', ncm: '7318', stock: 'positive', warehouse_id: warehouse });
    assert.ok(component(view, 'AppliedChips').props.chips.some(chip => chip.label === 'Estoque: Maior que zero (Geral)'));
    // The browser refuses the form before a value the server would reject (ncm needs 2 to 8 digits).
    assert.deepEqual([view.input('catalog-ncm-number-filter').props.pattern, view.input('catalog-ncm-number-filter').props.minLength], ['[0-9]{2,8}', 2]);
    assert.ok(new RegExp(`^(?:${view.input('catalog-ncm-number-filter').props.pattern})$`).test('7318') && !new RegExp(`^(?:${view.input('catalog-ncm-number-filter').props.pattern})$`).test('7'));
  } finally { view.unmount(); }
  const hidden = server({ read: ['products'], write: [] }, { stockVisible: false, products: [{ ...active, stock: null }] });
  const other = await mountComponent('RealCatalog.tsx', { controller: hidden.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.equal(headers(other).includes('Estoque'), false);
    assert.throws(() => other.input('catalog-stock-filter'));
    assert.equal(hidden.calls.some(call => call.path.startsWith('/v1/posicoes-estoque')), false);
  } finally { other.unmount(); }
});

test('company route: Ctrl/middle click opens a direct link in a new tab; the URL owns the open record and the contact type', async () => {
  const opened = [], previous = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  const { calls, controller, lists } = server({ read: ['products', 'contacts'], write: ['products', 'contacts'] });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { location: '/cadastros-reais?cadastro=products', expandChildren: ['NativeListLayout'] });
  try {
    const reads = () => calls.filter(call => /\/v1\/cadastros\/products\/[0-9a-f-]{36}$/.test(call.path)).length;
    row(view, active.id).props.onClick({ ctrlKey: true }); await view.flush();
    row(view, active.id).props.onAuxClick({ button: 1 }); await view.flush();
    assert.deepEqual(opened, [[`/cadastros-reais?cadastro=products&registro=${active.id}`, '_blank', 'noopener'], [`/cadastros-reais?cadastro=products&registro=${active.id}`, '_blank', 'noopener']]);
    assert.equal(reads(), 0, 'a new tab is opened without reading here');
    const link = view.find(node => node.type === 'test-router-link' && node.props.children === active.name);
    assert.equal(link.props.to, `/cadastros-reais?cadastro=products&registro=${active.id}`);
    row(view, active.id).props.onClick({ button: 0 }); await view.flush();
    assert.equal(view.location().search, `?cadastro=products&registro=${active.id}`);
    assert.equal(reads(), 1); assert.equal(component(view, 'Editor').props.record.id, active.id);
    component(view, 'Editor').props.onClose(); await view.flush();
    assert.equal(view.location().search, '?cadastro=products');
    await view.navigate('/cadastros-reais?cadastro=products&registro=not-a-uuid');
    assert.match(view.text(), /identificador de cadastro inválido/);
    assert.equal(reads(), 1);
  } finally { view.unmount(); globalThis.window = previous; }
  assert.ok(lists().length > 0);
});

test('company route: a middle click on the name link opens one tab; a confirmed navigation discards the inline price edit', async () => {
  const opened = [], previous = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  const { controller } = server({ read: ['products'], write: ['products'] });
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { location: '/cadastros-reais?cadastro=products', expandChildren: ['NativeListLayout'] });
  try {
    const selectors = [];
    row(view, active.id).props.onAuxClick({ button: 1, target: { closest: selector => { selectors.push(selector); return {}; } } }); await view.flush();
    assert.deepEqual(opened, [], 'the browser already opens the link; the row must not open a second tab');
    assert.match(selectors[0], /(^|, )a(,|$)/); assert.match(selectors[0], /button/); assert.match(selectors[0], /input/);
    row(view, active.id).props.onAuxClick({ button: 1, target: { closest: () => null } }); await view.flush();
    assert.deepEqual(opened, [[`/cadastros-reais?cadastro=products&registro=${active.id}`, '_blank', 'noopener']], 'any other cell still opens the direct link');

    view.find(node => node.type === 'button' && node.props['aria-label'] === `Editar o preço de ${active.name}`).props.onClick({ stopPropagation() {} }); await view.flush();
    await view.change('catalog-inline-price', '9');
    assert.equal(view.guard().changed, true);
    // The name link and Back are router navigations: the shared guard confirms them, then the list forgets the edit.
    await view.navigate(`/cadastros-reais?cadastro=products&registro=${active.id}`);
    assert.equal(component(view, 'Editor').props.record.id, active.id);
    component(view, 'Editor').props.onClose(); await view.flush();
    assert.throws(() => view.input('catalog-inline-price'), 'the discarded price is not shown again');
    assert.equal(view.guard().changed, false);
  } finally { view.unmount(); globalThis.window = previous; }
});

test('Estoque > Fornecedores links to the contacts list already filtered by supplier', async () => {
  const { resolveMenu } = await import('../src/lib/origin-menu.ts');
  const estoque = resolveMenu('real', { role: 'estoque', resources: ['contacts', 'products', 'purchase_orders'] }).find(group => group.name === 'Estoque');
  const suppliers = estoque.columns.flatMap(column => column.items).find(item => item.label === 'Fornecedores');
  assert.equal(suppliers.to, '/cadastros-reais?cadastro=contacts&contato=fornecedor');
  const cadastros = resolveMenu('real', { role: 'estoque', resources: ['contacts', 'products', 'purchase_orders'] }).find(group => group.name === 'Cadastros');
  assert.equal(cadastros.columns[0].items.find(item => item.label === 'Clientes e fornecedores').to, '/cadastros-reais?cadastro=contacts', 'the full list keeps its link');
});
