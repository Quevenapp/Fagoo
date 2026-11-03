/**
 * /v1/notas-fiscais: Origin-style invoice lists (Origin mirror and Brufap homologation tests), Brufap's own notes,
 * operation natures, global tax settings and the homologation event queue (migrations 202610200111-114).
 * No route here emits, signs, transmits, reserves numbers or creates stock/finance effects.
 */
import {
  FiscalSpecError,
} from '../../../packages/erp-domain/src/fiscal-invoice-dto.mjs';
import {
  originDetail, eventRecord, invoicePreferences, invoiceRecord, invoiceTotals, listPage, natureRecord, natureSummary, normalizeImportedInput, normalizeInvoiceInput, normalizeNatureInput, normalizeTaxSettings,
} from '../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import { IMPORT_MAX_BYTES, InvoiceImportError, invoiceImportCandidates } from '../../../packages/fiscal-xml/src/invoice-import.mjs';
import { parseInvoiceBalance, capturePartialItems, SalesInvoiceBalanceError } from '../../../packages/erp-domain/src/sales-invoice-balance.mjs';
// Notas lane (wave F, 202610200274): the signature of the imported XML.
import { SignatureCheckError, verifyNfeSignature } from '../../../packages/fiscal-xml/src/xml-signature-check.mjs';
// Notas lane (wave F, 202610200273): the native XML of a note of the Brufap ("Validar", "Gerar XML (suporte)").
import { NativeInvoiceError, validateNativeInvoice } from '../../../packages/fiscal-xml/src/native-invoice.mjs';
import { SchemaError } from '../../../packages/fiscal-xml/src/schema-check.mjs';
import { contactSourceRecord, estimateFromQuery, estimateTaxes, itemHistoryRecord, keyLookupRecord, orderSourceRecord, paymentMethodsRecord, returnedRecord } from '../../../packages/erp-domain/src/fiscal-invoice-order.mjs';

const PREFIX = '/v1/notas-fiscais';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 2 * 1024 * 1024;
export class FiscalInvoicesError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new FiscalInvoicesError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new FiscalInvoicesError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const version = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const timestamp = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
// Leva H (391): the balance contract throws its own error; any refusal of it is the same 400 (input) or 502 (answer).
const balanceOr = (fn, onError) => { try { return fn(); } catch (error) { if (error instanceof SalesInvoiceBalanceError) return onError(); throw error; } };
const guard = (fn, onError = invalid) => { try { return fn(); } catch (error) { if (error instanceof FiscalSpecError) return onError(); throw error; } };
const exact = (value, keys, required = keys) => object(value) && Object.keys(value).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(value, k));

export function fiscalInvoicesRoute(pathname) {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  const rest = pathname.slice(PREFIX.length);
  if (rest === '') return { kind: 'invoices' };
  if (rest === '/contexto') return { kind: 'context' };
  if (rest === '/naturezas') return { kind: 'natures' };
  if (rest === '/impostos') return { kind: 'taxes' };
  if (rest === '/eventos') return { kind: 'events' };
  if (rest === '/naturezas/revisao') return { kind: 'nature_review' };
  if (rest === '/importar') return { kind: 'import' };
  // Wave F: "Editar NF-e" of Notas recebidas — the entry note read from the XML, to be completed and saved in the form (nothing is stored).
  if (rest === '/importar/previa') return { kind: 'import_preview' };
  // 202610200176: "Gerar nota fiscal" from a pedido and the IPI / ICMS ST estimate of pedidos and propostas.
  if (rest === '/estimativa') return { kind: 'estimate' };
  if (rest === '/vinculos') return { kind: 'link_states' };
  // 202610200216: the group of the products of the note items ("Grupo de Produtos" rules).
  if (rest === '/grupos-produtos') return { kind: 'product_groups' };
  // 202610200218: "Histórico do produto para o cliente" of a note item.
  if (rest === '/historico-item') return { kind: 'item_history' };
  // 202610200252: "P" Preços atualizados of the entry notes of a page.
  if (rest === '/precos') return { kind: 'pricing_states' };
  // 202610200219: "Forma" of the parcels from the cadastro and the note of a referenced access key.
  if (rest === '/formas-pagamento') return { kind: 'payment_methods' };
  const keyMatch = /^\/chave\/([0-9]{44})$/.exec(rest);
  if (keyMatch) return { kind: 'key_lookup', key: keyMatch[1] };
  // 202610200220: "Devolução de produto" — what the Brufap returns of the note already returned.
  const returnedMatch = /^\/devolucoes\/([0-9]{44})$/.exec(rest);
  if (returnedMatch) return { kind: 'returned', key: returnedMatch[1] };
  // Leva H (391): "Resumo de faturamento" of a pedido de venda and "Gerar nota fiscal parcial".
  if (rest === '/parcial') return { kind: 'partial' };
  let match = /^\/pedido\/([0-9a-fA-F-]{36})\/saldo$/.exec(rest);
  if (match && UUID.test(match[1])) return { kind: 'order_balance', id: match[1].toLowerCase() };
  match = /^\/pedido\/([0-9a-fA-F-]{36})$/.exec(rest);
  if (match && UUID.test(match[1])) return { kind: 'order_source', id: match[1].toLowerCase() };
  // 202610200215: the contact picked in the note form (Contribuinte, natureza padrão, vendedor).
  match = /^\/contato\/([0-9a-fA-F-]{36})$/.exec(rest);
  if (match && UUID.test(match[1])) return { kind: 'contact_source', id: match[1].toLowerCase() };
  // 202610200275: the item links of a note with one pedido de compra ("Vincular à pedido de compra" item a item).
  match = /^\/([0-9a-fA-F-]{36})\/pedidos\/([0-9a-fA-F-]{36})$/.exec(rest);
  if (match && UUID.test(match[1]) && UUID.test(match[2])) return { kind: 'order_items', id: match[1].toLowerCase(), documentId: match[2].toLowerCase() };
  match = /^\/naturezas\/([0-9a-fA-F-]{36})$/.exec(rest);
  if (match && UUID.test(match[1])) return { kind: 'nature', id: match[1].toLowerCase() };
  match = /^\/origin\/(nfe|nfce)\/([0-9]{1,40})$/.exec(rest);
  if (match) return { kind: 'origin', entity: match[1], sourceId: match[2] };
  match = /^\/([0-9a-fA-F-]{36})(\/excluir|\/pedidos|\/xml|\/xml-nativo|\/conciliar|\/precos)?$/.exec(rest);
  if (match && UUID.test(match[1])) return { kind: { '/excluir': 'delete', '/pedidos': 'orders', '/xml': 'xml', '/xml-nativo': 'native_xml', '/conciliar': 'reconcile', '/precos': 'pricing' }[match[2]] ?? 'invoice', id: match[1].toLowerCase() };
  return { kind: 'unknown' };
}
const METHODS = { partial: ['POST'], order_balance: ['GET'], native_xml: ['GET'], order_items: ['GET'], import_preview: ['POST'], pricing: ['POST'], pricing_states: ['GET'], invoices: ['GET', 'POST'], context: ['GET'], order_source: ['GET'], contact_source: ['GET'], product_groups: ['GET'], item_history: ['GET'], payment_methods: ['GET'], key_lookup: ['GET'], returned: ['GET'], estimate: ['GET'], link_states: ['POST'], invoice: ['GET', 'PATCH'], delete: ['POST'], orders: ['POST'], xml: ['GET'], reconcile: ['POST'], import: ['POST'], origin: ['GET'],
  natures: ['GET', 'POST'], nature: ['GET'], taxes: ['GET', 'POST'], events: ['GET', 'POST'], nature_review: ['POST'], unknown: ['GET'] };
