// 202610200287/288 "Informar lotes" of an item of the pedido de venda or of a peça of the OS: the lots of the product (Estoque › Lotes e
// validades) adding up to the quantity of the item; without lots the stock is posted "Sem lote". Exact decimals (BigInt), never Number.
import type { DocumentKind, ItemLot } from '../../../../packages/erp-domain/src/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LOT_KINDS: readonly DocumentKind[] = ['sales_orders', 'service_orders'];
export interface LotOption { id: string; code: string; manufactured_on: string | null; expires_on: string | null; active: boolean; quantity: string }
export interface LotOptions { product: { id: string; name: string; code: string | null; unit: string; lot_control: boolean }; warehouse_id: string | null; total: number; items: LotOption[] }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** GET /v1/documentos/{tipo}/lotes?produtos=…: the products with Controle de lote. */
export function readLotProducts(value: unknown, asked: readonly string[]): Set<string> {
  if (!object(value) || !Array.isArray(value.items)) throw new Error('Resposta inválida dos lotes.');
  const out = new Set<string>();
  for (const item of value.items) {
    if (!object(item) || typeof item.product_id !== 'string' || !asked.includes(item.product_id) || typeof item.lot_control !== 'boolean') throw new Error('Resposta inválida dos lotes.');
    if (item.lot_control) out.add(item.product_id);
  }
  return out;
}
export const lotProductsPath = (kind: DocumentKind, ids: readonly string[]) => `/v1/documentos/${kind}/lotes?${new URLSearchParams({ produtos: ids.join(',') })}`;
export const lotOptionsPath = (kind: DocumentKind, productId: string, warehouseId: string | null) =>
  `/v1/documentos/${kind}/lotes/${productId}${warehouseId ? `?${new URLSearchParams({ deposito: warehouseId })}` : ''}`;
/** GET /v1/documentos/{tipo}/lotes/{produto}: the lots offered (active first). */
export function readLotOptions(value: unknown, productId: string): LotOptions {
  const v = value as LotOptions | null;
  if (!object(v) || !object(v.product) || v.product.id !== productId || !Array.isArray(v.items) || v.items.some(item => !object(item) || !UUID.test(item.id) || typeof item.code !== 'string'
    || typeof item.active !== 'boolean' || typeof item.quantity !== 'string')) throw new Error('Resposta inválida dos lotes.');
  return v;
}
const units = (value: string) => { if (!/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/.test(value)) return null; const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')); };
export const formatUnits = (value: bigint) => { const negative = value < 0n, abs = negative ? -value : value; const fraction = String(abs % 1_000_000n).padStart(6, '0').replace(/0+$/, ''); return `${negative ? '-' : ''}${abs / 1_000_000n}${fraction ? `,${fraction}` : ''}`; };
/** The lots of the panel: every row with a lot and a quantity above zero, no lot twice, the sum equal to the quantity of the item. */
export function lotsProblem(rows: readonly { lot_id: string; quantity: string }[], quantity: string): string | null {
  if (!rows.length) return null;
  const item = units(quantity);
  if (item === null) return 'Confira a quantidade do item antes de informar os lotes.';
  const seen = new Set<string>(); let sum = 0n;
  for (const row of rows) {
    if (!UUID.test(row.lot_id)) return 'Escolha o lote de cada linha.';
    if (seen.has(row.lot_id)) return 'Um lote aparece mais de uma vez.';
    seen.add(row.lot_id);
    const value = units(row.quantity);
    if (value === null || value <= 0n) return 'Informe a quantidade de cada lote, maior que zero e com até seis casas decimais.';
    sum += value;
  }
  return sum === item ? null : `A soma dos lotes (${formatUnits(sum)}) precisa ser igual à quantidade do item (${formatUnits(item)}).`;
}
/** What is still "Sem lote" of the item (quantity − lots), for the panel. */
export function withoutLot(rows: readonly { quantity: string }[], quantity: string): string | null {
  const item = units(quantity); if (item === null) return null;
  let sum = 0n; for (const row of rows) { const value = units(row.quantity); if (value === null) return null; sum += value; }
  return formatUnits(item - sum);
}
export const lotsSummary = (lots: readonly ItemLot[] | null | undefined) => !lots?.length ? '' : lots.length === 1 ? '1 lote informado' : `${lots.length} lotes informados`;
