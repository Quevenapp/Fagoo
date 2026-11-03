/** Borderôs (SQL 110): Baixa de lançamentos, Excluir borderô and "Gerenciar recebimentos / pagamentos". SQL is the authority for RBAC/CAS/arithmetic. */
import { FinanceError, projectFinanceRecord } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CENTS = /^\d{1,15}$/, SUM = /^\d{1,30}$/;
export const BORDERO_ACTIONS = ['settle_batch', 'bordero_delete'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
const id = (value, nullable = false) => { if (nullable && value === null) return null; if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); return value; };
const cents = (value, positive = false) => { if (typeof value !== 'string' || !CENTS.test(value) || (positive && BigInt(value) === 0n)) invalid(); return value; };
const note = (value, required = false, limit = 500) => {
  if (value === null || value === undefined) { if (required) invalid(); return null; }
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) invalid();
  return value;
};

/** Body of settle_batch / bordero_delete; returns the validated data sent unchanged to SQL. */
export function validateBorderoData(action, data) {
  if (action === 'settle_batch') {
    exact(data, ['kind', 'grouped', 'account_id', 'category_id', 'note', 'items'], ['kind', 'grouped', 'items']);
    if (!['receivable', 'payable'].includes(data.kind) || typeof data.grouped !== 'boolean' || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100) invalid();
    if (data.account_id !== undefined) id(data.account_id, true); if (data.category_id !== undefined) id(data.category_id, true);
    // SQL 249: the Histórico of the baixa takes 2,000 characters, as in Origin (the borderô keeps its first 500).
    if (data.note !== undefined) note(data.note, false, 2000);
    if (data.grouped ? data.items.length < 2 || !data.account_id : data.account_id || data.category_id) invalid();
    const ids = new Set();
    for (const item of data.items) {
      exact(item, ['id', 'expected_version', 'account_id', 'category_id', 'posted_on', 'principal_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents']);
      ids.add(id(item.id)); version(item.expected_version); id(item.account_id); id(item.category_id, true); day(item.posted_on);
      cents(item.principal_cents, true); for (const key of ['interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents']) cents(item[key]);
      if (data.grouped && (item.account_id.toLowerCase() !== data.account_id.toLowerCase() || item.posted_on !== data.items[0].posted_on)) invalid();
    }
    if (ids.size !== data.items.length) invalid();
    return data;
  }
  exact(data, ['id', 'expected_version', 'posted_on', 'note']);
  id(data.id); version(data.expected_version); day(data.posted_on); note(data.note, true);
  return data;
}

