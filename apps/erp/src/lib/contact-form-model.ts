import { CatalogValidationError, type CatalogRecord } from './catalog-base.ts';
import { UF_OPTIONS } from './contact-model.ts';

// Formulário de Cliente ou Fornecedor no padrão do Origin (lane contatos, migrações 124-128): campos, rótulos e dicas do
// Origin, campos que dependem do Tipo da Pessoa, padrões da inclusão e a mesma validação do servidor (que decide).
export type PersonType = 'F' | 'J' | 'E';
export type ContactSituation = 'A' | 'I' | 'S' | 'E';
export interface ContactPerson { id: string; name: string; code: string | null; situation: ContactSituation }
/** Contact as /v1/cadastros/contatos returns it (every field of the Origin form). */
export interface ContactRecord extends CatalogRecord {
  entity: 'contacts'; situation: ContactSituation; roles: string[]; types: string[]; persons: ContactPerson[]; ie_exempt: boolean; credit_limit_mode: 'unlimited' | 'zero' | 'value';
  finance_category_name: string | null; operation_nature_name: string | null; seller_name: string | null; updated_by_name: string | null; seller_record_id: string | null;
}
export type Option = { value: string; label: string };
export type FieldKind = 'text' | 'textarea' | 'select' | 'date' | 'decimal' | 'email' | 'tel' | 'url';
export interface ContactField { key: string; label: string; max: number; kind: FieldKind; options?: readonly Option[]; hint?: string; only?: PersonType; counter?: boolean; placeholder?: string }

export const PERSON_TYPE_OPTIONS: readonly Option[] = [{ value: 'J', label: 'Pessoa Jurídica' }, { value: 'F', label: 'Pessoa Física' }, { value: 'E', label: 'Estrangeiro' }];
export const CRT_OPTIONS: readonly Option[] = [{ value: '', label: 'Não definido' }, { value: '1', label: 'Simples nacional' }, { value: '2', label: 'Simples nacional - Excesso de sublimite de receita bruta' },
  { value: '3', label: 'Regime normal' }, { value: '4', label: 'MEI' }];
export const TAXPAYER_OPTIONS: readonly Option[] = [{ value: '1', label: '1 - Contribuinte ICMS' }, { value: '2', label: '2 - Contribuinte isento de Inscrição no Cadastro de Contribuintes' },
  { value: '9', label: '9 - Não contribuinte, que pode ou não possuir Inscrição Estadual no Cadastro de Contribuintes' }];
export const OPERATOR_OPTIONS: readonly Option[] = [{ value: '', label: 'Operadora' }, { value: 'claro', label: 'Claro' }, { value: 'oi', label: 'Oi' }, { value: 'tim', label: 'Tim' }, { value: 'vivo', label: 'Vivo' },
  { value: 'nextel', label: 'Nextel' }, { value: 'porto_seguro', label: 'Porto Seguro Conecta' }];
export const PUBLIC_AGENCY_OPTIONS: readonly Option[] = [{ value: '', label: 'Não' }, { value: 'municipal', label: 'Municipal' }, { value: 'estadual', label: 'Estadual' }, { value: 'federal', label: 'Federal' }];
export const MARITAL_OPTIONS: readonly Option[] = [{ value: '', label: 'Selecione' }, { value: 'casado', label: 'Casado' }, { value: 'solteiro', label: 'Solteiro' }, { value: 'viuvo', label: 'Viúvo' },
  { value: 'separado', label: 'Separado' }, { value: 'desquitado', label: 'Desquitado' }];
export const GENDER_OPTIONS: readonly Option[] = [{ value: '', label: 'selecione' }, { value: 'feminino', label: 'feminino' }, { value: 'masculino', label: 'masculino' }];
export const FORM_SITUATION_OPTIONS: readonly Option[] = [{ value: 'A', label: 'Ativo' }, { value: 'I', label: 'Inativo' }, { value: 'S', label: 'Sem Movimento' }];
export const UF_SELECT: readonly Option[] = [{ value: '', label: 'UF ...' }, ...UF_OPTIONS.map(uf => ({ value: uf, label: uf }))];
// País (Estrangeiro): sugestões com o nome usado na NF-e; o campo aceita outro nome.
export const COUNTRY_SUGGESTIONS = ['Alemanha', 'Argentina', 'Austrália', 'Bolívia', 'Canadá', 'Chile', 'China', 'Colômbia', 'Coreia do Sul', 'Equador', 'Espanha', 'Estados Unidos', 'França', 'Índia',
  'Itália', 'Japão', 'México', 'Paraguai', 'Países Baixos', 'Peru', 'Portugal', 'Reino Unido', 'Suíça', 'Uruguai', 'Venezuela'] as const;

