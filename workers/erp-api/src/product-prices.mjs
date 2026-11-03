/** Ferramentas de preço do cadastro de produtos (migration 202610200155), under /v1/cadastros/products:
 * - POST /reajuste/previa {rule, ids}: "Novo Preço" of up to 100 visible products (read only, no command);
 * - POST /reajuste {command_id, rule, items | filters}: Reajuste de preços of the selected (with versions, up to 100) or the
 *   filtered products (the v2 list filters, up to 5.000);
 * - GET /compras?ids=a,b&fornecedor=<id>: purchase information for the purchase order (default supplier, supplier data, last
 *   purchase and suggested price);
 * - POST /precos {command_id, supplier_id, items}: "Atualizar preços" of the price formation (sale and cost price, with versions).
 * Strict input before the database, closed answers after it; prices are exact decimal strings. */
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';
import {customFilterList,CustomFilterError} from '../../../packages/erp-domain/src/product-custom-filter.mjs';
import {PRODUCT_STOCK_FILTERS} from './product-stock-mirror.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
export class ProductPricesError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new ProductPricesError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new ProductPricesError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const version = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const price = value => value === null || isCanonicalUnitPrice(value, 14);
const isoDate = value => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? ''); if (!match) return false; const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31'; };

export function productPricesRoute(path) {
  const scope = { '/v1/cadastros/products/reajuste/previa': 'preview', '/v1/cadastros/products/reajuste': 'adjust', '/v1/cadastros/products/compras': 'purchase', '/v1/cadastros/products/precos': 'prices' }[path];
  return scope ? { product: 'prices', scope, entity: 'products', id: null } : null;
}
export const productPricesMethods = route => route.scope === 'purchase' ? ['GET'] : ['POST'];

function rule(value) {
  if (!exact(value, ['action', 'unit', 'value']) || !['increase', 'discount', 'fix'].includes(value.action) || !['amount', 'percent'].includes(value.unit)
    || typeof value.value !== 'string' || !/^(0|[1-9]\d{0,12})(?:\.\d{1,4})?$/.test(value.value) || (value.action === 'fix' && value.unit !== 'amount')
    || (value.action === 'discount' && value.unit === 'percent' && Number(value.value) > 100)) invalid();
  return { action: value.action, unit: value.unit, value: value.value };
}
const ids = (value, max) => { if (!Array.isArray(value) || !value.length || value.length > max || value.some(id => !uuid(id)) || new Set(value.map(id => id.toLowerCase())).size !== value.length) invalid(); return value.map(id => id.toLowerCase()); };
// The v2 list filters, as the product list sends them (same names as GET /v1/cadastros/products?page=N&situation=...).
const FILTERS = { situation: ['latest', 'active', 'inactive'], q: 120, type: ['composition', 'no_composition', 'products', 'simple', 'with_variations', 'variations', 'services'], ncm_presence: ['present', 'missing'],
  ncm: /^\d{2,8}$/, brand: 100, stock: PRODUCT_STOCK_FILTERS, warehouse_id: UUID, images: ['yes', 'no'], tag: 'ref', category: 'ref',
  item_type: ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '99'], supplier_id: UUID, supplier_code: 60, period: ['created', 'updated', 'expiry'], from: 'date', to: 'date',
  // Wave E (migration 235): the "Componente" of the Tipo "Produtos com composição".
  component_id: UUID };
