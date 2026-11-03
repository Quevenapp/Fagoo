import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { appliedCustomFilter, customFilterApi, customFilterDraft, customRowLabel, customRowProblem } from '../src/lib/product-custom-filter-model.ts';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';

// Produtos, onda D (migração 191): filtro "Campos customizados" da listagem, assistente "Cadastrar novo produto", Itens p/ caixa
// decimal, campos do IPI pelo regime da empresa e o código Sequencial EAN. Dados sintéticos.
let previous;
test.before(() => {
  previous = globalThis.document;
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, classList: { add() {}, remove() {} } }, createElement: () => ({ click() {}, remove() {} }) };
});
test.after(() => { globalThis.document = previous; });
const actor = '96000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { a: '96000000-0000-4000-8000-000000000001', b: '96000000-0000-4000-8000-000000000002', category: '96000000-0000-4000-8000-0000000000c1', child: '96000000-0000-4000-8000-0000000000c2',
  text: '96000000-0000-4000-8000-0000000000f1', list: '96000000-0000-4000-8000-0000000000f2', number: '96000000-0000-4000-8000-0000000000f3', azul: '96000000-0000-4000-8000-0000000000e1', verde: '96000000-0000-4000-8000-0000000000e2' };
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const preferenceView = (pageId, values) => { const page = preferencePage(pageId); return { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'admin', can_manage: true, directory: null,
  items: storedFields(page).map(field => Object.hasOwn(values, field.key) ? { key: field.key, value: values[field.key], version: 1, updated_at: stamp } : { key: field.key, value: field.default, version: 0, updated_at: null }) }; };
const field = (id, field_type, name, extra = {}) => ({ id, module: 'products', field_type, name, hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium', grouped: false, active: true, version: 1,
  created_at: stamp, updated_at: stamp, options: [], category_ids: [], products: 0, ...extra });
const FIELDS = [field(ids.text, 'text', 'Material'), field(ids.list, 'list', 'Cor', { grouped: true, category_ids: [ids.category], options: [{ id: ids.azul, label: 'Azul' }, { id: ids.verde, label: 'Verde' }] }), field(ids.number, 'decimal', 'Fator')];
const categories = [{ id: ids.category, kind: 'categories', parent_id: null, name: 'Ferragens', version: 1, created_at: stamp, updated_at: stamp, tag_type: null, children: 1, products: 0, contacts: 0 },
  { id: ids.child, kind: 'categories', parent_id: ids.category, name: 'Parafusos', version: 1, created_at: stamp, updated_at: stamp, tag_type: null, children: 0, products: 1, contacts: 0 }];

test('custom filter model: rows by type, problems, the applied filter and the canonical API list', () => {
  const draft = JSON.stringify({ category: ids.child, rows: [
    { field_id: ids.text, type: 'text', name: 'Material', value: '  aço ', from: '', to: '' },
    { field_id: ids.number, type: 'decimal', name: 'Fator', value: '', from: '1,5', to: '' },
    { field_id: ids.number, type: 'decimal', name: 'Fator', value: '', from: 'abc', to: '' },
    { field_id: ids.list, type: 'list', name: 'Cor', value: ids.azul, from: '', to: '', option: 'Azul' },
    { field_id: ids.list, type: 'list', name: 'Cor', value: '', from: '', to: '' }] });
  const rows = customFilterDraft(draft).rows;
  assert.deepEqual(rows.map(customRowProblem).map(Boolean), [false, false, true, false, true]);
  assert.equal(customRowProblem({ field_id: ids.number, type: 'integer', name: 'Peças', value: '', from: '5', to: '2' }), 'O valor inicial de Peças é maior que o final.');
  assert.equal(customRowProblem({ field_id: ids.number, type: 'date', name: 'Lançamento', value: '', from: '2026-05-01', to: '2026-01-01' }), 'A data inicial de Lançamento é posterior à final.');
  const applied = customFilterDraft(appliedCustomFilter(draft));
  assert.deepEqual([applied.category, applied.rows.length, applied.rows[1].from], [ids.child, 3, '1.5']);
  assert.deepEqual(customFilterApi(appliedCustomFilter(draft)), [{ field_id: ids.text, value: 'aço' }, { field_id: ids.number, from: '1.5' }, { field_id: ids.list, value: ids.azul }]);
  assert.deepEqual(applied.rows.map(customRowLabel), ['Material contém “aço”', 'Fator a partir de 1,5', 'Cor: Azul']);
  assert.equal(customRowLabel({ field_id: ids.number, type: 'date', name: 'Lançamento', value: '', from: '2026-01-01', to: '2026-03-31' }), 'Lançamento de 01/01/2026 até 31/03/2026');
  assert.equal(appliedCustomFilter(JSON.stringify({ category: ids.child, rows: [] })), '', 'only the category: no filter');
  assert.deepEqual(customFilterDraft('{bad'), { category: '', rows: [] });
  assert.equal(customFilterApi(''), null);
});

