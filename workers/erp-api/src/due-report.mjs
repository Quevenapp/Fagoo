/** Aggregate-only due report. No IDs, contact names, bank balances, or mutation endpoints. */
const BASE = '/v1/relatorios/vencimentos';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = ['admin', 'financeiro', 'consulta'];
const MAX_COUNT = 9223372036854775807n, MAX_TITLE_CENTS = 999999999999999n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && value >= '1900-01-01' && value <= '2100-12-31' && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const addDays = (value, offset) => new Date(Date.parse(`${value}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const dayCount = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
export class DueReportError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new DueReportError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new DueReportError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
export function dueReportMethods(path) { return path === BASE ? ['GET'] : null; }
export function parseDueReportRoute(request) {
  const url = new URL(request.url);
  if (!dueReportMethods(url.pathname)) throw new DueReportError(404, 'ERP_NOT_FOUND');
  if (request.method !== 'GET') throw new DueReportError(405, 'ERP_METHOD_NOT_ALLOWED');
  for (const key of url.searchParams.keys()) if (!['from', 'to'].includes(key) || url.searchParams.getAll(key).length !== 1) invalid();
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (from !== null || to !== null) {
    if (!date(from) || !date(to) || dayCount(from, to) < 1 || dayCount(from, to) > 366) invalid();
  }
  return { rpc: 'erp_finance_due_report', args: { p_from: from, p_to: to } };
}
function aggregate(value) {
  if (!object(value)) upstream();
  const projected = {};
  for (const kind of ['receivable', 'payable']) {
    const count = value[`${kind}_count`], cents = value[`${kind}_cents`];
    if (typeof count !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(count) || BigInt(count) > MAX_COUNT
      || typeof cents !== 'string' || !/^(?:0|[1-9][0-9]{0,33})$/.test(cents)
      || BigInt(cents) < BigInt(count) || BigInt(cents) > BigInt(count) * MAX_TITLE_CENTS) upstream();
    projected[`${kind}_count`] = count; projected[`${kind}_cents`] = cents;
  }
  const difference = (BigInt(projected.receivable_cents) - BigInt(projected.payable_cents)).toString();
  if (value.difference_cents !== difference) upstream();
  return { ...projected, difference_cents: difference };
}
export function dueReportResponse(value, args = { p_from: null, p_to: null }) {
  if (!object(value) || value.scope !== 'due_report' || value.data_mode !== 'erp_native' || value.basis !== 'outstanding_principal'
    || !ROLES.includes(value.role) || value.timezone !== 'America/Sao_Paulo' || !date(value.business_date) || !date(value.from) || !date(value.to)
    || typeof value.as_of !== 'string' || value.as_of.length > 80 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.as_of)
    || !date(value.as_of.slice(0, 10)) || !Number.isFinite(Date.parse(value.as_of))) upstream();
  const from = args.p_from ?? value.business_date, to = args.p_to ?? addDays(value.business_date, 29), length = dayCount(from, to);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value.as_of));
  if (['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-') !== value.business_date) upstream();
  if (value.from !== from || value.to !== to || !Number.isInteger(length) || length < 1 || length > 366 || value.day_count !== length
    || !Array.isArray(value.days) || value.days.length !== length) upstream();
  const days = value.days.map((item, index) => {
    if (!object(item) || item.day !== addDays(from, index)) upstream();
    return { day: item.day, ...aggregate(item) };
  });
  const totals = aggregate(value.totals);
  for (const key of ['receivable_count', 'receivable_cents', 'payable_count', 'payable_cents', 'difference_cents']) {
    if (days.reduce((sum, item) => sum + BigInt(item[key]), 0n) !== BigInt(totals[key])) upstream();
  }
  return { scope: 'due_report', data_mode: 'erp_native', basis: 'outstanding_principal', role: value.role,
    timezone: 'America/Sao_Paulo', business_date: value.business_date, as_of: value.as_of,
    from, to, day_count: length, days, totals };
}
export async function executeDueReportRoute(route, { userId, rpc }) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new DueReportError(403, 'ERP_ACCESS_DENIED');
  return dueReportResponse(await rpc('erp_finance_due_report', { p_user_id: userId, ...route.args }), route.args);
}
