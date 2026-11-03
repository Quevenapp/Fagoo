/** Controle de lotes (migration 258), routed through stock.mjs:
 * - GET /v1/estoque/lotes?product_id=&warehouse_id=&situacao=&offset=: Estoque > Lançamentos de estoque > aba "Lotes e validades"
 *   and the lot grid of the product form (lots, quantity in the warehouse or the considered warehouses, Sem lote);
 * - GET /v1/estoque/lotes/{lote}?limit=: "Detalhes de lotes" (balance per warehouse and the lançamentos of the lot);
 * - POST /v1/estoque/lotes and PATCH /v1/estoque/lotes/{lote}: "+ Adicionar lote" and the Salvar of the details;
 * - POST /v1/estoque/lotes/{lote}/situacao: "Excluir lote" (inactivates a lot without stock) and "Reativar lote".
 * The Novo Lançamento with Lote goes through POST /v1/estoque/lancamentos (stock-origin.mjs, launchLot here).
 * 278: "Informar lotes de produtos" of a recorded line and the "Informações de lote lançado" of an item:
 * - GET /v1/estoque/lotes/movimentos/{lançamento}?product_id=&warehouse_id=: the line, its lots, what is left and the lots offered;
 * - POST /v1/estoque/lotes/movimentos/{lançamento}: the informed lots of the line (command, expected number of lot lines);
 * - GET /v1/estoque/lotes/origem?documento=|nota=&product_id=: the lines posted by a document or a note for the product of an item.
 * Strict params and closed bodies, exact decimal strings (BigInt), projected and cross-checked responses. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const STATUS = { todos: 'all', ativos: 'active', inativos: 'inactive' };
const KINDS = ['receipt', 'issue', 'adjustment', 'transfer', 'reversal'];
const ORIGINS = ['sales', 'purchases', 'services', 'transfers', 'none', 'invoices'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const stored = value => typeof value === 'string' && STORED.test(value) && !/^-0\.0+$/.test(value);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
// SQL btrim() removes only spaces; the note it stores is compared with the same rule.
const spaces = value => value.replace(/^ +| +$/g, '');
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
/** Calendar date between 1900 and 2100 (the lot columns). */
export function lotDate(value) {
  if (typeof value !== 'string' || !DATE.test(value) || value < '1900-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const optionalDate = value => value === null || lotDate(value);
export class StockLotsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockLotsError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockLotsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };

export function stockLotsRoute(path) {
  if (path === '/v1/estoque/lotes') return { type: 'lots' };
  if (path === '/v1/estoque/lotes/origem') return { type: 'source-lots' };
  const line = /^\/v1\/estoque\/lotes\/movimentos\/([0-9a-fA-F-]{36})$/.exec(path);
  if (line) return uuid(line[1]) ? { type: 'movement-lots', id: line[1].toLowerCase() } : null;
  const match = /^\/v1\/estoque\/lotes\/([0-9a-fA-F-]{36})(\/situacao)?$/.exec(path);
  if (!match) return null;
  return uuid(match[1]) ? { type: match[2] ? 'lot-status' : 'lot', id: match[1].toLowerCase() } : null;
}
export const stockLotsMethods = route => ({ lots: ['GET', 'POST'], lot: ['GET', 'PATCH'], 'lot-status': ['POST'], 'movement-lots': ['GET', 'POST'], 'source-lots': ['GET'] }[route?.type] ?? null);
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 8192)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
const optionalNote = value => value === undefined || value === null ? null : text(value, 500) ? value : invalid();
const lotCode = value => typeof value === 'string' && value.trim() === value && text(value, 60, 1);

