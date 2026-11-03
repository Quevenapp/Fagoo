import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { defaultDocumentPreferences } from '../src/lib/document-preferences.ts';

// 202610200129: the real Editor of RealDocuments.tsx following the Preferências of each kind (synthetic controller, no DOM).
const actor = 'a0000000-0000-4000-8000-000000000129', docId = 'b0000000-0000-4000-8000-000000000129', contact = 'c0000000-0000-4000-8000-000000000129';
const product = 'd0000000-0000-4000-8000-000000000129';
const node = (view, name, predicate = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && predicate(n));
const picker = (view, entity) => node(view, 'CatalogPicker', n => n.props.entity === entity);
const prefs = (kind, extra = {}) => ({ ...defaultDocumentPreferences(kind), loaded: true, ...extra });
const productRow = (extra = {}) => ({ id: product, entity: 'products', version: 1, active: true, name: 'Produto sintético', code: 'PS-1', gtin: null, unit: 'UN', kind: 'P', price: '10.0000', gross_weight: '1.500000', source: null, ...extra });
const body = (kind, extra = {}) => ({ date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Item sintético', code: null, unit: 'UN', quantity: '1', unit_price: '10', detailed_description: null }], ...extra });
function record(kind = 'sales_orders', data = body(kind), extra = {}) {
  const normalized = normalizeDocument(kind, data);
  return { ...normalized, id: docId, kind, number: '129', version: 1, status: 'open', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, items: normalized.items.map((item, index) => ({ ...item, id: item.id ?? `e0000000-0000-4000-8000-00000000000${index + 1}`, product_snapshot: null })), ...extra };
}
function setup({ kind = 'sales_orders', nextNumber = '501', failWith = null, role = 'vendas' } = {}) {
  const calls = []; let saved = null;
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role, user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; return { entity: 'products', items: [], has_more: false }; },
    async documents(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body === undefined ? undefined : structuredClone(options.body) });
      if (path.endsWith('/proximo-numero')) return { kind, next_number: nextNumber, reserved: false, data_mode: 'erp_native', operational_effects: false };
      if (options.method) { if (failWith) throw new AccessError(failWith); saved = options.body.data; }
      const { number, ...data } = saved ?? body(kind);
      return { kind, document: record(kind, data, { version: 2, number: number ?? '129' }), data_mode: 'erp_native', operational_effects: false };
    },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { controller, calls, posts: () => calls.filter(call => call.method === 'POST' || call.method === 'PATCH') };
}
async function mount(s, kind, current, preferences, extra = {}) {
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind, record: current, writable: true, onSaved() {}, onClose() {}, onConverted() {}, preferences, ...extra }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentCommercialFields', 'DocumentOptionalSection', 'ServiceOrderItems'] });
  const reservations = node(view, 'SalesOrderReservations'); if (reservations) { reservations.props.onActive(false); await view.flush(); }
  const receipts = node(view, 'PurchaseReceipts'); if (receipts) { receipts.props.onActive(false); await view.flush(); }
  return view;
}
const choose = async (view, entity, row) => { picker(view, entity).props.onSelect(row); await view.flush(); };

test('Observação padrão fills a new document; arriving late it replaces only an untouched form', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null, prefs('sales_orders', { observation: 'Entrega em horário comercial' }));
  try { assert.equal(view.input('doc-notes').props.value, 'Entrega em horário comercial'); assert.equal(view.guard().changed, false, 'the default is not an unsaved change'); }
  finally { view.unmount(); }
  const late = setup({ kind: 'purchase_orders' }), first = await mount(late, 'purchase_orders', null, undefined);
  try {
    assert.equal(first.input('doc-notes').props.value, '');
    await first.updateProps({ preferences: prefs('purchase_orders', { observation: 'Conferir a NF na entrega' }) });
    assert.equal(first.input('doc-notes').props.value, 'Conferir a NF na entrega');
  } finally { first.unmount(); }
  const typed = setup({ kind: 'purchase_orders' }), second = await mount(typed, 'purchase_orders', null, undefined);
  try {
    await second.change('doc-internal_notes', 'Digitado antes');
    await second.updateProps({ preferences: prefs('purchase_orders', { observation: 'Padrão' }) });
    assert.equal(second.input('doc-notes').props.value, '', 'a form already edited is never overwritten');
    assert.equal(second.input('doc-internal_notes').props.value, 'Digitado antes');
  } finally { second.unmount(); }
  const existing = setup(), saved = await mount(existing, 'sales_orders', record(), prefs('sales_orders', { observation: 'Padrão' }));
  try { assert.equal(saved.input('doc-notes').props.value, '', 'a saved document keeps its own notes'); } finally { saved.unmount(); }
});

