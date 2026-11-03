// Contas lançadas pelas notas fiscais do Brufap (SQL 247): the answers of /v1/financeiro/notas/{id}/contas, of its prévia and of the
// letra C of the lists, checked before they are shown. Amounts stay in exact cents (strings).
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, DAY = /^\d{4}-\d{2}-\d{2}$/, CENTS = /^\d{1,15}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const broken = (): never => { throw new Error('Não foi possível conferir as contas da nota fiscal. Tente novamente.'); };

export type InvoiceFinanceTitle = { id: string; position: number; version: number; due_on: string; amount_cents: string; settled_cents: string; balance_cents: string; cancelled: boolean; cnab_linked: boolean };
export type InvoiceFinancePosting = { id: string; state: 'active' | 'reversed'; version: number; origin: 'manual' | 'automatic'; direction: 'receivable' | 'payable'; total_cents: string; installments: number; created_at: string; reversed_at: string | null; reason: string | null };
export type InvoiceFinance = {
  invoice: { id: string; version: number; model: '55' | '65'; direction: '0' | '1'; kind: 'receivable' | 'payable'; number: string | null; status: number; issue_date: string; total_cents: string; contact_name: string | null };
  active_posting: InvoiceFinancePosting | null; titles: InvoiceFinanceTitle[]; grouped_billing: { id: string; number: string } | null;
  orders_posted: { document_id: string; kind: string; number: string }[]; blocked_reason: string | null; postings: InvoiceFinancePosting[]; writable: boolean;
};
export type InvoicePreviewParcel = { position: number; amount_cents: string; due_on: string; payment_method_name: string | null; account_id: string | null; account_name: string | null };
export type InvoicePreview = { invoice_id: string; invoice_version: number; direction: 'receivable' | 'payable'; total_cents: string; category_id: string | null; category_name: string | null; account_id: string | null;
  installments: InvoicePreviewParcel[]; preview_hash: string };

/** Why Lançar contas is not possible, as the Origin messages of the note. */
export const INVOICE_FINANCE_BLOCKED: Readonly<Record<string, string>> = {
  erp_finance_invoice_deleted: 'A nota foi excluída.',
  erp_finance_invoice_ineligible_state: 'Nota cancelada ou denegada não lança contas.',
  erp_finance_invoice_already_posted: 'As contas desta nota já foram lançadas.',
  erp_finance_invoice_grouped: 'A nota está num Faturamento agrupado: as contas são do faturamento. Exclua o faturamento para lançar as contas pela nota.',
  erp_finance_invoice_order_posted: 'O pedido de origem já lançou as contas (letra V): a venda tem as contas uma vez só. Estorne as contas no pedido para lançá-las pela nota.',
  erp_finance_invalid_contact: 'O destinatário da nota não é um contato ativo do cadastro.',
  erp_finance_invoice_zero_total: 'A nota não tem valor a lançar.',
};
export const invoiceLabel = (invoice: { model: string; number: string | null }) => `${invoice.model === '65' ? 'NFC-e' : 'Nota fiscal'} ${invoice.number ? `nº ${invoice.number}` : '(sem número)'}`;

