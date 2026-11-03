import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_LIST_FILTERS, documentListQuery } from '../src/lib/document-list-model.ts';
import { effectTransitionAllowed } from '../src/lib/document-effects-model.ts';
import { STATES, TRANSITIONS, canEdit, transitionReasonRequired } from '../../../packages/erp-domain/src/index.mjs';

// Documentos lane, wave E: the Componente filter of the pedidos de venda and the situações Venda Agenciada / Faturado parcialmente.
const COMPONENT = 'a1000000-0000-4000-8000-000000000001';

test('Componente: only the pedidos de venda send component_id', () => {
  const params = documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, component: { id: COMPONENT, name: 'Parafuso' } });
  assert.equal(params.get('component_id'), COMPONENT);
  assert.equal(documentListQuery('sales_orders', EMPTY_LIST_FILTERS).has('component_id'), false);
  assert.throws(() => documentListQuery('sales_proposals', { ...EMPTY_LIST_FILTERS, component: { id: COMPONENT, name: 'Parafuso' } }), /componente/);
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, component: { id: 'x', name: 'Parafuso' } }), /componente/);
});

test('Venda Agenciada and Faturado parcialmente: labels, transitions, editing, reason and effects follow the SQL of 245', () => {
  assert.equal(STATES.sales_orders.agency_sale, 'Venda Agenciada'); assert.equal(STATES.sales_orders.partially_invoiced, 'Faturado parcialmente');
  assert.deepEqual(TRANSITIONS.sales_orders.partially_invoiced, ['partially_fulfilled', 'cancelled']);
  assert.ok(TRANSITIONS.sales_orders.partially_fulfilled.includes('partially_invoiced'));
  for (const status of ['draft', 'open', 'verified', 'in_progress', 'fulfilled', 'cancelled']) { assert.ok(TRANSITIONS.sales_orders[status].includes('agency_sale'), status); assert.ok(TRANSITIONS.sales_orders.agency_sale.includes(status), status); }
  assert.equal(canEdit('sales_orders', 'agency_sale'), true); assert.equal(canEdit('sales_orders', 'partially_invoiced'), false);
  assert.equal(transitionReasonRequired('sales_orders', 'open', 'agency_sale'), false);
  assert.equal(transitionReasonRequired('sales_orders', 'partially_invoiced', 'partially_fulfilled'), true, 'leaving a closed situação');
  assert.equal(effectTransitionAllowed('sales_orders', 'partially_fulfilled', 'partially_invoiced'), true);
  assert.equal(effectTransitionAllowed('sales_orders', 'partially_invoiced', 'partially_fulfilled'), true);
  assert.equal(effectTransitionAllowed('sales_orders', 'in_progress', 'agency_sale'), false);
});

test('Emitir boletos leaves the ⋮ when the pedido has a nota and its contas were not posted by the pedido', async () => {
  const { documentRowActions } = await import('../src/lib/document-list-model.ts');
  const row = { id: COMPONENT, kind: 'sales_orders', number: '1', version: 1, status: 'fulfilled', date: '2026-10-21', total: '1.00', contact_id: COMPONENT, contact_name: 'C', created_at: '', updated_at: '', expected_date: null, next_contact: null,
    template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, invoice_linked: true };
  const labels = extra => documentRowActions('sales_orders', { ...row, ...extra }, { role: 'admin', writable: true }).map(action => action.label);
  assert.ok(!labels({}).includes('Emitir boletos'));
  assert.ok(labels({ finance_active: true }).includes('Emitir boletos'), 'contas posted by the pedido keep it');
  assert.ok(labels({ invoice_linked: false }).includes('Emitir boletos'), 'without a nota it stays');
});

test('Imprimir etiquetas of the pedidos de compra: one label product per product of the cadastro (free items have none)', async () => {
  const { purchaseLabelProducts } = await import('../src/lib/document-labels-model.ts');
  const p1 = 'a2000000-0000-4000-8000-000000000001', p2 = 'a2000000-0000-4000-8000-000000000002';
  const item = (product_id, extra = {}) => ({ product_id, description: 'Item', code: 'C-1', product_snapshot: product_id ? { id: product_id, version: 1, name: 'Produto do cadastro', price: '9.9000', gtin: '7891234567895' } : null, ...extra });
  const labels = purchaseLabelProducts([{ items: [item(p1), item(null, { description: 'Frete' }), item(p2, { code: 'C-2' })] }, { items: [item(p1)] }]);
  assert.deepEqual(labels.products.map(p => [p.id, p.name, p.code, p.price, p.gtin]), [[p1, 'Produto do cadastro', 'C-1', '9.9000', '7891234567895'], [p2, 'Produto do cadastro', 'C-2', '9.9000', '7891234567895']]);
  assert.equal(labels.orders, 2);
});

test('Faturado parcialmente: the ⋮ hides Gerar nota fiscal, Gerar NFC-e and the launches not done, and Gerar ordem serviço waits', async () => {
  const { documentRowActions } = await import('../src/lib/document-list-model.ts');
  const row = { id: COMPONENT, kind: 'sales_orders', number: '1', version: 1, status: 'partially_invoiced', date: '2026-10-21', total: '1.00', contact_id: COMPONENT, contact_name: 'C', created_at: '', updated_at: '', expected_date: null, next_contact: null,
    template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, pendencies: false };
  const actions = extra => documentRowActions('sales_orders', { ...row, ...extra }, { role: 'admin', writable: true, serviceWritable: true });
  const labels = actions({}).map(action => action.label);
  for (const hidden of ['Gerar nota fiscal', 'Gerar NFC-e', 'Lançar estoque', 'Lançar contas', 'Emitir boletos']) assert.ok(!labels.includes(hidden), hidden);
  assert.ok(actions({ finance_active: true }).some(action => action.label === 'Estornar contas'), 'the estornos stay');
  const service = actions({}).find(action => action.action === 'sales_to_service');
  assert.equal(service.enabled, false); assert.equal(service.title, 'O pedido já tem nota fiscal.');
  assert.ok(documentRowActions('sales_orders', { ...row, status: 'partially_fulfilled' }, { role: 'admin', writable: true }).some(action => action.label === 'Gerar nota fiscal'), 'Atendido parcialmente keeps them');
});
