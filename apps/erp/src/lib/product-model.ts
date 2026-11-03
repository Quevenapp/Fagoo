import { normalizeUnitPrice, UNIT_PRICE_INPUT_LIMIT } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { invalidField, type CatalogField, type CatalogRecord } from './catalog-base.ts';
import { appliedCustomFilter, customFilterApi } from './product-custom-filter-model.ts';

// Produtos: campos do formulário, validações próprias, filtros da listagem, estoque, preço na linha e clonagem.
// catalog-model.ts re-exports everything here, so existing imports keep working.
export type ProductSection = 'basic' | 'characteristics' | 'stock' | 'tax';
export const PRODUCT_SECTIONS: { key: ProductSection; label: string }[] = [
  { key: 'basic', label: 'Dados básicos' }, { key: 'characteristics', label: 'Características' }, { key: 'stock', label: 'Estoque' }, { key: 'tax', label: 'Tributação' },
];
export const PRODUCT_KINDS = [{ value: 'P', label: 'Produto' }, { value: 'S', label: 'Serviço' }, { value: 'N', label: 'Outro tipo cadastral (N)' }];
export const PRODUCT_FORMATS = [{ value: 'S', label: 'Simples' }, { value: 'V', label: 'Com variações' }, { value: 'E', label: 'Com composição' }];
const sixDecimal = (key: string, label: string, section: ProductSection): CatalogField => ({ key, label, max: 19, decimal: 6, section });
export const PRODUCT_FIELDS: CatalogField[] = [
  { key: 'name', label: 'Nome', max: 200, section: 'basic' }, { key: 'code', label: 'Código (SKU)', max: 100, section: 'basic' },
  { key: 'format', label: 'Formato', max: 1, type: 'select', options: PRODUCT_FORMATS, section: 'basic' },
  { key: 'kind', label: 'Tipo', max: 1, type: 'select', options: PRODUCT_KINDS, section: 'basic' },
  { key: 'price', label: 'Preço de venda (R$)', max: UNIT_PRICE_INPUT_LIMIT, decimal: 10, section: 'basic', help: 'Até dez casas decimais, sem arredondar o preço. Deixe vazio se não informado.' }, { key: 'unit', label: 'Unidade', max: 16, section: 'basic' },
  { key: 'condition', label: 'Condição', max: 11, type: 'select', section: 'basic', options: [{ value: 'unspecified', label: 'Não especificado' }, { value: 'new', label: 'Novo' }, { value: 'used', label: 'Usado' }, { value: 'refurbished', label: 'Recondicionado' }] },
  { key: 'brand', label: 'Marca', max: 100, section: 'characteristics' },
  { key: 'production', label: 'Produção', max: 11, type: 'select', section: 'characteristics', options: [{ value: 'own', label: 'Própria' }, { value: 'third_party', label: 'Terceiros' }] },
  sixDecimal('net_weight', 'Peso líquido (kg)', 'characteristics'), sixDecimal('gross_weight', 'Peso bruto (kg)', 'characteristics'),
  sixDecimal('width', 'Largura', 'characteristics'), sixDecimal('height', 'Altura', 'characteristics'), sixDecimal('depth', 'Profundidade', 'characteristics'),
  { key: 'dimension_unit', label: 'Unidade das dimensões', max: 2, section: 'characteristics', type: 'select', options: [{ value: 'm', label: 'Metros' }, { value: 'cm', label: 'Centímetros' }, { value: 'mm', label: 'Milímetros' }] },
  { key: 'volumes', label: 'Volumes', max: 6, integer: true, section: 'characteristics' },
  // Itens p/ caixa (migration 191) left the catalog fields: the form sends the exact decimal as items_per_box_decimal (product
  // detail, product-form-model.ts); the integer catalog column is its mirror on the server.
  { key: 'gtin', label: 'GTIN / EAN', max: 14, section: 'characteristics' }, { key: 'gtin_tax', label: 'GTIN tributário', max: 14, section: 'characteristics' },
  { key: 'description', label: 'Descrição curta (Descrição Principal)', max: 4000, type: 'textarea', section: 'characteristics' },
  sixDecimal('stock_min', 'Estoque mínimo', 'stock'), sixDecimal('stock_max', 'Estoque máximo', 'stock'), { key: 'location', label: 'Localização', max: 100, section: 'stock' },
  { key: 'origin', label: 'Origem da mercadoria', max: 1, section: 'tax', type: 'select', options: [
    { value: '0', label: '0 — Nacional, exceto códigos 3, 4, 5 e 8' }, { value: '1', label: '1 — Estrangeira, importação direta, exceto código 6' },
    { value: '2', label: '2 — Estrangeira, adquirida no mercado interno, exceto código 7' }, { value: '3', label: '3 — Nacional, conteúdo de importação superior a 40% e até 70%' },
    { value: '4', label: '4 — Nacional, produção conforme processos produtivos básicos' }, { value: '5', label: '5 — Nacional, conteúdo de importação até 40%' },
    { value: '6', label: '6 — Estrangeira, importação direta, lista CAMEX sem similar nacional e gás natural' }, { value: '7', label: '7 — Estrangeira, mercado interno, lista CAMEX sem similar nacional e gás natural' },
    { value: '8', label: '8 — Nacional, conteúdo de importação superior a 70%' },
  ] },
  { key: 'ncm', label: 'NCM', max: 8, section: 'tax' }, { key: 'cest', label: 'CEST', max: 7, section: 'tax', help: 'Informe somente os sete dígitos, quando aplicável.' },
  { key: 'additional_info', label: 'Informações adicionais', max: 2000, type: 'textarea', section: 'tax' },
];

