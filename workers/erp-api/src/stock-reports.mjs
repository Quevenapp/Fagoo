/** Relatórios de suprimentos like Origin (migration 146), read-only, under /v1/estoque/relatorios/<relatório>.
 * Strict params, exact decimal strings and fail-closed projections that recompute what can be recomputed. Routed by stock.mjs. */
import { documentNativeCoverage } from '../../../packages/erp-domain/src/document-mirror.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTY = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{6}$/, Q4 = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{4}$/, MONEY = /^-?(0|[1-9][0-9]{0,35})\.[0-9]{2}$/, PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const PURCHASE = ['open', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const nonZero = value => !/^-0\.0+$/.test(value);
const qty = value => typeof value === 'string' && QTY.test(value) && nonZero(value);
const q4 = value => typeof value === 'string' && Q4.test(value) && nonZero(value);
const money = value => typeof value === 'string' && MONEY.test(value) && nonZero(value);
const units = (value, scale = 6) => { const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale)); return negative ? -result : result; };
// round(quantity × price, 2) like SQL (half away from zero): 6 + 10 decimals → 2.
const valueCents = (quantity, price) => { const product = units(quantity) * units(price, 10), scale = 100000000000000n, magnitude = product < 0n ? -product : product, rounded = (magnitude + scale / 2n) / scale; return product < 0n ? -rounded : rounded; };
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const days = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
export class StockReportsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockReportsError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockReportsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };

