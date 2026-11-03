// Sacola de vendas (202610200197): the bag of the user, kept on the server, and the pedido de venda opened from it.
import { freshDocument, type DocumentInput } from './real-documents-model.ts';
import type { ImportDraft } from './document-xml-import-model.ts';
import { compactDocumentDecimal } from './document-decimals.ts';

export const SALES_BAG_PATH = '/v1/documentos/sacola-vendas';
export interface SalesBagItem { product_id: string; name: string; code: string | null; unit: string | null; price: string | null; quantity: string; active: boolean; kind: string | null; }
export interface SalesBag { items: SalesBagItem[]; count: number; limit: number; }
export type SalesBagChange = { action: 'add' | 'set'; product_id: string; quantity: string } | { action: 'remove'; product_id: string } | { action: 'clear' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET and POST answers of /v1/documentos/sacola-vendas (the Worker checked every field; the screen checks the shape again). */
export function readSalesBag(value: unknown): SalesBag & { replayed?: boolean } {
  const page = (value ?? {}) as { items?: unknown; count?: unknown; limit?: unknown; replayed?: unknown };
  if (!Array.isArray(page.items) || page.items.length > 250 || page.count !== page.items.length || page.limit !== 250) throw new Error('SALES_BAG_INVALID');
  const items = (page.items as SalesBagItem[]).map(item => {
    if (!item || !UUID.test(item.product_id) || typeof item.name !== 'string' || typeof item.quantity !== 'string' || !/^\d{1,9}\.\d{6}$/.test(item.quantity) || typeof item.active !== 'boolean') throw new Error('SALES_BAG_INVALID');
    return { ...item };
  });
  return { items, count: items.length, limit: 250, ...(typeof page.replayed === 'boolean' ? { replayed: page.replayed } : {}) };
}
/** Quantity typed by the user (comma or dot), as the documents take it: up to nine integer digits and six decimals, above zero. */
export function bagQuantity(text: string): string | null {
  const value = text.trim().replace(',', '.');
  if (!/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(value) || /^0(\.0+)?$/.test(value)) return null;
  return value;
}
export const quantityText = (value: string) => compactDocumentDecimal(value).replace('.', ',');

/** "Gerar pedido de venda": a new pedido (not saved) with the products of the bag at their current price. */
export function salesBagDraft(bag: SalesBag, today: string): ImportDraft {
  const usable = bag.items.filter(item => item.active);
  const data: DocumentInput = { ...freshDocument('sales_orders', today), items: usable.map(item => {
    const price = item.price ? compactDocumentDecimal(item.price) : '0';
    return { id: crypto.randomUUID(), product_id: item.product_id, description: item.name, code: item.code, unit: item.unit || 'UN', quantity: compactDocumentDecimal(item.quantity), unit_price: price,
      discount_percent: '0', detailed_description: null, list_price: price, supplier_code: null };
  }) };
  const left = bag.items.length - usable.length;
  return { kind: 'sales_orders', data, contact: null, quick: null, sales_bag: true,
    notices: [`Pedido montado com ${usable.length} item(ns) da sacola de vendas, com o preço atual de cada produto. Escolha o cliente, confira e salve: nada foi gravado ainda, e a sacola é esvaziada depois de salvar.`,
      ...(left ? [`${left} produto(s) inativo(s) da sacola ficaram de fora.`] : [])] };
}
