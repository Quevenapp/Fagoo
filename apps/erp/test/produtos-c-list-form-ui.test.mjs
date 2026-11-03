import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { ean8, itf14, productBarcode, validGtin, labelSheet } from '../src/lib/product-labels.ts';
import { exportSheet, displayDecimal, checkWeights, productFormValues } from '../src/lib/product-form-model.ts';
import { productIssues } from '../src/lib/product-validation.ts';
import { CatalogValidationError } from '../src/lib/catalog-base.ts';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';

// Listagem e formulário de produtos, onda C: XLS, Imprimir, etiquetas com código de barras, selects pesquisáveis, Mudar
// situação em Mais ações, Validação do produto, observações do fornecedor e casas decimais do peso. Synthetic data only.
const downloads = [];
let previous;
test.before(() => {
  previous = globalThis.document;
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, classList: { add() {}, remove() {} } },
    createElement: () => ({ click() { downloads.push(this.download); }, remove() {} }) };
  globalThis.URL.createObjectURL ??= () => 'blob:synthetic'; globalThis.URL.revokeObjectURL ??= () => {};
});
test.after(() => { globalThis.document = previous; });
const actor = '95000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { a: '95000000-0000-4000-8000-000000000001', b: '95000000-0000-4000-8000-000000000002', supplier: '95000000-0000-4000-8000-000000000050', category: '95000000-0000-4000-8000-0000000000c1', child: '95000000-0000-4000-8000-0000000000c2' };
// A preferences page as the API answers it (every stored field; the given values saved, the rest at the default).
const preferenceView = (pageId, values, role = 'admin') => { const page = preferencePage(pageId); return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role, can_manage: role === 'admin', directory: null,
  items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: stamp } : { key: field.key, value: field.default, version: 0, updated_at: null }) }; };
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

test('barcodes of the labels: GTIN check digits, EAN-8 and ITF-14 patterns and the Code 128 fallback of the SKU', () => {
  assert.equal(validGtin('96385074'), true); assert.equal(validGtin('96385075'), false); assert.equal(validGtin('7891234567895'), true);
  assert.equal(ean8('96385074'), ['101', '0001011', '0101111', '0111101', '0110111', '01010', '1001110', '1110010', '1000100', '1011100', '101'].join(''));
  assert.equal(ean8('96385074').length, 67);
  const itf = itf14('17891234567892');
  assert.ok(itf.startsWith('1010') && itf.endsWith('11101')); assert.equal(itf14('17891234567893'), null);
  assert.deepEqual(['format', 'value'].map(key => productBarcode('7891234567895', 'P-1')[key]), ['EAN-13', '7891234567895']);
  assert.deepEqual(['format', 'value'].map(key => productBarcode('7891234567890', 'P-1')[key]), ['Code 128', 'P-1'], 'an invalid GTIN falls back to the SKU');
  assert.equal(productBarcode('SEM GTIN', null), null);
  assert.deepEqual(labelSheet([{ id: 'x' }, { id: 'y' }], { x: '2', y: '0' }).map(item => item.id), ['x', 'x']);
});

test('model: XLS keeps exact numbers, weights show the preference decimals and a changed weight is checked', () => {
  const sheet = exportSheet([{ id: ids.a, name: 'Parafuso', price: '10.5000', stock: '-2.000000', code: '=SOMA(A1)', active: true }]);
  const header = sheet[0].map(cell => cell.text), row = sheet[1];
  assert.deepEqual(row[header.indexOf('Preço')], { number: '10,5000'.replace(',', '.') });
  assert.deepEqual(row[header.indexOf('Estoque')], { number: '-2.000000' });
  assert.deepEqual(row[header.indexOf('Código')], { text: '=SOMA(A1)' }, 'text cells are neutralized by the sheet writer');
  assert.deepEqual([displayDecimal('1.500000', 3), displayDecimal('1.234567', 3), displayDecimal('2.000000', 2), displayDecimal('7', 0)], ['1,500', '1,234567', '2,00', '7']);
  const values = productFormValues({ id: ids.a, entity: 'products', version: 1, active: true, name: 'P', net_weight: '1.500000', width: '10.000000', created_at: stamp, updated_at: stamp, source: null }, undefined, { weightDecimals: 2 });
  assert.deepEqual([values.net_weight, values.width], ['1,50', '10,00']);
  assert.doesNotThrow(() => checkWeights({ net_weight: '1,234567' }, { net_weight: '1,234567' }, 2), 'an untouched weight is kept');
  assert.throws(() => checkWeights({ net_weight: '1,234' }, { net_weight: '1,50' }, 2), error => error instanceof CatalogValidationError && error.field === 'net_weight');
  assert.deepEqual(productIssues({ name: 'P', code: '', unit: 'UN', price: '0' }).map(issue => issue.label), ['Verificar preço', 'Inserir código']);
  assert.deepEqual(productIssues({ name: 'P', code: '', unit: 'UN', price: '1' }, { sequential: true }), []);
});