test('Editar número: the suggested number is not sent; a typed one is, and a taken number explains itself', async () => {
  const s = setup({ kind: 'purchase_orders' }), view = await mount(s, 'purchase_orders', null, prefs('purchase_orders', { numberEditable: true }));
  try {
    assert.equal(view.input('doc-number').props.value, '501');
    await choose(view, 'contacts', { id: contact, name: 'Fornecedor sintético' }); await view.change('doc-item-description-0', 'Item');
    await view.submit();
    assert.equal(Object.hasOwn(s.posts().at(-1).body.data, 'number'), false, 'the suggested number keeps the automatic numbering');
  } finally { view.unmount(); }
  const typed = setup({ kind: 'purchase_orders', failWith: 409 }), other = await mount(typed, 'purchase_orders', null, prefs('purchase_orders', { numberEditable: true }));
  try {
    await choose(other, 'contacts', { id: contact, name: 'Fornecedor sintético' }); await other.change('doc-item-description-0', 'Item');
    await other.change('doc-number', '0700'); await other.submit();
    assert.match(other.text(), /Informe um número de 1 a 9999999999, sem zeros à esquerda\./); assert.equal(typed.posts().length, 0);
    assert.equal(other.input('doc-number').props['aria-invalid'], true);
    await other.change('doc-number', '700'); await other.submit();
    assert.equal(typed.posts().at(-1).body.data.number, '700');
    assert.match(other.text(), /O número 700 pode já estar em uso/);
  } finally { other.unmount(); }
  const off = setup({ kind: 'purchase_orders' }), plain = await mount(off, 'purchase_orders', null, prefs('purchase_orders'));
  try { assert.equal(plain.nodes().some(n => n.props?.id === 'doc-number'), false, 'without the preference there is no number field'); } finally { plain.unmount(); }
  // The reviewed copy takes the automatic number (erp_document_copy refuses a requested one), so the field is not offered there.
  const copy = setup({ kind: 'purchase_orders' }), preview = { source: { id: docId, kind: 'purchase_orders', number: '129', version: 1 }, data: { ...body('purchase_orders'), discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], commercial: null },
    reset_fields: ['date', 'expected_date', 'valid_until', 'next_contact', 'installments', 'template', 'equipment', 'serial_number', 'technician', 'defect', 'solution'], persisted: false, data_mode: 'erp_native', operational_effects: false };
  const copied = await mount(copy, 'purchase_orders', null, prefs('purchase_orders', { numberEditable: true }), { copyDraft: { preview, contact: { id: contact, name: 'Fornecedor sintético' } } });
  try { assert.equal(copied.nodes().some(n => n.props?.id === 'doc-number'), false, 'a copy keeps the automatic number'); } finally { copied.unmount(); }
});

test('produtos não cadastrados off: no free line and the Origin refusal; OS without repeated items', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null, prefs('sales_orders', { freeItems: false }));
  try {
    assert.equal(view.nodes().some(n => n.type === 'button' && n.props.children === '+ Adicionar outro item'), false);
    assert.match(view.text(), /Não é permitido vender produtos não cadastrados \(Preferências › Vendas\)\./);
    await choose(view, 'contacts', { id: contact, name: 'Cliente sintético' });
    await view.change('doc-item-description-0', 'Livre'); await view.submit();
    assert.match(view.text(), /Não é permitido vender produtos não cadastrados\./); assert.equal(s.posts().length, 0);
    picker(view, 'products').props.onSelect(productRow()); await view.flush();
    view.nodes().find(n => n.type === 'button' && n.props['aria-label'] === 'Remover item 1').props.onClick(); await view.flush();
    await view.submit(); assert.equal(s.posts().length, 1);
  } finally { view.unmount(); }
  const os = setup({ kind: 'service_orders' }), service = await mount(os, 'service_orders', null, prefs('service_orders', { repeatedItems: false }));
  try {
    assert.match(picker(service, 'products').props.onSelect(productRow()), /incluído/);
    await service.flush();
    assert.match(picker(service, 'products').props.onSelect(productRow()), /não permitem itens repetidos/);
    await service.flush();
    assert.equal(service.nodes().filter(n => n.props?.id?.startsWith?.('doc-item-description-')).length, 1);
  } finally { service.unmount(); }
});

