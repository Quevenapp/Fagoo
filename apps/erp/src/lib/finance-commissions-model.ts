// Financeiro > Comissões (SQL 171): rota da tela (?area=comissoes), caminhos do Worker e leitura conferida das respostas.
// Valores sempre em centavos de texto; nenhuma conta passa por Number.

export const COMMISSION_PAGE_SIZE = 100;
export type CommissionSituation = 'all' | 'A' | 'I' | 'S';
export const COMMISSION_SITUATIONS: readonly { id: CommissionSituation; label: string }[] = [{ id: 'all', label: 'Todos' }, { id: 'A', label: 'Ativos' }, { id: 'I', label: 'Inativos' }, { id: 'S', label: 'Sem movimentos' }];
export type CommissionRule = 'parcial' | 'faturamento' | 'primeira_parcela' | 'ultima_parcela';
export const COMMISSION_RULES: readonly { id: CommissionRule; label: string }[] = [
  { id: 'parcial', label: 'Liberação parcial vinculada ao pagamento das parcelas' }, { id: 'faturamento', label: 'Liberação integral no faturamento (lançamento de contas)' },
  { id: 'primeira_parcela', label: 'Liberação integral após o pagamento da primeira parcela' }, { id: 'ultima_parcela', label: 'Liberação integral após o pagamento da última parcela' }];
export type CommissionRoute = { mes: string; situacao: CommissionSituation; todos: boolean; q: string; page: number; vendedor: string | null };
export type CommissionSums = { billed_cents: string; previous_cents: string; commission_cents: string; credit_cents: string; debit_cents: string; payment_cents: string; pending_cents: string; balance_cents: string };
export type CommissionRow = CommissionSums & { seller_id: string; name: string; situation: 'A' | 'I' | 'S' };
export type CommissionPage = { month: string; total: number; items: CommissionRow[]; totals: CommissionSums };
export type CommissionEntry = { id: string; seller_id: string; kind: 'credit' | 'debit' | 'payment'; month: string; posted_on: string; amount_cents: string; description: string; category_id: string | null; account_id: string | null; account_name: string | null; source: 'cash' | 'payable' | null; title_id: string | null; counts: boolean; deleted: boolean; version: number; created_at: string };
/** origin invoice (SQL 248): the commission of a conta lançada by a nota fiscal, whose document is the note (number null while not sent). */
export type CommissionLine = { id: string; origin: 'document' | 'manual' | 'invoice'; day: string; description: string; parcel_cents: string; base_cents: string; rate: string; commission_cents: string; document: { id: string; kind: 'sales_orders' | 'service_orders' | 'fiscal_invoices'; number: string | null } | null; title_id: string | null; version: number };
export type CommissionPending = { id: string; due_on: string; description: string; situation: 'overdue' | 'upcoming'; commission_cents: string };
export type CommissionSeller = { id: string; contact_id: string; name: string; code: string | null; situation: string; rule: CommissionRule; mode: 'fixa' | 'descontos'; rate: string | null };
export type EntrySection = { total: number; amount_cents: string; items: CommissionEntry[] };
export type CommissionStatement = { seller: CommissionSeller; month: string; payable: boolean;
  commissions: { total: number; parcel_cents: string; base_cents: string; commission_cents: string; items: CommissionLine[] }; credits: EntrySection; debits: EntrySection; payments: EntrySection;
  pending: { total: number; commission_cents: string; items: CommissionPending[] }; summary: Omit<CommissionSums, 'billed_cents'> };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED = /^-?\d{1,30}$/, UNSIGNED = /^\d{1,30}$/;
