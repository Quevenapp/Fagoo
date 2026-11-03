import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { crossDockedDate, priceDecimalsProblem, sellerProblem } from '../src/lib/document-seller-rules.ts';
import { stockLaunchDay } from '../src/lib/document-stock-model.ts';
import { documentListQuery, EMPTY_LIST_FILTERS } from '../src/lib/document-list-model.ts';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';

// 202610200164 in the editor and the list: vendedor nativo, regras do vendedor, casas decimais, Cross-Docking, data do
// lançamento de estoque e o depósito padrão. No DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000164', seller = 'f0000000-0000-4000-8000-000000000164', warehouse = 'e0000000-0000-4000-8000-000000000164';
const settings = { price_decimals_out: 2, price_decimals_in: 10, cross_docking_days: 2, occurrence_date_editable: false, stock_launch_date: 'data_documento', auto_products: { sales: true, purchases: false, services: false }, default_warehouse: { id: warehouse, name: 'Depósito padrão' } };
const mySeller = { id: seller, name: 'Vendedora sintética', allow_unregistered_products: false, view_stock: false, discount_limit: '5.0000' };
const totals = (gross, line, discount) => ({ items: [], gross, line_discount: line, subtotal: gross, discount, freight: '0.00', other_expenses: '0.00', total: gross });

test('rules of the editor mirror the server', () => {
  const items = [{ product_id: null, unit_price: '10.123' }, { product_id: 'p', unit_price: '10.10', discount_percent: '6' }];
  assert.deepEqual(priceDecimalsProblem('sales_orders', { items }, settings)?.invalid, ['doc-item-price-0']);
  assert.equal(priceDecimalsProblem('purchase_orders', { items }, settings), null);
  assert.match(sellerProblem('sales_orders', { items }, totals('20.00', '0.60', '0.00'), mySeller).message, /não permite incluir produtos não cadastrados/);
  assert.deepEqual(sellerProblem('sales_proposals', { items }, totals('20.00', '0.60', '0.00'), mySeller).invalid, ['doc-item-discount-1']);
  assert.equal(sellerProblem('sales_proposals', { items: [{ ...items[1], discount_percent: '0' }] }, totals('100.00', '0.00', '5.00'), mySeller), null);
  assert.ok(sellerProblem('sales_proposals', { items: [{ ...items[1], discount_percent: '0' }] }, totals('100.00', '0.00', '5.01'), mySeller));
  assert.equal(crossDockedDate('2026-10-20', '3', 2), '2026-10-25');
  assert.equal(crossDockedDate('2026-10-20', 'x', 2), null);
  assert.equal(stockLaunchDay('data_documento', { kind: 'sales_orders', date: '2026-10-01', ship_date: '2026-10-05' }, '2026-10-20'), '2026-10-05');
  assert.equal(stockLaunchDay('data_documento', { kind: 'purchase_orders', date: '2026-10-01', expected_date: '2026-11-05' }, '2026-10-20'), '2026-10-20', 'a future date becomes today');
  assert.equal(stockLaunchDay('data_atual', { kind: 'sales_orders', date: '2026-10-01' }, '2026-10-20'), '2026-10-20');
  const params = documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, seller: { id: seller, name: 'X' } });
  assert.equal(params.get('seller_id'), seller);
  assert.throws(() => documentListQuery('purchase_orders', { ...EMPTY_LIST_FILTERS, seller: { id: seller, name: 'X' } }));
});

function setup() {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' };
      if (path.startsWith('/v1/cadastros/vendedores/opcoes')) return { scope: 'seller_options', users: [], data_mode: 'erp_native', items: [{ id: seller, name: 'Vendedora sintética', code: 'V1' }] };
      return { entity: 'products', items: [], has_more: false };
    },
    async documents(path, options = {}) { calls.push({ path, method: options.method ?? 'GET', body: options.body }); throw new AccessError(404); },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, calls };
}

test('a new pedido starts with the vendedor of the user and the depósito padrão; Vendedor obrigatório and the vendedor rules block the save', async () => {
  const s = setup(), prefs = { ...defaultDocumentPreferences('sales_orders'), sellerRequired: true };
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {}, preferences: prefs,
    access: { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native', operational_effects: false, settings, seller: mySeller } }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentSellerPicker'] });
  try {
    assert.match(view.text(), /Vendedor \*/);
    assert.match(view.text(), /Vendedora sintética/);
    assert.match(view.text(), /Limite de desconto do vendedor: 5%/);
    assert.equal(view.nodes().some(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === 'warehouses' && n.props.selected?.name === 'Depósito padrão'), false, 'depósitos are not read by this profile');
    // Removing the vendedor makes the required message appear on save.
    view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'CatalogPicker' && n.props.entity === 'contacts').props.onSelect({ id: 'c0000000-0000-4000-8000-000000000164', name: 'Cliente sintético' }); await view.flush();
    await view.change('doc-item-description-0', 'Item livre'); await view.change('doc-item-price-0', '10');
    await view.submit();
    assert.match(view.text(), /não permite incluir produtos não cadastrados/, 'the vendedor rule comes first while the vendedor is set');
    await view.click('Trocar');
    await view.submit();
    assert.match(view.text(), /O campo Vendedor é obrigatório./);
    assert.equal(s.calls.some(call => call.method === 'POST'), false);
  } finally { view.unmount(); }
});
