import type { DocumentKind } from './real-documents-model';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export type AttachmentRecord = { id: string; document_id: string; filename: string; mime_type: string; size_bytes: number; sha256: string;
  status: 'reserved' | 'ready' | 'aborted'; created_at: string; finished_at: string | null;
  /** 202610200170: logical deletion and the name of who sent the file (absent before 170). */
  deleted?: boolean; owner_name?: string | null };
export type AttachmentPage = { items: AttachmentRecord[]; document_id: string; data_mode: 'erp_native' };
export type AttachmentEnvelope = { attachment: AttachmentRecord; replayed?: boolean; data_mode: 'erp_native' };
const extensions: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', xml: 'application/xml', txt: 'text/plain' };
/** Date of the file in America/Sao_Paulo. */
export const attachmentDay = (stamp: string) => { const date = new Date(stamp); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };
export const attachmentPath = (kind: DocumentKind, documentId: string, id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') => `/v1/documentos/${kind}/${documentId}/anexos${id ? `/${id}/${action}` : ''}`;
export function attachmentFileType(file: Pick<File, 'name' | 'size'>) {
  if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error('Selecione um arquivo de até 10 MiB, que não esteja vazio.');
  if (file.name.length > 255 || /[\x00-\x1f\x7f]/.test(file.name)) throw new Error('O nome do arquivo contém caracteres não permitidos.');
  const mime = extensions[file.name.split('.').at(-1)?.toLowerCase() || ''];
  if (!mime) throw new Error('Use um arquivo PDF, PNG, JPEG, XML ou TXT.');
  return mime;
}
export async function fileHash(file: Blob) {
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error('Tamanho de arquivo inválido.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
}
export function attachmentSize(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`; }
export function resumableFile(record: AttachmentRecord, size: number, sha: string, mime: string) { return record.status === 'reserved' && record.size_bytes === size && record.sha256 === sha && record.mime_type === mime; }
/** 202610200240 Origin "Miniatura": PNG and JPEG up to 2 MiB, the first 20 of the list, read once and checked like a download. */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024, THUMBNAIL_LIMIT = 20;
export const thumbnailRows = (rows: readonly AttachmentRecord[]) => rows.filter(row => row.status === 'ready' && (row.mime_type === 'image/png' || row.mime_type === 'image/jpeg') && row.size_bytes <= THUMBNAIL_MAX_BYTES).slice(0, THUMBNAIL_LIMIT);
/** Format shown in the Miniatura column of the files without a preview. */
export const attachmentFormat = (mime: string) => ({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'application/xml': 'XML', 'text/xml': 'XML', 'text/plain': 'TXT' } as Record<string, string>)[mime] ?? 'Arquivo';
/** A data: URL (the ERP Content-Security-Policy allows img-src 'self' data: only); the bytes were already checked by size and SHA-256. */
export async function thumbnailDataUrl(blob: Blob, mime: string): Promise<string> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') throw new Error('THUMBNAIL_TYPE');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