export const fiscalInvoicesMethods = route => METHODS[route?.kind] ?? ['GET'];
// Notas lane (wave F): the refusals the screen explains (the SQL message itself never leaves the Worker). Contas posted by the note
// (247, or a Faturamento agrupado) keep it from being deleted and keep its parcelas, total and destinatário; stock posted by it (259)
// keeps it from being deleted until "Estornar estoque".
const REFUSALS = Object.freeze({ erp_fiscal_invoice_active_finance: 'finance_posted', erp_invoice_stock_posted_delete: 'stock_posted',
  // 202610200275: "Vincular à pedido de compra" item a item.
  erp_fiscal_invoice_link_item_exceeds: 'link_item_exceeds', erp_fiscal_invoice_link_item_product_mismatch: 'link_item_product',
  // Leva H (391): Gerar nota fiscal parcial.
  erp_fiscal_invoice_partial_exceeds: 'partial_exceeds', erp_fiscal_invoice_partial_mismatch: 'partial_mismatch', erp_fiscal_invoice_partial_locked: 'partial_locked',
  erp_fiscal_invoice_partial_status: 'partial_status', erp_fiscal_invoice_order_has_invoice: 'has_invoice', erp_fiscal_invoice_partial_item_invalid: 'partial_item' });
export const fiscalInvoicesRefusal = message => typeof message === 'string' && Object.hasOwn(REFUSALS, message) ? REFUSALS[message] : null;

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
const integer = (value, fallback, min, max) => { if (value === null) return fallback; if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) invalid(); return Number(value); };
const date = value => {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2099-12-31' || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
};
const searchText = (value, max = 120) => { if (value === null) return null; if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(); return value.trim() || null; };
const commandId = value => { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); };
const expected = value => { if (!version(value)) invalid(); return value; };

const LIST_PARAMS = ['origin', 'model', 'direction', 'page', 'limit', 'order', 'q', 'date_type', 'date_from', 'date_to', 'status', 'product_id', 'state', 'nature', 'carrier', 'trade_name',
  'person_type', 'document', 'email', 'phone', 'series', 'contact_code', 'order_number', 'tracking', 'seller_id',
  // Produtos lane (202610200236): Tags (tag=none|<id>) of the Marcadores, answered by erp_catalog_invoice_list_tagged.
  'tag',
  // Espelho lane (wave H, 202610210358): Categoria of the contas lançadas by a note of the Brufap (NFE-024, NFE-172).
  'category_id'];
const STATUS_GROUPS = ['pending', 'issued', 'authorized', 'cancelled', 'denied', 'registered', 'contingency'];
const UF = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO','EX'];
function listArgs(url) {
  const get = params(url, LIST_PARAMS);
  const origin = get('origin') ?? 'origin', model = get('model'), direction = get('direction') ?? '1', order = get('order') ?? 'date_desc', dateType = get('date_type') ?? 'issue';
  const status = get('status'), state = get('state'), person = get('person_type'), product = get('product_id'), series = get('series'), seller = get('seller_id');
  if (!['origin', 'brufap'].includes(origin) || !['55', '65'].includes(model) || !['0', '1'].includes(direction) || (model === '65' && direction !== '1')
    || !['date_desc', 'date_asc', 'number_desc', 'number_asc'].includes(order) || !['issue', 'entry'].includes(dateType) || (status !== null && !STATUS_GROUPS.includes(status))
    || (state !== null && !UF.includes(state)) || (person !== null && !['J', 'F', 'E'].includes(person)) || (product !== null && !UUID.test(product))
    || (series !== null && !/^(0|[1-9][0-9]{0,2})$/.test(series)) || (seller !== null && !UUID.test(seller))) invalid();
  const from = date(get('date_from')), to = date(get('date_to'));
  if (from && to && from > to) invalid();
  return { p_origin: origin, p_model: model, p_direction: direction, p_page: integer(get('page'), 1, 1, 100000), p_limit: integer(get('limit'), 100, 1, 100), p_order: order,
    p_query: searchText(get('q')), p_date_type: dateType, p_date_from: from, p_date_to: to, p_status: status, p_product_id: product?.toLowerCase() ?? null, p_state: state,
    p_nature: searchText(get('nature')), p_carrier: searchText(get('carrier')), p_trade_name: searchText(get('trade_name')), p_person_type: person, p_document: searchText(get('document'), 30),
    p_email: searchText(get('email')), p_phone: searchText(get('phone'), 40), p_series: series === null ? null : Number(series), p_contact_code: searchText(get('contact_code'), 100),
    p_order_number: searchText(get('order_number'), 20), p_tracking: searchText(get('tracking')),
    // "Vendedor" (202610200215): sent only when used, so a database before that migration still answers the other filters.
    ...(seller !== null ? { p_seller_id: seller.toLowerCase() } : {}),
    ...(() => { const tag = get('tag'); if (tag !== null && tag !== 'none' && !UUID.test(tag)) invalid(); return tag !== null ? { p_tag: tag.toLowerCase() } : {}; })(),
    // Categoria exists only for the notes of the Brufap (the Origin notes have no contas linked in the Brufap); sent only when used.
    ...(() => { const category = get('category_id'); if (category !== null && (!UUID.test(category) || origin !== 'brufap')) invalid(); return category !== null ? { p_category_id: category.toLowerCase() } : {}; })() };
}
const invoiceEnvelope = (value, check = () => {}) => guard(() => {
  if (!object(value) || value.emission_enabled !== false || value.production_enabled !== false || value.operational_effects !== false || value.data_mode !== 'erp_native' || typeof value.writable !== 'boolean') bad();
  const invoice = invoiceRecord(value.invoice);
  // Imported notes (S/X) are read-only: the stored XML is their source (migration 202610200143).
  if (value.writable !== (invoice.deleted_at === null && [1, 5, 8, 12].includes(invoice.status) && !['S', 'X'].includes(invoice.issue_type))) bad();
  check(invoice, value);
  return { invoice, writable: value.writable, emission_enabled: false, production_enabled: false, operational_effects: false, data_mode: 'erp_native',
    ...(Object.hasOwn(value, 'action') ? { action: value.action, replayed: value.replayed } : {}) };
}, bad);
function commandResult(value, action) { if (!object(value) || value.action !== action || typeof value.replayed !== 'boolean') bad(); return value; }
const natureEnvelope = value => guard(() => { if (!object(value) || typeof value.writable !== 'boolean' || value.data_mode !== 'erp_native') bad(); return { nature: natureRecord(value.nature), writable: value.writable, data_mode: 'erp_native' }; }, bad);
/** "Confirmo que revisei e configurei as naturezas de operação" (migration 202610200141). */
export function natureReview(value) {
  if (!exact(value, ['confirmed', 'version', 'confirmed_at']) || typeof value.confirmed !== 'boolean' || !Number.isInteger(value.version) || value.version < 0 || value.version > 2147483647
    || value.confirmed !== (value.version > 0) || (value.confirmed ? !timestamp(value.confirmed_at) : value.confirmed_at !== null)) bad();
  return { confirmed: value.confirmed, version: value.version, confirmed_at: value.confirmed_at };
}
const taxEnvelope = (value, replay = false) => guard(() => {
  if (!object(value) || !Number.isInteger(value.version) || value.version < 0 || !(value.updated_at === null || timestamp(value.updated_at)) || typeof value.writable !== 'boolean' || value.data_mode !== 'erp_native'
    || (value.version === 0) !== (value.updated_at === null) || (replay && typeof value.replayed !== 'boolean')) bad();
  const normalized = normalizeTaxSettings(value.settings, value.difal_by_state);
  if (JSON.stringify(Object.keys(value.settings).sort()) !== JSON.stringify(Object.keys(normalized.settings).sort()) || Object.keys(normalized.settings).some(k => normalized.settings[k] !== value.settings[k])
    || JSON.stringify(Object.entries(value.difal_by_state).sort()) !== JSON.stringify(Object.entries(normalized.difal_by_state).sort())) bad();
  return { ...normalized, version: value.version, updated_at: value.updated_at, writable: value.writable, data_mode: 'erp_native', ...(replay ? { replayed: value.replayed } : {}) };
}, bad);

const saoPauloToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');
// 202610200274: "nfce_recipient" (an NFC-e of another company with the company as consumer is not a purchase note).
const IMPORT_REFUSALS = ['company_missing', 'other_company', 'duplicate', 'xml_unsupported', 'nfce_recipient'];
/** "Importar XML NF-e" / "Importar XML" (NFC-e): reads the XML here (bounded, no DTD), checks its signature and lets the database choose the side of the company. */
async function importRoute(body) {
  if (!exact(body, ['command_id', 'xml']) || typeof body.xml !== 'string' || body.xml.length > IMPORT_MAX_BYTES) invalid();
  const command = commandId(body.command_id);
  const local = (refused, extra = {}) => ({ local: { imported: false, refused, invoice_id: null, ...extra, data_mode: 'erp_native' } });
  let parsed;
  try { parsed = invoiceImportCandidates(body.xml); } catch (error) { if (error instanceof InvoiceImportError) return local(error.reason, error.field ? { field: error.field } : {}); throw error; }
  // Wave F (202610200274): the NFC-e candidate is checked like the importer of the database (an NFC-e keeping the number and key of the XML).
  const normalize = candidate => { try { return normalizeImportedInput(candidate); } catch (error) { if (error instanceof FiscalSpecError) return null; throw error; } };
  const asEmitter = normalize(parsed.as_emitter), asRecipient = normalize(parsed.as_recipient);
  if (!asEmitter && !asRecipient) return local('xml_unsupported');
  // The note total of Brufap must be the vNF of the XML; anything the field contract cannot hold (ISSQN, services) is refused.
  const computed = invoiceTotals(asEmitter ?? asRecipient).totals.total;
  if (computed !== parsed.total) return local('xml_total_mismatch', { computed_total: computed, xml_total: /^\d{1,13}\.\d{2}$/.test(parsed.total ?? '') ? parsed.total : null });
  // Wave F: the XMLDSig signature of infNFe, the digVal of the protocol and the CNPJ base of the certificate (not the ICP-Brasil chain).
  try { await verifyNfeSignature(body.xml); }
  catch (error) { if (error instanceof SignatureCheckError) return local(['xml_signature_missing', 'xml_signature_invalid'].includes(error.code) ? error.code : 'xml_invalid', error.field ? { field: error.field } : {}); throw error; }
  const data = { xml: body.xml, sha256: await hex(body.xml), size: parsed.bytes, key: parsed.key, signed: parsed.signed, emitter_document: parsed.emitter_document, recipient_document: parsed.recipient_document,
    // signature_verified rides in the protocol object (202610200274 stores it; an earlier database accepts and ignores it).
    protocol: { ...parsed.protocol, signature_verified: true }, as_emitter: asEmitter, as_recipient: asRecipient };
  if (!/^(\d{11}|\d{14})$/.test(data.emitter_document ?? '')) return local('xml_unsupported', { field: 'emit' });
  return { rpc: 'erp_fiscal_invoice_import', args: { p_command_id: command, p_data: data }, check: value => {
    if (object(value) && value.imported === false) {
      if (!IMPORT_REFUSALS.includes(value.refused) || !(value.invoice_id === null || (typeof value.invoice_id === 'string' && UUID.test(value.invoice_id))) || value.data_mode !== 'erp_native'
        || (value.refused === 'duplicate') !== (value.invoice_id !== null)) bad();
      return { imported: false, refused: value.refused, invoice_id: value.invoice_id, data_mode: 'erp_native' };
    }
    if (!object(value) || value.imported !== true || !Number.isInteger(value.matched_items) || value.matched_items < 0 || typeof value.contact_matched !== 'boolean') bad();
    const out = invoiceEnvelope(commandResult(value, 'import'), invoice => {
      if (invoice.access_key !== data.key || !['S', 'X'].includes(invoice.issue_type) || invoice.version !== 1 || invoice.status !== 8 || invoice.protocol !== data.protocol.number || value.matched_items > invoice.items.length
        || invoice.model !== data.key.slice(20, 22) || (invoice.model === '65' && invoice.issue_type !== 'S')) bad();
    });
    // 202610200217: products created and updated in the cadastro by the entry note (absent before that migration).
    const counters = ['created_products', 'updated_products', 'product_failures'];
    if (counters.some(k => Object.hasOwn(value, k)) && !counters.every(k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= out.invoice.items.length)) bad();
    return { ...out, imported: true, matched_items: value.matched_items, contact_matched: value.contact_matched,
      ...(Object.hasOwn(value, 'created_products') ? Object.fromEntries(counters.map(k => [k, value[k]])) : {}) };
  } };
}
/**
 * Wave F: "Editar NF-e" (Notas recebidas). The received NF-e of a supplier read and checked like the import (bounded parse, signature,
 * total), answered as the entry note of the field contract ("Emitida por Terceiros", with the number and the key of the XML) for the form,
 * where the user completes and saves it. Nothing is stored here; the profile is checked by the database (the context of the note form,
 * read only by who writes notes).
 */
