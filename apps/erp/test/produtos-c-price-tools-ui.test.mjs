import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';

// Ferramentas de preço (migração 155) na interface: reajuste de preços da listagem com "Novo Preço", "Atualizar preços" da
// Formação de preços e os preços de compra no pedido de compra. Synthetic data only.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const actor = '95000000-0000-4000-8000-0000000000aa', stamp = '2026-10-20T12:00:00+00:00';
const ids = { a: '95000000-0000-4000-8000-000000000001', b: '95000000-0000-4000-8000-000000000002', supplier: '95000000-0000-4000-8000-0000000000bb', other: '95000000-0000-4000-8000-0000000000cc' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

test('product list: Reajuste de preços shows Novo Preço from the database and applies to the selected products with "Conferir resultado"', async () => {
  const calls = []; let attempt = 0;
  const rows = [ids.a, ids.b].map((id, n) => ({ id, entity: 'products', version: 3 + n, active: true, name: n ? 'Porca' : 'Parafuso', code: null, unit: 'UN', price: n ? '4.0000' : '10.0000', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null,
    stock: null, stock_min: null, stock_max: null, thumbnail: null, deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }));
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'categorias-produtos': 'categories', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) return { entity: 'products', items: rows, page: 1, size: 100, total: 2, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/reajuste/previa') return { entity: 'products', items: [{ id: ids.a, price: '10.0000', status: 'ok', new_price: '11.0000' }, { id: ids.b, price: '4.0000', status: 'ok', new_price: '4.4000' }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/reajuste') { attempt++; if (attempt === 1) throw new AccessError(503); return { entity: 'products', total: 1, applied: 1, unchanged: 0, skipped_total: 0, skipped: [], rule: options.body.rule, replayed: true, data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return { items: [] }; },
  };
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'PriceAdjustmentBar', 'Modal', 'NewPriceCell'] });
  try {
    await view.click('Reajuste e sincronização de preços');
    assert.match(view.text(), /Reajuste de preços/); assert.match(view.text(), /Produtos filtrados\(2\)/);
    await view.change('price-adjust-value', '10'); await wait(350); await view.flush();
    assert.ok(view.nodes().some(node => node.type === 'th' && textOf(node.props.children) === 'Novo Preço'));
    assert.match(view.text(), /R\$ 11,00/); assert.match(view.text(), /R\$ 4,40/);
    assert.deepEqual(calls.filter(call => call.path === '/v1/cadastros/products/reajuste/previa').at(-1).body, { rule: { action: 'increase', unit: 'percent', value: '10' }, ids: [ids.a, ids.b] });
    view.find(node => node.type === 'button' && node.props.title === 'Clique aqui para trocar a unidade do valor').props.onClick(); await view.flush();
    view.find(node => node.type === 'button' && node.props.title === 'Clique aqui para trocar a unidade do valor').props.onClick(); await view.flush();
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Parafuso').props.onClick({ shiftKey: false }); await view.flush();
    view.nodes().filter(node => node.type === 'input' && node.props.name === 'price-adjust-target')[1].props.onChange(); await view.flush();
    await view.click('Atualizar produtos');
    assert.match(view.text(), /Acrescer 10% no preço de venda de 1 produto\(s\) selecionado\(s\)/);
    const buttons = view.nodes().filter(node => node.type === 'button' && textOf(node.props.children) === 'Atualizar produtos');
    buttons.at(-1).props.onClick(); await view.flush();
    const first = calls.filter(call => call.path === '/v1/cadastros/products/reajuste').at(-1);
    assert.deepEqual([first.body.items, first.body.rule], [[{ id: ids.a, expected_version: 3 }], { action: 'increase', unit: 'percent', value: '10' }]);
    assert.match(view.text(), /Conferir resultado/);
    await view.click('Conferir resultado');
    assert.equal(calls.filter(call => call.path === '/v1/cadastros/products/reajuste').at(-1).body.command_id, first.body.command_id);
    assert.match(view.text(), /Reajuste de preços \(comando já registrado\): 1 produto\(s\) atualizado\(s\)/);
  } finally { view.unmount(); }
});

