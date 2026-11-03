/**
 * Request normalization and response validation for /v1/notas-fiscais (migrations 202610200111-114).
 * Inputs are normalized exactly like the SQL functions (structure only: catalog/nature lookups stay in the
 * database). Responses are accepted only if every field round-trips through the same descriptors.
 * All money/rate/quantity arithmetic uses BigInt over canonical decimal strings.
 */
import {
  ADDITION_SPEC, AUTHORIZED_SPEC, CARD_SPEC, CARRIER_SPEC, CSOSN, CST_ICMS, DEFAULT_CODES, DELIVERY_SPEC, EXPORT_SPEC, FiscalSpecError, IMPORT_SPEC, INSTALLMENT_SPEC,
  INTERMEDIARY_SPEC, INVOICE_STATUS, ITEM_GROUPS, ITEM_SPEC, MONOPHASE, NATURE_OTHERS, NATURE_RETENTIONS, RECIPIENT_SPEC, REFERENCE_SPEC, TAX_SETTINGS_SPEC, TRANSPORT_SPEC,
  UFS, VEHICLE_SPEC, VOLUMES_SPEC, DIFAL_STATE_MODES, checkValue, ruleSpecFor, specObject, centsOf, moneyOf,
} from './fiscal-invoice-dto.mjs';

