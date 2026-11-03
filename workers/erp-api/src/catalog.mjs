import {normalizeUnitPrice,isCanonicalUnitPrice,UNIT_PRICE_INPUT_LIMIT} from '../../../packages/erp-domain/src/unit-price.mjs';
import {productRoute,productMethods,productOperation,productResponse,productPageOperation,productListExtras,productSaveData,productRecordDetail,ProductRegistryError} from './product-registry.mjs';
// Contatos lane (migrations 124-128): /v1/cadastros/{contatos,tipos-contato,vendedores,formas-pagamento,funcionarios}.
import { contactRoute, contactMethods, contactOperation, contactResponse, contactRefusal, ContactsError } from './contacts.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CATALOG_ENTITIES = ['contacts', 'products', 'warehouses'];
const COMMON = { name: 200, code: 100 };
const PRODUCT_DECIMALS = ['net_weight','gross_weight','width','height','depth','stock_min','stock_max'];
const PRODUCT_COUNTS = ['volumes','items_per_box'];
const PRODUCT_ENUMS = {condition:['new','used','refurbished','unspecified'],production:['own','third_party'],dimension_unit:['m','cm','mm'],origin:['0','1','2','3','4','5','6','7','8']};
const PRODUCT_EXTRA = {brand:100,condition:11,production:11,net_weight:19,gross_weight:19,width:19,height:19,depth:19,dimension_unit:2,volumes:6,items_per_box:6,gtin_tax:14,stock_min:19,stock_max:19,location:100,cest:7,origin:1,additional_info:2000};
const FIELDS = {
  contacts: { ...COMMON, trade_name: 200, person_type: 1, document: 30, ie: 30, email: 254, phone: 40, mobile: 40, postal_code: 20, street: 200, number: 30, complement: 200, district: 100, city: 100, state: 2 },
  products: { ...COMMON, unit: 16, price: 25, kind: 1, format: 1, description: 4000, ncm: 8, gtin: 14, ...PRODUCT_EXTRA },
  warehouses: { ...COMMON, description: 1000 },
};
// Origin-style numbered pages (migration 096): fixed allow-lists, strict response shapes and lean list items.
const PAGE_SORTS = ['created_desc', 'name_asc', 'name_desc', 'code_asc', 'code_desc'];
const PAGE_FILTERS = {
  contacts: ['role', 'person_type', 'state', 'city', 'phone', 'email', 'period', 'from', 'to'],
  products: ['kind', 'format', 'ncm_presence', 'ncm', 'brand', 'stock', 'warehouse_id', 'period', 'from', 'to'],
  warehouses: ['period', 'from', 'to'],
};
const LIST_FIELDS = {
  contacts: { trade_name: 200, person_type: 1, document: 30, email: 254, phone: 40, mobile: 40, city: 100, state: 2 },
  products: { unit: 16, price: 25, kind: 1, format: 1, gtin: 14, brand: 100, ncm: 8 },
  warehouses: {},
};
const WARNING_FIELDS = { duplicate_code: 'code', duplicate_gtin: 'gtin', invalid_document: 'document', duplicate_document: 'document' };
const STOCK_STATES = ['recorded', 'no_movements', 'review_required'];
const STOCK_QUANTITY = /^-?(0|[1-9][0-9]{0,30})\.[0-9]{6}$/;
const ROLES = ['customer', 'supplier', 'carrier'];
const isoDate = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31';
};
export class CatalogError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new CatalogError(400, 'ERP_INVALID_QUERY'); };
// The contacts module reports with its own error type; the Worker maps CatalogError, so it is converted here.
const contactCall = run => { const convert = error => { throw error instanceof ContactsError ? new CatalogError(error.status, error.code) : error; };
  try { const result = run(); return result instanceof Promise ? result.catch(convert) : result; } catch (error) { return convert(error); } };
