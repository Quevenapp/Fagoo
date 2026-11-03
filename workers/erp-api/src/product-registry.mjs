/** Produtos no padrão do Origin (migrations 202610200119-120), served under /v1/cadastros so the ERP keeps one catalog prefix:
 * - /v1/cadastros/taxonomias/:tipo (GET list, POST create), /:tipo/:id (PATCH rename), /:tipo/:id/excluir (POST delete), where :tipo is
 *   categorias-produtos | grupos-produtos | grupos-tags | tags;
 * - /v1/cadastros/products/completo (POST) and /v1/cadastros/products/:id/completo (GET, PATCH): the product form with its detail;
 * - /v1/cadastros/products/:id/deleted (PATCH): Excluir / Restaurar;
 * - /v1/cadastros/products/exportacao (GET): export reads, at most 250 rows per call;
 * - the v2 product page (GET /v1/cadastros/products?page=N&situation=...), used by catalog.mjs.
 * The catalog routes of 006/096 keep their contracts for the other screens (pickers, inline price, situation batch).
 * Strict allow-lists before the database, closed response shapes after it. */
import {PRODUCT_DETAIL_KEYS,PRODUCT_DETAIL_DECIMALS,PRODUCT_DETAIL_LISTS,productDetailRequest,productDetailResponse,checkProductDetail,ProductDetailError,isoDate} from '../../../packages/erp-domain/src/product-detail.mjs';
import {isCanonicalUnitPrice} from '../../../packages/erp-domain/src/unit-price.mjs';
import {priceListRoute,priceListMethods,priceListOperation,priceListResponse,PriceListError} from './price-lists.mjs';
import {contactTagRoute,contactTagMethods,contactTagOperation,contactTagResponse,ContactTagsError} from './contact-tags.mjs';
import {productPricesRoute,productPricesMethods,productPricesOperation,productPricesResponse,ProductPricesError} from './product-prices.mjs';
// Leva H (410): variações (pai e SKUs filhos).
import {productVariationsRoute,productVariationsMethods,productVariationsOperation,productVariationsResponse,ProductVariationsError} from './product-variations.mjs';
import {customFieldRoute,customFieldMethods,customFieldOperation,customFieldResponse,CustomFieldsError} from './product-custom-fields.mjs';
import { initialBalanceArgs, initialBalanceDto } from './stock-supply.mjs';
import {parseCustomFilterParam,CustomFilterError} from '../../../packages/erp-domain/src/product-custom-filter.mjs';
import { compositionArgs, compositionSaveDto } from './stock-compositions.mjs';
import { PRODUCT_STOCK_FILTERS } from './product-stock-mirror.mjs';
// Wave E (migration 236): Marcadores (tags) of the notas fiscais, /v1/cadastros/notas-fiscais/...
import {invoiceTagRoute,invoiceTagMethods,invoiceTagOperation,invoiceTagResponse,InvoiceTagsError} from './invoice-tags.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
export const TAXONOMY_SLUGS = { 'categorias-produtos': 'categories', 'grupos-produtos': 'product_groups', 'grupos-tags': 'tag_groups', tags: 'tags' };
const TAXONOMY_NAMES = { categories: 50, product_groups: 100, tag_groups: 60, tags: 60 };
export const PRODUCT_SITUATIONS = ['latest', 'active', 'inactive', 'deleted'];
export const PRODUCT_TYPES = ['composition', 'no_composition', 'products', 'simple', 'with_variations', 'variations', 'services'];
const ITEM_TYPES = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '99'];
const SORTS = ['created_desc', 'name_asc', 'name_desc', 'code_asc', 'code_desc'];

export class ProductRegistryError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new ProductRegistryError(400, 'ERP_INVALID_QUERY'); };
const badResponse = () => { throw new ProductRegistryError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const command = input => { if (!uuid(input.command_id)) invalid(); return input.command_id.toLowerCase(); };
const version = value => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) invalid(); return value; };
const stamp = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));

