// Estoque lane, onda F (EST-024): the actions of the selection panel of Pedidos de compra and why a pedido is left out of one.
import type { DocumentListRow } from './document-list-model';
import { FINANCE_ELIGIBLE } from './document-finance-model.ts';
export type PurchaseEffectAction = 'stock-post' | 'stock-reverse' | 'finance-post' | 'finance-reverse';
export const PURCHASE_EFFECT_LABELS: Record<PurchaseEffectAction, string> = { 'stock-post': 'Lançar estoque', 'stock-reverse': 'Estornar estoque', 'finance-post': 'Lançar contas', 'finance-reverse': 'Estornar contas' };
export const PURCHASE_EFFECT_ROLES: Record<PurchaseEffectAction, string[]> = { 'stock-post': ['admin', 'estoque'], 'stock-reverse': ['admin', 'estoque'], 'finance-post': ['admin', 'financeiro'], 'finance-reverse': ['admin', 'financeiro'] };
const STOCK_STATUSES = ['in_progress', 'partially_fulfilled', 'fulfilled'];
/** Why a selected pedido is left out of the action before anything runs (the server checks everything again). */
export function purchaseEffectSkip(action: PurchaseEffectAction, row: DocumentListRow): string | null {
  if (action === 'stock-post') return row.stock_active && !row.receipt_active ? 'O estoque deste pedido foi lançado pelo documento inteiro.'
    : STOCK_STATUSES.includes(row.status) ? null : 'A situação do pedido não permite lançar o estoque (Em andamento, Atendido parcialmente ou Atendido).';
  // The batch reverses the recebimentos (225); a pedido posted as a whole (018) is reversed by its own ⋮ Estornar estoque.
  if (action === 'stock-reverse') return row.receipt_active ? null : row.stock_active ? 'O estoque deste pedido foi lançado pelo documento inteiro; use Estornar estoque do próprio pedido.'
    : 'Não há estoque lançado neste pedido.';
  if (action === 'finance-post') return row.finance_active ? 'As contas deste pedido já foram lançadas.' : FINANCE_ELIGIBLE.purchase_orders?.includes(row.status) ? null : 'A situação do pedido não permite lançar contas.';
  return row.finance_active ? null : 'Não há contas lançadas neste pedido.';
}

