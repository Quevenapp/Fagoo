/** Cadastros > Listas de preços (migrations 202610200121 and 154), under /v1/cadastros:
 * - /v1/cadastros/listas-precos (GET list, POST create) and /:id (GET detail with products, PATCH dados gerais);
 * - /:id/itens (POST products, custom prices and the mass adjust), /:id/excluir (POST) and /:id/clonar (POST);
 * - /v1/cadastros/products/:id/listas-precos (GET): the lists of one product (aba Características);
 * - /:id/precos?produtos=a,b (GET, 154): the list price of up to 100 products, for the documents.
 * 154 adds the categories Vendedor and Forma de pagamento (up to 30 links each), the products of a new list (add_products) and
 * the period filter Cadastrada em (from/to).
 * 192 (wave D): /:id/importar (POST) links products by the "planilha modelo" (code and, in a customized list, the price) and
 * /aplicaveis?contato=&vendedor=&forma_pagamento=&uf= (GET) answers the lists valid now for a document.
 * 282 (wave F): forma_pagamento may carry the formas of every parcela of the document, comma separated (2 to 20, answered by
 * erp_pricing_applicable_lists_v2 with payment_method_ids); one forma or none keeps the 192 call and answer.
 * Strict bodies before the database; closed response shapes after it; list prices are exact strings. */
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
const CATEGORIES = ['other', 'contact', 'seller', 'payment_method', 'region'];
const STATES = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
export class PriceListError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new PriceListError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new PriceListError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const stamp = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const command = input => { if (!uuid(input.command_id)) invalid(); return input.command_id.toLowerCase(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); return value; };
const cents = value => typeof value === 'string' && /^(0|[1-9]\d{0,15})\.\d{2}$/.test(value);

export function priceListRoute(path) {
  if (path === '/v1/cadastros/listas-precos/aplicaveis') return { product: 'price-lists', scope: 'applicable', id: null };
  const product = /^\/v1\/cadastros\/products\/([a-fA-F0-9-]+)\/listas-precos$/.exec(path);
  if (product) return UUID.test(product[1]) ? { product: 'price-lists', scope: 'product', id: product[1].toLowerCase() } : null;
  const match = /^\/v1\/cadastros\/listas-precos(?:\/([a-fA-F0-9-]+)(?:\/(itens|excluir|clonar|precos|importar))?)?$/.exec(path);
  if (!match || (match[1] && !UUID.test(match[1]))) return null;
  return { product: 'price-lists', scope: match[2] ?? (match[1] ? 'list' : 'lists'), id: match[1]?.toLowerCase() ?? null };
}
export const priceListMethods = route => route.scope === 'lists' ? ['GET', 'POST'] : route.scope === 'list' ? ['GET', 'PATCH'] : ['product', 'precos', 'applicable'].includes(route.scope) ? ['GET'] : ['POST'];
// Planilha modelo (192): [{code, price?}], 1 to 500 lines; the price is an exact decimal with a dot (the screen converts the comma).
function importRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 500 || rows.some(row => !only(row, ['code', 'price']) || typeof row.code !== 'string' || !row.code.trim() || row.code.trim().length > 100 || CONTROL.test(row.code)
    || ((row.price ?? null) !== null && (typeof row.price !== 'string' || row.price.length > 80 || (row.price.trim() !== '' && !/^\d+(?:\.\d+)?$/.test(row.price.trim())))))) invalid();
  return rows.map(row => ({ code: row.code.trim(), ...((row.price ?? '').trim() ? { price: row.price.trim() } : {}) }));
}