// Listas de preços (migration 121) live in price-lists.mjs; their errors become product registry errors here.
const priceError = error => { if (error instanceof PriceListError || error instanceof ContactTagsError || error instanceof ProductPricesError || error instanceof ProductVariationsError || error instanceof CustomFieldsError || error instanceof InvoiceTagsError) throw new ProductRegistryError(error.status, error.code); throw error; };
const viaPrice = run => { try { const value = run(); return value instanceof Promise ? value.catch(priceError) : value; } catch (error) { return priceError(error); } };
export function productRoute(path) {
  const price = priceListRoute(path); if (price) return { ...price, entity: 'products' };
  // Tags de Contatos (migration 153): /v1/cadastros/contatos/tags and /v1/cadastros/contatos/:id/tags.
  const contactTags = contactTagRoute(path); if (contactTags) return contactTags;
  // Ferramentas de preço (migration 155): /v1/cadastros/products/{reajuste,reajuste/previa,compras,precos}.
  const prices = productPricesRoute(path); if (prices) return prices;
  const variations = productVariationsRoute(path); if (variations) return variations;
  // Campos customizados (migration 156): /v1/cadastros/campos-customizados[/:id[/excluir]].
  const custom = customFieldRoute(path); if (custom) return custom;
  // Marcadores das notas fiscais (migration 236): /v1/cadastros/notas-fiscais/tags and /v1/cadastros/notas-fiscais/:origem/:modelo/:nota/tags.
  const invoiceTags = invoiceTagRoute(path); if (invoiceTags) return invoiceTags;
  const taxonomy = /^\/v1\/cadastros\/taxonomias\/([a-z-]+)(?:\/([a-fA-F0-9-]+)(\/excluir)?)?$/.exec(path);
  if (taxonomy) {
    const kind = Object.hasOwn(TAXONOMY_SLUGS, taxonomy[1]) ? TAXONOMY_SLUGS[taxonomy[1]] : null;
    if (!kind || (taxonomy[2] && !UUID.test(taxonomy[2]))) return null;
    return { product: 'taxonomy', entity: 'products', kind, id: taxonomy[2]?.toLowerCase() ?? null, remove: Boolean(taxonomy[3]) };
  }
  if (path === '/v1/cadastros/products/exportacao') return { product: 'export', entity: 'products', id: null };
  // Contexto do formulário (migration 191): the confirmed CRT of the company, for the conditional IPI fields.
  if (path === '/v1/cadastros/products/contexto') return { product: 'context', entity: 'products', id: null };
  if (path === '/v1/cadastros/products/completo') return { product: 'complete', entity: 'products', id: null };
  const complete = /^\/v1\/cadastros\/products\/([a-fA-F0-9-]+)\/completo$/.exec(path);
  if (complete && UUID.test(complete[1])) return { product: 'complete', entity: 'products', id: complete[1].toLowerCase() };
  const deleted = /^\/v1\/cadastros\/products\/([a-fA-F0-9-]+)\/deleted$/.exec(path);
  if (deleted && UUID.test(deleted[1])) return { product: 'deleted', entity: 'products', id: deleted[1].toLowerCase() };
  return null;
}
export function productMethods(route) {
  if (route.product === 'price-lists') return priceListMethods(route);
  if (route.product === 'contact-tags') return contactTagMethods(route);
  if (route.product === 'prices') return productPricesMethods(route);
  if (route.product === 'variations') return productVariationsMethods(route);
  if (route.product === 'custom-fields') return customFieldMethods(route);
  if (route.product === 'invoice-tags') return invoiceTagMethods(route);
  if (route.product === 'taxonomy') return route.remove ? ['POST'] : route.id ? ['PATCH'] : ['GET', 'POST'];
  if (route.product === 'complete') return route.id ? ['GET', 'PATCH'] : ['POST'];
  return route.product === 'export' || route.product === 'context' ? ['GET'] : ['PATCH'];
}

