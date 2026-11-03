import { textCell, numberCell, type SheetCell } from './spreadsheet-export.ts';
import { brDate } from './origin-list.ts';
import { CRT_OPTIONS, OPERATOR_OPTIONS, PUBLIC_AGENCY_OPTIONS, MARITAL_OPTIONS, TAXPAYER_OPTIONS, documentLabel, type ContactRecord, type ContactSituation } from './contact-form-model.ts';

// Listagem de Clientes e fornecedores no padrão do Origin (lane contatos): Situação, seletor de tipo de contato, filtros,
// períodos Prox. Visita / Sem compras no período, colunas padrão e customizadas, exportação e impressão.
export const CONTACTS_BASE = '/v1/cadastros/contatos';
export const CONTACT_LIST_ID = 'cadastros.contatos';
export const CONTACT_PAGE_SIZE = 100;
export const EXPORT_LIMIT = 10000;
export const EXPORT_BLOCK = 100;

export interface ContactListItem {
  id: string; entity: 'contacts'; version: number; active: boolean; situation: ContactSituation; name: string; code: string | null; trade_name: string | null; person_type: string | null;
  document: string | null; email: string | null; phone: string | null; mobile: string | null; city: string | null; state: string | null; roles: string[]; types: string[]; crt: string | null;
  seller_id: string | null; seller_name: string | null; next_visit: string | null; is_seller: boolean; created_at: string; updated_at: string; source: { system: 'origin' } | null;
}
export interface ContactPage { entity: 'contacts'; items: ContactListItem[]; page: number; size: number; total: number; sort: string; situation: string; scoped: boolean }
export interface ContactTypeItem { id: string; slug: string; label: string; system: boolean; deletable: boolean; position: number; contacts: number }
export interface ContactTypes { items: ContactTypeItem[]; can_create: boolean; can_delete: boolean }

export type SituationFilter = 'latest' | 'all' | ContactSituation;
// Origin CL-07, in the Origin order.
export const SITUATION_FILTERS: readonly { value: SituationFilter; label: string }[] = [{ value: 'latest', label: 'Últimos incluídos' }, { value: 'all', label: 'Todos' }, { value: 'A', label: 'Ativos' },
  { value: 'E', label: 'Excluídos' }, { value: 'I', label: 'Inativos' }, { value: 'S', label: 'Sem movimento' }];
export const SITUATION_LABELS: Record<ContactSituation, string> = { A: 'Ativo', I: 'Inativo', S: 'Sem movimento', E: 'Excluído' };
export const PERIOD_TYPES = [{ value: 'next_visit', label: 'Prox. Visita' }, { value: 'no_purchases', label: 'Sem compras no período' }] as const;
export type ContactPeriodField = typeof PERIOD_TYPES[number]['value'];
// Situações nativas do pedido de venda (Origin CL-10, usadas com "Sem compras no período").
export const SALE_STATUS_OPTIONS = [{ value: 'draft', label: 'Em digitação' }, { value: 'open', label: 'Em aberto' }, { value: 'verified', label: 'Verificado' }, { value: 'in_progress', label: 'Em andamento' },
  { value: 'partially_fulfilled', label: 'Atendido parcialmente' }, { value: 'fulfilled', label: 'Atendido' }, { value: 'cancelled', label: 'Cancelado' }] as const;
export const PERSON_FILTERS = [{ value: 'F', label: 'Pessoa Física' }, { value: 'J', label: 'Pessoa Jurídica' }, { value: 'E', label: 'Estrangeiro' }] as const;