const broken = (): never => { throw new Error('Não foi possível conferir as comissões. Tente novamente.'); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Mês do dia de São Paulo (aaaa-mm). */
export const currentMonth = (today: string) => today.slice(0, 7);
export function shiftMonth(month: string, delta: number) { const [year, value] = month.split('-').map(Number); const date = new Date(Date.UTC(year, value - 1 + delta, 1)); return date.toISOString().slice(0, 7); }
export const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;
export const monthStart = (month: string) => `${month}-01`;

/** URL: mes (padrão Este mês), situacao, todos=1, q, pagina e vendedor (extrato). Unknown or repeated keys are refused. */
export function commissionRoute(params: URLSearchParams, today: string): CommissionRoute {
  const allowed = ['area', 'mes', 'situacao', 'todos', 'q', 'pagina', 'vendedor'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error('Filtros inválidos no endereço.');
  const mes = params.get('mes') ?? currentMonth(today), situacao = params.get('situacao') ?? 'all', todos = params.get('todos'), q = params.get('q') ?? '', page = params.get('pagina') ?? '1', vendedor = params.get('vendedor');
  if (!MONTH.test(mes) || mes < '1900-01' || mes > '2100-12' || !COMMISSION_SITUATIONS.some(item => item.id === situacao) || (todos !== null && todos !== '1') || q.length > 120 || /[\x00-\x1f\x7f]/.test(q)
    || !/^[1-9]\d{0,5}$/.test(page) || (vendedor !== null && !UUID.test(vendedor))) throw new Error('Filtros inválidos no endereço.');
  return { mes, situacao: situacao as CommissionSituation, todos: todos === '1', q, page: Number(page), vendedor };
}
export function commissionParams(route: CommissionRoute, today: string) {
  const params = new URLSearchParams({ area: 'comissoes' });
  if (route.mes !== currentMonth(today)) params.set('mes', route.mes);
  if (route.situacao !== 'all') params.set('situacao', route.situacao);
  if (route.todos) params.set('todos', '1');
  if (route.q) params.set('q', route.q);
  if (route.page > 1) params.set('pagina', String(route.page));
  if (route.vendedor) params.set('vendedor', route.vendedor);
  return params;
}
export function commissionApiPath(route: CommissionRoute) {
  if (route.vendedor) return `/v1/financeiro/comissoes/${route.vendedor}?${new URLSearchParams({ month: route.mes })}`;
  const params = new URLSearchParams({ month: route.mes });
  if (route.situacao !== 'all') params.set('situation', route.situacao);
  if (route.todos) params.set('idle', 'true');
  if (route.q) params.set('q', route.q);
  if (route.page > 1) params.set('page', String(route.page));
  return `/v1/financeiro/comissoes?${params}`;
}

const unsigned = (value: unknown) => typeof value === 'string' && UNSIGNED.test(value);
const signed = (value: unknown) => typeof value === 'string' && SIGNED.test(value);
function sums(value: unknown): CommissionSums {
  if (!object(value) || !['billed_cents', 'commission_cents', 'credit_cents', 'debit_cents', 'payment_cents', 'pending_cents'].every(key => unsigned(value[key])) || !signed(value.previous_cents) || !signed(value.balance_cents)) return broken();
  const v = value as CommissionSums;
  if (BigInt(v.previous_cents) + BigInt(v.commission_cents) + BigInt(v.credit_cents) - BigInt(v.debit_cents) - BigInt(v.payment_cents) !== BigInt(v.balance_cents)) return broken();
  return { billed_cents: v.billed_cents, previous_cents: v.previous_cents, commission_cents: v.commission_cents, credit_cents: v.credit_cents, debit_cents: v.debit_cents, payment_cents: v.payment_cents, pending_cents: v.pending_cents, balance_cents: v.balance_cents };
}
export function commissionPage(value: unknown, route: CommissionRoute): CommissionPage {
  if (!object(value) || value.entity !== 'commissions' || value.data_mode !== 'erp_native' || value.month !== route.mes || value.situation !== route.situacao || value.with_idle !== route.todos || value.page !== route.page
    || !Number.isSafeInteger(value.total) || (value.total as number) < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(COMMISSION_PAGE_SIZE, (value.total as number) - (route.page - 1) * COMMISSION_PAGE_SIZE))) return broken();
  const items = (value.items as unknown[]).map(item => {
    if (!object(item) || typeof item.seller_id !== 'string' || !UUID.test(item.seller_id) || typeof item.name !== 'string' || !['A', 'I', 'S'].includes(item.situation as string)) return broken();
    return { seller_id: item.seller_id, name: item.name, situation: item.situation as CommissionRow['situation'], ...sums(item) };
  });
  return { month: route.mes, total: value.total as number, items, totals: sums(value.totals) };
}
function entry(value: unknown): CommissionEntry {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !['credit', 'debit', 'payment'].includes(value.kind as string) || typeof value.month !== 'string' || !DAY.test(value.month) || typeof value.posted_on !== 'string' || !DAY.test(value.posted_on)
    || !unsigned(value.amount_cents) || typeof value.description !== 'string' || !(value.source === null || value.source === 'cash' || value.source === 'payable') || typeof value.counts !== 'boolean' || typeof value.deleted !== 'boolean' || !Number.isSafeInteger(value.version)) return broken();
  return value as CommissionEntry;
}
const section = (value: unknown, kind: CommissionEntry['kind']): EntrySection => {
  if (!object(value) || !Number.isSafeInteger(value.total) || !unsigned(value.amount_cents) || !Array.isArray(value.items)) return broken();
  const items = (value.items as unknown[]).map(entry); if (items.some(item => item.kind !== kind)) return broken();
  return { total: value.total as number, amount_cents: value.amount_cents as string, items };
};
export function commissionStatement(value: unknown, route: CommissionRoute): CommissionStatement {
  if (!object(value) || value.entity !== 'commission_statement' || value.data_mode !== 'erp_native' || value.month !== route.mes || typeof value.payable !== 'boolean') return broken();
  const seller = value.seller, c = value.commissions, p = value.pending, s = value.summary;
  if (!object(seller) || seller.id !== route.vendedor || typeof seller.name !== 'string' || !COMMISSION_RULES.some(rule => rule.id === seller.rule) || !object(c) || !Array.isArray(c.items) || !object(p) || !Array.isArray(p.items) || !object(s)) return broken();
  const lines = (c.items as unknown[]).map(item => {
    if (!object(item) || typeof item.id !== 'string' || typeof item.day !== 'string' || !item.day.startsWith(route.mes) || !unsigned(item.parcel_cents) || !unsigned(item.base_cents) || !unsigned(item.commission_cents) || typeof item.rate !== 'string' || !/^\d{1,3}\.\d{2}$/.test(item.rate)) return broken();
    return item as unknown as CommissionLine;
  });
  const pending = (p.items as unknown[]).map(item => { if (!object(item) || typeof item.id !== 'string' || typeof item.due_on !== 'string' || !DAY.test(item.due_on) || !['overdue', 'upcoming'].includes(item.situation as string) || !unsigned(item.commission_cents)) return broken(); return item as unknown as CommissionPending; });
  const summary = sums({ ...s, billed_cents: '0' });
  if (!unsigned(c.commission_cents) || c.commission_cents !== summary.commission_cents || !unsigned(p.commission_cents) || p.commission_cents !== summary.pending_cents) return broken();
  const credits = section(value.credits, 'credit'), debits = section(value.debits, 'debit'), payments = section(value.payments, 'payment');
  if (credits.amount_cents !== summary.credit_cents || debits.amount_cents !== summary.debit_cents || payments.amount_cents !== summary.payment_cents) return broken();
  const { billed_cents: _billed, ...rest } = summary;
  return { seller: seller as unknown as CommissionSeller, month: route.mes, payable: value.payable as boolean,
    commissions: { total: c.total as number, parcel_cents: c.parcel_cents as string, base_cents: c.base_cents as string, commission_cents: c.commission_cents as string, items: lines }, credits, debits, payments,
    pending: { total: p.total as number, commission_cents: p.commission_cents as string, items: pending }, summary: rest };
}
/** The record of a command answer, checked against what was sent. */
export function commissionResult(value: unknown, action: string): Record<string, unknown> {
  if (!object(value) || value.action !== action || value.data_mode !== 'erp_native' || typeof value.replayed !== 'boolean' || !object(value.record)) return broken();
  return value.record;
}
/** Percent typed with comma (até 4 casas), sent as "10.5"; empty keeps the seller's rate. */
export function percentInput(value: string): string | null {
  const input = value.trim(); if (!input) return null;
  if (!/^\d{1,3}(?:,\d{1,4})?$/.test(input)) throw new Error('Informe a alíquota em %, com vírgula e até quatro casas.');
  const normalized = input.replace(',', '.'); if (Number(normalized) > 100 || Number(normalized) <= 0) throw new Error('A alíquota deve ser maior que zero e até 100%.');
  return normalized.replace(/^0+(?=\d)/, '');
}