// ---- Filters of the v2 page and of the export (same names in the URL) ----
// component_id (wave E, migration 234): the "Componente" of the Tipo "Produtos com composição"; read by componentArg, never sent to v2.
const FILTERS = ['q', 'situation', 'type', 'ncm_presence', 'ncm', 'brand', 'stock', 'warehouse_id', 'images', 'tag', 'category', 'item_type', 'supplier_id', 'supplier_code', 'period', 'from', 'to', 'sort', 'component_id'];
/** The Componente filter: a product UUID, only with the Tipo "Produtos com composição"; null without it. */
export function componentArg(params) {
  const component = params.get('component_id');
  if (component === null) return null;
  if (!UUID.test(component) || params.get('type') !== 'composition') invalid();
  return component.toLowerCase();
}
function filterArgs(params, extra) {
  for (const key of params.keys()) if (![...FILTERS, ...extra].includes(key) || params.getAll(key).length !== 1) invalid();
  const value = key => params.get(key);
  const text = (key, max) => { const raw = value(key); if (raw === null) return null; if (raw.length > max || CONTROL.test(raw)) invalid(); return raw.trim() || null; };
  const choice = (key, options) => { const raw = value(key); if (raw !== null && !options.includes(raw)) invalid(); return raw; };
  const reference = key => { const raw = value(key); if (raw !== null && raw !== 'none' && !UUID.test(raw)) invalid(); return raw?.toLowerCase() ?? null; };
  const situation = choice('situation', PRODUCT_SITUATIONS) ?? 'latest', presence = choice('ncm_presence', ['present', 'missing']), ncm = value('ncm');
  if (ncm !== null && (!/^\d{2,8}$/.test(ncm) || presence === 'missing')) invalid();
  const period = choice('period', ['created', 'updated', 'expiry']), from = value('from'), to = value('to');
  if ((period === null) !== (from === null && to === null) || (from !== null && !isoDate(from)) || (to !== null && !isoDate(to)) || (from !== null && to !== null && from > to)) invalid();
  const warehouse = value('warehouse_id'), supplier = value('supplier_id');
  if ((warehouse !== null && !UUID.test(warehouse)) || (supplier !== null && !UUID.test(supplier))) invalid();
  return { p_sort: choice('sort', SORTS) ?? 'created_desc', p_query: text('q', 120), p_situation: situation, p_product_type: choice('type', PRODUCT_TYPES), p_ncm_presence: presence, p_ncm: ncm,
    p_brand: text('brand', 100), p_stock: choice('stock', PRODUCT_STOCK_FILTERS), p_warehouse_id: warehouse?.toLowerCase() ?? null,
    p_images: choice('images', ['yes', 'no']), p_tag: reference('tag'), p_category: reference('category'), p_item_type: choice('item_type', ITEM_TYPES),
    p_supplier_id: supplier?.toLowerCase() ?? null, p_supplier_code: text('supplier_code', 60), p_period: period, p_from: from, p_to: to };
}
/** GET /v1/cadastros/products?page=N&situation=...: the v2 page (only when `situation` is present; the 096 page stays as it was).
 * With `custom` (JSON list of the "Campos customizados" filter, migration 191) the page with that filter answers instead. */
