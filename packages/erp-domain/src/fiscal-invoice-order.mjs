/**
 * "Gerar nota fiscal" / "Gerar NFC-e" from a pedido (migration 202610200176): strict check of the order projection the
 * database returns, and the IPI / ICMS ST estimate of pedidos and propostas through the note's own tax engine.
 * Nothing here writes: the note is saved only by the form's Salvar (erp_fiscal_invoice_execute).
 */
import { FiscalSpecError, UFS } from './fiscal-invoice-dto.mjs';
import { invoiceTotals, natureRecord, normalizeInvoiceInput, normalizeTaxSettings } from './fiscal-invoice-contract.mjs';
import { calculateInvoiceTaxes } from '../../fiscal-core/src/tax-engine.mjs';

const fail = () => { throw new FiscalSpecError('FISCAL_RESPONSE_INVALID'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,10})?$/;
const DATE = /^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
/** exact() with keys a newer database adds (202610200215) and an older one leaves out. */
const exactWith = (value, keys, optional) => plain(value) && keys.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => keys.includes(k) || optional.includes(k));
const textOrNull = (value, max) => value === null || (typeof value === 'string' && [...value].length <= max);
const need = test => { if (!test) fail(); };

/** Origin "Erro ao gerar a Nota fiscal — Motivo: …" codes; the screen shows the Portuguese text. */
export const ORDER_REASONS = Object.freeze({
  cancelled: 'O pedido está cancelado.',
  no_items: 'O pedido não tem itens.',
  no_products: 'A ordem de serviço não tem produtos (peças): os serviços ficam fora da NF-e.',
  has_invoice: 'O pedido já tem nota fiscal.',
  international: 'Pedido internacional: o contato é estrangeiro e a nota de exportação ainda não está disponível no Brufap.',
  quantity_precision: 'A nota fiscal aceita quantidades com até 4 casas decimais.',
  stock_negative: 'O estoque ficaria negativo no depósito do pedido (Preferências › Suprimentos › Estoque: "Permite geração de NF a partir da venda e ordem de serviço com estoque negativo" está desligada).',
});
const CONTACT_KEYS = ['contact_id', 'name', 'code', 'active', 'trade_name', 'person_type', 'document', 'ie', 'email', 'phone', 'mobile', 'postal_code', 'street', 'number', 'complement', 'district',
  'city', 'state', 'taxpayer', 'country', 'nfe_email'];
