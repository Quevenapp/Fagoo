/** Controle de estoque and Depósitos like Origin (migration 105): launches, amendments, totals, reservations and warehouses.
 * Strict params and bodies, exact decimal strings, projected and cross-checked responses. Routed through stock.mjs. */
// 258: the Lote of the Novo Lançamento and of the Transferência entre depósitos.
import { launchLotInput, launchLotDto } from './stock-lots.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY = /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const SIGNED_QUANTITY = /^-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const TOTAL = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{6}$/;
const MONEY = /^-?(0|[1-9][0-9]{0,35})\.[0-9]{2}$/;
const PRICE_INPUT = /^(0|[1-9][0-9]{0,13})(?:\.[0-9]{1,10})?$/;
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const has = (value, keys) => object(value) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const negativeZero = value => /^-0(?:\.0+)?$/.test(value);
// SQL btrim() removes only spaces; the note it stores is compared with the same rule.
const spaces = value => value.replace(/^ +| +$/g, '');
const stored = value => typeof value === 'string' && STORED.test(value) && !negativeZero(value);
const price = value => value === null || (typeof value === 'string' && PRICE.test(value));
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
// Exact comparison of decimal strings in units of 10^-6 (no binary floating point).
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
const priceUnits = value => value === null ? null : (([whole, fraction = '']) => BigInt(whole + fraction.padEnd(10, '0')))(value.split('.'));
export class StockOriginError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockOriginError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockOriginError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };

export function stockOriginRoute(path) {
  if (path === '/v1/estoque/lancamentos') return { type: 'launch' };
  if (path === '/v1/estoque/reservas') return { type: 'reservations' };
  if (path === '/v1/estoque/totais') return { type: 'totals' };
  if (path === '/v1/estoque/depositos') return { type: 'warehouses' };
  // 145: preferences and suggested price of the manual lançamento.
  if (path === '/v1/estoque/sugestao') return { type: 'launch-context' };
  let match = /^\/v1\/estoque\/movimentos\/([0-9a-fA-F-]{36})$/.exec(path);
  if (match && uuid(match[1])) return { type: 'amend', id: match[1].toLowerCase() };
  match = /^\/v1\/estoque\/depositos\/([0-9a-fA-F-]{36})(\/padrao)?$/.exec(path);
  if (match && uuid(match[1])) return { type: match[2] ? 'warehouse-default' : 'warehouse', id: match[1].toLowerCase() };
  return null;
}
export function stockOriginMethods(route) {
  return { launch: ['POST'], amend: ['PATCH'], reservations: ['GET'], totals: ['GET'], 'launch-context': ['GET'], warehouses: ['GET', 'POST'], warehouse: ['PATCH'], 'warehouse-default': ['POST'] }[route?.type] ?? null;
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 16384)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, body = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 16384) invalid(); body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result;
  } catch { return invalid(); }
  finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
const optionalPrice = value => value === undefined || value === null ? null : (typeof value === 'string' && PRICE_INPUT.test(value) ? value : invalid());
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };

