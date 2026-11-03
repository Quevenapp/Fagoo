/** Contas lançadas pelas notas fiscais do Brufap (SQL 247): ⋮ Lançar contas / Estornar contas of the NF-e, NFC-e and entry notes and
 * the letra C of the lists. GET /v1/financeiro/notas/{id}/contas[/previa?versao=&categoria=&conta=], GET /v1/financeiro/notas-contas?ids=
 * and POST /v1/financeiro/actions/invoice_finance_(post|reverse). Nothing here emits or changes the note; SQL is the authority. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, HASH = /^[a-f0-9]{64}$/, CENTS = /^\d{1,15}$/, CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const INVOICE_FINANCE_ACTIONS = ['invoice_finance_post', 'invoice_finance_reverse'];
const BLOCKED = ['erp_finance_invoice_deleted', 'erp_finance_invoice_ineligible_state', 'erp_finance_invoice_already_posted', 'erp_finance_invoice_grouped', 'erp_finance_invoice_order_posted', 'erp_finance_invalid_contact', 'erp_finance_invoice_zero_total'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const uuid = (value, nullable = false) => { if (nullable && value === null) return null; if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); return value; };
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isDay = value => typeof value === 'string' && DAY.test(value);
const cents = value => typeof value === 'string' && CENTS.test(value);
const number = value => value === null || (typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value));
const text = (value, max, nullable = true) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);

/** POST /v1/financeiro/actions/invoice_finance_*; null for other actions. */
export function invoiceFinanceAction(action, value) {
  if (!INVOICE_FINANCE_ACTIONS.includes(action)) return null;
  const data = value.data;
  if (action === 'invoice_finance_post') {
    exact(data, ['invoice_id', 'expected_version', 'preview_hash', 'category_id', 'account_id'], ['invoice_id', 'expected_version', 'preview_hash']);
    if (typeof data.preview_hash !== 'string' || !HASH.test(data.preview_hash)) invalid();
    const body = { invoice_id: uuid(data.invoice_id), expected_version: version(data.expected_version), preview_hash: data.preview_hash, category_id: data.category_id === undefined ? null : uuid(data.category_id, true), account_id: data.account_id === undefined ? null : uuid(data.account_id, true) };
    return { kind: 'execute', action, invoiceFinance: true, rpc: 'erp_finance_invoice_finance_post', args: { p_command_id: value.command_id, p_data: body } };
  }
  exact(data, ['invoice_id', 'posting_id', 'expected_version', 'titles', 'reason']);
  if (!Array.isArray(data.titles) || data.titles.length < 1 || data.titles.length > 120) invalid();
  const titles = data.titles.map(item => { exact(item, ['id', 'version']); return { id: uuid(item.id), version: version(item.version) }; });
  if (new Set(titles.map(item => item.id)).size !== titles.length) invalid();
  if (typeof data.reason !== 'string' || data.reason.trim().length < 3 || data.reason.length > 1000 || CONTROL.test(data.reason)) invalid();
  const body = { invoice_id: uuid(data.invoice_id), posting_id: uuid(data.posting_id), expected_version: version(data.expected_version), titles, reason: data.reason.trim() };
  return { kind: 'execute', action, invoiceFinance: true, rpc: 'erp_finance_invoice_finance_reverse', args: { p_command_id: value.command_id, p_data: body } };
}

