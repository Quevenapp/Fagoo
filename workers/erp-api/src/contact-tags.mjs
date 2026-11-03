/** Tags de Contatos (migration 202610200153), under /v1/cadastros so the ERP keeps one catalog prefix:
 * - GET /v1/cadastros/contatos/tags?ids=a,b,c — the Marcadores of up to 100 listed contacts (only the visible ones come back);
 * - GET /v1/cadastros/contatos/:id/tags — the tags of one contact (form);
 * - PATCH /v1/cadastros/contatos/:id/tags — "Editar tags" (mode replace, with the version of the contact's tag set) or
 *   "Incluir tags para selecionados" (mode add, no version: adding never removes a tag saved by another operation).
 * The contact list filters Tags (tag=none|<id>) and Lista de preço (price_list_id=<id>) are read here for contacts.mjs, which then
 * calls the tagged page/export functions of the same migration. Strict input before the database, closed shapes after it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ContactTagsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new ContactTagsError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new ContactTagsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const name = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

// ---- Contact list filters (contacts.mjs) ----
export const CONTACT_TAG_FILTERS = ['tag', 'price_list_id'];
/** {} without the filters (the contatos page/export stay as they are), or the two extra arguments of the tagged functions. */
export function contactTagFilterArgs(get) {
  const tag = get('tag'), list = get('price_list_id');
  if (tag === null && list === null) return null;
  if ((tag !== null && tag !== 'none' && !UUID.test(tag)) || (list !== null && !UUID.test(list))) throw new ContactTagsError(400, 'ERP_INVALID_QUERY');
  return { p_tag: tag === null || tag === 'none' ? tag : tag.toLowerCase(), p_price_list_id: list?.toLowerCase() ?? null };
}

// ---- Routes ----
export function contactTagRoute(path) {
  if (path === '/v1/cadastros/contatos/tags') return { product: 'contact-tags', scope: 'list', entity: 'contacts', id: null };
  const match = /^\/v1\/cadastros\/contatos\/([0-9a-fA-F-]{36})\/tags$/.exec(path);
  if (match && UUID.test(match[1])) return { product: 'contact-tags', scope: 'contact', entity: 'contacts', id: match[1].toLowerCase() };
  return null;
}
export const contactTagMethods = route => route.scope === 'list' ? ['GET'] : ['GET', 'PATCH'];
export async function contactTagOperation(request, route, params, readBody) {
  if (!contactTagMethods(route).includes(request.method)) throw new ContactTagsError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.method === 'GET') {
    if (route.scope === 'contact') { if (params.size) invalid(); return { rpc: 'erp_catalog_contact_tags', args: { p_ids: [route.id] }, type: 'contact-tags-one' }; }
    for (const key of params.keys()) if (key !== 'ids' || params.getAll(key).length !== 1) invalid();
    const ids = (params.get('ids') ?? '').split(',');
    if (!ids.length || ids.length > 100 || ids.some(id => !UUID.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) invalid();
    return { rpc: 'erp_catalog_contact_tags', args: { p_ids: ids.map(id => id.toLowerCase()) }, type: 'contact-tags-list' };
  }
  if (params.size) invalid();
  const input = await readBody(request, 8192);
  if (!object(input) || !['replace', 'add'].includes(input.mode)) invalid();
  if (!exact(input, input.mode === 'replace' ? ['command_id', 'expected_version', 'mode', 'tag_ids'] : ['command_id', 'mode', 'tag_ids'])) invalid();
  if (!uuid(input.command_id) || !Array.isArray(input.tag_ids) || input.tag_ids.length > 50 || (input.mode === 'add' && !input.tag_ids.length) || input.tag_ids.some(id => !uuid(id))
    || new Set(input.tag_ids.map(id => id.toLowerCase())).size !== input.tag_ids.length) invalid();
  if (input.mode === 'replace' && (!Number.isInteger(input.expected_version) || input.expected_version < 0 || input.expected_version > 2147483646)) invalid();
  return { rpc: 'erp_catalog_contact_tags_save', args: { p_id: route.id, p_expected_version: input.mode === 'replace' ? input.expected_version : null, p_command_id: input.command_id.toLowerCase(),
    p_tag_ids: input.tag_ids.map(id => id.toLowerCase()), p_mode: input.mode }, type: 'contact-tags-save' };
}

function tagsOf(value) {
  if (!exact(value, ['contact_id', 'version', 'tag_ids', 'tags']) || !uuid(value.contact_id) || !Number.isInteger(value.version) || value.version < 0 || value.version > 2147483647
    || !Array.isArray(value.tag_ids) || value.tag_ids.length > 50 || value.tag_ids.some(id => !uuid(id)) || new Set(value.tag_ids).size !== value.tag_ids.length
    || !Array.isArray(value.tags) || value.tags.length !== value.tag_ids.length) bad();
  const tags = value.tags.map(tag => {
    if (!exact(tag, ['id', 'name', 'group_id', 'group_name']) || !uuid(tag.id) || !value.tag_ids.includes(tag.id) || !name(tag.name, 100)
      || (tag.group_id !== null && !uuid(tag.group_id)) || (tag.group_name !== null && !name(tag.group_name, 100)) || ((tag.group_id === null) !== (tag.group_name === null))) bad();
    return { id: tag.id, name: tag.name, group_id: tag.group_id, group_name: tag.group_name };
  });
  if (new Set(tags.map(tag => tag.id)).size !== tags.length) bad();
  return { contact_id: value.contact_id, version: value.version, tag_ids: [...value.tag_ids], tags };
}
export function contactTagResponse(value, route, operation) {
  if (!object(value) || value.data_mode !== 'erp_native' || value.entity !== 'contacts') bad();
  if (operation.type === 'contact-tags-save') {
    if (!exact(value, ['entity', 'contact', 'changed', 'replayed', 'data_mode']) || typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean') bad();
    const contact = tagsOf(value.contact); if (contact.contact_id !== route.id) bad();
    if (operation.args.p_mode === 'add' && operation.args.p_tag_ids.some(id => !contact.tag_ids.includes(id))) bad();
    if (operation.args.p_mode === 'replace' && (contact.tag_ids.length !== operation.args.p_tag_ids.length || operation.args.p_tag_ids.some(id => !contact.tag_ids.includes(id)))) bad();
    return { entity: 'contacts', contact, changed: value.changed, replayed: value.replayed, data_mode: 'erp_native' };
  }
  if (!exact(value, ['entity', 'items', 'data_mode']) || !Array.isArray(value.items) || value.items.length > operation.args.p_ids.length) bad();
  const items = value.items.map(tagsOf);
  if (items.some(item => !operation.args.p_ids.includes(item.contact_id)) || new Set(items.map(item => item.contact_id)).size !== items.length) bad();
  if (operation.type === 'contact-tags-one') {
    // A contact this profile cannot see (or that does not exist) answers like a missing record.
    if (items.length !== 1) throw new ContactTagsError(404, 'ERP_NOT_FOUND');
    return { entity: 'contacts', contact: items[0], data_mode: 'erp_native' };
  }
  return { entity: 'contacts', items, data_mode: 'erp_native' };
}
