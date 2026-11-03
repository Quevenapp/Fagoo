import { COMMON_FIELDS, type CatalogField } from './catalog-base.ts';

// Clientes e fornecedores: campos do formulário, tipos de contato e filtros da listagem.
// catalog-model.ts re-exports everything here, so existing imports keep working.
export const CONTACT_FIELDS: CatalogField[] = [...COMMON_FIELDS, { key: 'trade_name', label: 'Nome fantasia', max: 200 },
  { key: 'person_type', label: 'Tipo de pessoa', max: 1, type: 'select', options: [{ value: 'F', label: 'Física' }, { value: 'J', label: 'Jurídica' }, { value: 'E', label: 'Estrangeira' }] },
  { key: 'document', label: 'CPF / CNPJ / documento', max: 30 }, { key: 'ie', label: 'Inscrição estadual', max: 30 },
  { key: 'email', label: 'E-mail', max: 254, type: 'email' }, { key: 'phone', label: 'Telefone', max: 40 }, { key: 'mobile', label: 'Celular', max: 40 },
  { key: 'postal_code', label: 'CEP', max: 20 }, { key: 'street', label: 'Endereço', max: 200 }, { key: 'number', label: 'Número', max: 30 },
  { key: 'complement', label: 'Complemento', max: 200 }, { key: 'district', label: 'Bairro', max: 100 }, { key: 'city', label: 'Cidade', max: 100 }, { key: 'state', label: 'UF', max: 2 }];
/** Contact value as catalogData validates and sends it: the UF is upper case. */
export const contactFieldValue = (key: string, value: string) => key === 'state' ? value.toUpperCase() : value;

export type ContactRoleFilter = '' | 'none' | 'customer' | 'supplier' | 'carrier';
export const ROLE_LABELS: Record<'customer' | 'supplier' | 'carrier', string> = { customer: 'Cliente', supplier: 'Fornecedor', carrier: 'Transportador' };
// Seletor "Todos ▾" do Origin, só com os tipos que o cadastro registra (ordem do Origin).
export const CONTACT_ROLE_OPTIONS: readonly { value: ContactRoleFilter; label: string; param: string | null }[] = [
  { value: '', label: 'Todos', param: null }, { value: 'none', label: 'Sem tipo definido', param: 'sem-tipo' },
  { value: 'customer', label: 'Cliente', param: 'cliente' }, { value: 'supplier', label: 'Fornecedor', param: 'fornecedor' }, { value: 'carrier', label: 'Transportador', param: 'transportador' },
];
export const contactRoleFromParam = (value: string | null): ContactRoleFilter => CONTACT_ROLE_OPTIONS.find(option => option.param !== null && option.param === value)?.value ?? '';
export const contactRoleParam = (role: ContactRoleFilter) => CONTACT_ROLE_OPTIONS.find(option => option.value === role)?.param ?? null;

// ---- Filtros da listagem de contatos ----
export const EMPTY_CONTACT_FILTERS = { person_type: '', phone: '', email: '', state: '', city: '' };
export type ContactFilters = typeof EMPTY_CONTACT_FILTERS;
/** "Filtrar": the typed filters are trimmed; the selects are kept as chosen. */
export const appliedContactFilters = (draft: ContactFilters): ContactFilters => ({ person_type: draft.person_type, phone: draft.phone.trim(), email: draft.email.trim(), state: draft.state, city: draft.city.trim() });
export function contactPageParams(params: URLSearchParams, role: ContactRoleFilter, filters: ContactFilters) {
  if (role) params.set('role', role);
  for (const key of ['person_type', 'phone', 'email', 'state', 'city'] as const) if (filters[key].trim()) params.set(key, key === 'state' ? filters[key].trim().toUpperCase() : filters[key].trim());
}
export const UF_OPTIONS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO', 'EX'] as const;