function listServer({ total = 2, settings = {} } = {}) {
  const calls = [];
  const rows = [ids.a, ids.b].map((id, n) => ({ id, entity: 'products', version: 3, active: n === 0, name: n ? 'Porca' : 'Parafuso', code: n ? null : 'PAR-1', unit: 'UN', price: n ? null : '10.0000', kind: 'P', format: 'S', gtin: n ? null : '7891234567895',
    created_at: stamp, updated_at: stamp, source: null, stock: null, stock_min: null, stock_max: null, thumbnail: null, deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }));
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/categorias-produtos') return { kind: 'categories', items: [{ id: ids.category, kind: 'categories', parent_id: null, name: 'Ferragens', version: 1, created_at: stamp, updated_at: stamp, tag_type: null, children: 1, products: 0, contacts: 0 },
        { id: ids.child, kind: 'categories', parent_id: ids.category, name: 'Parafusos', version: 1, created_at: stamp, updated_at: stamp, tag_type: null, children: 0, products: 1, contacts: 0 }], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) { const page = Number(new URLSearchParams(path.split('?')[1]).get('page')); return { entity: 'products', items: page === 1 ? rows : [], page, size: 100, total, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return { scope: 'preferences_page', page: 'cadastros-produtos', data_mode: 'erp_native', items: Object.entries(settings).map(([key, value]) => ({ key, value, version: 1 })) }; },
  };
  return { calls, controller };
}

test('product list: Imprimir reads every page, the price report, labels from the row and the selection, searchable Categoria and Mudar situação in Mais ações', async () => {
  const service = listServer();
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'ProductListPrint', 'PrintSheet', 'ProductLabels', 'Barcode'] });
  try {
    const category = view.input('catalog-category-filter');
    assert.equal(category.type.name, 'SearchableSelect');
    assert.deepEqual(category.props.options.map(option => [option.label, option.depth ?? 0]), [['Todas', 0], ['Sem categoria', 0], ['Ferragens', 0], ['Parafusos', 1]]);
    await view.change('catalog-category-filter', ids.child); await view.submit();
    assert.equal(new URLSearchParams(service.calls.filter(call => call.path.startsWith('/v1/cadastros/products?')).at(-1).path.split('?')[1]).get('category'), ids.child);
    view.find(node => node.type?.name === 'ToolButton' && node.props.title === 'Imprimir').props.onClick(); await view.flush(); await view.flush();
    assert.match(view.text(), /Produtos · 2 registros/); assert.match(view.text(), /Parafuso/); assert.match(view.text(), /R\$ 10,00/);
    const reads = service.calls.filter(call => call.path.includes('size=100') && call.path.includes(`category=${ids.child}`));
    assert.ok(reads.length >= 2, 'the print reads the pages again, with the filters');
    await view.click('Fechar');
    await view.click('Relatório de preço dos produtos'); await view.flush(); await view.flush();
    assert.match(view.text(), /Relatório de preço dos produtos · 2 registros/);
    assert.deepEqual(view.nodes().filter(node => node.type === 'th' && node.props.scope === 'col').map(node => textOf(node.props.children)).slice(-4), ['Descrição', 'Código', 'Unidade', 'Preço']);
    await view.click('Fechar');
    view.find(node => node.type?.name === 'RowMenu' && node.props.label === 'Parafuso').props.items.find(item => item.label === 'Imprimir etiquetas').onClick(); await view.flush();
    assert.match(view.text(), /Imprimir etiquetas · 1 etiqueta\(s\)/);
    assert.ok(view.nodes().some(node => node.type === 'svg' && node.props['aria-label'] === 'EAN-13 7891234567895'));
    view.find(node => node.props?.['aria-label'] === 'Quantidade de etiquetas de Parafuso').props.onChange({ target: { value: '3' } }); await view.flush();
    assert.match(view.text(), /Imprimir etiquetas · 3 etiqueta\(s\)/);
    await view.click('Fechar');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Parafuso').props.onClick({ shiftKey: false }); await view.flush();
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Porca').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Imprimir etiquetas selecionadas');
    assert.match(view.text(), /2 produto\(s\)/); assert.match(view.text(), /Sem GTIN ou código para o código de barras/);
    await view.click('Fechar');
    await view.click('Mudar situação de produtos selecionados');
    const dialog = view.find(node => node.type?.name === 'BatchDialog');
    assert.equal(dialog.props.description.props.children[1].props.id, 'catalog-batch-target-select');
    assert.equal(view.nodes().find(node => node.type?.name === 'OriginPagination').props.pageSelect, true);
  } finally { view.unmount(); }
});