const PAGE_PARAMS = ['page', 'limit', 'kind', 'q', 'account', 'category', 'from', 'to', 'amount_cents', 'title'];
/** GET /v1/financeiro/borderos (page) and /v1/financeiro/borderos/{id}. */
export function parseBorderoRead(url) {
  const match = /^\/v1\/financeiro\/borderos(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return null;
  if (match[1] !== undefined) { if (!UUID.test(match[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'bordero_get', rpc: 'erp_finance_bordero_get', args: { p_id: match[1].toLowerCase() } }; }
  const params = url.searchParams;
  for (const key of params.keys()) if (!PAGE_PARAMS.includes(key) || params.getAll(key).length !== 1) invalid();
  const page = params.get('page'), limit = params.get('limit') ?? '100', kind = params.get('kind');
  if (!/^[1-9]\d{0,5}$/.test(page ?? '') || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || !['receivable', 'payable'].includes(kind)) invalid();
  const query = params.get('q'); if (query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query))) invalid();
  const account = params.get('account'); if (account !== null) id(account);
  const title = params.get('title'); if (title !== null) id(title);
  const category = params.get('category'); let categories = null;
  if (category !== null) { categories = category.split(',').map(value => value.toLowerCase()); if (categories.length > 50 || categories.some(value => value !== 'none' && !UUID.test(value)) || new Set(categories).size !== categories.length) invalid(); }
  const from = params.has('from') ? day(params.get('from')) : null, to = params.has('to') ? day(params.get('to')) : null; if (from && to && from > to) invalid();
  const amount = params.get('amount_cents'); if (amount !== null && !/^[1-9]\d{0,14}$/.test(amount)) invalid();
  return { kind: 'bordero_page', rpc: 'erp_finance_bordero_page', args: { p_kind: kind, p_page: Number(page), p_limit: Number(limit), p_query: query?.trim() || null, p_account: account?.toLowerCase() ?? null,
    p_categories: categories, p_from: from, p_to: to, p_amount_cents: amount, p_title: title?.toLowerCase() ?? null } };
}

const TOTAL_KEYS = ['paid_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents', 'net_cash_cents'];
const text = (value, max, nullable = true) => (value === null && nullable) || (typeof value === 'string' && value.length <= max);
function projectTotals(value, keys) {
  if (!object(value) || keys.some(key => typeof value[key] !== 'string' || !SUM.test(value[key]))) upstreamInvalid();
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function projectLine(value) {
  if (!object(value) || !UUID.test(value.settlement_id || '') || !UUID.test(value.title_id || '') || !text(value.contact_name, 200, false) || !text(value.document_number, 200) || !text(value.description, 240, false)
    || typeof value.reversed !== 'boolean' || (value.category_id !== null && !UUID.test(value.category_id || '')) || !text(value.category_name, 200)) upstreamInvalid();
  return { settlement_id: value.settlement_id, title_id: value.title_id, contact_name: value.contact_name, document_number: value.document_number, description: value.description,
    ...projectTotals(value, ['principal_cents', ...TOTAL_KEYS]), reversed: value.reversed, category_id: value.category_id, category_name: value.category_name };
}
export function projectBordero(value, lines = false) {
  if (!object(value) || !UUID.test(value.id || '') || !['receivable', 'payable'].includes(value.kind) || typeof value.posted_on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.posted_on)
    || !UUID.test(value.account_id || '') || !text(value.account_name, 200, false) || (value.category_id !== null && !UUID.test(value.category_id || '')) || !text(value.category_name, 200)
    || !text(value.note, 500) || typeof value.grouped !== 'boolean' || !Number.isInteger(value.version) || value.version < 1 || !text(value.created_at, 100, false) || !text(value.deleted_at, 100)
    || typeof value.active !== 'boolean' || !text(value.contact_name, 200) || !Number.isSafeInteger(value.contacts) || value.contacts < 1 || !Number.isSafeInteger(value.items) || value.items < 1
    || (value.contacts === 1) !== (value.contact_name !== null) || (value.deleted_at !== null && value.active)) upstreamInvalid();
  const result = { id: value.id, kind: value.kind, posted_on: value.posted_on, account_id: value.account_id, account_name: value.account_name, category_id: value.category_id, category_name: value.category_name,
    note: value.note, grouped: value.grouped, version: value.version, created_at: value.created_at, deleted_at: value.deleted_at, active: value.active, contact_name: value.contact_name, contacts: value.contacts, items: value.items,
    totals: projectTotals(value.totals, TOTAL_KEYS) };
  if (lines) { if (!Array.isArray(value.lines) || value.lines.length !== value.items) upstreamInvalid(); result.lines = value.lines.map(projectLine); }
  return result;
}

export function projectBorderoResult(route, value) {
  if (!object(value) || value.data_mode !== 'erp_native' || value.entity !== 'borderos') upstreamInvalid();
  if (route.kind === 'bordero_get') { const record = projectBordero(value.record, true); if (record.id !== route.args.p_id) upstreamInvalid(); return { entity: 'borderos', record, data_mode: 'erp_native' }; }
  if (route.kind === 'bordero_page') {
    const { p_kind: kind, p_page: page, p_limit: limit } = route.args;
    if (value.kind !== kind || value.page !== page || value.limit !== limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
      || value.items.length !== Math.max(0, Math.min(limit, value.total - (page - 1) * limit)) || !object(value.totals) || value.totals.count !== value.total) upstreamInvalid();
    const seen = new Set(); let previous = null;
    const items = value.items.map(item => {
      const row = projectBordero(item); if (row.kind !== kind || !row.active || seen.has(row.id)) upstreamInvalid(); seen.add(row.id);
      const key = `${row.posted_on}:${row.id}`; if (previous !== null && key >= previous) upstreamInvalid(); previous = key;
      return row;
    });
    return { entity: 'borderos', kind, items, page, limit, total: value.total, totals: { count: value.totals.count, ...projectTotals(value.totals, ['paid_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents']) }, data_mode: 'erp_native' };
  }
  // Commands: every baixa or estorno with its conta, and the borderôs touched.
  if (value.action !== route.action || typeof value.replayed !== 'boolean' || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100 || !Array.isArray(value.borderos) || value.borderos.length < 1) upstreamInvalid();
  const borderos = value.borderos.map(item => projectBordero(item)), ids = new Set(borderos.map(item => item.id));
  const items = value.items.map(item => {
    if (!object(item) || !ids.has(item.bordero_id)) upstreamInvalid();
    const title = projectFinanceRecord('titles', item.title), settlement = projectFinanceRecord('settlements', item.settlement);
    if (settlement.title_id !== title.id || settlement.kind !== (route.action === 'settle_batch' ? 'payment' : 'reversal')) upstreamInvalid();
    return { title, settlement, bordero_id: item.bordero_id };
  });
  if (route.action === 'settle_batch') {
    const sent = route.args.p_data.items.map(item => item.id.toLowerCase()).sort(), got = items.map(item => item.title.id).sort();
    if (JSON.stringify(sent) !== JSON.stringify(got) || borderos.length !== (route.args.p_data.grouped ? 1 : items.length)) upstreamInvalid();
  } else if (borderos.length !== 1 || borderos[0].id !== route.args.p_data.id || borderos[0].active || borderos[0].deleted_at === null) upstreamInvalid();
  const output = { entity: 'borderos', action: value.action, replayed: value.replayed, items, borderos, data_mode: 'erp_native' };
  if (value.note !== undefined) { if (!text(value.note, 500)) upstreamInvalid(); output.note = value.note; }
  return output;
}
