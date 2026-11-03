import {normalizeUnitPrice,unitPriceScaled} from './unit-price.mjs';
import {normalizeRichText} from './rich-text.mjs';

export class DocumentError extends Error {
  constructor(code) { super(code); this.name = 'DocumentError'; this.code = code; }
}
const need = (test, code) => { if (!test) throw new DocumentError(code); };
export const KINDS = Object.freeze(['sales_proposals', 'sales_orders', 'purchase_orders', 'service_orders']);
export const STATES = Object.freeze({
  sales_proposals: { draft: 'Rascunho', open: 'Em aberto', pending: 'Pendente', waiting: 'Aguardando', approved: 'Aprovado', rejected: 'Não aprovado', completed: 'Concluído', cancelled: 'Cancelado' },
  // 202610200245: Origin "Venda Agenciada" and "Faturado parcialmente"; 202610200291: "Checkout parcial" (Checkout de pedidos).
  sales_orders: { draft: 'Em digitação', open: 'Em aberto', verified: 'Verificado', in_progress: 'Em andamento', agency_sale: 'Venda Agenciada', checkout_partial: 'Checkout parcial', partially_fulfilled: 'Atendido parcialmente', partially_invoiced: 'Faturado parcialmente', fulfilled: 'Atendido', cancelled: 'Cancelado' },
  purchase_orders: { open: 'Em aberto', in_progress: 'Em andamento', partially_fulfilled: 'Atendido parcialmente', fulfilled: 'Atendido', cancelled: 'Cancelado' },
  service_orders: { open: 'Em aberto', quoted: 'Orçada', approved: 'Aprovada', rejected: 'Não aprovada', in_progress: 'Em andamento', waiting_parts: 'Aguardando componentes', service_done: 'Serviço concluído', finalized: 'Finalizada', no_repair: 'Finalizada sem conserto', cancelled: 'Cancelado' },
});
// 202610200129: the new pedido de venda is born "Em aberto", as in Origin (before it was Em digitação).
export const INITIAL_STATE = Object.freeze({ sales_proposals: 'draft', sales_orders: 'open', purchase_orders: 'open', service_orders: 'open' });
// 008 transitions, kept as the baseline of the reason rule (202610200103).
export const LEGACY_TRANSITIONS = Object.freeze({
  sales_proposals: { draft: ['open', 'cancelled'], open: ['pending', 'waiting', 'approved', 'rejected', 'cancelled'], pending: ['open', 'waiting', 'approved', 'rejected', 'cancelled'], waiting: ['open', 'pending', 'approved', 'rejected', 'cancelled'], approved: ['open', 'cancelled'], rejected: ['open'], cancelled: ['open'], completed: [] },
  sales_orders: { draft: ['open', 'cancelled'], open: ['verified', 'in_progress', 'cancelled'], verified: ['open', 'in_progress', 'cancelled'], in_progress: ['partially_fulfilled', 'fulfilled', 'cancelled'], partially_fulfilled: ['in_progress', 'fulfilled', 'cancelled'], fulfilled: ['open'], cancelled: ['open'] },
  purchase_orders: { open: ['in_progress', 'cancelled'], in_progress: ['partially_fulfilled', 'fulfilled', 'cancelled'], partially_fulfilled: ['in_progress', 'fulfilled', 'cancelled'], fulfilled: ['open'], cancelled: ['open'] },
  service_orders: { open: ['quoted', 'no_repair', 'cancelled'], quoted: ['approved', 'rejected', 'cancelled'], approved: ['in_progress', 'cancelled'], rejected: ['quoted', 'no_repair'], in_progress: ['waiting_parts', 'service_done', 'no_repair', 'cancelled'], waiting_parts: ['in_progress', 'no_repair', 'cancelled'], service_done: ['in_progress', 'finalized'], finalized: ['open'], no_repair: ['open'], cancelled: ['open'] },
});
// 202610200103: Origin "todas para todas" for propostas (Concluído only through conversion), pedidos (Atendido parcialmente keeps 008) and OS;
// 202610200129: also pedidos de compra (Em aberto, Em andamento, Atendido e Cancelado; Atendido parcialmente keeps 008).
export const TRANSITIONS = Object.freeze({
  sales_proposals: { draft: ['open', 'pending', 'waiting', 'approved', 'rejected', 'cancelled'], open: ['draft', 'pending', 'waiting', 'approved', 'rejected', 'cancelled'], pending: ['draft', 'open', 'waiting', 'approved', 'rejected', 'cancelled'], waiting: ['draft', 'open', 'pending', 'approved', 'rejected', 'cancelled'], approved: ['draft', 'open', 'pending', 'waiting', 'rejected', 'cancelled'], rejected: ['draft', 'open', 'pending', 'waiting', 'approved', 'cancelled'], cancelled: ['draft', 'open', 'pending', 'waiting', 'approved', 'rejected'], completed: [] },
  // 202610200245: Venda Agenciada goes to and from every situação of the "todas para todas" group; Faturado parcialmente comes from
  // Atendido parcialmente and goes only to Atendido parcialmente and Cancelado (Origin).
  // 202610200291: Checkout parcial is reached only by the Checkout de pedidos (the SQL map has Em aberto → Checkout parcial for it, the
  // menu never offers it) and goes on to Em aberto, Verificado, Em andamento or Cancelado.
  sales_orders: { draft: ['open', 'verified', 'in_progress', 'agency_sale', 'fulfilled', 'cancelled'], open: ['draft', 'verified', 'in_progress', 'agency_sale', 'fulfilled', 'cancelled'], checkout_partial: ['open', 'verified', 'in_progress', 'cancelled'], verified: ['draft', 'open', 'in_progress', 'agency_sale', 'fulfilled', 'cancelled'], in_progress: ['draft', 'open', 'verified', 'agency_sale', 'partially_fulfilled', 'fulfilled', 'cancelled'], agency_sale: ['draft', 'open', 'verified', 'in_progress', 'fulfilled', 'cancelled'], partially_fulfilled: ['in_progress', 'partially_invoiced', 'fulfilled', 'cancelled'], partially_invoiced: ['partially_fulfilled', 'cancelled'], fulfilled: ['draft', 'open', 'verified', 'in_progress', 'agency_sale', 'cancelled'], cancelled: ['draft', 'open', 'verified', 'in_progress', 'agency_sale', 'fulfilled'] },
  purchase_orders: { open: ['in_progress', 'fulfilled', 'cancelled'], in_progress: ['open', 'partially_fulfilled', 'fulfilled', 'cancelled'], partially_fulfilled: ['in_progress', 'fulfilled', 'cancelled'], fulfilled: ['open', 'in_progress', 'cancelled'], cancelled: ['open', 'in_progress', 'fulfilled'] },
  service_orders: { open: ['quoted', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'no_repair', 'cancelled'], quoted: ['open', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'no_repair', 'cancelled'], approved: ['open', 'quoted', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'no_repair', 'cancelled'], rejected: ['open', 'quoted', 'approved', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'no_repair', 'cancelled'], in_progress: ['open', 'quoted', 'approved', 'rejected', 'waiting_parts', 'service_done', 'finalized', 'no_repair', 'cancelled'], waiting_parts: ['open', 'quoted', 'approved', 'rejected', 'in_progress', 'service_done', 'finalized', 'no_repair', 'cancelled'], service_done: ['open', 'quoted', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'finalized', 'no_repair', 'cancelled'], finalized: ['open', 'quoted', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'no_repair', 'cancelled'], no_repair: ['open', 'quoted', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'cancelled'], cancelled: ['open', 'quoted', 'approved', 'rejected', 'in_progress', 'waiting_parts', 'service_done', 'finalized', 'no_repair'] },
});
export function canEdit(kind, state) {
  return KINDS.includes(kind) && Boolean(STATES[kind][state]) && !['approved', 'completed', 'fulfilled', 'finalized', 'no_repair', 'cancelled', 'rejected', 'service_done', 'partially_invoiced'].includes(state);
}
/** Same rule as erp_documents.transition_reason_required: cancel, the 008 reopenings and any new exit from a closed situação. */
export function transitionReasonRequired(kind, from, to) {
  const reopening = (to === 'open' && ['approved', 'rejected', 'fulfilled', 'finalized', 'no_repair', 'cancelled'].includes(from))
    || (from === 'rejected' && to === 'quoted') || (from === 'service_done' && to === 'in_progress');
  return to === 'cancelled' || reopening || (!LEGACY_TRANSITIONS[kind]?.[from]?.includes(to) && !canEdit(kind, from));
}
export function checkTransition(kind, from, to, reason) {
  need(KINDS.includes(kind) && TRANSITIONS[kind][from]?.includes(to), 'DOCUMENT_TRANSITION_INVALID');
  if (transitionReasonRequired(kind, from, to)) need(typeof reason === 'string' && reason.trim().length >= 3 && reason.length <= 1000, 'DOCUMENT_REASON_REQUIRED');
  return true;
}
const scale = precision => 10n ** BigInt(precision);
export function decimal(value, precision, integerDigits) {
  need(typeof value === 'string' && new RegExp(`^(0|[1-9][0-9]{0,${integerDigits - 1}})(\\.[0-9]{1,${precision}})?$`).test(value), 'DOCUMENT_DECIMAL_INVALID');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * scale(precision) + BigInt(fraction.padEnd(precision, '0'));
}
export function format(value, precision) {
  need(typeof value === 'bigint' && value >= 0n, 'DOCUMENT_DECIMAL_INVALID');
  return `${value / scale(precision)}.${String(value % scale(precision)).padStart(precision, '0')}`;
}
const rounded = (numerator, denominator) => (numerator + denominator / 2n) / denominator;
const MAX_CENTS = 99_999_999_999_999n; // 999,999,999,999.99
const amount = value => decimal(value, 2, 12);
const percent = value => { const n = decimal(value, 4, 3); need(n <= 1_000_000n, 'DOCUMENT_PERCENT_INVALID'); return n; };
// Keep the public document error contract; only unit-price precision changes.
const priceValue = (value, scaled = false) => {
  try { return scaled ? unitPriceScaled(value,10) : normalizeUnitPrice(value,10); }
  catch { throw new DocumentError('DOCUMENT_DECIMAL_INVALID'); }
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function keys(value, allowed) { need(plain(value) && Object.keys(value).every(key => allowed.includes(key)), 'DOCUMENT_FIELD_INVALID'); }
function text(value, maximum, required = false, multiline = false) {
  if (value === undefined || value === null || value === '') { need(!required, 'DOCUMENT_TEXT_REQUIRED'); return null; }
  need(typeof value === 'string' && value.length <= maximum, 'DOCUMENT_TEXT_INVALID');
  const clean = value.replace(/^ +| +$/g, '');
  need((!required || clean.length > 0) && !(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(clean), 'DOCUMENT_TEXT_INVALID');
  return clean || null;
}
function uuid(value, required = false) {
  if (value == null || value === '') { need(!required, 'DOCUMENT_ID_REQUIRED'); return null; }
  need(typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value), 'DOCUMENT_ID_INVALID');
  return value.toLowerCase();
}
function date(value, required = false) {
  if (value == null || value === '') { need(!required, 'DOCUMENT_DATE_REQUIRED'); return null; }
  need(typeof value === 'string' && /^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value), 'DOCUMENT_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number);
  need(month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate(), 'DOCUMENT_DATE_INVALID');
  return value;
}
// 202610200268: Equipamento is a textarea of up to 4,000 characters (Origin), like Problema.
const TEXT_FIELDS = Object.freeze({ notes: 4000, internal_notes: 4000, payment_terms: 4000, delivery_terms: 2000, equipment: 4000, serial_number: 100, technician: 200, defect: 4000, solution: 4000 });
const MULTILINE_FIELDS = Object.freeze(['notes', 'internal_notes', 'payment_terms', 'delivery_terms', 'equipment', 'defect', 'solution']);
const COMMERCIAL_FIELDS = ['introduction','attention_to','seller_reference','store_reference','business_unit_reference','transport'];
const TRANSPORT_FIELDS = ['freight_mode','volume_count','gross_weight','delivery_days','carrier_reference','service_reference','tracking_code'];
function completeKeys(value, allowed) {
  keys(value, allowed); need(Object.keys(value).length === allowed.length, 'DOCUMENT_COMMERCIAL_FIELDS_REQUIRED');
}
function commercialText(value, maximum, multiline = false) {
  if (value === null || value === '') return null;
  need(typeof value === 'string', 'DOCUMENT_TEXT_INVALID');
  const clean = value.replace(/^ +| +$/g, '');
  need(Array.from(clean).length <= maximum, 'DOCUMENT_TEXT_INVALID');
  need(!(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(clean), 'DOCUMENT_TEXT_INVALID');
  return clean || null;
}
/** A declared external reference, never a native association or verified provenance. */
export function normalizeCommercialReference(value) {
  if (value === null) return null;
  completeKeys(value, ['system','source_id','label']);
  need(value.system === 'origin' && typeof value.source_id === 'string' && /^[1-9][0-9]{0,39}$/.test(value.source_id), 'DOCUMENT_REFERENCE_INVALID');
  return {system:'origin',source_id:value.source_id,label:commercialText(value.label,200)};
}
export function normalizeCommercial(value) {
  if (value === null) return null;
  completeKeys(value, COMMERCIAL_FIELDS);
  let transport = null;
  if (value.transport !== null) {
    const t = value.transport; completeKeys(t, TRANSPORT_FIELDS);
    need(t.freight_mode === null || (typeof t.freight_mode === 'string' && ['0','1','2','3','4','9'].includes(t.freight_mode)), 'DOCUMENT_FREIGHT_MODE_INVALID');
    need(t.delivery_days === null || (typeof t.delivery_days === 'string' && /^(0|[1-9][0-9]{0,5})$/.test(t.delivery_days)), 'DOCUMENT_DELIVERY_DAYS_INVALID');
    transport = {freight_mode:t.freight_mode,volume_count:t.volume_count === null ? null : format(decimal(t.volume_count,6,12),6),
      gross_weight:t.gross_weight === null ? null : format(decimal(t.gross_weight,6,12),6),delivery_days:t.delivery_days,
      carrier_reference:normalizeCommercialReference(t.carrier_reference),service_reference:normalizeCommercialReference(t.service_reference),
      tracking_code:commercialText(t.tracking_code,200)};
  }
  return {introduction:commercialText(value.introduction,4000,true),attention_to:commercialText(value.attention_to,200),
    seller_reference:normalizeCommercialReference(value.seller_reference),store_reference:normalizeCommercialReference(value.store_reference),
    business_unit_reference:normalizeCommercialReference(value.business_unit_reference),transport};
}
// 202610200102: optional Origin fields, accepted on every document kind and kept only when sent (like 054).
// 202610200129: order_reference (Origin "Ordem de compra" of the pedido de compra, up to 100 characters).
// 202610200164: seller_id (native vendedor of Cadastros › Vendedores; the server checks it exists and the kind takes it).
// 202610200168: category_id (categoria financeira; not in propostas) and carrier_id (transportador of Clientes e fornecedores).
// 202610200196: price_list_id (Lista de preço of pedidos and propostas), payment_account_id (Destino: the conta financeira of the
// contas; null = Contas a receber/pagar), payment_means and payment_indicator (Detalhes de pagamento of the pedido de venda: tPag
// and indPag of the NF-e, null = padrão da empresa).
// 202610200270: other_items (Origin "Outros itens ou serviços": texto rico and "Total outros itens") and commercial_conditions
// ("Condições comerciais" Nenhum | Parcela | Texto), propostas only.
export const EXTENSION_FIELDS = Object.freeze(['ship_date','finish_date','start_time','end_time','customer_po_number','quote_requested','quoted','warranty_days','warranty_months','warranty_info','reception_notes','template_name','delivery_address','order_reference','seller_id','category_id','carrier_id','price_list_id','payment_account_id','payment_means','payment_indicator','other_items','commercial_conditions']);
export const COMMERCIAL_CONDITION_MODES = Object.freeze(['none', 'installments', 'text']);
const richValue = value => { try { return normalizeRichText(value); } catch { throw new DocumentError('DOCUMENT_RICH_TEXT_INVALID'); } };
/** Tipos de pagamento (tPag of the NF-e), the same codes as Cadastros › Formas de pagamento (202610200127). */
export const PAYMENT_TYPES = Object.freeze(['01','02','03','04','05','10','11','12','13','14','15','16','17','18','19','20','21','22','90','91','99']);
export const CARD_BRANDS = Object.freeze(['01','02','03','04','05','06','07','08','09','99']);
/** "Detalhes da parcela" (Ver detalhes): every key is sent, null when not informed (202610200196). */
export const INSTALLMENT_DETAIL_FIELDS = Object.freeze(['account_id','payment_type','card_brand','integration_type','acquirer_cnpj','authorization_code','received_amount','fee_amount','commission_fee_amount']);
export const DELIVERY_ADDRESS_FIELDS = Object.freeze(['name','postal_code','state','city','district','street','number','complement','country']);
const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','EX','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
export function normalizeDeliveryAddress(value) {
  if (value === null) return null;
  completeKeys(value, DELIVERY_ADDRESS_FIELDS);
  const postal = commercialText(value.postal_code, 9), state = commercialText(value.state, 2);
  need(postal === null || /^\d{5}-?\d{3}$/.test(postal), 'DOCUMENT_DELIVERY_ADDRESS_INVALID');
  need(state === null || UFS.includes(state.toUpperCase()), 'DOCUMENT_DELIVERY_ADDRESS_INVALID');
  const address = { name: commercialText(value.name, 120), postal_code: postal === null ? null : postal.replace('-', ''), state: state === null ? null : state.toUpperCase(),
    city: commercialText(value.city, 100), district: commercialText(value.district, 100), street: commercialText(value.street, 100), number: commercialText(value.number, 30),
    complement: commercialText(value.complement, 100), country: commercialText(value.country, 60) };
  need(address.street !== null && address.city !== null, 'DOCUMENT_DELIVERY_ADDRESS_INVALID');
  return address;
}
function extensionValue(key, value) {
  if (key === 'ship_date' || key === 'finish_date') return date(value);
  if (key === 'start_time' || key === 'end_time') { need(value === null || (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)), 'DOCUMENT_TIME_INVALID'); return value; }
  if (key === 'quote_requested' || key === 'quoted') { need(value === null || typeof value === 'boolean', 'DOCUMENT_FLAG_INVALID'); return value; }
  if (key === 'warranty_days') { need(value === null || (typeof value === 'string' && /^(0|[1-9]\d{0,3})$/.test(value)), 'DOCUMENT_WARRANTY_INVALID'); return value; }
  if (key === 'warranty_months') { need(value === null || (typeof value === 'string' && /^(0|[1-9]\d{0,2})$/.test(value)), 'DOCUMENT_WARRANTY_INVALID'); return value; }
  if (key === 'customer_po_number') return commercialText(value, 60);
  if (key === 'template_name') return commercialText(value, 120);
  if (key === 'order_reference') return commercialText(value, 100);
  if (key === 'seller_id' || key === 'category_id' || key === 'carrier_id' || key === 'price_list_id' || key === 'payment_account_id') return uuid(value);
  if (key === 'payment_means') { need(value === null || PAYMENT_TYPES.includes(value), 'DOCUMENT_PAYMENT_INVALID'); return value; }
  if (key === 'payment_indicator') { need(value === null || value === '0' || value === '1', 'DOCUMENT_PAYMENT_INVALID'); return value; }
  if (key === 'warranty_info' || key === 'reception_notes') return commercialText(value, 4000, true);
  if (key === 'other_items') { if (value === null) return null; completeKeys(value, ['content', 'total']); return { content: richValue(value.content), total: format(amount(value.total), 2) }; }
  if (key === 'commercial_conditions') {
    if (value === null) return null; completeKeys(value, ['mode', 'text']); need(COMMERCIAL_CONDITION_MODES.includes(value.mode), 'DOCUMENT_CONDITIONS_INVALID');
    return { mode: value.mode, text: richValue(value.text) };
  }
  return normalizeDeliveryAddress(value);
}
/** 202610200268 Peças / Serviços executados of the OS: the group of the item; Orçar (quote) and OK (done) only of a serviço. */
export const SERVICE_ITEM_GROUPS = Object.freeze(['part', 'service']);
function serviceItemExtras(kind, item) {
  const has = key => Object.hasOwn(item, key);
  if (!has('group') && !has('quote') && !has('done')) return {};
  need(kind === 'service_orders' && (!has('group') || SERVICE_ITEM_GROUPS.includes(item.group)), 'DOCUMENT_ITEM_GROUP_INVALID');
  for (const key of ['quote', 'done']) need(!has(key) || typeof item[key] === 'boolean', 'DOCUMENT_ITEM_GROUP_INVALID');
  need(!(item.quote || item.done) || item.group === 'service', 'DOCUMENT_ITEM_GROUP_INVALID');
  return { ...(has('group') ? { group: item.group } : {}), ...(has('quote') ? { quote: item.quote } : {}), ...(has('done') ? { done: item.done } : {}) };
}
function supplierCode(kind, value) {
  const code = text(value, 100); need(code === null || kind === 'purchase_orders', 'DOCUMENT_SUPPLIER_CODE_INVALID'); return code;
}
// Valor recebido, de taxa and de taxa de comissão never exceed the parcela.
function installmentDetails(kind, value, parcela) {
  const details = normalizeInstallmentDetails(kind, value);
  need(!details || ['received_amount', 'fee_amount', 'commission_fee_amount'].every(key => details[key] === null || amount(details[key]) <= parcela), 'DOCUMENT_INSTALLMENT_DETAILS_INVALID');
  return details;
}
/** "Detalhes da parcela" of pedidos de venda, OS and pedidos de compra: complete keys, null when not informed. */
export function normalizeInstallmentDetails(kind, value) {
  if (value === null) return null;
  need(kind !== 'sales_proposals', 'DOCUMENT_INSTALLMENT_DETAILS_INVALID');
  completeKeys(value, INSTALLMENT_DETAIL_FIELDS);
  const code = (v, allowed) => { need(v === null || allowed.includes(v), 'DOCUMENT_INSTALLMENT_DETAILS_INVALID'); return v; };
  const money = v => v === null ? null : format(amount(v), 2);
  need(value.acquirer_cnpj === null || (typeof value.acquirer_cnpj === 'string' && /^[A-Z0-9]{12}[0-9]{2}$/.test(value.acquirer_cnpj)), 'DOCUMENT_INSTALLMENT_DETAILS_INVALID');
  need(value.authorization_code === null || (typeof value.authorization_code === 'string' && /^[A-Za-z0-9./-]{1,128}$/.test(value.authorization_code)), 'DOCUMENT_INSTALLMENT_DETAILS_INVALID');
  return { account_id: uuid(value.account_id), payment_type: code(value.payment_type, PAYMENT_TYPES), card_brand: code(value.card_brand, CARD_BRANDS),
    integration_type: code(value.integration_type, ['1', '2']), acquirer_cnpj: value.acquirer_cnpj, authorization_code: value.authorization_code,
    received_amount: money(value.received_amount), fee_amount: money(value.fee_amount), commission_fee_amount: money(value.commission_fee_amount) };
}
// ---- 202610200287: item and body extensions (Informar lotes, garantia por item, IPI %, campos customizados) ----
/** IPI of one item in cents: the item total (cents) × the IPI % (4 decimals, at most 100%), half up, as erp_documents.normalize. */
export function itemIpiCents(totalCents, ipiRate) {
  need(typeof totalCents === 'bigint' && totalCents >= 0n, 'DOCUMENT_TAX_INVALID');
  return rounded(totalCents * percent(ipiRate), 1_000_000n);
}
/** IPI of an item total ("12.34") for the screens and the print: "1.23". */
export const itemIpi = (total, ipiRate) => format(itemIpiCents(amount(total), ipiRate), 2);
export const ITEM_LOTS_MAX = 50;
/** "Informar lotes" of an item (pedidos de venda and peças of the OS): up to 50 lots of the product, no repetition, quantities with up to
 * 6 decimals adding up to the quantity of the item. An empty list means no lot ("Sem lote") and is not kept. */
export function normalizeItemLots(kind, item, quantity, group) {
  const value = item.lots;
  if (value === undefined || value === null) return undefined;
  need(Array.isArray(value) && value.length <= ITEM_LOTS_MAX && ['sales_orders', 'service_orders'].includes(kind), 'DOCUMENT_ITEM_LOTS_INVALID');
  if (!value.length) return undefined;
  need(Boolean(item.product_id) && !(kind === 'service_orders' && group === 'service'), 'DOCUMENT_ITEM_LOTS_INVALID');
  const seen = new Set(); let sum = 0n;
  const lots = value.map(lot => {
    need(plain(lot) && Object.keys(lot).length === 2 && Object.hasOwn(lot, 'lot_id') && Object.hasOwn(lot, 'quantity'), 'DOCUMENT_ITEM_LOTS_INVALID');
    const id = uuid(lot.lot_id, true); need(!seen.has(id), 'DOCUMENT_ITEM_LOTS_INVALID'); seen.add(id);
    const units = decimal(lot.quantity, 6, 9); need(units > 0n, 'DOCUMENT_ITEM_LOTS_INVALID'); sum += units;
    return { lot_id: id, quantity: format(units, 6) };
  });
  need(sum === quantity, 'DOCUMENT_ITEM_LOTS_QUANTITY');
  return lots;
}
/** Garantia (dias) of an item of the OS (0 to 9999); null is not kept. */
function itemWarranty(kind, value) {
  if (value === undefined || value === null) return undefined;
  need(kind === 'service_orders' && typeof value === 'string' && /^(0|[1-9]\d{0,3})$/.test(value), 'DOCUMENT_WARRANTY_INVALID');
  return value;
}
/** IPI % of an item of the pedido de compra (up to 100%, 4 decimals); null is not kept. */
function itemIpiRate(kind, value) {
  if (value === undefined || value === null) return undefined;
  need(kind === 'purchase_orders', 'DOCUMENT_TAX_INVALID');
  return format(percent(value), 4);
}
export const CUSTOM_FIELDS_MAX = 60;
/** Campos customizados of the OS: {field id: value} with the canonical text of each value (the server checks them against the
 * definitions). Empty values are dropped; no value keeps no key. */
export function normalizeCustomFields(kind, value) {
  if (value === undefined || value === null) return undefined;
  need(plain(value) && Object.keys(value).length <= CUSTOM_FIELDS_MAX && kind === 'service_orders', 'DOCUMENT_CUSTOM_FIELDS_INVALID');
  const out = {};
  for (const [id, text] of Object.entries(value)) {
    need(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id), 'DOCUMENT_CUSTOM_FIELDS_INVALID');
    if (text === null || text === '') continue;
    need(typeof text === 'string' && text.length <= 4000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text), 'DOCUMENT_CUSTOM_FIELDS_INVALID');
    out[id] = text;
  }
  return Object.keys(out).length ? out : undefined;
}
/** Document number as the server stores it: 1 to 9,999,999,999 without leading zeros. */
export const documentNumber = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value);
export function calculateDocument(input) {
  need(plain(input) && Array.isArray(input.items) && input.items.length <= 250, 'DOCUMENT_ITEMS_INVALID');
  let gross = 0n, lineDiscount = 0n, itemsIpi = 0n, rated = false;
  const items = input.items.map(item => {
    need(plain(item), 'DOCUMENT_ITEM_INVALID');
    const quantity = decimal(item.quantity, 6, 9), price = priceValue(item.unit_price,true), rate = percent(item.discount_percent ?? '0');
    need(quantity > 0n, 'DOCUMENT_QUANTITY_INVALID');
    const base = rounded(quantity * price, 100_000_000_000_000n); // scales 6+10 -> cents
    need(base <= MAX_CENTS, 'DOCUMENT_TOTAL_LIMIT');
    const discount = rounded(base * rate, 1_000_000n);
    gross += base; lineDiscount += discount;
    // 202610200287: IPI % of the item (pedido de compra): the IPI of the item is its total × the rate, in cents (half up).
    if (item.ipi_rate !== undefined && item.ipi_rate !== null) { itemsIpi += itemIpiCents(base - discount, item.ipi_rate); rated = true; }
    return { gross: format(base, 2), discount: format(discount, 2), total: format(base - discount, 2) };
  });
  need(gross <= MAX_CENTS, 'DOCUMENT_TOTAL_LIMIT');
  const subtotal = gross - lineDiscount;
  const mode = input.discount_mode ?? 'amount';
  need(['amount', 'percent'].includes(mode), 'DOCUMENT_DISCOUNT_MODE_INVALID');
  const globalDiscount = mode === 'amount' ? amount(input.discount_value ?? '0') : rounded(subtotal * percent(input.discount_value ?? '0'), 1_000_000n);
  need(globalDiscount <= subtotal, 'DOCUMENT_DISCOUNT_EXCEEDS_SUBTOTAL');
  const freight = amount(input.freight ?? '0'), other = amount(input.other_expenses ?? '0');
  // 202610200196: Total do IPI and Total do ICMS ST (estimated by the fiscal rule) add to the total when the document carries them.
  const taxed = Object.hasOwn(input, 'tax_ipi') || Object.hasOwn(input, 'tax_icms_st') || rated;
  const tax = key => { if (input[key] === undefined) return 0n; need(typeof input[key] === 'string', 'DOCUMENT_TAX_INVALID'); return amount(input[key]); };
  // 202610200287: with IPI % in the items the Total do IPI is their sum (a tax_ipi sent with them follows the items).
  const sentIpi = tax('tax_ipi'), ipi = rated ? itemsIpi : sentIpi, icmsSt = tax('tax_icms_st');
  // 202610200270: "Total outros itens" of the proposta adds to its total (the discount stays on the items).
  let otherItems = null;
  if (input.other_items !== undefined && input.other_items !== null) { need(plain(input.other_items) && typeof input.other_items.total === 'string', 'DOCUMENT_OTHER_ITEMS_INVALID'); otherItems = amount(input.other_items.total); }
  const total = subtotal - globalDiscount + freight + other + ipi + icmsSt + (otherItems ?? 0n);
  need(total <= MAX_CENTS, 'DOCUMENT_TOTAL_LIMIT');
  return { items, gross: format(gross, 2), line_discount: format(lineDiscount, 2), subtotal: format(subtotal, 2), discount: format(globalDiscount, 2), freight: format(freight, 2), other_expenses: format(other, 2),
    ...(taxed ? { ipi: format(ipi, 2), icms_st: format(icmsSt, 2) } : {}), ...(otherItems !== null ? { other_items: format(otherItems, 2) } : {}), total: format(total, 2) };
}
export function normalizeDocument(kind, input) {
  need(KINDS.includes(kind), 'DOCUMENT_KIND_INVALID');
  keys(input, ['date', 'contact_id', 'warehouse_id', 'expected_date', 'valid_until', 'next_contact', 'template', 'items', 'discount_mode', 'discount_value', 'freight', 'other_expenses', 'installments', 'commercial', 'number', 'refresh_contact', 'tax_ipi', 'tax_icms_st', 'custom_fields', ...Object.keys(TEXT_FIELDS), ...EXTENSION_FIELDS]);
  // 202610200129 "Editar número": a requested number travels with the body but is never part of it (the server checks the preference).
  need(input.number === undefined || documentNumber(input.number), 'DOCUMENT_NUMBER_INVALID');
  // 202610200168 "Editar contato": refresh_contact=true asks the save for the current data of the contact; never part of the body.
  need(input.refresh_contact === undefined || input.refresh_contact === true, 'DOCUMENT_REFRESH_INVALID');
  need(new TextEncoder().encode(JSON.stringify(input)).byteLength <= 262144, 'DOCUMENT_BODY_LIMIT');
  need(input.template === undefined || typeof input.template === 'boolean', 'DOCUMENT_TEMPLATE_INVALID');
  need(!input.template || kind === 'sales_proposals', 'DOCUMENT_TEMPLATE_INVALID');
  need(Array.isArray(input.items) && (kind === 'service_orders' || input.items.length > 0), 'DOCUMENT_ITEMS_INVALID');
  const totals = calculateDocument(input);
  const seen = new Set();
  const items = input.items.map((item, index) => {
    keys(item, ['id', 'product_id', 'description', 'code', 'unit', 'quantity', 'unit_price', 'discount_percent', 'detailed_description', 'list_price', 'supplier_code', 'group', 'quote', 'done', 'lots', 'warranty_days', 'ipi_rate']);
    const id = uuid(item.id);
    if (id) { need(!seen.has(id), 'DOCUMENT_ITEM_ID_DUPLICATE'); seen.add(id); }
    // 202610200287: Informar lotes, Garantia of the item of the OS and IPI % of the item of the pedido de compra (kept only when informed).
    const lots = normalizeItemLots(kind, item, decimal(item.quantity, 6, 9), item.group), warranty = itemWarranty(kind, item.warranty_days), ipiRate = itemIpiRate(kind, item.ipi_rate);
    const extras = { ...(lots ? { lots } : {}), ...(warranty !== undefined ? { warranty_days: warranty } : {}), ...(ipiRate !== undefined ? { ipi_rate: ipiRate } : {}) };
    return { id, product_id: uuid(item.product_id), description: text(item.description, 200, true), code: text(item.code, 100),
      unit: text(item.unit, 16, true), quantity: format(decimal(item.quantity, 6, 9), 6), unit_price: priceValue(item.unit_price),
      discount_percent: format(percent(item.discount_percent ?? '0'), 4), position: index + 1, ...totals.items[index],
      ...(Object.hasOwn(item,'detailed_description') ? {detailed_description:commercialText(item.detailed_description,4000,true)} : {}),
      // 202610200196: Preço lista (reference price of the Lista de preço or of the product) and Código no fornecedor (pedido de compra).
      ...(Object.hasOwn(item,'list_price') ? {list_price:item.list_price === null ? null : priceValue(item.list_price)} : {}),
      ...(Object.hasOwn(item,'supplier_code') ? {supplier_code:supplierCode(kind,item.supplier_code)} : {}), ...serviceItemExtras(kind, item), ...extras };
  });
  const installments = input.installments ?? [];
  need(Array.isArray(installments) && installments.length <= 120, 'DOCUMENT_INSTALLMENTS_INVALID');
  let installmentsTotal = 0n;
  const planned = installments.map((row, index) => {
    keys(row, ['due_date', 'amount', 'method', 'note', 'payment_reference', 'payment_method_id', 'details']);
    const value = amount(row.amount); need(value > 0n, 'DOCUMENT_INSTALLMENT_AMOUNT_INVALID'); installmentsTotal += value;
    return { position: index + 1, due_date: date(row.due_date, true), amount: format(value, 2), method: text(row.method, 100),
      ...(Object.hasOwn(row,'note') ? {note:commercialText(row.note,2000,true)} : {}),
      ...(Object.hasOwn(row,'payment_reference') ? {payment_reference:normalizeCommercialReference(row.payment_reference)} : {}),
      // 202610200196: Forma (Cadastros › Formas de pagamento) and "Detalhes da parcela" (not in propostas).
      ...(Object.hasOwn(row,'payment_method_id') ? {payment_method_id:uuid(row.payment_method_id)} : {}),
      ...(Object.hasOwn(row,'details') ? {details:installmentDetails(kind,row.details,value)} : {}) };
  });
  need(!planned.length || installmentsTotal === amount(totals.total), 'DOCUMENT_INSTALLMENT_TOTAL_MISMATCH');
  const result = { date: date(input.date, true), contact_id: uuid(input.contact_id, true), warehouse_id: uuid(input.warehouse_id),
    expected_date: date(input.expected_date), valid_until: date(input.valid_until), next_contact: date(input.next_contact), template: input.template ?? false,
    items, discount_mode: input.discount_mode ?? 'amount', discount_value: input.discount_mode === 'percent' ? format(percent(input.discount_value ?? '0'), 4) : format(amount(input.discount_value ?? '0'), 2),
    freight: totals.freight, other_expenses: totals.other_expenses, installments: planned, totals };
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (['equipment', 'serial_number', 'technician', 'defect', 'solution'].includes(field) && kind !== 'service_orders') need(input[field] == null || input[field] === '', 'DOCUMENT_SERVICE_FIELD_INVALID');
    result[field] = text(input[field], max, false, MULTILINE_FIELDS.includes(field));
  }
  for (const key of EXTENSION_FIELDS) if (Object.hasOwn(input, key)) result[key] = extensionValue(key, input[key] === undefined ? null : input[key]);
  need(kind !== 'purchase_orders' || !result.seller_id, 'DOCUMENT_SELLER_INVALID');
  need(kind !== 'sales_proposals' || !result.category_id, 'DOCUMENT_CATEGORY_INVALID');
  need(!result.price_list_id || kind !== 'purchase_orders', 'DOCUMENT_PRICE_LIST_INVALID');
  need(!result.payment_account_id || kind !== 'sales_proposals', 'DOCUMENT_PAYMENT_INVALID');
  need((!result.payment_means && !result.payment_indicator) || kind === 'sales_orders', 'DOCUMENT_PAYMENT_INVALID');
  need((!result.other_items && !result.commercial_conditions) || kind === 'sales_proposals', 'DOCUMENT_OTHER_ITEMS_INVALID');
  // Condições comerciais Nenhum or Texto: the proposta carries no parcelas.
  need(!result.commercial_conditions || result.commercial_conditions.mode === 'installments' || planned.length === 0, 'DOCUMENT_CONDITIONS_INVALID');
  // 202610200287: the pedido de compra takes the IPI only from the IPI % of the items (a tax_ipi sent with them is not kept).
  // Leva H (EST-041, 390): it also takes the Total ICMS ST (campo), which adds to the total like the IPI.
  const rated = items.some(item => item.ipi_rate !== undefined);
  for (const key of ['tax_ipi', 'tax_icms_st']) if (Object.hasOwn(input, key) && !(key === 'tax_ipi' && rated)) {
    result[key] = totals[key === 'tax_ipi' ? 'ipi' : 'icms_st'];
    need(result[key] === '0.00' || kind !== 'purchase_orders' || key === 'tax_icms_st', 'DOCUMENT_TAX_INVALID');
  }
  const customFields = normalizeCustomFields(kind, input.custom_fields);
  if (customFields) result.custom_fields = customFields;
  if (Object.hasOwn(input,'commercial')) {
    result.commercial = normalizeCommercial(input.commercial);
    need(result.commercial?.transport?.freight_mode !== '9' || amount(result.freight) === 0n, 'DOCUMENT_TRANSPORT_CONFLICT');
  }
  return result;
}
