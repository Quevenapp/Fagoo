/** Composições no padrão do Origin (migrations 222/223), routed through stock.mjs:
 * - GET /v1/estoque/composicoes/{produto}: the Estrutura of a product (components, totals, saldo virtual, Preferências);
 * - GET /v1/estoque/composicoes/componentes?q=&excluir=: the "Componente" autocomplete (simple active products);
 * - POST /v1/estoque/composicoes/{produto}/lancamentos: "Novo Lançamento" (Entrada | Saída) of a composition; GET lists its lançamentos;
 * - GET /v1/estoque/composicoes/exportacao?offset=&limit=&incluir_excluidos=: "Exportar dados de estrutura para planilha".
 * - 280: GET /v1/estoque/composicoes/itens/{item}?documento= and POST /v1/estoque/composicoes/itens/{item}: "Componentes do item (kit)" of a
 *   pedido de venda or OS item (the components of that item, with the stock), saved with the expected versions of the pedido and of the item.
 * The structure itself is saved with the product (POST/PATCH /v1/cadastros/products/.../completo with data.composition); its body
 * and receipt are checked here. Strict params and closed bodies, exact decimal strings (BigInt), projected responses. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY = /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const PRICE_INPUT = /^(0|[1-9][0-9]{0,13})(?:\.[0-9]{1,10})?$/;
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const TOTAL_PRICE = /^(0|[1-9][0-9]{0,17})\.[0-9]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const STOCK_TYPES = ['physical', 'virtual'];
export const POST_MODES = ['product', 'components', 'both'];
const PROBLEMS = ['not_found', 'not_product', 'not_simple', 'deleted', 'inactive', 'no_unit'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const price = value => value === null || (typeof value === 'string' && PRICE.test(value));
const stored = value => typeof value === 'string' && STORED.test(value) && !/^-0\.0+$/.test(value);
const optionalStored = value => value === null || stored(value);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
export const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
export class StockCompositionsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockCompositionsError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockCompositionsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };

export function stockCompositionsRoute(path) {
  if (path === '/v1/estoque/composicoes/componentes') return { type: 'composition-components' };
  if (path === '/v1/estoque/composicoes/exportacao') return { type: 'composition-export' };
  const item = /^\/v1\/estoque\/composicoes\/itens\/([0-9a-fA-F-]{36})$/.exec(path);
  if (item) return uuid(item[1]) ? { type: 'item-components', id: item[1].toLowerCase() } : null;
  const match = /^\/v1\/estoque\/composicoes\/([0-9a-fA-F-]{36})(\/lancamentos)?$/.exec(path);
  if (!match || !uuid(match[1])) return null;
  return { type: match[2] ? 'composition-launch' : 'composition', id: match[1].toLowerCase() };
}
export const stockCompositionsMethods = route => route?.type === 'composition-launch' || route?.type === 'item-components' ? ['GET', 'POST'] : route ? ['GET'] : null;
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 16384)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
const optionalPrice = value => value === undefined || value === null ? null : typeof value === 'string' && PRICE_INPUT.test(value) ? value : invalid();

export async function stockCompositionsOperation(request, route, search) {
  if (route.type === 'item-components') {
    if (request.method === 'GET') {
      params(search, ['documento']); const document = search.get('documento'); need(uuid(document));
      return { type: 'item-components', rpc: 'erp_stock_item_components', args: { p_document_id: document.toLowerCase(), p_item_id: route.id } };
    }
    if (search.size) invalid();
    const input = await readBody(request);
    need(only(input, ['command_id', 'document_id', 'expected_document_version', 'expected_version', 'components']) && uuid(input.command_id) && uuid(input.document_id)
      && int(input.expected_document_version, 1, 2147483646) && int(input.expected_version, 0, 2147483646)
      && (input.components === null || (Array.isArray(input.components) && input.components.length >= 1 && input.components.length <= 100)));
    const seen = new Set();
    const components = input.components === null ? null : input.components.map(line => {
      need(only(line, ['component_id', 'quantity']) && uuid(line.component_id) && !seen.has(line.component_id.toLowerCase()) && typeof line.quantity === 'string'
        && QUANTITY.test(line.quantity) && units(line.quantity) > 0n);
      seen.add(line.component_id.toLowerCase()); return { component_id: line.component_id.toLowerCase(), quantity: line.quantity };
    });
    return { type: 'item-components-save', rpc: 'erp_stock_item_components_save', args: { p_command_id: input.command_id.toLowerCase(), p_document_id: input.document_id.toLowerCase(),
      p_expected_document_version: input.expected_document_version, p_item_id: route.id, p_expected_version: input.expected_version, p_components: components } };
  }
  if (route.type === 'composition') { params(search, []); return { type: route.type, rpc: 'erp_stock_composition_get', args: { p_product_id: route.id } }; }
  if (route.type === 'composition-components') {
    params(search, ['q', 'excluir']); const query = search.get('q'), exclude = search.get('excluir');
    need(text(query, 120, 1) && (exclude === null || uuid(exclude)));
    return { type: route.type, rpc: 'erp_stock_composition_components', args: { p_query: query, p_exclude: exclude?.toLowerCase() ?? null } };
  }
  if (route.type === 'composition-export') {
    params(search, ['offset', 'limit', 'incluir_excluidos']);
    const offset = search.get('offset') ?? '0', limit = search.get('limit') ?? '500', deleted = search.get('incluir_excluidos') ?? 'false';
    need(/^(0|[1-9]\d{0,7})$/.test(offset) && /^[1-9]\d{0,2}$/.test(limit) && Number(limit) <= 500 && ['true', 'false'].includes(deleted));
    return { type: route.type, rpc: 'erp_stock_composition_export', args: { p_offset: Number(offset), p_limit: Number(limit), p_include_deleted: deleted === 'true' } };
  }
  if (request.method === 'GET') {
    params(search, ['limit']); const limit = search.get('limit') ?? '10'; need(/^[1-9]\d?$/.test(limit) && Number(limit) <= 20);
    return { type: 'composition-launches', rpc: 'erp_stock_composition_launches', args: { p_product_id: route.id, p_limit: Number(limit) } };
  }
  if (search.size) invalid();
  const input = await readBody(request);
  need(only(input, ['command_id', 'kind', 'warehouse_id', 'quantity', 'expected_version', 'note', 'unit_price', 'unit_cost']) && uuid(input.command_id) && ['receipt', 'issue'].includes(input.kind)
    && uuid(input.warehouse_id) && typeof input.quantity === 'string' && QUANTITY.test(input.quantity) && units(input.quantity) > 0n
    && (input.expected_version === undefined || input.expected_version === null || int(input.expected_version, 0, 2147483646))
    && (input.note === undefined || input.note === null || text(input.note, 500)) && !(input.kind === 'issue' && input.unit_cost !== undefined && input.unit_cost !== null));
  return { type: route.type, rpc: 'erp_stock_composition_launch', args: { p_command_id: input.command_id.toLowerCase(), p_kind: input.kind, p_product_id: route.id,
    p_warehouse_id: input.warehouse_id.toLowerCase(), p_quantity: input.quantity, p_expected_version: input.expected_version ?? null, p_note: input.note ?? null,
    p_unit_price: optionalPrice(input.unit_price), p_unit_cost: optionalPrice(input.unit_cost) } };
}

const settingsDto = value => { need(exact(value, ['update_cost', 'update_weight', 'update_price']) && Object.values(value).every(item => typeof item === 'boolean'), upstream);
  return { update_cost: value.update_cost, update_weight: value.update_weight, update_price: value.update_price }; };
const totalsDto = value => {
  need(exact(value, ['items', 'sale', 'unpriced', 'cost', 'uncosted', 'net_weight', 'gross_weight', 'weighted']) && int(value.items, 0, 100) && typeof value.sale === 'string' && TOTAL_PRICE.test(value.sale)
    && typeof value.cost === 'string' && TOTAL_PRICE.test(value.cost) && int(value.unpriced, 0, value.items) && int(value.uncosted, 0, value.items) && stored(value.net_weight) && stored(value.gross_weight)
    && int(value.weighted, 0, value.items), upstream);
  return { items: value.items, sale: value.sale, unpriced: value.unpriced, cost: value.cost, uncosted: value.uncosted, net_weight: value.net_weight, gross_weight: value.gross_weight, weighted: value.weighted };
};
/** The structure as stored (version and items), shared by the read and the receipt of the product save. */
export function compositionDto(value) {
  if (value === null) return null;
  need(exact(value, ['stock_type', 'post_mode', 'version', 'updated_at', 'items']) && STOCK_TYPES.includes(value.stock_type) && POST_MODES.includes(value.post_mode)
    && (value.stock_type === 'physical' || value.post_mode === 'components') && int(value.version, 1) && instant(value.updated_at) && Array.isArray(value.items) && value.items.length <= 100, upstream);
  const items = value.items.map((item, index) => { need(exact(item, ['position', 'component_id', 'quantity']) && item.position === index + 1 && uuid(item.component_id) && stored(item.quantity) && units(item.quantity) > 0n, upstream);
    return { position: item.position, component_id: item.component_id, quantity: item.quantity }; });
  need(new Set(items.map(item => item.component_id)).size === items.length, upstream);
  return { stock_type: value.stock_type, post_mode: value.post_mode, version: value.version, updated_at: value.updated_at, items };
}

