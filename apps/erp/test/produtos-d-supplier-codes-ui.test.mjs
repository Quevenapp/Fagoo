import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { supplierCodes, supplierCodesPath } from '../src/lib/document-supplier-codes.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Pedido de compra, "Código secundário: Código no fornecedor" (produtos lane, wave D): the code of the product at the supplier of
// the order, read from the product registry, printed under the item. Synthetic data only.
let previous, previousElement;
test.before(() => {
  previous = globalThis.document; previousElement = globalThis.HTMLElement;
  globalThis.HTMLElement ??= class {};
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, children: [], style: {}, classList: { add() {}, remove() {} } }, createElement: () => ({ remove() {} }) };
});
test.after(() => { globalThis.document = previous; globalThis.HTMLElement = previousElement; });
const supplier = 'c1000000-0000-4000-8000-000000000001', p1 = 'd1000000-0000-4000-8000-000000000001', p2 = 'd1000000-0000-4000-8000-000000000002';
function order(extra = {}) {
  const data = { date: '2026-10-20', contact_id: supplier, items: [{ id: 'e1000000-0000-4000-8000-000000000001', product_id: p1, description: 'Chapa', code: 'CH-1', unit: 'UN', quantity: '2', unit_price: '9.5', discount_percent: '0' },
    { id: 'e1000000-0000-4000-8000-000000000002', product_id: p2, description: 'Rebite', code: 'RB-1', unit: 'UN', quantity: '1', unit_price: '1', discount_percent: '0' },
    { id: 'e1000000-0000-4000-8000-000000000003', product_id: null, description: 'Frete avulso', code: null, unit: 'UN', quantity: '1', unit_price: '5', discount_percent: '0' }], ...extra };
  const normalized = normalizeDocument('purchase_orders', data);
  return { ...normalized, id: 'b1000000-0000-4000-8000-000000000001', kind: 'purchase_orders', number: '42', version: 3, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: supplier, version: 1, name: 'Fornecedor Sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })) };
}
const prefs = { secondaryCode: 'codigo_fornecedor' };
const answer = (overrides = {}) => ({ entity: 'products', supplier_id: supplier, mode: 'last_purchase', data_mode: 'erp_native', items: [
  { product_id: p1, supplier: { id: supplier, code: 'FORN-77', description: null, purchase_price: null, cost_price: null } }, { product_id: p2, supplier: null }], ...overrides });

test('model: the path asks only for linked products of a purchase order with the preference, and the codes are read strictly', () => {
  assert.equal(supplierCodesPath(order(), prefs), `/v1/cadastros/products/compras?${new URLSearchParams({ ids: `${p1},${p2}`, fornecedor: supplier })}`);
  assert.equal(supplierCodesPath(order(), { secondaryCode: 'gtin' }), null);
  assert.equal(supplierCodesPath({ ...order(), kind: 'sales_orders' }, prefs), null);
  assert.deepEqual(supplierCodes(answer(), order()), { [p1]: 'FORN-77', [p2]: null });
  assert.throws(() => supplierCodes(answer({ supplier_id: p1 }), order()));
  const model = documentPrintModel(order(), null, { prefs, supplierCodes: { [p1]: 'FORN-77' } });
  assert.deepEqual(model.items.map(item => [item.description, item.secondaryCode, item.secondaryLabel]), [['Chapa', 'FORN-77', 'Código no fornecedor'], ['Rebite', null, 'Código no fornecedor'], ['Frete avulso', null, 'Código no fornecedor']]);
  assert.equal(documentPrintModel({ ...order(), kind: 'purchase_orders' }, null, { prefs }).items[0].secondaryCode, null, 'without the lookup the column stays empty');
});

test('print preview: the purchase order prints the code at the supplier; a failed lookup keeps the print', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const controller = {
      // No company identity yet: the print still opens (the sheet says the identity is not registered).
      async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; },
      async catalog(path) { calls.push(path); if (fail) throw new AccessError(403); return answer(); },
    };
    const view = await mountComponent('DocumentPrintPreview.tsx', { record: order(), controller, onClose() {}, options: { prefs } }, { expandChildren: ['DocumentPrintSheet'] });
    try {
      await view.flush();
      assert.equal(calls.length, 1);
      if (fail) { assert.doesNotMatch(view.text(), /Código no fornecedor:/); assert.match(view.text(), /Chapa/); }
      else assert.match(view.text(), /Chapa.*Código no fornecedor: FORN-77/s);
    } finally { view.unmount(); }
  }
});
