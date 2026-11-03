import { validFinanceDate, type FinanceEntity, type FinanceEnvelope, type FinancePage, type FinanceRecord, type FinanceTitle, type FinanceTitleOrigin, type FinanceTitlePage } from './real-finance-model.ts';

export type FinanceArea = 'receivable' | 'payable' | 'accounts' | 'categories';
/** Origin "Opção": Em aberto, Atrasadas, Emitidas and Recebidas (Pagas in contas a pagar). */
export type FinanceTitleOption = 'open' | 'overdue' | 'issued' | 'settled';
/** Origin "Situação" of Emitidas (SQL 281: Devolvido, a cancelled conta marked by a devolução). */
export type FinanceTitleStatus = 'open' | 'partial' | 'paid' | 'cancelled' | 'returned';
export type FinanceDateField = 'due' | 'issued' | 'settled' | 'competence';
export type FinanceTitleOrder = 'due_asc' | 'due_desc';
/**
 * URL state of the financial list. `status` and `category` are comma lists in canonical order; `value` is cents;
 * `account` is a UUID or "none"; `page` starts at 1. Without `from`/`to` the Origin default period applies.
 */
export type FinanceListRoute = {
  area: FinanceArea; q: string; option: FinanceTitleOption; status: string; from: string; to: string; date: FinanceDateField; account: string; category: string;
  remittance: '' | 'yes' | 'no'; value: string; doc: string; order: FinanceTitleOrder; page: number; titleId?: string;
  /** SQL 210: Tipo de pagamento (tPag, two digits), Forma de pagamento and Vendedor (contas a receber); absent or '' = Todas. */
  paymentType?: string; paymentMethod?: string; seller?: string;
};
export const FINANCE_TITLE_PAGE_SIZE = 100;
export const FINANCE_TITLE_OPTIONS: readonly FinanceTitleOption[] = ['open', 'overdue', 'issued', 'settled'];
/** Display and canonical URL order of Origin's Situação: Cancelada, Devolvido, Em aberto, Parcialmente recebida/paga, Recebida/Paga. */
export const FINANCE_TITLE_STATUSES: readonly FinanceTitleStatus[] = ['cancelled', 'returned', 'open', 'partial', 'paid'];
const AREAS: FinanceArea[] = ['receivable', 'payable', 'accounts', 'categories'];
const KEYS = ['area', 'q', 'opcao', 'status', 'from', 'to', 'date', 'conta', 'category', 'remessa', 'valor', 'doc', 'order', 'page', 'titulo', 'tipo', 'forma', 'vendedor'];
const ORIGIN_KINDS: Record<string, readonly string[]> = { receivable: ['sales_orders', 'service_orders'], payable: ['purchase_orders'] };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const cents = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,14})$/.test(value);
const unsafeText = (value: string) => /[\x00-\x1f\x7f]/.test(value);
function invalid(): never { throw new Error('Confira os filtros da listagem financeira.'); }
export function emptyFinanceRoute(area: FinanceArea): FinanceListRoute {
  return { area, q: '', option: 'open', status: '', from: '', to: '', date: 'due', account: '', category: '', remittance: '', value: '', doc: '', order: 'due_asc', page: 1 };
}
/** The date the period filters: fixed by the Opção, chosen only in Emitidas. */
export const optionDate = (option: FinanceTitleOption, chosen: FinanceDateField): FinanceDateField => option === 'issued' ? chosen : option === 'settled' ? 'settled' : 'due';
export const routeStatuses = (route: Pick<FinanceListRoute, 'status'>): FinanceTitleStatus[] => route.status ? route.status.split(',') as FinanceTitleStatus[] : [];
export const routeCategories = (route: Pick<FinanceListRoute, 'category'>): string[] => route.category ? route.category.split(',') : [];
/** Canonical comma list of distinct situações (empty for "todas"). */
export function statusParam(values: readonly string[]): string {
  if (values.some(value => !FINANCE_TITLE_STATUSES.includes(value as FinanceTitleStatus)) || new Set(values).size !== values.length) invalid();
  return FINANCE_TITLE_STATUSES.filter(value => values.includes(value)).join(',');
}
/** Canonical comma list of categorias: "none" first, then UUIDs in ascending order. */
export function categoryParam(values: readonly string[]): string {
  const normalized = values.map(value => value.toLowerCase());
  if (normalized.length > 50 || normalized.some(value => value !== 'none' && !uuid(value)) || new Set(normalized).size !== normalized.length) invalid();
  return [...normalized.filter(value => value === 'none'), ...normalized.filter(value => value !== 'none').sort()].join(',');
}
/** Origin opens contas with the period from the 1st day of the previous month to the last day of the next month (São Paulo). */
export function defaultTitlePeriod(today: string): { from: string; to: string } {
  validFinanceDate(today);
  const [year, month] = today.split('-').map(Number), first = new Date(Date.UTC(year, month - 2, 1)), last = new Date(Date.UTC(year, month + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}
/** The period actually requested: the one in the URL, or the Origin default. */
export function effectivePeriod(route: Pick<FinanceListRoute, 'from' | 'to'>, today: string): { from: string; to: string } {
  return route.from || route.to ? { from: route.from, to: route.to } : defaultTitlePeriod(today);
}
/** Titles accept the Origin filters of SQL 109; accounts and categories only search by name. */
export function financeListRoute(params: URLSearchParams, fallback: FinanceArea = 'receivable'): FinanceListRoute {
  for (const key of params.keys()) if (!KEYS.includes(key) || params.getAll(key).length !== 1) invalid();
  const area = params.get('area') ?? fallback, rawQuery = params.get('q') ?? '', q = rawQuery.trim(), rawStatus = params.get('status') ?? '', from = params.get('from') ?? '', to = params.get('to') ?? '';
  if (!AREAS.includes(area as FinanceArea) || rawQuery.length > 120 || unsafeText(rawQuery)) invalid();
  const option = params.get('opcao') ?? 'open';
  if (!FINANCE_TITLE_OPTIONS.includes(option as FinanceTitleOption)) invalid();
  const status = rawStatus ? statusParam(rawStatus.split(',')) : '';
  if (from) validFinanceDate(from); if (to) validFinanceDate(to);
  if (from && to && from > to) invalid();
  const date = params.get('date') ?? optionDate(option as FinanceTitleOption, 'due'), order = params.get('order') ?? 'due_asc', rawPage = params.get('page') ?? '1';
  const account = params.get('conta') ?? '', rawCategory = params.get('category') ?? '', remittance = params.get('remessa') ?? '', value = params.get('valor') ?? '', rawDoc = params.get('doc') ?? '', doc = rawDoc.trim();
  if (!['due', 'issued', 'settled', 'competence'].includes(date) || date !== optionDate(option as FinanceTitleOption, date as FinanceDateField)
    || (status && option !== 'issued') || !['due_asc', 'due_desc'].includes(order) || !/^[1-9]\d{0,5}$/.test(rawPage) || Number(rawPage) > 100000
    || (account && account !== 'none' && !uuid(account)) || !['', 'yes', 'no'].includes(remittance) || (remittance && (option !== 'open' || area !== 'receivable'))
    || (value && (!cents(value) || value === '0')) || rawDoc.length > 60 || unsafeText(rawDoc) || (doc && area !== 'payable')) invalid();
  const category = rawCategory ? categoryParam(rawCategory.split(',')) : '';
  // SQL 210: tipo (tPag), forma and vendedor (contas a receber only); kept out of the route when empty.
  const paymentType = params.get('tipo') ?? '', paymentMethod = params.get('forma') ?? '', seller = params.get('vendedor') ?? '';
  if ((paymentType && !/^\d{2}$/.test(paymentType)) || (paymentMethod && !uuid(paymentMethod)) || (seller && (!uuid(seller) || area !== 'receivable'))) invalid();
  if ((area === 'accounts' || area === 'categories') && (from || to || status || option !== 'open' || date !== 'due' || account || category || remittance || value || doc || order !== 'due_asc' || rawPage !== '1' || paymentType || paymentMethod)) invalid();
  const titleId = params.get('titulo');
  if (titleId !== null && (!uuid(titleId) || !params.has('area') || !['receivable', 'payable'].includes(area))) invalid();
  return { area: area as FinanceArea, q, option: option as FinanceTitleOption, status, from, to, date: date as FinanceDateField, account, category, remittance: remittance as FinanceListRoute['remittance'], value, doc,
    order: order as FinanceTitleOrder, page: Number(rawPage), ...(paymentType ? { paymentType } : {}), ...(paymentMethod ? { paymentMethod } : {}), ...(seller ? { seller } : {}), ...(titleId === null ? {} : { titleId }) };
}
export function financeListParams(value: FinanceListRoute): URLSearchParams {
  const params = new URLSearchParams({ area: value.area });
  if (value.q) params.set('q', value.q);
  if (value.option && value.option !== 'open') params.set('opcao', value.option);
  for (const key of ['status', 'from', 'to'] as const) if (value[key]) params.set(key, value[key]);
  if (value.option === 'issued' && value.date && value.date !== 'due') params.set('date', value.date);
  if (value.account) params.set('conta', value.account);
  if (value.category) params.set('category', value.category);
  if (value.remittance) params.set('remessa', value.remittance);
  if (value.value) params.set('valor', value.value);
  if (value.doc) params.set('doc', value.doc);
  if (value.order && value.order !== 'due_asc') params.set('order', value.order);
  if (value.page && value.page !== 1) params.set('page', String(value.page));
  if (value.paymentType) params.set('tipo', value.paymentType);
  if (value.paymentMethod) params.set('forma', value.paymentMethod);
  if (value.seller) params.set('vendedor', value.seller);
  if (value.titleId !== undefined) params.set('titulo', value.titleId);
  financeListRoute(params); return params;
}
export const financeListEntity = (area: FinanceArea): FinanceEntity => area === 'accounts' || area === 'categories' ? area : 'titles';
/** 010 cursor list, still used for accounts and categories (and by CNAB screens through their own paths). */
export function financeListApiPath(value: FinanceListRoute, after: string | null): string {
  const route = financeListRoute(financeListParams(value)), entity = financeListEntity(route.area), params = new URLSearchParams({ limit: '25' });
  if (entity === 'titles') invalid();
  if (after !== null) { if (!uuid(after)) invalid(); params.set('after', after); }
  if (route.q) params.set('q', route.q);
  return `/v1/financeiro/${entity}?${params}`;
}
/** Bind the returned page to its requested entity, beyond the server DTO validation. */
export function financeListPage(value: unknown, route: FinanceListRoute, after: string | null): FinancePage {
  const entity = financeListEntity(route.area);
  if (entity === 'titles' || !object(value) || value.entity !== entity || value.data_mode !== 'erp_native' || value.limit !== 25 || !Array.isArray(value.items)
    || value.items.length > 25 || typeof value.has_more !== 'boolean' || (value.has_more ? !uuid(value.next_cursor) || value.items.length !== 25 : value.next_cursor !== null)) invalid();
  let previous = after ?? '';
  for (const item of value.items) { if (!object(item) || !uuid(item.id) || item.id <= previous) invalid(); previous = item.id; }
  if (value.has_more && value.next_cursor !== previous) invalid();
  return value as unknown as FinancePage;
}
/** GET /v1/financeiro/titles in page mode (SQL 109): every filter of the URL and the effective period, 100 per page. */
export function financeTitlePageApiPath(value: FinanceListRoute, today: string): string {
  const route = financeListRoute(financeListParams(value));
  if (financeListEntity(route.area) !== 'titles') invalid();
  const period = effectivePeriod(route, today), params = new URLSearchParams({ page: String(route.page), limit: String(FINANCE_TITLE_PAGE_SIZE), kind: route.area, option: route.option });
  if (route.order !== 'due_asc') params.set('order', route.order);
  if (route.q) params.set('q', route.q);
  if (route.status) params.set('status', route.status);
  if (route.option === 'issued' && route.date !== 'due') params.set('date', route.date);
  if (period.from) params.set('from', period.from);
  if (period.to) params.set('to', period.to);
  if (route.account) params.set('account', route.account);
  if (route.category) params.set('category', route.category);
  if (route.remittance) params.set('remittance', route.remittance);
  if (route.value) params.set('amount_cents', route.value);
  if (route.doc) params.set('document', route.doc);
  if (route.paymentType) params.set('payment_type', route.paymentType);
  if (route.paymentMethod) params.set('payment_method', route.paymentMethod);
  if (route.seller) params.set('seller', route.seller);
  return `/v1/financeiro/titles?${params}`;
}
function titleOrigin(value: unknown, title: Record<string, unknown>): FinanceTitleOrigin | null {
  if (value === null) { if (title.document_linked !== false) invalid(); return null; }
  // SQL 247: "Nota fiscal de origem" (the direction of the note follows the kind of the conta).
  if (object(value) && value.kind === 'fiscal_invoices') {
    if (title.document_linked !== true || !uuid(value.invoice_id) || !['55', '65'].includes(String(value.model)) || value.direction !== (title.kind === 'payable' ? '0' : '1')
      || (value.number !== null && (typeof value.number !== 'string' || !/^[1-9]\d{0,8}$/.test(value.number)))) invalid();
    return { invoice_id: value.invoice_id as string, kind: 'fiscal_invoices', model: value.model as '55' | '65', direction: value.direction as '0' | '1', number: value.number as string | null };
  }
  if (!object(value) || title.document_linked !== true || !uuid(value.document_id) || !ORIGIN_KINDS[String(title.kind)]?.includes(String(value.kind))
    || typeof value.number !== 'string' || !/^[1-9]\d{0,9}$/.test(value.number)) invalid();
  return { document_id: value.document_id, kind: value.kind as 'sales_orders' | 'service_orders' | 'purchase_orders', number: value.number };
}
const cents30 = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
const day = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
function payments(value: unknown) {
  if (!object(value) || (value.settled_on !== null && !day(value.settled_on)) || typeof value.settled_by_return !== 'boolean'
    || !['fee_cents', 'interest_cents', 'penalty_cents', 'discount_cents'].every(key => cents30(value[key]))) invalid();
  return { settled_on: value.settled_on as string | null, fee_cents: value.fee_cents as string, interest_cents: value.interest_cents as string, penalty_cents: value.penalty_cents as string, discount_cents: value.discount_cents as string, settled_by_return: value.settled_by_return };
}
function remittance(value: unknown) {
  if (value === null) return null;
  if (!object(value) || !uuid(value.id) || !Number.isSafeInteger(value.sequence) || !['reserved', 'ready'].includes(String(value.state)) || (value.our_number !== null && typeof value.our_number !== 'string')) invalid();
  return { id: value.id, sequence: value.sequence as number, state: value.state as 'reserved' | 'ready', our_number: value.our_number as string | null };
}
function matchesStatus(item: Record<string, unknown>, statuses: FinanceTitleStatus[]) { return !statuses.length || statuses.includes(item.status as FinanceTitleStatus); }
/** The numbered page must be the one requested, in vencimento order, with every row inside the Opção and the applied filters. */
export function financeTitlePage(value: unknown, route: FinanceListRoute, today: string): FinanceTitlePage {
  if (!object(value) || value.entity !== 'titles' || value.data_mode !== 'erp_native' || value.kind !== route.area || value.page !== route.page || value.option !== route.option
    || value.limit !== FINANCE_TITLE_PAGE_SIZE || value.order !== route.order || !Number.isSafeInteger(value.total) || (value.total as number) < 0
    || !object(value.totals) || value.totals.count !== value.total || !cents30(value.totals.amount_cents) || !cents30(value.totals.balance_cents) || !cents30(value.totals.fee_cents)
    || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(FINANCE_TITLE_PAGE_SIZE, (value.total as number) - (route.page - 1) * FINANCE_TITLE_PAGE_SIZE))) invalid();
  const statuses = routeStatuses(route), categories = routeCategories(route), period = effectivePeriod(route, today), field = optionDate(route.option, route.date);
  const seen = new Set<string>(), items: Record<string, unknown>[] = []; let previous: string | null = null;
  for (const item of value.items as unknown[]) {
    if (!object(item) || !uuid(item.id) || seen.has(item.id) || item.kind !== route.area || !day(item.due_on) || !day(item.issued_on) || !cents(item.amount_cents) || !cents(item.balance_cents)
      || (item.deleted_at !== null && item.deleted_at !== undefined) || (item.recurrence_id !== null && item.recurrence_id !== undefined && !uuid(item.recurrence_id)) || (item.account_name !== null && typeof item.account_name !== 'string') || typeof item.imported !== 'boolean') invalid();
    seen.add(item.id);
    const key = `${item.due_on}:${item.id}`; if (previous !== null && (route.order === 'due_asc' ? key <= previous : key >= previous)) invalid(); previous = key;
    const paid = payments(item.payments), bank = remittance(item.remittance), open = item.cancelled !== true && BigInt(item.balance_cents as string) > 0n;
    const dayOf = field === 'issued' ? item.issued_on : field === 'due' ? item.due_on : field === 'competence' ? item.competence_on ?? item.issued_on : null;
    if (dayOf !== null && ((period.from && (dayOf as string) < period.from) || (period.to && (dayOf as string) > period.to))) invalid();
    if ((route.option === 'open' && !open) || (route.option === 'overdue' && (!open || item.overdue !== true)) || (route.option === 'settled' && (paid.settled_on === null || item.cancelled === true))
      || !matchesStatus(item, statuses) || (categories.length && !categories.some(category => category === 'none' ? item.category_id === null : item.category_id === category))
      || (route.account && (route.account === 'none' ? item.account_id !== null : item.account_id !== route.account)) || (route.value && item.amount_cents !== route.value)
      || (route.remittance && (route.remittance === 'yes') !== (bank !== null))
      || (route.paymentMethod && item.payment_method_id !== route.paymentMethod) || (route.paymentType && item.payment_type !== route.paymentType) || (route.seller && item.seller_id !== route.seller)) invalid();
    items.push({ ...item, origin: titleOrigin(item.origin, item), payments: paid, remittance: bank, account_name: item.account_name ?? null });
  }
  return { ...value, items } as unknown as FinanceTitlePage;
}
export function financeDetailRecord(value: unknown, entity: FinanceEntity, id: string, area: FinanceArea): FinanceRecord {
  if (!object(value) || value.entity !== entity || value.data_mode !== 'erp_native' || !object(value.record) || value.record.id !== id
    || (entity === 'titles' && value.record.kind !== area)) invalid();
  const record = (value as unknown as FinanceEnvelope).record;
  // 094 returns the origin beside the record; older responses simply omit it.
  if (entity === 'titles' && Object.hasOwn(value, 'origin')) return { ...(record as FinanceTitle), origin: titleOrigin(value.origin, value.record) };
  return record;
}
/** Emitidas with a vencimento period include every situação, unlike the due report. */
export function financePeriodNotice(route: FinanceListRoute): string | null {
  if (!['receivable', 'payable'].includes(route.area) || (!route.from && !route.to) || route.option !== 'issued' || route.date !== 'due') return null;
  return route.status ? 'O relatório soma os saldos pendentes. Esta listagem mostra somente a situação selecionada.'
    : 'A listagem inclui todas as situações. O relatório soma apenas os saldos pendentes.';
}
