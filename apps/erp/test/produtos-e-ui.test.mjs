import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import { permissionStatus } from '../../../packages/erp-domain/src/user-permissions.mjs';
import { appliedProductFilters, clearedProductFilter, EMPTY_PRODUCT_FILTERS, productFiltersFromSaved, productSavedFilters } from '../src/lib/product-model.ts';
import { emptyFilters, filterChips, filtersFromPreference, filtersToPreference, fiscalListQuery, SCREENS } from '../src/lib/fiscal-invoice-list-model.ts';
import { parseInvoiceTagSave, parseInvoiceTagSets } from '../src/lib/invoice-tags-model.ts';

// Produtos, onda E (migrações 234-236): Componente do Tipo "Produtos com composição", ajuda do Formato no assistente, estoque do
// depósito padrão na exportação, permissões de Campos Customizados e os Marcadores (tags) das notas fiscais. Dados sintéticos.
let previous;
test.before(() => {
  previous = globalThis.document;
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, classList: { add() {}, remove() {} } }, createElement: () => ({ click() {}, remove() {} }) };
});
test.after(() => { globalThis.document = previous; });
const actor = '97000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const id = n => `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const preferenceView = (pageId, values) => { const page = preferencePage(pageId); return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'admin', can_manage: true, directory: null,
  items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: stamp } : { key: field.key, value: field.default, version: 0, updated_at: null }) }; };
const wait = async view => { await view.flush(); await new Promise(resolve => setTimeout(resolve, 320)); await view.flush(); };
const tagItem = (n, name, extra = {}) => ({ id: id(n), kind: 'tags', parent_id: null, name, version: 1, created_at: stamp, updated_at: stamp, tag_type: 'invoices', children: 0, products: 0, contacts: 0, invoices: 0, ...extra });

test('filter model: Componente only with "Produtos com composição", cleared with the Tipo, saved with "Tornar padrão"', () => {
  const draft = { ...EMPTY_PRODUCT_FILTERS, type: 'composition', component_id: id(1), component_name: 'Parafuso' };
  assert.deepEqual([appliedProductFilters(draft).component_id, appliedProductFilters({ ...draft, type: 'simple' }).component_id], [id(1), '']);
  assert.deepEqual(clearedProductFilter('type'), { type: '', component_id: '', component_name: '' });
  assert.deepEqual(clearedProductFilter('component_id'), { component_id: '', component_name: '' });
  const saved = productSavedFilters(draft, '');
  assert.deepEqual([saved.component_id, saved.component_name], [id(1), 'Parafuso']);
  assert.deepEqual([productFiltersFromSaved(saved).filters.component_id, productFiltersFromSaved({ ...saved, type: 'simple' }).filters.component_id], [id(1), '']);
  assert.equal(productFiltersFromSaved({ type: 'composition', component_id: 'x' }).filters.component_id, '');
});

