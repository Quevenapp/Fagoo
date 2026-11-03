// Campos customizados de produtos (migração 202610200156): tipos, rótulos do Origin, leitura da API, o rascunho da gaveta
// "Adicionar campo" / "Editar Campo", os valores do formulário do produto (com a mesma validação do banco) e as colunas da
// exportação "Customizado" / "Ambos". Valores são texto exato; nada passa por Number.
import { invalidField } from './catalog-base.ts';
import { fold, type TaxonomyItem } from './product-form-model.ts';

export type CustomFieldType = 'integer' | 'decimal' | 'list' | 'text' | 'long_text' | 'boolean' | 'date';
export type CustomFieldWidth = 'small' | 'medium' | 'large' | 'extra_large';
export interface CustomFieldOption { id: string; label: string }
export interface CustomField {
  id: string; module: 'products'; field_type: CustomFieldType; name: string; hint: string | null; info: string | null; required: boolean;
  min_length: number | null; max_length: number | null; width: CustomFieldWidth; grouped: boolean; active: boolean; version: number;
  created_at: string; updated_at: string; options: CustomFieldOption[]; category_ids: string[]; products: number;
}
export const CUSTOM_FIELD_TYPES: CustomFieldType[] = ['integer', 'decimal', 'list', 'text', 'long_text', 'boolean', 'date'];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = { integer: 'Inteiro', decimal: 'Decimal', list: 'Lista', text: 'Texto', long_text: 'Texto Longo', boolean: 'Lógico', date: 'Data' };
export const CUSTOM_FIELD_WIDTHS: CustomFieldWidth[] = ['small', 'medium', 'large', 'extra_large'];
export const CUSTOM_FIELD_WIDTH_LABELS: Record<CustomFieldWidth, string> = { small: 'Pequeno', medium: 'Médio', large: 'Grande', extra_large: 'Extra Grande' };
/** Largest Tamanho máximo (characters of the value) of the types that have a size. */
export const CUSTOM_FIELD_SIZE: Partial<Record<CustomFieldType, number>> = { integer: 19, decimal: 22, text: 255, long_text: 4000 };
export const CUSTOM_FIELDS_LIMIT = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/, LINE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** The Produtos tab answered by the API, checked again on the screen. */
export function customFieldItems(value: unknown): CustomField[] {
  const page = value as { module?: unknown; items?: unknown } | null;
  if (!page || page.module !== 'products' || !Array.isArray(page.items) || page.items.some(item => !item || typeof item !== 'object' || !UUID.test((item as CustomField).id)
    || !CUSTOM_FIELD_TYPES.includes((item as CustomField).field_type) || typeof (item as CustomField).name !== 'string' || !Number.isInteger((item as CustomField).version)
    || !Array.isArray((item as CustomField).options) || !Array.isArray((item as CustomField).category_ids))) throw new Error('Invalid custom fields');
  return page.items as CustomField[];
}

/** The product's category and the ones above it: a field grouped in a category also shows in its subcategories. */
export function categoryLineage(categoryId: string | null | undefined, categories: readonly TaxonomyItem[]): string[] {
  const lineage: string[] = []; let current = categoryId ? categories.find(item => item.id === categoryId) : undefined;
  if (categoryId && !current) return [categoryId];
  while (current && lineage.length < 50) { lineage.push(current.id); const parent = current.parent_id; current = parent ? categories.find(item => item.id === parent) : undefined; }
  return lineage;
}
export const customFieldApplies = (field: CustomField, lineage: readonly string[]) => !field.grouped || field.category_ids.some(id => lineage.includes(id));
/** Fields shown in the product form: active and applicable to the category (Agrupador), in the order of the list (name). */
export const visibleCustomFields = (fields: readonly CustomField[], categoryId: string | null | undefined, categories: readonly TaxonomyItem[]) => {
  const lineage = categoryLineage(categoryId, categories);
  return fields.filter(field => field.active && customFieldApplies(field, lineage));
};
/** Values that a category change removes (grouped fields that do not apply to the new category), as the Origin warning says;
 * the database removes the same ones when the category changes. */
