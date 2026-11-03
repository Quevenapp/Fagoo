// "Vincular à pedido de compra" item a item (notas fiscais lane, wave F, migration 202610200275): which item of the note of entry fulfils
// which item of the pedido de compra, and how much. Quantities have four decimals and are handled as BigInt (no binary floating point).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QTY4 = /^(0|[1-9][0-9]{0,10})\.[0-9]{4}$/;
export const qty = (value: unknown): bigint => {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^(0|[1-9][0-9]{0,10})(\.[0-9]{0,6})?$/.test(text)) return -1n;
  const [w, f = ''] = text.split('.');
  if (f.length > 4 && /[1-9]/.test(f.slice(4))) return -1n;
  return BigInt(w) * 10000n + BigInt((f + '0000').slice(0, 4));
};
/** The quantity of an item of the pedido (up to 6 decimals in the documents) cut to the 4 decimals of the note. */
const orderQty = (value: unknown): bigint => { const text = String(value ?? '').trim(); const m = /^(\d{1,11})(?:\.(\d{1,6}))?$/.exec(text); return m ? BigInt(m[1]!) * 10000n + BigInt(((m[2] ?? '') + '0000').slice(0, 4)) : 0n; };
export const qtyText = (value: bigint) => { const whole = value / 10000n, fraction = String(value % 10000n).padStart(4, '0').replace(/0+$/, ''); return fraction ? `${whole},${fraction}` : String(whole); };
const qtyWire = (value: bigint) => `${value / 10000n}.${String(value % 10000n).padStart(4, '0')}`;

export interface OrderItemLink { invoice_position: number; document_item_id: string; quantity: string; counted: string; valid: boolean }
export interface OrderItemsState { invoice_id: string; document_id: string; linked: boolean; items: OrderItemLink[]; others: { document_item_id: string; quantity: string }[]; state: 'none' | 'linked' | 'partial' }
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** GET /v1/notas-fiscais/{id}/pedidos/{pedido}, checked again in the browser. */
export function orderItemsState(value: unknown, invoiceId: string, documentId: string): OrderItemsState {
  const v = value as Record<string, unknown>;
  if (!plain(v) || v.invoice_id !== invoiceId || v.document_id !== documentId || typeof v.linked !== 'boolean' || !['none', 'linked', 'partial'].includes(String(v.state)) || v.data_mode !== 'erp_native'
    || !Array.isArray(v.items) || !Array.isArray(v.others)) throw new Error('ORDER_ITEMS_RESPONSE_INVALID');
  const items = (v.items as unknown[]).map(r => {
    if (!plain(r) || !Number.isInteger(r.invoice_position) || !UUID.test(String(r.document_item_id)) || !QTY4.test(String(r.quantity)) || !QTY4.test(String(r.counted)) || typeof r.valid !== 'boolean') throw new Error('ORDER_ITEMS_RESPONSE_INVALID');
    return { invoice_position: r.invoice_position as number, document_item_id: r.document_item_id as string, quantity: r.quantity as string, counted: r.counted as string, valid: r.valid };
  });
  const others = (v.others as unknown[]).map(o => { if (!plain(o) || !UUID.test(String(o.document_item_id)) || !QTY4.test(String(o.quantity))) throw new Error('ORDER_ITEMS_RESPONSE_INVALID'); return { document_item_id: o.document_item_id as string, quantity: o.quantity as string }; });
  return { invoice_id: invoiceId, document_id: documentId, linked: v.linked, items, others, state: v.state as OrderItemsState['state'] };
}

export interface NoteItem { position?: number; product_id?: string | null; description?: string | null; quantity?: string | null }
export interface OrderItem { id?: string | null; product_id?: string | null; description?: string | null; quantity?: string | number | null }
export interface LinkLine { document_item_id: string; description: string; product_id: string | null; ordered: bigint; others: bigint; position: number | null; quantity: string }
const noteQty = (item: NoteItem) => qty(item.quantity);
/** The note items that may fulfil an item of the pedido: same product, or one of the two without product. */
export const compatible = (note: NoteItem, order: Pick<LinkLine, 'product_id'>) => !note.product_id || !order.product_id || note.product_id === order.product_id;
/**
 * The proposal of the screen: for each item of the pedido, the first compatible note item with the same product (or none), with the
 * quantity still to link (the pedido minus the other notes) limited by what is left of that note item.
 */