async function importPreviewRoute(body) {
  if (!exact(body, ['xml']) || typeof body.xml !== 'string' || body.xml.length > IMPORT_MAX_BYTES) invalid();
  const local = (refused, extra = {}) => ({ local: { previewed: false, refused, ...extra, data_mode: 'erp_native' } });
  let parsed;
  try { parsed = invoiceImportCandidates(body.xml); } catch (error) { if (error instanceof InvoiceImportError) return local(error.reason, error.field ? { field: error.field } : {}); throw error; }
  let entry = null;
  try { entry = parsed.as_recipient ? normalizeImportedInput(parsed.as_recipient) : null; } catch (error) { if (!(error instanceof FiscalSpecError)) throw error; }
  if (!entry || entry.model !== '55') return local('xml_unsupported');
  const computed = invoiceTotals(entry).totals.total;
  if (computed !== parsed.total) return local('xml_total_mismatch', { computed_total: computed, xml_total: /^\d{1,13}\.\d{2}$/.test(parsed.total ?? '') ? parsed.total : null });
  try { await verifyNfeSignature(body.xml); }
  catch (error) { if (error instanceof SignatureCheckError) return local(['xml_signature_missing', 'xml_signature_invalid'].includes(error.code) ? error.code : 'xml_invalid', error.field ? { field: error.field } : {}); throw error; }
  return { rpc: 'erp_fiscal_invoice_context', args: { p_model: '55' }, check: value => {
    contextResponse(value);
    return { previewed: true, key: parsed.key, recipient_document: parsed.recipient_document, emitter_document: parsed.emitter_document, total: computed, invoice: entry, data_mode: 'erp_native' };
  } };
}
export async function parseFiscalInvoicesRoute(request, route) {
  const url = new URL(request.url);
  if (!route || route.kind === 'unknown') throw new FiscalInvoicesError(404, 'ERP_NOT_FOUND');
  if (!fiscalInvoicesMethods(route).includes(request.method)) throw new FiscalInvoicesError(405, 'ERP_METHOD_NOT_ALLOWED');
  if (request.method === 'GET') {
    if (route.kind === 'invoices') {
      const args = listArgs(url);
      return { rpc: Object.hasOwn(args, 'p_tag') ? 'erp_catalog_invoice_list_tagged' : 'erp_fiscal_invoice_list', args, check: value => guard(() => listPage(value, { origin: args.p_origin, model: args.p_model, direction: args.p_direction, page: args.p_page, limit: args.p_limit, order: args.p_order }), bad) };
    }
    if (route.kind === 'order_balance') {
      if (url.search) invalid();
      return { rpc: 'erp_document_invoice_balance', args: { p_document_id: route.id }, check: value => balanceOr(() => parseInvoiceBalance(value, route.id), bad) };
    }
    if (route.kind === 'order_source') {
      // The pedido as the note form needs it, with the reasons Origin refuses "Gerar nota fiscal" (read only).
      const model = params(url, ['model'])('model'); if (!['55', '65'].includes(model)) invalid();
      // 202610200215: v2 adds the vendedor, the transportador and "Considerar a data da venda / da OS nas parcelas".
      // 202610200254: v3 adds the Detalhes de pagamento, the Forma and Detalhes of each parcel and the compositions to split.
      return { rpc: 'erp_fiscal_invoice_order_source_v3', args: { p_document_id: route.id, p_model: model }, check: value => guard(() => {
        const source = orderSourceRecord(value);
        if (source.document.id !== route.id || source.model !== model) bad();
        return source;
      }, bad) };
    }
    if (route.kind === 'product_groups') {
      const raw = params(url, ['ids'])('ids'); if (raw === null) invalid();
      const ids = raw.split(','); if (!ids.length || ids.length > 100 || ids.some(v => !UUID.test(v))) invalid();
      const unique = [...new Set(ids.map(v => v.toLowerCase()))];
      return { rpc: 'erp_fiscal_invoice_product_groups', args: { p_product_ids: unique }, check: value => {
        if (!exact(value, ['items', 'data_mode']) || value.data_mode !== 'erp_native' || !Array.isArray(value.items) || value.items.length > unique.length) bad();
        const items = value.items.map(i => { if (!exact(i, ['id', 'group_id']) || !unique.includes(i.id) || !(i.group_id === null || (typeof i.group_id === 'string' && UUID.test(i.group_id)))) bad(); return { id: i.id, group_id: i.group_id }; });
        if (new Set(items.map(i => i.id)).size !== items.length) bad();
        return { items, data_mode: 'erp_native' };
      } };
    }
    if (route.kind === 'pricing_states') {
      // "P" Preços atualizados (202610200252): the price formation recorded on each note of the page (read only, at most 100).
      const raw = params(url, ['ids'])('ids'); if (raw === null) invalid();
      const list = raw.split(','); if (!list.length || list.length > 100 || list.some(v => !UUID.test(v))) invalid();
      const ids = [...new Set(list.map(v => v.toLowerCase()))];
      return { rpc: 'erp_fiscal_invoice_pricing_states', args: { p_invoice_ids: ids }, check: value => {
        if (!exact(value, ['items', 'data_mode']) || value.data_mode !== 'erp_native' || !Array.isArray(value.items) || value.items.length > ids.length) bad();
        const items = value.items.map(i => {
          if (!exact(i, ['invoice_id', 'recorded_at', 'products', 'count']) || !ids.includes(i.invoice_id) || !timestamp(i.recorded_at) || !Number.isInteger(i.products) || i.products < 1 || i.products > 100
            || !Number.isInteger(i.count) || i.count < 1) bad();
          return { invoice_id: i.invoice_id, recorded_at: i.recorded_at, products: i.products, count: i.count };
        });
        if (new Set(items.map(i => i.invoice_id)).size !== items.length) bad();
        return { items, data_mode: 'erp_native' };
      } };
    }
    if (route.kind === 'payment_methods') {
      const direction = params(url, ['direction'])('direction'); if (!['0', '1'].includes(direction)) invalid();
      return { rpc: 'erp_fiscal_invoice_payment_methods', args: { p_direction: direction }, check: value => guard(() => paymentMethodsRecord(value, direction), bad) };
    }
    if (route.kind === 'returned') {
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_returned', args: { p_key: route.key }, check: value => guard(() => returnedRecord(value, route.key), bad) };
    }
    if (route.kind === 'key_lookup') {
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_key_lookup', args: { p_key: route.key }, check: value => guard(() => keyLookupRecord(value, route.key), bad) };
    }
    if (route.kind === 'item_history') {
      const get = params(url, ['contact_id', 'product_id', 'direction']);
      const contact = get('contact_id'), product = get('product_id'), direction = get('direction');
      if (!UUID.test(contact ?? '') || !UUID.test(product ?? '') || !['0', '1'].includes(direction)) invalid();
      const args = { contactId: contact.toLowerCase(), productId: product.toLowerCase(), direction };
      return { rpc: 'erp_fiscal_invoice_item_history', args: { p_contact_id: args.contactId, p_product_id: args.productId, p_direction: direction }, check: value => guard(() => itemHistoryRecord(value, args), bad) };
    }
    if (route.kind === 'contact_source') {
      const direction = params(url, ['direction'])('direction'); if (!['0', '1'].includes(direction)) invalid();
      return { rpc: 'erp_fiscal_invoice_contact_source', args: { p_contact_id: route.id, p_direction: direction }, check: value => guard(() => contactSourceRecord(value, route.id), bad) };
    }
    if (route.kind === 'estimate') {
      // Read-only calculation: the rules stay here, the screen receives only the IPI / ICMS ST values (no command, nothing stored).
      const input = guard(() => estimateFromQuery(params(url, ['kind', 'contact_id', 'items', 'discount', 'freight', 'other_expenses'])));
      const productIds = [...new Set(input.items.map(i => i.product_id).filter(Boolean))];
      // 202610200216: v2 adds the group of each product for the "Grupo de Produtos" rules.
      return { rpc: 'erp_fiscal_tax_estimate_context_v2', args: { p_kind: input.kind, p_contact_id: input.contact_id, p_product_ids: productIds },
        check: value => guard(() => estimateTaxes(value, input, saoPauloToday()), bad) };
    }
    if (route.kind === 'context') {
      const model = params(url, ['model'])('model'); if (!['55', '65'].includes(model)) invalid();
      return { rpc: 'erp_fiscal_invoice_context', args: { p_model: model }, check: contextResponse };
    }
    if (route.kind === 'invoice') {
      if (url.search) invalid();
      // The read also says what "Bloquear edição da nota quando o estoque/a conta foi lançado(a) pela venda" locks (migration 202610200142).
      return { rpc: 'erp_fiscal_invoice_get', args: { p_id: route.id }, check: value => {
        const out = invoiceEnvelope(value, invoice => { if (invoice.id !== route.id) bad(); });
        if (!exact(value.locks, ['items', 'installments']) || typeof value.locks.items !== 'boolean' || typeof value.locks.installments !== 'boolean') bad();
        return { ...out, locks: { items: value.locks.items, installments: value.locks.installments } };
      } };
    }
    if (route.kind === 'xml') {
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_xml_get', args: { p_id: route.id }, check: async value => {
        if (!exact(value, ['invoice_id', 'access_key', 'sha256', 'size', 'signed', 'protocol_status', 'imported_at', 'xml', 'data_mode']) || value.invoice_id !== route.id || value.data_mode !== 'erp_native'
          || !/^\d{44}$/.test(value.access_key ?? '') || !/^[0-9a-f]{64}$/.test(value.sha256 ?? '') || !Number.isInteger(value.size) || value.size < 1 || value.size > IMPORT_MAX_BYTES || typeof value.signed !== 'boolean'
          || !['100', '150'].includes(value.protocol_status) || !timestamp(value.imported_at) || typeof value.xml !== 'string') bad();
        // The bytes handed to the browser are the stored ones: same size, same SHA-256, same access key.
        if (new TextEncoder().encode(value.xml).byteLength !== value.size || await hex(value.xml) !== value.sha256 || !value.xml.includes(`NFe${value.access_key}`)) bad();
        return { invoice_id: value.invoice_id, access_key: value.access_key, sha256: value.sha256, size: value.size, signed: value.signed, protocol_status: value.protocol_status, imported_at: value.imported_at, xml: value.xml, data_mode: 'erp_native' };
      } };
    }
    if (route.kind === 'order_items') {
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_order_items', args: { p_invoice_id: route.id, p_document_id: route.documentId }, check: value => {
        if (!exact(value, ['invoice_id', 'document_id', 'linked', 'items', 'others', 'state', 'data_mode']) || value.invoice_id !== route.id || value.document_id !== route.documentId || typeof value.linked !== 'boolean'
          || !['none', 'linked', 'partial'].includes(value.state) || value.data_mode !== 'erp_native' || !Array.isArray(value.others) || value.others.length > 250) bad();
        const items = orderItemRows(value.items);
        if (!value.linked && items.length) bad();
        const others = value.others.map(o => { if (!exact(o, ['document_item_id', 'quantity']) || !UUID.test(o.document_item_id ?? '') || !QTY4.test(o.quantity ?? '')) bad(); return { document_item_id: o.document_item_id, quantity: o.quantity }; });
        if (new Set(others.map(o => o.document_item_id)).size !== others.length) bad();
        return { invoice_id: value.invoice_id, document_id: value.document_id, linked: value.linked, items, others, state: value.state, data_mode: 'erp_native' };
      } };
    }
    if (route.kind === 'native_xml') {
      // Notas lane (wave F, 202610200273): "Validar" / "Gerar XML (suporte)" build the XML here; nothing is reserved, signed or sent.
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_xml_source', args: { p_id: route.id }, check: value => nativeXmlResponse(value, route.id) };
    }
    if (route.kind === 'origin') {
      if (url.search) invalid();
      return { rpc: 'erp_fiscal_invoice_origin_get', args: { p_entity: route.entity, p_source_id: route.sourceId },
        check: value => guard(() => { const detail = originDetail(value); if (detail.entity !== route.entity || detail.source_id !== route.sourceId) bad(); return detail; }, bad) };
    }
    if (route.kind === 'natures') {
      const get = params(url, ['active', 'q', 'direction', 'crt', 'page', 'limit']);
      const active = get('active') ?? 'true', direction = get('direction'), crt = get('crt');
      if (!['true', 'false'].includes(active) || (direction !== null && !['0', '1'].includes(direction)) || (crt !== null && !['1', '2', '3', '4'].includes(crt))) invalid();
      const args = { p_active: active === 'true', p_query: searchText(get('q')), p_direction: direction, p_crt: crt, p_page: integer(get('page'), 1, 1, 100000), p_limit: integer(get('limit'), 100, 1, 100) };
      return { rpc: 'erp_fiscal_nature_list', args, check: value => guard(() => {
        if (!object(value) || !Array.isArray(value.items) || value.page !== args.p_page || value.limit !== args.p_limit || !Number.isInteger(value.total_count) || value.total_count < 0
          || value.items.length > args.p_limit || typeof value.writable !== 'boolean' || value.data_mode !== 'erp_native') bad();
        const items = value.items.map(natureSummary);
        if (items.some(n => n.active !== args.p_active || (args.p_direction && n.direction !== args.p_direction) || (args.p_crt && n.crt !== args.p_crt))) bad();
        return { items, page: value.page, limit: value.limit, total_count: value.total_count, writable: value.writable, review: natureReview(value.review), data_mode: 'erp_native' };
      }, bad) };
    }
    if (route.kind === 'nature') { if (url.search) invalid(); return { rpc: 'erp_fiscal_nature_get', args: { p_id: route.id }, check: value => { const out = natureEnvelope(value); if (out.nature.id !== route.id) bad(); return out; } }; }
    if (route.kind === 'taxes') { if (url.search) invalid(); return { rpc: 'erp_fiscal_tax_settings_get', args: {}, check: value => taxEnvelope(value) }; }
    if (route.kind === 'events') {
      const get = params(url, ['kind', 'q', 'date_from', 'date_to', 'page', 'limit']);
      const kind = get('kind'); if (!['cancel', 'correction', 'inutilization'].includes(kind)) invalid();
      const from = date(get('date_from')), to = date(get('date_to')); if (from && to && from > to) invalid();
      const args = { p_kind: kind, p_query: searchText(get('q')), p_date_from: from, p_date_to: to, p_page: integer(get('page'), 1, 1, 100000), p_limit: integer(get('limit'), 100, 1, 100) };
      return { rpc: 'erp_fiscal_event_list', args, check: value => guard(() => {
        if (!object(value) || value.kind !== kind || value.page !== args.p_page || value.limit !== args.p_limit || !Number.isInteger(value.total_count) || value.total_count < 0 || !Array.isArray(value.items)
          || value.items.length > args.p_limit || value.transmission_enabled !== false || value.data_mode !== 'erp_native_homologation') bad();
        const items = value.items.map(eventRecord); if (items.some(e => e.kind !== kind)) bad();
        return { items, kind, page: value.page, limit: value.limit, total_count: value.total_count, transmission_enabled: false, data_mode: 'erp_native_homologation' };
      }, bad) };
    }
    return invalid();
  }
  if (url.search) invalid();
  const body = await readBody(request);
  if (route.kind === 'import') return importRoute(body);
  if (route.kind === 'import_preview') return importPreviewRoute(body);
  if (route.kind === 'link_states') {
    // "Vinculação" of the pedidos de compra list: one state per pedido of the page (read only, at most 100).
    if (!exact(body, ['document_ids']) || !Array.isArray(body.document_ids) || !body.document_ids.length || body.document_ids.length > 100 || body.document_ids.some(id => typeof id !== 'string' || !UUID.test(id))) invalid();
    const ids = [...new Set(body.document_ids.map(id => id.toLowerCase()))];
    return { rpc: 'erp_fiscal_invoice_order_link_states', args: { p_document_ids: ids }, check: value => {
      if (!exact(value, ['items', 'data_mode']) || value.data_mode !== 'erp_native' || !Array.isArray(value.items) || value.items.length > ids.length) bad();
      const items = value.items.map(i => { if (!exact(i, ['document_id', 'state']) || !ids.includes(i.document_id) || !['none', 'linked', 'partial'].includes(i.state)) bad(); return { document_id: i.document_id, state: i.state }; });
      if (new Set(items.map(i => i.document_id)).size !== items.length) bad();
      return { items, data_mode: 'erp_native' };
    } };
  }
  if (route.kind === 'pricing') {
    // The confirmed "Atualizar preços" command of the cadastro, recorded on the entry note (idempotent by note + command).
    if (!exact(body, ['catalog_command_id'])) invalid();
    const command = commandId(body.catalog_command_id);
    return { rpc: 'erp_fiscal_invoice_pricing_record', args: { p_invoice_id: route.id, p_catalog_command_id: command }, check: value => {
      if (!exact(value, ['invoice_id', 'catalog_command_id', 'products', 'recorded_at', 'replayed', 'data_mode']) || value.invoice_id !== route.id || value.catalog_command_id !== command
        || !Number.isInteger(value.products) || value.products < 1 || value.products > 100 || !timestamp(value.recorded_at) || typeof value.replayed !== 'boolean' || value.data_mode !== 'erp_native') bad();
      return { invoice_id: value.invoice_id, catalog_command_id: value.catalog_command_id, products: value.products, recorded_at: value.recorded_at, replayed: value.replayed, data_mode: 'erp_native' };
    } };
  }
  if (route.kind === 'reconcile') {
    // "Conciliar produtos" of an imported note: product (or none) for each listed item position.
    if (!exact(body, ['command_id', 'expected_version', 'items']) || !Array.isArray(body.items) || !body.items.length || body.items.length > 990) invalid();
    const items = body.items.map(i => { if (!exact(i, ['position', 'product_id']) || !Number.isInteger(i.position) || i.position < 1 || i.position > 990 || !(i.product_id === null || (typeof i.product_id === 'string' && UUID.test(i.product_id)))) invalid(); return { position: i.position, product_id: i.product_id?.toLowerCase() ?? null }; });
    if (new Set(items.map(i => i.position)).size !== items.length) invalid();
    const data = { invoice_id: route.id, expected_version: expected(body.expected_version), items };
    return { rpc: 'erp_fiscal_invoice_reconcile', args: { p_command_id: commandId(body.command_id), p_data: data }, check: value => invoiceEnvelope(commandResult(value, 'reconcile'), invoice => {
      if (invoice.id !== route.id || invoice.version !== data.expected_version + 1 || !['S', 'X'].includes(invoice.issue_type)
        || items.some(i => (invoice.items[i.position - 1]?.product_id ?? null) !== i.product_id)) bad();
    }) };
  }
  if (route.kind === 'partial') {
    // Leva H (391): the note of part of a pedido de venda and the quantity of each pedido item it invoices, in one command.
    if (!exact(body, ['command_id', 'document_id', 'invoice', 'items']) || typeof body.document_id !== 'string' || !UUID.test(body.document_id)) invalid();
    const documentId = body.document_id.toLowerCase(), invoice = guard(() => normalizeInvoiceInput(body.invoice)), items = balanceOr(() => capturePartialItems(body.items), invalid);
    if (invoice.direction !== '1' || items.some(i => i.position > invoice.items.length)) invalid();
    return { rpc: 'erp_fiscal_invoice_partial_create', args: { p_command_id: commandId(body.command_id), p_document_id: documentId, p_data: { invoice, items } },
      check: value => { const envelope = invoiceEnvelope(commandResult(value, 'create'), saved => { if (saved.version !== 1 || !saved.orders.some(o => o.id === documentId)) bad(); });
        return { ...envelope, balance: balanceOr(() => parseInvoiceBalance(value.balance, documentId, { scoped: false }), bad) }; } };
  }
  if (route.kind === 'invoices' || route.kind === 'invoice') {
    const create = route.kind === 'invoices';
    if (!exact(body, create ? ['command_id', 'invoice', 'orders'] : ['command_id', 'expected_version', 'invoice', 'orders'], create ? ['command_id', 'invoice'] : ['command_id', 'expected_version', 'invoice'])) invalid();
    const invoice = guard(() => normalizeInvoiceInput(body.invoice));
    const orders = body.orders ?? [];
    if (!Array.isArray(orders) || orders.length > 20 || orders.some(id => typeof id !== 'string' || !UUID.test(id))) invalid();
    const data = { invoice, orders: [...new Set(orders.map(id => id.toLowerCase()))], ...(create ? {} : { id: route.id, expected_version: expected(body.expected_version) }) };
    return { rpc: 'erp_fiscal_invoice_execute', args: { p_command_id: commandId(body.command_id), p_action: create ? 'create' : 'update', p_data: data },
      check: value => invoiceEnvelope(commandResult(value, create ? 'create' : 'update'), invoice => {
        if (create ? invoice.version !== 1 : invoice.id !== route.id || invoice.version !== data.expected_version + 1) bad();
      }) };
  }
  if (route.kind === 'orders') {
    // "Vincular à pedido de compra" / "Desvincular pedido compra": one order per command; 202610200275 adds the items of the link.
    if (!exact(body, ['command_id', 'expected_version', 'action', 'document_id', 'items'], ['command_id', 'expected_version', 'action', 'document_id']) || !['link', 'unlink'].includes(body.action)
      || typeof body.document_id !== 'string' || !UUID.test(body.document_id) || (Object.hasOwn(body, 'items') && body.action !== 'link')) invalid();
    const data = { invoice_id: route.id, expected_version: expected(body.expected_version), action: body.action, document_id: body.document_id.toLowerCase(), ...(Object.hasOwn(body, 'items') ? { items: linkItemsInput(body.items) } : {}) };
    const action = `${body.action}_order`;
    return { rpc: 'erp_fiscal_invoice_link', args: { p_command_id: commandId(body.command_id), p_data: data }, check: value => {
      if (!object(value) || value.document_id !== data.document_id) bad();
      const out = invoiceEnvelope(commandResult(value, action), invoice => {
        if (invoice.id !== route.id || invoice.version !== data.expected_version + 1 || invoice.orders.some(o => o.id === data.document_id) !== (body.action === 'link')) bad();
      });
      // 202610200275: entry notes answer the item links of the pedido after the command and how many the unlink removed.
      if (Object.hasOwn(value, 'items') !== Object.hasOwn(value, 'removed_items') || (data.items && !Object.hasOwn(value, 'items'))) bad();
      if (!Object.hasOwn(value, 'items')) return { ...out, document_id: data.document_id };
      const items = orderItemRows(value.items);
      if (!Number.isInteger(value.removed_items) || value.removed_items < 0 || value.removed_items > 990 || (body.action === 'unlink' ? items.length !== 0 : value.removed_items !== 0)
        || (data.items && (items.length !== data.items.length || data.items.some(i => !items.some(r => r.invoice_position === i.position && r.document_item_id === i.document_item_id && r.quantity === quantity4(i.quantity)))))) bad();
      return { ...out, document_id: data.document_id, items, removed_items: value.removed_items };
    } };
  }
  if (route.kind === 'delete') {
    if (!exact(body, ['command_id', 'expected_version', 'reason']) || typeof body.reason !== 'string' || [...body.reason.trim()].length < 3 || [...body.reason].length > 1000 || /[\x00-\x1f\x7f]/.test(body.reason)) invalid();
    const data = { id: route.id, expected_version: expected(body.expected_version), reason: body.reason.trim() };
    return { rpc: 'erp_fiscal_invoice_execute', args: { p_command_id: commandId(body.command_id), p_action: 'delete', p_data: data },
      check: value => invoiceEnvelope(commandResult(value, 'delete'), invoice => { if (invoice.id !== route.id || invoice.version !== data.expected_version + 1 || invoice.deleted_at === null) bad(); }) };
  }
  if (route.kind === 'natures') {
    const action = body.action, keys = { create: ['nature'], update: ['id', 'expected_version', 'nature'], clone: ['id', 'expected_version'], set_active: ['id', 'expected_version', 'active'], set_default: ['id', 'expected_version', 'code'], delete: ['id', 'expected_version'] }[action];
    if (!keys || !exact(body, ['command_id', 'action', ...keys])) invalid();
    const data = {};
    if (keys.includes('id')) { if (typeof body.id !== 'string' || !UUID.test(body.id)) invalid(); data.id = body.id.toLowerCase(); data.expected_version = expected(body.expected_version); }
    if (keys.includes('nature')) data.nature = guard(() => normalizeNatureInput(body.nature));
    if (action === 'set_active') { if (typeof body.active !== 'boolean') invalid(); data.active = body.active; }
    if (action === 'set_default') { if (!['S', 'E', 'VF', 'VJ', 'CF', 'CJ', 'C', 'DE', 'DS'].includes(body.code)) invalid(); data.code = body.code; }
    return { rpc: 'erp_fiscal_nature_execute', args: { p_command_id: commandId(body.command_id), p_action: action, p_data: data }, check: value => {
      const result = commandResult(value, action); const out = natureEnvelope({ ...result, writable: true });
      const n = out.nature;
      if ((action === 'update' || action === 'set_active' || action === 'delete') && (n.id !== data.id || n.version !== data.expected_version + 1)) bad();
      if (action === 'delete' && (n.active || n.defaults.length)) bad();
      if (action === 'set_default' && (n.id !== data.id || n.version !== data.expected_version || !n.defaults.includes(data.code))) bad();
      if (action === 'set_active' && n.active !== data.active) bad();
      if ((action === 'create' || action === 'clone') && (n.version !== 1 || n.id === data.id)) bad();
      return { nature: n, action, replayed: result.replayed, data_mode: 'erp_native' };
    } };
  }
  if (route.kind === 'nature_review') {
    if (!exact(body, ['command_id', 'expected_version']) || !Number.isInteger(body.expected_version) || body.expected_version < 0 || body.expected_version > 2147483646) invalid();
    return { rpc: 'erp_fiscal_nature_review_confirm', args: { p_command_id: commandId(body.command_id), p_expected_version: body.expected_version }, check: value => {
      const result = commandResult(value, 'confirm_review'); if (value.data_mode !== 'erp_native') bad();
      const review = natureReview(result.review); if (!review.confirmed || (!result.replayed && review.version !== body.expected_version + 1)) bad();
      return { review, action: 'confirm_review', replayed: result.replayed, data_mode: 'erp_native' };
    } };
  }
  if (route.kind === 'taxes') {
    if (!exact(body, ['command_id', 'expected_version', 'settings', 'difal_by_state']) || !Number.isInteger(body.expected_version) || body.expected_version < 0 || body.expected_version > 2147483646) invalid();
    const normalized = guard(() => normalizeTaxSettings(body.settings, body.difal_by_state));
    return { rpc: 'erp_fiscal_tax_settings_save', args: { p_command_id: commandId(body.command_id), p_expected_version: body.expected_version, p_settings: normalized.settings, p_difal_by_state: body.difal_by_state },
      check: value => { const out = taxEnvelope(value, true); if (out.version !== body.expected_version + 1 || out.writable !== true) bad(); return out; } };
  }
  if (route.kind === 'events') {
    const action = body.action, keys = { cancel: ['invoice_id', 'expected_version', 'justification'], correction: ['invoice_id', 'expected_version', 'correction'], inutilization: ['model', 'series', 'number_from', 'number_to', 'justification'] }[action];
    if (!keys || !exact(body, ['command_id', 'action', ...keys])) invalid();
    const textKey = action === 'correction' ? 'correction' : 'justification', max = action === 'correction' ? 1000 : 255, value = body[textKey];
    if (typeof value !== 'string' || [...value.trim()].length < 15 || [...value.trim()].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (action !== 'correction' && /[\r\n\t]/.test(value))) invalid();
    const data = { [textKey]: value.trim() };
    if (action === 'inutilization') {
      if (!['55', '65'].includes(body.model) || typeof body.series !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(body.series) || ['number_from', 'number_to'].some(k => typeof body[k] !== 'string' || !/^[1-9][0-9]{0,8}$/.test(body[k]))
        || Number(body.number_from) > Number(body.number_to) || Number(body.number_to) - Number(body.number_from) >= 10000) invalid();
      Object.assign(data, { model: body.model, series: body.series, number_from: body.number_from, number_to: body.number_to });
    } else {
      if (typeof body.invoice_id !== 'string' || !UUID.test(body.invoice_id)) invalid();
      Object.assign(data, { invoice_id: body.invoice_id.toLowerCase(), expected_version: expected(body.expected_version) });
    }
    return { rpc: 'erp_fiscal_event_execute', args: { p_command_id: commandId(body.command_id), p_action: action, p_data: data }, check: result => guard(() => {
      commandResult(result, action);
      if (result.transmission_enabled !== false || result.data_mode !== 'erp_native_homologation') bad();
      const event = eventRecord(result.event);
      if (event.kind !== action || event.text !== data[textKey] || (action !== 'inutilization' && event.invoice_id !== data.invoice_id)
        || (action === 'inutilization' && (event.model !== data.model || event.series !== Number(data.series) || event.number_from !== Number(data.number_from) || event.number_to !== Number(data.number_to)))) bad();
      return { event, action, replayed: result.replayed, transmission_enabled: false, data_mode: 'erp_native_homologation' };
    }, bad) };
  }
  return invalid();
}
// ---- Item links of a note of entry with a pedido de compra (wave F, 202610200275) ----
const QTY4 = /^(0|[1-9][0-9]{0,10})\.[0-9]{4}$/;
const quantity4 = value => { const [w, f = ''] = value.split('.'); return `${w}.${(f + '0000').slice(0, 4)}`; };
function linkItemsInput(items) {
  if (!Array.isArray(items) || !items.length || items.length > 990) invalid();
  const out = items.map(i => {
    if (!exact(i, ['position', 'document_item_id', 'quantity']) || !Number.isInteger(i.position) || i.position < 1 || i.position > 990 || typeof i.document_item_id !== 'string' || !UUID.test(i.document_item_id)
      || typeof i.quantity !== 'string' || !/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,4})?$/.test(i.quantity) || /^0(\.0+)?$/.test(i.quantity)) invalid();
    return { position: i.position, document_item_id: i.document_item_id.toLowerCase(), quantity: i.quantity };
  });
  if (new Set(out.map(i => `${i.position}:${i.document_item_id}`)).size !== out.length) invalid();
  return out;
}
function orderItemRows(value) {
  if (!Array.isArray(value) || value.length > 990) bad();
  const rows = value.map(r => {
    if (!exact(r, ['invoice_position', 'document_item_id', 'quantity', 'counted', 'valid']) || !Number.isInteger(r.invoice_position) || r.invoice_position < 1 || r.invoice_position > 990
      || !UUID.test(r.document_item_id ?? '') || !QTY4.test(r.quantity ?? '') || !QTY4.test(r.counted ?? '') || typeof r.valid !== 'boolean'
      || (!r.valid && r.counted !== '0.0000') || (r.valid && (r.counted === '0.0000' || BigInt(r.counted.replace('.', '')) > BigInt(r.quantity.replace('.', ''))))) bad();
    return { invoice_position: r.invoice_position, document_item_id: r.document_item_id, quantity: r.quantity, counted: r.counted, valid: r.valid };
  });
  if (new Set(rows.map(r => `${r.invoice_position}:${r.document_item_id}`)).size !== rows.length) bad();
  return rows;
}
// ---- Native XML of a note of the Brufap (wave F, 202610200273) ----
const textOrNull = (value, max) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value));
const EMITTER_TEXT = { legal_name: 200, trade_name: 200, document: 14, ie: 30, municipal_registration: 30, cnae: 9, suframa: 12 };
const ADDRESS_TEXT = { street: 200, number: 30, complement: 200, district: 100, city: 100, municipality_code: 7, state: 2, postal_code: 9, phone: 40 };
function emitterRecord(value) {
  if (!exact(value, [...Object.keys(EMITTER_TEXT), 'person_type', 'ie_exempt', 'substitute_ies', 'crt', 'regime_confirmed', 'address']) || Object.entries(EMITTER_TEXT).some(([k, max]) => !textOrNull(value[k], max))
    || !['juridica', 'fisica'].includes(value.person_type) || typeof value.ie_exempt !== 'boolean' || !(value.crt === null || ['1', '2', '3', '4'].includes(value.crt)) || value.regime_confirmed !== (value.crt !== null)
    || !(value.document === null || /^(\d{11}|\d{14})$/.test(value.document)) || !Array.isArray(value.substitute_ies) || value.substitute_ies.length > 27
    || !exact(value.address, Object.keys(ADDRESS_TEXT)) || Object.entries(ADDRESS_TEXT).some(([k, max]) => !textOrNull(value.address[k], max))) bad();
  const substitutes = value.substitute_ies.map(s => { if (!exact(s, ['uf', 'ie']) || !UF.includes(s.uf) || s.uf === 'EX' || typeof s.ie !== 'string' || !/^[0-9A-Za-z./-]{2,20}$/.test(s.ie)) bad(); return { uf: s.uf, ie: s.ie }; });
  if (new Set(substitutes.map(s => s.uf)).size !== substitutes.length) bad();
  return { ...Object.fromEntries(Object.keys(EMITTER_TEXT).map(k => [k, value[k]])), person_type: value.person_type, ie_exempt: value.ie_exempt, substitute_ies: substitutes, crt: value.crt,
    regime_confirmed: value.regime_confirmed, address: Object.fromEntries(Object.keys(ADDRESS_TEXT).map(k => [k, value.address[k]])) };
}
/** "Now" in São Paulo (date, time and UTC offset) for the dhEmi of the support XML. */
export function saoPauloNow(at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(at).map(p => [p.type, p.value]));
  const offset = /^GMT([+-]\d{2}:\d{2})$/.exec(parts.timeZoneName ?? '')?.[1] ?? (parts.timeZoneName === 'GMT' ? '+00:00' : '-03:00');
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`, offset };
}
/** The answer of erp_fiscal_invoice_xml_source, checked, and the XML built and checked against the layout (no command, nothing stored). */
export async function nativeXmlResponse(value, id, now = saoPauloNow()) {
  if (!exact(value, ['envelope', 'emitter', 'numbering', 'data_mode']) || value.data_mode !== 'erp_native_homologation') bad();
  const { invoice } = invoiceEnvelope(value.envelope, record => { if (record.id !== id || record.deleted_at !== null || ['T', 'S', 'X'].includes(record.issue_type)) bad(); });
  const emitter = emitterRecord(value.emitter), n = value.numbering;
  if (!exact(n, ['series', 'next_number', 'enabled']) || n.series !== invoice.series || !(n.next_number === null || (Number.isInteger(n.next_number) && n.next_number >= 1 && n.next_number <= 1000000000))
    || !(n.enabled === null || typeof n.enabled === 'boolean') || (n.next_number === null) !== (n.enabled === null)) bad();
  let result;
  try { result = validateNativeInvoice({ invoice, emitter, numbering: { series: n.series, next_number: n.next_number > 999999999 ? null : n.next_number, enabled: n.enabled }, now }); }
  catch (error) { if (error instanceof NativeInvoiceError || error instanceof SchemaError) throw new FiscalInvoicesError(422, 'ERP_FISCAL_NATIVE_XML_FAILED'); throw error; }
  return { invoice_id: invoice.id, invoice_version: invoice.version, model: invoice.model, series: invoice.series, number: result.number, number_provisional: true, access_key: result.access_key, issued_at: result.issued_at,
    xml: result.xml, xml_bytes: new TextEncoder().encode(result.xml).byteLength, xml_sha256: await hex(result.xml), schema: result.schema, rules: result.rules, valid: result.valid,
    signed: false, transmitted: false, numbering_reserved: false, environment: '2', data_mode: 'erp_native_homologation' };
}
function contextResponse(value) {
  if (!object(value) || !exact(value.company, ['crt', 'regime_confirmed', 'state', 'cnpj_present']) || !(value.company.crt === null || ['1', '2', '3', '4'].includes(value.company.crt))
    || typeof value.company.regime_confirmed !== 'boolean' || value.company.regime_confirmed !== (value.company.crt !== null) || !(value.company.state === null || (typeof value.company.state === 'string' && /^[A-Z]{2}$/.test(value.company.state)))
    || typeof value.company.cnpj_present !== 'boolean' || !Array.isArray(value.series) || value.series.length > 890 || !object(value.defaults) || value.writable !== true
    || value.emission_enabled !== false || value.production_enabled !== false || value.data_mode !== 'erp_native') bad();
  const series = value.series.map(s => { if (!exact(s, ['series', 'next_number', 'enabled']) || !Number.isInteger(s.series) || s.series < 0 || s.series > 889 || !Number.isInteger(s.next_number) || s.next_number < 1 || s.next_number > 1000000000 || typeof s.enabled !== 'boolean') bad(); return { ...s }; });
  const defaults = {};
  for (const [code, nature] of Object.entries(value.defaults)) {
    if (!['S', 'E', 'VF', 'VJ', 'CF', 'CJ', 'C', 'DE', 'DS'].includes(code) || !exact(nature, ['id', 'description']) || !UUID.test(nature.id) || typeof nature.description !== 'string' || !nature.description || [...nature.description].length > 60) bad();
    defaults[code] = { id: nature.id, description: nature.description };
  }
  const preferences = guard(() => invoicePreferences(value.preferences), bad);
  // "Informar desconto individualmente nos itens" (202610200176); a database before 176 does not send it and the form spreads the discount.
  if (Object.hasOwn(value, 'item_discount') && typeof value.item_discount !== 'boolean') bad();
  // 202610200215: "Preencher manualmente Destino da Operação" and the open contas panels; before it, both stay off.
  if (Object.hasOwn(value, 'operation_destination_manual') && typeof value.operation_destination_manual !== 'boolean') bad();
  if (Object.hasOwn(value, 'open_titles') && (!exact(value.open_titles, ['receivable', 'payable']) || typeof value.open_titles.receivable !== 'boolean' || typeof value.open_titles.payable !== 'boolean')) bad();
  return { company: { ...value.company }, series, defaults, preferences, item_discount: value.item_discount === true, operation_destination_manual: value.operation_destination_manual === true,
    open_titles: { receivable: value.open_titles?.receivable === true, payable: value.open_titles?.payable === true }, writable: true, emission_enabled: false, production_enabled: false, data_mode: 'erp_native' };
}
export async function executeFiscalInvoicesRoute(parsed, { userId, rpc }) {
  // A refusal decided while reading the XML never reaches the database.
  if (parsed.local) return parsed.local;
  const result = await rpc(parsed.rpc, { ...parsed.args, p_user_id: userId });
  return parsed.check(result);
}
