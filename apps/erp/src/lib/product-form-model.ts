import { normalizeUnitPrice } from '../../../../packages/erp-domain/src/unit-price.mjs';
import { PRODUCT_ITEM_TYPES, ProductDetailError, checkProductDetail } from '../../../../packages/erp-domain/src/product-detail.mjs';
import { CatalogValidationError, invalidField, type CatalogRecord } from './catalog-base.ts';
import { numberCell, textCell, type SheetCell } from './spreadsheet-export.ts';
import { PRODUCT_FIELDS } from './product-model.ts';
import { ORIGIN_EXPORT_COLUMNS } from './product-origin-stock-model.ts';

// Formulário completo do produto no padrão do Origin (migração 202610200119): o detalhe (Características, Imagens externas,
// Estoque, Fornecedores e Tributação), as listas gravadas com o produto e as taxonomias (categorias, grupos e tags).
export type TaxonomyKind = 'categories' | 'product_groups' | 'tag_groups' | 'tags';
export const TAXONOMY_SLUG: Record<TaxonomyKind, string> = { categories: 'categorias-produtos', product_groups: 'grupos-produtos', tag_groups: 'grupos-tags', tags: 'tags' };
// Tags e grupos de tags têm o Tipo do Origin (migração 153): Produtos | Contatos, e Notas fiscais (migração 236, os Marcadores
// das notas). Categorias e grupos de produtos não têm tipo.
export type TagType = 'products' | 'contacts' | 'invoices';
export const TAG_TYPE_LABELS: Record<TagType, string> = { products: 'Produtos', contacts: 'Contatos', invoices: 'Notas fiscais' };
export interface TaxonomyItem { id: string; kind: TaxonomyKind; parent_id: string | null; name: string; version: number; created_at: string; updated_at: string; children: number; products: number; tag_type?: TagType | null; contacts?: number; invoices?: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tags or tag groups of one Tipo; an answer without the type (API before 153) has only Produtos tags. */
export const ofTagType = (items: readonly TaxonomyItem[], type: TagType) => items.filter(item => (item.tag_type ?? 'products') === type);
/** A taxonomy list answered by the API, checked again on the screen. */
export function taxonomyItems(value: unknown, kind: TaxonomyKind): TaxonomyItem[] {
  const page = value as { kind?: unknown; items?: unknown } | null;
  if (!page || page.kind !== kind || !Array.isArray(page.items) || page.items.some(item => !item || typeof item !== 'object' || !UUID.test((item as TaxonomyItem).id) || typeof (item as TaxonomyItem).name !== 'string'
    || (item as TaxonomyItem).kind !== kind || !Number.isInteger((item as TaxonomyItem).version))) throw new Error('Invalid taxonomy');
  return page.items as TaxonomyItem[];
}
/** Tree order (parent, then its children by name) with the depth of each node, as the Origin category list shows it. */
export function taxonomyTree(items: readonly TaxonomyItem[]): { item: TaxonomyItem; depth: number }[] {
  const children = new Map<string | null, TaxonomyItem[]>();
  for (const item of items) { const key = items.some(other => other.id === item.parent_id) ? item.parent_id : null; children.set(key, [...(children.get(key) ?? []), item]); }
  const result: { item: TaxonomyItem; depth: number }[] = [], seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const item of [...(children.get(parent) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
      if (seen.has(item.id)) continue; seen.add(item.id); result.push({ item, depth }); walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}
/** "Pai › Filho" for selects and chips. */
export function taxonomyPath(items: readonly TaxonomyItem[], id: string | null) {
  const names: string[] = []; let current = items.find(item => item.id === id), guard = 0;
  while (current && guard++ < 50) { names.unshift(current.name); const parent = current.parent_id; current = items.find(item => item.id === parent); }
  return names.join(' › ');
}
export const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---- Campos do detalhe ----
export type ProductTab = 'characteristics' | 'images' | 'stock' | 'suppliers' | 'tax';
export const PRODUCT_TABS: { key: ProductTab; label: string }[] = [
  { key: 'characteristics', label: 'Características' }, { key: 'images', label: 'Imagens' }, { key: 'stock', label: 'Estoque' }, { key: 'suppliers', label: 'Fornecedores' }, { key: 'tax', label: 'Tributação' },
];
export const ITEM_TYPE_OPTIONS = PRODUCT_ITEM_TYPES.map(([value, label]) => ({ value, label: `${value} ${label}` }));
export const FCI_ORIGINS = ['3', '5', '8'];
type DetailKind = 'text' | 'textarea' | 'date' | 'select' | 'decimal' | 'integer';
export interface DetailField { key: string; label: string; kind: DetailKind; max?: number; scale?: number; options?: { value: string; label: string }[]; tab: ProductTab; group?: string; info?: string; placeholder?: string }
const money = (key: string, label: string, group: string): DetailField => ({ key, label, kind: 'decimal', scale: 2, max: 17, tab: 'tax', group });
const fixed = (key: string, label: string, group: string): DetailField => ({ key, label, kind: 'decimal', scale: 4, max: 17, tab: 'tax', group });
const percent = (key: string, label: string, group: string): DetailField => ({ key, label, kind: 'decimal', scale: 4, max: 8, tab: 'tax', group });
export const DETAIL_FIELDS: DetailField[] = [
  { key: 'expiry_date', label: 'Data de validade', kind: 'date', tab: 'characteristics', info: 'Data limite para o consumo do ponto de vista sanitário.' },
  { key: 'free_shipping', label: 'Frete Grátis', kind: 'select', tab: 'characteristics', options: [{ value: 'false', label: 'Não' }, { value: 'true', label: 'Sim' }] },
  { key: 'discreet_description', label: 'Descrição discreta do produto', kind: 'text', max: 120, tab: 'characteristics', info: 'Descrição usada na declaração de conteúdo.' },
  { key: 'complementary_description', label: 'Descrição complementar', kind: 'textarea', max: 4000, tab: 'characteristics', info: 'Campo exibido em propostas comerciais, pedidos de venda e pedidos de compra.' },
  { key: 'external_link', label: 'Link Externo', kind: 'text', max: 120, tab: 'characteristics', placeholder: 'https://' },
  { key: 'video_url', label: 'Vídeo', kind: 'text', max: 100, tab: 'characteristics', placeholder: 'https://' },
  { key: 'notes', label: 'Observações', kind: 'textarea', max: 2000, tab: 'characteristics' },
  { key: 'crossdocking_days', label: 'Crossdocking', kind: 'integer', max: 4, tab: 'stock', info: 'Dias para preparar o produto antes do envio.' },
  { key: 'fci_number', label: 'Número FCI', kind: 'text', max: 36, tab: 'tax', info: 'Ficha de Conteúdo de Importação, para as origens 3, 5 e 8.' },
  { key: 'item_type', label: 'Tipo do item', kind: 'select', tab: 'tax', options: ITEM_TYPE_OPTIONS },
  { key: 'tax_percent', label: '% Tributos', kind: 'decimal', scale: 4, max: 8, tab: 'tax', info: 'Percentual aproximado dos tributos do produto.' },
  money('icms_st_retention_base', 'Valor base ICMS ST - retenção', 'ICMS'), money('icms_st_retention_value', 'Valor ICMS ST para retenção', 'ICMS'),
  money('icms_own_substitute_value', 'Valor ICMS próprio do substituto', 'ICMS'),
  { key: 'ipi_tipi_exception', label: 'Código exceção da TIPI', kind: 'text', max: 3, tab: 'tax', group: 'IPI' },
  { key: 'ipi_framework_class', label: 'Classe de enquadramento', kind: 'text', max: 3, tab: 'tax', group: 'IPI', info: 'Código de enquadramento legal do IPI, com três dígitos.' },
  fixed('ipi_fixed_value', 'Valor IPI fixo', 'IPI'), { key: 'ipi_seal_code', label: 'Código do selo do IPI', kind: 'text', max: 60, tab: 'tax', group: 'IPI' },
  fixed('pis_fixed_value', 'Valor PIS fixo', 'PIS / COFINS'), fixed('cofins_fixed_value', 'Valor COFINS fixo', 'PIS / COFINS'),
  { key: 'anp_code', label: 'Código ANP', kind: 'text', max: 9, tab: 'tax', group: 'Combustível' }, { key: 'anp_description', label: 'Descrição conforme ANP (SIMP)', kind: 'text', max: 95, tab: 'tax', group: 'Combustível' },
  percent('glp_percent', '% GLP derivado do petróleo', 'GLP'), percent('glgnn_percent', '% GLGNn', 'GLP'), percent('glgni_percent', '% GLGNi', 'GLP'), money('starting_value', 'Valor de partida', 'GLP'),
];
const DETAIL_TEXT: Record<string, string> = {
  expiry_date: 'Informe uma data de validade válida.', free_shipping: 'Escolha Sim ou Não em Frete Grátis.', external_link: 'Informe um endereço que comece com http:// ou https://.',
  video_url: 'Informe um endereço que comece com http:// ou https://.', crossdocking_days: 'Informe o crossdocking em dias, de 0 a 9999.', fci_number: 'Informe o número FCI no formato XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX.',
  ipi_tipi_exception: 'Informe o código de exceção da TIPI com até três dígitos.', ipi_framework_class: 'Informe a classe de enquadramento com três dígitos.',
  ipi_seal_code: 'Informe o código do selo do IPI só com letras, números, ponto, barra ou hífen.', anp_code: 'Informe o código ANP com nove dígitos.',
};
const decimalText = (field: DetailField) => `Informe ${field.label.replace(/^%/, 'o percentual de').toLowerCase()} com até ${field.scale} casas decimais${field.key.endsWith('percent') ? ', de 0 a 100' : ''}, sem separador de milhares.`;
export const DETAIL_SCALARS = DETAIL_FIELDS.map(field => field.key);

// ---- Listas ----
export interface ProductSupplier { supplier_id: string; supplier_name: string; supplier_code: string | null; description: string; code: string; purchase_price: string; cost_price: string; warranty_months: string; is_default: boolean }
export interface ProductDun { code: string; quantity: string }
// custom_values: the Campos customizados of the form (migration 156), the stored text or what was typed, by field id.
export interface ProductLists { suppliers: ProductSupplier[]; dun_codes: ProductDun[]; tag_ids: string[]; images: string[]; custom_values: Record<string, string> }
export const EMPTY_LISTS: ProductLists = { suppliers: [], dun_codes: [], tag_ids: [], images: [], custom_values: {} };
const LISTS_KEY = '__lists';
/** "1.2000000000" → "1,2"; the form shows the exact stored value with a comma. */
export const decimalInput = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace('.', ',') : '';
export function productLists(record: CatalogRecord | null, initialValues?: Record<string, string>): ProductLists {
  if (initialValues?.[LISTS_KEY]) { try { return { ...EMPTY_LISTS, ...JSON.parse(initialValues[LISTS_KEY]) as ProductLists }; } catch { return EMPTY_LISTS; } }
  if (!record) return EMPTY_LISTS;
  const suppliers = Array.isArray(record.suppliers) ? record.suppliers as Record<string, unknown>[] : [];
  return {
    suppliers: suppliers.map(item => ({ supplier_id: String(item.supplier_id), supplier_name: typeof item.supplier_name === 'string' ? item.supplier_name : 'Fornecedor', supplier_code: typeof item.supplier_code === 'string' ? item.supplier_code : null,
      description: typeof item.description === 'string' ? item.description : '', code: typeof item.code === 'string' ? item.code : '', purchase_price: decimalInput(item.purchase_price), cost_price: decimalInput(item.cost_price),
      warranty_months: typeof item.warranty_months === 'string' ? item.warranty_months : '', is_default: item.is_default === true })),
    dun_codes: Array.isArray(record.dun_codes) ? (record.dun_codes as ProductDun[]).map(item => ({ code: item.code, quantity: decimalInput(item.quantity) })) : [],
    tag_ids: Array.isArray(record.tag_ids) ? [...record.tag_ids as string[]] : [],
    images: Array.isArray(record.images) ? (record.images as { url: string }[]).map(item => item.url) : [],
    custom_values: record.custom_values && typeof record.custom_values === 'object' && !Array.isArray(record.custom_values)
      ? Object.fromEntries(Object.entries(record.custom_values as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
  };
}
/** Form values: catalog fields, detail fields (strings) and the "Ativado" switch. New products start as Origin does. */
// Origin shows the weights with the decimals of Preferências > Empresa > Geral ("Número de casas decimais no peso do produto", 3 by
// default) and the measures with 2; a stored value with more decimals is shown whole (nothing is rounded or lost).
export const WEIGHT_KEYS = ['net_weight', 'gross_weight'], MEASURE_KEYS = ['width', 'height', 'depth'];
export function displayDecimal(value: string, minimum: number) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return value;
  const [whole, fraction = ''] = value.split('.'), trimmed = fraction.replace(/0+$/, '');
  const digits = trimmed.length >= minimum ? trimmed : trimmed.padEnd(minimum, '0');
  return digits ? `${whole},${digits}` : whole;
}
/** A changed weight keeps at most the decimals of the preference (Preferências > Empresa > Geral). */
export function checkWeights(values: Record<string, string>, initial: Record<string, string>, decimals: number) {
  for (const key of WEIGHT_KEYS) {
    const value = (values[key] ?? '').trim();
    if (!value || value === (initial[key] ?? '').trim()) continue;
    const fraction = value.replace(',', '.').split('.')[1] ?? '';
    if (fraction.replace(/0+$/, '').length > decimals) invalidField(key, `Informe o peso com até ${decimals} casa(s) decimal(is) (Preferências > Empresa > Geral).`);
  }
}
export function productFormValues(record: CatalogRecord | null, initialValues: Record<string, string> | undefined, defaults: { origin?: string; weightDecimals?: number } = {}): Record<string, string> {
  if (initialValues) { const values = { ...initialValues }; delete values[LISTS_KEY]; return { active: 'true', ...values }; }
  const values: Record<string, string> = {};
  for (const field of PRODUCT_FIELDS) values[field.key] = typeof record?.[field.key] === 'string' ? record[field.key] as string : '';
  for (const key of WEIGHT_KEYS) if (values[key]) values[key] = displayDecimal(values[key], defaults.weightDecimals ?? 3);
  for (const key of MEASURE_KEYS) if (values[key]) values[key] = displayDecimal(values[key], 2);
  // Itens p/ caixa: the exact decimal of the detail (migration 191); before it, the integer catalog column.
  values.items_per_box = typeof record?.items_per_box_decimal === 'string' ? decimalInput(record.items_per_box_decimal) : typeof record?.items_per_box === 'string' ? record.items_per_box : '';
  for (const field of DETAIL_FIELDS) {
    const value = record?.[field.key];
    values[field.key] = typeof value === 'boolean' ? String(value) : field.kind === 'decimal' ? decimalInput(value) : typeof value === 'string' ? value : '';
  }
  values.category_id = typeof record?.category_id === 'string' ? record.category_id : '';
  // Estoque > Controle de lote (migration 191): stored switch of the product.
  values.lot_control = record?.lot_control === true ? 'true' : 'false';
  values.product_group_id = typeof record?.product_group_id === 'string' ? record.product_group_id : '';
  values.active = record ? String(record.active) : 'true';
  if (!record) Object.assign(values, { condition: 'unspecified', dimension_unit: 'cm', kind: 'P', format: 'S', origin: defaults.origin ?? '' });
  return values;
}
/** Clonar produto: everything but the identifiers (código, GTIN/EAN, GTIN tributário e DUN); nothing is saved until "Salvar produto". */
export function cloneProductForm(record: CatalogRecord): Record<string, string> {
  const values = productFormValues(record, undefined);
  for (const key of ['code', 'gtin', 'gtin_tax']) values[key] = '';
  values.active = 'true';
  return { ...values, [LISTS_KEY]: JSON.stringify({ ...productLists(record), dun_codes: [] }) };
}

const detailError = (field: string, message: string): never => invalidField(field, message);
const check = (key: string, value: unknown, message: string) => {
  try { checkProductDetail(key, value); } catch (error) { if (error instanceof ProductDetailError) detailError(key, message); throw error; }
};
const unitPrice = (field: string, value: string, label: string) => {
  const text = value.trim().replace(',', '.');
  if (!text) return null;
  try { return normalizeUnitPrice(text, 14); } catch { return detailError(field, `Informe ${label} não negativo, sem separador de milhares, com até dez casas decimais.`); }
};
/** Detail payload of the form: every detail field and list, checked with the same rules as the API and the database. */
export function productDetailPayload(values: Record<string, string>, lists: ProductLists): Record<string, unknown> {
  const data: Record<string, unknown> = { active: values.active !== 'false' };
  for (const field of DETAIL_FIELDS) {
    let value: string | boolean | null = (values[field.key] ?? '').trim();
    if (field.kind === 'decimal') value = value.replace(',', '.');
    if (field.key === 'free_shipping') value = value === '' ? null : value === 'true';
    else if (field.key === 'fci_number') value = value.toUpperCase();
    if (value === '') value = null;
    check(field.key, value, DETAIL_TEXT[field.key] ?? (field.kind === 'decimal' ? decimalText(field) : `Confira o campo ${field.label}.`));
    data[field.key] = value;
  }
  data.category_id = values.category_id || null; data.product_group_id = values.product_group_id || null;
  // Itens p/ caixa (migration 191): exact decimal, 0 to 999999 with up to six places.
  const box = (values.items_per_box ?? '').trim().replace(',', '.');
  if (box && !/^(0|[1-9]\d{0,5})(?:\.\d{1,6})?$/.test(box)) detailError('items_per_box', 'Informe os itens por caixa de 0 a 999999, com até seis casas decimais e sem separador de milhares.');
  data.items_per_box_decimal = box || null;
  data.lot_control = values.lot_control === 'true';
  data.dun_codes = lists.dun_codes.map((item, index) => {
    const code = item.code.trim(), quantity = item.quantity.trim().replace(',', '.');
    if (!/^\d{14}$/.test(code)) detailError('dun_codes', `Informe o código DUN da linha ${index + 1} com 14 dígitos.`);
    if (!/^(0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(quantity) || /^0(?:\.0*)?$/.test(quantity)) detailError('dun_codes', `Informe a quantidade do DUN da linha ${index + 1}, maior que zero, com até seis casas decimais.`);
    return { code, quantity };
  });
  if (new Set(lists.dun_codes.map(item => item.code.trim())).size !== lists.dun_codes.length) detailError('dun_codes', 'Há códigos DUN repetidos.');
  data.suppliers = lists.suppliers.map(item => ({ supplier_id: item.supplier_id, description: item.description.trim() || null, code: item.code.trim() || null,
    purchase_price: unitPrice('suppliers', item.purchase_price, 'o preço de compra'), cost_price: unitPrice('suppliers', item.cost_price, 'o preço de custo'),
    warranty_months: item.warranty_months.trim() || null, is_default: item.is_default }));
  check('suppliers', data.suppliers, 'Confira os fornecedores do produto: cada fornecedor aparece uma vez e só um é o padrão.');
  data.tag_ids = [...lists.tag_ids];
  data.images = lists.images.map(url => ({ url: url.trim() }));
  check('images', data.images, 'Cada imagem externa precisa de um endereço HTTPS público, sem espaços e sem repetir.');
  return data;
}
export { CatalogValidationError };

// ---- Exportação de produtos (planilha CSV) ----
// 40 rows per read: a row can carry ~12 KB of text (descriptions, notes, image URLs) plus up to 8 KB of custom field values,
// and each API answer is capped at 1 MB.
export const EXPORT_BATCH = 40, EXPORT_FILE_ROWS = 1000;
type ExportRow = Record<string, unknown>;
/** [header, value of a row, exact number in the XLS] — the custom field columns (Customizado / Ambos) bring their own flag. */
export type ExportColumn = [string, (row: ExportRow) => string, boolean?];
const KIND: Record<string, string> = { P: 'Produto', S: 'Serviço', N: 'N' };
const FORMAT: Record<string, string> = { S: 'Simples', V: 'Com variações', E: 'Com composição' };
const CONDITION: Record<string, string> = { unspecified: 'Não Especificado', new: 'Novo', used: 'Usado', refurbished: 'Recondicionado' };
const UNIT: Record<string, string> = { m: 'Metros', cm: 'Centímetros', mm: 'Milímetros' };
const decimalComma = (value: unknown) => typeof value === 'string' ? value.replace('.', ',') : '';
const text = (value: unknown) => typeof value === 'string' ? value : '';
/** Columns of the Brufap export, named like the Origin product sheet. */
export const EXPORT_COLUMNS: ExportColumn[] = [
  ['ID', row => text(row.source_id) || text(row.id)], ['Código', row => text(row.code)], ['Descrição', row => text(row.name)], ['Unidade', row => text(row.unit)],
  ['NCM', row => text(row.ncm)], ['Origem', row => text(row.origin)], ['Preço', row => decimalComma(row.price)], ['Valor IPI fixo', row => decimalComma(row.ipi_fixed_value)],
  ['Observações', row => text(row.notes)], ['Situação', row => row.deleted_at ? 'Excluído' : row.active ? 'Ativo' : 'Inativo'], ['Estoque', row => decimalComma(row.stock)],
  ['Preço de custo', row => decimalComma((row.supplier as ExportRow | null)?.cost_price)], ['Cód no fornecedor', row => text((row.supplier as ExportRow | null)?.code)],
  ['Fornecedor', row => text((row.supplier as ExportRow | null)?.name)], ['Localização', row => text(row.location)], ['Estoque máximo', row => decimalComma(row.stock_max)],
  ['Estoque mínimo', row => decimalComma(row.stock_min)], ['Peso líquido (Kg)', row => decimalComma(row.net_weight)], ['Peso bruto (Kg)', row => decimalComma(row.gross_weight)],
  ['GTIN/EAN', row => text(row.gtin)], ['GTIN/EAN tributário', row => text(row.gtin_tax)], ['Largura do produto', row => decimalComma(row.width)], ['Altura do Produto', row => decimalComma(row.height)],
  ['Profundidade do produto', row => decimalComma(row.depth)], ['Data Validade', row => typeof row.expiry_date === 'string' ? row.expiry_date.split('-').reverse().join('/') : ''],
  ['Descrição do Produto no Fornecedor', row => text((row.supplier as ExportRow | null)?.description)], ['Descrição Complementar', row => text(row.complementary_description)],
  ['Itens p/ caixa', row => typeof row.items_per_box_decimal === 'string' ? decimalInput(row.items_per_box_decimal) : text(row.items_per_box)], ['Tipo Produção', row => row.production === 'own' ? 'Própria' : row.production === 'third_party' ? 'Terceiros' : ''],
  ['Classe de enquadramento do IPI', row => text(row.ipi_framework_class)], ['Tipo do item', row => text(row.item_type)], ['Tags', row => Array.isArray(row.tags) ? row.tags.join(',') : ''],
  ['Tributos', row => decimalComma(row.tax_percent)], ['Grupo de produtos', row => text(row.product_group)], ['Marca', row => text(row.brand)], ['CEST', row => text(row.cest)],
  ['Volumes', row => text(row.volumes)], ['Descrição Curta', row => text(row.description)], ['Cross-Docking', row => text(row.crossdocking_days)],
  ['URL Imagens Externas', row => Array.isArray(row.images) ? row.images.join('|') : ''], ['Link Externo', row => text(row.external_link)],
  ['Meses Garantia no Fornecedor', row => text((row.supplier as ExportRow | null)?.warranty_months)], ['Condição do produto', row => CONDITION[text(row.condition)] ?? ''],
  ['Frete Grátis', row => row.free_shipping === true ? 'Sim' : row.free_shipping === false ? 'Não' : ''], ['Número FCI', row => text(row.fci_number)], ['Vídeo', row => text(row.video_url)],
  ['Unidade de medida', row => UNIT[text(row.dimension_unit)] ?? ''], ['Preço de compra', row => decimalComma((row.supplier as ExportRow | null)?.purchase_price)],
  ['Valor base ICMS ST para retenção', row => decimalComma(row.icms_st_retention_base)], ['Valor ICMS ST para retenção', row => decimalComma(row.icms_st_retention_value)],
  ['Valor ICMS próprio do substituto', row => decimalComma(row.icms_own_substitute_value)], ['Categoria do produto', row => text(row.category)],
  ['Informações Adicionais', row => text(row.additional_info)], ['Tipo', row => KIND[text(row.kind)] ?? ''], ['Formato', row => FORMAT[text(row.format)] ?? ''],
];
// A cell that starts like a formula (=, +, -, @, tab or carriage return) gets an apostrophe; a plain number such as a negative
// stock ("-5,000000") is data, not a formula, and stays as it is.
const formula = (value: string) => /^[=+\-@\t\r]/.test(value) && !/^-?\d+(?:,\d+)?$/.test(value);
const cell = (value: string) => /[";\r\n]/.test(value) || formula(value) ? `"${(formula(value) ? `'${value}` : value).replace(/"/g, '""')}"` : value;
// XLS (Origin "Formato de arquivo"): the same columns in an .xlsx sheet; decimals stay exact numbers (never floats), the rest is text.
const NUMERIC_COLUMNS = new Set(['Preço', 'Valor IPI fixo', 'Estoque', 'Preço de custo', 'Estoque máximo', 'Estoque mínimo', 'Peso líquido (Kg)', 'Peso bruto (Kg)', 'Largura do produto', 'Altura do Produto',
  'Profundidade do produto', 'Tributos', 'Preço de compra', 'Valor base ICMS ST para retenção', 'Valor ICMS ST para retenção', 'Valor ICMS próprio do substituto']);
export function exportSheet(rows: readonly ExportRow[], columns: readonly ExportColumn[] = EXPORT_COLUMNS): SheetCell[][] {
  return [columns.map(([label]) => textCell(label)), ...rows.map(row => columns.map(([label, read, numeric]) => { const value = read(row); return (numeric ?? NUMERIC_COLUMNS.has(label)) && value ? numberCell(value.replace(',', '.')) : textCell(value); }))];
}
/** CSV in UTF-8 with BOM and ";" (opens in Excel in Portuguese); cells that start like a formula are quoted with an apostrophe. */
export function exportCsv(rows: readonly ExportRow[], columns: readonly ExportColumn[] = EXPORT_COLUMNS) {
  return '﻿' + [columns.map(([label]) => label), ...rows.map(row => columns.map(([, read]) => read(row)))].map(line => line.map(cell).join(';')).join('\r\n') + '\r\n';
}
/** Tipo dos campos of the export: Padrão (the Brufap sheet), Customizado (ID, Código, Descrição and the custom fields) or Ambos.
 * 202610220008: "Estoque" stays the native balance of the Origin sheet; the balance observed in Origin has its own columns after the
 * standard ones, never added to it. */
export function exportColumns(kind: 'standard' | 'custom' | 'both', custom: readonly ExportColumn[]): ExportColumn[] {
  return kind === 'standard' ? [...EXPORT_COLUMNS, ...ORIGIN_EXPORT_COLUMNS] : kind === 'custom' ? [...EXPORT_COLUMNS.slice(0, 3), ...custom] : [...EXPORT_COLUMNS, ...ORIGIN_EXPORT_COLUMNS, ...custom];
}
