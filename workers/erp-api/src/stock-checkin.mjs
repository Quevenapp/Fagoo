/** Check-in de Recebimentos like Origin (migration 147): notes column, the check-in of one entry note and its commands
 * (Qtde Recebida, pendências, check-in em lote, Reiniciar, Finalizar). Strict params and closed bodies, exact decimal
 * strings and fail-closed projections. Routed by stock.mjs under /v1/estoque/checkin. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Q4 = /^(0|[1-9][0-9]{0,10})\.[0-9]{4}$/;
const QUANTITY_INPUT = /^(0|[1-9][0-9]{0,10})(?:\.[0-9]{1,4})?$/;
const PRICE = /^(0|[1-9][0-9]{0,13})\.[0-9]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// 181: units per box of a DUN code (numeric(18,6) of the product registry, 119).
const DUN_QUANTITY = /^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/;
const KINDS = ['missing', 'damaged', 'incorrect', 'refused'];
const ACTIONS = ['received', 'batch', 'missing', 'damaged', 'incorrect', 'refused', 'restart', 'finish'];
const STATES = ['pending', 'in_progress', 'complete', 'issue'];
const BASE = '/v1/estoque/checkin/notas';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const exact = (value, keys) => only(value, keys) && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const int = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max, min = 0) => typeof value === 'string' && value.length <= max && value.trim().length >= min && !/[\x00-\x1f\x7f]/.test(value);
const optionalText = (value, max) => value === null || text(value, max);
const instant = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const q4 = value => typeof value === 'string' && Q4.test(value);
const units = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(4, '0').slice(0, 4)); };
export class StockCheckinError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new StockCheckinError(400, 'ERP_INVALID_QUERY'); };
const upstream = () => { throw new StockCheckinError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const need = (value, fail = invalid) => { if (!value) fail(); };

const COMMANDS = { recebidos: 'save', pendencias: 'issue', lote: 'batch', reinicio: 'restart', finalizacao: 'finish' };
export function stockCheckinRoute(path) {
  if (path === BASE) return { type: 'checkin-notes' };
  const match = /^\/v1\/estoque\/checkin\/notas\/([0-9a-fA-F-]{36})(?:\/(recebidos|pendencias|lote|reinicio|finalizacao))?$/.exec(path);
  if (!match || !uuid(match[1])) return null;
  return match[2] ? { type: 'checkin-command', action: COMMANDS[match[2]], id: match[1].toLowerCase() } : { type: 'checkin-get', id: match[1].toLowerCase() };
}
export const stockCheckinMethods = route => route?.type === 'checkin-command' ? ['POST'] : route ? ['GET'] : null;
const params = (search, allowed) => { for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1 || search.get(key) === '') invalid(); };
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '') || !request.body) invalid();
  const length = request.headers.get('Content-Length'); if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65536)) invalid();
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0, body = '';
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) invalid(); body += decoder.decode(value, { stream: true }); }
    body += decoder.decode(); const result = JSON.parse(body); if (!object(result)) invalid(); return result; }
  catch { return invalid(); } finally { try { await reader.cancel(); } catch { /* Never log a request body. */ } reader.releaseLock(); }
}
const RPC = { save: 'erp_stock_checkin_save', issue: 'erp_stock_checkin_issue', batch: 'erp_stock_checkin_batch', restart: 'erp_stock_checkin_restart', finish: 'erp_stock_checkin_finish' };
export async function stockCheckinOperation(request, route, search) {
  if (route.type === 'checkin-notes') {
    params(search, ['q', 'offset']);
    const query = search.get('q'), offset = search.get('offset') ?? '0';
    need((query === null || (text(query, 60, 1) && /[0-9]/.test(query))) && /^(0|[1-9][0-9]{0,5})$/.test(offset) && Number(offset) <= 100000);
    if (query !== null) { const digits = query.replace(/[^0-9]/g, ''); need(digits.length === 44 || digits.length <= 9); }
    return { type: 'checkin-notes', rpc: 'erp_stock_checkin_notes', args: { p_query: query, p_offset: Number(offset), p_limit: 50 } };
  }
  if (route.type === 'checkin-get') { params(search, []); return { type: 'checkin-get', rpc: 'erp_stock_checkin_get', args: { p_invoice_id: route.id } }; }
  if (search.size) invalid();
  const input = await readBody(request), action = route.action;
  const keys = { save: ['items'], issue: ['position', 'kind', 'quantity', 'action'], batch: ['positions'], restart: [], finish: [] }[action];
  need(exact(input, ['command_id', 'expected_version', ...keys]) && uuid(input.command_id) && int(input.expected_version, ['restart', 'finish'].includes(action) ? 1 : 0, 2147483646));
  const args = { p_command_id: input.command_id.toLowerCase(), p_invoice_id: route.id, p_expected_version: input.expected_version };
  if (action === 'save') {
    need(Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 990
      && input.items.every(item => exact(item, ['position', 'received']) && int(item.position, 1, 990) && typeof item.received === 'string' && QUANTITY_INPUT.test(item.received))
      && new Set(input.items.map(item => item.position)).size === input.items.length);
    args.p_items = input.items.map(item => ({ position: item.position, received: item.received }));
  } else if (action === 'issue') {
    need(int(input.position, 1, 990) && KINDS.includes(input.kind) && input.action === 'none'
      && (input.kind === 'refused' ? input.quantity === null : typeof input.quantity === 'string' && QUANTITY_INPUT.test(input.quantity) && units(input.quantity) > 0n));
    Object.assign(args, { p_position: input.position, p_kind: input.kind, p_quantity: input.quantity, p_action: 'none' });
  } else if (action === 'batch') {
    need(Array.isArray(input.positions) && input.positions.length >= 1 && input.positions.length <= 990 && input.positions.every(item => int(item, 1, 990)) && new Set(input.positions).size === input.positions.length);
    args.p_positions = [...input.positions];
  }
  return { type: 'checkin-command', action, rpc: RPC[action], args };
}