const fail = (code = 'FISCAL_VALUE_INVALID', field = null) => { throw new FiscalSpecError(code, field); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (value, key) => value !== null && value !== undefined && Object.hasOwn(value, key) && value[key] !== null && value[key] !== undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY = /^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/;
// jsonb reorders object keys, so records are compared with sorted keys.
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const equal = (a, b) => canonical(a) === canonical(b);
const only = (value, keys, field) => { if (!plain(value)) fail('FISCAL_VALUE_INVALID', field); for (const key of Object.keys(value)) if (!keys.includes(key)) fail('FISCAL_UNKNOWN_FIELD', field ? `${field}.${key}` : key); };
const array = (value, max, field) => { if (value === null || value === undefined) return []; if (!Array.isArray(value) || value.length > max) fail('FISCAL_VALUE_INVALID', field); return Array.from(value); };
const bool = (value, fallback, field) => { if (value === null || value === undefined) return fallback; if (typeof value !== 'boolean') fail('FISCAL_VALUE_INVALID', field); return value; };
const text = (value, max, required = false, multiline = false, field = null) => { const v = checkValue(value, `${multiline ? 'm' : 't'}:${max}`, field); if (required && v === null) fail('FISCAL_VALUE_REQUIRED', field); return v; };
const isNull = value => value === null || value === undefined;

/** Mod-11 check digit of an NF-e/NFC-e/CT-e access key. */
export function accessKeyValid(key) {
  if (typeof key !== 'string' || !/^\d{44}$/.test(key)) return false;
  let sum = 0, weight = 2;
  for (let i = 42; i >= 0; i--) { sum += Number(key[i]) * weight; weight = weight === 9 ? 2 : weight + 1; }
  const dv = 11 - (sum % 11);
  return (dv >= 10 ? 0 : dv) === Number(key[43]);
}
const ipiAllowed = (direction, situation) => situation === undefined || situation === null || (direction === '0' ? ['00', '01', '02', '03', '04', '05', '49'] : ['50', '51', '52', '53', '54', '55', '99']).includes(situation);

// ---------------- Natures ----------------
export function normalizeRuleInput(rule, crt, direction) {
  only(rule, ['tax', 'destinations', 'product_scope', 'ncms', 'product_ids', 'group_ids', 'data', 'additional_info', 'fiscal_info'], 'rule');
  if (!['icms', 'ipi', 'pis', 'cofins', 'ii'].includes(rule.tax)) fail('FISCAL_RULE_INVALID', 'tax');
  const data = specObject(rule.data, ruleSpecFor(rule.tax, crt), 'data');
  if (!has(data, 'situation')) fail('FISCAL_RULE_SITUATION_REQUIRED', 'situation');
  if (rule.tax === 'ipi' && !ipiAllowed(direction, data.situation)) fail('FISCAL_RULE_SITUATION_INVALID', 'situation');
  const destinations = array(rule.destinations, 28, 'destinations');
  if (destinations.some(d => typeof d !== 'string' || ![...UFS, 'EX'].includes(d)) || new Set(destinations).size !== destinations.length) fail('FISCAL_RULE_DESTINATION_INVALID', 'destinations');
  const scope = rule.product_scope ?? 'any';
  // 202610200216: "Grupo de Produtos" (groups of the product cadastro, up to 10 per rule).
  if (!['any', 'ncm', 'products', 'groups'].includes(scope)) fail('FISCAL_RULE_INVALID', 'product_scope');
  const ncms = array(rule.ncms, 10, 'ncms'), products = array(rule.product_ids, 10, 'product_ids'), groupList = array(rule.group_ids, 10, 'group_ids');
  if (ncms.some(n => typeof n !== 'string' || !/^[0-9]{2}([0-9]{2}){0,3}$/.test(n)) || new Set(ncms).size !== ncms.length) fail('FISCAL_RULE_PRODUCT_INVALID', 'ncms');
  const ids = products.map(p => checkValue(p, 'u', 'product_ids'));
  if (ids.some(id => id === null) || new Set(ids).size !== ids.length) fail('FISCAL_RULE_PRODUCT_INVALID', 'product_ids');
  const groups = groupList.map(g => checkValue(g, 'u', 'group_ids'));
  if (groups.some(g => g === null) || new Set(groups).size !== groups.length) fail('FISCAL_RULE_GROUP_INVALID', 'group_ids');
  if ((scope === 'any' && (ncms.length || ids.length || groups.length)) || (scope === 'ncm' && (!ncms.length || ids.length || groups.length)) || (scope === 'products' && (!ids.length || ncms.length || groups.length))
    || (scope === 'groups' && (!groups.length || ncms.length || ids.length))) fail(scope === 'groups' ? 'FISCAL_RULE_GROUP_INVALID' : 'FISCAL_RULE_PRODUCT_INVALID', 'product_scope');
  return { tax: rule.tax, destinations: [...destinations].sort(), product_scope: scope, ncms: [...ncms].sort(), product_ids: [...ids].sort(), data,
    additional_info: text(rule.additional_info, 2000, false, true, 'additional_info'), fiscal_info: text(rule.fiscal_info, 2000, false, true, 'fiscal_info'),
    ...(scope === 'groups' ? { group_ids: [...groups].sort() } : {}) };
}
const NATURE_KEYS = ['description', 'series', 'direction', 'crt', 'presence', 'invoiced', 'final_consumer', 'return_operation', 'update_last_purchase_price', 'include_freight_ipi_base', 'others', 'retentions', 'additional_info', 'fiscal_info', 'rules'];
export function normalizeNatureInput(value) {
  only(value, NATURE_KEYS, 'nature');
  if (!['0', '1'].includes(value.direction) || !['1', '2', '3', '4'].includes(value.crt)) fail('FISCAL_NATURE_INVALID', 'direction');
  const presence = value.presence ?? '9';
  if (!['0', '1', '2', '3', '4', '5', '9'].includes(presence)) fail('FISCAL_NATURE_INVALID', 'presence');
  if (!isNull(value.series) && (typeof value.series !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value.series))) fail('FISCAL_NATURE_INVALID', 'series');
  const rules = array(value.rules, 250, 'rules').map(rule => normalizeRuleInput(rule, value.crt, value.direction));
  for (const tax of ['icms', 'ipi', 'pis', 'cofins', 'ii']) if (rules.filter(r => r.tax === tax).length > 50) fail('FISCAL_NATURE_INVALID', 'rules');
  const update = bool(value.update_last_purchase_price, false, 'update_last_purchase_price');
  if (value.direction === '1' && update) fail('FISCAL_NATURE_INVALID', 'update_last_purchase_price');
  return { description: text(value.description, 60, true, false, 'description'), series: isNull(value.series) ? null : value.series, direction: value.direction, crt: value.crt, presence,
    invoiced: bool(value.invoiced, true, 'invoiced'), final_consumer: bool(value.final_consumer, false, 'final_consumer'), return_operation: bool(value.return_operation, false, 'return_operation'),
    update_last_purchase_price: update, include_freight_ipi_base: bool(value.include_freight_ipi_base, false, 'include_freight_ipi_base'),
    others: specObject(value.others, NATURE_OTHERS, 'others'), retentions: specObject(value.retentions, NATURE_RETENTIONS, 'retentions'),
    additional_info: text(value.additional_info, 5000, false, true, 'additional_info'), fiscal_info: text(value.fiscal_info, 2000, false, true, 'fiscal_info'), rules };
}
const timestamp = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const version = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const codes = value => Array.isArray(value) && value.every(c => Object.hasOwn(DEFAULT_CODES, c)) && new Set(value).size === value.length;
/** Validates a nature record from the database; throws FiscalSpecError on any divergence. */
export function natureRecord(value) {
  if (!plain(value) || !UUID.test(value.id ?? '') || !version(value.version) || typeof value.active !== 'boolean' || !timestamp(value.created_at) || !timestamp(value.updated_at) || !codes(value.defaults)) fail('FISCAL_RESPONSE_INVALID');
  if (!Array.isArray(value.rules)) fail('FISCAL_RESPONSE_INVALID');
  const input = { ...Object.fromEntries(NATURE_KEYS.filter(k => k !== 'rules').map(k => [k, value[k]])), series: value.series === null ? null : String(value.series), rules: [] };
  if (value.series !== null && (!Number.isInteger(value.series) || value.series < 0 || value.series > 999)) fail('FISCAL_RESPONSE_INVALID');
  const header = normalizeNatureInput(input);
  if (!equal({ ...header, series: value.series }, { ...Object.fromEntries(Object.keys(header).map(k => [k, k === 'rules' ? [] : value[k]])) })) fail('FISCAL_RESPONSE_INVALID');
  const positions = {};
  const rules = value.rules.map(rule => {
    if (!plain(rule) || !Number.isInteger(rule.position) || !Array.isArray(rule.products)) fail('FISCAL_RESPONSE_INVALID');
    positions[rule.tax] = (positions[rule.tax] ?? 0) + 1;
    if (rule.position !== positions[rule.tax]) fail('FISCAL_RESPONSE_INVALID');
    // A "Grupo de Produtos" rule (202610200216) carries its group ids and names; the other rules never do.
    if ((rule.product_scope === 'groups') !== Object.hasOwn(rule, 'groups')) fail('FISCAL_RESPONSE_INVALID');
    const { position, products, groups, ...rest } = rule;
    const normalized = normalizeRuleInput(rest, value.crt, value.direction);
    if (!equal(normalized, rest)) fail('FISCAL_RESPONSE_INVALID');
    if (products.length !== normalized.product_ids.length || products.some(p => !plain(p) || !normalized.product_ids.includes(p.id) || typeof p.name !== 'string' || p.name.length > 200 || !(p.code === null || (typeof p.code === 'string' && p.code.length <= 100)))) fail('FISCAL_RESPONSE_INVALID');
    if (groups !== undefined && (!Array.isArray(groups) || groups.length > normalized.group_ids.length || groups.some(g => !plain(g) || !normalized.group_ids.includes(g.id) || typeof g.name !== 'string' || !g.name || g.name.length > 100))) fail('FISCAL_RESPONSE_INVALID');
    return { ...normalized, position, products: products.map(p => ({ id: p.id, name: p.name, code: p.code })), ...(groups !== undefined ? { groups: groups.map(g => ({ id: g.id, name: g.name })) } : {}) };
  });
  return { ...header, series: value.series, id: value.id, active: value.active, version: value.version, created_at: value.created_at, updated_at: value.updated_at, defaults: [...value.defaults], rules };
}
export function natureSummary(value) {
  if (!plain(value) || !UUID.test(value.id ?? '') || typeof value.description !== 'string' || !value.description || [...value.description].length > 60 || !['0', '1'].includes(value.direction)
    || !['1', '2', '3', '4'].includes(value.crt) || !['0', '1', '2', '3', '4', '5', '9'].includes(value.presence) || ['invoiced', 'final_consumer', 'return_operation', 'active'].some(k => typeof value[k] !== 'boolean')
    || !version(value.version) || !codes(value.defaults) || !Number.isInteger(value.rule_count) || value.rule_count < 0 || !(value.series === null || (Number.isInteger(value.series) && value.series >= 0 && value.series <= 999))) fail('FISCAL_RESPONSE_INVALID');
  return { id: value.id, description: value.description, series: value.series, direction: value.direction, crt: value.crt, presence: value.presence, invoiced: value.invoiced,
    final_consumer: value.final_consumer, return_operation: value.return_operation, active: value.active, version: value.version, defaults: [...value.defaults], rule_count: value.rule_count };
}
export function normalizeTaxSettings(settings, states) {
  const s = { exclude_icms_pis_cofins: false, exclude_icms_st_pis_cofins: false, st_contributor_differentiated: false, st_retained_from_sale: false, difal_default: 'inside', ipi_in_icms_import: false, ...specObject(settings, TAX_SETTINGS_SPEC, 'settings') };
  if (!plain(states)) fail('FISCAL_VALUE_INVALID', 'difal_by_state');
  const byState = {};
  for (const [uf, mode] of Object.entries(states)) {
    if (!UFS.includes(uf) || typeof mode !== 'string' || !Object.hasOwn(DIFAL_STATE_MODES, mode) || !DIFAL_STATE_MODES[mode].includes(uf)) fail('FISCAL_VALUE_INVALID', `difal_by_state.${uf}`);
    if (mode !== 'default') byState[uf] = mode;
  }
  return { settings: s, difal_by_state: byState };
}

// ---------------- Invoices ----------------
const INVOICE_KEYS = ['model', 'direction', 'issue_type', 'series', 'number', 'access_key', 'nature_id', 'nature_description', 'cfop', 'issue_date', 'exit_date', 'exit_time', 'crt', 'purpose',
  'credit_debit_type', 'presence', 'final_consumer', 'recipient', 'export', 'import_declaration', 'references', 'items', 'auto_tax', 'freight', 'insurance', 'other_expenses', 'discount',
  'transport', 'payment', 'authorized_xml', 'intermediary', 'additional_info', 'nature_additional_info', 'nature_fiscal_info', 'seller_id', 'operation_destination'];
