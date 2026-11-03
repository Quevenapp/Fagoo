// Relatórios de vendas e de serviço (202610200130), read-only, under /v1/documentos/{tipo}/<relatório>.
// Every parameter and every field of the answer is checked; amounts and quantities stay exact decimal strings.
import { STATES } from '../../../packages/erp-domain/src/index.mjs';
import { FiscalReportError, fiscalReportOperation, fiscalReportResponse, fiscalReportRoute } from './fiscal-reports.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
// 202610200271: the options of the Relatório de Vendas and the Relatório de Romaneio.
export const REPORT_PATHS = Object.freeze({ 'relatorio-vendas': 'sales_orders', 'relatorio-vendas/opcoes': 'sales_orders', romaneio: 'sales_orders', 'curva-abc': 'sales_orders', 'relatorio-os': 'service_orders', 'relatorio-ocorrencias': 'service_orders' });
export class DocumentReportError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new DocumentReportError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new DocumentReportError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const days = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
const money = value => typeof value === 'string' && /^-?(0|[1-9]\d{0,17})\.\d{2}$/.test(value);
const quantity = value => typeof value === 'string' && /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(value);
const percent = value => typeof value === 'string' && /^(0|[1-9]\d{0,2})\.\d{2}$/.test(value) && Number(value) <= 100;
const label = (value, max = 300) => value === null || (typeof value === 'string' && [...value].length <= max);
const plainText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableQuantity = value => value === null || quantity(value);
const nullableDate = value => value === null || validDate(value);
const short = (value, max) => value === null || (typeof value === 'string' && [...value].length <= max);
/** A comma list of distinct ids (an empty value is the empty list). */
const idList = (raw, max) => { if (raw === '') return []; const list = raw.split(','); if (list.length > max || list.some(value => !UUID.test(value)) || new Set(list.map(value => value.toLowerCase())).size !== list.length) invalid(); return list.map(value => value.toLowerCase()); };
// 374 (leva H): Preço de custo até a data do pedido (cost_until) and Custo aplicado na operação (applied).
export const PROFIT_BASES = Object.freeze(['cost', 'last_purchase', 'last_purchase_until', 'cost_until', 'applied']);

