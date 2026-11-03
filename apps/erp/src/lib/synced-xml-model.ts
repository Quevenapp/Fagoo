import type { NativeRequestOptions } from './real-access';
export interface SyncedXmlController {
  syncedXml(path: string, options?: NativeRequestOptions): Promise<unknown>;
  syncedXmlDownload(path: string, signal?: AbortSignal): Promise<Blob>;
}
export type SyncedXmlFilters = { q: string; model: '' | '55' | '65'; kind: '' | 'invoice' | 'event'; include_history: boolean };
export type SyncedXmlItem = { id: string; source_id: string; entity: 'nfe' | 'nfce'; key: string; model: '55' | '65'; environment: '1' | '2'; kind: 'invoice' | 'event'; revision: number;
  source_status: string | null; collected_at: string; xml_hash: string; size_bytes: number; protocol: string | null; protocol_present: boolean; signature_present: boolean;
  event_type: string | null; event_sequence: string | null; issues: string[]; validation: 'structural_only'; signature_verified: false; xsd_validated: false; authorization_verified: false };
export type SyncedXmlPage = { items: SyncedXmlItem[]; limit: number; has_more: boolean; next_cursor: string | null; data_mode: 'fiscal_archive_readonly' };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
export const SYNCED_XML_BASE = '/v1/xmls-sincronizados';
export const MAX_SYNCED_XML_BYTES = 8 * 1024 * 1024;
const bad = (): never => { throw new Error('Não foi possível conferir a resposta dos XMLs. Atualize a consulta.'); };
export function syncedXmlParams(filters: SyncedXmlFilters, after: string | null = null, limit = 25) {
  if (typeof filters.q !== 'string' || filters.q.length > 64 || /[\x00-\x1f\x7f]/.test(filters.q) || !['', '55', '65'].includes(filters.model)
    || !['', 'invoice', 'event'].includes(filters.kind) || typeof filters.include_history !== 'boolean' || (after !== null && !UUID.test(after))
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Confira os filtros da consulta.');
  const params = new URLSearchParams({ limit: String(limit), include_history: String(filters.include_history) });
  if (filters.q.trim()) params.set('q', filters.q.trim()); if (filters.model) params.set('model', filters.model); if (filters.kind) params.set('kind', filters.kind); if (after) params.set('after', after);
  return params;
}
function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return bad(); return value;
}
function digits(value: unknown, max: number): string | null { if (value === null) return null; if (typeof value !== 'string' || !(new RegExp(`^\\d{1,${max}}$`)).test(value)) return bad(); return value; }
export function syncedXmlPage(value: unknown, filters: SyncedXmlFilters, after: string | null = null, limit = 25): SyncedXmlPage {
  syncedXmlParams(filters, after, limit); const page = value as SyncedXmlPage;
  if (!page || page.data_mode !== 'fiscal_archive_readonly' || page.limit !== limit || !Array.isArray(page.items) || page.items.length > limit
    || typeof page.has_more !== 'boolean' || (page.has_more && page.items.length !== limit)) return bad();
  let previous = after;
  const items = page.items.map(row => {
    if (!row || !UUID.test(row.id) || (previous && row.id <= previous) || !['nfe', 'nfce'].includes(row.entity)
      || !/^\d{44}$/.test(row.key) || !['55', '65'].includes(row.model) || row.entity !== (row.model === '55' ? 'nfe' : 'nfce') || row.key.slice(20, 22) !== row.model || !['1', '2'].includes(row.environment)
      || !['invoice', 'event'].includes(row.kind) || !Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647
      || !SHA.test(row.xml_hash) || !Number.isInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > MAX_SYNCED_XML_BYTES
      || typeof row.protocol_present !== 'boolean' || typeof row.signature_present !== 'boolean'
      || row.validation !== 'structural_only' || row.signature_verified !== false || row.xsd_validated !== false || row.authorization_verified !== false
      || !Array.isArray(row.issues) || row.issues.length > 30 || row.issues.some(code => typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(code))
      || (filters.model && row.model !== filters.model) || (filters.kind && row.kind !== filters.kind) || (filters.q.trim() && !row.key.includes(filters.q.trim()))) return bad();
    previous = row.id; const collected = text(row.collected_at, 64)!;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(collected) || !Number.isFinite(Date.parse(collected))) return bad();
    const protocol = digits(row.protocol, 20), eventType = digits(row.event_type, 6), sequence = digits(row.event_sequence, 6);
    if (row.protocol_present !== (protocol !== null) || (row.kind === 'invoice' && (eventType !== null || sequence !== null))) return bad();
    return { id: row.id, source_id: text(row.source_id, 200)!, entity: row.entity, key: row.key, model: row.model, environment: row.environment, kind: row.kind,
      revision: row.revision, source_status: text(row.source_status, 100, true), collected_at: collected, xml_hash: row.xml_hash, size_bytes: row.size_bytes,
      protocol, protocol_present: row.protocol_present, signature_present: row.signature_present, event_type: eventType, event_sequence: sequence,
      issues: [...new Set(row.issues)], validation: 'structural_only' as const, signature_verified: false as const, xsd_validated: false as const, authorization_verified: false as const };
  });
  const next = page.has_more ? items.at(-1)!.id : null; if (page.next_cursor !== next) return bad();
  return { items, limit, has_more: page.has_more, next_cursor: next, data_mode: 'fiscal_archive_readonly' };
}
export function syncedXmlFilename(item: Pick<SyncedXmlItem, 'model' | 'xml_hash'>) {
  if (!['55', '65'].includes(item.model) || !SHA.test(item.xml_hash)) return bad(); return `origin-${item.model}-${item.xml_hash.slice(0, 12)}.xml`;
}
/** A browser download is created only after the entire authenticated object matches its immutable list metadata. */
export async function verifySyncedXmlBlob(blob: Blob, item: Pick<SyncedXmlItem, 'size_bytes' | 'xml_hash'>, signal?: AbortSignal): Promise<Blob> {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }; checkAbort();
  if (!(blob instanceof Blob) || !Number.isInteger(item.size_bytes) || item.size_bytes < 1 || item.size_bytes > MAX_SYNCED_XML_BYTES || blob.size !== item.size_bytes || !SHA.test(item.xml_hash)) return bad();
  const bytes = await blob.arrayBuffer(); checkAbort();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''); checkAbort();
  if (hash !== item.xml_hash) return bad(); return blob;
}