// ---- Validações próprias de produto (chamadas por catalogData depois das regras comuns de cada campo) ----
/** CEST, NCM and GTIN checks of one product field; `changed` keeps legacy values editable while the field is untouched. */
export function checkProductField(key: string, value: string, changed: boolean) {
  if (key === 'cest' && value && !/^\d{7}$/.test(value)) invalidField(key, 'Informe um CEST com sete dígitos ou deixe o campo vazio.');
  if (key === 'ncm' && value && changed && !/^\d{8}$/.test(value)) invalidField(key, 'Informe um NCM com oito dígitos ou deixe o campo vazio.');
  if (['gtin', 'gtin_tax'].includes(key) && value && (key === 'gtin_tax' || changed) && !/^(?:\d{8}|\d{12}|\d{13}|\d{14}|SEM GTIN)$/.test(value)) invalidField(key, 'Informe um GTIN com 8, 12, 13 ou 14 dígitos, SEM GTIN, ou deixe o campo vazio.');
}
function exactDecimal(value: string, scale: number) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}
/** Rules across product fields, after every field was checked. */
export function checkProductData(data: Record<string, string | string[] | null>) {
  if (typeof data.stock_min === 'string' && typeof data.stock_max === 'string'
    && exactDecimal(data.stock_min, 6) > exactDecimal(data.stock_max, 6)) invalidField('stock_max', 'O estoque máximo deve ser maior ou igual ao estoque mínimo.');
}

// ---- Filtros da listagem de produtos (página v2 da migração 120) ----
// kind and format stay for the cursor list of the document pickers (catalogListParams); the page uses the Origin "Tipo".
export const PRODUCT_SITUATIONS = [{ value: 'latest', label: 'Últimos Incluídos' }, { value: 'active', label: 'Ativos' }, { value: 'inactive', label: 'Inativos' }, { value: 'deleted', label: 'Excluídos' }] as const;
export const PRODUCT_TYPE_FILTERS = [{ value: 'composition', label: 'Produtos com composição' }, { value: 'no_composition', label: 'Produtos sem composição' }, { value: 'products', label: 'Produtos' }, { value: 'simple', label: 'Produtos simples' },
  { value: 'with_variations', label: 'Produtos c/ variações' }, { value: 'variations', label: 'Variações' }, { value: 'services', label: 'Serviços' }] as const;
