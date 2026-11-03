/** 202610200193 (produtos lane, wave D): Imagens armazenadas of the product, through the private attachment storage and proxy.
 * /v1/anexos-cadastros/produtos/:product (GET list, POST reserve), /:product/ordem (POST order) and
 * /:product/:image/(upload|download|abort|exclusao). PNG or JPEG up to 2 MB, checked by size, SHA-256 and signature both ways.
 * Strict bodies before the database, closed shapes after it. */
import { attachmentFilename, attachmentHash, boundedAttachmentBytes, failAttachment, AttachmentError, MIME_EXT, validateAttachmentContent } from './attachment-content.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_IMAGE_TYPES = ['image/png', 'image/jpeg'];
export const PRODUCT_IMAGE_LIMIT = 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const badResponse = () => failAttachment(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
const stamp = value => typeof value === 'string' && value.length > 0 && value.length <= 64;

export function productImageRoute(path) {
  const match = /^\/v1\/anexos-cadastros\/produtos\/([a-fA-F0-9-]+)(?:\/(ordem)|\/([a-fA-F0-9-]+)\/(upload|download|abort|exclusao))?$/.exec(path);
  if (!match || !UUID.test(match[1]) || (match[3] && !UUID.test(match[3]))) return null;
  return { owner: 'product', productId: match[1].toLowerCase(), id: match[3]?.toLowerCase() || null, action: match[2] ? 'order' : match[4] === 'exclusao' ? 'delete' : match[4] || null };
}
export const productImageMethods = route => route?.action === 'upload' ? ['PUT'] : route?.action === 'download' ? ['GET'] : route?.action ? ['POST'] : ['GET', 'POST'];

function dto(value, route, internal = false) {
  if (!object(value) || !UUID.test(value.id || '') || value.product_id !== route.productId || (route.id && value.id !== route.id)
    || !PRODUCT_IMAGE_TYPES.includes(value.mime_type) || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > PRODUCT_IMAGE_MAX_BYTES
    || !SHA.test(value.sha256 || '') || !['reserved', 'ready', 'aborted'].includes(value.status) || typeof value.deleted !== 'boolean' || (value.deleted && value.status !== 'ready')
    || (value.position !== null && (!Number.isInteger(value.position) || value.position < 1 || value.position > PRODUCT_IMAGE_LIMIT)) || ((value.position !== null) !== (value.status === 'ready' && !value.deleted))
    || typeof value.filename !== 'string' || !(new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${MIME_EXT[value.mime_type]}$`)).test(value.filename)
    || !stamp(value.created_at) || (value.finished_at !== null && !stamp(value.finished_at))
    || (value.owner_name !== null && (typeof value.owner_name !== 'string' || value.owner_name.length > 120))) badResponse();
  if (internal && (value.bucket !== 'erp-attachments' || value.object_key !== `products/${route.productId}/${value.id}/${value.sha256}`)) badResponse();
  return Object.fromEntries(['id', 'product_id', 'filename', 'mime_type', 'size_bytes', 'sha256', 'status', 'position', 'created_at', 'finished_at', 'deleted', 'owner_name'].map(key => [key, value[key]]));
}
function listing(value, route) {
  if (!object(value) || value.data_mode !== 'erp_native' || value.product_id !== route.productId || !Array.isArray(value.items) || value.items.length > PRODUCT_IMAGE_LIMIT
    || !Array.isArray(value.pending) || value.pending.length > 60 || typeof value.stored_bytes !== 'string' || !/^(0|[1-9]\d{0,12})$/.test(value.stored_bytes) || value.limit !== PRODUCT_IMAGE_LIMIT
    || (value.replayed !== undefined && typeof value.replayed !== 'boolean')) badResponse();
  const items = value.items.map(item => dto(item, { ...route, id: null })), pending = value.pending.map(item => dto(item, { ...route, id: null }));
  if (items.some((item, index) => item.status !== 'ready' || item.deleted || item.position !== index + 1) || pending.some(item => item.status !== 'reserved')) badResponse();
  return { product_id: route.productId, items, pending, stored_bytes: value.stored_bytes, limit: PRODUCT_IMAGE_LIMIT, ...(value.replayed === undefined ? {} : { replayed: value.replayed }), data_mode: 'erp_native' };
}
function mutation(value, route, replay = false) {
  if (!object(value) || value.data_mode !== 'erp_native' || (replay && typeof value.replayed !== 'boolean')) badResponse();
  return { image: dto(value.image, route), ...(replay ? { replayed: value.replayed } : {}), data_mode: 'erp_native' };
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

/** The caller authenticates the JWT and passes only its verified UUID; SQL rechecks membership, the product and its situation. */
export async function executeProductImageRoute(request, route, { userId, rpc, storage }) {
  if (!route) failAttachment(404, 'ERP_NOT_FOUND');
  if (!productImageMethods(route).includes(request.method)) failAttachment(405, 'ERP_METHOD_NOT_ALLOWED');
  if (new URL(request.url).search || !UUID.test(userId || '') || (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity')) failAttachment();
  const call = (name, extra = {}) => rpc(name, { p_user_id: userId, p_product_id: route.productId, ...(route.id ? { p_id: route.id } : {}), ...extra });
  const internal = async write => { const value = await call('erp_catalog_product_image_object', { p_write: write }); if (value?.data_mode !== 'erp_native') badResponse(); dto(value, route, true); return value; };
  if (!route.action && request.method === 'GET') return { type: 'json', body: listing(await call('erp_catalog_product_images'), route) };
  if (!route.action) {
    const value = await jsonBody(request);
    if (!only(value, ['command_id', 'filename', 'mime_type', 'size_bytes', 'sha256']) || !UUID.test(value.command_id || '') || !SHA.test(value.sha256 || '')
      || !PRODUCT_IMAGE_TYPES.includes(value.mime_type) || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > PRODUCT_IMAGE_MAX_BYTES) failAttachment();
    const result = await call('erp_catalog_product_image_reserve', { p_command_id: value.command_id.toLowerCase(), p_filename: attachmentFilename(value.filename, value.mime_type),
      p_mime_type: value.mime_type, p_size_bytes: value.size_bytes, p_sha256: value.sha256 });
    const body = mutation(result, route, true);
    if (body.image.sha256 !== value.sha256) badResponse();
    return { type: 'json', body };
  }
  if (route.action === 'order') {
    const value = await jsonBody(request);
    if (!only(value, ['command_id', 'ids']) || !UUID.test(value.command_id || '') || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > PRODUCT_IMAGE_LIMIT
      || value.ids.some(id => !UUID.test(id)) || new Set(value.ids.map(id => id.toLowerCase())).size !== value.ids.length) failAttachment();
    const ids = value.ids.map(id => id.toLowerCase());
    const body = listing(await call('erp_catalog_product_image_order', { p_command_id: value.command_id.toLowerCase(), p_ids: ids }), route);
    if (typeof body.replayed !== 'boolean' || (!body.replayed && body.items.map(item => item.id).join() !== ids.join())) badResponse();
    return { type: 'json', body };
  }
  if (route.action === 'abort') {
    const value = await jsonBody(request); if (!only(value, []) || Object.keys(value).length) failAttachment();
    return { type: 'json', body: mutation(await call('erp_catalog_product_image_stop', { p_abort: true }), route) };
  }
  if (route.action === 'delete') {
    const value = await jsonBody(request); if (!only(value, ['command_id']) || !UUID.test(value.command_id || '')) failAttachment();
    const body = mutation(await call('erp_catalog_product_image_delete', { p_command_id: value.command_id.toLowerCase() }), route, true);
    if (!body.image.deleted) badResponse();
    return { type: 'json', body };
  }
  const meta = await internal(route.action === 'upload');
  if (route.action === 'download') {
    if (meta.status !== 'ready' || meta.deleted) badResponse();
    const bytes = await verifiedObject(meta, storage);
    validateAttachmentContent(bytes, meta.mime_type);
    await internal(false); // A revocation during the read still blocks the delivery.
    return { type: 'download', bytes, filename: meta.filename, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename="${meta.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } };
  }
  if (request.headers.get('Content-Type') !== meta.mime_type || !['reserved', 'ready'].includes(meta.status)) failAttachment(415, 'ERP_ATTACHMENT_TYPE_MISMATCH');
  const bytes = await boundedAttachmentBytes(request, meta.size_bytes, { max: PRODUCT_IMAGE_MAX_BYTES });
  if (await attachmentHash(bytes) !== meta.sha256) failAttachment(409, 'ERP_ATTACHMENT_INTEGRITY_FAILURE');
  validateAttachmentContent(bytes, meta.mime_type);
  const lease = crypto.randomUUID();
  const claimed = await call('erp_catalog_product_image_claim', { p_lease: lease });
  if (claimed?.data_mode !== 'erp_native') badResponse(); dto(claimed, route, true);
  if (claimed.sha256 !== meta.sha256 || claimed.size_bytes !== meta.size_bytes || claimed.object_key !== meta.object_key || claimed.mime_type !== meta.mime_type) badResponse();
  if (claimed.status === 'ready') return { type: 'json', body: { image: dto(claimed, route), replayed: true, data_mode: 'erp_native' } };
  if (claimed.status !== 'reserved') badResponse();
  try {
    // Never overwrite the immutable key: an ambiguous POST is recovered only by reading the object back and matching the hash.
    try { await storage.put(meta.object_key, bytes, meta.mime_type); } catch { /* Safe recovery below. */ }
    await verifiedObject(meta, storage);
    const body = mutation(await call('erp_catalog_product_image_finish', { p_lease: lease, p_sha256: meta.sha256, p_size_bytes: meta.size_bytes }), route, true);
    if (body.image.status !== 'ready') badResponse();
    return { type: 'json', body };
  } finally {
    try { await call('erp_catalog_product_image_stop', { p_abort: false, p_lease: lease }); } catch { /* A revoked access leaves only a bounded lease. */ }
  }
}
