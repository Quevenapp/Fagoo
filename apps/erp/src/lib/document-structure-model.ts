// 202610200240: the current structure (Estoque › composições) of each product of a saved document and its Produção (Própria |
// Terceiros), read by the prints: "Desmembrar produtos da estrutura", "Ocultar itens produzidos por terceiros" and the Relatório de
// Produção ("Exibir estrutura de itens"). Read-only (GET /v1/documentos/{tipo}/{id}/estrutura).
import type { DocumentKind } from './real-documents-model';

export interface StructureComponent { product_id: string; code: string | null; description: string; unit: string | null; quantity: string; total: string }
export interface StructureItem { item_id: string; position: number; product_id: string; production: 'own' | 'third_party' | null; components: StructureComponent[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, QTY = /^\d+\.\d{6}$/;
export const structurePath = (kind: DocumentKind, id: string) => `/v1/documentos/${kind}/${id}/estrutura`;
/** The Worker checks every field; this guards against a foreign or late answer. */
export function readStructures(value: unknown, kind: DocumentKind, id: string): StructureItem[] {
  const page = value as { kind?: unknown; document_id?: unknown; items?: unknown } | null;
  if (!page || page.kind !== kind || page.document_id !== id || !Array.isArray(page.items)) throw new Error('STRUCTURE_INVALID');
  return (page.items as StructureItem[]).map(item => {
    if (!item || !UUID.test(item.item_id) || !UUID.test(item.product_id) || !Number.isInteger(item.position) || !(item.production === null || item.production === 'own' || item.production === 'third_party')
      || !Array.isArray(item.components) || item.components.some(c => !c || !UUID.test(c.product_id) || typeof c.description !== 'string' || !QTY.test(c.quantity) || !QTY.test(c.total))) throw new Error('STRUCTURE_INVALID');
    return { ...item, components: item.components.map(c => ({ ...c })) };
  });
}