export function lostCustomValues(fields: readonly CustomField[], values: Readonly<Record<string, string>>, from: string | null | undefined, to: string | null | undefined, categories: readonly TaxonomyItem[]) {
  if ((from || '') === (to || '')) return [];
  const after = categoryLineage(to, categories);
  return fields.filter(field => field.grouped && (values[field.id] ?? '').trim() !== '' && !customFieldApplies(field, after));
}

// ---- Product form values ----
/** The text shown in the input: the stored decimal with a comma; everything else as stored. */
export const customInputValue = (field: CustomField, value: string | undefined) => field.field_type === 'decimal' ? (value ?? '').replace('.', ',') : value ?? '';
const decimalPattern = /^-?(0|[1-9]\d{0,14})(?:[.,]\d{1,6})?$/;
function validDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31';
}
/** The value to send ('' becomes null) or the message of the first problem, with the same rules as the database. */
export function customValue(field: CustomField, raw: string | undefined): { value: string | null } | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return field.required ? { error: `Preencha o campo ${field.name}.` } : { value: null };
  let value = text;
  if (field.field_type === 'integer' && (!/^-?(0|[1-9]\d{0,17})$/.test(text) || text === '-0')) return { error: `Informe em ${field.name} um número inteiro, sem pontos ou vírgulas.` };
  if (field.field_type === 'decimal') {
    if (!decimalPattern.test(text)) return { error: `Informe em ${field.name} um número com até seis casas decimais, sem separador de milhares.` };
    value = text.replace(',', '.').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); if (value === '-0') value = '0';
  }
  if (field.field_type === 'text' && (text.length > 255 || CONTROL.test(text))) return { error: `Confira o campo ${field.name}: até 255 caracteres, sem quebra de linha.` };
  if (field.field_type === 'long_text' && (text.length > 4000 || LINE_CONTROL.test(text))) return { error: `Confira o campo ${field.name}: até 4000 caracteres.` };
  if (field.field_type === 'boolean' && !['true', 'false'].includes(text)) return { error: `Escolha Sim ou Não em ${field.name}.` };
  if (field.field_type === 'date' && !validDate(text)) return { error: `Informe uma data válida em ${field.name}.` };
  if (field.field_type === 'list' && !field.options.some(option => option.id === text)) return { error: `Escolha uma opção da lista em ${field.name}.` };
  if (field.min_length !== null && value.length < field.min_length) return { error: `${field.name} precisa de pelo menos ${field.min_length} caractere(s).` };
  if (field.max_length !== null && value.length > field.max_length) return { error: `${field.name} aceita até ${field.max_length} caractere(s).` };
  return { value };
}
/** data.custom_values of the product form: every field shown (null clears); fields not shown keep their stored value. */
export function customValuesPayload(fields: readonly CustomField[], values: Readonly<Record<string, string>>): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const field of fields) {
    const result = customValue(field, values[field.id]);
    if ('error' in result) invalidField(`custom-${field.id}`, result.error);
    else payload[field.id] = result.value;
  }
  return payload;
}
/** The stored values of a product record (canonical text by field id). */
export const recordCustomValues = (record: Record<string, unknown> | null | undefined): Record<string, string> => {
  const value = record?.custom_values;
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, text]) => typeof text === 'string')) as Record<string, string> : {};
};

// ---- Exportação "Customizado" / "Ambos" ----
/** The text of a stored value in the sheet: the option of a list, Sim/Não, dd/mm/aaaa and the decimal with a comma. */
export function customDisplay(field: CustomField, value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  if (field.field_type === 'list') return field.options.find(option => option.id === value)?.label ?? '';
  if (field.field_type === 'boolean') return value === 'true' ? 'Sim' : value === 'false' ? 'Não' : '';
  if (field.field_type === 'date') return value.split('-').reverse().join('/');
  if (field.field_type === 'decimal') return value.replace('.', ',');
  return value;
}
export type ExportColumn = [string, (row: Record<string, unknown>) => string, boolean?];
export function customExportColumns(fields: readonly CustomField[]): ExportColumn[] {
  return fields.map(field => [field.name, row => customDisplay(field, (row.custom_values as Record<string, unknown> | null | undefined)?.[field.id]), field.field_type === 'integer' || field.field_type === 'decimal']);
}

