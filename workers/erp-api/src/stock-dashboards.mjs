/** Dashboards de produtos like Origin (migration 107): Estoque de Produtos, Sem Movimentação, Sugestão de Compras and the
 * per-user Ajustes. Strict params, closed DTOs, exact decimal strings. Routed by stock.mjs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOTAL = /^-?(0|[1-9][0-9]{0,31})\.[0-9]{6}$/;
const MONEY = /^-?(0|[1-9][0-9]{0,35})\.[0-9]{2}$/;
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const INTEGER = /^(0|[1-9][0-9]{0,37})$/;
const PURCHASE = ['open', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled'];
const SALES = ['draft', 'open', 'verified', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const total = value => typeof value === 'string' && TOTAL.test(value) && !/^-0\.0+$/.test(value);
const money = value => typeof value === 'string' && MONEY.test(value) && !/^-0\.00$/.test(value);
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
// 145: Custo = quantity × custo médio rounded to cents like SQL round() (half away from zero), in exact integers.
const priceUnits = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(10, '0')); };
const cents = value => { const negative = value.startsWith('-'), [whole, fraction] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction); return negative ? -result : result; };
const costCents = (quantity, average) => { const product = units(quantity) * priceUnits(average), scale = 100000000000000n, magnitude = product < 0n ? -product : product;
  const rounded = (magnitude + scale / 2n) / scale; return product < 0n ? -rounded : rounded; };
const COST_BASES = ['preco_compra', 'custo_lancamento'];
// 181: Tipo de Estoque of the Origin filter (Físico | Virtual) and the price behind the Valor Estimado.
const STOCK_TYPES = { fisico: 'physical', virtual: 'virtual' };
const PRICE_MODES = ['ultima_compra', 'custo', 'compra'], PRICE_SOURCES = ['supplier_cost', 'supplier_purchase', 'last_purchase'];
const price = value => typeof value === 'string' && PRICE.test(value);
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2100-12-31') return false;
  const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export class StockDashboardsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockDashboardsError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockDashboardsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const BASE = '/v1/estoque/painel';
export function stockDashboardsRoute(path) {
  return { [`${BASE}/estoque`]: { type: 'dash-stock' }, [`${BASE}/sem-movimentacao`]: { type: 'dash-idle' }, [`${BASE}/sugestao`]: { type: 'dash-suggestion' }, [`${BASE}/ajustes`]: { type: 'dash-preference' } }[path] ?? null;
}
export const stockDashboardsMethods = route => route?.type === 'dash-preference' ? ['GET', 'POST'] : route ? ['GET'] : null;
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };
const page = value => { const raw = value ?? '1'; need(/^[1-9][0-9]{0,4}$/.test(raw) && Number(raw) <= 100000); return Number(raw); };
const statuses = (raw, allowed) => { const list = raw.split(','); need(list.length >= 1 && list.length <= allowed.length && list.every(item => allowed.includes(item)) && new Set(list).size === list.length); return list; };
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 4096)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4096) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
export async function stockDashboardsOperation(request, route, search) {
  if (request.method === 'POST') {
    if (search.size) invalid();
    const input = await readBody(request);
    need(only(input, ['command_id', 'expected_version', 'purchase_statuses', 'sales_statuses']) && uuid(input.command_id) && int(input.expected_version, 0, 2147483646)
      && Array.isArray(input.purchase_statuses) && Array.isArray(input.sales_statuses) && input.purchase_statuses.every(item => typeof item === 'string') && input.sales_statuses.every(item => typeof item === 'string'));
    statuses(input.purchase_statuses.join(','), PURCHASE); statuses(input.sales_statuses.join(','), SALES);
    return { type: 'dash-preference-set', rpc: 'erp_stock_dashboard_preference_set', args: { p_command_id: input.command_id.toLowerCase(), p_expected_version: input.expected_version, p_purchase_statuses: input.purchase_statuses, p_sales_statuses: input.sales_statuses } };
  }
  if (route.type === 'dash-preference') { if (search.size) invalid(); return { type: 'dash-preference', rpc: 'erp_stock_dashboard_preference_get', args: {} }; }
  if (route.type === 'dash-stock') {
    // 181: Fornecedor (product supplier, 119) and Tipo de Estoque (Físico | Virtual) are sent only when used, so a database
    // still on 145 keeps answering the screens that do not use them.
    params(search, ['q', 'pesquisar_por', 'warehouse_id', 'marca', 'pagina', 'fornecedor', 'tipo_estoque']);
    const query = search.get('q'), by = search.get('pesquisar_por') ?? 'description', warehouse = search.get('warehouse_id'), brand = search.get('marca'), supplier = search.get('fornecedor'), kind = search.get('tipo_estoque');
    need((query === null || text(query, 120)) && ['code', 'description', 'gtin'].includes(by) && (warehouse === null || uuid(warehouse)) && (brand === null || text(brand, 100))
      && (supplier === null || uuid(supplier)) && (kind === null || Object.hasOwn(STOCK_TYPES, kind)));
    return { type: 'dash-stock', rpc: 'erp_stock_dashboard_stock', args: { p_query: query, p_search_by: by, p_warehouse_id: warehouse?.toLowerCase() ?? null, p_brand: brand, p_page: page(search.get('pagina')), p_size: 100,
      ...(supplier !== null ? { p_supplier_id: supplier.toLowerCase() } : {}), ...(kind !== null ? { p_stock_type: STOCK_TYPES[kind] } : {}) } };
  }
  if (route.type === 'dash-idle') {
    params(search, ['data', 'pagina']);
    const since = search.get('data'); need(date(since));
    return { type: 'dash-idle', rpc: 'erp_stock_dashboard_idle', args: { p_since: since, p_page: page(search.get('pagina')), p_size: 100 } };
  }
  params(search, ['de', 'ate', 'cobertura', 'warehouse_id', 'reserva', 'compras', 'vendas', 'marca', 'fornecedor']);
  const from = search.get('de'), to = search.get('ate'), coverage = search.get('cobertura'), warehouse = search.get('warehouse_id'), reserve = search.get('reserva') ?? 'nao', brand = search.get('marca'), supplier = search.get('fornecedor');
  need(date(from) && date(to) && from <= to && coverage !== null && /^[1-9][0-9]{0,3}$/.test(coverage) && Number(coverage) <= 3650 && (warehouse === null || uuid(warehouse))
    && ['sim', 'nao'].includes(reserve) && search.has('compras') && search.has('vendas') && (brand === null || text(brand, 100)) && (supplier === null || uuid(supplier)));
  return { type: 'dash-suggestion', rpc: 'erp_stock_purchase_suggestion', args: { p_date_from: from, p_date_to: to, p_coverage: Number(coverage), p_warehouse_id: warehouse?.toLowerCase() ?? null,
    p_reserve: reserve === 'sim', p_purchase_statuses: statuses(search.get('compras'), PURCHASE), p_sales_statuses: statuses(search.get('vendas'), SALES), p_brand: brand,
    ...(supplier !== null ? { p_supplier_id: supplier.toLowerCase() } : {}) } };
}
const sorted = list => [...list].sort();
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && sorted(b).every((item, index) => a[index] === item);
function preferenceDto(value) {
  need(object(value) && Array.isArray(value.purchase_statuses) && Array.isArray(value.sales_statuses) && value.purchase_statuses.length >= 1 && value.sales_statuses.length >= 1
    && value.purchase_statuses.every(item => PURCHASE.includes(item)) && value.sales_statuses.every(item => SALES.includes(item)) && int(value.version)
    && (value.updated_at === null ? value.version === 0 : typeof value.updated_at === 'string' && Number.isFinite(Date.parse(value.updated_at))), upstream);
  return { purchase_statuses: [...value.purchase_statuses], sales_statuses: [...value.sales_statuses], version: value.version, updated_at: value.updated_at };
}
const pageShape = (value, args, max) => need(object(value) && value.data_mode === 'erp_native' && value.page === args.p_page && value.size === args.p_size && int(value.total)
  && Array.isArray(value.items) && value.items.length === Math.max(0, Math.min(args.p_size, value.total - (args.p_page - 1) * args.p_size)) && value.items.length <= max, upstream);
export function stockDashboardsResponse(value, operation) {
  const args = operation.args;
  if (operation.type === 'dash-preference' || operation.type === 'dash-preference-set') {
    need(object(value) && value.scope === 'stock_dashboard_preference' && value.data_mode === 'erp_native', upstream);
    const preference = preferenceDto(value.preference);
    if (operation.type === 'dash-preference') return { preference, scope: value.scope, data_mode: 'erp_native' };
    need(typeof value.replayed === 'boolean' && object(value.receipt) && value.receipt.command_id === args.p_command_id && value.receipt.from_version === args.p_expected_version
      && value.receipt.to_version === args.p_expected_version + 1 && (value.replayed || (preference.version === args.p_expected_version + 1
        && sameList(preference.purchase_statuses, args.p_purchase_statuses) && sameList(preference.sales_statuses, args.p_sales_statuses))), upstream);
    return { preference, replayed: value.replayed, receipt: { command_id: value.receipt.command_id, from_version: value.receipt.from_version, to_version: value.receipt.to_version }, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'dash-stock') {
    pageShape(value, args, 100);
    const supplierId = args.p_supplier_id ?? null, stockType = args.p_stock_type ?? null;
    need(value.scope === 'stock_dashboard_stock' && object(value.filters) && value.filters.query === args.p_query && value.filters.search_by === args.p_search_by
      && value.filters.warehouse_id === args.p_warehouse_id && value.filters.brand === args.p_brand && object(value.totals) && total(value.totals.quantity) && money(value.totals.value)
      && int(value.totals.unpriced) && Array.isArray(value.warehouses) && value.warehouses.length <= 1000, upstream);
    // 181: the echo of Fornecedor and Tipo de Estoque. A database still on 145 has no such filters (they are never sent to it).
    const modern = Object.hasOwn(value.totals, 'stock_cost');
    need(modern ? value.filters.supplier_id === supplierId && value.filters.stock_type === stockType : supplierId === null && stockType === null, upstream);
    // 145: the Custo column (quantity × custo médio) is purchase data, null for who does not read purchase orders.
    const visible = value.cost_visible;
    need(typeof visible === 'boolean' && COST_BASES.includes(value.cost_basis) && (visible ? money(value.totals.cost) && int(value.totals.uncosted) : value.totals.cost === null && value.totals.uncosted === null), upstream);
    // 181: Custo of Origin = custo do fornecedor padrão × quantidade (stock_cost); without it, the custo médio. Without the 181 fields
    // (database on 145) the Custo is the custo médio, as before.
    need(!modern || (visible ? money(value.totals.stock_cost) && int(value.totals.stock_uncosted) && int(value.totals.supplier_costed)
      : value.totals.stock_cost === null && value.totals.stock_uncosted === null && value.totals.supplier_costed === null), upstream);
    const items = value.items.map(item => { need(object(item) && uuid(item.product_id) && (item.code === null || text(item.code, 100)) && text(item.name, 200, 1) && total(item.quantity) && (item.value === null || money(item.value))
      && (item.average_cost === null ? item.cost === null : visible && typeof item.average_cost === 'string' && PRICE.test(item.average_cost) && money(item.cost) && cents(item.cost) === costCents(item.quantity, item.average_cost)), upstream);
      const supplier = modern ? item.supplier_cost : null, unit = modern ? item.unit_cost : item.average_cost, source = modern ? item.cost_source : item.average_cost === null ? null : 'average', stock = modern ? item.stock_cost : item.cost;
      need((supplier === null || (visible && price(supplier))) && unit === (supplier ?? item.average_cost) && source === (supplier !== null ? 'supplier' : item.average_cost !== null ? 'average' : null)
        && (unit === null ? stock === null : money(stock) && cents(stock) === costCents(item.quantity, unit)), upstream);
      return { product_id: item.product_id, code: item.code, name: item.name, quantity: item.quantity, value: item.value, average_cost: item.average_cost, cost: item.cost,
        supplier_cost: supplier, unit_cost: unit, cost_source: source, stock_cost: stock }; });
    const warehouses = value.warehouses.map(item => { need(object(item) && uuid(item.warehouse_id) && text(item.name, 200, 1) && typeof item.ignored === 'boolean' && total(item.quantity) && money(item.value)
      && (visible ? money(item.cost) : item.cost === null) && (!modern || (visible ? money(item.stock_cost) : item.stock_cost === null)) && (args.p_warehouse_id === null || item.warehouse_id === args.p_warehouse_id), upstream);
      return { warehouse_id: item.warehouse_id, name: item.name, ignored: item.ignored, quantity: item.quantity, value: item.value, cost: item.cost, stock_cost: modern ? item.stock_cost : item.cost }; });
    // Without a warehouse filter the total is the sum of the considered warehouses.
    const considered = warehouses.filter(item => args.p_warehouse_id !== null || !item.ignored).reduce((sum, item) => sum + units(item.quantity), 0n);
    need(considered === units(value.totals.quantity), upstream);
    return { items, page: value.page, size: value.size, total: value.total, totals: { quantity: value.totals.quantity, value: value.totals.value, unpriced: value.totals.unpriced, cost: value.totals.cost, uncosted: value.totals.uncosted,
      stock_cost: modern ? value.totals.stock_cost : value.totals.cost, stock_uncosted: modern ? value.totals.stock_uncosted : value.totals.uncosted, supplier_costed: modern ? value.totals.supplier_costed : visible ? 0 : null },
      warehouses, cost_visible: visible, cost_basis: value.cost_basis, filters: { query: args.p_query, search_by: args.p_search_by, warehouse_id: args.p_warehouse_id, brand: args.p_brand, supplier_id: supplierId, stock_type: stockType }, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'dash-idle') {
    pageShape(value, args, 100);
    need(value.scope === 'stock_dashboard_idle' && value.since === args.p_since, upstream);
    const items = value.items.map(item => { need(object(item) && uuid(item.product_id) && (item.code === null || text(item.code, 100)) && text(item.name, 200, 1) && total(item.quantity) && units(item.quantity) > 0n
      && (item.last_sale === null || (date(item.last_sale) && item.last_sale < args.p_since)), upstream);
      return { product_id: item.product_id, code: item.code, name: item.name, quantity: item.quantity, last_sale: item.last_sale }; });
    return { items, page: value.page, size: value.size, total: value.total, since: value.since, scope: value.scope, data_mode: 'erp_native' };
  }
  need(object(value) && value.scope === 'stock_purchase_suggestion' && value.data_mode === 'erp_native' && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(2000, value.total)
    && object(value.filters) && value.filters.date_from === args.p_date_from && value.filters.date_to === args.p_date_to && value.filters.coverage === args.p_coverage
    && value.filters.warehouse_id === args.p_warehouse_id && value.filters.reserve === args.p_reserve && value.filters.brand === args.p_brand
    && sameList(value.filters.purchase_statuses, args.p_purchase_statuses) && sameList(value.filters.sales_statuses, args.p_sales_statuses)
    && int(value.days, 1) && value.days === Math.round((Date.parse(args.p_date_to) - Date.parse(args.p_date_from)) / 86400000) + 1, upstream);
  // 181: Fornecedor, the price behind the Valor Estimado and, per row, the unit and the supplier (for "Gerar pedido de compra").
  const supplierId = args.p_supplier_id ?? null, modern = Object.hasOwn(value, 'price_mode');
  need(modern ? PRICE_MODES.includes(value.price_mode) && value.filters.supplier_id === supplierId : supplierId === null && value.filters.supplier_id === undefined, upstream);
  const items = value.items.map(item => {
    need(object(item) && uuid(item.product_id) && (item.code === null || text(item.code, 100)) && text(item.name, 200, 1) && total(item.sold) && units(item.sold) > 0n && total(item.stock)
      && total(item.reserved) && !item.reserved.startsWith('-') && (args.p_reserve || units(item.reserved) === 0n) && total(item.ordered) && !item.ordered.startsWith('-')
      && typeof item.suggestion === 'string' && INTEGER.test(item.suggestion) && (item.unit_price === null ? item.value === null : typeof item.unit_price === 'string' && PRICE.test(item.unit_price) && money(item.value)), upstream);
    // Exact check of the formula: suggestion = max(0, floor((sold × coverage − (stock − reserved + ordered) × days) ÷ days));
    // with Reserva = Sim the Estoque Atual is the balance less the reserved quantity.
    const numerator = units(item.sold) * BigInt(args.p_coverage) - (units(item.stock) - units(item.reserved) + units(item.ordered)) * BigInt(value.days), denominator = BigInt(value.days) * 1000000n;
    const expected = numerator <= 0n ? 0n : numerator / denominator;
    need(BigInt(item.suggestion) === expected, upstream);
    const unit = modern ? item.unit : null, source = modern ? item.price_source : item.unit_price === null ? null : 'last_purchase', supplier = modern ? item.supplier_id : null, supplierName = modern ? item.supplier_name : null;
    need((unit === null || text(unit, 16, 1)) && (source === null ? item.unit_price === null : PRICE_SOURCES.includes(source) && item.unit_price !== null)
      && (!source?.startsWith('supplier') || (value.price_mode === (source === 'supplier_cost' ? 'custo' : 'compra') && supplier !== null))
      && (supplier === null ? supplierName === null : uuid(supplier) && text(supplierName, 200, 1) && (supplierId === null || supplier === supplierId)), upstream);
    return { product_id: item.product_id, code: item.code, name: item.name, sold: item.sold, stock: item.stock, reserved: item.reserved, ordered: item.ordered, suggestion: item.suggestion, unit_price: item.unit_price, value: item.value,
      unit, price_source: source, supplier_id: supplier, supplier_name: supplierName };
  });
  return { items, total: value.total, days: value.days, price_mode: modern ? value.price_mode : 'ultima_compra', filters: { date_from: args.p_date_from, date_to: args.p_date_to, coverage: args.p_coverage, warehouse_id: args.p_warehouse_id, reserve: args.p_reserve,
    purchase_statuses: sorted(args.p_purchase_statuses), sales_statuses: sorted(args.p_sales_statuses), brand: args.p_brand, supplier_id: supplierId }, scope: value.scope, data_mode: 'erp_native' };
}
