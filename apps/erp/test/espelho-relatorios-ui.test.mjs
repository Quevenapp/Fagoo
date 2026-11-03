import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, AccessError } from './helpers/component-recovery-harness.mjs';
import { barWidths, coverageText, defaultFiscalParams, fiscalReportPath, readFiscalReport, sourcesText } from '../src/lib/fiscal-reports-model.ts';
import { REPORT_CATALOG } from '../src/lib/document-reports-model.ts';
import { originBadge } from '../src/lib/finance-statement-model.ts';
import { STOCK_ORIGIN_LABELS, originHref, originLabel, originReadable, stockLedgerPage, EMPTY_LEDGER_FILTERS } from '../src/lib/stock-model.ts';

// Leva H, lane espelho, with synthetic data only: Relatórios de Notas Fiscais (362: VND-265, VND-266), letras de origem do extrato
// for the contas imported from the Origin (363: FIN-156) and the Tipo de Origem "Origem excluída" of the extrato de estoque (364: EST-072).
const actor = '20000000-0000-4000-8000-000000000362';
const sources = { xml_notes: 1, origin_notes: 1, xml_imported_at: '2026-10-20T12:00:00+00:00', origin_synced_at: '2026-10-21T13:05:00+00:00' };

test('362 model: query per report, period limits, answer paired with the request, coverage, origin and exact bars', () => {
  assert.deepEqual(defaultFiscalParams('nf-difal', '2026-10-21'), { from: '2026-10-01', to: '2026-10-31', state: '', model: '' });
  assert.deepEqual(defaultFiscalParams('nf-evolucao', '2026-10-21'), { from: '2025-11-01', to: '2026-10-21', state: '', model: '' });
  assert.equal(fiscalReportPath('nf-difal', { from: '2026-10-01', to: '2026-10-31', state: 'RJ', model: '55' }), '/v1/documentos/sales_orders/notas-fiscais/difal?from=2026-10-01&to=2026-10-31&state=RJ');
  assert.equal(fiscalReportPath('nf-cliente', { from: '2026-10-01', to: '2026-10-31', state: 'RJ', model: '65' }), '/v1/documentos/sales_orders/notas-fiscais/cliente?from=2026-10-01&to=2026-10-31&model=65');
  assert.throws(() => fiscalReportPath('nf-produto', { from: '2025-01-01', to: '2026-10-31', state: '', model: '' }), /até um ano/);
  assert.equal(fiscalReportPath('nf-evolucao', { from: '2025-01-01', to: '2026-10-31', state: '', model: '' }).startsWith('/v1/documentos/sales_orders/notas-fiscais/evolucao?'), true);
  assert.throws(() => fiscalReportPath('nf-operacao', { from: '2026-10-31', to: '2026-10-01', state: '', model: '' }), /anterior ou igual/);
  const params = { from: '2026-10-01', to: '2026-10-31', state: '', model: '' };
  assert.throws(() => readFiscalReport({ report: 'contact', from: '2026-10-01', to: '2026-10-31', model: null, groups: [], coverage: {}, sources, totals: {} }, 'nf-operacao', params), /REPORT_INVALID/);
  assert.throws(() => readFiscalReport({ report: 'operation', from: '2026-09-01', to: '2026-10-31', model: null, groups: [], coverage: {}, sources, totals: {} }, 'nf-operacao', params), /REPORT_INVALID/);
  assert.deepEqual([coverageText({ notes: 3, covered: 1 }), coverageText({ notes: 0, covered: 0 })], ['1 de 3 notas (33,3%)', 'Nenhuma nota no período.']);
  assert.match(sourcesText(sources).join(' · '), /1 nota de XML importado \(última importação em 20\/10\/2026.*1 nota do espelho do Origin \(sincronizado em 21\/10\/2026, 10:05\)/);
  assert.deepEqual(barWidths([{ amount: '50.00' }, { amount: null }, { amount: '200.00' }, { amount: '0.00' }]), [25, null, 100, 0]);
});

test('362 catalog: the five Relatórios de Notas Fiscais are available cards', () => {
  const cards = REPORT_CATALOG.sales_orders.flatMap(group => group.cards);
  assert.deepEqual(['Notas Fiscais ICMS DIFAL', 'Notas Fiscais por Operação', 'Notas Fiscais por Cliente', 'Notas Fiscais por Produto', 'Evolução do Faturamento'].map(title => cards.find(card => card.title === title)?.id),
    ['nf-difal', 'nf-operacao', 'nf-cliente', 'nf-produto', 'nf-evolucao']);
});

const PORTAL = { 'react-dom': 'export const createPortal=child=>child;' };
function server(reply) {
  const calls = [];
  const controller = {
    getSnapshot: () => ({ phase: 'ready', membership: { user_id: actor, role: 'fiscal' } }), subscribe: () => () => {},
    async documents(path) {
      calls.push(path);
      if (path === '/v1/documentos') return { read: ['sales_orders'], write: [], data_mode: 'erp_native' };
      if (path.includes('/notas-fiscais/')) return reply(path);
      if (path.includes('?')) return { kind: 'sales_orders', items: [], limit: 100, page: 1, order: 'date_desc', has_more: false, next_cursor: null, total_count: 0, total_amount: '0.00', data_mode: 'erp_native', operational_effects: false };
      throw new AccessError(404);
    },
    async catalog(path) { if (path === '/v1/cadastros') return { read: ['contacts', 'products'], write: [] }; return { items: [], has_more: false }; },
    async documentCopy() { throw new AccessError(404); },
  };
  return { calls, controller, reports: () => calls.filter(path => path.includes('/notas-fiscais/')) };
}
const mount = (srv, id) => mountComponent('RealDocuments.tsx', { controller: srv.controller, initialKind: 'sales_orders' }, { location: `/documentos-empresa?tipo=sales_orders&acao=relatorios&relatorio=${id}`, expandChildren: ['DocumentReports', 'FiscalReportView'], modules: PORTAL });

test('362 ICMS DIFAL screen: Origin notes without detail, Indisponível instead of zero, coverage and the last sync', async () => {
  const srv = server(path => { const query = new URLSearchParams(path.split('?')[1]); return { report: 'difal', from: query.get('from'), to: query.get('to'), state: null,
    groups: [{ state: 'BA', notes: 1, detailed: 0, without_detail: 1, amount: '80.00', dest: null, remet: null, fcp: null }, { state: 'RJ', notes: 1, detailed: 1, without_detail: 0, amount: '100.00', dest: '12.34', remet: '0.00', fcp: '2.00' }], group_count: 2,
    rows: [{ origin: 'xml', ref: '40000000-0000-4000-8000-000000000001', number: 321, series: 1, issue_date: '2026-10-05', contact_name: 'Alfa XML', state: 'RJ', amount: '100.00', detail: true, dest: '12.34', remet: '0.00', fcp: '2.00' },
      { origin: 'origin', ref: 'nfe:7002', number: 504, series: 1, issue_date: '2026-10-06', contact_name: 'Gama Origin', state: 'BA', amount: '80.00', detail: false, dest: null, remet: null, fcp: null }], row_count: 2, truncated: false,
    totals: { notes: 2, detailed: 1, amount: '180.00', dest: '12.34', remet: '0.00', fcp: '2.00' }, coverage: { notes: 2, covered: 1 }, sources, data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' }; });
  const view = await mount(srv, 'nf-difal');
  try {
    assert.match(view.text(), /Notas Fiscais ICMS DIFAL/);
    await view.change('fiscal-report-state', 'RJ'); await view.change('fiscal-report-from', '2026-10-01'); await view.change('fiscal-report-to', '2026-10-31'); await view.submit();
    assert.equal(srv.reports().at(-1), '/v1/documentos/sales_orders/notas-fiscais/difal?from=2026-10-01&to=2026-10-31&state=RJ');
    // The answer of another UF is not this request's: dropped.
    assert.match(view.text(), /O relatório recebido não confere com a consulta/);
    await view.change('fiscal-report-state', ''); await view.submit();
    const text = view.text();
    assert.match(text, /Cobertura: 1 de 2 notas \(50%\) — notas com detalhamento do DIFAL/); assert.match(text, /espelho do Origin \(sincronizado em 21\/10\/2026/);
    assert.match(text, /12,34/); assert.match(text, /Indisponível/); assert.match(text, /Sem detalhamento/); assert.match(text, /Espelho do Origin/); assert.match(text, /000321/);
    assert.doesNotMatch(text, /DIFAL indisponível: nenhuma NF-e/, 'one note has detail');
  } finally { view.unmount(); }
});

test('362 Evolução do Faturamento: every month, plain bars, a month without value has no bar and reads Indisponível', async () => {
  const srv = server(path => { const query = new URLSearchParams(path.split('?')[1]); return { report: 'billing', from: query.get('from'), to: query.get('to'), model: query.get('model'),
    groups: [{ key: '2026-08', label: '08/2026', document: null, notes: 0, amount: '0.00', quantity: null, xml_notes: 0, origin_notes: 0 }, { key: '2026-09', label: '09/2026', document: null, notes: 1, amount: null, quantity: null, xml_notes: 0, origin_notes: 1 },
      { key: '2026-10', label: '10/2026', document: null, notes: 2, amount: '485.25', quantity: null, xml_notes: 1, origin_notes: 1 }], group_count: 3, truncated: false,
    totals: { notes: 3, amount: '485.25' }, coverage: { notes: 3, covered: 2 }, sources: { ...sources, xml_notes: 1, origin_notes: 2 }, data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' }; });
  const view = await mount(srv, 'nf-evolucao');
  try {
    await view.change('fiscal-report-from', '2026-08-01'); await view.change('fiscal-report-to', '2026-10-31'); await view.change('fiscal-report-model', '55'); await view.submit();
    assert.equal(srv.reports().at(-1), '/v1/documentos/sales_orders/notas-fiscais/evolucao?from=2026-08-01&to=2026-10-31&model=55');
    const bars = view.nodes().filter(n => String(n.props?.className ?? '').startsWith('fiscal-report-bar-fill'));
    assert.deepEqual(bars.map(n => [n.props.className, n.props.style.height]), [['fiscal-report-bar-fill', '0%'], ['fiscal-report-bar-fill is-missing', '0%'], ['fiscal-report-bar-fill', '100%']]);
    assert.match(view.text(), /485,25/); assert.match(view.text(), /Indisponível/); assert.match(view.text(), /2 de 3 notas \(66,6%\) — notas com valor/);
  } finally { view.unmount(); }
});

test('363 extrato letters: V and N declared by a conta imported from the Origin, P (red) and R otherwise', () => {
  const line = document => ({ line_kind: 'settlement', title_kind: 'receivable', document });
  assert.deepEqual(originBadge(line({ kind: 'sales_orders', number: '15', source: 'origin' })), { text: 'V', color: '#3b7dd8', title: 'Pedido de venda nº 15 no Origin' });
  assert.deepEqual(originBadge(line({ kind: 'fiscal_invoices', number: '321', source: 'origin' })), { text: 'N', color: '#7a5af8', title: 'Nota fiscal nº 321 no Origin' });
  assert.deepEqual(originBadge(line({ kind: 'fiscal_invoices', number: '9' })).title, 'Nota fiscal nº 9');
  assert.deepEqual(originBadge({ ...line(null), title_kind: 'payable' }), { text: 'P', color: '#d9534f', title: 'Pagamento' });
  assert.equal(originBadge(line(null)).text, 'R');
});

test('364 Tipo de Origem: Notas Fiscais and Origem excluída, the deleted note keeps its identification and is not opened', () => {
  assert.equal(STOCK_ORIGIN_LABELS.invoices, 'Notas Fiscais'); assert.equal(STOCK_ORIGIN_LABELS.deleted, 'Origem excluída');
  const product = '50000000-0000-4000-8000-000000000364', note = '60000000-0000-4000-8000-000000000364';
  const row = origin => ({ id: '70000000-0000-4000-8000-000000000364', kind: 'receipt', occurred_on: '2026-10-20', recorded_at_local: '2026-10-20T10:00:00', reason: 'Lançamento', reference: null, created_at: '2026-10-20T13:00:00Z', other_items: 0,
    items: [{ product_id: product, warehouse_id: '80000000-0000-4000-8000-000000000364', quantity: '3', balance_after: '8', unit: 'UN', balance_version: 2 }], origin, revision: 0, note: null, unit_price: null, unit_cost: null, price_source: null, balance: null });
  const page = origin => ({ product_id: product, items: [row(origin)], limit: 100, offset: 0, total: 1, has_more: false, next_offset: null, totals: { entries: '3.000000', exits: '0.000000', current_balance: '8.000000', unit: 'UN' }, data_mode: 'erp_native' });
  const deleted = { type: 'deleted', document_id: note, document_kind: 'nfe_entrada', document_number: '364001', via: 'invoice_stock' };
  const read = stockLedgerPage(page(deleted), product, { ...EMPTY_LEDGER_FILTERS, origin: 'deleted' }, 1).items[0].origin;
  assert.deepEqual(read, deleted);
  assert.equal(originLabel(read), 'NF-e de entrada 364001 (origem excluída)');
  assert.equal(originReadable(read, 'admin'), false); assert.equal(originHref({ ...read, type: 'invoices' }) !== null, true);
  assert.equal(originLabel({ type: 'deleted', document_id: note, document_kind: 'sales_orders', document_number: '12', via: 'document_stock' }), 'Pedido de venda 12 (origem excluída)');
  assert.throws(() => stockLedgerPage(page({ ...deleted, document_id: null }), product, EMPTY_LEDGER_FILTERS, 1), /INVALID_LEDGER/);
  assert.throws(() => stockLedgerPage(page(deleted), product, { ...EMPTY_LEDGER_FILTERS, origin: 'invoices' }, 1), /INVALID_LEDGER/);
});
