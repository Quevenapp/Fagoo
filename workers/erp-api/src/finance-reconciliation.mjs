/** Conciliação bancária (SQL 137): OFX import read here, queue, candidates and the reconciliation commands. SQL is the authority. */
import { FinanceError } from './finance.mjs';
import { OfxError, parseOfx, OFX_MAX_CHARS } from './finance-ofx.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/;
// SQL 212: line_dismiss is Origin "Desfazer vínculo" (discard the sugestão of a pending line), in its own RPC.
export const RECONCILIATION_ACTIONS = ['statement_import', 'statement_delete', 'line_reconcile', 'line_unreconcile', 'line_hide', 'line_show', 'line_create_entry', 'line_create_transfer', 'line_settle_titles', 'line_dismiss'];
export const STATEMENT_IMPORT_BODY_BYTES = 3 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = []) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = (value, nullable = false) => { if (nullable && value === null) return; if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
const text = (value, max) => { if (value === null || value === undefined) return; if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(); };
async function sha256(textValue) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textValue)); return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

/** POST /v1/financeiro/actions/{statement_*|line_*}: the OFX file is parsed here; only its transactions reach SQL. */
export async function reconciliationAction(action, value) {
  if (!RECONCILIATION_ACTIONS.includes(action)) return null;
  const data = value.data;
  let payload;
  if (action === 'statement_import') {
    exact(data, ['account_id', 'file_name', 'content'], ['account_id', 'file_name', 'content']); id(data.account_id);
    if (typeof data.file_name !== 'string' || !data.file_name.trim() || data.file_name.length > 200 || /[\x00-\x1f\x7f]/.test(data.file_name) || !/\.ofx$/i.test(data.file_name)) invalid();
    if (typeof data.content !== 'string' || !data.content.length || data.content.length > OFX_MAX_CHARS) invalid();
    let parsed; try { parsed = parseOfx(data.content); } catch (error) { if (error instanceof OfxError) throw new FinanceError(422, 'ERP_OFX_INVALID'); throw error; }
    payload = { account_id: data.account_id.toLowerCase(), file_name: data.file_name.trim(), file_hash: await sha256(data.content), period_from: parsed.period_from, period_to: parsed.period_to, lines: parsed.lines };
  } else if (action === 'statement_delete') { exact(data, ['id'], ['id']); id(data.id); payload = data; }
  else {
    const extra = { line_reconcile: ['links'], line_unreconcile: ['reverse'], line_create_entry: ['category_id', 'contact_id', 'note'], line_create_transfer: ['other_account_id'], line_settle_titles: ['items'], line_dismiss: ['target'] }[action] ?? [];
    exact(data, ['line_id', 'expected_version', ...extra], ['line_id', 'expected_version', ...(['line_reconcile', 'line_create_transfer', 'line_settle_titles', 'line_dismiss'].includes(action) ? extra : [])]);
    id(data.line_id); version(data.expected_version);
    if (action === 'line_reconcile') { if (!Array.isArray(data.links) || data.links.length < 1 || data.links.length > 50) invalid(); const seen = new Set(); for (const link of data.links) { exact(link, ['kind', 'id'], ['kind', 'id']); if (!['entry', 'movement'].includes(link.kind)) invalid(); id(link.id); const key = `${link.kind}:${link.id.toLowerCase()}`; if (seen.has(key)) invalid(); seen.add(key); } }
    if (action === 'line_unreconcile' && data.reverse !== undefined && typeof data.reverse !== 'boolean') invalid();
    if (action === 'line_create_entry') { if (data.category_id !== undefined) id(data.category_id, true); if (data.contact_id !== undefined) id(data.contact_id, true); text(data.note, 2000); }
    if (action === 'line_create_transfer') id(data.other_account_id);
    if (action === 'line_dismiss') { exact(data.target, ['kind', 'id'], ['kind', 'id']); if (!['entry', 'movement'].includes(data.target.kind)) invalid(); id(data.target.id); }
    if (action === 'line_settle_titles') { if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50) invalid(); const seen = new Set(); for (const item of data.items) { exact(item, ['id', 'expected_version', 'principal_cents'], ['id', 'expected_version', 'principal_cents']); id(item.id); version(item.expected_version); if (typeof item.principal_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(item.principal_cents)) invalid(); if (seen.has(item.id.toLowerCase())) invalid(); seen.add(item.id.toLowerCase()); } }
    payload = data;
  }
  if (action === 'line_dismiss') return { kind: 'execute', action, reconciliation: true, rpc: 'erp_finance_reconciliation_dismiss', args: { p_command_id: value.command_id, p_data: payload } };
  return { kind: 'execute', action, reconciliation: true, rpc: 'erp_finance_reconciliation_execute', args: { p_command_id: value.command_id, p_action: action, p_data: payload } };
}