export function productPageOperation(params) {
  const page = params.get('page'), size = params.get('size') ?? '100';
  if (!/^[1-9]\d{0,5}$/.test(page ?? '') || Number(page) > 100000 || !/^[1-9]\d{0,2}$/.test(size) || Number(size) > 100) invalid();
  const args = { p_page: Number(page), p_size: Number(size), ...filterArgs(params, ['page', 'size', 'custom']) }, component = componentArg(params);
  if (!params.has('custom') && component === null) return { rpc: 'erp_catalog_product_page_v2', args, type: 'page', originStock: true };
  let custom = null; if (params.has('custom')) try { custom = parseCustomFilterParam(params.get('custom')); } catch (error) { if (error instanceof CustomFilterError) invalid(); throw error; }
  // Componente (migration 234): the v3 page, with the Campos customizados filter when it is also present.
  if (component !== null) return { rpc: 'erp_catalog_product_page_v3', args: { ...args, p_custom: custom, p_component_id: component }, type: 'page', originStock: true };
  return { rpc: 'erp_catalog_product_page_custom', args: { ...args, p_custom: custom }, type: 'page', originStock: true };
}
/** Extra columns of a v2 list item (Origin custom list): validated and projected; catalog.mjs checks the common fields. */
export function productListExtras(value) {
  const safe = {};
  for (const key of ['stock_min', 'stock_max']) {
    const field = value[key] ?? null;
    if (field !== null && (typeof field !== 'string' || !/^(0|[1-9]\d{0,11})\.\d{6}$/.test(field))) badResponse();
    safe[key] = field;
  }
  const location = value.location ?? null, cost = value.cost_price ?? null, thumbnail = value.thumbnail ?? null, category = value.category_id ?? null, expiry = value.expiry_date ?? null;
  if ((location !== null && (typeof location !== 'string' || location.length > 100)) || (cost !== null && !isCanonicalUnitPrice(cost, 14))
    || (thumbnail !== null && (typeof thumbnail !== 'string' || thumbnail.length > 1000 || !/^https:\/\/[^\s\x00-\x1f\x7f]+$/.test(thumbnail)))
    || (category !== null && !uuid(category)) || (expiry !== null && !isoDate(expiry)) || typeof value.deleted !== 'boolean') badResponse();
  return { ...safe, location, cost_price: cost, thumbnail, category_id: category, expiry_date: expiry, deleted: value.deleted };
}

// ---- Product form: read, save and the "active" switch go through the product RPCs of 119 ----
/** Splits a product `data` object: catalog keys (checked by catalog.mjs), the 119 detail keys and the "Ativado" switch. */
export function productSaveData(data) {
  if (Object.hasOwn(data, 'active') && typeof data.active !== 'boolean') invalid();
  try { productDetailRequest(data); } catch (error) { if (error instanceof ProductDetailError) invalid(); throw error; }
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'active' && !PRODUCT_DETAIL_KEYS.includes(key)));
}
/** The detail of a product record response; a replay of a command saved before 119 has no detail and reads as null. */
export function productRecordDetail(value) {
  try { return productDetailResponse(value); } catch (error) { if (error instanceof ProductDetailError) badResponse(); throw error; }
}

