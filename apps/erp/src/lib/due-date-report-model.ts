import type { NativeRequestOptions } from './real-access';

export type DuePeriod = { from: string; to: string };
export type DueAggregate = { receivable_count: string; receivable_cents: string; payable_count: string; payable_cents: string; difference_cents: string };
export type DueDay = DueAggregate & { day: string };
export type DueReport = DuePeriod & { scope: 'due_report'; data_mode: 'erp_native'; basis: 'outstanding_principal'; role: 'admin' | 'financeiro' | 'consulta';
  timezone: 'America/Sao_Paulo'; business_date: string; as_of: string; day_count: number; days: DueDay[]; totals: DueAggregate };
export type DueReportController = { dueReport: (path: string, options?: NativeRequestOptions) => Promise<unknown> };
const MAX_COUNT = 9223372036854775807n, MAX_CENTS = 999999999999999n;
const KEYS = ['receivable_count', 'receivable_cents', 'payable_count', 'payable_cents', 'difference_cents'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new Error('O relatório recebido não pôde ser conferido. Atualize a consulta.'); }
export function dueDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '2100-12-31'
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export const dueAddDays = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export function duePeriod(from: string, to: string): DuePeriod {
  if (!dueDate(from) || !dueDate(to) || to < from || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 365)
    throw new Error('Informe um período válido de até 366 dias, incluindo o primeiro e o último dia.');
  return { from, to };
}
export function duePeriodFromParams(params: URLSearchParams): DuePeriod | null {
  for (const key of params.keys()) if (!['from', 'to'].includes(key) || params.getAll(key).length !== 1) throw new Error('Confira os filtros de período na consulta.');
  if (!params.size) return null;
  return duePeriod(params.get('from') ?? '', params.get('to') ?? '');
}
export function duePeriodParams(period: DuePeriod | null): URLSearchParams {
  return period === null ? new URLSearchParams() : new URLSearchParams(duePeriod(period.from, period.to));
}
function aggregate(value: unknown): DueAggregate {
  if (!object(value)) invalid();
  for (const kind of ['receivable', 'payable']) {
    const count = value[`${kind}_count`], cents = value[`${kind}_cents`];
    if (typeof count !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(count) || BigInt(count) > MAX_COUNT
      || typeof cents !== 'string' || !/^(?:0|[1-9][0-9]{0,33})$/.test(cents) || BigInt(cents) < BigInt(count) || BigInt(cents) > BigInt(count) * MAX_CENTS) invalid();
  }
  if (value.difference_cents !== (BigInt(value.receivable_cents as string) - BigInt(value.payable_cents as string)).toString()) invalid();
  return Object.fromEntries(KEYS.map(key => [key, value[key]])) as DueAggregate;
}
/** Reconcile every day and total before rendering/exporting; upstream extras are discarded. */
export function dueReport(value: unknown, period: DuePeriod | null = null): DueReport {
  if (!object(value) || value.scope !== 'due_report' || value.data_mode !== 'erp_native' || value.basis !== 'outstanding_principal'
    || typeof value.role !== 'string' || !['admin', 'financeiro', 'consulta'].includes(value.role) || value.timezone !== 'America/Sao_Paulo'
    || !dueDate(value.business_date) || !dueDate(value.from) || !dueDate(value.to) || typeof value.as_of !== 'string'
    || value.as_of.length > 80 || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.as_of)
    || !dueDate(value.as_of.slice(0, 10)) || !Number.isFinite(Date.parse(value.as_of))) invalid();
  const expected = period ?? { from: value.business_date, to: dueAddDays(value.business_date, 29) };
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value.as_of));
  if (['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-') !== value.business_date) invalid();
  duePeriod(expected.from, expected.to);
  const length = (Date.parse(`${expected.to}T00:00:00Z`) - Date.parse(`${expected.from}T00:00:00Z`)) / 86400000 + 1;
  if (value.from !== expected.from || value.to !== expected.to || value.day_count !== length || !Array.isArray(value.days) || value.days.length !== length) invalid();
  const days = value.days.map((item: unknown, index): DueDay => {
    if (!object(item) || item.day !== dueAddDays(expected.from, index)) invalid();
    return { day: item.day as string, ...aggregate(item) };
  }), totals = aggregate(value.totals);
  for (const key of KEYS) if (days.reduce((sum, row) => sum + BigInt(row[key]), 0n) !== BigInt(totals[key])) invalid();
  return { scope: 'due_report', data_mode: 'erp_native', basis: 'outstanding_principal', role: value.role as DueReport['role'], timezone: 'America/Sao_Paulo',
    business_date: value.business_date, as_of: value.as_of, from: value.from, to: value.to, day_count: length, days, totals };
}
export function dueCount(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,18})$/.test(value)) invalid();
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
const decimal = (cents: string) => { const n = BigInt(cents), abs = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')}`; };
const csvCell = (value: string) => `"${(/^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
/** CSV is aggregate-only. Negative values are neutralized as text, never spreadsheet expressions. */
export function dueReportCsv(report: DueReport): string {
  const safe = dueReport(report, { from: report.from, to: report.to });
  const fields = (row: DueAggregate) => [row.receivable_count, decimal(row.receivable_cents), row.payable_count, decimal(row.payable_cents), decimal(row.difference_cents)];
  const rows = [ ['Vencimento', 'Títulos a receber', 'A receber (BRL)', 'Títulos a pagar', 'A pagar (BRL)', 'Diferença prevista (BRL)'],
    ...safe.days.map(row => [row.day, ...fields(row)]), ['TOTAL DO PERÍODO', ...fields(safe.totals)] ];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
