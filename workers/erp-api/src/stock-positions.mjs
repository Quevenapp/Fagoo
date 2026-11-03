/** Read-only stock positions. Quantities remain exact strings; no valuation or operational effects. */
const BASE = '/v1/posicoes-estoque';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
// Recorded balances are signed since migration100 (company policy "Permitir estoque negativo"); limits stay non-negative.
const SIGNED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const TOTAL = /^-?(0|[1-9][0-9]{0,30})\.[0-9]{6}$/;
const COUNT = /^(0|[1-9][0-9]{0,18})$/;
const STATES = ['recorded', 'no_movements', 'review_required'];
const LIMIT_STATES = ['below_min', 'within', 'above_max', 'not_configured', 'no_movements', 'review_required'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const version = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const units = value => BigInt(value.replace('.', ''));
const signed = (value, pattern) => typeof value === 'string' && pattern.test(value) && !/^-0\.0+$/.test(value);
const magnitude = value => value < 0n ? -value : value;
const contains = (value, query) => !query?.trim() || (value ?? '').toLowerCase().includes(query.trim().toLowerCase());
export class StockPositionsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockPositionsError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockPositionsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
export function stockPositionsMethods(path) { return path === BASE || path === `${BASE}/depositos` ? ['GET'] : null; }
export function parseStockPositionsRoute(request) {
  const url = new URL(request.url), methods = stockPositionsMethods(url.pathname);
  if (!methods) throw new StockPositionsError(404, 'ERP_NOT_FOUND');
  if (!methods.includes(request.method)) throw new StockPositionsError(405, 'ERP_METHOD_NOT_ALLOWED');
  const warehouses = url.pathname.endsWith('/depositos'), params = url.searchParams;
  const allowed = warehouses ? ['limit', 'after'] : ['limit', 'after', 'q', 'active', 'warehouse_id', 'brand', 'location', 'stock_state', 'limit_state'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  const limit = params.get('limit') ?? (warehouses ? '100' : '25'), after = params.get('after');
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100 || (after !== null && !uuid(after))) invalid();
  const args = { p_limit: Number(limit), p_after: after?.toLowerCase() ?? null };
  if (!warehouses) {
    const warehouse = params.get('warehouse_id'), active = params.get('active'), state = params.get('stock_state'), limitState = params.get('limit_state');
    if ((warehouse !== null && !uuid(warehouse)) || (active !== null && !['true', 'false'].includes(active))
      || (state !== null && !STATES.includes(state)) || (limitState !== null && !LIMIT_STATES.includes(limitState))) invalid();
    for (const [key, max] of [['q', 120], ['brand', 100], ['location', 100]]) if (params.has(key) && !text(params.get(key), max)) invalid();
    Object.assign(args, { p_query: params.get('q'), p_active: active === null ? null : active === 'true', p_warehouse_id: warehouse?.toLowerCase() ?? null,
      p_brand: params.get('brand'), p_location: params.get('location'), p_stock_state: state, p_limit_state: limitState });
  }
  return { type: warehouses ? 'warehouses' : 'positions', rpc: warehouses ? 'erp_stock_position_warehouses' : 'erp_stock_positions', args };
}
function warehouseDto(value) {
  if (!object(value) || !uuid(value.id) || !text(value.name, 200, 1) || typeof value.active !== 'boolean') upstream();
  return { id: value.id.toLowerCase(), name: value.name, active: value.active };
}
function productDto(value) {
  if (!object(value) || !uuid(value.id) || !version(value.version) || value.version < 1 || !text(value.name, 200, 1)
    || typeof value.active !== 'boolean' || (value.kind !== null && !['P', 'S', 'N'].includes(value.kind))
    || (value.format !== null && !['S', 'V', 'E'].includes(value.format))) upstream();
  for (const [key, max] of [['code', 100], ['gtin', 14], ['unit', 16], ['brand', 100], ['location', 100]]) if (value[key] !== null && !text(value[key], max, 1)) upstream();
  for (const key of ['stock_min', 'stock_max']) if (value[key] !== null && (typeof value[key] !== 'string' || !DECIMAL.test(value[key]))) upstream();
  if (value.stock_min !== null && value.stock_max !== null && units(value.stock_min) > units(value.stock_max)) upstream();
  return Object.fromEntries(['id', 'version', 'name', 'code', 'active', 'unit', 'kind', 'format', 'gtin', 'brand', 'location', 'stock_min', 'stock_max'].map(key => [key, key === 'id' ? value.id.toLowerCase() : value[key]]));
}
function rowDto(value, args) {
  if (!object(value) || !object(value.global)) upstream();
  const product = productDto(value.product), global = value.global;
  if (!STATES.includes(global.state) || global.scope !== 'all_recorded_warehouses' || typeof global.recorded_warehouse_count !== 'string'
    || !COUNT.test(global.recorded_warehouse_count) || BigInt(global.recorded_warehouse_count) > 9223372036854775807n) upstream();
  if (global.state === 'recorded') {
    if (!signed(global.quantity, TOTAL) || global.recorded_warehouse_count === '0'
      || product.kind !== 'P' || product.unit === null || magnitude(units(global.quantity)) > BigInt(global.recorded_warehouse_count) * 999999999999999999n) upstream();
  } else if (global.quantity !== null || (global.state === 'no_movements' && global.recorded_warehouse_count !== '0')) upstream();
  let selected = null;
  if (args.p_warehouse_id !== null) {
    const position = value.selected_position;
    if (!object(position) || position.warehouse_id !== args.p_warehouse_id || !STATES.includes(position.state) || !version(position.version)) upstream();
    if (position.state === 'recorded') {
      // With a negative balance elsewhere, one warehouse may hold more than the global sum.
      if (!signed(position.quantity, SIGNED) || position.version < 1 || global.state === 'no_movements') upstream();
    } else if (position.quantity !== null || (position.state === 'no_movements' && position.version !== 0)) upstream();
    if (position.state === 'review_required' && global.state !== 'review_required') upstream();
    selected = { warehouse_id: position.warehouse_id, state: position.state, quantity: position.quantity, version: position.version };
  } else if (value.selected_position !== null) upstream();
  const expectedLimit = global.state !== 'recorded' ? global.state : product.stock_min === null && product.stock_max === null ? 'not_configured'
    : product.stock_min !== null && units(global.quantity) < units(product.stock_min) ? 'below_min'
      : product.stock_max !== null && units(global.quantity) > units(product.stock_max) ? 'above_max' : 'within';
  if (value.limit_state !== expectedLimit || (args.p_active !== null && product.active !== args.p_active)
    || (args.p_stock_state !== null && (selected?.state ?? global.state) !== args.p_stock_state)
    || (args.p_limit_state !== null && expectedLimit !== args.p_limit_state)
    || (!contains(product.name, args.p_query) && !contains(product.code, args.p_query) && !contains(product.gtin, args.p_query))
    || !contains(product.brand, args.p_brand) || !contains(product.location, args.p_location)) upstream();
  return { product, global: { state: global.state, quantity: global.quantity, recorded_warehouse_count: global.recorded_warehouse_count, scope: global.scope }, selected_position: selected, limit_state: expectedLimit };
}
export async function executeStockPositionsRoute(route, { userId, rpc }) {
  if (!uuid(userId)) throw new StockPositionsError(403, 'ERP_ACCESS_DENIED');
  const value = await rpc(route.rpc, { p_user_id: userId, ...route.args }), warehouses = route.type === 'warehouses';
  if (!object(value) || value.data_mode !== 'erp_native' || value.scope !== (warehouses ? 'stock_warehouse_options' : 'stock_positions')
    || value.limit !== route.args.p_limit || !Array.isArray(value.items) || value.items.length > route.args.p_limit
    || typeof value.has_more !== 'boolean' || (value.has_more ? !uuid(value.next_cursor) || value.items.length !== value.limit : value.next_cursor !== null)) upstream();
  const items = value.items.map(item => warehouses ? warehouseDto(item) : rowDto(item, route.args));
  const ids = items.map(item => warehouses ? item.id : item.product.id);
  if (ids.some((id, i) => id <= (i ? ids[i - 1] : route.args.p_after ?? '')) || (value.has_more && value.next_cursor !== ids.at(-1))) upstream();
  const page = { items, limit: value.limit, has_more: value.has_more, next_cursor: value.next_cursor, data_mode: value.data_mode, scope: value.scope };
  if (!warehouses) {
    const warehouse = value.warehouse === null ? null : warehouseDto(value.warehouse);
    if ((warehouse?.id ?? null) !== route.args.p_warehouse_id) upstream();
    return { ...page, warehouse };
  }
  return page;
}