test('product form: Validação do produto, searchable Categoria and Grupo, the contact notes of the supplier and the weight decimals', async () => {
  const record = { id: ids.a, entity: 'products', version: 3, active: true, name: 'Parafuso', code: '', unit: 'UN', price: '0', kind: 'P', format: 'S', net_weight: '1.500000', width: '10.000000', created_at: stamp, updated_at: stamp, source: null,
    tag_ids: [], images: [], dun_codes: [], deleted_at: null, suppliers: [], category_id: null, product_group_id: null };
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path.startsWith('/v1/cadastros/taxonomias/')) { const kind = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)]; return { kind, items: [], data_mode: 'erp_native' }; }
      if (path === `/v1/cadastros/products/${ids.a}/completo` && !options.method) return { entity: 'products', record, data_mode: 'erp_native' };
      // The supplier drawer searches the contacts picker (contatos lane, migration 158).
      if (path.startsWith('/v1/cadastros/contatos/opcoes?') || path.startsWith('/v1/cadastros/contacts?')) return { entity: 'contacts', items: [{ id: ids.supplier, entity: 'contacts', name: 'Fornecedor fictício', code: 'F' }], has_more: false, next_cursor: null, limit: 25, data_mode: 'erp_native' };
      if (path === `/v1/cadastros/contatos/${ids.supplier}`) return { entity: 'contacts', record: { id: ids.supplier, notes: 'Entregar só pela manhã.', persons: [{ id: ids.b, name: 'Joana Compras', code: null, situation: 'A' }] }, data_mode: 'erp_native' };
      if (options.method) return { entity: 'products', record: { ...record, version: 4 }, replayed: false, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async preferences(path) { if (path.includes('empresa-geral')) return preferenceView('empresa-geral', { 'empresa.decimais_peso': 2 }); throw new AccessError(404); },
  };
  const props = { controller, entity: 'products', record: { id: ids.a, entity: 'products', version: 3, active: true, name: 'Parafuso', code: '', created_at: stamp, updated_at: stamp, source: null }, writable: true, onSaved() {}, onClose() {} };
  const view = await mountComponent('ProductEditor.tsx', props, { componentName: 'ProductEditor', expandChildren: ['ProductForm', 'SupplierDrawer', 'Modal', 'ProductValidationPanel'] });
  try {
    assert.equal(view.input('catalog-category_id').type.name, 'SearchableSelect'); assert.equal(view.input('catalog-product_group_id').type.name, 'SearchableSelect');
    const card = view.find(node => node.type === 'button' && node.props['aria-label'] === 'Cadastro no FAGOO: Pendente');
    card.props.onClick(); await view.flush();
    assert.match(view.text(), /Verificar preço \*/); assert.match(view.text(), /Inserir código \*/);
    await view.change('catalog-price', '12'); await view.change('catalog-code', 'PAR-1');
    assert.match(view.text(), /Os campos obrigatórios do cadastro estão preenchidos/);
    assert.equal(view.input('catalog-net_weight').props.value, '1,50', 'the weight shows the decimals of the preference (2)');
    assert.equal(view.input('catalog-width').props.value, '10,00');
    await view.change('catalog-net_weight', '1,234');
    view.find(node => node.type === 'button' && node.props.type === 'submit' || (node.type === 'button' && textOf(node.props.children) === 'Salvar produto')).props.onClick?.({ preventDefault() {} });
    await view.submit();
    assert.match(view.text(), /Informe o peso com até 2 casa\(s\) decimal\(is\)/);
    assert.equal(calls.filter(call => call.method).length, 0);
    await view.change('catalog-net_weight', '1,25');
    view.find(node => node.type === 'button' && node.props.id === 'product-tab-suppliers').props.onClick(); await view.flush();
    view.find(node => node.type === 'button' && node.props.id === 'catalog-suppliers').props.onClick(); await view.flush();
    await view.change('product-supplier-search', 'Forn'); await new Promise(resolve => setTimeout(resolve, 300)); await view.flush();
    view.find(node => node.type === 'button' && node.props.role === 'option').props.onClick(); await view.flush(); await view.flush();
    assert.match(view.text(), /Observações do contato:.*Entregar só pela manhã\./);
    view.find(node => node.type === 'button' && node.props.title === 'Visualizar pessoas de contato').props.onClick(); await view.flush();
    assert.match(view.text(), /Pessoas de contato: Joana Compras/);
  } finally { view.unmount(); }
});
