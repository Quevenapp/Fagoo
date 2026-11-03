import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { documentPrintModel } from '../src/lib/document-print-model.ts';

// Review of the documentos wave D (202610200196/197): the IPI/ICMS ST estimate never makes a saved document dirty only by being
// opened, the print lists the taxes that the total carries, and the Sacola de vendas message follows the result of the clear.
// Synthetic controller; no DOM, no network.
globalThis.document ??= { activeElement: null, getElementById: () => null, addEventListener() {}, removeEventListener() {} };
const actor = 'a0000000-0000-4000-8000-0000000001d9', docId = 'b0000000-0000-4000-8000-0000000001d9', contact = 'c0000000-0000-4000-8000-0000000001d9';
const product = 'f0000000-0000-4000-8000-0000000001d9';
const settle = async view => { for (let i = 0; i < 4; i += 1) { await new Promise(resolve => setTimeout(resolve, 15)); await view.flush(); } };
const node = (view, name, predicate = () => true) => view.nodes().find(n => typeof n.type === 'function' && n.type.name === name && predicate(n));
const body = (extra = {}) => ({ date: '2026-10-20', contact_id: contact, items: [{ id: 'e0000000-0000-4000-8000-0000000001d9', product_id: product, description: 'Produto', code: 'P1', unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0', detailed_description: null, list_price: '10', supplier_code: null }],
  discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [], commercial: null, ...extra });
function record(data = body(), extra = {}) {
  const normalized = normalizeDocument('sales_orders', data);
  return { ...normalized, id: docId, kind: 'sales_orders', number: '19', version: 1, status: 'draft', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null,
    contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false },
    items: normalized.items.map(item => ({ ...item, product_snapshot: null })), ...extra };
}
const estimate = { enabled: true, available: true, reason: null, nature: { id: contact, description: 'Venda' }, items: [{ product_id: product, ipi: '1.00', st: '0.50' }], totals: { ipi: '1.00', st: '0.50', total: '11.50' }, data_mode: 'erp_native' };

test('a saved pedido only opened keeps its stored taxes and stays clean; the first change brings the estimate into the total', async () => {
  const sent = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; },
    async documents(path, options = {}) {
      if (options.method === 'PATCH') { sent.push(structuredClone(options.body)); return { kind: 'sales_orders', document: record(options.body.data, { version: 2 }), replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      if (path === `/v1/documentos/sales_orders/${docId}`) return { kind: 'sales_orders', document: record(sent.at(-1)?.data ?? body(), { version: sent.length ? 2 : 1 }), data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
    async fiscalInvoices() { return structuredClone(estimate); },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'sales_orders', record: record(), writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['FiscalOrderTaxEstimate'] });
  try {
    const reservations = node(view, 'SalesOrderReservations'); if (reservations) { reservations.props.onActive(false); await view.flush(); }
    await new Promise(resolve => setTimeout(resolve, 700)); await settle(view);
    assert.match(view.text(), /Total do IPI/, 'the estimate is shown');
    assert.match(view.text(), /Total da vendaR\$ 10,00/, 'the stored total is kept');
    assert.doesNotMatch(view.text(), /Salve as alterações do formulário/, 'opening the pedido does not make it dirty');
    await view.change('doc-delivery', 'Entrega combinada'); await settle(view);
    assert.match(view.text(), /Total da vendaR\$ 11,50/, 'once edited, the estimate is added to the total');
    await view.submit(); await settle(view);
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].data.tax_ipi, sent[0].data.tax_icms_st], ['1.00', '0.50']);
  } finally { view.unmount(); }
});

test('the print lists the Total do IPI and the Total do ICMS ST that the total of the document carries', () => {
  const taxed = record(body({ tax_ipi: '1.00', tax_icms_st: '0.50' }));
  const totals = documentPrintModel(taxed).totals.map(row => [row.label, row.value]);
  assert.deepEqual(totals.slice(-3), [['Total do IPI', 'R$ 1,00'], ['Total ICMS ST', 'R$ 0,50'], ['Total do documento', 'R$ 11,50']]);
  const proposal = { ...normalizeDocument('sales_proposals', body({ tax_ipi: '2.00', tax_icms_st: '0.00' })), id: docId, kind: 'sales_proposals', number: '3', version: 1, status: 'draft', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z',
    source_proposal_id: null, contact_snapshot: { id: contact, name: 'Cliente' }, effect_flags: { finance_active: false, stock_active: false } };
  proposal.items = proposal.items.map(item => ({ ...item, product_snapshot: null }));
  assert.deepEqual(documentPrintModel(proposal).totals.map(row => row.label).slice(-3), ['Total do IPI', 'Total do ICMS ST', 'Total do documento']);
  assert.equal(documentPrintModel(record()).totals.some(row => row.label === 'Total do IPI'), false, 'a document without taxes prints as before');
});

