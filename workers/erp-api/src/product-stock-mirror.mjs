/** Saldo observado no Origin para a lista e a exportação de produtos (migração 202610220008). Uma chamada em lote por página;
 * o resumo fica em `origin_stock`, separado do `stock` nativo, e nunca é somado a ele. Quantidades continuam textos decimais. */
export class ProductStockMirrorError extends Error {}
const bad = () => { throw new ProductStockMirrorError('ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const sourceId = value => typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value);
const decimal = value => typeof value === 'string' && value.length <= 100 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const nullable = (value, check) => value === null || check(value);
const KEYS = ['product_id', 'product_source_id', 'state', 'warehouse_source_id', 'warehouse_name', 'physical', 'virtual', 'physical_state', 'virtual_state', 'observed_at', 'source_version', 'positions', 'issues'];
export const ORIGIN_STOCK_STATES = ['observed', 'multiple_warehouses', 'not_observed', 'source_deleted', 'unlinked', 'warehouse_unlinked'];
const VALUE_STATES = ['value', 'absent', 'null', 'invalid'];
export const ORIGIN_STOCK_BATCH = 250;
// Estoque filter of the list, export and price tools: the native values (096/120) and the origin_* values, on the physical
// balance observed in Origin (same position the list shows).
export const PRODUCT_STOCK_FILTERS = ['zero', 'negative', 'positive', 'no_movements', 'origin_zero', 'origin_negative', 'origin_positive', 'origin_not_observed', 'origin_unlinked'];

export const productStockMirrorArgs = (ids, warehouseId) => ({ p_product_ids: ids, p_warehouse_id: warehouseId ?? null });

function item(row) {
  if (!object(row) || Object.keys(row).some(key => !KEYS.includes(key)) || !uuid(row.product_id) || !ORIGIN_STOCK_STATES.includes(row.state)
    || !Array.isArray(row.issues) || row.issues.length > 50 || !row.issues.every(issue => text(issue, 100)) || !Number.isSafeInteger(row.positions) || row.positions < 0) bad();
  const observed = row.state === 'observed';
  if ((row.state === 'unlinked') !== (row.product_source_id === null) || !nullable(row.product_source_id, sourceId)) bad();
  if (observed) {
    if (row.positions !== 1 || !nullable(row.warehouse_source_id, sourceId) || !text(row.warehouse_name, 500) || !VALUE_STATES.includes(row.physical_state) || !VALUE_STATES.includes(row.virtual_state)
      || !nullable(row.physical, decimal) || !nullable(row.virtual, decimal) || (row.physical_state === 'value') !== (row.physical !== null) || (row.virtual_state === 'value') !== (row.virtual !== null)
      || typeof row.observed_at !== 'string' || !Number.isFinite(Date.parse(row.observed_at)) || !Number.isSafeInteger(row.source_version) || row.source_version < 1) bad();
  } else if (['physical', 'virtual', 'physical_state', 'virtual_state', 'observed_at', 'source_version', 'warehouse_source_id', 'warehouse_name'].some(key => row[key] !== null && row[key] !== undefined)
    || (row.state === 'multiple_warehouses' ? row.positions < 2 : row.positions !== 0)) bad();
  return { origin: 'origin', state: row.state, product_source_id: row.product_source_id, warehouse_source_id: observed ? row.warehouse_source_id : null, warehouse_name: observed ? row.warehouse_name : null,
    physical: observed ? row.physical : null, virtual: observed ? row.virtual : null, physical_state: observed ? row.physical_state : null, virtual_state: observed ? row.virtual_state : null,
    observed_at: observed ? row.observed_at : null, source_version: observed ? row.source_version : null, positions: row.positions, issues: [...row.issues] };
}

/** Checks the RPC answer against the ids and the warehouse asked; returns the page-level summary and one item per id. */
export function productStockMirrorResponse(value, ids, warehouseId) {
  if (!object(value) || value.scope !== 'product_stock_mirror' || value.data_mode !== 'origin_mirror' || value.origin !== 'origin' || value.read_only !== true
    || !Array.isArray(value.items) || value.items.length !== ids.length) bad();
  let warehouse = null;
  if (warehouseId === null) { if (value.warehouse !== null) bad(); }
  else {
    const w = value.warehouse;
    if (!object(w) || w.id !== warehouseId || typeof w.linked !== 'boolean' || (w.linked ? !sourceId(w.source_id) : w.source_id !== null)) bad();
    warehouse = { id: w.id, source_id: w.source_id, linked: w.linked };
  }
  const items = new Map();
  value.items.forEach((row, index) => {
    const safe = item(row);
    if (row.product_id !== ids[index] || (warehouse && !warehouse.linked && safe.state !== 'unlinked' && safe.state !== 'warehouse_unlinked')
      || (warehouse?.linked && (safe.state === 'warehouse_unlinked' || safe.state === 'multiple_warehouses' || (safe.state === 'observed' && safe.warehouse_source_id !== warehouse.source_id)))
      || (!warehouse && safe.state === 'warehouse_unlinked')) bad();
    items.set(row.product_id, safe);
  });
  return { summary: { origin: 'origin', status: 'ok', warehouse }, items };
}

/** Adds `origin_stock` to a product page or export body that is already validated. `read(args)` calls the summary RPC;
 * a refusal (403) or failure keeps the native list and says the Origin balance was not read: absence is never zero. */
export async function withProductStockMirror(body, warehouseId, read) {
  if (!body.stock_visible) return { ...body, origin_stock: null, items: body.items.map(row => ({ ...row, origin_stock: null })) };
  const ids = body.items.map(row => row.id);
  if (!ids.length) return { ...body, origin_stock: { origin: 'origin', status: 'ok', warehouse: null }, items: [] };
  if (ids.length > ORIGIN_STOCK_BATCH) bad();
  let result;
  try { result = productStockMirrorResponse(await read(productStockMirrorArgs(ids, warehouseId)), ids, warehouseId); }
  catch (error) {
    if (error instanceof ProductStockMirrorError) throw error;
    const status = error?.status === 403 ? 'forbidden' : 'unavailable';
    return { ...body, origin_stock: { origin: 'origin', status, warehouse: null }, items: body.items.map(row => ({ ...row, origin_stock: null })) };
  }
  return { ...body, origin_stock: result.summary, items: body.items.map(row => ({ ...row, origin_stock: result.items.get(row.id) })) };
}