/** GET reads of the contas of a note; null for other paths. */
export function parseInvoiceFinanceRead(url) {
  const params = url.searchParams;
  for (const key of params.keys()) if (params.getAll(key).length !== 1) invalid();
  if (url.pathname === '/v1/financeiro/notas-contas') {
    for (const key of params.keys()) if (key !== 'ids') invalid();
    const ids = (params.get('ids') ?? '').split(',');
    if (!ids.length || ids.length > 100 || ids.some(id => !UUID.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) invalid();
    return { kind: 'invoice_flags', invoiceFinance: true, rpc: 'erp_finance_invoice_finance_flags', args: { p_ids: ids.map(id => id.toLowerCase()) } };
  }
  // SQL 375 (leva H): the contas already lançadas by the pedidos of the note, which the note references instead of lançar others.
  const orders = /^\/v1\/financeiro\/notas\/([^/]+)\/contas-pedido$/.exec(url.pathname);
  if (orders) { if (!UUID.test(orders[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'invoice_order_titles', invoiceFinance: true, rpc: 'erp_finance_invoice_order_titles', args: { p_invoice_id: orders[1].toLowerCase() } }; }
  const match = /^\/v1\/financeiro\/notas\/([^/]+)\/contas(\/previa)?$/.exec(url.pathname);
  if (!match) return null;
  if (!UUID.test(match[1])) throw new FinanceError(404, 'ERP_NOT_FOUND');
  const id = match[1].toLowerCase();
  if (!match[2]) { if (url.search) invalid(); return { kind: 'invoice_finance', invoiceFinance: true, rpc: 'erp_finance_invoice_finance_get', args: { p_invoice_id: id } }; }
  for (const key of params.keys()) if (!['versao', 'categoria', 'conta'].includes(key)) invalid();
  const versao = params.get('versao'); if (!/^[1-9]\d{0,9}$/.test(versao ?? '') || Number(versao) > 2147483647) invalid();
  const category = params.get('categoria'), account = params.get('conta');
  if ((category !== null && !UUID.test(category)) || (account !== null && !UUID.test(account))) invalid();
  return { kind: 'invoice_preview', invoiceFinance: true, rpc: 'erp_finance_invoice_finance_preview',
    args: { p_invoice_id: id, p_expected_version: Number(versao), p_category_id: category?.toLowerCase() ?? null, p_account_id: account?.toLowerCase() ?? null } };
}

function projectSummary(value, invoiceId) {
  if (!object(value) || !isUuid(value.id) || value.invoice_id !== invoiceId || !Number.isSafeInteger(value.source_invoice_version) || value.source_invoice_version < 1 || !isUuid(value.group_id)
    || !['active', 'reversed'].includes(value.state) || !Number.isSafeInteger(value.version) || value.version < 1 || !['manual', 'automatic'].includes(value.origin)
    || !['receivable', 'payable'].includes(value.direction) || !['55', '65'].includes(value.model) || !number(value.number) || !cents(value.total_cents)
    || !Number.isSafeInteger(value.installments) || value.installments < 1 || value.installments > 120 || (value.category_id !== null && !isUuid(value.category_id))
    || !text(value.created_at, 64, false) || !text(value.reversed_at, 64) || !text(value.reason, 1000) || (value.state === 'active') !== (value.reversed_at === null)) upstreamInvalid();
  return { id: value.id, invoice_id: value.invoice_id, source_invoice_version: value.source_invoice_version, group_id: value.group_id, state: value.state, version: value.version, origin: value.origin,
    direction: value.direction, model: value.model, number: value.number, total_cents: value.total_cents, installments: value.installments, category_id: value.category_id,
    created_at: value.created_at, reversed_at: value.reversed_at, reason: value.reason };
}
function projectTitles(value, summary) {
  if (!Array.isArray(value) || value.length > 120) upstreamInvalid();
  const titles = value.map((item, index) => {
    if (!object(item) || !isUuid(item.id) || item.position !== index + 1 || !Number.isSafeInteger(item.version) || item.version < 1 || !isDay(item.due_on) || !cents(item.amount_cents) || !cents(item.settled_cents)
      || !cents(item.balance_cents) || BigInt(item.balance_cents) !== BigInt(item.amount_cents) - BigInt(item.settled_cents) || typeof item.cancelled !== 'boolean' || typeof item.cnab_linked !== 'boolean'
      || [item.category_id, item.account_id, item.payment_method_id].some(id => id !== null && !isUuid(id)) || !text(item.description, 240, false)) upstreamInvalid();
    return { id: item.id, position: item.position, version: item.version, due_on: item.due_on, amount_cents: item.amount_cents, settled_cents: item.settled_cents, balance_cents: item.balance_cents,
      cancelled: item.cancelled, category_id: item.category_id, account_id: item.account_id, payment_method_id: item.payment_method_id, description: item.description, cnab_linked: item.cnab_linked };
  });
  if (summary && (titles.length !== summary.installments || titles.reduce((sum, item) => sum + BigInt(item.amount_cents), 0n) !== BigInt(summary.total_cents))) upstreamInvalid();
  return titles;
}
function projectPreview(value, args) {
  if (!object(value) || value.invoice_id !== args.p_invoice_id || value.invoice_version !== args.p_expected_version || !['55', '65'].includes(value.model) || !['receivable', 'payable'].includes(value.direction)
    || !number(value.number) || !isDay(value.issued_on) || !isUuid(value.contact_id) || !text(value.contact_name, 200, false) || !cents(value.total_cents) || typeof value.preview_hash !== 'string' || !HASH.test(value.preview_hash)
    || (value.category_id !== null && !isUuid(value.category_id)) || !text(value.category_name, 200) || (value.account_id !== null && !isUuid(value.account_id)) || !text(value.account_name, 200)
    || (args.p_category_id && value.category_id !== args.p_category_id) || (args.p_account_id && value.account_id !== args.p_account_id)
    || (value.seller_id !== null && (!isUuid(value.seller_id) || value.direction !== 'receivable')) || !Array.isArray(value.installments) || value.installments.length < 1 || value.installments.length > 120) upstreamInvalid();
  let sum = 0n;
  const installments = value.installments.map((item, index) => {
    if (!object(item) || item.position !== index + 1 || !cents(item.amount_cents) || item.amount_cents === '0' || !isDay(item.due_on) || item.due_on < value.issued_on || (item.method !== null && (typeof item.method !== 'string' || !/^\d{2}$/.test(item.method)))
      || [item.payment_method_id, item.account_id].some(id => id !== null && !isUuid(id)) || !text(item.payment_method_name, 100) || !text(item.account_name, 200)
      || (item.payment_method_id === null) !== (item.payment_method_name === null) || (item.account_id === null) !== (item.account_name === null)) upstreamInvalid();
    sum += BigInt(item.amount_cents);
    return { position: item.position, amount_cents: item.amount_cents, due_on: item.due_on, method: item.method, payment_method_id: item.payment_method_id, payment_method_name: item.payment_method_name, account_id: item.account_id, account_name: item.account_name };
  });
  if (sum !== BigInt(value.total_cents)) upstreamInvalid();
  return { invoice_id: value.invoice_id, invoice_version: value.invoice_version, model: value.model, direction: value.direction, number: value.number, issued_on: value.issued_on, contact_id: value.contact_id,
    contact_name: value.contact_name, total_cents: value.total_cents, category_id: value.category_id, category_name: value.category_name, account_id: value.account_id, account_name: value.account_name,
    seller_id: value.seller_id, installments, preview_hash: value.preview_hash };
}

export function projectInvoiceFinanceResult(route, value) {
  const a = route.args;
  if (route.kind === 'invoice_order_titles') {
    if (value.entity !== 'invoice_order_titles' || value.operational_effects !== false || value.invoice_id !== a.p_invoice_id || !(value.owner === null || ['invoice', 'orders'].includes(value.owner))
      || !Array.isArray(value.orders) || value.orders.length > 100 || (value.owner !== 'orders') !== (value.orders.length === 0)) upstreamInvalid();
    const orders = value.orders.map(order => {
      const e = order?.effect;
      if (!object(order) || !UUID.test(order.document_id ?? '') || !['sales_orders', 'service_orders'].includes(order.kind) || typeof order.number !== 'string' || !/^[1-9]\d{0,9}$/.test(order.number)
        || !object(e) || !['document', 'grouped'].includes(e.owner) || !UUID.test(e.id ?? '') || !Array.isArray(e.titles) || e.titles.length > 120) upstreamInvalid();
      return { document_id: order.document_id, kind: order.kind, number: order.number, effect: { owner: e.owner, id: e.id, titles: e.titles.map(t => {
        if (!object(t) || !UUID.test(t.id ?? '') || !Number.isInteger(t.position) || !isDay(t.due_on) || !CENTS.test(t.amount_cents ?? '') || !CENTS.test(t.settled_cents ?? '') || typeof t.cancelled !== 'boolean'
          || (t.account_id !== null && !UUID.test(t.account_id ?? ''))) upstreamInvalid();
        return { id: t.id, position: t.position, due_on: t.due_on, amount_cents: t.amount_cents, settled_cents: t.settled_cents, cancelled: t.cancelled, account_id: t.account_id }; }) } };
    });
    return { entity: 'invoice_order_titles', invoice_id: value.invoice_id, owner: value.owner, orders, data_mode: 'erp_native', operational_effects: false };
  }
  if (route.kind === 'invoice_flags') {
    if (value.entity !== 'invoice_finance_flags' || !Array.isArray(value.items) || value.items.length > a.p_ids.length) upstreamInvalid();
    const seen = new Set();
    return { entity: 'invoice_finance_flags', items: value.items.map(item => {
      if (!object(item) || !a.p_ids.includes(item.invoice_id) || seen.has(item.invoice_id) || typeof item.posted !== 'boolean' || typeof item.grouped !== 'boolean' || !Array.isArray(item.category_ids)
        || item.category_ids.length > 120 || item.category_ids.some(id => !isUuid(id)) || (!item.posted && item.category_ids.length)) upstreamInvalid();
      seen.add(item.invoice_id); return { invoice_id: item.invoice_id, posted: item.posted, grouped: item.grouped, category_ids: [...item.category_ids] };
    }), data_mode: 'erp_native' };
  }
  if (route.kind === 'invoice_preview') {
    if (value.cash_movement_performed !== false) upstreamInvalid();
    return { preview: projectPreview(value.preview, a), data_mode: 'erp_native', cash_movement_performed: false };
  }
  if (route.kind === 'invoice_finance') {
    const invoice = value.invoice;
    if (value.entity !== 'invoice_finance' || value.cash_movement_performed !== false || !object(invoice) || invoice.id !== a.p_invoice_id || !Number.isSafeInteger(invoice.version) || invoice.version < 1
      || !['55', '65'].includes(invoice.model) || !['0', '1'].includes(invoice.direction) || invoice.kind !== (invoice.direction === '0' ? 'payable' : 'receivable') || !Number.isSafeInteger(invoice.series)
      || !number(invoice.number) || !Number.isSafeInteger(invoice.status) || !isDay(invoice.issue_date) || !cents(invoice.total_cents) || (invoice.contact_id !== null && !isUuid(invoice.contact_id))
      || !text(invoice.contact_name, 200) || typeof invoice.deleted !== 'boolean' || typeof value.writable !== 'boolean' || (value.blocked_reason !== null && !BLOCKED.includes(value.blocked_reason))
      || !Array.isArray(value.orders_posted) || value.orders_posted.length > 20 || !Array.isArray(value.postings) || value.postings.length > 20
      || (value.grouped_billing !== null && (!object(value.grouped_billing) || !isUuid(value.grouped_billing.id) || !/^[1-9]\d{0,18}$/.test(value.grouped_billing.number ?? '')))) upstreamInvalid();
    const active = value.active_posting === null ? null : projectSummary(value.active_posting, a.p_invoice_id);
    if (active && active.state !== 'active') upstreamInvalid();
    if ((active !== null) !== (value.blocked_reason === 'erp_finance_invoice_already_posted')) upstreamInvalid();
    const titles = active ? projectTitles(value.titles, active) : (Array.isArray(value.titles) && !value.titles.length ? [] : upstreamInvalid());
    const orders = value.orders_posted.map(item => { if (!object(item) || !isUuid(item.document_id) || !['sales_orders', 'service_orders', 'purchase_orders'].includes(item.kind) || !/^[1-9]\d{0,9}$/.test(item.number ?? '')) upstreamInvalid();
      return { document_id: item.document_id, kind: item.kind, number: item.number }; });
    return { entity: 'invoice_finance', invoice: { id: invoice.id, version: invoice.version, model: invoice.model, direction: invoice.direction, kind: invoice.kind, series: invoice.series, number: invoice.number,
        status: invoice.status, issue_date: invoice.issue_date, total_cents: invoice.total_cents, contact_id: invoice.contact_id, contact_name: invoice.contact_name, deleted: invoice.deleted },
      active_posting: active, titles, grouped_billing: value.grouped_billing === null ? null : { id: value.grouped_billing.id, number: value.grouped_billing.number }, orders_posted: orders,
      blocked_reason: value.blocked_reason, postings: value.postings.map(item => projectSummary(item, a.p_invoice_id)), writable: value.writable, data_mode: 'erp_native', cash_movement_performed: false };
  }
  // Lançar contas / Estornar contas.
  const data = a.p_data;
  if (value.action !== (route.action === 'invoice_finance_post' ? 'invoice_post' : 'invoice_reverse') || typeof value.replayed !== 'boolean' || value.cash_movement_performed !== false
    || value.invoice_id !== data.invoice_id || !Number.isSafeInteger(value.invoice_version)) upstreamInvalid();
  const posting = projectSummary(value.posting, data.invoice_id), titles = projectTitles(value.titles, posting);
  if (route.action === 'invoice_finance_post' ? posting.state !== 'active' || titles.some(item => item.cancelled) : posting.state !== 'reversed' || posting.id !== data.posting_id || titles.some(item => !item.cancelled)) upstreamInvalid();
  return { action: route.action, replayed: value.replayed, invoice_id: value.invoice_id, invoice_version: value.invoice_version, posting, titles, data_mode: 'erp_native', cash_movement_performed: false };
}