/** `/v1/documentos/{tipo}/{relatorio}` → report name, or null when the path is not a report. */
export function documentReportRoute(path) {
  // Leva H (362): Relatórios de Notas Fiscais (ICMS DIFAL, por Operação, por Cliente, por Produto, Evolução do Faturamento).
  const fiscal = fiscalReportRoute(path);
  if (fiscal) return fiscal;
  const match = /^\/v1\/documentos\/(sales_orders|service_orders)\/(relatorio-vendas|relatorio-vendas\/opcoes|romaneio|curva-abc|relatorio-os|relatorio-ocorrencias)$/.exec(path);
  return match && REPORT_PATHS[match[2]] === match[1] ? { kind: match[1], report: match[2] } : null;
}
const fiscalError = fn => { try { return fn(); } catch (error) { if (error instanceof FiscalReportError) throw new DocumentReportError(error.status, error.code); throw error; } };
export function documentReportOperation(request, route, params) {
  if (route.report.startsWith('notas-fiscais/')) return fiscalError(() => fiscalReportOperation(request, route, params));
  if (request.method !== 'GET') throw new DocumentReportError(405, 'ERP_METHOD_NOT_ALLOWED');
  const allowed = { 'relatorio-vendas': ['from', 'to', 'date_type', 'group', 'subgroup', 'order', 'status', 'include_freight', 'contact_id', 'product_id', 'warehouse_id', 'city', 'state', 'without_invoice', 'first_purchase',
    'seller_id', 'supplier_id', 'categories', 'contact_types', 'contact_untyped', 'tags', 'untagged', 'show_profit', 'profit_base'],
    'relatorio-vendas/opcoes': [], romaneio: ['from', 'to', 'date_type', 'status', 'carrier_id', 'contact_id'], 'curva-abc': ['from', 'to'], 'relatorio-os': ['condicoes'], 'relatorio-ocorrencias': ['from', 'to', 'status'] }[route.report];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  const get = key => params.get(key);
  const period = maximum => { const from = get('from'), to = get('to'); if (!validDate(from) || !validDate(to) || from > to || days(from, to) > maximum) invalid(); return { from, to }; };
  if (route.report === 'relatorio-vendas') {
    const { from, to } = period(731), filters = { from, to };
    const choice = (key, options) => { const value = get(key); if (value === null) return; if (!options.includes(value)) invalid(); filters[key] = value; };
    choice('date_type', ['date', 'invoice', 'expected_date']); choice('group', ['contact', 'product', 'seller', 'district']); choice('subgroup', ['none', 'contact', 'product', 'seller']); choice('order', ['name', 'amount', 'items', 'sales']);
    if ((filters.subgroup ?? 'none') !== 'none' && filters.subgroup === (filters.group ?? 'contact')) invalid();
    for (const key of ['include_freight', 'without_invoice', 'first_purchase', 'contact_untyped', 'untagged', 'show_profit']) { const value = get(key); if (value === null) continue; if (!['true', 'false'].includes(value)) invalid(); filters[key] = value === 'true'; }
    for (const key of ['contact_id', 'product_id', 'warehouse_id', 'seller_id', 'supplier_id']) { const value = get(key); if (value === null) continue; if (!UUID.test(value)) invalid(); filters[key] = value.toLowerCase(); }
    const city = get('city'); if (city !== null) { if (!plainText(city, 100)) invalid(); filters.city = city.trim(); }
    const state = get('state'); if (state !== null) { if (!UFS.includes(state)) invalid(); filters.state = state; }
    const status = get('status'); if (status !== null) { const list = status.split(','); if (list.length > 20 || new Set(list).size !== list.length || list.some(value => !Object.hasOwn(STATES.sales_orders, value))) invalid(); filters.statuses = list; }
    // 271: Categorias (with the subcategorias), Tipo de contato with Sem vínculo, Tags with Incluir produtos sem classificação, Exibir lucro.
    if (get('categories') !== null) { filters.category_ids = idList(get('categories'), 50); if (!filters.category_ids.length) invalid(); }
    if (get('contact_types') !== null) filters.contact_type_ids = idList(get('contact_types'), 100); else if (Object.hasOwn(filters, 'contact_untyped')) invalid();
    if (get('tags') !== null) filters.tag_ids = idList(get('tags'), 100); else if (Object.hasOwn(filters, 'untagged')) invalid();
    const base = get('profit_base'); if (base !== null) { if (filters.show_profit !== true || !PROFIT_BASES.includes(base)) invalid(); filters.profit_base = base; }
    return { rpc: 'erp_document_sales_report', args: { p_filters: filters }, type: 'sales_report' };
  }
  if (route.report === 'relatorio-vendas/opcoes') return { rpc: 'erp_document_sales_report_options', args: {}, type: 'sales_options' };
  if (route.report === 'romaneio') {
    const { from, to } = period(366), filters = { from, to };
    const dateType = get('date_type'); if (dateType !== null) { if (!['date', 'expected_date', 'ship_date'].includes(dateType)) invalid(); filters.date_type = dateType; }
    for (const key of ['carrier_id', 'contact_id']) { const value = get(key); if (value === null) continue; if (!UUID.test(value)) invalid(); filters[key] = value.toLowerCase(); }
    const status = get('status'); if (status !== null) { const list = status.split(','); if (list.length > 20 || new Set(list).size !== list.length || list.some(value => !Object.hasOwn(STATES.sales_orders, value))) invalid(); filters.statuses = list; }
    return { rpc: 'erp_document_sales_romaneio', args: { p_filters: filters }, type: 'romaneio' };
  }
  if (route.report === 'curva-abc') { const { from, to } = period(366); return { rpc: 'erp_document_sales_abc', args: { p_from: from, p_to: to }, type: 'abc' }; }
  if (route.report === 'relatorio-ocorrencias') {
    const { from, to } = period(366), status = get('status');
    if (status !== null && !Object.hasOwn(STATES.service_orders, status)) invalid();
    return { rpc: 'erp_document_service_occurrence_report', args: { p_from: from, p_to: to, p_status: status }, type: 'service_occurrences' };
  }
  let conditions = [];
  const raw = get('condicoes');
  if (raw !== null) {
    if (raw.length > 2000) invalid();
    try { conditions = JSON.parse(raw); } catch { invalid(); }
    const checks = { number: v => /^[1-9]\d{0,9}$/.test(v), name: v => plainText(v, 120), date: validDate, parts: v => /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(v), services: v => /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(v), total: v => /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(v), status: v => Object.hasOwn(STATES.service_orders, v) };
    if (!Array.isArray(conditions) || conditions.length > 10 || conditions.some(c => !object(c) || Object.keys(c).length !== 2 || typeof c.value !== 'string' || !Object.hasOwn(checks, c.column) || !checks[c.column](c.value))) invalid();
    conditions = conditions.map(c => ({ column: c.column, value: c.column === 'name' ? c.value.trim() : c.value }));
  }
  return { rpc: 'erp_document_service_report', args: { p_conditions: conditions }, type: 'service_report' };
}