function title(value: unknown, index: number): InvoiceFinanceTitle {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.position !== index + 1 || !Number.isSafeInteger(value.version) || typeof value.due_on !== 'string' || !DAY.test(value.due_on)
    || ['amount_cents', 'settled_cents', 'balance_cents'].some(key => typeof value[key] !== 'string' || !CENTS.test(value[key] as string)) || typeof value.cancelled !== 'boolean' || typeof value.cnab_linked !== 'boolean') return broken();
  return value as unknown as InvoiceFinanceTitle;
}
function posting(value: unknown): InvoiceFinancePosting {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !['active', 'reversed'].includes(String(value.state)) || !Number.isSafeInteger(value.version) || !['manual', 'automatic'].includes(String(value.origin))
    || !['receivable', 'payable'].includes(String(value.direction)) || typeof value.total_cents !== 'string' || !CENTS.test(value.total_cents)) return broken();
  return value as unknown as InvoiceFinancePosting;
}
export function invoiceFinance(value: unknown, id: string): InvoiceFinance {
  if (!object(value) || value.entity !== 'invoice_finance' || value.data_mode !== 'erp_native' || !object(value.invoice) || value.invoice.id !== id || !Number.isSafeInteger(value.invoice.version)
    || !Array.isArray(value.titles) || !Array.isArray(value.postings) || !Array.isArray(value.orders_posted) || typeof value.writable !== 'boolean'
    || (value.blocked_reason !== null && typeof value.blocked_reason !== 'string')) return broken();
  const active = value.active_posting === null ? null : posting(value.active_posting);
  if (active && active.state !== 'active') return broken();
  return { invoice: value.invoice as InvoiceFinance['invoice'], active_posting: active, titles: value.titles.map(title), grouped_billing: (value.grouped_billing ?? null) as InvoiceFinance['grouped_billing'],
    orders_posted: value.orders_posted as InvoiceFinance['orders_posted'], blocked_reason: value.blocked_reason as string | null, postings: value.postings.map(posting), writable: value.writable };
}
export function invoicePreview(value: unknown, id: string, version: number): InvoicePreview {
  const preview = object(value) ? value.preview : null;
  if (!object(value) || value.data_mode !== 'erp_native' || value.cash_movement_performed !== false || !object(preview) || preview.invoice_id !== id || preview.invoice_version !== version
    || typeof preview.preview_hash !== 'string' || !/^[a-f0-9]{64}$/.test(preview.preview_hash) || !Array.isArray(preview.installments) || !preview.installments.length) return broken();
  let sum = 0n;
  for (const [index, item] of (preview.installments as unknown[]).entries()) {
    if (!object(item) || item.position !== index + 1 || typeof item.amount_cents !== 'string' || !CENTS.test(item.amount_cents) || typeof item.due_on !== 'string' || !DAY.test(item.due_on)) return broken();
    sum += BigInt(item.amount_cents);
  }
  if (typeof preview.total_cents !== 'string' || sum !== BigInt(preview.total_cents)) return broken();
  return preview as unknown as InvoicePreview;
}
export function invoicePreviewPath(id: string, version: number, category: string, account: string): string {
  const params = new URLSearchParams({ versao: String(version) }); if (category) params.set('categoria', category); if (account) params.set('conta', account);
  return `/v1/financeiro/notas/${id}/contas/previa?${params}`;
}
/** Emitir boletos: the open contas a receber of the note without boleto, up to the 30 of a remessa, for Incluir Remessa. */
export function boletoTitleIds(finance: InvoiceFinance): string[] {
  if (finance.invoice.kind !== 'receivable' || !finance.active_posting) return [];
  return finance.titles.filter(item => !item.cancelled && !item.cnab_linked && BigInt(item.balance_cents) > 0n).map(item => item.id).slice(0, 30);
}
/** Estornar contas needs every conta without baixa and without boleto, as the server refuses otherwise. */
export const reverseBlocked = (finance: InvoiceFinance) => finance.titles.some(item => item.settled_cents !== '0') ? 'Há contas com baixa: estorne as baixas antes de estornar as contas da nota.'
  : finance.titles.some(item => item.cnab_linked) ? 'Há contas com boleto em remessa: exclua a remessa reservada antes de estornar as contas.' : null;

export type InvoiceFlags = ReadonlyMap<string, { posted: boolean; grouped: boolean; category_ids: string[] }>;
/** Letra C of a page of notes (only the notes of the Brufap, up to 100). */
export function invoiceFlags(value: unknown, ids: readonly string[]): InvoiceFlags {
  if (!object(value) || value.entity !== 'invoice_finance_flags' || value.data_mode !== 'erp_native' || !Array.isArray(value.items) || value.items.length > ids.length) return broken();
  const map = new Map<string, { posted: boolean; grouped: boolean; category_ids: string[] }>();
  for (const item of value.items as unknown[]) {
    if (!object(item) || typeof item.invoice_id !== 'string' || !ids.includes(item.invoice_id) || map.has(item.invoice_id) || typeof item.posted !== 'boolean' || typeof item.grouped !== 'boolean' || !Array.isArray(item.category_ids)) return broken();
    map.set(item.invoice_id, { posted: item.posted, grouped: item.grouped, category_ids: item.category_ids as string[] });
  }
  return map;
}
