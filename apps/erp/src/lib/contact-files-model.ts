// 202610200170: Foto e Anexos of Clientes e fornecedores (`/v1/anexos-cadastros/contatos/{contato}`), same private storage
// and proxy of the document attachments. Bytes are checked by size and SHA-256 before an upload and after a download.
export type ContactFilePurpose = 'attachment' | 'photo';
export type ContactFile = { id: string; contact_id: string; purpose: ContactFilePurpose; filename: string; mime_type: string; size_bytes: number; sha256: string;
  status: 'reserved' | 'ready' | 'aborted'; created_at: string; finished_at: string | null; deleted: boolean; owner_name: string | null };
export type ContactFilesPage = { contact_id: string; items: ContactFile[]; photo: ContactFile | null; pending_photos: ContactFile[] };
export const CONTACT_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, SHA = /^[a-f0-9]{64}$/;
const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/plain'];
function fail(): never { throw new Error('CONTACT_FILES_INVALID'); }

// 202610200272: the same Foto for a Funcionário (`/v1/anexos-cadastros/funcionarios/{funcionário}`, administrator only).
export type FileOwner = 'contact' | 'employee';
export const ownerFilesPath = (owner: FileOwner, ownerId: string, id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') =>
  `/v1/anexos-cadastros/${owner === 'employee' ? 'funcionarios' : 'contatos'}/${ownerId}${id ? `/${id}/${action}` : ''}`;
export const contactFilesPath = (contactId: string, id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') => ownerFilesPath('contact', contactId, id, action);

export function readContactFile(value: unknown, contactId: string, owner: FileOwner = 'contact'): ContactFile {
  const source = value as Record<string, unknown> | null;
  // A foto of a funcionário carries employee_id (and is always a foto): read in the same shape, owned by that id.
  const row = (owner === 'employee' ? source && typeof source === 'object' && source.employee_id === contactId && source.purpose === 'photo' ? { ...source, contact_id: contactId } : null : source) as ContactFile | null;
  if (!row || !UUID.test(row.id) || row.contact_id !== contactId || !['attachment', 'photo'].includes(row.purpose) || !MIMES.includes(row.mime_type)
    || !Number.isInteger(row.size_bytes) || row.size_bytes < 1 || !SHA.test(row.sha256) || !['reserved', 'ready', 'aborted'].includes(row.status)
    || typeof row.filename !== 'string' || typeof row.created_at !== 'string' || typeof row.deleted !== 'boolean'
    || (row.owner_name !== null && typeof row.owner_name !== 'string')) fail();
  return { ...row };
}
export function readContactFiles(value: unknown, contactId: string, owner: FileOwner = 'contact'): ContactFilesPage {
  const page = value as (Partial<ContactFilesPage> & { employee_id?: unknown }) | null;
  if (!page || (owner === 'employee' ? page.employee_id : page.contact_id) !== contactId || !Array.isArray(page.items) || page.items.length > (owner === 'employee' ? 0 : 100) || !Array.isArray(page.pending_photos)) fail();
  const items = page.items.map(item => readContactFile(item, contactId, owner)), photo = page.photo ? readContactFile(page.photo, contactId, owner) : null;
  if (items.some(item => item.purpose !== 'attachment' || item.deleted) || (photo && (photo.purpose !== 'photo' || photo.status !== 'ready'))) fail();
  return { contact_id: contactId, items, photo, pending_photos: page.pending_photos.map(item => readContactFile(item, contactId, owner)) };
}
/** Origin "Foto": PNG or JPEG up to 2 MB. */
export function photoFileType(file: Pick<File, 'name' | 'size'>): string {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : '';
  if (!mime) throw new Error('Use uma imagem PNG ou JPEG.');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > CONTACT_PHOTO_MAX_BYTES) throw new Error('Selecione uma imagem de até 2 MB, que não esteja vazia.');
  return mime;
}
/**
 * The foto as a data: URL for the preview. The ERP Content-Security-Policy allows images only from 'self' and data:, so a
 * blob: URL is never rendered; the bytes were already checked by size and SHA-256.
 */
export async function photoDataUrl(blob: Blob, mime: string): Promise<string> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') fail();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
/** Date of the file in America/Sao_Paulo. */
export const contactFileDay = (stamp: string) => { const date = new Date(stamp); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };
