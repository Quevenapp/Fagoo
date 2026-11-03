/** Contas recorrentes and Importação de registros financeiros (SQL 138). SQL is the authority for RBAC, CAS and the schedule. */
import { FinanceError, projectFinanceRecord } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const RECURRENCE_ACTIONS = ['recurrence_create', 'recurrence_generate', 'recurrence_set_active', 'recurrence_update'];
export const IMPORT_ACTIONS = ['records_import_preview', 'records_import'];
export const IMPORT_BODY_BYTES = 1024 * 1024;
// SQL 172: Parcelada is a recurrence with the nº de parcelas ('installments').
const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual', 'installments'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = []) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = (value, nullable = false) => { if (nullable && value === null) return; if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); };
function day(value, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
}
const text = (value, max, required = false) => { if (value === null || value === undefined) { if (required) invalid(); return; } if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (required && !value.trim())) invalid(); };
const cents = value => { if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value)) invalid(); };
const bp = value => { if (!Number.isInteger(value) || value < 0 || value > 10000) invalid(); };
const dayNumber = (value, nullable = true) => { if (nullable && (value === null || value === undefined)) return; if (!Number.isInteger(value) || value < 1 || value > 31) invalid(); };

function validateRecurrence(action, data) {
  if (action === 'recurrence_create') {
    exact(data, ['kind', 'contact_id', 'category_id', 'account_id', 'description', 'source_reference', 'bank_number', 'issued_on', 'competence_on', 'due_on', 'amount_cents', 'interest_month_bp', 'penalty_bp', 'frequency', 'due_day', 'second_day', 'weekday', 'end_on', 'business_days', 'installments', 'payment_method_id'],
      ['kind', 'contact_id', 'description', 'issued_on', 'competence_on', 'due_on', 'amount_cents', 'frequency']);
    if (!['receivable', 'payable'].includes(data.kind) || !FREQUENCIES.includes(data.frequency)) invalid();
    id(data.contact_id); if (data.category_id !== undefined) id(data.category_id, true); if (data.account_id !== undefined) id(data.account_id, true);
    // SQL 172/175: the Forma de pagamento of the recurrence and of its contas (validated in SQL).
    if (data.payment_method_id !== undefined) id(data.payment_method_id, true);
    text(data.description, 240, true); text(data.source_reference, 200); text(data.bank_number, 60); day(data.issued_on); day(data.competence_on); day(data.due_on); if (data.end_on !== undefined) day(data.end_on, true);
    if (data.due_on < data.issued_on || (data.end_on && data.end_on < data.due_on)) invalid();
    cents(data.amount_cents); if (data.interest_month_bp !== undefined) bp(data.interest_month_bp); if (data.penalty_bp !== undefined) bp(data.penalty_bp);
    dayNumber(data.due_day); dayNumber(data.second_day);
    if (data.weekday !== undefined && data.weekday !== null && (!Number.isInteger(data.weekday) || data.weekday < 0 || data.weekday > 6)) invalid();
    if (data.business_days !== undefined && typeof data.business_days !== 'boolean') invalid();
    if (data.frequency === 'weekly' ? (data.weekday ?? null) === null || data.due_day != null || data.second_day != null : (data.due_day ?? null) === null || (data.weekday ?? null) !== null || ((data.frequency === 'biweekly') !== ((data.second_day ?? null) !== null))) invalid();
    if ((data.frequency === 'installments') !== (data.installments !== undefined && data.installments !== null) || (data.frequency === 'installments' && (!Number.isInteger(data.installments) || data.installments < 2 || data.installments > 120 || (data.end_on ?? null) !== null))) invalid();
    return data;
  }
  if (action === 'recurrence_set_active') { exact(data, ['id', 'expected_version', 'active'], ['id', 'expected_version', 'active']); id(data.id); version(data.expected_version); if (typeof data.active !== 'boolean') invalid(); return data; }
  if (action === 'recurrence_update') {
    exact(data, ['id', 'expected_version', 'from_title_id', 'scope', 'future', 'changes'], ['id', 'expected_version', 'from_title_id', 'scope', 'future', 'changes']); id(data.id); version(data.expected_version); id(data.from_title_id);
    if (!['none', 'following', 'all'].includes(data.scope) || typeof data.future !== 'boolean' || (data.scope === 'none' && !data.future)) invalid();
    exact(data.changes, ['description', 'amount_cents', 'category_id', 'account_id', 'interest_month_bp', 'penalty_bp']); if (!Object.keys(data.changes).length) invalid();
    const c = data.changes; text(c.description, 240, c.description !== undefined); if (c.amount_cents !== undefined) cents(c.amount_cents); if (c.category_id !== undefined) id(c.category_id, true); if (c.account_id !== undefined) id(c.account_id, true);
    if (c.interest_month_bp !== undefined) bp(c.interest_month_bp); if (c.penalty_bp !== undefined) bp(c.penalty_bp);
    return data;
  }
  exact(data, ['id', 'expected_version'], ['id', 'expected_version']); id(data.id); version(data.expected_version); return data;
}
function validateImport(data) {
  exact(data, ['kind', 'file_name', 'rows'], ['kind', 'file_name', 'rows']);
  if (!['receivable', 'payable', 'cash'].includes(data.kind) || typeof data.file_name !== 'string' || !data.file_name.trim() || data.file_name.length > 200 || /[\x00-\x1f\x7f]/.test(data.file_name)) invalid();
  if (!Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 1000) invalid();
  const lines = new Set();
  for (const row of data.rows) {
    exact(row, ['line', 'issued_on', 'due_on', 'competence_on', 'amount_cents', 'side', 'description', 'contact_name', 'contact_document', 'category', 'account', 'document'], ['line', 'issued_on', 'amount_cents', 'description']);
    if (!Number.isInteger(row.line) || row.line < 2 || row.line > 100000 || lines.has(row.line)) invalid(); lines.add(row.line);
    for (const key of ['issued_on', 'due_on', 'competence_on', 'amount_cents', 'side', 'description', 'contact_name', 'contact_document', 'category', 'account', 'document']) if (row[key] !== undefined && row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 2000 || CONTROL.test(row[key]))) invalid();
    if (row.side !== undefined && row.side !== null && !['in', 'out'].includes(row.side)) invalid();
  }
  return data;
}
/** POST /v1/financeiro/actions/{recurrence_*|records_import*}. */
export function recurrenceAction(action, value) {
  if (RECURRENCE_ACTIONS.includes(action)) return { kind: 'execute', action, recurrence: true, rpc: 'erp_finance_recurrence_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validateRecurrence(action, value.data) } };
  if (action === 'records_import_preview') return { kind: 'import_preview', action, recurrence: true, rpc: 'erp_finance_import_preview', args: { p_data: validateImport(value.data) } };
  if (action === 'records_import') return { kind: 'execute', action, recurrence: true, rpc: 'erp_finance_import_execute', args: { p_command_id: value.command_id, p_data: validateImport(value.data) } };
  return null;
}
/** GET /v1/financeiro/recorrentes?kind=…; null for other paths. */
export function parseRecurrenceRead(url) {
  const single = /^\/v1\/financeiro\/recorrentes\/([^/]+)$/.exec(url.pathname);
  if (single) { if (!UUID.test(single[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'recurrence_get', recurrence: true, rpc: 'erp_finance_recurrence_get', args: { p_id: single[1].toLowerCase() } }; }
  if (url.pathname !== '/v1/financeiro/recorrentes') return null;
  const params = url.searchParams; for (const key of params.keys()) if (!['kind', 'situacao', 'q', 'page', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
  const kind = params.get('kind'), situation = params.get('situacao') ?? 'ativas', page = params.get('page') ?? '1', limit = params.get('limit') ?? '100', query = params.get('q');
  if (!['receivable', 'payable'].includes(kind) || !['ativas', 'inativas', 'todas'].includes(situation) || !/^[1-9]\d{0,5}$/.test(page) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100
    || (query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query)))) invalid();
  return { kind: 'recurrence_page', recurrence: true, rpc: 'erp_finance_recurrence_page', args: { p_kind: kind, p_active: situation === 'todas' ? null : situation === 'ativas', p_query: query?.trim() || null, p_page: Number(page), p_limit: Number(limit) } };
}

const isDay = value => typeof value === 'string' && DAY.test(value);
function projectRecurrence(value) {
  if (!object(value) || !UUID.test(value.id ?? '') || !['receivable', 'payable'].includes(value.kind) || !UUID.test(value.contact_id ?? '') || typeof value.contact_name !== 'string' || value.contact_name.length > 200
    || (value.category_id !== null && !UUID.test(value.category_id ?? '')) || (value.category_name !== null && typeof value.category_name !== 'string') || (value.account_id !== null && !UUID.test(value.account_id ?? ''))
    || typeof value.description !== 'string' || value.description.length > 240 || typeof value.amount_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(value.amount_cents) || !FREQUENCIES.includes(value.frequency)
    || (value.due_day !== null && (!Number.isInteger(value.due_day) || value.due_day < 1 || value.due_day > 31)) || (value.second_day !== null && !Number.isInteger(value.second_day)) || (value.weekday !== null && !Number.isInteger(value.weekday))
    || typeof value.business_days !== 'boolean' || (value.end_on !== null && !isDay(value.end_on)) || (value.next_on !== null && !isDay(value.next_on)) || !Number.isSafeInteger(value.generated) || value.generated < 1
    || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.open_titles) || value.open_titles < 0 || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.created_at !== 'string'
    || (!value.active && value.next_on !== null) || (value.installments !== undefined && value.installments !== null && (!Number.isInteger(value.installments) || value.installments < 2 || value.installments > 120))
    || ((value.frequency === 'installments') !== Number.isInteger(value.installments))) upstreamInvalid();
  return { id: value.id, kind: value.kind, contact_id: value.contact_id, contact_name: value.contact_name, category_id: value.category_id, category_name: value.category_name, account_id: value.account_id, description: value.description,
    amount_cents: value.amount_cents, frequency: value.frequency, due_day: value.due_day, second_day: value.second_day, weekday: value.weekday, business_days: value.business_days, end_on: value.end_on, next_on: value.next_on,
    generated: value.generated, active: value.active, open_titles: value.open_titles, version: value.version, created_at: value.created_at, installments: value.installments ?? null };
}
export function projectRecurrenceResult(route, value) {
  if (route.kind === 'recurrence_get') { if (value.entity !== 'recurrences') upstreamInvalid(); const record = projectRecurrence(value.record); if (record.id !== route.args.p_id) upstreamInvalid(); return { entity: 'recurrences', record, data_mode: 'erp_native' }; }
  if (route.kind === 'recurrence_page') {
    const a = route.args;
    if (value.entity !== 'recurrences' || value.kind !== a.p_kind || value.active !== a.p_active || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || !Array.isArray(value.items)
      || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))) upstreamInvalid();
    return { entity: 'recurrences', kind: a.p_kind, active: a.p_active, page: a.p_page, limit: a.p_limit, total: value.total, items: value.items.map(item => { const record = projectRecurrence(item); if (record.kind !== a.p_kind || (a.p_active !== null && record.active !== a.p_active)) upstreamInvalid(); return record; }), data_mode: 'erp_native' };
  }
  if (route.kind === 'import_preview') {
    const rows = route.args.p_data.rows;
    if (value.entity !== 'financial_import' || value.kind !== route.args.p_data.kind || !Array.isArray(value.rows) || value.rows.length !== rows.length) upstreamInvalid();
    return { entity: 'financial_import', kind: value.kind, rows: value.rows.map((row, index) => {
      if (!object(row) || row.line !== rows[index].line || !['new', 'duplicate', 'error'].includes(row.status) || !Array.isArray(row.errors) || row.errors.some(item => typeof item !== 'string' || item.length > 40) || (row.status === 'error') !== (row.errors.length > 0)) upstreamInvalid();
      return { line: row.line, status: row.status, errors: [...row.errors] };
    }), data_mode: 'erp_native' };
  }
  if (value.action !== route.action || typeof value.replayed !== 'boolean') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, data_mode: 'erp_native' };
  if (route.action === 'records_import') {
    if (value.entity !== 'financial_import' || value.kind !== route.args.p_data.kind || !Number.isSafeInteger(value.created) || !Number.isSafeInteger(value.skipped) || value.created < 0 || value.skipped < 0 || value.created + value.skipped !== route.args.p_data.rows.length) upstreamInvalid();
    return { ...output, entity: 'financial_import', kind: value.kind, created: value.created, skipped: value.skipped };
  }
  if (value.entity !== 'recurrences') upstreamInvalid();
  const record = projectRecurrence(value.record);
  if (route.action !== 'recurrence_create' && record.id !== route.args.p_data.id.toLowerCase()) upstreamInvalid();
  const result = { ...output, entity: 'recurrences', record };
  if (['recurrence_create', 'recurrence_generate'].includes(route.action)) { const title = projectFinanceRecord('titles', value.title); if (title.contact_id !== record.contact_id || title.kind !== record.kind) upstreamInvalid(); result.title = title; }
  if (route.action === 'recurrence_update') { if (!Number.isSafeInteger(value.updated_titles) || value.updated_titles < 0) upstreamInvalid(); result.updated_titles = value.updated_titles; }
  return result;
}
