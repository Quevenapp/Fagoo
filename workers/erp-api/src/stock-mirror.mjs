/** Read-only Origin positions. Quantities remain decimal strings; no native ledger commands. */
export class StockMirrorError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const need = (value, status = 502) => { if (!value) throw new StockMirrorError(status, status === 400 ? 'ERP_INVALID_QUERY' : 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text = (value, max = 500) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const nullable = (value, check) => value === null || check(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const decimal = value => typeof value === 'string' && /^-?\d{1,30}(?:\.\d{1,20})?$/.test(value);
const sourceId = value => typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value);
export function stockMirrorOperation(params) {
  for (const key of params.keys()) need(['q', 'warehouse_source_id', 'product_id', 'state', 'limit', 'after'].includes(key) && params.getAll(key).length === 1, 400);
  const query = params.get('q'), warehouse = params.get('warehouse_source_id'), product = params.get('product_id'), state = params.get('state');
  const limit = params.get('limit') ?? '50', after = params.get('after');
  need(nullable(query, value => text(value, 120) && value.trim().length > 0)
    && nullable(warehouse, sourceId) && nullable(product, uuid) && nullable(state, value => ['pending', 'negative', 'deleted'].includes(value))
    && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 100
    && nullable(after, value => /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))), 400);
  return { type: 'mirror', rpc: 'erp_stock_mirror_list', args: {
    p_query: query?.trim() ?? null, p_warehouse_source_id: warehouse, p_product_id: product?.toLowerCase() ?? null,
    p_state: state, p_limit: Number(limit), p_after: after === null ? null : Number(after),
  } };
}
export function stockMirrorResponse(value, operation) {
  const args = operation.args;
  need(object(value) && value.scope === 'stock_mirror' && value.data_mode === 'origin_mirror' && value.limit === args.p_limit
    && typeof value.has_more === 'boolean' && nullable(value.next_after, integer)
    && Array.isArray(value.items) && value.items.length <= args.p_limit && object(value.coverage) && object(value.native) && Array.isArray(value.warehouses));
  const items = value.items.map(row => {
    need(object(row) && integer(row.id) && row.id > (args.p_after ?? 0) && sourceId(row.product_source_id)
      && nullable(row.product_id, uuid) && text(row.product_name) && nullable(row.product_code, text) && nullable(row.unit, value => text(value, 30))
      && nullable(row.warehouse_source_id, sourceId) && nullable(row.warehouse_id, uuid) && text(row.warehouse_name)
      && ['physical', 'virtual', 'reserved'].every(key => nullable(row[key], decimal))
      && ['value', 'absent', 'null', 'invalid'].includes(row.physical_state) && ['value', 'absent', 'null', 'invalid'].includes(row.virtual_state)
      && (row.physical_state === 'value') === (row.physical !== null) && (row.virtual_state === 'value') === (row.virtual !== null)
      && typeof row.source_deleted === 'boolean' && Array.isArray(row.issues) && row.issues.every(value => text(value, 100))
      && integer(row.source_version) && typeof row.source_hash === 'string' && /^[a-f0-9]{64}$/.test(row.source_hash)
      && typeof row.observed_at === 'string' && Number.isFinite(Date.parse(row.observed_at)) && row.origin === 'origin' && row.read_only === true
      && (!args.p_product_id || row.product_id === args.p_product_id) && (!args.p_warehouse_source_id || row.warehouse_source_id === args.p_warehouse_source_id));
    return Object.fromEntries(['id', 'product_source_id', 'product_id', 'product_name', 'product_code', 'unit', 'warehouse_source_id', 'warehouse_id', 'warehouse_name',
      'physical', 'virtual', 'reserved', 'physical_state', 'virtual_state', 'issues', 'source_version', 'source_hash', 'observed_at', 'source_deleted', 'origin', 'read_only'].map(key => [key, row[key]]));
  });
  need(items.every((row, index) => index === 0 || row.id > items[index - 1].id)
    && (value.has_more ? items.length === args.p_limit && value.next_after === items.at(-1)?.id : value.next_after === null));
  const coverage = {};
  for (const key of ['positions', 'products', 'raw_products', 'pending_products']) { need(integer(value.coverage[key])); coverage[key] = value.coverage[key]; }
  need(typeof value.coverage.partial === 'boolean'); coverage.partial = value.coverage.partial;
  need(integer(value.native.positions) && integer(value.native.movements));
  const warehouses = value.warehouses.map(row => { need(object(row) && sourceId(row.source_id) && nullable(row.id, uuid) && text(row.name)); return { source_id: row.source_id, id: row.id, name: row.name }; });
  return { scope: 'stock_mirror', data_mode: 'origin_mirror', items, limit: value.limit, next_after: value.next_after, has_more: value.has_more,
    coverage, warehouses, native: { positions: value.native.positions, movements: value.native.movements } };
}

/** Independent, bounded ERP cron: failures never roll back a collector's staging batch. */
export async function projectStockMirror(rpc) {
  return rpc('erp_stock_mirror_project', { p_limit: 100 });
}
