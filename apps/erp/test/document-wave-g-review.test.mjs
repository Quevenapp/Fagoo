import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { documentRowActions } from '../src/lib/document-list-model.ts';
import { documentValidation } from '../src/lib/real-documents-model.ts';
import { DOCUMENT_PREFERENCE_PAGES, documentPreferences } from '../src/lib/document-preferences.ts';
import { pdvFailure } from '../src/lib/pdv-model.ts';
import { AccessError } from '../src/lib/real-access.ts';
import { storedFields } from '../../../packages/erp-domain/src/preferences/core.mjs';
import { preferencePage } from '../../../packages/erp-domain/src/preferences/catalog.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Review of the documentos lane, wave G (202610200287-294). Synthetic data only; no network; no date of today.
globalThis.document ??= { activeElement: null, getElementById: () => null };
globalThis.document.addEventListener ??= () => undefined; globalThis.document.removeEventListener ??= () => undefined;
const ID = 'c0000000-0000-4000-8000-000000000299', PRODUCT = 'd0000000-0000-4000-8000-000000000299', LOT = 'a1000000-0000-4000-8000-000000000299';
const textOf = value => Array.isArray(value) ? value.map(textOf).join('') : value && typeof value === 'object' ? textOf(value.props?.children) : value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);

test('Checkout parcial: the ⋮ hides Gerar nota fiscal, Gerar NFC-e, Lançar estoque and Lançar contas (Origin); the estornos stay', () => {
  const row = { id: ID, kind: 'sales_orders', number: '1', version: 1, status: 'checkout_partial', date: '2026-10-21', total: '1.00', contact_id: ID, contact_name: 'C', created_at: '', updated_at: '', expected_date: null, next_contact: null,
    template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null, pendencies: false };
  const labels = extra => documentRowActions('sales_orders', { ...row, ...extra }, { role: 'admin', writable: true, serviceWritable: true }).map(action => action.label);
  for (const hidden of ['Gerar nota fiscal', 'Gerar NFC-e', 'Lançar estoque', 'Lançar contas']) assert.ok(!labels({}).includes(hidden), hidden);
  assert.ok(labels({ stock_active: true }).includes('Estornar estoque'), 'the stock posted in Em aberto is still reversed');
  assert.ok(labels({ finance_active: true }).includes('Estornar contas'));
  for (const kept of ['Gerar nota fiscal', 'Lançar estoque', 'Lançar contas']) assert.ok(labels({ status: 'open' }).includes(kept), `Em aberto keeps ${kept}`);
});

test('the save messages: the sum of the lots and the taxes of each kind have their own text', () => {
  const base = { date: '2026-10-21', contact_id: ID, warehouse_id: null, installments: [] };
  const line = extra => ({ product_id: PRODUCT, description: 'Parafuso', unit: 'UN', quantity: '3', unit_price: '5', discount_percent: '0', ...extra });
  assert.equal(documentValidation('sales_orders', { ...base, items: [line({ lots: [{ lot_id: LOT, quantity: '1' }] })] }), 'A soma das quantidades dos lotes precisa ser igual à quantidade do item (Informar lotes).');
  assert.equal(documentValidation('sales_orders', { ...base, items: [line({ lots: [{ lot_id: LOT, quantity: '3' }] })] }), null);
  assert.equal(documentValidation('purchase_orders', { ...base, tax_ipi: '1.00', items: [line({})] }), 'Confira o IPI % dos itens: até 100%, com até quatro casas decimais.');
  assert.equal(documentValidation('sales_orders', { ...base, tax_ipi: 1, items: [line({})] }), 'Confira o Total do IPI e o Total do ICMS ST.');
});

test('Frente de caixa: a quantity above the casas decimais of the Preferências has its own message', () => {
  const failure = Object.assign(new AccessError(400, 'ERP_INVALID_QUERY'), { field: 'quantity_decimals' });
  assert.match(pdvFailure(failure), /mais casas decimais/);
});

test('OS: each item shows the end of its Garantia by the Data base da garantia, in the form as in the print', async () => {
  const page = preferencePage(DOCUMENT_PREFERENCE_PAGES.service_orders);
  const prefs = documentPreferences('service_orders', { scope: 'preferences_page', data_mode: 'erp_native', page: page.id, owner: 'company', role: 'admin', can_manage: true, directory: null,
    items: storedFields(page).map(field => ({ key: field.key, value: field.key === 'os.garantia_base' ? 'data_os' : field.default, version: field.key === 'os.garantia_base' ? 1 : 0, updated_at: null })) }, null);
  const normalized = normalizeDocument('service_orders', { date: '2026-10-01', contact_id: ID, installments: [],
    items: [{ product_id: null, description: 'Troca de tela', unit: 'UN', quantity: '1', unit_price: '80', discount_percent: '0', group: 'service', quote: false, done: false, warranty_days: '90' },
      { product_id: null, description: 'Limpeza', unit: 'UN', quantity: '1', unit_price: '20', discount_percent: '0', group: 'service', quote: false, done: false }] });
  const doc = { ...normalized, id: 'b0000000-0000-4000-8000-000000000299', kind: 'service_orders', number: '299', version: 2, status: 'open', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
    source_proposal_id: null, contact_snapshot: { id: ID, version: 1, name: 'Cliente revisão' }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map((item, index) => ({ ...item, id: `e0000000-0000-4000-8000-00000000029${index}`, product_snapshot: null })) };
  const port = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'admin', user_id: 'a0000000-0000-4000-8000-000000000299' } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products', 'warehouses'], write: [], data_mode: 'erp_native' }; return { entity: 'products', items: [], has_more: false }; },
    async documents() { return { kind: 'service_orders', document: doc, data_mode: 'erp_native', operational_effects: false }; },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller: port, kind: 'service_orders', record: doc, writable: true, preferences: prefs, onSaved() {}, onClose() {}, onConverted() {}, onCopyPrepared() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['ServiceOrderItems'] });
  for (const node of view.nodes().filter(n => typeof n.type === 'function' && typeof n.props.onActive === 'function')) { node.props.onMode?.('available'); node.props.onActive(false); }
  await view.flush();
  const until = view.nodes().find(n => n.props?.id === 'doc-item-warranty-until-0');
  assert.ok(until, 'the item with Garantia shows its end');
  assert.equal(textOf(until.props.children), 'até 30/12/2026', '90 days from the date of the OS');
  assert.equal(view.nodes().some(n => n.props?.id === 'doc-item-warranty-until-1'), false, 'an item without Garantia shows nothing');
  const line = view.nodes().find(n => n.type === 'input' && n.props.id === 'doc-item-warranty-0');
  assert.equal(line.props.value, '90');
  view.unmount?.();
});
