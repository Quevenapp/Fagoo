import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

globalThis.document ??= { activeElement: null, getElementById: () => null };
const actor = '92000000-0000-4000-8000-0000000000aa';
const warehouse = '92000000-0000-4000-8000-0000000000bb';
const stamp = '2026-10-19T12:00:00+00:00';
const product = (n, extra = {}) => ({ id: `92000000-0000-4000-8000-00000000000${n}`, entity: 'products', version: n, active: true, name: `Produto ${n}`, code: `QA-${n}`, unit: 'UN', price: '1.5000', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null, stock: { state: 'recorded', quantity: '1.000000', warehouse: null }, ...extra });
const items = [product(1), product(2, { active: false }), product(3), product(4)];
const full = item => ({ ...item, stock: undefined, gtin: '7891234567895', gtin_tax: '7891234567895', description: 'Descrição fictícia', ncm: '73181500', brand: 'Marca fictícia' });

function server({ write = async () => undefined, role = 'admin' } = {}) {
  const calls = [], snapshot = { phase: 'ready', membership: { user_id: actor, role } };
  const controller = {
    getSnapshot: () => snapshot,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (options.method) {
        const result = await write(path, options.body, calls);
        if (result) return result;
        const id = path.split('/')[4], item = items.find(row => row.id === id);
        return { entity: 'products', record: { ...full(item), version: item.version + 1, ...(path.endsWith('/active') ? { active: options.body.active } : { price: options.body.data.price }) }, replayed: false, data_mode: 'erp_native' };
      }
      const [route, search = ''] = path.split('?'), id = route.split('/')[4];
      if (id) return { entity: 'products', record: full(items.find(row => row.id === id)), data_mode: 'erp_native' };
      const params = new URLSearchParams(search);
      return { entity: 'products', items, page: Number(params.get('page')), size: 100, total: items.length, sort: params.get('sort') || 'created_desc', stock_visible: true, data_mode: 'erp_native' };
    },
    async stockPositions() { return { items: [{ id: warehouse, name: 'Geral', active: true }], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
    async stock(path) { calls.push({ path }); return { product_id: path.split('=')[1], items: [{ warehouse_id: warehouse, warehouse_name: 'Geral', warehouse_active: true, quantity: '0.000000', version: 0, unit: 'UN' }, { warehouse_id: '92000000-0000-4000-8000-0000000000cc', warehouse_name: 'Loja', warehouse_active: false, quantity: '12.500000', version: 3, unit: 'UN' }], data_mode: 'erp_native' }; },
  };
  return { calls, controller, snapshot, writes: () => calls.filter(call => call.method), lists: () => calls.filter(call => /^\/v1\/cadastros\/products\?/.test(call.path)) };
}
const event = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, ...extra });
const component = (view, name) => view.find(node => node.type?.name === name);
const menu = (view, name) => view.find(node => node.type?.name === 'RowMenu' && node.props.label === name);
const byAria = (view, label) => view.find(node => node.type === 'button' && node.props['aria-label'] === label);
const checkbox = (view, name) => view.find(node => node.type === 'input' && node.props['aria-label'] === `Selecionar ${name}`);