export interface ContactListFilters {
  situation: SituationFilter; person_type: string; phone: string; email: string; state: string; city: string;
  seller: { id: string; name: string; code: string | null } | null; sale_statuses: string[];
  // Produtos lane, migration 153: Tags ('' Todos | 'none' Sem Tag | tag id) and Lista de preço ('' Todas | list id).
  tag: string; price_list_id: string;
}
export const EMPTY_LIST_FILTERS: ContactListFilters = { situation: 'latest', person_type: '', phone: '', email: '', state: '', city: '', seller: null, sale_statuses: [], tag: '', price_list_id: '' };
export interface ContactListPeriod { field: ContactPeriodField; from: string; to: string }
export const EMPTY_LIST_PERIOD: ContactListPeriod = { field: 'next_visit', from: '', to: '' };
export interface ContactListState { page: number; sort: 'created_desc' | 'name_asc'; query: string; type: string; filters: ContactListFilters; period: ContactListPeriod }

/** Query of the page and of the export (same filters, so the print and the spreadsheet are what the list shows). */
export function contactFilterParams(params: URLSearchParams, state: Omit<ContactListState, 'page'>) {
  if (state.sort !== 'created_desc') params.set('sort', state.sort);
  if (state.query.trim()) params.set('q', state.query.trim());
  if (state.filters.situation !== 'latest') params.set('situation', state.filters.situation);
  if (state.type) params.set('type', state.type);
  for (const key of ['person_type', 'phone', 'email', 'state', 'city'] as const) if (state.filters[key].trim()) params.set(key, key === 'state' ? state.filters[key].trim().toUpperCase() : state.filters[key].trim());
  if (state.filters.seller) params.set('seller_id', state.filters.seller.id);
  if (state.filters.tag) params.set('tag', state.filters.tag);
  if (state.filters.price_list_id) params.set('price_list_id', state.filters.price_list_id);
  if (state.period.from || state.period.to) {
    params.set('period', state.period.field);
    if (state.period.from) params.set('from', state.period.from);
    if (state.period.to) params.set('to', state.period.to);
    if (state.period.field === 'no_purchases' && state.filters.sale_statuses.length) params.set('sale_statuses', SALE_STATUS_OPTIONS.map(o => o.value).filter(v => state.filters.sale_statuses.includes(v)).join(','));
  }
  return params;
}
export function contactPageQuery(state: ContactListState) {
  return contactFilterParams(new URLSearchParams({ page: String(state.page), size: String(CONTACT_PAGE_SIZE) }), state);
}
/** "Filtrar": typed filters are trimmed; selects stay as chosen. */
export const appliedListFilters = (draft: ContactListFilters): ContactListFilters => ({ ...draft, phone: draft.phone.trim(), email: draft.email.trim(), city: draft.city.trim() });

// ---- Seletor de tipo de contato: Todos, Sem tipo definido e os tipos em ordem alfabética (Origin CL-01, sem "Padrao") ----
export function typeSelectorOptions(types: readonly ContactTypeItem[]) {
  // Origin sorts by the plain character codes ("Transportador" before "Técnico").
  const sorted = types.filter(type => type.slug !== 'default').sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  return [{ value: '', label: 'Todos' }, { value: 'none', label: 'Sem tipo definido' }, ...sorted.map(type => ({ value: type.slug, label: type.label }))];
}
// ?contato=<valor>: the readable values of migration 096 keep working (Estoque > Fornecedores), and other types use their slug.
const PARAM_SLUGS: Record<string, string> = { cliente: 'customer', fornecedor: 'supplier', transportador: 'carrier', 'sem-tipo': 'none', vendedor: 'seller', desenvolvedor: 'developer',
  tecnico: 'technician', contador: 'accountant', 'fornecedor-verificado': 'verified_supplier', padrao: 'default' };
export const typeFromParam = (value: string | null) => !value ? '' : PARAM_SLUGS[value] ?? (/^[a-z][a-z0-9_]{1,39}$/.test(value) ? value : '');
export const typeParam = (slug: string) => !slug ? null : Object.entries(PARAM_SLUGS).find(([, value]) => value === slug)?.[0] ?? slug;
export const typeLabels = (slugs: readonly string[], types: readonly ContactTypeItem[]) => slugs.map(slug => types.find(type => type.slug === slug)?.label ?? slug);

