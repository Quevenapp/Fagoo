import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { productDetailPayload, productFormValues, productLists, cloneProductForm, exportCsv, taxonomyTree, EMPTY_LISTS } from '../src/lib/product-form-model.ts';
import { CatalogValidationError } from '../src/lib/catalog-base.ts';

// Produtos no padrão do Origin (migrations 119-120): formulário completo, taxonomias, listagem v2 e exportação. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const actor = '95000000-0000-4000-8000-0000000000aa';
const id = '95000000-0000-4000-8000-000000000001', supplier = '95000000-0000-4000-8000-000000000050';
const category = '95000000-0000-4000-8000-0000000000c1', child = '95000000-0000-4000-8000-0000000000c2', tag = '95000000-0000-4000-8000-0000000000d1', group = '95000000-0000-4000-8000-0000000000e1';
const stamp = '2026-10-20T12:00:00+00:00';
const taxonomy = (kind, extra) => ({ id: extra.id, kind, parent_id: null, name: 'Item', version: 1, created_at: stamp, updated_at: stamp, children: 0, products: 0, ...extra });
const TAXONOMIES = {
  'categorias-produtos': ['categories', [taxonomy('categories', { id: category, name: 'Ferragens', children: 1 }), taxonomy('categories', { id: child, name: 'Parafusos', parent_id: category, products: 2 })]],
  'grupos-produtos': ['product_groups', [taxonomy('product_groups', { id: group, name: 'Fixadores' })]],
  'grupos-tags': ['tag_groups', []], tags: ['tags', [taxonomy('tags', { id: tag, name: 'Promoção' })]],
};
const complete = (extra = {}) => ({ id, entity: 'products', version: 3, active: true, name: 'Parafuso', code: 'PAR-1', unit: 'UN', price: '1.5000', kind: 'P', format: 'S', condition: 'new', origin: '0',
  created_at: stamp, updated_at: stamp, source: null, expiry_date: '2027-01-31', free_shipping: false, tax_percent: '4.5000', icms_st_retention_base: '10.00', category_id: child, tag_ids: [tag],
  images: [{ url: 'https://exemplo.test/a.png' }], dun_codes: [{ code: '17891234567892', quantity: '6.000000' }], deleted_at: null, cost_price: '2.0000000001',
  suppliers: [{ supplier_id: supplier, supplier_name: 'Fornecedor fictício', supplier_code: 'F', description: 'No fornecedor', code: 'F-1', purchase_price: '1.9000', cost_price: '2.0000000001', warranty_months: '6', is_default: true }], ...extra });

function server({ record = complete(), write = async () => undefined, role = 'admin' } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: role === 'admin' ? ['products', 'contacts'] : [], data_mode: 'erp_native' };
      const slug = /^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path)?.[1];
      if (slug && !options.method) return { kind: TAXONOMIES[slug][0], items: TAXONOMIES[slug][1], data_mode: 'erp_native' };
      if (options.method) { const result = await write(path, options.body, calls); if (result) return result; return { entity: 'products', record: { ...record, version: record.version + 1 }, replayed: false, data_mode: 'erp_native' }; }
      if (path.startsWith('/v1/cadastros/contatos/opcoes?')) return { scope: 'contact_options', items: [{ id: supplier, entity: 'contacts', name: 'Fornecedor fictício', code: 'F' }], has_more: false, next_cursor: null, limit: 25, data_mode: 'erp_native' };
      if (path === `/v1/cadastros/products/${id}/completo` || path === `/v1/cadastros/products/${id}`) return { entity: 'products', record, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
  };
  return { calls, controller, writes: () => calls.filter(call => call.method) };
}
const editorProps = (service, extra = {}) => ({ controller: service.controller, entity: 'products', record: { id, entity: 'products', version: 3, active: true, name: 'Parafuso', code: 'PAR-1', created_at: stamp, updated_at: stamp, source: null }, writable: true, onSaved() {}, onClose() {}, ...extra });
const mountEditor = (service, extra) => mountComponent('ProductEditor.tsx', editorProps(service, extra), { componentName: 'ProductEditor', expandChildren: ['ProductForm', 'ExternalImages', 'SupplierDrawer', 'TagsDrawer', 'Modal'] });

