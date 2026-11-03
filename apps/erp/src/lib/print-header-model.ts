// 202610200270 "Exibir tipo de cabeçalho: Personalizado" (Preferências de Vendas, Propostas, Ordens de serviço e Pedidos de compra): the
// header of the prints of a kind, read by its readers and saved by the administrador (GET/POST /v1/documentos/{tipo}/cabecalho).
import { normalizeRichText, type RichText } from './rich-text-model.ts';
import type { DocumentKind } from '../../../../packages/erp-domain/src/index.mjs';

export interface PrintHeader { kind: DocumentKind; content: RichText | null; version: number; updated_at: string | null; can_manage: boolean; replayed?: boolean }
export const printHeaderPath = (kind: DocumentKind) => `/v1/documentos/${kind}/cabecalho`;
/** Origin titles of the kinds in the header screen. */
export const PRINT_HEADER_TITLES: Record<DocumentKind, string> = { sales_orders: 'Pedidos de venda', sales_proposals: 'Propostas comerciais', service_orders: 'Ordens de serviço', purchase_orders: 'Pedidos de compra' };
export function readPrintHeader(value: unknown, kind: DocumentKind, saving = false): PrintHeader {
  const v = value as Partial<PrintHeader> | null; let content: RichText | null;
  try { content = normalizeRichText(v?.content ?? null); } catch { throw new Error('PRINT_HEADER_INVALID'); }
  if (!v || v.kind !== kind || !Number.isInteger(v.version) || (v.version as number) < 0 || typeof v.can_manage !== 'boolean' || (v.updated_at !== null && typeof v.updated_at !== 'string')
    || (saving && typeof v.replayed !== 'boolean')) throw new Error('PRINT_HEADER_INVALID');
  return { kind, content, version: v.version as number, updated_at: v.updated_at ?? null, can_manage: v.can_manage, ...(saving ? { replayed: v.replayed } : {}) };
}
