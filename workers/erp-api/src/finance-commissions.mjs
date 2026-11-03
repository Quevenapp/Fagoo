/** Financeiro > Comissões (SQL 171): listagem mensal por vendedor, extrato do vendedor e os comandos. SQL is the authority. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, CONTROL = /[\x00-\x1f\x7f]/;
const SIGNED = /^-?\d{1,30}$/, UNSIGNED = /^\d{1,30}$/, RATE = /^\d{1,3}\.\d{2}$/;
export const COMMISSION_ACTIONS = ['commission_payment', 'commission_entry', 'commission_manual', 'commission_delete'];
const SITUATIONS = ['all', 'A', 'I', 'S'], RULES = ['parcial', 'faturamento', 'primeira_parcela', 'ultima_parcela'];
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
const firstDay = value => { day(value); if (!value.endsWith('-01')) invalid(); return value; };
const cents = value => { if (typeof value !== 'string' || !/^\d{1,15}$/.test(value) || /^0+$/.test(value)) invalid(); };
const text = (value, max, required = true) => { if (value === null || value === undefined) { if (required) invalid(); return; } if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (required && !value.trim())) invalid(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); };

function validate(action, data) {
  if (action === 'commission_payment') {
    exact(data, ['seller_id', 'month', 'posted_on', 'category_id', 'account_id', 'amount_cents', 'description'], ['seller_id', 'month', 'posted_on', 'amount_cents', 'description']);
    id(data.seller_id); firstDay(data.month); day(data.posted_on); if (data.category_id !== undefined) id(data.category_id, true); if (data.account_id !== undefined) id(data.account_id, true);
    cents(data.amount_cents); text(data.description, 240); return data;
  }
  if (action === 'commission_entry') {
    exact(data, ['seller_id', 'month', 'posted_on', 'amount_cents', 'kind', 'description']);
    id(data.seller_id); firstDay(data.month); day(data.posted_on); cents(data.amount_cents); if (!['credit', 'debit'].includes(data.kind)) invalid(); text(data.description, 240); return data;
  }
  if (action === 'commission_manual') {
    exact(data, ['seller_id', 'due_on', 'credit_on', 'parcel_cents', 'rate', 'description'], ['seller_id', 'due_on', 'credit_on', 'parcel_cents']);
    id(data.seller_id); day(data.due_on); day(data.credit_on); cents(data.parcel_cents);
    if (data.rate !== undefined && data.rate !== null && (typeof data.rate !== 'string' || !/^(0|[1-9]\d?|100)(\.\d{1,4})?$/.test(data.rate) || Number(data.rate) > 100)) invalid();
    text(data.description, 240, false); return data;
  }
  exact(data, ['target', 'id', 'expected_version']); if (!['commission', 'entry'].includes(data.target)) invalid(); id(data.id); version(data.expected_version);
  return data;
}
/** POST /v1/financeiro/actions/commission_*; null for other actions. */
export function commissionAction(action, value) {
  if (!COMMISSION_ACTIONS.includes(action)) return null;
  return { kind: 'execute', action, commissions: true, rpc: 'erp_finance_commission_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validate(action, value.data) } };
}

/** GET /v1/financeiro/comissoes and /v1/financeiro/comissoes/{vendedor}; null for other paths. */
export function parseCommissionRead(url) {
  const params = url.searchParams, single = () => { for (const key of params.keys()) if (params.getAll(key).length !== 1) invalid(); };
  const month = () => { const value = params.get('month'); if (value === null || !MONTH.test(value) || value < '1900-01' || value > '2100-12') invalid(); return `${value}-01`; };
  if (url.pathname === '/v1/financeiro/comissoes') {
    single(); for (const key of params.keys()) if (!['month', 'situation', 'idle', 'q', 'page', 'limit'].includes(key)) invalid();
    const situation = params.get('situation') ?? 'all', idle = params.get('idle') ?? 'false', page = params.get('page') ?? '1', limit = params.get('limit') ?? '100', query = params.get('q');
    if (!SITUATIONS.includes(situation) || !['true', 'false'].includes(idle) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100
      || (query !== null && (query.length > 120 || CONTROL.test(query)))) invalid();
    return { kind: 'commission_page', commissions: true, rpc: 'erp_finance_commission_page', args: { p_month: month(), p_situation: situation, p_with_idle: idle === 'true', p_query: query?.trim() || null, p_page: Number(page), p_limit: Number(limit) } };
  }
  // SQL 370: Relatório complementar de comissões (operações confirmadas no período).
  if (url.pathname === '/v1/financeiro/comissoes-relatorio') {
    single(); for (const key of params.keys()) if (!['from', 'to', 'vendedor', 'state', 'page', 'limit'].includes(key)) invalid();
    const from = day(params.get('from') ?? ''), to = day(params.get('to') ?? ''), seller = params.get('vendedor'), state = params.get('state') ?? 'all', page = params.get('page') ?? '1', limit = params.get('limit') ?? '100';
    if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000 || (seller !== null && !UUID.test(seller)) || !['all', 'active', 'cancelled'].includes(state)
      || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) invalid();
    return { kind: 'commission_report', commissions: true, rpc: 'erp_finance_commission_report', args: { p_from: from, p_to: to, p_seller_id: seller?.toLowerCase() ?? null, p_state: state, p_page: Number(page), p_limit: Number(limit) } };
  }
  const match = /^\/v1\/financeiro\/comissoes\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  if (!UUID.test(match[1])) throw new FinanceError(404, 'ERP_NOT_FOUND');
  single(); for (const key of params.keys()) if (key !== 'month') invalid();
  return { kind: 'commission_statement', commissions: true, rpc: 'erp_finance_commission_statement', args: { p_seller: match[1].toLowerCase(), p_month: month() } };
}