test('Shift-click selects a range and "Mudar situação" runs each record through the single-record endpoint', async () => {
  let failOnce = true;
  const service = server({ async write(path) {
    if (path.includes(items[2].id) && failOnce) { failOnce = false; throw new AccessError(503); }
    if (path.includes(items[3].id)) throw new AccessError(409);
  } });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    const action = () => view.button('Mudar situação de produtos selecionados');
    assert.equal(action().disabled, true);
    checkbox(view, 'Produto 1').props.onClick(event({ shiftKey: false })); await view.flush();
    checkbox(view, 'Produto 4').props.onClick(event({ shiftKey: true })); await view.flush();
    assert.deepEqual(items.map(item => checkbox(view, item.name).props.checked), [true, true, true, true]);
    checkbox(view, 'Produto 2').props.onClick(event({ shiftKey: false })); await view.flush();
    assert.equal(component(view, 'ListControls').props.indeterminate, true);
    checkbox(view, 'Produto 2').props.onClick(event({ shiftKey: false })); await view.flush();
    await view.click('Mudar situação de produtos selecionados');
    let dialog = component(view, 'BatchDialog');
    assert.equal(dialog.props.title, 'Mudar situação de produtos selecionados');
    assert.equal(dialog.props.confirmLabel, 'Ativar', 'a mixed selection proposes Ativar');
    assert.deepEqual([dialog.props.plan.eligible.map(item => item.label), dialog.props.plan.skipped.map(item => item.message)], [['Produto 2'], ['Já está ativo.', 'Já está ativo.', 'Já está ativo.']]);
    // Products (Origin): "Nova situação" is a select (Ativo | Inativo).
    const select = dialog.props.description.props.children[1];
    assert.deepEqual(select.props.children.map(option => option.props.children), ['Ativo', 'Inativo']);
    select.props.onChange({ target: { value: 'I' } }); await view.flush();
    dialog = component(view, 'BatchDialog');
    assert.equal(dialog.props.confirmLabel, 'Inativar');
    assert.deepEqual(dialog.props.plan.eligible.map(item => item.id), [items[0].id, items[2].id, items[3].id]);
    const run = dialog.props.run, results = [];
    for (const item of dialog.props.plan.eligible) { try { results.push(await run(item) ?? 'ok'); } catch (error) { results.push(error.message); } }
    await view.flush();
    assert.equal(component(view, 'BatchDialog').props.description.props.children[1].props.disabled, true, 'the target is locked once the run starts');
    assert.deepEqual(results, ['ok', { message: 'Confirmado ao repetir a mesma operação.' }, 'O cadastro foi alterado por outra operação. Atualize a listagem e tente de novo.']);
    const writes = service.writes();
    assert.deepEqual(writes.map(call => [call.path, call.method, call.body.expected_version, call.body.active]), [
      [`/v1/cadastros/products/${items[0].id}/active`, 'PATCH', 1, false], [`/v1/cadastros/products/${items[2].id}/active`, 'PATCH', 3, false],
      [`/v1/cadastros/products/${items[2].id}/active`, 'PATCH', 3, false], [`/v1/cadastros/products/${items[3].id}/active`, 'PATCH', 4, false]]);
    assert.equal(writes[1].body.command_id, writes[2].body.command_id, 'the uncertain item is repeated with the same command');
    assert.equal(new Set(writes.map(call => call.body.command_id)).size, 3, 'each record has its own command');
    const before = service.lists().length;
    component(view, 'BatchDialog').props.onClose([{ id: items[0].id, label: 'Produto 1', outcome: 'ok' }, { id: items[3].id, label: 'Produto 4', outcome: 'failed', message: 'x' }]); await view.flush();
    assert.equal(service.lists().length, before + 1, 'the list is read again after the batch');
    assert.match(view.text(), /Mudança de situação: 1 concluído · 1 com falha/);
    assert.equal(checkbox(view, 'Produto 1').props.checked, false);
  } finally { view.unmount(); }
});

test('batch items are not sent after a session change and a twice-unknown result is reported as uncertain', async () => {
  const service = server({ async write() { throw new AccessError(503); } });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    menu(view, 'Produto 1').props.items.find(item => item.label === 'Inativar').onClick(); await view.flush();
    const dialog = component(view, 'BatchDialog');
    assert.equal(dialog.props.title, 'Inativar cadastro'); assert.equal(dialog.props.description, undefined);
    assert.deepEqual(await dialog.props.run(dialog.props.plan.eligible[0]), { uncertain: true, message: 'Não foi possível confirmar o resultado. Atualize a listagem e confira o cadastro antes de repetir.' });
    service.snapshot.membership = { user_id: '92000000-0000-4000-8000-0000000000dd', role: 'admin' };
    await assert.rejects(dialog.props.run(dialog.props.plan.eligible[0]), /A sessão mudou/);
    assert.equal(service.writes().length, 2, 'no request for the other actor');
  } finally { view.unmount(); }
});