/** Rótulo de CPF / CNPJ conforme o Tipo da Pessoa (Origin CF-05). */
export const documentLabel = (type: string) => type === 'J' ? 'CNPJ' : type === 'F' ? 'CPF' : type === 'E' ? 'Documento' : 'CPF / CNPJ';

const T = (key: string, label: string, max: number, extra: Partial<ContactField> = {}): ContactField => ({ key, label, max, kind: 'text', ...extra });
// Every editable field of the Origin form, by section (the order is the order on screen).
export const SECTION_FIELDS = {
  cadastrais: [T('name', 'Nome', 200, { hint: 'Nome completo do contato.' }), T('trade_name', 'Fantasia', 200, { hint: 'Nome de fantasia ou apelido.' }), T('code', 'Código', 100, { hint: 'Opcional' }),
    { key: 'person_type', label: 'Tipo da Pessoa', max: 1, kind: 'select', options: PERSON_TYPE_OPTIONS } as ContactField, T('document', 'CPF / CNPJ', 30),
    { key: 'crt', label: 'Código de regime tributário', max: 1, kind: 'select', options: CRT_OPTIONS, only: 'J' } as ContactField,
    { key: 'client_since', label: 'Cliente desde', max: 10, kind: 'date' } as ContactField, { key: 'taxpayer', label: 'Contribuinte', max: 1, kind: 'select', options: TAXPAYER_OPTIONS } as ContactField,
    T('ie', 'Inscrição Estadual', 30), T('municipal_registration', 'Inscrição Municipal', 30, { only: 'J' }), T('rg', 'RG', 20, { only: 'F' }), T('rg_issuer', 'Órgão Emissor', 20, { only: 'F' }),
    T('country', 'País', 60, { only: 'E' })],
  endereco: [T('postal_code', 'CEP', 20), { key: 'state', label: 'UF', max: 2, kind: 'select', options: UF_SELECT } as ContactField, T('city', 'Cidade', 100), T('district', 'Bairro', 100),
    T('street', 'Endereço', 200, { hint: 'Endereço Geral (Exemplo: Rua Assis Brasil)' }), T('number', 'Número', 30), T('complement', 'Complemento', 200, { counter: true }),
    T('foreign_state', 'UF (Exterior)', 60, { only: 'E' })],
  cobranca: [T('billing_postal_code', 'CEP', 20), { key: 'billing_state', label: 'UF', max: 2, kind: 'select', options: UF_SELECT } as ContactField, T('billing_city', 'Cidade', 100),
    T('billing_district', 'Bairro', 100), T('billing_street', 'Endereço', 200, { hint: 'Endereço de cobrança (Exemplo: Rua Assis Brasil)' }), T('billing_number', 'Número', 30),
    T('billing_complement', 'Complemento', 200, { counter: true }), T('billing_foreign_state', 'UF (Exterior)', 60, { only: 'E' })],
  contato: [{ key: 'contact_info', label: 'Informações do contato', max: 400, kind: 'text' } as ContactField, T('phone', 'Fone', 40, { kind: 'tel' }), T('fax', 'Fax', 40, { kind: 'tel' }),
    T('mobile', 'Celular', 40, { kind: 'tel' }), { key: 'carrier_operator', label: 'Operadora', max: 20, kind: 'select', options: OPERATOR_OPTIONS } as ContactField,
    { key: 'public_agency', label: 'Órgão Público?', max: 20, kind: 'select', options: PUBLIC_AGENCY_OPTIONS, only: 'J' } as ContactField,
    T('email', 'E-Mail', 254, { kind: 'email', hint: 'Informe vários e-mails separados por ; ou ,. Máximo de 60 caracteres para NF-e/NFC-e.' }),
    T('nfe_email', 'E-Mail para envio da NFe', 60, { kind: 'email', hint: 'Máximo de 60 caracteres para NF-e/NFC-e.' }),
    T('website', 'WebSite', 200, { kind: 'url', hint: 'Exemplo: https://www.seusite.com.br' }), T('skype', 'Skype', 100), { key: 'next_visit', label: 'Próxima visita', max: 10, kind: 'date' } as ContactField],
  adicionais: [{ key: 'avg_tax_load', label: '% carga média (opcional)', max: 6, kind: 'decimal', only: 'F', hint: 'Somente preencher caso o cliente estiver enquadrado no regime de carga média tributária' } as ContactField,
    { key: 'marital_status', label: 'Estado civil', max: 20, kind: 'select', options: MARITAL_OPTIONS, only: 'F' } as ContactField, T('profession', 'Profissão', 100, { only: 'F' }),
    { key: 'gender', label: 'Sexo', max: 20, kind: 'select', options: GENDER_OPTIONS, only: 'F' } as ContactField, { key: 'birth_date', label: 'Data Nascimento', max: 10, kind: 'date', only: 'F' } as ContactField,
    T('birthplace', 'Naturalidade', 100, { only: 'F' }), T('father_name', 'Nome do Pai', 200, { only: 'F' }), T('father_cpf', 'CPF do Pai', 20, { only: 'F' }),
    T('mother_name', 'Nome da Mãe', 200, { only: 'F' }), T('mother_cpf', 'CPF da Mãe', 20, { only: 'F' }), T('suframa', 'Inscrição Suframa', 9, { only: 'J' })],
  financeiro: [T('payment_condition', 'Condição de pagamento', 100, { hint: 'Número de parcelas ou prazos. Exemplo 30, 60, 3x ou 15 + 2x' })],
  observacoes: [{ key: 'notes', label: 'Observações', max: 4000, kind: 'textarea' } as ContactField],
} as const satisfies Record<string, readonly ContactField[]>;
export const CONTACT_FORM_FIELDS: readonly ContactField[] = Object.values(SECTION_FIELDS).flat();
/** Fields kept outside the simple inputs: Situação, IE Isento, Limite de crédito, referências e listas. */
export const SPECIAL_KEYS = ['situation', 'ie_exempt', 'credit_limit_mode', 'credit_limit', 'finance_category_id', 'operation_nature_id', 'seller_id', 'types', 'persons'] as const;
// Only for these person types (others send null), as the server refuses them elsewhere.
export const PERSON_ONLY: Record<string, PersonType> = Object.fromEntries([...CONTACT_FORM_FIELDS.filter(f => f.only).map(f => [f.key, f.only!]), ['ie_exempt', 'J']]);
export const fieldVisible = (key: string, personType: string) => !PERSON_ONLY[key] || PERSON_ONLY[key] === personType;

