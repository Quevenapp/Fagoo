// Observed commercial documents are validated independently of native calculations.
// Missing source values stay null, and no arbitrary staging payload reaches the client.
const KINDS = ['sales_orders', 'sales_proposals', 'purchase_orders', 'service_orders'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class DocumentMirrorError extends Error { constructor() { super('INVALID_DOCUMENT_MIRROR'); } }
const fail = () => { throw new DocumentMirrorError(); };
const need = condition => { if (!condition) fail(); };
const text = (value, max = 1000) => { need(value === null || typeof value === 'string' && [...value].length <= max); return value; };
const identity = value => { need(typeof value === 'string' && /^[1-9][0-9]{0,39}$/.test(value)); return value; };
const decimal = (value, signed = false) => { need(value === null || typeof value === 'string' && (signed ? /^-?(0|[1-9][0-9]{0,29})(\.[0-9]{1,30})?$/ : /^(0|[1-9][0-9]{0,29})(\.[0-9]{1,30})?$/).test(value)); return value; };
const uuid = value => { need(value === null || typeof value === 'string' && UUID.test(value)); return value; };
const timestamp = (value, nullable = true) => { need(nullable && value === null || typeof value === 'string' && value.length <= 100 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))); return value; };
const date = value => { need(value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value); return value; };

export function documentMirrorMeta(value, kind) {
  need(object(value) && KINDS.includes(kind) && value.entity === kind && typeof value.source_hash === 'string' && /^[0-9a-f]{64}$/.test(value.source_hash));
  need(Number.isSafeInteger(value.mapper_version) && value.mapper_version > 0 && ['synced', 'pending'].includes(value.state));
  need(typeof value.source_deleted === 'boolean' && typeof value.partial === 'boolean' && Array.isArray(value.issues) && value.issues.length <= 100);
  need(value.issues.every(issue => typeof issue === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(issue)) && new Set(value.issues).size === value.issues.length);
  const r = value.reconciliation, e = value.effects;
  need(object(r) && ['matches', 'differs', 'unknown'].includes(r.state) && object(e) && e.stock === 'unobservable');
  need(e.finance_count === null || Number.isSafeInteger(e.finance_count) && e.finance_count >= 0);
  return { entity: kind, source_id: identity(value.source_id), source_version: identity(value.source_version), source_hash: value.source_hash, mapper_version: value.mapper_version,
    source_number: text(value.source_number, 100), source_status: text(value.source_status, 100), source_status_label: text(value.source_status_label, 200),
    observed_at: timestamp(value.observed_at, false), source_updated_at: timestamp(value.source_updated_at), source_deleted: value.source_deleted,
    state: value.state, partial: value.partial, issues: [...value.issues],
    reconciliation: { source_total: decimal(r.source_total), source_products_total: decimal(r.source_products_total), calculated_total: decimal(r.calculated_total), difference: decimal(r.difference, true), state: r.state },
    effects: { stock: 'unobservable', finance_count: e.finance_count, invoice_source_id: e.invoice_source_id === null ? null : identity(e.invoice_source_id) } };
}

function base(value, kind) {
  need(object(value) && value.origin === 'origin' && value.authority === 'origin' && value.readonly === true && value.kind === kind);
  need(typeof value.id === 'string' && UUID.test(value.id) && Number.isSafeInteger(value.version) && value.version > 0);
  need(typeof value.status === 'string' && /^[a-z][a-z_]{0,49}$/.test(value.status));
  return { id: value.id, kind, version: value.version, number: text(value.number, 100), status: value.status,
    origin: 'origin', authority: 'origin', readonly: true, mirror: documentMirrorMeta(value.mirror, kind),
    created_at: timestamp(value.created_at, false), updated_at: timestamp(value.updated_at, false), date: date(value.date),
    total: decimal(value.total), contact_id: uuid(value.contact_id) };
}