function listServer() {
  const calls = [];
  const rows = [ids.a, ids.b].map((id, n) => ({ id, entity: 'products', version: 3, active: true, name: n ? 'Porca' : 'Parafuso', code: null, unit: 'UN', price: '10.0000', kind: 'P', format: 'S', gtin: null,
    created_at: stamp, updated_at: stamp, source: null, stock: null, stock_min: null, stock_max: null, thumbnail: null, deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }));
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/taxonomias/categorias-produtos') return { kind: 'categories', items: categories, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: FIELDS, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) return { entity: 'products', items: rows, page: 1, size: 100, total: 2, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/reajuste/previa') return { entity: 'products', items: rows.map(row => ({ id: row.id, price: '10.0000', status: 'ok', new_price: '11.0000' })), data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/reajuste') return { entity: 'products', total: 2, applied: 2, unchanged: 0, skipped_total: 0, skipped: [], rule: options.body.rule, replayed: false, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return preferenceView('cadastros-produtos', {}); },
  };
  return { calls, controller };
}
const pageParams = calls => new URLSearchParams(calls.filter(call => call.path.startsWith('/v1/cadastros/products?')).at(-1).path.split('?')[1]);

test('product list: Campos customizados filter — category, Adicionar filtros, typed rows, chip, page parameter, the filtered price adjust and the export', async () => {
  const service = listServer();
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'ProductCustomFilter', 'PriceAdjustmentBar', 'Modal', 'NewPriceCell', 'AppliedChips'] });
  try {
    assert.equal(service.calls.filter(call => call.path === '/v1/cadastros/campos-customizados').length, 0, 'the definitions are read only when the filter is used');
    assert.equal(view.button('Adicionar filtros').disabled, true, 'without a category');
    await view.change('catalog-custom-category', ids.child); await view.flush();
    assert.equal(service.calls.filter(call => call.path === '/v1/cadastros/campos-customizados').length, 1);
    await view.click('Adicionar filtros');
    assert.equal(view.input('catalog-custom-filter-0-field').props.value, ids.text);
    assert.deepEqual(view.input('catalog-custom-filter-0-field').props.children[1].map(option => textOf(option.props.children)), ['Material', 'Cor', 'Fator'], 'fields of the category and its parents, plus ungrouped ones');
    await view.change('catalog-custom-filter-0-value', 'aço');
    await view.click('Adicionar filtros');
    await view.change('catalog-custom-filter-1-field', ids.list);
    await view.change('catalog-custom-filter-1-value', ids.azul);
    await view.click('Adicionar filtros');
    await view.change('catalog-custom-filter-2-field', ids.number);
    await view.change('catalog-custom-filter-2-from', 'abc');
    assert.match(view.text(), /Informe números em Fator.*Este filtro fica de fora até ser corrigido\./);
    await view.submit();
    assert.deepEqual(JSON.parse(pageParams(service.calls).get('custom')), [{ field_id: ids.text, value: 'aço' }, { field_id: ids.list, value: ids.azul }], 'the invalid row stays out');
    assert.match(view.text(), /Campos customizados: Material contém “aço” · Cor: Azul/);
    const exportLink = view.find(node => node.type === 'test-router-link' && textOf(node.props.children).includes('Exportar dados para planilha'));
    assert.equal(new URLSearchParams(exportLink.props.to.split('?')[1]).has('custom'), false);
    assert.match(view.text(), /A exportação não usa o filtro Campos customizados, como no Origin\./);
    // Reajuste "Produtos filtrados" carries the same filter as a list.
    await view.click('Reajuste e sincronização de preços');
    await view.change('price-adjust-value', '10'); await new Promise(resolve => setTimeout(resolve, 350)); await view.flush();
    await view.click('Atualizar produtos');
    view.nodes().filter(node => node.type === 'button' && textOf(node.props.children) === 'Atualizar produtos').at(-1).props.onClick(); await view.flush();
    const adjust = service.calls.filter(call => call.path === '/v1/cadastros/products/reajuste').at(-1);
    assert.deepEqual(adjust.body.filters, { situation: 'latest', custom: [{ field_id: ids.text, value: 'aço' }, { field_id: ids.list, value: ids.azul }] });
    // Removing the chip clears the filter.
    view.find(node => node.type === 'button' && /^Remover filtro Campos customizados/.test(node.props['aria-label'] ?? '')).props.onClick(); await view.flush();
    assert.equal(pageParams(service.calls).has('custom'), false);
  } finally { view.unmount(); }
});