test('model: detail payload, exact decimals and lists; friendly field errors; clone clears the identifiers', () => {
  const values = productFormValues(complete(), undefined);
  assert.deepEqual([values.tax_percent, values.icms_st_retention_base, values.free_shipping, values.expiry_date, values.category_id, values.active], ['4,5', '10', 'false', '2027-01-31', child, 'true']);
  const lists = productLists(complete());
  assert.deepEqual(lists.suppliers[0].cost_price, '2,0000000001');
  const payload = productDetailPayload(values, lists);
  assert.deepEqual([payload.tax_percent, payload.free_shipping, payload.active, payload.category_id], ['4.5', false, true, child]);
  assert.deepEqual(payload.suppliers, [{ supplier_id: supplier, description: 'No fornecedor', code: 'F-1', purchase_price: '1.9000', cost_price: '2.0000000001', warranty_months: '6', is_default: true }]);
  assert.deepEqual(payload.dun_codes, [{ code: '17891234567892', quantity: '6' }]);
  const fail = (patch, listPatch, field) => assert.throws(() => productDetailPayload({ ...values, ...patch }, { ...lists, ...listPatch }), error => error instanceof CatalogValidationError && error.field === field);
  fail({ tax_percent: '100,5' }, {}, 'tax_percent'); fail({ fci_number: 'x' }, {}, 'fci_number'); fail({ expiry_date: '2027-02-30' }, {}, 'expiry_date');
  fail({ external_link: 'ftp://x' }, {}, 'external_link'); fail({}, { dun_codes: [{ code: '1', quantity: '1' }] }, 'dun_codes'); fail({}, { images: ['http://x.test/a.png'] }, 'images');
  fail({}, { suppliers: [{ ...lists.suppliers[0], cost_price: '1,12345678901' }] }, 'suppliers');
  assert.deepEqual(productDetailPayload(productFormValues(null, undefined, { origin: '2' }), EMPTY_LISTS).dun_codes, []);
  assert.equal(productFormValues(null, undefined, { origin: '2' }).origin, '2', 'Origem padrão de tributação fills a new product');
  const clone = cloneProductForm(complete());
  assert.deepEqual([clone.code, clone.gtin, clone.gtin_tax, clone.name], ['', '', '', 'Parafuso']);
  assert.deepEqual(productLists(null, clone).dun_codes, [], 'DUN codes are identifiers too');
  assert.equal(productLists(null, clone).suppliers.length, 1);
  assert.deepEqual(taxonomyTree(TAXONOMIES['categorias-produtos'][1]).map(({ item, depth }) => [item.name, depth]), [['Ferragens', 0], ['Parafusos', 1]]);
  const csv = exportCsv([{ id, code: '=SOMA(A1)', name: 'Produto; com "aspas"', active: true, price: '1.5000', tags: ['A', 'B'], images: [], supplier: null }]);
  assert.ok(csv.startsWith('﻿ID;Código;Descrição;'));
  assert.match(csv, /;"'=SOMA\(A1\)";"Produto; com ""aspas""";/, 'formula-like cells are neutralized and separators quoted');
  const numbers = exportCsv([{ id, code: '-SOMA', name: '\rcmd', active: true, stock: '-5.000000', price: '1.5000', tags: [], images: [], supplier: null }]);
  assert.match(numbers, /;-5,000000;/, 'a negative stock is a number, not a formula');
  assert.match(numbers, /;"'-SOMA";"'\rcmd";/, 'a leading minus in text and a leading carriage return are neutralized');
});

