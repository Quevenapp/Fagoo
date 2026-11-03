import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent } from './helpers/component-recovery-harness.mjs';
import { documentMirrorRecord, documentMirrorSummary } from '../../../packages/erp-domain/src/document-mirror.mjs';
import { DOCUMENT_MIRROR_READ_ONLY, documentSelectionTotals, mirrorDecimal } from '../src/lib/document-mirror-model.ts';
import { documentListQuery, documentRowActions, EMPTY_LIST_FILTERS, statusBatchPlan } from '../src/lib/document-list-model.ts';
import { documentListCsv, mergeListPages } from '../src/lib/document-list-export.ts';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kinds = ['sales_orders', 'sales_proposals', 'service_orders', 'purchase_orders'];
const stamp = '2026-10-22T15:40:00Z';
function mirror(kind = 'sales_orders', over = {}) {
  return { id: id(1), kind, origin: 'origin', authority: 'origin', readonly: true, number: '12', version: 2, status: 'source_unknown', date: null, total: '999999999999999999999.123456789', contact_id: null, contact_name: 'Contato observado', created_at: stamp, updated_at: stamp,
    contact_snapshot: { name: 'Contato observado' }, items: [{ id: id(2), position: 1, source_id: '10002', product_id: null, description: 'Item observado', code: null, unit: null, quantity: null, unit_price: '999999999999999999999.123456789', discount_percent: null, total: null, group: kind === 'service_orders' ? 'service' : null, hours: kind === 'service_orders' ? '1.50000001' : null }],
    mirror: { entity: kind, source_id: '12345678901234567890', source_version: '4', source_hash: 'a'.repeat(64), mapper_version: 1, source_number: '12', source_status: '99', source_status_label: 'Aguardando no Origin', observed_at: stamp, source_updated_at: null, source_deleted: false, state: 'pending', partial: true, issues: ['CONTACT_UNLINKED'], reconciliation: { source_total: '999999999999999999999.123456789', source_products_total: null, calculated_total: '0.00', difference: null, state: 'unknown' }, effects: { stock: 'unobservable', finance_count: null, invoice_source_id: null } }, ...over };
}
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const named = (view, name) => view.nodes().filter(node => typeof node.type === 'function' && node.type.name === name);

test('mirror filters retain existing filters, reject foreign origin, and all write/effect/copy actions are disabled for each kind', () => {
  for (const kind of kinds) {
    const row = documentMirrorSummary(mirror(kind), kind), actions = documentRowActions(kind, row, { role: 'admin', writable: true, serviceWritable: true });
    assert.ok(actions.some(action => action.action === 'print' && action.enabled));
    for (const action of actions.filter(action => !['edit', 'print', 'print_detailed'].includes(action.action))) { assert.equal(action.enabled, false, `${kind}: ${action.label}`); assert.equal(action.title, DOCUMENT_MIRROR_READ_ONLY); }
    const query = documentListQuery(kind, { ...EMPTY_LIST_FILTERS, origin: 'origin', query: '12', from: '2026-10-01' });
    assert.equal(query.get('origin'), 'origin'); assert.equal(query.get('q'), '12'); assert.equal(query.get('date_from'), '2026-10-01');
    const plan = statusBatchPlan(kind, [row], 'cancelled', 'Conferência'); assert.equal(plan.eligible.length, 0);
  }
  assert.throws(() => documentListQuery('sales_orders', { ...EMPTY_LIST_FILTERS, origin: 'foreign' }), /origem/);
});

for (const kind of kinds) test(`mirror ${kind} sheet preserves source totals and nulls without native recalculation`, async () => {
  const record = documentMirrorRecord(mirror(kind), kind), view = await mountComponent('DocumentMirrorView.tsx', { record }, { componentName: 'DocumentMirrorSheet' });
  try {
    assert.match(view.text(), /Origem Origin · Somente consulta/); assert.match(view.text(), /ID Origin: 12345678901234567890/); assert.match(view.text(), /22\/10\/2026/);
    assert.match(view.text(), /999\.999\.999\.999\.999\.999\.999,123456789/); assert.match(view.text(), /Cobertura parcial/); assert.match(view.text(), /Não informado/); assert.match(view.text(), /Aguardando no Origin/);
    assert.doesNotMatch(view.text(), /R\$ 0,00/); assert.equal(view.nodes().some(node => ['input', 'textarea', 'select'].includes(node.type)), false);
    if (kind === 'service_orders') assert.match(view.text(), /Horas: 1,50000001/);
  } finally { view.unmount(); }
});

