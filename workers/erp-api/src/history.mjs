/** Fiscal backup boundary: explicit projections, authenticated downloads, no signed public URLs. */
const SHA = /^[0-9a-f]{64}$/;
const MAX_XML = 8 * 1024 * 1024;
export class HistoryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new HistoryError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new HistoryError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
function allowed(params, keys) {
  for (const key of params.keys()) if (!keys.includes(key) || params.getAll(key).length !== 1) invalid();
}
function integer(value, fallback, max, min = 0) {
  if (value === null) return fallback;
  if (!/^\d{1,6}$/.test(value)) invalid();
  const number = Number(value);
  if (number < min || number > max) invalid();
  return number;
}
export function parseHistoryRoute(url) {
  if (!url.pathname.startsWith('/v1/history/')) return null;
  const params = url.searchParams;
  if (url.pathname === '/v1/history/backups') {
    allowed(params, []);
    return { kind: 'backups', rpc: 'erp_history_backups', args: {} };
  }
  const download = /^\/v1\/history\/xml\/([0-9a-f]{64})\/download$/.exec(url.pathname);
  if (url.pathname !== '/v1/history/xml' && !download) throw new HistoryError(404, 'ERP_NOT_FOUND');
  allowed(params, download ? ['backup'] : ['backup', 'q', 'model', 'kind', 'limit', 'offset']);
  const backup = params.get('backup');
  if (!backup || !SHA.test(backup)) invalid();
  if (download) return { kind: 'download', rpc: 'erp_history_xml_object', args: { p_backup_sha: backup, p_xml_sha: download[1] } };
  const query = params.get('q');
  const model = params.get('model');
  const kind = params.get('kind');
  if ((query !== null && (query.length > 64 || /[\x00-\x1f\x7f]/.test(query)))
    || (model !== null && !['55', '65'].includes(model)) || (kind !== null && !['invoice', 'event'].includes(kind))) invalid();
  return { kind: 'xml', rpc: 'erp_history_xml', args: { p_backup_sha: backup,
    p_limit: integer(params.get('limit'), 25, 100, 1), p_offset: integer(params.get('offset'), 0, 100000),
    p_query: query?.trim() || null, p_model: model, p_kind: kind } };
}
const text = (value, max, optional = true) => {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || value.length > max) upstreamInvalid();
  return value;
};
const count = value => { if (!Number.isSafeInteger(value) || value < 0) upstreamInvalid(); return value; };
const boolean = value => { if (typeof value !== 'boolean') upstreamInvalid(); return value; };
function backupList(value) {
  if (!value || value.data_mode !== 'backup_readonly' || !Array.isArray(value.items) || value.items.length > 100) upstreamInvalid();
  return { data_mode: 'backup_readonly', items: value.items.map(row => {
    if (!row || !SHA.test(row.id) || !['uploading', 'stored', 'stored_with_issues'].includes(row.status)
      || row.available !== (row.status !== 'uploading')) upstreamInvalid();
    return { id: row.id, status: row.status, available: row.available, created_at: text(row.created_at, 40, false),
      finished_at: text(row.finished_at, 40), xml_occurrences: count(row.xml_occurrences), issues: count(row.issues) };
  }) };
}
function xmlList(value, route) {
  const args = route.args;
  if (!value || value.data_mode !== 'backup_readonly' || value.backup_id !== args.p_backup_sha
    || value.limit !== args.p_limit || value.offset !== args.p_offset || !Array.isArray(value.items) || value.items.length > args.p_limit
    || typeof value.has_more !== 'boolean' || value.next_offset !== (value.has_more ? args.p_offset + args.p_limit : null)) upstreamInvalid();
  const total = count(value.total);
  if (value.has_more !== (total > args.p_offset + args.p_limit)) upstreamInvalid();
  const items = value.items.map(row => {
    if (!row || !SHA.test(row.id) || !['invoice', 'event'].includes(row.kind)
      || !['55', '65', null].includes(row.model) || !['1', '2', null].includes(row.environment)
      || row.validation !== 'structural_only' || row.signature_verified !== false || row.xsd_validated !== false
      || !Array.isArray(row.issues) || row.issues.length > 30 || row.issues.some(code => typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(code))) upstreamInvalid();
    return { id: row.id, kind: row.kind, model: row.model, environment: row.environment,
      key: text(row.key, 44), protocol: text(row.protocol, 20), event_type: text(row.event_type, 6), sequence: text(row.sequence, 6),
      occurrences: count(row.occurrences), protocol_present: boolean(row.protocol_present), signature_present: boolean(row.signature_present),
      issues: [...new Set(row.issues)], validation: 'structural_only', signature_verified: false, xsd_validated: false };
  });
  return { backup_id: args.p_backup_sha, items, limit: value.limit, offset: value.offset, total,
    has_more: value.has_more, next_offset: value.next_offset, data_mode: 'backup_readonly' };
}

function downloadMetadata(object, xmlSha) {
  if (!object || object.bucket !== 'origin-backups' || object.sha256 !== xmlSha || !SHA.test(xmlSha)
    || object.object_key !== `objects/${xmlSha}.xml` || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_XML
    || !['55', '65', null].includes(object.model)) upstreamInvalid();
  return { bucket: object.bucket, object_key: object.object_key, sha256: xmlSha, size: object.size, model: object.model };
}

/** Caller supplies fixed-origin, server-authenticated fetch; hash and size are rechecked before returning bytes. */
export async function verifiedXmlDownload(object, xmlSha, fetchObject) {
  object = downloadMetadata(object, xmlSha);
  const response = await fetchObject(`/storage/v1/object/authenticated/origin-backups/objects/${xmlSha}.xml`);
  if (!response.ok || response.redirected || !response.body) {
    await response.body?.cancel(); throw new HistoryError(502, 'ERP_HISTORY_DOWNLOAD_UNAVAILABLE');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== object.size)) {
    await response.body.cancel(); upstreamInvalid();
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(object.size);
  let position = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (position + value.byteLength > bytes.length) upstreamInvalid();
      bytes.set(value, position); position += value.byteLength;
    }
  } finally { try { await reader.cancel(); } catch { /* Never log object bytes. */ } reader.releaseLock(); }
  if (position !== bytes.length) upstreamInvalid();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== xmlSha) throw new HistoryError(502, 'ERP_HISTORY_INTEGRITY_FAILURE');
  return { type: 'download', bytes, filename: `origin-${object.model || 'xml'}-${xmlSha.slice(0, 12)}.xml` };
}

/** Auth and role verification are mandatory in the caller and SQL respectively. */
export async function executeHistoryRoute(route, { userId, rpc, fetchObject }) {
  const args = { p_user_id: userId, ...route.args };
  const result = await rpc(route.rpc, args);
  if (route.kind === 'download') {
    const metadata = downloadMetadata(result, route.args.p_xml_sha);
    const download = await verifiedXmlDownload(metadata, route.args.p_xml_sha, fetchObject);
    // Recheck the same actor, backup and hash after retrieval: revoked membership,
    // an unavailable backup/object or changed binding must prevent delivery.
    const current = downloadMetadata(await rpc(route.rpc, args), route.args.p_xml_sha);
    if (JSON.stringify(current) !== JSON.stringify(metadata)) upstreamInvalid();
    return download;
  }
  return { type: 'json', body: route.kind === 'backups' ? backupList(result) : xmlList(result, route) };
}