export async function stockLotsOperation(request, route, search) {
  if (request.method === 'GET') {
    if (route.type === 'lots') {
      params(search, ['product_id', 'warehouse_id', 'situacao', 'offset']);
      const product = search.get('product_id'), warehouse = search.get('warehouse_id'), state = search.get('situacao') ?? 'todos', offset = search.get('offset') ?? '0';
      need(uuid(product) && (warehouse === null || uuid(warehouse)) && Object.hasOwn(STATUS, state) && /^(0|[1-9][0-9]{0,5})$/.test(offset) && Number(offset) <= 100000);
      return { type: 'lots', rpc: 'erp_stock_lots', args: { p_product_id: product.toLowerCase(), p_warehouse_id: warehouse?.toLowerCase() ?? null, p_status: STATUS[state], p_offset: Number(offset), p_limit: 100 } };
    }
    // 278: one line of the razão, and the lines of a document or a note for one product.
    if (route.type === 'movement-lots') {
      params(search, ['product_id', 'warehouse_id']);
      const product = search.get('product_id'), warehouse = search.get('warehouse_id');
      need(uuid(product) && uuid(warehouse));
      return { type: 'movement-lots', rpc: 'erp_stock_movement_lots', args: { p_movement_id: route.id, p_product_id: product.toLowerCase(), p_warehouse_id: warehouse.toLowerCase() } };
    }
    if (route.type === 'source-lots') {
      params(search, ['documento', 'nota', 'product_id']);
      const document = search.get('documento'), invoice = search.get('nota'), product = search.get('product_id');
      need(uuid(product) && (document === null) !== (invoice === null) && uuid(document ?? invoice));
      return { type: 'source-lots', rpc: 'erp_stock_source_lots', args: { p_source: document ? 'document' : 'invoice', p_source_id: (document ?? invoice).toLowerCase(), p_product_id: product.toLowerCase() } };
    }
    if (route.type !== 'lot') invalid();
    params(search, ['limit']);
    const limit = search.get('limit') ?? '50'; need(/^[1-9][0-9]{0,2}$/.test(limit) && Number(limit) <= 100);
    return { type: 'lot', rpc: 'erp_stock_lot_get', args: { p_lot_id: route.id, p_limit: Number(limit) } };
  }
  if (search.size) invalid();
  const input = await readBody(request);
  need(uuid(input.command_id));
  const command = input.command_id.toLowerCase();
  if (route.type === 'lot-status') {
    need(only(input, ['command_id', 'expected_version', 'active']) && int(input.expected_version, 1, 2147483646) && typeof input.active === 'boolean');
    return { type: 'lot-status', rpc: 'erp_stock_lot_status', args: { p_command_id: command, p_lot_id: route.id, p_expected_version: input.expected_version, p_active: input.active } };
  }
  if (route.type === 'movement-lots') {
    need(only(input, ['command_id', 'product_id', 'warehouse_id', 'expected_lots', 'lots']) && uuid(input.product_id) && uuid(input.warehouse_id)
      && int(input.expected_lots, 0, 100000) && Array.isArray(input.lots) && input.lots.length >= 1 && input.lots.length <= 50);
    const ids = new Set(), codes = new Set();
    const lots = input.lots.map(item => {
      need(object(item) && typeof item.quantity === 'string' && /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(item.quantity) && units(item.quantity) > 0n);
      if (Object.hasOwn(item, 'lot_id')) {
        need(only(item, ['lot_id', 'quantity']) && uuid(item.lot_id) && !ids.has(item.lot_id.toLowerCase())); ids.add(item.lot_id.toLowerCase());
        return { lot_id: item.lot_id.toLowerCase(), quantity: item.quantity };
      }
      need(only(item, ['code', 'manufactured_on', 'expires_on', 'quantity']) && lotCode(item.code) && !codes.has(item.code.toLowerCase())
        && (item.manufactured_on === undefined || optionalDate(item.manufactured_on)) && (item.expires_on === undefined || optionalDate(item.expires_on))
        && !(item.manufactured_on && item.expires_on && item.manufactured_on > item.expires_on));
      codes.add(item.code.toLowerCase());
      return { code: item.code, manufactured_on: item.manufactured_on ?? null, expires_on: item.expires_on ?? null, quantity: item.quantity };
    });
    return { type: 'movement-lots-assign', rpc: 'erp_stock_movement_lots_assign', args: { p_command_id: command, p_movement_id: route.id, p_product_id: input.product_id.toLowerCase(),
      p_warehouse_id: input.warehouse_id.toLowerCase(), p_expected_lots: input.expected_lots, p_lots: lots } };
  }
  if (!['lots', 'lot'].includes(route.type)) invalid();
  const create = route.type === 'lots';
  need(only(input, create ? ['command_id', 'product_id', 'code', 'manufactured_on', 'expires_on', 'note'] : ['command_id', 'product_id', 'expected_version', 'code', 'manufactured_on', 'expires_on', 'note'])
    && uuid(input.product_id) && lotCode(input.code) && (create || int(input.expected_version, 1, 2147483646))
    && (input.manufactured_on === undefined || optionalDate(input.manufactured_on)) && (input.expires_on === undefined || optionalDate(input.expires_on))
    && !(input.manufactured_on && input.expires_on && input.manufactured_on > input.expires_on));
  return { type: 'lot-save', rpc: 'erp_stock_lot_save', args: { p_command_id: command, p_product_id: input.product_id.toLowerCase(), p_lot_id: create ? null : route.id,
    p_expected_version: create ? 0 : input.expected_version, p_code: input.code, p_manufactured_on: input.manufactured_on ?? null, p_expires_on: input.expires_on ?? null, p_note: optionalNote(input.note) } };
}