// 202610200215: "Vendedor" and "Destino da Operação" are optional, so a database or a form before that migration keeps round-tripping.
const OPTIONAL_INVOICE_KEYS = ['seller_id', 'operation_destination'];
const GROUP_KEYS = Object.keys(ITEM_GROUPS);
export function normalizeItemInput(item, crt, direction) {
  if (!plain(item)) fail('FISCAL_VALUE_INVALID', 'item');
  const top = {}, groups = {};
  for (const [key, value] of Object.entries(item)) (GROUP_KEYS.includes(key) ? groups : top)[key] = value;
  const result = specObject(top, ITEM_SPEC, 'item');
  if (!has(result, 'description') || !has(result, 'quantity') || !has(result, 'unit_price') || /^0\.0+$/.test(result.quantity)) fail('FISCAL_ITEM_INVALID', 'item');
  for (const key of GROUP_KEYS) { const group = specObject(groups[key], ITEM_GROUPS[key], key); if (Object.keys(group).length) result[key] = group; }
  const situation = result.icms?.situation;
  if (situation && (crt === '3' ? !CST_ICMS.includes(situation) : ![...CSOSN, ...MONOPHASE].includes(situation))) fail('FISCAL_ITEM_SITUATION_INVALID', 'icms.situation');
  if (!ipiAllowed(direction, result.ipi?.situation)) fail('FISCAL_ITEM_SITUATION_INVALID', 'ipi.situation');
  return result;
}
function normalizeReferences(value) {
  const keys = new Set();
  return array(value, 100, 'references').map(entry => {
    const ref = specObject(entry, REFERENCE_SPEC, 'reference');
    if (!has(ref, 'type')) fail('FISCAL_REFERENCE_INVALID', 'reference.type');
    if (['nfe', 'cte'].includes(ref.type)) {
      if (!has(ref, 'key') || has(ref, 'year_month') || has(ref, 'number') || has(ref, 'series') || !accessKeyValid(ref.key)
        || (ref.type === 'cte' ? ref.key.slice(20, 22) !== '57' : !['55', '65'].includes(ref.key.slice(20, 22)))) fail('FISCAL_REFERENCE_KEY_INVALID', 'reference.key');
      if (keys.has(ref.key)) fail('FISCAL_REFERENCE_DUPLICATE', 'reference.key');
      keys.add(ref.key);
    } else if (ref.type === 'ecf') { if (!has(ref, 'number') || has(ref, 'key') || has(ref, 'year_month')) fail('FISCAL_REFERENCE_INVALID', 'reference'); }
    else if (!has(ref, 'year_month') || !has(ref, 'number') || !has(ref, 'series') || has(ref, 'key')) fail('FISCAL_REFERENCE_INVALID', 'reference');
    return ref;
  });
}
function normalizeTransport(value) {
  const input = value ?? {};
  only(input, ['mode', 'freight_by', 'tracking_code', 'carrier', 'vehicle', 'volumes', 'delivery'], 'transport');
  const { carrier, vehicle, volumes, delivery, ...base } = input;
  const result = { mode: 'none', ...specObject(base, TRANSPORT_SPEC, 'transport') };
  const c = specObject(carrier, CARRIER_SPEC, 'carrier'), v = specObject(vehicle, VEHICLE_SPEC, 'vehicle');
  if (result.mode === 'none') { if (Object.keys(c).length || Object.keys(v).length) fail('FISCAL_TRANSPORT_INVALID', 'transport'); if (!has(result, 'freight_by')) result.freight_by = '9'; }
  if (!has(result, 'freight_by')) result.freight_by = '0';
  return { ...result, carrier: c, vehicle: v, volumes: specObject(volumes, VOLUMES_SPEC, 'volumes'), delivery: isNull(delivery) ? null : specObject(delivery, DELIVERY_SPEC, 'delivery') };
}
function normalizePayment(value) {
  const input = value ?? {};
  only(input, ['condition', 'installments', 'indicator'], 'payment');
  // 202610200254: Forma de pagamento of the pedido de venda (indPag: 0 à vista, 1 a prazo), only when informed.
  if (!isNull(input.indicator) && !['0', '1'].includes(input.indicator)) fail('FISCAL_VALUE_INVALID', 'payment.indicator');
  return { condition: text(input.condition, 60, false, false, 'payment.condition'), ...(isNull(input.indicator) ? {} : { indicator: input.indicator }), installments: array(input.installments, 120, 'installments').map(entry => {
    if (!plain(entry)) fail('FISCAL_VALUE_INVALID', 'installment');
    const { card, ...rest } = entry;
    const installment = specObject(rest, INSTALLMENT_SPEC, 'installment');
    if (!has(installment, 'date') || !has(installment, 'amount')) fail('FISCAL_INSTALLMENT_INVALID', 'installment');
    return { ...installment, card: isNull(card) ? null : specObject(card, CARD_SPEC, 'card') };
  }) };
}
function normalizeRecipient(value, model) {
  const r = specObject(value, RECIPIENT_SPEC, 'recipient');
  if (model === '55' && (!has(r, 'name') || !has(r, 'person_type'))) fail('FISCAL_RECIPIENT_REQUIRED', 'recipient');
  if ((r.person_type === 'J' && has(r, 'document') && r.document.length !== 14) || (r.person_type === 'F' && has(r, 'document') && r.document.length !== 11)
    || (r.person_type === 'E' && has(r, 'document')) || (r.person_type !== 'E' && has(r, 'foreign_id'))) fail('FISCAL_RECIPIENT_DOCUMENT_INVALID', 'recipient.document');
  return r;
}
function normalizeImport(value) {
  if (isNull(value)) return null;
  if (!plain(value)) fail('FISCAL_VALUE_INVALID', 'import_declaration');
  const { additions, ...rest } = value;
  return { ...specObject(rest, IMPORT_SPEC, 'import_declaration'), additions: array(additions, 100, 'additions').map(a => specObject(a, ADDITION_SPEC, 'addition')) };
}
/** Normalizes a create/update invoice body exactly like erp_fiscal_invoices.invoice_input (without database lookups). */
export function normalizeInvoiceInput(value) {
  only(value, INVOICE_KEYS, 'invoice');
  const { model, direction, issue_type: issue } = value;
  if (!['55', '65'].includes(model) || !['0', '1'].includes(direction) || !(direction === '0' ? ['N', 'I', 'T', 'X'] : ['N', 'D', 'E', 'T', 'S', 'C']).includes(issue) || (model === '65') !== (issue === 'C')) fail('FISCAL_INVOICE_TYPE_INVALID', 'issue_type');
  if (['S', 'X'].includes(issue)) fail('FISCAL_INVOICE_ISSUE_TYPE_UNAVAILABLE', 'issue_type');
  if (typeof value.series !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(value.series)) fail('FISCAL_INVOICE_SERIES_INVALID', 'series');
  let number = null, key = null;
  if (issue === 'T') {
    if (typeof value.number !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.number)) fail('FISCAL_INVOICE_NUMBER_INVALID', 'number');
    number = value.number; key = checkValue(value.access_key, 'x:^[0-9]{44}$', 'access_key');
    if (key !== null && (!accessKeyValid(key) || key.slice(20, 22) !== model || Number(key.slice(22, 25)) !== Number(value.series) || Number(key.slice(25, 34)) !== Number(number))) fail('FISCAL_INVOICE_ACCESS_KEY_INVALID', 'access_key');
  } else if (!isNull(value.number) || !isNull(value.access_key)) fail('FISCAL_INVOICE_NUMBER_RESERVED_ON_SEND', 'number');
  const natureId = checkValue(value.nature_id, 'u', 'nature_id'), natureDescription = text(value.nature_description, 60, false, false, 'nature_description');
  if (natureId === null && natureDescription === null) fail('FISCAL_INVOICE_NATURE_REQUIRED', 'nature_id');
  if (!['1', '2', '3', '4'].includes(value.crt) || !['1', '2', '3', '4', '5', '6'].includes(value.purpose) || !['0', '1', '2', '3', '4', '5', '9'].includes(value.presence)) fail('FISCAL_INVOICE_HEADER_INVALID', 'header');
  const finalConsumer = bool(value.final_consumer, model === '65', 'final_consumer');
  if (model === '65' && (!['1', '4'].includes(value.presence) || !finalConsumer || direction !== '1' || value.purpose !== '1')) fail('FISCAL_INVOICE_NFCE_INVALID', 'model');
  if (!['5', '6'].includes(value.purpose) && !isNull(value.credit_debit_type)) fail('FISCAL_INVOICE_HEADER_INVALID', 'credit_debit_type');
  if (issue !== 'E' && !isNull(value.export)) fail('FISCAL_INVOICE_EXPORT_INVALID', 'export');
  if (issue !== 'I' && !isNull(value.import_declaration)) fail('FISCAL_INVOICE_IMPORT_INVALID', 'import_declaration');
  const items = array(value.items, 990, 'items');
  if (!items.length) fail('FISCAL_INVOICE_ITEMS_REQUIRED', 'items');
  const issueDate = checkValue(value.issue_date, 'a', 'issue_date');
  if (issueDate === null) fail('FISCAL_INVOICE_ISSUE_DATE_REQUIRED', 'issue_date');
  const intermediary = specObject(value.intermediary, INTERMEDIARY_SPEC, 'intermediary');
  if (intermediary.present && (!has(intermediary, 'cnpj') || !has(intermediary, 'identification'))) fail('FISCAL_INVOICE_INTERMEDIARY_INVALID', 'intermediary');
  const authorized = array(value.authorized_xml, 10, 'authorized_xml').map(a => specObject(a, AUTHORIZED_SPEC, 'authorized_xml'));
  if (authorized.some(a => !has(a, 'document')) || new Set(authorized.map(a => a.document)).size !== authorized.length) fail('FISCAL_INVOICE_AUTHORIZED_INVALID', 'authorized_xml');
  const result = { model, direction, issue_type: issue, series: value.series, number, access_key: key, nature_id: natureId, nature_description: natureDescription,
    cfop: checkValue(value.cfop, 'x:^[1-7][0-9]{3}$', 'cfop'), issue_date: issueDate, exit_date: checkValue(value.exit_date, 'a', 'exit_date'),
    exit_time: checkValue(value.exit_time, 'x:^([01][0-9]|2[0-3]):[0-5][0-9]$', 'exit_time'), crt: value.crt, purpose: value.purpose,
    credit_debit_type: checkValue(value.credit_debit_type, 'x:^[0-9]{2}$', 'credit_debit_type'), presence: value.presence, final_consumer: finalConsumer,
    recipient: normalizeRecipient(value.recipient, model), export: issue === 'E' ? specObject(value.export, EXPORT_SPEC, 'export') : null,
    import_declaration: issue === 'I' ? normalizeImport(value.import_declaration) : null, references: normalizeReferences(value.references),
    items: items.map(item => normalizeItemInput(item, value.crt, direction)), auto_tax: bool(value.auto_tax, true, 'auto_tax'),
    freight: checkValue(value.freight ?? '0', 'd:2:13', 'freight'), insurance: checkValue(value.insurance ?? '0', 'd:2:13', 'insurance'),
    other_expenses: checkValue(value.other_expenses ?? '0', 'd:2:13', 'other_expenses'), discount: checkValue(value.discount ?? '0', 'd:2:13', 'discount'),
    transport: normalizeTransport(value.transport), payment: normalizePayment(value.payment), authorized_xml: authorized, intermediary,
    additional_info: text(value.additional_info, 5000, false, true, 'additional_info'), nature_additional_info: text(value.nature_additional_info, 5000, false, true, 'nature_additional_info'),
    nature_fiscal_info: text(value.nature_fiscal_info, 2000, false, true, 'nature_fiscal_info') };
  if (Object.hasOwn(value, 'seller_id')) result.seller_id = checkValue(value.seller_id, 'u', 'seller_id');
  if (Object.hasOwn(value, 'operation_destination')) {
    const destination = isNull(value.operation_destination) ? null : value.operation_destination;
    const foreign = result.recipient.person_type === 'E' || result.recipient.state === 'EX';
    // idDest: 3 (exterior) only and always for a foreign recipient; the NFC-e is always 1 (interna), like erp_fiscal_invoices.invoice_input.
    if (destination !== null && (!['1', '2', '3'].includes(destination) || (destination === '3') !== foreign || (model === '65' && destination !== '1'))) fail('FISCAL_INVOICE_DESTINATION_INVALID', 'operation_destination');
    result.operation_destination = destination;
  }
  invoiceTotals(result);
  return result;
}