function editorServer({ preferences = {}, crt = '1' } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path.startsWith('/v1/cadastros/taxonomias/')) { const kind = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)]; return { kind, items: kind === 'categories' ? categories : [], data_mode: 'erp_native' }; }
      if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: FIELDS, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/contexto') { if (crt === 'fail') throw new AccessError(503); return { crt, data_mode: 'erp_native' }; }
      if (path === '/v1/cadastros/products/completo' && options.method === 'POST') return { entity: 'products', record: { id: ids.a, entity: 'products', version: 1, active: true, name: options.body.data.name, created_at: stamp, updated_at: stamp, source: null }, replayed: false, data_mode: 'erp_native' };
      if (path === `/v1/cadastros/products/${ids.a}`) return { entity: 'products', record: { id: ids.a, entity: 'products', version: 1, active: true, name: 'Novo', created_at: stamp, updated_at: stamp, source: null }, data_mode: 'erp_native' };
      if (path.startsWith('/v1/posicoes-estoque/') || path.startsWith('/v1/estoque/')) throw new AccessError(403);
      throw new AccessError(404);
    },
    async stock() { throw new AccessError(403); }, async stockPositions() { throw new AccessError(403); },
    async preferences(path) { if (path.includes('empresa-geral')) return preferenceView('empresa-geral', {}); if (path.includes('cadastros-produtos')) return preferenceView('cadastros-produtos', preferences); throw new AccessError(404); },
  };
  return { calls, controller };
}
const EXPAND = ['ProductForm', 'Modal', 'ProductValidationPanel', 'ProductCustomFields'];
const editorProps = (controller, extra = {}) => ({ controller, entity: 'products', record: null, writable: true, onSaved() {}, onClose() {}, ...extra });

