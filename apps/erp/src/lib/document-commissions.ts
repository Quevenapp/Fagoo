// 202610200288 aba "Comissões" dos itens (Origin: pedido de venda "#, Descrição, Base, Adicionais da base, Alq (%), Valor comissão";
// OS "Base / Alq. % / Valor comissão"): the commission of each item by the rule of the vendedor (Cadastros › Vendedores: fixa, or the
// band of the discount of the item) and the Adicionais da base (Preferências › Vendas: Desconto subtracts, Frete adds, spread over the
// items by their totals). Read-only, as Financeiro › Comissões computes when the contas are lançadas. Cents as BigInt, never floats.
import type { DocumentKind, DocumentTotals } from '../../../../packages/erp-domain/src/index.mjs';

export type CommissionAddition = 'desconto' | 'frete' | 'icms_st' | 'ipi' | 'taxas_pagamento';
export interface SellerCommission { seller_id: string; mode: 'fixa' | 'descontos'; rate: string | null; bands: { discount_up_to: string; rate: string }[]; additions: CommissionAddition[] }
export interface ItemCommission { index: number; base: string; additions: string; rate: string; value: string }
export const COMMISSION_KINDS: readonly DocumentKind[] = ['sales_orders', 'service_orders'];
const PERCENT = /^(0|[1-9]\d{0,2})\.\d{4}$/;
export const commissionPath = (kind: DocumentKind, sellerId: string) => `/v1/documentos/${kind}/comissao?${new URLSearchParams({ vendedor: sellerId })}`;
export function readSellerCommission(value: unknown, sellerId: string): SellerCommission {
  const v = value as SellerCommission | null;
  if (!v || typeof v !== 'object' || v.seller_id !== sellerId || !['fixa', 'descontos'].includes(v.mode) || (v.rate !== null && !PERCENT.test(v.rate)) || !Array.isArray(v.bands)
    || v.bands.some(band => !PERCENT.test(band?.discount_up_to ?? '') || !PERCENT.test(band?.rate ?? '')) || !Array.isArray(v.additions)) throw new Error('Resposta inválida da comissão.');
  return v;
}
const cents = (value: string | undefined) => { if (!value || !/^\d+\.\d{2}$/.test(value)) return 0n; const [whole, fraction] = value.split('.'); return BigInt(whole!) * 100n + BigInt(fraction!); };
const rate4 = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4)); };
const money = (value: bigint) => { const negative = value < 0n, abs = negative ? -value : value; return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`; };
const percentText = (value: bigint) => `${value / 10_000n}.${String(value % 10_000n).padStart(4, '0')}`;
const half = (numerator: bigint, denominator: bigint) => numerator >= 0n ? (numerator + denominator / 2n) / denominator : -((-numerator + denominator / 2n) / denominator);
/** The rate of an item: the fixed rate of the vendedor, or the first band whose "Desconto de até" covers the discount of the item. */
export function itemRate(rule: SellerCommission, discountPercent: string | undefined): bigint {
  if (rule.mode === 'fixa') return rule.rate ? rate4(rule.rate) : 0n;
  const discount = rate4(/^\d+(\.\d+)?$/.test(discountPercent ?? '') ? discountPercent! : '0');
  const band = rule.bands.find(row => discount <= rate4(row.discount_up_to));
  return band ? rate4(band.rate) : 0n;
}
/** One row per item; the Adicionais da base are spread by the item totals with cumulative rounding (they add up to the document). */
export function itemCommissions(items: readonly { discount_percent?: string }[], totals: DocumentTotals | null, rule: SellerCommission): ItemCommission[] {
  if (!totals || totals.items.length !== items.length) return [];
  const bases = totals.items.map(line => cents(line.total)), sum = bases.reduce((total, value) => total + value, 0n);
  // 370: ICMS ST and IPI add when marked; Taxas de pagamento is only known by the parcelas, so the estimate of the items leaves it out.
  const extra = (rule.additions.includes('desconto') ? -cents(totals.discount) : 0n) + (rule.additions.includes('frete') ? cents(totals.freight) : 0n)
    + (rule.additions.includes('icms_st') ? cents(totals.icms_st) : 0n) + (rule.additions.includes('ipi') ? cents(totals.ipi) : 0n);
  let before = 0n, done = 0n;
  return items.map((item, index) => {
    before += bases[index]!;
    const upto = sum > 0n ? half(extra * before, sum) : 0n, share = upto - done; done = upto;
    const rate = itemRate(rule, item.discount_percent), base = bases[index]!;
    const value = half((base + share) * rate, 1_000_000n);
    return { index, base: money(base), additions: money(share), rate: percentText(rate), value: money(value < 0n ? 0n : value) };
  });
}

// 202610210370 (leva H): the commission frozen on the operation at the commercial confirmation (pedido Verificado, OS Aprovada...):
// regra, política da base, base and percentual of that moment, the adjustments (devolução, cancelamento) and the eligible amount.
export const COMMISSION_RULE_LABELS: Record<CommissionOperation['rule'], string> = { parcial: 'Parcial, conforme o recebimento', faturamento: 'Integral no faturamento', primeira_parcela: 'Após a primeira parcela', ultima_parcela: 'Após a última parcela' };
export const COMMISSION_ADDITION_LABELS: Record<CommissionAddition, string> = { desconto: 'Desconto', frete: 'Frete', icms_st: 'ICMS ST', ipi: 'IPI', taxas_pagamento: 'Taxas de pagamento' };
export interface CommissionOperation {
  id: string; document_id: string; state: 'active' | 'superseded' | 'cancelled'; rule: 'parcial' | 'faturamento' | 'primeira_parcela' | 'ultima_parcela';
  policy: { version: 1; base: 'itens_liquidos'; additions: CommissionAddition[] }; rate: string; base_cents: string; estimated_cents: string; adjusted_cents: string; net_cents: string;
  total_cents: string; received_cents: string; eligible_cents: string; titles: number; confirmed_on: string;
  adjustments: { kind: 'return' | 'cancel'; amount_cents: string; occurred_on: string; note: string }[];
}
export interface FrozenCommission { operation: CommissionOperation | null; items: { position: number; description: string; item_cents: string; base_cents: string; commission_cents: string }[] }
export const operationPath = (kind: DocumentKind, documentId: string) => `/v1/documentos/${kind}/${documentId}/comissao`;
const CENTS = /^-?\d{1,15}$/;
export function readFrozenCommission(value: unknown, documentId: string): FrozenCommission {
  const v = value as (FrozenCommission & { document_id?: string }) | null;
  const o = v?.operation;
  if (!v || typeof v !== 'object' || v.document_id !== documentId || !Array.isArray(v.items)
    || (o !== null && (!o || typeof o !== 'object' || o.document_id !== documentId || !(o.rule in COMMISSION_RULE_LABELS) || !/^\d{1,3}\.\d{4}$/.test(o.rate ?? '')
      || ['base_cents', 'estimated_cents', 'adjusted_cents', 'net_cents', 'received_cents', 'total_cents', 'eligible_cents'].some(key => !CENTS.test((o as unknown as Record<string, string>)[key] ?? ''))
      || !Array.isArray(o.adjustments) || !Array.isArray(o.policy?.additions)))
    || v.items.some(item => !item || !CENTS.test(item.base_cents ?? '') || !CENTS.test(item.commission_cents ?? ''))) throw new Error('Resposta inválida da comissão da venda.');
  return { operation: o, items: v.items };
}
/** Cents as reais with two decimals ("4500" → "45.00"), for decimalMoney. */
export const centsDecimal = (value: string) => money(BigInt(value));
