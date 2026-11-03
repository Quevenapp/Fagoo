// Leva H, lane espelho (202610210350-352): "Dados do Origin" dos cadastros, categorias do Origin e exclusões do Origin.
// The Worker already checks every answer; these readers keep the screen safe if a field is missing.
export type MirrorEntity = 'contacts' | 'products';
export type MirrorValue = string | string[] | Record<string, string>;
export type OriginMirror = {
  entity: MirrorEntity; id: string; linked: boolean; source_id: string | null; state: string | null;
  synced_at: string | null; source_updated_at: string | null; source_seen_at: string | null; pending: boolean;
  fields: Record<string, MirrorValue>; local_complements: string[];
};
export type OriginCategory = { source_id: string; taxonomy_id: string | null; name: string | null; source_name: string; source_parent_id: string | null; parent_id: string | null;
  inactive: boolean; issue: string | null; synced_at: string; removed_locally: boolean };
export type OriginCategories = { source_count: number; source_seen_at: string | null; pending: number; items: OriginCategory[] };
export type OriginDeletion = { id: string; version: number; name: string; code: string | null; source_id: string; source_status: string; action: 'delete' | 'restore'; deleted_at: string | null };
export type OriginDeletions = { items: OriginDeletion[]; has_more: boolean; writable: boolean; source_seen_at: string | null };

export const MIRROR_BASE = '/v1/espelho-origin';
export const mirrorRecordPath = (entity: MirrorEntity, id: string) => `${MIRROR_BASE}/cadastros/${entity}/${encodeURIComponent(id)}`;
export const mirrorCategoriesPath = (sync = false) => `${MIRROR_BASE}/categorias${sync ? '/sincronizar' : ''}`;
export const mirrorDeletionsPath = (id?: string) => `${MIRROR_BASE}/exclusoes${id ? `/${encodeURIComponent(id)}` : ''}`;
export const mirrorCarrierPath = (id: string) => `${MIRROR_BASE}/transportadores/${encodeURIComponent(id)}`;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : null;

export function readOriginMirror(value: unknown, entity: MirrorEntity, id: string): OriginMirror {
  if (!object(value) || value.scope !== 'origin_mirror' || value.entity !== entity || value.id !== id || !object(value.fields)) throw new Error('origin_mirror_invalid');
  return { entity, id, linked: value.linked === true, source_id: text(value.source_id), state: text(value.state), synced_at: text(value.synced_at),
    source_updated_at: text(value.source_updated_at), source_seen_at: text(value.source_seen_at), pending: value.pending === true,
    fields: value.fields as Record<string, MirrorValue>, local_complements: Array.isArray(value.local_complements) ? value.local_complements.filter((v): v is string => typeof v === 'string') : [] };
}
export function readOriginCategories(value: unknown): OriginCategories {
  if (!object(value) || value.scope !== 'origin_categories' || !Array.isArray(value.items)) throw new Error('origin_categories_invalid');
  return { source_count: Number(value.source_count) || 0, source_seen_at: text(value.source_seen_at), pending: Number(value.pending) || 0, items: value.items as OriginCategory[] };
}
export function readOriginDeletions(value: unknown): OriginDeletions {
  if (!object(value) || value.scope !== 'origin_deletions' || !Array.isArray(value.items)) throw new Error('origin_deletions_invalid');
  return { items: value.items as OriginDeletion[], has_more: value.has_more === true, writable: value.writable === true, source_seen_at: text(value.source_seen_at) };
}