function noteDto(value) {
  need(object(value) && uuid(value.invoice_id) && int(value.invoice_version, 1) && ['55', '65'].includes(value.model) && ['N', 'I', 'T', 'X'].includes(value.issue_type) && int(value.status, 1, 16)
    && int(value.series, 0, 999) && (value.number === null || int(value.number, 1, 999999999)) && (value.access_key === null || (typeof value.access_key === 'string' && /^[0-9]{44}$/.test(value.access_key)))
    && exact(value.supplier, ['name', 'document', 'person_type']) && optionalText(value.supplier.name, 60) && (value.supplier.document === null || (typeof value.supplier.document === 'string' && /^[0-9]{11}$|^[0-9]{14}$|^[A-Z0-9]{12}[0-9]{2}$/.test(value.supplier.document)))
    && (value.supplier.person_type === null || ['J', 'F', 'E'].includes(value.supplier.person_type)) && typeof value.issue_date === 'string' && DATE.test(value.issue_date) && instant(value.created_at)
    && int(value.items_count, 0, 990) && ['pending', 'in_progress', 'finished'].includes(value.checkin_state) && typeof value.open === 'boolean', upstream);
  return { invoice_id: value.invoice_id, invoice_version: value.invoice_version, model: value.model, issue_type: value.issue_type, status: value.status, series: value.series, number: value.number,
    access_key: value.access_key, supplier: { name: value.supplier.name, document: value.supplier.document, person_type: value.supplier.person_type }, issue_date: value.issue_date,
    created_at: value.created_at, items_count: value.items_count, checkin_state: value.checkin_state, open: value.open };
}
const expectedState = item => item.issue !== null ? 'issue' : units(item.received) === 0n ? 'pending' : units(item.received) < units(item.quantity) ? 'in_progress' : 'complete';
function itemDto(item) {
  need(object(item) && int(item.position, 1, 990) && (item.product_id === null || uuid(item.product_id)) && optionalText(item.product_code, 100) && optionalText(item.product_gtin, 20)
    && text(item.description, 120) && optionalText(item.supplier_code, 60) && optionalText(item.gtin, 20) && optionalText(item.unit, 6) && q4(item.quantity) && units(item.quantity) > 0n
    && typeof item.unit_price === 'string' && PRICE.test(item.unit_price) && q4(item.received) && (item.issue === null || KINDS.includes(item.issue))
    && (['missing', 'damaged', 'incorrect'].includes(item.issue) ? q4(item.issue_quantity) && units(item.issue_quantity) > 0n && units(item.issue_quantity) <= units(item.quantity) : item.issue_quantity === null)
    && (item.issue === null ? item.issue_action === null : item.issue_action === 'none') && STATES.includes(item.state) && item.state === expectedState(item)
    && (item.requested === null || (exact(item.requested, ['quantity', 'prices']) && item.product_id !== null && q4(item.requested.quantity) && Array.isArray(item.requested.prices)
      && item.requested.prices.length <= 250 && item.requested.prices.every(price => typeof price === 'string' && PRICE.test(price)))), upstream);
  // 181: Cod. fornecedor of the product at the supplier of the note and the DUN codes (box GTIN and units per box) of the product;
  // absent on a database still on 147.
  const catalogCode = item.catalog_supplier_code ?? null, duns = item.product_duns ?? [];
  need(optionalText(catalogCode, 60) && Array.isArray(duns) && duns.length <= 10 && (item.product_id !== null || (catalogCode === null && duns.length === 0))
    && duns.every(dun => exact(dun, ['code', 'quantity']) && typeof dun.code === 'string' && /^[0-9]{14}$/.test(dun.code) && typeof dun.quantity === 'string' && DUN_QUANTITY.test(dun.quantity) && !/^0\.0+$/.test(dun.quantity))
    && new Set(duns.map(dun => dun.code)).size === duns.length, upstream);
  return { position: item.position, product_id: item.product_id, product_code: item.product_code, product_gtin: item.product_gtin, description: item.description, supplier_code: item.supplier_code,
    gtin: item.gtin, unit: item.unit, quantity: item.quantity, unit_price: item.unit_price, received: item.received, issue: item.issue, issue_quantity: item.issue_quantity, issue_action: item.issue_action,
    state: item.state, requested: item.requested === null ? null : { quantity: item.requested.quantity, prices: [...item.requested.prices] },
    catalog_supplier_code: catalogCode, product_duns: duns.map(dun => ({ code: dun.code, quantity: dun.quantity })) };
}
// 259: also read by stock-invoices.mjs (Finalizar with "Lançar estoque ao finalizar Check-in").
export function checkinView(value, invoiceId) {
  need(object(value) && value.scope === 'stock_checkin' && value.data_mode === 'erp_native' && int(value.version) && Array.isArray(value.items) && value.items.length <= 990
    && Array.isArray(value.events) && value.events.length <= 500 && object(value.summary), upstream);
  const note = noteDto(value.note), items = value.items.map(itemDto);
  need(note.invoice_id === invoiceId && items.every((item, index) => index === 0 || items[index - 1].position < item.position), upstream);
  let checkin = null;
  if (value.checkin === null) need(value.version === 0 && note.checkin_state === 'pending' && items.every(item => item.state === 'pending' && item.issue === null), upstream);
  else {
    const c = value.checkin;
    need(exact(c, ['id', 'state', 'version', 'invoice_version', 'stale', 'started_at', 'updated_at', 'finished_at']) && uuid(c.id) && ['in_progress', 'finished'].includes(c.state)
      && c.version === value.version && int(c.version, 1) && int(c.invoice_version, 1) && typeof c.stale === 'boolean' && c.stale === (c.invoice_version !== note.invoice_version)
      && instant(c.started_at) && instant(c.updated_at) && (c.state === 'finished' ? instant(c.finished_at) : c.finished_at === null) && note.checkin_state === c.state, upstream);
    checkin = { id: c.id, state: c.state, version: c.version, invoice_version: c.invoice_version, stale: c.stale, started_at: c.started_at, updated_at: c.updated_at, finished_at: c.finished_at };
  }
  const s = value.summary, count = predicate => items.filter(predicate).length;
  need(exact(s, ['total', 'complete', 'issue', 'refused', 'pending']) && s.total === items.length && s.complete === count(item => item.state === 'complete')
    && s.issue === count(item => item.state === 'issue' && item.issue !== 'refused') && s.refused === count(item => item.issue === 'refused')
    && s.pending === count(item => ['pending', 'in_progress'].includes(item.state)), upstream);
  const events = value.events.map(event => {
    need(exact(event, ['id', 'action', 'position', 'description', 'quantity', 'previous', 'at']) && int(event.id, 1, Number.MAX_SAFE_INTEGER) && ACTIONS.includes(event.action)
      && (['restart', 'finish'].includes(event.action) ? event.position === null && event.description === null && event.quantity === null && event.previous === null
        : int(event.position, 1, 990) && text(event.description, 120) && (event.action === 'refused' ? event.quantity === null : q4(event.quantity))
          && (['received', 'batch'].includes(event.action) ? q4(event.previous) : event.previous === null)) && instant(event.at), upstream);
    return { id: event.id, action: event.action, position: event.position, description: event.description, quantity: event.quantity, previous: event.previous, at: event.at };
  });
  need(events.every((event, index) => index === 0 || events[index - 1].id < event.id) && (checkin !== null || events.length === 0), upstream);
  // 181: "Usuário responsável" (Sistema › Usuários): who started and who finished; absent on a database still on 147.
  const r = value.responsible ?? null;
  need(r === null || (checkin !== null && exact(r, ['started_by_name', 'finished_by_name']) && optionalText(r.started_by_name, 120) && optionalText(r.finished_by_name, 120)
    && (checkin.state === 'finished' || r.finished_by_name === null)), upstream);
  return { note, checkin, version: value.version, items, summary: { total: s.total, complete: s.complete, issue: s.issue, refused: s.refused, pending: s.pending }, events,
    responsible: r === null ? null : { started_by_name: r.started_by_name, finished_by_name: r.finished_by_name } };
}
function receiptDto(value, operation) {
  const r = value.receipt, args = operation.args;
  need(exact(r, ['command_id', 'action', 'invoice_id', 'from_version', 'to_version', 'detail', 'saved_at']) && r.command_id === args.p_command_id && r.action === operation.action
    && r.invoice_id === args.p_invoice_id && r.from_version === args.p_expected_version && r.to_version === args.p_expected_version + (operation.action === 'finish' ? 2 : 1)
    && object(r.detail) && instant(r.saved_at), upstream);
  return { command_id: r.command_id, action: r.action, invoice_id: r.invoice_id, from_version: r.from_version, to_version: r.to_version, detail: structuredClone(r.detail), saved_at: r.saved_at };
}
export function stockCheckinResponse(value, operation) {
  if (operation.type === 'checkin-notes') {
    need(object(value) && value.scope === 'stock_checkin_notes' && value.data_mode === 'erp_native' && value.query === operation.args.p_query && value.offset === operation.args.p_offset
      && value.limit === operation.args.p_limit && int(value.total) && Array.isArray(value.items) && value.items.length === Math.max(0, Math.min(value.limit, value.total - value.offset))
      && typeof value.can_manage === 'boolean', upstream);
    const items = value.items.map(noteDto);
    need(items.every(item => item.open) && new Set(items.map(item => item.invoice_id)).size === items.length
      && items.every((item, index) => index === 0 || Date.parse(items[index - 1].created_at) >= Date.parse(item.created_at)), upstream);
    return { items, total: value.total, offset: value.offset, limit: value.limit, query: value.query, can_manage: value.can_manage, scope: value.scope, data_mode: 'erp_native' };
  }
  if (operation.type === 'checkin-get') {
    need(object(value) && typeof value.can_manage === 'boolean', upstream);
    return { ...checkinView(value, operation.args.p_invoice_id), can_manage: value.can_manage, scope: 'stock_checkin', data_mode: 'erp_native' };
  }
  need(object(value) && typeof value.replayed === 'boolean', upstream);
  const receipt = receiptDto(value, operation), view = checkinView(value, operation.args.p_invoice_id);
  // A replay may return a later state; a new command returns exactly the version it produced.
  need(view.checkin !== null && (value.replayed ? view.version >= receipt.to_version : view.version === receipt.to_version)
    && (operation.action !== 'finish' || value.replayed || view.checkin.state === 'finished'), upstream);
  return { receipt, ...view, replayed: value.replayed, scope: 'stock_checkin', data_mode: 'erp_native' };
}
