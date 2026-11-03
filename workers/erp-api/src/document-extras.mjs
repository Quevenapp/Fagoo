// Documentos lane, wave G: the routes of the document editor added after 287, kept apart from documents.mjs (a shared hotspot).
// 202610200288:
// - GET  /v1/documentos/service_orders/campos-customizados: the campos customizados of the OS (readers of OS; can_manage = administrador);
// - POST /v1/documentos/service_orders/campos-customizados[/{campo}]: Adicionar campo / Editar Campo (command, expected version, data);
// - POST /v1/documentos/service_orders/campos-customizados/{campo}/exclusao: Excluir (refused while an OS has a value);
// - GET  /v1/documentos/{sales_orders|service_orders}/lotes?produtos=a,b: "Controle de lote" of the products of the document;
// - GET  /v1/documentos/{sales_orders|service_orders}/lotes/{produto}?deposito=: the lots offered by Informar lotes;
// - GET  /v1/documentos/{sales_orders|service_orders}/comissao?vendedor=: the commission rule of the vendedor (aba Comissões);
// - GET  /v1/documentos/{sales_orders|sales_proposals|service_orders}/produtos?q=&limit=: the search of the Descrição of a line.
// 202610210370 (leva H, financeiro): GET /v1/documentos/{sales_orders|service_orders}/{id}/comissao: the commission frozen on the
//   operation (commercial confirmation) and each item's share of the base, for the aba Comissões.
// 202610210374 (leva H, financeiro): GET|POST /v1/documentos/sales_orders/{id}/frete-pago: the frete pago pela empresa (apart from the
//   frete cobrado do cliente; no conta is created) and the costs applied on the operation.
// 202610200290:
// - POST /v1/documentos/{sales_orders|service_orders|purchase_orders}/{id}/observacoes: only Observações and Observações internas, also
//   with active effects (answered as the document, by the generic document response).
// 202610200291 (Vendas › Logística › Checkout de pedidos):
// - GET  /v1/documentos/sales_orders/{id}/checkout: the lines to check (item or component), the reads and the checkout options;
// - POST /v1/documentos/sales_orders/{id}/checkout: the reads (command, document version, checkout version); the situação follows
//   (all read = Verificado, part = Checkout parcial, none = Em aberto).
// 202610210392 (leva H, documentos): POST /v1/documentos/{tipo}/lixeira: Excluir (to the lixeira) or Restaurar the selected documents
//   (up to 100 per command, a result per document; documents with effects are refused with the reason).
// Strict params and closed bodies, exact decimal strings, every response projected and cross-checked.
import { catalogResponse } from './catalog.mjs';
import { projectCommissionOperation } from './finance-commissions.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MULTILINE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
export const CUSTOM_FIELD_TYPES = Object.freeze(['integer', 'decimal', 'list', 'text', 'long_text', 'boolean', 'date']);
export const CUSTOM_FIELD_WIDTHS = Object.freeze(['small', 'medium', 'large', 'extra_large']);
const CUSTOM_FIELD_KEYS = ['field_type', 'name', 'hint', 'info', 'required', 'min_length', 'max_length', 'width', 'options', 'active'];
export class DocumentExtrasError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new DocumentExtrasError(400, 'ERP_INVALID_QUERY'); };
const bad = () => { throw new DocumentExtrasError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const characters = value => [...value].length;
const line = (value, max, min = 1) => typeof value === 'string' && characters(value) <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const block = (value, max) => typeof value === 'string' && characters(value) <= max && value.trim().length >= 1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const instant = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const day = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const percent = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/.test(value) && Number(value) <= 100;
// The balance of a lot (6 decimals); negative when the stock policy let it go below zero.
const quantity = value => typeof value === 'string' && /^-?(0|[1-9][0-9]{0,11})\.[0-9]{6}$/.test(value) && value !== '-0.000000';
const single = (params, allowed) => { for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid(); };
// 202610200291: a checkout line is an item (its id) or a component of its structure (item id:component id); reads have up to 6 decimals.
const CHECKOUT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const READ = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;
const STORED_READ = /^(0|[1-9][0-9]{0,17})\.[0-9]{6}$/;
const units = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')); };
const CHECKOUT_STATUSES = ['draft', 'open', 'verified', 'in_progress', 'agency_sale', 'checkout_partial', 'partially_fulfilled', 'partially_invoiced', 'fulfilled', 'cancelled'];
function checkoutView(value, route, saving) {
  const d = value.order, s = value.settings;
  if (value.kind !== 'sales_orders' || !exact(d, ['id', 'number', 'version', 'status', 'contact_name', 'date']) || d.id !== route.id || typeof d.number !== 'string' || !/^[1-9][0-9]{0,9}$/.test(d.number)
    || !version(d.version, 1) || !CHECKOUT_STATUSES.includes(d.status) || !line(d.contact_name, 200) || !day(d.date) || typeof value.available !== 'boolean' || value.available !== ['open', 'checkout_partial'].includes(d.status)
    || typeof value.split !== 'boolean' || !int(value.checkout_version, 0, 2147483647) || !exact(s, ['order', 'split', 'picking', 'auto_save', 'quantity_input']) || !['crescente', 'nao_ordenar'].includes(s.order)
    || ['split', 'picking', 'auto_save', 'quantity_input'].some(key => typeof s[key] !== 'boolean') || !Array.isArray(value.lines) || value.lines.length > 1000 || !Array.isArray(value.reads) || value.reads.length > value.lines.length) bad();
  const keys = new Map();
  const lines = value.lines.map(item => {
    if (!exact(item, ['key', 'item_id', 'component_id', 'product_id', 'position', 'description', 'code', 'unit', 'quantity', 'gtin', 'gtin_tax', 'location']) || !LOWER_UUID.test(item.item_id ?? '')
      || (item.component_id !== null && !LOWER_UUID.test(item.component_id)) || item.key !== (item.component_id ? `${item.item_id}:${item.component_id}` : item.item_id)
      || (item.product_id !== null && !LOWER_UUID.test(item.product_id)) || (item.component_id !== null && item.product_id !== item.component_id) || !int(item.position, 1, 250)
      || !line(item.description, 200) || (item.code !== null && !line(item.code, 100)) || typeof item.unit !== 'string' || characters(item.unit) > 16 || !STORED_READ.test(item.quantity ?? '') || units(item.quantity) <= 0n
      || ['gtin', 'gtin_tax'].some(key => item[key] !== null && !line(item[key], 14)) || (item.location !== null && !line(item.location, 100)) || keys.has(item.key)) bad();
    keys.set(item.key, units(item.quantity));
    return Object.fromEntries(['key', 'item_id', 'component_id', 'product_id', 'position', 'description', 'code', 'unit', 'quantity', 'gtin', 'gtin_tax', 'location'].map(key => [key, item[key]]));
  });
  const seen = new Set();
  const reads = value.reads.map(read => {
    if (!exact(read, ['key', 'quantity']) || !keys.has(read.key) || seen.has(read.key) || !STORED_READ.test(read.quantity ?? '') || units(read.quantity) <= 0n || units(read.quantity) > keys.get(read.key)) bad();
    seen.add(read.key); return { key: read.key, quantity: read.quantity };
  });
  const base = { kind: 'sales_orders', order: { ...d }, available: value.available, split: value.split, lines, reads, checkout_version: value.checkout_version, settings: { ...s } };
  if (!saving) { if (value.complete !== undefined || value.replayed !== undefined) bad(); return base; }
  const complete = lines.every(item => reads.some(read => read.key === item.key && read.quantity === item.quantity));
  if (typeof value.complete !== 'boolean' || value.complete !== complete || typeof value.replayed !== 'boolean' || value.checkout_version < 1
    || (!value.replayed && (complete ? d.status !== 'verified' : reads.length ? d.status !== 'checkout_partial' : d.status !== 'open'))) bad();
  let auto = {};
  if (value.auto_finance !== undefined) {
    const a = value.auto_finance;
    if (a?.outcome === 'done' ? !exact(a, ['outcome', 'posting_id']) || !LOWER_UUID.test(a.posting_id ?? '') : !exact(a, ['outcome', 'reason']) || a.outcome !== 'skipped' || !/^erp_[a-z0-9_]{1,80}$/.test(a.reason ?? '')) bad();
    auto = { auto_finance: { ...a } };
  }
  return { ...base, complete, replayed: value.replayed, ...auto };
}

const KIND = '(sales_proposals|sales_orders|purchase_orders|service_orders)';
export function documentExtrasRoute(path) {
  const trash = new RegExp(`^/v1/documentos/${KIND}/lixeira$`).exec(path);
  if (trash) return { extra: true, kind: trash[1], id: null, action: 'trash' };
  const notes = /^\/v1\/documentos\/(sales_orders|service_orders|purchase_orders)\/([0-9a-fA-F-]{36})\/observacoes$/.exec(path);
  if (notes) return UUID.test(notes[2]) ? { extra: true, kind: notes[1], id: notes[2].toLowerCase(), action: 'notes' } : null;
  // 202610200294: "Exibir descrição do produto no fornecedor" of the prints.
  const descriptions = new RegExp(`^/v1/documentos/${KIND}/([0-9a-fA-F-]{36})/descricoes-fornecedor$`).exec(path);
  if (descriptions) return UUID.test(descriptions[2]) ? { extra: true, kind: descriptions[1], id: descriptions[2].toLowerCase(), action: 'supplier_descriptions' } : null;
  const checkout = /^\/v1\/documentos\/sales_orders\/([0-9a-fA-F-]{36})\/checkout$/.exec(path);
  if (checkout) return UUID.test(checkout[1]) ? { extra: true, kind: 'sales_orders', id: checkout[1].toLowerCase(), action: 'checkout' } : null;
  const fields = /^\/v1\/documentos\/service_orders\/campos-customizados(?:\/([0-9a-fA-F-]{36})(\/exclusao)?)?$/.exec(path);
  if (fields) {
    if (fields[1] && !UUID.test(fields[1])) return null;
    return { extra: true, kind: 'service_orders', id: null, field: fields[1]?.toLowerCase() ?? null, action: fields[2] ? 'custom_field_delete' : fields[1] ? 'custom_field_update' : 'custom_fields' };
  }
  const lots = new RegExp(`^/v1/documentos/${KIND}/lotes(?:/([0-9a-fA-F-]{36}))?$`).exec(path);
  if (lots) {
    if (!['sales_orders', 'service_orders'].includes(lots[1]) || (lots[2] && !UUID.test(lots[2]))) return null;
    return { extra: true, kind: lots[1], id: null, product: lots[2]?.toLowerCase() ?? null, action: lots[2] ? 'lot_options' : 'lot_products' };
  }
  const freight = /^\/v1\/documentos\/sales_orders\/([0-9a-fA-F-]{36})\/frete-pago$/.exec(path);
  if (freight) return UUID.test(freight[1]) ? { extra: true, kind: 'sales_orders', id: freight[1].toLowerCase(), action: 'freight_paid' } : null;
  const operation = new RegExp(`^/v1/documentos/${KIND}/([0-9a-fA-F-]{36})/comissao$`).exec(path);
  if (operation) return ['sales_orders', 'service_orders'].includes(operation[1]) && UUID.test(operation[2]) ? { extra: true, kind: operation[1], id: operation[2].toLowerCase(), action: 'commission_operation' } : null;
  const commission = new RegExp(`^/v1/documentos/${KIND}/comissao$`).exec(path);
  if (commission) return ['sales_orders', 'service_orders'].includes(commission[1]) ? { extra: true, kind: commission[1], id: null, action: 'seller_commission' } : null;
  const search = new RegExp(`^/v1/documentos/${KIND}/produtos$`).exec(path);
  if (search) return search[1] !== 'purchase_orders' ? { extra: true, kind: search[1], id: null, action: 'product_search' } : null;
  return null;
}
export function documentExtrasMethods(route) {
  return { trash: ['POST'], notes: ['POST'], checkout: ['GET', 'POST'], supplier_descriptions: ['GET'], custom_fields: ['GET', 'POST'], custom_field_update: ['POST'], custom_field_delete: ['POST'], lot_products: ['GET'], lot_options: ['GET'], seller_commission: ['GET'], commission_operation: ['GET'], freight_paid: ['GET', 'POST'], product_search: ['GET'] }[route.action] ?? [];
}

/** The drawer "Adicionar campo" / "Editar Campo": every key, the same limits as erp_documents.custom_field_input. */
export function customFieldData(value) {
  if (!exact(value, CUSTOM_FIELD_KEYS) || !CUSTOM_FIELD_TYPES.includes(value.field_type) || !line(value.name, 60) || (value.hint !== null && !line(value.hint, 100))
    || (value.info !== null && !block(value.info, 300)) || typeof value.required !== 'boolean' || typeof value.active !== 'boolean' || !CUSTOM_FIELD_WIDTHS.includes(value.width)
    || (value.min_length !== null && !int(value.min_length, 1, 4000)) || (value.max_length !== null && !int(value.max_length, 1, 4000))
    || (value.min_length !== null && value.max_length !== null && value.min_length > value.max_length)
    || ((value.min_length !== null || value.max_length !== null) && !['integer', 'decimal', 'text', 'long_text'].includes(value.field_type))
    || !Array.isArray(value.options) || value.options.length > 50 || (value.field_type === 'list') !== (value.options.length > 0)
    || value.options.some(option => !exact(option, ['id', 'label']) || (option.id !== null && (typeof option.id !== 'string' || !UUID.test(option.id))) || !line(option.label, 60))
    || new Set(value.options.map(option => option.label.trim().toLowerCase())).size !== value.options.length
    || new Set(value.options.filter(option => option.id).map(option => option.id.toLowerCase())).size !== value.options.filter(option => option.id).length) invalid();
  return { ...value, options: value.options.map(option => ({ id: option.id?.toLowerCase() ?? null, label: option.label })) };
}
const command = input => typeof input.command_id === 'string' && UUID.test(input.command_id);
const version = (value, min) => int(value, min, 2147483647);

export async function documentExtrasOperation(request, route, params, readBody) {
  const kind = route.kind;
  if (route.action === 'trash') {
    if (params.size) invalid();
    const input = await readBody(request);
    if (!exact(input, ['command_id', 'action', 'ids', 'reason']) || !command(input) || !['delete', 'restore'].includes(input.action) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100
      || input.ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(input.ids.map(id => id.toLowerCase())).size !== input.ids.length
      || (input.action === 'delete' ? !line(input.reason, 1000) || input.reason.trim().length < 3 : input.reason !== null)) invalid();
    return { extra: true, rpc: 'erp_document_trash', args: { p_kind: kind, p_command_id: input.command_id.toLowerCase(), p_action: input.action, p_ids: input.ids.map(id => id.toLowerCase()), p_reason: input.reason === null ? null : input.reason.trim() }, type: 'trash' };
  }
  if (route.action === 'checkout') {
    if (params.size) invalid();
    if (request.method === 'GET') return { extra: true, rpc: 'erp_document_checkout_get', args: { p_id: route.id }, type: 'checkout' };
    const input = await readBody(request);
    if (!exact(input, ['command_id', 'expected_version', 'checkout_version', 'reads']) || !command(input) || !version(input.expected_version, 1) || !int(input.checkout_version, 0, 2147483646)
      || !Array.isArray(input.reads) || input.reads.length > 1000 || input.reads.some(read => !exact(read, ['key', 'quantity']) || !CHECKOUT_KEY.test(read.key ?? '') || !READ.test(read.quantity ?? ''))
      || new Set(input.reads.map(read => read.key.toLowerCase())).size !== input.reads.length) invalid();
    return { extra: true, rpc: 'erp_document_checkout_save', args: { p_id: route.id, p_expected_version: input.expected_version, p_checkout_version: input.checkout_version, p_command_id: input.command_id.toLowerCase(),
      p_reads: input.reads.map(read => ({ key: read.key.toLowerCase(), quantity: read.quantity })) }, type: 'checkout' };
  }
  if (request.method === 'GET') {
    if (route.action === 'supplier_descriptions') { if (params.size) invalid(); return { extra: true, rpc: 'erp_document_supplier_descriptions', args: { p_kind: kind, p_document_id: route.id }, type: 'supplier_descriptions' }; }
    if (route.action === 'custom_fields') { if (params.size) invalid(); return { extra: true, rpc: 'erp_document_custom_fields', args: { p_kind: kind }, type: 'custom_fields' }; }
    if (route.action === 'lot_products') {
      single(params, ['produtos']);
      const ids = (params.get('produtos') ?? '').split(',');
      if (!ids.length || ids.length > 250 || ids.some(id => !UUID.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) invalid();
      return { extra: true, rpc: 'erp_document_lot_products', args: { p_kind: kind, p_product_ids: ids.map(id => id.toLowerCase()) }, type: 'lot_products' };
    }
    if (route.action === 'lot_options') {
      single(params, ['deposito']);
      const warehouse = params.get('deposito');
      if (warehouse !== null && !UUID.test(warehouse)) invalid();
      return { extra: true, rpc: 'erp_document_lot_options', args: { p_kind: kind, p_product_id: route.product, p_warehouse_id: warehouse?.toLowerCase() ?? null }, type: 'lot_options' };
    }
    if (route.action === 'freight_paid') {
      if (params.size) invalid();
      return { extra: true, rpc: 'erp_document_freight_paid_get', args: { p_kind: kind, p_document_id: route.id }, type: 'freight_paid' };
    }
    if (route.action === 'commission_operation') {
      if (params.size) invalid();
      return { extra: true, rpc: 'erp_document_commission_operation', args: { p_kind: kind, p_document_id: route.id }, type: 'commission_operation' };
    }
    if (route.action === 'seller_commission') {
      single(params, ['vendedor']);
      const seller = params.get('vendedor');
      if (!UUID.test(seller ?? '')) invalid();
      return { extra: true, rpc: 'erp_document_seller_commission', args: { p_kind: kind, p_seller_id: seller.toLowerCase() }, type: 'seller_commission' };
    }
    if (route.action === 'product_search') {
      single(params, ['q', 'limit']);
      const query = params.get('q') ?? '', limit = params.get('limit') ?? '8';
      if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 25 || characters(query.trim()) < 2 || characters(query) > 120 || /[\x00-\x1f\x7f]/.test(query)) invalid();
      return { extra: true, rpc: 'erp_document_product_search', args: { p_kind: kind, p_query: query.trim(), p_limit: Number(limit) }, type: 'product_search' };
    }
    invalid();
  }
  if (params.size) invalid();
  const input = await readBody(request);
  if (route.action === 'notes') {
    const note = value => value === null || (typeof value === 'string' && characters(value) <= 4000 && !MULTILINE_CONTROL.test(value));
    if (!exact(input, ['command_id', 'expected_version', 'notes', 'internal_notes']) || !command(input) || !version(input.expected_version, 1) || !note(input.notes) || !note(input.internal_notes)) invalid();
    // No `extra`: the answer is the document, checked by the generic document response of documents.mjs.
    return { rpc: 'erp_document_notes_save', args: { p_kind: kind, p_id: route.id, p_expected_version: input.expected_version, p_command_id: input.command_id.toLowerCase(), p_notes: input.notes, p_internal_notes: input.internal_notes }, type: 'document' };
  }
  if (route.action === 'custom_fields' || route.action === 'custom_field_update') {
    const update = route.action === 'custom_field_update';
    if (!exact(input, ['command_id', 'expected_version', 'data']) || !command(input) || !(update ? version(input.expected_version, 1) : input.expected_version === 0)) invalid();
    return { extra: true, rpc: 'erp_document_custom_field_save', args: { p_kind: kind, p_id: route.field, p_expected_version: input.expected_version, p_command_id: input.command_id.toLowerCase(), p_data: customFieldData(input.data) }, type: 'custom_field' };
  }
  if (route.action === 'freight_paid') {
    const data = input.data;
    if (!exact(input, ['command_id', 'expected_version', 'data']) || !command(input) || !int(input.expected_version, 0, 2147483646) || !exact(data, ['amount', 'note'])
      || typeof data.amount !== 'string' || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(data.amount) || (data.note !== null && !line(data.note, 200))) invalid();
    return { extra: true, rpc: 'erp_document_freight_paid_save', args: { p_kind: kind, p_document_id: route.id, p_expected_version: input.expected_version, p_command_id: input.command_id.toLowerCase(), p_data: { amount: data.amount, note: data.note } }, type: 'freight_paid' };
  }
  if (route.action === 'custom_field_delete') {
    if (!exact(input, ['command_id', 'expected_version']) || !command(input) || !version(input.expected_version, 1)) invalid();
    return { extra: true, rpc: 'erp_document_custom_field_delete', args: { p_kind: kind, p_id: route.field, p_expected_version: input.expected_version, p_command_id: input.command_id.toLowerCase() }, type: 'custom_field_delete' };
  }
  return invalid();
}

function customField(value, admin) {
  const keys = ['id', 'kind', 'field_type', 'name', 'hint', 'info', 'required', 'min_length', 'max_length', 'width', 'options', 'active', 'version', 'created_at', 'updated_at', 'documents'];
  if (!exact(value, keys) || !LOWER_UUID.test(value.id) || value.kind !== 'service_orders') bad();
  try { customFieldData(Object.fromEntries(CUSTOM_FIELD_KEYS.map(key => [key, value[key]]))); } catch { bad(); }
  if (value.options.some(option => !LOWER_UUID.test(option.id ?? '')) || !version(value.version, 1) || !instant(value.created_at) || !instant(value.updated_at)
    || (admin ? !int(value.documents, 0, 2147483647) : value.documents !== null)) bad();
  return { ...Object.fromEntries(keys.map(key => [key, value[key]])), options: value.options.map(option => ({ id: option.id, label: option.label })) };
}
export function documentExtrasResponse(value, route, operation) {
  const base = { data_mode: 'erp_native', operational_effects: false };
  if (!object(value) || value.data_mode !== 'erp_native') bad();
  if (operation.type === 'product_search') {
    if (value.operational_effects !== false) bad();
    const page = catalogResponse(value, { entity: 'products' }, { type: 'list', args: { p_limit: operation.args.p_limit } });
    return { ...base, kind: route.kind, entity: 'products', items: page.items, limit: page.limit, has_more: page.has_more };
  }
  if (operation.type === 'trash') {
    const ids = operation.args.p_ids, reasons = ['not_found', 'stock_posted', 'finance_posted', 'invoice_linked', 'stock_reserved', 'grouped_billing', 'checkout', 'generated_document'];
    if (value.scope !== 'document_trash' || value.kind !== route.kind || value.action !== operation.args.p_action || value.command_id !== operation.args.p_command_id || typeof value.replayed !== 'boolean'
      || !Array.isArray(value.results) || value.results.length !== ids.length || value.results.some(r => !exact(r, ['id', 'ok', 'reason']) || !ids.includes(r.id) || typeof r.ok !== 'boolean'
        || (r.ok ? r.reason !== null : !reasons.includes(r.reason))) || new Set(value.results.map(r => r.id)).size !== ids.length) bad();
    return { ...base, kind: route.kind, action: value.action, command_id: value.command_id, replayed: value.replayed, results: value.results.map(r => ({ id: r.id, ok: r.ok, reason: r.reason })) };
  }
  if (value.operational_effects !== false || value.kind !== route.kind) bad();
  if (operation.type === 'checkout') return { ...base, ...checkoutView(value, route, operation.rpc === 'erp_document_checkout_save') };
  if (operation.type === 'supplier_descriptions') {
    if (value.document_id !== route.id || !Array.isArray(value.items) || value.items.length > 250 || value.items.some(item => !exact(item, ['item_id', 'product_id', 'description'])
      || !LOWER_UUID.test(item.item_id ?? '') || !LOWER_UUID.test(item.product_id ?? '') || !line(item.description, 120)) || new Set(value.items.map(item => item.item_id)).size !== value.items.length) bad();
    return { ...base, kind: route.kind, document_id: route.id, items: value.items.map(item => ({ item_id: item.item_id, product_id: item.product_id, description: item.description })) };
  }
  if (operation.type === 'custom_fields') {
    if (typeof value.can_manage !== 'boolean' || !Array.isArray(value.items) || value.items.length > 60) bad();
    const items = value.items.map(item => customField(item, value.can_manage));
    if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.name.toLowerCase())).size !== items.length) bad();
    return { ...base, kind: route.kind, can_manage: value.can_manage, items };
  }
  if (operation.type === 'custom_field') {
    if (typeof value.replayed !== 'boolean') bad();
    const field = customField(value.field, true);
    if ((route.field && field.id !== route.field) || field.name.trim() !== operation.args.p_data.name.trim() || field.field_type !== operation.args.p_data.field_type) bad();
    return { ...base, kind: route.kind, replayed: value.replayed, field };
  }
  if (operation.type === 'custom_field_delete') {
    if (typeof value.replayed !== 'boolean' || value.deleted !== route.field) bad();
    return { ...base, kind: route.kind, replayed: value.replayed, deleted: value.deleted };
  }
  if (operation.type === 'lot_products') {
    const asked = new Set(operation.args.p_product_ids);
    if (!Array.isArray(value.items) || value.items.length > asked.size || value.items.some(item => !exact(item, ['product_id', 'lot_control']) || !asked.has(item.product_id) || typeof item.lot_control !== 'boolean')
      || new Set(value.items.map(item => item.product_id)).size !== value.items.length) bad();
    return { ...base, kind: route.kind, items: value.items.map(item => ({ product_id: item.product_id, lot_control: item.lot_control })) };
  }
  if (operation.type === 'lot_options') {
    const p = value.product;
    if (!exact(p, ['id', 'name', 'code', 'unit', 'lot_control']) || p.id !== operation.args.p_product_id || !line(p.name, 200) || (p.code !== null && !line(p.code, 100, 0))
      || typeof p.unit !== 'string' || characters(p.unit) > 16 || typeof p.lot_control !== 'boolean' || value.warehouse_id !== operation.args.p_warehouse_id
      || !int(value.total, 0, 2147483647) || !Array.isArray(value.items) || value.items.length > 100 || value.items.length > value.total) bad();
    const items = value.items.map(item => {
      if (!exact(item, ['id', 'code', 'manufactured_on', 'expires_on', 'active', 'quantity']) || !LOWER_UUID.test(item.id) || !line(item.code, 60)
        || (item.manufactured_on !== null && !day(item.manufactured_on)) || (item.expires_on !== null && !day(item.expires_on)) || typeof item.active !== 'boolean' || !quantity(item.quantity)) bad();
      return { id: item.id, code: item.code, manufactured_on: item.manufactured_on, expires_on: item.expires_on, active: item.active, quantity: item.quantity };
    });
    if (new Set(items.map(item => item.id)).size !== items.length) bad();
    return { ...base, kind: route.kind, product: { id: p.id, name: p.name, code: p.code, unit: p.unit, lot_control: p.lot_control }, warehouse_id: value.warehouse_id, total: value.total, items };
  }
  if (operation.type === 'seller_commission') {
    if (value.seller_id !== operation.args.p_seller_id || !['fixa', 'descontos'].includes(value.mode) || (value.rate !== null && !percent(value.rate))
      || !Array.isArray(value.bands) || value.bands.length > 20 || value.bands.some(band => !exact(band, ['discount_up_to', 'rate']) || !percent(band.discount_up_to) || !percent(band.rate))
      || value.bands.some((band, index) => index > 0 && Number(band.discount_up_to) <= Number(value.bands[index - 1].discount_up_to))
      // 370: every addition of the política.
      || !Array.isArray(value.additions) || value.additions.some(item => !['desconto', 'frete', 'icms_st', 'ipi', 'taxas_pagamento'].includes(item)) || new Set(value.additions).size !== value.additions.length) bad();
    return { ...base, kind: route.kind, seller_id: value.seller_id, mode: value.mode, rate: value.rate, bands: value.bands.map(band => ({ discount_up_to: band.discount_up_to, rate: band.rate })), additions: [...value.additions] };
  }
  if (operation.type === 'freight_paid') {
    const item = value.item, money = v => typeof v === 'string' && /^\d{1,12}\.\d{2}$/.test(v);
    if (value.entity !== 'freight_paid' || !object(item) || item.document_id !== route.id || item.kind !== 'sales_orders' || !money(item.freight_charged) || (item.freight_paid !== null && !money(item.freight_paid))
      || (item.note !== null && !line(item.note, 200)) || !int(item.version, 0, 2147483647) || !Array.isArray(item.applied_costs) || item.applied_costs.length > 1000
      || (value.replayed !== undefined && typeof value.replayed !== 'boolean')) bad();
    const costs = item.applied_costs.map(cost => {
      if (!exact(cost, ['item_id', 'product_id', 'unit_cost', 'basis', 'applied_on']) || !LOWER_UUID.test(cost.item_id ?? '') || !LOWER_UUID.test(cost.product_id ?? '') || typeof cost.unit_cost !== 'string' || !/^\d{1,20}(\.\d{1,10})?$/.test(cost.unit_cost)
        || !['custo_medio', 'preco_custo', 'ultimo_pedido_compra'].includes(cost.basis) || !day(cost.applied_on)) bad();
      return { item_id: cost.item_id, product_id: cost.product_id, unit_cost: cost.unit_cost, basis: cost.basis, applied_on: cost.applied_on };
    });
    return { ...base, entity: 'freight_paid', item: { document_id: item.document_id, kind: 'sales_orders', freight_charged: item.freight_charged, freight_paid: item.freight_paid, note: item.note, version: item.version, applied_costs: costs },
      ...(value.replayed === undefined ? {} : { replayed: value.replayed }) };
  }
  if (operation.type === 'commission_operation') {
    if (value.document_id !== operation.args.p_document_id || value.kind !== route.kind || !Array.isArray(value.items) || value.items.length > 1000) bad();
    let frozen = null;
    if (value.operation !== null) { try { frozen = projectCommissionOperation(value.operation); } catch { bad(); } if (frozen.document_id !== value.document_id || frozen.state !== 'active') bad(); }
    const money = item => typeof item === 'string' && /^\d{1,15}$/.test(item);
    const items = value.items.map(item => {
      if (!exact(item, ['position', 'description', 'item_cents', 'base_cents', 'commission_cents']) || !int(item.position, 1, 1000) || typeof item.description !== 'string' || characters(item.description) > 240
        || !money(item.item_cents) || !money(item.base_cents) || !money(item.commission_cents)) bad();
      return { position: item.position, description: item.description, item_cents: item.item_cents, base_cents: item.base_cents, commission_cents: item.commission_cents };
    });
    if (frozen === null ? items.length > 0 : items.reduce((sum, item) => sum + BigInt(item.base_cents), 0n) !== (items.length ? BigInt(frozen.base_cents) : 0n)) bad();
    return { ...base, kind: route.kind, document_id: value.document_id, operation: frozen, items };
  }
  return bad();
}
