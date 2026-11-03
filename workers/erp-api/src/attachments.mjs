import { AttachmentError, attachmentFilename, attachmentHash, boundedAttachmentBytes, failAttachment, MAX_ATTACHMENT_BYTES, MIME_EXT, validateAttachmentContent } from './attachment-content.mjs';
export { AttachmentError } from './attachment-content.mjs';
export { createAttachmentStorage, ATTACHMENT_BUCKET_CONFIG } from './attachment-storage.mjs';
import { contactFileMethods, contactFileRoute, executeContactFileRoute } from './contact-files.mjs';
// 202610200193 (produtos lane): Imagens armazenadas of the product, same proxy and private storage.
import { executeProductImageRoute, productImageMethods, productImageRoute } from './product-images.mjs';
// 202610200211: Anexos of contas and lançamentos of the financeiro (finance lane).
import { financeFileMethods, financeFileRoute, executeFinanceFileRoute } from './finance-files.mjs';
// 202610200262: the logo of the company (Empresa › Sua marca, preferências lane).
import { companyLogoMethods, companyLogoRoute, executeCompanyLogoRoute } from './company-logo.mjs';
// 202610200272: the Foto of the Funcionário (documentos lane).
import { employeeFileMethods, employeeFileRoute, executeEmployeeFileRoute } from './employee-files.mjs';
// 202610200301: the company files of the Gerenciador de arquivos (Inserir Arquivo, mixed lane).
import { companyFileMethods, companyFileRoute, executeCompanyFileRoute } from './company-files.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const badResponse = () => failAttachment(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
export function attachmentRoute(path) {
  // 202610200170: Foto e Anexos of Clientes e fornecedores share this proxy and the private storage.
  const contact = contactFileRoute(path); if (contact) return contact;
  const product = productImageRoute(path); if (product) return product;
  const finance = financeFileRoute(path); if (finance) return finance;
  const logo = companyLogoRoute(path); if (logo) return logo;
  const companyFile = companyFileRoute(path); if (companyFile) return companyFile;
  const employee = employeeFileRoute(path); if (employee) return employee;
  const match = /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/([a-fA-F0-9-]+)\/anexos(?:\/([a-fA-F0-9-]+)\/(upload|download|abort|exclusao))?$/.exec(path);
  if (!match || !UUID.test(match[2]) || (match[3] && !UUID.test(match[3]))) return null;
  // 202610200170: "exclusao" is the audited logical deletion ("Excluir selecionados").
  return { kind: match[1], documentId: match[2].toLowerCase(), id: match[3]?.toLowerCase() || null, action: match[4] === 'exclusao' ? 'delete' : match[4] || null };
}
export const attachmentMethods = route => route?.owner === 'company_file' ? companyFileMethods(route) : route?.owner === 'employee' ? employeeFileMethods(route) : route?.owner === 'contact' ? contactFileMethods(route) : route?.owner === 'product' ? productImageMethods(route) : route?.owner === 'finance' ? financeFileMethods(route) : route?.owner === 'company' ? companyLogoMethods(route) : route?.action === 'upload' ? ['PUT'] : route?.action === 'abort' || route?.action === 'delete' ? ['POST'] : route?.action === 'download' ? ['GET'] : ['GET', 'POST'];
function dto(value, route, internal = false) {
  if (!object(value) || !UUID.test(value.id || '') || value.document_id !== route.documentId || (route.id && value.id !== route.id)
    || !Object.hasOwn(MIME_EXT, value.mime_type) || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_ATTACHMENT_BYTES
    || !SHA.test(value.sha256 || '') || !['reserved', 'ready', 'aborted'].includes(value.status)
    || typeof value.filename !== 'string' || !(new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${MIME_EXT[value.mime_type]}$`)).test(value.filename)
    || typeof value.created_at !== 'string' || value.created_at.length > 64 || (value.finished_at !== null && (typeof value.finished_at !== 'string' || value.finished_at.length > 64))
    // 202610200170: deleted and the name of the owner (absent before 170).
    || (value.deleted !== undefined && (typeof value.deleted !== 'boolean' || (value.deleted && value.status !== 'ready')))
    || (value.owner_name !== undefined && value.owner_name !== null && (typeof value.owner_name !== 'string' || value.owner_name.length > 120))) badResponse();
  if (internal && (value.bucket !== 'erp-attachments' || value.object_key !== `documents/${route.documentId}/${value.id}/${value.sha256}`)) badResponse();
  return Object.fromEntries(['id', 'document_id', 'filename', 'mime_type', 'size_bytes', 'sha256', 'status', 'created_at', 'finished_at', 'deleted', 'owner_name'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
function mutation(value, route, replay = false) {
  if (!object(value) || value.data_mode !== 'erp_native' || (replay && typeof value.replayed !== 'boolean')) badResponse();
  return { attachment: dto(value.attachment, route), ...(replay ? { replayed: value.replayed } : {}), data_mode: 'erp_native' };
}
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) failAttachment();
  // Metadata is small and bounded even without Content-Length.
  if (!request.body) failAttachment();
  const reader = request.body.getReader(), chunks = []; let size = 0, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new AttachmentError(408, 'ERP_ATTACHMENT_TIMEOUT')), 10000); });
  try {
    while (true) { const { done, value } = await Promise.race([reader.read(), deadline]); if (done) break; size += value.byteLength; if (size > 8192) failAttachment(); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(value)) failAttachment(); return value;
  } catch (error) { if (error instanceof AttachmentError) throw error; failAttachment(); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function verifiedObject(meta, storage) {
  const response = await storage.get(meta.object_key);
  if (!response.ok || response.redirected || response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); failAttachment(503, 'ERP_ATTACHMENT_STORAGE_UNAVAILABLE'); }
  const bytes = await boundedAttachmentBytes(response, meta.size_bytes, { status: 502 });
  if (await attachmentHash(bytes) !== meta.sha256) failAttachment(502, 'ERP_ATTACHMENT_INTEGRITY_FAILURE');
  return bytes;
}
/** The caller authenticates JWT via /auth/v1/user and passes only its verified UUID. SQL rechecks active membership every time. */
export async function executeAttachmentRoute(request, route, { userId, rpc, storage }) {
  if (route?.owner === 'contact') return executeContactFileRoute(request, route, { userId, rpc, storage });
  if (route?.owner === 'product') return executeProductImageRoute(request, route, { userId, rpc, storage });
  if (route?.owner === 'finance') return executeFinanceFileRoute(request, route, { userId, rpc, storage });
  if (route?.owner === 'company') return executeCompanyLogoRoute(request, route, { userId, rpc, storage });
  if (route?.owner === 'company_file') return executeCompanyFileRoute(request, route, { userId, rpc, storage });
  if (route?.owner === 'employee') return executeEmployeeFileRoute(request, route, { userId, rpc, storage });
  if (!route) failAttachment(404, 'ERP_NOT_FOUND');
  if (!attachmentMethods(route).includes(request.method)) failAttachment(405, 'ERP_METHOD_NOT_ALLOWED');
  if (new URL(request.url).search || !UUID.test(userId || '') || (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity')) failAttachment();
  const args = { p_user_id: userId, p_kind: route.kind, p_document_id: route.documentId, ...(route.id ? { p_id: route.id } : {}) };
  const call = (name, extra = {}) => rpc(name, { ...args, ...extra });
  const internal = async write => {
    const value = await call('erp_attachment_object', { p_write: write });
    if (value?.data_mode !== 'erp_native') badResponse(); dto(value, route, true); return value;
  };
  if (!route.action && request.method === 'GET') {
    const value = await call('erp_attachment_list');
    if (value?.data_mode !== 'erp_native' || value.document_id !== route.documentId || !Array.isArray(value.items) || value.items.length > 100) badResponse();
    return { type: 'json', body: { items: value.items.map(item => dto(item, route)), document_id: route.documentId, data_mode: 'erp_native' } };
  }
  if (!route.action) {
    const value = await jsonBody(request);
    if (!only(value, ['command_id', 'filename', 'mime_type', 'size_bytes', 'sha256']) || !UUID.test(value.command_id || '') || !SHA.test(value.sha256 || '')
      || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_ATTACHMENT_BYTES) failAttachment();
    const result = await call('erp_attachment_reserve', { p_command_id: value.command_id.toLowerCase(), p_filename: attachmentFilename(value.filename, value.mime_type),
      p_mime_type: value.mime_type, p_size_bytes: value.size_bytes, p_sha256: value.sha256 });
    return { type: 'json', body: mutation(result, route, true) };
  }
  if (route.action === 'abort') {
    const value = await jsonBody(request); if (!only(value, []) || Object.keys(value).length) failAttachment();
    return { type: 'json', body: mutation(await call('erp_attachment_stop', { p_abort: true }), route) };
  }
  if (route.action === 'delete') {
    const value = await jsonBody(request); if (!only(value, ['command_id']) || !UUID.test(value.command_id || '')) failAttachment();
    const body = mutation(await call('erp_attachment_delete', { p_command_id: value.command_id.toLowerCase() }), route, true);
    if (body.attachment.deleted !== true) badResponse();
    return { type: 'json', body };
  }
  const meta = await internal(route.action === 'upload');
  if (route.action === 'download') {
    if (meta.status !== 'ready') badResponse();
    const bytes = await verifiedObject(meta, storage);
    await internal(false); // Revocation during object retrieval must still block delivery.
    return { type: 'download', bytes, filename: meta.filename, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${meta.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } };
  }
  if (request.headers.get('Content-Type') !== meta.mime_type || !['reserved', 'ready'].includes(meta.status)) failAttachment(415, 'ERP_ATTACHMENT_TYPE_MISMATCH');
  const bytes = await boundedAttachmentBytes(request, meta.size_bytes);
  if (await attachmentHash(bytes) !== meta.sha256) failAttachment(409, 'ERP_ATTACHMENT_INTEGRITY_FAILURE');
  validateAttachmentContent(bytes, meta.mime_type);
  const lease = crypto.randomUUID();
  const claimed = await call('erp_attachment_claim', { p_lease: lease });
  if (claimed?.data_mode !== 'erp_native') badResponse(); dto(claimed, route, true);
  if (claimed.sha256 !== meta.sha256 || claimed.size_bytes !== meta.size_bytes || claimed.object_key !== meta.object_key || claimed.mime_type !== meta.mime_type) badResponse();
  if (claimed.status === 'ready') return { type: 'json', body: { attachment: dto(claimed, route), replayed: true, data_mode: 'erp_native' } };
  if (claimed.status !== 'reserved') badResponse();
  try {
    // A failed/ambiguous POST may already have stored this immutable key. Never
    // overwrite: recover only by reading the complete object and matching hash.
    try { await storage.put(meta.object_key, bytes, meta.mime_type); } catch { /* Safe recovery below; no upstream error/body is logged. */ }
    await verifiedObject(meta, storage);
    const result = await call('erp_attachment_finish', { p_lease: lease, p_sha256: meta.sha256, p_size_bytes: meta.size_bytes });
    const body = mutation(result, route, true); if (body.attachment.status !== 'ready') badResponse();
    return { type: 'json', body };
  } finally {
    try { await call('erp_attachment_stop', { p_abort: false, p_lease: lease }); } catch { /* Revoked access leaves only a bounded lease to expire. */ }
  }
}
