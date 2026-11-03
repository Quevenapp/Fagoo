import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { customValue, customValuesPayload, customFieldData, customFieldDraft, lostCustomValues, visibleCustomFields, customExportColumns } from '../src/lib/custom-fields.ts';
import { exportColumns, exportCsv, exportSheet, productLists } from '../src/lib/product-form-model.ts';

// Campos customizados de produtos (migração 156) na interface: tela Campos Customizados (filtros, grade, Situação, gaveta e
// exclusão), o bloco do formulário do produto (categoria/Agrupador, validação, aviso ao trocar a categoria), o formulário de
// categoria com os campos aplicáveis e a exportação Customizado/Ambos. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const actor = '96000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { power: '96000000-0000-4000-8000-000000000001', color: '96000000-0000-4000-8000-000000000002', factor: '96000000-0000-4000-8000-000000000003', old: '96000000-0000-4000-8000-000000000004',
  blue: '96000000-0000-4000-8000-0000000000b1', green: '96000000-0000-4000-8000-0000000000b2', tools: '96000000-0000-4000-8000-0000000000c1', drills: '96000000-0000-4000-8000-0000000000c2', food: '96000000-0000-4000-8000-0000000000c3',
  product: '96000000-0000-4000-8000-0000000000d1', created: '96000000-0000-4000-8000-0000000000e1' };
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
const field = (id, name, field_type, extra = {}) => ({ id, module: 'products', field_type, name, hint: null, info: null, required: false, min_length: null, max_length: null, width: 'medium', grouped: false, active: true,
  version: 1, created_at: stamp, updated_at: stamp, options: [], category_ids: [], products: 0, ...extra });
const FIELDS = () => [
  field(ids.color, 'Cor', 'list', { required: true, options: [{ id: ids.blue, label: 'Azul' }, { id: ids.green, label: 'Verde' }], info: 'Cor principal', products: 2 }),
  field(ids.factor, 'Fator', 'decimal', { hint: 'Ex.: 1,5', width: 'small' }),
  field(ids.power, 'Potência', 'integer', { grouped: true, category_ids: [ids.tools], max_length: 4 }),
  field(ids.old, 'Antigo', 'text', { active: false }),
];
const category = (id, name, parent_id = null) => ({ id, kind: 'categories', parent_id, name, version: 1, created_at: stamp, updated_at: stamp, children: 0, products: 0, tag_type: null, contacts: 0 });
const CATEGORIES = [category(ids.tools, 'Ferramentas'), category(ids.drills, 'Furadeiras', ids.tools), category(ids.food, 'Alimentos')];