const REPORTS = {
  'entradas-saidas': { rpc: 'erp_stock_report_movements', params: ['de', 'ate', 'warehouse_id', 'product_id', 'offset'] },
  transferencias: { rpc: 'erp_stock_report_transfers', params: ['de', 'ate', 'warehouse_id', 'offset'] },
  saldos: { rpc: 'erp_stock_report_balances_at', params: ['data', 'warehouse_id', 'offset'] },
  'maior-circulacao': { rpc: 'erp_stock_report_top', params: ['de', 'ate', 'warehouse_id', 'limite'] },
  'sem-movimentacao': { rpc: 'erp_stock_report_idle', params: ['data', 'warehouse_id', 'offset'] },
  'abaixo-minimo': { rpc: 'erp_stock_report_below_min', params: ['warehouse_id', 'offset'] },
  'visao-financeira': { rpc: 'erp_stock_report_financial', params: ['warehouse_id', 'offset'] },
  'movimentacao-produto': { rpc: 'erp_stock_report_product', params: ['product_id', 'de', 'ate', 'warehouse_id'] },
  'pedidos-compra': { rpc: 'erp_stock_report_purchase_orders', params: ['de', 'ate', 'situacoes', 'agrupar'] },
  'notas-entrada': { rpc: 'erp_stock_report_entry_notes', params: ['de', 'ate', 'agrupar'] },
};
export const STOCK_REPORT_IDS = Object.freeze(Object.keys(REPORTS));
export function stockReportsRoute(path) {
  const match = /^\/v1\/estoque\/relatorios\/([a-z-]+)$/.exec(path);
  return match && Object.hasOwn(REPORTS, match[1]) ? { type: 'report', report: match[1] } : null;
}
export const stockReportsMethods = route => route ? ['GET'] : null;
const PO_GROUPS = { fornecedor: 'supplier', produto: 'product' }, NOTE_GROUPS = { operacao: 'nature', fornecedor: 'supplier', produto: 'product', evolucao: 'month' };
export function stockReportsOperation(request, route, search) {
  const spec = REPORTS[route.report];
  for (const key of search.keys()) if (!spec.params.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid();
  const get = key => search.get(key), args = {};
  const period = () => { const from = get('de'), to = get('ate'); need(date(from) && date(to) && from <= to && days(from, to) <= 3660); args.p_date_from = from; args.p_date_to = to; };
  const warehouse = () => { const value = get('warehouse_id'); need(value === null || uuid(value)); args.p_warehouse_id = value?.toLowerCase() ?? null; };
  const page = () => { const value = get('offset') ?? '0'; need(/^(0|[1-9][0-9]{0,5})$/.test(value) && Number(value) <= 100000); args.p_offset = Number(value); args.p_limit = 500; };
  switch (route.report) {
    case 'entradas-saidas': { period(); warehouse(); const product = get('product_id'); need(product === null || uuid(product)); args.p_product_id = product?.toLowerCase() ?? null; page(); break; }
    case 'transferencias': period(); warehouse(); page(); break;
    case 'saldos': { const day = get('data'); need(date(day)); args.p_date = day; warehouse(); page(); break; }
    case 'maior-circulacao': { period(); warehouse(); const limit = get('limite') ?? '50'; need(/^[1-9][0-9]{0,2}$/.test(limit) && Number(limit) <= 500); args.p_limit = Number(limit); break; }
    case 'sem-movimentacao': { const day = get('data'); need(date(day)); args.p_since = day; warehouse(); page(); break; }
    case 'abaixo-minimo': case 'visao-financeira': warehouse(); page(); break;
    case 'movimentacao-produto': { const product = get('product_id'); need(uuid(product)); args.p_product_id = product.toLowerCase(); period(); warehouse(); break; }
    case 'pedidos-compra': {
      period(); const list = (get('situacoes') ?? '').split(','), group = get('agrupar');
      need(list.length >= 1 && list.every(item => PURCHASE.includes(item)) && new Set(list).size === list.length && Object.hasOwn(PO_GROUPS, group));
      args.p_statuses = list; args.p_group = PO_GROUPS[group]; break;
    }
    default: { period(); const group = get('agrupar'); need(Object.hasOwn(NOTE_GROUPS, group)); args.p_group = NOTE_GROUPS[group]; }
  }
  return { type: 'report', report: route.report, rpc: spec.rpc, args };
}

const productDto = item => { need(uuid(item.product_id) && optionalText(item.code, 100) && text(item.name, 200, 1) && optionalText(item.unit, 16), upstream); return { product_id: item.product_id, code: item.code, name: item.name, unit: item.unit }; };
const pageShape = (value, args) => need(value.offset === args.p_offset && value.limit === args.p_limit && int(value.total) && Array.isArray(value.items)
  && value.items.length === Math.max(0, Math.min(args.p_limit, value.total - args.p_offset)), upstream);
const sameFilters = (value, expected) => need(only(value, Object.keys(expected)) && Object.entries(expected).every(([key, item]) => Array.isArray(item) ? Array.isArray(value[key]) && value[key].length === item.length && [...item].sort().every((entry, index) => value[key][index] === entry) : value[key] === item), upstream);
const sum = (items, key, scale = 6) => items.reduce((total, item) => total + units(item[key], scale), 0n);
function base(value, operation, scope) { need(object(value) && value.scope === scope && value.data_mode === 'erp_native', upstream); return operation.args; }
const PROJECT = {
  'entradas-saidas'(value, operation) {
    const args = base(value, operation, 'stock_report_movements'); pageShape(value, args);
    sameFilters(value.filters, { date_from: args.p_date_from, date_to: args.p_date_to, warehouse_id: args.p_warehouse_id, product_id: args.p_product_id });
    const items = value.items.map(item => { need(object(item) && qty(item.entries) && qty(item.exits) && qty(item.balances) && qty(item.net) && !item.entries.startsWith('-') && !item.exits.startsWith('-') && int(item.launches, 1)
      && units(item.net) === units(item.entries) - units(item.exits) + units(item.balances) && (args.p_product_id === null || item.product_id === args.p_product_id), upstream);
      return { ...productDto(item), entries: item.entries, exits: item.exits, balances: item.balances, net: item.net, launches: item.launches }; });
    const t = value.totals; need(only(t, ['entries', 'exits', 'balances', 'net']) && ['entries', 'exits', 'balances', 'net'].every(key => qty(t[key])) && units(t.net) === units(t.entries) - units(t.exits) + units(t.balances)
      && (value.total > items.length || ['entries', 'exits', 'balances'].every(key => sum(items, key) === units(t[key]))), upstream);
    return { items, totals: { entries: t.entries, exits: t.exits, balances: t.balances, net: t.net } };
  },
  transferencias(value, operation) {
    const args = base(value, operation, 'stock_report_transfers'); pageShape(value, args);
    sameFilters(value.filters, { date_from: args.p_date_from, date_to: args.p_date_to, warehouse_id: args.p_warehouse_id });
    const items = value.items.map(item => { need(object(item) && uuid(item.movement_id) && date(item.occurred_on) && item.occurred_on >= args.p_date_from && item.occurred_on <= args.p_date_to && qty(item.quantity) && units(item.quantity) > 0n
      && uuid(item.source_id) && uuid(item.destination_id) && item.source_id !== item.destination_id && text(item.source_name, 200, 1) && text(item.destination_name, 200, 1) && text(item.note, 500)
      && typeof item.reversed === 'boolean' && (args.p_warehouse_id === null || [item.source_id, item.destination_id].includes(args.p_warehouse_id)), upstream);
      return { ...productDto(item), movement_id: item.movement_id, occurred_on: item.occurred_on, quantity: item.quantity, source_id: item.source_id, source_name: item.source_name,
        destination_id: item.destination_id, destination_name: item.destination_name, note: item.note, reversed: item.reversed }; });
    return { items };
  },
  saldos(value, operation) {
    const args = base(value, operation, 'stock_report_balances_at'); pageShape(value, args);
    sameFilters(value.filters, { date: args.p_date, warehouse_id: args.p_warehouse_id });
    const items = value.items.map(item => { need(object(item) && qty(item.quantity) && units(item.quantity) !== 0n, upstream); return { ...productDto(item), quantity: item.quantity }; });
    need(only(value.totals, ['quantity']) && qty(value.totals.quantity) && (value.total > items.length || sum(items, 'quantity') === units(value.totals.quantity)), upstream);
    return { items, totals: { quantity: value.totals.quantity } };
  },
  'maior-circulacao'(value, operation) {
    const args = base(value, operation, 'stock_report_top');
    need(value.limit === args.p_limit && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(args.p_limit, value.total), upstream);
    sameFilters(value.filters, { date_from: args.p_date_from, date_to: args.p_date_to, warehouse_id: args.p_warehouse_id });
    const items = value.items.map(item => { need(object(item) && qty(item.entries) && qty(item.exits) && qty(item.moved) && !item.entries.startsWith('-') && !item.exits.startsWith('-')
      && units(item.moved) === units(item.entries) + units(item.exits) && units(item.moved) > 0n && int(item.launches, 1), upstream);
      return { ...productDto(item), entries: item.entries, exits: item.exits, moved: item.moved, launches: item.launches }; });
    need(items.every((item, index) => index === 0 || units(items[index - 1].moved) >= units(item.moved)), upstream);
    return { items };
  },
  'sem-movimentacao'(value, operation) {
    const args = base(value, operation, 'stock_report_idle'); pageShape(value, args);
    sameFilters(value.filters, { since: args.p_since, warehouse_id: args.p_warehouse_id });
    const items = value.items.map(item => { need(object(item) && qty(item.quantity) && units(item.quantity) !== 0n && (item.last_movement === null || (date(item.last_movement) && item.last_movement < args.p_since)), upstream);
      return { ...productDto(item), quantity: item.quantity, last_movement: item.last_movement }; });
    return { items };
  },
  'abaixo-minimo'(value, operation) {
    const args = base(value, operation, 'stock_report_below_min'); pageShape(value, args);
    sameFilters(value.filters, { warehouse_id: args.p_warehouse_id });
    const items = value.items.map(item => { need(object(item) && qty(item.stock_min) && !item.stock_min.startsWith('-') && (item.stock_max === null || qty(item.stock_max)) && qty(item.quantity) && qty(item.missing)
      && units(item.quantity) < units(item.stock_min) && units(item.missing) === units(item.stock_min) - units(item.quantity), upstream);
      return { ...productDto(item), stock_min: item.stock_min, stock_max: item.stock_max, quantity: item.quantity, missing: item.missing }; });
    return { items };
  },
  'visao-financeira'(value, operation) {
    const args = base(value, operation, 'stock_report_financial'); pageShape(value, args);
    sameFilters(value.filters, { warehouse_id: args.p_warehouse_id }); need(['preco_compra', 'custo_lancamento'].includes(value.cost_basis), upstream);
    const items = value.items.map(item => {
      const price = value => value === null || (typeof value === 'string' && PRICE.test(value));
      need(object(item) && qty(item.quantity) && units(item.quantity) !== 0n && price(item.average_cost) && price(item.sale_price)
        && (item.average_cost === null ? item.cost_value === null : money(item.cost_value) && units(item.cost_value, 2) === valueCents(item.quantity, item.average_cost))
        && (item.sale_price === null ? item.sale_value === null : money(item.sale_value) && units(item.sale_value, 2) === valueCents(item.quantity, item.sale_price))
        && (item.cost_value === null || item.sale_value === null ? item.margin === null : money(item.margin) && units(item.margin, 2) === units(item.sale_value, 2) - units(item.cost_value, 2)), upstream);
      return { ...productDto(item), quantity: item.quantity, average_cost: item.average_cost, cost_value: item.cost_value, sale_price: item.sale_price, sale_value: item.sale_value, margin: item.margin };
    });
    const t = value.totals;
    need(only(t, ['quantity', 'cost_value', 'sale_value', 'margin', 'uncosted', 'unpriced']) && qty(t.quantity) && money(t.cost_value) && money(t.sale_value) && money(t.margin) && int(t.uncosted) && int(t.unpriced)
      && (value.total > items.length || (sum(items, 'quantity') === units(t.quantity) && items.filter(item => item.cost_value === null).length === t.uncosted)), upstream);
    return { items, cost_basis: value.cost_basis, totals: { quantity: t.quantity, cost_value: t.cost_value, sale_value: t.sale_value, margin: t.margin, uncosted: t.uncosted, unpriced: t.unpriced } };
  },
  'movimentacao-produto'(value, operation) {
    const args = base(value, operation, 'stock_report_product');
    sameFilters(value.filters, { product_id: args.p_product_id, date_from: args.p_date_from, date_to: args.p_date_to, warehouse_id: args.p_warehouse_id });
    need(object(value.product) && value.product.product_id === args.p_product_id && qty(value.opening) && qty(value.closing) && Array.isArray(value.days) && value.days.length <= 3661, upstream);
    let running = units(value.opening), previous = '';
    const items = value.days.map(day => { need(only(day, ['date', 'entries', 'exits', 'balance']) && date(day.date) && day.date > previous && day.date >= args.p_date_from && day.date <= args.p_date_to
      && qty(day.entries) && qty(day.exits) && qty(day.balance) && !day.entries.startsWith('-') && !day.exits.startsWith('-'), upstream);
      running += units(day.entries) - units(day.exits); previous = day.date; need(running === units(day.balance), upstream);
      return { date: day.date, entries: day.entries, exits: day.exits, balance: day.balance }; });
    const t = value.totals;
    need(running === units(value.closing) && only(t, ['entries', 'exits']) && qty(t.entries) && qty(t.exits) && sum(items, 'entries') === units(t.entries) && sum(items, 'exits') === units(t.exits), upstream);
    return { product: productDto(value.product), opening: value.opening, days: items, closing: value.closing, totals: { entries: t.entries, exits: t.exits } };
  },
  'pedidos-compra'(value, operation) {
    const args = base(value, operation, 'stock_report_purchase_orders');
    sameFilters(value.filters, { date_from: args.p_date_from, date_to: args.p_date_to, statuses: args.p_statuses, group: args.p_group });
    return grouped(value, ['orders', 'quantity', 'value'], item => int(item.orders, 1) && qty(item.quantity), t => only(t, ['orders', 'quantity', 'value']) && int(t.orders) && qty(t.quantity) && money(t.value));
  },
  'notas-entrada'(value, operation) {
    const args = base(value, operation, 'stock_report_entry_notes');
    sameFilters(value.filters, { date_from: args.p_date_from, date_to: args.p_date_to, group: args.p_group });
    return grouped(value, ['notes', 'quantity', 'value'], item => int(item.notes, 1) && (args.p_group === 'product' ? q4(item.quantity) : item.quantity === null), t => only(t, ['notes', 'value']) && int(t.notes) && money(t.value));
  },
};
function grouped(value, keys, row, totals) {
  need(int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(2000, value.total) && totals(value.totals), upstream);
  const items = value.items.map(item => { need(object(item) && text(item.key, 300, 1) && text(item.label, 200, 1) && optionalText(item.code, 100) && money(item.value) && row(item), upstream);
    return Object.fromEntries(['key', 'label', 'code', ...keys].map(key => [key, item[key]])); });
  need(new Set(items.map(item => item.key)).size === items.length, upstream);
  return { items, totals: { ...value.totals } };
}
export function stockReportsResponse(value, operation) {
  const project = PROJECT[operation.report]; need(project, upstream);
  const body = project(value, operation);
  let coverage;try{coverage=documentNativeCoverage(value);}catch{need(false,upstream);}
  return { report: operation.report, filters: structuredClone(value.filters), total: value.total ?? null, offset: value.offset ?? null, limit: value.limit ?? null, ...body, scope: value.scope, data_mode: 'erp_native', ...coverage };
}