test('product form: complete read, tabs, suppliers, DUN, images and tags save in one command with the expected version', async () => {
  const service = server(), saved = [];
  const view = await mountEditor(service, { onSaved: value => saved.push(value) });
  try {
    assert.deepEqual(service.calls.filter(call => !call.path.includes('/taxonomias/')).map(call => call.path), [`/v1/cadastros/products/${id}/completo`, '/v1/cadastros/campos-customizados'], 'the product and the custom field definitions (migration 156)');
    assert.match(view.text(), /Dados básicos.*Características.*Imagens.*Estoque.*Fornecedores.*Tributação/);
    assert.equal(view.input('catalog-active').props.checked, true);
    assert.equal(view.input('catalog-category_id').props.value, child);
    assert.match(view.text(), /Promoção/, 'the tag name comes from the taxonomy');
    assert.match(view.text(), /Fornecedor fictício/);
    assert.match(view.text(), /Dados da nota fiscal/);
    await view.change('catalog-notes', 'Observação nova');
    await view.change('catalog-tax_percent', '7,25');
    await view.click('Adicionar DUN');
    const dun = view.find(node => node.props?.['aria-label'] === 'Código DUN da linha 2'); dun.props.onChange({ target: { value: '1789-1234567885' } }); await view.flush();
    view.find(node => node.props?.['aria-label'] === 'Quantidade do DUN da linha 2').props.onChange({ target: { value: '12' } }); await view.flush();
    await view.change('catalog-images', 'https://exemplo.test/b.webp'); await view.click('Adicionar nova imagem externa');
    assert.equal(view.guard().changed, true, 'lists are part of the unsaved guard');
    await view.submit();
    const save = service.writes()[0];
    assert.equal(save.path, `/v1/cadastros/products/${id}/completo`); assert.equal(save.method, 'PATCH'); assert.equal(save.body.expected_version, 3);
    assert.deepEqual([save.body.data.notes, save.body.data.tax_percent, save.body.data.dun_codes.at(-1), save.body.data.images.map(image => image.url)],
      ['Observação nova', '7.25', { code: '17891234567885', quantity: '12' }, ['https://exemplo.test/a.png', 'https://exemplo.test/b.webp']]);
    assert.deepEqual(save.body.data.tag_ids, [tag]); assert.equal(save.body.data.suppliers[0].cost_price, '2.0000000001');
    assert.equal(saved.length, 1);
  } finally { view.unmount(); }
});

test('product form: an invalid detail opens its tab; an unknown result keeps the same command for "Conferir resultado"', async () => {
  let attempt = 0;
  const service = server({ async write() { attempt++; if (attempt === 1) throw new AccessError(503); return undefined; } });
  const view = await mountEditor(service);
  try {
    await view.change('catalog-origin', '3');
    await view.change('catalog-fci_number', 'não é FCI');
    await view.submit();
    assert.match(view.text(), /número FCI no formato/i);
    assert.equal(view.find(node => node.props?.id === 'product-tab-tax').props['aria-selected'], true, 'the Tributação tab is shown with the field');
    assert.equal(service.writes().length, 0);
    await view.change('catalog-fci_number', 'b01f70af-10bf-4b1f-848c-65ff57f616fe');
    await view.submit();
    assert.equal(service.writes().length, 1); assert.match(view.text(), /Conferir resultado/);
    assert.equal(service.writes()[0].body.data.fci_number, 'B01F70AF-10BF-4B1F-848C-65FF57F616FE');
    await view.click('Conferir resultado');
    assert.equal(service.writes().length, 2); assert.equal(service.writes()[1].body.command_id, service.writes()[0].body.command_id, 'same command, no duplicate save');
    assert.deepEqual(service.writes()[1].body, service.writes()[0].body);
  } finally { view.unmount(); }
});

test('product form: supplier drawer searches contacts; a deleted product is read-only; a failed read offers a retry', async () => {
  const service = server({ record: complete({ suppliers: [] }) });
  const view = await mountEditor(service);
  try {
    await view.click('Adicionar fornecedor');
    assert.match(view.text(), /Editar fornecedor do produto/);
    await view.change('product-supplier-search', 'Forn');
    await new Promise(resolve => setTimeout(resolve, 300)); await view.flush();
    // Every active contact (seller scope): contacts mirrored from Origin have no Tipo de contato, so no papel filter.
    assert.ok(service.calls.some(call => call.path.startsWith('/v1/cadastros/contatos/opcoes?') && !new URLSearchParams(call.path.split('?')[1]).has('papel')), 'no papel filter');
    view.find(node => node.type === 'button' && node.props.role === 'option').props.onClick(); await view.flush();
    await view.change('product-supplier-cost', '3,5'); await view.click('Ok');
    assert.match(view.text(), /Fornecedor fictício/);
    await view.submit();
    assert.deepEqual(service.writes()[0].body.data.suppliers, [{ supplier_id: supplier, description: null, code: null, purchase_price: null, cost_price: '3.5000', warranty_months: null, is_default: true }]);
  } finally { view.unmount(); }
  const deleted = server({ record: complete({ deleted_at: stamp, active: false }) });
  const readOnly = await mountEditor(deleted);
  try {
    assert.match(readOnly.text(), /Produto excluído/);
    assert.throws(() => readOnly.button('Salvar produto'));
    assert.equal(readOnly.input('catalog-name').disabled, true);
  } finally { readOnly.unmount(); }
  let fails = 1;
  const flaky = server(); const original = flaky.controller.catalog;
  flaky.controller.catalog = async (path, options) => { if (path.endsWith('/completo') && fails-- > 0) throw new AccessError(503); return original(path, options); };
  const retry = await mountEditor(flaky);
  try {
    assert.match(retry.text(), /Não foi possível concluir a operação/);
    await retry.click('Tentar novamente');
    assert.equal(retry.input('catalog-name').props.value, 'Parafuso');
  } finally { retry.unmount(); }
});

