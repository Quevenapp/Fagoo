/** Relatórios financeiros (SQL 212): fluxo de caixa realizado e previsto, receitas e despesas por categoria e por cliente/fornecedor.
 * GET /v1/financeiro/relatorios?report=&from=&to=[&account=][&group=day|month][&page=&limit=]. Read only; SQL is the authority. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/;
export const FINANCE_REPORTS = ['cash_flow', 'forecast', 'categories', 'contacts'];
const PAGED = ['categories', 'contacts'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const SIGNED = /^-?\d{1,30}$/, UNSIGNED = /^\d{1,30}$/;
const signed = value => typeof value === 'string' && SIGNED.test(value), unsigned = value => typeof value === 'string' && UNSIGNED.test(value);
const isDay = value => typeof value === 'string' && DAY.test(value);
const name = (value, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= 200);
function day(value) {
  if (!isDay(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

export function parseFinanceReportRead(url) {
  if (url.pathname !== '/v1/financeiro/relatorios') return null;
  const params = url.searchParams;
  for (const key of params.keys()) if (!['report', 'from', 'to', 'account', 'group', 'page', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
  const report = params.get('report'), from = day(params.get('from')), to = day(params.get('to')), account = params.get('account'), group = params.get('group') ?? 'month';
  const page = params.get('page') ?? '1', limit = params.get('limit') ?? '100';
  if (!FINANCE_REPORTS.includes(report) || from > to || !['day', 'month'].includes(group) || (group === 'day' && days(from, to) > 366) || days(from, to) > 3660
    || (account !== null && !UUID.test(account)) || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100
    || (!PAGED.includes(report) && (params.has('page') || params.has('limit'))) || (PAGED.includes(report) && params.has('group'))) invalid();
  return { kind: 'report', report: true, rpc: 'erp_finance_report', args: { p_report: report, p_from: from, p_to: to, p_account: account?.toLowerCase() ?? null, p_group: group, p_page: Number(page), p_limit: Number(limit) } };
}

const BUCKET_FIELDS = { cash_flow: ['in_cents', 'out_cents'], forecast: ['receivable_cents', 'payable_cents'] };
export function projectFinanceReport(route, value) {
  const a = route.args;
  if (value.entity !== 'finance_report' || value.report !== a.p_report || value.from !== a.p_from || value.to !== a.p_to || value.account_id !== a.p_account || value.group !== a.p_group
    || value.limit !== a.p_limit || value.page !== (PAGED.includes(a.p_report) ? a.p_page : 1) || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || !object(value.summary)) upstreamInvalid();
  const s = value.summary, base = { entity: 'finance_report', report: a.p_report, from: a.p_from, to: a.p_to, account_id: a.p_account, group: a.p_group, page: value.page, limit: value.limit, total: value.total, data_mode: 'erp_native' };
  if (!PAGED.includes(a.p_report)) {
    // Buckets: consecutive, inside the period, every day or month once (at most 367 days or 121 months).
    if (value.items.length !== value.total || value.items.length < 1 || value.items.length > 367) upstreamInvalid();
    const [plus, minus] = BUCKET_FIELDS[a.p_report]; let previous = null;
    const items = value.items.map(item => {
      if (!object(item) || !isDay(item.start_on) || !isDay(item.end_on) || item.start_on > item.end_on || item.start_on < a.p_from || item.end_on > a.p_to || (previous && item.start_on <= previous)
        || !unsigned(item[plus]) || !unsigned(item[minus]) || !signed(item.net_cents) || !signed(item.balance_cents) || BigInt(item.net_cents) !== BigInt(item[plus]) - BigInt(item[minus])) upstreamInvalid();
      previous = item.end_on;
      return { start_on: item.start_on, end_on: item.end_on, [plus]: item[plus], [minus]: item[minus], net_cents: item.net_cents, balance_cents: item.balance_cents };
    });
    if (items[0].start_on !== a.p_from || items.at(-1).end_on !== a.p_to) upstreamInvalid();
    const keys = a.p_report === 'cash_flow' ? ['previous_cents', 'in_cents', 'out_cents', 'net_cents', 'closing_cents'] : ['current_cents', 'receivable_cents', 'payable_cents', 'net_cents', 'projected_cents', 'overdue_receivable_cents', 'overdue_payable_cents'];
    if (keys.some(key => !signed(s[key]))) upstreamInvalid();
    const sum = key => items.reduce((total, item) => total + BigInt(item[key]), 0n).toString();
    if (s[plus] !== sum(plus) || s[minus] !== sum(minus)) upstreamInvalid();
    return { ...base, items, summary: Object.fromEntries(keys.map(key => [key, s[key]])) };
  }
  if (value.items.length !== Math.max(0, Math.min(a.p_limit, value.total - (a.p_page - 1) * a.p_limit))) upstreamInvalid();
  if (a.p_report === 'categories') {
    if (!['in_cents', 'out_cents', 'net_cents'].every(key => signed(s[key]))) upstreamInvalid();
    const seen = new Set();
    const items = value.items.map(item => {
      const key = item?.category_id ?? 'none';
      if (!object(item) || (item.category_id !== null && !UUID.test(item.category_id || '')) || seen.has(key) || !name(item.name, true) || !name(item.parent_name, true)
        || (item.category_id === null) !== (item.name === null) || ![null, 'receivable', 'payable', 'both'].includes(item.kind) || typeof item.deleted !== 'boolean' || !signed(item.amount_cents)) upstreamInvalid();
      seen.add(key);
      return { category_id: item.category_id, name: item.name, parent_name: item.parent_name, kind: item.kind, deleted: item.deleted, amount_cents: item.amount_cents };
    });
    return { ...base, items, summary: { in_cents: s.in_cents, out_cents: s.out_cents, net_cents: s.net_cents } };
  }
  if (!['received_cents', 'paid_cents', 'net_cents'].every(key => signed(s[key]))) upstreamInvalid();
  const seen = new Set();
  const items = value.items.map(item => {
    if (!object(item) || !UUID.test(item.contact_id || '') || seen.has(item.contact_id) || !name(item.name) || !signed(item.received_cents) || !signed(item.paid_cents) || !signed(item.net_cents)
      || BigInt(item.net_cents) !== BigInt(item.received_cents) - BigInt(item.paid_cents)) upstreamInvalid();
    seen.add(item.contact_id);
    return { contact_id: item.contact_id, name: item.name, received_cents: item.received_cents, paid_cents: item.paid_cents, net_cents: item.net_cents };
  });
  return { ...base, items, summary: { received_cents: s.received_cents, paid_cents: s.paid_cents, net_cents: s.net_cents } };
}
