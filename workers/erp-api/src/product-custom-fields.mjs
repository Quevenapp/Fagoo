/** Campos customizados de produtos (migration 202610200156), under /v1/cadastros so the ERP keeps one catalog prefix:
 * - GET /v1/cadastros/campos-customizados[?modulo=produtos] — the Produtos tab (up to 60 fields, no paging, as in Origin);
 * - POST /v1/cadastros/campos-customizados {command_id, data} — "Adicionar campo";
 * - PATCH /v1/cadastros/campos-customizados/:id {command_id, expected_version, data} — "Editar Campo" and the Situação toggle;
 * - POST /v1/cadastros/campos-customizados/:id/excluir {command_id, expected_version} — refused while products have values.
 * The values themselves travel in the product form (data.custom_values of /v1/cadastros/products/.../completo).
 * Strict input before the database, closed shapes after it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/, LINE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export class CustomFieldsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new CustomFieldsError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new CustomFieldsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const stamp = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const version = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;

export const CUSTOM_FIELD_TYPES = ['integer', 'decimal', 'list', 'text', 'long_text', 'boolean', 'date'];
export const CUSTOM_FIELD_WIDTHS = ['small', 'medium', 'large', 'extra_large'];
/** Largest Tamanho máximo of each type (characters of the value); the other types have no size. */
export const CUSTOM_FIELD_SIZE = { integer: 19, decimal: 22, text: 255, long_text: 4000 };
const KEYS = ['field_type', 'name', 'hint', 'info', 'required', 'min_length', 'max_length', 'width', 'grouped', 'category_ids', 'options', 'active'];

export function customFieldRoute(path) {
  if (path === '/v1/cadastros/campos-customizados') return { product: 'custom-fields', entity: 'products', id: null, remove: false };
  const match = /^\/v1\/cadastros\/campos-customizados\/([0-9a-fA-F-]{36})(\/excluir)?$/.exec(path);
  if (match && UUID.test(match[1])) return { product: 'custom-fields', entity: 'products', id: match[1].toLowerCase(), remove: Boolean(match[2]) };
  return null;
}
export const customFieldMethods = route => route.remove ? ['POST'] : route.id ? ['PATCH'] : ['GET', 'POST'];