const badResponse = () => { throw new CatalogError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
/** Contatos lane, wave C: a known refusal of a contact RPC becomes its specific code (and field); anything else is kept. */
export function catalogFailure(error, operation) {
  if (!operation?.contact || typeof error?.upstreamMessage !== 'string') return error;
  const refusal = contactRefusal(error.upstreamMessage, error.status);
  if (!refusal) return error;
  const failure = new CatalogError(refusal.status, refusal.code); if (refusal.field) failure.field = refusal.field;
  return failure;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
// Products lane (migrations 119-120): its own routes live in product-registry.mjs and its errors become catalog errors here.
// The routes below keep their contracts; only the product check also accepts (and leaves out) the form detail.
const rethrow = error => { if (error instanceof ProductRegistryError) throw new CatalogError(error.status, error.code); throw error; };
const viaProduct = run => { try { const value = run(); return value instanceof Promise ? value.catch(rethrow) : value; } catch (error) { return rethrow(error); } };
export function catalogRoute(path) {
  const product = productRoute(path); if (product) return product;
  const contact = contactRoute(path); if (contact) return contact;
  const check = /^\/v1\/cadastros\/(contacts|products)\/check$/.exec(path);
  if (check) return { entity: check[1], id: null, active: false, check: true };
  const match = /^\/v1\/cadastros(?:\/(contacts|products|warehouses)(?:\/([a-fA-F0-9-]+)(\/active)?)?)?$/.exec(path);
  if (!match || (match[2] && !UUID.test(match[2]))) return null;
  return { entity: match[1] || null, id: match[2]?.toLowerCase() || null, active: Boolean(match[3]) };
}
export function catalogMethods(route) {
  if (!route) return ['GET'];
  if (route.product) return productMethods(route);
  if (route.contact) return contactMethods(route);
  return route.check ? ['POST'] : route.active ? ['PATCH'] : route.id ? ['GET', 'PATCH'] : route.entity ? ['GET', 'POST'] : ['GET'];
}
async function body(request, max = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) invalid();
  if (Number(request.headers.get('Content-Length')) > max || !request.body) invalid();
  const reader = request.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) invalid(); text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); const data = JSON.parse(text); if (!object(data)) invalid(); return data;
  } catch { return invalid(); }
  finally { try { await reader.cancel(); } catch { /* No request data is logged. */ } reader.releaseLock(); }
}
function validateData(entity, data, create) {
  const allowed = [...Object.keys(FIELDS[entity]), ...(entity === 'contacts' ? ['roles'] : [])];
  if (!keysOnly(data, allowed) || !Object.keys(data).length || (create && typeof data.name !== 'string')) invalid();
  for (const [key, value] of Object.entries(data)) {
    if (key === 'roles') {
      if (!Array.isArray(value) || value.length > 3 || value.some(role => !['customer', 'supplier', 'carrier'].includes(role)) || new Set(value).size !== value.length) invalid();
    } else if (value !== null && (typeof value !== 'string' || value.length > (key === 'price' ? UNIT_PRICE_INPUT_LIMIT : FIELDS[entity][key]) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))) invalid();
    if (key === 'name' && (typeof value !== 'string' || !value.trim())) invalid();
    if (key === 'price' && value !== null) { try { normalizeUnitPrice(value,14); } catch { invalid(); } }
    if (entity === 'products' && Object.hasOwn(PRODUCT_EXTRA,key)) validateProductField(key,value,false,invalid);
  }
  for (const [key, choices] of Object.entries({ person_type: ['F', 'J', 'E'], kind: ['P', 'S', 'N'], format: ['S', 'V', 'E'] })) if (data[key] && !choices.includes(data[key])) invalid();
  if(entity==='products')validateStockRange(data,invalid);
  return data;
}
function validateProductField(key,value,response,fail){
  if(value===null)return;
  if(typeof value!=='string')fail();
  if(PRODUCT_DECIMALS.includes(key)&&!(response?/^(0|[1-9]\d{0,11})\.\d{6}$/:/^(0|[1-9]\d{0,11})(?:\.\d{1,6})?$/).test(value))fail();
  if(PRODUCT_COUNTS.includes(key)&&!/^(0|[1-9]\d{0,5})$/.test(value))fail();
  if(Object.hasOwn(PRODUCT_ENUMS,key)&&!(value===''&&!response)&&!PRODUCT_ENUMS[key].includes(value.trim()))fail();
  if(key==='gtin_tax'&&value!==''&&value.trim()!=='SEM GTIN'&&!/^(?:\d{8}|\d{12,14})$/.test(value.trim()))fail();
  if(key==='cest'&&value!==''&&!/^\d{7}$/.test(value.trim()))fail();
  if(/[\x00-\x1f\x7f]/.test(key==='additional_info'?value.replace(/[\r\n\t]/g,''):value))fail();
  if(response&&(value!==value.replace(/^ +| +$/g,'')||value===''))fail();
}
function validateStockRange(data,fail){
  const scaled=value=>{const [integer,fraction='']=value.split('.');return BigInt(integer)*1000000n+BigInt(fraction.padEnd(6,'0'));};
  if(typeof data.stock_min==='string'&&typeof data.stock_max==='string'&&scaled(data.stock_min)>scaled(data.stock_max))fail();
}
export async function catalogOperation(request, route, params) {
  if (!route) throw new CatalogError(404, 'ERP_NOT_FOUND');
  if (route.product) return viaProduct(() => productOperation(request, route, params, { body, validateBase: (data, create) => validateData('products', data, create) }));
  if (!catalogMethods(route).includes(request.method)) throw new CatalogError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (route.contact) return contactCall(() => contactOperation(request, route, params));
  const args = route.entity ? { p_entity: route.entity } : {};
  if (request.method === 'GET') {
    if (!route.entity || route.id) {
      if (params.size) invalid();
      return { rpc: route.id ? 'erp_catalog_get' : 'erp_catalog_access', args: { ...args, ...(route.id ? { p_id: route.id } : {}) }, type: route.id ? 'record' : 'access' };
    }
    if (params.has('page') && route.entity === 'products' && params.has('situation')) return viaProduct(() => productPageOperation(params));
    if (params.has('page')) return pageOperation(route.entity, params);
    const allowed = ['limit', 'after', 'q', 'active', ...(route.entity==='products'?['kind','format','ncm_presence','brand']:[])];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
    const limit = params.get('limit') ?? '25'; const after = params.get('after'); const query = params.get('q'); const active = params.get('active');
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || (after !== null && !UUID.test(after))
      || (query !== null && (query.length > 120 || /[\x00-\x1f\x7f]/.test(query))) || (active !== null && !['true', 'false'].includes(active))) invalid();
    const paging={p_limit:Number(limit),p_after:after?.toLowerCase()??null,p_query:query?.trim()||null,p_active:active===null?null:active==='true'};
    if(route.entity==='products'){
      const kind=params.get('kind'),format=params.get('format'),presence=params.get('ncm_presence'),brand=params.get('brand');
      if((kind!==null&&!['P','S','N'].includes(kind))||(format!==null&&!['S','V','E'].includes(format))||(presence!==null&&!['present','missing'].includes(presence))
        ||(brand!==null&&(brand.length>100||/[\x00-\x1f\x7f]/.test(brand))))invalid();
      return {rpc:'erp_catalog_product_list',args:{...paging,p_kind:kind,p_format:format,p_ncm_presence:presence,p_brand:brand?.trim()||null},type:'list'};
    }
    return { rpc: 'erp_catalog_list', args: { ...args,...paging }, type: 'list' };
  }
  if (params.size) invalid();
  const input = await body(request, route.check && route.entity === 'products' ? 65536 : 16384);
  if (route.check) {
    if (!keysOnly(input, ['id', 'data']) || !Object.hasOwn(input, 'data') || (input.id !== undefined && input.id !== null && !UUID.test(input.id))) invalid();
    const data = route.entity === 'products' && object(input.data) ? viaProduct(() => productSaveData(input.data)) : input.data;
    return { rpc: 'erp_catalog_check', args: { p_entity: route.entity, p_id: input.id ? input.id.toLowerCase() : null, p_data: validateData(route.entity, data, false) }, type: 'check' };
  }
  const allowed = route.active ? ['command_id', 'expected_version', 'active'] : [...(route.id ? ['command_id', 'expected_version', 'data'] : ['command_id', 'data']), ...(route.entity === 'warehouses' ? [] : ['acknowledged_warnings'])];
  if (!keysOnly(input, allowed) || !UUID.test(input.command_id || '') || (route.id && (!Number.isInteger(input.expected_version) || input.expected_version < 1 || input.expected_version > 2147483647))) invalid();
  const base = { ...args, p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_command_id: input.command_id.toLowerCase() };
  if (route.active) {
    if (typeof input.active !== 'boolean') invalid();
    return { rpc: 'erp_catalog_set_active', args: { ...base, p_active: input.active }, type: 'record' };
  }
  const data = validateData(route.entity, input.data, !route.id);
  if (Object.hasOwn(input, 'acknowledged_warnings')) {
    const acknowledged = input.acknowledged_warnings;
    if (!Array.isArray(acknowledged) || acknowledged.length > 4 || acknowledged.some(code => typeof code !== 'string' || !Object.hasOwn(WARNING_FIELDS, code)) || new Set(acknowledged).size !== acknowledged.length) invalid();
    return { rpc: 'erp_catalog_save_checked', args: { ...base, p_data: data, p_acknowledged: acknowledged }, type: 'record' };
  }
  return { rpc: 'erp_catalog_save', args: { ...base, p_data: data }, type: 'record' };
}
function pageOperation(entity, params) {
  const allowed = ['page', 'size', 'sort', 'q', 'active', ...PAGE_FILTERS[entity]];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  const value = key => params.get(key);
  const text = (key, max) => { const raw = value(key); if (raw === null) return null; if (raw.length > max || /[\x00-\x1f\x7f]/.test(raw)) invalid(); return raw.trim() || null; };
  const page = value('page'), size = value('size') ?? '100', sort = value('sort') ?? 'created_desc', active = value('active');
  if (!/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000 || !/^[1-9]\d{0,2}$/.test(size) || Number(size) > 100 || !PAGE_SORTS.includes(sort)
    || (active !== null && !['true', 'false'].includes(active))) invalid();
  const period = value('period'), from = value('from'), to = value('to');
  if ((period === null) !== (from === null && to === null) || (period !== null && !['created', 'updated'].includes(period))
    || (from !== null && !isoDate(from)) || (to !== null && !isoDate(to)) || (from !== null && to !== null && from > to)) invalid();
  const args = { p_page: Number(page), p_size: Number(size), p_sort: sort, p_query: text('q', 120), p_active: active === null ? null : active === 'true', p_period: period, p_from: from, p_to: to };
  if (entity === 'products') {
    const kind = value('kind'), format = value('format'), presence = value('ncm_presence'), ncm = value('ncm'), stock = value('stock'), warehouse = value('warehouse_id');
    if ((kind !== null && !['P', 'S', 'N'].includes(kind)) || (format !== null && !['S', 'V', 'E'].includes(format)) || (presence !== null && !['present', 'missing'].includes(presence))
      || (ncm !== null && (!/^\d{2,8}$/.test(ncm) || presence === 'missing')) || (stock !== null && !['zero', 'negative', 'positive', 'no_movements'].includes(stock))
      || (warehouse !== null && !UUID.test(warehouse))) invalid();
    return { rpc: 'erp_catalog_product_page', args: { ...args, p_kind: kind, p_format: format, p_ncm_presence: presence, p_ncm: ncm, p_brand: text('brand', 100), p_stock: stock, p_warehouse_id: warehouse?.toLowerCase() ?? null }, type: 'page' };
  }
  if (entity === 'contacts') {
    const role = value('role'), personType = value('person_type'), state = value('state'), phone = text('phone', 40);
    if ((role !== null && ![...ROLES, 'none'].includes(role)) || (personType !== null && !['F', 'J', 'E'].includes(personType))
      || (state !== null && !/^[A-Za-z]{2}$/.test(state)) || (phone !== null && !/\d/.test(phone))) invalid();
    Object.assign(args, { p_role: role, p_person_type: personType, p_state: state?.toUpperCase() ?? null, p_city: text('city', 100), p_phone: phone, p_email: text('email', 254) });
  }
  return { rpc: 'erp_catalog_page', args: { p_entity: entity, ...args }, type: 'page' };
}
function record(value, entity, detail = false) {
  if (!object(value) || !UUID.test(value.id || '') || value.entity !== entity || !Number.isInteger(value.version) || value.version < 1 || typeof value.active !== 'boolean') badResponse();
  const safe = { id: value.id, entity, version: value.version, active: value.active };
  for (const [key, max] of Object.entries({ ...FIELDS[entity], created_at: 100, updated_at: 100 })) {
    const field = value[key] ?? null;
    if (field !== null && (typeof field !== 'string' || field.length > max)) badResponse();
    safe[key] = field;
  }
  if (typeof safe.name !== 'string' || !safe.name.trim()) badResponse();
  if(entity==='products'){
    if(safe.price!==null&&!isCanonicalUnitPrice(safe.price,14))badResponse();
    for(const key of Object.keys(PRODUCT_EXTRA))validateProductField(key,safe[key],true,badResponse);
    validateStockRange(safe,badResponse);
    if (detail) Object.assign(safe, viaProduct(() => productRecordDetail(value)));
  }
  if (entity === 'contacts') {
    if (!Array.isArray(value.roles) || value.roles.some(role => !['customer', 'supplier', 'carrier'].includes(role))) badResponse();
    safe.roles = value.roles;
  }
  safe.source = null;
  if (value.source !== null && value.source !== undefined) {
    if (!object(value.source) || value.source.system !== 'origin') badResponse();
    safe.source = { system: 'origin' };
    for (const key of ['source_id', 'state', 'applied_hash', 'latest_hash']) {
      const field = value.source[key] ?? null;
      if (field !== null && (typeof field !== 'string' || field.length > 200)) badResponse();
      safe.source[key] = field;
    }
  }
  return safe;
}
export function catalogResponse(value, route, operation) {
  if (route.product) return viaProduct(() => productResponse(value, route, operation, item => record(item, 'products', true)));
  if (operation.contact) return contactCall(() => contactResponse(value, route, operation));
  if (!object(value) || value.data_mode !== 'erp_native') badResponse();
  if (operation.type === 'access') {
    for (const key of ['read', 'write']) if (!Array.isArray(value[key]) || value[key].some(entity => !CATALOG_ENTITIES.includes(entity))) badResponse();
    return { read: value.read, write: value.write, data_mode: 'erp_native' };
  }
  if (value.entity !== route.entity) badResponse();
  if (operation.type === 'page') return pageResponse(value, route.entity, operation.args);
  if (operation.type === 'check') {
    if (!Array.isArray(value.warnings) || value.warnings.length > 4) badResponse();
    return { entity: route.entity, warnings: value.warnings.map(item => warning(item, route.entity)), data_mode: 'erp_native' };
  }
  if (operation.type === 'list') {
    if (!Array.isArray(value.items) || value.items.length > operation.args.p_limit || value.limit !== operation.args.p_limit || typeof value.has_more !== 'boolean'
      || (value.has_more ? !UUID.test(value.next_cursor || '') : value.next_cursor !== null)) badResponse();
    return { entity: route.entity, items: value.items.map(item => record(item, route.entity)), limit: value.limit, has_more: value.has_more, next_cursor: value.next_cursor, data_mode: 'erp_native' };
  }
  if (value.replayed !== undefined && typeof value.replayed !== 'boolean') badResponse();
  const row=record(value.record,route.entity);if(route.id&&row.id!==route.id)badResponse();
  return { entity: route.entity, record: row, data_mode: 'erp_native', ...(value.replayed === undefined ? {} : { replayed: value.replayed }) };
}

