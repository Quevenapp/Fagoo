// "Formação de preços" of an entry note (Origin ⋮ Formação de preços): unit cost from the note and the sale price suggested by
// the markup of Preferências › Configurações de NF-e. Exact decimals with BigInt; prices with four decimals like the cadastro.
import type { InvoiceRecord } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';

const scaled = (value: unknown, scale: number) => {
  const text = String(value ?? '').trim();
  if (!/^\d{1,15}(\.\d+)?$/.test(text)) return 0n;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale));
};
const fixed = (value: bigint, scale: number) => { const base = 10n ** BigInt(scale); return `${value / base}.${String(value % base).padStart(scale, '0')}`; };
const half = (numerator: bigint, denominator: bigint) => denominator === 0n ? 0n : (2n * numerator + denominator) / (2n * denominator);
export const validMarkup = (value: string) => /^(0|[1-9]\d{0,4})([.,]\d{1,2})?$/.test(value.trim());
export interface PricingLine { position: number; description: string; product_id: string | null; quantity: string; purchase: string; ipi: string; st: string; freight: string; other: string; discount: string; cost: string; sale: string | null }
/** Per item: purchase unit price, per-unit IPI, ICMS ST, freight (with insurance), other expenses and discount, the unit cost and the sale price. */
export function pricingLines(record: Pick<InvoiceRecord, 'items'>, markups: Record<number, string>, fallback: string): PricingLine[] {
  return record.items.map(item => {
    const qty = scaled(item.quantity, 4) || 1n;
    const perUnit = (cents: bigint) => fixed(half(cents * 1000000n, qty), 4); // cents (2) / qty (4) with four decimals
    const ipi = scaled((item.ipi as Record<string, string> | undefined)?.value, 2), st = scaled((item.icms as Record<string, string> | undefined)?.st_value, 2);
    const freight = scaled(item.allocated.freight, 2) + scaled(item.allocated.insurance, 2), other = scaled(item.allocated.other_expenses, 2), discount = scaled(item.allocated.discount, 2);
    const total = scaled(item.total, 2), costCents = total + ipi + st + freight + other - discount;
    const cost = half(costCents * 1000000n, qty), markup = (markups[item.position] ?? fallback).trim().replace(',', '.');
    const sale = validMarkup(markup) ? fixed(half(cost * (10000n + scaled(markup, 2)), 10000n), 4) : null;
    return { position: item.position, description: String(item.description), product_id: typeof item.product_id === 'string' ? item.product_id : null, quantity: String(item.quantity),
      purchase: fixed(half(scaled(item.unit_price, 10), 1000000n), 4), ipi: perUnit(ipi), st: perUnit(st), freight: perUnit(freight), other: perUnit(other), discount: perUnit(discount), cost: fixed(cost, 4), sale };
  });
}
export const brUnit = (value: string | null) => value === null ? '—' : value.replace(/^(\d+)\.(\d+)$/, (_, w: string, f: string) => `${w.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`);

// ---- "P" Preços atualizados (migration 202610200252): the confirmed "Atualizar preços" recorded on the entry note ----
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const moment = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
export interface PricingState { invoice_id: string; recorded_at: string; products: number; count: number }
export interface PricingRecord { invoice_id: string; catalog_command_id: string; products: number; recorded_at: string; replayed: boolean }
const invalid = (): never => { throw new Error('PRICING_RESPONSE_INVALID'); };
/** POST /v1/notas-fiscais/precos answer for the ids of the page (anything else is refused). */
export function pricingStates(value: unknown, ids: readonly string[]): PricingState[] {
  const v = value as { items?: unknown; data_mode?: unknown } | null;
  if (!v || v.data_mode !== 'erp_native' || !Array.isArray(v.items) || v.items.length > ids.length) invalid();
  const items = (v!.items as Record<string, unknown>[]).map(i => {
    if (!i || typeof i.invoice_id !== 'string' || !ids.includes(i.invoice_id) || !moment(i.recorded_at) || !Number.isInteger(i.products) || (i.products as number) < 1 || !Number.isInteger(i.count) || (i.count as number) < 1) invalid();
    return { invoice_id: i.invoice_id as string, recorded_at: i.recorded_at as string, products: i.products as number, count: i.count as number };
  });
  if (new Set(items.map(i => i.invoice_id)).size !== items.length) invalid();
  return items;
}
/** POST /v1/notas-fiscais/{id}/precos answer for that note and that command of the cadastro. */
export function pricingRecord(value: unknown, invoiceId: string, commandId: string): PricingRecord {
  const v = value as Partial<PricingRecord> & { data_mode?: unknown } | null;
  if (!v || v.data_mode !== 'erp_native' || v.invoice_id !== invoiceId || !UUID.test(invoiceId) || v.catalog_command_id !== commandId || !Number.isInteger(v.products) || (v.products as number) < 1
    || !moment(v.recorded_at) || typeof v.replayed !== 'boolean') invalid();
  return { invoice_id: invoiceId, catalog_command_id: commandId, products: v!.products!, recorded_at: v!.recorded_at!, replayed: v!.replayed! };
}
export const pricingTitle = (state: PricingState) => `Preços atualizados em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(Date.parse(state.recorded_at))} (${state.products} produto${state.products === 1 ? '' : 's'}${state.count > 1 ? `, ${state.count} formações` : ''})`;