const isDay = value => typeof value === 'string' && DAY.test(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const str = (value, max) => typeof value === 'string' && value.length <= max;
const opt = (value, check) => value === null || check(value);
const unsigned = value => typeof value === 'string' && UNSIGNED.test(value);
const signed = value => typeof value === 'string' && SIGNED.test(value);
const MONEY = ['billed_cents', 'commission_cents', 'credit_cents', 'debit_cents', 'payment_cents', 'pending_cents'];
function projectSums(value) {
  if (!object(value) || MONEY.some(key => !unsigned(value[key])) || !signed(value.previous_cents) || !signed(value.balance_cents)
    || BigInt(value.previous_cents) + BigInt(value.commission_cents) + BigInt(value.credit_cents) - BigInt(value.debit_cents) - BigInt(value.payment_cents) !== BigInt(value.balance_cents)) upstreamInvalid();
  return Object.fromEntries(['billed_cents', 'previous_cents', ...MONEY.slice(1), 'balance_cents'].map(key => [key, value[key]]));
}
function projectEntry(value) {
  if (!object(value) || !isUuid(value.id) || !isUuid(value.seller_id) || !['credit', 'debit', 'payment'].includes(value.kind) || !isDay(value.month) || !value.month.endsWith('-01') || !isDay(value.posted_on)
    || !unsigned(value.amount_cents) || !str(value.description, 240) || !opt(value.category_id, isUuid) || !opt(value.account_id, isUuid) || !opt(value.account_name, item => str(item, 200))
    || !opt(value.source, source => ['cash', 'payable'].includes(source)) || (value.kind === 'payment') !== (value.source !== null) || !opt(value.title_id, isUuid) || (value.source === 'payable') !== (value.title_id !== null)
    || typeof value.counts !== 'boolean' || typeof value.deleted !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 1 || !str(value.created_at, 100)) upstreamInvalid();
  return { id: value.id, seller_id: value.seller_id, kind: value.kind, month: value.month, posted_on: value.posted_on, amount_cents: value.amount_cents, description: value.description, category_id: value.category_id,
    account_id: value.account_id, account_name: value.account_name, source: value.source, title_id: value.title_id, counts: value.counts, deleted: value.deleted, version: value.version, created_at: value.created_at };
}
function projectSeller(value) {
  if (!object(value) || !isUuid(value.id) || !isUuid(value.contact_id) || !str(value.name, 200) || !opt(value.code, code => str(code, 100)) || !['A', 'I', 'S', 'E'].includes(value.situation)
    || !RULES.includes(value.rule) || !['fixa', 'descontos'].includes(value.mode) || !opt(value.rate, rate => typeof rate === 'string' && /^\d{1,3}(\.\d{1,4})?$/.test(rate))) upstreamInvalid();
  return { id: value.id, contact_id: value.contact_id, name: value.name, code: value.code, situation: value.situation, rule: value.rule, mode: value.mode, rate: value.rate };
}
const section = (value, items) => { if (!object(value) || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length > Math.min(500, value.total)) upstreamInvalid(); return items(value.items); };
function projectStatement(route, value) {
  if (value.entity !== 'commission_statement' || value.month !== route.args.p_month.slice(0, 7) || typeof value.payable !== 'boolean') upstreamInvalid();
  const seller = projectSeller(value.seller); if (seller.id !== route.args.p_seller) upstreamInvalid();
  const c = value.commissions;
  const commissions = section(c, items => items.map(item => {
    // SQL 248: the commissions of the contas lançadas by a note (origin invoice, the note as its document).
    if (!object(item) || !isUuid(item.id) || !['document', 'manual', 'invoice'].includes(item.origin) || !isDay(item.day) || !item.day.startsWith(value.month) || !str(item.description, 240) || !unsigned(item.parcel_cents) || !unsigned(item.base_cents)
      || typeof item.rate !== 'string' || !RATE.test(item.rate) || !unsigned(item.commission_cents) || !opt(item.title_id, isUuid) || !Number.isSafeInteger(item.version)
      || (item.document !== null && (!object(item.document) || !isUuid(item.document.id) || !(item.origin === 'invoice' ? item.document.kind === 'fiscal_invoices' && (item.document.number === null || /^[1-9]\d{0,8}$/.test(item.document.number)) : ['sales_orders', 'service_orders'].includes(item.document.kind) && /^[1-9]\d{0,9}$/.test(item.document.number ?? ''))))
      || (item.origin !== 'manual') !== (item.document !== null)) upstreamInvalid();
    return { id: item.id, origin: item.origin, day: item.day, description: item.description, parcel_cents: item.parcel_cents, base_cents: item.base_cents, rate: item.rate, commission_cents: item.commission_cents,
      document: item.document === null ? null : { id: item.document.id, kind: item.document.kind, number: item.document.number }, title_id: item.title_id, version: item.version };
  }));
  if (!unsigned(c.parcel_cents) || !unsigned(c.base_cents) || !unsigned(c.commission_cents)) upstreamInvalid();
  const entries = (part, kind) => { const items = section(part, list => list.map(projectEntry)); if (!unsigned(part.amount_cents) || items.some(item => item.kind !== kind || item.month !== route.args.p_month || !item.counts || item.deleted)) upstreamInvalid(); return { total: part.total, amount_cents: part.amount_cents, items }; };
  const p = value.pending;
  const pending = section(p, items => items.map(item => {
    if (!object(item) || !isUuid(item.id) || !isDay(item.due_on) || !str(item.description, 240) || !['overdue', 'upcoming'].includes(item.situation) || !unsigned(item.commission_cents)) upstreamInvalid();
    return { id: item.id, due_on: item.due_on, description: item.description, situation: item.situation, commission_cents: item.commission_cents };
  }));
  if (!unsigned(p.commission_cents)) upstreamInvalid();
  const summary = value.summary;
  if (!object(summary) || ['commission_cents', 'credit_cents', 'debit_cents', 'payment_cents', 'pending_cents'].some(key => !unsigned(summary[key])) || !signed(summary.previous_cents) || !signed(summary.balance_cents)
    || BigInt(summary.previous_cents) + BigInt(summary.commission_cents) + BigInt(summary.credit_cents) - BigInt(summary.debit_cents) - BigInt(summary.payment_cents) !== BigInt(summary.balance_cents)
    || summary.commission_cents !== c.commission_cents || summary.pending_cents !== p.commission_cents) upstreamInvalid();
  const credits = entries(value.credits, 'credit'), debits = entries(value.debits, 'debit'), payments = entries(value.payments, 'payment');
  if (summary.credit_cents !== credits.amount_cents || summary.debit_cents !== debits.amount_cents || summary.payment_cents !== payments.amount_cents) upstreamInvalid();
  return { entity: 'commission_statement', seller, month: value.month, payable: value.payable,
    commissions: { total: c.total, parcel_cents: c.parcel_cents, base_cents: c.base_cents, commission_cents: c.commission_cents, items: commissions }, credits, debits, payments,
    pending: { total: p.total, commission_cents: p.commission_cents, items: pending },
    summary: { previous_cents: summary.previous_cents, commission_cents: summary.commission_cents, credit_cents: summary.credit_cents, debit_cents: summary.debit_cents, payment_cents: summary.payment_cents, pending_cents: summary.pending_cents, balance_cents: summary.balance_cents },
    data_mode: 'erp_native' };
}

const OPERATION_MONEY = ['items_cents', 'discount_cents', 'freight_cents', 'ipi_cents', 'icms_st_cents', 'fee_cents', 'base_cents', 'estimated_cents', 'net_cents', 'total_cents', 'received_cents', 'eligible_cents'];
const ADDITIONS = ['desconto', 'frete', 'icms_st', 'ipi', 'taxas_pagamento'];
/** SQL 370 commission_operation_view: the frozen operation of a sale, with adjusted, net, received and eligible. */
export function projectCommissionOperation(value) {
  const policy = value?.policy;
  if (!object(value) || !isUuid(value.id) || !isUuid(value.document_id) || !['sales_orders', 'service_orders'].includes(value.kind) || !isUuid(value.seller_id)
    || !['active', 'superseded', 'cancelled'].includes(value.state) || !RULES.includes(value.rule) || OPERATION_MONEY.some(key => !unsigned(value[key])) || !signed(value.adjusted_cents)
    || BigInt(value.adjusted_cents) > 0n || BigInt(value.eligible_cents) > BigInt(value.net_cents) || BigInt(value.net_cents) > BigInt(value.estimated_cents)
    || typeof value.rate !== 'string' || !/^\d{1,3}\.\d{4}$/.test(value.rate) || !Number.isSafeInteger(value.titles) || value.titles < 0
    || !object(policy) || policy.version !== 1 || policy.base !== 'itens_liquidos' || !Array.isArray(policy.additions) || policy.additions.some(item => !ADDITIONS.includes(item))
    || !Array.isArray(value.adjustments) || value.adjustments.length > 200 || !isDay(value.confirmed_on) || !str(value.confirmed_status, 40)
    || !opt(value.ended_at, item => str(item, 100)) || !opt(value.ended_reason, item => str(item, 80)) || !Number.isSafeInteger(value.version) || value.version < 1) upstreamInvalid();
  const adjustments = value.adjustments.map(item => {
    if (!object(item) || !['return', 'cancel'].includes(item.kind) || !signed(item.amount_cents) || BigInt(item.amount_cents) > 0n || !isDay(item.occurred_on) || !str(item.note, 240)) upstreamInvalid();
    return { kind: item.kind, amount_cents: item.amount_cents, occurred_on: item.occurred_on, note: item.note };
  });
  return { id: value.id, document_id: value.document_id, kind: value.kind, seller_id: value.seller_id, state: value.state, rule: value.rule, policy: { version: 1, base: 'itens_liquidos', additions: [...policy.additions] },
    ...Object.fromEntries([...OPERATION_MONEY, 'adjusted_cents'].map(key => [key, value[key]])), rate: value.rate, titles: value.titles, adjustments,
    confirmed_status: value.confirmed_status, confirmed_on: value.confirmed_on, ended_at: value.ended_at, ended_reason: value.ended_reason, version: value.version };
}
function projectReport(route, value) {
  const a = route.args;
  if (value.entity !== 'commission_report' || value.from !== a.p_from || value.to !== a.p_to || value.seller_id !== a.p_seller_id || value.state !== a.p_state || value.page !== a.p_page || value.limit !== a.p_limit
    || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))
    || !Array.isArray(value.sellers) || value.sellers.length > 10000) upstreamInvalid();
  const items = value.items.map(item => {
    const operation = projectCommissionOperation(item);
    if (operation.state === 'superseded' || (a.p_state !== 'all' && operation.state !== a.p_state) || (a.p_seller_id && operation.seller_id !== a.p_seller_id) || operation.confirmed_on < a.p_from || operation.confirmed_on > a.p_to
      || !/^[1-9]\d{0,9}$/.test(item.document_number ?? '') || !opt(item.document_date, isDay) || !str(item.contact_name, 200) || !str(item.seller_name, 200)) upstreamInvalid();
    return { ...operation, document_number: item.document_number, document_date: item.document_date, contact_name: item.contact_name, seller_name: item.seller_name };
  });
  const sums = item => { if (!object(item) || !unsigned(item.estimated_cents) || !signed(item.adjusted_cents) || !unsigned(item.eligible_cents) || !unsigned(item.paid_cents)) upstreamInvalid();
    return { estimated_cents: item.estimated_cents, adjusted_cents: item.adjusted_cents, eligible_cents: item.eligible_cents, paid_cents: item.paid_cents }; };
  const seen = new Set(), sellers = value.sellers.map(item => {
    if (!object(item) || !isUuid(item.seller_id) || seen.has(item.seller_id) || !str(item.name, 200) || !Number.isSafeInteger(item.operations) || item.operations < 0) upstreamInvalid();
    seen.add(item.seller_id); return { seller_id: item.seller_id, name: item.name, operations: item.operations, ...sums(item) };
  });
  return { entity: 'commission_report', from: value.from, to: value.to, seller_id: value.seller_id, state: value.state, page: value.page, limit: value.limit, total: value.total, items, sellers, totals: sums(value.totals), data_mode: 'erp_native' };
}

