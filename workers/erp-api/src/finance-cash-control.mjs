/** Financeiro > Controle de caixa (SQL 173): caixas, sangrias, suprimentos, valores informados e conferência. SQL is the authority. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, CONTROL = /[\x00-\x1f\x7f]/, UNSIGNED = /^\d{1,30}$/;
export const CASH_CONTROL_ACTIONS = ['session_open', 'session_save', 'session_close', 'session_reopen', 'session_move', 'session_move_delete', 'session_delete'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = keys) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = value => { if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); };
const cents = (value, positive = false) => { if (typeof value !== 'string' || !/^\d{1,15}$/.test(value) || (positive && /^0+$/.test(value))) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function values(list) {
  if (!Array.isArray(list) || list.length > 50) invalid();
  for (const item of list) { exact(item, ['payment_method_id', 'amount_cents']); id(item.payment_method_id); cents(item.amount_cents); }
}
function validate(action, data) {
  if (action === 'session_open') { exact(data, ['account_id', 'change_cents']); id(data.account_id); cents(data.change_cents); return data; }
  if (action === 'session_save') { exact(data, ['id', 'expected_version', 'values', 'checked'], ['id', 'expected_version', 'checked']); id(data.id); version(data.expected_version); if (typeof data.checked !== 'boolean') invalid(); if (data.values !== undefined) values(data.values); return data; }
  if (action === 'session_close') { exact(data, ['id', 'expected_version', 'values']); id(data.id); version(data.expected_version); values(data.values); return data; }
  if (action === 'session_move') {
    exact(data, ['id', 'expected_version', 'kind', 'posted_on', 'amount_cents', 'note'], ['id', 'expected_version', 'kind', 'amount_cents']); id(data.id); version(data.expected_version);
    if (!['withdrawal', 'supply'].includes(data.kind)) invalid(); if (data.posted_on !== undefined && data.posted_on !== null) day(data.posted_on); cents(data.amount_cents, true);
    if (data.note !== undefined && data.note !== null && (typeof data.note !== 'string' || data.note.length > 240 || CONTROL.test(data.note))) invalid();
    return data;
  }
  if (action === 'session_move_delete') { exact(data, ['id', 'expected_version', 'move_id']); id(data.id); version(data.expected_version); id(data.move_id); return data; }
  exact(data, ['id', 'expected_version']); id(data.id); version(data.expected_version); return data;
}
/** POST /v1/financeiro/actions/session_*; null for other actions. */
export function cashControlAction(action, value) {
  if (!CASH_CONTROL_ACTIONS.includes(action)) return null;
  return { kind: 'execute', action, cashControl: true, rpc: 'erp_finance_cash_session_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validate(action, value.data) } };
}
/** GET /v1/financeiro/controle-caixa and /v1/financeiro/controle-caixa/{id}; null for other paths. */
export function parseCashControlRead(url) {
  const params = url.searchParams;
  const single = /^\/v1\/financeiro\/controle-caixa\/([^/]+)$/.exec(url.pathname);
  if (single) { if (!UUID.test(single[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'cash_session', cashControl: true, rpc: 'erp_finance_cash_session_get', args: { p_id: single[1].toLowerCase() } }; }
  if (url.pathname !== '/v1/financeiro/controle-caixa') return null;
  for (const key of params.keys()) if (!['state', 'all', 'q', 'from', 'to', 'page', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
  const state = params.get('state') ?? 'all', all = params.get('all') ?? 'false', page = params.get('page') ?? '1', limit = params.get('limit') ?? '100', query = params.get('q');
  if (!['all', 'open', 'closed', 'checked'].includes(state) || !['true', 'false'].includes(all) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100
    || (query !== null && (query.length > 120 || CONTROL.test(query)))) invalid();
  const from = params.has('from') ? day(params.get('from')) : null, to = params.has('to') ? day(params.get('to')) : null; if (from && to && from > to) invalid();
  return { kind: 'cash_session_page', cashControl: true, rpc: 'erp_finance_cash_session_page', args: { p_state: state, p_all: all === 'true', p_query: query?.trim() || null, p_from: from, p_to: to, p_page: Number(page), p_limit: Number(limit) } };
}

const isDay = value => typeof value === 'string' && DAY.test(value);
const isUuid = value => typeof value === 'string' && UUID.test(value);
const unsigned = value => typeof value === 'string' && UNSIGNED.test(value);
const str = (value, max) => typeof value === 'string' && value.length <= max;
function projectSession(value, lines) {
  if (!object(value) || !isUuid(value.id) || !isUuid(value.account_id) || !str(value.account_name, 200) || !isUuid(value.operator_id) || !str(value.operator_name, 200) || !str(value.opened_at, 100) || !isDay(value.opened_on)
    || !unsigned(value.previous_change_cents) || !unsigned(value.change_cents) || !['open', 'closed'].includes(value.state) || (value.closed_by_name !== null && !str(value.closed_by_name, 200)) || (value.closed_at !== null && !str(value.closed_at, 100))
    || (value.state === 'open') !== (value.closed_at === null) || typeof value.checked !== 'boolean' || (value.checked && value.state !== 'closed') || !unsigned(value.supply_cents) || !unsigned(value.withdrawal_cents)
    || typeof value.expected_cash_cents !== 'string' || !/^-?\d{1,30}$/.test(value.expected_cash_cents) || BigInt(value.change_cents) + BigInt(value.supply_cents) - BigInt(value.withdrawal_cents) !== BigInt(value.expected_cash_cents)
    || !unsigned(value.informed_cents) || !Number.isSafeInteger(value.version) || value.version < 1 || !str(value.created_at, 100)) upstreamInvalid();
  const out = { id: value.id, account_id: value.account_id, account_name: value.account_name, operator_id: value.operator_id, operator_name: value.operator_name, opened_at: value.opened_at, opened_on: value.opened_on,
    previous_change_cents: value.previous_change_cents, change_cents: value.change_cents, state: value.state, closed_by_name: value.closed_by_name, closed_at: value.closed_at, checked: value.checked,
    supply_cents: value.supply_cents, withdrawal_cents: value.withdrawal_cents, expected_cash_cents: value.expected_cash_cents, informed_cents: value.informed_cents, version: value.version, created_at: value.created_at };
  if (!lines) return out;
  if (!Array.isArray(value.values) || value.values.length > 50 || !Array.isArray(value.methods) || value.methods.length > 50 || !Array.isArray(value.moves) || value.moves.length > 5000) upstreamInvalid();
  let informed = 0n;
  out.values = value.values.map(item => { if (!object(item) || !isUuid(item.payment_method_id) || !str(item.payment_method_name, 100) || !unsigned(item.amount_cents)) upstreamInvalid(); informed += BigInt(item.amount_cents); return { payment_method_id: item.payment_method_id, payment_method_name: item.payment_method_name, amount_cents: item.amount_cents }; });
  if (informed !== BigInt(value.informed_cents)) upstreamInvalid();
  out.methods = value.methods.map(item => { if (!object(item) || !isUuid(item.payment_method_id) || !str(item.name, 100) || !unsigned(item.registered_cents) || !unsigned(item.informed_cents) || typeof item.difference_cents !== 'string' || !/^-?\d{1,30}$/.test(item.difference_cents)
    || BigInt(item.informed_cents) - BigInt(item.registered_cents) !== BigInt(item.difference_cents)) upstreamInvalid(); return { payment_method_id: item.payment_method_id, name: item.name, registered_cents: item.registered_cents, informed_cents: item.informed_cents, difference_cents: item.difference_cents }; });
  let supplies = 0n, withdrawals = 0n;
  out.moves = value.moves.map(item => { if (!object(item) || !isUuid(item.id) || !['withdrawal', 'supply'].includes(item.kind) || !isDay(item.posted_on) || (item.note !== null && !str(item.note, 240)) || !unsigned(item.amount_cents) || !str(item.created_at, 100)) upstreamInvalid();
    if (item.kind === 'supply') supplies += BigInt(item.amount_cents); else withdrawals += BigInt(item.amount_cents);
    return { id: item.id, kind: item.kind, posted_on: item.posted_on, note: item.note, amount_cents: item.amount_cents, created_at: item.created_at }; });
  if (supplies !== BigInt(value.supply_cents) || withdrawals !== BigInt(value.withdrawal_cents)) upstreamInvalid();
  return out;
}
export function projectCashControlResult(route, value) {
  if (route.kind === 'cash_session_page') {
    const a = route.args;
    if (value.entity !== 'cash_sessions' || value.state !== a.p_state || value.all !== a.p_all || value.from !== a.p_from || value.to !== a.p_to || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || value.total < 0
      || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))) upstreamInvalid();
    const items = value.items.map(item => { const record = projectSession(item, false);
      if ((a.p_state === 'open' && record.state !== 'open') || (a.p_state === 'closed' && (record.state !== 'closed' || record.checked)) || (a.p_state === 'checked' && !record.checked) || (a.p_from && record.opened_on < a.p_from) || (a.p_to && record.opened_on > a.p_to)) upstreamInvalid();
      return record; });
    return { entity: 'cash_sessions', state: a.p_state, all: a.p_all, from: a.p_from, to: a.p_to, page: a.p_page, limit: a.p_limit, total: value.total, items, data_mode: 'erp_native' };
  }
  if (route.kind === 'cash_session') { if (value.entity !== 'cash_sessions') upstreamInvalid(); const record = projectSession(value.record, true); if (record.id !== route.args.p_id) upstreamInvalid(); return { entity: 'cash_sessions', record, data_mode: 'erp_native' }; }
  if (value.action !== route.action || typeof value.replayed !== 'boolean' || value.entity !== 'cash_sessions') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, entity: 'cash_sessions', data_mode: 'erp_native' }, data = route.args.p_data;
  if (route.action === 'session_delete') { if (!object(value.record) || value.record.id !== data.id.toLowerCase() || value.record.deleted !== true) upstreamInvalid(); return { ...output, record: { id: value.record.id, deleted: true } }; }
  const record = projectSession(value.record, true);
  if ((route.action !== 'session_open' && record.id !== data.id.toLowerCase()) || (route.action === 'session_open' && (record.account_id !== data.account_id.toLowerCase() || record.change_cents !== String(BigInt(data.change_cents)) || record.state !== 'open'))
    || (route.action === 'session_close' && record.state !== 'closed') || (route.action === 'session_reopen' && record.state !== 'open') || (route.action === 'session_save' && record.checked !== data.checked)) upstreamInvalid();
  return { ...output, record };
}