function listServer({ components = () => [] } = {}) {
  const calls = [], stockCalls = [];
  const rows = [{ id: id(10), entity: 'products', version: 2, active: true, name: 'Kit sintético', code: null, unit: 'KIT', price: '10.0000', kind: 'P', format: 'E', gtin: null,
    created_at: stamp, updated_at: stamp, source: null, stock: null, stock_min: null, stock_max: null, thumbnail: null, deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'categorias-produtos': 'categories', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) return { entity: 'products', items: rows, page: 1, size: 100, total: 1, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async stock(path, options = {}) {
      stockCalls.push(path);
      const query = new URLSearchParams(path.split('?')[1]).get('q');
      return components(query, options.signal);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return preferenceView('cadastros-produtos', {}); },
  };
  return { calls, stockCalls, controller };
}
const componentAnswer = (query, items) => ({ scope: 'stock_composition_components', data_mode: 'erp_native', query, stock_visible: false, total: items.length,
  items: items.map(([n, name]) => ({ id: id(n), name, code: `C-${n}`, unit: 'UN', price: null, cost_price: null, stock: null })) });
const pageParams = calls => new URLSearchParams(calls.filter(call => call.path.startsWith('/v1/cadastros/products?')).at(-1).path.split('?')[1]);

test('product list: "Produtos com composição" reveals Componente; the picked product filters the page, the chip and the export', async () => {
  let release; const late = new Promise(resolve => { release = resolve; });
  const service = listServer({ components: async query => query === 'Par' ? late.then(() => componentAnswer('Par', [[2, 'Parede velha']])) : componentAnswer(query, [[1, 'Parafuso sintético']]) });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'AppliedChips'] });
  try {
    assert.throws(() => view.input('catalog-component-filter'), 'no Componente with Tipo Todos');
    await view.change('catalog-type-filter', 'composition');
    assert.equal(view.input('catalog-component-filter').props.placeholder, 'Digite o nome ou código');
    assert.match(view.text(), /Uma composição espelhada do Origin só entra neste filtro depois que a estrutura dela é informada no FAGOO\./);
    // An older answer arriving after a newer text is ignored; while the search waits it says so (never "nenhum produto").
    await view.change('catalog-component-filter', 'Par');
    assert.match(view.text(), /Pesquisando…/); assert.doesNotMatch(view.text(), /Nenhum produto simples ativo encontrado/);
    await wait(view);
    await view.change('catalog-component-filter', 'Parafuso'); await wait(view);
    release(); await wait(view);
    const options = view.nodes().filter(node => node.type === 'button' && node.props.role === 'option');
    assert.deepEqual(options.map(textOf), ['Parafuso sintético (C-1)']);
    options[0].props.onClick(); await view.flush();
    assert.equal(view.input('catalog-component-filter').props.value, 'Parafuso sintético');
    // The picked product is not searched again (its name stays in the field without another request).
    const searches = service.stockCalls.length; await wait(view);
    assert.equal(service.stockCalls.length, searches);
    await view.submit();
    const params = pageParams(service.calls);
    assert.deepEqual([params.get('type'), params.get('component_id')], ['composition', id(1)]);
    assert.match(view.text(), /Componente: Parafuso sintético/);
    const exportLink = view.find(node => node.type === 'test-router-link' && textOf(node.props.children).includes('Exportar dados para planilha'));
    assert.equal(new URLSearchParams(exportLink.props.to.split('?')[1]).get('component_id'), id(1));
    // Another Tipo drops the Componente from the draft and from the applied filters.
    await view.change('catalog-type-filter', 'simple');
    assert.throws(() => view.input('catalog-component-filter'));
    // A hidden Componente never searches (the text left in it is not sent while the Tipo is another one).
    await wait(view);
    assert.equal(service.stockCalls.length, searches);
    await view.submit();
    assert.deepEqual([pageParams(service.calls).get('type'), pageParams(service.calls).has('component_id')], ['simple', false]);
  } finally { view.unmount(); }
});

function editorServer() {
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path) {
      if (path.startsWith('/v1/cadastros/taxonomias/')) { const kind = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)]; return { kind, items: [], data_mode: 'erp_native' }; }
      if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: [], data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async stock() { throw new AccessError(403); }, async stockPositions() { throw new AccessError(403); },
    async preferences(path) { if (path.includes('empresa-geral')) return preferenceView('empresa-geral', {}); return preferenceView('cadastros-produtos', { 'produtos.pular_etapas': false }); },
  };
  return { controller };
}