/**
 * "Importar XML NF-e" (143) and, from wave F (202610200274), the NFC-e: the candidate read from an authorized XML, with issue type T for
 * the check. An NFC-e (model 65) is checked like an own NFC-e (C: final consumer, presence, recipient optional) and keeps the number and
 * the access key of the XML, which must agree with each other, exactly like erp_fiscal_invoice_import.
 */
export function normalizeImportedInput(value) {
  if (!plain(value) || value.model !== '65') return normalizeInvoiceInput(value);
  if (value.issue_type !== 'T') fail('FISCAL_INVOICE_TYPE_INVALID', 'issue_type');
  const key = checkValue(value.access_key, 'x:^[0-9]{44}$', 'access_key');
  if (typeof value.number !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value.number) || key === null || !accessKeyValid(key) || key.slice(20, 22) !== '65'
    || typeof value.series !== 'string' || Number(key.slice(22, 25)) !== Number(value.series) || Number(key.slice(25, 34)) !== Number(value.number)) fail('FISCAL_INVOICE_ACCESS_KEY_INVALID', 'access_key');
  const normalized = normalizeInvoiceInput({ ...value, issue_type: 'C', number: null, access_key: null });
  return { ...normalized, issue_type: 'T', number: value.number, access_key: key };
}

// ---- Exact totals, identical to erp_fiscal_invoices.invoice_input ----
const scaled = (value, scale) => { const [whole, fraction = ''] = String(value).split('.'); return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale)); };
/** round(quantity × unit price, 2) half away from zero, like PostgreSQL numeric round. */
export function lineTotalCents(quantity, unitPrice) { const product = scaled(quantity, 4) * scaled(unitPrice, 10); return (product + 5n * 10n ** 11n) / 10n ** 12n; }
/** Truncated proportional shares; the last weighted line takes the remainder (erp_fiscal_invoices.allocate). */
export function allocateCents(amount, weights) {
  const result = weights.map(() => 0n);
  if (amount === 0n || !weights.length) return result;
  const total = weights.reduce((sum, w) => sum + w, 0n);
  let last = -1; weights.forEach((w, i) => { if (w > 0n) last = i; }); if (last < 0) last = weights.length - 1;
  let given = 0n;
  weights.forEach((w, i) => { if (i !== last && total > 0n) { const share = amount * w / total; result[i] = share; given += share; } });
  result[last] = amount - given;
  return result;
}
/**
 * Discount of each item: its own discount when any item carries one ("Informar desconto individualmente nos itens", 176; the note
 * discount must then be their sum), otherwise the note discount spread by value like erp_fiscal_invoices.allocate.
 */
