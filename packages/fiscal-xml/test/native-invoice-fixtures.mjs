// Synthetic notes of the Brufap for the native XML tests (wave F of the notas fiscais lane). Every party, product and number is fictitious;
// the records are built by the same contract the Worker checks the database with, so totals and allocations are the real ones.
import { invoiceRecord, invoiceTotals, normalizeInvoiceInput } from '../../erp-domain/src/fiscal-invoice-contract.mjs';

export const COMPANY = '11222333000181';
export const NOW = Object.freeze({ date: '2026-10-20', time: '10:15:00', offset: '-03:00' });
export const emitter = (over = {}) => ({ legal_name: 'Empresa Sintética Ltda', trade_name: 'Sintética', document: COMPANY, person_type: 'juridica', ie: '110042490114', ie_exempt: false,
  municipal_registration: null, cnae: null, suframa: null, substitute_ies: [], crt: '1', regime_confirmed: true,
  address: { street: 'Praça Sintética', number: '1', complement: null, district: 'Centro', city: 'São Paulo', municipality_code: '3550308', state: 'SP', postal_code: '01001000', phone: '1130001000' }, ...over });
const ID = '50000000-0000-4000-8000-0000000000a1';
export const recipient = (over = {}) => ({ name: 'Comprador Sintético Ltda', person_type: 'J', document: '12345678000195', ie: '535123456789', ie_indicator: '1', email: 'compras@sintetico.invalid',
  postal_code: '13400000', street: 'Rua Sintética', number: '100', district: 'Centro', city: 'Piracicaba', municipality_code: '3538709', state: 'SP', ...over });
export const item = (over = {}) => ({ description: 'Parafuso sintético', code: 'P-1', unit: 'UN', quantity: '10', unit_price: '2.5', ncm: '73181500', gtin: '7891234567895', cfop: '5102', origin: undefined,
  icms: { origin: '0', situation: '102' }, pis: { situation: '49', base: '0', rate: '0', value: '0' }, cofins: { situation: '49', base: '0', rate: '0', value: '0' }, ...over });
/** A saved note record (as erp_fiscal_invoice_get answers it) from a note body. */
export function record(over = {}) {
  const body = { model: '55', direction: '1', issue_type: 'N', series: '2', number: null, access_key: null, nature_id: null, nature_description: 'Venda de mercadoria', cfop: '5102', issue_date: '2026-10-20',
    crt: '1', purpose: '1', presence: '1', final_consumer: false, recipient: recipient(), items: [item()], payment: { installments: [{ date: '2026-11-20', amount: '25.00', method: '15' }] }, ...over };
  for (const i of body.items) delete i.origin;
  const normalized = normalizeInvoiceInput(body), totals = invoiceTotals(normalized);
  const value = { ...normalized, id: ID, version: 3, status: 1, environment: normalized.issue_type === 'T' ? null : '2', series: Number(normalized.series), number: normalized.number === null ? null : Number(normalized.number),
    protocol: null, authorized_at: null, nature_description: normalized.nature_description ?? 'Venda', created_at: '2026-10-20T12:00:00Z', updated_at: '2026-10-20T12:00:00Z', deleted_at: null, delete_reason: null, orders: [],
    items: normalized.items.map((it, i) => ({ ...it, position: i + 1, total: totals.lines[i], allocated: { freight: totals.allocation.freight[i], insurance: totals.allocation.insurance[i], other_expenses: totals.allocation.other_expenses[i], discount: totals.allocation.discount[i] } })),
    totals: totals.totals };
  return invoiceRecord(value);
}
export const source = (invoice = record(), over = {}) => ({ invoice, emitter: emitter(over.emitter), numbering: { series: invoice.series, next_number: 41, enabled: true, ...(over.numbering ?? {}) }, now: over.now ?? NOW });
