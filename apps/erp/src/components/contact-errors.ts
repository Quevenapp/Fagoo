import { contactFieldLabel } from '../lib/contact-form-model.ts';

// Specific refusals of the contact routes (contatos, onda C): the API sends an allow-listed code and, when it names one,
// the field. These messages replace the generic "Confira os campos" of the status. Duck-typed on purpose: every screen
// and its tests may carry their own AccessError class.
type Refusal = { status?: unknown; code?: unknown; field?: unknown };
const PAYMENT_LABELS: Record<string, string> = { description: 'Descrição', payment_type: 'Tipo de pagamento', condition: 'Condição de pagamento', account_id: 'Conta financeira', card_cnpj: 'CNPJ credenciadora',
  pix_cnpj: 'CNPJ da instituição de pagamento', fee_fixed: 'Valor fixo', fee_rate: 'Valor alíquota', settlement_days: 'Prazo de recebimento', interest_rate: 'Juros mensal', fine_rate: 'Multa' };
/** Field named by a specific refusal, when it is a contact field. */
export const refusalField = (error: unknown): string | null => {
  const value = error as Refusal | null;
  return value && typeof value === 'object' && typeof value.field === 'string' && /^[a-z_]{1,40}$/.test(value.field) && typeof value.code === 'string' && value.code.startsWith('ERP_CONTACT_') ? value.field : null;
};
/** Origin-like message of a specific refusal, or null for a generic one (the caller keeps its own text). */
export function contactRefusalText(error: unknown): string | null {
  const value = error as Refusal | null;
  if (!value || typeof value !== 'object' || typeof value.code !== 'string') return null;
  const field = typeof value.field === 'string' ? value.field : '';
  switch (value.code) {
    case 'ERP_CONTACT_REQUIRED_FIELD': return field ? `O campo ${contactFieldLabel(field)} é obrigatório (Preferências › Configurações de clientes e fornecedores).` : 'Preencha os campos obrigatórios do cadastro.';
    case 'ERP_CONTACT_INVALID_FIELD': return field ? `Confira o campo ${contactFieldLabel(field)}: o valor não foi aceito.` : 'Confira os campos informados antes de tentar novamente.';
    case 'ERP_CONTACT_DUPLICATE_DOCUMENT': return 'Este CPF/CNPJ já está cadastrado em outro contato e as Preferências não permitem CPF / CNPJ duplicado.';
    case 'ERP_CONTACT_NOT_VISIBLE': return 'Este contato não pertence à carteira do seu vendedor (Preferências › Contato acessível somente ao vendedor vinculado).';
    case 'ERP_CONTACT_DELETED': return 'Cadastro excluído. Restaure-o na listagem com “Restaurar selecionados” antes de editar.';
    case 'ERP_CONTACT_EXPORT_TOO_LARGE': return 'A operação é limitada a 10.000 contatos. Refine os filtros.';
    case 'ERP_CONTACT_PERIOD_TOO_LONG': return 'O período pode ter no máximo 366 dias.';
    case 'ERP_CONTACT_IMPORT_INVALID_ROWS': return 'O lote tem linhas recusadas e nada dele foi importado. Valide a planilha de novo e importe só as linhas válidas.';
    case 'ERP_CONTACT_CODE_USED': return 'O próximo número precisa ser maior que o maior código numérico já usado.';
    case 'ERP_CONTACT_TYPE_EXISTS': return 'Já existe um tipo de contato com este nome.';
    case 'ERP_CONTACT_COMMENT_LIMIT': return 'Este contato chegou ao limite de 1.000 comentários.';
    case 'ERP_SELLER_USER_TAKEN': return 'Este usuário do sistema já está vinculado a outro vendedor.';
    case 'ERP_SELLER_EXISTS': return 'Este contato já é vendedor.';
    case 'ERP_SELLER_INVALID_USER': return 'O usuário do sistema escolhido não está mais ativo. Escolha outro usuário.';
    case 'ERP_EMPLOYEE_CPF_EXISTS': return 'Já existe um funcionário com este CPF.';
    case 'ERP_EMPLOYEE_INVALID_FIELD': return 'Confira os dados do funcionário: um dos campos não foi aceito.';
    case 'ERP_PAYMENT_METHOD_INACTIVE': return 'Ative a forma de pagamento antes de torná-la padrão.';
    case 'ERP_PAYMENT_METHOD_INVALID_FIELD': return PAYMENT_LABELS[field] ? `Confira o campo ${PAYMENT_LABELS[field]}: o valor não foi aceito.` : 'Confira os campos da forma de pagamento: um deles não foi aceito.';
    default: return null;
  }
}