// ---- Taxonomy, deleted flag and export ----
async function taxonomyOperation(request, route, params, readBody) {
  if (request.method === 'GET') { if (params.size) invalid(); return { rpc: 'erp_catalog_taxonomy_list', args: { p_kind: route.kind }, type: 'taxonomy-list' }; }
  if (params.size) invalid();
  const input = await readBody(request, 4096);
  if (route.remove) {
    if (!keysOnly(input, ['command_id', 'expected_version'])) invalid();
    return { rpc: 'erp_catalog_taxonomy_delete', args: { p_kind: route.kind, p_id: route.id, p_expected_version: version(input.expected_version), p_command_id: command(input) }, type: 'taxonomy-delete' };
  }
  const tagged = TAGGED.includes(route.kind);
  // Categorias: "Campos customizáveis aplicáveis nesta categoria" (migration 156) in the same command as the category.
  const fields = route.kind === 'categories' ? ['custom_field_ids'] : [];
  if (!keysOnly(input, route.id ? ['command_id', 'expected_version', 'data'] : ['command_id', 'data']) || !keysOnly(input.data, route.id ? ['name', ...fields] : ['name', 'parent_id', ...(tagged ? ['tag_type'] : []), ...fields])) invalid();
  const linked = Object.hasOwn(input.data, 'custom_field_ids') ? input.data.custom_field_ids : null;
  if (linked !== null && (!Array.isArray(linked) || linked.length > 60 || linked.some(id => !uuid(id)) || new Set(linked.map(id => id.toLowerCase())).size !== linked.length)) invalid();
  const name = input.data.name, parent = input.data.parent_id ?? null;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > TAXONOMY_NAMES[route.kind] || CONTROL.test(name) || (parent !== null && !uuid(parent))
    || (parent !== null && route.kind === 'tag_groups') || (Object.hasOwn(input.data, 'tag_type') && !TAG_TYPES.includes(input.data.tag_type))) invalid();
  const data = { name: name.trim(), ...(Object.hasOwn(input.data, 'parent_id') ? { parent_id: parent?.toLowerCase() ?? null } : {}), ...(Object.hasOwn(input.data, 'tag_type') ? { tag_type: input.data.tag_type } : {}),
    ...(linked !== null ? { custom_field_ids: linked.map(id => id.toLowerCase()) } : {}) };
  return { rpc: 'erp_catalog_taxonomy_save', args: { p_kind: route.kind, p_id: route.id, p_expected_version: route.id ? version(input.expected_version) : 0, p_command_id: command(input), p_data: data }, type: 'taxonomy-save' };
}
const WARNINGS = ['duplicate_code', 'duplicate_gtin'];
/** The product form: catalog keys (checked like POST/PATCH of 006/096), the 119 detail and the Ativado switch, in one command. */
async function completeOperation(request, route, params, { body: readBody, validateBase }) {
  if (params.size) invalid();
  if (request.method === 'GET') return { rpc: 'erp_catalog_product_get', args: { p_id: route.id }, type: 'record' };
  const input = await readBody(request, 65536);
  if (!keysOnly(input, route.id ? ['command_id', 'expected_version', 'data', 'acknowledged_warnings'] : ['command_id', 'data', 'acknowledged_warnings']) || !object(input.data) || !Object.keys(input.data).length) invalid();
  // 183 (estoque): "Saldo inicial" of a new product travels inside data; the product and its entry are saved by one stock command.
  const initial = !route.id && Object.hasOwn(input.data, 'initial_balance') ? input.data.initial_balance : undefined;
  if (initial !== undefined) input.data = Object.fromEntries(Object.entries(input.data).filter(([key]) => key !== 'initial_balance'));
  // 222 (estoque): the "Estrutura" of a composition (or the update of the compositions that use this product) travels inside data;
  // the product and the structure are saved by one stock command.
  const composition = Object.hasOwn(input.data, 'composition') ? input.data.composition : undefined, compositionSync = Object.hasOwn(input.data, 'composition_sync') ? input.data.composition_sync : undefined;
  if (composition !== undefined || compositionSync !== undefined) input.data = Object.fromEntries(Object.entries(input.data).filter(([key]) => key !== 'composition' && key !== 'composition_sync'));
  if (!Object.keys(input.data).length) invalid();
  const base = productSaveData(input.data);
  if (Object.keys(base).length || !route.id) validateBase(base, !route.id);
  const acknowledged = Object.hasOwn(input, 'acknowledged_warnings') ? input.acknowledged_warnings : null;
  if (acknowledged !== null && (!Array.isArray(acknowledged) || acknowledged.some(code => !WARNINGS.includes(code)) || new Set(acknowledged).size !== acknowledged.length)) invalid();
  if (composition !== undefined || compositionSync !== undefined) { let structure; try { if (initial !== undefined || (compositionSync !== undefined && !route.id)) invalid(); structure = compositionArgs(composition, compositionSync); } catch { invalid(); }
    return { rpc: 'erp_stock_product_compose', args: { p_id: route.id, p_expected_version: route.id ? version(input.expected_version) : 0, p_command_id: command(input), p_data: input.data, p_acknowledged: acknowledged, ...structure }, type: 'record', composition: true }; }
  if (initial !== undefined) { let stock; try { stock = initialBalanceArgs(initial); } catch { invalid(); }
    return { rpc: 'erp_stock_product_create', args: { p_command_id: command(input), p_data: input.data, p_acknowledged: acknowledged, ...stock }, type: 'record', initial: true }; }
  return { rpc: 'erp_catalog_product_save', args: { p_id: route.id, p_expected_version: route.id ? version(input.expected_version) : 0, p_command_id: command(input), p_data: input.data, p_acknowledged: acknowledged }, type: 'record' };
}
export async function productOperation(request, route, params, tools) {
  const readBody = tools.body;
  if (!productMethods(route).includes(request.method)) throw new ProductRegistryError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (route.product === 'price-lists') return viaPrice(() => priceListOperation(request, route, params, readBody));
  if (route.product === 'contact-tags') return viaPrice(() => contactTagOperation(request, route, params, readBody));
  if (route.product === 'prices') return viaPrice(() => productPricesOperation(request, route, params, readBody));
  if (route.product === 'variations') return viaPrice(() => productVariationsOperation(request, route, params, readBody));
  if (route.product === 'custom-fields') return viaPrice(() => customFieldOperation(request, route, params, readBody));
  if (route.product === 'invoice-tags') return viaPrice(() => invoiceTagOperation(request, route, params, readBody));
  if (route.product === 'taxonomy') return taxonomyOperation(request, route, params, readBody);
  if (route.product === 'complete') return completeOperation(request, route, params, tools);
  if (route.product === 'context') { if (params.size) invalid(); return { rpc: 'erp_catalog_product_form_context', args: {}, type: 'context' }; }
  if (route.product === 'export') {
    const offset = params.get('offset') ?? '0', limit = params.get('limit') ?? '250', deleted = params.get('include_deleted') ?? 'false';
    if (!/^(0|[1-9]\d{0,7})$/.test(offset) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 250 || !['true', 'false'].includes(deleted)) invalid();
    const args = { p_offset: Number(offset), p_limit: Number(limit), p_include_deleted: deleted === 'true', ...filterArgs(params, ['offset', 'limit', 'include_deleted']) }, component = componentArg(params);
    // Componente (migration 234): the v2 export; without it the 120 export, which answers through the v2 from 234 on.
    return component === null ? { rpc: 'erp_catalog_product_export', args, type: 'export', originStock: true } : { rpc: 'erp_catalog_product_export_v2', args: { ...args, p_component_id: component }, type: 'export', originStock: true };
  }
  if (params.size) invalid();
  const input = await readBody(request, 4096);
  if (!keysOnly(input, ['command_id', 'expected_version', 'deleted']) || typeof input.deleted !== 'boolean') invalid();
  return { rpc: 'erp_catalog_product_set_deleted', args: { p_id: route.id, p_expected_version: version(input.expected_version), p_command_id: command(input), p_deleted: input.deleted }, type: 'record' };
}

