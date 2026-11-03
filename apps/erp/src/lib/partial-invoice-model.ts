// Leva H, lane documentos (VND-047, VND-083, VND-085): "Gerar nota fiscal parcial" do pedido de venda. A nota leva só as
// quantidades escolhidas, cada uma até o saldo do item (Resumo de faturamento); o desconto do pedido, o frete e as outras despesas
// entram na proporção do valor escolhido; as parcelas ficam de fora, porque as contas são do pedido (política da 375). O banco
// confere o saldo de novo, sob a trava do pedido, e grava o vínculo de cada item da nota com o item do pedido.
import type { OrderSource } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import type { InvoiceBalance } from '../../../../packages/erp-domain/src/sales-invoice-balance.mjs';

/** A refusal of the cut, with Origin's reason (shown as is). */
export class PartialRefusal extends Error {}
const SCALE = 1_000_000n;
/** Decimal text to an integer of 6 decimals (quantities) or cents (money). */
export const units = (value: string, decimals: number) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals)); };
const money = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const quantityText = (value: bigint) => { const whole = value / SCALE, fraction = String(value % SCALE).padStart(6, '0').replace(/0+$/, ''); return fraction ? `${whole}.${fraction}` : String(whole); };
/** Rounded a × b / c (half up), all non-negative. */
const share = (a: bigint, b: bigint, c: bigint) => c === 0n ? 0n : (a * b * 2n + c) / (2n * c);
export const quantity4 = (value: string) => { const v = units(value, 4); return `${v / 10000n}.${String(v % 10000n).padStart(4, '0')}`; };

export interface PartialPick { position: number; quantity: string }
/** Validates the quantities typed for each item against the balance; null when they are fine, otherwise the message. */
export function picksProblem(balance: InvoiceBalance, picks: readonly PartialPick[]): string | null {
  if (balance.full_invoice_id) return 'O pedido já tem uma nota fiscal completa; não há saldo para nota parcial.';
  if (!picks.length) return 'Informe a quantidade de pelo menos um item.';
  for (const pick of picks) {
    const item = balance.items.find(i => i.position === pick.position);
    if (!item) return 'Um item escolhido não pertence ao pedido.';
    if (!/^\d{1,11}(\.\d{1,4})?$/.test(pick.quantity) || units(pick.quantity, 4) <= 0n) return `Item ${pick.position}: informe uma quantidade maior que zero, com até 4 casas decimais.`;
    if (units(pick.quantity, 4) > units(item.remaining, 4)) return `Item ${pick.position}: a quantidade passa do saldo a faturar (${item.remaining.replace(/\.?0+$/, '')}).`;
  }
  return null;
}

/** The pedido source cut to the chosen quantities (the same reasons, except that the pedido already has notes, still refuse). */
export function cutSource(source: OrderSource, picks: readonly PartialPick[]): OrderSource {
  const others = source.reasons.filter(r => r.code !== 'has_invoice');
  if (others.length) throw new PartialRefusal('O pedido não pode gerar nota: ' + others.map(r => r.code).join(', ') + '.');
  const chosen = picks.map(pick => {
    const item = source.items.find(i => i.position === pick.position);
    if (!item) throw new PartialRefusal('Um item escolhido não está mais no pedido.');
    const ordered = units(item.quantity, 6), picked = units(pick.quantity, 6);
    if (picked <= 0n || picked > ordered) throw new PartialRefusal(`Item ${pick.position}: quantidade fora do pedido.`);
    const gross = share(units(item.unit_price, 6), picked, SCALE * 10000n);
    const discount = share(units(item.discount, 2), picked, ordered);
    return { ...item, quantity: quantityText(picked), gross: money(gross), discount: money(discount), total: money(gross - discount) };
  });
  const net = (items: readonly OrderSource['items'][number][]) => items.reduce((sum, i) => sum + units(i.gross, 2) - units(i.discount, 2), 0n);
  const allNet = net(source.items), pickedNet = net(chosen);
  const t = source.totals, gross = chosen.reduce((s, i) => s + units(i.gross, 2), 0n), lineDiscount = chosen.reduce((s, i) => s + units(i.discount, 2), 0n);
  const discount = share(units(t.discount, 2), pickedNet, allNet), freight = share(units(t.freight, 2), pickedNet, allNet), other = share(units(t.other_expenses, 2), pickedNet, allNet);
  return { ...source, eligible: true, reasons: [], existing_invoice: null, items: chosen.map((item, index) => ({ ...item, position: index + 1 })), installments: [],
    totals: { gross: money(gross), line_discount: money(lineDiscount), discount: money(discount), freight: money(freight), other_expenses: money(other), total: money(gross - lineDiscount - discount + freight + other) } };
}

