/** Marcadores (tags) das notas fiscais (migration 202610200236), under /v1/cadastros so the ERP keeps one catalog prefix:
 * - GET /v1/cadastros/notas-fiscais/tags?origem=origin|brufap&modelo=55|65&ids=a,b,c — the Marcadores of up to 100 listed notes;
 * - PATCH /v1/cadastros/notas-fiscais/:origem/:modelo/:nota/tags {command_id, expected_version, tag_ids} — "Editar tags" (replaces
 *   the note's tag set, with its version).
 * :nota is the Origin source id (digits) of a mirrored note or the UUID of a Brufap note. The Tags filter of the notes list
 * (tag=none|<id>) is read by fiscal-invoices.mjs, which then calls the tagged list function of the same migration.
 * Strict input before the database, closed shapes after it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INVOICE_TAG_ORIGINS = ['origin', 'brufap'], INVOICE_TAG_MODELS = ['55', '65'];
export class InvoiceTagsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new InvoiceTagsError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new InvoiceTagsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const name = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
/** The key of a note of the list: the Origin source id (digits) or the Brufap UUID (lower case). */
export const invoiceTagKey = (origin, id) => typeof id === 'string' && (origin === 'origin' ? /^[0-9]{1,40}$/.test(id) : origin === 'brufap' && UUID.test(id));
const keyOf = (origin, id) => origin === 'brufap' ? id.toLowerCase() : id;

export function invoiceTagRoute(path) {
  if (path === '/v1/cadastros/notas-fiscais/tags') return { product: 'invoice-tags', scope: 'list', entity: 'products', id: null };
  const match = /^\/v1\/cadastros\/notas-fiscais\/(origin|brufap)\/(55|65)\/([0-9a-fA-F-]{1,40})\/tags$/.exec(path);
  if (match && invoiceTagKey(match[1], match[3])) return { product: 'invoice-tags', scope: 'note', entity: 'products', origin: match[1], model: match[2], id: keyOf(match[1], match[3]) };
  return null;
}
export const invoiceTagMethods = route => route.scope === 'list' ? ['GET'] : ['PATCH'];
export async function invoiceTagOperation(request, route, params, readBody) {
  if (!invoiceTagMethods(route).includes(request.method)) throw new InvoiceTagsError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.method === 'GET') {
    for (const key of params.keys()) if (!['origem', 'modelo', 'ids'].includes(key) || params.getAll(key).length !== 1) invalid();
    const origin = params.get('origem'), model = params.get('modelo'), ids = (params.get('ids') ?? '').split(',');
    if (!INVOICE_TAG_ORIGINS.includes(origin) || !INVOICE_TAG_MODELS.includes(model) || !ids.length || ids.length > 100 || ids.some(id => !invoiceTagKey(origin, id))) invalid();
    const keys = ids.map(id => keyOf(origin, id));
    if (new Set(keys).size !== keys.length) invalid();
    return { rpc: 'erp_catalog_invoice_tags', args: { p_origin: origin, p_model: model, p_ids: keys }, type: 'invoice-tags-list' };
  }
  if (params.size) invalid();
  const input = await readBody(request, 8192);
  if (!exact(input, ['command_id', 'expected_version', 'tag_ids']) || typeof input.command_id !== 'string' || !UUID.test(input.command_id)
    || !Number.isInteger(input.expected_version) || input.expected_version < 0 || input.expected_version > 2147483646
    || !Array.isArray(input.tag_ids) || input.tag_ids.length > 50 || input.tag_ids.some(id => typeof id !== 'string' || !UUID.test(id))
    || new Set(input.tag_ids.map(id => id.toLowerCase())).size !== input.tag_ids.length) invalid();
  return { rpc: 'erp_catalog_invoice_tags_save', args: { p_origin: route.origin, p_model: route.model, p_id: route.id, p_expected_version: input.expected_version,
    p_command_id: input.command_id.toLowerCase(), p_tag_ids: input.tag_ids.map(id => id.toLowerCase()), p_mode: 'replace' }, type: 'invoice-tags-save' };
}

function tagsOf(value, origin) {
  if (!exact(value, ['invoice_id', 'version', 'tag_ids', 'tags']) || !invoiceTagKey(origin, value.invoice_id) || (origin === 'brufap' && !LOWER.test(value.invoice_id))
    || !Number.isInteger(value.version) || value.version < 0 || value.version > 2147483647
    || !Array.isArray(value.tag_ids) || value.tag_ids.length > 50 || value.tag_ids.some(id => typeof id !== 'string' || !LOWER.test(id)) || new Set(value.tag_ids).size !== value.tag_ids.length
    || !Array.isArray(value.tags) || value.tags.length !== value.tag_ids.length || (value.version === 0 && value.tag_ids.length)) bad();
  const tags = value.tags.map(tag => {
    if (!exact(tag, ['id', 'name', 'group_id', 'group_name']) || !value.tag_ids.includes(tag.id) || !name(tag.name, 100)
      || (tag.group_id !== null && (typeof tag.group_id !== 'string' || !LOWER.test(tag.group_id))) || (tag.group_name !== null && !name(tag.group_name, 100)) || ((tag.group_id === null) !== (tag.group_name === null))) bad();
    return { id: tag.id, name: tag.name, group_id: tag.group_id, group_name: tag.group_name };
  });
  if (new Set(tags.map(tag => tag.id)).size !== tags.length) bad();
  return { invoice_id: value.invoice_id, version: value.version, tag_ids: [...value.tag_ids], tags };
}
export function invoiceTagResponse(value, route, operation) {
  const { p_origin: origin, p_model: model } = operation.args;
  if (!object(value) || value.data_mode !== 'erp_native' || value.scope !== 'invoice_tags' || value.origin !== origin || value.model !== model) bad();
  if (operation.type === 'invoice-tags-save') {
    if (!exact(value, ['scope', 'origin', 'model', 'invoice', 'changed', 'replayed', 'data_mode']) || typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean') bad();
    const invoice = tagsOf(value.invoice, origin), wanted = operation.args.p_tag_ids;
    if (invoice.invoice_id !== route.id || invoice.tag_ids.length !== wanted.length || wanted.some(id => !invoice.tag_ids.includes(id))
      || invoice.version !== operation.args.p_expected_version + (value.changed ? 1 : 0)) bad();
    return { scope: 'invoice_tags', origin, model, invoice, changed: value.changed, replayed: value.replayed, data_mode: 'erp_native' };
  }
  if (!exact(value, ['scope', 'origin', 'model', 'data_mode', 'items']) || !Array.isArray(value.items) || value.items.length !== operation.args.p_ids.length) bad();
  const items = value.items.map(item => tagsOf(item, origin));
  if (items.some((item, index) => item.invoice_id !== operation.args.p_ids[index])) bad();
  return { scope: 'invoice_tags', origin, model, items, data_mode: 'erp_native' };
}