/** The `lot` of a Novo Lançamento: an existing lot ({lot_id}) or, in an Entrada or a Balanço, a "Novo lote" ({code, manufactured_on, expires_on}). */
export function launchLotInput(value, kind) {
  if (only(value, ['lot_id']) && uuid(value.lot_id)) return { lot_id: value.lot_id.toLowerCase() };
  need(['receipt', 'balance'].includes(kind) && only(value, ['code', 'manufactured_on', 'expires_on']) && lotCode(value.code)
    && (value.manufactured_on === undefined || optionalDate(value.manufactured_on)) && (value.expires_on === undefined || optionalDate(value.expires_on))
    && !(value.manufactured_on && value.expires_on && value.manufactured_on > value.expires_on));
  return { code: value.code, manufactured_on: value.manufactured_on ?? null, expires_on: value.expires_on ?? null };
}

const EXPIRY = [null, 'expired', 'expiring'];
// The list rows carry no product (it is the one asked); lot_dto (details, save, status) carries it.
function lotDto(value, withProduct = false) {
  need(exact(value, ['id', 'code', 'manufactured_on', 'expires_on', 'note', 'active', 'version', 'created_on', 'quantity', 'expiry_state', ...(withProduct ? ['product_id'] : [])])
    && (!withProduct || uuid(value.product_id)) && uuid(value.id) && lotCode(value.code) && optionalDate(value.manufactured_on) && optionalDate(value.expires_on) && optionalText(value.note, 500) && typeof value.active === 'boolean'
    && int(value.version, 1) && lotDate(value.created_on) && stored(value.quantity) && !value.quantity.startsWith('-') && EXPIRY.includes(value.expiry_state)
    && !(value.manufactured_on && value.expires_on && value.manufactured_on > value.expires_on)
    && (value.expiry_state === null || (value.active && value.expires_on !== null && units(value.quantity) > 0n)), upstream);
  return { id: value.id, code: value.code, manufactured_on: value.manufactured_on, expires_on: value.expires_on, note: value.note, active: value.active, version: value.version,
    created_on: value.created_on, quantity: value.quantity, expiry_state: value.expiry_state };
}
function settingsDto(value) {
  need(exact(value, ['require_expiry', 'require_manufacture', 'warning_days']) && typeof value.require_expiry === 'boolean' && typeof value.require_manufacture === 'boolean' && int(value.warning_days, 0, 9999), upstream);
  return { require_expiry: value.require_expiry, require_manufacture: value.require_manufacture, warning_days: value.warning_days };
}
function originDto(value) {
  const keys = ['type', 'document_id', 'document_kind', 'document_number', 'via'];
  need(exact(value, keys) && ORIGINS.includes(value.type) && (value.document_id === null || uuid(value.document_id)) && (value.document_kind === null || text(value.document_kind, 40, 1))
    && (value.document_number === null || (typeof value.document_number === 'string' && /^[1-9][0-9]{0,9}$/.test(value.document_number))) && (value.via === null || text(value.via, 40, 1)), upstream);
  return { type: value.type, document_id: value.document_id, document_kind: value.document_kind, document_number: value.document_number, via: value.via };
}
function lotsResponse(value, args) {
  need(object(value) && value.scope === 'stock_lots' && value.warehouse_id === args.p_warehouse_id && value.status === args.p_status && value.offset === args.p_offset && value.limit === args.p_limit
    && int(value.total) && lotDate(value.today) && Array.isArray(value.items) && value.items.length === Math.max(0, Math.min(args.p_limit, value.total - args.p_offset))
    && exact(value.product, ['id', 'name', 'code', 'unit', 'kind', 'format', 'active', 'lot_control']) && value.product.id === args.p_product_id && text(value.product.name, 200, 1)
    && optionalText(value.product.code, 100) && optionalText(value.product.unit, 16) && typeof value.product.active === 'boolean' && typeof value.product.lot_control === 'boolean'
    && stored(value.stock) && stored(value.assigned) && !value.assigned.startsWith('-') && stored(value.unassigned)
    && units(value.unassigned) === units(value.stock) - units(value.assigned), upstream);
  const items = value.items.map(item => lotDto(item));
  need(new Set(items.map(item => item.id)).size === items.length && (args.p_status === 'all' || items.every(item => item.active === (args.p_status === 'active')))
    && items.every((item, index) => index === 0 || !(items[index - 1].active === false && item.active)), upstream);
  const p = value.product;
  return { product: { id: p.id, name: p.name, code: p.code, unit: p.unit, kind: p.kind, format: p.format, active: p.active, lot_control: p.lot_control }, warehouse_id: value.warehouse_id,
    status: value.status, offset: value.offset, limit: value.limit, total: value.total, today: value.today, settings: settingsDto(value.settings), items,
    stock: value.stock, assigned: value.assigned, unassigned: value.unassigned, scope: value.scope, data_mode: 'erp_native' };
}
function lotResponse(value, args) {
  need(object(value) && value.scope === 'stock_lot' && object(value.lot) && value.lot.id === args.p_lot_id && exact(value.product, ['id', 'name', 'code', 'unit', 'lot_control'])
    && uuid(value.product.id) && value.lot.product_id === value.product.id && text(value.product.name, 200, 1) && optionalText(value.product.code, 100) && optionalText(value.product.unit, 16)
    && typeof value.product.lot_control === 'boolean' && Array.isArray(value.warehouses) && value.warehouses.length <= 1000 && exact(value.movements, ['total', 'limit', 'items'])
    && value.movements.limit === args.p_limit && int(value.movements.total) && Array.isArray(value.movements.items) && value.movements.items.length === Math.min(args.p_limit, value.movements.total), upstream);
  const lot = lotDto(value.lot, true);
  const warehouses = value.warehouses.map(w => { need(exact(w, ['warehouse_id', 'name', 'active', 'ignored', 'quantity', 'version']) && uuid(w.warehouse_id) && text(w.name, 200, 1)
    && typeof w.active === 'boolean' && typeof w.ignored === 'boolean' && stored(w.quantity) && !w.quantity.startsWith('-') && int(w.version), upstream);
    return { warehouse_id: w.warehouse_id, name: w.name, active: w.active, ignored: w.ignored, quantity: w.quantity, version: w.version }; });
  // The lot quantity is the sum of the considered warehouses.
  need(new Set(warehouses.map(w => w.warehouse_id)).size === warehouses.length && warehouses.filter(w => !w.ignored).reduce((sum, w) => sum + units(w.quantity), 0n) === units(lot.quantity), upstream);
  const movements = value.movements.items.map(m => { need(exact(m, ['movement_id', 'warehouse_id', 'quantity', 'balance_after', 'kind', 'occurred_on', 'created_at', 'recorded_at_local', 'reason', 'origin'])
    && uuid(m.movement_id) && uuid(m.warehouse_id) && stored(m.quantity) && units(m.quantity) !== 0n && stored(m.balance_after) && !m.balance_after.startsWith('-') && KINDS.includes(m.kind)
    && lotDate(m.occurred_on) && instant(m.created_at) && typeof m.recorded_at_local === 'string' && LOCAL_TIME.test(m.recorded_at_local) && text(m.reason, 500, 1), upstream);
    return { movement_id: m.movement_id, warehouse_id: m.warehouse_id, quantity: m.quantity, balance_after: m.balance_after, kind: m.kind, occurred_on: m.occurred_on, created_at: m.created_at,
      recorded_at_local: m.recorded_at_local, reason: m.reason, origin: originDto(m.origin) }; });
  const p = value.product;
  return { lot, product: { id: p.id, name: p.name, code: p.code, unit: p.unit, lot_control: p.lot_control }, settings: settingsDto(value.settings), warehouses,
    movements: { total: value.movements.total, limit: value.movements.limit, items: movements }, scope: value.scope, data_mode: 'erp_native' };
}
function saveResponse(value, args) {
  need(object(value) && value.scope === 'stock_lot_save' && typeof value.replayed === 'boolean' && typeof value.created === 'boolean' && value.created === (args.p_lot_id === null)
    && object(value.lot) && value.lot.product_id === args.p_product_id && (args.p_lot_id === null || value.lot.id === args.p_lot_id), upstream);
  const lot = lotDto(value.lot, true);
  // A replay returns the stored receipt; a new save wrote exactly what was asked.
  need(value.replayed || (lot.code === args.p_code.trim() && lot.manufactured_on === args.p_manufactured_on && lot.expires_on === args.p_expires_on
    && lot.note === (spaces(args.p_note ?? '') || null) && lot.version === (args.p_lot_id === null ? 1 : args.p_expected_version + 1)), upstream);
  return { created: value.created, lot, settings: settingsDto(value.settings), replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}
function statusResponse(value, args) {
  need(object(value) && value.scope === 'stock_lot_status' && typeof value.replayed === 'boolean' && object(value.lot) && value.lot.id === args.p_lot_id, upstream);
  const lot = lotDto(value.lot, true);
  need(value.replayed || (lot.active === args.p_active && lot.version === args.p_expected_version + 1 && (lot.active || units(lot.quantity) === 0n)), upstream);
  return { lot, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}
// ---- 278: Informar lotes de produtos / Informações de lote lançado ----
const LINE_REASONS = [null, 'kind', 'reversed', 'lot_control_off', 'assigned'];
const positive = value => stored(value) && !value.startsWith('-');
const lineProductDto = value => { need(exact(value, ['id', 'name', 'code', 'unit', 'lot_control']) && uuid(value.id) && text(value.name, 200, 1) && optionalText(value.code, 100)
  && optionalText(value.unit, 16) && typeof value.lot_control === 'boolean', upstream);
  return { id: value.id, name: value.name, code: value.code, unit: value.unit, lot_control: value.lot_control }; };
/** A line of the razão with its lots: assigned + unassigned = quantity, one lot line per lot, and "assignable" only with something left. */
function lotLineDto(value, product) {
  need(exact(value, ['movement_id', 'product_id', 'warehouse_id', 'warehouse_name', 'kind', 'direction', 'occurred_on', 'reason', 'quantity', 'assigned', 'unassigned', 'lots_version',
    'assignable', 'reason_code', 'origin', 'lots']) && uuid(value.movement_id) && value.product_id === product && uuid(value.warehouse_id) && text(value.warehouse_name, 200, 1)
    && KINDS.includes(value.kind) && ['receipt', 'issue'].includes(value.direction) && lotDate(value.occurred_on) && text(value.reason, 500, 1)
    && positive(value.quantity) && units(value.quantity) > 0n && positive(value.assigned) && positive(value.unassigned) && units(value.assigned) + units(value.unassigned) === units(value.quantity)
    && int(value.lots_version) && typeof value.assignable === 'boolean' && LINE_REASONS.includes(value.reason_code) && value.assignable === (value.reason_code === null)
    && (!value.assignable || (['receipt', 'issue'].includes(value.kind) && units(value.unassigned) > 0n)) && (value.reason_code !== 'assigned' || units(value.unassigned) === 0n)
    && Array.isArray(value.lots) && value.lots.length === value.lots_version && value.lots.length <= 1000, upstream);
  const lots = value.lots.map(lot => { need(exact(lot, ['lot_id', 'code', 'manufactured_on', 'expires_on', 'quantity']) && uuid(lot.lot_id) && lotCode(lot.code) && optionalDate(lot.manufactured_on)
    && optionalDate(lot.expires_on) && positive(lot.quantity) && units(lot.quantity) > 0n, upstream);
    return { lot_id: lot.lot_id, code: lot.code, manufactured_on: lot.manufactured_on, expires_on: lot.expires_on, quantity: lot.quantity }; });
  need(new Set(lots.map(lot => lot.lot_id)).size === lots.length && lots.reduce((sum, lot) => sum + units(lot.quantity), 0n) === units(value.assigned), upstream);
  return { movement_id: value.movement_id, product_id: value.product_id, warehouse_id: value.warehouse_id, warehouse_name: value.warehouse_name, kind: value.kind, direction: value.direction,
    occurred_on: value.occurred_on, reason: value.reason, quantity: value.quantity, assigned: value.assigned, unassigned: value.unassigned, lots_version: value.lots_version,
    assignable: value.assignable, reason_code: value.reason_code, origin: originDto(value.origin), lots };
}
function movementLotsDto(value, args) {
  const line = lotLineDto(value.line, args.p_product_id), product = lineProductDto(value.product);
  need(line.movement_id === args.p_movement_id && line.warehouse_id === args.p_warehouse_id && product.id === args.p_product_id && positive(value.room)
    && units(value.room) <= units(line.unassigned) && (line.assignable || units(value.room) === 0n) && typeof value.can_write === 'boolean'
    && Array.isArray(value.candidates) && value.candidates.length <= 100 && (line.assignable || value.candidates.length === 0), upstream);
  const candidates = value.candidates.map(item => { need(exact(item, ['id', 'code', 'manufactured_on', 'expires_on', 'quantity']) && uuid(item.id) && lotCode(item.code)
    && optionalDate(item.manufactured_on) && optionalDate(item.expires_on) && positive(item.quantity) && (line.direction === 'receipt' || units(item.quantity) > 0n), upstream);
    return { id: item.id, code: item.code, manufactured_on: item.manufactured_on, expires_on: item.expires_on, quantity: item.quantity }; });
  need(new Set(candidates.map(item => item.id)).size === candidates.length, upstream);
  return { line, product, room: value.room, candidates, settings: settingsDto(value.settings), can_write: value.can_write };
}
function movementLotsResponse(value, args) {
  need(value.scope === 'stock_movement_lots', upstream);
  return { ...movementLotsDto(value, args), scope: value.scope, data_mode: 'erp_native' };
}
function movementLotsAssignResponse(value, args) {
  need(value.scope === 'stock_movement_lots_assign' && typeof value.replayed === 'boolean' && Array.isArray(value.entries) && value.entries.length === args.p_lots.length, upstream);
  const view = movementLotsDto(value, args), sign = view.line.direction === 'receipt' ? 1n : -1n;
  const entries = value.entries.map(entry => { need(exact(entry, ['warehouse_id', 'quantity', 'balance_after', 'lot_id', 'code', 'created']) && entry.warehouse_id === args.p_warehouse_id
    && stored(entry.quantity) && units(entry.quantity) * sign > 0n && positive(entry.balance_after) && uuid(entry.lot_id) && lotCode(entry.code) && typeof entry.created === 'boolean', upstream);
    return { warehouse_id: entry.warehouse_id, quantity: entry.quantity, balance_after: entry.balance_after, lot_id: entry.lot_id, code: entry.code, created: entry.created }; });
  // Each informed lot is in the line now, with the asked quantity; a new save wrote exactly one lot line per item asked.
  for (const asked of args.p_lots) {
    const entry = entries.find(item => asked.lot_id ? item.lot_id === asked.lot_id && !item.created : item.created && item.code === asked.code);
    need(entry && units(entry.quantity) === units(asked.quantity) * sign && view.line.lots.some(lot => lot.lot_id === entry.lot_id && units(lot.quantity) === units(asked.quantity)), upstream);
  }
  need(value.replayed || view.line.lots_version === args.p_expected_lots + args.p_lots.length, upstream);
  return { ...view, entries, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}
function sourceLotsResponse(value, args) {
  need(value.scope === 'stock_source_lots' && value.source === args.p_source && value.source_id === args.p_source_id && typeof value.posted === 'boolean'
    && typeof value.can_write === 'boolean' && Array.isArray(value.lines) && value.lines.length <= 100 && (value.posted || value.lines.length === 0), upstream);
  let reference = null;
  if (value.reference !== null) {
    const r = value.reference;
    need(args.p_source === 'invoice' && exact(r, ['document_id', 'kind', 'number', 'via']) && uuid(r.document_id) && ['sales_orders', 'purchase_orders', 'service_orders'].includes(r.kind)
      && typeof r.number === 'string' && /^[1-9][0-9]{0,9}$/.test(r.number) && ['document_stock', 'purchase_receipt'].includes(r.via), upstream);
    reference = { document_id: r.document_id, kind: r.kind, number: r.number, via: r.via };
  }
  const product = lineProductDto(value.product), lines = value.lines.map(line => lotLineDto(line, args.p_product_id));
  need(product.id === args.p_product_id && new Set(lines.map(line => `${line.movement_id}:${line.warehouse_id}`)).size === lines.length, upstream);
  return { source: value.source, source_id: value.source_id, posted: value.posted, reference, product, lines, settings: settingsDto(value.settings), can_write: value.can_write,
    scope: value.scope, data_mode: 'erp_native' };
}
export function stockLotsResponse(value, operation) {
  need(object(value) && value.data_mode === 'erp_native', upstream);
  switch (operation.type) {
    case 'lots': return lotsResponse(value, operation.args);
    case 'lot': return lotResponse(value, operation.args);
    case 'lot-save': return saveResponse(value, operation.args);
    case 'lot-status': return statusResponse(value, operation.args);
    case 'movement-lots': return movementLotsResponse(value, operation.args);
    case 'movement-lots-assign': return movementLotsAssignResponse(value, operation.args);
    case 'source-lots': return sourceLotsResponse(value, operation.args);
    default: return upstream();
  }
}

/** The `lot` part of a Novo Lançamento with Lote (erp_stock_lot_launch), checked against the request and the posted movement. */
export function launchLotDto(value, args, movement, balance) {
  need(exact(value, ['id', 'code', 'manufactured_on', 'expires_on', 'created', 'entries', 'balance']) && uuid(value.id) && lotCode(value.code) && optionalDate(value.manufactured_on)
    && optionalDate(value.expires_on) && typeof value.created === 'boolean' && Array.isArray(value.entries) && value.entries.length === (args.p_kind === 'transfer' ? 2 : 1), upstream);
  const asked = args.p_lot;
  need(asked.lot_id ? value.id === asked.lot_id && !value.created
    : value.created && value.code === asked.code.trim() && value.manufactured_on === asked.manufactured_on && value.expires_on === asked.expires_on, upstream);
  const entries = value.entries.map(entry => { need(exact(entry, ['warehouse_id', 'quantity', 'balance_after']) && uuid(entry.warehouse_id) && stored(entry.quantity) && units(entry.quantity) !== 0n
    && stored(entry.balance_after) && !entry.balance_after.startsWith('-'), upstream);
    return { warehouse_id: entry.warehouse_id, quantity: entry.quantity, balance_after: entry.balance_after }; });
  // Each lot line belongs to a line of the movement with the same sign and never more than it.
  for (const entry of entries) {
    const line = movement.items.find(item => item.warehouse_id === entry.warehouse_id);
    need(line && (units(line.quantity) > 0n) === (units(entry.quantity) > 0n) && (units(entry.quantity) < 0n ? -units(entry.quantity) : units(entry.quantity)) <= (units(line.quantity) < 0n ? -units(line.quantity) : units(line.quantity)), upstream);
  }
  const q = units(args.p_quantity), [first, second] = entries;
  let lotBalance = null;
  if (args.p_kind === 'balance') {
    need(exact(value.balance, ['counted', 'previous']) && stored(value.balance.counted) && stored(value.balance.previous) && !value.balance.previous.startsWith('-')
      && units(value.balance.counted) === q && first.warehouse_id === args.p_warehouse_id && units(first.quantity) === q - units(value.balance.previous) && units(first.balance_after) === q
      && balance !== null && units(balance.counted) - units(balance.previous) === units(first.quantity), upstream);
    lotBalance = { counted: value.balance.counted, previous: value.balance.previous };
  } else {
    need(value.balance === null && first.warehouse_id === args.p_warehouse_id && units(first.quantity) === (args.p_kind === 'receipt' ? q : -q)
      && (args.p_kind !== 'transfer' || (second.warehouse_id === args.p_destination_id && units(second.quantity) === q)), upstream);
  }
  return { id: value.id, code: value.code, manufactured_on: value.manufactured_on, expires_on: value.expires_on, created: value.created, entries, balance: lotBalance };
}