/** Field labels, in the order of the Origin cadastro. Unknown keys are shown after them with the key itself. */
export const MIRROR_LABELS: Record<MirrorEntity, [string, string][]> = {
  contacts: [['name', 'Nome'], ['code', 'Código'], ['trade_name', 'Fantasia'], ['person_type', 'Tipo da pessoa'], ['document', 'CNPJ/CPF'], ['ie_indicator', 'Contribuinte (indicador IE)'],
    ['ie', 'Inscrição estadual'], ['rg', 'RG'], ['rg_issuer', 'Órgão emissor'], ['municipal_registration', 'Inscrição municipal'], ['email', 'E-mail'], ['nfe_email', 'E-mail para envio da NF-e'],
    ['phone', 'Telefone'], ['mobile', 'Celular'], ['address', 'Endereço'], ['billing_address', 'Endereço de cobrança'], ['contact_types', 'Tipos de contato'], ['seller_source_id', 'Vendedor (id no Origin)'],
    ['credit_limit', 'Limite de crédito'], ['payment_condition', 'Condição de pagamento'], ['financial_category_source_id', 'Categoria financeira (id no Origin)'], ['birth_date', 'Data de nascimento'],
    ['gender', 'Sexo'], ['birthplace', 'Naturalidade'], ['country', 'País'], ['persons', 'Pessoas de contato'], ['situation', 'Situação no Origin']],
  products: [['name', 'Nome'], ['code', 'Código (SKU)'], ['kind', 'Tipo'], ['format', 'Formato'], ['situation', 'Situação no Origin'], ['unit', 'Unidade'], ['price', 'Preço'], ['brand', 'Marca'],
    ['condition', 'Condição'], ['production', 'Produção'], ['gtin', 'GTIN/EAN'], ['gtin_package', 'GTIN/EAN tributário'], ['net_weight', 'Peso líquido (kg)'], ['gross_weight', 'Peso bruto (kg)'],
    ['width', 'Largura'], ['height', 'Altura'], ['depth', 'Profundidade'], ['dimension_unit', 'Unidade das dimensões'], ['volumes', 'Volumes'], ['items_per_box', 'Itens por caixa'],
    ['stock_min', 'Estoque mínimo'], ['stock_max', 'Estoque máximo'], ['crossdocking', 'Crossdocking (dias)'], ['location', 'Localização'], ['expiry_date', 'Validade'], ['free_shipping', 'Frete grátis'],
    ['category_source_id', 'Categoria (id no Origin)'], ['product_group_source_id', 'Grupo de produtos (id no Origin)'], ['parent_source_id', 'Produto pai (id no Origin)'], ['variations', 'Variações'],
    ['tax_origin', 'Origem'], ['ncm', 'NCM'], ['cest', 'CEST'], ['fci_number', 'Nº FCI'], ['item_type', 'Tipo do item (SPED)'], ['tax_percent', 'Tributos aproximados (%)'], ['ipi_exception', 'Código de exceção da TIPI'],
    ['short_description', 'Descrição curta'], ['complementary_description', 'Descrição complementar'], ['additional_info', 'Informações adicionais'], ['notes', 'Observações'], ['external_link', 'Link externo']],
};
const ADDRESS: [string, string][] = [['street', 'Endereço'], ['number', 'Número'], ['complement', 'Complemento'], ['district', 'Bairro'], ['city', 'Cidade'], ['state', 'UF'], ['postal_code', 'CEP']];
const PLAIN = /<[^>]*>/g;
export function mirrorValueText(value: MirrorValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return ADDRESS.filter(([key]) => value[key]).map(([key]) => value[key]).join(', ');
  return value.replace(PLAIN, ' ').replace(/\s+/g, ' ').trim();
}
/** The mirrored fields as label/value rows (empty values left out). */
export function mirrorRows(mirror: OriginMirror): { key: string; label: string; value: string }[] {
  const known = MIRROR_LABELS[mirror.entity], seen = new Set(known.map(([key]) => key));
  const rows = known.filter(([key]) => mirror.fields[key] !== undefined).map(([key, label]) => ({ key, label, value: mirrorValueText(mirror.fields[key]) }));
  for (const key of Object.keys(mirror.fields).sort()) if (!seen.has(key) && !['source_roles', 'detail_available', 'listed_as_deleted'].includes(key)) rows.push({ key, label: key, value: mirrorValueText(mirror.fields[key]) });
  return rows.filter(row => row.value !== '');
}
export const MIRROR_STATE_TEXT: Record<string, string> = { synced: 'Sincronizado', local_modified: 'Alterado no FAGOO', source_changed: 'Alteração do Origin aguardando revisão', source_deleted: 'Excluído no Origin' };
export const CATEGORY_ISSUE_TEXT: Record<string, string> = { parent_missing: 'Categoria superior ainda não sincronizada', cycle: 'Hierarquia circular no Origin (mantida a anterior)',
  name_conflict: 'Já existe outra categoria com este nome no mesmo nível', name_invalid: 'Nome inválido no Origin', limit: 'Limite de categorias atingido' };
export const SYNC_COUNT_TEXT: Record<string, string> = { created: 'criadas', updated: 'atualizadas', adopted: 'vinculadas a categorias existentes', unchanged: 'sem alteração', refreshed: 'conferidas',
  removed_locally: 'excluídas no FAGOO (ignoradas)', invalid: 'inválidas', limit: 'acima do limite', name_conflict: 'com nome em conflito' };
export function syncSummary(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([key, n]) => `${n} ${SYNC_COUNT_TEXT[key] ?? key}`);
  return parts.length ? `Categorias do Origin: ${parts.join(', ')}.` : 'Nenhuma categoria do Origin para sincronizar.';
}
export const dateTimeText = (value: string | null) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(value)) : '—';
