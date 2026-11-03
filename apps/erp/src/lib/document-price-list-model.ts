// Cadastros › Listas de preços (202610200121) applied in the pedido de venda and in the proposta: which lists apply to the cliente
// now (America/Sao_Paulo) and the list price of a product. Read-only; the price stays a normal, editable unit price.
export type PriceListOption = { id: string; name: string; category: 'other' | 'contact' | 'region' | 'seller' | 'payment_method'; list_type: 'rates' | 'period' | 'custom'; rule: string;
  starts_on: string | null; ends_on: string | null; considers_datetime: boolean; start_time: string | null; end_time: string | null;
  contacts?: string[]; regions?: string[] };
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/, CENTS = /^\d{1,16}\.\d{2}$/;
function fail(): never { throw new Error('PRICE_LISTS_INVALID'); }
function header(value: unknown, detail: boolean): PriceListOption {
  const row = value as PriceListOption & { contacts?: { id: string }[] | string[]; regions?: string[] } | null;
  if (!row || !UUID.test(row.id) || typeof row.name !== 'string' || !row.name || !['other', 'contact', 'region', 'seller', 'payment_method'].includes(row.category) || !['rates', 'period', 'custom'].includes(row.list_type)
    || typeof row.rule !== 'string' || [row.starts_on, row.ends_on].some(day => day !== null && !DAY.test(day)) || typeof row.considers_datetime !== 'boolean'
    || [row.start_time, row.end_time].some(time => time !== null && !TIME.test(time))) fail();
  const option: PriceListOption = { id: row.id, name: row.name, category: row.category, list_type: row.list_type, rule: row.rule, starts_on: row.starts_on, ends_on: row.ends_on,
    considers_datetime: row.considers_datetime, start_time: row.start_time, end_time: row.end_time };
  if (detail) {
    if (!Array.isArray(row.contacts) || !Array.isArray(row.regions)) fail();
    option.contacts = (row.contacts as { id: string }[]).map(item => { if (!item || !UUID.test(item.id)) fail(); return item.id; });
    option.regions = row.regions.map(state => { if (typeof state !== 'string' || !/^[A-Z]{2}$/.test(state)) fail(); return state; });
  }
  return option;
}
/** `/v1/cadastros/listas-precos`: headers without the contacts and the UFs. */
export function readPriceLists(value: unknown): PriceListOption[] {
  const page = value as { items?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 1000) fail();
  return page.items.map(item => header(item, false));
}
/** `/v1/cadastros/listas-precos/{id}?offset=0&limit=1`: the header with the contacts and the UFs of the list. */
export function readPriceListDetail(value: unknown, id: string): PriceListOption {
  const page = value as { list?: unknown } | null;
  const list = header(page?.list, true); if (list.id !== id) fail();
  return list;
}
/**
 * 202610200282 (produtos lane): `/v1/cadastros/listas-precos/aplicaveis` decides on the server which lists apply now (São Paulo): Outra,
 * Contato (the cliente), Região (its UF), Vendedor (the vendedor of the document: "Vendedores selecionados terão acesso a esta lista de
 * preços nos formulários de venda") and Forma de pagamento (one of the formas of the parcelas, up to 20).
 */
export function applicableListsPath(contact: { id: string; state: string | null } | null, seller: string | null, paymentMethods: readonly string[]): string {
  const methods = [...new Set(paymentMethods.filter(id => UUID.test(id)).map(id => id.toLowerCase()))].sort().slice(0, 20);
  // Only one of the 27 UFs is sent: a cliente of the exterior mirrored from Origin ("EX") or any other value is left to the server.
  const upper = contact?.state?.toUpperCase() ?? null, state = upper && UFS.includes(upper) ? upper : null;
  const params = new URLSearchParams(Object.entries({ contato: contact?.id ?? '', vendedor: seller && UUID.test(seller) ? seller : '', forma_pagamento: methods.join(','), uf: state ?? '' }).filter(([, value]) => value));
  return `/v1/cadastros/listas-precos/aplicaveis${params.size ? `?${params}` : ''}`;
}
/** The answer of `/aplicaveis`: list headers (without contacts, UFs, vendedores and formas), at most 1000. */
export function readApplicableLists(value: unknown): PriceListOption[] {
  const page = value as { items?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 1000) fail();
  const items = page.items.map(item => header(item, false));
  if (new Set(items.map(item => item.id)).size !== items.length) fail();
  return items;
}
/** Origin: the list applies to the cliente (Contato), to its UF (Região) or to everyone (Outra), within its validity and hours. */
export function priceListApplies(list: PriceListOption, contact: { id: string; state: string | null } | null, now: { day: string; time: string }): boolean {
  if (list.category === 'contact' && !(contact && list.contacts?.includes(contact.id))) return false;
  if (list.category === 'region' && !(contact?.state && list.regions?.includes(contact.state.toUpperCase()))) return false;
  if (list.starts_on && now.day < list.starts_on) return false;
  if (list.ends_on && now.day > list.ends_on) return false;
  if (list.considers_datetime && list.start_time && list.end_time && (now.time < list.start_time || now.time > list.end_time)) return false;
  return true;
}
/** `/v1/cadastros/products/{id}/listas-precos`: the list price of the product in the chosen list (null when it is not in the list). */
export function productListPrice(value: unknown, productId: string, listId: string): string | null {
  const page = value as { product_id?: unknown; items?: { id: string; list_price: string | null }[] } | null;
  if (!page || page.product_id !== productId || !Array.isArray(page.items)) fail();
  const found = page.items.find(item => item?.id === listId);
  if (!found || found.list_price === null) return null;
  if (!CENTS.test(found.list_price)) fail();
  return found.list_price;
}
/** Now in America/Sao_Paulo (day and HH:MM). */
export function saoPauloNow(date = new Date()): { day: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map(part => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
/** 202610200196: the batch lookup of the produtos lane (GET /v1/cadastros/listas-precos/{id}/precos?produtos=, up to 100 products). */
export const listPricesPath = (listId: string, productIds: readonly string[]) => `/v1/cadastros/listas-precos/${listId}/precos?${new URLSearchParams({ produtos: productIds.join(',') })}`;
/** Product → list price of the list (null when the product is not in the list); a list no longer valid now prices nothing. */
export function readListPrices(value: unknown, listId: string, productIds: readonly string[]): Map<string, string | null> {
  const page = value as { list?: { id?: unknown; valid_now?: unknown }; items?: { product_id: string; in_list: boolean; list_price: string | null }[] } | null;
  if (!page || page.list?.id !== listId || typeof page.list.valid_now !== 'boolean' || !Array.isArray(page.items) || page.items.length > productIds.length) fail();
  const prices = new Map<string, string | null>(productIds.map(id => [id, null]));
  for (const item of page.items) {
    if (!item || !productIds.includes(item.product_id) || typeof item.in_list !== 'boolean' || (item.list_price !== null && !CENTS.test(item.list_price))) fail();
    prices.set(item.product_id, page.list.valid_now && item.in_list ? item.list_price : null);
  }
  return prices;
}