export function discountShares(invoice, weights) {
  const discount = centsOf(invoice.discount);
  if (!invoice.items.some(item => item.discount !== null && item.discount !== undefined)) return allocateCents(discount, weights);
  const shares = invoice.items.map(item => item.discount ? centsOf(item.discount) : 0n);
  if (shares.reduce((sum, value) => sum + value, 0n) !== discount) fail('FISCAL_INVOICE_DISCOUNT_MISMATCH', 'discount');
  return shares;
}
const SUM_FIELDS = { icms_base: ['icms', 'base'], icms: ['icms', 'value'], st_base: ['icms', 'st_base'], st: ['icms', 'st_value'], fcp: ['icms', 'fcp_value'], fcp_st: ['icms', 'st_fcp_value'],
  deson: ['icms', 'deson_value'], credit: ['icms', 'credit_value'], difal_dest: ['icms', 'difal_dest_value'], difal_origin: ['icms', 'difal_origin_value'], difal_fcp: ['icms', 'difal_fcp_value'],
  ipi: ['ipi', 'value'], ipi_devol: ['ipi', 'devol_value'], ii: ['ii', 'value'], pis: ['pis', 'value'], cofins: ['cofins', 'value'], approx_taxes: ['others', 'approx_taxes'],
  ret_ir: ['retentions', 'ir_value'], ret_csll: ['retentions', 'csll_value'], ret_pis: ['retentions', 'pis_value'], ret_cofins: ['retentions', 'cofins_value'], ret_base: ['retentions', 'ir_csll_base'] };
export const TOTAL_KEYS = Object.freeze([...Object.keys(SUM_FIELDS), 'deson_deducted', 'funrural', 'products', 'freight', 'insurance', 'other_expenses', 'discount', 'services', 'issqn', 'total', 'invoiced'].sort());
/** Item totals, allocations and invoice totals of a normalized invoice (throws when the discount or total is invalid). */
export function invoiceTotals(invoice) {
  const lines = invoice.items.map(item => lineTotalCents(item.quantity, item.unit_price));
  if (lines.some(line => line >= 1000000000000000n)) fail('FISCAL_INVOICE_AMOUNT_INVALID', 'items');
  const weights = invoice.items.map((item, i) => item.invoiced === false ? 0n : lines[i]);
  const products = weights.reduce((sum, w) => sum + w, 0n);
  const [freight, insurance, other, discount] = ['freight', 'insurance', 'other_expenses', 'discount'].map(k => centsOf(invoice[k]));
  if (discount > products) fail('FISCAL_INVOICE_DISCOUNT_EXCEEDS', 'discount');
  const allocation = { freight: allocateCents(freight, weights), insurance: allocateCents(insurance, weights), other_expenses: allocateCents(other, weights), discount: discountShares(invoice, weights) };
  if (allocation.discount.some((d, i) => (weights[i] > 0n && d > weights[i]) || (weights[i] === 0n && d > 0n))) fail('FISCAL_INVOICE_DISCOUNT_EXCEEDS', 'discount');
  const sums = Object.fromEntries(Object.entries(SUM_FIELDS).map(([key, [group, field]]) => [key, invoice.items.reduce((sum, item) => sum + (item[group]?.[field] ? centsOf(item[group][field]) : 0n), 0n)]));
  const deducted = invoice.items.reduce((sum, item) => sum + (item.icms?.deson_deduct && item.icms?.deson_value ? centsOf(item.icms.deson_value) : 0n), 0n);
  const total = products - discount - deducted + sums.st + sums.fcp_st + freight + insurance + other + sums.ii + sums.ipi + sums.ipi_devol;
  if (total < 0n || total >= 1000000000000000n) fail('FISCAL_INVOICE_AMOUNT_INVALID', 'total');
  const totals = Object.fromEntries([...Object.entries(sums).map(([k, v]) => [k, moneyOf(v)]), ['deson_deducted', moneyOf(deducted)], ['funrural', '0.00'], ['products', moneyOf(products)],
    ['freight', moneyOf(freight)], ['insurance', moneyOf(insurance)], ['other_expenses', moneyOf(other)], ['discount', moneyOf(discount)], ['services', '0.00'], ['issqn', '0.00'],
    ['total', moneyOf(total)], ['invoiced', moneyOf(total)]].sort(([a], [b]) => a.localeCompare(b)));
  return { lines: lines.map(moneyOf), allocation: Object.fromEntries(Object.entries(allocation).map(([k, v]) => [k, v.map(moneyOf)])), totals };
}

