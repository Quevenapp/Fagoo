/** Native stock boundary: exact decimal strings, optimistic versions and a projected response. */
import { stockOriginRoute, stockOriginMethods, stockOriginOperation, stockOriginResponse, StockOriginError, reservationPolicyDto } from './stock-origin.mjs';
import { stockCountRoute, stockCountMethods, stockCountOperation, stockCountResponse, StockCountError } from './stock-count.mjs';
import { stockDashboardsRoute, stockDashboardsMethods, stockDashboardsOperation, stockDashboardsResponse, StockDashboardsError } from './stock-dashboards.mjs';
import { stockCheckinRoute, stockCheckinMethods, stockCheckinOperation, stockCheckinResponse, StockCheckinError } from './stock-checkin.mjs';
import { stockReportsRoute, stockReportsMethods, stockReportsOperation, stockReportsResponse, StockReportsError } from './stock-reports.mjs';
import { stockSupplyRoute, stockSupplyMethods, stockSupplyOperation, stockSupplyResponse, StockSupplyError } from './stock-supply.mjs';
import { stockCompositionsRoute, stockCompositionsMethods, stockCompositionsOperation, stockCompositionsResponse, StockCompositionsError } from './stock-compositions.mjs';
// Wave E (258-260): lots, stock posted by the fiscal notes and the product locations.
import { stockLotsRoute, stockLotsMethods, stockLotsOperation, stockLotsResponse, StockLotsError } from './stock-lots.mjs';
import { stockInvoicesRoute, stockInvoicesMethods, stockInvoicesOperation, stockInvoicesResponse, StockInvoicesError } from './stock-invoices.mjs';
import { stockMirrorOperation, stockMirrorResponse, StockMirrorError } from './stock-mirror.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const KINDS = ['receipt', 'issue', 'adjustment', 'transfer'];
// Extrato no padrão do Origin (migração 098): página por número (offset), filtros e totalizador.
const LEDGER_KINDS = [...KINDS, 'reversal'];
// 259: 'invoices' is the origin "Notas Fiscais" (a lançamento of a Brufap note or of its check-in).
// 364: 'deleted' is the origin "Origem excluída" (the note or document of the lançamento was deleted; its identification stays).
const ORIGINS = ['sales', 'purchases', 'services', 'transfers', 'none', 'invoices', 'deleted'];
const INVOICE_SCREENS = ['nfe_saida', 'nfe_entrada', 'nfce'];
const ORIGIN_DOCUMENTS = { sales: 'sales_orders', purchases: 'purchase_orders', services: 'service_orders' };
// 105: Tipo Entrada/Saída/Balanço of Origin (direction), unit price/cost/observação revisions and the Balanço count.
const LEDGER_PARAMS = ['product_id', 'limit', 'offset', 'warehouse_id', 'kind', 'origin', 'date_from', 'date_to', 'direction'];
const DIRECTIONS = ['entry', 'exit', 'balance'];
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
const TOTAL = /^(0|[1-9][0-9]{0,31})\.[0-9]{6}$/;
// Saldo atual can be negative when the company allows negative stock (migration100); entries and exits are unsigned sums.
const SIGNED_TOTAL = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{6}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const version = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const string = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const decimal = value => typeof value === 'string' && DECIMAL.test(value);
// Balances may be negative since migration100 (company policy "Permitir estoque negativo"); "-0" is never a valid quantity.
const negativeZero = value => /^-0(?:\.0+)?$/.test(value);
export class StockError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new StockError(400, 'ERP_INVALID_QUERY'); };
// The 105 module keeps its own error class; the worker only knows StockError.
const lane = error => error instanceof StockOriginError || error instanceof StockCountError || error instanceof StockDashboardsError || error instanceof StockCheckinError || error instanceof StockReportsError || error instanceof StockSupplyError
  || error instanceof StockCompositionsError || error instanceof StockLotsError || error instanceof StockInvoicesError || error instanceof StockMirrorError;