// custom: the "Campos customizados" filter (migration 191) as the JSON text of product-custom-filter-model.ts (category and rows).
// component_id/component_name: the "Componente" of the Tipo "Produtos com composição" (migration 234).
export const EMPTY_PRODUCT_FILTERS = { situation: 'latest', type: '', kind: '', format: '', ncm_presence: '', ncm: '', brand: '', stock: '', warehouse_id: '', images: '', tag: '', category: '', item_type: '', supplier_id: '', supplier_name: '', supplier_code: '', custom: '',
  component_id: '', component_name: '' };
export type ProductFilters = typeof EMPTY_PRODUCT_FILTERS;
/** "Filtrar": texts are trimmed, Número NCM only applies with "Com NCM", Depósito only with Estoque and Componente only with "Produtos com composição". */
export const appliedProductFilters = (draft: ProductFilters): ProductFilters => ({ ...draft, brand: draft.brand.trim(), supplier_code: draft.supplier_code.trim(), ncm: draft.ncm_presence === 'present' ? draft.ncm.trim() : '', warehouse_id: draft.stock ? draft.warehouse_id : '',
  custom: appliedCustomFilter(draft.custom), ...(draft.type === 'composition' && draft.component_id ? {} : { component_id: '', component_name: '' }) });
/** Removing a chip also clears the filter that only exists with it (Depósito with Estoque, Número NCM with NCM, Componente with the Tipo, the names). */
export const clearedProductFilter = (key: keyof ProductFilters): Partial<ProductFilters> => key === 'stock' ? { stock: '', warehouse_id: '' } : key === 'ncm_presence' ? { ncm_presence: '', ncm: '' }
  : key === 'supplier_id' ? { supplier_id: '', supplier_name: '' } : key === 'situation' ? { situation: 'latest' } : key === 'type' ? { type: '', component_id: '', component_name: '' }
  : key === 'component_id' ? { component_id: '', component_name: '' } : { [key]: '' };
// "Tornar padrão" (per-user list store, migration 116): the applied Situação (other than Últimos Incluídos), Pesquisa and Origin
// filters. Estoque and Depósito stay out: they depend on the stock permission at the time the list opens.
const SAVED_FILTER_KEYS = ['type', 'ncm_presence', 'ncm', 'brand', 'images', 'tag', 'category', 'item_type', 'supplier_id', 'supplier_name', 'supplier_code', 'component_id', 'component_name'] as const;
const SAVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function productSavedFilters(filters: ProductFilters, query: string): Record<string, string> {
  const saved: Record<string, string> = {};
  if (filters.situation && filters.situation !== 'latest') saved.situation = filters.situation;
  if (query.trim()) saved.q = query.trim();
  for (const key of SAVED_FILTER_KEYS) if (filters[key]) saved[key] = filters[key];
  return saved;
}
/** Saved filters back to the list. A value the list would refuse is left out, so an old default never breaks the list. */
export function productFiltersFromSaved(saved: Record<string, unknown>): { filters: ProductFilters; query: string } {
  const text = (key: string, max: number, test?: RegExp) => { const value = saved[key]; return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) && (!test || test.test(value)) ? value.trim() : ''; };
  const choice = (key: string, options: readonly { value: string }[]) => options.some(option => option.value === saved[key]) ? saved[key] as string : '';
  const reference = (key: string) => { const value = text(key, 36); return value === 'none' || SAVED_ID.test(value) ? value.toLowerCase() : ''; };
  const presence = choice('ncm_presence', [{ value: 'present' }, { value: 'missing' }]), supplier = text('supplier_id', 36, SAVED_ID).toLowerCase(), type = choice('type', PRODUCT_TYPE_FILTERS);
  const component = type === 'composition' ? text('component_id', 36, SAVED_ID).toLowerCase() : '';
  const filters: ProductFilters = { ...EMPTY_PRODUCT_FILTERS, situation: choice('situation', PRODUCT_SITUATIONS) || 'latest', type, ncm_presence: presence,
    ncm: presence === 'present' ? text('ncm', 8, /^\d{2,8}$/) : '', brand: text('brand', 100), images: choice('images', [{ value: 'yes' }, { value: 'no' }]), tag: reference('tag'),
    category: reference('category'), item_type: text('item_type', 2, /^(?:0\d|10|99)$/), supplier_id: supplier, supplier_name: supplier ? text('supplier_name', 200) || 'fornecedor selecionado' : '',
    supplier_code: text('supplier_code', 60), component_id: component, component_name: component ? text('component_name', 200) || 'componente selecionado' : '' };
  return { filters, query: text('q', 120) };
}
const PAGE_KEYS = ['type', 'ncm_presence', 'ncm', 'brand', 'stock', 'warehouse_id', 'images', 'tag', 'category', 'item_type', 'supplier_id', 'supplier_code', 'component_id'] as const;
/** v2 page: Situação replaces the shared "active" of the other cadastros. */
export function productPageParams(params: URLSearchParams, filters: ProductFilters) {
  params.delete('active'); params.set('situation', filters.situation || 'latest');
  for (const key of PAGE_KEYS) if (filters[key].trim()) params.set(key, filters[key].trim());
  const custom = customFilterApi(filters.custom);
  if (custom) params.set('custom', JSON.stringify(custom));
}