// ---- Gaveta "Adicionar campo" / "Editar Campo" ----
export interface CustomFieldDraft {
  field_type: CustomFieldType; name: string; hint: string; info: string; required: boolean; min_length: string; max_length: string; width: CustomFieldWidth;
  grouped: boolean; category_ids: string[]; options: { id: string | null; label: string; key: string }[]; active: boolean;
}
let optionKey = 0;
export const newOptionKey = () => `option-${++optionKey}`;
export function customFieldDraft(field?: CustomField | null): CustomFieldDraft {
  return field ? { field_type: field.field_type, name: field.name, hint: field.hint ?? '', info: field.info ?? '', required: field.required, min_length: field.min_length?.toString() ?? '', max_length: field.max_length?.toString() ?? '',
    width: field.width, grouped: field.grouped, category_ids: [...field.category_ids].sort(), options: field.options.map(option => ({ id: option.id, label: option.label, key: option.id })), active: field.active }
    : { field_type: 'integer', name: '', hint: '', info: '', required: false, min_length: '', max_length: '', width: 'medium', grouped: false, category_ids: [], options: [], active: true };
}
/** The draft checked like the API (message for the first problem) and turned into the request data. */
export function customFieldData(draft: CustomFieldDraft, original?: CustomField | null): { data: Record<string, unknown> } | { error: string; field: string } {
  const name = draft.name.trim(), hint = draft.hint.trim(), info = draft.info.trim();
  if (!name || name.length > 60 || CONTROL.test(name)) return { error: 'Informe o nome do campo com até 60 caracteres.', field: 'name' };
  if (hint.length > 100 || CONTROL.test(hint)) return { error: 'A dica de preenchimento aceita até 100 caracteres, sem quebra de linha.', field: 'hint' };
  if (info.length > 300 || LINE_CONTROL.test(info)) return { error: 'A informação sobre o campo aceita até 300 caracteres.', field: 'info' };
  const cap = CUSTOM_FIELD_SIZE[draft.field_type];
  const size = (text: string) => text.trim() === '' ? null : /^[1-9]\d{0,3}$/.test(text.trim()) ? Number(text.trim()) : NaN;
  const min = cap ? size(draft.min_length) : null, max = cap ? size(draft.max_length) : null;
  if (Number.isNaN(min) || Number.isNaN(max) || (min !== null && min > cap!) || (max !== null && max > cap!)) return { error: `Informe os tamanhos como números inteiros de 1 a ${cap}.`, field: 'min_length' };
  if (min !== null && max !== null && min > max) return { error: 'O tamanho mínimo não pode ser maior que o máximo.', field: 'min_length' };
  const data: Record<string, unknown> = { name, hint: hint || null, info: info || null, required: draft.required, width: draft.width, grouped: draft.grouped,
    category_ids: draft.grouped ? [...draft.category_ids] : [], active: draft.active };
  if (cap) Object.assign(data, { min_length: min, max_length: max });
  if (!original) data.field_type = draft.field_type;
  if (draft.field_type === 'list') {
    const options = draft.options.map(option => ({ ...(option.id ? { id: option.id } : {}), label: option.label.trim() }));
    if (!options.length) return { error: 'Adicione ao menos uma opção à lista.', field: 'options' };
    if (options.length > 50) return { error: 'A lista aceita até 50 opções.', field: 'options' };
    if (options.some(option => !option.label || option.label.length > 60 || CONTROL.test(option.label))) return { error: 'Cada opção precisa de um nome com até 60 caracteres.', field: 'options' };
    if (new Set(options.map(option => fold(option.label))).size !== options.length) return { error: 'Há opções repetidas na lista.', field: 'options' };
    data.options = options;
  }
  if (draft.grouped && draft.category_ids.length > 100) return { error: 'O agrupador aceita até 100 categorias.', field: 'grouped' };
  return { data };
}
/** Whether the drawer has changes (unsaved-change guard). */
export const draftChanged = (draft: CustomFieldDraft, initial: CustomFieldDraft) => JSON.stringify({ ...draft, options: draft.options.map(({ id, label }) => ({ id, label })) })
  !== JSON.stringify({ ...initial, options: initial.options.map(({ id, label }) => ({ id, label })) });
