export function decimal(value, { signed = false, places = 6 } = {}) {
  const v = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (
    !new RegExp(`^${signed ? "-?" : ""}\\d+(?:\\.\\d{1,${places}})?$`).test(v)
  )
    throw new Error(
      `Informe um número válido, com até ${places} casas decimais.`,
    );
  return v;
}
export const currency = (value, maximumFractionDigits = 2) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: 2,
        maximumFractionDigits,
      }).format(String(value));
export const quantity = (value) =>
  value === null || value === undefined
    ? "—"
    : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 }).format(
        String(value),
      );
export const date = (value) =>
  !value
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
      }).format(
        new Date(String(value).length === 10 ? `${value}T12:00:00Z` : value),
      );
const messages = {
  CNPJ_INVALID: "Informe um CNPJ válido, com 14 caracteres e sem pontuação.",
  COMPANY_DOCUMENT_NOT_CONFIGURED:
    "Cadastre o CNPJ da empresa em Sua instalação antes de importar documentos.",
  PRIVATE_STORAGE_NOT_CONFIGURED:
    "Configure o armazenamento privado da instalação antes de importar documentos.",
  CNAB_ACCOUNT_INVALID: "Confira a agência, a conta e seu dígito verificador.",
  CNAB_NUMERIC_CNPJ_INVALID: "Informe um CNPJ numérico válido.",
  CNAB_COMPANY_DOCUMENT_MISMATCH:
    "O CNPJ do perfil deve coincidir com o CNPJ da empresa.",
  CNAB_PROFILE_INVALID: "Confira os dados do perfil bancário e as declarações.",
  INSUFFICIENT_STOCK: "O estoque disponível é insuficiente para esta operação.",
  INSUFFICIENT_STOCK_FOR_REVERSAL:
    "Não há saldo disponível suficiente para estornar este recebimento.",
  STOCK_RANGE_INVALID: "O estoque mínimo não pode ser maior que o máximo.",
  FINANCE_ALREADY_POSTED: "Este pedido já tem um lançamento financeiro ativo.",
  ALREADY_EXISTS: "Já existe um cadastro com esta identificação.",
  PRICE_RULE_AMBIGUOUS:
    "Há regras de preço conflitantes para este pedido. Revise as regras aplicáveis.",
  LAST_ADMIN_REQUIRED: "É necessário manter pelo menos um administrador ativo.",
  COMMAND_REUSED:
    "Esta solicitação já foi usada com outros dados. Reabra o formulário e confira o registro antes de continuar.",
  UPDATER_UNAVAILABLE:
    "O atualizador local está indisponível. Verifique o serviço na instalação.",
  INVALID_USER:
    "Confira os dados da conta, a senha e as permissões selecionadas.",
};
export function readableError(error) {
  if (messages[error?.code]) return messages[error.code];
  if (error?.status === 401)
    return "Sua sessão expirou. Entre novamente para continuar.";
  if (error?.status === 403) return "Seu acesso não permite esta operação.";
  if (error?.status === 409)
    return "Este registro foi alterado ou a operação já foi realizada. Atualize os dados antes de tentar novamente.";
  return error?.message || "Não foi possível concluir. Tente novamente.";
}
export const labels = {
  xml_available: "XML importado",
  pending_homologation: "Pendente de homologação",
  fulfilled: "Entregue",
  queued: "Na fila",
  running: "Em execução",
  complete: "Concluído",
  unavailable: "Indisponível",
  interrupted: "Interrompido",
  draft: "Rascunho",
  confirmed: "Confirmado",
  partial: "Parcial",
  partially_received: "Recebido em parte",
  received: "Recebido",
  completed: "Concluído",
  open: "Em aberto",
  paid: "Pago",
  cancelled: "Cancelado",
  customer: "Cliente",
  supplier: "Fornecedor",
  both: "Cliente e fornecedor",
  sale: "Venda",
  purchase: "Compra",
  pending: "Pendente",
  processing: "Processando",
  available: "Disponível",
  unsupported: "Não disponível",
  not_configured: "Configuração pendente",
  ready: "Pronto",
  failed: "Falhou",
  success: "Concluído",
  idle: "Aguardando",
};
export const label = (value) => labels[value] || value || "—";
