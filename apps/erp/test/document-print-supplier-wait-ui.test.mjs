import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Pedido de compra, "Código secundário: Código no fornecedor" (documentos lane, wave E): Imprimir waits for the codes at the supplier,
// and the batch print says how many orders beyond the first 50 print without them. Synthetic data only.
let previous, previousElement;
test.before(() => {
  previous = globalThis.document; previousElement = globalThis.HTMLElement;
  globalThis.HTMLElement ??= class {};
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, children: [], style: {}, classList: { add() {}, remove() {} } }, createElement: () => ({ remove() {} }) };
});
test.after(() => { globalThis.document = previous; globalThis.HTMLElement = previousElement; });
const supplier = 'c1000000-0000-4000-8000-000000000001', p1 = 'd1000000-0000-4000-8000-000000000001';
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
function order(n) {
  const data = { date: '2026-10-20', contact_id: supplier, items: [{ id: `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`, product_id: p1, description: 'Chapa', code: 'CH-1', unit: 'UN', quantity: '2', unit_price: '9.5', discount_percent: '0' }] };
  const normalized = normalizeDocument('purchase_orders', data);
  return { ...normalized, id: `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'purchase_orders', number: String(n), version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: supplier, version: 1, name: 'Fornecedor Sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map(item => ({ ...item, product_snapshot: null })) };
}
const prefs = { secondaryCode: 'codigo_fornecedor' };
const answer = { entity: 'products', supplier_id: supplier, mode: 'last_purchase', data_mode: 'erp_native', items: [{ product_id: p1, supplier: { id: supplier, code: 'FORN-77', description: null, purchase_price: null, cost_price: null } }] };
const printButton = (view, label) => view.nodes().find(node => node.type === 'button' && text(node) === label);

test('Imprimir documento waits for the codes at the supplier, then prints them', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const controller = { async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; }, async catalog() { await pending; return answer; } };
  const view = await mountComponent('DocumentPrintPreview.tsx', { record: order(1), controller, onClose() {}, options: { prefs } }, { expandChildren: ['DocumentPrintSheet'] });
  try {
    await view.flush();
    assert.equal(printButton(view, 'Imprimir documento').disabled, true, 'the print waits for the lookup');
    assert.match(view.text(), /Consultando os códigos no fornecedor…/);
    release(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.equal(printButton(view, 'Imprimir documento').disabled, false);
    assert.match(view.text(), /Código no fornecedor: FORN-77/); assert.doesNotMatch(view.text(), /Consultando os códigos/);
  } finally { view.unmount(); }
});

test('Imprimir selecionados: past 50 orders the print says how many go without the codes; at most 50 lookups', async () => {
  const calls = [];
  const controller = { async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; }, async catalog(path) { calls.push(path); return answer; } };
  const records = Array.from({ length: 52 }, (_, i) => order(i + 1));
  const view = await mountComponent('DocumentBatchPrint.tsx', { records, controller, onClose() {}, options: { prefs } });
  try {
    await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.equal(calls.length, 50);
    assert.match(view.text(), /consultados nos 50 primeiros pedidos\. 2 pedidos saem sem o Código secundário/);
    assert.equal(printButton(view, 'Imprimir documentos').disabled, false);
  } finally { view.unmount(); }
  const single = await mountComponent('DocumentBatchPrint.tsx', { records: records.slice(0, 51), controller: { ...controller, async catalog() { return answer; } }, onClose() {}, options: { prefs } });
  try { await single.flush(); assert.match(single.text(), /Um pedido sai sem o Código secundário/); } finally { single.unmount(); }
  const few = await mountComponent('DocumentBatchPrint.tsx', { records: records.slice(0, 3), controller: { ...controller, async catalog() { return answer; } }, onClose() {}, options: { prefs } });
  try { await few.flush(); assert.doesNotMatch(few.text(), /primeiros pedidos/); } finally { few.unmount(); }
});