function getDto(value, args) {
  need(exact(value, ['scope', 'data_mode', 'product', 'stock_visible', 'composition', 'items', 'totals', 'virtual', 'used_in', 'settings']) && value.scope === 'stock_composition'
    && typeof value.stock_visible === 'boolean' && int(value.used_in) && Array.isArray(value.items) && value.items.length <= 100, upstream);
  const p = value.product;
  need(exact(p, ['id', 'name', 'code', 'kind', 'format', 'unit', 'active', 'version', 'price', 'net_weight', 'gross_weight', 'cost_price', 'default_supplier']) && p.id === args.p_product_id
    && text(p.name, 200, 1) && optionalText(p.code, 100) && (p.kind === null || ['P', 'S', 'N'].includes(p.kind)) && (p.format === null || ['S', 'V', 'E'].includes(p.format)) && optionalText(p.unit, 16)
    && typeof p.active === 'boolean' && int(p.version, 1) && price(p.price) && optionalStored(p.net_weight) && optionalStored(p.gross_weight) && price(p.cost_price) && typeof p.default_supplier === 'boolean', upstream);
  const c = value.composition;
  need(c === null || (exact(c, ['stock_type', 'post_mode', 'version', 'updated_at']) && STOCK_TYPES.includes(c.stock_type) && POST_MODES.includes(c.post_mode)
    && (c.stock_type === 'physical' || c.post_mode === 'components') && int(c.version, 1) && instant(c.updated_at)), upstream);
  need(c !== null || value.items.length === 0, upstream);
  const items = value.items.map((item, index) => {
    need(exact(item, ['position', 'component_id', 'name', 'code', 'unit', 'kind', 'format', 'active', 'problem', 'quantity', 'price', 'cost_price', 'stock']) && item.position === index + 1
      && uuid(item.component_id) && item.component_id !== p.id && text(item.name, 200, 1) && optionalText(item.code, 100) && optionalText(item.unit, 16) && (item.kind === null || ['P', 'S', 'N'].includes(item.kind))
      && (item.format === null || ['S', 'V', 'E'].includes(item.format)) && typeof item.active === 'boolean' && (item.problem === null || PROBLEMS.includes(item.problem))
      && stored(item.quantity) && units(item.quantity) > 0n && price(item.price) && price(item.cost_price) && (value.stock_visible ? stored(item.stock) : item.stock === null), upstream);
    return { position: item.position, component_id: item.component_id, name: item.name, code: item.code, unit: item.unit, kind: item.kind, format: item.format, active: item.active,
      problem: item.problem, quantity: item.quantity, price: item.price, cost_price: item.cost_price, stock: item.stock };
  });
  need(new Set(items.map(item => item.component_id)).size === items.length, upstream);
  const totals = totalsDto(value.totals);
  need(totals.items === items.length, upstream);
  let virtual = null;
  if (value.virtual !== null) {
    const v = value.virtual;
    need(value.stock_visible && c?.stock_type === 'virtual' && p.format === 'E' && exact(v, ['quantity', 'warehouses']) && stored(v.quantity) && Array.isArray(v.warehouses) && v.warehouses.length <= 1000, upstream);
    const warehouses = v.warehouses.map(w => { need(exact(w, ['warehouse_id', 'name', 'active', 'ignored', 'quantity']) && uuid(w.warehouse_id) && text(w.name, 200, 1) && typeof w.active === 'boolean'
      && typeof w.ignored === 'boolean' && stored(w.quantity), upstream); return { warehouse_id: w.warehouse_id, name: w.name, active: w.active, ignored: w.ignored, quantity: w.quantity }; });
    need(new Set(warehouses.map(w => w.warehouse_id)).size === warehouses.length, upstream);
    // The total is the sum of the considered warehouses (an ignored warehouse stays out, 105).
    need(warehouses.filter(w => !w.ignored).reduce((sum, w) => sum + units(w.quantity), 0n) === units(v.quantity), upstream);
    virtual = { quantity: v.quantity, warehouses };
  }
  return { product: { id: p.id, name: p.name, code: p.code, kind: p.kind, format: p.format, unit: p.unit, active: p.active, version: p.version, price: p.price, net_weight: p.net_weight,
    gross_weight: p.gross_weight, cost_price: p.cost_price, default_supplier: p.default_supplier }, stock_visible: value.stock_visible,
    composition: c && { stock_type: c.stock_type, post_mode: c.post_mode, version: c.version, updated_at: c.updated_at }, items, totals, virtual, used_in: value.used_in,
    settings: settingsDto(value.settings), scope: value.scope, data_mode: 'erp_native' };
}

