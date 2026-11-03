// Filtro "Campos customizados" da listagem de produtos (Origin: "Selecione uma categoria" e "Adicionar filtros"; migração
// 202610200191). O rascunho guarda a categoria escolhida e as linhas (campo, tipo, nome e valores digitados) como texto JSON
// dentro dos filtros da listagem; o filtro aplicado leva só as linhas completas e válidas, e a API recebe a lista canônica
// (sem o tipo, o nome e a categoria). Números são texto exato com ponto; nada passa por Number.
import { CUSTOM_FILTER_MAX, customFilterList, type CustomFilterItem } from '../../../../packages/erp-domain/src/product-custom-filter.mjs';
import type { CustomField, CustomFieldType } from './custom-fields';

export { CUSTOM_FILTER_MAX };
export interface CustomFilterRow { field_id: string; type: CustomFieldType; name: string; value: string; from: string; to: string; option?: string }
export interface CustomFilterDraft { category: string; rows: CustomFilterRow[] }
export const EMPTY_CUSTOM_FILTER: CustomFilterDraft = { category: '', rows: [] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES: CustomFieldType[] = ['integer', 'decimal', 'list', 'text', 'long_text', 'boolean', 'date'];
const NUMBER = /^-?(0|[1-9]\d{0,17})(?:[.,]\d{1,6})?$/, DATE = /^\d{4}-\d{2}-\d{2}$/, CONTROL = /[\x00-\x1f\x7f]/;
const text = (value: unknown, max = 255) => typeof value === 'string' && value.length <= max ? value : '';

/** The draft (or applied) text of the list filters; anything unexpected reads as no filter. */
export function customFilterDraft(raw: string): CustomFilterDraft {
  if (!raw) return EMPTY_CUSTOM_FILTER;
  try {
    const value = JSON.parse(raw) as { category?: unknown; rows?: unknown };
    const rows = Array.isArray(value?.rows) ? value.rows.filter((row): row is CustomFilterRow => !!row && typeof row === 'object' && UUID.test((row as CustomFilterRow).field_id)
      && TYPES.includes((row as CustomFilterRow).type)).slice(0, CUSTOM_FILTER_MAX).map(row => ({ field_id: row.field_id, type: row.type, name: text(row.name, 60), value: text(row.value), from: text(row.from), to: text(row.to), ...(row.option ? { option: text(row.option, 60) } : {}) })) : [];
    return { category: typeof value?.category === 'string' && (UUID.test(value.category) || value.category === '') ? value.category : '', rows };
  } catch { return EMPTY_CUSTOM_FILTER; }
}
export const customFilterText = (draft: CustomFilterDraft) => draft.rows.length || draft.category ? JSON.stringify(draft) : '';
/** A new row for a field (first option of nothing: the user picks the value). */
export const customFilterRow = (field: CustomField): CustomFilterRow => ({ field_id: field.id, type: field.field_type, name: field.name, value: '', from: '', to: '' });

const scaled = (value: string) => { const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace('-', '').split('.'); return (negative ? -1n : 1n) * BigInt(whole + fraction.padEnd(6, '0')); };
const number = (value: string) => value.trim().replace(',', '.');
/** The problem of one row, or null when it is complete and valid (the same rules as the database). */
export function customRowProblem(row: CustomFilterRow): string | null {
  if (row.type === 'text' || row.type === 'long_text') return !row.value.trim() ? `Informe o texto de ${row.name}.` : CONTROL.test(row.value) ? `Confira o texto de ${row.name}.` : null;
  if (row.type === 'list' || row.type === 'boolean') return row.value ? null : `Escolha ${row.type === 'boolean' ? 'Sim ou Não' : 'uma opção'} em ${row.name}.`;
  const from = row.type === 'date' ? row.from : number(row.from), to = row.type === 'date' ? row.to : number(row.to);
  if (!from && !to) return `Informe o início ou o fim de ${row.name}.`;
  if (row.type === 'date') {
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return `Informe datas válidas em ${row.name}.`;
    return from && to && from > to ? `A data inicial de ${row.name} é posterior à final.` : null;
  }
  if ((from && !NUMBER.test(from)) || (to && !NUMBER.test(to))) return `Informe números em ${row.name}, com até seis casas decimais e sem separador de milhares.`;
  return from && to && scaled(from) > scaled(to) ? `O valor inicial de ${row.name} é maior que o final.` : null;
}
/** "Filtrar": the category stays for the panel; only complete, valid rows are applied. */
export function appliedCustomFilter(raw: string): string {
  const draft = customFilterDraft(raw);
  const rows = draft.rows.filter(row => customRowProblem(row) === null).map(row => row.type === 'text' || row.type === 'long_text' ? { ...row, value: row.value.trim(), from: '', to: '' }
    : row.type === 'list' || row.type === 'boolean' ? { ...row, from: '', to: '' } : { ...row, value: '', from: row.type === 'date' ? row.from : number(row.from), to: row.type === 'date' ? row.to : number(row.to) });
  return rows.length ? JSON.stringify({ category: draft.category, rows }) : '';
}
/** The canonical list the API receives (page `custom` parameter and the price adjust filters), or null without filter. */
export function customFilterApi(raw: string): CustomFilterItem[] | null {
  const rows = customFilterDraft(raw).rows.filter(row => customRowProblem(row) === null);
  if (!rows.length) return null;
  return customFilterList(rows.map(row => row.type === 'text' || row.type === 'long_text' || row.type === 'list' || row.type === 'boolean'
    ? { field_id: row.field_id, value: row.type === 'text' || row.type === 'long_text' ? row.value.trim() : row.value }
    : { field_id: row.field_id, from: row.type === 'date' ? row.from : number(row.from), to: row.type === 'date' ? row.to : number(row.to) }));
}
const brDate = (value: string) => value.split('-').reverse().join('/');
const brNumber = (value: string) => value.replace('.', ',');
/** Chip text of one applied row, as the panel shows it. */
export function customRowLabel(row: CustomFilterRow): string {
  if (row.type === 'text' || row.type === 'long_text') return `${row.name} contém “${row.value}”`;
  if (row.type === 'boolean') return `${row.name}: ${row.value === 'true' ? 'Sim' : 'Não'}`;
  if (row.type === 'list') return `${row.name}: ${row.option ?? 'opção selecionada'}`;
  const show = row.type === 'date' ? brDate : brNumber;
  return row.from && row.to ? `${row.name} de ${show(row.from)} até ${show(row.to)}` : row.from ? `${row.name} a partir de ${show(row.from)}` : `${row.name} até ${show(row.to)}`;
}
