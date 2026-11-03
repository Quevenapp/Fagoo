import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { bagQuantity, readSalesBag, salesBagDraft } from '../src/lib/sales-bag-model.ts';

// 202610200197 Sacola de vendas: toolbar counter, "Quantidade a adicionar:" of the row, the drawer and "Gerar pedido de venda".
// Synthetic controller; no DOM, no network.
globalThis.document ??= { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
const actor = '97000000-0000-4000-8000-0000000000aa', product = '97000000-0000-4000-8000-000000000001', other = '97000000-0000-4000-8000-000000000002';
const row = (id, name) => ({ id, entity: 'products', version: 1, active: true, name, code: 'QA-1', created_at: '2026-10-19T12:00:00+00:00', updated_at: '2026-10-19T12:00:00+00:00', source: null, unit: 'UN', price: '1.5000', kind: 'P', format: 'S', stock: { state: 'no_movements', quantity: null, warehouse: null } });
const bagItem = (id, quantity, extra = {}) => ({ product_id: id, name: id === product ? 'Produto um' : 'Produto dois', code: 'QA-1', unit: 'UN', price: '1.5000', quantity, active: true, kind: 'P', ...extra });
function server({ role = 'vendas', fail = null } = {}) {
  const posts = [];let items = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role } }),
    async catalog(path) {
      if (path === '/v1/cadastros') return { read: ['products'], write: [], data_mode: 'erp_native' };
      if (path.includes('/taxonomias/') || path === '/v1/cadastros/campos-customizados') return { items: [], data_mode: 'erp_native' };
      const params = new URLSearchParams(path.split('?')[1]);
      return { entity: 'products', items: [row(product, 'Produto um'), row(other, 'Produto dois')], page: Number(params.get('page')), size: 100, total: 2, sort: 'created_desc', stock_visible: true, data_mode: 'erp_native' };
    },
    async stockPositions() { return { items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
    async documents(path, options = {}) {
      assert.equal(path, '/v1/documentos/sacola-vendas');
      if (role !== 'vendas' && role !== 'admin') throw new AccessError(403);
      if (options.method === 'POST') {
        posts.push(structuredClone(options.body)); const failure = fail?.(posts.length); if (failure) throw failure;
        const body = options.body;
        if (body.action === 'add') { const found = items.find(i => i.product_id === body.product_id); items = found ? items.map(i => i === found ? { ...i, quantity: (Number(i.quantity) + Number(body.quantity)).toFixed(6) } : i) : [...items, bagItem(body.product_id, Number(body.quantity).toFixed(6))]; }
        if (body.action === 'set') items = items.map(i => i.product_id === body.product_id ? { ...i, quantity: Number(body.quantity).toFixed(6) } : i);
        if (body.action === 'remove') items = items.filter(i => i.product_id !== body.product_id);
        if (body.action === 'clear') items = [];
        return { items, count: items.length, limit: 250, action: body.action, product_id: body.product_id ?? null, replayed: false, data_mode: 'erp_native', operational_effects: false };
      }
      return { items, count: items.length, limit: 250, data_mode: 'erp_native', operational_effects: false };
    },
  };
  return { controller, posts, items: () => items };
}
const settle = async view => { for (let i = 0; i < 4; i += 1) { await new Promise(resolve => setTimeout(resolve, 10)); await view.flush(); } };
const mount = s => mountComponent('RealCatalog.tsx', { controller: s.controller, initialEntity: 'products' }, { expandChildren: ['NativeListLayout', 'SalesBagButton', 'SalesBagRowAdd', 'SalesBagDrawer', 'Modal'] });
const byLabel = (view, label) => view.find(node => node.type === 'button' && node.props['aria-label'] === label);

test('bag model: quantities as the documents take them and the pedido made from the bag', () => {
  assert.equal(bagQuantity('1,5'), '1.5'); assert.equal(bagQuantity('0'), null); assert.equal(bagQuantity('1.1234567'), null); assert.equal(bagQuantity('1000000000'), null);
  const bag = readSalesBag({ items: [bagItem(product, '2.000000'), bagItem(other, '1.000000', { active: false })], count: 2, limit: 250 });
  const draft = salesBagDraft(bag, '2026-10-20');
  assert.deepEqual(draft.data.items.map(i => [i.product_id, i.quantity, i.unit_price, i.list_price]), [[product, '2', '1.5', '1.5']]);
  assert.equal(draft.sales_bag, true); assert.match(draft.notices.join(' '), /1 produto\(s\) inativo\(s\) da sacola ficaram de fora/);
});