export async function stockOriginOperation(request, route, search) {
  if (request.method === 'GET') {
    if (route.type === 'reservations') {
      params(search, ['product_id', 'warehouse_id']);
      const product = search.get('product_id'), warehouse = search.get('warehouse_id');
      need(uuid(product) && (warehouse === null || uuid(warehouse)));
      return { type: 'reservations', rpc: 'erp_stock_product_reservations', args: { p_product_id: product.toLowerCase(), p_warehouse_id: warehouse?.toLowerCase() ?? null } };
    }
    if (route.type === 'launch-context') {
      params(search, ['product_id']);
      const product = search.get('product_id'); need(uuid(product));
      return { type: 'launch-context', rpc: 'erp_stock_launch_context', args: { p_product_id: product.toLowerCase() } };
    }
    if (route.type === 'totals') {
      params(search, ['warehouse_id']);
      const warehouse = search.get('warehouse_id'); need(warehouse === null || uuid(warehouse));
      return { type: 'totals', rpc: 'erp_stock_totals', args: { p_warehouse_id: warehouse?.toLowerCase() ?? null } };
    }
    params(search, ['q', 'situacao', 'pagina']);
    const query = search.get('q'), state = search.get('situacao'), page = search.get('pagina') ?? '1';
    need((query === null || text(query, 120)) && (state === null || ['ativos', 'inativos'].includes(state)) && /^[1-9][0-9]{0,4}$/.test(page) && Number(page) <= 100000);
    return { type: 'warehouses', rpc: 'erp_stock_warehouses', args: { p_query: query, p_active: state === null ? null : state === 'ativos', p_page: Number(page), p_size: 100 } };
  }
  if (search.size) invalid();
  const input = await readBody(request);
  need(uuid(input.command_id));
  const command = input.command_id.toLowerCase();
  if (route.type === 'launch') {
    need(only(input, ['command_id', 'kind', 'product_id', 'warehouse_id', 'quantity', 'expected_version', 'unit_price', 'unit_cost', 'note', 'destination_id', 'destination_version', 'lot'])
      && ['receipt', 'issue', 'balance', 'transfer'].includes(input.kind) && uuid(input.product_id) && uuid(input.warehouse_id) && int(input.expected_version, 0, 2147483646)
      && typeof input.quantity === 'string' && (input.kind === 'balance' ? SIGNED_QUANTITY : QUANTITY).test(input.quantity) && !negativeZero(input.quantity)
      && (input.kind === 'balance' || units(input.quantity) !== 0n) && (input.note === undefined || input.note === null || text(input.note, 500))
      && (input.kind === 'transfer' ? uuid(input.destination_id) && int(input.destination_version, 0, 2147483646) && input.destination_id.toLowerCase() !== input.warehouse_id.toLowerCase()
        : input.destination_id === undefined && input.destination_version === undefined)
      && !(input.kind === 'issue' && input.unit_cost !== undefined && input.unit_cost !== null)
      // 258: a lot is never negative, so the Balanço of a lot is its new quantity (zero or more).
      && (input.lot === undefined || (object(input.lot) && !(input.kind === 'balance' && input.quantity.startsWith('-')))));
    const lot = input.lot === undefined ? null : launchLotInput(input.lot, input.kind);
    return { type: 'launch', rpc: lot ? 'erp_stock_lot_launch' : 'erp_stock_launch', args: { p_command_id: command, p_kind: input.kind, p_product_id: input.product_id.toLowerCase(), p_warehouse_id: input.warehouse_id.toLowerCase(),
      p_quantity: input.quantity, p_expected_version: input.expected_version, p_unit_price: optionalPrice(input.unit_price), p_unit_cost: optionalPrice(input.unit_cost),
      p_note: input.note ?? null, p_destination_id: input.kind === 'transfer' ? input.destination_id.toLowerCase() : null, p_destination_version: input.kind === 'transfer' ? input.destination_version : null,
      ...(lot ? { p_lot: lot } : {}) } };
  }
  if (route.type === 'amend') {
    need(only(input, ['command_id', 'product_id', 'expected_revision', 'unit_price', 'unit_cost', 'note']) && has(input, ['product_id', 'expected_revision', 'note'])
      && uuid(input.product_id) && int(input.expected_revision, 0, 2147483646) && text(input.note, 500));
    return { type: 'amend', rpc: 'erp_stock_movement_amend', args: { p_command_id: command, p_movement_id: route.id, p_product_id: input.product_id.toLowerCase(),
      p_expected_revision: input.expected_revision, p_unit_price: optionalPrice(input.unit_price), p_unit_cost: optionalPrice(input.unit_cost), p_note: input.note } };
  }
  if (route.type === 'warehouse-default') {
    need(only(input, ['command_id', 'expected_version']) && int(input.expected_version, 0, 2147483646));
    return { type: 'warehouse-default', rpc: 'erp_stock_warehouse_set_default', args: { p_command_id: command, p_warehouse_id: route.id, p_expected_version: input.expected_version } };
  }
  const create = route.type === 'warehouses';
  need(only(input, create ? ['command_id', 'name', 'ignore_balance'] : ['command_id', 'name', 'ignore_balance', 'expected_version', 'expected_setting_version'])
    && typeof input.name === 'string' && input.name === input.name.trim() && text(input.name, 200, 1) && typeof input.ignore_balance === 'boolean'
    && (create || (int(input.expected_version, 1, 2147483646) && int(input.expected_setting_version, 0, 2147483646))));
  return { type: 'warehouse-save', rpc: 'erp_stock_warehouse_save', args: { p_command_id: command, p_warehouse_id: create ? null : route.id,
    p_expected_version: create ? 0 : input.expected_version, p_expected_setting_version: create ? 0 : input.expected_setting_version, p_name: input.name, p_ignore_balance: input.ignore_balance } };
}