const NAMES = { q: 'query', type: 'product_type' };
function filters(value) {
  if (!only(value, [...Object.keys(FILTERS), 'custom'])) invalid();
  const out = {};
  // Campos customizados (migration 191): the same list as the page's `custom` parameter, as JSON here.
  if ((value.custom ?? null) !== null) { try { out.custom = customFilterList(value.custom); } catch (error) { if (error instanceof CustomFilterError) invalid(); throw error; } }
  for (const [key, spec] of Object.entries(FILTERS)) {
    const raw = value[key] ?? null; if (raw === null) continue;
    if (typeof raw !== 'string') invalid();
    const ok = Array.isArray(spec) ? spec.includes(raw) : spec instanceof RegExp ? spec.test(raw) : typeof spec === 'number' ? raw.length <= spec && !CONTROL.test(raw)
      : spec === 'ref' ? raw === 'none' || UUID.test(raw) : isoDate(raw);
    if (!ok) invalid();
    const text = typeof spec === 'number' ? raw.trim() : raw;
    if (text) out[NAMES[key] ?? key] = UUID.test(text) ? text.toLowerCase() : text;
  }
  if ((out.period === undefined) !== (out.from === undefined && out.to === undefined) || (out.from && out.to && out.from > out.to) || (out.ncm && out.ncm_presence === 'missing')
    || (out.component_id && out.product_type !== 'composition')) invalid();
  return out;
}
export async function productPricesOperation(request, route, params, readBody) {
  if (!productPricesMethods(route).includes(request.method)) throw new ProductPricesError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (route.scope === 'purchase') {
    for (const key of params.keys()) if (!['ids', 'fornecedor'].includes(key) || params.getAll(key).length !== 1) invalid();
    const supplier = params.get('fornecedor');
    if (supplier !== null && !UUID.test(supplier)) invalid();
    return { rpc: 'erp_catalog_product_purchase_info', args: { p_product_ids: ids((params.get('ids') ?? '').split(','), 100), p_supplier_id: supplier?.toLowerCase() ?? null }, type: 'purchase' };
  }
  if (params.size) invalid();
  const input = await readBody(request, 32768);
  if (route.scope === 'preview') {
    if (!exact(input, ['rule', 'ids'])) invalid();
    return { rpc: 'erp_catalog_product_price_preview', args: { p_rule: rule(input.rule), p_ids: ids(input.ids, 100) }, type: 'preview' };
  }
  if (!uuid(input.command_id)) invalid();
  if (route.scope === 'adjust') {
    if (!only(input, ['command_id', 'rule', 'items', 'filters']) || Object.hasOwn(input, 'items') === Object.hasOwn(input, 'filters')) invalid();
    let items = null;
    if (Object.hasOwn(input, 'items')) {
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100 || input.items.some(item => !exact(item, ['id', 'expected_version']) || !uuid(item.id) || !version(item.expected_version))
        || new Set(input.items.map(item => item.id.toLowerCase())).size !== input.items.length) invalid();
      items = input.items.map(item => ({ id: item.id.toLowerCase(), expected_version: item.expected_version }));
    }
    return { rpc: 'erp_catalog_product_price_adjust', args: { p_command_id: input.command_id.toLowerCase(), p_rule: rule(input.rule), p_items: items, p_filters: items ? null : filters(input.filters) }, type: 'adjust' };
  }
  if (!exact(input, ['command_id', 'supplier_id', 'items']) || (input.supplier_id !== null && !uuid(input.supplier_id)) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) invalid();
  const items = input.items.map(item => {
    if (!only(item, ['product_id', 'expected_version', 'price', 'cost_price']) || !uuid(item.product_id) || !version(item.expected_version) || (!Object.hasOwn(item, 'price') && !Object.hasOwn(item, 'cost_price'))
      || ['price', 'cost_price'].some(key => Object.hasOwn(item, key) && (typeof item[key] !== 'string' || !isCanonicalUnitPrice(item[key], 14)))) invalid();
    if (Object.hasOwn(item, 'cost_price') && input.supplier_id === null) invalid();
    return { product_id: item.product_id.toLowerCase(), expected_version: item.expected_version, ...(Object.hasOwn(item, 'price') ? { price: item.price } : {}), ...(Object.hasOwn(item, 'cost_price') ? { cost_price: item.cost_price } : {}) };
  });
  if (new Set(items.map(item => item.product_id)).size !== items.length) invalid();
  return { rpc: 'erp_catalog_product_prices_update', args: { p_command_id: input.command_id.toLowerCase(), p_supplier_id: input.supplier_id?.toLowerCase() ?? null, p_items: items }, type: 'prices' };
}