// Preferência "Campos obrigatórios para clientes e fornecedores" (Origin PR-05): option id → field key.
export const REQUIRED_OPTION_FIELDS: Record<string, string> = { carga_media: 'avg_tax_load', bairro: 'district', bairro_cobranca: 'billing_district', celular: 'mobile', cep: 'postal_code',
  cep_cobranca: 'billing_postal_code', cidade: 'city', cidade_cobranca: 'billing_city', cliente_desde: 'client_since', cnpj: 'document', complemento: 'complement',
  complemento_cobranca: 'billing_complement', condicao_pagamento: 'payment_condition', informacoes_contato: 'contact_info', cpf_mae: 'mother_cpf', cpf_pai: 'father_cpf',
  data_nascimento: 'birth_date', email: 'email', email_nfe: 'nfe_email', endereco: 'street', endereco_cobranca: 'billing_street', numero: 'number', numero_cobranca: 'billing_number',
  fantasia: 'trade_name', fax: 'fax', fone: 'phone', natureza_operacao: 'operation_nature_id', inscricao_estadual: 'ie', inscricao_municipal: 'municipal_registration',
  inscricao_suframa: 'suframa', limite_credito: 'credit_limit_mode', naturalidade: 'birthplace', nome_mae: 'mother_name', nome_pai: 'father_name', pais: 'country', observacoes: 'notes',
  orgao_emissor: 'rg_issuer', profissao: 'profession', proxima_visita: 'next_visit', rg: 'rg', website: 'website', skype: 'skype', uf_exterior_cobranca: 'billing_foreign_state', uf_exterior: 'foreign_state' };
