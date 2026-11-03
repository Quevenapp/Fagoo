// 202610200240 Pedidos de compra "Imprimir etiquetas": the products of the saved pedidos for the product labels of Cadastros ›
// Produtos (ProductLabels: nome, código, preço and código de barras do GTIN ou do código).
import type { DocumentRecord } from './real-documents-model';
import type { LabelProduct } from '../components/ProductLabels';

/** 202610200283: `quantities` is "uma etiqueta por quantidade": the sum of the item quantities of each product, rounded up, 1 to 999. */
export interface PurchaseLabels { products: LabelProduct[]; orders: number; quantities: Record<string, string> }
const SCALE = 1000000n;
/** An exact decimal quantity (up to 6 places) in millionths; anything else is null. */
const millionths = (value: unknown) => { if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,6})?$/.test(value)) return null; const [whole, part = ''] = value.split('.'); return BigInt(whole!) * SCALE + BigInt(part.padEnd(6, '0')); };
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
/** One entry per product of the cadastro, in the order the items appear (free items have no product and no label). */
export function purchaseLabelProducts(records: readonly DocumentRecord[]): PurchaseLabels {
  const seen = new Map<string, LabelProduct>(), totals = new Map<string, bigint>();
  for (const record of records) for (const item of record.items) {
    if (!item.product_id) continue;
    const quantity = millionths(item.quantity); if (quantity !== null) totals.set(item.product_id, (totals.get(item.product_id) ?? 0n) + quantity);
    if (seen.has(item.product_id)) continue;
    const snapshot = item.product_snapshot ?? {};
    seen.set(item.product_id, { id: item.product_id, name: text(snapshot.name) ?? item.description, code: item.code ?? text(snapshot.code), price: text(snapshot.price), gtin: text(snapshot.gtin) });
  }
  const quantities = Object.fromEntries([...seen.keys()].map(id => { const total = totals.get(id) ?? 0n, labels = (total + SCALE - 1n) / SCALE;
    return [id, String(labels < 1n ? 1n : labels > 999n ? 999n : labels)]; }));
  return { products: [...seen.values()], orders: records.length, quantities };
}

/** Leva H (NFE-209): "Imprimir etiquetas selecionadas" of Notas de entrada — the products of the selected Brufap notes, one label per
 * quantity (rounded up, 1 to 999), like the pedidos de compra. Items without a product of the cadastro have no label. */
export function invoiceLabelProducts(records: readonly { items: readonly Record<string, unknown>[] }[]): PurchaseLabels {
  const seen = new Map<string, LabelProduct>(), totals = new Map<string, bigint>();
  for (const record of records) for (const item of record.items) {
    const id = text(item.product_id); if (!id) continue;
    const quantity = millionths(item.quantity); if (quantity !== null) totals.set(id, (totals.get(id) ?? 0n) + quantity);
    if (seen.has(id)) continue;
    seen.set(id, { id, name: text(item.description) ?? 'Produto', code: text(item.code), price: null, gtin: text(item.gtin) });
  }
  const quantities = Object.fromEntries([...seen.keys()].map(id => { const total = totals.get(id) ?? 0n, labels = (total + SCALE - 1n) / SCALE;
    return [id, String(labels < 1n ? 1n : labels > 999n ? 999n : labels)]; }));
  return { products: [...seen.values()], orders: records.length, quantities };
}
