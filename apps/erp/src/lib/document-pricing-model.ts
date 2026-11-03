// 202610200196 helpers of the document editor: the Código no fornecedor lookup of the pedido de compra and the message of the
// automatic lançamento de contas (Preferências › Vendas › Vendas) returned by a save or a change of situação.
import type { DocumentInput } from './real-documents-model.ts';
import type { ImportDraft } from './document-xml-import-model.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const supplierCodesPath = (contactId: string, productIds: readonly string[]) =>
  `/v1/documentos/purchase_orders/codigos-fornecedor?${new URLSearchParams({ contact_id: contactId, produtos: productIds.join(',') })}`;
/** GET …/codigos-fornecedor: product id → Código no fornecedor of that fornecedor (only the products that have one). */
export function readSupplierCodes(value: unknown, contactId: string): Map<string, string> {
  const page = value as { contact_id?: unknown; items?: unknown } | null;
  if (!page || page.contact_id !== contactId || !Array.isArray(page.items) || page.items.length > 250) throw new Error('SUPPLIER_CODES_INVALID');
  return new Map((page.items as { product_id?: unknown; code?: unknown }[]).map(item => {
    if (!item || !UUID.test(String(item.product_id)) || typeof item.code !== 'string' || !item.code.trim() || item.code.length > 60) throw new Error('SUPPLIER_CODES_INVALID');
    return [String(item.product_id), item.code.trim()];
  }));
}

// Reasons the server gives when nothing was posted (the document is saved anyway).
const REASONS: Record<string, string> = {
  erp_finance_access_denied: 'seu perfil não lança contas; peça ao financeiro para usar Lançar contas no pedido.',
  // Financeiro lane (SQL 246): Sistema › Usuários › Permissões › Vendas › Pedidos de venda › Lançar contas.
  erp_finance_permission_denied: 'seu usuário não tem a permissão de lançar contas dos pedidos de venda (Sistema › Usuários › Permissões).',
  erp_document_finance_zero_total: 'o pedido não tem valor a lançar.',
  erp_finance_invalid_contact: 'o cliente está inativo ou não é um contato.',
  erp_finance_invalid_category: 'a categoria do pedido não pode ser usada nas contas.',
  erp_document_finance_invalid_installment: 'uma parcela vence antes da data do pedido.',
  erp_finance_installment_total_mismatch: 'a soma das parcelas difere do total do pedido.',
  erp_document_finance_account_unavailable: 'a conta financeira do Destino está inativa.',
};
// 202610200267: the pedido de compra (Preferências › Suprimentos "Automação lançamento de contas pagar ao criar novo pedido de compra").
const PURCHASE_REASONS: Record<string, string> = {
  ...REASONS,
  erp_finance_permission_denied: 'seu usuário não tem a permissão de lançar contas dos pedidos de compra (Sistema › Usuários › Permissões).',
  erp_finance_invalid_contact: 'o fornecedor está inativo ou não é um contato.',
  erp_document_finance_no_installments: 'o pedido não tem parcelas; gere as parcelas e use Lançar contas.',
};
/** Text of the `auto_finance` answer (null when the preference is off or the situação does not post contas). */
export function autoFinanceMessage(value: unknown, kind: 'sales_orders' | 'purchase_orders' = 'sales_orders'): string | null {
  const result = value as { outcome?: unknown; reason?: unknown } | null | undefined;
  if (!result || typeof result !== 'object') return null;
  const purchase = kind === 'purchase_orders';
  if (result.outcome === 'done') return purchase ? 'Contas a pagar lançadas automaticamente (Preferências › Suprimentos › Automação lançamento de contas pagar ao criar novo pedido de compra).'
    : 'Contas a receber lançadas automaticamente (Preferências › Vendas › Lançamento automático de contas em Pedidos de Venda).';
  if (result.outcome !== 'skipped') return null;
  const reason = typeof result.reason === 'string' ? (purchase ? PURCHASE_REASONS : REASONS)[result.reason] : undefined;
  return `As contas ${purchase ? 'a pagar ' : ''}não foram lançadas automaticamente: ${reason ?? 'confira o pedido e use Lançar contas.'}`;
}

/**
 * GET /v1/documentos/{sales_orders|service_orders}/a-partir-da-proposta/{id} (Origin vendas.php#idOrigem/<id>): the new document
 * prefilled with the proposta, opened like an imported draft; the save sends `source_proposal` and concludes the proposta.
 */
export function proposalDraft(value: unknown, kind: 'sales_orders' | 'service_orders', proposalId: string): ImportDraft {
  const page = (value ?? {}) as { kind?: unknown; source?: { id?: unknown; number?: unknown; version?: unknown }; data?: DocumentInput; contact?: { id?: unknown; name?: unknown }; price_list_name?: unknown };
  if (page.kind !== kind || page.source?.id !== proposalId || typeof page.source.number !== 'string' || !Number.isInteger(page.source.version) || !page.data || !Array.isArray(page.data.items)
    || typeof page.contact?.id !== 'string' || typeof page.contact.name !== 'string' || (page.price_list_name !== null && typeof page.price_list_name !== 'string')) throw new Error('PROPOSAL_DRAFT_INVALID');
  const data: DocumentInput = { ...page.data, items: page.data.items.map(item => ({ ...item, id: crypto.randomUUID() })) };
  const target = kind === 'sales_orders' ? 'O pedido de venda foi preenchido' : 'A ordem de serviço foi preenchida';
  return { kind, data, contact: { id: page.contact.id, name: page.contact.name }, quick: null, price_list_name: page.price_list_name ?? null,
    notices: [`${target} com a proposta nº ${page.source.number}. Confira e salve: nada foi gravado ainda, e a proposta só é concluída ao salvar.`],
    source_proposal: { id: proposalId, expected_version: page.source.version as number } };
}