test('próximo contato obrigatório on propostas; models are exempt', async () => {
  const s = setup({ kind: 'sales_proposals' }), view = await mount(s, 'sales_proposals', null, prefs('sales_proposals', { nextContactRequired: true }));
  try {
    assert.match(view.text(), /Próximo contato \*/);
    await choose(view, 'contacts', { id: contact, name: 'Cliente sintético' }); await view.change('doc-item-description-0', 'Item'); await view.submit();
    assert.match(view.text(), /O campo Próximo contato é obrigatório\./); assert.equal(s.posts().length, 0);
    await view.change('doc-next', '2026-10-27'); await view.submit(); assert.equal(s.posts().length, 1);
  } finally { view.unmount(); }
});

test('Gerar parcelas uses Data saída and puts the freight in the first installment; Dias count from the same date', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', record('sales_orders', body('sales_orders', { ship_date: '2026-10-25', freight: '10.01' })), prefs('sales_orders', { installmentBase: 'ship_date', freightFirstInstallment: true }));
  try {
    await view.change('doc-condition', '30 60'); await view.click('Gerar parcelas');
    assert.equal(view.input('doc-installment-date-0').props.value, '2026-11-24');
    assert.equal(view.input('doc-installment-amount-0').props.value, '15,01'); assert.equal(view.input('doc-installment-amount-1').props.value, '5,00');
    assert.equal(view.input('doc-installment-days-0').props.value, '30');
    await view.change('doc-ship-date', ''); await view.click('Gerar parcelas');
    assert.match(view.text(), /Preencha o campo Data saída antes de gerar as parcelas\./);
  } finally { view.unmount(); }
});

test('Exibe detalhes / dados adicionais / transportadora: Opcional collapses, Não hides while empty', async () => {
  const s = setup(), view = await mount(s, 'sales_orders', null, prefs('sales_orders', { showDetails: 'opcional', showAdditional: 'nao', showCarrier: 'opcional' }));
  try {
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-customer-po'), false);
    await view.click('Mostrar detalhes da venda');
    assert.equal(view.input('doc-customer-po').props.value, '');
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-notes'), false, 'dados adicionais hidden');
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-freight-mode'), false, 'the default CIF alone keeps the carrier collapsed');
    await view.click('Mostrar transportador');
    assert.equal(view.input('doc-freight-mode').props.value, '0');
  } finally { view.unmount(); }
  const filled = setup(), saved = await mount(filled, 'sales_orders', record('sales_orders', body('sales_orders', { notes: 'Obs. salva' })), prefs('sales_orders', { showAdditional: 'nao' }));
  try { assert.equal(saved.input('doc-notes').props.value, 'Obs. salva', 'a section with values stays visible'); } finally { saved.unmount(); }
});

test('Somar peso bruto: read-only sum of the chosen products, saved with the document', async () => {
  const s = setup({ kind: 'purchase_orders' }), view = await mount(s, 'purchase_orders', null, prefs('purchase_orders', { sumGrossWeight: true }));
  try {
    await choose(view, 'contacts', { id: contact, name: 'Fornecedor sintético' });
    picker(view, 'products').props.onSelect(productRow()); await view.flush();
    await view.change('doc-item-qty-0', '3');
    assert.equal(view.input('doc-gross_weight').props.readOnly, true); assert.equal(view.input('doc-gross_weight').props.value, '4,5');
    await view.change('doc-order-reference', 'OC-77');
    await view.submit();
    const data = s.posts().at(-1).body.data;
    assert.deepEqual([data.commercial.transport.gross_weight, data.order_reference], ['4.5', 'OC-77']);
  } finally { view.unmount(); }
});

