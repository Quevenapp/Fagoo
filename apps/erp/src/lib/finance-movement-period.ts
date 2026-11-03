import { validFinanceDate, type FinanceMovement } from './real-finance-model.ts';

/** A page selection, not a bank statement balance or a snapshot of the whole period. */
export type FinanceMovementQuery = Readonly<{ accountId: string; from: string; to: string; after: string | null }>;
export type FinanceMovementPage = Readonly<{
  entity: 'movements'; data_mode: 'erp_native'; limit: 25;
  items: readonly Readonly<FinanceMovement & { created_at: string }>[];
  has_more: boolean; next_cursor: string | null;
}>;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const KINDS = ['opening', 'payment', 'reversal', 'transfer_out', 'transfer_in', 'bank_fee', 'bank_fee_reversal', 'entry', 'entry_reversal'];
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const invalid = (): never => { throw new Error('FINANCE_MOVEMENT_PERIOD_INVALID'); };
const responseInvalid = (): never => { throw new Error('FINANCE_MOVEMENT_PAGE_INVALID'); };
function fields(raw: unknown, names: readonly string[], fail: () => never): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== names.length) return fail();
  return Object.fromEntries(names.map(name => {
    const descriptor = descriptors[name];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail();
    return [name, descriptor.value];
  }));
}
function day(raw: unknown, fail: () => never): string {
  if (typeof raw !== 'string') return fail();
  try { return validFinanceDate(raw); } catch { return fail(); }
}
/** Capture before starting a request. Empty dates mean an unbounded side; no implicit today/month. */
export function captureFinanceMovementQuery(raw: unknown): FinanceMovementQuery {
  const v = fields(raw, ['accountId', 'from', 'to', 'after'], invalid);
  if (!uuid(v.accountId) || (v.after !== null && !uuid(v.after))) invalid();
  const from = v.from === '' ? '' : day(v.from, invalid), to = v.to === '' ? '' : day(v.to, invalid);
  if (from && to && from > to) invalid();
  return Object.freeze({ accountId: v.accountId as string, from, to, after: v.after as string | null });
}
export function financeMovementPath(raw: FinanceMovementQuery): string {
  const q = captureFinanceMovementQuery(raw), params = new URLSearchParams({ parent_id: q.accountId, limit: '25' });
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  if (q.after !== null) params.set('after', q.after);
  // SQL010's optional kind filter does not list transfer/fee kinds. Never restrict it here.
  return `/v1/financeiro/movements?${params}`;
}
/** Bind every returned movement to the captured selection without sorting, filtering or summing it. */
export function financeMovementPage(raw: unknown, selected: FinanceMovementQuery): FinanceMovementPage {
  const q = captureFinanceMovementQuery(selected);
  const page = fields(raw, ['entity', 'items', 'limit', 'has_more', 'next_cursor', 'data_mode'], responseInvalid);
  if (page.entity !== 'movements' || page.data_mode !== 'erp_native' || page.limit !== 25 || !Array.isArray(page.items)
    || page.items.length > 25 || typeof page.has_more !== 'boolean'
    || (page.has_more ? page.items.length !== 25 || !uuid(page.next_cursor) : page.next_cursor !== null)) responseInvalid();
  let previous = q.after ?? '';
  const items = (page.items as unknown[]).map(rawItem => {
    const item = fields(rawItem, ['id', 'created_at', 'account_id', 'settlement_id', 'transfer_id', 'kind', 'delta_cents', 'posted_on', 'note'], responseInvalid);
    if (!uuid(item.id) || item.id <= previous || item.account_id !== q.accountId
      || (item.settlement_id !== null && !uuid(item.settlement_id)) || (item.transfer_id !== null && !uuid(item.transfer_id))
      || typeof item.kind !== 'string' || !KINDS.includes(item.kind)
      || typeof item.delta_cents !== 'string' || !/^-?\d{1,30}$/.test(item.delta_cents)
      || typeof item.created_at !== 'string' || item.created_at.length > 100
      || (item.note !== null && (typeof item.note !== 'string' || item.note.length > 500))) responseInvalid();
    const posted = day(item.posted_on, responseInvalid);
    if ((q.from && posted < q.from) || (q.to && posted > q.to)) responseInvalid();
    previous = item.id as string;
    return Object.freeze(item) as unknown as Readonly<FinanceMovement & { created_at: string }>;
  });
  if (page.has_more && page.next_cursor !== previous) responseInvalid();
  return Object.freeze({ entity: 'movements', data_mode: 'erp_native', limit: 25, items: Object.freeze(items),
    has_more: page.has_more as boolean, next_cursor: page.next_cursor as string | null });
}