function server({ write = ['products'], fields = FIELDS(), patch, post } = {}) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => {}, retry() {},
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products'], write, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/campos-customizados' && !options.method) return { module: 'products', items: fields, data_mode: 'erp_native' };
      // Wave E (migration 235): the screen reads its list with the user's permissions.
      if (path === '/v1/cadastros/campos-customizados?tela=produtos') return { module: 'products', items: fields, permissions: { insert_edit: write.includes('products'), delete: write.includes('products') }, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/campos-customizados' && options.method === 'POST') return post ? post(options.body, calls) : { saved: true, field: field(ids.created, options.body.data.name, options.body.data.field_type, { ...options.body.data, options: (options.body.data.options ?? []).map((option, i) => ({ id: `96000000-0000-4000-8000-0000000000f${i}`, label: option.label })) }), data_mode: 'erp_native' };
      const one = /^\/v1\/cadastros\/campos-customizados\/([^/]+)$/.exec(path);
      if (one && options.method === 'PATCH') { if (patch) return patch(one[1], options.body, calls); const current = fields.find(item => item.id === one[1]); return { saved: true, field: { ...current, ...options.body.data, version: current.version + 1 }, data_mode: 'erp_native' }; }
      if (path.endsWith('/excluir')) return { id: path.split('/').at(-2), deleted: true, products: 0, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) { const kind = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/')[4]];
        if (options.method) return { kind, saved: true, item: { ...CATEGORIES[2], version: 2 }, data_mode: 'erp_native' };
        return { kind, items: kind === 'categories' ? CATEGORIES : [], data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
  };
  return { calls, controller, writes: () => calls.filter(call => call.method) };
}

test('custom field rules: canonical values, required, Agrupador with subcategories, category change and the drawer data', () => {
  const [color, factor, power] = FIELDS();
  assert.deepEqual(customValue(factor, '1,50'), { value: '1.5' });
  assert.deepEqual(customValue(factor, '-0,0'), { value: '0' });
  assert.match(customValue(factor, '1.234,5').error, /seis casas decimais/);
  assert.match(customValue(power, '12345').error, /até 4 caractere/);
  assert.match(customValue(power, '1.5').error, /número inteiro/);
  assert.match(customValue(color, '').error, /Preencha o campo Cor/);
  assert.match(customValue(color, ids.food).error, /opção da lista/);
  assert.deepEqual(visibleCustomFields(FIELDS(), ids.drills, CATEGORIES).map(item => item.name), ['Cor', 'Fator', 'Potência'], 'a subcategory shows the grouped field; inactive fields are hidden');
  assert.deepEqual(visibleCustomFields(FIELDS(), ids.food, CATEGORIES).map(item => item.name), ['Cor', 'Fator']);
  assert.deepEqual(lostCustomValues(FIELDS(), { [ids.power]: '500', [ids.factor]: '1' }, ids.drills, ids.food, CATEGORIES).map(item => item.name), ['Potência']);
  assert.deepEqual(lostCustomValues(FIELDS(), { [ids.power]: '500' }, ids.drills, ids.drills, CATEGORIES), []);
  assert.deepEqual(customValuesPayload([factor], { [ids.factor]: ' 2,0 ' }), { [ids.factor]: '2' });
  assert.throws(() => customValuesPayload([color], {}), error => error.field === `custom-${ids.color}`);
  const draft = { ...customFieldDraft(), name: ' Material ', field_type: 'list', options: [{ id: null, label: 'Aço', key: 'a' }, { id: null, label: 'aço', key: 'b' }] };
  assert.match(customFieldData(draft).error, /repetidas/);
  assert.deepEqual(customFieldData({ ...draft, options: [{ id: null, label: ' Aço ', key: 'a' }] }).data,
    { name: 'Material', hint: null, info: null, required: false, width: 'medium', grouped: false, category_ids: [], active: true, field_type: 'list', options: [{ label: 'Aço' }] });
  assert.match(customFieldData({ ...customFieldDraft(), name: 'Faixa', field_type: 'text', min_length: '10', max_length: '5' }).error, /mínimo não pode ser maior/);
  assert.match(customFieldData({ ...customFieldDraft(), name: 'Grande', field_type: 'text', max_length: '300' }).error, /1 a 255/);
  assert.equal('field_type' in customFieldData(customFieldDraft(color), color).data, false, 'the type is fixed on edit');
});

test('export Customizado / Ambos: ID, Código, Descrição and one column per field; lists, booleans, dates and exact decimals', () => {
  const flag = field('96000000-0000-4000-8000-000000000005', 'Importado', 'boolean'), date = field('96000000-0000-4000-8000-000000000006', 'Lançamento', 'date');
  const custom = customExportColumns([...FIELDS().slice(0, 2), flag, date]);
  const row = { id: ids.product, code: 'P-1', name: 'Mesa', active: true, tags: [], images: [], supplier: null, custom_values: { [ids.color]: ids.green, [ids.factor]: '1.5', [flag.id]: 'true', [date.id]: '2026-10-20' } };
  const csv = exportCsv([row], exportColumns('custom', custom));
  assert.equal(csv.split('\r\n')[0], '﻿ID;Código;Descrição;Cor;Fator;Importado;Lançamento');
  assert.equal(csv.split('\r\n')[1], `${ids.product};P-1;Mesa;Verde;1,5;Sim;20/10/2026`);
  const both = exportColumns('both', custom);
  assert.equal(both.length, exportColumns('standard', []).length + 4);
  const sheet = exportSheet([row], exportColumns('custom', custom));
  assert.deepEqual(sheet[1][4], { number: '1.5' }, 'a decimal custom field is an exact number in the XLS');
  assert.deepEqual(productLists({ id: ids.product, custom_values: { [ids.factor]: '1.5', bad: 1 } }).custom_values, { [ids.factor]: '1.5' });
});

test('Campos Customizados screen: tabs, filters, Situação toggle with "Conferir resultado", drawer and deletion of a field with values', async () => {
  let toggles = 0;
  const service = server({ patch(id, body) { toggles++; if (toggles === 1) throw new AccessError(503); const current = FIELDS().find(item => item.id === id); return { saved: true, field: { ...current, ...body.data, version: 2 }, data_mode: 'erp_native' }; } });
  const view = await mountComponent('CustomFields.tsx', { controller: service.controller }, { location: '/campos-customizados', expandChildren: ['CustomFieldDrawer', 'Modal'] });
  try {
    const tabs = view.nodes().filter(node => node.props?.role === 'tab');
    // 202610200288 (onda G): the Ordem de Serviço tab opens the campos customizados of the OS.
    assert.deepEqual(tabs.map(tab => [textOf(tab.props.children), Boolean(tab.props.disabled)]), [['Produtos', false], ['Ordem de Serviço', false], ['Clientes e Fornecedores', true]]);
    const headers = view.nodes().filter(node => node.type === 'th').map(node => textOf(node.props.children));
    assert.deepEqual(headers, ['Seleção', 'Nome', 'Tipo', 'Situação', 'Ações']);
    assert.match(view.text(), /Quantidade de campos4/);
    await view.change('custom-fields-type', 'list'); assert.match(view.text(), /Quantidade de campos1/);
    await view.change('custom-fields-type', ''); await view.change('custom-fields-situation', 'inactive'); assert.match(view.text(), /Antigo/); assert.doesNotMatch(view.text(), /Potência/);
    await view.click('Limpar filtros'); await view.change('custom-fields-search', 'potencia'); assert.match(view.text(), /Quantidade de campos1/);
    await view.click('Limpar filtros');
    // Situação: the first answer is unknown; "Conferir resultado" repeats the same command.
    view.find(node => node.props?.['aria-label'] === 'Situação de Fator').props.onChange(); await view.flush();
    assert.match(view.text(), /Não foi possível confirmar a situação do campo “Fator”/);
    await view.click('Conferir resultado');
    const sent = service.writes().filter(call => call.method === 'PATCH');
    assert.equal(sent.length, 2); assert.equal(sent[0].body.command_id, sent[1].body.command_id);
    assert.deepEqual(sent[0].body.data, { active: false }); assert.equal(sent[0].body.expected_version, 1);
    assert.match(view.text(), /Campo “Fator” inativado/);
    // Drawer: a list needs options; the type is fixed on edit.
    await view.click('Adicionar campo');
    assert.match(view.text(), /Características do campo/);
    await view.change('custom-field-type', 'list'); await view.change('custom-field-name', 'Material'); await view.click('Salvar');
    assert.match(view.text(), /Adicione ao menos uma opção/);
    await view.click('Adicionar opção');
    view.find(node => node.props?.['aria-label'] === 'Opção 1').props.onChange({ target: { value: 'Aço' } }); await view.flush();
    await view.change('custom-field-grouped', true);
    assert.match(view.text(), /Furadeiras/, 'the Agrupador lists the product categories');
    await view.click('Salvar');
    const created = service.writes().find(call => call.method === 'POST');
    assert.deepEqual(created.body.data, { name: 'Material', hint: null, info: null, required: false, width: 'medium', grouped: true, category_ids: [], active: true, field_type: 'list', options: [{ label: 'Aço' }] });
    assert.match(view.text(), /Campo incluído/);
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Editar Cor').props.onClick(); await view.flush();
    assert.equal(view.input('custom-field-type').props.disabled, true);
    assert.match(view.text(), /2 produto\(s\) têm valor neste campo/);
    await view.click('Cancelar');
    // Deletion: a field with values is skipped with the reason; the others go one command each.
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Excluir Cor').props.onClick(); await view.flush();
    const dialog = view.find(node => node.type?.name === 'BatchDialog');
    assert.equal(dialog.props.plan.eligible.length, 0); assert.match(dialog.props.plan.skipped[0].message, /inative o campo/);
  } finally { view.unmount(); }
  const readOnly = await mountComponent('CustomFields.tsx', { controller: server({ write: [] }).controller }, { location: '/campos-customizados' });
  try {
    assert.match(readOnly.text(), /Somente consulta/);
    assert.throws(() => readOnly.button('Adicionar campo'));
    assert.equal(readOnly.find(node => node.props?.['aria-label'] === 'Situação de Fator').props.disabled, true);
  } finally { readOnly.unmount(); }
});

test('product form: custom fields of the category, the Origin warning on a category change and data.custom_values in the same command', async () => {
  const record = { id: ids.product, entity: 'products', version: 3, active: true, name: 'Furadeira', code: 'F-1', unit: 'UN', price: '10', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null,
    tag_ids: [], images: [], dun_codes: [], deleted_at: null, suppliers: [], category_id: ids.drills, product_group_id: null, custom_values: { [ids.power]: '500', [ids.color]: ids.blue } };
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros/campos-customizados') return { module: 'products', items: FIELDS(), data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) { const kind = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)]; return { kind, items: kind === 'categories' ? CATEGORIES : [], data_mode: 'erp_native' }; }
      if (path === `/v1/cadastros/products/${ids.product}/completo` && !options.method) return { entity: 'products', record, data_mode: 'erp_native' };
      if (options.method) return { entity: 'products', record: { ...record, version: 4 }, replayed: false, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
    async preferences() { throw new AccessError(404); },
  };
  const props = { controller, entity: 'products', record: { id: ids.product, entity: 'products', version: 3, active: true, name: 'Furadeira', code: 'F-1', created_at: stamp, updated_at: stamp, source: null }, writable: true, onSaved() {}, onClose() {} };
  const view = await mountComponent('ProductEditor.tsx', props, { componentName: 'ProductEditor', expandChildren: ['ProductForm', 'ProductCustomFields', 'Modal'] });
  try {
    assert.match(view.text(), /Campos customizados/);
    assert.equal(view.input(`catalog-custom-${ids.power}`).props.value, '500');
    assert.equal(view.input(`catalog-custom-${ids.factor}`).props.placeholder, 'Ex.: 1,5');
    assert.throws(() => view.input(`catalog-custom-${ids.old}`), 'inactive fields are hidden');
    await view.change(`catalog-custom-${ids.factor}`, '1,25');
    // Changing to a category where Potência does not apply: Origin warning, then the value leaves the form.
    view.input('catalog-category_id').props.onChange({ target: { value: ids.food } }); await view.flush();
    assert.match(view.text(), /Ao alterar a categoria do produto, os campos customizados vinculados serão removidos\./);
    assert.match(view.text(), /Potência/);
    await view.click('Alterar categoria');
    assert.throws(() => view.input(`catalog-custom-${ids.power}`));
    await view.change(`catalog-custom-${ids.color}`, '');
    await view.submit();
    assert.match(view.text(), /Preencha o campo Cor/);
    assert.equal(calls.filter(call => call.method).length, 0, 'nothing is sent with a required field empty');
    await view.change(`catalog-custom-${ids.color}`, ids.green);
    await view.submit();
    const save = calls.find(call => call.method === 'PATCH');
    assert.equal(save.body.data.category_id, ids.food);
    assert.deepEqual(save.body.data.custom_values, { [ids.color]: ids.green, [ids.factor]: '1.25' }, 'only the fields shown; the removed one is left to the database');
  } finally { view.unmount(); }
});

test('category form: "Campos customizáveis aplicáveis nesta categoria" in the same command as the category', async () => {
  const service = server();
  const view = await mountComponent('ProductTaxonomy.tsx', { controller: service.controller, kind: 'categories' }, { location: '/categorias-produtos', expandChildren: [] });
  try {
    view.find(node => node.type === 'button' && textOf(node.props.children) === 'Ferramentas').props.onClick(); await view.flush();
    assert.match(view.text(), /Campos customizáveis aplicáveis nesta categoria/);
    assert.match(view.text(), /Potência/, 'the fields grouped in the category are selected');
    view.find(node => node.type?.name === 'SearchableSelect' && node.props.id === 'taxonomy-fields').props.onChange({ target: { value: ids.factor } }); await view.flush();
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Remover o campo Potência').props.onClick(); await view.flush();
    await view.submit();
    const sent = service.writes().at(-1);
    assert.equal(sent.path, `/v1/cadastros/taxonomias/categorias-produtos/${ids.tools}`);
    assert.deepEqual(sent.body.data, { name: 'Ferramentas', custom_field_ids: [ids.factor] });
  } finally { view.unmount(); }
});
