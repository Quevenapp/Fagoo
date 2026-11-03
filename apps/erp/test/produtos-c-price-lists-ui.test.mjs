import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { listSheetRows, priceListData, EMPTY } from '../src/lib/price-list-model.ts';

// Listas de preços, onda C (migração 154) na interface: assistente, "Vincular a uma lista", Vendedor/Forma de pagamento,
// carga incremental, exportação e impressão das listas. Synthetic data only.
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
const ids = { list: '95000000-0000-4000-8000-0000000000f1', p1: '95000000-0000-4000-8000-000000000001', p2: '95000000-0000-4000-8000-000000000002', seller: '95000000-0000-4000-8000-0000000000bb', method: '95000000-0000-4000-8000-0000000000cc' };
const header = extra => ({ id: ids.list, name: 'Atacado', category: 'other', list_type: 'rates', factor: '10.0000', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: null, ends_on: null, start_time: null, end_time: null,
  version: 4, created_at: stamp, updated_at: stamp, rule: 'Desconto 10 %', products: 150, contacts: [], sellers: [], payment_methods: [], regions: [], ...extra });
const item = (n) => ({ product_id: `95000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`, name: `Produto ${n}`, code: `P${n}`, gtin: null, product_price: '10.0000', custom_price: null, list_price: '9.00' });

test('model: Dados gerais with the new links and the products of the selection; the spreadsheet rows', () => {
  const draft = { ...EMPTY, name: 'Vendedores', category: 'seller', factor: '5', sellers: [{ id: ids.seller, name: 'Vendedora' }], contacts: [{ id: ids.p1, name: 'x' }] };
  const data = priceListData(draft, [ids.p1]);
  assert.deepEqual([data.sellers, data.contacts, data.payment_methods, data.add_products], [[ids.seller], [], [], [ids.p1]]);
  assert.equal(Object.hasOwn(priceListData(draft), 'add_products'), false);
  const rows = listSheetRows([{ list: header(), items: [item(1)] }]);
  assert.deepEqual(rows[0].map(cell => cell.text), ['Lista de preço', 'Tipo de lista', 'Regra da lista', 'Data de validade', 'Produto', 'Código (SKU)', 'GTIN/EAN', 'Preço de venda', 'Preço da lista']);
  assert.deepEqual(rows[1].slice(7), [{ number: '10.0000' }, { number: '9.00' }], 'prices stay exact decimals');
});

function productServer({ items = async () => ({ saved: true, list: header({ version: 5, products: 152 }), data_mode: 'erp_native' }) } = {}) {
  const calls = [];
  const rows = [ids.p1, ids.p2].map((id, n) => ({ id, entity: 'products', version: 2, active: true, name: `Produto ${n + 1}`, code: `P${n + 1}`, unit: 'UN', price: '10.0000', kind: 'P', format: 'S', created_at: stamp, updated_at: stamp, source: null,
    stock: null, stock_min: null, stock_max: null, thumbnail: null, deleted: false, cost_price: null, location: null, category_id: null, expiry_date: null }));
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }), subscribe: () => () => undefined,
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products', 'contacts'], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/taxonomias/')) return { kind: { 'categorias-produtos': 'categories', 'grupos-tags': 'tag_groups', tags: 'tags' }[path.split('/').at(-1)], items: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) return { entity: 'products', items: rows, page: 1, size: 100, total: 2, sort: 'created_desc', stock_visible: false, data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos' && !options.method) return { items: [header()], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos' && options.method === 'POST') return { saved: true, list: header({ id: ids.list, name: options.body.data.name, products: options.body.data.add_products.length, version: 1 }), data_mode: 'erp_native' };
      if (path === `/v1/cadastros/listas-precos/${ids.list}/itens`) return items(options.body);
      throw new AccessError(404);
    },
    async listPreferences() { return { scope: 'list_preferences', data_mode: 'erp_native', list_id: 'cadastros.produtos', version: 0, columns: null, filters: null, updated_at: null }; },
    async preferences() { return { items: [] }; },
  };
  return { calls, controller, writes: () => calls.filter(call => call.method) };
}

test('product list: "Criar lista de preço" opens the assistant with the selection; "Vincular a uma lista" adds them with the list version', async () => {
  let attempt = 0;
  const service = productServer({ items: async () => { attempt++; if (attempt === 1) throw new AccessError(503); return { saved: true, list: header({ version: 5, products: 152 }), data_mode: 'erp_native' }; } });
  const view = await mountComponent('RealCatalog.tsx', { controller: service.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'PriceListWizard', 'LinkToPriceList', 'Modal', 'PriceListLinks'] });
  try {
    assert.equal(view.button('Vincular a uma lista').disabled, true, 'needs a selection');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Produto 1').props.onClick({ shiftKey: false }); await view.flush();
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Produto 2').props.onClick({ shiftKey: false }); await view.flush();
    await view.click('Criar lista de preço');
    assert.match(view.text(), /Criando lista de preços a partir da seleção de 2 produto\(s\)\./);
    await view.click('Avançar'); await view.click('Avançar');
    await view.change('price-list-wizard-factor', '10'); await view.click('Avançar');
    await view.change('price-list-wizard-name', 'Seleção'); await view.click('Avançar');
    assert.match(view.text(), /Produtos2/);
    await view.click('Salvar');
    const created = service.writes().at(-1);
    assert.deepEqual([created.body.data.name, created.body.data.list_type, created.body.data.factor, created.body.data.add_products], ['Seleção', 'rates', '10', [ids.p1, ids.p2]]);
    assert.match(view.text(), /Lista de preços “Seleção” criada com 2 produto\(s\)/);
    await view.click('Vincular a uma lista');
    await view.change('price-list-link', ids.list);
    await view.click('Vincular');
    const first = service.writes().at(-1);
    assert.deepEqual([first.path, first.body.expected_version, first.body.change], [`/v1/cadastros/listas-precos/${ids.list}/itens`, 4, { add: [ids.p1, ids.p2] }], 'the selection stays after the new list');
    assert.equal(view.guard().changed, true, 'an unconfirmed link is protected');
    await view.click('Conferir resultado');
    assert.equal(service.writes().at(-1).body.command_id, first.body.command_id, 'the same command is repeated');
    assert.match(view.text(), /Produtos vinculados à lista “Atacado” \(152 produto\(s\) na lista\)/);
  } finally { view.unmount(); }
});