test('taxonomy screen: tree list, create with a fixed parent, duplicate names, uncertain save and refused delete', async () => {
  let attempt = 0;
  const service = server({ async write(path, body) {
    if (path.endsWith('/excluir')) return { kind: 'categories', id: category, deleted: false, reason: 'has_children', data_mode: 'erp_native' };
    attempt++;
    if (attempt === 1) return { kind: 'categories', saved: false, reason: 'duplicate_name', data_mode: 'erp_native' };
    if (attempt === 2) throw new AccessError(503);
    return { kind: 'categories', saved: true, item: taxonomy('categories', { id: '95000000-0000-4000-8000-0000000000c3', name: body.data.name, parent_id: body.data.parent_id ?? null }), data_mode: 'erp_native' };
  } });
  const view = await mountComponent('ProductTaxonomy.tsx', { controller: service.controller, kind: 'categories' }, {});
  try {
    assert.match(view.text(), /Categorias de produtos/); assert.match(view.text(), /Quantidade de categoria2/);
    assert.match(view.text(), /Dica — Criando suas categorias/);
    const menu = view.find(node => node.type?.name === 'RowMenu' && node.props.label === 'Ferragens').props.items;
    assert.deepEqual(menu.map(item => item.label), ['Incluir subcategoria', 'Editar', 'Clonar categoria', 'Excluir']);
    menu[0].onClick(); await view.flush();
    assert.equal(view.input('taxonomy-parent').props.value, 'Ferragens', 'the parent is read-only on a subcategory');
    await view.change('taxonomy-name', 'Parafusos');
    await view.submit();
    assert.match(view.text(), /Já existe uma categoria com este nome neste nível/);
    const first = service.writes()[0];
    assert.deepEqual(first.body.data, { name: 'Parafusos', parent_id: category });
    await view.change('taxonomy-name', 'Porcas'); await view.submit();
    assert.notEqual(service.writes()[1].body.command_id, first.body.command_id, 'a refused name is a new command next time');
    assert.match(view.text(), /Conferir resultado/);
    assert.equal(view.guard().changed, true);
    await view.submit(); // "Conferir resultado" is the submit button while the result is unknown
    assert.equal(service.writes()[2].body.command_id, service.writes()[1].body.command_id);
    assert.match(view.text(), /Categoria incluída/);
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Ferragens').props.onChange({ target: { checked: true } }); await view.flush();
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Excluir selecionados').props.onClick(); await view.flush();
    assert.equal(view.find(node => node.type?.name === 'BatchDialog').props.title, 'Excluir selecionados');
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta' });
  const readOnly = await mountComponent('ProductTaxonomy.tsx', { controller: reader.controller, kind: 'tags' }, {});
  try {
    assert.match(readOnly.text(), /Somente consulta/); assert.throws(() => readOnly.button('Incluir tag'));
    assert.match(readOnly.text(), /Promoção/);
  } finally { readOnly.unmount(); }
});

test('product list: v2 filters, Excluídos with Restaurar, the stock cube and the category batch per product', async () => {
  const rows = [{ id, entity: 'products', version: 3, active: true, name: 'Parafuso', code: 'PAR-1', unit: 'UN', price: '1.5000', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null,
    stock: { state: 'recorded', quantity: '1.000000', warehouse: null }, stock_min: '2.000000', stock_max: '9.000000', thumbnail: 'https://exemplo.test/a.png', deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }];
  const calls = [];
  const base = server({ async write(path, body) { return { entity: 'products', record: { ...complete(), version: body.expected_version + 1 }, replayed: false, data_mode: 'erp_native' }; } });
  const catalog = base.controller.catalog;
  base.controller.catalog = async (path, options = {}) => {
    if (path.startsWith('/v1/cadastros/products?')) { calls.push(path); const params = new URLSearchParams(path.split('?')[1]);
      const deleted = params.get('situation') === 'deleted'; return { entity: 'products', items: rows.map(row => ({ ...row, deleted })), page: 1, size: 100, total: 1, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native' }; }
    return catalog(path, options);
  };
  base.controller.stockPositions = async () => ({ items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' });
  const view = await mountComponent('RealCatalog.tsx', { controller: base.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'StockCube'] });
  try {
    assert.equal(view.find(node => node.type === 'span' && String(node.props.className).startsWith('catalog-cube')).props.className, 'catalog-cube is-low', 'stock at or below the minimum is yellow');
    assert.throws(() => view.input('catalog-warehouse-filter'), 'Depósito appears only with Estoque');
    await view.change('catalog-category-filter', child); await view.change('catalog-tag-filter', 'none'); await view.change('catalog-item-type-filter', '00');
    await view.change('catalog-type-filter', 'simple'); await view.change('catalog-images-filter', 'yes'); await view.change('catalog-supplier-code-filter', ' F-1 ');
    await view.submit();
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls.at(-1).split('?')[1])), { page: '1', size: '100', situation: 'latest', type: 'simple', images: 'yes', tag: 'none', category: child, item_type: '00', supplier_code: 'F-1' });
    const chips = view.find(node => node.type?.name === 'AppliedChips').props.chips.map(chip => chip.label);
    assert.ok(chips.includes('Categoria: Ferragens › Parafusos') && chips.includes('Tags: Sem Tag') && chips.includes('Classificação: Mercadoria para Revenda'));
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Parafuso').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Incluir categorias para selecionados');
    view.find(node => node.type?.name === 'BatchDialog').props.description.props.children[1].props.onChange({ target: { value: category } }); await view.flush();
    const dialog = view.find(node => node.type?.name === 'BatchDialog').props;
    assert.equal(dialog.canConfirm, true);
    assert.equal(dialog.title, 'Atualizar categoria dos produtos selecionados');
    await dialog.run(dialog.plan.eligible[0]);
    const patch = base.writes().at(-1);
    assert.deepEqual([patch.path, patch.body.expected_version, patch.body.data], [`/v1/cadastros/products/${id}/completo`, 3, { category_id: category }]);
    dialog.onClose([]); await view.flush();
    assert.ok(view.button('Mudar situação de produtos selecionados'));
    await view.change('catalog-situation-filter', 'deleted'); await view.submit();
    assert.equal(new URLSearchParams(calls.at(-1).split('?')[1]).get('situation'), 'deleted');
    assert.throws(() => view.button('Mudar situação de produtos selecionados'), 'deleted products are read-only: only Restaurar applies');
    assert.ok(view.find(node => node.type === 'button' && node.props['aria-label'] === 'Restaurar selecionados'));
    assert.throws(() => view.button('Incluir categorias para selecionados'), 'edition actions are hidden for deleted products');
    assert.equal(view.find(node => node.type === 'span' && String(node.props.className).startsWith('catalog-cube')).props.title, 'Item Excluído');
  } finally { view.unmount(); }
});