test('without formas cadastradas, a profile that cannot open Formas de pagamento gets the warning without a dead link', async () => {
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'estoque', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; return { items: [], has_more: false }; },
    async documents(path) {
      if (path.endsWith('/pagamento')) return { kind: 'purchase_orders', methods: [], accounts: [], data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, kind: 'purchase_orders', record: null, writable: true, onSaved() {}, onClose() {}, onConverted() {} },
    { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentPaymentHeader'] });
  try {
    await view.click('Adicionar outra parcela');
    view.nodes().find(n => n.type === 'fieldset' && typeof n.props.onMouseEnter === 'function').props.onMouseEnter(); await settle(view);
    assert.match(view.text(), /Não será possível utilizar esta seção pois você não possui forma de pagamentos cadastradas nesta conta\./);
    assert.match(view.text(), /Peça ao administrador ou ao financeiro para cadastrar as formas de pagamento\./);
    assert.equal(view.nodes().some(n => n.type === 'button' && n.props.children === 'Configurar formas'), false);
  } finally { view.unmount(); }
});

test('only the product list reads the Sacola de vendas (the catalog runs the hook for every entity)', async () => {
  const documents = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) {
      if (path === '/v1/cadastros') return { read: ['products', 'warehouses'], write: [], data_mode: 'erp_native' };
      return { entity: 'warehouses', items: [], page: 1, size: 100, total: 0, sort: 'created_desc', data_mode: 'erp_native' };
    },
    async stockPositions() { return { items: [], limit: 100, has_more: false, next_cursor: null, data_mode: 'erp_native', scope: 'stock_warehouse_options' }; },
    async documents(path) { documents.push(path); return { items: [], count: 0, limit: 250, data_mode: 'erp_native', operational_effects: false }; },
  };
  const view = await mountComponent('RealCatalog.tsx', { controller, initialEntity: 'warehouses' }, { expandChildren: ['NativeListLayout'] });
  try { await settle(view); assert.deepEqual(documents, []); } finally { view.unmount(); }
});

test('a pedido from the Sacola de vendas says when the bag could not be emptied', async () => {
  const saved = 'b0000000-0000-4000-8000-0000000002d9';let doc = null;const bagPosts = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'vendas' } }),
    async catalog() { return { read: ['contacts', 'products'], write: [], data_mode: 'erp_native' }; },
    async documents(path, options = {}) {
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'], data_mode: 'erp_native', operational_effects: false };
      if (path === '/v1/documentos/sacola-vendas') { if (options.method) { bagPosts.push(options.body); throw new AccessError(503); }
        return { items: [{ product_id: product, name: 'Produto', code: 'P1', unit: 'UN', price: '1.5000', quantity: '2.000000', active: true, kind: 'P' }], count: 1, limit: 250, data_mode: 'erp_native', operational_effects: false }; }
      if (options.method === 'POST') { doc = { ...normalizeDocument('sales_orders', options.body.data), id: saved, kind: 'sales_orders', number: '5', version: 1, status: 'open', contact_snapshot: { id: contact, name: 'Cliente' }, source_proposal_id: null, effect_flags: { finance_active: false, stock_active: false }, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z' };
        doc.items = doc.items.map(item => ({ ...item, product_snapshot: null })); return { kind: 'sales_orders', document: doc, replayed: false, data_mode: 'erp_native', operational_effects: false }; }
      if (path === `/v1/documentos/sales_orders/${saved}`) return { kind: 'sales_orders', document: doc, data_mode: 'erp_native', operational_effects: false };
      if (path.includes('?')) return { kind: 'sales_orders', items: [], limit: 25, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: '/documentos-empresa?tipo=sales_orders&acao=sacola', expandChildren: ['Editor'] });
  try {
    await settle(view);
    node(view, 'CatalogPicker', n => n.props.entity === 'contacts').props.onSelect({ id: contact, name: 'Cliente', state: 'SP' }); await view.flush();
    await view.submit(); await settle(view);
    assert.equal(bagPosts.length, 1); assert.equal(bagPosts[0].action, 'clear');
    assert.doesNotMatch(view.text(), /Sacola de vendas esvaziada\./, 'the bag was not emptied');
    assert.match(view.text(), /Não foi possível esvaziar a sacola de vendas/);
  } finally { view.unmount(); }
});