function group(value, sub, profit) {
  if (!object(value) || typeof value.key !== 'string' || value.key.length > 300 || !label(value.label) || typeof value.label !== 'string' || !count(value.sales) || !quantity(value.items) || !money(value.amount)) bad();
  if (!sub && !Array.isArray(value.subgroups)) bad();
  // 271: Custo and Lucro come exactly when Exibir lucro was asked.
  // (A database before 271 answers without them: they read as null.)
  if (profit ? !money(value.cost) || !money(value.profit) : (value.cost ?? null) !== null || (value.profit ?? null) !== null) bad();
  return { key: value.key, label: value.label, sales: value.sales, items: value.items, amount: value.amount, cost: value.cost ?? null, profit: value.profit ?? null, ...(sub ? {} : { subgroups: value.subgroups.map(item => group(item, true, profit)) }) };
}
const option = (item, key, max) => { if (!object(item) || Object.keys(item).length !== 2 || !UUID.test(item.id ?? '') || !plainText(item[key], max)) bad(); return { id: item.id.toLowerCase(), [key]: item[key] }; };
function address(value) {
  if (!object(value) || !['delivery', 'contact'].includes(value.source)) bad();
  const limits = { name: 200, street: 200, number: 60, complement: 200, district: 120, city: 120, state: 2, postal_code: 9 };
  for (const [key, max] of Object.entries(limits)) if (!short(value[key], max)) bad();
  return { source: value.source, ...Object.fromEntries(Object.keys(limits).map(key => [key, value[key]])) };
}
export function documentReportResponse(value, route, operation) {
  if (route.report.startsWith('notas-fiscais/')) return fiscalError(() => fiscalReportResponse(value, operation));
  if (!object(value) || value.data_mode !== 'erp_native' || value.operational_effects !== false) bad();
  const base = { data_mode: 'erp_native', operational_effects: false, kind: route.kind };
  if (Object.hasOwn(value, 'origin')) {
    if (value.origin !== 'brufap' || !count(value.mirror_excluded_count) || !object(value.coverage) || value.coverage.reason !== 'native_effects_only'
      || value.coverage.partial !== (value.mirror_excluded_count > 0)) bad();
    Object.assign(base, { origin: 'brufap', mirror_excluded_count: value.mirror_excluded_count, coverage: { partial: value.coverage.partial, reason: 'native_effects_only' } });
  }
  if (operation.type === 'sales_report') {
    const f = operation.args.p_filters;
    // A database before 271 answers without date_type, show_profit, cost and profit: accepted only for a query without the 271 parameters.
    const profit = f.show_profit === true, legacy = !Object.hasOwn(value, 'show_profit'), dateType = f.date_type ?? 'date';
    if (legacy && (profit || dateType === 'invoice' || ['seller_id', 'supplier_id', 'category_ids', 'contact_type_ids', 'tag_ids'].some(key => Object.hasOwn(f, key)))) bad();
    if (!object(value.totals)) bad();
    if (value.report !== 'sales' || value.from !== f.from || value.to !== f.to || value.group !== (f.group ?? 'contact') || value.subgroup !== ((f.subgroup ?? 'none') === 'none' ? null : f.subgroup)
      || (!legacy && (value.date_type !== dateType || value.show_profit !== profit || value.profit_base !== (profit ? f.profit_base ?? 'cost' : null) || !count(value.totals.items_without_cost)))
      || (profit ? !money(value.totals.cost) || !money(value.totals.profit) : (value.totals.cost ?? null) !== null || (value.totals.profit ?? null) !== null)
      || typeof value.item_values !== 'boolean' || typeof value.include_freight !== 'boolean' || !Array.isArray(value.groups) || value.groups.length > 2000 || !count(value.group_count)
      || typeof value.truncated !== 'boolean' || value.truncated !== value.group_count > 2000 || !object(value.totals) || !count(value.totals.sales) || !quantity(value.totals.items) || !money(value.totals.amount)) bad();
    const groups = value.groups.map(item => group(item, false, profit));
    if (value.subgroup === null && groups.some(item => item.subgroups.length)) bad();
    return { ...base, report: 'sales', from: value.from, to: value.to, date_type: dateType, group: value.group, subgroup: value.subgroup, item_values: value.item_values, include_freight: value.include_freight,
      show_profit: profit, profit_base: legacy ? null : value.profit_base, groups, group_count: value.group_count, truncated: value.truncated,
      totals: { sales: value.totals.sales, items: value.totals.items, amount: value.totals.amount, cost: value.totals.cost ?? null, profit: value.totals.profit ?? null, items_without_cost: legacy ? 0 : value.totals.items_without_cost } };
  }
  if (operation.type === 'sales_options') {
    if (value.report !== 'sales_options' || !Array.isArray(value.contact_types) || value.contact_types.length > 100 || !Array.isArray(value.tags) || value.tags.length > 500 || !count(value.tag_count) || value.tag_count < value.tags.length
      || !Array.isArray(value.sellers) || value.sellers.length > 500 || !count(value.seller_count) || value.seller_count < value.sellers.length || typeof value.profit_visible !== 'boolean' || typeof value.invoice_visible !== 'boolean') bad();
    return { ...base, report: 'sales_options', contact_types: value.contact_types.map(item => option(item, 'label', 60)), tags: value.tags.map(item => option(item, 'name', 200)), tag_count: value.tag_count,
      sellers: value.sellers.map(item => option(item, 'name', 200)), seller_count: value.seller_count, profit_visible: value.profit_visible, invoice_visible: value.invoice_visible };
  }
  if (operation.type === 'romaneio') {
    const f = operation.args.p_filters;
    if (value.report !== 'romaneio' || value.from !== f.from || value.to !== f.to || value.date_type !== (f.date_type ?? 'date') || !Array.isArray(value.rows) || value.rows.length > 100 || !count(value.row_count)
      || typeof value.truncated !== 'boolean' || value.truncated !== value.row_count > 100 || !object(value.totals) || value.totals.orders !== value.row_count || !quantity(value.totals.volumes) || !quantity(value.totals.gross_weight)) bad();
    const rows = value.rows.map(row => {
      if (!object(row) || !UUID.test(row.id ?? '') || typeof row.number !== 'string' || !/^[1-9]\d{0,9}$/.test(row.number) || !Object.hasOwn(STATES.sales_orders, row.status) || !validDate(row.date) || !nullableDate(row.expected_date) || !nullableDate(row.ship_date)
        || typeof row.contact_name !== 'string' || !label(row.contact_name, 200) || !short(row.phone, 60) || !short(row.carrier, 200) || (row.freight_mode !== null && !/^[0-49]$/.test(row.freight_mode ?? ''))
        || !nullableQuantity(row.volumes) || !nullableQuantity(row.gross_weight) || !Array.isArray(row.items) || row.items.length > 250) bad();
      const items = row.items.map(item => {
        if (!object(item) || !short(item.code, 100) || typeof item.description !== 'string' || !label(item.description, 300) || !short(item.unit, 20) || !quantity(item.quantity)) bad();
        return { code: item.code, description: item.description, unit: item.unit, quantity: item.quantity };
      });
      return { id: row.id, number: row.number, status: row.status, date: row.date, expected_date: row.expected_date, ship_date: row.ship_date, contact_name: row.contact_name, phone: row.phone, address: address(row.address),
        carrier: row.carrier, freight_mode: row.freight_mode, volumes: row.volumes, gross_weight: row.gross_weight, items };
    });
    return { ...base, report: 'romaneio', from: value.from, to: value.to, date_type: value.date_type, rows, row_count: value.row_count, truncated: value.truncated,
      totals: { orders: value.totals.orders, volumes: value.totals.volumes, gross_weight: value.totals.gross_weight } };
  }
  if (operation.type === 'abc') {
    if (value.report !== 'abc' || value.from !== operation.args.p_from || value.to !== operation.args.p_to || !Array.isArray(value.items) || value.items.length > 5000 || !count(value.item_count) || typeof value.truncated !== 'boolean' || !money(value.total)) bad();
    const items = value.items.map((item, index) => {
      if (!object(item) || item.position !== index + 1 || (item.product_id !== null && !UUID.test(item.product_id ?? '')) || typeof item.description !== 'string' || !label(item.description, 200) || !label(item.code, 100)
        || !quantity(item.quantity) || !money(item.amount) || !percent(item.percent) || !percent(item.accumulated) || !['A', 'B', 'C'].includes(item.class)) bad();
      return { position: item.position, product_id: item.product_id, description: item.description, code: item.code, quantity: item.quantity, amount: item.amount, percent: item.percent, accumulated: item.accumulated, class: item.class };
    });
    return { ...base, report: 'abc', from: value.from, to: value.to, items, item_count: value.item_count, truncated: value.truncated, total: value.total };
  }
  if (operation.type === 'service_report') {
    if (value.report !== 'service_orders' || !Array.isArray(value.rows) || value.rows.length > 5000 || !count(value.row_count) || typeof value.truncated !== 'boolean') bad();
    const rows = value.rows.map(row => {
      if (!object(row) || !UUID.test(row.id ?? '') || typeof row.number !== 'string' || !/^[1-9]\d{0,9}$/.test(row.number) || typeof row.name !== 'string' || !label(row.name, 200) || !validDate(row.date)
        || !money(row.parts) || !money(row.services) || !money(row.total) || !Object.hasOwn(STATES.service_orders, row.status)) bad();
      return { id: row.id, number: row.number, name: row.name, date: row.date, parts: row.parts, services: row.services, total: row.total, status: row.status };
    });
    return { ...base, report: 'service_orders', rows, row_count: value.row_count, truncated: value.truncated };
  }
  if (value.report !== 'service_occurrences' || value.from !== operation.args.p_from || value.to !== operation.args.p_to || !Array.isArray(value.rows) || value.rows.length > 5000 || !count(value.row_count) || typeof value.truncated !== 'boolean') bad();
  const rows = value.rows.map(row => {
    if (!object(row) || !UUID.test(row.document_id ?? '') || typeof row.number !== 'string' || !/^[1-9]\d{0,9}$/.test(row.number) || typeof row.name !== 'string' || !label(row.name, 200) || !validDate(row.occurred_on)
      || typeof row.occurred_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.occurred_time) || !label(row.text, 1000) || !Object.hasOwn(STATES.service_orders, row.status_before)
      || (row.status_after !== null && !Object.hasOwn(STATES.service_orders, row.status_after)) || !label(row.actor_name, 120) || typeof row.actor_role !== 'string' || row.actor_role.length > 20) bad();
    return { document_id: row.document_id, number: row.number, name: row.name, occurred_on: row.occurred_on, occurred_time: row.occurred_time, text: row.text, status_before: row.status_before, status_after: row.status_after, actor_name: row.actor_name, actor_role: row.actor_role };
  });
  return { ...base, report: 'service_occurrences', from: value.from, to: value.to, rows, row_count: value.row_count, truncated: value.truncated };
}