/** GET /v1/financeiro/conciliacao and /v1/financeiro/conciliacao/candidatos; null for other paths. */
export function parseReconciliationRead(url) {
  const params = url.searchParams, single = allowed => { for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid(); };
  if (url.pathname === '/v1/financeiro/conciliacao') {
    single(['account', 'state', 'amount_cents', 'page', 'limit']);
    const account = params.get('account'); id(account); const state = params.get('state') ?? 'pending', page = params.get('page') ?? '1', limit = params.get('limit') ?? '50', amount = params.get('amount_cents');
    if (!['pending', 'reconciled', 'hidden'].includes(state) || !/^[1-9]\d{0,5}$/.test(page) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || (amount !== null && !/^[1-9]\d{0,14}$/.test(amount))) invalid();
    return { kind: 'queue', reconciliation: true, rpc: 'erp_finance_reconciliation_page', args: { p_account: account.toLowerCase(), p_state: state, p_amount_cents: amount, p_page: Number(page), p_limit: Number(limit) } };
  }
  if (url.pathname === '/v1/financeiro/conciliacao/candidatos') {
    single(['account', 'from', 'to', 'q', 'amount_cents']);
    const account = params.get('account'); id(account); const from = day(params.get('from')), to = day(params.get('to')); if (from > to) invalid();
    const query = params.get('q'); if (query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query))) invalid();
    const amount = params.get('amount_cents'); if (amount !== null && !/^[1-9]\d{0,14}$/.test(amount)) invalid();
    return { kind: 'candidates', reconciliation: true, rpc: 'erp_finance_reconciliation_candidates', args: { p_account: account.toLowerCase(), p_from: from, p_to: to, p_query: query?.trim() || null, p_amount_cents: amount } };
  }
  return null;
}

const SIGNED = /^-?\d{1,30}$/;
const isDay = value => typeof value === 'string' && DAY.test(value);
const opt = (value, check) => value === null || check(value);
const str = max => value => typeof value === 'string' && value.length <= max;
const uuidOk = value => typeof value === 'string' && UUID.test(value);
function projectCandidate(value) {
  if (!object(value) || !['entry', 'movement'].includes(value.kind) || !uuidOk(value.id) || !['entry', 'transfer', 'settlement'].includes(value.line_kind) || (value.kind === 'entry') !== (value.line_kind === 'entry')
    || !isDay(value.posted_on) || typeof value.amount_cents !== 'string' || !SIGNED.test(value.amount_cents) || !opt(value.note, str(2000)) || !opt(value.contact_name ?? null, str(200))) upstreamInvalid();
  return { kind: value.kind, id: value.id, line_kind: value.line_kind, posted_on: value.posted_on, amount_cents: value.amount_cents, note: value.note, contact_name: value.contact_name ?? null,
    ...(value.category_name !== undefined ? { category_name: opt(value.category_name, str(200)) ? value.category_name : upstreamInvalid() } : {}),
    ...(value.entry_origin !== undefined ? { entry_origin: value.entry_origin } : {}), ...(value.entry_version !== undefined ? { entry_version: value.entry_version } : {}),
    ...(value.title_kind !== undefined ? { title_kind: value.title_kind } : {}), ...(value.link_id !== undefined ? { link_id: uuidOk(value.link_id) ? value.link_id : upstreamInvalid() } : {}) };
}
function projectLine(value, account) {
  if (!object(value) || !uuidOk(value.id) || !uuidOk(value.statement_id) || value.account_id !== account || !str(255)(value.fitid) || !isDay(value.posted_on) || typeof value.amount_cents !== 'string' || !/^-?[1-9]\d{0,14}$/.test(value.amount_cents)
    || !opt(value.memo, str(255)) || !opt(value.trntype, item => /^[A-Z]{1,20}$/.test(item)) || !['pending', 'reconciled', 'hidden'].includes(value.state) || !Number.isSafeInteger(value.version) || value.version < 1
    || !Array.isArray(value.links) || (value.state === 'reconciled') !== (value.links.length > 0) || (value.suggestion !== null && value.state !== 'pending')) upstreamInvalid();
  const links = value.links.map(projectCandidate);
  if (value.state === 'reconciled' && links.reduce((sum, link) => sum + BigInt(link.amount_cents), 0n) !== BigInt(value.amount_cents)) upstreamInvalid();
  const suggestion = value.suggestion === null ? null : projectCandidate(value.suggestion);
  if (suggestion && suggestion.amount_cents !== value.amount_cents) upstreamInvalid();
  return { id: value.id, statement_id: value.statement_id, account_id: value.account_id, fitid: value.fitid, posted_on: value.posted_on, amount_cents: value.amount_cents, memo: value.memo, trntype: value.trntype, state: value.state, version: value.version, links, suggestion };
}