const ids = (value, max) => {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !UUID.test(id))) invalid();
  const out = value.map(id => id.toLowerCase()); if (new Set(out).size !== out.length) invalid(); return out;
};
/** The drawer's data: trimmed texts, sizes as integers, lower-case ids; the database repeats every rule. */
function fieldData(value, create) {
  if (!only(value, KEYS) || !Object.keys(value).length || (create && (!Object.hasOwn(value, 'field_type') || !Object.hasOwn(value, 'name')))) invalid();
  const out = {};
  if (Object.hasOwn(value, 'field_type')) { if (!CUSTOM_FIELD_TYPES.includes(value.field_type)) invalid(); out.field_type = value.field_type; }
  if (Object.hasOwn(value, 'name')) { const name = typeof value.name === 'string' ? value.name.trim() : ''; if (!name || name.length > 60 || CONTROL.test(name)) invalid(); out.name = name; }
  for (const [key, max, lines] of [['hint', 100, false], ['info', 300, true]]) {
    if (!Object.hasOwn(value, key)) continue;
    const text = value[key] === null ? '' : typeof value[key] === 'string' ? value[key].trim() : invalid();
    if (text.length > max || (lines ? LINE_CONTROL : CONTROL).test(text)) invalid();
    out[key] = text || null;
  }
  for (const key of ['required', 'grouped', 'active']) if (Object.hasOwn(value, key)) { if (typeof value[key] !== 'boolean') invalid(); out[key] = value[key]; }
  for (const key of ['min_length', 'max_length']) if (Object.hasOwn(value, key)) { if (value[key] !== null && (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 4000)) invalid(); out[key] = value[key]; }
  if ((out.min_length ?? null) !== null && (out.max_length ?? null) !== null && out.min_length > out.max_length) invalid();
  if (out.field_type && !Object.hasOwn(CUSTOM_FIELD_SIZE, out.field_type) && ((out.min_length ?? null) !== null || (out.max_length ?? null) !== null)) invalid();
  if (Object.hasOwn(value, 'width')) { if (!CUSTOM_FIELD_WIDTHS.includes(value.width)) invalid(); out.width = value.width; }
  if (Object.hasOwn(value, 'category_ids')) out.category_ids = ids(value.category_ids, 100);
  if (Object.hasOwn(value, 'options')) {
    if (!Array.isArray(value.options) || value.options.length > 50 || (out.field_type && out.field_type !== 'list')) invalid();
    out.options = value.options.map(option => {
      if (!only(option, ['id', 'label']) || typeof option.label !== 'string') invalid();
      const label = option.label.trim(), id = option.id ?? null;
      if (!label || label.length > 60 || CONTROL.test(label) || (id !== null && (typeof id !== 'string' || !UUID.test(id)))) invalid();
      return id === null ? { label } : { id: id.toLowerCase(), label };
    });
    const ids = out.options.filter(option => option.id).map(option => option.id), labels = out.options.map(option => option.label.toLocaleLowerCase('pt-BR'));
    if (new Set(ids).size !== ids.length || new Set(labels).size !== labels.length) invalid();
  }
  if (out.field_type === 'list' && create && !out.options?.length) invalid();
  return out;
}
const command = input => { if (typeof input.command_id !== 'string' || !UUID.test(input.command_id)) invalid(); return input.command_id.toLowerCase(); };
export async function customFieldOperation(request, route, params, readBody) {
  if (!customFieldMethods(route).includes(request.method)) throw new CustomFieldsError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.method === 'GET') {
    // ?tela=produtos (wave E, migration 235): the Campos Customizados screen, with the user's permissions of Sistema › Usuários.
    if (params.has('tela')) {
      if (params.size !== 1 || params.getAll('tela').length !== 1 || params.get('tela') !== 'produtos') invalid();
      return { rpc: 'erp_catalog_custom_fields_screen', args: {}, type: 'custom-fields-screen' };
    }
    for (const key of params.keys()) if (key !== 'modulo' || params.getAll(key).length !== 1 || params.get(key) !== 'produtos') invalid();
    return { rpc: 'erp_catalog_custom_fields', args: { p_module: 'products' }, type: 'custom-fields' };
  }
  if (params.size) invalid();
  const input = await readBody(request, 32768);
  if (route.remove) {
    if (!exact(input, ['command_id', 'expected_version']) || !version(input.expected_version)) invalid();
    return { rpc: 'erp_catalog_custom_field_delete', args: { p_id: route.id, p_expected_version: input.expected_version, p_command_id: command(input) }, type: 'custom-field-delete' };
  }
  if (!exact(input, route.id ? ['command_id', 'expected_version', 'data'] : ['command_id', 'data']) || (route.id && !version(input.expected_version))) invalid();
  return { rpc: 'erp_catalog_custom_field_save', args: { p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_command_id: command(input), p_data: fieldData(input.data, !route.id) }, type: 'custom-field-save' };
}