function movementDto(value) {
  need(object(value) && uuid(value.id) && ['receipt', 'issue', 'adjustment', 'transfer'].includes(value.kind) && typeof value.occurred_on === 'string' && DATE.test(value.occurred_on)
    && text(value.reason, 500, 3) && value.reference === null && instant(value.created_at) && value.reverses_id === null && value.reversed_by === null
    && Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 2, upstream);
  const items = value.items.map(item => {
    need(object(item) && uuid(item.product_id) && uuid(item.warehouse_id) && typeof item.quantity === 'string' && SIGNED_QUANTITY.test(item.quantity) && !negativeZero(item.quantity)
      && units(item.quantity) !== 0n && stored(item.balance_after) && text(item.unit, 16, 1) && int(item.balance_version, 1), upstream);
    return { product_id: item.product_id, warehouse_id: item.warehouse_id, quantity: item.quantity, unit: item.unit, balance_after: item.balance_after, balance_version: item.balance_version };
  });
  return { id: value.id, kind: value.kind, occurred_on: value.occurred_on, reason: value.reason, reference: null, created_at: value.created_at, reverses_id: null, reversed_by: null, items };
}
function detailDto(value, revision) {
  need(only(value, ['revision', 'unit_price', 'unit_cost', 'note']) && value.revision === revision && price(value.unit_price) && price(value.unit_cost) && text(value.note, 500), upstream);
  return { revision: value.revision, unit_price: value.unit_price, unit_cost: value.unit_cost, note: value.note };
}
const samePrice = (output, input) => input === null ? output === null : output !== null && priceUnits(output) === priceUnits(input);
function launchResponse(value, args) {
  need(object(value) && value.scope === 'stock_launch' && value.data_mode === 'erp_native' && typeof value.replayed === 'boolean' && value.kind === args.p_kind
    && typeof value.occurred_on === 'string' && DATE.test(value.occurred_on), upstream);
  const movement = movementDto(value.movement), detail = detailDto(value.detail, 1);
  const note = spaces(args.p_note ?? '') || (args.p_kind === 'transfer' ? 'Transferência' : 'Lançamento manual');
  need(movement.occurred_on === value.occurred_on && samePrice(detail.unit_price, args.p_unit_price) && samePrice(detail.unit_cost, args.p_unit_cost) && detail.note === note
    && movement.items.every(item => item.product_id === args.p_product_id), upstream);
  const q = units(args.p_quantity), [first, second] = movement.items;
  let balance = null;
  if (args.p_kind === 'balance') {
    // 258: with a Lote the quantity is the lot's new quantity; the position moves by the same difference (launchLotDto checks it).
    need(movement.kind === 'adjustment' && movement.items.length === 1 && first.warehouse_id === args.p_warehouse_id && only(value.balance, ['counted', 'previous', 'warehouse_id', 'source'])
      && stored(value.balance.counted) && stored(value.balance.previous) && value.balance.warehouse_id === args.p_warehouse_id && value.balance.source === 'launch'
      && units(first.quantity) === units(value.balance.counted) - units(value.balance.previous) && units(first.balance_after) === units(value.balance.counted)
      && (args.p_lot !== undefined || units(value.balance.counted) === q), upstream);
    balance = { counted: value.balance.counted, previous: value.balance.previous, warehouse_id: value.balance.warehouse_id, source: 'launch' };
  } else if (args.p_kind === 'transfer') {
    need(value.balance === null && movement.kind === 'transfer' && movement.items.length === 2, upstream);
    const out = movement.items.find(item => item.warehouse_id === args.p_warehouse_id), into = movement.items.find(item => item.warehouse_id === args.p_destination_id);
    need(out && into && out !== into && units(out.quantity) === -q && units(into.quantity) === q, upstream);
  } else {
    need(value.balance === null && movement.kind === args.p_kind && movement.items.length === 1 && second === undefined && first.warehouse_id === args.p_warehouse_id
      && units(first.quantity) === (args.p_kind === 'issue' ? -q : q), upstream);
  }
  if (args.p_lot === undefined) {
    need(value.lot === undefined, upstream);
    return { scope: 'stock_launch', kind: value.kind, occurred_on: value.occurred_on, movement, detail, balance, replayed: value.replayed, data_mode: 'erp_native' };
  }
  return { scope: 'stock_launch', kind: value.kind, occurred_on: value.occurred_on, movement, detail, balance, lot: launchLotDto(value.lot, args, movement, balance), replayed: value.replayed, data_mode: 'erp_native' };
}
function amendResponse(value, args) {
  need(object(value) && value.scope === 'stock_amend' && value.data_mode === 'erp_native' && typeof value.replayed === 'boolean'
    && value.movement_id === args.p_movement_id && value.product_id === args.p_product_id && instant(value.amended_at) && object(value.from), upstream);
  const detail = detailDto(value.detail, args.p_expected_revision + 1);
  need(only(value.from, ['revision', 'unit_price', 'unit_cost', 'note']) && value.from.revision === args.p_expected_revision && price(value.from.unit_price) && price(value.from.unit_cost)
    && text(value.from.note, 500) && samePrice(detail.unit_price, args.p_unit_price) && samePrice(detail.unit_cost, args.p_unit_cost) && detail.note === spaces(args.p_note), upstream);
  return { scope: 'stock_amend', movement_id: value.movement_id, product_id: value.product_id, from: { revision: value.from.revision, unit_price: value.from.unit_price, unit_cost: value.from.unit_cost, note: value.from.note },
    detail, amended_at: value.amended_at, replayed: value.replayed, data_mode: 'erp_native' };
}
// 145: "Reserva de estoque" of Preferências > Suprimentos > Estoque, mapped to Brufap sales order situations.
const RESERVE_STATUSES = ['draft', 'open', 'verified', 'in_progress', 'fulfilled', 'cancelled'];
export function reservationPolicyDto(value, withQuantity = false) {
  need(object(value) && typeof value.by_situation === 'boolean' && typeof value.by_warehouse === 'boolean' && Array.isArray(value.statuses)
    && value.statuses.every(status => RESERVE_STATUSES.includes(status)) && new Set(value.statuses).size === value.statuses.length
    && value.statuses.every((status, index) => index === 0 || RESERVE_STATUSES.indexOf(value.statuses[index - 1]) < RESERVE_STATUSES.indexOf(status))
    && (value.by_situation || value.statuses.length === 0)
    && (!withQuantity || (stored(value.unassigned_quantity) && !value.unassigned_quantity.startsWith('-') && (units(value.unassigned_quantity) === 0n || value.by_situation))), upstream);
  // 277: custom situations (situações personalizadas) chosen in the option; a database still on 266 sends none.
  const situations = value.situation_ids === undefined ? [] : value.situation_ids;
  need(Array.isArray(situations) && situations.length <= 30 && situations.every(uuid) && new Set(situations).size === situations.length
    && (value.by_situation || situations.length === 0), upstream);
  return { by_situation: value.by_situation, by_warehouse: value.by_warehouse, statuses: [...value.statuses], ...(value.situation_ids === undefined ? {} : { situation_ids: [...situations] }),
    ...(withQuantity ? { unassigned_quantity: value.unassigned_quantity } : {}) };
}
function reservationsResponse(value, args) {
  need(object(value) && value.scope === 'stock_product_reservations' && value.data_mode === 'erp_native' && value.product_id === args.p_product_id
    && value.warehouse_id === args.p_warehouse_id && int(value.total) && typeof value.quantity === 'string' && TOTAL.test(value.quantity) && !value.quantity.startsWith('-')
    && Array.isArray(value.items) && value.items.length === Math.min(100, value.total), upstream);
  const reservation = reservationPolicyDto(value.reservation);
  let sum = 0n;
  const items = value.items.map(item => {
    // An explicit reservation (070) has its id, warehouse and time; a reservation by the sale situation (145) has none of them,
    // and no warehouse when it counts for every considered warehouse.
    const explicit = item?.source === 'reservation';
    // 277: the custom situation of the pedido (none from a database still on 266); a pedido reserved by a chosen custom situation
    // may have a base status that is not chosen.
    const situationId = item?.situation_id === undefined ? null : item.situation_id, situationName = item?.situation_name === undefined ? null : item.situation_name;
    need(object(item) && (situationId === null ? situationName === null : !explicit && uuid(situationId) && text(situationName, 40, 1)), upstream);
    need(object(item) && ['reservation', 'situation'].includes(item.source) && (explicit ? uuid(item.reservation_id) && uuid(item.warehouse_id) && instant(item.reserved_at)
        : item.reservation_id === null && item.reserved_at === null && (item.warehouse_id === null || uuid(item.warehouse_id)) && reservation.by_situation
          && (reservation.statuses.includes(item.status) || (situationId !== null && (reservation.situation_ids ?? []).includes(situationId))))
      && uuid(item.document_id) && typeof item.document_number === 'string' && /^[1-9][0-9]{0,9}$/.test(item.document_number)
      && text(item.status, 40, 1) && (item.contact_name === null || text(item.contact_name, 200)) && typeof item.warehouse_ignored === 'boolean' && (item.warehouse_id !== null || !item.warehouse_ignored)
      && (args.p_warehouse_id === null || item.warehouse_id === args.p_warehouse_id || (!explicit && item.warehouse_id === null)) && stored(item.quantity) && units(item.quantity) > 0n && text(item.unit, 16, 1), upstream);
    sum += units(item.quantity);
    return { reservation_id: item.reservation_id, source: item.source, document_id: item.document_id, document_number: item.document_number, status: item.status, contact_name: item.contact_name,
      warehouse_id: item.warehouse_id, warehouse_ignored: item.warehouse_ignored, quantity: item.quantity, unit: item.unit, reserved_at: item.reserved_at,
      situation_id: situationId, situation_name: situationName };
  });
  need(value.total > 100 || sum === units(value.quantity), upstream);
  return { product_id: value.product_id, warehouse_id: value.warehouse_id, items, total: value.total, quantity: value.quantity, reservation, scope: value.scope, data_mode: 'erp_native' };
}
const PRICE_TYPES = ['ultima_compra', 'compra_fornecedor', 'custo_fornecedor'], COST_BASES = ['preco_compra', 'custo_lancamento'];
function launchContextResponse(value, args) {
  need(object(value) && value.scope === 'stock_launch_context' && value.data_mode === 'erp_native' && value.product_id === args.p_product_id && object(value.settings)
    && only(value.settings, ['show_unit_price', 'price_type', 'consider_balances', 'average_cost_base']) && typeof value.settings.show_unit_price === 'boolean'
    && PRICE_TYPES.includes(value.settings.price_type) && typeof value.settings.consider_balances === 'boolean' && COST_BASES.includes(value.settings.average_cost_base)
    && price(value.average_cost) && price(value.sale_price), upstream);
  let last = null;
  if (value.last_purchase !== null) {
    const l = value.last_purchase;
    // Only "Preço da última compra" suggests a price; a Balanço counts only when the company considers it.
    need(value.settings.price_type === 'ultima_compra' && only(l, ['unit_price', 'unit_cost', 'occurred_on', 'movement_id', 'source']) && price(l.unit_price) && l.unit_price !== null && price(l.unit_cost)
      && typeof l.occurred_on === 'string' && DATE.test(l.occurred_on) && uuid(l.movement_id) && ['manual', 'purchase_order', 'balance'].includes(l.source)
      && (l.source !== 'balance' || value.settings.consider_balances), upstream);
    last = { unit_price: l.unit_price, unit_cost: l.unit_cost, occurred_on: l.occurred_on, movement_id: l.movement_id, source: l.source };
  }
  // 181: the default supplier of the product (aba Fornecedores, 119) for "Preço de compra/custo do fornecedor padrão"; a database
  // still on 145 has no such field (no supplier).
  let supplier = null;
  if (value.default_supplier !== undefined && value.default_supplier !== null) {
    const s = value.default_supplier;
    need(only(s, ['supplier_id', 'supplier_name', 'code', 'purchase_price', 'cost_price']) && uuid(s.supplier_id) && text(s.supplier_name, 200, 1) && (s.code === null || text(s.code, 60))
      && price(s.purchase_price) && price(s.cost_price), upstream);
    supplier = { supplier_id: s.supplier_id, supplier_name: s.supplier_name, code: s.code, purchase_price: s.purchase_price, cost_price: s.cost_price };
  }
  // 277: "Número de casas decimais no preço nas entradas" (Preferências › Empresa › Geral) for the Entrada and the Balanço; a database
  // still on 266 has no such field (the stored ten).
  let decimals = 10;
  if (value.price_decimals !== undefined) {
    need(only(value.price_decimals, ['entry']) && int(value.price_decimals.entry, 0, 10), upstream);
    decimals = value.price_decimals.entry;
  }
  return { product_id: value.product_id, settings: { show_unit_price: value.settings.show_unit_price, price_type: value.settings.price_type, consider_balances: value.settings.consider_balances,
    average_cost_base: value.settings.average_cost_base }, last_purchase: last, average_cost: value.average_cost, sale_price: value.sale_price, default_supplier: supplier,
    price_decimals: { entry: decimals }, scope: value.scope, data_mode: 'erp_native' };
}
function optionDto(item) {
  need(object(item) && uuid(item.id) && text(item.name, 200, 1) && typeof item.active === 'boolean' && typeof item.is_default === 'boolean' && typeof item.ignore_balance === 'boolean', upstream);
  return { id: item.id, name: item.name, active: item.active, is_default: item.is_default, ignore_balance: item.ignore_balance };
}
function totalsResponse(value, args) {
  need(object(value) && value.scope === 'stock_totals' && value.data_mode === 'erp_native' && value.warehouse_id === args.p_warehouse_id && typeof value.quantity === 'string' && TOTAL.test(value.quantity)
    && !negativeZero(value.quantity) && typeof value.sale_value === 'string' && MONEY.test(value.sale_value) && !/^-0\.00$/.test(value.sale_value) && int(value.unpriced_products) && int(value.ignored_warehouses)
    && Array.isArray(value.warehouses) && value.warehouses.length <= 1000
    // 145: Valor de Custo do Estoque (quantity × custo médio), purchase data shown only to readers of purchase orders.
    && typeof value.cost_visible === 'boolean' && COST_BASES.includes(value.cost_basis)
    && (value.cost_visible ? typeof value.cost_value === 'string' && MONEY.test(value.cost_value) && !/^-0\.00$/.test(value.cost_value) && int(value.uncosted_products)
      : value.cost_value === null && value.uncosted_products === null), upstream);
  const warehouses = value.warehouses.map(optionDto);
  need(new Set(warehouses.map(item => item.id)).size === warehouses.length && warehouses.filter(item => item.is_default).length <= 1
    && warehouses.filter(item => item.is_default).every(item => item.active) && warehouses.filter(item => item.ignore_balance).length === value.ignored_warehouses
    && (args.p_warehouse_id === null || warehouses.some(item => item.id === args.p_warehouse_id)), upstream);
  return { warehouse_id: value.warehouse_id, quantity: value.quantity, sale_value: value.sale_value, unpriced_products: value.unpriced_products, ignored_warehouses: value.ignored_warehouses,
    cost_visible: value.cost_visible, cost_value: value.cost_value, uncosted_products: value.uncosted_products, cost_basis: value.cost_basis, warehouses, scope: value.scope, data_mode: 'erp_native' };
}
function warehouseDto(item) {
  need(object(item) && uuid(item.id) && text(item.name, 200, 1) && typeof item.active === 'boolean' && int(item.version, 1) && typeof item.is_default === 'boolean'
    && typeof item.ignore_balance === 'boolean' && int(item.setting_version) && (!item.is_default || item.active) && (item.setting_version > 0 || !item.ignore_balance), upstream);
  return { id: item.id, name: item.name, active: item.active, version: item.version, is_default: item.is_default, ignore_balance: item.ignore_balance, setting_version: item.setting_version };
}
function warehousesResponse(value, args) {
  need(object(value) && value.scope === 'stock_warehouses' && value.data_mode === 'erp_native' && value.page === args.p_page && value.size === args.p_size && int(value.total)
    && Array.isArray(value.items) && value.items.length === Math.max(0, Math.min(args.p_size, value.total - (args.p_page - 1) * args.p_size)) && typeof value.can_manage === 'boolean'
    && only(value.default, ['warehouse_id', 'version']) && (value.default.warehouse_id === null || uuid(value.default.warehouse_id)) && int(value.default.version)
    && (value.default.version === 0) === (value.default.warehouse_id === null), upstream);
  const items = value.items.map(warehouseDto);
  need(new Set(items.map(item => item.id)).size === items.length && items.every(item => item.is_default === (item.id === value.default.warehouse_id))
    && (args.p_active === null || items.every(item => item.active === args.p_active))
    && (!args.p_query?.trim() || items.every(item => fold(item.name).includes(fold(args.p_query.trim())))), upstream);
  return { items, page: value.page, size: value.size, total: value.total, default: { warehouse_id: value.default.warehouse_id, version: value.default.version }, can_manage: value.can_manage,
    scope: value.scope, data_mode: 'erp_native' };
}
// Same accent folding as erp_catalog.fold (096) for the response cross-check.
const FROM = 'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñÝŸýÿ', TO = 'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYYyy';
const fold = value => [...value].map(char => { const index = FROM.indexOf(char); return index < 0 ? char : TO[index]; }).join('').toLowerCase();
function warehouseSaveResponse(value, args, action) {
  need(object(value) && value.scope === 'stock_warehouse' && value.data_mode === 'erp_native' && typeof value.replayed === 'boolean' && object(value.receipt)
    && value.receipt.command_id === args.p_command_id && value.receipt.action === action && instant(value.receipt.saved_at), upstream);
  const warehouse = warehouseDto(value.warehouse), receipt = value.receipt;
  if (action === 'save') {
    need(only(receipt, ['command_id', 'action', 'created', 'catalog_changed', 'setting_changed', 'from', 'to', 'saved_at']) && receipt.created === (args.p_warehouse_id === null)
      && typeof receipt.catalog_changed === 'boolean' && typeof receipt.setting_changed === 'boolean' && only(receipt.from, ['ignore_balance']) && only(receipt.to, ['ignore_balance'])
      && typeof receipt.from.ignore_balance === 'boolean' && receipt.to.ignore_balance === args.p_ignore_balance && receipt.setting_changed === (receipt.from.ignore_balance !== receipt.to.ignore_balance)
      && (args.p_warehouse_id === null || warehouse.id === args.p_warehouse_id) && (value.replayed || (warehouse.name === args.p_name && warehouse.ignore_balance === args.p_ignore_balance)), upstream);
    return { receipt: { command_id: receipt.command_id, action, created: receipt.created, catalog_changed: receipt.catalog_changed, setting_changed: receipt.setting_changed,
      from: { ignore_balance: receipt.from.ignore_balance }, to: { ignore_balance: receipt.to.ignore_balance }, saved_at: receipt.saved_at }, warehouse, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
  }
  need(only(receipt, ['command_id', 'action', 'from', 'to', 'saved_at']) && only(receipt.from, ['warehouse_id', 'version']) && only(receipt.to, ['warehouse_id', 'version'])
    && (receipt.from.warehouse_id === null || uuid(receipt.from.warehouse_id)) && receipt.from.version === args.p_expected_version && receipt.to.warehouse_id === args.p_warehouse_id
    && receipt.to.version === args.p_expected_version + 1 && warehouse.id === args.p_warehouse_id && (value.replayed || warehouse.is_default), upstream);
  return { receipt: { command_id: receipt.command_id, action, from: { warehouse_id: receipt.from.warehouse_id, version: receipt.from.version }, to: { warehouse_id: receipt.to.warehouse_id, version: receipt.to.version },
    saved_at: receipt.saved_at }, warehouse, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}
export function stockOriginResponse(value, operation) {
  switch (operation.type) {
    case 'launch': return launchResponse(value, operation.args);
    case 'amend': return amendResponse(value, operation.args);
    case 'reservations': return reservationsResponse(value, operation.args);
    case 'totals': return totalsResponse(value, operation.args);
    case 'launch-context': return launchContextResponse(value, operation.args);
    case 'warehouses': return warehousesResponse(value, operation.args);
    case 'warehouse-save': return warehouseSaveResponse(value, operation.args, 'save');
    case 'warehouse-default': return warehouseSaveResponse(value, operation.args, 'default');
    default: return upstream();
  }
}
