import { useEffect, useMemo, useState } from 'react';
import { decimalMoney, type AccessController } from '../lib/real-access';
import { ESTIMATE_MAX_ITEMS, estimateResult, estimateSearch, type EstimateResult } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import './fiscal-invoices.css';
import type { DocumentItemInput, DocumentTotals } from '../lib/real-documents-model';

const REASONS: Record<string, string> = {
  no_nature: 'Cadastre a natureza de operação "Padrão venda" (ou a natureza do contato) para estimar o IPI e o ICMS ST.',
  regime: 'A natureza de operação não é do regime tributário da empresa: o IPI e o ICMS ST não foram estimados.',
  quantity_precision: 'A estimativa usa quantidades com até 4 casas decimais, como a nota fiscal.',
  invalid: 'Confira os valores do documento para estimar o IPI e o ICMS ST.',
  no_items: '',
};
const cents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2)); };
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

/**
 * "Total do IPI" e "Total do ICMS ST" de pedidos de venda e propostas comerciais (Origin: Tributação), estimados pelo mesmo
 * cálculo automático da nota fiscal com a natureza do contato ou a "Padrão venda". Aparecem com a preferência "Exibe campos IPI e
 * ST nos pedidos de venda e em propostas comerciais" ou quando há valor. Só leitura: o total salvo do documento não muda.
 */
export default function FiscalOrderTaxEstimate({ controller, kind, contactId, items, totals, onEstimate, applied = false }: {
  controller: AccessController; kind: 'sales_orders' | 'sales_proposals'; contactId: string | null; items: readonly DocumentItemInput[]; totals: DocumentTotals | null;
  /** Documentos lane (202610200196): the estimate with the preference on is added to the total of the document. */
  onEstimate?: (value: { ipi: string; icms_st: string } | null) => void; applied?: boolean;
}) {
  const [result, setResult] = useState<EstimateResult | null>(null);
  const actor = controller.getSnapshot().membership?.user_id ?? null;
  // Only valid, complete values are estimated; the request text is the dependency, so equal values never ask twice.
  const body = useMemo(() => {
    if (!totals || !contactId || !items.length || items.length > ESTIMATE_MAX_ITEMS) return null;
    return estimateSearch({ kind, contact_id: contactId, items: items.map(i => ({ product_id: i.product_id || null, quantity: i.quantity, unit_price: i.unit_price })),
      discount: money(cents(totals.line_discount) + cents(totals.discount)), freight: totals.freight, other_expenses: totals.other_expenses }).toString();
  }, [kind, contactId, items, totals]);
  useEffect(() => {
    if (!body || typeof controller.fiscalInvoices !== 'function') { setResult(null); return; }
    const request = new AbortController();
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => controller.fiscalInvoices(`/v1/notas-fiscais/estimativa?${body}`, { signal: request.signal }))
        // A late answer, another document or another session never shows its values here.
        .then(value => { if (!request.signal.aborted && controller.getSnapshot().membership?.user_id === actor) setResult(estimateResult(value)); })
        .catch(() => { if (!request.signal.aborted) setResult(null); });
    }, 600);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, body, actor]);
  // Leva H (VND-123, VND-194): the IPI and ICMS ST due go into the total even when "Exibir IPI e ST" is off; the preference only
  // decides whether the block is shown without values.
  useEffect(() => { if (onEstimate && result?.available && (result.enabled || cents(result.totals.ipi) > 0n || cents(result.totals.st) > 0n)) onEstimate({ ipi: result.totals.ipi, icms_st: result.totals.st }); }, [result, onEstimate]);
  if (!result) return null;
  const shown = result.enabled || cents(result.totals.ipi) > 0n || cents(result.totals.st) > 0n;
  if (!shown) return null;
  const noun = kind === 'sales_orders' ? 'do pedido' : 'da proposta';
  // Origin labels: "Total ICMS ST" on the pedido de venda (Tributação), "Total do ICMS ST" on the proposta comercial.
  return <section className="document-tax-estimate" aria-label="Tributação estimada">
    <dl className="document-total-summary" aria-live="polite">
      <div><dt>Total do IPI</dt><dd>{result.available ? decimalMoney(result.totals.ipi) : '—'}</dd></div>
      <div><dt>{kind === 'sales_orders' ? 'Total ICMS ST' : 'Total do ICMS ST'}</dt><dd>{result.available ? decimalMoney(result.totals.st) : '—'}</dd></div>
      {result.available && result.totals.total && !applied && <div><dt>Total com IPI e ICMS ST (estimado)</dt><dd>{decimalMoney(result.totals.total)}</dd></div>}
    </dl>
    <p className="real-help">{result.available ? `Estimativa pela natureza de operação ${result.nature?.description ?? ''} e pelas Configurações globais de impostos, como no cálculo automático da nota. ${applied ? `O total ${noun} soma o IPI e o ICMS ST estimados.` : `O total ${noun} ainda não soma o IPI e o ICMS ST.`}` : REASONS[result.reason ?? 'invalid']}</p>
  </section>;
}