test('wizard: Formato "Simples" | "Com variações" | "Com composição" with the help of the three formats', async () => {
  const view = await mountComponent('ProductEditor.tsx', { controller: editorServer().controller, entity: 'products', record: null, writable: true, onSaved() {}, onClose() {} },
    { componentName: 'ProductEditor', expandChildren: ['ProductForm', 'WizardFormatHelp', 'Modal', 'ProductValidationPanel', 'ProductCustomFields'] });
  try {
    assert.deepEqual(view.input('catalog-format').props.children[1].map(option => textOf(option.props.children)), ['Simples', 'Com variações', 'Com composição (Kit ou união de vários itens)']);
    const help = view.button('Qual formato escolher?');
    assert.equal(help.props['aria-expanded'], false);
    assert.doesNotMatch(view.text(), /um item único/);
    await view.click('Qual formato escolher?');
    assert.equal(view.button('Qual formato escolher?').props['aria-expanded'], true);
    assert.match(view.text(), /Simples: um item único, sem grade de tamanhos ou cores\./);
    assert.match(view.text(), /cada variação vira um produto com código, preço e estoque próprios/);
    assert.match(view.text(), /Com composição: um kit ou a união de vários itens/);
  } finally { view.unmount(); }
});

test('export: the instruction says which stock is exported and the Componente travels to every read', async () => {
  const calls = [];
  const answer = (path, scope) => { const q = new URLSearchParams(path.split('?')[1]); return { entity: 'products', items: [], offset: Number(q.get('offset') ?? 0), limit: Number(q.get('limit') ?? 250), total: 3, stock_visible: true, ...scope, data_mode: 'erp_native' }; };
  const mount = scope => mountComponent('ProductExport.tsx', { controller: { async catalog(path) { calls.push(path); if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: [], data_mode: 'erp_native' }; return answer(path, scope); } } },
    { location: `/exportacao-produtos?type=composition&component_id=${id(1)}` });
  let view = await mount({ stock_scope: 'default_warehouse', stock_warehouse: { id: id(5), name: 'Geral' } });
  try {
    assert.match(view.text(), /O estoque exportado é o do depósito padrão \(Geral\), como no Origin\./);
    assert.equal(new URLSearchParams(calls.find(path => path.startsWith('/v1/cadastros/products/exportacao')).split('?')[1]).get('component_id'), id(1));
  } finally { view.unmount(); }
  view = await mount({ stock_scope: 'considered_warehouses', stock_warehouse: null });
  try { assert.match(view.text(), /Sem depósito padrão definido \(Preferências › Depósitos\)/); } finally { view.unmount(); }
  view = await mount({ stock_scope: 'all_warehouses', stock_warehouse: null });
  try { assert.match(view.text(), /O estoque exportado é a soma de todos os depósitos\./); } finally { view.unmount(); }
});

function fieldsServer({ screen }) {
  const calls = [];
  const field = { id: id(20), module: 'products', field_type: 'text', name: 'Material', hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium', grouped: false, active: true, version: 1,
    created_at: stamp, updated_at: stamp, options: [], category_ids: [], products: 0 };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'estoque' } }), subscribe: () => () => {},
    async catalog(path) {
      calls.push(path);
      if (path === '/v1/cadastros') return { read: ['products'], write: ['products'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/campos-customizados?tela=produtos') { if (screen === 'denied') throw new AccessError(403); return { module: 'products', items: [field], permissions: screen, data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: 'categories', items: [], data_mode: 'erp_native' };
      throw new AccessError(404);
    },
  };
  return { calls, controller };
}

