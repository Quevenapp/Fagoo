/** 202610200211: Anexos of contas a receber/pagar and of the lançamentos of Caixas e bancos, through the private attachment
 * storage and proxy. /v1/anexos-financeiro/(contas|lancamentos)/:owner (GET list, POST reserve) and /:file/(upload|download|abort|exclusao).
 * Strict bodies before the database, closed shapes after it, bytes checked by size and SHA-256 both ways. */
import { attachmentFilename, attachmentHash, boundedAttachmentBytes, failAttachment, AttachmentError, MAX_ATTACHMENT_BYTES, MIME_EXT, validateAttachmentContent } from './attachment-content.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const OWNERS = Object.freeze({ contas: 'title', lancamentos: 'cash_entry' });
export const FINANCE_FILE_LIMIT = 100;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const badResponse = () => failAttachment(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
const stamp = value => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function financeFileRoute(path) {
  const match = /^\/v1\/anexos-financeiro\/(contas|lancamentos)\/([a-fA-F0-9-]+)(?:\/([a-fA-F0-9-]+)\/(upload|download|abort|exclusao))?$/.exec(path);
  if (!match || !UUID.test(match[2]) || (match[3] && !UUID.test(match[3]))) return null;
  return { owner: 'finance', ownerKind: OWNERS[match[1]], ownerId: match[2].toLowerCase(), id: match[3]?.toLowerCase() || null, action: match[4] === 'exclusao' ? 'delete' : match[4] || null };
}
export const financeFileMethods = route => route?.action === 'upload' ? ['PUT'] : route?.action === 'download' ? ['GET'] : route?.action ? ['POST'] : ['GET', 'POST'];

function dto(value, route, internal = false) {
  if (!object(value) || !UUID.test(value.id || '') || value.owner_kind !== route.ownerKind || value.owner_id !== route.ownerId || (route.id && value.id !== route.id)
    || !Object.hasOwn(MIME_EXT, value.mime_type) || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_ATTACHMENT_BYTES
    || !SHA.test(value.sha256 || '') || !['reserved', 'ready', 'aborted'].includes(value.status) || typeof value.deleted !== 'boolean' || (value.deleted && value.status !== 'ready')
    || typeof value.filename !== 'string' || !(new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${MIME_EXT[value.mime_type]}$`)).test(value.filename)
    || !stamp(value.created_at) || (value.finished_at !== null && !stamp(value.finished_at))
    || (value.owner_name !== null && (typeof value.owner_name !== 'string' || value.owner_name.length > 120))) badResponse();
  if (internal && (value.bucket !== 'erp-attachments' || value.object_key !== `finance/${route.ownerId}/${value.id}/${value.sha256}`)) badResponse();
  return Object.fromEntries(['id', 'owner_kind', 'owner_id', 'filename', 'mime_type', 'size_bytes', 'sha256', 'status', 'created_at', 'finished_at', 'deleted', 'owner_name'].map(key => [key, value[key]]));
}
function mutation(value, route, replay = false) {
  if (!object(value) || value.data_mode !== 'erp_native' || (replay && typeof value.replayed !== 'boolean')) badResponse();
  return { attachment: dto(value.attachment, route), ...(replay ? { replayed: value.replayed } : {}), data_mode: 'erp_native' };
}
async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) failAttachment();
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

/** The caller authenticates the JWT and passes only its verified UUID; SQL rechecks the finance role and the owner. */
export async function executeFinanceFileRoute(request, route, { userId, rpc, storage }) {
  if (!route) failAttachment(404, 'ERP_NOT_FOUND');
  if (!financeFileMethods(route).includes(request.method)) failAttachment(405, 'ERP_METHOD_NOT_ALLOWED');
  if (new URL(request.url).search || !UUID.test(userId || '') || (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity')) failAttachment();
  const call = (name, extra = {}) => rpc(name, { p_user_id: userId, p_owner_kind: route.ownerKind, p_owner_id: route.ownerId, ...(route.id ? { p_id: route.id } : {}), ...extra });
  const internal = async write => { const value = await call('erp_finance_file_object', { p_write: write }); if (value?.data_mode !== 'erp_native') badResponse(); dto(value, route, true); return value; };
  if (!route.action && request.method === 'GET') {
    const value = await call('erp_finance_file_list');
    if (!object(value) || value.data_mode !== 'erp_native' || value.owner_kind !== route.ownerKind || value.owner_id !== route.ownerId || !Array.isArray(value.items) || value.items.length > FINANCE_FILE_LIMIT) badResponse();
    const items = value.items.map(item => dto(item, route));
    if (items.some(item => item.deleted) || new Set(items.map(item => item.id)).size !== items.length) badResponse();
    return { type: 'json', body: { owner_kind: route.ownerKind, owner_id: route.ownerId, items, data_mode: 'erp_native' } };
  }
  if (!route.action) {
    const value = await jsonBody(request);
    if (!only(value, ['command_id', 'filename', 'mime_type', 'size_bytes', 'sha256']) || !UUID.test(value.command_id || '') || !SHA.test(value.sha256 || '')
      || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_ATTACHMENT_BYTES) failAttachment();
    const result = await call('erp_finance_file_reserve', { p_command_id: value.command_id.toLowerCase(), p_filename: attachmentFilename(value.filename, value.mime_type),
      p_mime_type: value.mime_type, p_size_bytes: value.size_bytes, p_sha256: value.sha256 });
    const body = mutation(result, route, true);
    if (body.attachment.sha256 !== value.sha256 || body.attachment.size_bytes !== value.size_bytes || body.attachment.mime_type !== value.mime_type) badResponse();
    return { type: 'json', body };
  }
  if (route.action === 'abort') {
    const value = await jsonBody(request); if (!only(value, []) || Object.keys(value).length) failAttachment();
    return { type: 'json', body: mutation(await call('erp_finance_file_stop', { p_abort: true }), route) };
  }
  if (route.action === 'delete') {
    const value = await jsonBody(request); if (!only(value, ['command_id']) || !UUID.test(value.command_id || '')) failAttachment();
    const body = mutation(await call('erp_finance_file_delete', { p_command_id: value.command_id.toLowerCase() }), route, true);
    if (!body.attachment.deleted) badResponse();
    return { type: 'json', body };
  }
  const meta = await internal(route.action === 'upload');
  if (route.action === 'download') {
    if (meta.status !== 'ready' || meta.deleted) badResponse();
    const bytes = await verifiedObject(meta, storage);
    await internal(false); // A revocation during the read still blocks the delivery.
    return { type: 'download', bytes, filename: meta.filename, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${meta.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } };
  }
  if (request.headers.get('Content-Type') !== meta.mime_type || !['reserved', 'ready'].includes(meta.status)) failAttachment(415, 'ERP_ATTACHMENT_TYPE_MISMATCH');
  const bytes = await boundedAttachmentBytes(request, meta.size_bytes);
  if (await attachmentHash(bytes) !== meta.sha256) failAttachment(409, 'ERP_ATTACHMENT_INTEGRITY_FAILURE');
  validateAttachmentContent(bytes, meta.mime_type);
  const lease = crypto.randomUUID();
  const claimed = await call('erp_finance_file_claim', { p_lease: lease });
  if (claimed?.data_mode !== 'erp_native') badResponse(); dto(claimed, route, true);
  if (claimed.sha256 !== meta.sha256 || claimed.size_bytes !== meta.size_bytes || claimed.object_key !== meta.object_key || claimed.mime_type !== meta.mime_type) badResponse();
  if (claimed.status === 'ready') return { type: 'json', body: { attachment: dto(claimed, route), replayed: true, data_mode: 'erp_native' } };
  if (claimed.status !== 'reserved') badResponse();
  try {
    // Never overwrite the immutable key: an ambiguous POST is recovered only by reading the object back and matching the hash.
    try { await storage.put(meta.object_key, bytes, meta.mime_type); } catch { /* Safe recovery below. */ }
    await verifiedObject(meta, storage);
    const body = mutation(await call('erp_finance_file_finish', { p_lease: lease, p_sha256: meta.sha256, p_size_bytes: meta.size_bytes }), route, true);
    if (body.attachment.status !== 'ready') badResponse();
    return { type: 'json', body };
  } finally {
    try { await call('erp_finance_file_stop', { p_abort: false, p_lease: lease }); } catch { /* A revoked access leaves only a bounded lease. */ }
  }
}
