// Filtro "Campos customizados" da listagem de produtos (migração 202610200191): a mesma forma na tela (montagem do filtro), no
// Worker (validação estrita antes do banco) e no SQL (tipo do campo, opção e intervalo, decisão final).
// [{field_id, value} | {field_id, from?, to?}], até 10 filtros, todos juntos. Valores são texto (decimais exatos, nunca Number).
export const CUSTOM_FILTER_MAX = 10, CUSTOM_FILTER_TEXT = 255, CUSTOM_FILTER_PARAM = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/;
export class CustomFilterError extends Error { constructor() { super('PRODUCT_CUSTOM_FILTER_INVALID'); this.name = 'CustomFilterError'; } }
const fail = () => { throw new CustomFilterError(); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Canonical filter list: lower-case ids, only the keys that carry a value, no empty filter. */
export function customFilterList(value) {
  if (!Array.isArray(value) || !value.length || value.length > CUSTOM_FILTER_MAX) fail();
  return value.map(item => {
    if (!plain(item) || Object.keys(item).some(key => !['field_id', 'value', 'from', 'to'].includes(key)) || typeof item.field_id !== 'string' || !UUID.test(item.field_id)) fail();
    const out = { field_id: item.field_id.toLowerCase() };
    for (const key of ['value', 'from', 'to']) {
      const text = item[key] ?? null;
      if (text === null || text === '') continue;
      if (typeof text !== 'string' || text.length > CUSTOM_FILTER_TEXT || CONTROL.test(text)) fail();
      out[key] = text;
    }
    if (Object.hasOwn(out, 'value') ? Object.hasOwn(out, 'from') || Object.hasOwn(out, 'to') : !Object.hasOwn(out, 'from') && !Object.hasOwn(out, 'to')) fail();
    return out;
  });
}
/** The `custom` parameter of GET /v1/cadastros/products?page=N&situation=... (JSON text). */
export function customFilterParam(list) { return JSON.stringify(customFilterList(list)); }
export function parseCustomFilterParam(text) {
  if (typeof text !== 'string' || !text || text.length > CUSTOM_FILTER_PARAM) fail();
  let value; try { value = JSON.parse(text); } catch { fail(); }
  return customFilterList(value);
}