const PRODUCT_KEYS = ['kind', 'ncm', 'gtin', 'gtin_tax', 'cest', 'origin', 'gross_weight', 'net_weight', 'volumes'];
const DELIVERY_KEYS = ['name', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement', 'country'];
// 202610200215 (erp_fiscal_invoice_order_source_v2): the vendedor and the transportador of the pedido and the parcels rule.
const V2_KEYS = ['seller', 'carrier', 'keep_order_dates'];
const CARRIER_KEYS = ['contact_id', 'name', 'active', 'person_type', 'document', 'ie', 'postal_code', 'street', 'number', 'complement', 'district', 'city', 'state'];
const sellerRef = value => value === null || (exact(value, ['id', 'name']) && UUID.test(value.id) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200);
const carrierRef = value => value === null || (exact(value, CARRIER_KEYS) && UUID.test(value.contact_id) && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200
  && typeof value.active === 'boolean' && (value.person_type === null || ['J', 'F', 'E'].includes(value.person_type)) && CARRIER_KEYS.filter(k => !['contact_id', 'name', 'active', 'person_type'].includes(k)).every(k => textOrNull(value[k], 1000)));
/** A contact of the cadastro as the note copies it (the pedido contact of 176 and GET /v1/notas-fiscais/contato/{id}). */
function contactRecord(c) {
  need(exact(c, CONTACT_KEYS) && UUID.test(c.contact_id) && typeof c.name === 'string' && c.name.length > 0 && c.name.length <= 200 && typeof c.active === 'boolean'
    && (c.person_type === null || ['J', 'F', 'E'].includes(c.person_type)) && (c.taxpayer === null || ['1', '2', '9'].includes(c.taxpayer))
    && CONTACT_KEYS.filter(k => !['contact_id', 'name', 'active', 'person_type', 'taxpayer'].includes(k)).every(k => textOrNull(c[k], 1000)));
  return { ...c };
}
const natureRef = value => value === null || (exact(value, ['id', 'description', 'crt']) && UUID.test(value.id) && typeof value.description === 'string' && value.description.length > 0
  && [...value.description].length <= 60 && ['1', '2', '3', '4'].includes(value.crt));
/**
 * GET /v1/notas-fiscais/contato/{id} (erp_fiscal_invoice_contact_source, 202610200215): the contact picked in the note form with
 * Contribuinte, e-mail da NF-e, natureza de operação padrão (same direction; the form checks the regime) and vendedor.
 */
export function contactSourceRecord(value, contactId) {
  need(exact(value, ['contact', 'nature', 'seller', 'writable', 'data_mode']) && value.data_mode === 'erp_native' && typeof value.writable === 'boolean' && natureRef(value.nature) && sellerRef(value.seller));
  const contact = contactRecord(value.contact);
  need(contactId === undefined || contact.contact_id === contactId);
  return { contact, nature: value.nature && { ...value.nature }, seller: value.seller && { ...value.seller }, writable: value.writable, data_mode: 'erp_native' };
}

/**
 * GET /v1/notas-fiscais/historico-item (erp_fiscal_invoice_item_history, 202610200218): "Histórico do produto para o cliente", the
 * last 20 notes of the same contact with the same product (Origin mirror and Brufap notes), newest first.
 */
export function itemHistoryRecord(value, { contactId, productId, direction }) {
  need(exact(value, ['items', 'contact_id', 'product_id', 'direction', 'data_mode']) && value.data_mode === 'erp_native' && value.contact_id === contactId && value.product_id === productId
    && value.direction === direction && Array.isArray(value.items) && value.items.length <= 20);
  const items = value.items.map(i => {
    need(exact(i, ['origin', 'id', 'number', 'series', 'issue_date', 'issue_type', 'quantity', 'unit_price', 'total']) && ['brufap', 'origin'].includes(i.origin)
      && (i.origin === 'brufap' ? UUID.test(i.id ?? '') && /^[NDETSCIX]$/.test(i.issue_type ?? '') : /^\d{1,40}$/.test(i.id ?? '') && i.issue_type === null)
      && (i.number === null || (Number.isInteger(i.number) && i.number > 0)) && (i.series === null || (Number.isInteger(i.series) && i.series >= 0)) && (i.issue_date === null || DATE.test(i.issue_date))
      && (i.quantity === null || (typeof i.quantity === 'string' && DECIMAL.test(i.quantity))) && (i.unit_price === null || (typeof i.unit_price === 'string' && DECIMAL.test(i.unit_price)))
      && (i.total === null || (typeof i.total === 'string' && MONEY.test(i.total))));
    return { ...i };
  });
  return { items, contact_id: value.contact_id, product_id: value.product_id, direction: value.direction, data_mode: 'erp_native' };
}
const PAYMENT_TYPES = ['01', '02', '03', '04', '05', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '90', '91', '99'];
/** GET /v1/notas-fiscais/formas-pagamento (erp_fiscal_invoice_payment_methods, 202610200219): "Forma" of the parcels. */
export function paymentMethodsRecord(value, direction) {
  need(exact(value, ['direction', 'items', 'data_mode']) && value.data_mode === 'erp_native' && value.direction === direction && Array.isArray(value.items) && value.items.length <= 200);
  const items = value.items.map(m => {
    need(exact(m, ['id', 'description', 'payment_type', 'card_brand', 'card_integration', 'card_cnpj']) && UUID.test(m.id ?? '') && typeof m.description === 'string' && m.description.length > 0 && m.description.length <= 100
      && PAYMENT_TYPES.includes(m.payment_type) && (m.card_brand === null || /^\d{2}$/.test(m.card_brand)) && (m.card_integration === null || ['1', '2'].includes(m.card_integration))
      && (m.card_cnpj === null || /^[A-Z0-9]{12}\d{2}$/.test(m.card_cnpj)));
    return { ...m };
  });
  need(new Set(items.map(m => m.id)).size === items.length);
  return { direction, items, data_mode: 'erp_native' };
}
/** GET /v1/notas-fiscais/devolucoes/{key} (erp_fiscal_invoice_returned, 202610200220): the Brufap returns of a note and what they returned. */
export function returnedRecord(value, key) {
  need(exact(value, ['key', 'returns', 'items', 'data_mode']) && value.data_mode === 'erp_native' && value.key === key && Array.isArray(value.returns) && value.returns.length <= 50
    && Array.isArray(value.items) && value.items.length <= 990);
  const returns = value.returns.map(r => { need(exact(r, ['id', 'model', 'direction', 'number', 'series', 'issue_date', 'status']) && UUID.test(r.id ?? '') && ['55', '65'].includes(r.model) && ['0', '1'].includes(r.direction)
    && (r.number === null || (Number.isInteger(r.number) && r.number > 0)) && Number.isInteger(r.series) && r.series >= 0 && DATE.test(r.issue_date ?? '') && Number.isInteger(r.status)); return { ...r }; });
  const items = value.items.map(i => { need(exact(i, ['product_id', 'code', 'description', 'quantity']) && (i.product_id === null || UUID.test(i.product_id)) && textOrNull(i.code, 60) && textOrNull(i.description, 120)
    && typeof i.quantity === 'string' && DECIMAL.test(i.quantity)); return { ...i }; });
  return { key, returns, items, data_mode: 'erp_native' };
}
/** GET /v1/notas-fiscais/chave/{key} (erp_fiscal_invoice_key_lookup, 202610200219): the note of a referenced access key. */
export function keyLookupRecord(value, key) {
  need(exact(value, ['key', 'items', 'data_mode']) && value.data_mode === 'erp_native' && value.key === key && Array.isArray(value.items) && value.items.length <= 6);
  const items = value.items.map(i => {
    need(exact(i, ['origin', 'id', 'model', 'direction', 'number', 'series', 'issue_date', 'name', 'total']) && ['brufap', 'origin'].includes(i.origin)
      && (i.origin === 'brufap' ? UUID.test(i.id ?? '') : /^\d{1,40}$/.test(i.id ?? '')) && ['55', '65'].includes(i.model) && (i.direction === null || ['0', '1'].includes(i.direction))
      && (i.number === null || (Number.isInteger(i.number) && i.number > 0)) && (i.series === null || (Number.isInteger(i.series) && i.series >= 0)) && (i.issue_date === null || DATE.test(i.issue_date))
      && textOrNull(i.name, 200) && (i.total === null || (typeof i.total === 'string' && MONEY.test(i.total))));
    return { ...i };
  });
  return { key, items, data_mode: 'erp_native' };
}
/** Validates the projection of GET /v1/notas-fiscais/pedido/{id} (erp_fiscal_invoice_order_source). */
// 202610200254 (erp_fiscal_invoice_order_source_v3): Detalhes de pagamento of the pedido, Forma and Detalhes of each parcel, and the
// composition of each item when "Desmembrar produtos ... em uma estrutura na nota fiscal" is on.
const DETAIL_KEYS = ['payment_type', 'card_brand', 'integration_type', 'acquirer_cnpj', 'authorization_code', 'received_amount', 'fee_amount', 'commission_fee_amount'];
const COMPONENT_KEYS = ['position', 'product_id', 'description', 'code', 'unit', 'quantity', 'price', 'product'];
function compositionRecord(c) {
  if (c === null) return null;
  need(exact(c, ['stock_type', 'problem', 'components']) && ['physical', 'virtual'].includes(c.stock_type) && (c.problem === null || ['structure_missing', 'component_unavailable'].includes(c.problem))
    && Array.isArray(c.components) && c.components.length <= 100 && (c.problem !== null || c.components.length > 0));
  const components = c.components.map((k, index) => {
    need(index < 100 && exact(k, COMPONENT_KEYS) && Number.isInteger(k.position) && k.position >= 1 && k.position <= 100);
    need(UUID.test(k.product_id ?? '') && typeof k.description === 'string' && k.description.length > 0 && k.description.length <= 200 && textOrNull(k.code, 100) && textOrNull(k.unit, 16)
      && typeof k.quantity === 'string' && /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(k.quantity) && /[1-9]/.test(k.quantity) && (k.price === null || (typeof k.price === 'string' && DECIMAL.test(k.price))));
    const p = k.product;
    need(exact(p, PRODUCT_KEYS) && (p.kind === null || ['P', 'S', 'N'].includes(p.kind)) && PRODUCT_KEYS.filter(x => x !== 'kind').every(x => textOrNull(p[x], 60)));
    return { ...k, product: { ...p } };
  });
  need(new Set(components.map(k => k.position)).size === components.length);
  return { stock_type: c.stock_type, problem: c.problem, components };
}
function formaRecord(m) {
  need(m === null || (exact(m, ['id', 'description', 'payment_type', 'card_brand', 'card_integration', 'card_cnpj', 'active']) && UUID.test(m.id ?? '') && typeof m.description === 'string' && m.description.length > 0
    && m.description.length <= 100 && PAYMENT_TYPES.includes(m.payment_type) && (m.card_brand === null || /^\d{2}$/.test(m.card_brand)) && (m.card_integration === null || ['1', '2'].includes(m.card_integration))
    && (m.card_cnpj === null || /^[A-Z0-9]{12}\d{2}$/.test(m.card_cnpj)) && typeof m.active === 'boolean'));
  return m && { ...m };
}
function parcelDetails(d) {
  need(d === null || (exact(d, DETAIL_KEYS) && (d.payment_type === null || PAYMENT_TYPES.includes(d.payment_type)) && (d.card_brand === null || /^\d{2}$/.test(d.card_brand))
    && (d.integration_type === null || ['1', '2'].includes(d.integration_type)) && (d.acquirer_cnpj === null || /^[A-Z0-9]{12}\d{2}$/.test(d.acquirer_cnpj))
    && (d.authorization_code === null || (typeof d.authorization_code === 'string' && /^[A-Za-z0-9./-]{1,128}$/.test(d.authorization_code)))
    && ['received_amount', 'fee_amount', 'commission_fee_amount'].every(k => d[k] === null || (typeof d[k] === 'string' && MONEY.test(d[k])))));
  return d && { ...d };
}
export function orderSourceRecord(value) {
  const v3 = plain(value) && Object.hasOwn(value, 'payment');
  need(exactWith(value, ['document', 'direction', 'model', 'eligible', 'reasons', 'contact', 'nature', 'items', 'totals', 'installments', 'delivery', 'transport', 'existing_invoice', 'writable',
    'emission_enabled', 'production_enabled', 'data_mode'], [...V2_KEYS, 'payment']) && V2_KEYS.every(k => Object.hasOwn(value, k)) === V2_KEYS.some(k => Object.hasOwn(value, k)) && (!v3 || Object.hasOwn(value, 'keep_order_dates'))
    && value.emission_enabled === false && value.production_enabled === false && value.data_mode === 'erp_native' && typeof value.writable === 'boolean');
  need(!v3 || (exact(value.payment, ['means', 'indicator']) && (value.payment.means === null || PAYMENT_TYPES.includes(value.payment.means)) && (value.payment.indicator === null || ['0', '1'].includes(value.payment.indicator))));
  const d = value.document;
  need(exact(d, ['id', 'kind', 'number', 'version', 'status', 'date', 'ship_date', 'customer_po_number', 'notes', 'warehouse_id', 'stock_active', 'finance_active']) && UUID.test(d.id)
    && ['sales_orders', 'purchase_orders', 'service_orders'].includes(d.kind) && typeof d.number === 'string' && /^[1-9][0-9]{0,9}$/.test(d.number) && Number.isInteger(d.version) && d.version > 0
    && typeof d.status === 'string' && /^[a-z_]{1,30}$/.test(d.status) && (d.date === null || DATE.test(d.date)) && (d.ship_date === null || DATE.test(d.ship_date))
    && textOrNull(d.customer_po_number, 60) && textOrNull(d.notes, 4000) && (d.warehouse_id === null || UUID.test(d.warehouse_id))
    && typeof d.stock_active === 'boolean' && typeof d.finance_active === 'boolean');
  need(value.direction === (d.kind === 'purchase_orders' ? '0' : '1') && ['55', '65'].includes(value.model) && (value.model === '55' || d.kind === 'sales_orders'));
  need(Array.isArray(value.reasons) && value.reasons.length <= 10 && typeof value.eligible === 'boolean' && value.eligible === (value.reasons.length === 0));
  const reasons = value.reasons.map(r => { need(exact(r, ['code', 'items']) && Object.hasOwn(ORDER_REASONS, r.code) && Array.isArray(r.items) && r.items.length <= 250 && r.items.every(n => Number.isInteger(n) && n >= 1 && n <= 250)); return { code: r.code, items: [...r.items] }; });
  need(new Set(reasons.map(r => r.code)).size === reasons.length);
  const c = contactRecord(value.contact);
  need(natureRef(value.nature));
  const v2 = Object.hasOwn(value, 'keep_order_dates');
  need(!v2 || (sellerRef(value.seller) && carrierRef(value.carrier) && typeof value.keep_order_dates === 'boolean'));
  need(Array.isArray(value.items) && value.items.length <= 250);
  const items = value.items.map((item, index) => {
    need(exact(item, ['position', 'product_id', 'description', 'code', 'unit', 'quantity', 'unit_price', 'gross', 'discount', 'total', 'product', ...(v3 ? ['composition'] : [])]) && item.position === index + 1
      && (item.product_id === null || UUID.test(item.product_id)) && typeof item.description === 'string' && item.description.length > 0 && item.description.length <= 200 && textOrNull(item.code, 100)
      && typeof item.unit === 'string' && item.unit.length > 0 && item.unit.length <= 16 && typeof item.quantity === 'string' && DECIMAL.test(item.quantity) && /^[^.]*(\.\d{1,6})?$/.test(item.quantity)
      && typeof item.unit_price === 'string' && DECIMAL.test(item.unit_price) && ['gross', 'discount', 'total'].every(k => typeof item[k] === 'string' && MONEY.test(item[k])));
    const p = item.product;
    need(p === null || (exact(p, PRODUCT_KEYS) && (p.kind === null || ['P', 'S', 'N'].includes(p.kind)) && PRODUCT_KEYS.filter(k => k !== 'kind').every(k => textOrNull(p[k], 60))
      && ['gross_weight', 'net_weight'].every(k => p[k] === null || DECIMAL.test(p[k])) && (p.volumes === null || /^(0|[1-9][0-9]{0,5})$/.test(p.volumes))));
    need(p === null || item.product_id !== null);
    const composition = v3 ? compositionRecord(item.composition) : null;
    need(composition === null || item.product_id !== null);
    return { ...item, product: p === null ? null : { ...p }, composition };
  });
  const t = value.totals;
  need(exact(t, ['gross', 'line_discount', 'discount', 'freight', 'other_expenses', 'total']) && Object.values(t).every(v => typeof v === 'string' && MONEY.test(v)));
  need(Array.isArray(value.installments) && value.installments.length <= 120);
  const installments = value.installments.map((i, index) => {
    need(exact(i, ['position', 'due_date', 'amount', 'method', 'note', ...(v3 ? ['payment_method', 'details'] : [])]) && i.position === index + 1 && typeof i.due_date === 'string' && DATE.test(i.due_date) && typeof i.amount === 'string' && MONEY.test(i.amount)
      && textOrNull(i.method, 100) && textOrNull(i.note, 2000));
    return { ...i, payment_method: v3 ? formaRecord(i.payment_method) : null, details: v3 ? parcelDetails(i.details) : null };
  });
  need(value.delivery === null || (exact(value.delivery, DELIVERY_KEYS) && DELIVERY_KEYS.every(k => textOrNull(value.delivery[k], 120))));
  const tr = value.transport;
  need(tr === null || (exact(tr, ['freight_mode', 'volume_count', 'gross_weight', 'tracking_code', 'carrier_label']) && (tr.freight_mode === null || ['0', '1', '2', '3', '4', '9'].includes(tr.freight_mode))
    && ['volume_count', 'gross_weight'].every(k => tr[k] === null || (typeof tr[k] === 'string' && DECIMAL.test(tr[k]))) && textOrNull(tr.tracking_code, 200) && textOrNull(tr.carrier_label, 200)));
  const e = value.existing_invoice;
  need(e === null || (exact(e, ['id', 'model', 'number', 'status']) && UUID.test(e.id) && ['55', '65'].includes(e.model) && (e.number === null || (Number.isInteger(e.number) && e.number > 0)) && Number.isInteger(e.status)));
  need(reasons.some(r => r.code === 'has_invoice') === (e !== null));
  return { document: { ...d }, direction: value.direction, model: value.model, eligible: value.eligible, reasons, contact: { ...c }, nature: value.nature && { ...value.nature }, items,
    totals: { ...t }, installments, delivery: value.delivery && { ...value.delivery }, transport: tr && { ...tr }, existing_invoice: e && { ...e }, writable: value.writable,
    // Before 202610200215 the pedido carries no seller nor carrier and the parcels keep the pedido due dates (wave C behaviour).
    seller: v2 ? value.seller && { ...value.seller } : null, carrier: v2 ? value.carrier && { ...value.carrier } : null, keep_order_dates: v2 ? value.keep_order_dates : true,
    // Before 202610200254 the pedido carries no Detalhes de pagamento (the note keeps its own defaults).
    payment: v3 ? { means: value.payment.means, indicator: value.payment.indicator } : { means: null, indicator: null },
    emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
}

// ---- "Total do IPI" and "Total do ICMS ST" of pedidos de venda and propostas comerciais ----
const ESTIMATE_KINDS = ['sales_orders', 'sales_proposals'];
const QUANTITY = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const PRICE = /^(0|[1-9][0-9]{0,10})(\.[0-9]{1,10})?$/;
const AMOUNT = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;
/** Body of POST /v1/notas-fiscais/estimativa: the unsaved items and totals of the document being edited. */
export function estimateRequest(body) {
  const bad = () => { throw new FiscalSpecError('FISCAL_VALUE_INVALID'); };
  if (!exact(body, ['kind', 'contact_id', 'items', 'discount', 'freight', 'other_expenses']) || !ESTIMATE_KINDS.includes(body.kind) || !(body.contact_id === null || (typeof body.contact_id === 'string' && UUID.test(body.contact_id.toLowerCase())))
    || !Array.isArray(body.items) || body.items.length > 250 || ['discount', 'freight', 'other_expenses'].some(k => typeof body[k] !== 'string' || !AMOUNT.test(body[k]))) bad();
  const items = body.items.map(i => {
    if (!exact(i, ['product_id', 'quantity', 'unit_price']) || !(i.product_id === null || (typeof i.product_id === 'string' && UUID.test(i.product_id.toLowerCase())))
      || typeof i.quantity !== 'string' || !QUANTITY.test(i.quantity) || /^0(\.0+)?$/.test(i.quantity) || typeof i.unit_price !== 'string' || !PRICE.test(i.unit_price)) bad();
    // The document keeps six decimals ("2.500000"); trailing zeros are not precision.
    const trim = (value) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
    return { product_id: i.product_id?.toLowerCase() ?? null, quantity: trim(i.quantity), unit_price: trim(i.unit_price) };
  });
  return { kind: body.kind, contact_id: body.contact_id?.toLowerCase() ?? null, items, discount: body.discount, freight: body.freight, other_expenses: body.other_expenses };
}
/** GET /v1/notas-fiscais/estimativa carries the request in the query (a read, never a command): items as "product,quantity,price;…". */
export const ESTIMATE_MAX_ITEMS = 60;
export function estimateSearch(request) {
  return new URLSearchParams({ kind: request.kind, ...(request.contact_id ? { contact_id: request.contact_id } : {}),
    items: request.items.map(i => `${i.product_id ?? '-'},${i.quantity},${i.unit_price}`).join(';'), discount: request.discount, freight: request.freight, other_expenses: request.other_expenses });
}
/** Reads the query back into the request shape (the Worker then checks it with estimateRequest). */
export function estimateFromQuery(get) {
  const items = (get('items') ?? '').split(';');
  if (!get('items') || items.length > ESTIMATE_MAX_ITEMS) throw new FiscalSpecError('FISCAL_VALUE_INVALID');
  return estimateRequest({ kind: get('kind'), contact_id: get('contact_id'), discount: get('discount'), freight: get('freight'), other_expenses: get('other_expenses'),
    items: items.map(text => { const parts = text.split(','); if (parts.length !== 3) throw new FiscalSpecError('FISCAL_VALUE_INVALID'); return { product_id: parts[0] === '-' ? null : parts[0], quantity: parts[1], unit_price: parts[2] }; }) });
}
const sumCents = values => values.reduce((total, v) => total + BigInt(v.replace('.', '')), 0n);
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const cents = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)); };
/**
 * Runs the note's "Cálculo automático" on the document items with the natureza of the contact (or the default "Padrão
 * venda"), its rules and the global tax settings. The result is an estimate for the screen; it never reaches a note.
 */