const origin = async run => { try { return await run(); } catch (error) { if (lane(error)) throw new StockError(error.status, error.code); throw error; } };
const originSync = run => { try { return run(); } catch (error) { if (lane(error)) throw new StockError(error.status, error.code); throw error; } };
const upstream = () => { throw new StockError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function stockRoute(path) {
  if (path === '/v1/estoque/espelho') return { type: 'mirror' };
  if (path === '/v1/estoque/saldos') return { type: 'balances' };
  if (path === '/v1/estoque/movimentos') return { type: 'movements' };
  const match = /^\/v1\/estoque\/movimentos\/([a-fA-F0-9-]+)\/estorno$/.exec(path);
  if (match) return uuid(match[1]) ? { type: 'reverse', id: match[1].toLowerCase() } : null;
  const origin = stockOriginRoute(path);
  if (origin) return { ...origin, origin: true };
  // 106: Conferência de estoque.
  const count = stockCountRoute(path);
  if (count) return { ...count, count: true };
  // 107: dashboards de produtos.
  const dashboard = stockDashboardsRoute(path);
  if (dashboard) return { ...dashboard, dashboard: true };
  // 147: Check-in de Recebimentos.
  const checkin = stockCheckinRoute(path);
  if (checkin) return { ...checkin, checkin: true };
  // 181/183: depósitos e fornecedores dos filtros, transferência em lote.
  const supply = stockSupplyRoute(path);
  if (supply) return { ...supply, supply: true };
  // 222: composições (Estrutura, componentes, lançamento da composição e exportação de estruturas).
  const composition = stockCompositionsRoute(path);
  if (composition) return { ...composition, composition: true };
  // 258: lotes (Lotes e validades, Detalhes de lotes, grade de lotes do produto).
  const lots = stockLotsRoute(path);
  if (lots) return { ...lots, lots: true };
  // 259: estoque lançado pela nota fiscal (letra E, Lançar/Estornar estoque e o Finalizar do check-in com lançamento).
  const invoices = stockInvoicesRoute(path);
  if (invoices) return { ...invoices, invoices: true };
  // 146: relatórios de suprimentos.
  const report = stockReportsRoute(path);
  return report ? { ...report, reports: true } : null;
}
export const stockMethods = route => route?.invoices ? stockInvoicesMethods(route) : route?.lots ? stockLotsMethods(route) : route?.composition ? stockCompositionsMethods(route) : route?.supply ? stockSupplyMethods(route) : route?.reports ? stockReportsMethods(route) : route?.checkin ? stockCheckinMethods(route) : route?.dashboard ? stockDashboardsMethods(route) : route?.count ? stockCountMethods(route) : route?.origin ? stockOriginMethods(route) : route?.type === 'reverse' ? ['POST'] : route?.type === 'movements' ? ['GET', 'POST'] : ['GET'];
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body || Number(request.headers.get('Content-Length')) > 65536) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 65536) invalid(); text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); const result = JSON.parse(text); if (!object(result)) invalid(); return result;
  } catch { return invalid(); }
  finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