export function defaultLinkLines(noteItems: readonly NoteItem[], orderItems: readonly OrderItem[], others: OrderItemsState['others']): LinkLine[] {
  const left = new Map(noteItems.map((item, index) => [item.position ?? index + 1, noteQty(item) < 0n ? 0n : noteQty(item)]));
  return orderItems.filter(item => typeof item.id === 'string' && UUID.test(item.id)).map(item => {
    const ordered = orderQty(item.quantity), already = qty(others.find(o => o.document_item_id === item.id)?.quantity ?? '0'), open = ordered - already > 0n ? ordered - already : 0n;
    const productId = typeof item.product_id === 'string' && item.product_id ? item.product_id : null;
    const match = productId ? noteItems.map((n, i) => ({ n, position: n.position ?? i + 1 })).find(({ n, position }) => n.product_id === productId && (left.get(position) ?? 0n) > 0n) : undefined;
    let quantity = 0n;
    if (match && open > 0n) { const available = left.get(match.position) ?? 0n; quantity = available < open ? available : open; left.set(match.position, available - quantity); }
    return { document_item_id: item.id as string, description: String(item.description ?? 'Item'), product_id: productId, ordered: ordered < 0n ? 0n : ordered, others: already < 0n ? 0n : already,
      position: match && quantity > 0n ? match.position : null, quantity: quantity > 0n ? qtyText(quantity) : '' };
  });
}
/** Why the lines cannot be linked (empty when they can), in the words of the screen. */
export function linkLineProblems(lines: readonly LinkLine[], noteItems: readonly NoteItem[]): string[] {
  const problems: string[] = [], used = new Map<number, bigint>();
  for (const line of lines) {
    if (!line.quantity.trim()) continue;
    const value = qty(line.quantity);
    if (value <= 0n) { problems.push(`${line.description}: informe uma quantidade maior que zero, com até 4 casas.`); continue; }
    if (line.position === null) { problems.push(`${line.description}: escolha o item da nota.`); continue; }
    const note = noteItems[line.position - 1];
    if (!note) { problems.push(`${line.description}: o item da nota não existe mais.`); continue; }
    if (!compatible(note, line)) problems.push(`${line.description}: o item ${line.position} da nota é de outro produto.`);
    if (value > line.ordered - line.others) problems.push(`${line.description}: a quantidade passa do que falta vincular no pedido (${qtyText(line.ordered - line.others > 0n ? line.ordered - line.others : 0n)}).`);
    used.set(line.position, (used.get(line.position) ?? 0n) + value);
  }
  for (const [position, total] of used) { const note = noteItems[position - 1]; if (note && total > noteQty(note)) problems.push(`Item ${position} da nota: as quantidades passam da quantidade da nota (${qtyText(noteQty(note))}).`); }
  return problems;
}
/** The items of the command (only the lines with a quantity). */
export const linkLineItems = (lines: readonly LinkLine[]) => lines.filter(l => l.quantity.trim() && l.position !== null && qty(l.quantity) > 0n)
  .map(l => ({ position: l.position as number, document_item_id: l.document_item_id, quantity: qtyWire(qty(l.quantity)) }));
/** "Resumo": items of the pedido fully linked (all notes, with these lines) and still to link. */
export function linkSummary(lines: readonly LinkLine[]): { linked: number; open: number; total: number } {
  let linked = 0;
  for (const l of lines) { const now = l.quantity.trim() ? qty(l.quantity) : 0n; if (l.ordered > 0n && l.others + (now > 0n ? now : 0n) >= l.ordered) linked++; }
  return { linked, open: lines.length - linked, total: lines.length };
}