test('row ⋮ menu: Origin items, Clonar produto opens a prefilled new form without saving and Ver estoque reads per depósito', async () => {
  const service = server();
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['StockView', 'NativeListLayout'] });
  try {
    const entries = menu(view, 'Produto 1').props.items;
    assert.deepEqual(entries.map(item => [item.label, Boolean(item.disabled)]), [['Imprimir etiquetas', false], ['Editar', false], ['Clonar produto', false], ['Inativar', false], ['Ver estoque', false]]);
    assert.equal(menu(view, 'Produto 2').props.items.find(item => item.label === 'Ativar').label, 'Ativar');
    entries.find(item => item.label === 'Ver estoque').onClick(); await view.flush();
    assert.equal(service.calls.at(-1).path, `/v1/estoque/saldos?product_id=${items[0].id}`);
    assert.equal(component(view, 'Modal').props.title, 'Estoque — Produto 1');
    assert.match(view.text(), /GeralSem lançamentos/); assert.match(view.text(), /Loja \(inativo\)12,5 UN/);
    entries.find(item => item.label === 'Clonar produto').onClick(); await view.flush();
    assert.equal(service.calls.filter(call => !call.path.includes('/taxonomias/')).at(-1).path, `/v1/cadastros/products/${items[0].id}/completo`, 'the clone reads the complete product (detail of migration 119)');
    const editor = component(view, 'Editor').props;
    assert.equal(editor.record, null); assert.equal(editor.cloneOf, 'Produto 1');
    assert.equal(editor.initialValues.name, 'Produto 1'); assert.equal(editor.initialValues.price, '1.5000'); assert.equal(editor.initialValues.ncm, '73181500'); assert.equal(editor.initialValues.description, 'Descrição fictícia');
    assert.deepEqual([editor.initialValues.code, editor.initialValues.gtin, editor.initialValues.gtin_tax], ['', '', '']);
    assert.equal(service.writes().length, 0, 'nothing is saved until Salvar');
  } finally { view.unmount(); }
  const reader = server({ role: 'consulta' });
  reader.controller.catalog = (original => async (path, options) => path === '/v1/cadastros' ? { read: ['products'], write: [], data_mode: 'erp_native' } : original(path, options))(reader.controller.catalog);
  const readOnly = await mountComponent('RealCatalog.tsx', { controller: reader.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.deepEqual(menu(readOnly, 'Produto 1').props.items.map(item => item.label), ['Imprimir etiquetas', 'Visualizar', 'Ver estoque']);
    assert.throws(() => byAria(readOnly, 'Editar o preço de Produto 1'), 'no pencil without write permission');
  } finally { readOnly.unmount(); }
});

test('inline price edit (green pencil) keeps the command through an unknown result and updates only that row', async () => {
  let attempt = 0;
  const service = server({ async write(path, body) { attempt++; if (attempt === 1) throw new AccessError(503); if (attempt === 3) throw new AccessError(409); return undefined; } });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.equal(byAria(view, 'Editar o preço de Produto 1').props.title, 'Clique para editar o preço do produto');
    assert.throws(() => byAria(view, 'Editar o preço de Produto 2'), 'inactive products keep a read-only price');
    byAria(view, 'Editar o preço de Produto 1').props.onClick(event()); await view.flush();
    assert.equal(view.input('catalog-inline-price').props.value, '1,50');
    await view.change('catalog-inline-price', '1.234,56');
    byAria(view, 'Salvar preço').props.onClick(event()); await view.flush();
    assert.match(view.text(), /sem separador de milhares/); assert.equal(service.writes().length, 0);
    await view.change('catalog-inline-price', '2,75');
    assert.equal(view.guard().changed, true, 'an unsaved price is protected like a form');
    view.input('catalog-inline-price').props.onKeyDown(event({ key: 'Enter' })); await view.flush();
    assert.equal(service.writes().length, 1);
    assert.deepEqual(service.writes()[0].body.data, { price: '2.7500' }); assert.equal(service.writes()[0].body.expected_version, 1);
    assert.equal(view.input('catalog-inline-price').disabled, true); assert.equal(view.guard().busy, true);
    await view.click('Conferir resultado');
    assert.equal(service.writes().length, 2);
    assert.deepEqual(service.writes()[1].body, service.writes()[0].body, 'Conferir resultado repeats the same command');
    assert.match(view.text(), /Preço atualizado\./);
    assert.match(view.text(), /R\$ 2,75/);
    assert.throws(() => view.input('catalog-inline-price'));
    byAria(view, 'Editar o preço de Produto 3').props.onClick(event()); await view.flush();
    await view.change('catalog-inline-price', '9');
    byAria(view, 'Salvar preço').props.onClick(event()); await view.flush();
    assert.match(view.text(), /O produto foi alterado por outra operação/);
    assert.equal(view.input('catalog-inline-price').disabled, false, 'a known conflict releases the edit');
    assert.notEqual(service.writes()[2].body.command_id, service.writes()[0].body.command_id);
    byAria(view, 'Cancelar edição do preço').props.onClick(event()); await view.flush();
    assert.throws(() => view.input('catalog-inline-price'));
    assert.equal(service.lists().length, 1, 'no list reload was needed');
  } finally { view.unmount(); }
});

