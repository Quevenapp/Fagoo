// 202610200262: Empresa › Dados da empresa › Sua marca (`/v1/anexos-empresa/logo`), the logo of the company in the private
// attachment storage. Bytes are checked by size and SHA-256 before an upload and after a download; the image is shown as a
// data: URL (the ERP Content-Security-Policy allows img-src 'self' data: only).
// Self-contained (no imports), so the model also runs under Node in the tests.

export type CompanyLogoMime = 'image/png' | 'image/jpeg';
export type CompanyLogo = { id: string; mime_type: CompanyLogoMime; size_bytes: number; sha256: string; status: 'reserved' | 'ready' | 'aborted';
  created_at: string; finished_at: string | null; deleted: boolean; owner_name: string | null };
export type CompanyLogoPage = { scope: 'company_logo'; can_manage: boolean; logo: CompanyLogo | null; pending: CompanyLogo[]; data_mode: 'erp_native' };
export const COMPANY_LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const COMPANY_LOGO_PATH = '/v1/anexos-empresa/logo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, SHA = /^[a-f0-9]{64}$/;
type Requester = (path: string, options?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; contentType?: string; download?: boolean; signal?: AbortSignal }) => Promise<unknown>;
function fail(): never { throw new Error('COMPANY_LOGO_INVALID'); }

export const companyLogoPath = (id?: string, action?: 'upload' | 'download' | 'abort' | 'exclusao') => `${COMPANY_LOGO_PATH}${id ? `/${id}/${action}` : ''}`;
export function readCompanyLogo(value: unknown): CompanyLogo {
  const row = value as CompanyLogo | null;
  if (!row || typeof row !== 'object' || !UUID.test(row.id) || !['image/png', 'image/jpeg'].includes(row.mime_type) || !Number.isInteger(row.size_bytes) || row.size_bytes < 1
    || row.size_bytes > COMPANY_LOGO_MAX_BYTES || !SHA.test(row.sha256) || !['reserved', 'ready', 'aborted'].includes(row.status) || typeof row.created_at !== 'string'
    || (row.finished_at !== null && typeof row.finished_at !== 'string') || typeof row.deleted !== 'boolean' || (row.owner_name !== null && typeof row.owner_name !== 'string')) fail();
  return { id: row.id, mime_type: row.mime_type, size_bytes: row.size_bytes, sha256: row.sha256, status: row.status, created_at: row.created_at, finished_at: row.finished_at, deleted: row.deleted, owner_name: row.owner_name };
}
export function readCompanyLogoPage(value: unknown): CompanyLogoPage {
  const page = value as Partial<CompanyLogoPage> | null;
  if (!page || page.scope !== 'company_logo' || page.data_mode !== 'erp_native' || typeof page.can_manage !== 'boolean' || !Array.isArray(page.pending) || page.pending.length > 20) fail();
  const logo = page.logo === null ? null : readCompanyLogo(page.logo), pending = page.pending.map(readCompanyLogo);
  if ((logo && (logo.status !== 'ready' || logo.deleted)) || pending.some(item => item.status !== 'reserved') || (!page.can_manage && pending.length)) fail();
  return { scope: 'company_logo', can_manage: page.can_manage, logo, pending, data_mode: 'erp_native' };
}
/** Origin "Logo": PNG or JPEG up to 2 MB. */
export function logoFileType(file: Pick<File, 'name' | 'size'>): CompanyLogoMime {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : null;
  if (!mime) throw new Error('Use uma imagem PNG ou JPEG.');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > COMPANY_LOGO_MAX_BYTES) throw new Error('Selecione uma imagem de até 2 MB, que não esteja vazia.');
  return mime;
}
/** SHA-256 of the bytes, hex. */
export async function logoHash(file: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** The logo as a data: URL (img-src 'self' data: only; a blob: URL would never render). */
export async function logoDataUrl(blob: Blob, mime: CompanyLogoMime): Promise<string> {
  if (mime !== 'image/png' && mime !== 'image/jpeg') fail();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}
/** The bytes of a ready logo, checked by size and SHA-256. */
export async function verifiedLogo(request: Requester, logo: CompanyLogo, signal: AbortSignal): Promise<Blob> {
  const blob = await request(companyLogoPath(logo.id, 'download'), { download: true, signal }) as Blob;
  if (!(blob instanceof Blob) || blob.size !== logo.size_bytes || await logoHash(blob) !== logo.sha256) fail();
  return blob;
}
/** The current logo as a data: URL, or null when the company has none. */
export async function companyLogoImage(request: Requester, signal: AbortSignal): Promise<{ logo: CompanyLogo; url: string } | null> {
  const page = readCompanyLogoPage(await request(COMPANY_LOGO_PATH, { signal }));
  if (!page.logo) return null;
  const blob = await verifiedLogo(request, page.logo, signal);
  return { logo: page.logo, url: await logoDataUrl(blob, page.logo.mime_type) };
}