test('Campos Customizados follows Sistema › Usuários › Permissões: denied screen, Inclusão e edição without Exclusão', async () => {
  let view = await mountComponent('CustomFields.tsx', { controller: fieldsServer({ screen: 'denied' }).controller }, { location: '/campos-customizados' });
  try {
    assert.match(view.text(), /Seu usuário não tem a permissão Campos Customizados \(Produtos\)/);
    assert.throws(() => view.button('Adicionar campo'));
    assert.doesNotMatch(view.text(), /Nenhum campo customizado cadastrado/);
  } finally { view.unmount(); }
  view = await mountComponent('CustomFields.tsx', { controller: fieldsServer({ screen: { insert_edit: true, delete: false } }).controller }, { location: '/campos-customizados' });
  try {
    assert.ok(view.button('Adicionar campo'));
    assert.equal(view.find(node => node.props?.['aria-label'] === 'Situação de Material').props.disabled, false);
    assert.equal(view.nodes().some(node => node.props?.['aria-label'] === 'Excluir Material' || node.props?.['aria-label'] === 'Excluir selecionados' || node.props?.['aria-label'] === 'Selecionar Material'), false, 'no deletion without Exclusão');
  } finally { view.unmount(); }
  view = await mountComponent('CustomFields.tsx', { controller: fieldsServer({ screen: { insert_edit: false, delete: true } }).controller }, { location: '/campos-customizados' });
  try {
    assert.throws(() => view.button('Adicionar campo'));
    assert.ok(view.find(node => node.props?.['aria-label'] === 'Excluir Material'));
    assert.equal(view.find(node => node.props?.['aria-label'] === 'Situação de Material').props.disabled, true);
  } finally { view.unmount(); }
  assert.deepEqual(['preferencias.campos_customizados', 'preferencias.campos_customizados.ie', 'preferencias.campos_customizados.ex', 'preferencias.campos_customizados.produtos', 'preferencias.campos_customizados.os'].map(permissionStatus),
    ['applied', 'applied', 'applied', 'applied', 'stored']);
});

function taxonomyServer({ role, permissions = null }) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['admin', 'estoque'].includes(role) ? ['products'] : [], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/tags') return { kind: 'tags', items: [tagItem(1, 'Urgente', { invoices: 4 }), tagItem(2, 'Promoção', { tag_type: 'products', products: 3, invoices: undefined })], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/grupos-tags') return { kind: 'tag_groups', items: [], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/categorias-produtos') return { kind: 'categories', items: [{ id: id(30), kind: 'categories', parent_id: null, name: 'Ferragens', version: 1, created_at: stamp, updated_at: stamp, tag_type: null, children: 0, products: 0, contacts: 0 }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: [{ id: id(20), module: 'products', field_type: 'text', name: 'Material', hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium', grouped: true, active: true, version: 1, created_at: stamp, updated_at: stamp, options: [], category_ids: [id(30)], products: 0 }], data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async system() { return { scope: 'access_permissions', data_mode: 'erp_native', user_id: actor, role, user_type: 'normal', permissions, access: { open: true, until: null } }; },
  };
  return { calls, controller };
}

test('Tags: the Tipo "Notas fiscais" is written by fiscal (not by consulta) and counts its notes', async () => {
  let view = await mountComponent('ProductTaxonomy.tsx', { controller: taxonomyServer({ role: 'fiscal' }).controller, kind: 'tags' }, { location: '/tags?tipo=notas' });
  try {
    assert.match(view.text(), /Urgente/); assert.doesNotMatch(view.text(), /Promoção/, '?tipo=notas filters Notas fiscais');
    assert.match(view.text(), /Notas fiscais/);
    const row = view.nodes().find(node => node.type === 'tr' && textOf(node).includes('Urgente'));
    assert.match(textOf(row), /4/);
    await view.click('Incluir tag');
    assert.deepEqual(view.input('taxonomy-type').props.children.map(option => textOf(option.props.children)), ['Notas fiscais'], 'fiscal writes only Notas fiscais tags');
  } finally { view.unmount(); }
  view = await mountComponent('ProductTaxonomy.tsx', { controller: taxonomyServer({ role: 'consulta' }).controller, kind: 'tags' }, { location: '/tags?tipo=notas' });
  try { assert.match(view.text(), /Somente consulta/); assert.throws(() => view.button('Incluir tag')); } finally { view.unmount(); }
});

test('Nova categoria: without "Inclusão e edição" of Campos Customizados the linked fields are shown, not changed or sent', async () => {
  const service = taxonomyServer({ role: 'estoque', permissions: ['cadastros.produtos', 'preferencias.campos_customizados', 'preferencias.campos_customizados.produtos'] });
  const view = await mountComponent('ProductTaxonomy.tsx', { controller: service.controller, kind: 'categories' }, { location: '/categorias-produtos' });
  try {
    view.find(node => node.type === 'button' && textOf(node) === 'Ferragens').props.onClick(); await view.flush();
    assert.match(view.text(), /Material/);
    assert.match(view.text(), /não tem a permissão Campos Customizados › Inclusão e edição/);
    assert.equal(view.nodes().some(node => node.props?.['aria-label'] === 'Remover o campo Material'), false);
    assert.throws(() => view.input('taxonomy-fields'));
  } finally { view.unmount(); }
});

// ---- Marcadores das notas fiscais ----
const originRow = (n, over = {}) => ({ origin: 'origin', id: String(9000 + n), version: null, number: 120 + n, series: 1, issue_date: '2026-10-15', entry_date: null, name: `Cliente Origin ${n}`, document: '12345678000190', state: 'SP',
  nature: null, status: 6, status_raw: '5', total: '100.10', total_known: true, environment: '1', issue_type: null, access_key: null, xml_id: null, xml_hash: null, xml_size: null, protocol_present: true, event_count: 0, orders: [], ...over });
const listResponse = (path, rows) => { const q = new URLSearchParams(path.split('?')[1]);
  return { items: rows, origin: q.get('origin') ?? 'origin', model: q.get('model'), direction: q.get('direction') ?? '1', page: Number(q.get('page')), limit: 100, order: q.get('order') ?? 'date_desc',
    has_more: false, total_count: rows.length, total_amount: '200.20', amount_unknown: 0, brufap_visible: true, show_totals: true, data_mode: q.get('origin') === 'brufap' ? 'erp_native_homologation' : 'origin_mirror_readonly' }; };
const nativeNoteId = n => id(9000 + n);
const nativeNoteRow = n => originRow(n, { origin: 'brufap', id: nativeNoteId(n), version: 1, environment: '2', issue_type: 'N', status: 1, status_raw: null, protocol_present: false });
const tagSet = (invoice, version, tags) => ({ invoice_id: invoice, version, tag_ids: tags.map(tag => tag.id), tags: tags.map(tag => ({ id: tag.id, name: tag.name, group_id: null, group_name: null })) });
function notesServer({ role = 'fiscal', origin = role === 'consulta' ? 'origin' : 'brufap', patch } = {}) {
  const calls = [], urgent = tagItem(1, 'Urgente'), review = tagItem(2, 'Conferir');
  const key = n => origin === 'origin' ? String(9000 + n) : nativeNoteId(n);
  let sets = { [key(1)]: tagSet(key(1), 1, [urgent]), [key(2)]: tagSet(key(2), 0, []) };
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }), subscribe: () => () => {},
    async fiscalInvoices(path) { calls.push({ path }); if (path.startsWith('/v1/notas-fiscais?')) return listResponse(path, [1, 2].map(origin === 'origin' ? n => originRow(n) : nativeNoteRow)); throw new AccessError(404); },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'x', version: 0, columns: null, filters: null, updated_at: null }; },
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path.startsWith('/v1/cadastros/notas-fiscais/tags?')) { const q = new URLSearchParams(path.split('?')[1]); return { scope: 'invoice_tags', origin: q.get('origem'), model: q.get('modelo'), data_mode: 'erp_native', items: q.get('ids').split(',').map(n => sets[n]) }; }
      const save = /^\/v1\/cadastros\/notas-fiscais\/brufap\/55\/([a-f0-9-]+)\/tags$/.exec(path);
      if (save && options.method === 'PATCH') {
        if (patch) { const result = await patch(options.body, calls); if (result) return result; }
        const tags = [urgent, review].filter(tag => options.body.tag_ids.includes(tag.id)); sets = { ...sets, [save[1]]: tagSet(save[1], options.body.expected_version + 1, tags) };
        return { scope: 'invoice_tags', origin: 'brufap', model: '55', invoice: sets[save[1]], changed: true, replayed: false, data_mode: 'erp_native' };
      }
      if (path === '/v1/cadastros/taxonomias/tags') return { kind: 'tags', items: [urgent, review, tagItem(3, 'Produto', { tag_type: 'products', invoices: undefined })], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/grupos-tags') return { kind: 'tag_groups', items: [], data_mode: 'erp_native' };
      return { items: [], has_more: false };
    },
  };
  return { calls, controller, origin, tags: { urgent, review } };
}
const mountNotes = service => mountComponent('RealFiscalInvoices.tsx', { controller: service.controller, screen: 'nfe' }, { location: `/historico-fiscal?modelo=55${service.origin === 'brufap' ? '&origem=brufap' : ''}`, expandChildren: ['NativeListLayout', 'InvoiceTagCell', 'InvoiceTagFilter', 'InvoiceTagsOverlay', 'AppliedChips'] });
const confirmAgain = async view => { const modal = view.nodes().find(node => node.type?.name === 'Modal' && node.props.title === 'Tags da nota');
  const button = [modal.props.actions].flat().find(node => textOf(node) === 'Conferir resultado'); button.props.onClick(); await view.flush(); };