const STATUS_CODES = Object.keys(INVOICE_STATUS).map(Number);
const dateOrNull = value => value === null || (typeof value === 'string' && checkValue(value, 'a') === value);
/** Validates the invoice record returned by the database. */
export function invoiceRecord(value) {
  if (!plain(value) || !UUID.test(value.id ?? '') || !version(value.version) || !STATUS_CODES.includes(value.status) || !timestamp(value.created_at) || !timestamp(value.updated_at)
    || !(value.deleted_at === null || timestamp(value.deleted_at)) || !(value.delete_reason === null || (typeof value.delete_reason === 'string' && value.delete_reason.length <= 1000))
    || !(value.number === null || (Number.isInteger(value.number) && value.number > 0 && value.number <= 999999999)) || !Number.isInteger(value.series)
    || !(value.access_key === null || accessKeyValid(value.access_key)) || !(value.protocol === null || /^\d{15}$/.test(value.protocol ?? '')) || !(value.authorized_at === null || timestamp(value.authorized_at))
    || value.environment !== (['T', 'S', 'X'].includes(value.issue_type) ? null : '2') || !Array.isArray(value.items) || !plain(value.totals) || !Array.isArray(value.orders)) fail('FISCAL_RESPONSE_INVALID');
  const own = !['T', 'S', 'X'].includes(value.issue_type);
  const input = Object.fromEntries(INVOICE_KEYS.filter(k => !OPTIONAL_INVOICE_KEYS.includes(k) || Object.hasOwn(value, k)).map(k => [k, value[k]]));
  input.series = String(value.series); input.number = own ? null : value.number === null ? null : String(value.number); input.access_key = own ? null : value.access_key;
  input.items = value.items.map((item, index) => { if (!plain(item) || item.position !== index + 1 || !MONEY.test(item.total ?? '') || !plain(item.allocated)) fail('FISCAL_RESPONSE_INVALID'); const { position, total, allocated, ...rest } = item; return rest; });
  let normalized;
  // An imported NFC-e (S, model 65, wave F) is checked by the importer's own rule; every other record as before.
  try { normalized = (value.issue_type === 'S' && value.model === '65' ? normalizeImportedInput : normalizeInvoiceInput)(issueTypeForCheck(input)); } catch { fail('FISCAL_RESPONSE_INVALID'); }
  const computed = invoiceTotals(normalized);
  for (const [key, expected] of Object.entries(normalized)) if (!['number', 'access_key', 'series', 'nature_id', 'nature_description', 'issue_type'].includes(key) && !equal(expected, key === 'items' ? input.items : value[key])) fail('FISCAL_RESPONSE_INVALID', key);
  // Imported XML notes are checked as registered notes (T): S only on exit notes, X only on entry notes.
  if (normalized.issue_type !== (['S', 'X'].includes(value.issue_type) ? 'T' : value.issue_type) || (value.issue_type === 'S' && value.direction !== '1') || (value.issue_type === 'X' && value.direction !== '0')) fail('FISCAL_RESPONSE_INVALID', 'issue_type');
  if (!dateOrNull(value.exit_date) || value.nature_id !== normalized.nature_id || typeof value.nature_description !== 'string' || !value.nature_description || [...value.nature_description].length > 60) fail('FISCAL_RESPONSE_INVALID');
  if (!equal(Object.keys(value.totals).sort(), TOTAL_KEYS) || !equal(Object.fromEntries(Object.entries(value.totals).sort(([a], [b]) => a.localeCompare(b))), computed.totals)) fail('FISCAL_RESPONSE_INVALID', 'totals');
  value.items.forEach((item, i) => { if (item.total !== computed.lines[i] || !equal(item.allocated, { freight: computed.allocation.freight[i], insurance: computed.allocation.insurance[i], other_expenses: computed.allocation.other_expenses[i], discount: computed.allocation.discount[i] })) fail('FISCAL_RESPONSE_INVALID', 'items'); });
  // 202610200176: exit notes also carry the ordens de serviço they came from (letter O).
  const orders = value.orders.map(o => { if (!plain(o) || !UUID.test(o.id ?? '') || !(value.direction === '0' ? ['purchase_orders'] : ['sales_orders', 'service_orders']).includes(o.kind) || typeof o.number !== 'string' || !/^\d{1,10}$/.test(o.number) || !dateOrNull(o.date) || !(o.contact_name === null || (typeof o.contact_name === 'string' && o.contact_name.length <= 200))) fail('FISCAL_RESPONSE_INVALID'); return { id: o.id, kind: o.kind, number: o.number, date: o.date, contact_name: o.contact_name }; });
  // 202610200215: the seller name comes only with a seller (absent or null otherwise).
  if (!(value.seller_name === undefined || value.seller_name === null || (typeof value.seller_name === 'string' && value.seller_name.length <= 200 && typeof value.seller_id === 'string'))) fail('FISCAL_RESPONSE_INVALID', 'seller_name');
  return { ...normalized, issue_type: value.issue_type, id: value.id, version: value.version, status: value.status, environment: value.environment, series: value.series, number: value.number, access_key: value.access_key,
    protocol: value.protocol, authorized_at: value.authorized_at, nature_description: value.nature_description, ...(Object.hasOwn(value, 'seller_id') ? { seller_name: value.seller_name ?? null } : {}),
    items: value.items.map(item => structuredClone(item)), totals: computed.totals, orders, created_at: value.created_at, updated_at: value.updated_at, deleted_at: value.deleted_at, delete_reason: value.delete_reason };
}
// S/X records (imported XML) are stored by a future importer; the shape check treats them like T.
const issueTypeForCheck = input => ['S', 'X'].includes(input.issue_type) ? { ...input, issue_type: 'T' } : input;

// ---- Preferências › Notas Fiscais followed by the note form and list (migration 202610200140) ----
export const PREFERENCE_FLAGS = Object.freeze(['show_totals', 'sum_weight', 'compute_volume', 'ipi_first_installment', 'st_first_installment', 'tracking_in_info', 'purchase_order_in_info',
  'simples_credit_message', 'optional_installments', 'fuel_group', 'weapon_group', 'vehicle_group', 'retention_group', 'autxml_carrier', 'block_edit_stock', 'block_edit_finance']);
const PREFERENCE_KEYS = [...PREFERENCE_FLAGS, 'freight_by', 'species', 'volume_quantity', 'markup', 'autxml_people'].sort();
/** Default-safe values when a screen has no preferences yet (Origin defaults of the pages). */
export const DEFAULT_INVOICE_PREFERENCES = Object.freeze({ ...Object.fromEntries(PREFERENCE_FLAGS.map(k => [k, k === 'show_totals'])), freight_by: '9', species: 'volumes', volume_quantity: 0, markup: '0', autxml_people: Object.freeze([]) });
/** Validates the "preferences" block of GET /v1/notas-fiscais/contexto. */
export function invoicePreferences(value) {
  if (!plain(value) || !equal(Object.keys(value).sort(), PREFERENCE_KEYS) || PREFERENCE_FLAGS.some(k => typeof value[k] !== 'boolean')
    || !['0', '1', '2', '3', '4', '9'].includes(value.freight_by) || !['outros', 'volumes', 'unidades', 'caixas', 'pacotes', 'envelopes'].includes(value.species)
    || !Number.isInteger(value.volume_quantity) || value.volume_quantity < 0 || value.volume_quantity > 99999 || typeof value.markup !== 'string' || !/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/.test(value.markup)
    || !Array.isArray(value.autxml_people) || value.autxml_people.length > 10) fail('FISCAL_RESPONSE_INVALID');
  const people = value.autxml_people.map(p => { if (!plain(p) || !equal(Object.keys(p).sort(), ['document', 'name']) || typeof p.document !== 'string' || !/^(\d{11}|\d{14})$/.test(p.document) || !nullableText(p.name, 60)) fail('FISCAL_RESPONSE_INVALID'); return { document: p.document, name: p.name }; });
  if (new Set(people.map(p => p.document)).size !== people.length) fail('FISCAL_RESPONSE_INVALID');
  return { ...Object.fromEntries(PREFERENCE_FLAGS.map(k => [k, value[k]])), freight_by: value.freight_by, species: value.species, volume_quantity: value.volume_quantity, markup: value.markup, autxml_people: people };
}

