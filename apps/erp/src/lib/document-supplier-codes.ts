// "Código secundário: Código no fornecedor" da impressão do pedido de compra (Preferências › Suprimentos › Configurações de pedidos
// de compras): o código de cada produto no fornecedor do pedido, lido do cadastro de produtos (aba Fornecedores) pela consulta de
// informações de compra (GET /v1/cadastros/products/compras, até 100 produtos). Só leitura; sem permissão de ler produtos, a coluna
// fica vazia.
import type { DocumentRecord } from './real-documents-model';
import type { DocumentPrintPreferences } from './document-preferences';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The lookup path, or null when the print does not need it (other kinds, other secondary codes, no linked products). */
export function supplierCodesPath(record: Pick<DocumentRecord, 'kind' | 'contact_id' | 'items'>, prefs: Pick<DocumentPrintPreferences, 'secondaryCode'> | null | undefined): string | null {
  if (record.kind !== 'purchase_orders' || prefs?.secondaryCode !== 'codigo_fornecedor' || !UUID.test(record.contact_id ?? '')) return null;
  const ids = [...new Set(record.items.map(item => item.product_id).filter((id): id is string => typeof id === 'string' && UUID.test(id)))].slice(0, 100);
  return ids.length ? `/v1/cadastros/products/compras?${new URLSearchParams({ ids: ids.join(','), fornecedor: record.contact_id })}` : null;
}
/** Product id → code at the supplier of the order (null: the product has no code there, or the supplier is not linked). */
export function supplierCodes(value: unknown, record: Pick<DocumentRecord, 'contact_id'>): Record<string, string | null> {
  const page = value as { supplier_id?: unknown; items?: { product_id?: unknown; supplier?: { id?: unknown; code?: unknown } | null }[] } | null;
  const supplier = (record.contact_id ?? '').toLowerCase();
  if (!page || typeof page.supplier_id !== 'string' || page.supplier_id.toLowerCase() !== supplier || !Array.isArray(page.items)) throw new Error('SUPPLIER_CODES_INVALID');
  const codes: Record<string, string | null> = {};
  for (const item of page.items) {
    if (typeof item?.product_id !== 'string' || !UUID.test(item.product_id)) throw new Error('SUPPLIER_CODES_INVALID');
    const code = item.supplier && typeof item.supplier.id === 'string' && item.supplier.id.toLowerCase() === supplier && typeof item.supplier.code === 'string' && item.supplier.code.trim() && item.supplier.code.length <= 60 ? item.supplier.code : null;
    codes[item.product_id] = code;
  }
  return codes;
}
