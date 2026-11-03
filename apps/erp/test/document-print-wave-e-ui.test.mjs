import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { documentPrintModel } from '../src/lib/document-print-model.ts';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';
import { documentRowActions } from '../src/lib/document-list-model.ts';
import { readStructures } from '../src/lib/document-structure-model.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Documentos lane, wave E (migration 240): Code 128 bars, endereço alternativo, aprovação da proposta, pessoas de contato of the OS,
// "Desmembrar produtos da estrutura", "Ocultar itens produzidos por terceiros" and the Relatório de produção. Synthetic data only.
let previous, previousElement;
test.before(() => {
  previous = globalThis.document; previousElement = globalThis.HTMLElement;
  globalThis.HTMLElement ??= class {};
  globalThis.document = { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {}, body: { append() {}, children: [], style: {}, classList: { add() {}, remove() {} } }, createElement: () => ({ remove() {} }) };
});
test.after(() => { globalThis.document = previous; globalThis.HTMLElement = previousElement; });
const contact = 'c0000000-0000-4000-8000-000000000240', kit = 'd0000000-0000-4000-8000-000000000240', third = 'd1000000-0000-4000-8000-000000000240', carrier = 'c1000000-0000-4000-8000-000000000240';
const ITEM1 = 'e0000000-0000-4000-8000-000000000001', ITEM2 = 'e0000000-0000-4000-8000-000000000002', DOC = 'b0000000-0000-4000-8000-000000000240';
function record(kind = 'sales_orders', extra = {}) {
  const data = { date: '2026-10-21', contact_id: contact, items: [{ id: ITEM1, product_id: kit, description: 'Kit sintético', code: 'KIT-1', unit: 'UN', quantity: '2', unit_price: '30', discount_percent: '0', detailed_description: 'Montar antes' },
    { id: ITEM2, product_id: third, description: 'Peça de terceiros', code: 'TER-1', unit: 'UN', quantity: '1', unit_price: '5', discount_percent: '0' }], ...extra };
  const normalized = normalizeDocument(kind, data);
  return { ...normalized, id: DOC, kind, number: '240', version: 2, status: 'open', created_at: '2026-10-21T12:00:00Z', updated_at: '2026-10-21T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente Sintético', street: 'Rua do Cliente', number: '10', city: 'Piracicaba', state: 'SP' }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map(item => ({ ...item, product_snapshot: null })) };
}
const structures = [{ item_id: ITEM1, position: 1, product_id: kit, production: 'own', components: [{ product_id: 'd2000000-0000-4000-8000-000000000240', code: 'PAR-1', description: 'Parafuso', unit: 'UN', quantity: '4.000000', total: '8.000000' }] },
  { item_id: ITEM2, position: 2, product_id: third, production: 'third_party', components: [] }];
const prefs = (kind, change = {}) => ({ ...defaultDocumentPreferences(kind).print, ...change });

test('print model: bars of the code and of the number, alternative address, approval fields and the structure options', () => {
  const bars = documentPrintModel(record(), null, { prefs: prefs('sales_orders', { codeBarcode: true, titleBarcode: true }) });
  assert.match(bars.titleBars, /^[01]+$/); assert.match(bars.items[0].bars, /^[01]+$/);
  assert.equal(documentPrintModel(record()).titleBars, null, 'off by default');
  const delivery = { name: 'Depósito do cliente', street: 'Rua da Entrega', number: '99', complement: null, district: 'Distrito', city: 'Limeira', state: 'SP', postal_code: '13480000', country: null };
  const alternative = documentPrintModel(record('sales_orders', { delivery_address: delivery }), null, { prefs: prefs('sales_orders', { alternativeAddress: true }) });
  assert.deepEqual([alternative.contact.address, alternative.contact.city, alternative.deliveryAddress], ['Rua da Entrega, 99', 'Limeira / SP', null]);
  assert.equal(documentPrintModel(record('sales_orders', { delivery_address: delivery })).contact.address, 'Rua do Cliente, 10');
  assert.equal(documentPrintModel(record('sales_proposals'), null, { prefs: prefs('sales_proposals', { approvalFields: true }) }).approvalFields, true);
  const exploded = documentPrintModel(record(), null, { structures, explode: true, hideThirdParty: true });
  assert.deepEqual(exploded.items.map(item => item.description), ['Kit sintético']); assert.equal(exploded.hiddenThirdParty, 1);
  assert.deepEqual(exploded.items[0].components.map(c => [c.description, c.quantity, c.perUnit]), [['Parafuso', '8', '4']]);
  assert.throws(() => readStructures({ kind: 'sales_orders', document_id: 'outro', items: [] }, 'sales_orders', DOC));
});

