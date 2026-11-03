// 202610200291 Vendas › Logística › Checkout de pedidos (Origin vendas.checkout.php): the pedido is read by its number, each product by
// its GTIN, GTIN tributário or código (a reader types it and presses Enter), the quantities are checked against the pedido and saving
// moves the pedido: everything read = Verificado, part = Checkout parcial, nothing = Em aberto. Exact decimals (BigInt), never Number.
export interface CheckoutLine { key: string; item_id: string; component_id: string | null; product_id: string | null; position: number; description: string; code: string | null;
  unit: string; quantity: string; gtin: string | null; gtin_tax: string | null; location: string | null }
export interface CheckoutSettings { order: 'crescente' | 'nao_ordenar'; split: boolean; picking: boolean; auto_save: boolean; quantity_input: boolean }
export interface CheckoutView { kind: 'sales_orders'; order: { id: string; number: string; version: number; status: string; contact_name: string; date: string }; available: boolean; split: boolean;
  lines: CheckoutLine[]; reads: { key: string; quantity: string }[]; checkout_version: number; settings: CheckoutSettings; complete?: boolean; replayed?: boolean; auto_finance?: unknown }
export const checkoutPath = (id: string) => `/v1/documentos/sales_orders/${id}/checkout`;
export function readCheckout(value: unknown, id: string): CheckoutView {
  const v = value as CheckoutView | null;
  if (!v || v.kind !== 'sales_orders' || v.order?.id !== id || !Array.isArray(v.lines) || !Array.isArray(v.reads) || !Number.isInteger(v.checkout_version) || typeof v.available !== 'boolean' || !v.settings) throw new Error('Resposta inválida do checkout.');
  return v;
}
const SCALE = 1_000_000n;
export function units(value: string): bigint | null {
  const text = value.trim().replace(',', '.');
  if (!/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.'); return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
export const text6 = (value: bigint) => `${value / SCALE}.${String(value % SCALE).padStart(6, '0')}`;
export const shown = (value: bigint) => { const fraction = String(value % SCALE).padStart(6, '0').replace(/0+$/, ''); return `${value / SCALE}${fraction ? `,${fraction}` : ''}`; };
export type Reads = Readonly<Record<string, bigint>>;
export const readsOf = (view: CheckoutView): Record<string, bigint> => Object.fromEntries(view.reads.map(read => [read.key, units(read.quantity) ?? 0n]));
/** Preferências "Ordenar itens do checkout por localização": Crescente (no localização last) or the order of the pedido. */
export function orderedLines(lines: readonly CheckoutLine[], settings: Pick<CheckoutSettings, 'order'>): CheckoutLine[] {
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });
  return [...lines].sort((a, b) => settings.order === 'crescente' ? (a.location === null ? 1 : 0) - (b.location === null ? 1 : 0) || collator.compare(a.location ?? '', b.location ?? '') || a.position - b.position : a.position - b.position);
}
const same = (value: string | null, code: string) => Boolean(value) && value!.trim().toLowerCase() === code;
/** The line a read code belongs to: GTIN, GTIN tributário or código of the line, the first one not complete yet. */
export function lineForCode(lines: readonly CheckoutLine[], reads: Reads, raw: string): CheckoutLine | null {
  const code = raw.trim().toLowerCase(); if (!code) return null;
  const matches = lines.filter(line => same(line.gtin, code) || same(line.gtin_tax, code) || same(line.code, code));
  return matches.find(line => (reads[line.key] ?? 0n) < (units(line.quantity) ?? 0n)) ?? matches[0] ?? null;
}
/** The next line of the "método picking": the first line, in the order of the checkout, still missing quantities. */
export const pickingLine = (lines: readonly CheckoutLine[], reads: Reads) => lines.find(line => (reads[line.key] ?? 0n) < (units(line.quantity) ?? 0n)) ?? null;
export type ReadResult = { ok: true; reads: Record<string, bigint>; line: CheckoutLine } | { ok: false; message: string };
/** One reading (code + quantity, 1 without "Permite inserir quantidade do item"); never above the quantity of the line. */
export function applyRead(lines: readonly CheckoutLine[], reads: Reads, code: string, quantity: string, picking: boolean): ReadResult {
  const amount = units(quantity || '1');
  if (amount === null || amount <= 0n) return { ok: false, message: 'Informe uma quantidade maior que zero, com até seis casas decimais.' };
  const line = lineForCode(lines, reads, code);
  if (!line) return { ok: false, message: `Produto não encontrado no pedido: ${code.trim() || '(vazio)'}.` };
  const next = picking ? pickingLine(lines, reads) : null;
  if (picking && next && next.key !== line.key) return { ok: false, message: `Leia o item indicado: ${next.description}${next.location ? ` (localização ${next.location})` : ''}.` };
  const total = (reads[line.key] ?? 0n) + amount, limit = units(line.quantity) ?? 0n;
  if (total > limit) return { ok: false, message: `Quantidade lida maior que a do pedido para ${line.description}: ${shown(total)} de ${shown(limit)}.` };
  return { ok: true, reads: { ...reads, [line.key]: total }, line };
}
export const complete = (lines: readonly CheckoutLine[], reads: Reads) => lines.length > 0 && lines.every(line => (reads[line.key] ?? 0n) === (units(line.quantity) ?? 0n));
export const anyRead = (reads: Reads) => Object.values(reads).some(value => value > 0n);
/** What Salvar sends: every line read, with exact decimals. */
export const readsBody = (reads: Reads) => Object.entries(reads).filter(([, value]) => value > 0n).map(([key, value]) => ({ key, quantity: text6(value) }));
/** The situação the save will give the pedido (Origin): Verificado, Checkout parcial or Em aberto. */
export const savedStatus = (lines: readonly CheckoutLine[], reads: Reads) => complete(lines, reads) ? 'verified' : anyRead(reads) ? 'checkout_partial' : 'open';