function launchDto(value, args) {
  need(exact(value, ['scope', 'data_mode', 'kind', 'occurred_on', 'movement', 'composition', 'lines', 'detail', 'replayed']) && value.scope === 'stock_composition_launch' && value.kind === args.p_kind
    && typeof value.occurred_on === 'string' && DATE.test(value.occurred_on) && typeof value.replayed === 'boolean', upstream);
  const k = value.composition;
  need(exact(k, ['product_id', 'stock_type', 'post_mode', 'version']) && k.product_id === args.p_product_id && STOCK_TYPES.includes(k.stock_type) && POST_MODES.includes(k.post_mode) && int(k.version, 1), upstream);
  need(Array.isArray(value.lines) && value.lines.length >= 1 && value.lines.length <= 100, upstream);
  const sign = args.p_kind === 'issue' ? -1n : 1n, asked = units(args.p_quantity);
  const lines = value.lines.map(line => {
    need(exact(line, ['product_id', 'role', 'per_kit', 'quantity']) && uuid(line.product_id) && ['composition', 'component'].includes(line.role) && stored(line.per_kit) && stored(line.quantity)
      && (line.role === 'composition') === (line.product_id === args.p_product_id), upstream);
    // Quantity = quantidade da composição × quantidade do componente, exact (both have 6 decimals).
    need(units(line.quantity) * 1000000n === sign * asked * units(line.per_kit), upstream);
    return { product_id: line.product_id, role: line.role, per_kit: line.per_kit, quantity: line.quantity };
  });
  const own = lines.some(line => line.role === 'composition');
  // Lançar estoque: Produto (only the composition), Componentes (only the components) or Produto e componente (both).
  need(new Set(lines.map(line => line.product_id)).size === lines.length && own === (k.post_mode !== 'components')
    && lines.some(line => line.role === 'component') === (k.post_mode !== 'product'), upstream);
  const m = value.movement;
  need(object(m) && uuid(m.id) && m.kind === args.p_kind && m.occurred_on === value.occurred_on && Array.isArray(m.items) && m.items.length === lines.length, upstream);
  for (const item of m.items) {
    const line = lines.find(row => row.product_id === item?.product_id);
    need(object(item) && line !== undefined && item.warehouse_id === args.p_warehouse_id && stored(item.quantity) && units(item.quantity) === units(line.quantity) && stored(item.balance_after), upstream);
  }
  let detail = null;
  if (value.detail !== null) {
    const d = value.detail;
    need(own && exact(d, ['revision', 'unit_price', 'unit_cost', 'note']) && d.revision === 1 && price(d.unit_price) && price(d.unit_cost) && text(d.note, 500, 1), upstream);
    detail = { revision: 1, unit_price: d.unit_price, unit_cost: d.unit_cost, note: d.note };
  } else need(!own, upstream);
  return { kind: value.kind, occurred_on: value.occurred_on, movement: { id: m.id, kind: m.kind, occurred_on: m.occurred_on, items: m.items.map(item => ({ product_id: item.product_id,
    warehouse_id: item.warehouse_id, quantity: item.quantity, balance_after: item.balance_after })) }, composition: { product_id: k.product_id, stock_type: k.stock_type, post_mode: k.post_mode,
    version: k.version }, lines, detail, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}

// ---- 280: Componentes do item (kit) ----
const ITEM_REASONS = [null, 'not_composition', 'no_structure', 'product_only', 'role', 'locked', 'posted', 'reserved', 'invoice'];
// Qtde Total is exact: Qtde Un (6 decimals) x the item quantity (6 decimals) has 12 decimals.
const TOTAL12 = /^(0|[1-9][0-9]{0,17})\.[0-9]{12}$/;
function itemComponentsDto(value, args) {
  need(exact(value.document, ['id', 'kind', 'number', 'version', 'status', 'warehouse_id']) && value.document.id === args.p_document_id && ['sales_orders', 'service_orders'].includes(value.document.kind)
    && typeof value.document.number === 'string' && /^[1-9][0-9]{0,9}$/.test(value.document.number) && int(value.document.version, 1) && text(value.document.status, 40, 1)
    && (value.document.warehouse_id === null || uuid(value.document.warehouse_id))
    && exact(value.item, ['id', 'position', 'product_id', 'description', 'quantity', 'unit']) && value.item.id === args.p_item_id && int(value.item.position, 1, 250) && uuid(value.item.product_id)
    && optionalText(value.item.description, 2000) && stored(value.item.quantity) && units(value.item.quantity) > 0n && optionalText(value.item.unit, 16)
    && exact(value.product, ['id', 'name', 'code', 'unit', 'format']) && value.product.id === value.item.product_id && text(value.product.name, 200, 1) && optionalText(value.product.code, 100)
    && optionalText(value.product.unit, 16) && (value.composition === null || (exact(value.composition, ['stock_type', 'post_mode', 'version']) && STOCK_TYPES.includes(value.composition.stock_type)
      && POST_MODES.includes(value.composition.post_mode) && int(value.composition.version, 1)))
    && Array.isArray(value.structure) && value.structure.length <= 100 && typeof value.edited === 'boolean' && int(value.version) && value.edited === (value.version > 0)
    && typeof value.stock_visible === 'boolean' && Array.isArray(value.components) && value.components.length <= 100 && typeof value.editable === 'boolean'
    && ITEM_REASONS.includes(value.reason_code) && value.editable === (value.reason_code === null), upstream);
  const structure = value.structure.map(line => { need(exact(line, ['component_id', 'quantity']) && uuid(line.component_id) && stored(line.quantity) && units(line.quantity) > 0n, upstream);
    return { component_id: line.component_id, quantity: line.quantity }; });
  const kit = units(value.item.quantity);
  const components = value.components.map(line => { need(exact(line, ['component_id', 'name', 'code', 'unit', 'active', 'problem', 'quantity', 'total', 'stock']) && uuid(line.component_id)
    && text(line.name, 200, 1) && optionalText(line.code, 100) && optionalText(line.unit, 16) && typeof line.active === 'boolean' && (line.problem === null || PROBLEMS.includes(line.problem))
    && stored(line.quantity) && units(line.quantity) > 0n && typeof line.total === 'string' && TOTAL12.test(line.total)
    && (value.stock_visible ? stored(line.stock) : line.stock === null), upstream);
    need(units(line.quantity) * kit === BigInt(line.total.replace('.', '')), upstream);
    return { component_id: line.component_id, name: line.name, code: line.code, unit: line.unit, active: line.active, problem: line.problem, quantity: line.quantity, total: line.total, stock: line.stock }; });
  need(new Set(components.map(line => line.component_id)).size === components.length
    && (value.edited || JSON.stringify(components.map(line => [line.component_id, line.quantity])) === JSON.stringify(structure.map(line => [line.component_id, line.quantity]))), upstream);
  const d = value.document, i = value.item, p = value.product;
  return { document: { id: d.id, kind: d.kind, number: d.number, version: d.version, status: d.status, warehouse_id: d.warehouse_id },
    item: { id: i.id, position: i.position, product_id: i.product_id, description: i.description, quantity: i.quantity, unit: i.unit },
    product: { id: p.id, name: p.name, code: p.code, unit: p.unit, format: p.format },
    composition: value.composition && { stock_type: value.composition.stock_type, post_mode: value.composition.post_mode, version: value.composition.version },
    structure, edited: value.edited, version: value.version, stock_visible: value.stock_visible, components, editable: value.editable, reason_code: value.reason_code };
}
export function stockCompositionsResponse(value, operation) {
  need(object(value) && value.data_mode === 'erp_native', upstream);
  const args = operation.args;
  if (operation.type === 'item-components') { need(value.scope === 'stock_item_components', upstream); return { ...itemComponentsDto(value, args), scope: value.scope, data_mode: 'erp_native' }; }
  if (operation.type === 'item-components-save') {
    need(value.scope === 'stock_item_components_save' && typeof value.replayed === 'boolean' && typeof value.restored === 'boolean' && value.restored === (args.p_components === null), upstream);
    const view = itemComponentsDto(value, args);
    // A new save wrote exactly what was asked (or restored the structure) and moved the pedido one version.
    need(value.replayed || (view.document.version === args.p_expected_document_version + 1 && (args.p_components === null ? !view.edited && view.version === 0
      : view.edited && view.version === args.p_expected_version + 1
        && JSON.stringify(view.components.map(line => [line.component_id, String(units(line.quantity))])) === JSON.stringify(args.p_components.map(line => [line.component_id, String(units(line.quantity))])))), upstream);
    return { ...view, restored: value.restored, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'composition') return getDto(value, args);
  if (operation.type === 'composition-components') {
    need(exact(value, ['scope', 'data_mode', 'query', 'stock_visible', 'total', 'items']) && value.scope === 'stock_composition_components' && value.query === args.p_query
      && typeof value.stock_visible === 'boolean' && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(20, value.total), upstream);
    const items = value.items.map(item => { need(exact(item, ['id', 'name', 'code', 'unit', 'price', 'cost_price', 'stock']) && uuid(item.id) && item.id !== args.p_exclude && text(item.name, 200, 1)
      && optionalText(item.code, 100) && text(item.unit, 16, 1) && price(item.price) && price(item.cost_price) && (value.stock_visible ? stored(item.stock) : item.stock === null), upstream);
      return { id: item.id, name: item.name, code: item.code, unit: item.unit, price: item.price, cost_price: item.cost_price, stock: item.stock }; });
    need(new Set(items.map(item => item.id)).size === items.length, upstream);
    return { items, total: value.total, query: value.query, stock_visible: value.stock_visible, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'composition-export') {
    need(exact(value, ['scope', 'data_mode', 'offset', 'limit', 'include_deleted', 'total', 'items']) && value.scope === 'stock_composition_export' && value.offset === args.p_offset
      && value.limit === args.p_limit && value.include_deleted === args.p_include_deleted && int(value.total) && Array.isArray(value.items)
      && value.items.length === Math.max(0, Math.min(args.p_limit, value.total - args.p_offset)), upstream);
    const items = value.items.map(item => {
      need(exact(item, ['product_id', 'product_code', 'product_name', 'product_deleted', 'stock_type', 'post_mode', 'position', 'component_id', 'component_code', 'component_name', 'component_unit', 'quantity'])
        && uuid(item.product_id) && optionalText(item.product_code, 100) && text(item.product_name, 200, 1) && typeof item.product_deleted === 'boolean' && (args.p_include_deleted || !item.product_deleted)
        && STOCK_TYPES.includes(item.stock_type) && POST_MODES.includes(item.post_mode) && int(item.position, 1, 100) && uuid(item.component_id) && optionalText(item.component_code, 100)
        && text(item.component_name, 200, 1) && optionalText(item.component_unit, 16) && stored(item.quantity) && units(item.quantity) > 0n, upstream);
      return { ...item };
    });
    need(new Set(items.map(item => `${item.product_id}:${item.position}`)).size === items.length, upstream);
    return { items, offset: value.offset, limit: value.limit, include_deleted: value.include_deleted, total: value.total, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'composition-launches') {
    need(exact(value, ['scope', 'data_mode', 'product_id', 'limit', 'total', 'items']) && value.scope === 'stock_composition_launches' && value.product_id === args.p_product_id
      && value.limit === args.p_limit && int(value.total) && Array.isArray(value.items) && value.items.length === Math.min(args.p_limit, value.total), upstream);
    const items = value.items.map(item => {
      need(exact(item, ['movement_id', 'kind', 'occurred_on', 'created_at', 'note', 'reversed_by', 'lines']) && uuid(item.movement_id) && ['receipt', 'issue'].includes(item.kind)
        && typeof item.occurred_on === 'string' && DATE.test(item.occurred_on) && instant(item.created_at) && text(item.note, 500, 1) && (item.reversed_by === null || uuid(item.reversed_by))
        && Array.isArray(item.lines) && item.lines.length >= 1 && item.lines.length <= 100, upstream);
      const lines = item.lines.map(line => { need(exact(line, ['product_id', 'name', 'code', 'warehouse_id', 'quantity', 'expected_version']) && uuid(line.product_id) && text(line.name, 200, 1)
        && optionalText(line.code, 100) && uuid(line.warehouse_id) && stored(line.quantity) && (item.kind === 'issue' ? line.quantity.startsWith('-') : !line.quantity.startsWith('-')) && int(line.expected_version, 1), upstream);
        return { product_id: line.product_id, name: line.name, code: line.code, warehouse_id: line.warehouse_id, quantity: line.quantity, expected_version: line.expected_version }; });
      need(new Set(lines.map(line => `${line.product_id}:${line.warehouse_id}`)).size === lines.length, upstream);
      return { movement_id: item.movement_id, kind: item.kind, occurred_on: item.occurred_on, created_at: item.created_at, note: item.note, reversed_by: item.reversed_by, lines };
    });
    need(new Set(items.map(item => item.movement_id)).size === items.length, upstream);
    return { product_id: value.product_id, items, limit: value.limit, total: value.total, scope: value.scope, data_mode: 'erp_native' };
  }
  return launchDto(value, args);
}

// ---- 222: "Estrutura" sent with the product form (Cadastros > Produtos), routed to erp_stock_product_compose ----
/** Validates `composition` (and `composition_sync`) of POST/PATCH /v1/cadastros/products/.../completo; returns the extra RPC argument. */
export function compositionArgs(value, sync) {
  if (sync !== undefined && sync !== true) invalid();
  if (value === undefined) { if (sync !== true) invalid(); return { p_composition: null }; }
  if (sync !== undefined) invalid();
  if (!exact(value, ['expected_version', 'stock_type', 'post_mode', 'items']) || !int(value.expected_version, 0, 2147483646) || !STOCK_TYPES.includes(value.stock_type)
    || !POST_MODES.includes(value.post_mode) || (value.stock_type === 'virtual' && value.post_mode !== 'components') || !Array.isArray(value.items) || value.items.length > 100) invalid();
  const items = value.items.map(item => { if (!exact(item, ['component_id', 'quantity']) || !uuid(item.component_id) || typeof item.quantity !== 'string' || !QUANTITY.test(item.quantity) || units(item.quantity) === 0n) invalid();
    return { component_id: item.component_id.toLowerCase(), quantity: item.quantity }; });
  if (new Set(items.map(item => item.component_id)).size !== items.length) invalid();
  return { p_composition: { expected_version: value.expected_version, stock_type: value.stock_type, post_mode: value.post_mode, items } };
}
/** Checks the receipt of the structure saved with the product (the product itself is checked by the product route). */
export function compositionSaveDto(value, args, productId) {
  need(object(value) && uuid(productId), upstream);
  const composition = compositionDto(value.composition);
  const asked = args.p_composition;
  if (asked !== null) {
    need(composition !== null && composition.stock_type === asked.stock_type && composition.post_mode === asked.post_mode && composition.items.length === asked.items.length
      && (value.replayed === true || composition.version === asked.expected_version + 1)
      && composition.items.every((item, index) => item.component_id === asked.items[index].component_id && units(item.quantity) === units(asked.items[index].quantity)), upstream);
  }
  need(Array.isArray(value.synced) && value.synced.length <= 1000 && value.synced.every(item => exact(item, ['product_id', 'applied']) && uuid(item.product_id) && item.product_id !== productId)
    && new Set(value.synced.map(item => item.product_id)).size === value.synced.length && (asked === null || value.synced.length === 0), upstream);
  // What erp_stock.composition_apply_values applied (the structure save and every composition updated by a component save).
  const appliedDto = applied => {
    need(only(applied, ['price', 'net_weight', 'gross_weight', 'cost_price', 'cost_skipped', 'skipped']) && (applied.price === undefined || (typeof applied.price === 'string' && TOTAL_PRICE.test(applied.price)))
      && (applied.cost_price === undefined || (typeof applied.cost_price === 'string' && TOTAL_PRICE.test(applied.cost_price))) && ['net_weight', 'gross_weight'].every(key => applied[key] === undefined || stored(applied[key]))
      && (applied.cost_skipped === undefined || applied.cost_skipped === 'no_default_supplier') && (applied.skipped === undefined || applied.skipped === 'not_applicable'), upstream);
    return Object.fromEntries(['price', 'net_weight', 'gross_weight', 'cost_price', 'cost_skipped', 'skipped'].filter(key => applied[key] !== undefined).map(key => [key, applied[key]]));
  };
  return { composition, applied: appliedDto(value.applied), synced: value.synced.map(item => ({ product_id: item.product_id, applied: appliedDto(item.applied) })), settings: settingsDto(value.settings) };
}