export function documentMirrorSummary(value, kind) {
  const result = { ...base(value, kind), contact_name: text(value.contact_name, 200) };
  // Fields shared with native list rendering; effects describe only native postings.
  for (const key of ['expected_date', 'next_contact', 'ship_date']) if (Object.hasOwn(value, key)) result[key] = date(value[key]);
  for (const key of ['warehouse_id', 'seller_id', 'source_proposal_id']) if (Object.hasOwn(value, key)) result[key] = uuid(value[key]);
  for (const key of ['warehouse_name', 'seller_name', 'source_proposal_number', 'internal_notes', 'customer_po_number', 'contact_email', 'contact_phone', 'contact_document', 'address', 'carrier_name', 'template_name', 'service_order_number', 'version_label'])
    if (Object.hasOwn(value, key)) result[key] = text(value[key], 1000);
  for (const key of ['template', 'finance_active', 'stock_active', 'receipt_active', 'first_sale', 'pendencies', 'invoice_linked']) {
    if (Object.hasOwn(value, key)) { need(value[key] === false); result[key] = false; }
  }
  for (const key of ['reservation_active', 'fiscal_draft']) if (Object.hasOwn(value, key)) { need(value[key] === false || value[key] === null); result[key] = value[key]; }
  for (const key of ['invoice', 'situation']) if (Object.hasOwn(value, key)) { need(value[key] === null); result[key] = null; }
  return result;
}

function item(value) {
  need(object(value) && typeof value.id === 'string' && UUID.test(value.id) && Number.isSafeInteger(value.position) && value.position >= 1 && value.position <= 10000);
  const result = { id: value.id, position: value.position, source_id: value.source_id === null ? null : identity(value.source_id), product_id: uuid(value.product_id),
    description: text(value.description, 10000), code: text(value.code, 200), unit: text(value.unit, 100),
    quantity: decimal(value.quantity), unit_price: decimal(value.unit_price), discount_percent: decimal(value.discount_percent), total: decimal(value.total) };
  if (Object.hasOwn(value, 'group')) { need(value.group === null || ['part', 'service'].includes(value.group)); result.group = value.group; }
  if (Object.hasOwn(value, 'hours')) result.hours = decimal(value.hours);
  if (Object.hasOwn(value, 'source_path')) { need(value.source_path === null || typeof value.source_path === 'string' && /^\/(itens|pecas|servicos)\/[0-9]{1,5}$/.test(value.source_path)); result.source_path = value.source_path; }
  return result;
}

export function documentMirrorRecord(value, kind) {
  const result = base(value, kind);
  need(Array.isArray(value.items) && value.items.length <= 10000);
  result.items = value.items.map(item);
  need(new Set(result.items.map(row => row.id)).size === result.items.length && result.items.every((row, i) => i === 0 || row.position > result.items[i - 1].position));
  need(value.contact_snapshot === null || object(value.contact_snapshot));
  result.contact_snapshot = value.contact_snapshot === null ? null : Object.fromEntries(['name', 'document', 'email', 'phone', 'mobile', 'street', 'number', 'complement', 'district', 'city', 'state', 'postal_code'].map(key => [key, text(value.contact_snapshot[key] ?? null, key === 'name' ? 200 : 1000)]));
  for (const key of ['expected_date', 'next_contact', 'ship_date']) if (Object.hasOwn(value, key)) result[key] = date(value[key]);
  for (const key of ['notes', 'internal_notes', 'equipment', 'serial_number', 'technician', 'defect', 'solution', 'payment_terms', 'delivery_terms'])
    if (Object.hasOwn(value, key)) result[key] = text(value[key], 20000);
  return result;
}

export function documentOriginTotals(value) {
  need(object(value));
  return Object.fromEntries(['brufap', 'origin'].map(origin => {
    const row = value[origin];
    need(object(row) && Number.isSafeInteger(row.count) && row.count >= 0 && Number.isSafeInteger(row.known_total_count) && row.known_total_count >= 0 && row.known_total_count <= row.count);
    const total = decimal(row.total);
    need(row.known_total_count === row.count || total === null);
    return [origin, { count: row.count, known_total_count: row.known_total_count, total }];
  }));
}

/** Operational reports explicitly disclose the observed documents excluded from native calculations. */
export function documentNativeCoverage(value) {
  if (!object(value) || !['origin', 'mirror_excluded_count', 'coverage'].some(key => Object.hasOwn(value, key))) return {};
  need(value.origin === 'brufap' && Number.isSafeInteger(value.mirror_excluded_count) && value.mirror_excluded_count >= 0);
  need(object(value.coverage) && value.coverage.reason === 'native_effects_only' && value.coverage.partial === (value.mirror_excluded_count > 0));
  return { origin: 'brufap', mirror_excluded_count: value.mirror_excluded_count, coverage: { partial: value.coverage.partial, reason: 'native_effects_only' } };
}