export function projectReconciliationResult(route, value) {
  if (route.kind === 'queue') {
    const a = route.args, counts = value.counts;
    if (value.entity !== 'reconciliation' || value.account_id !== a.p_account || value.state !== a.p_state || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || value.total < 0
      || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit)) || !object(counts) || ['pending', 'reconciled', 'hidden'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)
      || counts[a.p_state] < value.total || !Array.isArray(value.statements)) upstreamInvalid();
    const items = value.items.map(item => { const line = projectLine(item, a.p_account); if (line.state !== a.p_state || (a.p_amount_cents && line.amount_cents.replace('-', '') !== a.p_amount_cents)) upstreamInvalid(); return line; });
    const statements = value.statements.map(item => {
      if (!object(item) || !uuidOk(item.id) || !str(200)(item.file_name) || !str(100)(item.created_at) || !isDay(item.period_from) || !isDay(item.period_to) || !Number.isSafeInteger(item.lines) || !Number.isSafeInteger(item.reconciled) || item.reconciled > item.lines) upstreamInvalid();
      return { id: item.id, file_name: item.file_name, created_at: item.created_at, period_from: item.period_from, period_to: item.period_to, lines: item.lines, reconciled: item.reconciled };
    });
    return { entity: 'reconciliation', account_id: a.p_account, state: a.p_state, page: a.p_page, limit: a.p_limit, total: value.total, items, counts: { pending: counts.pending, reconciled: counts.reconciled, hidden: counts.hidden }, statements, data_mode: 'erp_native' };
  }
  if (route.kind === 'candidates') {
    const a = route.args;
    if (value.entity !== 'reconciliation_candidates' || value.account_id !== a.p_account || value.from !== a.p_from || value.to !== a.p_to || !Array.isArray(value.movements) || value.movements.length > 100 || !Array.isArray(value.titles) || value.titles.length > 100) upstreamInvalid();
    const movements = value.movements.map(item => { const candidate = projectCandidate(item); if (candidate.posted_on < a.p_from || candidate.posted_on > a.p_to || (a.p_amount_cents && candidate.amount_cents.replace('-', '') !== a.p_amount_cents)) upstreamInvalid(); return candidate; });
    const titles = value.titles.map(item => {
      if (!object(item) || !uuidOk(item.id) || !['receivable', 'payable'].includes(item.kind) || !Number.isSafeInteger(item.version) || item.version < 1 || !str(200)(item.contact_name) || !str(2000)(item.description) || !isDay(item.due_on)
        || item.due_on < a.p_from || item.due_on > a.p_to || typeof item.balance_cents !== 'string' || !/^[1-9]\d{0,14}$/.test(item.balance_cents) || !Number.isSafeInteger(item.installment) || !Number.isSafeInteger(item.installments)
        || !opt(item.payment_method_name ?? null, str(100))) upstreamInvalid();
      // SQL 175: the Forma de pagamento column of Buscar.
      return { id: item.id, kind: item.kind, version: item.version, contact_name: item.contact_name, description: item.description, due_on: item.due_on, balance_cents: item.balance_cents, installment: item.installment, installments: item.installments, payment_method_name: item.payment_method_name ?? null };
    });
    return { entity: 'reconciliation_candidates', account_id: a.p_account, from: a.p_from, to: a.p_to, movements, titles, data_mode: 'erp_native' };
  }
  if (value.action !== route.action || typeof value.replayed !== 'boolean' || value.entity !== 'reconciliation' || !object(value.record)) upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, entity: 'reconciliation', data_mode: 'erp_native' }, r = value.record, data = route.args.p_data;
  if (route.action === 'statement_import') {
    if (!uuidOk(r.id) || r.account_id !== data.account_id || r.file_name !== data.file_name || r.period_from !== data.period_from || r.period_to !== data.period_to || r.bank_lines !== data.lines.length || !Number.isSafeInteger(r.new_lines) || r.new_lines < 0 || r.new_lines > r.bank_lines) upstreamInvalid();
    return { ...output, record: { id: r.id, account_id: r.account_id, file_name: r.file_name, period_from: r.period_from, period_to: r.period_to, bank_lines: r.bank_lines, new_lines: r.new_lines } };
  }
  if (route.action === 'statement_delete') { if (r.id !== data.id.toLowerCase() || r.deleted !== true) upstreamInvalid(); return { ...output, record: { id: r.id, deleted: true } }; }
  const line = projectLine(r, r.account_id);
  const expected = { line_reconcile: 'reconciled', line_create_entry: 'reconciled', line_create_transfer: 'reconciled', line_settle_titles: 'reconciled', line_hide: 'hidden', line_show: 'pending', line_unreconcile: 'pending', line_dismiss: 'pending' }[route.action];
  if (line.id !== data.line_id.toLowerCase() || line.state !== expected || line.version <= data.expected_version) upstreamInvalid();
  // The discarded sugestão is the one asked for, and it is not suggested again.
  if (route.action === 'line_dismiss' && (!object(value.dismissed) || value.dismissed.kind !== data.target.kind || value.dismissed.id !== data.target.id.toLowerCase()
    || (line.suggestion && line.suggestion.kind === data.target.kind && line.suggestion.id === value.dismissed.id))) upstreamInvalid();
  return { ...output, record: line };
}