export const requiredFields = (options: readonly string[]) => [...new Set(options.map(option => REQUIRED_OPTION_FIELDS[option]).filter(Boolean))];
/** Whether a required field applies to the person type shown (the Origin form only asks what it shows). */
export function requiredApplies(key: string, values: Record<string, string>) {
  if (!fieldVisible(key, values.person_type ?? '')) return false;
  return !(key === 'ie' && values.ie_exempt === 'true');
}

/** Today in São Paulo as YYYY-MM-DD (Cliente desde). */
export const saoPauloToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
const TEXT_KEYS = CONTACT_FORM_FIELDS.map(field => field.key);
/** Values of the form (all strings; IE Isento "true"/""; types and persons apart). Origin CF-48 defaults for a new contact. */
export function contactFormValues(record: ContactRecord | null, today = saoPauloToday()): Record<string, string> {
  const values: Record<string, string> = Object.fromEntries(TEXT_KEYS.map(key => [key, typeof record?.[key] === 'string' ? record[key] as string : '']));
  values.situation = record?.situation && record.situation !== 'E' ? record.situation : record?.situation ?? 'A';
  values.ie_exempt = record?.ie_exempt ? 'true' : '';
  values.credit_limit_mode = record?.credit_limit_mode ?? 'unlimited';
  values.credit_limit = typeof record?.credit_limit === 'string' ? record.credit_limit.replace('.', ',') : '';
  for (const key of ['finance_category_id', 'operation_nature_id', 'seller_id']) values[key] = typeof record?.[key] === 'string' ? record[key] as string : '';
  if (typeof record?.avg_tax_load === 'string') values.avg_tax_load = record.avg_tax_load.replace('.', ',');
  if (!record) Object.assign(values, { person_type: 'F', taxpayer: '9', client_since: today, situation: 'A', credit_limit_mode: 'unlimited' });
  return values;
}

const EMAIL = /^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const emailListValid = (value: string, max: number) => !value || (value.length <= max && value.split(/\s*[;,]\s*/).every(part => EMAIL.test(part)));
export function isoDateValid(value: string) {
  const match = DATE.exec(value); if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31';
}
/** Same grammar as erp_catalog.payment_condition_valid: 30 | 30 60 90 (também , ; /) | 3x | 15 + 2x. */
export function paymentConditionValid(text: string) {
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!value) return true;
  if (value.length > 100) return false;
  const entry = /^(\d{1,4}) ?\+ ?(\d{1,3}) ?x$/.exec(value), equal = /^(\d{1,3}) ?x$/.exec(value);
  if (entry) return Number(entry[2]) >= 1 && Number(entry[2]) <= 119 && Number(entry[1]) <= 3650;
  if (equal) return Number(equal[1]) >= 1 && Number(equal[1]) <= 120;
  if (!/^\d{1,4}(?:(?: ?[,;/] ?| )\d{1,4})*$/.test(value)) return false;
  const days = value.split(/ ?[,;/] ?| /).map(Number);
  return days.length <= 120 && days.every((day, index) => day <= 3650 && (index === 0 || day >= days[index - 1]!));
}
const decimal = (value: string, scale: number) => value.trim().replace(',', '.');
const fail = (field: string, message: string): never => { throw new CatalogValidationError(field, message); };
const labelOf = (key: string) => CONTACT_FORM_FIELDS.find(field => field.key === key)?.label ?? ({ seller_id: 'Vendedor', operation_nature_id: 'Natureza de Operação Padrão', finance_category_id: 'Categoria', credit_limit_mode: 'Limite de crédito',
  credit_limit: 'Limite de crédito', situation: 'Situação', ie_exempt: 'IE Isento', types: 'Tipo de contato', persons: 'Pessoas de contato', roles: 'Tipo de contato' } as Record<string, string>)[key] ?? key;
/** Origin label of a contact field (the field a refusal of the server names). */
export const contactFieldLabel = (key: string) => labelOf(key);

/**
 * Payload of the whole form (every key, empty → null), with the fields of other person types cleared, as the server
 * expects. `previous` decides which legacy values are only checked when changed (e-mail and UF copied from Origin).
 */