test('product export: ranges of 1000 from the list filters, read in batches of 40', async () => {
  const reads = [];
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), async catalog(path) {
    reads.push(path); const params = new URLSearchParams(path.split('?')[1]), offset = Number(params.get('offset') ?? 0), limit = Number(params.get('limit'));
    return { entity: 'products', items: Array.from({ length: Math.max(0, Math.min(limit, 1203 - offset)) }, (_, n) => ({ id: `${offset + n}`, name: `P${offset + n}`, active: true, tags: [], images: [], supplier: null })), offset, limit, total: 1203, stock_visible: true, data_mode: 'erp_native' };
  } };
  const view = await mountComponent('ProductExport.tsx', { controller }, { location: '/exportacao-produtos?situation=active&category=none&q=parafuso' });
  try {
    assert.match(view.text(), /1203 produtos com os filtros da listagem/);
    assert.match(view.text(), /1 a 1000/); assert.match(view.text(), /1001 a 1203/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(reads[0].split('?')[1])), { situation: 'active', q: 'parafuso', category: 'none', limit: '1', include_deleted: 'false' });
    const buttons = view.nodes().filter(node => node.type === 'button' && node.props.children === 'Download');
    buttons[1].props.onClick(); await view.flush();
    const pages = reads.filter(path => path.startsWith('/v1/cadastros/products/exportacao?')).slice(1);
    assert.deepEqual(pages.map(path => new URLSearchParams(path.split('?')[1]).get('offset')), ['1000', '1040', '1080', '1120', '1160', '1200'], 'the last file reads only the rows it has');
    assert.ok(pages.every(path => new URLSearchParams(path.split('?')[1]).get('limit') === '40'), 'each answer stays far below the API limit, custom field values included');
  } finally { view.unmount(); }
});

