/** Financeiro > Faturamento agrupado (SQL 174): clientes com pedidos a faturar, seleção de pedidos, GERAR CONTAS e os gerados.
 * SQL 247: the NF-e de saída of the Brufap join the pedidos (invoice_ids, "Nota Fiscal nº"); older answers read as without notes. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, CONTROL = /[\x00-\x1f\x7f]/, UNSIGNED = /^\d{1,30}$/;
export const GROUPED_BILLING_ACTIONS = ['grouped_billing_generate', 'grouped_billing_delete'];
export const GROUPED_BILLING_BODY_BYTES = 262144;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = (value, nullable = false) => { if (nullable && value === null) return; if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function validate(action, data) {
  if (action === 'grouped_billing_delete') { exact(data, ['id', 'expected_version']); id(data.id); if (!Number.isInteger(data.expected_version) || data.expected_version < 1 || data.expected_version > 2147483647) invalid(); return data; }
  exact(data, ['items', 'category_id'], ['items']); if (data.category_id !== undefined) id(data.category_id, true);
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50) invalid();
  const contacts = new Set(), documents = new Set(), invoices = new Set();
  for (const item of data.items) {
    exact(item, ['contact_id', 'document_ids', 'invoice_ids', 'total_cents', 'condition', 'days'], ['contact_id', 'document_ids', 'total_cents', 'condition', 'days']); id(item.contact_id); if (contacts.has(item.contact_id.toLowerCase())) invalid(); contacts.add(item.contact_id.toLowerCase());
    const notes = item.invoice_ids ?? [];
    if (!Array.isArray(item.document_ids) || !Array.isArray(notes) || item.document_ids.length > 200 || notes.length > 200 || item.document_ids.length + notes.length < 1) invalid();
    for (const document of item.document_ids) { id(document); if (documents.has(document.toLowerCase())) invalid(); documents.add(document.toLowerCase()); }
    for (const invoice of notes) { id(invoice); if (invoices.has(invoice.toLowerCase())) invalid(); invoices.add(invoice.toLowerCase()); }
    if (typeof item.total_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(item.total_cents)) invalid();
    if (typeof item.condition !== 'string' || !item.condition.trim() || item.condition.length > 200 || CONTROL.test(item.condition)) invalid();
    if (!Array.isArray(item.days) || item.days.length < 1 || item.days.length > 120 || item.days.some((value, index) => !Number.isInteger(value) || value < 0 || value > 3650 || (index > 0 && value < item.days[index - 1]))) invalid();
  }
  if (documents.size + invoices.size > 500) invalid();
  return data;
}
/** POST /v1/financeiro/actions/grouped_billing_*; null for other actions. */
export function groupedBillingAction(action, value) {
  if (!GROUPED_BILLING_ACTIONS.includes(action)) return null;
  return { kind: 'execute', action, groupedBilling: true, rpc: 'erp_finance_grouped_billing_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validate(action, value.data) } };
}
function documentsParam(params) {
  const value = params.get('documents'); if (value === null) return null;
  const ids = value.split(','); if (!ids.length || ids.length > 200 || ids.some(item => !UUID.test(item)) || new Set(ids.map(item => item.toLowerCase())).size !== ids.length) invalid();
  return ids.map(item => item.toLowerCase());
}
function period(params, documents) {
  if (documents) { if (params.has('from') || params.has('to')) invalid(); return { from: null, to: null }; }
  const from = day(params.get('from')), to = day(params.get('to')); if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366) invalid();
  return { from, to };
}
/** GET /v1/financeiro/faturamento-agrupado, /documentos and /gerados; null for other paths. */
export function parseGroupedBillingRead(url) {
  const params = url.searchParams, base = '/v1/financeiro/faturamento-agrupado';
  if (![base, `${base}/documentos`, `${base}/gerados`].includes(url.pathname)) return null;
  for (const key of params.keys()) if (params.getAll(key).length !== 1) invalid();
  const page = params.get('page') ?? '1', limit = params.get('limit') ?? '100', query = params.get('q');
  const paging = () => { if (!/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || (query !== null && (query.length > 120 || CONTROL.test(query)))) invalid(); };
  if (url.pathname === base) {
    for (const key of params.keys()) if (!['from', 'to', 'documents', 'q', 'page', 'limit'].includes(key)) invalid(); paging();
    const documents = documentsParam(params), { from, to } = period(params, documents);
    return { kind: 'grouped_candidates', groupedBilling: true, rpc: 'erp_finance_grouped_billing_candidates', args: { p_from: from, p_to: to, p_documents: documents, p_query: query?.trim() || null, p_page: Number(page), p_limit: Number(limit) } };
  }
  if (url.pathname === `${base}/documentos`) {
    for (const key of params.keys()) if (!['contact', 'from', 'to', 'documents'].includes(key)) invalid();
    const contact = params.get('contact'); id(contact); const documents = documentsParam(params), { from, to } = period(params, documents);
    return { kind: 'grouped_documents', groupedBilling: true, rpc: 'erp_finance_grouped_billing_documents', args: { p_contact: contact.toLowerCase(), p_from: from, p_to: to, p_documents: documents } };
  }
  for (const key of params.keys()) if (!['from', 'to', 'q', 'page', 'limit'].includes(key)) invalid(); paging();
  const from = params.has('from') ? day(params.get('from')) : null, to = params.has('to') ? day(params.get('to')) : null; if (from && to && from > to) invalid();
  return { kind: 'grouped_page', groupedBilling: true, rpc: 'erp_finance_grouped_billing_page', args: { p_from: from, p_to: to, p_query: query?.trim() || null, p_page: Number(page), p_limit: Number(limit) } };
}