function ledgerOperation(params) {
  for (const key of params.keys()) if (!LEDGER_PARAMS.includes(key) || params.getAll(key).length !== 1) invalid();
  const product = params.get('product_id'), warehouse = params.get('warehouse_id'), kind = params.get('kind'), origin = params.get('origin'), direction = params.get('direction');
  const from = params.get('date_from'), to = params.get('date_to'), limit = params.get('limit') ?? '100', offset = params.get('offset');
  if (!uuid(product) || (warehouse !== null && !uuid(warehouse)) || (kind !== null && !LEDGER_KINDS.includes(kind)) || (origin !== null && !ORIGINS.includes(origin))
    || (direction !== null && !DIRECTIONS.includes(direction))
    || (from !== null && !date(from)) || (to !== null && !date(to)) || (from !== null && to !== null && from > to)
    || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100 || !/^(?:0|[1-9][0-9]{0,5})$/.test(offset) || Number(offset) > 100000) invalid();
  return { rpc: 'erp_stock_ledger', type: 'ledger', args: { p_product_id: product.toLowerCase(), p_warehouse_id: warehouse?.toLowerCase() ?? null,
    p_kind: kind, p_origin: origin, p_date_from: from, p_date_to: to, p_limit: Number(limit), p_offset: Number(offset), p_direction: direction } };
}
export async function stockOperation(request, route, params) {
  if (!route) throw new StockError(404, 'ERP_NOT_FOUND');
  if (!stockMethods(route).includes(request.method)) throw new StockError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (route.type === 'mirror') return originSync(() => stockMirrorOperation(params));
  if (route.invoices) return origin(() => stockInvoicesOperation(request, route, params));
  if (route.lots) return origin(() => stockLotsOperation(request, route, params));
  if (route.composition) return origin(() => stockCompositionsOperation(request, route, params));
  if (route.supply) return origin(() => stockSupplyOperation(request, route, params));
  if (route.reports) return originSync(() => stockReportsOperation(request, route, params));
  if (route.checkin) return origin(() => stockCheckinOperation(request, route, params));
  if (route.dashboard) return origin(() => stockDashboardsOperation(request, route, params));
  if (route.count) return origin(() => stockCountOperation(request, route, params));
  if (route.origin) return origin(() => stockOriginOperation(request, route, params));
  if (request.method === 'GET') {
    // The ledger mode is explicit (offset present); the 009 cursor contract stays unchanged for existing callers.
    if (route.type === 'movements' && params.has('offset')) return ledgerOperation(params);
    const allowed = route.type === 'balances' ? ['product_id', 'warehouse_id'] : ['product_id', 'limit', 'after'];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
    const product = params.get('product_id'); if (!uuid(product)) invalid();
    if (route.type === 'balances') {
      const warehouse = params.get('warehouse_id'); if (warehouse !== null && !uuid(warehouse)) invalid();
      return { rpc: 'erp_stock_balances', args: { p_product_id: product.toLowerCase(), p_warehouse_id: warehouse?.toLowerCase() ?? null }, type: 'balances' };
    }
    const limit = params.get('limit') ?? '25', after = params.get('after');
    if (!/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 25 || (after !== null && !uuid(after))) invalid();
    return { rpc: 'erp_stock_movements', args: { p_product_id: product.toLowerCase(), p_limit: Number(limit), p_after: after?.toLowerCase() ?? null }, type: 'list' };
  }
  if (params.size) invalid();
  const input = await readBody(request), reverse = route.type === 'reverse';
  if (!only(input, reverse ? ['command_id', 'occurred_on', 'reason', 'versions'] : ['command_id', 'kind', 'occurred_on', 'reason', 'reference', 'items'])
    || !uuid(input.command_id) || !date(input.occurred_on) || !string(input.reason, 500, 3)) invalid();
  const lines = reverse ? input.versions : input.items;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) invalid();
  for (const line of lines) {
    if (!only(line, reverse ? ['product_id', 'warehouse_id', 'expected_version'] : ['product_id', 'warehouse_id', 'quantity', 'expected_version'])
      || !uuid(line.product_id) || !uuid(line.warehouse_id) || !version(line.expected_version)
      || (!reverse && (!decimal(line.quantity) || /^-?0(?:\.0+)?$/.test(line.quantity)))) invalid();
  }
  const positions = lines.map(line => `${line.product_id.toLowerCase()}:${line.warehouse_id.toLowerCase()}`);
  if (new Set(positions).size !== positions.length) invalid();
  const normalizedLines = lines.map(line => ({ ...line, product_id: line.product_id.toLowerCase(), warehouse_id: line.warehouse_id.toLowerCase() }));
  const args = { p_command_id: input.command_id.toLowerCase(), p_occurred_on: input.occurred_on, p_reason: input.reason };
  if (reverse) return { rpc: 'erp_stock_reverse', args: { ...args, p_movement_id: route.id, p_versions: normalizedLines }, type: 'mutation' };
  if (!KINDS.includes(input.kind) || (input.reference !== undefined && input.reference !== null && !string(input.reference, 100))
    || (input.kind === 'receipt' && lines.some(line => line.quantity.startsWith('-')))
    || (input.kind === 'issue' && lines.some(line => !line.quantity.startsWith('-')))) invalid();
  return { rpc: 'erp_stock_post', args: { ...args, p_kind: input.kind, p_reference: input.reference ?? null, p_items: normalizedLines }, type: 'mutation' };
}
function movement(value) {
  if (!object(value) || !uuid(value.id) || ![...KINDS, 'reversal'].includes(value.kind) || !date(value.occurred_on)
    || !string(value.reason, 500, 3) || (value.reference !== null && !string(value.reference, 100)) || !string(value.created_at, 100, 1)
    || (value.reverses_id !== null && !uuid(value.reverses_id)) || (value.reversed_by !== null && !uuid(value.reversed_by))
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) upstream();
  const items = value.items.map(item => {
    if (!object(item) || !uuid(item.product_id) || !uuid(item.warehouse_id) || !decimal(item.quantity)
      || !decimal(item.balance_after) || negativeZero(item.balance_after) || !string(item.unit, 16, 1) || !version(item.balance_version) || item.balance_version < 1) upstream();
    return { product_id: item.product_id, warehouse_id: item.warehouse_id, quantity: item.quantity, unit: item.unit, balance_after: item.balance_after, balance_version: item.balance_version };
  });
  return { id: value.id, kind: value.kind, occurred_on: value.occurred_on, reason: value.reason, reference: value.reference,
    created_at: value.created_at, reverses_id: value.reverses_id, reversed_by: value.reversed_by, items };
}
function ledgerOrigin(value, kind) {
  const keys = ['type', 'document_id', 'document_kind', 'document_number', 'via'];
  if (!only(value, keys) || keys.some(key => !Object.hasOwn(value, key)) || !ORIGINS.includes(value.type)) upstream();
  if (value.type === 'deleted') {
    const invoice = INVOICE_SCREENS.includes(value.document_kind);
    if (!uuid(value.document_id) || !(invoice || Object.values(ORIGIN_DOCUMENTS).includes(value.document_kind)) || !['receipt', 'issue', 'reversal'].includes(kind)
      || (invoice ? value.via !== 'invoice_stock' || (value.document_number !== null && (typeof value.document_number !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.document_number)))
        : typeof value.document_number !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.document_number)
          || !(value.via === 'document_stock' || (value.via === 'purchase_receipt' && value.document_kind === 'purchase_orders')))) upstream();
    return { type: value.type, document_id: value.document_id, document_kind: value.document_kind, document_number: value.document_number, via: value.via };
  }
  if (value.type === 'invoices') {
    if (!uuid(value.document_id) || !INVOICE_SCREENS.includes(value.document_kind) || (value.document_number !== null && (typeof value.document_number !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.document_number)))
      || value.via !== 'invoice_stock' || !['receipt', 'issue', 'reversal'].includes(kind)) upstream();
    return { type: value.type, document_id: value.document_id, document_kind: value.document_kind, document_number: value.document_number, via: value.via };
  }
  const linked = Object.hasOwn(ORIGIN_DOCUMENTS, value.type);
  if (linked ? !uuid(value.document_id) || value.document_kind !== ORIGIN_DOCUMENTS[value.type] || typeof value.document_number !== 'string'
      || !/^[1-9][0-9]{0,9}$/.test(value.document_number) || !['receipt', 'issue', 'reversal'].includes(kind)
      || !(value.via === 'document_stock' || (value.via === 'purchase_receipt' && value.type === 'purchases'))
    : value.document_id !== null || value.document_kind !== null || value.document_number !== null || value.via !== null
      || (value.type === 'transfers' && !['transfer', 'reversal'].includes(kind))) upstream();
  return { type: value.type, document_id: value.document_id, document_kind: value.document_kind, document_number: value.document_number, via: value.via };
}
function ledgerRow(value, args) {
  const row = movement(value);
  if (!Number.isInteger(value.other_items) || value.other_items < 0 || row.items.length + value.other_items > 100
    || typeof value.recorded_at_local !== 'string' || !LOCAL_TIME.test(value.recorded_at_local) || !date(value.recorded_at_local.slice(0, 10))
    || !Number.isFinite(Date.parse(row.created_at)) || row.items.some(item => item.product_id !== args.p_product_id)
    || (args.p_warehouse_id !== null && !row.items.some(item => item.warehouse_id === args.p_warehouse_id))
    || (args.p_kind !== null && row.kind !== args.p_kind) || (args.p_date_from !== null && row.occurred_on < args.p_date_from)
    || (args.p_date_to !== null && row.occurred_on > args.p_date_to)) upstream();
  const origin = ledgerOrigin(value.origin, row.kind);
  if (args.p_origin !== null && origin.type !== args.p_origin) upstream();
  return { ...row, recorded_at_local: value.recorded_at_local, other_items: value.other_items, origin, ...ledgerDetail(value, row, origin, args) };
}
// Preços, observação e Balanço (105). A revision > 0 is a stored detail; without one, the price may come from the document item.
function ledgerDetail(value, row, origin, args) {
  const priced = item => item === null || (typeof item === 'string' && PRICE.test(item));
  if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision > 2147483647 || !priced(value.unit_price) || !priced(value.unit_cost)
    || ![null, 'detail', 'document'].includes(value.price_source)
    || (value.revision > 0 ? value.price_source !== 'detail' || !string(value.note, 500)
      : value.note !== null || value.unit_cost !== null || value.price_source === 'detail' || (value.price_source === 'document') !== (value.unit_price !== null))
    || (value.price_source === 'document' && origin.document_id === null)) upstream();
  let balance = null;
  if (value.balance !== null) {
    const b = value.balance, line = row.items[0];
    if (!object(b) || !only(b, ['counted', 'previous', 'warehouse_id', 'source']) || typeof b.counted !== 'string' || !STORED.test(b.counted) || typeof b.previous !== 'string'
      || !STORED.test(b.previous) || negativeZero(b.counted) || negativeZero(b.previous) || !uuid(b.warehouse_id) || !['launch', 'count'].includes(b.source)
      || row.kind !== 'adjustment' || row.items.length !== 1 || value.other_items !== 0 || line.warehouse_id !== b.warehouse_id
      || units(line.quantity) !== units(b.counted) - units(b.previous) || units(line.balance_after) !== units(b.counted)) upstream();
    balance = { counted: b.counted, previous: b.previous, warehouse_id: b.warehouse_id, source: b.source };
  }
  const scoped = row.items.filter(item => args.p_warehouse_id === null || item.warehouse_id === args.p_warehouse_id);
  if ((args.p_direction === 'balance' && balance === null) || (['entry', 'exit'].includes(args.p_direction) && (balance !== null
    || !scoped.some(item => args.p_direction === 'entry' ? !item.quantity.startsWith('-') : item.quantity.startsWith('-'))))) upstream();
  return { revision: value.revision, note: value.note, unit_price: value.unit_price, unit_cost: value.unit_cost, price_source: value.price_source, balance };
}
function ledgerResponse(value, args) {
  const filters = { warehouse_id: args.p_warehouse_id, kind: args.p_kind, origin: args.p_origin, date_from: args.p_date_from, date_to: args.p_date_to, direction: args.p_direction };
  const echoed = value.filters, totals = value.totals;
  if (value.product_id !== args.p_product_id || value.limit !== args.p_limit || value.offset !== args.p_offset
    || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 2147483647 || typeof value.has_more !== 'boolean'
    || value.has_more !== (value.total > args.p_offset + args.p_limit) || value.next_offset !== (value.has_more ? args.p_offset + args.p_limit : null)
    || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(args.p_limit, value.total - args.p_offset))
    || !only(echoed, Object.keys(filters)) || Object.entries(filters).some(([key, expected]) => !Object.hasOwn(echoed, key) || echoed[key] !== expected)
    || !only(totals, ['entries', 'exits', 'current_balance', 'unit']) || !['entries', 'exits'].every(key => typeof totals[key] === 'string' && TOTAL.test(totals[key]))
    || typeof totals.current_balance !== 'string' || !SIGNED_TOTAL.test(totals.current_balance) || negativeZero(totals.current_balance)
    || !Object.hasOwn(totals, 'unit') || (totals.unit !== null && !string(totals.unit, 16, 1))) upstream();
  const items = value.items.map(row => ledgerRow(row, args));
  // Newest first, as Origin: occurred_on, then registration time; the UUID tiebreaker is checked by the SQL tests.
  for (let index = 1; index < items.length; index++) {
    const previous = items[index - 1], current = items[index];
    if (previous.id === current.id || previous.occurred_on < current.occurred_on
      || (previous.occurred_on === current.occurred_on && Date.parse(previous.created_at) < Date.parse(current.created_at))) upstream();
  }
  return { product_id: value.product_id, items, limit: value.limit, offset: value.offset, total: value.total, has_more: value.has_more, next_offset: value.next_offset,
    filters, totals: { entries: totals.entries, exits: totals.exits, current_balance: totals.current_balance, unit: totals.unit }, data_mode: 'erp_native' };
}
export function stockResponse(value, route, operation) {
  if (route?.type === 'mirror') return originSync(() => stockMirrorResponse(value, operation));
  if (!object(value) || value.data_mode !== 'erp_native') upstream();
  if (route?.invoices) return originSync(() => stockInvoicesResponse(value, operation));
  if (route?.lots) return originSync(() => stockLotsResponse(value, operation));
  if (route?.composition) return originSync(() => stockCompositionsResponse(value, operation));
  if (route?.supply) return originSync(() => stockSupplyResponse(value, operation));
  if (route?.reports) return originSync(() => stockReportsResponse(value, operation));
  if (route?.checkin) return originSync(() => stockCheckinResponse(value, operation));
  if (route?.dashboard) return originSync(() => stockDashboardsResponse(value, operation));
  if (route?.count) return originSync(() => stockCountResponse(value, operation));
  if (route?.origin) return originSync(() => stockOriginResponse(value, operation));
  if (operation.type === 'balances') {
    if (value.product_id !== operation.args.p_product_id || !Array.isArray(value.items) || value.items.length > 1000) upstream();
    const items = value.items.map(item => {
      if (!object(item) || !uuid(item.warehouse_id) || !string(item.warehouse_name, 200, 1) || typeof item.warehouse_active !== 'boolean'
        || !decimal(item.quantity) || negativeZero(item.quantity) || !version(item.version) || (item.unit !== null && !string(item.unit, 16, 1))
        // 105: depósito padrão (always active), "Desconsiderar saldo deste depósito" and the reserved quantity of the position.
        || typeof item.warehouse_default !== 'boolean' || (item.warehouse_default && !item.warehouse_active) || typeof item.warehouse_ignored !== 'boolean'
        || typeof item.reserved_quantity !== 'string' || !STORED.test(item.reserved_quantity) || item.reserved_quantity.startsWith('-')
        // 145: the part reserved by the sale situations (Preferências > Suprimentos > Estoque) is inside reserved_quantity.
        || typeof item.situation_reserved_quantity !== 'string' || !STORED.test(item.situation_reserved_quantity) || item.situation_reserved_quantity.startsWith('-')
        || units(item.situation_reserved_quantity) > units(item.reserved_quantity)
        // 227: the saldo virtual of a Virtual composition has no position of its own (version 0).
        || (Object.hasOwn(item, 'virtual') && (item.virtual !== true || item.version !== 0))) upstream();
      return { warehouse_id: item.warehouse_id, warehouse_name: item.warehouse_name, warehouse_active: item.warehouse_active, quantity: item.quantity, version: item.version, unit: item.unit,
        warehouse_default: item.warehouse_default, warehouse_ignored: item.warehouse_ignored, reserved_quantity: item.reserved_quantity, situation_reserved_quantity: item.situation_reserved_quantity,
        ...(item.virtual === true ? { virtual: true } : {}) };
    });
    const reservation = originSync(() => reservationPolicyDto(value.reservation, true));
    if (items.filter(item => item.warehouse_default).length > 1 || (items.some(item => item.virtual) && !items.every(item => item.virtual))
      || items.some(item => units(item.situation_reserved_quantity) > 0n && !(reservation.by_situation && reservation.by_warehouse))) upstream();
    return { product_id: value.product_id, items, reservation, data_mode: 'erp_native' };
  }
  if (operation.type === 'ledger') return ledgerResponse(value, operation.args);
  if (operation.type === 'list') {
    if (!Array.isArray(value.items) || value.items.length > operation.args.p_limit || value.limit !== operation.args.p_limit || typeof value.has_more !== 'boolean'
      || (value.has_more ? !uuid(value.next_cursor) : value.next_cursor !== null)) upstream();
    return { items: value.items.map(movement), limit: value.limit, has_more: value.has_more, next_cursor: value.next_cursor, data_mode: 'erp_native' };
  }
  if (typeof value.replayed !== 'boolean') upstream();
  if (operation.rpc !== 'erp_stock_reverse') return { movement: movement(value.movement), replayed: value.replayed, data_mode: 'erp_native' };
  // 145: with "Considerar estorno ... se houver balanço após o lançamento original" off, the reversal comes with the adjustments
  // that keep the balance of each position with a later Balanço: one adjustment line per such position, opposite to the reversal.
  const reversal = movement(value.movement);
  if (reversal.kind !== 'reversal' || reversal.reverses_id !== operation.args.p_movement_id || !Array.isArray(value.balance_adjustments) || value.balance_adjustments.length > 2) upstream();
  const adjustments = value.balance_adjustments.map(movement), compensated = new Set();
  for (const adjustment of adjustments) {
    if (adjustment.kind !== 'adjustment' || adjustment.reverses_id !== null || adjustment.reference !== null) upstream();
    for (const line of adjustment.items) {
      const key = `${line.product_id}:${line.warehouse_id}`, match = reversal.items.find(item => `${item.product_id}:${item.warehouse_id}` === key);
      if (!match || compensated.has(key) || units(line.quantity) !== -units(match.quantity)) upstream();
      compensated.add(key);
    }
  }
  return { movement: reversal, balance_adjustments: adjustments, replayed: value.replayed, data_mode: 'erp_native' };
}