// ---- List and Origin detail ----
const LIST_ORDERS = ['date_desc', 'date_asc', 'number_desc', 'number_asc'];
const nullableText = (value, max) => value === null || (typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value));
export function listRow(value, origin) {
  if (!plain(value) || value.origin !== origin || !(origin === 'brufap' ? UUID.test(value.id ?? '') : /^\d{1,40}$/.test(value.id ?? ''))
    || !(origin === 'brufap' ? version(value.version) : value.version === null) || !(value.number === null || (Number.isInteger(value.number) && value.number > 0))
    || !(value.series === null || (Number.isInteger(value.series) && value.series >= 0)) || !dateOrNull(value.issue_date) || !dateOrNull(value.entry_date)
    || !nullableText(value.name, 200) || !(value.document === null || /^\d{1,30}$/.test(value.document)) || !(value.state === null || [...UFS, 'EX'].includes(value.state))
    || !nullableText(value.nature, 60) || !(value.status === null || STATUS_CODES.includes(value.status)) || !nullableText(value.status_raw, 20) || !MONEY.test(value.total ?? '')
    || typeof value.total_known !== 'boolean' || !(value.environment === null || ['1', '2'].includes(value.environment)) || !(value.issue_type === null || /^[NDETSCIX]$/.test(value.issue_type))
    || !(value.access_key === null || /^\d{44}$/.test(value.access_key)) || !(value.xml_id === null || UUID.test(value.xml_id)) || typeof value.protocol_present !== 'boolean'
    || (value.xml_id === null ? value.xml_hash !== null || value.xml_size !== null : !/^[0-9a-f]{64}$/.test(value.xml_hash ?? '') || !Number.isInteger(value.xml_size) || value.xml_size < 1 || value.xml_size > 8388608)
    || !Number.isInteger(value.event_count) || value.event_count < 0 || !Array.isArray(value.orders) || value.orders.length > 100
    || (origin === 'brufap' && (value.environment !== (['T', 'S', 'X'].includes(value.issue_type) ? null : '2') || value.xml_id !== null))) fail('FISCAL_RESPONSE_INVALID');
  // Espelho lane (wave H, 202610210358, NFE-027): a Origin note answers the Origin pedidos de venda that declare it (notaFiscal.id), by their Origin id.
  const orders = value.orders.map(o => { if (!plain(o) || !(origin === 'origin' ? /^[1-9]\d{0,39}$/.test(o.id ?? '') && o.kind === 'sales_orders' : UUID.test(o.id ?? '') && ['sales_orders', 'purchase_orders', 'service_orders'].includes(o.kind))
    || !/^\d{1,10}$/.test(o.number ?? '') || !dateOrNull(o.date) || !nullableText(o.contact_name, 200)) fail('FISCAL_RESPONSE_INVALID'); return { id: o.id, kind: o.kind, number: o.number, date: o.date, contact_name: o.contact_name }; });
  if (new Set(orders.map(o => o.id)).size !== orders.length) fail('FISCAL_RESPONSE_INVALID');
  return { origin, id: value.id, version: value.version, number: value.number, series: value.series, issue_date: value.issue_date, entry_date: value.entry_date, name: value.name,
    document: value.document, state: value.state, nature: value.nature, status: value.status, status_raw: value.status_raw, total: value.total, total_known: value.total_known,
    environment: value.environment, issue_type: value.issue_type, access_key: value.access_key, xml_id: value.xml_id, xml_hash: value.xml_hash, xml_size: value.xml_size,
    protocol_present: value.protocol_present, event_count: value.event_count, orders, ...sourceAttributes(value, origin),
    ...observedAttributes(value, origin) };
}
function observedAttributes(value, origin) {
  if (!Object.hasOwn(value, 'observed_at')) return {};
  if (!(value.observed_at === null || timestamp(value.observed_at)) || (origin === 'brufap' && value.observed_at !== null)) fail('FISCAL_RESPONSE_INVALID');
  return { observed_at: value.observed_at };
}
function mirrorCoverage(value, origin) {
  if (!Object.hasOwn(value, 'coverage')) return {};
  if (origin === 'brufap') {
    if (value.coverage !== null) fail('FISCAL_RESPONSE_INVALID');
    return { coverage: null };
  }
  const coverage = value.coverage;
  const counts = ['source_count', 'visible_count', 'xml_count', 'missing_xml_count', 'homologation_count', 'duplicate_count', 'incomplete_count'];
  if (!plain(coverage) || coverage.scope !== 'model_direction' || typeof coverage.partial !== 'boolean'
    || counts.some(key => !Number.isSafeInteger(coverage[key]) || coverage[key] < 0)
    || coverage.visible_count > coverage.source_count || coverage.xml_count > coverage.visible_count
    || coverage.xml_count + coverage.missing_xml_count !== coverage.visible_count
    || ![coverage.oldest_observed_at, coverage.latest_observed_at].every(value => value === null || timestamp(value))
    || (coverage.oldest_observed_at !== null && coverage.latest_observed_at !== null && Date.parse(coverage.oldest_observed_at) > Date.parse(coverage.latest_observed_at))) fail('FISCAL_RESPONSE_INVALID');
  return { coverage: { scope: 'model_direction', ...Object.fromEntries(counts.map(key => [key, coverage[key]])), oldest_observed_at: coverage.oldest_observed_at,
    latest_observed_at: coverage.latest_observed_at, partial: coverage.partial } };
}
/**
 * Espelho lane (wave H, 202610210358). NFE-069: the fiscal state apart from the DANFE print (7 Emitida DANFE is an authorized note, 6,
 * whose DANFE was printed). NFE-063/185: origin and environment of the source, apart from the model and the emission environment.
 * A database before 358 does not send them; they are then derived from the row (the source environment of an imported XML stays unknown).
 */