test('price lists: tabs and search, the Dados gerais form with an uncertain save, products and custom prices', async () => {
  const listId = '95000000-0000-4000-8000-0000000000f1';
  const header = extra => ({ id: listId, name: 'Atacado', category: 'other', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null,
    version: 1, created_at: stamp, updated_at: stamp, rule: 'Customizada', products: 1, contacts: [], regions: [], ...extra });
  const calls = []; let saves = 0;
  const controller = { getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), async catalog(path, options = {}) {
    calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
    if (path === '/v1/cadastros') return { read: ['products'], write: ['products'], data_mode: 'erp_native' };
    if (options.method === 'POST' && path === '/v1/cadastros/listas-precos') { saves++; if (saves === 1) throw new AccessError(503); return { saved: true, list: header(), data_mode: 'erp_native' }; }
    if (options.method) return { saved: true, list: header({ version: 2 }), data_mode: 'erp_native' };
    if (path.startsWith('/v1/cadastros/listas-precos?') || path === '/v1/cadastros/listas-precos') return { items: [header()], data_mode: 'erp_native' };
    if (path.startsWith(`/v1/cadastros/listas-precos/${listId}`)) return { list: header(), items: [{ product_id: id, name: 'Parafuso', code: 'PAR-1', gtin: null, product_price: '10.1250', custom_price: '9.9950', list_price: '10.00' }], total: 1, offset: 0, limit: 100, data_mode: 'erp_native' };
    throw new AccessError(404);
  } };
  const view = await mountComponent('PriceLists.tsx', { controller }, { location: '/listas-precos', expandChildren: ['PriceListEditor', 'PriceListWizard', 'PriceListLinks', 'Modal'] });
  try {
    assert.match(view.text(), /Todas listas.*Taxas.*Por período.*Customizada/); assert.match(view.text(), /Atacado/); assert.match(view.text(), /Quantidade de registros1/);
    view.find(node => node.type === 'button' && node.props.role === 'tab' && node.props.children === 'Customizada').props.onClick(); await view.flush();
    assert.equal(calls.at(-1).path, '/v1/cadastros/listas-precos?tipo=custom');
    // "+ Incluir lista" opens the Origin assistant (migration 154): Categoria, Montagem, Nome e validade and Resumo; one command at the end.
    await view.click('Incluir lista');
    assert.match(view.text(), /Vamos configurar a lista de preços!/); assert.match(view.text(), /Qual categoria se aplicaria a lista\?/);
    await view.click('Avançar');
    view.nodes().filter(node => node.type === 'input' && node.props.name === 'price-list-build')[2].props.onChange(); await view.flush();
    await view.click('Avançar');
    await view.click('Avançar');
    assert.match(view.text(), /Informe o nome da lista/, 'the name is checked before the summary');
    await view.change('price-list-wizard-name', 'Atacado');
    await view.click('Avançar');
    assert.match(view.text(), /Resumo/); assert.match(view.text(), /Lista customizada/);
    await view.click('Salvar');
    const first = calls.find(call => call.method === 'POST');
    assert.deepEqual(first.body.data, { name: 'Atacado', category: 'other', list_type: 'custom', factor: null, factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null, contacts: [], regions: [], sellers: [], payment_methods: [] });
    assert.match(view.text(), /Conferir resultado/); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado');
    const posts = calls.filter(call => call.method === 'POST' && call.path === '/v1/cadastros/listas-precos');
    assert.equal(posts.length, 2); assert.deepEqual(posts[1].body, posts[0].body, 'the same command is repeated');
    assert.match(view.text(), /Produtos da lista/); assert.match(view.text(), /R\$ 10,1250/);
    view.find(node => node.props?.['aria-label'] === 'Preço da lista de Parafuso').props.onChange({ target: { value: '8,5' } }); await view.flush();
    await view.click('Salvar preços');
    const items = calls.filter(call => call.path === `/v1/cadastros/listas-precos/${listId}/itens`).at(-1);
    assert.deepEqual([items.body.expected_version, items.body.change], [1, { prices: [{ product_id: id, custom_price: '8.5000' }] }]);
    // Changing the products reloads the list: with unsaved Dados gerais nothing is sent and the edit stays on the screen.
    const sent = calls.filter(call => call.method).length;
    await view.change('price-list-name', 'Atacado editado');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Parafuso').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Excluir itens');
    assert.match(view.text(), /Salve ou descarte as alterações da tela antes de alterar os produtos da lista/);
    assert.equal(calls.filter(call => call.method).length, sent);
    assert.equal(view.input('price-list-name').props.value, 'Atacado editado');
  } finally { view.unmount(); }
});