export function estimateTaxes(context, request, today) {
  need(exact(context, ['enabled', 'company', 'recipient', 'nature', 'settings', 'difal_by_state', 'products', 'data_mode']) && context.data_mode === 'erp_native' && typeof context.enabled === 'boolean'
    && exact(context.company, ['crt', 'state']) && (context.company.crt === null || ['1', '2', '3', '4'].includes(context.company.crt)) && (context.company.state === null || UFS.includes(context.company.state))
    && (context.recipient === null || (exact(context.recipient, ['person_type', 'state', 'ie', 'taxpayer']) && (context.recipient.person_type === null || ['J', 'F', 'E'].includes(context.recipient.person_type))
      && textOrNull(context.recipient.state, 60) && textOrNull(context.recipient.ie, 60) && (context.recipient.taxpayer === null || ['1', '2', '9'].includes(context.recipient.taxpayer))))
    && Array.isArray(context.products) && context.products.length <= 250);
  // 202610200216 (erp_fiscal_tax_estimate_context_v2): the group of each product, for the "Grupo de Produtos" rules.
  const products = new Map(context.products.map(p => { need(exactWith(p, ['id', 'ncm', 'kind'], ['group_id']) && UUID.test(p.id) && textOrNull(p.ncm, 60) && (p.kind === null || ['P', 'S', 'N'].includes(p.kind))
    && (p.group_id === undefined || p.group_id === null || UUID.test(p.group_id))); return [p.id, p]; }));
  need(request.items.every(i => i.product_id === null || products.has(i.product_id)));
  let nature = null, taxes;
  try { taxes = normalizeTaxSettings(context.settings, context.difal_by_state); } catch { fail(); }
  if (context.nature !== null) { try { nature = natureRecord(context.nature); } catch { fail(); } need(nature.direction === '1'); }
  const out = (available, reason = null, items = [], totals = { ipi: '0.00', st: '0.00', total: null }) => ({ enabled: context.enabled, available, reason,
    nature: nature && { id: nature.id, description: nature.description }, items, totals, data_mode: 'erp_native' });
  if (!request.items.length) return out(false, 'no_items');
  if (!nature) return out(false, 'no_nature');
  if (!context.company.crt || nature.crt !== context.company.crt) return out(false, 'regime');
  if (request.items.some(i => /\.\d{5,}$/.test(i.quantity))) return out(false, 'quantity_precision');
  const r = context.recipient, state = r?.state && /^[A-Za-z]{2}$/.test(r.state) ? r.state.toUpperCase() : null;
  const recipient = { name: 'Estimativa', ...(r?.person_type ? { person_type: r.person_type } : {}), ...(state && (UFS.includes(state) || state === 'EX') ? { state } : {}), ...(r?.taxpayer ? { ie_indicator: r.taxpayer } : {}) };
  let invoice;
  try {
    invoice = normalizeInvoiceInput({ model: '55', direction: '1', issue_type: 'N', series: '1', number: null, access_key: null, nature_id: nature.id, nature_description: nature.description, cfop: null,
      issue_date: today, exit_date: null, exit_time: null, crt: context.company.crt, purpose: '1', credit_debit_type: null, presence: '1', final_consumer: nature.final_consumer, recipient,
      export: null, import_declaration: null, references: [], auto_tax: true, items: request.items.map(i => {
        const ncm = i.product_id ? products.get(i.product_id).ncm : null;
        return { ...(i.product_id ? { product_id: i.product_id } : {}), description: 'Item', quantity: i.quantity, unit_price: i.unit_price, ...(ncm && /^\d{8}$/.test(ncm) ? { ncm } : {}) };
      }), freight: request.freight, insurance: '0', other_expenses: request.other_expenses, discount: request.discount, transport: { mode: 'none' }, payment: { installments: [] },
      authorized_xml: [], intermediary: { present: false }, additional_info: null, nature_additional_info: null, nature_fiscal_info: null });
  } catch (error) { if (error instanceof FiscalSpecError) return out(false, 'invalid'); throw error; }
  let computed;
  const productGroups = Object.fromEntries([...products.values()].filter(p => p.group_id).map(p => [p.id, p.group_id]));
  try { computed = calculateInvoiceTaxes(invoice, { natures: { [nature.id]: nature }, settings: taxes.settings, difalByState: taxes.difal_by_state, options: { companyState: context.company.state }, productGroups }).invoice; invoiceTotals(computed); }
  catch (error) { if (error instanceof FiscalSpecError) return out(false, 'invalid'); throw error; }
  const items = computed.items.map((item, index) => ({ product_id: request.items[index].product_id, ipi: item.ipi?.value ?? '0.00', st: item.icms?.st_value ?? '0.00' }));
  const totals = invoiceTotals(computed).totals;
  // "Total do ICMS ST" is vST; the estimate adds IPI and ICMS ST to the commercial total of the document, like Origin does on the order.
  const commercial = cents(totals.products) - cents(totals.discount) + cents(totals.freight) + cents(totals.other_expenses);
  return out(true, null, items, { ipi: money(sumCents(items.map(i => i.ipi))), st: money(sumCents(items.map(i => i.st))), total: money(commercial + sumCents(items.map(i => i.ipi)) + sumCents(items.map(i => i.st))) });
}
/** Validates the estimate the Worker returns (the screen trusts nothing it did not check). */
export function estimateResult(value) {
  need(exact(value, ['enabled', 'available', 'reason', 'nature', 'items', 'totals', 'data_mode']) && typeof value.enabled === 'boolean' && typeof value.available === 'boolean' && value.data_mode === 'erp_native'
    && (value.available ? value.reason === null : ['no_items', 'no_nature', 'regime', 'quantity_precision', 'invalid'].includes(value.reason))
    && (value.nature === null || (exact(value.nature, ['id', 'description']) && UUID.test(value.nature.id) && typeof value.nature.description === 'string'))
    && Array.isArray(value.items) && value.items.length <= 250 && value.items.every(i => exact(i, ['product_id', 'ipi', 'st']) && (i.product_id === null || UUID.test(i.product_id)) && MONEY.test(i.ipi) && MONEY.test(i.st))
    && exact(value.totals, ['ipi', 'st', 'total']) && MONEY.test(value.totals.ipi) && MONEY.test(value.totals.st) && (value.totals.total === null || MONEY.test(value.totals.total))
    && (value.available ? value.totals.total !== null && money(sumCents(value.items.map(i => i.ipi))) === value.totals.ipi && money(sumCents(value.items.map(i => i.st))) === value.totals.st
      : value.items.length === 0 && value.totals.total === null));
  return { enabled: value.enabled, available: value.available, reason: value.reason, nature: value.nature && { ...value.nature }, items: value.items.map(i => ({ ...i })), totals: { ...value.totals }, data_mode: 'erp_native' };
}
