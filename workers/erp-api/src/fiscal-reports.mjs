// Relatórios de Notas Fiscais of the Relatórios de vendas (leva H, 362), read-only, under /v1/documentos/sales_orders/notas-fiscais/<relatório>:
// ICMS DIFAL (VND-265) and por Operação, por Cliente, por Produto and Evolução do Faturamento (VND-266), over the real notes
// (imported XMLs and the Origin mirror). Every parameter and every field of the answer is checked; amounts stay exact decimal strings,
// and a missing value stays null (indisponível), never zero.
export class FiscalReportError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new FiscalReportError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new FiscalReportError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validDate = value => typeof value === 'string' && /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const days = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const money = value => typeof value === 'string' && /^-?(0|[1-9]\d{0,17})\.\d{2}$/.test(value);
const nullableMoney = value => value === null || money(value);
const quantity = value => value === null || (typeof value === 'string' && /^(0|[1-9]\d{0,17})(\.\d{1,10})?$/.test(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => value === null || (typeof value === 'string' && [...value].length <= max && !/[\x00-\x1f\x7f]/.test(value));
const timestamp = value => value === null || (typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
export const FISCAL_REPORT_UFS = Object.freeze(['AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO']);
/** Path segment → report of erp_fiscal_report_invoices (difal has its own function). */
export const FISCAL_REPORTS = Object.freeze({ difal: 'difal', operacao: 'operation', cliente: 'contact', produto: 'product', evolucao: 'billing' });

export const fiscalReportRoute = path => {
  const match = /^\/v1\/documentos\/sales_orders\/notas-fiscais\/(difal|operacao|cliente|produto|evolucao)$/.exec(path);
  return match ? { kind: 'sales_orders', report: `notas-fiscais/${match[1]}` } : null;
};
export function fiscalReportOperation(request, route, params) {
  if (request.method !== 'GET') throw new FiscalReportError(405, 'ERP_METHOD_NOT_ALLOWED');
  const fiscal = route.report.slice('notas-fiscais/'.length), difal = fiscal === 'difal', allowed = difal ? ['from', 'to', 'state'] : ['from', 'to', 'model'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  const from = params.get('from'), to = params.get('to'), report = FISCAL_REPORTS[fiscal];
  if (!report) invalid();
  if (!validDate(from) || !validDate(to) || from > to || days(from, to) > (report === 'billing' ? 731 : 366)) invalid();
  if (difal) {
    const state = params.get('state');
    if (state !== null && state !== 'SEM' && !FISCAL_REPORT_UFS.includes(state)) invalid();
    return { rpc: 'erp_fiscal_report_difal', args: { p_from: from, p_to: to, p_state: state }, type: 'fiscal_difal' };
  }
  const model = params.get('model');
  if (model !== null && !['55', '65'].includes(model)) invalid();
  return { rpc: 'erp_fiscal_report_invoices', args: { p_report: report, p_from: from, p_to: to, p_model: model }, type: 'fiscal_invoices' };
}

function sources(value, notes) {
  if (!exact(value, ['xml_notes', 'origin_notes', 'xml_imported_at', 'origin_synced_at']) || !count(value.xml_notes) || !count(value.origin_notes)
    || value.xml_notes + value.origin_notes !== notes || !timestamp(value.xml_imported_at) || !timestamp(value.origin_synced_at)) bad();
  return { xml_notes: value.xml_notes, origin_notes: value.origin_notes, xml_imported_at: value.xml_imported_at, origin_synced_at: value.origin_synced_at };
}
function coverage(value, notes) {
  if (!exact(value, ['notes', 'covered']) || value.notes !== notes || !count(value.covered) || value.covered > notes) bad();
  return { notes: value.notes, covered: value.covered };
}
export function fiscalReportResponse(value, operation) {
  if (!object(value) || value.data_mode !== 'erp_native' || value.operational_effects !== false) bad();
  const a = operation.args, base = { data_mode: 'erp_native', operational_effects: false, kind: 'sales_orders' };
  if (operation.type === 'fiscal_difal') {
    if (!exact(value, ['report', 'from', 'to', 'state', 'groups', 'group_count', 'rows', 'row_count', 'truncated', 'totals', 'coverage', 'sources', 'data_mode', 'operational_effects'])
      || value.report !== 'difal' || value.from !== a.p_from || value.to !== a.p_to || value.state !== a.p_state || !Array.isArray(value.groups) || value.groups.length !== value.group_count || value.group_count > 29
      || !Array.isArray(value.rows) || !count(value.row_count) || value.rows.length !== Math.min(value.row_count, 1000) || value.truncated !== value.row_count > 1000) bad();
    const t = value.totals;
    if (!exact(t, ['notes', 'detailed', 'amount', 'dest', 'remet', 'fcp']) || t.notes !== value.row_count || !count(t.detailed) || t.detailed > t.notes || !nullableMoney(t.amount)
      || ['dest', 'remet', 'fcp'].some(key => t.detailed === 0 ? t[key] !== null : !money(t[key]))) bad();
    const seen = new Set();
    const groups = value.groups.map(g => {
      if (!exact(g, ['state', 'notes', 'detailed', 'without_detail', 'amount', 'dest', 'remet', 'fcp']) || (g.state !== null && !FISCAL_REPORT_UFS.includes(g.state)) || seen.has(g.state)
        || !count(g.notes) || g.notes < 1 || !count(g.detailed) || g.detailed > g.notes || g.without_detail !== g.notes - g.detailed || !nullableMoney(g.amount)
        || ['dest', 'remet', 'fcp'].some(key => g.detailed === 0 ? g[key] !== null : !money(g[key])) || (a.p_state !== null && (g.state ?? 'SEM') !== a.p_state)) bad();
      seen.add(g.state);
      return { state: g.state, notes: g.notes, detailed: g.detailed, without_detail: g.without_detail, amount: g.amount, dest: g.dest, remet: g.remet, fcp: g.fcp };
    });
    if (groups.reduce((sum, g) => sum + g.notes, 0) !== t.notes || groups.reduce((sum, g) => sum + g.detailed, 0) !== t.detailed) bad();
    const rows = value.rows.map(r => {
      if (!exact(r, ['origin', 'ref', 'number', 'series', 'issue_date', 'contact_name', 'state', 'amount', 'detail', 'dest', 'remet', 'fcp']) || !['xml', 'origin'].includes(r.origin)
        || typeof r.ref !== 'string' || !(r.origin === 'xml' ? /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.ref) : /^nfe:[0-9]{1,40}$/.test(r.ref))
        || (r.number !== null && !(Number.isSafeInteger(r.number) && r.number > 0 && r.number <= 999999999)) || (r.series !== null && !(Number.isSafeInteger(r.series) && r.series >= 0 && r.series <= 999))
        || !validDate(r.issue_date) || r.issue_date < a.p_from || r.issue_date > a.p_to || !text(r.contact_name, 200) || (r.state !== null && !FISCAL_REPORT_UFS.includes(r.state))
        || !nullableMoney(r.amount) || typeof r.detail !== 'boolean' || (r.detail && r.origin !== 'xml') || ['dest', 'remet', 'fcp'].some(key => r.detail ? !money(r[key]) : r[key] !== null)) bad();
      return { origin: r.origin, ref: r.ref, number: r.number, series: r.series, issue_date: r.issue_date, contact_name: r.contact_name, state: r.state, amount: r.amount, detail: r.detail, dest: r.dest, remet: r.remet, fcp: r.fcp };
    });
    return { ...base, report: 'difal', from: value.from, to: value.to, state: value.state, groups, group_count: value.group_count, rows, row_count: value.row_count, truncated: value.truncated,
      totals: { notes: t.notes, detailed: t.detailed, amount: t.amount, dest: t.dest, remet: t.remet, fcp: t.fcp }, coverage: coverage(value.coverage, t.notes), sources: sources(value.sources, t.notes) };
  }
  if (!exact(value, ['report', 'from', 'to', 'model', 'groups', 'group_count', 'truncated', 'totals', 'coverage', 'sources', 'data_mode', 'operational_effects'])
    || value.report !== a.p_report || value.from !== a.p_from || value.to !== a.p_to || value.model !== a.p_model || !Array.isArray(value.groups) || !count(value.group_count)
    || value.groups.length !== Math.min(value.group_count, 2000) || value.truncated !== value.group_count > 2000) bad();
  const t = value.totals;
  if (!exact(t, ['notes', 'amount']) || !count(t.notes) || !nullableMoney(t.amount) || (t.notes === 0 && t.amount !== '0.00')) bad();
  const billing = a.p_report === 'billing', product = a.p_report === 'product', seen = new Set();
  const groups = value.groups.map((g, index) => {
    if (!exact(g, ['key', 'label', 'document', 'notes', 'amount', 'quantity', 'xml_notes', 'origin_notes']) || typeof g.key !== 'string' || !g.key || [...g.key].length > 400 || seen.has(g.key)
      || !text(g.label, 300) || !text(g.document, 60) || !count(g.notes) || !count(g.xml_notes) || !count(g.origin_notes) || (!product && g.xml_notes + g.origin_notes !== g.notes)
      || (product && (g.xml_notes + g.origin_notes < g.notes || g.notes < 1)) || !nullableMoney(g.amount) || (g.notes === 0 && g.amount !== '0.00') || !quantity(g.quantity) || (!product && g.quantity !== null)
      || (billing ? !/^\d{4}-(0[1-9]|1[0-2])$/.test(g.key) || g.label !== `${g.key.slice(5)}/${g.key.slice(0, 4)}` || g.document !== null || (index > 0 && g.key <= value.groups[index - 1].key) : g.notes < 1)
      || (a.p_report === 'operation' && g.document !== null)) bad();
    seen.add(g.key);
    return { key: g.key, label: g.label, document: g.document, notes: g.notes, amount: g.amount, quantity: g.quantity, xml_notes: g.xml_notes, origin_notes: g.origin_notes };
  });
  if (billing && (groups.length < 1 || groups[0].key !== a.p_from.slice(0, 7) || groups.at(-1).key !== a.p_to.slice(0, 7) || groups.reduce((sum, g) => sum + g.notes, 0) !== t.notes)) bad();
  if (!product && !value.truncated && groups.reduce((sum, g) => sum + g.notes, 0) !== t.notes) bad();
  return { ...base, report: value.report, from: value.from, to: value.to, model: value.model, groups, group_count: value.group_count, truncated: value.truncated,
    totals: { notes: t.notes, amount: t.amount }, coverage: coverage(value.coverage, t.notes), sources: sources(value.sources, t.notes) };
}