// Tags and tag groups have a Tipo (Produtos | Contatos, migration 153; Notas fiscais, migration 236, whose items also count the
// notes in `invoices`); categories and product groups have none.
const TAGGED = ['tag_groups', 'tags'], TAG_TYPES = ['products', 'contacts', 'invoices'];
function taxonomyItem(value, kind) {
  const invoices = value?.tag_type === 'invoices';
  if (!keysOnly(value, ['id', 'kind', 'parent_id', 'name', 'version', 'created_at', 'updated_at', 'tag_type', 'children', 'products', 'contacts', ...(invoices ? ['invoices'] : [])]) || !uuid(value.id) || value.kind !== kind
    || (invoices && (!Number.isSafeInteger(value.invoices) || value.invoices < 0 || (kind !== 'tags' && value.invoices !== 0)))
    || (value.parent_id !== null && !uuid(value.parent_id)) || typeof value.name !== 'string' || !value.name || value.name.length > 100
    || !Number.isInteger(value.version) || value.version < 1 || value.version > 2147483647 || !stamp(value.created_at) || !stamp(value.updated_at)
    || (TAGGED.includes(kind) ? !TAG_TYPES.includes(value.tag_type) : value.tag_type !== null)
    || !Number.isSafeInteger(value.children) || value.children < 0 || !Number.isSafeInteger(value.products) || value.products < 0 || !Number.isSafeInteger(value.contacts) || value.contacts < 0) badResponse();
  return { id: value.id, kind, parent_id: value.parent_id, name: value.name, version: value.version, created_at: value.created_at, updated_at: value.updated_at, tag_type: value.tag_type,
    children: value.children, products: value.products, contacts: value.contacts, invoices: invoices ? value.invoices : 0 };
}
const EXPORT_TEXT = { name: 200, code: 100, unit: 16, kind: 1, format: 1, description: 4000, ncm: 8, gtin: 14, brand: 100, condition: 11, production: 11, dimension_unit: 2,
  volumes: 6, items_per_box: 6, gtin_tax: 14, location: 100, cest: 7, origin: 1, additional_info: 2000, net_weight: 19, gross_weight: 19, width: 19, height: 19, depth: 19,
  stock_min: 19, stock_max: 19, category: 100, product_group: 100, stock: 40, source_id: 200, created_at: 100, updated_at: 100 };
