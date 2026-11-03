/**
 * /v1/frente-caixa: Vendas > Frente de caixa (PDV) no padrão do Origin (migrações 202610200204-206). O SQL decide; aqui cada
 * parâmetro e cada campo do corpo são conferidos antes (400) e cada resposta é conferida depois (502). Nada aqui emite nota fiscal
 * ou movimenta banco: a venda grava o pedido de venda e os efeitos de estoque e contas pelas RPCs das outras áreas, no banco.
 */
import { normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';

const PREFIX = '/v1/frente-caixa';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, DAY = /^\d{4}-\d{2}-\d{2}$/, CENTS = /^\d{1,14}$/, CONTROL = /[\x00-\x1f\x7f]/, AREA_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;
const DECIMAL = (scale, digits = 16) => new RegExp(`^-?(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{1,${scale}})?$`);
const BODY_LIMIT = 262144;
const SETTINGS_ACTIONS = ['settings_save', 'favorite_add', 'favorite_remove'], SALE_ACTIONS = ['sale_save', 'sale_finish', 'sale_cancel', 'sale_transfer'], RETURN_ACTIONS = ['sale_return'];
const ROLES = ['admin', 'consulta', 'vendas', 'financeiro', 'estoque', 'fiscal'];
// 202610200245: Venda Agenciada and Faturado parcialmente (a sale of the PDV may be moved in Pedidos de venda).
const DOCUMENT_STATUSES = ['draft', 'open', 'verified', 'in_progress', 'agency_sale', 'checkout_partial', 'partially_fulfilled', 'partially_invoiced', 'fulfilled', 'cancelled'];
export class PosError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new PosError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new PosError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys, required = keys) => object(value) && Object.keys(value).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(value, key));
const isUuid = value => typeof value === 'string' && UUID.test(value);
const isDay = value => typeof value === 'string' && DAY.test(value) && value >= '1900-01-01' && value <= '2100-12-31' && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const str = (value, max, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= max && !CONTROL.test(value));
// Display names read from cadastros and contas (also the ones mirrored from Origin): any text up to the size; React escapes it.
const label = (value, max, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
const area = (value, max) => value === null || (typeof value === 'string' && value.length <= max && !AREA_CONTROL.test(value));
const cents = value => typeof value === 'string' && CENTS.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const stamp = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));

export function posRoute(pathname) {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  const rest = pathname.slice(PREFIX.length);
  if (rest === '') return { kind: 'context' };
  if (rest === '/vendas') return { kind: 'sales' };
  if (rest === '/favoritos') return { kind: 'favorites' };
  let match = /^\/vendas\/([^/]+)$/.exec(rest);
  if (match) return isUuid(match[1]) ? { kind: 'sale', id: match[1].toLowerCase() } : { kind: 'unknown' };
  match = /^\/pedidos\/([^/]+)$/.exec(rest);
  if (match) return isUuid(match[1]) ? { kind: 'order', id: match[1].toLowerCase() } : { kind: 'unknown' };
  match = /^\/caixas\/([^/]+)\/resumo$/.exec(rest);
  if (match) return isUuid(match[1]) ? { kind: 'summary', id: match[1].toLowerCase() } : { kind: 'unknown' };
  match = /^\/actions\/([a-z_]{1,40})$/.exec(rest);
  if (match && [...SETTINGS_ACTIONS, ...SALE_ACTIONS, ...RETURN_ACTIONS].includes(match[1])) return { kind: 'action', action: match[1] };
  return { kind: 'unknown' };
}
export const posMethods = route => route?.kind === 'action' ? ['POST'] : route?.kind === 'unknown' ? ['GET', 'POST'] : ['GET'];

async function readBody(request) {
  const length = request.headers.get('content-length');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !request.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))) invalid();
  if (request.headers.has('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, text = '';
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > BODY_LIMIT) invalid(); text += decoder.decode(part.value, { stream: true }); }
    const parsed = JSON.parse(text + decoder.decode()); if (!object(parsed)) invalid(); return parsed;
  } catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log body data. */ } reader.releaseLock(); }
}
function params(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) invalid();
  return key => url.searchParams.get(key);
}
const pageNumber = (value, fallback, max) => { if (value === null) return fallback; if (!/^[1-9]\d{0,5}$/.test(value) || Number(value) > max) invalid(); return Number(value); };
const queryDay = value => { if (value === null) return null; if (!isDay(value)) invalid(); return value; };
const queryId = value => { if (value === null) return null; if (!isUuid(value)) invalid(); return value.toLowerCase(); };

