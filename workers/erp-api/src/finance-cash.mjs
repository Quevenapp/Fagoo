/** Caixas e bancos (SQL 136): extrato, lançamentos de caixa, ajuste de saldo, transferências e a Ficha financeira. SQL is the authority. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/, CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/, LINE_CONTROL = /[\x00-\x1f\x7f]/;
export const CASH_ACTIONS = ['entry_save', 'entry_delete', 'entry_restore', 'balance_adjust', 'transfer_create', 'transfer_delete', 'line_categorize'];
const LINE_KINDS = ['entry', 'transfer', 'settlement', 'opening'];
// Onda C: pagamentos de comissão (SQL 171) e sangrias/suprimentos do Controle de caixa (SQL 173) are lançamentos owned by their screens.
const ENTRY_ORIGINS = ['manual', 'adjustment', 'ledger', 'import', 'reconciliation', 'commission', 'cash_session'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = []) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = (value, nullable = false) => { if (nullable && value === null) return; if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
const cents = (value, { signed = false, positive = false } = {}) => { if (typeof value !== 'string' || !(signed ? /^-?\d{1,15}$/ : /^\d{1,15}$/).test(value) || value === '-0' || (positive && /^0+$/.test(value))) invalid(); };
const text = (value, max, required = false) => { if (value === null || value === undefined) { if (required) invalid(); return; } if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || (required && !value.trim())) invalid(); };

function validate(action, data) {
  if (action === 'entry_save') {
    exact(data, ['id', 'expected_version', 'account_id', 'kind', 'amount_cents', 'posted_on', 'competence_on', 'category_id', 'contact_id', 'note', 'origin'], ['expected_version', 'account_id', 'kind', 'amount_cents', 'posted_on', 'competence_on', 'note']);
    if (data.id !== undefined) id(data.id, true);
    if (!Number.isInteger(data.expected_version) || data.expected_version < (data.id ? 1 : 0) || data.expected_version > 2147483647 || (!data.id && data.expected_version !== 0)) invalid();
    id(data.account_id); if (!['in', 'out'].includes(data.kind)) invalid(); cents(data.amount_cents, { positive: true }); day(data.posted_on); day(data.competence_on);
    if (data.category_id !== undefined) id(data.category_id, true); if (data.contact_id !== undefined) id(data.contact_id, true);
    text(data.note, 2000, true); if (data.origin !== undefined && !['manual', 'ledger'].includes(data.origin)) invalid();
    return data;
  }
  if (action === 'entry_delete' || action === 'entry_restore') {
    exact(data, ['id', 'expected_version', 'note'], ['id', 'expected_version']); id(data.id);
    if (!Number.isInteger(data.expected_version) || data.expected_version < 1 || data.expected_version > 2147483647) invalid(); text(data.note, 500); return data;
  }
  if (action === 'balance_adjust') {
    exact(data, ['account_id', 'desired_cents', 'current_cents', 'posted_on'], ['account_id', 'desired_cents', 'current_cents', 'posted_on']);
    id(data.account_id); cents(data.desired_cents, { signed: true }); if (typeof data.current_cents !== 'string' || !/^-?\d{1,30}$/.test(data.current_cents)) invalid(); day(data.posted_on);
    if (data.desired_cents === data.current_cents) invalid(); return data;
  }
  if (action === 'transfer_create') {
    exact(data, ['from_account_id', 'to_account_id', 'amount_cents', 'posted_on', 'float_days', 'note'], ['from_account_id', 'to_account_id', 'amount_cents', 'posted_on']);
    id(data.from_account_id); id(data.to_account_id); if (data.from_account_id.toLowerCase() === data.to_account_id.toLowerCase()) invalid();
    cents(data.amount_cents, { positive: true }); day(data.posted_on);
    if (data.float_days !== undefined && (!Number.isInteger(data.float_days) || data.float_days < 0 || data.float_days > 30)) invalid(); text(data.note, 500); return data;
  }
  if (action === 'transfer_delete') { exact(data, ['transfer_id', 'note'], ['transfer_id']); id(data.transfer_id); text(data.note, 500); return data; }
  exact(data, ['line_kind', 'line_id', 'expected_category_id', 'category_id'], ['line_kind', 'line_id', 'expected_category_id', 'category_id']);
  if (!['entry', 'transfer', 'settlement'].includes(data.line_kind)) invalid(); id(data.line_id); id(data.expected_category_id, true); id(data.category_id, true);
  return data;
}
/** POST /v1/financeiro/actions/{entry_*|balance_adjust|transfer_*|line_categorize}. */
export function cashAction(action, value) {
  if (!CASH_ACTIONS.includes(action)) return null;
  return { kind: 'execute', action, cash: true, rpc: 'erp_finance_cash_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validate(action, value.data) } };
}

const STATEMENT_PARAMS = ['account', 'from', 'to', 'tab', 'deleted', 'category', 'amount_cents', 'q', 'order', 'page', 'limit', 'reconciliation', 'cancelled'];
/** GET /v1/financeiro/extrato, /v1/financeiro/lancamentos/{id} and /v1/financeiro/ficha; null for other paths. */
export function parseCashRead(url) {
  const params = url.searchParams, single = () => { for (const key of params.keys()) if (params.getAll(key).length !== 1) invalid(); };
  if (url.pathname === '/v1/financeiro/extrato') {
    single(); for (const key of params.keys()) if (!STATEMENT_PARAMS.includes(key)) invalid();
    const account = params.get('account'); if (account !== null) id(account);
    const from = day(params.get('from')), to = day(params.get('to')); if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 3660) invalid();
    const tab = params.get('tab') ?? 'all', deleted = params.get('deleted') ?? 'false', order = params.get('order') ?? 'asc', page = params.get('page') ?? '1', limit = params.get('limit') ?? '100';
    if (!['all', 'in', 'out'].includes(tab) || !['true', 'false'].includes(deleted) || !['asc', 'desc'].includes(order) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) invalid();
    const category = params.get('category'); let categories = null;
    if (category !== null) { categories = category.split(',').map(value => value.toLowerCase()); if (categories.length > 200 || categories.some(value => value !== 'none' && !UUID.test(value)) || new Set(categories).size !== categories.length) invalid(); }
    const amount = params.get('amount_cents'); if (amount !== null && !/^[1-9]\d{0,14}$/.test(amount)) invalid();
    const query = params.get('q'); if (query !== null && (query.length > 120 || LINE_CONTROL.test(query))) invalid();
    const reconciliation = params.get('reconciliation'); if (reconciliation !== null && (!['reconciled', 'unreconciled'].includes(reconciliation) || deleted === 'true')) invalid();
    // SQL 246: Situação "Cancelados" (baixas estornadas and their estornos); sent only when asked, never with Excluídos.
    const cancelled = params.get('cancelled'); if (cancelled !== null && (cancelled !== 'true' || deleted === 'true')) invalid();
    return { kind: 'statement', cash: true, rpc: 'erp_finance_statement_page', args: { p_account: account?.toLowerCase() ?? null, p_from: from, p_to: to, p_tab: tab, p_deleted: deleted === 'true', p_categories: categories, p_amount_cents: amount, p_query: query?.trim() || null, p_order: order, p_page: Number(page), p_limit: Number(limit), p_reconciliation: reconciliation, ...(cancelled ? { p_cancelled: true } : {}) } };
  }
  const entry = /^\/v1\/financeiro\/lancamentos\/([^/]+)$/.exec(url.pathname);
  if (entry) { if (!UUID.test(entry[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'cash_entry', cash: true, rpc: 'erp_finance_cash_entry_get', args: { p_id: entry[1].toLowerCase() } }; }
  if (url.pathname === '/v1/financeiro/ficha') {
    single(); for (const key of params.keys()) if (!['contact', 'scope', 'from', 'to', 'page', 'limit'].includes(key)) invalid();
    const contact = params.get('contact'); id(contact); const scope = params.get('scope') ?? 'all'; if (!['all', 'receivable', 'payable'].includes(scope)) invalid();
    const from = day(params.get('from')), to = day(params.get('to')); if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 3660) invalid();
    // SQL 172: the paged ficha (100 lines per page, totals of the whole period) always fits the response bound.
    if (params.has('page') || params.has('limit')) {
      const page = params.get('page') ?? '1', limit = params.get('limit') ?? '100';
      if (!/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) invalid();
      return { kind: 'ledger_page', cash: true, rpc: 'erp_finance_contact_ledger_page', args: { p_contact: contact.toLowerCase(), p_scope: scope, p_from: from, p_to: to, p_page: Number(page), p_limit: Number(limit) } };
    }
    return { kind: 'ledger', cash: true, rpc: 'erp_finance_contact_ledger', args: { p_contact: contact.toLowerCase(), p_scope: scope, p_from: from, p_to: to } };
  }
  if (url.pathname === '/v1/financeiro/contato-em-aberto') {
    single(); for (const key of params.keys()) if (!['contact', 'kind'].includes(key)) invalid();
    const contact = params.get('contact'); id(contact); const kind = params.get('kind'); if (!['receivable', 'payable'].includes(kind)) invalid();
    return { kind: 'open_titles', cash: true, rpc: 'erp_finance_contact_open_titles', args: { p_contact: contact.toLowerCase(), p_kind: kind } };
  }
  return null;
}

const SIGNED = /^-?\d{1,30}$/, UNSIGNED = /^\d{1,30}$/;
const isDay = value => typeof value === 'string' && DAY.test(value);
const opt = (value, check) => value === null || check(value);
const str = max => value => typeof value === 'string' && value.length <= max;
const uuidOk = value => typeof value === 'string' && UUID.test(value);
function projectLine(value, route) {
  const a = route.args;
  if (!object(value) || !uuidOk(value.line_id) || !LINE_KINDS.includes(value.line_kind) || !isDay(value.posted_on) || !opt(value.competence_on, isDay) || !uuidOk(value.account_id) || !str(200)(value.account_name)
    || typeof value.amount_cents !== 'string' || !SIGNED.test(value.amount_cents) || !opt(value.category_id, uuidOk) || !opt(value.category_name, str(200)) || !opt(value.contact_id, uuidOk) || !opt(value.contact_name, str(200))
    || !opt(value.note, str(2000)) || !opt(value.title_id, uuidOk) || !opt(value.title_kind, kind => ['receivable', 'payable'].includes(kind)) || !opt(value.transfer_id, uuidOk) || !opt(value.entry_id, uuidOk)
    || !opt(value.entry_version, version => Number.isSafeInteger(version) && version > 0) || !opt(value.entry_origin, origin => ENTRY_ORIGINS.includes(origin))
    || (value.document !== null && (!object(value.document) || typeof value.document.kind !== 'string' || !/^[1-9]\d{0,9}$/.test(value.document.number ?? '')
      // 363: the origin a conta imported from the Origin declares (V or N), marked source 'origin'.
      || (value.document.source !== undefined && (value.document.source !== 'origin' || !['sales_orders', 'fiscal_invoices'].includes(value.document.kind)))))
    || ((value.line_kind === 'entry') !== (value.entry_id !== null)) || ((value.line_kind === 'transfer') !== (value.transfer_id !== null)) || ((value.line_kind === 'settlement') !== (value.title_id !== null))
    || (a.p_account && value.account_id !== a.p_account) || value.posted_on < a.p_from || value.posted_on > a.p_to
    || (a.p_tab === 'in' && value.amount_cents.startsWith('-')) || (a.p_tab === 'out' && !value.amount_cents.startsWith('-'))
    || (a.p_amount_cents && value.amount_cents.replace('-', '') !== a.p_amount_cents)
    || (a.p_deleted && !['entry', 'transfer'].includes(value.line_kind)) || (a.p_cancelled && value.line_kind !== 'settlement')
    || (a.p_categories && !a.p_categories.some(category => category === 'none' ? value.category_id === null : value.category_id === category))
    || typeof value.reconciled !== 'boolean' || (a.p_reconciliation && value.reconciled !== (a.p_reconciliation === 'reconciled')) || (value.reconciled && value.line_kind === 'opening')) upstreamInvalid();
  return { line_id: value.line_id, line_kind: value.line_kind, posted_on: value.posted_on, competence_on: value.competence_on, account_id: value.account_id, account_name: value.account_name, amount_cents: value.amount_cents,
    category_id: value.category_id, category_name: value.category_name, contact_id: value.contact_id, contact_name: value.contact_name, note: value.note, title_id: value.title_id, title_kind: value.title_kind,
    document: value.document === null ? null : { kind: value.document.kind, number: value.document.number, ...(value.document.source === 'origin' ? { source: 'origin' } : {}) }, transfer_id: value.transfer_id, entry_id: value.entry_id, entry_version: value.entry_version, entry_origin: value.entry_origin, reconciled: value.reconciled };
}
function projectEntry(value) {
  if (!object(value) || !uuidOk(value.id) || !uuidOk(value.account_id) || !str(200)(value.account_name) || !['in', 'out'].includes(value.kind) || typeof value.amount_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(value.amount_cents)
    || !isDay(value.posted_on) || !isDay(value.competence_on) || !opt(value.category_id, uuidOk) || !opt(value.category_name, str(200)) || !opt(value.contact_id, uuidOk) || !opt(value.contact_name, str(200))
    || !str(2000)(value.note) || !ENTRY_ORIGINS.includes(value.origin) || !Number.isSafeInteger(value.version) || value.version < 1 || typeof value.deleted !== 'boolean'
    || !str(100)(value.created_at) || !str(100)(value.updated_at)) upstreamInvalid();
  return { id: value.id, account_id: value.account_id, account_name: value.account_name, kind: value.kind, amount_cents: value.amount_cents, posted_on: value.posted_on, competence_on: value.competence_on,
    category_id: value.category_id, category_name: value.category_name, contact_id: value.contact_id, contact_name: value.contact_name, note: value.note, origin: value.origin, version: value.version, deleted: value.deleted,
    created_at: value.created_at, updated_at: value.updated_at };
}
const LEDGER_SITUATIONS = ['cancelled', 'paid', 'partial', 'due_today', 'overdue', 'open'];
function projectLedgerLine(value, route) {
  if (!object(value) || !isDay(value.day) || !['title', 'payment', 'reversal', 'entry'].includes(value.line_kind) || !uuidOk(value.ref_id) || !['receivable', 'payable'].includes(value.kind)
    || !str(2000)(value.note) || !opt(value.due_on, isDay) || !['debit', 'credit'].includes(value.side) || typeof value.amount_cents !== 'string' || !UNSIGNED.test(value.amount_cents)
    || !opt(value.situation, situation => LEDGER_SITUATIONS.includes(situation)) || (value.line_kind === 'title') !== (value.situation !== null)
    || (value.origin !== null && (!object(value.origin) || typeof value.origin.kind !== 'string' || !/^[1-9]\d{0,9}$/.test(value.origin.number ?? '')))
    || !opt(value.version, version => Number.isSafeInteger(version) && version > 0) || (value.line_kind === 'entry') !== (value.version !== null)
    || value.day < route.args.p_from || value.day > route.args.p_to || (route.args.p_scope !== 'all' && value.kind !== route.args.p_scope)
    || (value.payment_method !== undefined && value.payment_method !== null && !str(100)(value.payment_method))) upstreamInvalid();
  return { day: value.day, line_kind: value.line_kind, ref_id: value.ref_id, kind: value.kind, note: value.note, due_on: value.due_on, side: value.side, amount_cents: value.amount_cents, situation: value.situation,
    origin: value.origin === null ? null : { kind: value.origin.kind, number: value.origin.number }, version: value.version, payment_method: value.payment_method ?? null };
}

export function projectCashResult(route, value) {
  if (route.kind === 'statement') {
    const a = route.args, summary = value.summary;
    const cancelled = a.p_cancelled === true;
    if (value.entity !== 'statement' || value.account_id !== a.p_account || value.from !== a.p_from || value.to !== a.p_to || value.tab !== a.p_tab || value.deleted !== a.p_deleted || value.order !== a.p_order || value.reconciliation !== a.p_reconciliation
      || (value.cancelled ?? false) !== cancelled
      || !Number.isSafeInteger(value.summary?.reconciled_lines) || value.summary.reconciled_lines < 0
      || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))
      || !object(value.day_balances) || Object.entries(value.day_balances).some(([key, cents]) => !DAY.test(key) || typeof cents !== 'string' || !SIGNED.test(cents))
      || !object(summary) || ['before_cents', 'previous_cents', 'closing_cents', 'current_cents'].some(key => typeof summary[key] !== 'string' || !SIGNED.test(summary[key])) || ['in_cents', 'out_cents'].some(key => typeof summary[key] !== 'string' || !UNSIGNED.test(summary[key]))) upstreamInvalid();
    // Excluídos and Cancelados are subsets outside the saldos: their Entradas/Saídas do not add up to the period.
    if (!a.p_deleted && !cancelled && BigInt(summary.previous_cents) + BigInt(summary.in_cents) - BigInt(summary.out_cents) !== BigInt(summary.closing_cents)) upstreamInvalid();
    const seen = new Set(), items = value.items.map(item => { const line = projectLine(item, route); if (seen.has(line.line_id)) upstreamInvalid(); seen.add(line.line_id); return line; });
    for (let index = 1; index < items.length; index++) if (a.p_order === 'asc' ? items[index].posted_on < items[index - 1].posted_on : items[index].posted_on > items[index - 1].posted_on) upstreamInvalid();
    const days = new Set(items.map(item => item.posted_on));
    if (!a.p_deleted && !cancelled && (Object.keys(value.day_balances).length !== days.size || [...days].some(key => !Object.hasOwn(value.day_balances, key)))) upstreamInvalid();
    if (cancelled && Object.keys(value.day_balances).length) upstreamInvalid();
    return { entity: 'statement', account_id: a.p_account, from: a.p_from, to: a.p_to, tab: a.p_tab, deleted: a.p_deleted, ...(cancelled ? { cancelled: true } : {}), order: a.p_order, reconciliation: a.p_reconciliation, page: a.p_page, limit: a.p_limit, total: value.total, items,
      day_balances: { ...value.day_balances }, summary: { before_cents: summary.before_cents, previous_cents: summary.previous_cents, in_cents: summary.in_cents, out_cents: summary.out_cents, closing_cents: summary.closing_cents, current_cents: summary.current_cents, reconciled_lines: summary.reconciled_lines }, data_mode: 'erp_native' };
  }
  if (route.kind === 'cash_entry') { if (value.entity !== 'cash_entries') upstreamInvalid(); const record = projectEntry(value.record); if (record.id !== route.args.p_id) upstreamInvalid(); return { entity: 'cash_entries', record, data_mode: 'erp_native' }; }
  if (route.kind === 'open_titles') {
    const a = route.args;
    if (value.entity !== 'contact_open_titles' || value.contact_id !== a.p_contact || value.kind !== a.p_kind || !Number.isSafeInteger(value.total) || value.total < 0 || !Number.isSafeInteger(value.overdue) || value.overdue < 0 || value.overdue > value.total
      || typeof value.balance_cents !== 'string' || !UNSIGNED.test(value.balance_cents) || typeof value.overdue_cents !== 'string' || !UNSIGNED.test(value.overdue_cents) || BigInt(value.overdue_cents) > BigInt(value.balance_cents)
      || !Array.isArray(value.items) || value.items.length > Math.min(50, value.total)) upstreamInvalid();
    const items = value.items.map(item => { if (!object(item) || !uuidOk(item.id) || !str(260)(item.description) || !isDay(item.due_on) || typeof item.amount_cents !== 'string' || !UNSIGNED.test(item.amount_cents) || typeof item.balance_cents !== 'string' || !UNSIGNED.test(item.balance_cents)
      || BigInt(item.balance_cents) < 1n || BigInt(item.balance_cents) > BigInt(item.amount_cents) || typeof item.overdue !== 'boolean') upstreamInvalid(); return { id: item.id, description: item.description, due_on: item.due_on, amount_cents: item.amount_cents, balance_cents: item.balance_cents, overdue: item.overdue }; });
    return { entity: 'contact_open_titles', contact_id: a.p_contact, kind: a.p_kind, total: value.total, balance_cents: value.balance_cents, overdue: value.overdue, overdue_cents: value.overdue_cents, items, data_mode: 'erp_native' };
  }
  if (route.kind === 'ledger' || route.kind === 'ledger_page') {
    const totals = value.totals, paged = route.kind === 'ledger_page';
    if (value.entity !== 'contact_ledger' || value.contact_id !== route.args.p_contact || !str(200)(value.contact_name) || value.scope !== route.args.p_scope || value.from !== route.args.p_from || value.to !== route.args.p_to
      || (paged && (value.page !== route.args.p_page || value.limit !== route.args.p_limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(route.args.p_limit, value.total - (route.args.p_page - 1) * route.args.p_limit))))
      || !Array.isArray(value.items) || value.items.length > 5000 || !object(totals) || ['debit_cents', 'credit_cents'].some(key => typeof totals[key] !== 'string' || !UNSIGNED.test(totals[key]))
      || typeof totals.balance_cents !== 'string' || !SIGNED.test(totals.balance_cents) || BigInt(totals.credit_cents) - BigInt(totals.debit_cents) !== BigInt(totals.balance_cents)) upstreamInvalid();
    return { entity: 'contact_ledger', contact_id: value.contact_id, contact_name: value.contact_name, scope: value.scope, from: value.from, to: value.to, ...(paged ? { page: value.page, limit: value.limit, total: value.total } : {}), items: value.items.map(item => projectLedgerLine(item, route)),
      totals: { debit_cents: totals.debit_cents, credit_cents: totals.credit_cents, balance_cents: totals.balance_cents }, data_mode: 'erp_native' };
  }
  if (value.action !== route.action || typeof value.replayed !== 'boolean') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, data_mode: 'erp_native' }, data = route.args.p_data;
  if (['entry_save', 'entry_delete', 'entry_restore', 'balance_adjust'].includes(route.action)) {
    if (value.entity !== 'cash_entries') upstreamInvalid(); const record = projectEntry(value.record);
    if ((route.action !== 'entry_save' || data.id) && route.action !== 'balance_adjust' && record.id !== data.id.toLowerCase()) upstreamInvalid();
    if (route.action === 'entry_delete' && !record.deleted || route.action === 'entry_restore' && record.deleted) upstreamInvalid();
    if (route.action === 'balance_adjust' && (record.origin !== 'adjustment' || record.account_id !== data.account_id.toLowerCase() || value.balance_cents !== data.desired_cents)) upstreamInvalid();
    return { ...output, entity: 'cash_entries', record, ...(route.action === 'balance_adjust' ? { balance_cents: value.balance_cents } : {}) };
  }
  if (route.action === 'transfer_create') {
    const r = value.record;
    if (value.entity !== 'transfers' || !object(r) || !uuidOk(r.id) || r.from_account_id !== data.from_account_id.toLowerCase() || r.to_account_id !== data.to_account_id.toLowerCase() || r.amount_cents !== data.amount_cents
      || r.posted_on !== data.posted_on || !isDay(r.in_posted_on) || r.float_days !== (data.float_days ?? 0) || !str(500)(r.note)) upstreamInvalid();
    return { ...output, entity: 'transfers', record: { id: r.id, from_account_id: r.from_account_id, to_account_id: r.to_account_id, amount_cents: r.amount_cents, posted_on: r.posted_on, in_posted_on: r.in_posted_on, float_days: r.float_days, note: r.note } };
  }
  if (route.action === 'transfer_delete') {
    const r = value.record; if (value.entity !== 'transfers' || !object(r) || r.id !== data.transfer_id.toLowerCase() || r.deleted !== true || !uuidOk(r.reversal_id)) upstreamInvalid();
    return { ...output, entity: 'transfers', record: { id: r.id, deleted: true, reversal_id: r.reversal_id } };
  }
  const r = value.record;
  if (value.entity !== 'statement' || !object(r) || r.line_kind !== data.line_kind || r.line_id !== data.line_id.toLowerCase() || r.category_id !== (data.category_id?.toLowerCase() ?? null)) upstreamInvalid();
  return { ...output, entity: 'statement', record: { line_kind: r.line_kind, line_id: r.line_id, category_id: r.category_id } };
}