const editButton = (view, n) => view.find(node => node.type === 'button' && node.props['aria-label'] === `Editar tags da nota 000${120 + n}`);

test('notes list: Marcadores of the page, "Editar tags" with the version of the set and the Tags filter', async () => {
  const service = notesServer();
  const view = await mountNotes(service);
  try {
    assert.match(view.text(), /Urgente/);
    const read = service.calls.filter(call => call.path.startsWith('/v1/cadastros/notas-fiscais/tags?'));
    assert.equal(read.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(read[0].path.split('?')[1])), { origem: 'brufap', modelo: '55', ids: `${nativeNoteId(1)},${nativeNoteId(2)}` });
    editButton(view, 2).props.onClick(); await view.flush();
    const drawer = view.nodes().find(node => node.type?.name === 'TagsDrawer');
    assert.deepEqual([drawer.props.tagType, drawer.props.selected, drawer.props.tags.map(tag => tag.name)], ['invoices', [], ['Urgente', 'Conferir']]);
    drawer.props.onApply([service.tags.review.id]); await view.flush();
    const patch = service.calls.find(call => call.method === 'PATCH');
    assert.deepEqual([patch.path, patch.body.expected_version, patch.body.tag_ids], [`/v1/cadastros/notas-fiscais/brufap/55/${nativeNoteId(2)}/tags`, 0, [service.tags.review.id]]);
    assert.match(view.text(), /Tags da nota 000122 salvas\./);
    assert.match(view.text(), /Conferir/);
    // Tags filter: Todos | Sem Tag | the Notas fiscais tags; the list asks with tag=<id> and shows the chip.
    const filter = view.input('fiscal-tag-filter');
    assert.deepEqual(filter.props.options.map(option => option.label), ['Todos', 'Sem Tag', 'Conferir', 'Urgente']);
    filter.props.onChange({ target: { value: service.tags.urgent.id } }); await view.flush();
    await view.submit();
    const listCall = service.calls.filter(call => call.path.startsWith('/v1/notas-fiscais?')).at(-1);
    assert.equal(new URLSearchParams(listCall.path.split('?')[1]).get('tag'), service.tags.urgent.id);
    assert.match(view.text(), /Tags: Urgente/);
  } finally { view.unmount(); }
});

test('notes list: an unconfirmed "Editar tags" keeps the same command for "Conferir resultado" and guards the screen; consulta only reads', async () => {
  let attempt = 0; const commands = [];
  const service = notesServer({ patch: async body => { commands.push(body.command_id); attempt += 1; if (attempt === 1) throw new AccessError(503); return null; } });
  const view = await mountNotes(service);
  try {
    editButton(view, 1).props.onClick(); await view.flush();
    view.nodes().find(node => node.type?.name === 'TagsDrawer').props.onApply([service.tags.urgent.id, service.tags.review.id]); await view.flush();
    assert.match(view.text(), /Não foi possível confirmar as tags da nota 000121/);
    assert.deepEqual(view.guard(), { changed: true, busy: true });
    assert.equal(editButton(view, 2).props.disabled, true, 'no other edit while one is unconfirmed');
    await confirmAgain(view);
    assert.deepEqual([commands.length, commands[0] === commands[1]], [2, true]);
    assert.match(view.text(), /Tags da nota 000121 salvas\./);
    assert.deepEqual(view.guard(), { changed: false, busy: false });
  } finally { view.unmount(); }
  const reader = await mountNotes(notesServer({ role: 'consulta' }));
  try {
    assert.match(reader.text(), /Urgente/);
    assert.equal(reader.nodes().some(node => node.props?.['aria-label']?.startsWith('Editar tags da nota')), false);
  } finally { reader.unmount(); }
});

