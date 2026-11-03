import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { COMMON_FIELDS, invalidField, type CatalogEntity, type CatalogField, type CatalogRecord } from './catalog-base.ts';
import { CONTACT_FIELDS, contactFieldValue, contactPageParams, type ContactFilters, type ContactRoleFilter } from './contact-model.ts';
import type { ProductOriginStock, ProductOriginStockPage } from './product-origin-stock-model.ts';
import { EMPTY_PRODUCT_FILTERS, PRODUCT_FIELDS, checkProductData, checkProductField, productPageParams, type CatalogStock, type ProductFilters } from './product-model.ts';

// Shared catalog contract (fields of every entity, save payload, listing page, order and warnings).
// The entity rules live in product-model.ts and contact-model.ts and are re-exported here.
export { CATALOG_LABELS, CatalogValidationError, type CatalogAccess, type CatalogEntity, type CatalogEnvelope, type CatalogField, type CatalogPage, type CatalogRecord } from './catalog-base.ts';
export * from './product-model.ts';
export * from './contact-model.ts';

export const CATALOG_FIELDS: Record<CatalogEntity, CatalogField[]> = {
  contacts: CONTACT_FIELDS,
  products: PRODUCT_FIELDS,
  warehouses: [...COMMON_FIELDS, { key: 'description', label: 'Descrição', max: 1000, type: 'textarea' }],
};
export function catalogData(entity: CatalogEntity, values: Record<string, string>, roles: string[], record?: CatalogRecord | null) {
  const data: Record<string, string | string[] | null> = {};
  for (const field of CATALOG_FIELDS[entity]) {
    let value = (values[field.key] || '').trim();
    if (field.decimal) value = value.replace(',', '.');
    if (entity === 'contacts') value = contactFieldValue(field.key, value);
    if (field.key === 'name' && !value) invalidField(field.key, 'Informe o nome do cadastro.');
    if (value.length > field.max) invalidField(field.key, `Confira o campo ${field.label}.`);
    if (field.decimal === 10 && value) {
      try { value = normalizeUnitPrice(value, 14); }
      catch { invalidField(field.key, 'Informe um preço não negativo, sem separador de milhares, com até dez casas decimais e no máximo quatorze dígitos inteiros.'); }
    } else if (field.decimal && value && !/^(0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) {
      invalidField(field.key, `Informe ${field.label.toLowerCase()} sem separador de milhares, com até seis casas decimais e no máximo doze dígitos inteiros.`);
    }
    if (field.integer && value && !/^(0|[1-9]\d{0,5})$/.test(value)) invalidField(field.key, `Informe ${field.label.toLowerCase()} como um número inteiro entre 0 e 999999.`);
    if (field.options && value && !field.options.some(option => option.value === value)) invalidField(field.key, `Confira o campo ${field.label}.`);
    const changed = value !== (typeof record?.[field.key] === 'string' ? record[field.key] : '');
    if (entity === 'products') checkProductField(field.key, value, changed);
    data[field.key] = value || null;
  }
  if (entity === 'products') checkProductData(data);
  if (entity === 'contacts') data.roles = [...roles];
  return data;
}

export function catalogListParams(entity: CatalogEntity, query: string, active: string, after: string | null, products = EMPTY_PRODUCT_FILTERS) {
  const params = new URLSearchParams({ limit: '25' });
  if (query.trim()) params.set('q', query.trim()); if (active) params.set('active', active); if (after) params.set('after', after);
  if (entity === 'products') for (const key of ['kind', 'format', 'ncm_presence', 'brand'] as const) if (products[key].trim()) params.set(key, products[key].trim());
  return params;
}

// ---- Listagem no padrão do Origin (migração 096): páginas numeradas de 100, total, ordenação e filtros ----
export const CATALOG_PAGE_SIZE = 100;
export type CatalogSort = 'created_desc' | 'name_asc' | 'name_desc' | 'code_asc' | 'code_desc';
// 202610220008: origin_stock is the balance observed in Origin, beside the native stock and never added to it.
export interface CatalogListItem extends CatalogRecord { stock?: CatalogStock | null; origin_stock?: ProductOriginStock | null }
export interface CatalogListPage { entity: CatalogEntity; items: CatalogListItem[]; page: number; size: number; total: number; sort: CatalogSort; stock_visible?: boolean; origin_stock?: ProductOriginStockPage | null; data_mode: 'erp_native' }
export type CatalogPeriodField = 'created' | 'updated' | 'expiry';
export interface CatalogPeriod { field: CatalogPeriodField; from: string; to: string }
export const EMPTY_PERIOD: CatalogPeriod = { field: 'created', from: '', to: '' };
export const PERIOD_FIELDS: readonly { value: CatalogPeriodField; label: string }[] = [{ value: 'created', label: 'Data de inclusão' }, { value: 'updated', label: 'Data de alteração' }];
/** Produtos (Origin): "Alterado em" and "Data de validade"; the order of inclusion is the Situação "Últimos Incluídos". */
export const PRODUCT_PERIOD_FIELDS: readonly { value: CatalogPeriodField; label: string }[] = [{ value: 'updated', label: 'Alterado em' }, { value: 'expiry', label: 'Data de validade' }];
export interface CatalogListState { page: number; sort: CatalogSort; query: string; active: string; role: ContactRoleFilter; contact: ContactFilters; product: ProductFilters; period: CatalogPeriod }

export function catalogPageParams(entity: CatalogEntity, state: CatalogListState) {
  const params = new URLSearchParams({ page: String(state.page), size: String(CATALOG_PAGE_SIZE) });
  if (state.sort !== 'created_desc') params.set('sort', state.sort);
  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.active) params.set('active', state.active);
  if (entity === 'contacts') contactPageParams(params, state.role, state.contact);
  if (entity === 'products') productPageParams(params, state.product);
  if (state.period.from || state.period.to) {
    params.set('period', state.period.field);
    if (state.period.from) params.set('from', state.period.from);
    if (state.period.to) params.set('to', state.period.to);
  }
  return params;
}
/** Clicking a column header: ascending first, then descending; other columns start ascending again. */
export function nextSort(current: CatalogSort, column: 'name' | 'code'): CatalogSort { return current === `${column}_asc` ? `${column}_desc` : `${column}_asc`; }
export function ariaSort(current: CatalogSort, column: 'name' | 'code') { return current === `${column}_asc` ? 'ascending' as const : current === `${column}_desc` ? 'descending' as const : undefined; }
export function sortLabel(entity: CatalogEntity, sort: CatalogSort) {
  if (sort === 'created_desc') return 'Exibindo pela ordem de inclusão';
  const column = sort.startsWith('name') ? entity === 'products' ? 'descrição' : 'nome' : 'código';
  return `Exibindo pela ordem de ${column} (${sort.endsWith('asc') ? 'A-Z' : 'Z-A'})`;
}