// ---------------------------------------------------------------- Corpo dos comandos
const id = (value, nullable = false) => { if (nullable && value === null) return null; if (!isUuid(value)) invalid(); return value.toLowerCase(); };
const version = (value, min = 1) => { if (!integer(value, min, 2147483646)) invalid(); return value; };
const text = (value, max, nullable = true) => { if (nullable && value === null) return null; if (!str(value, max) || (!nullable && !value.trim())) invalid(); return value; };
const DOCUMENT_KEYS = ['date', 'warehouse_id', 'expected_date', 'items', 'discount_mode', 'discount_value', 'freight', 'other_expenses', 'notes', 'internal_notes', 'seller_id', 'category_id'];
const ITEM_KEYS = ['id', 'product_id', 'description', 'code', 'unit', 'quantity', 'unit_price', 'discount_percent', 'detailed_description'];
function document(value, payments) {
  if (!exact(value, DOCUMENT_KEYS, ['date', 'items']) || !isDay(value.date) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 250) invalid();
  const items = value.items.map(item => {
    if (!exact(item, ITEM_KEYS, ITEM_KEYS) || !isUuid(item.id)) invalid();
    return { ...item, id: item.id.toLowerCase(), product_id: item.product_id === null ? null : id(item.product_id) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) invalid();
  const out = { ...value, items };
  for (const key of ['warehouse_id', 'seller_id', 'category_id']) if (Object.hasOwn(value, key)) out[key] = id(value[key], true);
  // The same contract as the pedido de venda (document domain); the database checks it again.
  const installments = payments.map(row => ({ due_date: value.date, amount: `${BigInt(row.amount_cents) / 100n}.${String(BigInt(row.amount_cents) % 100n).padStart(2, '0')}`, method: 'Forma', note: row.note, payment_reference: null }));
  try { normalizeDocument('sales_orders', { ...out, contact_id: '00000000-0000-4000-8000-000000000000', installments }); } catch { invalid(); }
  if (Object.hasOwn(value, 'notes') && !area(value.notes, 4000)) invalid();
  if (Object.hasOwn(value, 'internal_notes') && !area(value.internal_notes, 4000)) invalid();
  return out;
}
function payments(value) {
  if (!Array.isArray(value) || value.length > 120) invalid();
  return value.map(row => {
    if (!exact(row, ['payment_method_id', 'days', 'amount_cents', 'note']) || !integer(row.days, 0, 9999) || !cents(row.amount_cents) || /^0+$/.test(row.amount_cents) || !area(row.note, 2000)) invalid();
    return { payment_method_id: id(row.payment_method_id), days: row.days, amount_cents: row.amount_cents, note: row.note };
  });
}
// document_version: the version of the pedido the screen read (null for a new sale); the open sale is saved only over it.
const SALE_KEYS = ['sale_id', 'expected_version', 'document_version', 'kind', 'table_number', 'account_id', 'cash_session_id', 'contact_id', 'price_list_id', 'document', 'payments', 'destination_account_id', 'to_ledger', 'cash_received_cents'];
function saleData(value) {
  if (!exact(value, SALE_KEYS) || !['balcao', 'mesa'].includes(value.kind) || (value.kind === 'mesa') !== (value.table_number !== null)
    || (value.table_number !== null && !integer(value.table_number, 1, 9999)) || (value.cash_received_cents !== null && !cents(value.cash_received_cents))
    || typeof value.to_ledger !== 'boolean' || (value.to_ledger && (value.destination_account_id !== null || value.contact_id === null))) invalid();
  const sale = id(value.sale_id, true);
  if (sale === null ? value.expected_version !== 0 || value.document_version !== null : !integer(value.expected_version, 1, 2147483646) || !integer(value.document_version, 1, 2147483646)) invalid();
  const rows = payments(value.payments);
  return { sale_id: sale, expected_version: value.expected_version, document_version: value.document_version, kind: value.kind, table_number: value.table_number, account_id: id(value.account_id, true), cash_session_id: id(value.cash_session_id, true),
    contact_id: id(value.contact_id, true), price_list_id: id(value.price_list_id, true), document: document(value.document, rows), payments: rows, destination_account_id: id(value.destination_account_id, true), to_ledger: value.to_ledger,
    cash_received_cents: value.cash_received_cents };
}
const PIX_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'random'];
function actionData(action, value) {
  if (action === 'settings_save') {
    const keys = ['expected_version', 'consumer_contact_id', 'pix_key_type', 'pix_key', 'pix_merchant_name', 'pix_merchant_city'];
    if (!exact(value, keys) || !integer(value.expected_version, 0, 2147483646)) invalid();
    const pix = value.pix_key !== null;
    if (pix ? !PIX_TYPES.includes(value.pix_key_type) || !str(value.pix_key, 77) || !value.pix_key || value.pix_key !== value.pix_key.trim()
      || !str(value.pix_merchant_name, 25) || !/^[A-Za-z0-9 .,&/-]{1,25}$/.test(value.pix_merchant_name) || !str(value.pix_merchant_city, 15) || !/^[A-Za-z0-9 .-]{1,15}$/.test(value.pix_merchant_city)
      : value.pix_key_type !== null || value.pix_merchant_name !== null || value.pix_merchant_city !== null) invalid();
    return { ...value, consumer_contact_id: id(value.consumer_contact_id, true) };
  }
  if (action === 'favorite_add' || action === 'favorite_remove') { if (!exact(value, ['product_id'])) invalid(); return { product_id: id(value.product_id) }; }
  if (action === 'sale_save' || action === 'sale_finish') return saleData(value);
  if (action === 'sale_cancel') { if (!exact(value, ['sale_id', 'expected_version', 'reason']) || typeof value.reason !== 'string' || value.reason.trim().length < 3) invalid(); return { sale_id: id(value.sale_id), expected_version: version(value.expected_version), reason: text(value.reason, 1000, false) }; }
  if (action === 'sale_transfer') { if (!exact(value, ['sale_id', 'expected_version', 'table_number']) || !integer(value.table_number, 1, 9999)) invalid(); return { sale_id: id(value.sale_id), expected_version: version(value.expected_version), table_number: value.table_number }; }
  // sale_return
  if (!exact(value, ['sale_id', 'expected_version', 'items', 'refund_account_id', 'cash_session_id', 'reason']) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 250
    || typeof value.reason !== 'string' || value.reason.trim().length < 3) invalid();
  const items = value.items.map(row => { if (!exact(row, ['item_id', 'quantity']) || typeof row.quantity !== 'string' || !/^\d{1,9}(\.\d{1,6})?$/.test(row.quantity) || /^0+(\.0+)?$/.test(row.quantity)) invalid(); return { item_id: id(row.item_id), quantity: row.quantity }; });
  if (new Set(items.map(row => row.item_id)).size !== items.length) invalid();
  return { sale_id: id(value.sale_id), expected_version: version(value.expected_version), items, refund_account_id: id(value.refund_account_id, true), cash_session_id: id(value.cash_session_id, true), reason: text(value.reason, 500, false) };
}

// ---------------------------------------------------------------- Respostas
const named = (value, max = 200) => { if (!object(value) || !isUuid(value.id) || !label(value.name, max)) bad(); return { id: value.id, name: value.name }; };
const list = (value, max, map) => { if (!Array.isArray(value) || value.length > max) bad(); return value.map(map); };
const flag = value => { if (typeof value !== 'boolean') bad(); return value; };
const PERMISSIONS = ['operate', 'items', 'payments', 'finish', 'edit_price', 'remove_items', 'change_method'];
const PDV_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ',', '.'];
const SHORTCUT_ACTIONS = ['cliente', 'pagamento', 'produto', 'pesquisa', 'buscar', 'excluir', 'fechar', 'finalizar', 'imprimir', 'nova', 'favoritos', 'remover-gtin', 'sangria', 'suprimento', 'trocar-loja', 'balcao', 'mesa'];
function shortcuts(value) {
  if (!exact(value, SHORTCUT_ACTIONS) || SHORTCUT_ACTIONS.some(action => !PDV_KEYS.includes(value[action])) || new Set(Object.values(value)).size !== SHORTCUT_ACTIONS.length) bad();
  return Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action, value[action]]));
}
export function projectContext(value) {
  if (!object(value) || value.entity !== 'pos_context' || value.data_mode !== 'erp_native' || !isDay(value.today) || !ROLES.includes(value.role)
    || !exact(value.permissions, PERMISSIONS) || !exact(value.effects, ['stock', 'finance', 'cash', 'fiscal', 'settings', 'contacts']) || !integer(value.settings_version, 0, 2147483647)
    || !['missing', 'unknown', 'expired', 'valid'].includes(value.certificate)) bad();
  const s = value.settings, r = value.receipt;
  const settingKeys = ['tables', 'cash_control', 'cash_check_methods', 'unique_cash', 'default_operation', 'default_method', 'receipt_order', 'percent_discount', 'closing_statuses', 'negative_stock',
    'block_zero', 'item_discount', 'group_items', 'shortcuts', 'sales_negative_stock', 'free_items', 'seller_required'];
  if (!exact(s, settingKeys) || !['nenhum', 'gerar_nfce', 'comprovante', 'pre_venda', 'nfe_simplificada'].includes(s.default_operation) || !['nenhum', 'pix_qrcode_impresso'].includes(s.default_method)
    || !['alfabetica', 'insercao'].includes(s.receipt_order) || !Array.isArray(s.closing_statuses) || s.closing_statuses.some(item => !['atendido', 'verificado'].includes(item))
    || !exact(r, ['limit_description', 'code', 'notes', 'comments', 'discount', 'footer', 'font_size']) || !area(r.footer, 500) || !integer(r.font_size, 6, 72)) bad();
  const settings = { ...Object.fromEntries(['tables', 'cash_control', 'cash_check_methods', 'unique_cash', 'percent_discount', 'negative_stock', 'block_zero', 'item_discount', 'group_items', 'sales_negative_stock', 'free_items', 'seller_required'].map(key => [key, flag(s[key])])),
    default_operation: s.default_operation, default_method: s.default_method, receipt_order: s.receipt_order, closing_statuses: [...s.closing_statuses], shortcuts: shortcuts(s.shortcuts) };
  const receipt = { ...Object.fromEntries(['limit_description', 'code', 'notes', 'comments', 'discount'].map(key => [key, flag(r[key])])), footer: r.footer, font_size: r.font_size };
  const sessions = list(value.cash_sessions, 100, item => {
    if (!exact(item, ['id', 'account_id', 'account_name', 'operator_id', 'operator_name', 'opened_at', 'opened_on', 'change_cents', 'version', 'own']) || !isUuid(item.id) || !isUuid(item.account_id)
      || !label(item.account_name, 200) || !isUuid(item.operator_id) || !label(item.operator_name, 200) || !stamp(item.opened_at) || !isDay(item.opened_on) || !cents(item.change_cents) || !integer(item.version, 1, 2147483647) || typeof item.own !== 'boolean') bad();
    return { ...item };
  });
  const methods = list(value.methods, 200, item => {
    if (!exact(item, ['id', 'description', 'payment_type', 'destination', 'account_id', 'condition', 'is_default']) || !isUuid(item.id) || !label(item.description, 100) || !/^\d{2}$/.test(item.payment_type ?? '')
      || !['contas', 'ficha', 'caixa'].includes(item.destination) || (item.account_id !== null && !isUuid(item.account_id)) || !label(item.condition, 100, true) || typeof item.is_default !== 'boolean') bad();
    return { ...item };
  });
  const accounts = list(value.accounts, 200, item => { if (!exact(item, ['id', 'name', 'kind']) || !['bank', 'cash', 'other'].includes(item.kind)) bad(); return { ...named(item), kind: item.kind }; });
  const pix = value.pix === null ? null : (() => { const p = value.pix; if (!exact(p, ['key_type', 'key', 'merchant_name', 'merchant_city']) || !PIX_TYPES.includes(p.key_type) || !str(p.key, 77) || !str(p.merchant_name, 25) || !str(p.merchant_city, 15)) bad(); return { ...p }; })();
  const consumer = value.consumer === null ? null : (() => { if (!exact(value.consumer, ['id', 'name', 'active']) || typeof value.consumer.active !== 'boolean') bad(); return { ...named(value.consumer), active: value.consumer.active }; })();
  return { entity: 'pos_context', data_mode: 'erp_native', today: value.today, role: value.role,
    permissions: Object.fromEntries(PERMISSIONS.map(key => [key, flag(value.permissions[key])])), effects: Object.fromEntries(Object.keys(value.effects).sort().map(key => [key, flag(value.effects[key])])),
    settings, receipt, stores: list(value.stores, 100, item => { if (!exact(item, ['id', 'name'])) bad(); return named(item); }), accounts, cash_sessions: sessions, methods,
    warehouses: list(value.warehouses, 100, item => { if (!exact(item, ['id', 'name'])) bad(); return named(item); }),
    default_warehouse: value.default_warehouse === null ? null : named(value.default_warehouse), seller: value.seller === null ? null : named(value.seller), consumer, pix,
    certificate: value.certificate, settings_version: value.settings_version };
}

