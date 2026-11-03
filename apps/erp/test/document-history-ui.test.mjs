import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { historyPath, readHistory } from '../src/lib/document-history-model.ts';
import { itemStockView, stockUnits, unitsText } from '../src/lib/document-item-stock-model.ts';
import { record, input, contact } from './helpers/document-commercial-fixtures.mjs';

// 202610200169 histories and "Todos os depósitos" in the document forms. No DOM, no network.
const actor = 'a0000000-0000-4000-8000-000000000169', product = 'f0000000-0000-4000-8000-000000000169', warehouse = 'e1000000-0000-4000-8000-000000000169', other = 'e2000000-0000-4000-8000-000000000169';
const line = (extra = {}) => ({ type: 'sale', document_id: 'd1000000-0000-4000-8000-000000000169', number: '12', date: '2026-10-01', position: 1, description: 'Produto sintético', code: 'PS', product_id: product, unit: 'UN', quantity: '2.000000', unit_price: '9.5000', ...extra });
const finance = { open_count: 1, open_amount: '130.00', overdue_amount: '100.00', titles: [{ id: 'd2000000-0000-4000-8000-000000000169', due_on: '2026-09-15', description: 'Pedido de venda nº 12', installment: 1, installments: 2, amount: '100.00', open_amount: '100.00' }] };
const MODAL = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
const balances = { product_id: product, items: [
  { warehouse_id: warehouse, warehouse_name: 'Depósito do pedido', warehouse_active: true, quantity: '10.000000', version: 3, unit: 'UN', warehouse_default: false, warehouse_ignored: false, reserved_quantity: '1.500000', situation_reserved_quantity: '0.000000' },
  { warehouse_id: other, warehouse_name: 'Depósito padrão', warehouse_active: true, quantity: '-1.000000', version: 1, unit: 'UN', warehouse_default: true, warehouse_ignored: true, reserved_quantity: '0.000000', situation_reserved_quantity: '0.000000' }], reservation: {}, data_mode: 'erp_native' };

test('the history reader and the Todos os depósitos arithmetic stay exact', () => {
  assert.equal(historyPath('sales_orders', { mode: 'client' }, contact, ' parafuso '), `/v1/documentos/sales_orders/historico?contact_id=${contact}&q=parafuso&limit=50`);
  assert.equal(historyPath('purchase_orders', { mode: 'purchase', productId: product, label: 'x' }, null), `/v1/documentos/purchase_orders/historico?product_id=${product}&limit=10`);
  assert.equal(readHistory({ items: [line()], has_more: false, invoices_included: false, finance }, { mode: 'client' }).finance.open_amount, '130.00');
  assert.throws(() => readHistory({ items: [line({ product_id: null })], has_more: false, invoices_included: true, finance: null }, { mode: 'item', productId: product, label: 'x' }), 'an item history only has the product');
  assert.throws(() => readHistory({ items: Array.from({ length: 11 }, () => line()), has_more: true, invoices_included: true, finance: null }, { mode: 'item', productId: product, label: 'x' }));
  assert.equal(stockUnits('1.5'), 1500000n); assert.equal(unitsText(-2500000n), '−2,5');
  const sale = itemStockView('sales_orders', product, balances, '3', warehouse, { min: '8.000000', max: null });
  assert.deepEqual(sale.rows.map(row => [row.name, row.current, row.available, row.after]), [['Depósito do pedido', '10', '8,5', '7'], ['Depósito padrão', '−1', '−1', null]]);
  assert.deepEqual([sale.total, sale.totalAfter, sale.tone, sale.afterLabel], ['10', '7', 'low', 'Depois da venda'], 'the ignored depósito stays out of the total');
  const purchase = itemStockView('purchase_orders', product, balances, '2.5', null, { min: null, max: null });
  assert.deepEqual([purchase.rows[1].after, purchase.totalAfter, purchase.tone], ['1,5', '12,5', 'ok'], 'without a depósito the depósito padrão receives it');
  assert.equal(itemStockView('sales_orders', product, balances, '11', warehouse, { min: null, max: null }).tone, 'negative');
});

