/** Conferência de estoque like Origin (migration 106): strict routes, closed DTOs and cross-checked decimals. Routed by stock.mjs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY_INPUT = /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const TOTAL = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{6}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const REASONS = ['not_found', 'ambiguous', 'invalid_kind', 'invalid_format', 'inactive', 'invalid_quantity'];
const SKIPS = ['composition', 'unavailable', 'reserved', 'limit'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const negativeZero = value => /^-0(?:\.0+)?$/.test(value);
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
export class StockCountError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockCountError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockCountError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const BASE = '/v1/estoque/conferencias';
const ACTIONS = { exclusoes: 'delete', deposito: 'warehouse', reinicio: 'restart', balanco: 'balance' };

export function stockCountRoute(path) {
  if (path === `${BASE}/atual`) return { type: 'count-get' };
  if (path === `${BASE}/leituras`) return { type: 'count-read' };
  const match = /^\/v1\/estoque\/conferencias\/([0-9a-fA-F-]{36})\/(exclusoes|deposito|reinicio|balanco)$/.exec(path);
  return match && uuid(match[1]) ? { type: `count-${ACTIONS[match[2]]}`, session: match[1].toLowerCase() } : null;
}
export const stockCountMethods = route => route?.type === 'count-get' ? ['GET'] : route ? ['POST'] : null;
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 8192)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, body = '';
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result;
  } catch { return invalid(); }
  finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
export async function stockCountOperation(request, route, search) {
  if (search.size) invalid();
  if (route.type === 'count-get') return { type: 'count-get', rpc: 'erp_stock_count_get', args: {} };
  const input = await readBody(request);
  need(uuid(input.command_id));
  const command = input.command_id.toLowerCase(), warehouse = value => value === null ? null : uuid(value) ? value.toLowerCase() : invalid();
  switch (route.type) {
    case 'count-read':
      // The quantity text is validated by SQL, which answers Origin's "Quantidade inválida!" as a rejected reading.
      need(only(input, ['command_id', 'session_id', 'code', 'quantity', 'warehouse_id']) && (input.session_id === null || uuid(input.session_id))
        && typeof input.code === 'string' && text(input.code, 100, 1) && typeof input.quantity === 'string' && input.quantity.length <= 40 && !/[\x00-\x1f\x7f]/.test(input.quantity)
        && Object.hasOwn(input, 'warehouse_id') && Object.hasOwn(input, 'session_id'));
      return { type: 'count-read', rpc: 'erp_stock_count_read', args: { p_command_id: command, p_session_id: input.session_id?.toLowerCase() ?? null, p_code: input.code, p_quantity: input.quantity, p_warehouse_id: warehouse(input.warehouse_id) } };
    case 'count-delete':
      need(only(input, ['command_id', 'product_id']) && uuid(input.product_id));
      return { type: 'count-delete', rpc: 'erp_stock_count_delete', args: { p_command_id: command, p_session_id: route.session, p_product_id: input.product_id.toLowerCase() } };
    case 'count-warehouse':
      need(only(input, ['command_id', 'expected_version', 'warehouse_id']) && int(input.expected_version, 1, 2147483646) && Object.hasOwn(input, 'warehouse_id'));
      return { type: 'count-warehouse', rpc: 'erp_stock_count_warehouse', args: { p_command_id: command, p_session_id: route.session, p_expected_version: input.expected_version, p_warehouse_id: warehouse(input.warehouse_id) } };
    case 'count-restart':
      need(only(input, ['command_id', 'expected_version']) && int(input.expected_version, 1, 2147483646));
      return { type: 'count-restart', rpc: 'erp_stock_count_restart', args: { p_command_id: command, p_session_id: route.session, p_expected_version: input.expected_version } };
    default:
      need(only(input, ['command_id', 'expected_version', 'scope', 'confirmed']) && int(input.expected_version, 1, 2147483646) && ['counted', 'all_active'].includes(input.scope)
        && typeof input.confirmed === 'boolean' && (input.scope === 'counted' || input.confirmed));
      return { type: 'count-balance', rpc: 'erp_stock_count_balance', args: { p_command_id: command, p_session_id: route.session, p_expected_version: input.expected_version, p_scope: input.scope, p_confirmed: input.confirmed } };
  }
}
const stored = value => typeof value === 'string' && STORED.test(value) && !negativeZero(value);
const total = value => typeof value === 'string' && TOTAL.test(value) && !negativeZero(value);
function countDto(value) {
  if (value === null) return null;
  need(object(value) && object(value.session) && Array.isArray(value.items) && Array.isArray(value.log) && int(value.readings) && int(value.items_total) && total(value.total_read)
    && value.items.length <= 1500 && value.items.length === Math.min(1500, value.items_total) && value.log.length <= 200, upstream);
  const s = value.session;
  need(uuid(s.id) && s.state === 'open' && int(s.version, 1) && (s.warehouse_id === null ? s.warehouse_name === null : uuid(s.warehouse_id) && text(s.warehouse_name, 200, 1))
    && instant(s.created_at) && s.balance_scope === null && s.closed_at === null, upstream);
  let sum = 0n;
  const items = value.items.map(item => {
    need(object(item) && uuid(item.product_id) && (item.code === null || text(item.code, 100)) && text(item.name, 200, 1) && (item.location === null || text(item.location, 100))
      && (item.unit === null || text(item.unit, 16, 1)) && total(item.counted) && units(item.counted) > 0n && total(item.physical) && total(item.difference)
      && units(item.difference) === units(item.counted) - units(item.physical), upstream);
    sum += units(item.counted);
    // 181: Imagem of Origin (first external image of the product, 119); absent on a database still on 106/145.
    const image = item.image_url ?? null;
    need(image === null || (typeof image === 'string' && image.length >= 9 && image.length <= 1000 && /^https:\/\/[^\s\x00-\x1f\x7f]+$/.test(image)), upstream);
    return { product_id: item.product_id, code: item.code, name: item.name, location: item.location, unit: item.unit, counted: item.counted, physical: item.physical, difference: item.difference, image_url: image };
  });
  need(new Set(items.map(item => item.product_id)).size === items.length && (value.items_total > items.length || sum === units(value.total_read)) && (value.readings > 0) === (value.items_total > 0), upstream);
  const log = value.log.map(entry => {
    need(object(entry) && uuid(entry.id) && text(entry.code, 100, 1) && stored(entry.quantity) && units(entry.quantity) > 0n && uuid(entry.product_id) && text(entry.product_name, 200, 1)
      && typeof entry.recorded_at_local === 'string' && LOCAL_TIME.test(entry.recorded_at_local) && typeof entry.deleted === 'boolean', upstream);
    return { id: entry.id, code: entry.code, quantity: entry.quantity, product_id: entry.product_id, product_name: entry.product_name, recorded_at_local: entry.recorded_at_local, deleted: entry.deleted };
  });
  return { session: { id: s.id, state: s.state, version: s.version, warehouse_id: s.warehouse_id, warehouse_name: s.warehouse_name, created_at: s.created_at }, total_read: value.total_read,
    readings: value.readings, items_total: value.items_total, items, log };
}
export function stockCountResponse(value, operation) {
  need(object(value) && value.scope === 'stock_count' && value.data_mode === 'erp_native', upstream);
  const args = operation.args;
  if (operation.type === 'count-get') return { count: countDto(value.count), scope: 'stock_count', data_mode: 'erp_native' };
  need(typeof value.replayed === 'boolean', upstream);
  const base = { replayed: value.replayed, scope: 'stock_count', data_mode: 'erp_native' };
  if (operation.type === 'count-read') {
    if (value.outcome === 'rejected') {
      need(REASONS.includes(value.reason) && text(value.code, 100, 1), upstream);
      return { ...base, outcome: 'rejected', reason: value.reason, code: value.code, count: countDto(value.count) };
    }
    const count = value.replayed ? null : countDto(value.count);
    need(value.outcome === 'read' && value.reason === null && text(value.code, 100, 1) && object(value.reading) && uuid(value.reading.product_id) && text(value.reading.product_name, 200, 1) && stored(value.reading.quantity)
      && units(value.reading.quantity) === units(args.p_quantity) && uuid(value.session_id) && (args.p_session_id === null || value.session_id === args.p_session_id)
      && (value.replayed || (count !== null && count.session.id === value.session_id)), upstream);
    return { ...base, outcome: 'read', code: value.code, reading: { product_id: value.reading.product_id, product_name: value.reading.product_name, quantity: value.reading.quantity }, session_id: value.session_id, count: value.replayed ? null : count };
  }
  need(value.session_id === args.p_session_id, upstream);
  if (operation.type === 'count-delete') {
    need(value.outcome === 'deleted' && value.product_id === args.p_product_id && int(value.deleted_readings, 1), upstream);
    const count = value.replayed ? null : countDto(value.count);
    need(value.replayed || (count !== null && !count.items.some(item => item.product_id === args.p_product_id)), upstream);
    return { ...base, outcome: 'deleted', product_id: value.product_id, deleted_readings: value.deleted_readings, count };
  }
  if (operation.type === 'count-warehouse') {
    need(value.outcome === 'warehouse' && object(value.from) && object(value.to) && value.from.version === args.p_expected_version && value.to.version === args.p_expected_version + 1
      && value.to.warehouse_id === args.p_warehouse_id, upstream);
    const count = value.replayed ? null : countDto(value.count);
    need(value.replayed || (count !== null && count.session.version === value.to.version && count.session.warehouse_id === args.p_warehouse_id), upstream);
    return { ...base, outcome: 'warehouse', count };
  }
  if (operation.type === 'count-restart') {
    need(value.outcome === 'restarted' && int(value.discarded_readings), upstream);
    const count = value.replayed ? null : countDto(value.count);
    need(value.replayed || (count !== null && count.session.id !== args.p_session_id && count.readings === 0), upstream);
    return { ...base, outcome: 'restarted', discarded_readings: value.discarded_readings, count };
  }
  need(value.outcome === 'balanced' && uuid(value.warehouse_id) && value.balance_scope === args.p_scope && typeof value.occurred_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.occurred_on)
    && Array.isArray(value.changed) && Array.isArray(value.skipped) && int(value.unchanged), upstream);
  const changed = value.changed.map(item => { need(object(item) && uuid(item.product_id) && text(item.name, 200, 1) && uuid(item.movement_id) && stored(item.counted) && stored(item.previous) && units(item.counted) !== units(item.previous), upstream);
    return { product_id: item.product_id, name: item.name, movement_id: item.movement_id, counted: item.counted, previous: item.previous }; });
  const skipped = value.skipped.map(item => { need(object(item) && uuid(item.product_id) && text(item.name, 200, 1) && SKIPS.includes(item.reason), upstream); return { product_id: item.product_id, name: item.name, reason: item.reason }; });
  need(new Set([...changed, ...skipped].map(item => item.product_id)).size === changed.length + skipped.length, upstream);
  return { ...base, outcome: 'balanced', warehouse_id: value.warehouse_id, balance_scope: value.balance_scope, occurred_on: value.occurred_on, changed, unchanged: value.unchanged, skipped };
}