// The product form reads the complete product (and the taxonomies, answered empty) before showing the fields.
const editorServer = ({ checks = [], saves = [], current = null } = {}) => {
  const calls = [];
  return { calls, writes: () => calls.filter(call => !call.path.includes('/taxonomias/') && call.path !== '/v1/cadastros/campos-customizados'), controller: { getSnapshot:()=>({phase:'ready',membership:{user_id:actor,role:'admin',capabilities:{originIntegration:false,originHistory:false}}}), async catalog(path, options = {}) {
    calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
    const taxonomy = /^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path);
    if (taxonomy) return { kind: { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' }[taxonomy[1]], items: [], data_mode: 'erp_native' };
    if (current && !options.method && path === `/v1/cadastros/products/${current.id}/completo`) return { entity: 'products', record: current, data_mode: 'erp_native' };
    if (path.endsWith('/check')) { const next = checks.shift(); if (next instanceof Error) throw next; return { entity: path.split('/')[3], warnings: next ?? [], data_mode: 'erp_native' }; }
    if (options.method) { const next = saves.shift(); if (next instanceof Error) throw next; return { record: { id: '92000000-0000-4000-8000-0000000000ee' } }; }
    return { record: { id: '92000000-0000-4000-8000-0000000000ee', entity: 'products', version: 1, active: true, name: 'Novo', code: 'QA-1' } };
  } } };
};
const duplicate = { code: 'duplicate_code', field: 'code', total: 2, matches: [{ id: '92000000-0000-4000-8000-000000000001', name: 'Produto 1', code: 'QA-1', active: true }, { id: '92000000-0000-4000-8000-000000000002', name: 'Produto 2', code: 'qa-1', active: false }] };

test('editor: duplicate code warning from the server needs an explicit "Salvar mesmo assim" and is sent as confirmed', async () => {
  const service = editorServer({ checks: [[duplicate], [duplicate]] }), saved = [];
  const view = await mountComponent('ProductEditor.tsx', { controller: service.controller, entity: 'products', record: null, writable: true, onSaved: value => saved.push(value), onClose() {} }, { componentName: 'ProductEditor', expandChildren: ['ProductForm'] });
  try {
    await view.change('catalog-name', 'Novo'); await view.change('catalog-code', 'QA-1');
    await view.submit();
    assert.deepEqual(service.writes().map(call => [call.path, call.method]), [['/v1/cadastros/products/check', 'POST']]);
    assert.equal(service.writes()[0].body.id, null); assert.equal(service.writes()[0].body.data.code, 'QA-1');
    assert.match(view.text(), /O código \(SKU\) informado já está em 2 outros produtos: Produto 1 \(QA-1\); Produto 2 \(qa-1\) — inativo\./);
    assert.equal(saved.length, 0);
    await view.click('Revisar');
    assert.throws(() => view.button('Salvar mesmo assim'));
    await view.submit();
    await view.click('Salvar mesmo assim');
    const save = service.calls.find(call => call.path === '/v1/cadastros/products/completo' && call.method === 'POST');
    assert.deepEqual(save.body.acknowledged_warnings, ['duplicate_code']); assert.equal(save.body.data.code, 'QA-1');
    assert.equal(saved.length, 1);
  } finally { view.unmount(); }
});

test('editor: no warning means a confirmed-empty save; unchanged identifiers skip the check; a new warning after confirmation is shown again', async () => {
  const quiet = editorServer({ checks: [[]] });
  const view = await mountComponent('ProductEditor.tsx', { controller: quiet.controller, entity: 'products', record: null, writable: true, onSaved() {}, onClose() {} }, { componentName: 'ProductEditor', expandChildren: ['ProductForm'] });
  try {
    await view.change('catalog-name', 'Novo'); await view.change('catalog-code', 'QA-9'); await view.submit();
    assert.deepEqual(quiet.writes().map(call => call.path), ['/v1/cadastros/products/check', '/v1/cadastros/products/completo', '/v1/cadastros/products/92000000-0000-4000-8000-0000000000ee']);
    assert.deepEqual(quiet.writes()[1].body.acknowledged_warnings, []);
  } finally { view.unmount(); }
  const record = { id: '92000000-0000-4000-8000-000000000001', entity: 'products', version: 3, active: true, name: 'Produto 1', code: 'QA-1', gtin: '7891234567895', price: '1.5000', source: null };
  const legacy = editorServer({ current: record });
  const edit = await mountComponent('ProductEditor.tsx', { controller: legacy.controller, entity: 'products', record, writable: true, onSaved() {}, onClose() {} }, { componentName: 'ProductEditor', expandChildren: ['ProductForm'] });
  try {
    await edit.change('catalog-name', 'Produto 1 renomeado'); await edit.submit();
    assert.deepEqual(legacy.writes().map(call => [call.path, call.method]), [[`/v1/cadastros/products/${record.id}/completo`, undefined], [`/v1/cadastros/products/${record.id}/completo`, 'PATCH'], ['/v1/cadastros/products/92000000-0000-4000-8000-0000000000ee', undefined]], 'a legacy duplicate code that is not changed is not checked again');
    assert.equal('acknowledged_warnings' in legacy.writes()[1].body, false);
  } finally { edit.unmount(); }
  const gtin = { code: 'duplicate_gtin', field: 'gtin', total: 1, matches: [duplicate.matches[0]] };
  const raced = editorServer({ checks: [[duplicate], [duplicate, gtin]], saves: [new AccessError(409)] });
  const racing = await mountComponent('ProductEditor.tsx', { controller: raced.controller, entity: 'products', record: null, writable: true, onSaved() {}, onClose() {} }, { componentName: 'ProductEditor', expandChildren: ['ProductForm'] });
  try {
    await racing.change('catalog-name', 'Novo'); await racing.change('catalog-code', 'QA-1'); await racing.change('catalog-gtin', '7891234567895'); await racing.submit();
    await racing.click('Salvar mesmo assim');
    assert.match(racing.text(), /Surgiu um novo aviso desde a conferência/);
    assert.match(racing.text(), /O GTIN\/EAN informado já está em 1 outro produto: Produto 1 \(QA-1\)\./);
    assert.equal(raced.calls.filter(call => call.path.endsWith('/check')).length, 2);
  } finally { racing.unmount(); }
});

// The contact form (warnings, checks and refusals) is covered by contacts-ui.test.mjs.
test('another pencil or a situation batch goes through the unsaved-changes guard and discards the open price edit', async () => {
  const service = server();
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    byAria(view, 'Editar o preço de Produto 1').props.onClick(event()); await view.flush();
    await view.change('catalog-inline-price', '9');
    byAria(view, 'Editar o preço de Produto 3').props.onClick(event()); await view.flush();
    assert.equal(view.input('catalog-inline-price').props['aria-label'], 'Preço de venda de Produto 3');
    assert.equal(view.input('catalog-inline-price').props.value, '1,50', 'the other row starts from its stored price');
    await view.change('catalog-inline-price', '8');
    assert.equal(view.guard().changed, true);
    menu(view, 'Produto 1').props.items.find(item => item.label === 'Inativar').onClick(); await view.flush();
    assert.equal(component(view, 'BatchDialog').props.title, 'Inativar cadastro');
    assert.throws(() => view.input('catalog-inline-price'), 'the batch reloads the list, so the unsaved price was confirmed and discarded first');
    assert.equal(service.writes().length, 0);
  } finally { view.unmount(); }
});

test('a late price reply after the list changed is ignored and never rewrites the new page', async () => {
  let release;
  const service = server({ write: () => new Promise(resolve => { release = resolve; }) });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout'] });
  try {
    byAria(view, 'Editar o preço de Produto 1').props.onClick(event()); await view.flush();
    await view.change('catalog-inline-price', '3');
    byAria(view, 'Salvar preço').props.onClick(event()); await view.flush();
    assert.equal(view.guard().busy, true);
    // Products: the first chip is "Situação: Últimos Incluídos" (Origin); removing it changes the list like the order chip did.
    component(view, 'AppliedChips').props.chips[0].onRemove(); await view.flush();
    assert.equal(service.lists().at(-1).path.includes('situation=active'), true, 'the situation changed only after the guarded discard');
    assert.throws(() => view.input('catalog-inline-price'));
    release({ entity: 'products', record: { ...full(items[0]), version: 2, price: '3.0000' }, replayed: false, data_mode: 'erp_native' }); await view.flush();
    assert.doesNotMatch(view.text(), /Preço atualizado/);
    assert.match(view.text(), /R\$ 1,5000/);
    assert.equal(view.guard().busy, false);
  } finally { view.unmount(); }
});