function setup(kind, role = 'vendas') {
  const calls = [];
  const saved = record(kind, { ...input(), items: [{ ...input().items[0], product_id: product, code: 'PS', description: 'Produto sintético' }], warehouse_id: warehouse });
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role, user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products', 'warehouses'], write: [], data_mode: 'erp_native' }; return { items: [], has_more: false }; },
    async documents(path) {
      calls.push(path);
      if (path.includes('/historico?')) { const q = new URLSearchParams(path.split('?')[1]); const client = !q.has('product_id');
        return { kind, contact_id: q.get('contact_id'), product_id: q.get('product_id'), items: [line({ type: kind === 'purchase_orders' ? 'purchase' : 'sale' })], has_more: false, invoices_included: false, finance: client ? finance : null, data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async stock(path) { calls.push(path); if (path === `/v1/estoque/saldos?product_id=${product}`) return balances; throw new AccessError(404); },
    async stockPositions(path) { calls.push(path); return { items: [], warehouse: null, limit: 25, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_positions' }; },
    async stockReservations() { throw new AccessError(404); }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, calls, saved };
}
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
// The consultations are links (role=button): a disabled fieldset (locked form) does not disable links in the browser.
const consult = async (view, label) => { const node = view.nodes().find(n => n.type === 'a' && (n.props['aria-label'] === label || textOf(n) === label)); if (!node) throw new Error(`Missing ${label}`); node.props.onClick({ preventDefault() {} }); await view.flush(); };
const section = (view, title) => view.nodes().some(n => n.type === 'section' && n.props['aria-label'] === title);

test('pedido de venda: Visualizar histórico do cliente (Produtos and Financeiro) and of the item for the cliente', async () => {
  const s = setup('sales_orders');
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: s.saved, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentHistory', 'DocumentItemStock', 'Modal'], modules: MODAL });
  try {
    await consult(view, 'Visualizar histórico do cliente'); await view.flush();
    assert.ok(section(view, 'Últimos registros deste cliente'));
    assert.ok(s.calls.includes(`/v1/documentos/sales_orders/historico?contact_id=${contact}&limit=50`));
    assert.match(view.text(), /Produto sintético · PS/); assert.match(view.text(), /R\$ 9,50/); assert.match(view.text(), /Venda/);
    assert.match(view.text(), /As notas fiscais aparecem para os perfis administrador e fiscal/);
    await view.click('Financeiro');
    assert.match(view.text(), /Saldo em aberto/); assert.match(view.text(), /R\$ 130,00/); assert.match(view.text(), /1\/2/);
    await view.click('Fechar');
    assert.equal(section(view, 'Últimos registros deste cliente'), false);
    await consult(view, 'Visualizar histórico do item 1 para o cliente'); await view.flush();
    assert.ok(section(view, 'Últimas vendas deste item para este cliente'));
    assert.ok(s.calls.includes(`/v1/documentos/sales_orders/historico?contact_id=${contact}&product_id=${product}&limit=10`));
    assert.match(view.text(), /São exibidos apenas os 10 últimos registros/);
    await view.click('Fechar');
    await consult(view, 'Todos os depósitos do item 1'); await view.flush();
    assert.ok(section(view, 'Todos os depósitos'));
    assert.match(view.text(), /Depósito do pedido/); assert.match(view.text(), /Depois da venda/);
    assert.match(view.text(), /Depósito padrão \(padrão\) · saldo desconsiderado/);
  } finally { view.unmount(); }
});

test('pedido de compra: Últimas compras of the product, only from the supplier or from all; a seller without stock view sees no cubos', async () => {
  const s = setup('purchase_orders', 'estoque');
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'purchase_orders', record: s.saved, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentHistory', 'Modal'], modules: MODAL });
  try {
    assert.equal(view.nodes().some(n => n.type === 'a' && n.props.title === 'Visualizar histórico do cliente'), false, 'the pedido de compra has no client history');
    await consult(view, 'Visualizar histórico do produto do item 1'); await view.flush();
    assert.ok(section(view, 'Últimas compras'));
    assert.ok(s.calls.includes(`/v1/documentos/purchase_orders/historico?contact_id=${contact}&product_id=${product}&limit=10`));
    view.input('document-history-supplier').props.onChange({ target: { checked: false } }); await view.flush();
    assert.ok(s.calls.includes(`/v1/documentos/purchase_orders/historico?product_id=${product}&limit=10`));
    assert.match(view.text(), /Pedido de compra/);
  } finally { view.unmount(); }
  const seller = setup('sales_orders');
  const hidden = await mountComponent('RealDocuments.tsx', { controller: seller.controller, kind: 'sales_orders', record: seller.saved, writable: true, onSaved() {}, onClose() {}, onConverted() {},
    access: { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native', operational_effects: false, seller: { id: 'a1000000-0000-4000-8000-000000000169', name: 'Vendedora', allow_unregistered_products: true, view_stock: false, discount_limit: '0.0000' } } },
    { componentName: 'Editor', location: '/documentos-empresa' });
  try {
    assert.equal(hidden.nodes().some(n => n.type === 'a' && n.props['aria-label'] === 'Todos os depósitos do item 1'), false);
    assert.equal(hidden.nodes().some(n => n.type === 'a' && n.props['aria-label'] === 'Visualizar histórico do item 1 para o cliente'), true, 'the history stays');
  } finally { hidden.unmount(); }
  // "nos pedidos de venda e ordens de serviço": the same vendedor still sees the cubos of a pedido de compra.
  const buyer = setup('purchase_orders', 'admin');
  const purchase = await mountComponent('RealDocuments.tsx', { controller: buyer.controller, kind: 'purchase_orders', record: buyer.saved, writable: true, onSaved() {}, onClose() {}, onConverted() {},
    access: { read: ['purchase_orders'], write: ['purchase_orders'], data_mode: 'erp_native', operational_effects: false, seller: { id: 'a1000000-0000-4000-8000-000000000169', name: 'Vendedora', allow_unregistered_products: true, view_stock: false, discount_limit: '0.0000' } } },
    { componentName: 'Editor', location: '/documentos-empresa' });
  try { assert.equal(purchase.nodes().some(n => n.type === 'a' && n.props['aria-label'] === 'Todos os depósitos do item 1'), true); } finally { purchase.unmount(); }
});