test('wizard: "Pular etapas" off opens Cadastrar novo produto; no step change without Nome; progress; Itens p/ caixa decimal; IPI by regime; save', async () => {
  const service = editorServer({ preferences: { 'produtos.pular_etapas': false }, crt: '1' });
  const view = await mountComponent('ProductEditor.tsx', editorProps(service.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    assert.match(view.text(), /Cadastrar novo produto/);
    assert.deepEqual(view.nodes().filter(node => node.type === 'button' && /^product-step-/.test(node.props.id ?? '')).map(node => textOf(node.props.children)),
      ['1Dados básicos', '2Características (opcional)', '3Imagens (opcional)', '4Estoque (opcional)', '5Tributação (opcional)']);
    assert.equal(view.input('product-step-basic').props['aria-current'], 'step');
    assert.deepEqual(view.input('catalog-format').props.children[1].map(option => textOf(option.props.children)), ['Simples', 'Com variações', 'Com composição (Kit ou união de vários itens)']);
    assert.ok(view.nodes().some(node => node.props?.id === 'catalog-category_id'), 'Categoria is in Dados básicos');
    // Origin: changing steps without Nome shows the orange alert and highlights the field.
    await view.click('Avançar');
    assert.match(view.text(), /Não foi possível navegar para o passo desejado.*Verifique os campos destacados abaixo\..*Preencha o nome do produto/);
    assert.equal(view.input('catalog-name').props['aria-invalid'], true);
    assert.ok(view.nodes().some(node => node.type === 'div' && /product-field-warning/.test(node.props.className ?? '')));
    view.input('product-step-tax').props.onClick(); await view.flush();
    assert.equal(view.input('product-step-basic').props['aria-current'], 'step', 'the step column is guarded too');
    await view.change('catalog-name', 'Caixa de parafusos');
    assert.doesNotMatch(view.text(), /Não foi possível navegar/);
    await view.click('Avançar');
    assert.equal(view.input('product-step-characteristics').props['aria-current'], 'step');
    const progress = view.find(node => node.props?.role === 'progressbar');
    assert.deepEqual([progress.props['aria-valuenow'], progress.props['aria-valuemax'], progress.props['aria-valuetext']], [2, 5, 'Etapa 2 de 5: Características']);
    await view.change('catalog-items_per_box', '2,5');
    assert.equal(service.calls.filter(call => call.path === '/v1/cadastros/products/contexto').length, 0, 'the regime is read when Tributação is shown');
    view.input('product-step-tax').props.onClick(); await view.flush(); await view.flush();
    assert.equal(service.calls.filter(call => call.path === '/v1/cadastros/products/contexto').length, 1);
    assert.ok(view.nodes().some(node => node.props?.id === 'catalog-ipi_tipi_exception'));
    assert.equal(view.nodes().some(node => node.props?.id === 'catalog-ipi_framework_class'), false, 'Simples Nacional: no Classe de enquadramento');
    assert.match(view.text(), /aparecem para empresas do Regime Normal/);
    assert.ok(view.nodes().some(node => node.type === 'button' && node.props.type === 'submit' && textOf(node.props.children) === 'Salvar'), 'Salvar from the second step on');
    await view.submit();
    const save = service.calls.find(call => call.method === 'POST');
    assert.equal(save.path, '/v1/cadastros/products/completo');
    assert.equal(save.body.data.name, 'Caixa de parafusos');
    assert.equal(save.body.data.items_per_box_decimal, '2.5');
    assert.equal(Object.hasOwn(save.body.data, 'items_per_box'), false, 'the integer catalog column is not sent');
  } finally { view.unmount(); }
});

test('wizard: Pular para versão completa keeps the values; the default preference opens the complete form; a clone never opens the wizard', async () => {
  const wizard = editorServer({ preferences: { 'produtos.pular_etapas': false } });
  let view = await mountComponent('ProductEditor.tsx', editorProps(wizard.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    await view.change('catalog-name', 'Arruela');
    await view.click('Pular para versão completa');
    assert.doesNotMatch(view.text(), /Cadastrar novo produto/);
    assert.ok(view.nodes().some(node => node.props?.role === 'tablist'));
    assert.equal(view.input('catalog-name').props.value, 'Arruela');
  } finally { view.unmount(); }
  const complete = editorServer();
  view = await mountComponent('ProductEditor.tsx', editorProps(complete.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try { assert.doesNotMatch(view.text(), /Cadastrar novo produto/); assert.ok(view.nodes().some(node => node.props?.role === 'tablist')); } finally { view.unmount(); }
  view = await mountComponent('ProductEditor.tsx', editorProps(wizard.controller, { initialValues: { name: 'Cópia', __lists: '{}' }, cloneOf: 'Original' }), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try { assert.doesNotMatch(view.text(), /Cadastrar novo produto/); } finally { view.unmount(); }
});

test('complete form: IPI fields by the regime (Regime Normal, unconfirmed, unreadable) and the Consultar link', async () => {
  for (const [crt, shown, note] of [['3', true, null], [null, true, /não está confirmado/], ['fail', true, null], ['4', false, /Regime Normal/]]) {
    const service = editorServer({ crt });
    const view = await mountComponent('ProductEditor.tsx', editorProps(service.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
    try {
      view.input('product-tab-tax').props.onClick(); await view.flush(); await view.flush();
      assert.equal(view.nodes().some(node => node.props?.id === 'catalog-ipi_framework_class'), shown, String(crt));
      assert.equal(view.nodes().some(node => node.props?.id === 'catalog-ipi_seal_code'), shown, String(crt));
      if (shown) assert.ok(view.nodes().some(node => node.type === 'a' && textOf(node.props.children) === 'Consultar' && /nfe\.fazenda\.gov\.br/.test(node.props.href)));
      if (note) assert.match(view.text(), note); else assert.doesNotMatch(view.text(), /não está confirmado|aparecem para empresas do Regime Normal/);
    } finally { view.unmount(); }
  }
});

test('complete form: Sequencial EAN asks for the code without the GS1 prefix and shows "Gerado ao salvar" with it', async () => {
  const without = editorServer({ preferences: { 'produtos.codigo': 'sequencial_ean' } });
  let view = await mountComponent('ProductEditor.tsx', editorProps(without.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    await view.change('catalog-name', 'Sem prefixo');
    await view.submit();
    assert.match(view.text(), /Informe o código \(SKU\): o código Sequencial EAN precisa do Prefixo GS1/);
    assert.equal(without.calls.filter(call => call.method).length, 0);
    assert.notEqual(view.input('catalog-code').props.placeholder, 'Gerado ao salvar');
  } finally { view.unmount(); }
  const withPrefix = editorServer({ preferences: { 'produtos.codigo': 'sequencial_ean', 'produtos.ean_prefixo': '7891234' } });
  view = await mountComponent('ProductEditor.tsx', editorProps(withPrefix.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    assert.equal(view.input('catalog-code').props.placeholder, 'Gerado ao salvar');
    await view.change('catalog-name', 'Com prefixo'); await view.submit();
    assert.equal(withPrefix.calls.filter(call => call.method === 'POST').length, 1);
  } finally { view.unmount(); }
});

test('complete form: Controle de lote is a stored switch of the Estoque tab, unavailable for products with variations', async () => {
  const service = editorServer();
  const view = await mountComponent('ProductEditor.tsx', editorProps(service.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    view.input('product-tab-stock').props.onClick(); await view.flush();
    assert.equal(view.input('catalog-lot_control').props.checked, false);
    assert.match(view.text(), /Controle de lote desativado/);
    // Estoque lane (258): the lots exist in the stock now; the note says where they are managed.
    assert.match(view.text(), /Com o controle ativado e salvo, os lotes ficam abaixo e em Estoque › Lançamentos de estoque \(aba Lotes e validades\)/);
    view.input('catalog-lot_control').props.onChange({ target: { checked: true } }); await view.flush();
    assert.match(view.text(), /Controle de lote ativado/);
    await view.change('catalog-name', 'Leite em pó'); await view.submit();
    assert.equal(service.calls.find(call => call.method === 'POST').body.data.lot_control, true);
  } finally { view.unmount(); }
  const variations = await mountComponent('ProductEditor.tsx', editorProps(editorServer().controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    await variations.change('catalog-format', 'V');
    variations.input('product-tab-stock').props.onClick(); await variations.flush();
    assert.equal(variations.input('catalog-lot_control').props.disabled, true);
    assert.match(variations.text(), /Não é possível usar controle de lote em produto com variações\./);
  } finally { variations.unmount(); }
});

test('complete form: a stored IPI value stays visible outside the Regime Normal while it is cleared; Controle de lote with variations is refused before the save', async () => {
  const service = editorServer({ crt: '1' });
  const view = await mountComponent('ProductEditor.tsx', editorProps(service.controller, { initialValues: { name: 'Cópia com selo', kind: 'P', format: 'S', unit: 'UN', ipi_seal_code: '971-001' } }),
    { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    view.input('product-tab-tax').props.onClick(); await view.flush(); await view.flush();
    assert.equal(view.input('catalog-ipi_seal_code').props.value, '971-001');
    await view.change('catalog-ipi_seal_code', '');
    assert.ok(view.nodes().some(node => node.props?.id === 'catalog-ipi_seal_code'), 'the field does not vanish while it is cleared');
    assert.equal(view.nodes().some(node => node.props?.id === 'catalog-ipi_framework_class'), false, 'an empty conditional field stays hidden');
  } finally { view.unmount(); }
  const lot = editorServer();
  const form = await mountComponent('ProductEditor.tsx', editorProps(lot.controller), { componentName: 'ProductEditor', expandChildren: EXPAND });
  try {
    form.input('product-tab-stock').props.onClick(); await form.flush();
    form.input('catalog-lot_control').props.onChange({ target: { checked: true } }); await form.flush();
    await form.change('catalog-format', 'V');
    await form.change('catalog-name', 'Camiseta');
    await form.submit();
    assert.equal(lot.calls.filter(call => call.method === 'POST').length, 0, 'nothing is sent');
    assert.match(form.text(), /Não é possível usar controle de lote em produto com variações\. Desative o Controle de lote ou escolha outro formato\./);
    assert.equal(form.input('catalog-lot_control').props['aria-invalid'], true);
    assert.equal(form.input('catalog-lot_control').props.disabled, false, 'a switch already on can still be turned off');
    form.input('catalog-lot_control').props.onChange({ target: { checked: false } }); await form.flush();
    await form.submit();
    const posts = lot.calls.filter(call => call.method === 'POST');
    assert.deepEqual([posts.length, posts[0]?.body.data.lot_control, posts[0]?.body.data.format], [1, false, 'V']);
  } finally { form.unmount(); }
});

test('complete form: Imagens armazenadas is mounted only when Imagens is first opened, then stays mounted', async () => {
  const service = editorServer();
  const view = await mountComponent('ProductEditor.tsx', editorProps(service.controller), { componentName: 'ProductEditor', expandChildren: [...EXPAND, 'ProductStoredImages'] });
  try {
    assert.doesNotMatch(view.text(), /Salve o produto para enviar imagens armazenadas/);
    view.input('product-tab-images').props.onClick(); await view.flush();
    assert.match(view.text(), /Salve o produto para enviar imagens armazenadas no FAGOO\./);
    view.input('product-tab-stock').props.onClick(); await view.flush();
    assert.match(view.text(), /Salve o produto para enviar imagens armazenadas no FAGOO\./, 'kept mounted (hidden) after the tab changes');
  } finally { view.unmount(); }
});