const DEC2 = DECIMAL(2), DEC4 = DECIMAL(4, 12), DEC6 = DECIMAL(6, 12), PRICE = DECIMAL(10, 12);
const EFFECT = ['posted', 'pending', 'none', 'reversed'];
// 202610200267: a Lançar estoque / Lançar contas / baixa à vista refused while finishing the sale stays pending with the erp_* code of
// the refusal; the answer carries only a short reason of the known list ('refused' for any other code).
const EFFECT_REASONS = Object.freeze({
  erp_stock_insufficient_or_excess_quantity: 'stock_policy', erp_stock_warehouse_unavailable: 'warehouse_unavailable', erp_document_warehouse_unavailable: 'warehouse_unavailable',
  erp_stock_product_unavailable: 'stock_product_unavailable', erp_document_stock_composition_unsupported: 'stock_product_unavailable', erp_document_stock_unit_mismatch: 'stock_product_unavailable',
  erp_finance_invalid_contact: 'contact_unavailable', erp_finance_invalid_category: 'category_unavailable', erp_document_finance_invalid_installment: 'installment_invalid',
  erp_finance_payment_before_opening: 'account_opening_date', erp_finance_invalid_account: 'account_invalid', erp_document_finance_account_unavailable: 'account_invalid',
  erp_finance_access_denied: 'permission_denied', erp_finance_permission_denied: 'permission_denied', erp_document_permission_denied: 'permission_denied', erp_stock_access_denied: 'permission_denied',
});
export const effectReason = value => typeof value !== 'string' || !/^erp_[a-z0-9_]{1,80}$/.test(value) ? bad() : EFFECT_REASONS[value] ?? 'refused';
function effects(value) {
  if (!object(value)) bad();
  if (!Object.keys(value).length) return {};
  if (!exact(value, ['stock', 'finance', 'settled_cents', 'open_cents', 'stock_reason', 'finance_reason', 'settle_reason'], ['stock', 'finance', 'settled_cents', 'open_cents'])
    || !EFFECT.includes(value.stock) || !EFFECT.includes(value.finance) || !cents(value.settled_cents) || !cents(value.open_cents)
    || (value.stock_reason !== undefined && value.stock !== 'pending' && value.stock !== 'reversed') || (value.finance_reason !== undefined && value.finance !== 'pending' && value.finance !== 'reversed')) bad();
  return { stock: value.stock, finance: value.finance, settled_cents: value.settled_cents, open_cents: value.open_cents,
    ...Object.fromEntries(['stock_reason', 'finance_reason', 'settle_reason'].filter(key => value[key] !== undefined).map(key => [key, effectReason(value[key])])) };
}
const SUMMARY_KEYS = ['id', 'document_id', 'number', 'document_version', 'status', 'state', 'kind', 'table_number', 'date', 'created_at', 'finished_at', 'cancelled_at', 'operator_id', 'operator_name',
  'account_id', 'account_name', 'cash_session_id', 'contact_id', 'contact_name', 'customer_identified', 'total_cents', 'cash_received_cents', 'change_cents', 'effects', 'invoice', 'version'];