test('selection and CSV preserve precision, separate origins, and omit partial sums', () => {
  const source = documentMirrorSummary(mirror(), 'sales_orders'), missing = { ...source, id: id(3), total: null }, native = { ...source, id: id(4), origin: 'brufap', authority: 'brufap', mirror: null, status: 'open', total: '10.00' };
  const complete = documentSelectionTotals([source, native]); assert.equal(complete.origin.total, source.total); assert.equal(complete.brufap.total, '10.00');
  const totals = documentSelectionTotals([source, missing, native]); assert.deepEqual(totals.origin, { count: 2, known_total_count: 1, total: null });
  const csv = documentListCsv({ kind: 'sales_orders', rows: [source, missing, native], total_count: 3, total_amount: null, origin_totals: totals });
  assert.match(csv, /"Origem";"ID Origin";"Observado em";"Cobertura"/); assert.match(csv, /999999999999999999999,123456789/); assert.match(csv, /"Não informado"/); assert.match(csv, /"Origem Origin";"2";"Total informado";"Não informado"/); assert.match(csv, /"Origem FAGOO";"1";"Total informado";"10,00"/);
  assert.equal(mirrorDecimal(null, true), 'Não informado');
  const page = { kind: 'sales_orders', page: 1, order: 'date_desc', total_count: 2, total_amount: null, origin_totals: totals, items: [source] };
  assert.throws(() => mergeListPages('sales_orders', [page, { ...page, page: 2, items: [native], origin_totals: complete }]), /mudou/);
});

for (const kind of kinds) test(`mixed ${kind} list blocks selected mirror effects and still lets native records act`, async () => {
  const source = documentMirrorSummary(mirror(kind), kind), calls = [], page = { kind, items: [source], page: 1, limit: 100, order: 'date_desc', total_count: 1, total_amount: null, has_more: false, next_cursor: null, data_mode: 'erp_native', operational_effects: false };
  const controller = { getSnapshot: () => ({ membership: { role: 'admin', user_id: id(90) } }), documents: async path => { calls.push(path); throw new Error('Auxiliary read unavailable'); }, catalog: async () => ({ read: [] }) };
  let applied;
  const view = await mountComponent('DocumentList.tsx', { controller, kind, access: { read: [kind], write: kinds }, writable: true, today: '2026-10-22', page, loading: false, filters: EMPTY_LIST_FILTERS, order: 'date_desc', listPage: 1, filterError: '', onApply: value => { applied = value; return true; }, onReload() {}, onPage() {}, onKind() {}, onOrder() {}, onOpen() {}, onClone() {}, onConverted() {}, onNavigate() {} }, { expandChildren: ['NativeListLayout'] });
  try {
    assert.match(view.text(), /Origin · Somente consulta/); assert.match(view.text(), /Aguardando no Origin/); assert.match(view.text(), /999\.999\.999\.999\.999\.999\.999,123456789/);
    await view.change('documents-origin', 'brufap'); await view.submit(); assert.equal(applied.origin, 'brufap');
    view.nodes().find(node => node.type === 'input' && String(node.props['aria-label']).startsWith('Selecionar ') && node.props['aria-label'] !== 'Selecionar todos').props.onClick({ shiftKey: false }); await view.flush();
    const status = view.nodes().find(node => node.type === 'button' && text(node).startsWith('Mudar situação')); assert.equal(status.disabled, true); assert.equal(status.props.title, DOCUMENT_MIRROR_READ_ONLY);
    assert.ok(named(view, 'RowMenu')[0].props.items.every(action => ['Visualizar', 'Imprimir', 'Imprimir c/ detalhes'].includes(action.label) || action.disabled));
    assert.equal(calls.some(path => /\/status|\/financeiro|\/estoque|duplicacao/.test(path)), false);
  } finally { view.unmount(); }
  const native = { ...source, origin: 'brufap', authority: 'brufap', mirror: null, status: 'open', total: '10.00' };
  assert.ok(documentRowActions(kind, native, { role: 'admin', writable: true, serviceWritable: true }).some(action => action.enabled && action.action === 'clone'));
});

