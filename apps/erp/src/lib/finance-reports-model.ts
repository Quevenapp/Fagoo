// Financeiro > Ver relatórios financeiros (SQL 212): rota da tela, caminho da API e leitura conferida das respostas.
import { validFinanceDate } from './real-finance-model.ts';

export type FinanceReport = 'cash_flow' | 'forecast' | 'categories' | 'contacts';
export type ReportGroup = 'day' | 'month';
export const FINANCE_REPORTS: readonly { id: FinanceReport; label: string; description: string }[] = [
  { id: 'cash_flow', label: 'Fluxo de caixa realizado', description: 'Entradas, saídas e o saldo de cada período nas contas financeiras.' },
  { id: 'forecast', label: 'Fluxo de caixa previsto', description: 'Contas a receber e a pagar em aberto por vencimento, sobre o saldo atual.' },
  { id: 'categories', label: 'Receitas e despesas por categoria', description: 'Recebimentos, pagamentos e lançamentos de caixa realizados, com juros, multas, descontos e taxas na Categorização para DRE.' },
  { id: 'contacts', label: 'Recebimentos e pagamentos por cliente/fornecedor', description: 'O que cada cliente pagou e cada fornecedor recebeu no período.' },
];
export const REPORT_PAGE_SIZE = 100;
const PAGED: readonly FinanceReport[] = ['categories', 'contacts'];
export const reportPaged = (report: FinanceReport) => PAGED.includes(report);
export type ReportRoute = { report: FinanceReport; from: string; to: string; account: string; group: ReportGroup; page: number };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (): never => { throw new Error('Confira os filtros do relatório.'); };
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const shiftDays = (value: string, amount: number) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
const monthEnd = (value: string) => { const [year, month] = value.split('-').map(Number); return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10); };

/** Origin opens the realizado in the current month and the previsto from today to the end of the next month (São Paulo). */
export function defaultReportPeriod(report: FinanceReport, today: string): { from: string; to: string } {
  validFinanceDate(today);
  if (report === 'forecast') { const next = shiftDays(`${today.slice(0, 7)}-01`, 32); return { from: today, to: monthEnd(next) }; }
  return { from: `${today.slice(0, 7)}-01`, to: monthEnd(today) };
}
/** ?area=relatorios&relatorio=&de=&ate=[&conta=][&agrupar=dia][&page=] */
export function reportRoute(params: URLSearchParams, today: string): ReportRoute {
  for (const key of params.keys()) if (!['area', 'relatorio', 'de', 'ate', 'conta', 'agrupar', 'page'].includes(key) || params.getAll(key).length !== 1) fail();
  const report = (params.get('relatorio') ?? 'cash_flow') as FinanceReport;
  if (!FINANCE_REPORTS.some(item => item.id === report)) fail();
  const period = defaultReportPeriod(report, today), from = params.get('de') ?? period.from, to = params.get('ate') ?? period.to;
  try { validFinanceDate(from); validFinanceDate(to); } catch { fail(); }
  const account = params.get('conta') ?? '', group = params.get('agrupar') === 'dia' ? 'day' : params.has('agrupar') && params.get('agrupar') !== 'mes' ? fail() : 'month', page = params.get('page') ?? '1';
  if (from > to || (account && !UUID.test(account)) || !/^[1-9]\d{0,5}$/.test(page) || (!reportPaged(report) && page !== '1') || (reportPaged(report) && params.has('agrupar'))
    || (group === 'day' && days(from, to) > 366) || days(from, to) > 3660) fail();
  return { report, from, to, account, group, page: Number(page) };
}
export function reportParams(route: ReportRoute, today: string): URLSearchParams {
  const params = new URLSearchParams({ area: 'relatorios' });
  if (route.report !== 'cash_flow') params.set('relatorio', route.report);
  const period = defaultReportPeriod(route.report, today);
  if (route.from !== period.from || route.to !== period.to) { params.set('de', route.from); params.set('ate', route.to); }
  if (route.account) params.set('conta', route.account);
  if (!reportPaged(route.report) && route.group === 'day') params.set('agrupar', 'dia');
  if (route.page > 1) params.set('page', String(route.page));
  reportRoute(params, today); return params;
}
export function reportApiPath(route: ReportRoute): string {
  const params = new URLSearchParams({ report: route.report, from: route.from, to: route.to });
  if (route.account) params.set('account', route.account);
  if (reportPaged(route.report)) { params.set('page', String(route.page)); params.set('limit', String(REPORT_PAGE_SIZE)); } else params.set('group', route.group);
  return `/v1/financeiro/relatorios?${params}`;
}

export type FlowRow = { start_on: string; end_on: string; in_cents?: string; out_cents?: string; receivable_cents?: string; payable_cents?: string; net_cents: string; balance_cents: string };
export type CategoryRow = { category_id: string | null; name: string | null; parent_name: string | null; kind: 'receivable' | 'payable' | 'both' | null; deleted: boolean; amount_cents: string };
export type ContactRow = { contact_id: string; name: string; received_cents: string; paid_cents: string; net_cents: string };
export type ReportResult = { report: FinanceReport; from: string; to: string; total: number; page: number; items: (FlowRow | CategoryRow | ContactRow)[]; summary: Record<string, string> };
const signed = (value: unknown) => typeof value === 'string' && /^-?\d{1,30}$/.test(value);
/** The answer must be the report asked for (same period, conta, grouping and page). */
export function reportResult(value: unknown, route: ReportRoute): ReportResult {
  const page = value as Record<string, unknown> | null;
  if (!page || page.entity !== 'finance_report' || page.data_mode !== 'erp_native' || page.report !== route.report || page.from !== route.from || page.to !== route.to
    || page.account_id !== (route.account || null) || page.page !== (reportPaged(route.report) ? route.page : 1) || !Number.isSafeInteger(page.total) || !Array.isArray(page.items)
    || !page.summary || typeof page.summary !== 'object' || Object.values(page.summary as object).some(item => !signed(item))) throw new Error('Não foi possível conferir o relatório.');
  const items = page.items as Record<string, unknown>[];
  if (route.report === 'categories' ? items.some(item => !signed(item.amount_cents)) : route.report === 'contacts' ? items.some(item => typeof item.name !== 'string' || !signed(item.received_cents) || !signed(item.paid_cents))
    : items.some(item => typeof item.start_on !== 'string' || !signed(item.net_cents) || !signed(item.balance_cents))) throw new Error('Não foi possível conferir o relatório.');
  return { report: route.report, from: route.from, to: route.to, total: page.total as number, page: page.page as number, items: items as unknown as ReportResult['items'], summary: page.summary as Record<string, string> };
}
/** "01/03/2026" for a day, "03/2026" for a month bucket. */
export function bucketLabel(row: Pick<FlowRow, 'start_on' | 'end_on'>, group: ReportGroup): string {
  const [year, month, day] = row.start_on.split('-');
  return group === 'day' ? `${day}/${month}/${year}` : `${month}/${year}`;
}
export const categoryLabel = (row: CategoryRow) => row.name === null ? 'Sem categoria' : `${row.parent_name ? `${row.parent_name} > ` : ''}${row.name}${row.deleted ? ' (excluída)' : ''}`;
export const categoryKind = (row: CategoryRow) => row.kind === 'receivable' ? 'Receita' : row.kind === 'payable' ? 'Despesa' : '—';
