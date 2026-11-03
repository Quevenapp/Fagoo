/** Estoque pela nota fiscal (migration 259), routed through stock.mjs:
 * - GET /v1/estoque/notas-fiscais/situacao?ids=: letter E of a page of notes (S by the note, R by the reference);
 * - GET /v1/estoque/notas-fiscais/{nota}: the stock state of one note (letter, block, default warehouse, postings);
 * - POST /v1/estoque/notas-fiscais/{nota}/previa and .../lancamento: ⋮ Lançar estoque (depósito, prévia, command);
 * - POST /v1/estoque/notas-fiscais/{nota}/estorno/previa and .../estorno: ⋮ Estornar estoque;
 * - POST /v1/estoque/notas-fiscais/{nota}/checkin/previa and .../checkin: Finalizar do Check-in with "Lançar estoque ao finalizar".
 * - GET and POST /v1/estoque/notas-fiscais/{nota}/unidades (295): "Conversão de unidades" of an entry note and its "Fator de conversão".
 * Strict params and closed bodies, exact decimal strings (BigInt), projected and cross-checked responses. */
import { checkinView } from './stock-checkin.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORED = /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const HASH = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCREENS = ['nfe_saida', 'nfe_entrada', 'nfce'];
const BLOCKS = [null, 'deleted', 'cancelled', 'denied', 'posted', 'reference', 'reserved', 'no_products'];
// A note that is gone, cancelled or denied keeps the block of its state even with its stock posted (S): that posting is still reversed.
const CLOSED = ['deleted', 'cancelled', 'denied'];
const IGNORED = ['unlinked_item', 'service'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const stored = value => typeof value === 'string' && STORED.test(value) && !/^-0\.0+$/.test(value);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const date = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const units = value => { const [whole, fraction = ''] = value.replace(/^-/, '').split('.'); const result = BigInt(whole + fraction.padEnd(6, '0').slice(0, 6)); return value.startsWith('-') ? -result : result; };
export class StockInvoicesError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockInvoicesError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockInvoicesError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };

const ACTIONS = { previa: 'preview', lancamento: 'post', 'estorno/previa': 'reverse-preview', estorno: 'reverse', 'checkin/previa': 'checkin-preview', checkin: 'checkin-post', unidades: 'units' };
export function stockInvoicesRoute(path) {
  if (path === '/v1/estoque/notas-fiscais/situacao') return { type: 'invoice-flags' };
  const match = /^\/v1\/estoque\/notas-fiscais\/([0-9a-fA-F-]{36})(?:\/(previa|lancamento|estorno\/previa|estorno|checkin\/previa|checkin|unidades))?$/.exec(path);
  if (!match || !uuid(match[1])) return null;
  return match[2] ? { type: `invoice-${ACTIONS[match[2]]}`, id: match[1].toLowerCase() } : { type: 'invoice-get', id: match[1].toLowerCase() };
}
export const stockInvoicesMethods = route => route?.type === 'invoice-flags' || route?.type === 'invoice-get' ? ['GET'] : route?.type === 'invoice-units' ? ['GET', 'POST'] : route ? ['POST'] : null;
// 295: "Fator de conversão" (1 unidade da nota = fator unidades do produto), up to 6 decimals and 999999.999999; null removes it.
const FACTOR = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$/;
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 4096)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4096) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}