function listsServer() {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'admin' } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method, body: options.body && structuredClone(options.body) });
      if (path === '/v1/cadastros') return { read: ['products', 'contacts'], write: ['products'], data_mode: 'erp_native' };
      if (path === '/v1/cadastros/listas-precos' || path.startsWith('/v1/cadastros/listas-precos?')) return { items: [header(), header({ id: '95000000-0000-4000-8000-0000000000f2', name: 'Varejo', products: 1 })], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/products?')) return { entity: 'products', items: [{ id: ids.p1, entity: 'products', name: 'Parafuso', code: 'P1' }], has_more: false, next_cursor: null, limit: 10, data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return { scope: 'seller_options', users: [], items: [{ id: ids.seller, name: 'Vendedora', code: null }], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/formas-pagamento')) return { items: [{ id: ids.method, description: 'Boleto' }], data_mode: 'erp_native' };
      const detail = /^\/v1\/cadastros\/listas-precos\/([^/?]+)\?(.*)$/.exec(path);
      if (detail) { const params = new URLSearchParams(detail[2]), offset = Number(params.get('offset') ?? 0), total = detail[1] === ids.list ? 150 : 1;
        return { list: header(detail[1] === ids.list ? {} : { id: detail[1], name: 'Varejo', products: 1 }), items: Array.from({ length: Math.max(0, Math.min(100, total - offset)) }, (_, n) => item(offset + n)), total, offset, limit: 100, data_mode: 'erp_native' }; }
      if (options.method === 'PATCH') return { saved: true, list: header({ version: 5, category: options.body.data.category, sellers: [{ id: ids.seller, name: 'Vendedora' }] }), data_mode: 'erp_native' };
      throw new AccessError(404);
    },
  };
  return { calls, controller };
}

test('price lists: filter (Categoria, Produto), Imprimir, export of the selected lists and the editor with sellers and incremental loading', async () => {
  const service = listsServer();
  const view = await mountComponent('PriceLists.tsx', { controller: service.controller }, { location: '/listas-precos', expandChildren: ['PriceListEditor', 'PriceListLinks', 'ExportLists', 'Modal', 'PrintSheet'] });
  try {
    view.find(node => node.type === 'button' && node.props['aria-label'] === 'Abrir filtro').props.onClick(); await view.flush();
    await view.change('price-list-category', 'seller');
    await view.change('price-list-product-filter', 'paraf');
    await new Promise(resolve => setTimeout(resolve, 300)); await view.flush();
    view.find(node => node.type === 'button' && node.props.role === 'option').props.onClick(); await view.flush();
    await view.click('Filtrar');
    assert.equal(service.calls.filter(call => call.path.startsWith('/v1/cadastros/listas-precos?')).at(-1).path, `/v1/cadastros/listas-precos?categoria=seller&produto=${ids.p1}`);
    assert.deepEqual(view.find(node => node.type?.name === 'AppliedChips').props.chips.map(chip => chip.label), ['Categoria: Vendedor', 'Produto: Parafuso']);
    view.find(node => node.type?.name === 'ToolButton' && node.props.title === 'Imprimir').props.onClick(); await view.flush();
    assert.match(view.text(), /Listas de preços · 2 registros/); assert.match(view.text(), /Categoria: Vendedor/);
    await view.click('Fechar');
    view.find(node => node.type === 'input' && node.props['aria-label'] === 'Selecionar Atacado').props.onChange({ target: { checked: true } }); await view.flush();
    await view.click('Exportar dados para planilha');
    await view.change('price-list-export-format', 'xlsx');
    await view.click('Exportar');
    assert.ok(downloads.at(-1).endsWith('.xlsx'));
    assert.deepEqual(service.calls.filter(call => call.path.startsWith(`/v1/cadastros/listas-precos/${ids.list}?`)).map(call => new URLSearchParams(call.path.split('?')[1]).get('offset')), ['0', '100'], 'every product of the list, 100 at a time');
    await view.click('Fechar');
    view.find(node => node.type === 'button' && node.props.className === 'text-button record-link' && node.props.children === 'Atacado').props.onClick(); await view.flush();
    assert.match(view.text(), /Exibindo 100 de 150 produtos/);
    assert.equal(view.button('Salvar').disabled, true, 'Salvar is enabled after a change');
    await view.click('Carregar mais produtos');
    assert.doesNotMatch(view.text(), /Exibindo/); assert.match(view.text(), /Produto 149/);
    await view.change('price-list-category-field', 'seller');
    view.find(node => node.type?.name === 'SellerPicker').props.onChange({ id: ids.seller, name: 'Vendedora', code: null }); await view.flush();
    await view.submit();
    const patch = service.calls.filter(call => call.method === 'PATCH').at(-1);
    assert.deepEqual([patch.body.expected_version, patch.body.data.category, patch.body.data.sellers], [4, 'seller', [ids.seller]]);
  } finally { view.unmount(); }
});