export function contactPayload(values: Record<string, string>, types: readonly string[], persons: readonly string[], { required = [], previous = null, today = saoPauloToday() }: { required?: readonly string[]; previous?: ContactRecord | null; today?: string } = {}) {
  const type = values.person_type ?? '', data: Record<string, unknown> = {};
  for (const field of CONTACT_FORM_FIELDS) {
    let value = (values[field.key] ?? '').trim();
    if (!fieldVisible(field.key, type)) value = '';
    if (field.key === 'state' || field.key === 'billing_state') value = value.toUpperCase();
    if (value.length > field.max) fail(field.key, `Confira o campo ${field.label}: até ${field.max} caracteres.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (field.kind !== 'textarea' && field.key !== 'contact_info' && /[\n\r\t]/.test(value))) fail(field.key, `Confira o campo ${field.label}.`);
    if (field.options && value && !field.options.some(option => option.value === value)) fail(field.key, `Confira o campo ${field.label}.`);
    if (field.kind === 'date' && value && !isoDateValid(value)) fail(field.key, `Informe ${field.label} como uma data válida.`);
    data[field.key] = value || null;
  }
  if (!data.name) fail('name', 'Informe o nome do cadastro.');
  if (!data.person_type && previous?.person_type) fail('person_type', 'Escolha o Tipo da Pessoa.');
  const changed = (key: string) => (data[key] ?? null) !== (typeof previous?.[key] === 'string' ? previous[key] : null);
  if (changed('email') && !emailListValid(String(data.email ?? ''), 254)) fail('email', 'Informe e-mails válidos, separados por ; ou ,.');
  if (!emailListValid(String(data.nfe_email ?? ''), 60)) fail('nfe_email', 'Informe um e-mail válido para envio da NF-e, com até 60 caracteres.');
  if (data.website && !/^(https?:\/\/)?[^\s/?#]+\.[^\s]+$/i.test(String(data.website))) fail('website', 'Informe o WebSite como no exemplo: https://www.seusite.com.br');
  if (data.payment_condition && !paymentConditionValid(String(data.payment_condition))) fail('payment_condition', 'Informe a condição como no Origin: 30, 60, 3x ou 15 + 2x.');
  if (data.suframa && !/^\d{8,9}$/.test(String(data.suframa))) fail('suframa', 'Informe a Inscrição Suframa com 8 ou 9 dígitos.');
  if (data.birth_date && String(data.birth_date) > today && changed('birth_date')) fail('birth_date', 'A Data Nascimento não pode ser futura.');
  for (const key of ['state', 'billing_state']) if (data[key] && changed(key) && !UF_OPTIONS.includes(data[key] as typeof UF_OPTIONS[number])) fail(key, 'Escolha uma UF válida.');
  if (data.avg_tax_load) {
    const value = decimal(String(data.avg_tax_load), 2);
    if (!/^(0|[1-9]\d?|100)(\.\d{1,2})?$/.test(value) || Number(value.split('.')[0]) > 100 || (value.startsWith('100') && /[1-9]/.test(value.slice(4)))) fail('avg_tax_load', 'Informe o % carga média entre 0 e 100, com até duas casas decimais.');
    data.avg_tax_load = value;
  }
  const ieExempt = type === 'J' && values.ie_exempt === 'true';
  if (ieExempt) data.ie = null;
  data.ie_exempt = ieExempt;
  data.situation = ['A', 'I', 'S'].includes(values.situation ?? '') ? values.situation : 'A';
  const mode = ['unlimited', 'zero', 'value'].includes(values.credit_limit_mode ?? '') ? values.credit_limit_mode : 'unlimited';
  data.credit_limit_mode = mode;
  if (mode === 'value') {
    const value = decimal(values.credit_limit ?? '', 2);
    if (!/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(value) || !/[1-9]/.test(value)) fail('credit_limit', 'Para definir um limite de crédito, informe um valor maior que zero.');
    data.credit_limit = value;
  } else data.credit_limit = null;
  for (const key of ['finance_category_id', 'operation_nature_id', 'seller_id']) data[key] = values[key] || null;
  data.types = [...types]; data.persons = [...persons];
  for (const key of required) {
    if (!requiredApplies(key, values)) continue;
    const missing = key === 'credit_limit_mode' ? data.credit_limit_mode === 'unlimited' : data[key] === null || data[key] === '';
    if (missing) fail(key, `O campo ${labelOf(key)} é obrigatório (Preferências > Configurações de clientes e fornecedores).`);
  }
  return data;
}
/** Contribuinte suggested by IE Isento (Origin: marking it suggests 2). */
export const suggestedTaxpayer = (ieExempt: boolean, current: string) => ieExempt && current === '9' ? '2' : current;