const EXPORT_DETAIL = PRODUCT_DETAIL_KEYS.filter(key => !Object.hasOwn(PRODUCT_DETAIL_LISTS, key));
function exportItem(value) {
  if (!object(value) || !uuid(value.id) || !Number.isInteger(value.version) || typeof value.active !== 'boolean' || typeof value.name !== 'string' || !value.name) badResponse();
  const safe = { id: value.id, version: value.version, active: value.active };
  for (const [key, max] of Object.entries(EXPORT_TEXT)) { const field = value[key] ?? null; if (field !== null && (typeof field !== 'string' || field.length > max)) badResponse(); safe[key] = field; }
  if ((value.price ?? null) !== null && !isCanonicalUnitPrice(value.price, 14)) badResponse();
  safe.price = value.price ?? null;
  try { for (const key of EXPORT_DETAIL) { const field = value[key] ?? null; checkProductDetail(key, field, { response: true }); safe[key] = field; } }
  catch (error) { if (error instanceof ProductDetailError) badResponse(); throw error; }
  const cost = value.cost_price ?? null, deleted = value.deleted_at ?? null;
  if ((cost !== null && !isCanonicalUnitPrice(cost, 14)) || (deleted !== null && !stamp(deleted))) badResponse();
  Object.assign(safe, { cost_price: cost, deleted_at: deleted });
  for (const key of ['tags', 'images']) {
    if (!Array.isArray(value[key]) || value[key].length > (key === 'tags' ? 50 : 20) || value[key].some(item => typeof item !== 'string' || !item || item.length > 1000)) badResponse();
    safe[key] = [...value[key]];
  }
  const supplier = value.supplier ?? null;
  if (supplier !== null) {
    if (!keysOnly(supplier, ['name', 'description', 'code', 'purchase_price', 'cost_price', 'warranty_months']) || typeof supplier.name !== 'string' || !supplier.name || supplier.name.length > 200) badResponse();
    for (const [key, max] of [['description', 120], ['code', 60], ['warranty_months', 3]]) { const field = supplier[key] ?? null; if (field !== null && (typeof field !== 'string' || field.length > max)) badResponse(); }
    for (const key of ['purchase_price', 'cost_price']) if ((supplier[key] ?? null) !== null && !isCanonicalUnitPrice(supplier[key], 14)) badResponse();
  }
  safe.supplier = supplier && { name: supplier.name, description: supplier.description ?? null, code: supplier.code ?? null, purchase_price: supplier.purchase_price ?? null, cost_price: supplier.cost_price ?? null, warranty_months: supplier.warranty_months ?? null };
  return safe;
}
export function productResponse(value, route, operation, record) {
  if (route.product === 'price-lists') return viaPrice(() => priceListResponse(value, route, operation));
  if (route.product === 'contact-tags') return viaPrice(() => contactTagResponse(value, route, operation));
  if (route.product === 'prices') return viaPrice(() => productPricesResponse(value, route, operation));
  if (route.product === 'variations') return viaPrice(() => productVariationsResponse(value, route, operation));
  if (route.product === 'custom-fields') return viaPrice(() => customFieldResponse(value, route, operation));
  if (route.product === 'invoice-tags') return viaPrice(() => invoiceTagResponse(value, route, operation));
  if (!object(value) || value.data_mode !== 'erp_native') badResponse();
  if (operation.type === 'context') {
    if (!keysOnly(value, ['crt', 'data_mode']) || ![null, '1', '2', '3', '4'].includes(value.crt ?? null)) badResponse();
    return { crt: value.crt ?? null, data_mode: 'erp_native' };
  }
  if (value.replayed !== undefined && typeof value.replayed !== 'boolean') badResponse();
  const replayed = value.replayed === undefined ? {} : { replayed: value.replayed };
  if (operation.type === 'taxonomy-list') {
    if (value.kind !== route.kind || !Array.isArray(value.items) || value.items.length > 2000) badResponse();
    const items = value.items.map(item => taxonomyItem(item, route.kind));
    if (new Set(items.map(item => item.id)).size !== items.length) badResponse();
    return { kind: route.kind, items, data_mode: 'erp_native' };
  }
  if (operation.type === 'taxonomy-save') {
    if (value.kind !== route.kind || typeof value.saved !== 'boolean') badResponse();
    if (!value.saved) { if (value.reason !== 'duplicate_name') badResponse(); return { kind: route.kind, saved: false, reason: value.reason, data_mode: 'erp_native', ...replayed }; }
    const item = taxonomyItem(value.item, route.kind);
    if (route.id && item.id !== route.id) badResponse();
    return { kind: route.kind, saved: true, item, data_mode: 'erp_native', ...replayed };
  }
  if (operation.type === 'taxonomy-delete') {
    if (value.kind !== route.kind || value.id !== route.id || typeof value.deleted !== 'boolean') badResponse();
    if (!value.deleted) { if (!['has_children', 'in_use'].includes(value.reason)) badResponse(); return { kind: route.kind, id: route.id, deleted: false, reason: value.reason, data_mode: 'erp_native', ...replayed }; }
    if (!Number.isSafeInteger(value.products) || value.products < 0) badResponse();
    return { kind: route.kind, id: route.id, deleted: true, products: value.products, data_mode: 'erp_native', ...replayed };
  }
  if (operation.type === 'export') {
    const { p_offset: offset, p_limit: limit } = operation.args;
    if (value.entity !== 'products' || value.offset !== offset || value.limit !== limit || !Number.isSafeInteger(value.total) || value.total < 0 || typeof value.stock_visible !== 'boolean'
      || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(limit, value.total - offset))) badResponse();
    const items = value.items.map(exportItem);
    if (new Set(items.map(item => item.id)).size !== items.length) badResponse();
    // 234: which stock was exported (the default warehouse, or the considered warehouses without one); a database before 234
    // answers without it (the sum of every warehouse).
    const scope = Object.hasOwn(value, 'stock_scope') ? value.stock_scope : value.stock_visible ? 'all_warehouses' : null, warehouse = value.stock_warehouse ?? null;
    if (![null, 'default_warehouse', 'considered_warehouses', 'all_warehouses'].includes(scope) || (scope === null) === value.stock_visible
      || (warehouse !== null && (!keysOnly(warehouse, ['id', 'name']) || !uuid(warehouse.id) || typeof warehouse.name !== 'string' || !warehouse.name || warehouse.name.length > 200))
      || (scope === 'default_warehouse') !== (warehouse !== null)) badResponse();
    return { entity: 'products', items, offset, limit, total: value.total, stock_visible: value.stock_visible, stock_scope: scope,
      stock_warehouse: scope === 'default_warehouse' ? { id: warehouse.id, name: warehouse.name } : null, data_mode: 'erp_native' };
  }
  if (value.entity !== 'products') badResponse();
  const row = record(value.record);
  if (route.id && row.id !== route.id) badResponse();
  if (operation.composition) { let structure; try { structure = compositionSaveDto(value, operation.args, row.id); } catch { badResponse(); }
    return { entity: 'products', record: row, ...structure, data_mode: 'erp_native', ...replayed }; }
  if (operation.initial) { let initial; try { initial = initialBalanceDto(value.initial_balance, operation.args, row.id, value.replayed === true); } catch { badResponse(); }
    return { entity: 'products', record: row, initial_balance: initial, data_mode: 'erp_native', ...replayed }; }
  return { entity: 'products', record: row, data_mode: 'erp_native', ...replayed };
}
export { PRODUCT_DETAIL_KEYS, PRODUCT_DETAIL_DECIMALS };