// ---- Avisos antes de salvar (calculados no servidor; o usuário confirma explicitamente) ----
export type CatalogWarningCode = 'duplicate_code' | 'duplicate_gtin' | 'invalid_document' | 'duplicate_document';
export interface CatalogWarningMatch { id: string; name: string; code: string | null; active: boolean }
export interface CatalogWarning { code: CatalogWarningCode; field: string; total?: number; expected?: 'cpf' | 'cnpj' | 'document'; matches?: CatalogWarningMatch[] }
const WARNING_CODES: readonly CatalogWarningCode[] = ['duplicate_code', 'duplicate_gtin', 'invalid_document', 'duplicate_document'];
export function catalogWarnings(value: unknown): CatalogWarning[] {
  const warnings = (value as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(warnings) || warnings.length > 4 || warnings.some(item => !item || typeof item !== 'object' || !WARNING_CODES.includes((item as CatalogWarning).code)
    || ((item as CatalogWarning).matches !== undefined && !Array.isArray((item as CatalogWarning).matches)))) throw new Error('Invalid warnings');
  return warnings as CatalogWarning[];
}
/** Only new or changed code/GTIN (products) or CPF/CNPJ/tipo da pessoa (contacts) can produce a warning, as in SQL. */
export function needsWarningCheck(entity: CatalogEntity, data: Record<string, unknown>, record?: CatalogRecord | null) {
  const before = (key: string) => typeof record?.[key] === 'string' ? record[key] : null;
  if (entity === 'products') return (typeof data.code === 'string' && data.code !== before('code')) || (typeof data.gtin === 'string' && data.gtin !== 'SEM GTIN' && data.gtin !== before('gtin'));
  if (entity === 'contacts') return typeof data.document === 'string' && (data.document !== before('document') || (data.person_type ?? null) !== before('person_type'));
  return false;
}
const others = (warning: CatalogWarning, noun: [string, string]) => {
  const total = warning.total ?? warning.matches?.length ?? 0, shown = (warning.matches ?? []).slice(0, 3).map(match => `${match.name}${match.code ? ` (${match.code})` : ''}${match.active ? '' : ' — inativo'}`);
  return `${total === 1 ? `1 outro ${noun[0]}` : `${total} outros ${noun[1]}`}: ${shown.join('; ')}${total > shown.length ? '…' : ''}`;
};
export function warningText(warning: CatalogWarning) {
  if (warning.code === 'duplicate_code') return `O código (SKU) informado já está em ${others(warning, ['produto', 'produtos'])}.`;
  if (warning.code === 'duplicate_gtin') return `O GTIN/EAN informado já está em ${others(warning, ['produto', 'produtos'])}.`;
  if (warning.code === 'duplicate_document') return `Este CPF/CNPJ já está em ${others(warning, ['contato', 'contatos'])}.`;
  return warning.expected === 'cpf' ? 'O CPF informado não confere com os dígitos verificadores.'
    : warning.expected === 'cnpj' ? 'O CNPJ informado não confere com os dígitos verificadores.'
      : 'O documento não tem formato de CPF nem de CNPJ. Para estrangeiro, selecione “Estrangeiro” em Tipo da Pessoa.';
}