const isUuid = value => typeof value === 'string' && UUID.test(value);
const unsigned = value => typeof value === 'string' && UNSIGNED.test(value);
const isDay = value => typeof value === 'string' && DAY.test(value);
const str = (value, max) => typeof value === 'string' && value.length <= max;
const pageLength = (value, a) => Array.isArray(value.items) && Number.isSafeInteger(value.total) && value.total >= 0 && value.items.length === Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit));
function projectBilling(value) {
  if (!object(value) || !isUuid(value.id) || !/^[1-9]\d{0,18}$/.test(value.number ?? '') || !isUuid(value.contact_id) || !str(value.contact_name, 200) || !isDay(value.issued_on) || !str(value.condition, 200) || !unsigned(value.total_cents)
    || !['active', 'deleted'].includes(value.state) || !Number.isSafeInteger(value.version) || value.version < 1 || !str(value.created_at, 100) || typeof value.deletable !== 'boolean' || !Array.isArray(value.documents) || !Array.isArray(value.titles)
    || value.documents.length > 200 || value.titles.length < 1 || value.titles.length > 120) upstreamInvalid();
  const notes = value.invoices === undefined ? [] : value.invoices;
  if (!Array.isArray(notes) || notes.length > 200 || value.documents.length + notes.length < 1) upstreamInvalid();
  let documents = 0n, titles = 0n;
  const docs = value.documents.map(item => { if (!object(item) || !isUuid(item.id) || !/^[1-9]\d{0,9}$/.test(item.number ?? '') || !unsigned(item.total_cents)) upstreamInvalid(); documents += BigInt(item.total_cents); return { id: item.id, number: item.number, total_cents: item.total_cents }; });
  const parts = value.titles.map((item, index) => { if (!object(item) || !isUuid(item.id) || item.position !== index + 1 || !isDay(item.due_on) || !unsigned(item.amount_cents) || !unsigned(item.settled_cents) || typeof item.cancelled !== 'boolean') upstreamInvalid(); titles += BigInt(item.amount_cents);
    return { id: item.id, position: item.position, due_on: item.due_on, amount_cents: item.amount_cents, settled_cents: item.settled_cents, cancelled: item.cancelled }; });
  const invoices = notes.map(item => { if (!object(item) || !isUuid(item.id) || (item.number !== null && !/^[1-9]\d{0,8}$/.test(item.number ?? '')) || !unsigned(item.total_cents)) upstreamInvalid(); documents += BigInt(item.total_cents); return { id: item.id, number: item.number, total_cents: item.total_cents }; });
  if (documents !== BigInt(value.total_cents) || titles !== BigInt(value.total_cents)) upstreamInvalid();
  return { id: value.id, number: value.number, contact_id: value.contact_id, contact_name: value.contact_name, issued_on: value.issued_on, condition: value.condition, total_cents: value.total_cents, state: value.state, version: value.version, created_at: value.created_at, deletable: value.deletable, documents: docs, invoices, titles: parts };
}
export function projectGroupedBillingResult(route, value) {
  const a = route.args;
  if (route.kind === 'grouped_candidates') {
    if (value.entity !== 'grouped_billing_candidates' || value.from !== a.p_from || value.to !== a.p_to || value.selected !== (a.p_documents !== null) || value.page !== a.p_page || value.limit !== a.p_limit || !pageLength(value, a)) upstreamInvalid();
    const seen = new Set();
    return { entity: 'grouped_billing_candidates', from: a.p_from, to: a.p_to, selected: value.selected, page: a.p_page, limit: a.p_limit, total: value.total, items: value.items.map(item => {
      const notes = item?.invoices === undefined ? 0 : item.invoices;
      if (!object(item) || !isUuid(item.contact_id) || seen.has(item.contact_id) || !str(item.contact_name, 200) || !Number.isSafeInteger(item.documents) || item.documents < 0 || !Number.isSafeInteger(notes) || notes < 0
        || item.documents + notes < 1 || (a.p_documents !== null && notes !== 0) || !unsigned(item.total_cents)) upstreamInvalid();
      seen.add(item.contact_id); return { contact_id: item.contact_id, contact_name: item.contact_name, documents: item.documents, invoices: notes, total_cents: item.total_cents }; }), data_mode: 'erp_native' };
  }
  if (route.kind === 'grouped_documents') {
    if (value.entity !== 'grouped_billing_documents' || value.contact_id !== a.p_contact || !Number.isSafeInteger(value.total) || !Array.isArray(value.items) || value.items.length > Math.min(500, value.total)) upstreamInvalid();
    return { entity: 'grouped_billing_documents', contact_id: a.p_contact, total: value.total, items: value.items.map(item => {
      const kind = item?.kind === undefined ? 'sales_orders' : item.kind, orders = item?.orders === undefined || item?.orders === null ? [] : item.orders;
      if (!object(item) || !isUuid(item.id) || !['sales_orders', 'fiscal_invoices'].includes(kind) || !(kind === 'sales_orders' ? /^[1-9]\d{0,9}$/.test(item.number ?? '') : item.number === null || /^[1-9]\d{0,8}$/.test(item.number ?? ''))
        || !isDay(item.date) || (a.p_from && (item.date < a.p_from || item.date > a.p_to)) || (a.p_documents && (kind !== 'sales_orders' || !a.p_documents.includes(item.id))) || !unsigned(item.total_cents) || !Number.isSafeInteger(item.version)
        || !Array.isArray(orders) || orders.length > 20 || orders.some(order => !isUuid(order)) || (kind === 'sales_orders' && orders.length)) upstreamInvalid();
      return { id: item.id, kind, number: item.number, date: item.date, total_cents: item.total_cents, version: item.version, orders: [...orders] }; }), data_mode: 'erp_native' };
  }
  if (route.kind === 'grouped_page') {
    if (value.entity !== 'grouped_billings' || value.from !== a.p_from || value.to !== a.p_to || value.page !== a.p_page || value.limit !== a.p_limit || !pageLength(value, a)) upstreamInvalid();
    return { entity: 'grouped_billings', from: a.p_from, to: a.p_to, page: a.p_page, limit: a.p_limit, total: value.total, items: value.items.map(item => { const record = projectBilling(item); if (record.state !== 'active') upstreamInvalid(); return record; }), data_mode: 'erp_native' };
  }
  if (value.action !== route.action || typeof value.replayed !== 'boolean' || value.entity !== 'grouped_billings') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, entity: 'grouped_billings', data_mode: 'erp_native' }, data = a.p_data;
  if (route.action === 'grouped_billing_delete') { if (!object(value.record) || value.record.id !== data.id.toLowerCase() || value.record.deleted !== true) upstreamInvalid(); return { ...output, record: { id: value.record.id, deleted: true } }; }
  if (!Array.isArray(value.items) || value.items.length !== data.items.length) upstreamInvalid();
  const items = value.items.map((item, index) => { const record = projectBilling(item), sent = data.items[index];
    if (record.contact_id !== sent.contact_id.toLowerCase() || record.total_cents !== sent.total_cents || record.titles.length !== sent.days.length || record.documents.length !== sent.document_ids.length
      || record.invoices.length !== (sent.invoice_ids ?? []).length) upstreamInvalid(); return record; });
  return { ...output, items };
}