const STATUSES = ['ok', 'unchanged', 'no_price', 'negative', 'too_large', 'deleted'];
const REASONS = ['negative', 'no_price', 'too_large', 'deleted', 'conflict', 'not_found'];
const text = (value, max) => value === null || (typeof value === 'string' && value.length <= max);
function supplierLink(value) {
  if (value === null) return null;
  if (!exact(value, ['id', 'name']) || !uuid(value.id) || typeof value.name !== 'string' || !value.name || value.name.length > 200) bad();
  return { id: value.id, name: value.name };
}
export function productPricesResponse(value, route, operation) {
  if (!object(value) || value.data_mode !== 'erp_native' || value.entity !== 'products') bad();
  if (operation.type === 'preview') {
    const wanted = operation.args.p_ids;
    if (!exact(value, ['entity', 'items', 'data_mode']) || !Array.isArray(value.items) || value.items.length > wanted.length) bad();
    const items = value.items.map(item => {
      const priced = item?.status === 'ok' || item?.status === 'unchanged';
      if (!exact(item, ['id', 'price', 'status', 'new_price']) || !uuid(item.id) || !wanted.includes(item.id) || !price(item.price) || !STATUSES.includes(item.status)
        || (priced ? !isCanonicalUnitPrice(item.new_price, 14) : item.new_price !== null) || (item.status === 'unchanged' && item.new_price !== item.price)) bad();
      return { id: item.id, price: item.price, status: item.status, new_price: item.new_price };
    });
    if (new Set(items.map(item => item.id)).size !== items.length) bad();
    return { entity: 'products', items, data_mode: 'erp_native' };
  }
  if (value.replayed !== undefined && typeof value.replayed !== 'boolean') bad();
  if (operation.type === 'adjust') {
    if (!exact(value, ['entity', 'total', 'applied', 'unchanged', 'skipped_total', 'skipped', 'rule', 'replayed', 'data_mode'])) bad();
    for (const key of ['total', 'applied', 'unchanged', 'skipped_total']) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 5000) bad();
    if (value.applied + value.unchanged + value.skipped_total < value.total || !Array.isArray(value.skipped) || value.skipped.length > Math.min(value.skipped_total, 150)
      || value.skipped.some(item => !exact(item, ['id', 'name', 'reason']) || !uuid(item.id) || !text(item.name, 200) || !REASONS.includes(item.reason))) bad();
    return { entity: 'products', total: value.total, applied: value.applied, unchanged: value.unchanged, skipped_total: value.skipped_total, skipped: value.skipped.map(item => ({ ...item })),
      rule: { ...operation.args.p_rule }, replayed: value.replayed, data_mode: 'erp_native' };
  }
  if (operation.type === 'purchase') {
    const wanted = operation.args.p_product_ids;
    if (!exact(value, ['entity', 'supplier_id', 'mode', 'items', 'data_mode']) || value.supplier_id !== operation.args.p_supplier_id || !['last_purchase', 'cost', 'purchase'].includes(value.mode)
      || !Array.isArray(value.items) || value.items.length > wanted.length) bad();
    const items = value.items.map(item => {
      if (!exact(item, ['product_id', 'version', 'name', 'code', 'price', 'deleted', 'default_supplier', 'supplier', 'last_purchase_price', 'suggested_price']) || !wanted.includes(item.product_id)
        || !version(item.version) || typeof item.name !== 'string' || !item.name || item.name.length > 200 || !text(item.code, 100) || typeof item.deleted !== 'boolean'
        || ![item.price, item.last_purchase_price, item.suggested_price].every(price)) bad();
      const supplier = item.supplier;
      if (supplier !== null && (!exact(supplier, ['id', 'code', 'description', 'purchase_price', 'cost_price']) || supplier.id !== operation.args.p_supplier_id || !text(supplier.code, 60)
        || !text(supplier.description, 120) || !price(supplier.purchase_price) || !price(supplier.cost_price))) bad();
      return { product_id: item.product_id, version: item.version, name: item.name, code: item.code, price: item.price, deleted: item.deleted, default_supplier: supplierLink(item.default_supplier),
        supplier: supplier && { ...supplier }, last_purchase_price: item.last_purchase_price, suggested_price: item.suggested_price };
    });
    if (new Set(items.map(item => item.product_id)).size !== items.length) bad();
    return { entity: 'products', supplier_id: value.supplier_id, mode: value.mode, items, data_mode: 'erp_native' };
  }
  const wanted = operation.args.p_items;
  if (!exact(value, ['entity', 'supplier_id', 'items', 'replayed', 'data_mode']) || value.supplier_id !== operation.args.p_supplier_id || !Array.isArray(value.items) || value.items.length !== wanted.length) bad();
  const items = value.items.map(item => {
    const asked = wanted.find(row => row.product_id === item?.product_id);
    if (!exact(item, ['product_id', 'version', 'price', 'cost_price']) || !asked || !version(item.version) || item.version !== asked.expected_version + 1 || !price(item.price) || !price(item.cost_price)
      || (!value.replayed && ((asked.price !== undefined && item.price !== asked.price) || (asked.cost_price !== undefined && item.cost_price !== asked.cost_price)))) bad();
    return { ...item };
  });
  return { entity: 'products', supplier_id: value.supplier_id, items, replayed: value.replayed, data_mode: 'erp_native' };
}
