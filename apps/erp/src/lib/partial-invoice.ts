// Leva H, lane documentos (VND-047): the note body of "Gerar nota fiscal parcial" (the pure cut is in partial-invoice-model.ts).
import type { PartialItem } from '../../../../packages/erp-domain/src/sales-invoice-balance.mjs';
import type { InvoiceBalance } from '../../../../packages/erp-domain/src/sales-invoice-balance.mjs';
import { invoiceFromSource, OrderBatchRefusal, readOrderSource, type BatchBasis } from './fiscal-order-batch';
import { cutSource, PartialRefusal, picksProblem, quantity4, units, type PartialPick } from './partial-invoice-model';
export { picksProblem, type PartialPick } from './partial-invoice-model';

type Fetch = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
/** The body of POST /v1/notas-fiscais/parcial: the note and the pedido item of each note item, in the order of the note. */
export async function partialInvoiceBody(fetch: Fetch, basis: BatchBasis, balance: InvoiceBalance, picks: readonly PartialPick[], model: '55' | '65', today: string, signal?: AbortSignal) {
  const problem = picksProblem(balance, picks);
  if (problem) throw new OrderBatchRefusal(problem);
  const source = await readOrderSource(fetch, balance.document_id, model, signal);
  let cut;
  try { cut = cutSource(source, picks); } catch (error) { if (error instanceof PartialRefusal) throw new OrderBatchRefusal(error.message); throw error; }
  const built = await invoiceFromSource(fetch, basis, cut, model, today, signal);
  const items = built.invoice.items as unknown as { product_id?: string | null; quantity: string }[];
  // A composition split into components or a service item cannot be tied to one pedido item: the note must keep one line per pick.
  if (items.length !== picks.length) throw new OrderBatchRefusal('Itens desmembrados em componentes ou de serviço não entram em nota parcial. Gere a nota pelo menu do pedido.');
  const links: PartialItem[] = picks.map((pick, index) => {
    const item = balance.items.find(i => i.position === pick.position)!;
    if (units(items[index]!.quantity, 4) !== units(pick.quantity, 4)) throw new OrderBatchRefusal('A quantidade de um item mudou ao montar a nota. Confira o pedido.');
    return { position: index + 1, document_item_id: item.document_item_id, quantity: quantity4(pick.quantity) };
  });
  return { command_id: crypto.randomUUID(), document_id: balance.document_id, invoice: built.invoice, items: links };
}