test('OS Rótulos rename Cliente, Equipamento, Problema and the date; the print gets the Preferências options', async () => {
  const p = prefs('service_orders', { labels: { cliente: 'Proprietário', equipamento: 'Aparelho', problema: 'Defeito relatado', data_entrada: 'Data entrada' } });
  const s = setup({ kind: 'service_orders' }), view = await mount(s, 'service_orders', record('service_orders', body('service_orders', { items: [] })), p);
  try {
    assert.equal(picker(view, 'contacts').props.label, 'Proprietário *');
    assert.match(view.text(), /Aparelho/); assert.match(view.text(), /Defeito relatado/); assert.match(view.text(), /Data entrada \*/);
    await view.click('Visualizar impressão');
    const preview = node(view, 'DocumentPrintPreview');
    assert.deepEqual([preview.props.options.prefs, preview.props.options.labels.equipamento], [p.print, 'Aparelho']);
  } finally { view.unmount(); }
});

test('OS por partes shows the Resumo do recebimento until Editar dados do recebimento; desconto e preço de lista by preference', async () => {
  const saved = record('service_orders', body('service_orders', { items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: product, description: 'Peça', code: null, unit: 'UN', quantity: '1', unit_price: '9', detailed_description: null }], equipment: 'Furadeira', defect: 'Não liga' }));
  saved.items[0].product_snapshot = { id: product, version: 1, name: 'Peça', price: '12.5000' };
  const s = setup({ kind: 'service_orders' }), view = await mount(s, 'service_orders', saved, prefs('service_orders', { receptionInParts: true, showListDiscount: true }));
  try {
    assert.match(view.text(), /Resumo do recebimento/); assert.match(view.text(), /Furadeira/); assert.match(view.text(), /Não liga/);
    assert.equal(view.nodes().some(n => n.props?.id === 'doc-equipment'), false);
    await view.click('Editar dados do recebimento');
    assert.equal(view.input('doc-equipment').props.value, 'Furadeira');
    // 202610200268: the OS items are the Peças / Serviços executados grids (Origin "Desc %").
    assert.ok(view.nodes().some(n => n.type === 'th' && n.props.children === 'Preço lista')); assert.match(view.text(), /R\$ 12,5/);
    assert.ok(view.nodes().some(n => n.type === 'th' && n.props.children === 'Desc %'));
  } finally { view.unmount(); }
  const plain = setup({ kind: 'service_orders' }), other = await mount(plain, 'service_orders', saved, prefs('service_orders'));
  try {
    assert.ok(other.nodes().some(n => n.props?.id === 'doc-equipment'), 'without the preference the reception is a normal section');
    assert.equal(other.nodes().some(n => n.type === 'th' && (n.props.children === 'Preço lista' || n.props.children === 'Desc %')), false, 'Origin default: no desconto nor preço de lista in the OS');
  } finally { other.unmount(); }
});

test('the comprovante não fiscal limits the description, hides the code and prints the footer of the Preferências', async () => {
  const { documentPrintModel } = await import('../src/lib/document-print-model.ts');
  const data = body('sales_orders', { notes: 'Entregar pela manhã', items: [{ id: 'e0000000-0000-4000-8000-000000000001', product_id: null, description: 'Bucha de nylon com rosca interna 8 mm', code: 'B8', unit: 'UN', quantity: '2', unit_price: '1.5', discount_percent: '10', detailed_description: null }] });
  const p = prefs('sales_orders'), receipt = { ...p.print.receipt, limitDescription: true, notes: true, discount: true, footer: 'Volte sempre' };
  const model = documentPrintModel(record('sales_orders', data), null, { prefs: { ...p.print, receipt } });
  const view = await mountComponent('DocumentPrintPreview.tsx', { model, format: 'a4' }, { componentName: 'DocumentReceiptSheet' });
  try {
    const text = view.text();
    assert.match(text, /Bucha de nylon com rosca /); assert.doesNotMatch(text, /interna 8 mm/); assert.doesNotMatch(text, /B8/);
    assert.match(text, /Desconto: 10%/); assert.match(text, /Entregar pela manhã/); assert.match(text, /Volte sempre/);
    assert.equal(view.find(n => n.type === 'article').props.style.fontSize, '12px');
  } finally { view.unmount(); }
});