test('vendas: add from the row, edit and remove in the drawer, Gerar pedido de venda opens the pedido', async () => {
  const s = server(), view = await mount(s);
  try {
    await settle(view);
    assert.equal(byLabel(view, 'Sacola de vendas: 0 produto(s)').type, 'button');
    byLabel(view, 'Adicionar Produto um à sacola de vendas').props.onClick({ stopPropagation() {} }); await view.flush();
    assert.match(view.text(), /Quantidade a adicionar:/);
    await view.change(`sales-bag-quantity-${product}`, '2,5'); await view.click('Adicionar'); await settle(view);
    assert.deepEqual(s.posts[0], { command_id: s.posts[0].command_id, action: 'add', product_id: product, quantity: '2.5' });
    assert.ok(byLabel(view, 'Sacola de vendas: 1 produto(s)'));
    byLabel(view, 'Sacola de vendas: 1 produto(s)').props.onClick(); await view.flush();
    assert.match(view.text(), /Sacola de vendasProdutoQuantidadeAções/);
    const input = view.input(`sales-bag-set-${product}`); input.props.onChange({ target: { value: '4' } }); await view.flush(); view.input(`sales-bag-set-${product}`).props.onBlur(); await settle(view);
    assert.deepEqual([s.posts[1].action, s.posts[1].quantity], ['set', '4']);
    await view.click('Gerar pedido de venda'); await view.flush();
    assert.equal(view.location().search, '?tipo=sales_orders&acao=sacola');
  } finally { view.unmount(); }
});

test('a lost answer keeps the same command until Conferir resultado; profiles without pedidos de venda see no bag', async () => {
  const s = server({ fail: n => n === 1 ? new AccessError(503) : null }), view = await mount(s);
  try {
    await settle(view);
    byLabel(view, 'Adicionar Produto dois à sacola de vendas').props.onClick({ stopPropagation() {} }); await view.flush();
    await view.click('Adicionar'); await settle(view);
    byLabel(view, 'Sacola de vendas: 0 produto(s)').props.onClick(); await view.flush();
    assert.match(view.text(), /Use “Conferir resultado”/);
    await view.click('Conferir resultado'); await settle(view);
    assert.equal(s.posts.length, 2); assert.deepEqual(s.posts[0], s.posts[1], 'the same command is repeated');
    assert.equal(s.items().length, 1);
  } finally { view.unmount(); }
  const closed = server({ role: 'estoque' }), list = await mount(closed);
  try { await settle(list); assert.equal(list.nodes().some(node => node.type === 'button' && /Sacola de vendas/.test(node.props['aria-label'] ?? '')), false); }
  finally { list.unmount(); }
});

test('acao=sacola opens a new pedido with the products of the bag; saving it empties the bag', async () => {
  const { normalizeDocument } = await import('../../../packages/erp-domain/src/index.mjs');
  const contact = '97000000-0000-4000-8000-000000000009', saved = '97000000-0000-4000-8000-000000000010';
  const posts = [], bagPosts = [];let doc = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }),
    async catalog() { return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; },
    async documents(path, options = {}) {
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native', operational_effects: false };
      if (path === '/v1/documentos/sacola-vendas') { if (options.method) { bagPosts.push(options.body); return { items: [], count: 0, limit: 250, action: 'clear', product_id: null, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
        return { items: [bagItem(product, '3.000000')], count: 1, limit: 250, data_mode: 'erp_native', operational_effects: false }; }
      if (options.method === 'POST') { posts.push(structuredClone(options.body)); doc = { ...normalizeDocument('sales_orders', options.body.data), id: saved, kind: 'sales_orders', number: '5', version: 1, status: 'open', contact_snapshot: { id: contact, name: 'Cliente' }, source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
        doc.items = doc.items.map(item => ({ ...item, id: item.id ?? '97000000-0000-4000-8000-000000000011', product_snapshot: null })); return { kind: 'sales_orders', document: doc, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      if (path === `/v1/documentos/sales_orders/${saved}`) return { kind: 'sales_orders', document: doc, data_mode: 'erp_native', operational_effects: false };
      if (path.includes('?')) return { kind: 'sales_orders', items: [], limit: 25, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=sacola', expandChildren: ['Editor'] });
  try {
    await settle(view);
    assert.match(view.text(), /Pedido montado com 1 item\(ns\) da sacola de vendas/);
    const picker = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === 'contacts');
    picker.props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    await view.submit(); await settle(view);
    assert.deepEqual(posts[0].data.items.map(i => [i.product_id, i.quantity, i.unit_price]), [[product, '3', '1.5']]);
    assert.equal(bagPosts.length, 1); assert.equal(bagPosts[0].action, 'clear');
    assert.match(view.text(), /Sacola de vendas esvaziada\./);
  } finally { view.unmount(); }
});