// ---- Colunas: listagem padrão (CL-11) e customizada (CL-12), com Nome fixo ----
export const COLUMN_LABELS: Record<string, string> = { name: 'Nome', city: 'Cidade', document: 'CPF/CNPJ', phone: 'Telefone', code: 'Código', crt: 'Código do Regime Tributário',
  situation: 'Situação', state: 'UF', trade_name: 'Nome fantasia', email: 'E-mail', mobile: 'Celular', seller: 'Vendedor' };
export const DEFAULT_COLUMNS = ['code', 'name', 'document', 'city', 'phone'] as const;
export const CUSTOM_COLUMNS = ['name', 'city', 'document', 'phone', 'code', 'crt', 'situation', 'state', 'trade_name', 'email', 'mobile', 'seller'] as const;
export const FIXED_COLUMN = 'name';
/** Saved custom columns in their order; Nome is always shown (first if the saved list lost it). */
export function visibleColumns(view: 'padrao' | 'customizada', saved: readonly string[]) {
  if (view === 'padrao') return [...DEFAULT_COLUMNS];
  const columns = saved.filter(column => (CUSTOM_COLUMNS as readonly string[]).includes(column));
  return columns.includes(FIXED_COLUMN) ? columns : [FIXED_COLUMN, ...columns];
}
const CRT_LABEL = Object.fromEntries(CRT_OPTIONS.filter(o => o.value).map(o => [o.value, o.label]));
export function columnText(item: ContactListItem, column: string) {
  const value = column === 'seller' ? item.seller_name : column === 'situation' ? SITUATION_LABELS[item.situation] : column === 'crt' ? (item.crt ? CRT_LABEL[item.crt] ?? item.crt : null) : item[column as keyof ContactListItem];
  return typeof value === 'string' && value ? value : '—';
}

// ---- Exportar para a planilha (Padrão): mesmas colunas do modelo de importação (IC-02) ----
const OPTION_LABEL = (options: readonly { value: string; label: string }[]) => Object.fromEntries(options.filter(o => o.value).map(o => [o.value, o.label]));
const LABELS = { crt: OPTION_LABEL(CRT_OPTIONS), taxpayer: OPTION_LABEL(TAXPAYER_OPTIONS), carrier_operator: OPTION_LABEL(OPERATOR_OPTIONS), public_agency: OPTION_LABEL(PUBLIC_AGENCY_OPTIONS),
  marital_status: OPTION_LABEL(MARITAL_OPTIONS), person_type: { F: 'Física', J: 'Jurídica', E: 'Estrangeiro' } as Record<string, string>, situation: SITUATION_LABELS as Record<string, string>,
  credit_limit_mode: { unlimited: 'Ilimitado', zero: 'Limite zero', value: 'Valor' } as Record<string, string> };
