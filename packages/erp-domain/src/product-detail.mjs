// Detalhe do produto (migração 202610200119): o mesmo contrato na interface (mensagens), no Worker (validação estrita do
// corpo e da resposta) e no SQL (decisão final). Decimais são strings exatas; nada passa por Number.
import {normalizeUnitPrice,isCanonicalUnitPrice} from './unit-price.mjs';

export class ProductDetailError extends Error {
  constructor(field, code = 'PRODUCT_DETAIL_INVALID') { super(code); this.name = 'ProductDetailError'; this.field = field; this.code = code; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LINE_CONTROL = /[\x00-\x1f\x7f]/;
export const PRODUCT_ITEM_TYPES = [['00', 'Mercadoria para Revenda'], ['01', 'Matéria-Prima'], ['02', 'Embalagem'], ['03', 'Produto em Processo'], ['04', 'Produto Acabado'],
  ['05', 'Subproduto'], ['06', 'Produto Intermediário'], ['07', 'Material de Uso e Consumo'], ['08', 'Ativo Imobilizado'], ['09', 'Serviços'], ['10', 'Outros insumos'], ['99', 'Outras']];
/** Texts: [maximum, accepts line breaks]. */
export const PRODUCT_DETAIL_TEXTS = { discreet_description: [120, false], complementary_description: [4000, true], notes: [2000, true], anp_description: [95, false], external_link: [120, false], video_url: [100, false] };
/** Decimals: [integer digits, decimal places, maximum]. */
export const PRODUCT_DETAIL_DECIMALS = {
  tax_percent: [3, 4, '100'], glp_percent: [3, 4, '100'], glgnn_percent: [3, 4, '100'], glgni_percent: [3, 4, '100'],
  icms_st_retention_base: [13, 2], icms_st_retention_value: [13, 2], icms_own_substitute_value: [13, 2], starting_value: [13, 2],
  ipi_fixed_value: [11, 4], pis_fixed_value: [11, 4], cofins_fixed_value: [11, 4],
  // Itens p/ caixa (migration 191): up to 999999 with six decimal places; the integer catalog column becomes its mirror.
  items_per_box_decimal: [6, 6],
};
export const PRODUCT_DETAIL_CODES = { fci_number: /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/, ipi_tipi_exception: /^\d{1,3}$/, ipi_framework_class: /^\d{3}$/, ipi_seal_code: /^[0-9A-Za-z./-]{1,60}$/, anp_code: /^\d{9}$/, crossdocking_days: /^(0|[1-9]\d{0,3})$/ };
export const PRODUCT_DETAIL_LISTS = { dun_codes: 10, suppliers: 20, tag_ids: 50, images: 20 };
/** Campos customizados (migration 156): { field_id: value }, up to 60 fields; null or '' clears a value in a request. */
export const PRODUCT_CUSTOM_VALUES_MAX = 60;
export const PRODUCT_DETAIL_KEYS = ['expiry_date', 'free_shipping', ...Object.keys(PRODUCT_DETAIL_TEXTS), 'crossdocking_days', 'category_id', 'product_group_id', 'fci_number', 'item_type',
  ...Object.keys(PRODUCT_DETAIL_DECIMALS), 'ipi_tipi_exception', 'ipi_framework_class', 'ipi_seal_code', 'anp_code', ...Object.keys(PRODUCT_DETAIL_LISTS), 'custom_values',
  // Estoque > Controle de lote (migration 191): the switch of the product; the lots themselves belong to the stock area.
  'lot_control'];
export const SUPPLIER_KEYS = ['supplier_id', 'description', 'code', 'purchase_price', 'cost_price', 'warranty_months', 'is_default'];

const fail = field => { throw new ProductDetailError(field); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export function isoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? ''); if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31';
}
/** Exact comparison of two non-negative decimal strings. */
export function decimalCompare(a, b) {
  const [wa, fa = ''] = a.split('.'), [wb, fb = ''] = b.split('.'), size = Math.max(fa.length, fb.length);
  const x = BigInt(wa + fa.padEnd(size, '0')), y = BigInt(wb + fb.padEnd(size, '0'));
  return x === y ? 0 : x > y ? 1 : -1;
}
export function decimalValid(value, [integers, scale, max], exact = false) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,${integers - 1}})(?:\\.\\d{${exact ? scale : `1,${scale}`}})${exact ? '' : '?'}$`).test(value)) return false;
  return max === undefined || decimalCompare(value, max) <= 0;
}
const url = (value, max, https) => typeof value === 'string' && value.length <= max && (https ? /^https:\/\/[^\s\x00-\x1f\x7f]+$/ : /^https?:\/\/[^\s\x00-\x1f\x7f]+$/).test(value) && value.length >= (https ? 9 : 8);
const uuid = value => typeof value === 'string' && UUID.test(value);

/** One detail field. `response` checks the canonical form the database returns (trimmed, exact decimal places, null for empty). */
export function checkProductDetail(key, value, { response = false } = {}) {
  if (value === null) return;
  if (Object.hasOwn(PRODUCT_DETAIL_LISTS, key)) return checkList(key, value, response);
  if (key === 'custom_values') return checkCustomValues(value, response);
  if (key === 'free_shipping' || key === 'lot_control') { if (typeof value !== 'boolean') fail(key); return; }
  if (typeof value !== 'string') fail(key);
  // Same rules as SQL: texts and codes drop outer spaces (an empty text is "not informed"); dates, ids and numbers are exact.
  const trimmable = Object.hasOwn(PRODUCT_DETAIL_TEXTS, key) || ['fci_number', 'ipi_tipi_exception', 'ipi_framework_class', 'ipi_seal_code', 'anp_code', 'item_type'].includes(key);
  const text = trimmable ? value.replace(/^ +| +$/g, '') : value;
  if (response && (text === '' || text !== value)) fail(key);
  if (trimmable && text === '') return;
  if (key === 'expiry_date') { if (!isoDate(text)) fail(key); return; }
  if (key === 'category_id' || key === 'product_group_id') { if (!uuid(text)) fail(key); return; }
  if (key === 'item_type') { if (!PRODUCT_ITEM_TYPES.some(([code]) => code === text)) fail(key); return; }
  if (Object.hasOwn(PRODUCT_DETAIL_TEXTS, key)) {
    const [max, lines] = PRODUCT_DETAIL_TEXTS[key];
    if (text.length > max || (lines ? CONTROL : LINE_CONTROL).test(text)) fail(key);
    if ((key === 'external_link' || key === 'video_url') && !url(text, max, false)) fail(key);
    return;
  }
  if (Object.hasOwn(PRODUCT_DETAIL_DECIMALS, key)) { if (!decimalValid(text, PRODUCT_DETAIL_DECIMALS[key], response)) fail(key); return; }
  if (Object.hasOwn(PRODUCT_DETAIL_CODES, key)) { if (!PRODUCT_DETAIL_CODES[key].test(key === 'fci_number' && !response ? text.toUpperCase() : text)) fail(key); return; }
  fail(key);
}
// Keys are lower-case field ids; a request value is text (the database checks type, option, situation and category) or null,
// an answer value is the stored canonical text.
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function checkCustomValues(value, response) {
  if (!object(value) || Object.keys(value).length > PRODUCT_CUSTOM_VALUES_MAX) fail('custom_values');
  for (const [id, text] of Object.entries(value)) {
    if (!LOWER_UUID.test(id)) fail('custom_values');
    if (text === null && !response) continue;
    if (typeof text !== 'string' || text.length > 4000 || CONTROL.test(text) || (response && !text)) fail('custom_values');
  }
}
function checkList(key, value, response) {
  if (!Array.isArray(value) || value.length > PRODUCT_DETAIL_LISTS[key]) fail(key);
  const seen = new Set();
  for (const item of value) {
    if (key === 'tag_ids') { if (!uuid(item) || seen.has(item.toLowerCase())) fail(key); seen.add(item.toLowerCase()); continue; }
    if (key === 'images') { if (!only(item, ['url']) || !url(item.url, 1000, true) || seen.has(item.url)) fail(key); seen.add(item.url); continue; }
    if (key === 'dun_codes') {
      if (!only(item, ['code', 'quantity']) || typeof item.code !== 'string' || !/^\d{14}$/.test(item.code) || seen.has(item.code)
        || !decimalValid(item.quantity, [12, 6], response) || /^0(?:\.0*)?$/.test(item.quantity)) fail(key);
      seen.add(item.code); continue;
    }
    // suppliers
    if (!only(item, response ? [...SUPPLIER_KEYS, 'supplier_name', 'supplier_code'] : SUPPLIER_KEYS) || !uuid(item.supplier_id) || seen.has(item.supplier_id.toLowerCase())
      || typeof item.is_default !== 'boolean') fail(key);
    seen.add(item.supplier_id.toLowerCase());
    for (const [field, max] of [['description', 120], ['code', 60]]) {
      const text = item[field] ?? null;
      if (text !== null && (typeof text !== 'string' || text.replace(/^ +| +$/g, '').length > max || LINE_CONTROL.test(text) || (response && (text === '' || text !== text.replace(/^ +| +$/g, ''))))) fail(key);
    }
    for (const field of ['purchase_price', 'cost_price']) {
      const price = item[field] ?? null;
      if (price !== null && (response ? !isCanonicalUnitPrice(price, 14) : (() => { try { normalizeUnitPrice(price, 14); return false; } catch { return true; } })())) fail(key);
    }
    const warranty = item.warranty_months ?? null;
    if (warranty !== null && (typeof warranty !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(warranty))) fail(key);
    if (response && (typeof item.supplier_name !== 'string' || !item.supplier_name || item.supplier_name.length > 200
      || (item.supplier_code !== null && (typeof item.supplier_code !== 'string' || item.supplier_code.length > 100)))) fail(key);
  }
  if (key === 'suppliers' && value.filter(item => item.is_default).length > 1) fail(key);
}

/** Request body: the detail keys of `data` (others are left to the caller). */
export function productDetailRequest(data) {
  for (const key of PRODUCT_DETAIL_KEYS) if (Object.hasOwn(data, key)) checkProductDetail(key, data[key]);
}
/** Response record: every detail key, canonical. Absent keys (a replay of a command saved before 119) become null. */
export function productDetailResponse(value) {
  const safe = {};
  for (const key of PRODUCT_DETAIL_KEYS) {
    const field = Object.hasOwn(value, key) ? value[key] : null;
    checkProductDetail(key, field, { response: true });
    safe[key] = key === 'suppliers' && field ? field.map(item => ({ ...Object.fromEntries(SUPPLIER_KEYS.map(k => [k, item[k] ?? null])), supplier_name: item.supplier_name, supplier_code: item.supplier_code ?? null }))
      : key === 'custom_values' && field ? { ...field } : Array.isArray(field) ? field.map(item => typeof item === 'object' ? { ...item } : item) : field;
  }
  const deleted = Object.hasOwn(value, 'deleted_at') ? value.deleted_at : null;
  if (deleted !== null && (typeof deleted !== 'string' || deleted.length > 100 || !Number.isFinite(Date.parse(deleted)))) fail('deleted_at');
  const cost = Object.hasOwn(value, 'cost_price') ? value.cost_price : null;
  if (cost !== null && !isCanonicalUnitPrice(cost, 14)) fail('cost_price');
  return { ...safe, deleted_at: deleted, cost_price: cost };
}
