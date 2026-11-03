import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { exportRows, EXPORT_HEADER } from '../src/lib/document-list-export.ts';
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

// Lane C review items: "Exportar para a planilha" (XLSX with items), "Gerar ordem serviço" in the pedido form and
// "Imprimir para técnico" in the OS form. No DOM, no network.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = '20000000-0000-4000-8000-000000000166', contact = '30000000-0000-4000-8000-000000000166';
const MODAL = { './Modal': 'export function Modal({title,actions,children}){return r.jsx("section",{"aria-label":title,children:[actions,children]});}' };
const SHEET = { '../lib/spreadsheet-export': 'export const XLSX_TYPE="xlsx";export const downloadFile=(...args)=>globalThis.__sheetDownloads.push(args);export const numberCell=v=>({number:v});export const textCell=v=>({text:v??""});export const toXlsx=(name,rows)=>({name,rows});' };
const exportDoc = (n, items) => ({ id: id(100 + n), number: String(n), date: '2026-09-0' + n, expected_date: null, status: 'open', situation_name: 'Em aberto', contact_name: 'Fornecedor sintético', contact_document: null, order_reference: `OC-${n}`, internal_notes: null, freight: '0.00', discount: '0.00', total: '2.60', items });

test('one row per item with the columns of the pedido; a pedido without items keeps one row', () => {
  const rows = exportRows('purchase_orders', [exportDoc(1, [{ position: 1, code: 'C1', description: 'Item', unit: 'UN', quantity: '2.000000', unit_price: '1.2500', discount_percent: '0.0000', total: '2.50' }]), exportDoc(2, [])]);
  assert.equal(EXPORT_HEADER.length, rows[0].length);
  assert.deepEqual(rows[0].slice(11), ['1', 'C1', 'Item', 'UN', '2', '1.25', '0', '2.50']);
  assert.deepEqual(rows[1].slice(0, 4), ['2', '02/09/2026', '', 'Fornecedor sintético']);
  assert.deepEqual(rows[1].slice(11), ['', '', '', '', '', '', '', '']);
});

test('Exportar para a planilha reads every page of the month and downloads the XLSX with the items', async () => {
  globalThis.__sheetDownloads = [];
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'estoque' } }), subscribe: () => () => {},
    async documents(path, options = {}) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: ['purchase_orders'], write: ['purchase_orders'], data_mode: 'erp_native' };
      if (path.includes('/exportacao?')) { const q = new URLSearchParams(path.split('?')[1]), page = Number(q.get('page'));
        return { kind: 'purchase_orders', date_from: q.get('from'), date_to: q.get('to'), page, size: 25, total_count: 26, has_more: page === 1, items: page === 1 ? [exportDoc(1, [{ position: 1, code: 'C1', description: 'Item', unit: 'UN', quantity: '2.000000', unit_price: '1.2500', discount_percent: '0.0000', total: '2.50' }])] : [exportDoc(2, [])], data_mode: 'erp_native', operational_effects: false }; }
      if (path.includes('?')) { const q = new URLSearchParams(path.split('?')[1]); return { kind: 'purchase_orders', items: [], limit: Number(q.get('limit')), page: Number(q.get('page')), order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false }; }
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: [], write: [] }; return { items: [], has_more: false }; }, async documentCopy() { throw new AccessError(404); },
  };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'purchase_orders' }, { location: '/documentos-empresa?tipo=purchase_orders', expandChildren: ['NativeListLayout', 'DocumentList', 'Modal'], modules: { ...MODAL, ...SHEET } });
  try {
    await view.change('documents-origin', 'brufap'); await view.submit();
    await view.click('Exportar para a planilha');
    await view.change('documents-export-month', '09'); await view.change('documents-export-year', '2026');
    await view.click('Download');
    assert.deepEqual(calls.filter(path => path.includes('/exportacao?')), ['/v1/documentos/purchase_orders/exportacao?from=2026-09-01&to=2026-09-30&page=1', '/v1/documentos/purchase_orders/exportacao?from=2026-09-01&to=2026-09-30&page=2']);
    const [name, sheet, type] = globalThis.__sheetDownloads.at(-1);
    assert.deepEqual([name, type, sheet.name, sheet.rows.length], ['pedidos-de-compra-2026-09.xlsx', 'xlsx', 'Pedidos de compra', 3]);
    assert.deepEqual(sheet.rows[1][16], { number: '1.25' });
    assert.match(view.text(), /Planilha gerada com 2 pedidos e 2 linhas/);
  } finally { view.unmount(); }
});