// [header, key, kind]: the header row is the spreadsheet model; import reads the same headers back.
export const SHEET_COLUMNS: readonly (readonly [string, string, 'text' | 'date' | 'number' | 'option' | 'bool' | 'types'])[] = [
  ['Código', 'code', 'text'], ['Nome', 'name', 'text'], ['Fantasia', 'trade_name', 'text'], ['Tipo da Pessoa', 'person_type', 'option'], ['CPF/CNPJ', 'document', 'text'],
  ['Código de regime tributário', 'crt', 'option'], ['Contribuinte', 'taxpayer', 'option'], ['Inscrição Estadual', 'ie', 'text'], ['IE Isento', 'ie_exempt', 'bool'],
  ['Inscrição Municipal', 'municipal_registration', 'text'], ['RG', 'rg', 'text'], ['Órgão Emissor', 'rg_issuer', 'text'], ['País', 'country', 'text'], ['Cliente desde', 'client_since', 'date'],
  ['CEP', 'postal_code', 'text'], ['UF', 'state', 'text'], ['Cidade', 'city', 'text'], ['Bairro', 'district', 'text'], ['Endereço', 'street', 'text'], ['Número', 'number', 'text'],
  ['Complemento', 'complement', 'text'], ['UF (Exterior)', 'foreign_state', 'text'], ['CEP - Cobrança', 'billing_postal_code', 'text'], ['UF - Cobrança', 'billing_state', 'text'],
  ['Cidade - Cobrança', 'billing_city', 'text'], ['Bairro - Cobrança', 'billing_district', 'text'], ['Endereço - Cobrança', 'billing_street', 'text'], ['Número - Cobrança', 'billing_number', 'text'],
  ['Complemento - Cobrança', 'billing_complement', 'text'], ['UF (Exterior) - Cobrança', 'billing_foreign_state', 'text'], ['Informações do contato', 'contact_info', 'text'],
  ['Fone', 'phone', 'text'], ['Fax', 'fax', 'text'], ['Celular', 'mobile', 'text'], ['Operadora', 'carrier_operator', 'option'], ['Órgão Público', 'public_agency', 'option'],
  ['E-Mail', 'email', 'text'], ['E-Mail para envio da NFe', 'nfe_email', 'text'], ['WebSite', 'website', 'text'], ['Skype', 'skype', 'text'], ['Próxima visita', 'next_visit', 'date'],
  ['% carga média', 'avg_tax_load', 'number'], ['Estado civil', 'marital_status', 'option'], ['Profissão', 'profession', 'text'], ['Sexo', 'gender', 'option'], ['Data Nascimento', 'birth_date', 'date'],
  ['Naturalidade', 'birthplace', 'text'], ['Nome do Pai', 'father_name', 'text'], ['CPF do Pai', 'father_cpf', 'text'], ['Nome da Mãe', 'mother_name', 'text'], ['CPF da Mãe', 'mother_cpf', 'text'],
  ['Tipo de Contato', 'types', 'types'], ['Situação', 'situation', 'option'], ['Vendedor', 'seller_name', 'text'], ['Inscrição Suframa', 'suframa', 'text'],
  ['Limite de crédito', 'credit_limit_mode', 'option'], ['Valor do limite de crédito', 'credit_limit', 'number'], ['Condição de pagamento', 'payment_condition', 'text'],
  ['Categoria', 'finance_category_name', 'text'], ['Natureza de Operação Padrão', 'operation_nature_name', 'text'], ['Observações', 'notes', 'text'],
];
export function sheetRows(records: readonly ContactRecord[], types: readonly ContactTypeItem[]): SheetCell[][] {
  return [SHEET_COLUMNS.map(([header]) => textCell(header)), ...records.map(record => SHEET_COLUMNS.map(([, key, kind]) => {
    const value = record[key];
    if (kind === 'bool') return textCell(value === true ? 'Sim' : 'Não');
    if (kind === 'types') return textCell(typeLabels(Array.isArray(value) ? value as string[] : [], types).join(', '));
    if (typeof value !== 'string' || !value) return textCell('');
    if (kind === 'date') return textCell(brDate(value));
    if (kind === 'number') return numberCell(value);
    if (kind === 'option') return textCell((LABELS as Record<string, Record<string, string>>)[key]?.[value] ?? value);
    return textCell(value);
  }))];
}
/** Origin XLS warns about the 30.000-character cell limit; those cells are named so the user can choose CSV. */
export const longCells = (rows: readonly SheetCell[][]) => rows.flat().filter(cell => 'text' in cell && cell.text.length > 30000).length;

// ---- Impressão: Imprimir listagem de contatos e Aniversariantes ----
export const printColumns = (columns: readonly string[]) => columns.map(column => ({ key: column, label: COLUMN_LABELS[column] ?? column }));
export const birthday = (record: ContactRecord) => typeof record.birth_date === 'string' ? brDate(record.birth_date).slice(0, 5) : '';
export { documentLabel };
