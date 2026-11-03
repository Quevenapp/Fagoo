// Origin "Todos os depósitos" of an item (cubos): estoque atual per depósito, mínimo, máximo and the balance after the document.
// Exact decimal text only (six places, as the stock API); never a Number.
import type { DocumentKind } from './real-documents-model';
import { quantityText, type StockBalance } from './stock-model.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED = /^-?\d{1,18}\.\d{6}$/;
function fail(): never { throw new Error('ITEM_STOCK_INVALID'); }
/** Six-place units of a decimal text (form quantities such as "2" or "1,5" already normalized to "1.5"). */
export function stockUnits(value: string): bigint {
  const match = /^(-?)(\d{1,18})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) fail();
  const units = BigInt(match[2] + (match[3] ?? '').padEnd(6, '0'));
  return match[1] ? -units : units;
}
export function unitsText(units: bigint): string {
  const negative = units < 0n, text = (negative ? -units : units).toString().padStart(7, '0');
  return quantityText(`${negative ? '-' : ''}${text.slice(0, -6)}.${text.slice(-6)}`);
}
export type ItemStockRow = { warehouseId: string; name: string; current: string; reserved: string; available: string; after: string | null; ignored: boolean; isDefault: boolean };
export type ItemStockTone = 'ok' | 'low' | 'negative';
export type ItemStockView = { rows: ItemStockRow[]; total: string; totalAfter: string; tone: ItemStockTone; min: string | null; max: string | null; unit: string | null; afterLabel: string };

/** `/v1/estoque/saldos?product_id` (per depósito) plus the mínimo and máximo of the cadastro, for a line of the document. */
export function itemStockView(kind: DocumentKind, productId: string, balances: unknown, quantity: string, warehouseId: string | null, limits: { min: string | null; max: string | null }): ItemStockView {
  const value = balances as { product_id?: unknown; items?: unknown } | null;
  if (!value || value.product_id !== productId || !Array.isArray(value.items) || value.items.length > 1000) fail();
  const sign = kind === 'purchase_orders' ? 1n : -1n, amount = stockUnits(quantity || '0');
  const items = (value.items as StockBalance[]).filter(item => {
    if (!item || !UUID.test(item.warehouse_id) || typeof item.warehouse_name !== 'string' || !STORED.test(item.quantity)
      || (item.reserved_quantity !== undefined && !STORED.test(item.reserved_quantity))) fail();
    return item.warehouse_active;
  });
  // The document's depósito, else the depósito padrão, is where the document moves the stock.
  const target = items.find(item => item.warehouse_id === warehouseId)?.warehouse_id ?? items.find(item => item.warehouse_default)?.warehouse_id ?? null;
  const rows = items.map(item => {
    const current = stockUnits(item.quantity), reserved = stockUnits(item.reserved_quantity ?? '0.000000');
    return { warehouseId: item.warehouse_id, name: item.warehouse_name, current: unitsText(current), reserved: unitsText(reserved), available: unitsText(current - reserved),
      after: item.warehouse_id === target ? unitsText(current + sign * amount) : null, ignored: Boolean(item.warehouse_ignored), isDefault: Boolean(item.warehouse_default) };
  });
  const total = items.filter(item => !item.warehouse_ignored).reduce((sum, item) => sum + stockUnits(item.quantity), 0n), after = total + sign * amount;
  const min = limits.min === null ? null : stockUnits(limits.min);
  const tone: ItemStockTone = after < 0n ? 'negative' : min !== null && after < min ? 'low' : 'ok';
  return { rows, total: unitsText(total), totalAfter: unitsText(after), tone, min: limits.min === null ? null : unitsText(stockUnits(limits.min)), max: limits.max === null ? null : unitsText(stockUnits(limits.max)),
    unit: items.find(item => item.unit)?.unit ?? null, afterLabel: kind === 'purchase_orders' ? 'Depois da compra' : 'Depois da venda' };
}
export const ITEM_STOCK_TONES: Record<ItemStockTone, string> = { ok: 'Saldo suficiente', low: 'Abaixo do estoque mínimo', negative: 'Saldo negativo' };