export async function stockInvoicesOperation(request, route, search) {
  if (route.type === 'invoice-flags') {
    params(search, ['ids']);
    const ids = (search.get('ids') ?? '').split(',');
    need(ids.length >= 1 && ids.length <= 100 && ids.every(uuid) && new Set(ids.map(id => id.toLowerCase())).size === ids.length);
    return { type: route.type, rpc: 'erp_stock_invoice_flags', args: { p_ids: ids.map(id => id.toLowerCase()) } };
  }
  if (route.type === 'invoice-get') { params(search, []); return { type: route.type, rpc: 'erp_stock_invoice_get', args: { p_invoice_id: route.id } }; }
  if (route.type === 'invoice-units' && request.method === 'GET') { params(search, []); return { type: 'invoice-units', rpc: 'erp_stock_invoice_units', args: { p_invoice_id: route.id } }; }
  if (search.size) invalid();
  const input = await readBody(request), base = { p_invoice_id: route.id };
  const command = () => (need(uuid(input.command_id)), input.command_id.toLowerCase()), hash = () => (need(typeof input.preview_hash === 'string' && HASH.test(input.preview_hash)), input.preview_hash);
  switch (route.type) {
    case 'invoice-preview':
      need(exact(input, ['expected_version', 'warehouse_id']) && int(input.expected_version, 1, 2147483646) && uuid(input.warehouse_id));
      return { type: route.type, rpc: 'erp_stock_invoice_preview', args: { ...base, p_expected_version: input.expected_version, p_warehouse_id: input.warehouse_id.toLowerCase() } };
    case 'invoice-post':
      need(exact(input, ['command_id', 'expected_version', 'warehouse_id', 'preview_hash']) && int(input.expected_version, 1, 2147483646) && uuid(input.warehouse_id));
      return { type: route.type, rpc: 'erp_stock_invoice_post', args: { ...base, p_command_id: command(), p_expected_version: input.expected_version, p_warehouse_id: input.warehouse_id.toLowerCase(), p_preview_hash: hash() } };
    case 'invoice-reverse-preview':
      need(exact(input, ['posting_id', 'posting_version']) && uuid(input.posting_id) && int(input.posting_version, 1, 2147483646));
      return { type: route.type, rpc: 'erp_stock_invoice_reverse_preview', args: { ...base, p_posting_id: input.posting_id.toLowerCase(), p_posting_version: input.posting_version } };
    case 'invoice-reverse':
      need(exact(input, ['command_id', 'posting_id', 'posting_version', 'preview_hash']) && uuid(input.posting_id) && int(input.posting_version, 1, 2147483646));
      return { type: route.type, rpc: 'erp_stock_invoice_reverse', args: { ...base, p_command_id: command(), p_posting_id: input.posting_id.toLowerCase(), p_posting_version: input.posting_version, p_preview_hash: hash() } };
    case 'invoice-checkin-preview':
      need(exact(input, ['expected_version', 'warehouse_id']) && int(input.expected_version, 1, 2147483645) && uuid(input.warehouse_id));
      return { type: route.type, rpc: 'erp_stock_checkin_post_preview', args: { ...base, p_expected_version: input.expected_version, p_warehouse_id: input.warehouse_id.toLowerCase() } };
    case 'invoice-units':
      need(exact(input, ['command_id', 'position', 'expected_version', 'factor']) && int(input.position, 1, 990) && int(input.expected_version, 0, 2147483646)
        && (input.factor === null ? input.expected_version >= 1 : typeof input.factor === 'string' && FACTOR.test(input.factor) && !/^0(\.0+)?$/.test(input.factor)));
      return { type: 'invoice-unit-save', rpc: 'erp_stock_invoice_unit_save', args: { ...base, p_command_id: command(), p_position: input.position, p_expected_version: input.expected_version, p_factor: input.factor } };
    case 'invoice-checkin-post':
      need(exact(input, ['command_id', 'expected_version', 'warehouse_id', 'preview_hash']) && int(input.expected_version, 1, 2147483645) && uuid(input.warehouse_id));
      return { type: route.type, rpc: 'erp_stock_checkin_finish_post', args: { ...base, p_command_id: command(), p_expected_version: input.expected_version, p_warehouse_id: input.warehouse_id.toLowerCase(), p_preview_hash: hash() } };
    default: return invalid();
  }
}

