// "Gerar NF-e dos pedidos selecionados" / "Gerar: NFC-es selecionadas" (Origin, lista de pedidos de venda): uma nota de homologação
// por pedido, montada exatamente como "Gerar nota fiscal" do menu ⋮ (orderDraft + cálculo automático) e gravada com um
// command_id por pedido, que se repete quando o resultado não foi confirmado. Nada é emitido, transmitido ou lançado.
import { invoiceTotals, invoicePreferences, natureRecord, natureSummary, normalizeInvoiceInput, normalizeTaxSettings, invoiceRecord, type InvoiceRecord, type NatureRecord, type NatureSummary, type TaxSettingsValues } from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { centsOf } from '../../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import { ORDER_REASONS, orderSourceRecord, type OrderSource } from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import { calculateInvoiceTaxes } from '../../../../packages/fiscal-core/src/tax-engine.mjs';
import { draftToInput, installmentsMismatch, isServiceItem, orderDraft, orderLocks, orderOrigin, preferencesOf, withItemDiscounts, withNatureSummary, withPreferenceVolumes, type FormContext } from './fiscal-invoice-form-model';
import { FISCAL_BASE } from './fiscal-invoice-list-model';

type Fetch = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
export interface BatchBasis { context: FormContext; natures: NatureSummary[]; details: Record<string, NatureRecord>; settings: Partial<TaxSettingsValues>; difalByState: Record<string, string>; groups: Record<string, string | null> }
export class OrderBatchRefusal extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Context, natures and tax settings of the model, read once per batch (the same reads as the note form). */
export async function loadBatchBasis(fetch: Fetch, model: '55' | '65', signal?: AbortSignal): Promise<BatchBasis> {
  const raw = await fetch(`${FISCAL_BASE}/contexto?model=${model}`, { signal }) as FormContext & { production_enabled?: boolean };
  if (!raw || raw.production_enabled !== false || !Array.isArray(raw.series) || typeof raw.defaults !== 'object') throw new Error('Não foi possível conferir o contexto das notas.');
  const context: FormContext = { ...raw, preferences: invoicePreferences(raw.preferences), item_discount: raw.item_discount === true };
  const [list, taxes] = await Promise.all([fetch(`${FISCAL_BASE}/naturezas?active=true&limit=100`, { signal }) as Promise<{ items?: unknown[] }>, fetch(`${FISCAL_BASE}/impostos`, { signal }) as Promise<{ settings: unknown; difal_by_state: unknown }>]);
  const tax = normalizeTaxSettings(taxes?.settings, taxes?.difal_by_state);
  return { context, natures: (list?.items ?? []).map(natureSummary), details: {}, settings: tax.settings, difalByState: tax.difal_by_state, groups: {} };
}
const reasonsText = (source: OrderSource) => source.reasons.map(r => `${ORDER_REASONS[r.code]}${r.items.length ? ` Itens: ${r.items.join(', ')}.` : ''}`).join(' ');
const br = (cents: bigint) => `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`;

/**
 * The note of one pedido as "Gerar nota fiscal" would fill it, with the taxes of "Cálculo automático". Throws OrderBatchRefusal with
 * Origin's "Motivo" when the pedido cannot become a note here (refused pedido, no natureza, parcels that the note total changed).
 */