test('notes list: a conflict refreshes the Marcadores and closes the drawer', async () => {
  const service = notesServer({ patch: async () => { throw new AccessError(409); } });
  const view = await mountNotes(service);
  try {
    editButton(view, 1).props.onClick(); await view.flush();
    view.nodes().find(node => node.type?.name === 'TagsDrawer').props.onApply([]); await view.flush();
    assert.match(view.text(), /foram alteradas por outra operação/);
    assert.equal(service.calls.filter(call => call.path.startsWith('/v1/cadastros/notas-fiscais/tags?')).length, 2, 'the page tags are read again');
    assert.equal(view.nodes().some(node => node.type?.name === 'TagsDrawer'), false);
  } finally { view.unmount(); }
});

test('Origin note tags remain readable but cannot be edited even by fiscal and admin', async () => {
  for (const role of ['admin', 'fiscal', 'consulta']) {
    const service = notesServer({ role, origin: 'origin' }), view = await mountNotes(service);
    try {
      assert.match(view.text(), /Urgente/);
      assert.equal(view.nodes().some(node => node.props?.['aria-label']?.startsWith('Editar tags da nota')), false);
      assert.equal(service.calls.some(call => call.method === 'PATCH'), false);
    } finally { view.unmount(); }
  }
});

test('notes model: Tags filter in the query, chips and "Tornar padrão"; closed answers of the tags', () => {
  const config = SCREENS.nfe, tag = { id: id(1), name: 'Urgente' };
  assert.equal(fiscalListQuery(config, 'origin', { ...emptyFilters(config), tag }).get('tag'), id(1));
  assert.equal(fiscalListQuery(config, 'origin', { ...emptyFilters(config), tag: { id: 'none', name: 'Sem Tag' } }).get('tag'), 'none');
  assert.throws(() => fiscalListQuery(config, 'origin', { ...emptyFilters(config), tag: { id: 'x', name: 'X' } }), /Selecione novamente a tag/);
  assert.deepEqual(filterChips(config, { ...emptyFilters(config), tag }), [{ key: 'tag', label: 'Tags: Urgente' }]);
  assert.deepEqual(filtersFromPreference(config, filtersToPreference(config, { ...emptyFilters(config), tag })).tag, tag);
  assert.deepEqual(filtersFromPreference(config, { tag_id: 'none' }).tag, { id: 'none', name: 'Sem Tag' });
  assert.equal(filtersFromPreference(config, { tag_id: 'x' }).tag, null);
  const good = { scope: 'invoice_tags', origin: 'origin', model: '55', data_mode: 'erp_native', items: [tagSet('1', 0, [])] };
  assert.equal(parseInvoiceTagSets(good, 'origin', '55', ['1']).length, 1);
  assert.throws(() => parseInvoiceTagSets(good, 'origin', '55', ['2']));
  assert.throws(() => parseInvoiceTagSets({ ...good, model: '65' }, 'origin', '55', ['1']));
  assert.throws(() => parseInvoiceTagSave({ scope: 'invoice_tags', origin: 'origin', model: '55', invoice: tagSet('2', 1, []), changed: true, replayed: false }, 'origin', '55', '1'));
});

