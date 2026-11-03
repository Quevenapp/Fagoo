// Leva H (SQL 375: VND-313): the contas a note generated from a pedido references (lançadas by the pedido or by the faturamento
// agrupado). A sale has its contas once; the note never lança another cobrança for the same sale.
export interface InvoiceOrderTitles {
  invoice_id: string; owner: 'invoice' | 'orders' | null;
  orders: { document_id: string; kind: 'sales_orders' | 'service_orders'; number: string; effect: { owner: 'document' | 'grouped'; id: string;
    titles: { id: string; position: number; due_on: string; amount_cents: string; settled_cents: string; cancelled: boolean; account_id: string | null }[] } }[];
}
export function invoiceOrderTitles(value: unknown, invoiceId: string): InvoiceOrderTitles {
  const v = value as (InvoiceOrderTitles & { entity?: unknown }) | null;
  if (!v || v.entity !== 'invoice_order_titles' || v.invoice_id !== invoiceId || !Array.isArray(v.orders)
    || v.orders.some(order => !order?.effect || !Array.isArray(order.effect.titles) || order.effect.titles.some(title => !/^\d+$/.test(title?.amount_cents ?? '') || !/^\d+$/.test(title?.settled_cents ?? ''))))
    throw new Error('Resposta inválida das contas do pedido.');
  return { invoice_id: v.invoice_id, owner: v.owner, orders: v.orders };
}