function editor(kind, status = 'open', extra = {}) {
  const data = { date: '2026-10-20', contact_id: contact, items: kind === 'service_orders' ? [] : [{ id: id(9), product_id: null, description: 'Item', code: null, unit: 'UN', quantity: '1', unit_price: '10', discount_percent: '0', detailed_description: null }], discount_mode: 'amount', discount_value: '0', freight: '0', other_expenses: '0', installments: [] };
  const record = { ...normalizeDocument(kind, data), id: id(1), kind, number: '160', version: 3, status, created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', source_proposal_id: null, contact_snapshot: { id: contact, version: 1, name: 'Cliente sintético' }, effect_flags: { finance_active: false, stock_active: false }, ...extra };
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { role: 'vendas', user_id: actor } }),
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts'], write: [], data_mode: 'erp_native' }; if (path.startsWith('/v1/cadastros/contacts/')) return { entity: 'contacts', record: { id: contact, name: 'Cliente sintético', active: true } }; return { items: [], has_more: false }; },
    async documents(path, options = {}) { calls.push({ path, method: options.method ?? 'GET', body: options.body }); if (path.endsWith('/gerar-os')) return extra.refuse ? Promise.reject(new AccessError(400)) : { sale: { id: id(1) }, service_order: { id: id(90), kind: 'service_orders', number: '17', version: 1, status: 'open' }, replayed: false, data_mode: 'erp_native', operational_effects: false };
      if (path.endsWith('/reservas') || path.includes('reserv')) return { items: [] }; throw new AccessError(404); },
    async stockPositions() { return { items: [] }; }, async documentCopy() { throw new AccessError(404); },
  };
  return { record, calls, controller };
}

test('Gerar ordem serviço in the pedido form: reviewed, sent once and the new OS opens; a refusal explains why', async () => {
  const s = editor('sales_orders');
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'sales_orders', record: s.record, writable: true, onSaved() {}, onClose() {}, onConverted() {},
    access: { read: ['sales_orders', 'service_orders'], write: ['sales_orders', 'service_orders'], data_mode: 'erp_native', operational_effects: false } }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentSalesToService'] });
  try {
    const button = view.nodes().find(n => n.type === 'button' && String(n.props.title).startsWith('Abre a conferência da ordem de serviço'));
    assert.ok(button, 'the form offers Gerar ordem serviço');
    button.props.onClick(); await view.flush();
    assert.match(view.text(), /A ordem de serviço será criada em Em aberto/);
    assert.equal(s.calls.some(call => call.path.endsWith('/gerar-os')), false, 'nothing is created before the confirmation');
    await view.click('Confirmar criação da OS');
    const post = s.calls.find(call => call.path.endsWith('/gerar-os'));
    assert.deepEqual([post.method, post.body.expected_version], ['POST', 3]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(view.location().search)), { tipo: 'service_orders', documento: id(90) });
  } finally { view.unmount(); }
  const refused = editor('sales_orders', 'open', { refuse: true });
  const second = await mountComponent('RealDocuments.tsx', { controller: refused.controller, kind: 'sales_orders', record: refused.record, writable: true, onSaved() {}, onClose() {}, onConverted() {},
    access: { read: ['sales_orders', 'service_orders'], write: ['sales_orders', 'service_orders'], data_mode: 'erp_native', operational_effects: false } }, { componentName: 'Editor', location: '/documentos-empresa', expandChildren: ['DocumentSalesToService'] });
  try {
    second.nodes().find(n => n.type === 'button' && String(n.props.title).startsWith('Abre a conferência da ordem de serviço')).props.onClick(); await second.flush();
    await second.click('Confirmar criação da OS');
    assert.match(second.text(), /o pedido tem nota fiscal vinculada, está cancelado/);
  } finally { second.unmount(); }
});

test('the OS form offers Imprimir para técnico with the technician options', async () => {
  const s = editor('service_orders');
  const view = await mountComponent('RealDocuments.tsx', { controller: s.controller, kind: 'service_orders', record: s.record, writable: true, onSaved() {}, onClose() {}, onConverted() {} }, { componentName: 'Editor', location: '/documentos-empresa' });
  try {
    await view.click('Imprimir para técnico');
    const preview = view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'DocumentPrintPreview');
    assert.equal(preview.props.options.technician, true);
    await view.click('Visualizar impressão');
    assert.equal(view.nodes().find(n => typeof n.type === 'function' && n.type.name === 'DocumentPrintPreview').props.options.technician, undefined);
  } finally { view.unmount(); }
});
