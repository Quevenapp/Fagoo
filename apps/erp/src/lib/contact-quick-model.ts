import { CatalogValidationError } from './catalog-base.ts';
import { contactFieldLabel, emailListValid, isoDateValid, requiredApplies, saoPauloToday } from './contact-form-model.ts';
import { quickContactPayload, type QuickContactValues } from './document-editor-pickers.ts';
import type { DocumentKind } from './real-documents-model';

// "Contato rápido" completo do Origin (pedidos, propostas, notas e financeiro; contatos onda C): grava pela rota de
// Clientes e fornecedores (/v1/cadastros/contatos), que aplica as Preferências (código sequencial, CPF/CNPJ duplicado,
// campos obrigatórios) e a carteira do vendedor. As regras do contato rápido antigo continuam valendo para os campos dele.
export const QUICK_SITUATIONS = [{ value: 'A', label: 'Ativo' }, { value: 'I', label: 'Inativo' }, { value: 'S', label: 'Sem movimento' }] as const;
export const QUICK_TAXPAYERS = [{ value: '1', label: '1 - Contribuinte ICMS' }, { value: '2', label: '2 - Contribuinte isento de Inscrição no Cadastro de Contribuintes' },
  { value: '9', label: '9 - Não contribuinte' }] as const;
/** Fields of the full quick contact beyond the legacy ones (Origin CQ-02 a CQ-06). */
export const QUICK_FULL_TEXT = { country: ['País', 60], rg: ['RG', 20], nfe_email: ['E-Mail para envio da NFe', 60], contact_info: ['Informações do contato', 400], notes: ['Observações', 4000] } as const;
const fail = (field: string, message: string): never => { throw new CatalogValidationError(field, message); };
/** Fields of the quick contact that "Campos obrigatórios" can demand here; the others are checked by the server. */
export const QUICK_REQUIRABLE = ['trade_name', 'document', 'ie', 'country', 'birth_date', 'rg', 'postal_code', 'city', 'district', 'street', 'number', 'complement', 'email', 'nfe_email', 'mobile', 'phone', 'contact_info', 'notes'];
/** Whether a field of the quick contact is required by the Preferências for this Tipo da Pessoa (marked with *). */
export const quickRequired = (required: readonly string[], key: string, personType: string) => QUICK_REQUIRABLE.includes(key) && required.includes(key) && requiredApplies(key, { person_type: personType, ie_exempt: '' });

/** Body of POST /v1/cadastros/contatos for the quick contact: the legacy checks, then the Origin fields of the full form. */
export function quickContactFullPayload(kind: DocumentKind, values: QuickContactValues, today = saoPauloToday(), required: readonly string[] = []) {
  const legacy = quickContactPayload(kind, values).data as Record<string, unknown>;
  const { roles, ...data } = legacy;
  const type = values.person_type, situation = values.situation ?? 'A', taxpayer = values.taxpayer ?? '9';
  if (!QUICK_SITUATIONS.some(option => option.value === situation)) fail('situation', 'Escolha a situação do cadastro.');
  if (!QUICK_TAXPAYERS.some(option => option.value === taxpayer)) fail('taxpayer', 'Escolha o Contribuinte.');
  const extra: Record<string, string | null> = {};
  for (const [key, [label, max]] of Object.entries(QUICK_FULL_TEXT)) {
    const value = (values[key as keyof typeof QUICK_FULL_TEXT] ?? '').trim();
    if (value.length > max) fail(key, `Confira o campo ${label}: até ${max} caracteres.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!['notes', 'contact_info'].includes(key) && /[\n\r\t]/.test(value))) fail(key, `Confira o campo ${label}.`);
    extra[key] = value || null;
  }
  if (!emailListValid(extra.nfe_email ?? '', 60)) fail('nfe_email', 'Informe um e-mail válido para envio da NF-e, com até 60 caracteres.');
  const birth = (values.birth_date ?? '').trim();
  if (birth && (!isoDateValid(birth) || birth > today)) fail('birth_date', 'Informe a Data Nascimento como uma data válida, que não seja futura.');
  // Fields of one Tipo da Pessoa only (the server refuses them elsewhere): País for Estrangeiro, RG and nascimento for PF.
  const result: Record<string, unknown> = { ...data, situation, taxpayer, ...extra, country: type === 'E' ? extra.country : null, rg: type === 'F' ? extra.rg : null,
    birth_date: type === 'F' && birth ? birth : null, types: roles };
  for (const key of QUICK_REQUIRABLE) if (quickRequired(required, key, type) && (result[key] === null || result[key] === '' || result[key] === undefined))
    fail(key, `O campo ${contactFieldLabel(key)} é obrigatório (Preferências › Configurações de clientes e fornecedores).`);
  return { data: result };
}