function sourceAttributes(value, origin) {
  const fiscal = value.status === 7 ? 6 : value.status, danfe = value.status === 7;
  const sourceOrigin = origin === 'origin' ? 'origin' : ['S', 'X'].includes(value.issue_type) ? 'xml_import' : value.issue_type === 'T' ? 'third_party' : 'brufap_native';
  const keys = ['fiscal_status', 'danfe_emitted', 'source_origin', 'source_environment'], present = keys.filter(k => Object.hasOwn(value, k));
  if (!present.length) return { fiscal_status: fiscal, danfe_emitted: danfe, source_origin: sourceOrigin, source_environment: sourceOrigin === 'xml_import' || sourceOrigin === 'third_party' ? null : value.environment };
  if (present.length !== keys.length || value.fiscal_status !== fiscal || value.danfe_emitted !== danfe || value.source_origin !== sourceOrigin
    || !(value.source_environment === null || ['1', '2'].includes(value.source_environment))
    || (sourceOrigin === 'xml_import' ? false : sourceOrigin === 'third_party' ? value.source_environment !== null : value.source_environment !== value.environment)) fail('FISCAL_RESPONSE_INVALID');
  return { fiscal_status: fiscal, danfe_emitted: danfe, source_origin: sourceOrigin, source_environment: value.source_environment };
}
export function listPage(value, args) {
  if (!plain(value) || value.origin !== args.origin || value.model !== args.model || value.direction !== args.direction || value.page !== args.page || value.limit !== args.limit
    || value.order !== args.order || !LIST_ORDERS.includes(value.order) || !Array.isArray(value.items) || value.items.length > args.limit || typeof value.has_more !== 'boolean'
    || !Number.isInteger(value.total_count) || value.total_count < 0 || !MONEY.test(value.total_amount ?? '') || !Number.isInteger(value.amount_unknown) || value.amount_unknown < 0
    || value.amount_unknown > value.total_count || typeof value.brufap_visible !== 'boolean' || typeof value.show_totals !== 'boolean' || value.data_mode !== (args.origin === 'origin' ? 'origin_mirror_readonly' : 'erp_native_homologation')
    || value.has_more !== (value.total_count > args.page * args.limit) || (value.total_count === 0 && value.items.length)
    || value.items.length !== Math.max(0, Math.min(args.limit, value.total_count - (args.page - 1) * args.limit))) fail('FISCAL_RESPONSE_INVALID');
  const items = value.items.map(row => listRow(row, args.origin));
  if (new Set(items.map(row => row.id)).size !== items.length) fail('FISCAL_RESPONSE_INVALID');
  return { items, origin: value.origin, model: value.model, direction: value.direction, page: value.page, limit: value.limit, order: value.order, has_more: value.has_more,
    total_count: value.total_count, total_amount: value.total_amount, amount_unknown: value.amount_unknown, brufap_visible: value.brufap_visible, show_totals: value.show_totals, data_mode: value.data_mode,
    ...mirrorCoverage(value, args.origin) };
}
const decimalText = (value, digits) => value === null || (typeof value === 'string' && new RegExp(`^[0-9]{1,${digits}}(\\.[0-9]{1,10})?$`).test(value));
export function originDetail(value) {
  if (!plain(value) || value.origin !== 'origin' || !['nfe', 'nfce'].includes(value.entity) || !/^\d{1,40}$/.test(value.source_id ?? '') || value.model !== (value.entity === 'nfe' ? '55' : '65')
    || !(value.direction === null || ['0', '1'].includes(value.direction)) || !(value.number === null || Number.isInteger(value.number)) || !(value.series === null || Number.isInteger(value.series))
    || !dateOrNull(value.issue_date) || !dateOrNull(value.operation_date) || !(value.status === null || STATUS_CODES.includes(value.status)) || !nullableText(value.status_raw, 20)
    || !(value.access_key === null || /^\d{44}$/.test(value.access_key)) || !MONEY.test(value.total ?? '') || typeof value.total_known !== 'boolean' || !(value.freight === null || MONEY.test(value.freight))
    || !plain(value.contact) || !Array.isArray(value.items) || value.items.length > 990 || !Array.isArray(value.installments) || value.installments.length > 120 || !plain(value.transport)
    || !nullableText(value.additional_info, 5000) || !Array.isArray(value.events) || value.events.length > 100 || !timestamp(value.observed_at) || value.data_mode !== 'origin_mirror_readonly' || value.writable !== false) fail('FISCAL_RESPONSE_INVALID');
  const contactKeys = { name: 200, document: 30, ie: 30, email: 254, phone: 40, street: 200, number: 30, complement: 200, district: 100, postal_code: 20, city: 100, state: 2, country: 60 };
  if (!equal(Object.keys(value.contact).sort(), Object.keys(contactKeys).sort()) || Object.entries(contactKeys).some(([k, max]) => !nullableText(value.contact[k], max))) fail('FISCAL_RESPONSE_INVALID');
  const items = value.items.map(i => { if (!plain(i) || !nullableText(i.code, 60) || !nullableText(i.description, 200) || !nullableText(i.unit, 10) || !decimalText(i.quantity, 12) || !decimalText(i.unit_price, 13) || !(i.total === null || MONEY.test(i.total)) || !nullableText(i.cfop, 4) || !nullableText(i.ncm, 10) || !nullableText(i.gtin, 14)) fail('FISCAL_RESPONSE_INVALID'); return { code: i.code, description: i.description, unit: i.unit, quantity: i.quantity, unit_price: i.unit_price, total: i.total, cfop: i.cfop, ncm: i.ncm, gtin: i.gtin }; });
  const installments = value.installments.map(i => { if (!plain(i) || !dateOrNull(i.date) || !(i.amount === null || MONEY.test(i.amount)) || !nullableText(i.note, 255)) fail('FISCAL_RESPONSE_INVALID'); return { date: i.date, amount: i.amount, note: i.note }; });
  const file = v => /^[0-9a-f]{64}$/.test(v.hash ?? '') && Number.isInteger(v.size) && v.size >= 1 && v.size <= 8388608;
  const events = value.events.map(e => { if (!plain(e) || !UUID.test(e.id ?? '') || !(e.type === null || /^\d{6}$/.test(e.type)) || !(e.sequence === null || /^\d{1,3}$/.test(e.sequence)) || !file(e)) fail('FISCAL_RESPONSE_INVALID'); return { id: e.id, type: e.type, sequence: e.sequence, hash: e.hash, size: e.size }; });
  if (!nullableText(value.transport.freight_by, 2) || !nullableText(value.transport.carrier, 200) || Object.keys(value.transport).length !== 2) fail('FISCAL_RESPONSE_INVALID');
  if (!(value.xml === null || (plain(value.xml) && UUID.test(value.xml.id ?? '') && file(value.xml) && ['1', null].includes(value.xml.environment ?? null) && (value.xml.protocol === null || /^\d{1,20}$/.test(value.xml.protocol))))) fail('FISCAL_RESPONSE_INVALID');
  return { origin: 'origin', entity: value.entity, source_id: value.source_id, model: value.model, direction: value.direction, number: value.number, series: value.series, issue_date: value.issue_date,
    operation_date: value.operation_date, status: value.status, status_raw: value.status_raw, access_key: value.access_key, total: value.total, total_known: value.total_known, freight: value.freight,
    contact: { ...value.contact }, items, installments, transport: { ...value.transport }, additional_info: value.additional_info, xml: value.xml && { ...value.xml }, events, observed_at: value.observed_at, data_mode: value.data_mode, writable: false };
}

// ---- Events ----
export function eventRecord(value) {
  if (!plain(value) || !UUID.test(value.id ?? '') || !['cancel', 'correction', 'inutilization'].includes(value.kind) || !['55', '65'].includes(value.model) || value.environment !== '2'
    || (value.kind === 'inutilization') !== (value.invoice_id === null) || !(value.invoice_id === null || UUID.test(value.invoice_id)) || !Number.isInteger(value.series)
    || !Number.isInteger(value.number_from) || !Number.isInteger(value.number_to) || value.number_from > value.number_to || (value.kind === 'correction') !== Number.isInteger(value.sequence)
    || typeof value.text !== 'string' || [...value.text].length < 15 || [...value.text].length > 1000 || value.state !== 'pending' || value.protocol !== null || !timestamp(value.requested_at)
    || !(value.access_key === null || /^\d{44}$/.test(value.access_key))) fail('FISCAL_RESPONSE_INVALID');
  return { id: value.id, kind: value.kind, invoice_id: value.invoice_id, model: value.model, environment: '2', series: value.series, number_from: value.number_from, number_to: value.number_to,
    sequence: value.sequence ?? null, text: value.text, state: 'pending', protocol: null, requested_at: value.requested_at, access_key: value.access_key };
}