test('Relatório de produção: waits for the structure, prints items without values, the carrier address and the client', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const controller = {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; },
    async documents(path) { calls.push(path); await pending; return { kind: 'sales_orders', document_id: DOC, items: structures }; },
    async catalog(path) { calls.push(path); return { entity: 'contacts', record: { id: carrier, name: 'Transportadora Sintética', street: 'Av. Frete', number: '5', city: 'Campinas', state: 'SP', postal_code: '13000000' } }; },
  };
  const production = { itemNumber: true, carrierAddress: true, structure: true, clientData: true, detailedDescription: true };
  const view = await mountComponent('DocumentPrintPreview.tsx', { record: { ...record(), carrier_id: carrier, carrier_name: 'Transportadora Sintética' }, controller, onClose() {}, variant: 'production', options: { prefs: prefs('sales_orders', { production }) } },
    { expandChildren: ['DocumentProductionSheet'] });
  try {
    await view.flush();
    assert.equal(view.button('Imprimir documento').disabled, true, 'waits for the structure');
    release(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.equal(view.button('Imprimir documento').disabled, false);
    const shown = view.text();
    assert.match(shown, /Relatório de produção/); assert.match(shown, /Pedido de venda nº 240/);
    assert.match(shown, /Parafuso · PAR-1 — 8 UN \(4 por unidade\)/); assert.match(shown, /Montar antes/);
    assert.match(shown, /Transportadora Sintética/); assert.match(shown, /Av\. Frete, 5/); assert.match(shown, /Cliente Sintético/);
    assert.doesNotMatch(shown, /R\$/, 'no values');
    assert.ok(calls.includes(`/v1/documentos/sales_orders/${DOC}/estrutura`) && calls.includes(`/v1/cadastros/contatos/${carrier}`));
  } finally { view.unmount(); }
});

test('Relatório de produção waits for the carrier address too; a failed read prints the name of the pedido', async () => {
  let fail; const pending = new Promise((_, reject) => { fail = reject; });
  const controller = {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; },
    async documents() { return { kind: 'sales_orders', document_id: DOC, items: structures }; },
    async catalog() { return pending; },
  };
  const production = { itemNumber: false, carrierAddress: true, structure: false, clientData: false, detailedDescription: false };
  const view = await mountComponent('DocumentPrintPreview.tsx', { record: { ...record(), carrier_id: carrier, carrier_name: 'Transportadora do Pedido' }, controller, onClose() {}, variant: 'production', options: { prefs: prefs('sales_orders', { production }) } },
    { expandChildren: ['DocumentProductionSheet'] });
  try {
    await view.flush(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.equal(view.button('Imprimir documento').disabled, true, 'waits for the carrier');
    assert.match(view.text(), /Consultando o endereço da transportadora/);
    fail(new Error('synthetic')); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.equal(view.button('Imprimir documento').disabled, false);
    assert.match(view.text(), /Transportadora do Pedido/);
  } finally { view.unmount(); }
});

test('OS print with "Imprimir pessoas de contato" lists the visible persons of the client', async () => {
  const controller = {
    async company() { return { section: 'identity', data_mode: 'erp_native', emission_enabled: false, record: null }; },
    async catalog(path) { assert.equal(path, `/v1/cadastros/contatos/${contact}/resumo`); return { scope: 'contact_summary', id: contact, name: 'Cliente Sintético', notes: null, contact_info: null,
      persons: [{ id: 'f0000000-0000-4000-8000-000000000001', name: 'Ana Contato', code: null, situation: 'A', visible: true, email: 'ana@sintetico.test', phone: null, mobile: '19999990000' },
        { id: 'f0000000-0000-4000-8000-000000000002', name: 'Oculto', code: null, situation: 'A', visible: false, email: null, phone: null, mobile: null }] }; },
  };
  const view = await mountComponent('DocumentPrintPreview.tsx', { record: record('service_orders', { items: [] }), controller, onClose() {}, options: { prefs: prefs('service_orders', { contactPersons: true }) } }, { expandChildren: ['DocumentPrintSheet'] });
  try {
    await view.flush(); await new Promise(resolve => setTimeout(resolve, 5)); await view.flush();
    assert.match(view.text(), /Pessoas de contato/); assert.match(view.text(), /Ana Contato · ana@sintetico\.test · 19999990000/); assert.doesNotMatch(view.text(), /Oculto/);
  } finally { view.unmount(); }
});

test('⋮ of the pedido de venda offers the Relatório de produção', () => {
  const row = { id: DOC, kind: 'sales_orders', number: '240', version: 2, status: 'open', date: '2026-10-21', total: '65.00', contact_id: contact, contact_name: 'Cliente', created_at: '', updated_at: '', expected_date: null, next_contact: null,
    template: false, warehouse_id: null, warehouse_name: null, source_proposal_id: null, source_proposal_number: null, finance_active: false, stock_active: false, receipt_active: false, reservation_active: false, fiscal_draft: null, internal_notes: null };
  const action = documentRowActions('sales_orders', row, { role: 'vendas', writable: true }).find(item => item.action === 'print_production');
  assert.ok(action?.enabled); assert.equal(action.label, 'Relatório de produção');
});