test('deep link to a mirror opens the read-only view, and clone deep link never calls duplication', async () => {
  const source = documentMirrorRecord(mirror(), 'sales_orders'), calls = [], controller = { getSnapshot: () => ({ membership: { role: 'admin', user_id: id(90) } }), catalog: async () => ({ read: [] }), documents: async path => {
    calls.push(path); if (path === '/v1/documentos') return { read: ['sales_orders'], write: ['sales_orders'] }; if (path.endsWith(source.id)) return { document: source }; throw new Error('Auxiliary read unavailable');
  }, documentCopy: async path => { calls.push(path); throw new Error('Must not copy mirror'); } };
  const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: 'sales_orders' }, { location: `/documentos-empresa?tipo=sales_orders&documento=${source.id}` });
  try { assert.equal(named(view, 'DocumentMirrorView').length, 1); assert.equal(named(view, 'Editor').length, 0); await view.navigate(`/documentos-empresa?tipo=sales_orders&acao=clonar&origem=${source.id}`); assert.match(view.text(), /Documento do Origin ainda em conversão para o FAGOO/); assert.equal(calls.some(path => path.includes('duplicacao')), false); } finally { view.unmount(); }
});

test('mirror availability keeps the initial list free of native status and period defaults for all four kinds', async () => {
  for (const kind of kinds) {
    const calls = [], controller = { getSnapshot: () => ({ membership: { role: 'admin', user_id: id(90) } }), catalog: async () => ({ read: [] }), documents: async path => {
      calls.push(path);
      if (path === '/v1/documentos') return { read: [kind], write: [kind], mirror_available: true };
      if (path.endsWith('/preferencias-listagem')) return { kind, custom_view: false, columns: kind === 'sales_orders' ? ['date', 'contact', 'total'] : [], default_statuses: ['open'], statuses_saved: true, available_columns: kind === 'sales_orders' ? ['date', 'contact', 'total'] : [], column_limit: 8, version: 1, data_mode: 'erp_native', operational_effects: false };
      if (path.startsWith(`/v1/documentos/${kind}?`)) { const q = new URLSearchParams(path.split('?')[1]); return { kind, items: [documentMirrorSummary(mirror(kind), kind)], limit: 100, page: Number(q.get('page')), order: q.get('order') ?? 'date_desc', total_count: 1, total_amount: null, has_more: false, next_cursor: null, data_mode: 'erp_native', operational_effects: false }; }
      throw new Error('Auxiliary read unavailable');
    } };
    const view = await mountComponent('RealDocuments.tsx', { controller, initialKind: kind }, { location: `/documentos-empresa?tipo=${kind}` });
    try {
      const requests = calls.filter(path => path.startsWith(`/v1/documentos/${kind}?`)); assert.ok(requests.length, kind);
      for (const path of requests) { const params = new URLSearchParams(path.split('?')[1]); for (const name of ['status', 'statuses', 'date_from', 'date_to']) assert.equal(params.has(name), false, `${kind}: ${name}`); }
      const list = named(view, 'DocumentList')[0]; assert.equal(list.props.page.items[0].origin, 'origin');
    } finally { view.unmount(); }
  }
});

test('mirror batch and list printing preserve source data without company lookup or native totals', async () => {
  const previous = globalThis.document, previousElement = globalThis.HTMLElement; globalThis.HTMLElement ??= class {};
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, body: { append() {}, children: [], style: {}, classList: { add() {}, remove() {} } }, createElement: () => ({ remove() {} }) };
  const source = documentMirrorRecord(mirror('service_orders', { contact_name: null, contact_snapshot: null }), 'service_orders');
  try {
    const calls = [], batch = await mountComponent('DocumentBatchPrint.tsx', { records: [source], controller: { company: async () => { calls.push('company'); throw new Error('No native company'); } }, onClose() {}, options: { prefs: { headerType: 'personalizado' }, explode: true } }, { expandChildren: ['DocumentMirrorSheet'] });
    try { assert.match(batch.text(), /999\.999\.999\.999\.999\.999\.999,123456789/); assert.match(batch.text(), /Origem Origin/); assert.equal(calls.length, 0); } finally { batch.unmount(); }
    const snapshot = { kind: 'service_orders', rows: [source], total_count: 1, total_amount: null, origin_totals: documentSelectionTotals([source]) };
    const list = await mountComponent('DocumentListPrint.tsx', { snapshot, filters: ['Origem: Origin'], onClose() {} }, { expandChildren: ['DocumentOriginTotals'] });
    try { assert.match(list.text(), /Origin · ID 12345678901234567890 · Observado em/); assert.match(list.text(), /Parcial/); assert.match(list.text(), /Não informado/); assert.match(list.text(), /999\.999\.999\.999\.999\.999\.999,123456789/); } finally { list.unmount(); }
    assert.match(documentListCsv(snapshot), /"Não informado"/);
  } finally { globalThis.document = previous; globalThis.HTMLElement = previousElement; }
});