export function projectCommissionResult(route, value) {
  if (route.kind === 'commission_report') return projectReport(route, value);
  if (route.kind === 'commission_page') {
    const a = route.args;
    if (value.entity !== 'commissions' || value.month !== a.p_month.slice(0, 7) || value.situation !== a.p_situation || value.with_idle !== a.p_with_idle || value.page !== a.p_page || value.limit !== a.p_limit
      || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))) upstreamInvalid();
    const seen = new Set(), items = value.items.map(item => {
      if (!object(item) || !isUuid(item.seller_id) || seen.has(item.seller_id) || !str(item.name, 200) || !['A', 'I', 'S'].includes(item.situation) || (a.p_situation !== 'all' && item.situation !== a.p_situation)) upstreamInvalid();
      seen.add(item.seller_id); return { seller_id: item.seller_id, name: item.name, situation: item.situation, ...projectSums(item) };
    });
    return { entity: 'commissions', month: value.month, situation: value.situation, with_idle: value.with_idle, page: value.page, limit: value.limit, total: value.total, items, totals: projectSums(value.totals), data_mode: 'erp_native' };
  }
  if (route.kind === 'commission_statement') return projectStatement(route, value);
  if (value.action !== route.action || typeof value.replayed !== 'boolean') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, data_mode: 'erp_native' }, data = route.args.p_data;
  if (route.action === 'commission_manual' || (route.action === 'commission_delete' && data.target === 'commission')) {
    const r = value.record;
    if (value.entity !== 'commissions' || !object(r) || !isUuid(r.id)) upstreamInvalid();
    if (route.action === 'commission_delete') { if (r.id !== data.id.toLowerCase() || r.deleted !== true) upstreamInvalid(); return { ...output, entity: 'commissions', record: { id: r.id, deleted: true } }; }
    if (r.seller_id !== data.seller_id.toLowerCase() || r.origin !== 'manual' || r.due_on !== data.due_on || r.credit_on !== data.credit_on || r.parcel_cents !== data.parcel_cents || typeof r.rate !== 'string' || !RATE.test(r.rate)
      || !unsigned(r.commission_cents) || !str(r.description, 240) || r.version !== 1 || r.deleted !== false) upstreamInvalid();
    return { ...output, entity: 'commissions', record: { id: r.id, seller_id: r.seller_id, origin: 'manual', due_on: r.due_on, credit_on: r.credit_on, parcel_cents: r.parcel_cents, rate: r.rate, commission_cents: r.commission_cents, description: r.description, version: 1, deleted: false } };
  }
  if (value.entity !== 'commission_entries') upstreamInvalid();
  const record = projectEntry(value.record);
  if (route.action === 'commission_delete') { if (record.id !== data.id.toLowerCase() || !record.deleted) upstreamInvalid(); }
  else if (record.seller_id !== data.seller_id.toLowerCase() || record.month !== data.month || record.posted_on !== data.posted_on || record.amount_cents !== data.amount_cents || record.deleted
    || record.kind !== (route.action === 'commission_payment' ? 'payment' : data.kind)) upstreamInvalid();
  return { ...output, entity: 'commission_entries', record };
}