function listData(data, create) {
  if (!only(data, ['name', 'category', 'list_type', 'factor', 'factor_unit', 'direction', 'considers_datetime', 'starts_on', 'ends_on', 'start_time', 'end_time', 'contacts', 'regions', 'sellers', 'payment_methods', ...(create ? ['add_products'] : [])])) invalid();
  const nullable = (key, test) => { const value = data[key] ?? null; if (value !== null && !test(value)) invalid(); return value; };
  const name = data.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || CONTROL.test(name)) invalid();
  if (!CATEGORIES.includes(data.category) || !['rates', 'period', 'custom'].includes(data.list_type) || !['percent', 'amount'].includes(data.factor_unit)
    || !['increase', 'discount'].includes(data.direction) || typeof data.considers_datetime !== 'boolean') invalid();
  const factor = nullable('factor', value => typeof value === 'string' && /^(0|[1-9]\d{0,10})(?:\.\d{1,4})?$/.test(value));
  if (!Array.isArray(data.contacts) || data.contacts.length > 30 || data.contacts.some(id => !uuid(id)) || new Set(data.contacts.map(id => id.toLowerCase())).size !== data.contacts.length
    || !Array.isArray(data.regions) || data.regions.some(state => !STATES.includes(state)) || new Set(data.regions).size !== data.regions.length) invalid();
  const ids = (key, max) => { const value = data[key] ?? []; if (!Array.isArray(value) || value.length > max || value.some(id => !uuid(id)) || new Set(value.map(id => id.toLowerCase())).size !== value.length) invalid(); return value.map(id => id.toLowerCase()); };
  const extra = { ...(Object.hasOwn(data, 'sellers') ? { sellers: ids('sellers', 30) } : {}), ...(Object.hasOwn(data, 'payment_methods') ? { payment_methods: ids('payment_methods', 30) } : {}),
    ...(Object.hasOwn(data, 'add_products') ? { add_products: ids('add_products', 500) } : {}) };
  return { name: name.trim(), category: data.category, list_type: data.list_type, factor, factor_unit: data.factor_unit, direction: data.direction, considers_datetime: data.considers_datetime,
    starts_on: nullable('starts_on', date), ends_on: nullable('ends_on', date), start_time: nullable('start_time', time), end_time: nullable('end_time', time),
    contacts: data.contacts.map(id => id.toLowerCase()), regions: [...data.regions], ...extra };
}
function itemsChange(change) {
  if (!only(change, ['add', 'remove', 'prices', 'adjust'])) invalid();
  const ids = key => { const value = change[key] ?? []; if (!Array.isArray(value) || value.some(id => !uuid(id))) invalid(); return value.map(id => id.toLowerCase()); };
  const prices = change.prices ?? [];
  if (!Array.isArray(prices) || prices.some(item => !only(item, ['product_id', 'custom_price']) || !uuid(item.product_id) || (item.custom_price !== null && (typeof item.custom_price !== 'string' || item.custom_price.length > 80)))) invalid();
  const result = { add: ids('add'), remove: ids('remove'), prices: prices.map(item => ({ product_id: item.product_id.toLowerCase(), custom_price: item.custom_price })) };
  if (result.add.length + result.remove.length + result.prices.length > 500) invalid();
  if (change.adjust !== undefined) {
    const adjust = change.adjust;
    if (!only(adjust, ['action', 'unit', 'value', 'products']) || !['increase', 'discount', 'fix'].includes(adjust.action) || !['amount', 'percent'].includes(adjust.unit)
      || typeof adjust.value !== 'string' || !/^(0|[1-9]\d{0,10})(?:\.\d{1,4})?$/.test(adjust.value) || (adjust.action === 'fix' && adjust.unit !== 'amount')
      || (adjust.products !== undefined && (!Array.isArray(adjust.products) || adjust.products.length > 500 || adjust.products.some(id => !uuid(id))))) invalid();
    result.adjust = { action: adjust.action, unit: adjust.unit, value: adjust.value, ...(adjust.products ? { products: adjust.products.map(id => id.toLowerCase()) } : {}) };
  }
  return result;
}
export async function priceListOperation(request, route, params, readBody) {
  if (!priceListMethods(route).includes(request.method)) throw new PriceListError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.method === 'GET') {
    const text = (key, max) => { const raw = params.get(key); if (raw === null) return null; if (raw.length > max || CONTROL.test(raw)) invalid(); return raw.trim() || null; };
    if (route.scope === 'product') { if (params.size) invalid(); return { rpc: 'erp_pricing_product_lists', args: { p_product_id: route.id }, type: 'price-product' }; }
    if (route.scope === 'applicable') {
      for (const key of params.keys()) if (!['contato', 'vendedor', 'forma_pagamento', 'uf'].includes(key) || params.getAll(key).length !== 1) invalid();
      const ref = key => { const raw = params.get(key); if (raw !== null && !UUID.test(raw)) invalid(); return raw?.toLowerCase() ?? null; };
      const state = params.get('uf'); if (state !== null && !STATES.includes(state)) invalid();
      const methods = params.get('forma_pagamento')?.split(',');
      if (methods && methods.length > 1) {
        if (methods.length > 20 || methods.some(id => !UUID.test(id)) || new Set(methods.map(id => id.toLowerCase())).size !== methods.length) invalid();
        const ids = methods.map(id => id.toLowerCase());
        const contact = params.get('contato'), seller = params.get('vendedor');
        if ((contact !== null && !UUID.test(contact)) || (seller !== null && !UUID.test(seller))) invalid();
        return { rpc: 'erp_pricing_applicable_lists_v2', args: { p_contact_id: contact?.toLowerCase() ?? null, p_seller_id: seller?.toLowerCase() ?? null, p_payment_method_ids: ids, p_state: state }, type: 'price-applicable-v2' };
      }
      return { rpc: 'erp_pricing_applicable_lists', args: { p_contact_id: ref('contato'), p_seller_id: ref('vendedor'), p_payment_method_id: ref('forma_pagamento'), p_state: state }, type: 'price-applicable' };
    }
    if (route.scope === 'precos') {
      for (const key of params.keys()) if (key !== 'produtos' || params.getAll(key).length !== 1) invalid();
      const products = (params.get('produtos') ?? '').split(',');
      if (!products.length || products.length > 100 || products.some(id => !UUID.test(id)) || new Set(products.map(id => id.toLowerCase())).size !== products.length) invalid();
      return { rpc: 'erp_pricing_list_prices', args: { p_id: route.id, p_product_ids: products.map(id => id.toLowerCase()) }, type: 'price-prices' };
    }
    if (route.scope === 'lists') {
      for (const key of params.keys()) if (!['tipo', 'q', 'categoria', 'produto', 'from', 'to'].includes(key) || params.getAll(key).length !== 1) invalid();
      const type = params.get('tipo'), category = params.get('categoria'), product = params.get('produto'), from = params.get('from'), to = params.get('to');
      if ((type !== null && !['rates', 'period', 'custom'].includes(type)) || (category !== null && !CATEGORIES.includes(category)) || (product !== null && !UUID.test(product))
        || (from !== null && !date(from)) || (to !== null && !date(to)) || (from !== null && to !== null && from > to)) invalid();
      return { rpc: 'erp_pricing_lists', args: { p_list_type: type, p_query: text('q', 120), p_category: category, p_product_id: product?.toLowerCase() ?? null, ...(from !== null || to !== null ? { p_from: from, p_to: to } : {}) }, type: 'price-lists' };
    }
    for (const key of params.keys()) if (!['q', 'offset', 'limit'].includes(key) || params.getAll(key).length !== 1) invalid();
    const offset = params.get('offset') ?? '0', limit = params.get('limit') ?? '100';
    if (!/^(0|[1-9]\d{0,6})$/.test(offset) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100) invalid();
    return { rpc: 'erp_pricing_list_get', args: { p_id: route.id, p_query: text('q', 120), p_offset: Number(offset), p_limit: Number(limit) }, type: 'price-list' };
  }
  if (params.size) invalid();
  const input = await readBody(request, 65536);
  if (route.scope === 'lists' || route.scope === 'list') {
    if (!only(input, route.id ? ['command_id', 'expected_version', 'data'] : ['command_id', 'data'])) invalid();
    return { rpc: 'erp_pricing_list_save', args: { p_id: route.id, p_expected_version: route.id ? version(input.expected_version) : 0, p_command_id: command(input), p_data: listData(input.data, !route.id) }, type: 'price-save' };
  }
  if (route.scope === 'itens') { if (!only(input, ['command_id', 'expected_version', 'change'])) invalid(); return { rpc: 'erp_pricing_list_items', args: { p_id: route.id, p_expected_version: version(input.expected_version), p_command_id: command(input), p_change: itemsChange(input.change) }, type: 'price-save' }; }
  if (route.scope === 'excluir') { if (!only(input, ['command_id', 'expected_version'])) invalid(); return { rpc: 'erp_pricing_list_delete', args: { p_id: route.id, p_expected_version: version(input.expected_version), p_command_id: command(input) }, type: 'price-delete' }; }
  if (route.scope === 'importar') { if (!only(input, ['command_id', 'expected_version', 'rows'])) invalid(); return { rpc: 'erp_pricing_list_import', args: { p_id: route.id, p_expected_version: version(input.expected_version), p_command_id: command(input), p_rows: importRows(input.rows) }, type: 'price-import' }; }
  if (!only(input, ['command_id', 'name']) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || CONTROL.test(input.name)) invalid();
  return { rpc: 'erp_pricing_list_clone', args: { p_id: route.id, p_command_id: command(input), p_name: input.name.trim() }, type: 'price-save' };
}

