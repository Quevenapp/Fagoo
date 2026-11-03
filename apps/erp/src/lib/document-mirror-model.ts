import type { DocumentRecord } from './real-documents-model.ts';
import type { DocumentMirrorMeta, DocumentMirrorRecord, DocumentOriginTotals } from '../../../../packages/erp-domain/src/document-mirror.mjs';
export type { DocumentMirrorMeta, DocumentMirrorRecord, DocumentMirrorItem, DocumentOriginTotals } from '../../../../packages/erp-domain/src/document-mirror.mjs';
/** Commercial mirrors keep the observed values separate from the native calculation. Since the two-way sync (202610220009) a
 * document of Origin origin is converted to the native model (authority brufap): only a document still under the Origin authority
 * is read-only; the origin only says where it was created. */
export interface DocumentOrigin {
  origin?: 'brufap' | 'origin'; authority?: 'brufap' | 'origin'; readonly?: boolean; mirror?: DocumentMirrorMeta | null;
}
export type DocumentReadRecord = DocumentRecord | DocumentMirrorRecord;
export const DOCUMENT_MIRROR_READ_ONLY = 'Documento do Origin ainda em conversão para o FAGOO: aguarde a próxima sincronização para editar.';
export const isDocumentMirror = (document: DocumentOrigin): document is DocumentOrigin & { origin: 'origin'; mirror: DocumentMirrorMeta } => document.authority === 'origin';
export const isMirrorRecord = (document: DocumentReadRecord): document is DocumentMirrorRecord => isDocumentMirror(document);
export const documentOriginLabel = (document: DocumentOrigin) => document.origin === 'origin' || isDocumentMirror(document) ? 'Origin' : 'FAGOO';
export const documentNumber = (document: { number: string | null }) => document.number ?? 'Não informado';
export function documentSelectionTotals(rows: readonly (DocumentOrigin & { total: string | null })[]): DocumentOriginTotals {
  const result: DocumentOriginTotals = { origin: { count: 0, known_total_count: 0, total: null }, brufap: { count: 0, known_total_count: 0, total: null } };
  for (const origin of ['origin', 'brufap'] as const) {
    const selected = rows.filter(row => (row.origin === 'origin' || isDocumentMirror(row) ? 'origin' : 'brufap') === origin), known = selected.filter(row => row.total !== null);
    const scale = Math.max(2, ...known.map(row => row.total!.split('.')[1]?.length ?? 0)), factor = 10n ** BigInt(scale);
    const total = known.reduce((sum, row) => { const [whole, fraction = ''] = row.total!.split('.'); return sum + BigInt(whole!) * factor + BigInt(fraction.padEnd(scale, '0')); }, 0n);
    result[origin] = { count: selected.length, known_total_count: known.length, total: known.length && known.length === selected.length ? `${total / factor}.${String(total % factor).padStart(scale, '0')}` : null };
  }
  return result;
}
export const documentObservedAt = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : 'Não informado';
/** Decimal strings are formatted without converting them to Number or rounding them. */
export function mirrorDecimal(value: string | null | undefined, money = false): string {
  if (value === null || value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value)) return 'Não informado';
  const [whole, fraction] = value.split('.');
  return `${money ? 'R$ ' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? ',' + fraction : money ? ',00' : ''}`;
}
