// Financeiro > Faturamento agrupado (SQL 174): rota (?area=faturamento-agrupado), período do Origin e respostas conferidas.
export const GROUPED_PAGE_SIZE = 100;
export type GroupedPeriod = 'mes' | 'dia' | 'periodo';
export const GROUPED_PERIODS: readonly { id: GroupedPeriod; label: string }[] = [{ id: 'mes', label: 'Do mês' }, { id: 'dia', label: 'Do dia' }, { id: 'periodo', label: 'De um período' }];
export type GroupedRoute = { periodo: GroupedPeriod; mes: string; dia: string; from: string; to: string; q: string; page: number; pedidos: string[] | null; aba: 'agrupar' | 'gerados' };
/** invoices: SQL 247, the NF-e de saída of the cliente in the period (0 before it). */
export type GroupedCandidate = { contact_id: string; contact_name: string; documents: number; invoices?: number; total_cents: string };
/** kind: Venda (pedido de venda) or Nota Fiscal (SQL 247, with the pedidos of origin, never chosen together with them). */
export type GroupedDocument = { id: string; kind?: 'sales_orders' | 'fiscal_invoices'; number: string | null; date: string; total_cents: string; version: number; orders?: string[] };
export type GroupedBilling = { id: string; number: string; contact_id: string; contact_name: string; issued_on: string; condition: string; total_cents: string; state: 'active'; version: number; created_at: string; deletable: boolean;
  documents: { id: string; number: string; total_cents: string }[]; invoices?: { id: string; number: string | null; total_cents: string }[]; titles: { id: string; position: number; due_on: string; amount_cents: string; settled_cents: string; cancelled: boolean }[] };

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, CENTS = /^\d{1,30}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const broken: () => never = () => { throw new Error('Não foi possível conferir o faturamento agrupado. Tente novamente.'); };
const lastDay = (month: string) => { const [year, value] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(year, value, 0)).getUTCDate()).padStart(2, '0')}`; };

export function groupedRoute(params: URLSearchParams, today: string): GroupedRoute {
  for (const key of params.keys()) if (!['area', 'periodo', 'mes', 'dia', 'from', 'to', 'q', 'pagina', 'pedidos', 'aba'].includes(key) || params.getAll(key).length !== 1) throw new Error('Filtros inválidos no endereço.');
  const periodo = params.get('periodo') ?? 'mes', mes = params.get('mes') ?? today.slice(0, 7), dia = params.get('dia') ?? today, from = params.get('from') ?? today, to = params.get('to') ?? today, q = params.get('q') ?? '', page = params.get('pagina') ?? '1', aba = params.get('aba') ?? 'agrupar';
  const pedidos = params.get('pedidos');
  const ids = pedidos === null ? null : pedidos.split(',');
  if (!GROUPED_PERIODS.some(item => item.id === periodo) || !MONTH.test(mes) || !DAY.test(dia) || !DAY.test(from) || !DAY.test(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366 || q.length > 120 || /[\x00-\x1f\x7f]/.test(q)
    || !/^[1-9]\d{0,5}$/.test(page) || !['agrupar', 'gerados'].includes(aba) || (ids && (!ids.length || ids.length > 200 || ids.some(item => !UUID.test(item)) || new Set(ids).size !== ids.length))) throw new Error('Filtros inválidos no endereço.');
  return { periodo: periodo as GroupedPeriod, mes, dia, from, to, q, page: Number(page), pedidos: ids, aba: aba as GroupedRoute['aba'] };
}
export function groupedParams(route: GroupedRoute, today: string) {
  const params = new URLSearchParams({ area: 'faturamento-agrupado' });
  if (route.aba === 'gerados') params.set('aba', 'gerados');
  if (route.pedidos) params.set('pedidos', route.pedidos.join(','));
  else if (route.aba === 'agrupar') {
    if (route.periodo !== 'mes') params.set('periodo', route.periodo);
    if (route.periodo === 'mes' && route.mes !== today.slice(0, 7)) params.set('mes', route.mes);
    if (route.periodo === 'dia' && route.dia !== today) params.set('dia', route.dia);
    if (route.periodo === 'periodo') { params.set('from', route.from); params.set('to', route.to); }
  }
  if (route.q) params.set('q', route.q); if (route.page > 1) params.set('pagina', String(route.page));
  return params;
}
/** The dates of the Período chosen (Do mês | Do dia | De um período). */
export function groupedRange(route: GroupedRoute): { from: string; to: string } {
  if (route.periodo === 'dia') return { from: route.dia, to: route.dia };
  if (route.periodo === 'periodo') return { from: route.from, to: route.to };
  return { from: `${route.mes}-01`, to: lastDay(route.mes) };
}
export function groupedApiPath(route: GroupedRoute) {
  const params = new URLSearchParams();
  if (route.aba === 'gerados') { if (route.q) params.set('q', route.q); if (route.page > 1) params.set('page', String(route.page)); return `/v1/financeiro/faturamento-agrupado/gerados${params.size ? `?${params}` : ''}`; }
  if (route.pedidos) params.set('documents', route.pedidos.join(',')); else { const range = groupedRange(route); params.set('from', range.from); params.set('to', range.to); }
  if (route.q) params.set('q', route.q); if (route.page > 1) params.set('page', String(route.page));
  return `/v1/financeiro/faturamento-agrupado?${params}`;
}
export function groupedDocumentsPath(route: GroupedRoute, contact: string) {
  const params = new URLSearchParams({ contact });
  if (route.pedidos) params.set('documents', route.pedidos.join(',')); else { const range = groupedRange(route); params.set('from', range.from); params.set('to', range.to); }
  return `/v1/financeiro/faturamento-agrupado/documentos?${params}`;
}
export function groupedCandidates(value: unknown, route: GroupedRoute): { total: number; items: GroupedCandidate[] } {
  if (!object(value) || value.entity !== 'grouped_billing_candidates' || value.data_mode !== 'erp_native' || value.page !== route.page || value.selected !== Boolean(route.pedidos) || !Number.isSafeInteger(value.total) || !Array.isArray(value.items)
    || value.items.length !== Math.max(0, Math.min(GROUPED_PAGE_SIZE, (value.total as number) - (route.page - 1) * GROUPED_PAGE_SIZE))) return broken();
  for (const item of value.items as unknown[]) if (!object(item) || typeof item.contact_id !== 'string' || !UUID.test(item.contact_id) || typeof item.contact_name !== 'string' || !Number.isSafeInteger(item.documents) || typeof item.total_cents !== 'string' || !CENTS.test(item.total_cents)) return broken();
  return { total: value.total as number, items: value.items as GroupedCandidate[] };
}
export function groupedDocuments(value: unknown, contact: string): { total: number; items: GroupedDocument[] } {
  if (!object(value) || value.entity !== 'grouped_billing_documents' || value.data_mode !== 'erp_native' || value.contact_id !== contact || !Number.isSafeInteger(value.total) || !Array.isArray(value.items)) return broken();
  for (const item of value.items as unknown[]) if (!object(item) || typeof item.id !== 'string' || !UUID.test(item.id) || !['sales_orders', 'fiscal_invoices', undefined].includes(item.kind as string | undefined)
    || (item.kind === 'fiscal_invoices' ? item.number !== null && typeof item.number !== 'string' : typeof item.number !== 'string') || typeof item.total_cents !== 'string' || !CENTS.test(item.total_cents)
    || (item.orders !== undefined && (!Array.isArray(item.orders) || item.orders.some(order => typeof order !== 'string' || !UUID.test(order))))) return broken();
  return { total: value.total as number, items: value.items as GroupedDocument[] };
}
/** "Venda nº 12" / "Nota Fiscal nº 345" (an own note not sent yet: "Nota Fiscal (sem número)"), as the Origin selection modal. */
export const groupedItemLabel = (item: GroupedDocument) => item.kind === 'fiscal_invoices' ? item.number ? `Nota Fiscal nº ${item.number}` : 'Nota Fiscal (sem número)' : `Venda nº ${item.number}`;
/** Choosing a note leaves its pedidos out (one sale is billed once); choosing a pedido leaves its notes out. */
export function groupedToggle(items: readonly GroupedDocument[], chosen: readonly string[], id: string): string[] {
  if (chosen.includes(id)) return chosen.filter(item => item !== id);
  const item = items.find(entry => entry.id === id), related = new Set<string>();
  if (item?.kind === 'fiscal_invoices') for (const order of item.orders ?? []) related.add(order);
  else for (const entry of items) if (entry.kind === 'fiscal_invoices' && (entry.orders ?? []).includes(id)) related.add(entry.id);
  return [...chosen.filter(entry => !related.has(entry)), id];
}
/** Every item, without a pedido whose note is also listed (the note represents the sale). */
export function groupedDefaultChoice(items: readonly GroupedDocument[]): string[] {
  const billedByNote = new Set(items.flatMap(item => item.kind === 'fiscal_invoices' ? item.orders ?? [] : []));
  return items.filter(item => !billedByNote.has(item.id)).map(item => item.id);
}
export function groupedPage(value: unknown, route: GroupedRoute): { total: number; items: GroupedBilling[] } {
  if (!object(value) || value.entity !== 'grouped_billings' || value.data_mode !== 'erp_native' || value.page !== route.page || !Number.isSafeInteger(value.total) || !Array.isArray(value.items)) return broken();
  for (const item of value.items as unknown[]) if (!object(item) || typeof item.id !== 'string' || typeof item.contact_name !== 'string' || !Array.isArray(item.documents) || !Array.isArray(item.titles) || typeof item.deletable !== 'boolean') return broken();
  return { total: value.total as number, items: value.items as GroupedBilling[] };
}
export function groupedResult(value: unknown, action: string): Record<string, unknown> {
  if (!object(value) || value.action !== action || value.entity !== 'grouped_billings' || value.data_mode !== 'erp_native' || typeof value.replayed !== 'boolean') return broken();
  return value;
}
export const sumCents = (values: readonly string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString();