const warehouseRef = value => { need(exact(value, ['id', 'name']) && uuid(value.id) && text(value.name, 200, 1), upstream); return { id: value.id, name: value.name }; };
function invoiceDto(value, id) {
  need(exact(value, ['id', 'model', 'direction', 'screen', 'number', 'series', 'status', 'version', 'label', 'issue_date', 'exit_date', 'deleted']) && value.id === id && ['55', '65'].includes(value.model)
    && ['0', '1'].includes(value.direction) && SCREENS.includes(value.screen) && value.screen === (value.model === '65' ? 'nfce' : value.direction === '0' ? 'nfe_entrada' : 'nfe_saida')
    && (value.number === null || int(value.number, 1, 999999999)) && int(value.series, 0, 999) && int(value.status, 1, 16) && int(value.version, 1) && text(value.label, 40, 1)
    && date(value.issue_date) && (value.exit_date === null || date(value.exit_date)) && typeof value.deleted === 'boolean', upstream);
  return { id: value.id, model: value.model, direction: value.direction, screen: value.screen, number: value.number, series: value.series, status: value.status, version: value.version,
    label: value.label, issue_date: value.issue_date, exit_date: value.exit_date, deleted: value.deleted };
}
function flagDto(value) {
  need(exact(value, ['flag', 'warehouse', 'posting_id', 'posting_version', 'source', 'reference']) && [null, 'S', 'R'].includes(value.flag), upstream);
  if (value.flag === 'S') need(uuid(value.posting_id) && int(value.posting_version, 1) && ['invoice', 'checkin'].includes(value.source) && value.reference === null, upstream);
  else need(value.posting_id === null && value.posting_version === null && value.source === null, upstream);
  let reference = null;
  if (value.flag === 'R') {
    const r = value.reference;
    need(exact(r, ['document_id', 'kind', 'number', 'via']) && uuid(r.document_id) && ['sales_orders', 'service_orders', 'purchase_orders'].includes(r.kind) && typeof r.number === 'string'
      && /^[1-9][0-9]{0,9}$/.test(r.number) && ['document_stock', 'purchase_receipt'].includes(r.via) && (r.via === 'document_stock' || r.kind === 'purchase_orders'), upstream);
    reference = { document_id: r.document_id, kind: r.kind, number: r.number, via: r.via };
  } else need(value.reference === null, upstream);
  return { flag: value.flag, warehouse: value.flag === null ? (need(value.warehouse === null, upstream), null) : warehouseRef(value.warehouse), posting_id: value.posting_id,
    posting_version: value.posting_version, source: value.source, reference };
}
function postingDto(value, invoiceId) {
  need(exact(value, ['id', 'invoice_id', 'invoice_version', 'source', 'state', 'version', 'warehouse', 'movement_id', 'occurred_on', 'direction', 'positions', 'ignored_items', 'created_at', 'reversal_movement_id', 'reversed_at'])
    && uuid(value.id) && value.invoice_id === invoiceId && int(value.invoice_version, 1) && ['invoice', 'checkin'].includes(value.source) && ['active', 'reversed'].includes(value.state)
    && int(value.version, 1) && uuid(value.movement_id) && date(value.occurred_on) && ['receipt', 'issue'].includes(value.direction) && int(value.positions, 1, 100) && int(value.ignored_items, 0, 990)
    && instant(value.created_at) && (value.state === 'active' ? value.reversal_movement_id === null && value.reversed_at === null && value.version === 1
      : uuid(value.reversal_movement_id) && instant(value.reversed_at) && value.version === 2), upstream);
  return { id: value.id, invoice_id: value.invoice_id, invoice_version: value.invoice_version, source: value.source, state: value.state, version: value.version, warehouse: warehouseRef(value.warehouse),
    movement_id: value.movement_id, occurred_on: value.occurred_on, direction: value.direction, positions: value.positions, ignored_items: value.ignored_items, created_at: value.created_at,
    reversal_movement_id: value.reversal_movement_id, reversed_at: value.reversed_at };
}
function sourceDto(value, direction) {
  const kit = object(value) && Object.hasOwn(value, 'kit_product_id'), converted = object(value) && Object.hasOwn(value, 'conversion'), factor = converted && value.conversion === 'supplier';
  need(!(kit && converted) && exact(value, ['position', 'quantity', ...(kit ? ['kit_product_id', 'kit_quantity', 'component_quantity'] : []), ...(converted ? ['invoice_quantity', 'invoice_unit', 'conversion', ...(factor ? ['factor'] : [])] : [])])
    && int(value.position, 1, 990) && stored(value.quantity) && units(value.quantity) > 0n
    && (!kit || (uuid(value.kit_product_id) && stored(value.kit_quantity) && stored(value.component_quantity) && units(value.kit_quantity) * units(value.component_quantity) === units(value.quantity) * 1000000n))
    // 295: an entry note item in another unit: the quantity of the note, its unit and the rule (factor of the supplier or unidade tributária).
    && (!converted || (direction === 'receipt' && stored(value.invoice_quantity) && units(value.invoice_quantity) > 0n && text(value.invoice_unit, 6, 1) && ['supplier', 'tax_unit'].includes(value.conversion)
      && (!factor || (stored(value.factor) && units(value.factor) > 0n && units(value.invoice_quantity) * units(value.factor) === units(value.quantity) * 1000000n)))), upstream);
  if (kit) return { position: value.position, quantity: value.quantity, kit_product_id: value.kit_product_id, kit_quantity: value.kit_quantity, component_quantity: value.component_quantity };
  if (converted) return { position: value.position, quantity: value.quantity, invoice_quantity: value.invoice_quantity, invoice_unit: value.invoice_unit, conversion: value.conversion, ...(factor ? { factor: value.factor } : {}) };
  return { position: value.position, quantity: value.quantity };
}
function previewDto(value, args, kind) {
  const reverse = kind === 'reverse';
  need(object(value) && exact(value, ['action', ...(reverse ? ['posting'] : ['source']), 'invoice', 'direction', 'occurred_on', 'reason', 'warehouse', 'positions', 'ignored', 'preview_hash'])
    && value.action === (reverse ? 'reverse' : 'post') && (reverse || value.source === (kind === 'checkin' ? 'checkin' : 'invoice')) && date(value.occurred_on) && text(value.reason, 500, 3)
    && typeof value.preview_hash === 'string' && HASH.test(value.preview_hash) && Array.isArray(value.positions) && value.positions.length >= 1 && value.positions.length <= 100 && Array.isArray(value.ignored), upstream);
  const invoice = invoiceDto(value.invoice, args.p_invoice_id), direction = reverse ? 'reversal' : invoice.direction === '0' ? 'receipt' : 'issue';
  need(value.direction === direction && (kind !== 'checkin' || invoice.direction === '0'), upstream);
  const warehouse = reverse ? warehouseRef(value.warehouse) : (need(exact(value.warehouse, ['id', 'name', 'version', 'active']) && value.warehouse.id === args.p_warehouse_id && text(value.warehouse.name, 200, 1)
    && int(value.warehouse.version, 1) && value.warehouse.active === true, upstream), { id: value.warehouse.id, name: value.warehouse.name, version: value.warehouse.version, active: true });
  const posting = reverse ? postingDto(value.posting, args.p_invoice_id) : null;
  need(!posting || (posting.id === args.p_posting_id && posting.version === args.p_posting_version && posting.state === 'active'), upstream);
  const positions = value.positions.map(p => {
    const kept = object(p) && Object.hasOwn(p, 'balance_kept');
    need(exact(p, ['product_id', 'product_name', 'catalog_version', 'warehouse_id', 'unit', 'quantity', 'balance_before', 'balance_after', 'expected_version', 'sources', ...(kept ? ['balance_kept'] : [])])
      && uuid(p.product_id) && text(p.product_name, 200, 1) && int(p.catalog_version, 1) && uuid(p.warehouse_id) && (reverse || p.warehouse_id === warehouse.id) && text(p.unit, 16, 1)
      && stored(p.quantity) && units(p.quantity) !== 0n && stored(p.balance_before) && stored(p.balance_after) && units(p.balance_after) === units(p.balance_before) + units(p.quantity)
      && int(p.expected_version) && Array.isArray(p.sources) && (!kept || (reverse && p.balance_kept === true))
      && (direction === 'receipt' ? units(p.quantity) > 0n : direction === 'issue' ? units(p.quantity) < 0n : true), upstream);
    const sources = p.sources.map(s => sourceDto(s, direction));
    // The position is the sum of its sources (a reversal mirrors the posted lines and carries none).
    need(reverse ? sources.length === 0 : sources.length >= 1 && sources.reduce((sum, s) => sum + units(s.quantity), 0n) === (units(p.quantity) < 0n ? -units(p.quantity) : units(p.quantity)), upstream);
    return { product_id: p.product_id, product_name: p.product_name, catalog_version: p.catalog_version, warehouse_id: p.warehouse_id, unit: p.unit, quantity: p.quantity,
      balance_before: p.balance_before, balance_after: p.balance_after, expected_version: p.expected_version, sources, ...(kept ? { balance_kept: true } : {}) };
  });
  need(new Set(positions.map(p => `${p.product_id}:${p.warehouse_id}`)).size === positions.length, upstream);
  const ignored = value.ignored.map(i => { need(!reverse && exact(i, ['position', 'product_id', 'description', 'quantity', 'unit', 'reason']) && int(i.position, 1, 990) && (i.product_id === null || uuid(i.product_id))
    && text(i.description, 120) && stored(i.quantity) && optionalText(i.unit, 16) && IGNORED.includes(i.reason) && (i.reason === 'unlinked_item') === (i.product_id === null), upstream);
    return { position: i.position, product_id: i.product_id, description: i.description, quantity: i.quantity, unit: i.unit, reason: i.reason }; });
  return { action: value.action, ...(reverse ? { posting } : { source: value.source }), invoice, direction, occurred_on: value.occurred_on, reason: value.reason, warehouse, positions, ignored, preview_hash: value.preview_hash };
}
// 295: "Conversão de unidades" of an entry note: each item with a product in another unit, the factor of the supplier, the unidade
// tributária and the rule that applies (the factor first), with the quantity in the unit of the product or why it cannot convert.
const TAX_QUANTITY = /^[0-9]{1,12}(\.[0-9]{1,6})?$/, FACTOR_STORED = /^(0|[1-9][0-9]{0,5})\.[0-9]{6}$/;
// The same comparison as erp_stock.unit_key (upper(btrim)): btrim only removes spaces.
const sameUnit = (a, b) => a.replace(/^ +| +$/g, '').toUpperCase() === b.replace(/^ +| +$/g, '').toUpperCase();
function unitsDto(value, invoiceId) {
  need(exact(value, ['scope', 'data_mode', 'invoice', 'supplier', 'can_manage', 'total', 'items']) && value.scope === 'stock_invoice_units' && value.data_mode === 'erp_native'
    && typeof value.can_manage === 'boolean' && int(value.total, 0, 990) && Array.isArray(value.items) && value.items.length === Math.min(100, value.total), upstream);
  const invoice = invoiceDto(value.invoice, invoiceId), supplier = value.supplier === null ? null : warehouseRef(value.supplier);
  need(invoice.direction === '0' || (value.total === 0 && !value.can_manage), upstream);
  let last = 0;
  const items = value.items.map(i => {
    need(exact(i, ['position', 'description', 'unit', 'quantity', 'product', 'tax', 'factor', 'rule', 'converted_quantity', 'problem']) && int(i.position, last + 1, 990) && text(i.description, 120)
      && optionalText(i.unit, 6) && stored(i.quantity) && units(i.quantity) > 0n
      && exact(i.product, ['id', 'name', 'code', 'unit']) && uuid(i.product.id) && text(i.product.name, 200, 1) && optionalText(i.product.code, 100) && text(i.product.unit, 16, 1)
      && (i.unit === null || !sameUnit(i.unit, i.product.unit))
      && (i.tax === null || (exact(i.tax, ['unit', 'quantity']) && text(i.tax.unit, 6, 1) && (i.tax.quantity === null || (typeof i.tax.quantity === 'string' && TAX_QUANTITY.test(i.tax.quantity)))))
      && (i.factor === null || (supplier !== null && exact(i.factor, ['factor', 'version']) && typeof i.factor.factor === 'string' && FACTOR_STORED.test(i.factor.factor) && units(i.factor.factor) > 0n && int(i.factor.version, 1)))
      && [null, 'supplier', 'tax_unit'].includes(i.rule) && (i.rule === 'supplier') === (i.factor !== null)
      && (i.rule === null ? i.converted_quantity === null && i.problem === null
        : (i.converted_quantity === null) !== (i.problem === null) && (i.problem === null || ['inexact', 'excess'].includes(i.problem)) && (i.converted_quantity === null || (stored(i.converted_quantity) && units(i.converted_quantity) > 0n)))
      && (i.rule !== 'supplier' || i.converted_quantity === null || units(i.quantity) * units(i.factor.factor) === units(i.converted_quantity) * 1000000n)
      && (i.rule !== 'tax_unit' || (i.tax !== null && sameUnit(i.tax.unit, i.product.unit))), upstream);
    last = i.position;
    return { position: i.position, description: i.description, unit: i.unit, quantity: i.quantity, product: { id: i.product.id, name: i.product.name, code: i.product.code, unit: i.product.unit },
      tax: i.tax === null ? null : { unit: i.tax.unit, quantity: i.tax.quantity }, factor: i.factor === null ? null : { factor: i.factor.factor, version: i.factor.version },
      rule: i.rule, converted_quantity: i.converted_quantity, problem: i.problem };
  });
  return { invoice, supplier, can_manage: value.can_manage, total: value.total, items, scope: 'stock_invoice_units', data_mode: 'erp_native' };
}
const factorRef = value => { need(value === null || (exact(value, ['factor', 'version']) && typeof value.factor === 'string' && FACTOR_STORED.test(value.factor) && int(value.version, 1)), upstream); return value === null ? null : { factor: value.factor, version: value.version }; };
const factorUnits = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')); };
function unitSaveDto(value, args) {
  need(exact(value, ['scope', 'data_mode', 'command_id', 'position', 'product_id', 'supplier_id', 'unit', 'product_unit', 'before', 'after', 'saved_at', 'units', 'replayed'])
    && value.scope === 'stock_invoice_unit_save' && value.command_id === args.p_command_id && value.position === args.p_position && uuid(value.product_id) && uuid(value.supplier_id)
    && text(value.unit, 6, 1) && value.unit === value.unit.trim().toUpperCase() && text(value.product_unit, 16, 1) && instant(value.saved_at) && typeof value.replayed === 'boolean', upstream);
  const before = factorRef(value.before), after = factorRef(value.after);
  // A new command saved exactly what was asked over the expected version; a replay returns the stored receipt.
  need(value.replayed || ((before === null ? args.p_expected_version === 0 : before.version === args.p_expected_version)
    && (args.p_factor === null ? after === null && before !== null : after !== null && factorUnits(after.factor) === factorUnits(args.p_factor) && after.version === args.p_expected_version + 1)), upstream);
  need(object(value.units), upstream);
  const view = unitsDto({ ...value.units, scope: 'stock_invoice_units', data_mode: 'erp_native' }, args.p_invoice_id);
  need(view.supplier?.id === value.supplier_id, upstream);
  return { command_id: value.command_id, position: value.position, product_id: value.product_id, supplier_id: value.supplier_id, unit: value.unit, product_unit: value.product_unit,
    before, after, saved_at: value.saved_at, units: view, replayed: value.replayed, scope: value.scope, data_mode: 'erp_native' };
}
function movementDto(value, kind) {
  need(object(value) && uuid(value.id) && value.kind === kind && date(value.occurred_on) && Array.isArray(value.items) && value.items.length >= 1 && value.items.length <= 100
    && value.items.every(item => object(item) && uuid(item.product_id) && uuid(item.warehouse_id) && stored(item.quantity) && stored(item.balance_after) && int(item.balance_version, 1)), upstream);
  return { id: value.id, kind: value.kind, occurred_on: value.occurred_on, items: value.items.map(item => ({ product_id: item.product_id, warehouse_id: item.warehouse_id, quantity: item.quantity, balance_after: item.balance_after, balance_version: item.balance_version })) };
}
function resultDto(value, args, kind) {
  const scope = { post: 'stock_invoice_post', reverse: 'stock_invoice_reverse', checkin: 'stock_checkin_post' }[kind];
  need(object(value) && value.scope === scope && value.command_id === args.p_command_id && typeof value.replayed === 'boolean', upstream);
  const invoice = invoiceDto(value.invoice, args.p_invoice_id), posting = postingDto(value.posting, args.p_invoice_id), flag = flagDto(value.flag);
  const movement = movementDto(value.movement, kind === 'reverse' ? 'reversal' : invoice.direction === '0' ? 'receipt' : 'issue');
  need(kind === 'reverse' ? posting.id === args.p_posting_id && posting.state === 'reversed' && posting.reversal_movement_id === movement.id
    : posting.movement_id === movement.id && posting.source === (kind === 'checkin' ? 'checkin' : 'invoice') && (kind !== 'checkin' || posting.direction === 'receipt'), upstream);
  // A new command leaves the letter it produced; a replay reads the current one.
  need(value.replayed || (kind === 'reverse' ? flag.flag !== 'S' : flag.flag === 'S' && flag.posting_id === posting.id), upstream);
  const out = { command_id: value.command_id, invoice, posting, movement, flag, replayed: value.replayed, scope, data_mode: 'erp_native' };
  if (kind === 'reverse') {
    need(Array.isArray(value.balance_adjustments) && value.balance_adjustments.length <= 2 && value.balance_adjustments.every(m => object(m) && uuid(m.id) && m.kind === 'adjustment'), upstream);
    out.balance_adjustments = value.balance_adjustments.map(m => ({ id: m.id, kind: m.kind }));
  }
  if (kind === 'checkin') {
    need(uuid(value.finish_command_id), upstream);
    out.finish_command_id = value.finish_command_id;
    out.checkin = checkinView({ ...value.checkin, scope: 'stock_checkin', data_mode: 'erp_native' }, args.p_invoice_id);
    need(out.checkin.checkin?.state === 'finished', upstream);
  }
  return out;
}
export function stockInvoicesResponse(value, operation) {
  need(object(value) && value.data_mode === 'erp_native', upstream);
  const args = operation.args;
  switch (operation.type) {
    case 'invoice-flags': {
      need(value.scope === 'stock_invoice_flags' && Array.isArray(value.items) && value.items.length <= args.p_ids.length, upstream);
      const items = value.items.map(item => { need(object(item) && args.p_ids.includes(item.invoice_id), upstream); const { invoice_id, ...flag } = item; return { invoice_id, ...flagDto(flag) }; });
      need(new Set(items.map(item => item.invoice_id)).size === items.length, upstream);
      return { items, scope: value.scope, data_mode: 'erp_native' };
    }
    case 'invoice-get': {
      need(value.scope === 'stock_invoice' && BLOCKS.includes(value.block) && typeof value.can_manage === 'boolean' && date(value.occurred_on) && ['data_atual', 'data_documento'].includes(value.date_mode)
        && typeof value.checkin_post === 'boolean' && Array.isArray(value.postings) && value.postings.length <= 20, upstream);
      const invoice = invoiceDto(value.invoice, args.p_invoice_id), flag = flagDto(value.flag), postings = value.postings.map(p => postingDto(p, args.p_invoice_id));
      need((flag.flag === 'S' ? value.block === 'posted' || CLOSED.includes(value.block) : value.block !== 'posted') && (flag.flag !== 'R' || value.block === 'reference' || CLOSED.includes(value.block))
        && (value.block !== 'deleted') === !invoice.deleted
        && postings.filter(p => p.state === 'active').length === (flag.flag === 'S' ? 1 : 0) && (flag.flag !== 'S' || postings.some(p => p.id === flag.posting_id && p.state === 'active')), upstream);
      return { invoice, flag, block: value.block, can_manage: value.can_manage, occurred_on: value.occurred_on, date_mode: value.date_mode, checkin_post: value.checkin_post,
        default_warehouse: value.default_warehouse === null ? null : warehouseRef(value.default_warehouse), postings, scope: value.scope, data_mode: 'erp_native' };
    }
    case 'invoice-preview': case 'invoice-checkin-preview': {
      const checkin = operation.type === 'invoice-checkin-preview';
      need(value.scope === (checkin ? 'stock_checkin_post_preview' : 'stock_invoice_preview') && (!checkin || value.checkin_version === args.p_expected_version), upstream);
      const preview = previewDto(value.preview, args, checkin ? 'checkin' : 'post');
      need(checkin || preview.invoice.version === args.p_expected_version, upstream);
      return { preview, ...(checkin ? { checkin_version: value.checkin_version } : {}), scope: value.scope, data_mode: 'erp_native' };
    }
    case 'invoice-reverse-preview':
      need(value.scope === 'stock_invoice_reverse_preview', upstream);
      return { preview: previewDto(value.preview, args, 'reverse'), scope: value.scope, data_mode: 'erp_native' };
    case 'invoice-units': return unitsDto(value, args.p_invoice_id);
    case 'invoice-unit-save': return unitSaveDto(value, args);
    case 'invoice-post': return resultDto(value, args, 'post');
    case 'invoice-reverse': return resultDto(value, args, 'reverse');
    case 'invoice-checkin-post': return resultDto(value, args, 'checkin');
    default: return upstream();
  }
}