test('notes list: a late answer of the Marcadores of an older page is ignored', async () => {
  const service = notesServer();
  let lists = 0, release; const held = new Promise(resolve => { release = resolve; });
  const base = service.controller.catalog, fiscal = service.controller.fiscalInvoices;
  service.controller.fiscalInvoices = async path => { if (path.startsWith('/v1/notas-fiscais?')) { lists += 1; return listResponse(path, lists === 1 ? [nativeNoteRow(1)] : [nativeNoteRow(2)]); } return fiscal(path); };
  service.controller.catalog = async (path, options) => {
    if (path.startsWith('/v1/cadastros/notas-fiscais/tags?') && path.includes(`ids=${nativeNoteId(1)}`)) { await held; return { scope: 'invoice_tags', origin: 'brufap', model: '55', data_mode: 'erp_native', items: [tagSet(nativeNoteId(1), 1, [service.tags.urgent])] }; }
    return base(path, options);
  };
  const view = await mountNotes(service);
  try {
    view.nodes().find(node => node.type?.name === 'ListControls').props.onRefresh(); await view.flush();
    assert.match(view.text(), /Cliente Origin 2/);
    release(); await view.flush(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.doesNotMatch(view.text(), /Urgente/, 'the tags of the old page never show on the new one');
    assert.equal(editButton(view, 2).props.disabled, false);
  } finally { view.unmount(); }
});

test('product form: without an external image the first stored image is the Imagem principal; an external one keeps the first place', async () => {
  const { createHash } = await import('node:crypto');
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), sha = createHash('sha256').update(png).digest('hex'), product = id(40);
  const stored = { id: id(41), product_id: product, filename: 'foto.png', mime_type: 'image/png', size_bytes: png.length, sha256: sha, status: 'ready', position: 1, created_at: stamp, finished_at: stamp, deleted: false, owner_name: null };
  const mount = async images => {
    const calls = [];
    const record = { id: product, entity: 'products', version: 3, active: true, name: 'Furadeira', code: 'F-1', unit: 'UN', price: '10', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null,
      tag_ids: [], images, dun_codes: [], deleted_at: null, suppliers: [], category_id: null, product_group_id: null, custom_values: {} };
    const controller = {
      getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
      async catalog(path) {
        if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: [], data_mode: 'erp_native' };
        if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
        if (path === `/v1/cadastros/products/${product}/completo`) return { entity: 'products', record, data_mode: 'erp_native' };
        throw new AccessError(404);
      },
      async attachments(path, options = {}) {
        calls.push(path);
        if (path === `/v1/anexos-cadastros/produtos/${product}` && !options.method) return { product_id: product, items: [stored], pending: [], stored_bytes: String(png.length), limit: 20, data_mode: 'erp_native' };
        if (path.endsWith('/download')) return new Blob([png]);
        throw new AccessError(404);
      },
      async preferences() { throw new AccessError(404); },
    };
    const view = await mountComponent('ProductEditor.tsx', { controller, entity: 'products', record: { id: product, entity: 'products', version: 3, active: true, name: 'Furadeira', code: 'F-1', created_at: stamp, updated_at: stamp, source: null }, writable: true, onSaved() {}, onClose() {} },
      { componentName: 'ProductEditor', expandChildren: ['ProductForm'] });
    await view.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await view.flush();
    return { view, calls };
  };
  const main = view => view.find(node => node.type === 'button' && node.props.className === 'product-main-image');
  let { view, calls } = await mount([]);
  try {
    const image = [main(view).props.children].flat().find(node => node?.type === 'img');
    assert.match(image.props.src, /^data:image\/png;base64,/);
    assert.deepEqual(calls, [`/v1/anexos-cadastros/produtos/${product}`, `/v1/anexos-cadastros/produtos/${product}/${stored.id}/download`], 'one listing and one download');
  } finally { view.unmount(); }
  ({ view, calls } = await mount([{ url: 'https://imagens.example.test/a.png' }]));
  try {
    assert.equal([main(view).props.children].flat().find(node => node?.type === 'img').props.src, 'https://imagens.example.test/a.png');
    assert.deepEqual(calls, [], 'no stored image is read when an external image exists');
  } finally { view.unmount(); }
});