// ---- Estoque na listagem ----
export type StockState = 'recorded' | 'no_movements' | 'review_required';
export interface CatalogStock { state: StockState; quantity: string | null; warehouse: { id: string; state: StockState; quantity: string | null } | null }
export const STOCK_FILTERS = [{ value: 'zero', label: 'Igual à zero' }, { value: 'negative', label: 'Menor que zero' }, { value: 'positive', label: 'Maior que zero' }, { value: 'no_movements', label: 'Sem lançamentos' }] as const;
const stockQuantity = (value: string) => {
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const decimals = fraction.replace(/0+$/, '');
  return `${negative ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${decimals ? `,${decimals}` : ''}`;
};
/** Estoque column: a recorded zero is "0"; no position is "Sem lançamentos"; a projection under review shows no quantity. */
export function stockCell(stock: CatalogStock | null | undefined, byWarehouse: boolean): { text: string; state: StockState | null } {
  const value = byWarehouse ? stock?.warehouse : stock;
  if (!value) return { text: '—', state: null };
  if (value.state === 'recorded' && value.quantity !== null && /^-?\d+\.\d+$/.test(value.quantity)) return { text: stockQuantity(value.quantity), state: 'recorded' };
  return { text: value.state === 'no_movements' ? 'Sem lançamentos' : 'Conferência necessária', state: value.state === 'no_movements' ? 'no_movements' : 'review_required' };
}

// ---- Preço na linha (lápis verde) ----
/** "12.5000" → "12,50", "1.2345678900" → "1,23456789": the input starts with the exact stored value. */
export function priceInputValue(price: unknown) {
  if (typeof price !== 'string' || !/^\d+(?:\.\d+)?$/.test(price)) return '';
  const [whole, fraction = ''] = price.split('.');
  return `${whole},${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}
export function inlinePrice(value: string) {
  const text = value.trim().replace(',', '.');
  if (!text) invalidField('price', 'Informe o preço de venda.');
  try { return normalizeUnitPrice(text, 14); }
  catch { return invalidField('price', 'Informe um preço não negativo, sem separador de milhares, com até dez casas decimais.'); }
}

// ---- Clonar produto (formulário curto de 096); o formulário completo usa cloneProductForm de product-form-model.ts ----
export const CLONE_CLEARED_FIELDS = ['code', 'gtin', 'gtin_tax'] as const;
export function cloneProductValues(record: CatalogRecord): Record<string, string> {
  return Object.fromEntries(PRODUCT_FIELDS.map(field => [field.key, (CLONE_CLEARED_FIELDS as readonly string[]).includes(field.key) || typeof record[field.key] !== 'string' ? '' : record[field.key] as string]));
}