export async function orderInvoiceBody(fetch: Fetch, basis: BatchBasis, documentId: string, model: '55' | '65', today: string, signal?: AbortSignal) {
  const source = await readOrderSource(fetch, documentId, model, signal);
  if (!source.eligible) throw new OrderBatchRefusal(reasonsText(source));
  return invoiceFromSource(fetch, basis, source, model, today, signal);
}
/** The pedido as "Gerar nota fiscal" reads it (any refusal reason is left to the caller). */
export async function readOrderSource(fetch: Fetch, documentId: string, model: '55' | '65', signal?: AbortSignal): Promise<OrderSource> {
  const source = orderSourceRecord(await fetch(`${FISCAL_BASE}/pedido/${documentId}?model=${model}`, { signal }));
  if (source.document.id !== documentId || source.model !== model) throw new Error('A resposta do pedido não pôde ser conferida.');
  if (source.direction !== '1') throw new OrderBatchRefusal('O pedido de compra gera a nota em Notas fiscais de entrada.');
  return source;
}
/** The note of a pedido source (whole or cut by "Gerar nota fiscal parcial"), with the taxes of "Cálculo automático". */
export async function invoiceFromSource(fetch: Fetch, basis: BatchBasis, source: OrderSource, model: '55' | '65', today: string, signal?: AbortSignal) {
  const config = { model, direction: '1' as const };
  let draft = orderDraft(source, config, basis.context, today);
  draft = withNatureSummary(draft, basis.natures.find(n => n.id === draft.nature_id) ?? null);
  if (!draft.nature_id) throw new OrderBatchRefusal('Sem natureza de operação: defina a natureza do contato ou a "Padrão venda" em Naturezas de operação.');
  const prefs = preferencesOf(basis.context);
  for (const natureId of new Set([draft.nature_id, ...draft.items.map(i => typeof i.nature_id === 'string' ? i.nature_id : '')].filter(Boolean))) {
    if (!basis.details[natureId]) { const value = await fetch(`${FISCAL_BASE}/naturezas/${natureId}`, { signal }) as { nature?: unknown }; const nature = natureRecord(value?.nature); basis.details[nature.id] = nature; }
  }
  // "Grupo de Produtos" rules (202610200216): the groups of the item products, read only when a natureza has such a rule.
  if (Object.values(basis.details).some(n => n.rules.some(r => r.product_scope === 'groups'))) {
    const missing = [...new Set(draft.items.map(i => typeof i.product_id === 'string' ? i.product_id : '').filter(p => UUID.test(p) && !Object.hasOwn(basis.groups, p)))].slice(0, 100);
    if (missing.length) {
      const value = await fetch(`${FISCAL_BASE}/grupos-produtos?${new URLSearchParams({ ids: missing.join(',') })}`, { signal }) as { items?: { id: string; group_id: string | null }[] };
      for (const id of missing) basis.groups[id] = null;
      for (const item of value?.items ?? []) if (missing.includes(item.id)) basis.groups[item.id] = typeof item.group_id === 'string' ? item.group_id : null;
    }
  }
  const effective = withItemDiscounts(withPreferenceVolumes(draft, prefs), basis.context.item_discount === true);
  const options = { companyState: basis.context.company.state ?? null, simplesCreditMessage: prefs.simples_credit_message, trackingInInfo: prefs.tracking_in_info, purchaseOrderInInfo: prefs.purchase_order_in_info, sellerName: effective.seller_name || null };
  const groups = Object.fromEntries(Object.entries(basis.groups).filter(([, g]) => g !== null)) as Record<string, string>;
  const invoice = calculateInvoiceTaxes(normalizeInvoiceInput(draftToInput(effective)), { natures: basis.details, settings: basis.settings, difalByState: basis.difalByState, orders: orderOrigin(source), options, productGroups: groups }).invoice;
  const total = centsOf(invoiceTotals(invoice).totals.total);
  // Parcels that follow contas already posted by the pedido never block (the database agrees); others must add up unless optional.
  if (!orderLocks(source, prefs).installments && installmentsMismatch(draft, total, prefs))
    throw new OrderBatchRefusal(`As parcelas do pedido não somam o total da nota (R$ ${br(total)}, com os impostos calculados). Gere esta nota pelo menu ⋮ do pedido para ajustar as parcelas.`);
  const services = source.items.filter(i => isServiceItem(source, i)).length;
  return { invoice, orders: [source.document.id], services };
}

/** POST of the note with the command id of the pedido; the answer must be version 1 of a note linked to that pedido. */
export async function saveOrderInvoice(fetch: Fetch, body: { invoice: unknown; orders: string[] }, commandId: string, signal?: AbortSignal): Promise<InvoiceRecord> {
  const value = await fetch(FISCAL_BASE, { method: 'POST', body: { command_id: commandId, invoice: body.invoice, orders: body.orders }, signal }) as { invoice?: unknown };
  const saved = invoiceRecord(value?.invoice);
  if (saved.version !== 1 || !body.orders.every(id => saved.orders.some(o => o.id === id))) throw new Error('A nota salva não pôde ser conferida.');
  return saved;
}
