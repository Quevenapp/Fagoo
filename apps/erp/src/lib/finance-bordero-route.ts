// "Gerenciar recebimentos / pagamentos" do Origin (SQL 110): URL, chamada da API e conferência das respostas.
import { validFinanceDate, type FinanceKind } from './real-finance-model.ts';
import { categoryParam, routeCategories } from './finance-list-route.ts';
import { presetRange } from './origin-list.ts';

export interface BorderoTotals { paid_cents: string; interest_cents: string; penalty_cents: string; discount_cents: string; fee_cents: string; net_cash_cents?: string }
export interface Bordero { id: string; kind: FinanceKind; posted_on: string; account_id: string; account_name: string; category_id: string | null; category_name: string | null; note: string | null; grouped: boolean; version: number; created_at: string; deleted_at: string | null; active: boolean; contact_name: string | null; contacts: number; items: number; totals: Required<BorderoTotals> }
export interface BorderoLine { settlement_id: string; title_id: string; contact_name: string; document_number: string | null; description: string; principal_cents: string; interest_cents: string; penalty_cents: string; discount_cents: string; fee_cents: string; paid_cents: string; net_cash_cents: string; reversed: boolean; category_id: string | null; category_name: string | null }
export interface BorderoPage { entity: 'borderos'; kind: FinanceKind; items: Bordero[]; page: number; limit: number; total: number; totals: BorderoTotals & { count: number }; data_mode: 'erp_native' }
export type BorderoRoute = { kind: FinanceKind; q: string; account: string; category: string; from: string; to: string; value: string; title: string; page: number };
export const BORDERO_PAGE_SIZE = 100;
const KEYS = ['area', 'tipo', 'q', 'conta', 'category', 'from', 'to', 'valor', 'titulo', 'page'];
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sum = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
function invalid(): never { throw new Error('Confira os filtros dos borderôs.'); }
export const borderoTitle = (kind: FinanceKind) => kind === 'receivable' ? 'Recebimentos' : 'Pagamentos';
export const borderoMenuLabel = (kind: FinanceKind) => kind === 'receivable' ? 'Gerenciar recebimentos' : 'Gerenciar pagamentos';
export function borderoPath(kind: FinanceKind, title?: string): string {
  const params = new URLSearchParams({ area: 'borderos', tipo: kind === 'receivable' ? 'R' : 'P' });
  if (title) { if (!uuid(title)) invalid(); params.set('titulo', title); }
  return `/financeiro-empresa?${params}`;
}
export function borderoRoute(params: URLSearchParams): BorderoRoute {
  for (const key of params.keys()) if (!KEYS.includes(key) || params.getAll(key).length !== 1) invalid();
  if (params.get('area') !== 'borderos') invalid();
  const tipo = params.get('tipo') ?? 'R', q = params.get('q') ?? '', account = params.get('conta') ?? '', rawCategory = params.get('category') ?? '', from = params.get('from') ?? '', to = params.get('to') ?? '';
  const value = params.get('valor') ?? '', title = params.get('titulo') ?? '', rawPage = params.get('page') ?? '1';
  if (!['R', 'P'].includes(tipo) || q.length > 120 || /[\x00-\x1f\x7f]/.test(q) || (account && !uuid(account)) || (title && !uuid(title)) || (value && !/^[1-9]\d{0,14}$/.test(value))
    || !/^[1-9]\d{0,5}$/.test(rawPage) || Number(rawPage) > 100000) invalid();
  if (from) validFinanceDate(from); if (to) validFinanceDate(to); if (from && to && from > to) invalid();
  const category = rawCategory ? categoryParam(rawCategory.split(',')) : '';
  return { kind: tipo === 'R' ? 'receivable' : 'payable', q: q.trim(), account, category, from, to, value, title, page: Number(rawPage) };
}
export function borderoParams(route: BorderoRoute): URLSearchParams {
  const params = new URLSearchParams({ area: 'borderos', tipo: route.kind === 'receivable' ? 'R' : 'P' });
  if (route.q) params.set('q', route.q);
  if (route.account) params.set('conta', route.account);
  if (route.category) params.set('category', route.category);
  if (route.from) params.set('from', route.from);
  if (route.to) params.set('to', route.to);
  if (route.value) params.set('valor', route.value);
  if (route.title) params.set('titulo', route.title);
  if (route.page !== 1) params.set('page', String(route.page));
  borderoRoute(params); return params;
}
/** Origin opens borderôs on "Este mês"; following one conta (⋮ Gerenciar recebimentos) shows every date. */
export function borderoPeriod(route: Pick<BorderoRoute, 'from' | 'to' | 'title'>, today: string): { from: string; to: string } {
  return route.from || route.to || route.title ? { from: route.from, to: route.to } : presetRange('este-mes', today);
}
export function borderoApiPath(route: BorderoRoute, today: string): string {
  const period = borderoPeriod(route, today), params = new URLSearchParams({ page: String(route.page), limit: String(BORDERO_PAGE_SIZE), kind: route.kind });
  if (route.q) params.set('q', route.q);
  if (route.account) params.set('account', route.account);
  if (route.category) params.set('category', route.category);
  if (period.from) params.set('from', period.from);
  if (period.to) params.set('to', period.to);
  if (route.value) params.set('amount_cents', route.value);
  if (route.title) params.set('title', route.title);
  return `/v1/financeiro/borderos?${params}`;
}
function totals(value: unknown, keys: readonly string[]) { if (!object(value) || keys.some(key => !sum(value[key]))) invalid(); return value; }
export function borderoRow(value: unknown): Bordero {
  if (!object(value) || !uuid(value.id) || !['receivable', 'payable'].includes(String(value.kind)) || typeof value.posted_on !== 'string' || !uuid(value.account_id) || typeof value.account_name !== 'string'
    || typeof value.grouped !== 'boolean' || !Number.isInteger(value.version) || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.contacts) || !Number.isSafeInteger(value.items)) invalid();
  totals(value.totals, ['paid_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents', 'net_cash_cents']);
  return value as unknown as Bordero;
}
/** The page must be the one asked, newest first, with every borderô inside the period, the conta and the conta followed. */
export function borderoPage(value: unknown, route: BorderoRoute, today: string): BorderoPage {
  if (!object(value) || value.entity !== 'borderos' || value.data_mode !== 'erp_native' || value.kind !== route.kind || value.page !== route.page || value.limit !== BORDERO_PAGE_SIZE
    || !Number.isSafeInteger(value.total) || (value.total as number) < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(BORDERO_PAGE_SIZE, (value.total as number) - (route.page - 1) * BORDERO_PAGE_SIZE))) invalid();
  totals(value.totals, ['paid_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents']); if ((value.totals as Record<string, unknown>).count !== value.total) invalid();
  const period = borderoPeriod(route, today), seen = new Set<string>(); let previous: string | null = null;
  const items = (value.items as unknown[]).map(item => {
    const row = borderoRow(item);
    if (row.kind !== route.kind || !row.active || seen.has(row.id) || (period.from && row.posted_on < period.from) || (period.to && row.posted_on > period.to) || (route.account && row.account_id !== route.account)
      || (route.value && row.totals.paid_cents !== route.value)) invalid();
    seen.add(row.id); const key = `${row.posted_on}:${row.id}`; if (previous !== null && key >= previous) invalid(); previous = key;
    return row;
  });
  return { ...(value as unknown as BorderoPage), items };
}
export function borderoDetail(value: unknown, id: string, kind: FinanceKind): Bordero & { lines: BorderoLine[] } {
  if (!object(value) || value.entity !== 'borderos' || value.data_mode !== 'erp_native') invalid();
  const record = borderoRow(value.record) as Bordero & { lines?: unknown };
  if (record.id !== id || record.kind !== kind || !Array.isArray(record.lines) || record.lines.length !== record.items) invalid();
  for (const line of record.lines as unknown[]) { if (!object(line) || !uuid(line.settlement_id) || typeof line.contact_name !== 'string' || typeof line.reversed !== 'boolean') invalid(); totals(line, ['principal_cents', 'interest_cents', 'penalty_cents', 'discount_cents', 'fee_cents', 'paid_cents', 'net_cash_cents']); }
  return record as Bordero & { lines: BorderoLine[] };
}
export const borderoCategories = routeCategories;
