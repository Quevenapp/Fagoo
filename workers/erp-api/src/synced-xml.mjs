/** Authenticated read-only projection of complete Origin XML revisions. */
const BASE = '/v1/xmls-sincronizados';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MAX_XML = 8 * 1024 * 1024;
const MODE = 'fiscal_archive_readonly';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class SyncedXmlError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const fail = (status = 400, code = 'ERP_INVALID_QUERY') => { throw new SyncedXmlError(status, code); };
const invalid = () => fail(502, 'ERP_UPSTREAM_INVALID_RESPONSE');
export const syncedXmlMethods = path => path === BASE || path.startsWith(`${BASE}/`) ? ['GET'] : null;
export function parseSyncedXmlRoute(request) {
  const url = new URL(request.url);
  if (!syncedXmlMethods(url.pathname)) return null;
  if (request.method !== 'GET') fail(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') fail();
  const match = new RegExp(`^${BASE}/([a-fA-F0-9-]+)/download$`).exec(url.pathname);
  if (url.pathname !== BASE && (!match || !UUID.test(match[1]))) fail(404, 'ERP_NOT_FOUND');
  const keys = match ? [] : ['q', 'model', 'kind', 'include_history', 'limit', 'after'];
  for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) fail();
  if (match) return { type: 'download', rpc: 'erp_synced_xml_object', args: { p_id: match[1].toLowerCase() } };
  const params = url.searchParams, q = params.get('q'), model = params.get('model'), kind = params.get('kind'), history = params.get('include_history'), after = params.get('after'), limit = params.get('limit');
  if ((q !== null && (q.length > 64 || /[\x00-\x1f\x7f]/.test(q))) || (model !== null && !['55', '65'].includes(model))
    || (kind !== null && !['invoice', 'event'].includes(kind)) || (history !== null && !['true', 'false'].includes(history))
    || (after !== null && !UUID.test(after)) || (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100))) fail();
  return { type: 'list', rpc: 'erp_synced_xml_list', args: { p_limit: limit === null ? 25 : Number(limit), p_after: after?.toLowerCase() || null,
    p_query: q?.trim() || null, p_model: model, p_kind: kind, p_include_history: history === 'true' } };
}
function text(value, max, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
function nullableDigits(value, max) { if (value === null) return null; if (typeof value !== 'string' || !(new RegExp(`^\\d{1,${max}}$`)).test(value)) invalid(); return value; }
function item(value) {
  if (!object(value) || !UUID.test(value.id || '') || !['nfe', 'nfce'].includes(value.entity) || !/^\d{44}$/.test(value.key || '')
    || !['55', '65'].includes(value.model) || value.entity !== (value.model === '55' ? 'nfe' : 'nfce') || value.key.slice(20, 22) !== value.model || !['1', '2'].includes(value.environment)
    || !['invoice', 'event'].includes(value.kind) || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 2147483647
    || !SHA.test(value.xml_hash || '') || !Number.isInteger(value.size_bytes) || value.size_bytes < 1 || value.size_bytes > MAX_XML
    || typeof value.protocol_present !== 'boolean' || typeof value.signature_present !== 'boolean'
    || value.validation !== 'structural_only' || value.signature_verified !== false || value.xsd_validated !== false || value.authorization_verified !== false
    || !Array.isArray(value.issues) || value.issues.length > 30 || value.issues.some(code => typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(code))) invalid();
  const collected = text(value.collected_at, 64);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(collected) || !Number.isFinite(Date.parse(collected))) invalid();
  const protocol = nullableDigits(value.protocol, 20), eventType = nullableDigits(value.event_type, 6), sequence = nullableDigits(value.event_sequence, 6);
  if (value.protocol_present !== (protocol !== null) || (value.kind === 'invoice' && (eventType !== null || sequence !== null))) invalid();
  return { id: value.id.toLowerCase(), source_id: text(value.source_id, 200), entity: value.entity, key: value.key, model: value.model,
    environment: value.environment, kind: value.kind, revision: value.revision, source_status: text(value.source_status, 100, true), collected_at: collected,
    xml_hash: value.xml_hash, size_bytes: value.size_bytes, protocol, protocol_present: value.protocol_present, signature_present: value.signature_present,
    event_type: eventType, event_sequence: sequence, issues: [...new Set(value.issues)], validation: 'structural_only', signature_verified: false,
    xsd_validated: false, authorization_verified: false };
}
function page(value, args) {
  if (!object(value) || value.data_mode !== MODE || value.limit !== args.p_limit || !Array.isArray(value.items) || value.items.length > args.p_limit
    || typeof value.has_more !== 'boolean' || (value.has_more && value.items.length !== args.p_limit)) invalid();
  const items = value.items.map(item); let previous = args.p_after;
  for (const row of items) {
    if ((previous && row.id <= previous) || (args.p_model && row.model !== args.p_model) || (args.p_kind && row.kind !== args.p_kind)
      || (args.p_query && !row.key.includes(args.p_query))) invalid();
    previous = row.id;
  }
  const next = value.has_more ? items.at(-1).id : null;
  if (value.next_cursor !== next) invalid();
  return { items, limit: args.p_limit, has_more: value.has_more, next_cursor: next, data_mode: MODE };
}
function metadata(value, id) {
  if (!object(value) || value.id !== id || !UUID.test(value.revision_id || '') || value.bucket !== 'origin-fiscal-xml' || !SHA.test(value.sha256 || '')
    || value.object_key !== `objects/${value.sha256}.xml` || !Number.isInteger(value.size) || value.size < 1 || value.size > MAX_XML || !['55', '65'].includes(value.model)) invalid();
  return { id, revision_id: value.revision_id, bucket: value.bucket, object_key: value.object_key, sha256: value.sha256, size: value.size, model: value.model };
}
async function readVerified(meta, fetchObject, timeoutMs) {
  let timer, reader, response;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new SyncedXmlError(504, 'ERP_SYNCED_XML_TIMEOUT')), timeoutMs); });
  try {
    const fetched = Promise.resolve().then(() => fetchObject(`/storage/v1/object/authenticated/origin-fiscal-xml/${meta.object_key}`));
    // A fetch implementation must enforce its own network cancellation too. A late
    // response after this deadline is cancelled and is never forwarded to a user.
    let timedOut = false;
    try { response = await Promise.race([fetched, timeout]); } catch (error) { timedOut = true; void fetched.then(late => late.body?.cancel()).catch(() => {}); throw error; }
    if (timedOut || response.status !== 200 || response.redirected || !response.body) fail(502, 'ERP_SYNCED_XML_DOWNLOAD_UNAVAILABLE');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== meta.size)) invalid();
    reader = response.body.getReader(); const bytes = new Uint8Array(meta.size); let offset = 0;
    while (true) {
      const result = await Promise.race([reader.read(), timeout]); if (result.done) break;
      if (!(result.value instanceof Uint8Array) || offset + result.value.length > bytes.length) invalid();
      bytes.set(result.value, offset); offset += result.value.length;
    }
    if (offset !== meta.size) invalid();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== meta.sha256) fail(502, 'ERP_SYNCED_XML_INTEGRITY_FAILURE');
    return bytes;
  } catch (error) { if (error instanceof SyncedXmlError) throw error; fail(502, 'ERP_SYNCED_XML_DOWNLOAD_UNAVAILABLE'); }
  finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else void response?.body?.cancel().catch(() => {}); }
}
/** The caller verifies the JWT; SQL rechecks fiscal membership for both RPC reads. */
export async function executeSyncedXmlRoute(route, { userId, rpc, fetchObject, timeoutMs = 20000 }) {
  if (!UUID.test(userId || '')) fail(401, 'ERP_UNAUTHORIZED');
  if (!route || !['list', 'download'].includes(route.type)) fail(404, 'ERP_NOT_FOUND');
  const args = { p_user_id: userId.toLowerCase(), ...route.args };
  if (route.type === 'list') return { type: 'json', body: page(await rpc('erp_synced_xml_list', args), route.args) };
  const meta = metadata(await rpc('erp_synced_xml_object', args), route.args.p_id);
  const bytes = await readVerified(meta, fetchObject, timeoutMs);
  const current = metadata(await rpc('erp_synced_xml_object', args), route.args.p_id);
  if (JSON.stringify(current) !== JSON.stringify(meta)) invalid();
  const filename = `origin-${meta.model}-${meta.sha256.slice(0, 12)}.xml`;
  return { type: 'download', bytes, filename, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
    'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } };
}