// ---- Answers ----
const text = (value, max, lines) => value === null || (typeof value === 'string' && value.length >= 1 && value.length <= max && value === value.trim() && !(lines ? LINE_CONTROL : CONTROL).test(value));
export function customFieldItem(value) {
  if (!exact(value, ['id', 'module', 'field_type', 'name', 'hint', 'info', 'required', 'min_length', 'max_length', 'width', 'grouped', 'active', 'version', 'created_at', 'updated_at', 'options', 'category_ids', 'products'])
    || !LOWER.test(value.id) || value.module !== 'products' || !CUSTOM_FIELD_TYPES.includes(value.field_type) || typeof value.name !== 'string' || !value.name || !text(value.name, 60, false)
    || !text(value.hint, 100, false) || !text(value.info, 300, true) || typeof value.required !== 'boolean' || typeof value.grouped !== 'boolean' || typeof value.active !== 'boolean'
    || !CUSTOM_FIELD_WIDTHS.includes(value.width) || !version(value.version) || !stamp(value.created_at) || !stamp(value.updated_at)
    || !Number.isSafeInteger(value.products) || value.products < 0) bad();
  const cap = CUSTOM_FIELD_SIZE[value.field_type];
  for (const key of ['min_length', 'max_length']) if (value[key] !== null && (!cap || !Number.isInteger(value[key]) || value[key] < 1 || value[key] > cap)) bad();
  if (value.min_length !== null && value.max_length !== null && value.min_length > value.max_length) bad();
  if (!Array.isArray(value.options) || value.options.length > 50 || (value.field_type === 'list' ? !value.options.length : value.options.length)
    || value.options.some(option => !exact(option, ['id', 'label']) || !LOWER.test(option.id) || typeof option.label !== 'string' || !option.label || !text(option.label, 60, false))
    || new Set(value.options.map(option => option.id)).size !== value.options.length) bad();
  if (!Array.isArray(value.category_ids) || value.category_ids.length > 100 || value.category_ids.some(id => typeof id !== 'string' || !LOWER.test(id))
    || new Set(value.category_ids).size !== value.category_ids.length || (!value.grouped && value.category_ids.length)) bad();
  return { ...value, options: value.options.map(option => ({ id: option.id, label: option.label })), category_ids: [...value.category_ids] };
}
export function customFieldResponse(value, route, operation) {
  if (!object(value) || value.data_mode !== 'erp_native') bad();
  if (value.replayed !== undefined && typeof value.replayed !== 'boolean') bad();
  const replayed = value.replayed === undefined ? {} : { replayed: value.replayed };
  if (operation.type === 'custom-fields' || operation.type === 'custom-fields-screen') {
    if (value.module !== 'products' || !Array.isArray(value.items) || value.items.length > 60) bad();
    const items = value.items.map(customFieldItem);
    if (new Set(items.map(item => item.id)).size !== items.length) bad();
    if (operation.type === 'custom-fields') return { module: 'products', items, data_mode: 'erp_native' };
    if (!exact(value, ['module', 'data_mode', 'items', 'permissions']) || !exact(value.permissions, ['insert_edit', 'delete'])
      || typeof value.permissions.insert_edit !== 'boolean' || typeof value.permissions.delete !== 'boolean') bad();
    return { module: 'products', items, permissions: { insert_edit: value.permissions.insert_edit, delete: value.permissions.delete }, data_mode: 'erp_native' };
  }
  if (operation.type === 'custom-field-save') {
    if (typeof value.saved !== 'boolean') bad();
    if (!value.saved) {
      if (!['duplicate_name', 'limit', 'option_in_use'].includes(value.reason) || (value.reason === 'option_in_use' ? !Number.isSafeInteger(value.products) || value.products < 1 : value.products !== undefined)) bad();
      return { saved: false, reason: value.reason, ...(value.reason === 'option_in_use' ? { products: value.products } : {}), data_mode: 'erp_native', ...replayed };
    }
    const field = customFieldItem(value.field);
    if (route.id && field.id !== route.id) bad();
    return { saved: true, field, data_mode: 'erp_native', ...replayed };
  }
  if (value.id !== route.id || typeof value.deleted !== 'boolean' || !Number.isSafeInteger(value.products) || value.products < 0) bad();
  if (!value.deleted) { if (value.reason !== 'in_use' || value.products < 1) bad(); return { id: route.id, deleted: false, reason: 'in_use', products: value.products, data_mode: 'erp_native', ...replayed }; }
  return { id: route.id, deleted: true, products: 0, data_mode: 'erp_native', ...replayed };
}