test('Formação de preços: "Atualizar preços" reads the versions and sends sale and cost price of the note supplier in one command', async () => {
  const calls = []; let write = ['products'];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products'], write, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products/compras?')) return { entity: 'products', supplier_id: ids.supplier, mode: 'last_purchase', items: [{ product_id: ids.a, version: 7, name: 'Parafuso', code: null, price: '10.0000', deleted: false, default_supplier: null, supplier: null, last_purchase_price: null, suggested_price: null }], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/products/precos') return { entity: 'products', supplier_id: ids.supplier, items: [{ product_id: ids.a, version: 8, price: '15.0000', cost_price: '10.0000' }], replayed: false, data_mode: 'erp_native' };
      throw new AccessError(404);
    },
  };
  const lines = [{ product_id: ids.a, description: 'Parafuso', cost: '10.0000', sale: '15.0000' }, { product_id: null, description: 'Item livre', cost: '1.0000', sale: '2.0000' }, { product_id: ids.a, description: 'Parafuso de novo', cost: '9.0000', sale: '14.0000' }];
  const view = await mountComponent('ProductPriceUpdate.tsx', { controller, supplierId: ids.supplier, lines }, { componentName: 'UpdatePricesButton', expandChildren: ['Modal'] });
  try {
    await view.click('Atualizar preços');
    assert.match(view.text(), /preço de venda de 1 produto\(s\) e o preço de custo no fornecedor da nota/); assert.match(view.text(), /1 linha\(s\) a mais ignorada\(s\)/);
    const buttons = view.nodes().filter(node => node.type === 'button' && textOf(node.props.children) === 'Atualizar preços');
    buttons.at(-1).props.onClick(); await view.flush(); await view.flush();
    assert.equal(calls.find(call => call.path.startsWith('/v1/cadastros/products/compras?')).path, `/v1/cadastros/products/compras?ids=${ids.a}&fornecedor=${ids.supplier}`);
    const sent = calls.find(call => call.path === '/v1/cadastros/products/precos');
    assert.deepEqual([sent.body.supplier_id, sent.body.items], [ids.supplier, [{ product_id: ids.a, expected_version: 7, price: '15.0000', cost_price: '10.0000' }]]);
    assert.match(view.text(), /Preços atualizados em 1 produto\(s\)/);
  } finally { view.unmount(); }
  write = [];
  const readOnly = await mountComponent('ProductPriceUpdate.tsx', { controller, supplierId: ids.supplier, lines }, { componentName: 'UpdatePricesButton' });
  try { assert.equal(readOnly.button('Atualizar preços').disabled, true); assert.equal(readOnly.button('Atualizar preços').props.title, 'Seu perfil não altera o cadastro de produtos.'); } finally { readOnly.unmount(); }
});

test('purchase order: the suggested price on inclusion, the default supplier question and the prices of a new supplier', async () => {
  const previous = globalThis.document; globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {} };
  const calls = [], saved = [];
  const info = supplier => ({ product_id: ids.a, version: 2, name: 'Parafuso', code: 'P1', price: '20.0000', deleted: false, default_supplier: { id: ids.supplier, name: 'Fornecedor padrão' },
    supplier: supplier === ids.other ? { id: ids.other, code: 'X', description: null, purchase_price: '6.5000', cost_price: '7.0000' } : null, last_purchase_price: '8.2500', suggested_price: '8.2500' });
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method });
      if (path === '/v1/cadastros') return { read: ['contacts', 'products', 'warehouses'], write: ['contacts'], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products/compras?')) { const params = new URLSearchParams(path.split('?')[1]); return { entity: 'products', supplier_id: params.get('fornecedor'), mode: 'last_purchase', items: [info(params.get('fornecedor'))], data_mode: 'erp_native' }; }
      throw new AccessError(404);
    },
    async documents(path, options = {}) { saved.push({ path, options }); throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'purchase_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} }, { componentName: 'Editor', expandChildren: ['Modal'] });
  try {
    const picker = entity => view.nodes().find(node => node.type?.name === 'CatalogPicker' && node.props.entity === entity);
    picker('products').props.onSelect({ id: ids.a, entity: 'products', version: 2, active: true, name: 'Parafuso', code: 'P1', gtin: null, unit: 'UN', kind: 'P', price: '20.0000', source: null });
    await view.flush(); await view.flush();
    assert.equal(view.find(node => node.type === 'input' && node.props['aria-label'] === 'Preço do item 1').props.value, '8,25', 'the last purchase, not the sale price');
    assert.match(view.text(), /O fornecedor padrão desse produto é: Fornecedor padrão/);
    await view.click('Sim, inserir');
    assert.deepEqual(picker('contacts').props.selected, { id: ids.supplier, name: 'Fornecedor padrão' });
    picker('contacts').props.onSelect({ id: ids.other, name: 'Outro fornecedor' }); await view.flush();
    assert.match(view.text(), /Alterar os preços de compra dos itens de acordo com o novo fornecedor selecionado\?/);
    await view.click('Sim, alterar'); await view.flush();
    assert.equal(view.find(node => node.type === 'input' && node.props['aria-label'] === 'Preço do item 1').props.value, '6,5', 'the purchase price of the new supplier');
    assert.match(view.text(), /1 preço\(s\) de compra alterado\(s\) conforme o fornecedor Outro fornecedor/);
    assert.equal(calls.filter(call => call.path.startsWith('/v1/cadastros/products/compras?')).at(-1).path, `/v1/cadastros/products/compras?ids=${ids.a}&fornecedor=${ids.other}`);
  } finally { view.unmount(); globalThis.document = previous; }
});