// Lines of a devolução: the item of the sale, the quantity and its value (the description is on the item).
const returnLines = (value, items, max = 250) => list(value, max, line => {
  if (!exact(line, ['item_id', 'quantity', 'value_cents']) || !isUuid(line.item_id) || (items && !items.some(item => item.id === line.item_id)) || !DEC6.test(line.quantity ?? '') || !cents(line.value_cents)) bad();
  return { item_id: line.item_id, quantity: line.quantity, value_cents: line.value_cents };
});
const DETAIL_KEYS = ['price_list_id', 'destination_account_id', 'to_ledger', 'cancel_reason', 'warehouse_id', 'warehouse_name', 'seller_id', 'seller_name', 'category_id', 'expected_date', 'notes', 'internal_notes',
  'discount_mode', 'discount_value', 'freight', 'other_expenses', 'totals', 'contact_document', 'items', 'payments'];
export function projectSale(value, detail) {
  const keys = detail ? [...SUMMARY_KEYS, ...DETAIL_KEYS, 'returns', 'returned'] : SUMMARY_KEYS;
  if (!exact(value, keys, detail ? [...SUMMARY_KEYS, ...DETAIL_KEYS] : SUMMARY_KEYS) || !isUuid(value.id) || !isUuid(value.document_id) || typeof value.number !== 'string' || !/^[1-9]\d{0,9}$/.test(value.number)
    || !integer(value.document_version, 1, 2147483647) || !DOCUMENT_STATUSES.includes(value.status) || !['open', 'finished', 'cancelled'].includes(value.state) || !['balcao', 'mesa'].includes(value.kind)
    || (value.kind === 'mesa') !== (value.table_number !== null) || (value.table_number !== null && !integer(value.table_number, 1, 9999)) || !isDay(value.date) || !stamp(value.created_at)
    || (value.finished_at !== null && !stamp(value.finished_at)) || (value.cancelled_at !== null && !stamp(value.cancelled_at)) || (value.state === 'cancelled') !== (value.cancelled_at !== null)
    || (value.state === 'finished' && value.finished_at === null) || !isUuid(value.operator_id) || !label(value.operator_name, 200) || (value.account_id !== null && !isUuid(value.account_id))
    || !label(value.account_name, 200, true) || (value.account_id === null) !== (value.account_name === null) || (value.cash_session_id !== null && !isUuid(value.cash_session_id)) || !isUuid(value.contact_id)
    || !label(value.contact_name, 200) || typeof value.customer_identified !== 'boolean' || !cents(value.total_cents) || (value.cash_received_cents !== null && !cents(value.cash_received_cents))
    || !cents(value.change_cents) || !integer(value.version, 1, 2147483647)) bad();
  let invoice = null;
  if (value.invoice !== null) {
    const i = value.invoice;
    if (!exact(i, ['id', 'model', 'number', 'series', 'status']) || !isUuid(i.id) || !['55', '65'].includes(i.model) || (i.number !== null && !/^[1-9]\d{0,8}$/.test(i.number)) || !/^\d{1,3}$/.test(i.series ?? '') || !integer(i.status, 1, 16)) bad();
    invoice = { ...i };
  }
  const out = Object.fromEntries(SUMMARY_KEYS.map(key => [key, value[key]]));
  out.effects = effects(value.effects); out.invoice = invoice;
  if (!detail) return out;
  if ((value.price_list_id !== null && !isUuid(value.price_list_id)) || (value.destination_account_id !== null && !isUuid(value.destination_account_id)) || typeof value.to_ledger !== 'boolean' || !str(value.cancel_reason, 1000, true)
    || (value.warehouse_id !== null && !isUuid(value.warehouse_id)) || !label(value.warehouse_name, 200, true) || (value.seller_id !== null && !isUuid(value.seller_id)) || !label(value.seller_name, 200, true)
    || (value.category_id !== null && !isUuid(value.category_id)) || (value.expected_date !== null && !isDay(value.expected_date)) || !area(value.notes, 4000) || !area(value.internal_notes, 4000)
    || !['amount', 'percent'].includes(value.discount_mode) || !DEC4.test(value.discount_value ?? '') || !DEC2.test(value.freight ?? '') || !DEC2.test(value.other_expenses ?? '') || !label(value.contact_document, 20)) bad();
  const t = value.totals;
  if (!object(t) || ['gross', 'line_discount', 'subtotal', 'discount', 'freight', 'other_expenses', 'total'].some(key => !DEC2.test(t[key] ?? ''))) bad();
  const items = list(value.items, 250, item => {
    if (!exact(item, ['id', 'position', 'product_id', 'description', 'code', 'unit', 'quantity', 'unit_price', 'discount_percent', 'gross', 'discount', 'total', 'comment']) || !isUuid(item.id) || !integer(item.position, 1, 250)
      || (item.product_id !== null && !isUuid(item.product_id)) || !label(item.description, 200) || !label(item.code, 100, true) || !str(item.unit, 16) || !DEC6.test(item.quantity ?? '') || !PRICE.test(item.unit_price ?? '')
      || !DEC4.test(item.discount_percent ?? '') || ['gross', 'discount', 'total'].some(key => !DEC2.test(item[key] ?? '')) || !area(item.comment, 4000)) bad();
    return { ...item };
  });
  let paid = 0n;
  const rows = list(value.payments, 120, row => {
    if (!exact(row, ['position', 'payment_method_id', 'method_name', 'payment_type', 'days', 'due_on', 'amount_cents', 'note', 'title_id', 'settlement_id']) || !integer(row.position, 1, 120) || !isUuid(row.payment_method_id)
      || !label(row.method_name, 100) || !/^\d{2}$/.test(row.payment_type ?? '') || !integer(row.days, 0, 9999) || !isDay(row.due_on) || !cents(row.amount_cents) || !area(row.note, 2000)
      || (row.title_id !== null && !isUuid(row.title_id)) || (row.settlement_id !== null && !isUuid(row.settlement_id))) bad();
    paid += BigInt(row.amount_cents); return { ...row };
  });
  // The parcelas of an open sale may differ from a pedido edited in Pedidos de venda; a finished sale always matches.
  const total = BigInt(t.total.replace('.', ''));
  if (BigInt(value.total_cents) !== total || (value.state === 'finished' && rows.length && paid !== total)) bad();
  Object.assign(out, Object.fromEntries(DETAIL_KEYS.map(key => [key, value[key]])), { totals: Object.fromEntries(['gross', 'line_discount', 'subtotal', 'discount', 'freight', 'other_expenses', 'total'].map(key => [key, t[key]])), items, payments: rows });
  if (Object.hasOwn(value, 'returns')) {
    out.returns = list(value.returns, 20, row => {
      if (!exact(row, ['id', 'created_at', 'value_cents', 'refund_cents', 'reason', 'items', 'actor_name', 'stock', 'refund_account_id']) || !isUuid(row.id) || !stamp(row.created_at) || !cents(row.value_cents) || !cents(row.refund_cents)
        || BigInt(row.refund_cents) > BigInt(row.value_cents) || !str(row.reason, 500) || !label(row.actor_name, 200) || typeof row.stock !== 'boolean' || (row.refund_account_id !== null && !isUuid(row.refund_account_id))
        || (row.refund_account_id === null) !== (row.refund_cents === '0')) bad();
      return { ...row, items: returnLines(row.items, items) };
    });
  }
  if (Object.hasOwn(value, 'returned')) {
    if (!object(value.returned) || Object.entries(value.returned).some(([key, qty]) => !items.some(item => item.id === key) || !DEC6.test(qty))) bad();
    out.returned = { ...value.returned };
  }
  return out;
}
function salesPage(value, args) {
  if (!object(value) || value.entity !== 'pos_sales' || value.data_mode !== 'erp_native' || value.session_id !== args.p_session || value.state !== args.p_state || value.from !== args.p_from || value.to !== args.p_to
    || value.method_id !== args.p_method || value.page !== args.p_page || value.limit !== args.p_limit || !integer(value.total, 0, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(value.items) || value.items.length !== Math.max(0, Math.min(args.p_limit, value.total - (args.p_page - 1) * args.p_limit))) bad();
  const items = value.items.map(item => { const sale = projectSale(item, false); if ((args.p_state !== 'all' && sale.state !== args.p_state) || (args.p_session && sale.cash_session_id !== args.p_session)) bad(); return sale; });
  return { entity: 'pos_sales', data_mode: 'erp_native', session_id: args.p_session, state: args.p_state, from: args.p_from, to: args.p_to, method_id: args.p_method, page: args.p_page, limit: args.p_limit, total: value.total, items };
}
function favorites(value, warehouse) {
  if (!object(value) || value.entity !== 'pos_favorites' || value.data_mode !== 'erp_native' || value.warehouse_id !== warehouse) bad();
  const items = list(value.items, 200, item => {
    if (!exact(item, ['product_id', 'name', 'code', 'unit', 'price', 'gtin', 'active', 'kind', 'stock']) || !isUuid(item.product_id) || !label(item.name, 200) || !label(item.code, 60, true) || !label(item.unit, 16, true)
      || (item.price !== null && !PRICE.test(item.price)) || !label(item.gtin, 14, true) || typeof item.active !== 'boolean' || !['P', 'S', 'N', null].includes(item.kind) || (item.stock !== null && !DEC6.test(item.stock))) bad();
    return { ...item };
  });
  return { entity: 'pos_favorites', data_mode: 'erp_native', warehouse_id: warehouse, items };
}
function summary(value, session) {
  if (!object(value) || value.entity !== 'pos_cash_summary' || value.data_mode !== 'erp_native' || value.session_id !== session || !Array.isArray(value.statuses) || value.statuses.some(item => !['fulfilled', 'verified'].includes(item))
    || !integer(value.sales_count, 0, Number.MAX_SAFE_INTEGER) || !cents(value.total_cents) || !cents(value.returns_cents)) bad();
  const methods = list(value.methods, 100, item => { if (!exact(item, ['payment_method_id', 'name', 'payment_type', 'registered_cents', 'sales']) || !isUuid(item.payment_method_id) || !label(item.name, 100) || !/^\d{2}$/.test(item.payment_type ?? '')
    || !cents(item.registered_cents) || !integer(item.sales, 0, Number.MAX_SAFE_INTEGER)) bad(); return { ...item }; });
  const groups = list(value.groups, 100, item => { if (!exact(item, ['group_id', 'name', 'quantity', 'value', 'percent']) || (item.group_id !== null && !isUuid(item.group_id)) || !label(item.name, 100) || !DEC6.test(item.quantity ?? '')
    || !DEC2.test(item.value ?? '') || !/^\d{1,3}\.\d{2}$/.test(item.percent ?? '')) bad(); return { ...item }; });
  if (methods.reduce((sum, item) => sum + BigInt(item.registered_cents), 0n) !== BigInt(value.total_cents)) bad();
  return { entity: 'pos_cash_summary', data_mode: 'erp_native', session_id: session, statuses: [...value.statuses], sales_count: value.sales_count, total_cents: value.total_cents, returns_cents: value.returns_cents, methods, groups };
}
function actionResult(value, action, data) {
  if (!object(value) || value.action !== action || typeof value.replayed !== 'boolean' || value.data_mode !== 'erp_native') bad();
  const base = { action, replayed: value.replayed, data_mode: 'erp_native' };
  if (action === 'settings_save') {
    const r = value.record;
    if (value.entity !== 'pos_settings' || !exact(r, ['version', 'consumer_contact_id', 'pix_key_type', 'pix_key', 'pix_merchant_name', 'pix_merchant_city']) || !integer(r.version, 1, 2147483647)
      || r.consumer_contact_id !== data.consumer_contact_id || r.pix_key !== data.pix_key || r.pix_key_type !== data.pix_key_type) bad();
    return { ...base, entity: 'pos_settings', record: { ...r } };
  }
  if (action === 'favorite_add' || action === 'favorite_remove') {
    if (value.entity !== 'pos_favorites' || !exact(value.record, ['product_id', 'favorite']) || value.record.product_id !== data.product_id || value.record.favorite !== (action === 'favorite_add')) bad();
    return { ...base, entity: 'pos_favorites', record: { ...value.record } };
  }
  if (value.entity !== 'pos_sale') bad();
  const record = projectSale(value.record, true);
  if ((data.sale_id && record.id !== data.sale_id) || (action === 'sale_finish' && (record.state !== 'finished' || record.status !== 'fulfilled')) || (action === 'sale_save' && record.state !== 'open')
    || (action === 'sale_cancel' && record.state !== 'cancelled') || (action === 'sale_transfer' && record.table_number !== data.table_number)) bad();
  if (action !== 'sale_return') return { ...base, entity: 'pos_sale', record };
  const r = value.return;
  // 202610200292: how many contas a receber of the sale became Devolvido (a database before 292 does not send it).
  const titled = object(r) && Object.hasOwn(r, 'returned_titles');
  if (titled && (!Number.isInteger(r.returned_titles) || r.returned_titles < 0 || r.returned_titles > 120)) bad();
  if (!exact(r, ['value_cents', 'refund_cents', 'stock', 'refund', 'items', ...(titled ? ['returned_titles'] : [])]) || !cents(r.value_cents) || !cents(r.refund_cents) || BigInt(r.refund_cents) > BigInt(r.value_cents) || typeof r.stock !== 'boolean'
    || typeof r.refund !== 'boolean' || r.refund !== (r.refund_cents !== '0') || !Array.isArray(r.items) || r.items.length !== data.items.length || !Array.isArray(record.returns) || !object(record.returned)) bad();
  const lines = returnLines(r.items, record.items);
  if (lines.some((line, index) => line.item_id !== data.items[index].item_id)) bad();
  return { ...base, entity: 'pos_sale', record, return: { value_cents: r.value_cents, refund_cents: r.refund_cents, stock: r.stock, refund: r.refund, items: lines, ...(titled ? { returned_titles: r.returned_titles } : {}) } };
}

export async function parsePosRoute(request, route) {
  const url = new URL(request.url);
  if (!route || route.kind === 'unknown') throw new PosError(404, 'ERP_NOT_FOUND');
  if (!posMethods(route).includes(request.method)) throw new PosError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (route.kind === 'action') {
    if (url.search) invalid();
    const body = await readBody(request);
    if (!exact(body, ['command_id', 'data']) || !isUuid(body.command_id)) invalid();
    const data = actionData(route.action, body.data);
    const rpc = SETTINGS_ACTIONS.includes(route.action) ? 'erp_pos_settings_execute' : SALE_ACTIONS.includes(route.action) ? 'erp_pos_sale_execute' : 'erp_pos_return_execute';
    return { rpc, args: { p_command_id: body.command_id.toLowerCase(), p_action: route.action, p_data: data }, check: value => actionResult(value, route.action, data) };
  }
  if (route.kind === 'context') { params(url, []); return { rpc: 'erp_pos_context', args: {}, check: projectContext }; }
  if (route.kind === 'sale') { params(url, []); return { rpc: 'erp_pos_sale_get', args: { p_id: route.id }, check: value => { if (!object(value) || value.entity !== 'pos_sale' || value.data_mode !== 'erp_native') bad(); const record = projectSale(value.record, true); if (record.id !== route.id) bad(); return { entity: 'pos_sale', data_mode: 'erp_native', record }; } }; }
  if (route.kind === 'order') { params(url, []); return { rpc: 'erp_pos_order', args: { p_document_id: route.id }, check: value => {
    if (!object(value) || value.entity !== 'pos_order' || value.data_mode !== 'erp_native' || value.document_id !== route.id) bad();
    const r = value.record;
    if (r !== null && (!exact(r, ['sale_id', 'kind', 'table_number', 'state', 'account_name']) || !isUuid(r.sale_id) || !['balcao', 'mesa'].includes(r.kind) || (r.kind === 'mesa') !== (r.table_number !== null)
      || (r.table_number !== null && !integer(r.table_number, 1, 9999)) || !['open', 'finished', 'cancelled'].includes(r.state) || !label(r.account_name, 200, true))) bad();
    return { entity: 'pos_order', data_mode: 'erp_native', document_id: route.id, record: r === null ? null : { ...r } }; } }; }
  if (route.kind === 'summary') { params(url, []); return { rpc: 'erp_pos_cash_summary', args: { p_session: route.id }, check: value => summary(value, route.id) }; }
  if (route.kind === 'favorites') { const get = params(url, ['warehouse']), warehouse = queryId(get('warehouse')); return { rpc: 'erp_pos_favorites', args: { p_warehouse_id: warehouse }, check: value => favorites(value, warehouse) }; }
  const get = params(url, ['caixa', 'state', 'q', 'from', 'to', 'method', 'page', 'limit']);
  const state = get('state') ?? 'all', q = get('q'), from = queryDay(get('from')), to = queryDay(get('to'));
  if (!['all', 'open', 'finished', 'cancelled'].includes(state) || (q !== null && (q.length > 120 || CONTROL.test(q))) || (from && to && from > to)) invalid();
  const args = { p_session: queryId(get('caixa')), p_state: state, p_query: q?.trim() || null, p_from: from, p_to: to, p_method: queryId(get('method')), p_page: pageNumber(get('page'), 1, 10000), p_limit: pageNumber(get('limit'), 50, 50) };
  return { rpc: 'erp_pos_sales', args, check: value => salesPage(value, args) };
}
export async function executePosRoute(parsed, { userId, rpc }) {
  return parsed.check(await rpc(parsed.rpc, { ...parsed.args, p_user_id: userId }));
}
// Known refusals of the PDV and of the RPCs it calls become a short reason in `field` (the SQL message itself is never sent).
const REFUSALS = Object.freeze({
  erp_pos_consumer_required: 'consumer_required', erp_pos_cash_session_required: 'cash_session_required', erp_pos_cash_session_unavailable: 'cash_session_unavailable',
  erp_pos_stock_insufficient: 'stock_insufficient', erp_pos_stock_zero: 'stock_zero', erp_stock_insufficient_or_excess_quantity: 'stock_policy', erp_pos_payments_mismatch: 'payments_mismatch',
  erp_pos_payments_required: 'payments_required', erp_pos_cash_received_invalid: 'cash_received_invalid', erp_pos_edit_price_denied: 'edit_price_denied', erp_pos_remove_items_denied: 'remove_items_denied',
  erp_pos_change_method_denied: 'change_method_denied', erp_pos_items_denied: 'items_denied', erp_pos_payments_denied: 'payments_denied', erp_pos_finish_denied: 'finish_denied',
  erp_pos_access_denied: 'access_denied', erp_pos_tables_disabled: 'tables_disabled', erp_pos_table_busy: 'table_busy', erp_pos_sale_invoice_linked: 'invoice_linked', erp_pos_sale_state: 'sale_state',
  erp_pos_document_state: 'document_state', erp_pos_version_conflict: 'version_conflict', erp_pos_return_exceeds: 'return_exceeds', erp_pos_reverse_stock_denied: 'reverse_stock_denied',
  erp_pos_reverse_finance_denied: 'reverse_finance_denied', erp_pos_return_stock_denied: 'return_stock_denied', erp_pos_return_finance_denied: 'return_finance_denied',
  erp_pos_sale_has_returns: 'sale_has_returns', erp_pos_return_exceeds_paid: 'return_exceeds_paid', erp_pos_return_effects_pending: 'return_effects_pending', erp_pos_returns_limit: 'returns_limit',
  erp_pos_invalid_price_list: 'price_list_unavailable', erp_pos_invalid_pix_key: 'pix_key_invalid', erp_pos_favorites_limit: 'favorites_limit', erp_pos_invalid_store: 'store_invalid', erp_pos_invalid_date: 'date_invalid',
  erp_pos_invalid_contact: 'contact_unavailable', erp_pos_ledger_requires_contact: 'ledger_requires_contact', erp_pos_invalid_payment_method: 'payment_method_unavailable', erp_pos_reason_required: 'reason_required',
  erp_document_seller_discount_limit: 'seller_discount_limit', erp_document_seller_required: 'seller_required', erp_document_product_required: 'product_required',
  erp_document_seller_product_required: 'product_required', erp_document_transition_invalid: 'transition_unavailable', erp_document_transition_inactive: 'transition_unavailable',
  erp_document_price_decimals: 'price_decimals', erp_document_contact_unavailable: 'contact_unavailable', erp_document_price_list_unavailable: 'price_list_unavailable', erp_document_warehouse_unavailable: 'warehouse_unavailable',
  erp_stock_warehouse_unavailable: 'warehouse_unavailable', erp_stock_product_unavailable: 'stock_product_unavailable', erp_document_stock_composition_unsupported: 'stock_product_unavailable',
  erp_document_stock_unit_mismatch: 'stock_product_unavailable', erp_document_finance_reverse_blocked: 'finance_reverse_blocked', erp_finance_payment_before_opening: 'account_opening_date',
  erp_finance_invalid_account: 'account_invalid', erp_document_state_locked: 'document_state', erp_document_version_conflict: 'version_conflict',
  // 202610200292: the full return marks the open contas as Devolvido (a parcela partly received, boleto or agrupada blocks it).
  erp_pos_return_partial_title: 'return_partial_title', erp_finance_active_payments: 'return_partial_title', erp_finance_billed_locked: 'return_titles_locked',
  erp_finance_source_locked: 'return_titles_locked', erp_finance_title_already_returned: 'return_titles_locked',
  // 202610200287: Preferências › Empresa "Número de casas decimais na quantidade" also holds for the pedido of the venda.
  erp_document_quantity_decimals: 'quantity_decimals',
});
export function posRefusal(message) { return typeof message === 'string' && Object.hasOwn(REFUSALS, message) ? REFUSALS[message] : null; }