function listItem(value, entity) {
  if (!object(value) || !UUID.test(value.id || '') || value.entity !== entity || !Number.isInteger(value.version) || value.version < 1 || value.version > 2147483647 || typeof value.active !== 'boolean') badResponse();
  const safe = { id: value.id, entity, version: value.version, active: value.active };
  for (const [key, max] of Object.entries({ ...COMMON, ...LIST_FIELDS[entity], created_at: 100, updated_at: 100 })) {
    const field = value[key] ?? null;
    if (field !== null && (typeof field !== 'string' || field.length > max)) badResponse();
    safe[key] = field;
  }
  if (typeof safe.name !== 'string' || !safe.name.trim() || typeof safe.created_at !== 'string' || typeof safe.updated_at !== 'string') badResponse();
  if (entity === 'products' && safe.price !== null && !isCanonicalUnitPrice(safe.price, 14)) badResponse();
  if (entity === 'contacts') {
    if (!Array.isArray(value.roles) || value.roles.length > 3 || value.roles.some(role => !ROLES.includes(role)) || new Set(value.roles).size !== value.roles.length) badResponse();
    safe.roles = [...value.roles];
  }
  safe.source = null;
  if (value.source !== null && value.source !== undefined) {
    if (!keysOnly(value.source, ['system', 'source_id', 'state']) || value.source.system !== 'origin') badResponse();
    safe.source = { system: 'origin' };
    for (const key of ['source_id', 'state']) {
      const field = value.source[key] ?? null;
      if (field !== null && (typeof field !== 'string' || field.length > 200)) badResponse();
      safe.source[key] = field;
    }
  }
  return safe;
}
function stockQuantity(state, quantity) {
  if (!STOCK_STATES.includes(state)) badResponse();
  if (state === 'recorded' ? typeof quantity !== 'string' || !STOCK_QUANTITY.test(quantity) || quantity === '-0.000000' : quantity !== null) badResponse();
  return quantity;
}
// "Sem lançamentos" (no position) stays distinct from a recorded zero; review states never carry a quantity.
function stock(value, warehouse) {
  if (!keysOnly(value, ['state', 'quantity', 'warehouse'])) badResponse();
  const safe = { state: value.state, quantity: stockQuantity(value.state, value.quantity ?? null), warehouse: null };
  if (warehouse === null) { if (value.warehouse !== null && value.warehouse !== undefined) badResponse(); return safe; }
  const selected = value.warehouse;
  if (!keysOnly(selected, ['id', 'state', 'quantity']) || selected.id !== warehouse || (selected.state === 'review_required' && safe.state !== 'review_required')) badResponse();
  safe.warehouse = { id: warehouse, state: selected.state, quantity: stockQuantity(selected.state, selected.quantity ?? null) };
  return safe;
}
function pageResponse(value, entity, args) {
  const total = value.total;
  // Total and page come from the same filtered set: a page inside the total is full or the last one, and one past it is empty.
  if (!Array.isArray(value.items) || value.page !== args.p_page || value.size !== args.p_size || value.sort !== args.p_sort
    || !Number.isSafeInteger(total) || total < 0 || total > 100000000
    || value.items.length !== Math.max(0, Math.min(args.p_size, total - (args.p_page - 1) * args.p_size))) badResponse();
  const result = { entity, page: value.page, size: value.size, total, sort: value.sort, data_mode: 'erp_native' };
  if (entity === 'products') {
    if (typeof value.stock_visible !== 'boolean') badResponse();
    result.stock_visible = value.stock_visible;
  }
  const seen = new Set();
  result.items = value.items.map(item => {
    const safe = listItem(item, entity);
    if (seen.has(safe.id)) badResponse();
    seen.add(safe.id);
    if (entity === 'products') safe.stock = value.stock_visible ? stock(item.stock, args.p_warehouse_id) : item.stock === null ? null : badResponse();
    if (entity === 'products' && args.p_situation !== undefined) Object.assign(safe, viaProduct(() => productListExtras(item)));
    return safe;
  });
  return result;
}
function warning(value, entity) {
  const field = object(value) ? WARNING_FIELDS[value.code] : undefined;
  if (!field || value.field !== field || (entity === 'products') !== ['duplicate_code', 'duplicate_gtin'].includes(value.code)) badResponse();
  if (value.code === 'invalid_document') {
    if (!keysOnly(value, ['code', 'field', 'expected']) || !['cpf', 'cnpj', 'document'].includes(value.expected)) badResponse();
    return { code: value.code, field, expected: value.expected };
  }
  if (!keysOnly(value, ['code', 'field', 'total', 'matches']) || !Array.isArray(value.matches) || value.matches.length < 1 || value.matches.length > 5
    || !Number.isSafeInteger(value.total) || value.total < value.matches.length || value.total > 100000000) badResponse();
  const matches = value.matches.map(match => {
    if (!keysOnly(match, ['id', 'name', 'code', 'active']) || !UUID.test(match.id || '') || typeof match.name !== 'string' || !match.name.trim() || match.name.length > 200
      || (match.code !== null && (typeof match.code !== 'string' || match.code.length > 100)) || typeof match.active !== 'boolean') badResponse();
    return { id: match.id, name: match.name, code: match.code, active: match.active };
  });
  return { code: value.code, field, total: value.total, matches };
}
