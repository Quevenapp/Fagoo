import { textCell, numberCell, type SheetCell } from './spreadsheet-export.ts';

// Cadastros > Listas de preços (migrações 121 e 154): tipos, rótulos do Origin, o corpo dos Dados gerais e a planilha das listas.
export type ListType = 'rates' | 'period' | 'custom';
export type ListCategory = 'other' | 'contact' | 'seller' | 'payment_method' | 'region';
export type Link = { id: string; name: string };
export interface PriceList {
  id: string; name: string; category: ListCategory; list_type: ListType; factor: string | null; factor_unit: 'percent' | 'amount'; direction: 'increase' | 'discount';
  considers_datetime: boolean; starts_on: string | null; ends_on: string | null; start_time: string | null; end_time: string | null; version: number; created_at: string; updated_at: string; rule: string; products: number;
  contacts?: Link[]; sellers?: Link[]; payment_methods?: Link[]; regions?: string[];
}
export type PriceListItem = { product_id: string; name: string; code: string | null; gtin: string | null; product_price: string | null; custom_price: string | null; list_price: string | null };
// Origin order of the categories (Loja is out of the Brufap scope).
export const CATEGORY: Record<ListCategory, string> = { other: 'Outra', contact: 'Contato', seller: 'Vendedor', payment_method: 'Forma de pagamento', region: 'Região' };
export const TYPE: Record<ListType, string> = { rates: 'Lista de taxas', period: 'Lista por período', custom: 'Lista customizada' };
export const STATES = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
export const MAX_LINKS = 30;
export const brDate = (value: string | null) => value ? value.split('-').reverse().join('/') : '';
export const validity = (list: Pick<PriceList, 'starts_on' | 'ends_on'>) => list.starts_on || list.ends_on ? `${brDate(list.starts_on) || '…'} a ${brDate(list.ends_on) || '…'}` : '—';
export const hours = (list: Pick<PriceList, 'considers_datetime' | 'start_time' | 'end_time'>) => list.considers_datetime && (list.start_time || list.end_time) ? `${list.start_time ?? '00:00'} às ${list.end_time ?? '23:59'}` : '—';
export const decimalComma = (value: string | null) => value ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',') : '';

export type Draft = { name: string; category: ListCategory; list_type: ListType; factor: string; factor_unit: PriceList['factor_unit']; direction: PriceList['direction']; considers_datetime: boolean;
  starts_on: string; ends_on: string; start_time: string; end_time: string; contacts: Link[]; sellers: Link[]; payment_methods: Link[]; regions: string[] };
export const EMPTY: Draft = { name: '', category: 'other', list_type: 'rates', factor: '', factor_unit: 'percent', direction: 'discount', considers_datetime: false, starts_on: '', ends_on: '', start_time: '', end_time: '',
  contacts: [], sellers: [], payment_methods: [], regions: [] };
export const draftOf = (list: PriceList): Draft => ({ name: list.name, category: list.category, list_type: list.list_type, factor: decimalComma(list.factor), factor_unit: list.factor_unit, direction: list.direction,
  considers_datetime: list.considers_datetime, starts_on: list.starts_on ?? '', ends_on: list.ends_on ?? '', start_time: list.start_time ?? '', end_time: list.end_time ?? '',
  contacts: list.contacts ?? [], sellers: list.sellers ?? [], payment_methods: list.payment_methods ?? [], regions: list.regions ?? [] });
/** Dados gerais as the API expects them, or the message of the first problem. `products` only on the inclusion (seleção). */
export function priceListData(draft: Draft, products: readonly string[] = []): Record<string, unknown> | string {
  const factor = draft.factor.trim().replace(',', '.');
  if (!draft.name.trim()) return 'Informe o nome da lista.';
  if (draft.list_type !== 'custom' && !/^(0|[1-9]\d{0,10})(?:\.\d{1,4})?$/.test(factor)) return 'Informe o fator com até quatro casas decimais, sem separador de milhares.';
  if (draft.list_type !== 'custom' && Number(factor) <= 0) return 'O fator precisa ser maior que zero.';
  if (draft.factor_unit === 'percent' && draft.direction === 'discount' && Number(factor) > 100) return 'O desconto em porcentagem não pode passar de 100%.';
  if (draft.list_type === 'period' && !draft.starts_on && !draft.ends_on) return 'Informe a data de validade da lista por período.';
  if (draft.starts_on && draft.ends_on && draft.starts_on > draft.ends_on) return 'A data de término precisa ser igual ou posterior à de início.';
  const link = (category: ListCategory, items: readonly Link[]) => draft.category === category ? items.map(item => item.id) : [];
  return { name: draft.name.trim(), category: draft.category, list_type: draft.list_type, factor: draft.list_type === 'custom' && !factor ? null : factor, factor_unit: draft.factor_unit, direction: draft.direction,
    considers_datetime: draft.considers_datetime, starts_on: draft.starts_on || null, ends_on: draft.ends_on || null, start_time: draft.considers_datetime ? draft.start_time || null : null,
    end_time: draft.considers_datetime ? draft.end_time || null : null, contacts: link('contact', draft.contacts), regions: draft.category === 'region' ? draft.regions : [],
    sellers: link('seller', draft.sellers), payment_methods: link('payment_method', draft.payment_methods), ...(products.length ? { add_products: [...products] } : {}) };
}

