// Regras do editor que o servidor também confere (202610200164): vendedor obrigatório, vendedor vinculado ao usuário
// (produtos não cadastrados e limite de desconto), casas decimais do preço (Preferências › Empresa) e Cross-Docking.
import { decimal } from '../../../../packages/erp-domain/src/index.mjs';
import { addDays } from './origin-list.ts';
import type { DocumentInput, DocumentKind, DocumentSeller, DocumentSettings, DocumentTotals } from './real-documents-model.ts';

export interface RuleProblem { message: string; invalid: string[] }
const fraction = (value: string) => { const [, decimals = ''] = value.split('.'); return decimals.replace(/0+$/, '').length; };

/** Origin "Número de casas decimais no preço nas saídas/entradas": pedidos de compra use the entradas, the others the saídas. */
export function priceDecimalsProblem(kind: DocumentKind, values: Pick<DocumentInput, 'items'>, settings: DocumentSettings | null | undefined): RuleProblem | null {
  if (!settings) return null;
  const limit = kind === 'purchase_orders' ? settings.price_decimals_in : settings.price_decimals_out;
  const invalid = values.items.flatMap((item, index) => typeof item.unit_price === 'string' && fraction(item.unit_price) > limit ? [`doc-item-price-${index}`] : []);
  return invalid.length ? { message: `O preço unitário aceita até ${limit} ${limit === 1 ? 'casa decimal' : 'casas decimais'} (Preferências › Empresa › Geral).`, invalid } : null;
}
/** 202610200287 Preferências › Empresa "Número de casas decimais na quantidade" (at most 6, the stock precision): items and lots. */
export function quantityDecimalsProblem(values: Pick<DocumentInput, 'items'>, settings: DocumentSettings | null | undefined): RuleProblem | null {
  const limit = Math.min(Math.max(settings?.quantity_decimals ?? 6, 0), 6);
  const invalid = values.items.flatMap((item, index) => typeof item.quantity === 'string' && (fraction(item.quantity) > limit || (item.lots ?? []).some(lot => fraction(lot.quantity) > limit)) ? [`doc-item-qty-${index}`] : []);
  return invalid.length ? { message: `A quantidade aceita até ${limit} ${limit === 1 ? 'casa decimal' : 'casas decimais'} (Preferências › Empresa › Geral).`, invalid } : null;
}
/** The casas decimais allowed when typing a quantity (6 before 287). */
export const quantityPlaces = (settings: DocumentSettings | null | undefined) => Math.min(Math.max(settings?.quantity_decimals ?? 6, 0), 6);
/**
 * Vendedor linked to the user (Cadastros › Vendedores): without "Permite incluir produtos não cadastrados nos pedidos de venda"
 * a pedido refuses free items; a "Limite de desconto" above zero limits the discount of each item and the total discount.
 */
export function sellerProblem(kind: DocumentKind, values: Pick<DocumentInput, 'items'>, totals: DocumentTotals | null, seller: DocumentSeller | null | undefined): RuleProblem | null {
  if (!seller || !['sales_orders', 'sales_proposals', 'service_orders'].includes(kind)) return null;
  if (kind === 'sales_orders' && !seller.allow_unregistered_products) {
    const invalid = values.items.flatMap((item, index) => item.product_id ? [] : [`doc-item-description-${index}`]);
    if (invalid.length) return { message: 'Seu cadastro de vendedor não permite incluir produtos não cadastrados nos pedidos de venda. Escolha os produtos do cadastro.', invalid };
  }
  const limit = decimal(seller.discount_limit, 4, 3);
  if (limit === 0n) return null;
  const shown = seller.discount_limit.replace(/\.?0+$/, '').replace('.', ',');
  const items = values.items.flatMap((item, index) => { try { return decimal(item.discount_percent ?? '0', 4, 3) > limit ? [`doc-item-discount-${index}`] : []; } catch { return []; } });
  let total = false;
  if (totals) { const gross = decimal(totals.gross, 2, 12), given = decimal(totals.line_discount, 2, 12) + decimal(totals.discount, 2, 12); total = gross > 0n && given * 1_000_000n > limit * gross; }
  return items.length || total ? { message: `O desconto passa do limite do vendedor (${shown}%). Reduza o desconto ${items.length ? 'dos itens destacados' : 'da venda'}.`, invalid: items.length ? items : ['doc-discount_value'] } : null;
}
/** Origin Cross-Docking (Preferências › Estoque): data prevista = data + prazo de entrega + dias de cross-docking. */
export function crossDockedDate(date: string, deliveryDays: string, crossDocking: number): string | null {
  if (!/^(0|[1-9]\d{0,3})$/.test(deliveryDays.trim()) || !/^(19|20)\d{2}-\d{2}-\d{2}$/.test(date)) return null;
  const result = addDays(date, Number(deliveryDays.trim()) + crossDocking);
  return result <= '2099-12-31' ? result : null;
}