const LINKS = ['contacts', 'sellers', 'payment_methods'];
function header(value, detail) {
  const keys = ['id', 'name', 'category', 'list_type', 'factor', 'factor_unit', 'direction', 'considers_datetime', 'starts_on', 'ends_on', 'start_time', 'end_time', 'version', 'created_at', 'updated_at', 'rule', 'products', ...(detail ? [...LINKS, 'regions'] : [])];
  if (!only(value, keys) || (detail && keys.some(key => !Object.hasOwn(value, key))) || !uuid(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 120 || !CATEGORIES.includes(value.category)
    || !['rates', 'period', 'custom'].includes(value.list_type) || !['percent', 'amount'].includes(value.factor_unit) || !['increase', 'discount'].includes(value.direction)
    || typeof value.considers_datetime !== 'boolean' || !Number.isInteger(value.version) || value.version < 1 || !stamp(value.created_at) || !stamp(value.updated_at)
    || typeof value.rule !== 'string' || value.rule.length > 60 || !Number.isSafeInteger(value.products) || value.products < 0
    || (value.factor !== null && (typeof value.factor !== 'string' || !/^\d{1,11}\.\d{4}$/.test(value.factor)))
    || [value.starts_on, value.ends_on].some(day => day !== null && !date(day)) || [value.start_time, value.end_time].some(hour => hour !== null && !time(hour))) bad();
  const safe = Object.fromEntries(keys.filter(key => ![...LINKS, 'regions'].includes(key)).map(key => [key, value[key]]));
  if (detail) {
    if (LINKS.some(key => !Array.isArray(value[key]) || value[key].length > 30 || value[key].some(item => !only(item, ['id', 'name']) || !uuid(item.id) || typeof item.name !== 'string' || item.name.length > 200))
      || !Array.isArray(value.regions) || value.regions.some(state => !STATES.includes(state))) bad();
    Object.assign(safe, Object.fromEntries(LINKS.map(key => [key, value[key].map(item => ({ id: item.id, name: item.name }))])), { regions: [...value.regions] });
  }
  return safe;
}
export function priceListResponse(value, route, operation) {
  if (!object(value) || value.data_mode !== 'erp_native') bad();
  if (value.replayed !== undefined && typeof value.replayed !== 'boolean') bad();
  const replayed = value.replayed === undefined ? {} : { replayed: value.replayed };
  if (operation.type === 'price-lists') { if (!Array.isArray(value.items) || value.items.length > 1000) bad(); return { items: value.items.map(item => header(item, false)), data_mode: 'erp_native' }; }
  if (operation.type === 'price-product') {
    if (value.product_id !== route.id || !Array.isArray(value.items) || value.items.length > 1000 || value.items.some(item => !only(item, ['id', 'name', 'list_type', 'rule', 'list_price']) || !uuid(item.id)
      || typeof item.name !== 'string' || !item.name || item.name.length > 120 || !['rates', 'period', 'custom'].includes(item.list_type) || typeof item.rule !== 'string' || item.rule.length > 60
      || (item.list_price !== null && !cents(item.list_price)))) bad();
    return { product_id: route.id, items: value.items.map(item => ({ ...item })), data_mode: 'erp_native' };
  }
  if (operation.type === 'price-list') {
    const { p_offset: offset, p_limit: limit } = operation.args;
    if (value.offset !== offset || value.limit !== limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(limit, value.total - offset))) bad();
    const list = header(value.list, true); if (list.id !== route.id) bad();
    const items = value.items.map(item => {
      if (!only(item, ['product_id', 'name', 'code', 'gtin', 'product_price', 'custom_price', 'list_price']) || !uuid(item.product_id) || typeof item.name !== 'string' || !item.name
        || (item.code !== null && (typeof item.code !== 'string' || item.code.length > 100)) || (item.gtin !== null && (typeof item.gtin !== 'string' || item.gtin.length > 14))
        || [item.product_price, item.custom_price].some(price => price !== null && !isCanonicalUnitPrice(price, 14)) || (item.list_price !== null && !cents(item.list_price))) bad();
      return { ...item };
    });
    return { list, items, total: value.total, offset, limit, data_mode: 'erp_native' };
  }
  if (operation.type === 'price-prices') {
    const list = value.list, ids = operation.args.p_product_ids;
    if (!only(list, ['id', 'name', 'list_type', 'rule', 'valid_now', 'version']) || list.id !== route.id || typeof list.name !== 'string' || !list.name || list.name.length > 120 || !['rates', 'period', 'custom'].includes(list.list_type)
      || typeof list.rule !== 'string' || list.rule.length > 60 || typeof list.valid_now !== 'boolean' || !Number.isInteger(list.version) || list.version < 1
      || !Array.isArray(value.items) || value.items.length > ids.length || value.items.some(item => !only(item, ['product_id', 'in_list', 'list_price']) || !ids.includes(item.product_id) || typeof item.in_list !== 'boolean'
        || (item.in_list ? item.list_price !== null && !cents(item.list_price) : item.list_price !== null)) || new Set(value.items.map(item => item.product_id)).size !== value.items.length) bad();
    return { list: { ...list }, items: value.items.map(item => ({ product_id: item.product_id, in_list: item.in_list, list_price: item.list_price })), data_mode: 'erp_native' };
  }
  if (operation.type === 'price-delete') { if (value.deleted !== true || value.id !== route.id) bad(); return { deleted: true, id: route.id, data_mode: 'erp_native', ...replayed }; }
  if (operation.type === 'price-applicable') {
    const args = operation.args;
    if (!only(value, ['data_mode', 'contact_id', 'seller_id', 'payment_method_id', 'state', 'items']) || value.contact_id !== args.p_contact_id || value.seller_id !== args.p_seller_id
      || value.payment_method_id !== args.p_payment_method_id || (value.state !== null && !STATES.includes(value.state)) || (args.p_state !== null && value.state !== args.p_state)
      || !Array.isArray(value.items) || value.items.length > 1000) bad();
    const items = value.items.map(item => header(item, false));
    if (new Set(items.map(item => item.id)).size !== items.length) bad();
    return { contact_id: value.contact_id, seller_id: value.seller_id, payment_method_id: value.payment_method_id, state: value.state, items, data_mode: 'erp_native' };
  }
  if (operation.type === 'price-applicable-v2') {
    const args = operation.args, sorted = [...args.p_payment_method_ids].sort();
    if (!only(value, ['data_mode', 'contact_id', 'seller_id', 'payment_method_ids', 'state', 'items']) || value.contact_id !== args.p_contact_id || value.seller_id !== args.p_seller_id
      || !Array.isArray(value.payment_method_ids) || JSON.stringify(value.payment_method_ids) !== JSON.stringify(sorted)
      || (value.state !== null && !STATES.includes(value.state)) || (args.p_state !== null && value.state !== args.p_state)
      || !Array.isArray(value.items) || value.items.length > 1000) bad();
    const items = value.items.map(item => header(item, false));
    if (new Set(items.map(item => item.id)).size !== items.length) bad();
    return { contact_id: value.contact_id, seller_id: value.seller_id, payment_method_ids: sorted, state: value.state, items, data_mode: 'erp_native' };
  }
  if (operation.type === 'price-import') {
    const codes = (list, total) => Array.isArray(list) && list.length <= Math.min(50, total) && list.every(code => typeof code === 'string' && code.length >= 1 && code.length <= 100);
    const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 500;
    if (value.saved !== true || !['added', 'updated', 'unchanged', 'duplicates', 'not_found_total', 'ambiguous_total'].every(count)
      || !codes(value.not_found, value.not_found_total) || !codes(value.ambiguous, value.ambiguous_total)
      || value.added + value.updated + value.unchanged + value.duplicates + value.not_found_total + value.ambiguous_total !== operation.args.p_rows.length) bad();
    const list = header(value.list, true); if (list.id !== route.id) bad();
    return { saved: true, list, added: value.added, updated: value.updated, unchanged: value.unchanged, duplicates: value.duplicates, not_found: [...value.not_found], not_found_total: value.not_found_total,
      ambiguous: [...value.ambiguous], ambiguous_total: value.ambiguous_total, data_mode: 'erp_native', ...replayed };
  }
  if (typeof value.saved !== 'boolean') bad();
  if (!value.saved) { if (!['duplicate_name', 'too_many_products'].includes(value.reason)) bad(); return { saved: false, reason: value.reason, data_mode: 'erp_native', ...replayed }; }
  const list = header(value.list, true);
  if (route.id && route.scope !== 'clonar' && list.id !== route.id) bad();
  return { saved: true, list, data_mode: 'erp_native', ...replayed };
}
