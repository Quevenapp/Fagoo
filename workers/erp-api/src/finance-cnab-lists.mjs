/** Remessas e Retornos (CNAB) no padrão Origin (SQL 213): listagens, detalhes e as exclusões permitidas. Bank operations stay off:
 * nothing here generates, transmits or reads a file. GET /v1/financeiro/(remessas|retornos)[/{id}] and
 * POST /v1/financeiro/actions/(remittance_exclude|return_exclude). SQL is the authority for roles and states.
 * SQL 372 (leva H): GET /v1/financeiro/remessa-candidatos?forma=&conta=&sem_conta=&q=&after=&limit= lists the contas a receber that a
 * new remessa may include (in no other remessa), with the Forma de pagamento and Conta financeira filters; read-only. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, SHA = /^[a-f0-9]{64}$/;
export const CNAB_LIST_ACTIONS = ['remittance_exclude', 'return_exclude'];
const GROUPS = { entradas: 'entries', baixas: 'settlements', outras: 'others' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const isDay = value => typeof value === 'string' && DAY.test(value);
const stamp = value => typeof value === 'string' && value.length > 0 && value.length <= 64;
const cents = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const text = (value, max, nullable = true) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
function day(value) {
  if (!isDay(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function listArgs(params) {
  for (const key of params.keys()) if (!['q', 'from', 'to', 'page', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
  const query = params.get('q'), from = params.has('from') ? day(params.get('from')) : null, to = params.has('to') ? day(params.get('to')) : null, page = params.get('page') ?? '1', limit = params.get('limit') ?? '50';
  if ((query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query))) || (from && to && from > to) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) invalid();
  return { p_query: query?.trim() || null, p_from: from, p_to: to, p_page: Number(page), p_limit: Number(limit) };
}

function candidateArgs(params) {
  for (const key of params.keys()) if (!['forma', 'conta', 'sem_conta', 'q', 'after', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
  const method = params.get('forma'), account = params.get('conta'), without = params.get('sem_conta') ?? 'true', query = params.get('q'), after = params.get('after'), limit = params.get('limit') ?? '15';
  if ((method !== null && !UUID.test(method)) || (account !== null && !UUID.test(account)) || !['true', 'false'].includes(without) || (query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query)))
    || (after !== null && !UUID.test(after)) || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 15) invalid();
  return { p_payment_method_id: method?.toLowerCase() ?? null, p_account_id: account?.toLowerCase() ?? null, p_without_account: without === 'true', p_query: query?.trim() || null,
    p_after: after?.toLowerCase() ?? null, p_limit: Number(limit) };
}
function projectCandidates(route, value) {
  const a = route.args, f = value.filters;
  if (value.entity !== 'titles' || value.operational_effects !== false || !Array.isArray(value.items) || value.items.length > a.p_limit || typeof value.has_more !== 'boolean'
    || (value.has_more ? !UUID.test(value.next_cursor ?? '') : value.next_cursor !== null) || !Number.isSafeInteger(value.eligible_total) || value.eligible_total < value.items.length || value.remittance_limit !== 30
    || !object(f) || f.payment_method_id !== a.p_payment_method_id || f.account_id !== a.p_account_id || f.without_account !== a.p_without_account
    || !Array.isArray(value.payment_methods) || value.payment_methods.length > 200) upstreamInvalid();
  const seen = new Set(), items = value.items.map(row => {
    if (!object(row) || !UUID.test(row.id ?? '') || seen.has(row.id) || (a.p_after && row.id <= a.p_after) || !Number.isSafeInteger(row.version) || row.version < 1 || row.kind !== 'receivable' || !text(row.description, 500, false)
      || !text(row.contact_name, 200, false) || !cents(row.amount_cents) || row.amount_cents === '0' || row.settled_cents !== '0' || !isDay(row.issued_on) || !isDay(row.due_on) || row.cancelled !== false
      || typeof row.payer_ready !== 'boolean' || (row.account_id !== null && !UUID.test(row.account_id)) || !text(row.account_name, 200) || (row.payment_method_id !== null && !UUID.test(row.payment_method_id))
      || !text(row.payment_method_name, 200) || (a.p_payment_method_id && row.payment_method_id !== a.p_payment_method_id)
      || (a.p_account_id && row.account_id !== a.p_account_id && !(a.p_without_account && row.account_id === null)) || (!a.p_without_account && !a.p_account_id && row.account_id === null)) upstreamInvalid();
    seen.add(row.id);
    return Object.fromEntries(['id', 'version', 'kind', 'description', 'contact_name', 'amount_cents', 'settled_cents', 'issued_on', 'due_on', 'cancelled', 'payer_ready', 'account_id', 'account_name', 'payment_method_id', 'payment_method_name'].map(key => [key, row[key]]));
  });
  const methods = value.payment_methods.map(item => {
    if (!object(item) || !UUID.test(item.id ?? '') || !text(item.description, 200, false) || typeof item.active !== 'boolean' || typeof item.linked !== 'boolean') upstreamInvalid();
    return { id: item.id, description: item.description, active: item.active, linked: item.linked };
  });
  return { entity: 'titles', data_mode: 'erp_native', operational_effects: false, items, has_more: value.has_more, next_cursor: value.next_cursor, eligible_total: value.eligible_total, remittance_limit: 30,
    filters: { payment_method_id: f.payment_method_id, account_id: f.account_id, without_account: f.without_account }, payment_methods: methods };
}

export function parseCnabListRead(url) {
  if (url.pathname === '/v1/financeiro/remessa-candidatos') return { kind: 'remittance_candidates', cnabList: true, rpc: 'erp_cnab_remittance_candidates', args: candidateArgs(url.searchParams) };
  const remittance = /^\/v1\/financeiro\/remessas(?:\/([a-fA-F0-9-]+))?$/.exec(url.pathname), returned = /^\/v1\/financeiro\/retornos(?:\/([a-fA-F0-9-]+))?$/.exec(url.pathname);
  if (!remittance && !returned) return null;
  const id = (remittance ?? returned)[1];
  if (id !== undefined && !UUID.test(id)) throw new FinanceError(404, 'ERP_NOT_FOUND');
  if (remittance) {
    if (id) { if (url.search) invalid(); return { kind: 'remittance_detail', cnabList: true, rpc: 'erp_cnab_remittance_detail', args: { p_id: id.toLowerCase() } }; }
    return { kind: 'remittance_page', cnabList: true, rpc: 'erp_cnab_remittance_page', args: listArgs(url.searchParams) };
  }
  if (id) {
    const params = url.searchParams;
    for (const key of params.keys()) if (!['grupo', 'page'].includes(key) || params.getAll(key).length !== 1) invalid();
    const group = params.get('grupo') ?? 'baixas', page = params.get('page') ?? '1';
    if (!Object.hasOwn(GROUPS, group) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000) invalid();
    return { kind: 'return_detail', cnabList: true, rpc: 'erp_cnab_return_detail', args: { p_id: id.toLowerCase(), p_group: GROUPS[group], p_page: Number(page), p_limit: 100 } };
  }
  return { kind: 'return_page', cnabList: true, rpc: 'erp_cnab_return_page', args: listArgs(url.searchParams) };
}
export function cnabListAction(action, value) {
  const data = value.data;
  if (action === 'remittance_exclude') { if (!object(data) || Object.keys(data).some(key => !['id', 'sequence'].includes(key)) || !UUID.test(data.id || '') || typeof data.sequence !== 'string' || !/^[1-9]\d{0,9}$/.test(data.sequence)) invalid(); }
  else if (!object(data) || Object.keys(data).some(key => key !== 'id') || !UUID.test(data.id || '')) invalid();
  return { kind: 'execute', action, cnabList: true, rpc: action === 'remittance_exclude' ? 'erp_cnab_remittance_exclude' : 'erp_cnab_return_exclude',
    args: { p_command_id: value.command_id.toLowerCase(), p_data: { ...data, id: data.id.toLowerCase() } } };
}

function remittanceRow(value) {
  if (!object(value) || !UUID.test(value.id || '') || !UUID.test(value.profile_id || '') || !['homologation', 'operational'].includes(value.purpose) || !['reserved', 'ready'].includes(value.state)
    || typeof value.sequence !== 'string' || !/^[1-9]\d{0,9}$/.test(value.sequence) || !isDay(value.generated_on) || !stamp(value.created_at) || !text(value.filename, 60, false) || !text(value.bank, 3) || !text(value.bank_name, 40)
    || (value.state === 'ready') !== (value.file_hash !== null) || (value.file_hash !== null && !SHA.test(value.file_hash)) || (value.byte_size !== null && (!Number.isSafeInteger(value.byte_size) || value.byte_size < 1))
    || (value.encoding_profile !== null && !text(value.encoding_profile, 60, false)) || typeof value.excludable !== 'boolean' || (value.excludable && value.state !== 'reserved')) upstreamInvalid();
  return { id: value.id, profile_id: value.profile_id, purpose: value.purpose, state: value.state, sequence: value.sequence, generated_on: value.generated_on, created_at: value.created_at, filename: value.filename,
    bank: value.bank, bank_name: value.bank_name, file_hash: value.file_hash, byte_size: value.byte_size, encoding_profile: value.encoding_profile, excludable: value.excludable };
}
function returnRow(value) {
  if (!object(value) || !UUID.test(value.id || '') || !UUID.test(value.profile_id || '') || !['homologation', 'operational'].includes(value.purpose) || !isDay(value.generated_on) || !stamp(value.created_at)
    || !text(value.filename, 60, false) || !text(value.bank, 3) || !text(value.bank_name, 40) || typeof value.excludable !== 'boolean') upstreamInvalid();
  // SQL 246: Nº Retorno (sequence of the .RET file), only for the returns read since 246; older answers read as without it.
  const number = value.number === undefined ? null : value.number;
  if (number !== null && (typeof number !== 'string' || !/^\d{1,7}$/.test(number))) upstreamInvalid();
  return { id: value.id, profile_id: value.profile_id, purpose: value.purpose, generated_on: value.generated_on, created_at: value.created_at, filename: value.filename, bank: value.bank, bank_name: value.bank_name, number, excludable: value.excludable };
}
const counted = item => { if (!Number.isSafeInteger(item.titles) || item.titles < 0 || !cents(item.total_cents)) upstreamInvalid(); return { titles: item.titles, total_cents: item.total_cents }; };
function page(route, value, entity, row) {
  const a = route.args;
  if (value.entity !== entity || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
    || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))) upstreamInvalid();
  const seen = new Set();
  const items = value.items.map(item => { const out = { ...row(item), ...counted(item) }; if (seen.has(out.id) || (a.p_from && out.generated_on < a.p_from) || (a.p_to && out.generated_on > a.p_to)) upstreamInvalid(); seen.add(out.id); return out; });
  return { entity, page: value.page, limit: value.limit, total: value.total, items, data_mode: 'erp_native' };
}
export function projectCnabListResult(route, value) {
  if (route.kind === 'remittance_candidates') return projectCandidates(route, value);
  if (route.kind === 'remittance_page') return page(route, value, 'cnab_remittances', remittanceRow);
  if (route.kind === 'return_page') return page(route, value, 'cnab_returns', returnRow);
  if (route.kind === 'remittance_detail') {
    const record = remittanceRow(value.record ?? null), account = value.account;
    if (value.entity !== 'cnab_remittance' || record.id !== route.args.p_id || !object(account) || !text(account.bank, 3) || !text(account.bank_name, 40) || !text(account.agency, 10) || !text(account.account, 20)
      || !text(account.account_digit, 2) || !text(account.wallet, 5) || !text(account.name, 200) || !Array.isArray(value.titles) || value.titles.length > 500 || !Number.isSafeInteger(value.titles_total)
      || value.titles_total < value.titles.length || !cents(value.total_cents)) upstreamInvalid();
    const titles = value.titles.map(item => {
      if (!object(item) || !UUID.test(item.billing_title_id || '') || !UUID.test(item.title_id || '') || !text(item.contact_name, 200, false) || !text(item.our_number, 40) || !text(item.document_number, 40, false)
        || !isDay(item.issued_on) || !isDay(item.due_on) || !text(item.description, 240, false) || !cents(item.amount_cents)) upstreamInvalid();
      return { billing_title_id: item.billing_title_id, title_id: item.title_id, contact_name: item.contact_name, our_number: item.our_number, document_number: item.document_number, issued_on: item.issued_on, due_on: item.due_on, description: item.description, amount_cents: item.amount_cents };
    });
    return { entity: 'cnab_remittance', record, account: { bank: account.bank, bank_name: account.bank_name, agency: account.agency, account: account.account, account_digit: account.account_digit, wallet: account.wallet, name: account.name },
      titles, titles_total: value.titles_total, total_cents: value.total_cents, data_mode: 'erp_native' };
  }
  if (route.kind === 'return_detail') {
    const a = route.args, record = returnRow(value.record ?? null), s = value.summary;
    if (value.entity !== 'cnab_return' || record.id !== a.p_id || value.group !== a.p_group || value.page !== a.p_page || value.limit !== a.p_limit || !Number.isSafeInteger(value.total) || value.total < 0
      || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit)) || !object(s)
      || ['titles', 'entries', 'settlements', 'others'].some(key => !Number.isSafeInteger(s[key]) || s[key] < 0) || s.entries + s.settlements + s.others !== s.titles
      || ['amount_cents', 'amount_with_additions_cents', 'entries_cents', 'settlements_cents', 'interest_cents', 'discount_cents', 'fee_cents'].some(key => !cents(s[key]))
      || value.total !== s[{ entries: 'entries', settlements: 'settlements', others: 'others' }[a.p_group]]) upstreamInvalid();
    let previous = 0;
    const items = value.items.map(item => {
      if (!object(item) || !Number.isSafeInteger(item.line) || item.line <= previous || !UUID.test(item.event_id || '') || typeof item.duplicate !== 'boolean' || !text(item.kind, 40, false) || !text(item.occurrence, 4)
        || !text(item.document_number, 40) || !text(item.our_number, 40) || ![item.occurrence_date, item.credit_date, item.due_date].every(value => value === null || isDay(value)) || !text(item.contact_name, 200)
        || !['fee_cents', 'interest_cents', 'amount_cents', 'paid_cents'].every(key => cents(item[key]))) upstreamInvalid();
      previous = item.line;
      return { line: item.line, event_id: item.event_id, duplicate: item.duplicate, kind: item.kind, occurrence: item.occurrence, document_number: item.document_number, our_number: item.our_number, occurrence_date: item.occurrence_date,
        credit_date: item.credit_date, due_date: item.due_date, contact_name: item.contact_name || null, fee_cents: item.fee_cents, interest_cents: item.interest_cents, amount_cents: item.amount_cents, paid_cents: item.paid_cents };
    });
    return { entity: 'cnab_return', record, summary: Object.fromEntries(['titles', 'amount_cents', 'amount_with_additions_cents', 'entries', 'entries_cents', 'settlements', 'settlements_cents', 'others', 'interest_cents', 'discount_cents', 'fee_cents'].map(key => [key, s[key]])),
      group: value.group, page: value.page, limit: value.limit, total: value.total, items, data_mode: 'erp_native' };
  }
  // Exclusions: the record asked for, with the command replay flag.
  const data = route.args.p_data, r = value.record;
  if (typeof value.replayed !== 'boolean' || !object(r) || r.id !== data.id) upstreamInvalid();
  if (route.action === 'remittance_exclude') {
    if (value.entity !== 'cnab_remittance_exclusion' || r.sequence !== data.sequence || !Number.isSafeInteger(r.titles) || r.titles < 0 || typeof r.released_sequence !== 'boolean') upstreamInvalid();
    return { entity: value.entity, action: route.action, replayed: value.replayed, record: { id: r.id, sequence: r.sequence, titles: r.titles, released_sequence: r.released_sequence }, data_mode: 'erp_native' };
  }
  if (value.entity !== 'cnab_return_exclusion' || r.excluded !== true) upstreamInvalid();
  return { entity: value.entity, action: route.action, replayed: value.replayed, record: { id: r.id, excluded: true }, data_mode: 'erp_native' };
}
