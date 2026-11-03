/** Estoque no padrão do Origin, onda C (migrations 181 and 183), routed through stock.mjs:
 * - GET /v1/estoque/depositos/opcoes: the light list behind every "Depósito" selector (no totals);
 * - GET /v1/estoque/fornecedores?q=: the "Fornecedor" filter of the dashboards (product suppliers, 119);
 * - GET /v1/estoque/transferencias/posicoes?origem=&destino=&produtos=: the grid of "Transferir estoque dos produtos selecionados";
 * - POST /v1/estoque/transferencias: that transfer, one command for up to 50 products;
 * - POST /v1/estoque/compras/{pedido}/estorno: Pedidos de compra > ⋮ "Estornar estoque", every active receipt in one command (225);
 * - GET /v1/estoque/produtos/localizacoes?ids=: the Localização of the products of a report page (260).
 * The saldo inicial of a new product (183) is posted through the product form route; its body and receipt are checked here.
 * Strict params and closed bodies, exact decimal strings (BigInt), projected and cross-checked responses. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY = /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const PRICE_INPUT = /^(0|[1-9][0-9]{0,13})(?:\.[0-9]{1,10})?$/;
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ELIGIBILITY = ['eligible', 'not_product', 'inactive', 'composition', 'no_unit', 'unit_mismatch'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const price = value => value === null || (typeof value === 'string' && PRICE.test(value));
const stored = value => typeof value === 'string' && STORED.test(value) && !/^-0\.0+$/.test(value);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
const priceUnits = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(10, '0')); };
const samePrice = (output, input) => input === null || input === undefined ? output === null : output !== null && priceUnits(output) === priceUnits(input);
export class StockSupplyError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockSupplyError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockSupplyError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };

export function stockSupplyRoute(path) {
  const purchase = /^\/v1\/estoque\/compras\/([0-9a-fA-F-]{36})\/estorno$/.exec(path);
  if (purchase) return uuid(purchase[1]) ? { type: 'purchase-reverse-all', id: purchase[1].toLowerCase() } : null;
  return { '/v1/estoque/depositos/opcoes': { type: 'warehouse-options' }, '/v1/estoque/fornecedores': { type: 'suppliers' },
    '/v1/estoque/transferencias/posicoes': { type: 'transfer-positions' }, '/v1/estoque/transferencias': { type: 'transfer-batch' },
    '/v1/estoque/produtos/localizacoes': { type: 'product-locations' } }[path] ?? null;
}
export const stockSupplyMethods = route => route?.type === 'transfer-batch' || route?.type === 'purchase-reverse-all' ? ['POST'] : route ? ['GET'] : null;
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 32768)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32768) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
const optionalPrice = value => value === undefined || value === null ? null : typeof value === 'string' && PRICE_INPUT.test(value) ? value : invalid();

export async function stockSupplyOperation(request, route, search) {
  if (route.type === 'warehouse-options') { params(search, []); return { type: route.type, rpc: 'erp_stock_warehouse_options', args: {} }; }
  if (route.type === 'suppliers') {
    params(search, ['q']); const query = search.get('q'); need(query === null || text(query, 120));
    return { type: route.type, rpc: 'erp_stock_suppliers', args: { p_query: query } };
  }
  if (route.type === 'product-locations') {
    params(search, ['ids']);
    const ids = (search.get('ids') ?? '').split(',');
    need(ids.length >= 1 && ids.length <= 100 && ids.every(uuid) && new Set(ids.map(id => id.toLowerCase())).size === ids.length);
    return { type: route.type, rpc: 'erp_stock_product_locations', args: { p_ids: ids.map(id => id.toLowerCase()) } };
  }
  if (route.type === 'transfer-positions') {
    params(search, ['origem', 'destino', 'produtos']);
    const source = search.get('origem'), destination = search.get('destino'), products = (search.get('produtos') ?? '').split(',');
    need(uuid(source) && (destination === null || (uuid(destination) && destination.toLowerCase() !== source.toLowerCase())) && products.length >= 1 && products.length <= 50 && products.every(uuid)
      && new Set(products.map(id => id.toLowerCase())).size === products.length);
    return { type: route.type, rpc: 'erp_stock_transfer_positions', args: { p_source_id: source.toLowerCase(), p_destination_id: destination?.toLowerCase() ?? null, p_product_ids: products.map(id => id.toLowerCase()) } };
  }
  if (search.size) invalid();
  const input = await readBody(request);
  if (route.type === 'purchase-reverse-all') {
    need(only(input, ['command_id', 'expected_version']) && uuid(input.command_id) && int(input.expected_version, 1, 2147483646));
    return { type: route.type, rpc: 'erp_stock_purchase_reverse_all', args: { p_command_id: input.command_id.toLowerCase(), p_document_id: route.id, p_expected_version: input.expected_version } };
  }
  need(only(input, ['command_id', 'source_id', 'destination_id', 'note', 'items']) && uuid(input.command_id) && uuid(input.source_id) && uuid(input.destination_id)
    && input.source_id.toLowerCase() !== input.destination_id.toLowerCase() && (input.note === undefined || input.note === null || text(input.note, 500))
    && Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 50);
  const items = input.items.map(item => {
    need(only(item, ['product_id', 'quantity', 'source_version', 'destination_version', 'unit_price', 'unit_cost', 'lot_id']) && uuid(item.product_id) && typeof item.quantity === 'string'
      && QUANTITY.test(item.quantity) && units(item.quantity) > 0n && int(item.source_version, 0, 2147483646) && int(item.destination_version, 0, 2147483646)
      && (item.lot_id === undefined || uuid(item.lot_id)));
    // 258: the Lote of the row is sent only when chosen, so a transfer without lots keeps the request (and its hash) of 183.
    return { product_id: item.product_id.toLowerCase(), quantity: item.quantity, source_version: item.source_version, destination_version: item.destination_version,
      unit_price: optionalPrice(item.unit_price), unit_cost: optionalPrice(item.unit_cost), ...(item.lot_id ? { lot_id: item.lot_id.toLowerCase() } : {}) };
  });
  need(new Set(items.map(item => item.product_id)).size === items.length);
  return { type: route.type, rpc: 'erp_stock_transfer_batch', args: { p_command_id: input.command_id.toLowerCase(), p_source_id: input.source_id.toLowerCase(),
    p_destination_id: input.destination_id.toLowerCase(), p_note: input.note ?? null, p_items: items } };
}

const warehouseRef = value => { need(exact(value, ['id', 'name', 'active', 'ignore_balance']) && uuid(value.id) && text(value.name, 200, 1) && typeof value.active === 'boolean' && typeof value.ignore_balance === 'boolean', upstream);
  return { id: value.id, name: value.name, active: value.active, ignore_balance: value.ignore_balance }; };
function transferReceipt(value, args) {
  const r = value.receipt;
  need(exact(r, ['command_id', 'source', 'destination', 'note', 'occurred_on', 'items', 'saved_at']) && r.command_id === args.p_command_id
    && exact(r.source, ['id', 'name']) && r.source.id === args.p_source_id && text(r.source.name, 200, 1) && exact(r.destination, ['id', 'name']) && r.destination.id === args.p_destination_id
    && text(r.destination.name, 200, 1) && text(r.note, 500, 1) && typeof r.occurred_on === 'string' && DATE.test(r.occurred_on) && instant(r.saved_at)
    && Array.isArray(r.items) && r.items.length === args.p_items.length, upstream);
  const requested = new Map(args.p_items.map(item => [item.product_id, item]));
  const items = r.items.map(item => {
    const asked = requested.get(item?.product_id);
    const lotted = asked?.lot_id !== undefined;
    need(exact(item, ['product_id', 'name', 'code', 'unit', 'quantity', 'movement_id', 'source_balance_after', 'destination_balance_after', 'unit_price', 'unit_cost', ...(lotted ? ['lot_id', 'lot_code'] : [])]) && asked !== undefined
      && (!lotted || (item.lot_id === asked.lot_id && text(item.lot_code, 60, 1)))
      && text(item.name, 200, 1) && optionalText(item.code, 100) && text(item.unit, 16, 1) && stored(item.quantity) && units(item.quantity) === units(asked.quantity) && uuid(item.movement_id)
      && stored(item.source_balance_after) && stored(item.destination_balance_after) && price(item.unit_price) && price(item.unit_cost)
      && (value.replayed || (samePrice(item.unit_price, asked.unit_price) && samePrice(item.unit_cost, asked.unit_cost))), upstream);
    requested.delete(item.product_id);
    return { product_id: item.product_id, name: item.name, code: item.code, unit: item.unit, quantity: item.quantity, movement_id: item.movement_id,
      source_balance_after: item.source_balance_after, destination_balance_after: item.destination_balance_after, unit_price: item.unit_price, unit_cost: item.unit_cost,
      ...(lotted ? { lot_id: item.lot_id, lot_code: item.lot_code } : {}) };
  });
  need(requested.size === 0 && new Set(items.map(item => item.movement_id)).size === items.length, upstream);
  return { command_id: r.command_id, source: { id: r.source.id, name: r.source.name }, destination: { id: r.destination.id, name: r.destination.name }, note: r.note, occurred_on: r.occurred_on, items, saved_at: r.saved_at };
}

export function stockSupplyResponse(value, operation) {
  need(object(value) && value.data_mode === 'erp_native', upstream);
  const args = operation.args;
  if (operation.type === 'warehouse-options') {
    need(value.scope === 'stock_warehouse_options' && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(500, value.total), upstream);
    const items = value.items.map(item => { need(exact(item, ['id', 'name', 'active', 'is_default', 'ignore_balance']) && uuid(item.id) && text(item.name, 200, 1) && typeof item.active === 'boolean'
      && typeof item.is_default === 'boolean' && typeof item.ignore_balance === 'boolean' && (!item.is_default || item.active), upstream);
      return { id: item.id, name: item.name, active: item.active, is_default: item.is_default, ignore_balance: item.ignore_balance }; });
    need(new Set(items.map(item => item.id)).size === items.length && items.filter(item => item.is_default).length <= 1, upstream);
    return { items, total: value.total, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'suppliers') {
    need(value.scope === 'stock_suppliers' && value.query === args.p_query && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(50, value.total), upstream);
    const items = value.items.map(item => { need(exact(item, ['id', 'name', 'code', 'active', 'products']) && uuid(item.id) && text(item.name, 200, 1) && optionalText(item.code, 100)
      && typeof item.active === 'boolean' && int(item.products), upstream);
      return { id: item.id, name: item.name, code: item.code, active: item.active, products: item.products }; });
    need(new Set(items.map(item => item.id)).size === items.length, upstream);
    return { items, total: value.total, query: value.query, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'product-locations') {
    need(value.scope === 'stock_product_locations' && Array.isArray(value.items) && value.items.length <= args.p_ids.length, upstream);
    const items = value.items.map(item => { need(exact(item, ['product_id', 'location']) && args.p_ids.includes(item.product_id) && (item.location === null || text(item.location, 100, 1)), upstream);
      return { product_id: item.product_id, location: item.location }; });
    need(new Set(items.map(item => item.product_id)).size === items.length, upstream);
    return { items, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'transfer-positions') {
    need(value.scope === 'stock_transfer_positions' && typeof value.show_unit_price === 'boolean' && Array.isArray(value.items) && value.items.length === args.p_product_ids.length, upstream);
    const source = warehouseRef(value.source), destination = args.p_destination_id === null ? (need(value.destination === null, upstream), null) : warehouseRef(value.destination);
    need(source.id === args.p_source_id && (destination === null || destination.id === args.p_destination_id), upstream);
    const items = value.items.map(item => {
      // 258: the lots of the row (a database still on 183 has none).
      const lotted = object(item) && Object.hasOwn(item, 'lot_control');
      need(exact(item, ['product_id', 'name', 'code', 'unit', 'kind', 'format', 'active', 'eligibility', 'source', 'destination', 'suggested_price', 'suggested_cost', ...(lotted ? ['lot_control', 'lots'] : [])])
        && (!lotted || (typeof item.lot_control === 'boolean' && Array.isArray(item.lots) && item.lots.length <= 50 && (item.lot_control || item.lots.length === 0)
          && item.lots.every(lot => exact(lot, ['id', 'code', 'expires_on', 'quantity']) && uuid(lot.id) && text(lot.code, 60, 1) && (lot.expires_on === null || (typeof lot.expires_on === 'string' && DATE.test(lot.expires_on)))
            && stored(lot.quantity) && units(lot.quantity) > 0n) && new Set(item.lots.map(lot => lot.id)).size === item.lots.length))
        && args.p_product_ids.includes(item.product_id) && text(item.name, 200, 1) && optionalText(item.code, 100) && optionalText(item.unit, 16) && (item.kind === null || ['P', 'S', 'N'].includes(item.kind))
        && (item.format === null || ['S', 'V', 'E'].includes(item.format)) && typeof item.active === 'boolean' && ELIGIBILITY.includes(item.eligibility)
        && (item.eligibility !== 'eligible' || (item.kind === 'P' && item.active && item.unit !== null && !['V', 'E'].includes(item.format)))
        && exact(item.source, ['quantity', 'version', 'reserved']) && stored(item.source.quantity) && int(item.source.version) && stored(item.source.reserved) && !item.source.reserved.startsWith('-')
        && (destination === null ? item.destination === null : exact(item.destination, ['quantity', 'version']) && stored(item.destination.quantity) && int(item.destination.version))
        && price(item.suggested_price) && price(item.suggested_cost), upstream);
      return { product_id: item.product_id, name: item.name, code: item.code, unit: item.unit, kind: item.kind, format: item.format, active: item.active, eligibility: item.eligibility,
        source: { quantity: item.source.quantity, version: item.source.version, reserved: item.source.reserved },
        destination: destination === null ? null : { quantity: item.destination.quantity, version: item.destination.version }, suggested_price: item.suggested_price, suggested_cost: item.suggested_cost,
        lot_control: lotted ? item.lot_control : false, lots: lotted ? item.lots.map(lot => ({ id: lot.id, code: lot.code, expires_on: lot.expires_on, quantity: lot.quantity })) : [] };
    });
    need(new Set(items.map(item => item.product_id)).size === items.length, upstream);
    return { source, destination, show_unit_price: value.show_unit_price, items, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'purchase-reverse-all') {
    need(exact(value, ['scope', 'data_mode', 'command_id', 'document_id', 'document_number', 'document_version', 'occurred_on', 'reason', 'reversed', 'replayed']) && value.scope === 'stock_purchase_reverse_all'
      && value.command_id === args.p_command_id && value.document_id === args.p_document_id && typeof value.document_number === 'string' && /^[1-9]\d{0,9}$/.test(value.document_number)
      && int(value.document_version, 2) && typeof value.occurred_on === 'string' && DATE.test(value.occurred_on) && value.reason === `Estorno do pedido de compra ${value.document_number}`
      && typeof value.replayed === 'boolean' && Array.isArray(value.reversed) && value.reversed.length >= 1 && value.reversed.length <= 250
      && (value.replayed || value.document_version === args.p_expected_version + value.reversed.length), upstream);
    const reversed = value.reversed.map(item => { need(exact(item, ['receipt_id', 'movement_id', 'positions']) && uuid(item.receipt_id) && uuid(item.movement_id) && int(item.positions, 1, 100), upstream);
      return { receipt_id: item.receipt_id, movement_id: item.movement_id, positions: item.positions }; });
    need(new Set(reversed.map(item => item.receipt_id)).size === reversed.length, upstream);
    return { document_id: value.document_id, document_number: value.document_number, document_version: value.document_version, occurred_on: value.occurred_on, reason: value.reason,
      reversed, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
  }
  need(value.scope === 'stock_transfer_batch' && typeof value.replayed === 'boolean', upstream);
  return { receipt: transferReceipt(value, args), replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}

// ---- 183: "Saldo inicial" of the product form (Cadastros > Produtos > Incluir), sent with the new product's data ----
/** Validates `initial_balance` of POST /v1/cadastros/products/completo and returns the extra RPC arguments of erp_stock_product_create. */
export function initialBalanceArgs(value) {
  if (!only(value, ['warehouse_id', 'quantity', 'unit_price', 'unit_cost', 'note']) || !uuid(value.warehouse_id) || typeof value.quantity !== 'string' || !QUANTITY.test(value.quantity)
    || units(value.quantity) === 0n || (value.note !== undefined && value.note !== null && !text(value.note, 500))) invalid();
  return { p_warehouse_id: value.warehouse_id.toLowerCase(), p_quantity: value.quantity, p_unit_price: optionalPrice(value.unit_price), p_unit_cost: optionalPrice(value.unit_cost), p_note: value.note ?? null };
}
/** Checks the receipt of the entry posted with the new product (the product itself is checked by the product route). */
export function initialBalanceDto(value, args, productId, replayed) {
  if (!exact(value, ['command_id', 'warehouse_id', 'warehouse_name', 'quantity', 'movement_id', 'occurred_on', 'unit_price', 'unit_cost', 'note']) || value.command_id !== args.p_command_id
    || value.warehouse_id !== args.p_warehouse_id || !text(value.warehouse_name, 200, 1) || !stored(value.quantity) || units(value.quantity) !== units(args.p_quantity) || !uuid(value.movement_id)
    || typeof value.occurred_on !== 'string' || !DATE.test(value.occurred_on) || !price(value.unit_price) || !price(value.unit_cost) || !text(value.note, 500, 1) || !uuid(productId)
    || (!replayed && (!samePrice(value.unit_price, args.p_unit_price) || !samePrice(value.unit_cost, args.p_unit_cost)))) upstream();
  return { command_id: value.command_id, warehouse_id: value.warehouse_id, warehouse_name: value.warehouse_name, quantity: value.quantity, movement_id: value.movement_id,
    occurred_on: value.occurred_on, unit_price: value.unit_price, unit_cost: value.unit_cost, note: value.note };
}