// ---- "Exportar dados para planilha" das listas selecionadas: uma linha por produto da lista ----
export const EXPORT_LIST_PAGE = 100, EXPORT_LIST_LIMIT = 15000;
export const LIST_SHEET_HEADER = ['Lista de preço', 'Tipo de lista', 'Regra da lista', 'Data de validade', 'Produto', 'Código (SKU)', 'GTIN/EAN', 'Preço de venda', 'Preço da lista'];
export function listSheetRows(entries: readonly { list: PriceList; items: readonly PriceListItem[] }[]): SheetCell[][] {
  return [LIST_SHEET_HEADER.map(textCell), ...entries.flatMap(({ list, items }) => items.map(item => [textCell(list.name), textCell(TYPE[list.list_type]), textCell(list.rule), textCell(validity(list) === '—' ? '' : validity(list)),
    textCell(item.name), textCell(item.code), textCell(item.gtin), numberCell(item.product_price), numberCell(item.list_price)]))];
}

// ---- Planilha modelo (migração 192): "Acesse a planilha modelo aqui e vincule seus produtos à uma lista de preço" ----
// The model is a CSV in UTF-8 with ";" (Excel in Portuguese): Código (SKU) and, in a customized list, Preço da lista. Up to 500
// lines per sheet (one command); a price uses a comma or a dot and no thousands separator.
export const SHEET_LIMIT = 500;
export const SHEET_HEADER = (custom: boolean) => custom ? ['Código (SKU)', 'Preço da lista'] : ['Código (SKU)'];
export const sheetTemplate = (custom: boolean) => `\uFEFF${SHEET_HEADER(custom).join(';')}\r\n`;
export type SheetRow = { code: string; price?: string };
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** CSV cells (quotes with "" escapes, CRLF or LF); the separator is the first of ";", tab or "," found in the first line. */
function csvRows(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, ''), first = body.split(/\r?\n/, 1)[0] ?? '';
  const separator = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) { if (char === '"' && body[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char; continue; }
    if (char === '"' && !cell) quoted = true;
    else if (char === separator) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') { if (char === '\r' && body[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
/** The lines of the sheet to send, and the problems found (a blocking problem leaves no rows). */
export function parsePriceListSheet(text: string, custom: boolean): { rows: SheetRow[]; problems: string[]; blocking: boolean } {
  const all = csvRows(text).map(cells => cells.map(cell => cell.trim())).filter(cells => cells.some(Boolean));
  // Only a header cell is skipped ("Código (SKU)", "Código", "SKU"): a first product whose code merely contains "sku" stays a row.
  if (all.length && /^(?:codigo(?: do produto)?(?: ?\(sku\)| sku)?|sku)$/.test(fold(all[0][0] ?? ''))) all.shift();
  const problems: string[] = [], rows: SheetRow[] = [];
  if (!all.length) return { rows: [], problems: ['A planilha não tem linhas de produtos.'], blocking: true };
  if (all.length > SHEET_LIMIT) return { rows: [], problems: [`A planilha tem ${all.length} linhas; envie até ${SHEET_LIMIT} por vez.`], blocking: true };
  let ignoredPrices = 0;
  all.forEach((cells, index) => {
    const line = index + 2, code = cells[0] ?? '', price = (cells[1] ?? '').replace(/\s/g, '');
    if (!code) { problems.push(`Linha ${line}: sem código.`); return; }
    if (code.length > 100 || /[\x00-\x1f\x7f]/.test(code)) { problems.push(`Linha ${line}: código inválido.`); return; }
    if (!custom) { if (price) ignoredPrices++; rows.push({ code }); return; }
    if (price && !/^\d{1,14}(?:[.,]\d{1,10})?$/.test(price)) { problems.push(`Linha ${line}: preço inválido (use vírgula ou ponto, sem separador de milhares).`); return; }
    rows.push(price ? { code, price: price.replace(',', '.') } : { code });
  });
  if (ignoredPrices) problems.push(`${ignoredPrices} preço(s) ignorado(s): o preço da planilha só vale na lista customizada; nesta lista ele vem da regra.`);
  return { rows, problems, blocking: false };
}
export type SheetResult = { added: number; updated: number; unchanged: number; duplicates: number; not_found: string[]; not_found_total: number; ambiguous: string[]; ambiguous_total: number };
export function sheetResultText(result: SheetResult) {
  const parts = [`${result.added} produto(s) incluído(s)`, ...(result.updated ? [`${result.updated} preço(s) atualizado(s)`] : []), ...(result.unchanged ? [`${result.unchanged} já estavam na lista`] : []),
    ...(result.duplicates ? [`${result.duplicates} linha(s) repetida(s)`] : [])];
  const missing = result.not_found_total ? ` Códigos não encontrados (${result.not_found_total}): ${result.not_found.join(', ')}${result.not_found_total > result.not_found.length ? '…' : ''}.` : '';
  const ambiguous = result.ambiguous_total ? ` Códigos de mais de um produto (${result.ambiguous_total}), não vinculados: ${result.ambiguous.join(', ')}${result.ambiguous_total > result.ambiguous.length ? '…' : ''}.` : '';
  return `Planilha: ${parts.join(', ')}.${missing}${ambiguous}`;
}
