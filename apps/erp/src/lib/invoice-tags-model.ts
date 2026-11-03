// Marcadores (tags) das notas fiscais (migração 202610200236, área de produtos): leitura da coluna Marcadores, "Editar tags" e o
// filtro Tags das listagens de notas. As tags são do Tipo "Notas fiscais" (Preferências › Tags) e ficam só no Brufap.
export type InvoiceTagOrigin = 'origin' | 'brufap';
export interface InvoiceTag { id: string; name: string; group_id: string | null; group_name: string | null }
export interface InvoiceTagSet { invoice_id: string; version: number; tag_ids: string[]; tags: InvoiceTag[] }
export const INVOICE_TAGS_PATH = '/v1/cadastros/notas-fiscais/tags';
/** Profiles that write the tags of the notes (the server decides; the screen only hides the editor). */
export const INVOICE_TAG_WRITERS = ['admin', 'fiscal'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(): never { throw new Error('Invalid invoice tags'); }
/** The key of a note of the list: the Origin source id (digits) or the Brufap UUID. */
export const invoiceTagKey = (origin: InvoiceTagOrigin, id: string) => origin === 'origin' ? /^[0-9]{1,40}$/.test(id) : UUID.test(id.toLowerCase());
export const invoiceTagsQuery = (origin: InvoiceTagOrigin, model: string, ids: readonly string[]) =>
  `${INVOICE_TAGS_PATH}?${new URLSearchParams({ origem: origin, modelo: model, ids: ids.join(',') })}`;
export const invoiceTagSavePath = (origin: InvoiceTagOrigin, model: string, id: string) => `/v1/cadastros/notas-fiscais/${origin}/${model}/${encodeURIComponent(id)}/tags`;

function tagSet(value: unknown): InvoiceTagSet {
  if (!isObject(value) || typeof value.invoice_id !== 'string' || !Number.isInteger(value.version) || (value.version as number) < 0 || !Array.isArray(value.tag_ids) || !Array.isArray(value.tags)
    || value.tag_ids.some(id => typeof id !== 'string' || !UUID.test(id)) || value.tags.length !== value.tag_ids.length) fail();
  const set = value as { invoice_id: string; version: number; tag_ids: string[]; tags: unknown[] };
  const tags = set.tags.map(tag => {
    if (!isObject(tag) || typeof tag.id !== 'string' || !set.tag_ids.includes(tag.id) || typeof tag.name !== 'string' || !tag.name
      || !(tag.group_id === null || typeof tag.group_id === 'string') || !(tag.group_name === null || typeof tag.group_name === 'string')) fail();
    return { id: tag.id as string, name: tag.name as string, group_id: tag.group_id as string | null, group_name: tag.group_name as string | null };
  });
  return { invoice_id: set.invoice_id, version: set.version, tag_ids: [...set.tag_ids], tags };
}
/** GET answer: one set per asked note, in the asked order. */
export function parseInvoiceTagSets(value: unknown, origin: InvoiceTagOrigin, model: string, ids: readonly string[]): InvoiceTagSet[] {
  if (!isObject(value) || value.scope !== 'invoice_tags' || value.origin !== origin || value.model !== model || !Array.isArray(value.items) || value.items.length !== ids.length) fail();
  const sets = (value.items as unknown[]).map(tagSet);
  if (sets.some((set, index) => set.invoice_id !== ids[index])) fail();
  return sets;
}
/** PATCH answer of "Editar tags". */
export function parseInvoiceTagSave(value: unknown, origin: InvoiceTagOrigin, model: string, id: string): { set: InvoiceTagSet; changed: boolean; replayed: boolean } {
  if (!isObject(value) || value.scope !== 'invoice_tags' || value.origin !== origin || value.model !== model || typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean') fail();
  const set = tagSet((value as { invoice: unknown }).invoice);
  if (set.invoice_id !== id) fail();
  return { set, changed: value.changed as boolean, replayed: value.replayed as boolean };
}
