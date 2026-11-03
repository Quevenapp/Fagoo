import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { readCategoryChoices } from '../src/lib/document-category-model.ts';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { transitionNote } from '../src/lib/document-situations-model.ts';
import { record } from './helpers/document-commercial-fixtures.mjs';

// 202610200168 in the editor: Categoria (pedidos de venda e de compra, OS) and Transportador of the cadastro. No DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000168', sale = 'c1000000-0000-4000-8000-000000000168', child = 'c2000000-0000-4000-8000-000000000168';
const carrier = 'd0000000-0000-4000-8000-000000000168', customer = 'e0000000-0000-4000-8000-000000000168';
const page = { kind: 'sales_orders', category_kind: 'receivable', items: [{ id: sale, name: 'Vendas', parent_id: null, depth: 1 }, { id: child, name: 'Balcão', parent_id: sale, depth: 2 }], total_count: 2, has_more: false, default: { id: sale, name: 'Vendas' }, data_mode: 'erp_native', operational_effects: false };
const node = (view, name, test = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && test(n));

test('the categorias of the seletor are checked before use', () => {
  assert.deepEqual(readCategoryChoices(page).items.map(item => item.depth), [1, 2]);
  assert.throws(() => readCategoryChoices({ ...page, items: [{ ...page.items[0], depth: 0 }] }));
  assert.throws(() => readCategoryChoices({ ...page, default: { id: 'x', name: 'Vendas' } }));
  assert.throws(() => readCategoryChoices({ ...page, items: Array.from({ length: 501 }, () => page.items[0]) }));
});

test('a new pedido de venda saves the Categoria and the Transportador chosen in the form', async () => {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; return { entity: 'contacts', items: [], has_more: false }; },
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/v1/documentos/sales_orders/categorias') return page;
      throw new AccessError(409);
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCategoryPicker'] });
  try {
    await view.flush();
    assert.deepEqual(view.input('doc-category').props.children[2].map(option => option.props.children), ['Vendas', '  Balcão']);
    assert.match(view.text(), /Sem categoria, o Lançar contas usa a categoria padrão \(Vendas\)/);
    await view.change('doc-category', child);
    node(view, 'CatalogPicker', n => n.props.entity === 'contacts' && n.props.label !== 'Transportador').props.onSelect({ id: customer, name: 'Cliente sintético' }); await view.flush();
    const fields = node(view, 'DocumentCommercialFields');
    assert.equal(fields.props.carrier.props.label, 'Transportador');
    // 202610200238 (wave E): the picker searches only contacts of the type Transportador.
    assert.deepEqual(fields.props.carrier.props.contactTools, { role: 'carrier' });
    fields.props.carrier.props.onSelect({ id: carrier, name: 'Transportadora sintética' }); await view.flush();
    assert.equal(node(view, 'DocumentCommercialFields').props.carrierFilled, true);
    await view.change('doc-item-description-0', 'Item livre'); await view.change('doc-item-price-0', '10');
    await view.submit();
    const saved = calls.find(call => call.method === 'POST' && call.path === '/v1/documentos/sales_orders');
    assert.ok(saved, JSON.stringify(calls.map(call => call.path)));
    assert.deepEqual([saved.body.data.category_id, saved.body.data.carrier_id], [child, carrier]);
    await view.change('doc-category', '');
    assert.equal(view.input('doc-category').props.value, '');
  } finally { view.unmount(); }
});

test('propostas have no Categoria; OS have no Transportador; the print names the transportador; the transition note says which categoria', async () => {
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; return { items: [], has_more: false }; },
    async documents() { throw new AccessError(404); }, async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  for (const [kind, category, carrierShown] of [['sales_proposals', false, true], ['service_orders', true, false], ['purchase_orders', true, true]]) {
    const view = await mountComponent('RealDocuments.tsx', { controller, kind, record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} }, { componentName: 'Editor', location: '/documentos-empresa' });
    try {
      assert.equal(Boolean(node(view, 'DocumentCategoryPicker')), category, kind);
      assert.equal(Boolean(node(view, 'DocumentCommercialFields').props.carrier), carrierShown, kind);
    } finally { view.unmount(); }
  }
  const saved = { ...record('sales_orders'), carrier_id: carrier, carrier_name: 'Transportadora sintética' };
  assert.equal(documentPrintModel(saved).commercial.transport.carrier, 'Transportadora sintética');
  assert.match(transitionNote(['post_finance']), /categoria do documento \(ou a padrão\)/);
});

test('Preferências › Vendas "Título" and "Seção auxiliar" of the printed pedido', async () => {
  const { defaultDocumentPreferences, documentPreferences } = await import('../src/lib/document-preferences.ts');
  const saved = { ...record('sales_orders'), customer_po_number: 'OC-77' };
  const standard = documentPrintModel(saved, null, { prefs: defaultDocumentPreferences('sales_orders').print });
  assert.deepEqual([standard.titleNumber, standard.auxiliary], [true, null], 'by default the title carries the number and there is no auxiliary section');
  const view = { page: 'vendas-vendas', items: [{ key: 'vendas.imprimir_titulo', value: [] }, { key: 'vendas.imprimir_secao_auxiliar', value: ['ordem_compra'] }] };
  const prefs = documentPreferences('sales_orders', view, null).print;
  const custom = documentPrintModel(saved, null, { prefs });
  assert.deepEqual([custom.titleNumber, custom.auxiliary], [false, 'Nº da ordem de compra: OC-77']);
});
