import type { ProductSection } from './product-model.ts';

// Foundation shared by catalog-model.ts, product-model.ts and contact-model.ts. It imports no other catalog
// module at runtime, so the entity models can depend on it without an import cycle.
export const CATALOG_LABELS = { contacts: 'Clientes e fornecedores', products: 'Produtos', warehouses: 'Depósitos' } as const;
export type CatalogEntity = keyof typeof CATALOG_LABELS;
export interface CatalogAccess { read: CatalogEntity[]; write: CatalogEntity[]; data_mode: 'erp_native' }
export interface CatalogRecord {
  id: string; entity: CatalogEntity; version: number; active: boolean; name: string; code: string | null;
  created_at: string; updated_at: string; roles?: string[]; source: { system: string; source_id: string; state: string } | null;
  [key: string]: unknown;
}
export interface CatalogPage { entity: CatalogEntity; items: CatalogRecord[]; next_cursor: string | null; has_more: boolean; limit: number; data_mode: 'erp_native' }
export interface CatalogEnvelope { entity: CatalogEntity; record: CatalogRecord; data_mode: 'erp_native'; replayed?: boolean }
export interface CatalogField { key: string; label: string; max: number; type?: 'email' | 'textarea' | 'select'; options?: { value: string; label: string }[]; section?: ProductSection; decimal?: 6 | 10; integer?: boolean; help?: string }
/** Nome and Código of contacts and depósitos (products declare their own, with a form section). */
export const COMMON_FIELDS: CatalogField[] = [{ key: 'name', label: 'Nome', max: 200 }, { key: 'code', label: 'Código', max: 100 }];
export class CatalogValidationError extends Error {
  field: string;
  constructor(field: string, message: string) { super(message); this.field = field; }
}
export const invalidField = (field: string, message: string): never => { throw new CatalogValidationError(field, message); };
