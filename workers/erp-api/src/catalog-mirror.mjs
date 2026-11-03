/** Leva H, lane espelho (migrations 202610210350-352), under /v1/espelho-origin:
 * - GET cadastros/{contacts|products}/:id: "Dados do Origin" of a record (mirrored fields, origin, sync date, pending, Brufap complements);
 * - GET categorias, POST categorias/sincronizar: the Origin product categories and their synchronization (administrador);
 * - GET exclusoes, POST exclusoes/:id: products excluded or restored in the Origin, applied by the administrador;
 * - POST transportadores/:id: the Transportador complement of a contact (never edits the mirrored contact).
 * Read-only towards the Origin: nothing here writes to it. Every answer is checked before it leaves the Worker. */
export const MIRROR_BASE = '/v1/espelho-origin';
export const MIRROR_BODY_BYTES = 4096;
export class CatalogMirrorError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE = /^[1-9]\d{0,39}$/;
const STAMP = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const need = (value, status, code) => { if (!value) throw new CatalogMirrorError(status, code); };
const bad = () => { throw new CatalogMirrorError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const check = value => { if (!value) bad(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nullable = (value, test) => value === null || test(value);
const version = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const STATES = ['synced', 'local_modified', 'source_changed', 'source_deleted'];
const ISSUES = ['parent_missing', 'cycle', 'name_conflict', 'name_invalid', 'limit'];
const SYNC_COUNTS = ['created', 'updated', 'adopted', 'unchanged', 'refreshed', 'removed_locally', 'invalid', 'limit', 'name_conflict'];
const ROUTES = [
  [/^cadastros\/(contacts|products)\/([0-9a-f-]{36})$/, ['GET'], 'record'],
  [/^categorias$/, ['GET'], 'categories'],
  [/^categorias\/sincronizar$/, ['POST'], 'categories-sync'],
  [/^exclusoes$/, ['GET'], 'deletions'],
  [/^exclusoes\/([0-9a-f-]{36})$/, ['POST'], 'deletion-apply'],
  [/^transportadores\/([0-9a-f-]{36})$/, ['POST'], 'carrier'],
];
export const catalogMirrorRoute = path => path === MIRROR_BASE || path.startsWith(`${MIRROR_BASE}/`);
const match = path => { const rest = path.slice(MIRROR_BASE.length + 1); for (const [pattern, methods, action] of ROUTES) { const found = pattern.exec(rest); if (found) return { methods, action, found }; } return null; };
export const catalogMirrorMethods = path => match(path)?.methods ?? ['GET'];

async function body(request) {
  need(/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || ''), 415, 'ERP_UNSUPPORTED_MEDIA_TYPE');
  const raw = await request.text(); need(new TextEncoder().encode(raw).byteLength <= MIRROR_BODY_BYTES, 413, 'ERP_PAYLOAD_TOO_LARGE');
  let value; try { value = JSON.parse(raw); } catch { throw new CatalogMirrorError(400, 'ERP_INVALID_INPUT'); }
  need(object(value), 400, 'ERP_INVALID_INPUT'); return value;
}
const commandOf = value => { need(typeof value === 'string' && UUID.test(value.toLowerCase()), 400, 'ERP_INVALID_INPUT'); return value.toLowerCase(); };

export async function parseCatalogMirrorRoute(request) {
  const url = new URL(request.url), route = match(url.pathname);
  need(route, 404, 'ERP_NOT_FOUND');
  need(route.methods.includes(request.method), 405, 'ERP_METHOD_NOT_ALLOWED');
  const { action, found } = route;
  if (action === 'deletions') {
    for (const key of url.searchParams.keys()) need(['limit', 'after'].includes(key) && url.searchParams.getAll(key).length === 1, 400, 'ERP_INVALID_QUERY');
    const limit = url.searchParams.get('limit') ?? '50', after = url.searchParams.get('after');
    need(/^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 100 && (after === null || UUID.test(after)), 400, 'ERP_INVALID_QUERY');
    return { action, limit: Number(limit), after };
  }
  need(!url.search, 400, 'ERP_INVALID_QUERY');
  if (action === 'record') { need(UUID.test(found[2]), 404, 'ERP_NOT_FOUND'); return { action, entity: found[1], id: found[2] }; }
  if (action === 'categories') return { action };
  const sent = await body(request);
  if (action === 'categories-sync') { need(exact(sent, ['command_id']), 400, 'ERP_INVALID_INPUT'); return { action, command_id: commandOf(sent.command_id) }; }
  need(UUID.test(found[1]), 404, 'ERP_NOT_FOUND');
  if (action === 'deletion-apply') {
    need(exact(sent, ['command_id', 'expected_version', 'action']) && version(sent.expected_version) && sent.expected_version < 2147483647 && ['delete', 'restore'].includes(sent.action), 400, 'ERP_INVALID_INPUT');
    return { action, id: found[1], command_id: commandOf(sent.command_id), expected_version: sent.expected_version, apply: sent.action };
  }
  need(exact(sent, ['command_id', 'carrier']) && typeof sent.carrier === 'boolean', 400, 'ERP_INVALID_INPUT');
  return { action, id: found[1], command_id: commandOf(sent.command_id), carrier: sent.carrier };
}

/** Mirrored fields: text values, or (addresses) one level of text values; at most 80 keys. */
function fields(value) {
  check(object(value) && Object.keys(value).length <= 80);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    check(/^[a-z][a-z_]{0,39}$/.test(key));
    if (Array.isArray(item)) { check(item.length <= 50 && item.every(v => text(v, 100))); out[key] = [...item]; }
    else if (object(item)) { check(Object.keys(item).length <= 10 && Object.entries(item).every(([k, v]) => /^[a-z][a-z_]{0,39}$/.test(k) && text(v, 200))); out[key] = { ...item }; }
    else { check(text(item, 4000)); out[key] = item; }
  }
  return out;
}
function recordAnswer(value, route) {
  check(exact(value, ['scope', 'entity', 'id', 'data_mode', 'system', 'linked', 'source_id', 'state', 'synced_at', 'source_updated_at', 'source_seen_at', 'pending', 'fields', 'local_complements'])
    && value.scope === 'origin_mirror' && value.entity === route.entity && value.id === route.id && value.data_mode === 'erp_native' && value.system === 'origin'
    && typeof value.linked === 'boolean' && typeof value.pending === 'boolean' && nullable(value.source_id, v => SOURCE.test(v)) && value.linked === (value.source_id !== null)
    && nullable(value.state, v => STATES.includes(v)) && (value.state === null) === !value.linked && [value.synced_at, value.source_updated_at, value.source_seen_at].every(v => nullable(v, STAMP))
    && (value.linked || (!value.pending && value.synced_at === null)) && Array.isArray(value.local_complements) && value.local_complements.length <= 80
    && value.local_complements.every(v => typeof v === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(v)));
  return { ...value, fields: fields(value.fields), local_complements: [...value.local_complements] };
}
function categoriesAnswer(value) {
  check(exact(value, ['scope', 'data_mode', 'system', 'source_count', 'source_seen_at', 'pending', 'items']) && value.scope === 'origin_categories' && value.data_mode === 'erp_native'
    && value.system === 'origin' && Number.isInteger(value.source_count) && value.source_count >= 0 && nullable(value.source_seen_at, STAMP)
    && Number.isInteger(value.pending) && value.pending >= 0 && value.pending <= value.source_count && Array.isArray(value.items) && value.items.length <= 5000);
  const items = value.items.map(item => {
    check(exact(item, ['source_id', 'taxonomy_id', 'name', 'source_name', 'source_parent_id', 'parent_id', 'inactive', 'issue', 'synced_at', 'removed_locally'])
      && SOURCE.test(item.source_id) && nullable(item.taxonomy_id, v => UUID.test(v)) && nullable(item.name, v => text(v, 100)) && text(item.source_name, 200)
      && nullable(item.source_parent_id, v => SOURCE.test(v)) && nullable(item.parent_id, v => UUID.test(v)) && typeof item.inactive === 'boolean'
      && nullable(item.issue, v => ISSUES.includes(v)) && STAMP(item.synced_at) && item.removed_locally === (item.taxonomy_id === null) && (item.taxonomy_id === null) === (item.name === null));
    return { ...item };
  });
  check(new Set(items.map(i => i.source_id)).size === items.length);
  return { ...value, items };
}
function syncAnswer(value) {
  check(exact(value, ['scope', 'counts', 'issues', 'total', 'replayed', 'data_mode', 'operational_effects']) && value.scope === 'origin_categories_sync' && typeof value.replayed === 'boolean'
    && value.data_mode === 'erp_native' && value.operational_effects === false && Number.isInteger(value.total) && value.total >= 0
    && object(value.counts) && Object.entries(value.counts).every(([k, v]) => SYNC_COUNTS.includes(k) && Number.isInteger(v) && v >= 0 && v <= value.total)
    && Array.isArray(value.issues) && value.issues.length <= value.total && value.issues.every(i => exact(i, ['source_id', 'issue']) && SOURCE.test(i.source_id) && ISSUES.includes(i.issue)));
  return { scope: value.scope, counts: { ...value.counts }, issues: value.issues.map(i => ({ ...i })), total: value.total, replayed: value.replayed, data_mode: 'erp_native', operational_effects: false };
}
function deletionsAnswer(value, route) {
  check(exact(value, ['scope', 'data_mode', 'system', 'limit', 'has_more', 'writable', 'items', 'source_seen_at']) && value.scope === 'origin_deletions' && value.data_mode === 'erp_native'
    && value.system === 'origin' && value.limit === route.limit && typeof value.has_more === 'boolean' && typeof value.writable === 'boolean' && nullable(value.source_seen_at, STAMP)
    && Array.isArray(value.items) && value.items.length <= route.limit && (!value.has_more || value.items.length === route.limit));
  const items = value.items.map(item => {
    check(exact(item, ['id', 'version', 'name', 'code', 'source_id', 'source_status', 'action', 'deleted_at']) && UUID.test(item.id) && version(item.version) && text(item.name, 200) && item.name.trim()
      && nullable(item.code, v => text(v, 100)) && SOURCE.test(item.source_id) && ['delete', 'restore'].includes(item.action)
      && (item.action === 'delete' ? item.source_status === 'E' && item.deleted_at === null : ['A', 'I'].includes(item.source_status) && STAMP(item.deleted_at))
      && (route.after === null || item.id > route.after));
    return { ...item };
  });
  for (let i = 1; i < items.length; i++) check(items[i - 1].id < items[i].id);
  return { ...value, items };
}
function applyAnswer(value, route) {
  check(exact(value, ['scope', 'id', 'action', 'version', 'deleted', 'replayed', 'data_mode', 'operational_effects']) && value.scope === 'origin_deletion_apply' && value.id === route.id
    && value.action === route.apply && version(value.version) && value.deleted === (route.apply === 'delete') && typeof value.replayed === 'boolean'
    && value.data_mode === 'erp_native' && value.operational_effects === false && (value.replayed || value.version > route.expected_version));
  return { ...value };
}
function carrierAnswer(value, route) {
  check(exact(value, ['scope', 'id', 'carrier_complement', 'carrier_match', 'changed', 'replayed', 'data_mode']) && value.scope === 'contact_carrier_complement' && value.id === route.id
    && value.carrier_complement === route.carrier && typeof value.changed === 'boolean' && typeof value.replayed === 'boolean' && value.data_mode === 'erp_native'
    && nullable(value.carrier_match, v => ['role', 'origin', 'complement', 'untyped'].includes(v)) && (!route.carrier || value.carrier_match !== null) && (route.carrier || value.carrier_match !== 'complement'));
  return { ...value };
}

export async function executeCatalogMirrorRoute(route, { userId, rpc }) {
  if (route.action === 'record') return recordAnswer(await rpc('erp_catalog_origin_mirror_get', { p_user_id: userId, p_entity: route.entity, p_id: route.id }), route);
  if (route.action === 'categories') return categoriesAnswer(await rpc('erp_catalog_origin_categories', { p_user_id: userId }));
  if (route.action === 'categories-sync') return syncAnswer(await rpc('erp_catalog_origin_categories_sync', { p_user_id: userId, p_command_id: route.command_id }));
  if (route.action === 'deletions') return deletionsAnswer(await rpc('erp_catalog_origin_deletions', { p_user_id: userId, p_limit: route.limit, p_after: route.after }), route);
  if (route.action === 'deletion-apply') return applyAnswer(await rpc('erp_catalog_origin_deletion_apply', { p_user_id: userId, p_id: route.id, p_expected_version: route.expected_version, p_command_id: route.command_id, p_action: route.apply }), route);
  return carrierAnswer(await rpc('erp_catalog_contact_carrier_complement', { p_user_id: userId, p_contact_id: route.id, p_carrier: route.carrier, p_command_id: route.command_id }), route);
}
