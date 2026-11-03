import { isConfiguredBackendOrigin } from '../../../packages/backend-config/src/origin.mjs';
import { failAttachment } from './attachment-content.mjs';
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
// documents/<document>/<id>/<sha>, since 202610200170 contacts/<contact>/<id>/<sha>, since 202610200193 products/<product>/<id>/<sha>
// since 202610200211 finance/<conta|lançamento>/<id>/<sha>, since 202610200262 company/logo/<id>/<sha> and since 202610200272
// employees/<funcionário>/<id>/<sha>; since 202610200301 company/files/<id>/<sha> (Inserir Arquivo of the Gerenciador de arquivos).
const KEY = new RegExp(`^(?:(?:documents|contacts|products|finance|employees)/${UUID}|company/logo|company/files)/${UUID}/[a-f0-9]{64}$`);
export const ATTACHMENT_BUCKET_CONFIG = Object.freeze({ id: 'erp-attachments', name: 'erp-attachments', public: false, file_size_limit: 10485760,
  allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg', 'application/xml', 'text/plain'] });
/** Server-only adapter. No URL, header or credential comes from attachment requests. */
export function createAttachmentStorage({ baseUrl, supabaseDeployment, key, fetchImpl = fetch, timeoutMs = 20000 }) {
  let base; try { base = new URL(baseUrl); } catch { failAttachment(503, 'ERP_ATTACHMENT_STORAGE_CONFIG'); }
  if (!isConfiguredBackendOrigin(baseUrl, supabaseDeployment, { allowTrailingSlash: true })
    || typeof key !== 'string' || key.length < 10 || key.length > 8192 || /\s/.test(key)) failAttachment(503, 'ERP_ATTACHMENT_STORAGE_CONFIG');
  async function request(objectKey, method, bytes, mime) {
    if (!KEY.test(objectKey)) failAttachment(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base.origin}/storage/v1/object/${method === 'GET' ? 'authenticated/' : ''}erp-attachments/${objectKey}`, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { apikey: key, Authorization: `Bearer ${key}`, ...(method === 'POST' ? { 'Content-Type': mime, 'x-upsert': 'false', 'Cache-Control': 'no-store' } : { Accept: 'application/octet-stream', 'Cache-Control': 'no-cache' }) },
        ...(method === 'POST' ? { body: bytes } : {}),
      });
      if (response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); failAttachment(502, 'ERP_ATTACHMENT_STORAGE_UNAVAILABLE'); }
      return response;
    } catch { failAttachment(503, 'ERP_ATTACHMENT_STORAGE_UNAVAILABLE'); }
    finally { clearTimeout(timeout); }
  }
  return Object.freeze({
    get: objectKey => request(objectKey, 'GET'),
    put: async (objectKey, bytes, mime) => {
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 10485760 || !ATTACHMENT_BUCKET_CONFIG.allowed_mime_types.includes(mime)) failAttachment();
      const response = await request(objectKey, 'POST', bytes, mime);
      const ok = response.ok; void response.body?.cancel().catch(() => {}); return ok;
    },
  });
}