test('product list: "Tornar padrão" offers the applied filters and applies the saved default when the list opens', async () => {
  // Estoque is never restored from a default (it depends on the stock permission) and Número NCM only comes with "Com NCM".
  const saved = { situation: 'active', category: child, q: 'parafuso', stock: 'zero', ncm: '12' };
  const pages = [];
  const base = server();
  const catalog = base.controller.catalog;
  base.controller.catalog = async (path, options = {}) => {
    if (path.startsWith('/v1/cadastros/products?')) { pages.push(path); return { entity: 'products', items: [], page: 1, size: 100, total: 0, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' }; }
    return catalog(path, options);
  };
  base.controller.subscribe = () => () => undefined;
  base.controller.listPreferences = async () => ({ scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 1, columns: null, filters: saved, updated_at: stamp });
  const view = await mountComponent('RealCatalog.tsx', { controller: base.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(Object.fromEntries(new URLSearchParams(pages.at(-1).split('?')[1])), { page: '1', size: '100', q: 'parafuso', situation: 'active', category: child });
    assert.deepEqual(view.find(node => node.type?.name === 'ListPreferencesBar').props.currentFilters, { situation: 'active', q: 'parafuso', category: child });
    await view.change('catalog-images-filter', 'yes'); await view.submit();
    assert.deepEqual(view.find(node => node.type?.name === 'ListPreferencesBar').props.currentFilters, { situation: 'active', q: 'parafuso', category: child, images: 'yes' });
  } finally { view.unmount(); }
});

test('cloned product: a new inclusion, so Código do produto "Sequencial" shows its hint and Origem comes from the source', async () => {
  const { storedPreferencePage } = await import('../../../packages/erp-domain/src/preferences/catalog.mjs');
  const { storedFields } = await import('../../../packages/erp-domain/src/preferences/core.mjs');
  const page = storedPreferencePage('cadastros-produtos');
  const service = server();
  service.controller.preferences = async () => ({ scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: page.scope, role: 'admin', can_manage: true, directory: null,
    items: storedFields(page).map(field => field.key === 'produtos.codigo' ? { key: field.key, value: 'sequencial', version: 1, updated_at: stamp } : field.key === 'produtos.origem_padrao' ? { key: field.key, value: '2', version: 1, updated_at: stamp } : { key: field.key, value: field.default, version: 0, updated_at: null }) });
  const view = await mountEditor(service, { record: null, initialValues: cloneProductForm(complete({ origin: '1' })), cloneOf: 'Parafuso' });
  try {
    assert.equal(view.input('catalog-code').props.placeholder, 'Gerado ao salvar');
    assert.equal(view.input('catalog-origin').props.value, '1', 'the clone keeps the Origem of the source product');
  } finally { view.unmount(); }
});

test('external images: an address the browser cannot parse never breaks the form and is not added', async () => {
  const service = server({ record: complete({ images: [{ url: 'https://exemplo.test/a.png' }, { url: 'https://[x' }] }) });
  const view = await mountEditor(service);
  try {
    assert.match(view.text(), /https:\/\/\[x/, 'the stored row is shown');
    await view.change('catalog-images', 'https://exemplo.test:porta/x.png'); await view.click('Adicionar nova imagem externa');
    assert.match(view.text(), /Informe um endereço HTTPS público, sem espaços/);
    assert.equal(view.nodes().filter(node => String(node.props?.['aria-label'] ?? '').startsWith('Remover a imagem')).length, 2);
  } finally { view.unmount(); }
});
