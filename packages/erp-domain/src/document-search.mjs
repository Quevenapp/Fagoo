// Listagens de documentos (migração 202610200289): "Lote (até 50 lotes separados por ;)" e "Busca customizada" (Adicionar filtros).
// A mesma forma na tela (montagem das condições), no Worker (validação estrita antes do banco) e no SQL (decisão final, com o tipo
// dos campos customizados da OS). Valores são texto exato; números e datas nunca passam por Number.
export const SEARCH_MAX = 10, SEARCH_TEXT = 120, SEARCH_PARAM = 4096, LOTS_MAX = 50, LOT_CODE = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export class DocumentSearchError extends Error { constructor() { super('DOCUMENT_SEARCH_INVALID'); this.name = 'DocumentSearchError'; } }
const fail = () => { throw new DocumentSearchError(); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Fields of Adicionar filtros per list: [field, label, type]; type text | number | money | date. */
const COMMON = [['number', 'Número', 'number'], ['date', 'Data', 'date'], ['expected_date', 'Data prevista', 'date'], ['total', 'Total', 'money'],
  ['discount', 'Desconto', 'money'], ['freight', 'Frete', 'money'], ['contact_name', 'Nome do contato', 'text'], ['contact_document', 'CPF/CNPJ do contato', 'text'],
  ['contact_email', 'E-mail do contato', 'text'], ['contact_city', 'Cidade do contato', 'text'], ['contact_state', 'UF do contato', 'text'],
  ['notes', 'Observações', 'text'], ['internal_notes', 'Observações internas', 'text']];
export const SEARCH_FIELDS = Object.freeze({
  sales_orders: [...COMMON, ['ship_date', 'Data saída', 'date'], ['customer_po_number', 'Nº do pedido de compra', 'text']],
  sales_proposals: [...COMMON, ['valid_until', 'Validade', 'date'], ['next_contact', 'Data do próximo contato', 'date']],
  service_orders: [...COMMON, ['ship_date', 'Data de saída', 'date'], ['finish_date', 'Data conclusão', 'date'], ['equipment', 'Equipamento', 'text'],
    ['serial_number', 'Número de série', 'text'], ['technician', 'Técnico', 'text']],
  purchase_orders: [...COMMON, ['order_reference', 'Ordem de compra', 'text']],
});
export const SEARCH_OPERATOR_LABELS = Object.freeze({ contains: 'contém', not_contains: 'não contém', eq: 'igual a', ne: 'diferente de', starts_with: 'começa com',
  gt: 'maior que', ge: 'maior ou igual a', lt: 'menor que', le: 'menor ou igual a', empty: 'está vazio', not_empty: 'não está vazio' });
/** Operators per type (the campos customizados of the OS: integer/decimal = number, list = option, boolean, date, text). */
export const SEARCH_OPERATORS = Object.freeze({
  text: ['contains', 'not_contains', 'eq', 'ne', 'starts_with', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'not_empty'], money: ['eq', 'ne', 'gt', 'ge', 'lt', 'le'],
  date: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'not_empty'], boolean: ['eq', 'ne', 'empty', 'not_empty'], option: ['eq', 'ne', 'empty', 'not_empty'],
});
const VALUE = { number: /^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/, money: /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/ };
const validDate = value => /^(19|20)\d{2}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** The type of a field of the list; `custom` gives the type of a campo customizado of the OS by its id (the screen knows it). */
export function searchFieldType(kind, field, custom) {
  const known = SEARCH_FIELDS[kind]?.find(([key]) => key === field);
  if (known) return known[2];
  if (kind === 'service_orders' && typeof field === 'string' && /^custom:/.test(field) && UUID.test(field.slice(7))) return custom ? custom(field.slice(7)) ?? null : 'any';
  return null;
}
/** Canonical conditions: {field, op, value}; value null only for "está vazio" / "não está vazio". */
export function searchConditions(kind, value, custom) {
  if (!Array.isArray(value) || !value.length || value.length > SEARCH_MAX) fail();
  return value.map(item => {
    if (!plain(item) || Object.keys(item).length !== 3 || !['field', 'op', 'value'].every(key => Object.hasOwn(item, key))) fail();
    const type = searchFieldType(kind, item.field, custom);
    if (!type || typeof item.op !== 'string') fail();
    const ops = type === 'any' ? Object.keys(SEARCH_OPERATOR_LABELS) : SEARCH_OPERATORS[type];
    if (!ops.includes(item.op) || (item.field === 'number' && ['empty', 'not_empty'].includes(item.op))) fail();
    const empty = item.op === 'empty' || item.op === 'not_empty';
    if (empty) { if (item.value !== null) fail(); return { field: item.field, op: item.op, value: null }; }
    if (typeof item.value !== 'string' || CONTROL.test(item.value)) fail();
    const text = type === 'text' || type === 'any' ? item.value.trim() : item.value;
    if (!text || [...text].length > SEARCH_TEXT) fail();
    if (item.field === 'number' && !/^[1-9][0-9]{0,9}$/.test(text)) fail();
    if (VALUE[type] && !VALUE[type].test(text)) fail();
    if (type === 'date' && !validDate(text)) fail();
    if (type === 'boolean' && !['true', 'false'].includes(text)) fail();
    if (type === 'option' && !UUID.test(text)) fail();
    return { field: item.field, op: item.op, value: text };
  });
}
/** The `busca` parameter of GET /v1/documentos/{tipo}?page=N (JSON text). */
export const searchParam = (kind, list, custom) => JSON.stringify(searchConditions(kind, list, custom));
export function parseSearchParam(kind, text) {
  if (typeof text !== 'string' || !text || text.length > SEARCH_PARAM) fail();
  let value; try { value = JSON.parse(text); } catch { fail(); }
  return searchConditions(kind, value);
}
/** "Lote (até 50 lotes separados por ;)": the codes, trimmed, without empty ones or repetitions (case-insensitive). */
export function lotCodes(text) {
  if (typeof text !== 'string' || text.length > 4000) fail();
  const seen = new Set(), codes = [];
  for (const part of text.split(';')) {
    const code = part.trim(); if (!code) continue;
    if ([...code].length > LOT_CODE || CONTROL.test(code)) fail();
    if (seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase()); codes.push(code);
  }
  if (!codes.length || codes.length > LOTS_MAX) fail();
  return codes;
}
