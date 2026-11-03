// Clientes e fornecedores no padrão do Origin (lane contatos, migrações 202610200124-128): formulário completo, situação,
// tipos de contato, listagem com os filtros do Origin, exportação, comentários, histórico, importação, vendedores, formas
// de pagamento e funcionários. Rotas em /v1/cadastros/{contatos,tipos-contato,vendedores,formas-pagamento,funcionarios}.
// O contrato antigo /v1/cadastros/contacts (seletores e contato rápido dos documentos) continua em catalog.mjs.
// Parameters and bodies are allow-listed and validated before any upstream call; every response is validated strictly.

import { CONTACT_TAG_FILTERS, contactTagFilterArgs, ContactTagsError } from './contact-tags.mjs';
import { LABEL_FIELDS, labelConfigValid } from '../../../packages/erp-domain/src/reports-labels.mjs';
import { documentNativeCoverage } from '../../../packages/erp-domain/src/document-mirror.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\x00-\x1f\x7f]/, AREA_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SLUG = /^[a-z][a-z0-9_]{1,39}$/;
const STAMP = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
export class ContactsError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const invalid = () => { throw new ContactsError(400, 'ERP_INVALID_QUERY'); };
const tagFilters = get => { try { return contactTagFilterArgs(get); } catch (error) { if (error instanceof ContactTagsError) invalid(); throw error; } };
const bad = () => { throw new ContactsError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const isoDate = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? ''); if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1] && date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3] && value >= '1900-01-01' && value <= '2100-12-31';
};
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const version = value => int(value, 1, 2147483647);

// ---- Contact fields (same limits as erp_catalog.contact_input) ----
export const CONTACT_TEXT = { name: 200, code: 100, trade_name: 200, document: 30, ie: 30, email: 254, phone: 40, mobile: 40, postal_code: 20, street: 200, number: 30,
  complement: 200, district: 100, city: 100, state: 2, municipal_registration: 30, rg: 20, rg_issuer: 20, country: 60, foreign_state: 60, fax: 40, nfe_email: 60,
  website: 200, skype: 100, profession: 100, birthplace: 100, father_name: 200, father_cpf: 20, mother_name: 200, mother_cpf: 20, payment_condition: 100,
  billing_postal_code: 20, billing_state: 2, billing_city: 100, billing_district: 100, billing_street: 200, billing_number: 30, billing_complement: 200, billing_foreign_state: 60, suframa: 9 };
export const CONTACT_AREA = { notes: 4000, contact_info: 400 };
export const CONTACT_ENUMS = { person_type: ['F', 'J', 'E'], situation: ['A', 'I', 'S'], crt: ['1', '2', '3', '4'], taxpayer: ['1', '2', '9'],
  carrier_operator: ['claro', 'oi', 'tim', 'vivo', 'nextel', 'porto_seguro'], public_agency: ['municipal', 'estadual', 'federal'],
  marital_status: ['casado', 'solteiro', 'viuvo', 'separado', 'desquitado'], gender: ['feminino', 'masculino'], credit_limit_mode: ['unlimited', 'zero', 'value'] };
const CONTACT_DATES = ['client_since', 'next_visit', 'birth_date'];
const CONTACT_DECIMALS = { avg_tax_load: /^(0|[1-9]\d?|100)(\.\d{1,2})?$/, credit_limit: /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/ };
const CONTACT_REFS = ['finance_category_id', 'operation_nature_id', 'seller_id'];
export const CONTACT_KEYS = [...Object.keys(CONTACT_TEXT), ...Object.keys(CONTACT_AREA), ...Object.keys(CONTACT_ENUMS), 'ie_exempt', ...CONTACT_DATES, ...Object.keys(CONTACT_DECIMALS), ...CONTACT_REFS, 'roles', 'types', 'persons'];
const ROLES = ['customer', 'supplier', 'carrier'];
const WARNINGS = ['invalid_document', 'duplicate_document', 'invalid_father_cpf', 'invalid_mother_cpf'];
export const SALE_STATUSES = ['draft', 'open', 'verified', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled'];
// Situações a pedido can have in the history of the contact (202610200245 adds Venda Agenciada and Faturado parcialmente; the
// "Sem compras no período" filter keeps the list of migration 125).
// 202610200291: Checkout parcial.
const HISTORY_STATUSES = [...SALE_STATUSES, 'agency_sale', 'partially_invoiced', 'checkout_partial'];

function distinctStrings(value, max, test) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !test(item)) || new Set(value).size !== value.length) invalid();
  return value;
}
/** Contact data as the SQL accepts it: types, lengths and enums only (formats and cross-field rules are decided in SQL). */
export function contactData(data, create) {
  if (!only(data, CONTACT_KEYS) || !Object.keys(data).length || (create && typeof data.name !== 'string')) invalid();
  const safe = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'ie_exempt') { if (typeof value !== 'boolean') invalid(); }
    else if (key === 'roles') distinctStrings(value, 3, role => ROLES.includes(role));
    else if (key === 'types') distinctStrings(value, 40, slug => SLUG.test(slug));
    else if (key === 'persons') distinctStrings(value, 20, id => UUID.test(id));
    else if (value !== null) {
      if (typeof value !== 'string') invalid();
      const max = CONTACT_TEXT[key] ?? CONTACT_AREA[key] ?? (CONTACT_REFS.includes(key) ? 36 : 20);
      if (value.length > max || (CONTACT_AREA[key] ? AREA_CONTROL : CONTROL).test(value)) invalid();
      const trimmed = value.trim();
      if (CONTACT_ENUMS[key] && trimmed && !CONTACT_ENUMS[key].includes(trimmed)) invalid();
      if (CONTACT_DATES.includes(key) && trimmed && !isoDate(trimmed)) invalid();
      if (CONTACT_DECIMALS[key] && trimmed && !CONTACT_DECIMALS[key].test(trimmed)) invalid();
      if (CONTACT_REFS.includes(key) && trimmed && !UUID.test(trimmed)) invalid();
    }
    if (key === 'name' && (typeof value !== 'string' || !value.trim())) invalid();
    if (key === 'credit_limit_mode' && value === null) invalid();
    safe[key] = CONTACT_REFS.includes(key) && typeof value === 'string' ? value.toLowerCase() : key === 'persons' ? value.map(id => id.toLowerCase()) : value;
  }
  return safe;
}
const acknowledged = value => { if (!Array.isArray(value) || value.length > 4 || value.some(code => !WARNINGS.includes(code)) || new Set(value).size !== value.length) invalid(); return value; };

// ---- Specific refusals (wave C) ----
// SQL message of a refused contact RPC → a worker code and, when the message names one, the field. The HTTP status stays
// the one of the SQLSTATE, so every screen keeps its recovery rules; only these allow-listed codes and field names leave.
const PAYMENT_KEYS = ['description', 'payment_type', 'condition', 'destination', 'account_id', 'business_days', 'applicable', 'interest_rate', 'fine_rate', 'card_brand', 'card_integration', 'card_cnpj',
  'auto_settle', 'pix_integration', 'pix_cnpj', 'fee_type', 'fee_rate', 'fee_fixed', 'settlement_days', 'choice', 'section', 'fee'];
const EMPLOYEE_KEYS = ['name', 'cpf', 'rg', 'job_title', 'pis', 'ctps', 'code', 'phone', 'mobile', 'email', 'emergency_phone', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement',
  'birth_date', 'admission_date', 'salary', 'notes'];
const REFUSALS = [
  [/^erp_catalog_contact_required:([a-z_]{1,40})$/, 400, 'ERP_CONTACT_REQUIRED_FIELD', CONTACT_KEYS], [/^erp_catalog_name_required$/, 400, 'ERP_CONTACT_REQUIRED_FIELD', 'name'],
  [/^erp_catalog_contact_invalid:([a-z_]{1,40})$/, 400, 'ERP_CONTACT_INVALID_FIELD', CONTACT_KEYS], [/^erp_catalog_duplicate_document$/, 409, 'ERP_CONTACT_DUPLICATE_DOCUMENT'],
  [/^erp_catalog_contact_not_visible$/, 403, 'ERP_CONTACT_NOT_VISIBLE'], [/^erp_catalog_contact_deleted$/, 400, 'ERP_CONTACT_DELETED'],
  [/^erp_catalog_export_too_large$/, 400, 'ERP_CONTACT_EXPORT_TOO_LARGE'], [/^erp_catalog_import_invalid_rows$/, 400, 'ERP_CONTACT_IMPORT_INVALID_ROWS'],
  [/^erp_catalog_contact_code_used$/, 400, 'ERP_CONTACT_CODE_USED'], [/^erp_catalog_contact_type_exists$/, 409, 'ERP_CONTACT_TYPE_EXISTS'],
  [/^erp_catalog_comment_limit$/, 400, 'ERP_CONTACT_COMMENT_LIMIT'], [/^erp_catalog_seller_user_taken$/, 409, 'ERP_SELLER_USER_TAKEN'],
  [/^erp_catalog_seller_exists$/, 409, 'ERP_SELLER_EXISTS'], [/^erp_catalog_seller_invalid:user_id$/, 400, 'ERP_SELLER_INVALID_USER'],
  [/^erp_catalog_employee_cpf_exists$/, 409, 'ERP_EMPLOYEE_CPF_EXISTS'], [/^erp_catalog_employee_invalid:([a-z_]{1,40})$/, 400, 'ERP_EMPLOYEE_INVALID_FIELD', EMPLOYEE_KEYS],
  [/^erp_catalog_payment_method_inactive$/, 400, 'ERP_PAYMENT_METHOD_INACTIVE'], [/^erp_catalog_payment_method_invalid:([a-z_]{1,40})$/, 400, 'ERP_PAYMENT_METHOD_INVALID_FIELD', PAYMENT_KEYS],
];
/** { status, code, field? } for a known refusal of a contact RPC, or null (the generic mapping stays). */
export function contactRefusal(message, status) {
  if (typeof message !== 'string' || message.length > 120) return null;
  for (const [pattern, expected, code, fields] of REFUSALS) {
    const match = pattern.exec(message);
    if (!match || status !== expected) continue;
    const name = typeof fields === 'string' ? fields : match[1];
    if (Array.isArray(fields) && !fields.includes(name)) return { status, code };
    return name ? { status, code, field: name } : { status, code };
  }
  return null;
}

// ---- Routes ----
const ID = '([0-9a-fA-F-]{36})';
const ROUTES = [
  ['contacts', /^\/v1\/cadastros\/contatos$/], ['contact-check', /^\/v1\/cadastros\/contatos\/conferir$/], ['contact-export', /^\/v1\/cadastros\/contatos\/exportar$/],
  ['contact-import', /^\/v1\/cadastros\/contatos\/importar$/], ['contact-code', /^\/v1\/cadastros\/contatos\/codigo$/],
  // Wave C (migration 158): pickers, labels, the summary of a contact and the history by document kind.
  ['contact-options', /^\/v1\/cadastros\/contatos\/opcoes$/], ['contact-labels', /^\/v1\/cadastros\/contatos\/etiquetas$/],
  ['contact-summary', new RegExp(`^/v1/cadastros/contatos/${ID}/resumo$`)],
  ['contact', new RegExp(`^/v1/cadastros/contatos/${ID}$`)], ['contact-situation', new RegExp(`^/v1/cadastros/contatos/${ID}/situacao$`)],
  ['contact-seller', new RegExp(`^/v1/cadastros/contatos/${ID}/vendedor$`)], ['contact-comments', new RegExp(`^/v1/cadastros/contatos/${ID}/comentarios$`)],
  ['contact-sales', new RegExp(`^/v1/cadastros/contatos/${ID}/historico$`)],
  // Leva H (migration 373): Cobrança of the contact (use the general address, e-mail de cobrança, verified badges).
  ['contact-billing', new RegExp(`^/v1/cadastros/contatos/${ID}/cobranca$`)],
  ['types', /^\/v1\/cadastros\/tipos-contato$/], ['type-delete', new RegExp(`^/v1/cadastros/tipos-contato/${ID}/excluir$`)],
  ['sellers', /^\/v1\/cadastros\/vendedores$/], ['seller-options', /^\/v1\/cadastros\/vendedores\/opcoes$/], ['seller-from-contact', /^\/v1\/cadastros\/vendedores\/a-partir-do-contato$/],
  ['seller', new RegExp(`^/v1/cadastros/vendedores/${ID}$`)],
  ['payment-methods', /^\/v1\/cadastros\/formas-pagamento$/], ['payment-method', new RegExp(`^/v1/cadastros/formas-pagamento/${ID}$`)],
  ['payment-method-action', new RegExp(`^/v1/cadastros/formas-pagamento/${ID}/acao$`)],
  ['employees', /^\/v1\/cadastros\/funcionarios$/], ['employee', new RegExp(`^/v1/cadastros/funcionarios/${ID}$`)],
];
const METHODS = { contacts: ['GET', 'POST'], 'contact-check': ['POST'], 'contact-export': ['GET'], 'contact-import': ['POST'], 'contact-code': ['GET', 'PATCH'],
  contact: ['GET', 'PATCH'], 'contact-options': ['GET'], 'contact-labels': ['GET'], 'contact-summary': ['GET'], 'contact-situation': ['PATCH'], 'contact-seller': ['PATCH'], 'contact-comments': ['GET', 'POST'], 'contact-sales': ['GET'], 'contact-billing': ['GET', 'POST'],
  types: ['GET', 'POST'], 'type-delete': ['POST'], sellers: ['GET', 'POST'], 'seller-options': ['GET'], 'seller-from-contact': ['POST'], seller: ['GET', 'PATCH'],
  'payment-methods': ['GET', 'POST'], 'payment-method': ['GET', 'PATCH'], 'payment-method-action': ['POST'], employees: ['GET', 'POST'], employee: ['GET', 'PATCH'] };
export function contactRoute(path) {
  for (const [kind, pattern] of ROUTES) {
    const match = pattern.exec(path);
    if (match) { if (match[1] && !UUID.test(match[1])) return null; return { contact: kind, id: match[1]?.toLowerCase() ?? null, entity: 'contacts' }; }
  }
  return null;
}
export const contactMethods = route => METHODS[route.contact];

async function body(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) invalid();
  if (Number(request.headers.get('Content-Length')) > limit || !request.body) invalid();
  const reader = request.body.getReader(); let size = 0; let text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) invalid(); text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); const data = JSON.parse(text); if (!object(data)) invalid(); return data;
  } catch { return invalid(); }
  finally { try { await reader.cancel(); } catch { /* No request data is logged. */ } reader.releaseLock(); }
}
const command = value => { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); };
function query(params, allowed) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid();
  return key => params.get(key);
}
const text = (raw, max) => { if (raw === null) return null; if (raw.length > max || CONTROL.test(raw)) invalid(); return raw.trim() || null; };
const pageNumber = (raw, fallback, max) => { const value = raw ?? fallback; if (!/^[1-9]\d{0,5}$/.test(value) || Number(value) > max) invalid(); return Number(value); };
const SORTS = ['created_desc', 'name_asc', 'name_desc', 'code_asc', 'code_desc'];
// Leva H (VND-248, 393): tecnico reads the contacts of the type Técnico.
const PICKER_ROLES = { cliente: 'customer', fornecedor: 'supplier', transportador: 'carrier', tecnico: 'technician' };
const HISTORY_KINDS = { 'pedidos-venda': 'sales_orders', 'pedidos-compra': 'purchase_orders' };
const SITUATIONS = ['latest', 'all', 'A', 'I', 'S', 'E'];
// Produtos lane, migration 153: the Tags and Lista de preço filters switch to the tagged page/export (same response shape).
const FILTERS = ['q', 'situation', 'type', 'person_type', 'state', 'city', 'phone', 'email', 'seller_id', 'period', 'from', 'to', 'sale_statuses', ...CONTACT_TAG_FILTERS];
/** The listing filters shared by the page and the export (Origin CL-01, CL-02, CL-07, CL-08 and CL-10). */
function contactFilters(get, sort) {
  const situation = get('situation') ?? 'latest', type = get('type'), personType = get('person_type'), state = get('state'), phone = text(get('phone'), 40), seller = get('seller_id');
  const period = get('period'), from = get('from'), to = get('to'), statuses = get('sale_statuses');
  if (!SITUATIONS.includes(situation) || (type !== null && type !== 'none' && !SLUG.test(type)) || (personType !== null && !['F', 'J', 'E'].includes(personType))
    || (state !== null && !/^[A-Za-z]{2}$/.test(state)) || (phone !== null && !/\d/.test(phone)) || (seller !== null && !UUID.test(seller))
    || (period === null) !== (from === null && to === null) || (period !== null && !['created', 'updated', 'next_visit', 'no_purchases'].includes(period))
    || (from !== null && !isoDate(from)) || (to !== null && !isoDate(to)) || (from !== null && to !== null && from > to)
    || (statuses !== null && period !== 'no_purchases') || !SORTS.includes(sort)) invalid();
  let saleStatuses = null;
  if (statuses !== null) { saleStatuses = statuses.split(','); if (!saleStatuses.length || saleStatuses.some(s => !SALE_STATUSES.includes(s)) || new Set(saleStatuses).size !== saleStatuses.length) invalid(); }
  return { p_sort: sort, p_query: text(get('q'), 120), p_situation: situation, p_type: type, p_person_type: personType, p_state: state?.toUpperCase() ?? null, p_city: text(get('city'), 100),
    p_phone: phone, p_email: text(get('email'), 254), p_seller_id: seller?.toLowerCase() ?? null, p_period: period, p_from: from, p_to: to, p_sale_statuses: saleStatuses };
}

export async function contactOperation(request, route, params) {
  const kind = route.contact, method = request.method;
  const read = (rpc, args, type) => ({ contact: true, rpc, args, type });
  if (method === 'GET') {
    if (kind === 'contacts') {
      const get = query(params, ['page', 'size', 'sort', ...FILTERS]), tagged = tagFilters(get);
      return read(tagged ? 'erp_catalog_contact_page_tagged' : 'erp_catalog_contact_page', { p_page: pageNumber(get('page'), '1', 100000), p_size: pageNumber(get('size'), '100', 100), ...contactFilters(get, get('sort') ?? 'created_desc'), ...tagged }, 'page');
    }
    if (kind === 'contact-export') {
      const get = query(params, ['kind', 'offset', 'limit', 'sort', ...FILTERS, 'birth_from', 'birth_to']);
      const exportKind = get('kind') ?? 'contacts', offset = get('offset') ?? '0', limit = get('limit') ?? '100', birthFrom = get('birth_from'), birthTo = get('birth_to');
      if (!['contacts', 'birthdays'].includes(exportKind) || !/^(0|[1-9]\d{0,3})$/.test(offset) || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100
        || (exportKind === 'contacts' ? birthFrom !== null || birthTo !== null : !isoDate(birthFrom) || !isoDate(birthTo) || birthFrom > birthTo)) invalid();
      // Aniversariantes: at most 366 days, as the SQL; a longer period gets its own code so the screen can say so.
      if (exportKind === 'birthdays' && (Date.parse(`${birthTo}T00:00:00Z`) - Date.parse(`${birthFrom}T00:00:00Z`)) / 86400000 > 366) throw new ContactsError(400, 'ERP_CONTACT_PERIOD_TOO_LONG');
      const tagged = tagFilters(get);
      return read(tagged ? 'erp_catalog_contact_export_tagged' : 'erp_catalog_contact_export', { p_kind: exportKind, p_offset: Number(offset), p_limit: Number(limit), ...contactFilters(get, get('sort') ?? 'created_desc'), p_birth_from: birthFrom, p_birth_to: birthTo, ...tagged }, 'export');
    }
    if (kind === 'sellers') {
      const get = query(params, ['page', 'size', 'sort', 'q', 'situation', 'type']);
      const situation = get('situation') ?? 'latest', type = get('type'), sort = get('sort') ?? 'created_desc';
      if (!SITUATIONS.includes(situation) || (type !== null && type !== 'none' && !SLUG.test(type)) || !SORTS.includes(sort)) invalid();
      return read('erp_catalog_seller_page', { p_page: pageNumber(get('page'), '1', 100000), p_size: pageNumber(get('size'), '100', 100), p_sort: sort, p_query: text(get('q'), 120), p_situation: situation, p_type: type }, 'seller-page');
    }
    if (kind === 'seller-options') { const get = query(params, ['q']); return read('erp_catalog_seller_options', { p_query: text(get('q'), 120) }, 'seller-options'); }
    if (kind === 'payment-methods') {
      const get = query(params, ['page', 'size', 'q', 'applicable', 'account_id', 'situation']);
      const applicable = get('applicable'), account = get('account_id'), situation = get('situation') ?? 'active';
      if ((applicable !== null && !['pagamentos', 'recebimentos', 'ambos'].includes(applicable)) || (account !== null && !UUID.test(account)) || !['active', 'inactive', 'all'].includes(situation)) invalid();
      return read('erp_catalog_payment_method_page', { p_page: pageNumber(get('page'), '1', 100000), p_size: pageNumber(get('size'), '100', 100), p_query: text(get('q'), 120),
        p_applicable: applicable, p_account_id: account?.toLowerCase() ?? null, p_active: situation === 'all' ? null : situation === 'active' }, 'payment-page');
    }
    if (kind === 'employees') {
      const get = query(params, ['page', 'size', 'q', 'situation']); const situation = get('situation') ?? 'ativos';
      if (!['todas', 'ativos', 'desligados'].includes(situation)) invalid();
      return read('erp_catalog_employee_page', { p_page: pageNumber(get('page'), '1', 100000), p_size: pageNumber(get('size'), '100', 100), p_query: text(get('q'), 120), p_situation: situation }, 'employee-page');
    }
    if (kind === 'contact-options') {
      // Picker of other screens: papel (Cliente | Fornecedor | Transportador), the listing search and the city.
      const get = query(params, ['q', 'papel', 'cidade', 'limit']), role = get('papel'), limit = get('limit') ?? '25';
      if ((role !== null && !Object.hasOwn(PICKER_ROLES, role)) || !/^[1-9]\d?$/.test(limit) || Number(limit) > 50) invalid();
      return read('erp_catalog_contact_options', { p_query: text(get('q'), 120), p_role: role === null ? null : PICKER_ROLES[role], p_city: text(get('cidade'), 100), p_limit: Number(limit) }, 'options');
    }
    if (kind === 'contact-labels') {
      const get = query(params, ['ids']), raw = get('ids');
      const list = raw === null ? [] : raw.split(',');
      if (!list.length || list.length > 100 || list.some(id => !UUID.test(id))) invalid();
      const ids = list.map(id => id.toLowerCase()); if (new Set(ids).size !== ids.length) invalid();
      return read('erp_catalog_contact_labels', { p_ids: ids }, 'labels');
    }
    if (kind === 'contact-sales' && params.size) {
      // "Visualizar histórico" by kind: pedidos de venda (cliente) or pedidos de compra (fornecedor). Without tipo the
      // route keeps the sales history of migration 125.
      const get = query(params, ['tipo']), tipo = get('tipo');
      if (!Object.hasOwn(HISTORY_KINDS, tipo)) invalid();
      return read('erp_catalog_contact_history', { p_contact_id: route.id, p_kind: HISTORY_KINDS[tipo] }, 'history');
    }
    if (params.size) invalid();
    if (kind === 'contact-billing') return read('erp_contact_billing_get', { p_contact_id: route.id }, 'contact-billing');
    const single = { contact: ['erp_catalog_contact_get', 'contact-record'], 'contact-summary': ['erp_catalog_contact_summary', 'summary'], 'contact-comments': ['erp_catalog_contact_comments', 'comments'], 'contact-sales': ['erp_catalog_contact_sales', 'sales'],
      'contact-code': ['erp_catalog_contact_code', 'code'], types: ['erp_catalog_contact_types', 'types'], seller: ['erp_catalog_seller_get', 'seller'],
      'payment-method': ['erp_catalog_payment_method_get', 'payment-method'], employee: ['erp_catalog_employee_get', 'employee'] }[kind];
    const idKey = kind === 'contact-comments' || kind === 'contact-sales' ? 'p_contact_id' : 'p_id';
    return read(single[0], route.id ? { [idKey]: route.id } : {}, single[1]);
  }
  if (params.size) invalid();
  const input = await body(request, kind === 'contact-import' ? 262144 : 32768);
  const keys = allowed => { if (!only(input, allowed)) invalid(); };
  if (kind === 'contacts' || kind === 'contact') {
    keys(kind === 'contact' ? ['command_id', 'expected_version', 'data', 'acknowledged_warnings'] : ['command_id', 'data', 'acknowledged_warnings']);
    if (kind === 'contact' && !version(input.expected_version)) invalid();
    return read('erp_catalog_contact_save', { p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_command_id: command(input.command_id),
      p_data: contactData(input.data, !route.id), p_acknowledged: Object.hasOwn(input, 'acknowledged_warnings') ? acknowledged(input.acknowledged_warnings) : null }, 'contact-record');
  }
  if (kind === 'contact-billing') {
    const data = input.data;
    if (!exact(input, ['command_id', 'expected_version', 'data']) || !Number.isInteger(input.expected_version) || input.expected_version < 0 || input.expected_version > 2147483646
      || !exact(data, ['same_as_general', 'billing_email']) || typeof data.same_as_general !== 'boolean' || (data.billing_email !== null && (typeof data.billing_email !== 'string' || data.billing_email.length > 254 || /[\x00-\x1f\x7f]/.test(data.billing_email)))) invalid();
    return read('erp_contact_billing_save', { p_contact_id: route.id, p_expected_version: input.expected_version, p_command_id: command(input.command_id), p_data: { same_as_general: data.same_as_general, billing_email: data.billing_email } }, 'contact-billing');
  }
  if (kind === 'contact-check') {
    keys(['id', 'data']); if (input.id !== undefined && input.id !== null && !UUID.test(input.id)) invalid();
    return read('erp_catalog_contact_check', { p_id: input.id ? input.id.toLowerCase() : null, p_data: contactData(input.data, false) }, 'check');
  }
  if (kind === 'contact-situation') {
    if (!exact(input, ['command_id', 'expected_version', 'situation']) || !version(input.expected_version) || !['A', 'I', 'S', 'E'].includes(input.situation)) invalid();
    return read('erp_catalog_contact_set_situation', { p_id: route.id, p_expected_version: input.expected_version, p_command_id: command(input.command_id), p_situation: input.situation }, 'contact-record');
  }
  if (kind === 'contact-seller') {
    if (!exact(input, ['command_id', 'expected_version', 'seller_id']) || !version(input.expected_version) || (input.seller_id !== null && (typeof input.seller_id !== 'string' || !UUID.test(input.seller_id)))) invalid();
    return read('erp_catalog_contact_set_seller', { p_id: route.id, p_expected_version: input.expected_version, p_command_id: command(input.command_id), p_seller_id: input.seller_id?.toLowerCase() ?? null }, 'contact-record');
  }
  if (kind === 'contact-comments') {
    if (!exact(input, ['command_id', 'body']) || typeof input.body !== 'string' || !input.body.trim() || input.body.length > 2000 || AREA_CONTROL.test(input.body)) invalid();
    return read('erp_catalog_contact_comment_add', { p_command_id: command(input.command_id), p_contact_id: route.id, p_body: input.body }, 'comment');
  }
  if (kind === 'contact-import') {
    if (!only(input, ['command_id', 'dry_run', 'rows']) || typeof input.dry_run !== 'boolean' || !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 50
      || (!input.dry_run && input.command_id === undefined) || (input.dry_run && input.command_id !== undefined)) invalid();
    const rows = input.rows.map(row => { if (!exact(row, ['row', 'data']) || !int(row.row, 1, 99999)) invalid(); return { row: row.row, data: contactData(row.data, true) }; });
    if (new Set(rows.map(row => row.row)).size !== rows.length) invalid();
    return read('erp_catalog_contact_import', { p_command_id: input.dry_run ? null : command(input.command_id), p_rows: rows, p_dry_run: input.dry_run }, 'import');
  }
  if (kind === 'contact-code') {
    if (!exact(input, ['command_id', 'expected_version', 'next_number']) || !int(input.expected_version, 0, 2147483646) || typeof input.next_number !== 'string' || !/^[1-9]\d{0,14}$/.test(input.next_number)) invalid();
    return read('erp_catalog_contact_code_set', { p_command_id: command(input.command_id), p_expected_version: input.expected_version, p_next_number: input.next_number }, 'code');
  }
  if (kind === 'types') {
    if (!exact(input, ['command_id', 'label']) || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 60 || CONTROL.test(input.label)) invalid();
    return read('erp_catalog_contact_type_create', { p_command_id: command(input.command_id), p_label: input.label.trim() }, 'type');
  }
  if (kind === 'type-delete') {
    if (!exact(input, ['command_id'])) invalid();
    return read('erp_catalog_contact_type_delete', { p_command_id: command(input.command_id), p_id: route.id }, 'type-delete');
  }
  if (kind === 'sellers' || kind === 'seller') {
    keys(kind === 'seller' ? ['command_id', 'expected_version', 'contact_expected_version', 'contact', 'settings', 'acknowledged_warnings'] : ['command_id', 'contact', 'settings', 'acknowledged_warnings']);
    if (kind === 'seller' && (!version(input.expected_version) || !version(input.contact_expected_version))) invalid();
    return read('erp_catalog_seller_save', { p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_contact_expected_version: route.id ? input.contact_expected_version : 0,
      p_command_id: command(input.command_id), p_contact: contactData(input.contact, !route.id), p_settings: sellerSettings(input.settings),
      p_acknowledged: Object.hasOwn(input, 'acknowledged_warnings') ? acknowledged(input.acknowledged_warnings) : null }, 'seller');
  }
  if (kind === 'seller-from-contact') {
    if (!exact(input, ['command_id', 'contact_id']) || typeof input.contact_id !== 'string' || !UUID.test(input.contact_id)) invalid();
    return read('erp_catalog_seller_from_contact', { p_command_id: command(input.command_id), p_contact_id: input.contact_id.toLowerCase() }, 'seller');
  }
  if (kind === 'payment-methods' || kind === 'payment-method') {
    keys(kind === 'payment-method' ? ['command_id', 'expected_version', 'data'] : ['command_id', 'data']);
    if (kind === 'payment-method' && !version(input.expected_version)) invalid();
    return read('erp_catalog_payment_method_save', { p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_command_id: command(input.command_id), p_data: paymentMethodData(input.data) }, 'payment-method-save');
  }
  if (kind === 'payment-method-action') {
    // 371: the default of each purpose (recebimentos, pagamentos, devoluções) besides the legacy "default".
    if (!exact(input, ['command_id', 'expected_version', 'action']) || !version(input.expected_version) || !PAYMENT_ACTIONS.includes(input.action)) invalid();
    return read('erp_catalog_payment_method_action', { p_id: route.id, p_expected_version: input.expected_version, p_command_id: command(input.command_id), p_action: input.action }, 'payment-method-action');
  }
  if (kind === 'employees' || kind === 'employee') {
    keys(kind === 'employee' ? ['command_id', 'expected_version', 'data', 'situation'] : ['command_id', 'data']);
    if (kind === 'employee' && (!version(input.expected_version) || (input.situation !== undefined && !['ativo', 'desligado'].includes(input.situation)) || (input.data === null && input.situation === undefined))) invalid();
    return read('erp_catalog_employee_save', { p_id: route.id, p_expected_version: route.id ? input.expected_version : 0, p_command_id: command(input.command_id),
      p_data: input.data === null && route.id ? null : employeeData(input.data), p_situation: input.situation ?? null }, 'employee-save');
  }
  return invalid();
}

// ---- Vendedor, forma de pagamento e funcionário: request bodies ----
export const SELLER_MODULES = ['clientes', 'clientes_limite_credito', 'clientes_ver_clientes', 'clientes_ver_fornecedores', 'clientes_ver_tecnicos', 'clientes_ver_transportadores',
  'clientes_ver_vendedores', 'clientes_ver_desenvolvedores', 'listas_precos', 'comissoes', 'controle_caixa', 'frente_caixa', 'pdv_registro_itens', 'pdv_registro_pagamento',
  'pdv_fechamento', 'pdv_editar_preco', 'pdv_exclusao_itens', 'pdv_alterar_forma_pagamento', 'pdv_gerenciador_pos', 'pedidos_venda', 'pedidos_exportar',
  'pedidos_alterar_forma_pagamento', 'visualizacao_lote', 'propostas', 'propostas_outros_vendedores', 'propostas_alterar_status', 'propostas_exportar',
  'gerenciador_arquivos', 'relatorio_controle_caixa', 'relatorio_saldos_estoque', 'relatorio_vendas', 'relatorio_visao_financeira_estoque', 'ordens_servico',
  'os_alterar_forma_pagamento', 'os_permitir_exclusao'];
const PERCENT = /^(0|[1-9]\d?|100)(\.\d{1,4})?$/;
const percent = (value, nullable) => value === null ? nullable : typeof value === 'string' && PERCENT.test(value) && !(value.startsWith('100') && /[1-9]/.test(value.slice(4)));
const HOUR = /^([01]\d|2[0-3]):[0-5]\d$/;
export function sellerSettings(value) {
  if (!exact(value, ['user_id', 'allow_unregistered_products', 'view_stock', 'access_hours_enabled', 'access_windows', 'modules', 'commission_rule', 'commission_mode', 'commission_rate', 'commission_bands', 'discount_limit', 'notes'])
    || (value.user_id !== null && (typeof value.user_id !== 'string' || !UUID.test(value.user_id))) || [value.allow_unregistered_products, value.view_stock, value.access_hours_enabled].some(flag => typeof flag !== 'boolean')
    || !Array.isArray(value.access_windows) || value.access_windows.length > 20
    || value.access_windows.some(row => !exact(row, ['start', 'end', 'days']) || !HOUR.test(row.start) || !HOUR.test(row.end) || row.start >= row.end || !Array.isArray(row.days) || !row.days.length
      || row.days.length > 7 || row.days.some(day => !int(day, 0, 6)) || new Set(row.days).size !== row.days.length)
    || !object(value.modules) || Object.entries(value.modules).some(([key, flag]) => !SELLER_MODULES.includes(key) || typeof flag !== 'boolean')
    || !['parcial', 'faturamento', 'primeira_parcela', 'ultima_parcela'].includes(value.commission_rule) || !['fixa', 'descontos'].includes(value.commission_mode)
    || !percent(value.commission_rate, true) || !percent(value.discount_limit, false) || !Array.isArray(value.commission_bands) || value.commission_bands.length > 20
    || value.commission_bands.some(band => !exact(band, ['discount_up_to', 'rate']) || !percent(band.discount_up_to, false) || !percent(band.rate, false))
    || (value.notes !== null && (typeof value.notes !== 'string' || value.notes.length > 4000 || AREA_CONTROL.test(value.notes)))) invalid();
  return { ...value, user_id: value.user_id?.toLowerCase() ?? null };
}
export const PAYMENT_TYPES = ['01', '02', '03', '04', '05', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '90', '91', '99'];
export function paymentMethodData(value) {
  const keys = ['description', 'payment_type', 'condition', 'destination', 'account_id', 'business_days', 'applicable', 'interest_rate', 'fine_rate', 'card_brand', 'card_integration', 'card_cnpj',
    'auto_settle', 'pix_integration', 'pix_cnpj', 'fee_type', 'fee_rate', 'fee_fixed', 'settlement_days'];
  const textValue = (raw, max) => raw === null || (typeof raw === 'string' && raw.length <= max && !CONTROL.test(raw));
  if (!exact(value, keys) || typeof value.description !== 'string' || !value.description.trim() || !textValue(value.description, 100) || !PAYMENT_TYPES.includes(value.payment_type)
    || !textValue(value.condition, 100) || !['contas', 'ficha', 'caixa'].includes(value.destination) || (value.account_id !== null && (typeof value.account_id !== 'string' || !UUID.test(value.account_id)))
    || typeof value.business_days !== 'boolean' || typeof value.auto_settle !== 'boolean' || !['pagamentos', 'recebimentos', 'ambos'].includes(value.applicable)
    || ![value.interest_rate, value.fine_rate, value.fee_rate].every(rate => percent(rate, true)) || (value.card_brand !== null && !['01', '02', '03', '04', '05', '06', '07', '08', '09', '99'].includes(value.card_brand))
    || (value.card_integration !== null && !['1', '2'].includes(value.card_integration)) || !textValue(value.card_cnpj, 20) || (value.pix_integration !== null && value.pix_integration !== 'sem')
    || !textValue(value.pix_cnpj, 20) || !['aliquota', 'fixa', 'aliquota_fixa'].includes(value.fee_type) || (value.fee_fixed !== null && (typeof value.fee_fixed !== 'string' || !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(value.fee_fixed)))
    || (value.settlement_days !== null && !int(value.settlement_days, 0, 365))) invalid();
  return { ...value, account_id: value.account_id?.toLowerCase() ?? null };
}
const EMPLOYEE_TEXT = { name: 200, cpf: 14, rg: 20, job_title: 100, pis: 14, ctps: 30, code: 30, phone: 40, mobile: 40, email: 254, emergency_phone: 40, postal_code: 20, state: 2, city: 100,
  district: 100, street: 200, number: 30, complement: 200 };
export function employeeData(value) {
  if (!exact(value, [...Object.keys(EMPLOYEE_TEXT), 'birth_date', 'admission_date', 'salary', 'notes'])) invalid();
  for (const [key, max] of Object.entries(EMPLOYEE_TEXT)) if (value[key] !== null && (typeof value[key] !== 'string' || value[key].length > max || CONTROL.test(value[key]))) invalid();
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.cpf !== 'string' || !value.cpf.trim()) invalid();
  for (const key of ['birth_date', 'admission_date']) if (value[key] !== null && (typeof value[key] !== 'string' || !isoDate(value[key]))) invalid();
  if (value.salary !== null && (typeof value.salary !== 'string' || !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(value.salary))) invalid();
  if (value.notes !== null && (typeof value.notes !== 'string' || value.notes.length > 4000 || AREA_CONTROL.test(value.notes))) invalid();
  return value;
}

// ---- Responses ----
const nullableText = (value, max, area = false) => value === null || (typeof value === 'string' && value.length <= max && !(area ? AREA_CONTROL : CONTROL).test(value));
const field = (value, key, check) => { const v = value[key] ?? null; if (!check(v)) bad(); return v; };
const uuidOrNull = v => v === null || (typeof v === 'string' && UUID.test(v));
const dateOrNull = v => v === null || isoDate(v);
function source(value, full) {
  if (value === null || value === undefined) return null;
  if (!only(value, ['system', 'source_id', 'state', 'applied_hash', 'latest_hash']) || value.system !== 'origin') bad();
  const safe = { system: 'origin' };
  for (const key of full ? ['source_id', 'state', 'applied_hash', 'latest_hash'] : ['source_id', 'state']) safe[key] = field(value, key, v => nullableText(v, 200));
  return safe;
}
const typeList = value => { if (!Array.isArray(value) || value.length > 40 || value.some(slug => typeof slug !== 'string' || !SLUG.test(slug)) || new Set(value).size !== value.length) bad(); return [...value]; };
const roleList = value => { if (!Array.isArray(value) || value.length > 3 || value.some(role => !ROLES.includes(role)) || new Set(value).size !== value.length) bad(); return [...value]; };
const situationOf = value => { if (!['A', 'I', 'S', 'E'].includes(value)) bad(); return value; };
/** Full contact (form): every field typed and bounded; decimals exact; dates ISO. `exported` rows carry no persons/source. */
export function contactRecord(value, { exported = false } = {}) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.entity !== 'contacts' || !version(value.version) || typeof value.active !== 'boolean'
    || !STAMP(value.created_at) || !STAMP(value.updated_at)) bad();
  const safe = { id: value.id, entity: 'contacts', version: value.version, active: value.active, created_at: value.created_at, updated_at: value.updated_at };
  for (const [key, max] of Object.entries(CONTACT_TEXT)) safe[key] = field(value, key, v => nullableText(v, max));
  for (const [key, max] of Object.entries(CONTACT_AREA)) safe[key] = field(value, key, v => nullableText(v, max, true));
  if (typeof safe.name !== 'string' || !safe.name.trim()) bad();
  for (const [key, options] of Object.entries(CONTACT_ENUMS)) safe[key] = field(value, key, v => key === 'situation' ? ['A', 'I', 'S', 'E'].includes(v) : key === 'credit_limit_mode' ? options.includes(v) : v === null || options.includes(v));
  if (typeof value.ie_exempt !== 'boolean') bad(); safe.ie_exempt = value.ie_exempt;
  for (const key of CONTACT_DATES) safe[key] = field(value, key, dateOrNull);
  safe.avg_tax_load = field(value, 'avg_tax_load', v => v === null || (typeof v === 'string' && /^(0|[1-9]\d?|100)\.\d{2}$/.test(v)));
  safe.credit_limit = field(value, 'credit_limit', v => v === null || (typeof v === 'string' && /^[1-9]\d{0,15}\.\d{2}$|^0\.(0[1-9]|[1-9]\d)$/.test(v)));
  if ((safe.credit_limit_mode === 'value') !== (safe.credit_limit !== null)) bad();
  for (const key of CONTACT_REFS) safe[key] = field(value, key, uuidOrNull);
  safe.finance_category_name = field(value, 'finance_category_name', v => nullableText(v, 200));
  safe.operation_nature_name = field(value, 'operation_nature_name', v => nullableText(v, 60));
  safe.seller_name = field(value, 'seller_name', v => nullableText(v, 200));
  safe.updated_by_name = field(value, 'updated_by_name', v => nullableText(v, 200));
  safe.seller_record_id = field(value, 'seller_record_id', uuidOrNull);
  safe.roles = roleList(value.roles); safe.types = typeList(value.types);
  if (!exported) {
    safe.source = source(value.source, true);
    if (!Array.isArray(value.persons) || value.persons.length > 20) bad();
    safe.persons = value.persons.map(person => {
      if (!exact(person, ['id', 'name', 'code', 'situation']) || typeof person.id !== 'string' || !UUID.test(person.id) || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 200
        || !nullableText(person.code, 100)) bad();
      return { id: person.id, name: person.name, code: person.code, situation: situationOf(person.situation) };
    });
  } else if (value.persons !== undefined || value.source !== undefined) bad();
  return safe;
}
const LIST_TEXT = { name: 200, code: 100, trade_name: 200, document: 30, email: 254, phone: 40, mobile: 40, city: 100, state: 2, seller_name: 200 };
function listItem(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.entity !== 'contacts' || !version(value.version) || typeof value.active !== 'boolean'
    || !STAMP(value.created_at) || !STAMP(value.updated_at) || typeof value.is_seller !== 'boolean') bad();
  const safe = { id: value.id, entity: 'contacts', version: value.version, active: value.active, created_at: value.created_at, updated_at: value.updated_at, is_seller: value.is_seller };
  for (const [key, max] of Object.entries(LIST_TEXT)) safe[key] = field(value, key, v => nullableText(v, max));
  if (typeof safe.name !== 'string' || !safe.name.trim()) bad();
  safe.situation = situationOf(value.situation);
  if (safe.active !== ['A', 'S'].includes(safe.situation)) bad();
  safe.person_type = field(value, 'person_type', v => v === null || ['F', 'J', 'E'].includes(v));
  safe.crt = field(value, 'crt', v => v === null || ['1', '2', '3', '4'].includes(v));
  safe.seller_id = field(value, 'seller_id', uuidOrNull);
  safe.next_visit = field(value, 'next_visit', dateOrNull);
  safe.roles = roleList(value.roles); safe.types = typeList(value.types); safe.source = source(value.source, false);
  return safe;
}
// Picker item (migration 158): the legacy record fields, always an active contact (Ativo or Sem movimento).
const OPTION_TEXT = { name: 200, code: 100, trade_name: 200, document: 30, ie: 30, email: 254, phone: 40, mobile: 40, postal_code: 20, street: 200, number: 30, complement: 200, district: 100, city: 100, state: 2 };
const CARRIER_MATCHES = ['role', 'origin', 'complement', 'untyped'];
function optionItem(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || value.entity !== 'contacts' || !version(value.version) || value.active !== true
    || !STAMP(value.created_at) || !STAMP(value.updated_at) || typeof value.has_notes !== 'boolean' || !int(value.persons, 0, 20)) bad();
  const safe = { id: value.id, entity: 'contacts', version: value.version, active: true, created_at: value.created_at, updated_at: value.updated_at, has_notes: value.has_notes, persons: value.persons };
  for (const [key, max] of Object.entries(OPTION_TEXT)) safe[key] = field(value, key, v => nullableText(v, max));
  if (typeof safe.name !== 'string' || !safe.name.trim()) bad();
  safe.person_type = field(value, 'person_type', v => v === null || ['F', 'J', 'E'].includes(v));
  safe.situation = situationOf(value.situation); if (!['A', 'S'].includes(safe.situation)) bad();
  safe.roles = roleList(value.roles); safe.types = typeList(value.types); safe.source = source(value.source, false);
  return safe;
}
const historyItem = item => {
  if (!exact(item, ['id', 'number', 'date', 'status', 'total']) || !UUID.test(item.id ?? '') || typeof item.number !== 'string' || !/^[1-9]\d{0,9}$/.test(item.number) || !dateOrNull(item.date)
    || !HISTORY_STATUSES.includes(item.status) || typeof item.total !== 'string' || !/^\d{1,12}\.\d{2}$/.test(item.total)) bad();
  return { ...item };
};
function pageCoherent(value, args, extraKeys) {
  // Total and page come from the same filtered set: a page inside the total is full or the last one, and one past it is empty.
  if (!Array.isArray(value.items) || value.page !== args.p_page || value.size !== args.p_size || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 100000000
    || value.items.length !== Math.max(0, Math.min(args.p_size, value.total - (args.p_page - 1) * args.p_size))) bad();
  for (const key of extraKeys) if (!Object.hasOwn(value, key)) bad();
}
const unique = items => { if (new Set(items.map(item => item.id)).size !== items.length) bad(); return items; };
const TYPE_ITEM = item => {
  if (!exact(item, ['id', 'slug', 'label', 'system', 'deletable', 'position', 'contacts']) || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.slug !== 'string' || !SLUG.test(item.slug)
    || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 60 || typeof item.system !== 'boolean' || typeof item.deletable !== 'boolean' || (item.system && item.deletable)
    || !int(item.position, 1, 100000) || !int(item.contacts, 0, 100000000)) bad();
  return { ...item };
};
function sellerDto(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.contact_id !== 'string' || !UUID.test(value.contact_id) || !version(value.version)
    || !STAMP(value.created_at) || !STAMP(value.updated_at)) bad();
  const settings = sellerSettings({ user_id: value.user_id ?? null, allow_unregistered_products: value.allow_unregistered_products, view_stock: value.view_stock, access_hours_enabled: value.access_hours_enabled,
    access_windows: value.access_windows, modules: value.modules, commission_rule: value.commission_rule, commission_mode: value.commission_mode, commission_rate: value.commission_rate ?? null,
    commission_bands: value.commission_bands, discount_limit: value.discount_limit, notes: value.notes ?? null });
  return { id: value.id, contact_id: value.contact_id, version: value.version, created_at: value.created_at, updated_at: value.updated_at, user_name: field(value, 'user_name', v => nullableText(v, 200)), ...settings };
}
const usersList = value => {
  if (!Array.isArray(value) || value.length > 500) bad();
  return value.map(user => { if (!exact(user, ['user_id', 'name', 'role']) || !UUID.test(user.user_id ?? '') || !nullableText(user.name, 200) || typeof user.role !== 'string') bad(); return { ...user }; });
};
const PAYMENT_ACTIONS = ['default', 'default_recebimentos', 'default_pagamentos', 'default_devolucoes', 'clear_devolucoes', 'activate', 'inactivate', 'delete'];
const PAYMENT_DEFAULTS = ['default_receipt', 'default_payment', 'default_return'];
function paymentMethod(value) {
  if (value === null) return null;
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !version(value.version) || typeof value.active !== 'boolean' || typeof value.is_default !== 'boolean'
    || !STAMP(value.created_at) || !STAMP(value.updated_at)) bad();
  // 371: the default of each purpose; a database before 371 has only is_default (the default of recebimentos since 371).
  const defaults = PAYMENT_DEFAULTS.every(key => value[key] === undefined) ? { default_receipt: value.is_default, default_payment: false, default_return: false }
    : Object.fromEntries(PAYMENT_DEFAULTS.map(key => [key, value[key]]));
  if (PAYMENT_DEFAULTS.some(key => typeof defaults[key] !== 'boolean') || value.is_default !== defaults.default_receipt || (!value.active && PAYMENT_DEFAULTS.some(key => defaults[key]))) bad();
  const data = paymentMethodData(Object.fromEntries(['description', 'payment_type', 'condition', 'destination', 'account_id', 'business_days', 'applicable', 'interest_rate', 'fine_rate', 'card_brand', 'card_integration',
    'card_cnpj', 'auto_settle', 'pix_integration', 'pix_cnpj', 'fee_type', 'fee_rate', 'fee_fixed', 'settlement_days'].map(key => [key, value[key] ?? null])).valueOf());
  return { id: value.id, version: value.version, active: value.active, is_default: value.is_default, ...defaults, created_at: value.created_at, updated_at: value.updated_at, account_name: field(value, 'account_name', v => nullableText(v, 200)), ...data };
}
const accounts = value => {
  if (!Array.isArray(value) || value.length > 500) bad();
  return value.map(account => { if (!exact(account, ['id', 'name', 'active']) || !UUID.test(account.id ?? '') || !nullableText(account.name, 200) || typeof account.active !== 'boolean') bad(); return { ...account }; });
};
function employee(value) {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id) || !version(value.version) || !['ativo', 'desligado'].includes(value.situation) || !STAMP(value.created_at) || !STAMP(value.updated_at)) bad();
  const data = employeeData(Object.fromEntries([...Object.keys(EMPLOYEE_TEXT), 'birth_date', 'admission_date', 'salary', 'notes'].map(key => [key, value[key] ?? null])));
  if (!/^\d{11}$/.test(data.cpf) || (data.salary !== null && !/^\d{1,16}\.\d{2}$/.test(data.salary))) bad();
  return { id: value.id, version: value.version, situation: value.situation, created_at: value.created_at, updated_at: value.updated_at, ...data };
}

export function contactResponse(value, route, operation) {
  if (!object(value) || value.data_mode !== 'erp_native') bad();
  const replayed = () => { if (value.replayed !== undefined && typeof value.replayed !== 'boolean') bad(); return value.replayed === true; };
  const { type, args } = operation;
  if (type === 'page') {
    pageCoherent(value, args, ['sort', 'situation', 'scoped']);
    if (value.entity !== 'contacts' || value.sort !== args.p_sort || value.situation !== args.p_situation || typeof value.scoped !== 'boolean') bad();
    return { entity: 'contacts', page: value.page, size: value.size, total: value.total, sort: value.sort, situation: value.situation, scoped: value.scoped, items: unique(value.items.map(listItem)), data_mode: 'erp_native' };
  }
  if (type === 'contact-billing') {
    const item = value.item, address = item?.address;
    if (value.entity !== 'contact_billing' || value.operational_effects !== false || !object(item) || item.contact_id !== route.id || typeof item.same_as_general !== 'boolean'
      || !nullableText(item.billing_email, 254) || typeof item.email_verified !== 'boolean' || typeof item.billing_email_verified !== 'boolean' || item.verification_available !== false
      || !Number.isInteger(item.version) || item.version < 0
      || !object(address) || !['geral', 'cobranca'].includes(address.source) || ['postal_code', 'state', 'city', 'district', 'street', 'number', 'complement', 'foreign_state'].some(key => !nullableText(address[key], 200))
      || (item.same_as_general && address.source !== 'geral')) bad();
    return { entity: 'contact_billing', item: { contact_id: item.contact_id, same_as_general: item.same_as_general, billing_email: item.billing_email, email_verified: item.email_verified, billing_email_verified: item.billing_email_verified,
      verification_available: false, address: Object.fromEntries(['source', 'postal_code', 'state', 'city', 'district', 'street', 'number', 'complement', 'foreign_state'].map(key => [key, address[key]])), version: item.version },
      replayed: replayed(), data_mode: 'erp_native', operational_effects: false };
  }
  if (type === 'contact-record') {
    if (value.entity !== 'contacts') bad();
    const record = contactRecord(value.record); if (route.id && record.id !== route.id) bad();
    if (args.p_situation && record.situation !== args.p_situation) bad();
    return { entity: 'contacts', record, data_mode: 'erp_native', replayed: replayed() };
  }
  if (type === 'check') {
    if (value.entity !== 'contacts' || !Array.isArray(value.warnings) || value.warnings.length > 4) bad();
    return { entity: 'contacts', data_mode: 'erp_native', warnings: value.warnings.map(item => {
      if (!object(item) || !WARNINGS.includes(item.code) || item.field !== { invalid_document: 'document', duplicate_document: 'document', invalid_father_cpf: 'father_cpf', invalid_mother_cpf: 'mother_cpf' }[item.code]) bad();
      if (item.code !== 'duplicate_document') {
        if (!exact(item, ['code', 'field', 'expected']) || !['cpf', 'cnpj', 'document'].includes(item.expected)) bad();
        return { code: item.code, field: item.field, expected: item.expected };
      }
      if (!only(item, ['code', 'field', 'total', 'matches', 'blocked']) || !Array.isArray(item.matches) || item.matches.length < 1 || item.matches.length > 5 || !int(item.total, item.matches.length, 100000000)
        || (item.blocked !== undefined && typeof item.blocked !== 'boolean')) bad();
      return { code: item.code, field: item.field, total: item.total, blocked: item.blocked === true, matches: item.matches.map(match => {
        if (!exact(match, ['id', 'name', 'code', 'active']) || !UUID.test(match.id ?? '') || typeof match.name !== 'string' || !match.name.trim() || match.name.length > 200 || !nullableText(match.code, 100) || typeof match.active !== 'boolean') bad();
        return { ...match };
      }) };
    }) };
  }
  if (type === 'export') {
    if (value.scope !== 'contacts_export' || value.kind !== args.p_kind || value.offset !== args.p_offset || value.limit !== args.p_limit || !int(value.total, 0, 10000) || !Array.isArray(value.items)
      || value.items.length !== Math.max(0, Math.min(args.p_limit, value.total - args.p_offset))) bad();
    return { scope: 'contacts_export', kind: value.kind, offset: value.offset, limit: value.limit, total: value.total, items: unique(value.items.map(item => contactRecord(item, { exported: true }))), data_mode: 'erp_native' };
  }
  const comment = item => { if (!exact(item, ['id', 'body', 'author_name', 'created_at']) || !UUID.test(item.id ?? '') || typeof item.body !== 'string' || !item.body || item.body.length > 2000 || AREA_CONTROL.test(item.body)
    || !nullableText(item.author_name, 200) || !STAMP(item.created_at)) bad(); return { ...item }; };
  if (type === 'comments') {
    if (value.scope !== 'contact_comments' || value.contact_id !== args.p_contact_id || typeof value.can_comment !== 'boolean' || !Array.isArray(value.items) || value.items.length > 200) bad();
    return { scope: 'contact_comments', contact_id: value.contact_id, can_comment: value.can_comment, items: unique(value.items.map(comment)), data_mode: 'erp_native' };
  }
  if (type === 'comment') {
    if (value.scope !== 'contact_comment' || value.contact_id !== args.p_contact_id) bad();
    return { scope: 'contact_comment', contact_id: value.contact_id, item: comment(value.item), replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'sales') {
    if (value.scope !== 'contact_sales' || value.contact_id !== args.p_contact_id || typeof value.visible !== 'boolean' || !Array.isArray(value.items) || value.items.length > 10 || (!value.visible && value.items.length)) bad();
    let coverage;try{coverage=documentNativeCoverage(value);}catch{bad();}
    return { scope: 'contact_sales', contact_id: value.contact_id, visible: value.visible, data_mode: 'erp_native', items: unique(value.items.map(historyItem)), ...coverage };
  }
  if (type === 'import') {
    if (value.scope !== 'contact_import' || value.dry_run !== args.p_dry_run || !Array.isArray(value.items) || value.items.length !== args.p_rows.length) bad();
    const expected = args.p_rows.map(row => row.row).sort((a, b) => a - b);
    const items = value.items.map((item, index) => {
      if (!only(item, ['row', 'status', 'code', 'field', 'record_id']) || item.row !== expected[index] || !['valid', 'created', 'invalid'].includes(item.status)
        || (item.status === 'created') !== (item.record_id !== undefined) || (item.record_id !== undefined && !UUID.test(item.record_id))
        || (item.status === 'invalid') !== (item.code !== undefined) || (item.code !== undefined && !['required', 'duplicate_document', 'not_visible', 'invalid'].includes(item.code))
        || (item.field !== undefined && (typeof item.field !== 'string' || !/^[a-z_]{1,40}$/.test(item.field))) || (args.p_dry_run && item.status === 'created') || (!args.p_dry_run && item.status !== 'created')) bad();
      return { ...item };
    });
    return { scope: 'contact_import', dry_run: value.dry_run, replayed: replayed(), items, data_mode: 'erp_native' };
  }
  if (type === 'code') {
    if (value.scope !== 'contact_code' || !['manual', 'sequencial'].includes(value.mode) || typeof value.next_number !== 'string' || !/^[1-9]\d{0,15}$/.test(value.next_number)
      || !int(value.version, 0, 2147483647) || typeof value.highest_used !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value.highest_used) || typeof value.can_edit !== 'boolean') bad();
    return { scope: 'contact_code', mode: value.mode, next_number: value.next_number, version: value.version, highest_used: value.highest_used, can_edit: value.can_edit, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'types') {
    if (value.scope !== 'contact_types' || typeof value.can_create !== 'boolean' || typeof value.can_delete !== 'boolean' || !Array.isArray(value.items) || value.items.length > 100) bad();
    return { scope: 'contact_types', can_create: value.can_create, can_delete: value.can_delete, items: unique(value.items.map(TYPE_ITEM)), data_mode: 'erp_native' };
  }
  if (type === 'type') {
    if (value.scope !== 'contact_type') bad();
    const item = TYPE_ITEM(value.item); if (item.label !== args.p_label || item.system) bad();
    return { scope: 'contact_type', item, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'type-delete') {
    if (value.scope !== 'contact_type_delete' || value.id !== args.p_id || !int(value.unlinked, 0, 100000000)) bad();
    return { scope: 'contact_type_delete', id: value.id, unlinked: value.unlinked, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'seller-page') {
    pageCoherent(value, args, ['sort', 'situation', 'can_write']);
    if (value.entity !== 'sellers' || value.sort !== args.p_sort || value.situation !== args.p_situation || typeof value.can_write !== 'boolean') bad();
    return { entity: 'sellers', page: value.page, size: value.size, total: value.total, sort: value.sort, situation: value.situation, can_write: value.can_write, data_mode: 'erp_native',
      items: unique(value.items.map(item => { const safe = listItem(item); if (!UUID.test(item.seller_id ?? '') || !version(item.seller_version)) bad(); return { ...safe, seller_id: item.seller_id, seller_version: item.seller_version }; })) };
  }
  if (type === 'seller') {
    if (value.entity !== 'sellers') bad();
    const seller = sellerDto(value.seller), contact = contactRecord(value.contact);
    if (seller.contact_id !== contact.id || contact.seller_record_id !== seller.id || (route.id && seller.id !== route.id) || !contact.types.includes('seller')) bad();
    if (Object.hasOwn(args, 'p_contact_id') && seller.contact_id !== args.p_contact_id) bad();
    const read = Object.keys(args).length === 1;
    if (read && (typeof value.can_write !== 'boolean')) bad();
    return { entity: 'sellers', seller, contact, data_mode: 'erp_native', ...(read ? { can_write: value.can_write, users: usersList(value.users) } : { replayed: replayed() }) };
  }
  if (type === 'seller-options') {
    if (value.scope !== 'seller_options' || !Array.isArray(value.items) || value.items.length > 25) bad();
    return { scope: 'seller_options', users: usersList(value.users), data_mode: 'erp_native', items: unique(value.items.map(item => {
      if (!exact(item, ['id', 'name', 'code']) || !UUID.test(item.id ?? '') || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || !nullableText(item.code, 100)) bad();
      return { ...item };
    })) };
  }
  if (type === 'payment-page') {
    pageCoherent(value, args, ['can_write', 'accounts']);
    if (value.entity !== 'payment_methods' || typeof value.can_write !== 'boolean') bad();
    const items = unique(value.items.map(paymentMethod));
    if (args.p_active !== null && items.some(item => item.active !== args.p_active)) bad();
    return { entity: 'payment_methods', page: value.page, size: value.size, total: value.total, can_write: value.can_write, accounts: accounts(value.accounts), items, data_mode: 'erp_native' };
  }
  if (type === 'payment-method') {
    if (value.entity !== 'payment_methods' || typeof value.can_write !== 'boolean') bad();
    const item = paymentMethod(value.item); if (!item || item.id !== route.id) bad();
    return { entity: 'payment_methods', can_write: value.can_write, item, accounts: accounts(value.accounts), data_mode: 'erp_native' };
  }
  if (type === 'payment-method-save') {
    if (value.entity !== 'payment_methods') bad();
    const item = paymentMethod(value.item); if (!item || (route.id && item.id !== route.id)) bad();
    return { entity: 'payment_methods', item, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'payment-method-action') {
    if (value.entity !== 'payment_methods' || value.id !== route.id || value.action !== args.p_action || !uuidOrNull(value.previous_default ?? null)) bad();
    const item = paymentMethod(value.item ?? null);
    const flag = { default_recebimentos: 'default_receipt', default_pagamentos: 'default_payment', default_devolucoes: 'default_return' }[args.p_action];
    if ((args.p_action === 'delete') !== (item === null) || (item && item.id !== route.id) || (item && args.p_action === 'default' && !item.default_receipt && !item.default_payment)
      || (item && flag && !item[flag]) || (item && args.p_action === 'clear_devolucoes' && item.default_return)
      || (item && args.p_action === 'activate' && !item.active) || (item && args.p_action === 'inactivate' && item.active)) bad();
    return { entity: 'payment_methods', id: value.id, action: value.action, item, previous_default: value.previous_default ?? null, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'employee-page') {
    pageCoherent(value, args, ['situation']);
    if (value.entity !== 'employees' || value.situation !== args.p_situation) bad();
    return { entity: 'employees', page: value.page, size: value.size, total: value.total, situation: value.situation, data_mode: 'erp_native', items: unique(value.items.map(item => {
      if (!exact(item, ['id', 'version', 'name', 'cpf', 'job_title', 'admission_date', 'situation']) || !UUID.test(item.id ?? '') || !version(item.version) || typeof item.name !== 'string' || !item.name.trim()
        || item.name.length > 200 || typeof item.cpf !== 'string' || !/^\d{11}$/.test(item.cpf) || !nullableText(item.job_title, 100) || !dateOrNull(item.admission_date) || !['ativo', 'desligado'].includes(item.situation)
        || (args.p_situation !== 'todas' && item.situation !== (args.p_situation === 'ativos' ? 'ativo' : 'desligado'))) bad();
      return { ...item };
    })) };
  }
  if (type === 'employee') {
    if (value.entity !== 'employees') bad();
    const item = employee(value.item); if (item.id !== route.id) bad();
    return { entity: 'employees', item, data_mode: 'erp_native' };
  }
  if (type === 'employee-save') {
    if (value.entity !== 'employees' || !exact(value.item, ['id', 'version']) || !UUID.test(value.item.id ?? '') || !version(value.item.version) || (route.id && value.item.id !== route.id)) bad();
    return { entity: 'employees', item: { id: value.item.id, version: value.item.version }, replayed: replayed(), data_mode: 'erp_native' };
  }
  if (type === 'options') {
    if (value.scope !== 'contact_options' || value.role !== args.p_role || value.limit !== args.p_limit || typeof value.scoped !== 'boolean' || typeof value.has_more !== 'boolean'
      || !Array.isArray(value.items) || value.items.length > args.p_limit || (value.has_more && value.items.length !== args.p_limit)) bad();
    return { scope: 'contact_options', role: value.role, limit: value.limit, scoped: value.scoped, has_more: value.has_more, data_mode: 'erp_native',
      // 202610200241: the Transportador role also lists the contacts without any role (Sem tipo definido, e.g. mirrored from the Origin).
      items: unique(value.items.map(item => { const safe = optionItem(item);
        // Leva H (350, EST-057): for the Transportador, why the contact is listed (papel, tipo do Origin, complemento do Brufap, sem tipo).
        // A database before 350 sends no carrier_match: then only the papel or a contact without any role.
        const match = Object.hasOwn(item, 'carrier_match') ? item.carrier_match : undefined;
        if (match !== undefined && (args.p_role !== 'carrier' || !CARRIER_MATCHES.includes(match) || (match === 'role') !== safe.roles.includes('carrier') || (match === 'untyped' && safe.roles.length !== 0))) bad();
        if (args.p_role && args.p_role !== 'technician' && !safe.roles.includes(args.p_role) && !(args.p_role === 'carrier' && (match !== undefined ? match !== 'role' : safe.roles.length === 0))) bad();
        return match === undefined ? safe : { ...safe, carrier_match: match }; })) };
  }
  if (type === 'summary') {
    if (value.scope !== 'contact_summary' || value.id !== route.id || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || !nullableText(value.code, 100)
      || !nullableText(value.notes, 4000, true) || !nullableText(value.contact_info, 400, true) || !Array.isArray(value.persons) || value.persons.length > 20) bad();
    return { scope: 'contact_summary', id: value.id, name: value.name, code: value.code, situation: situationOf(value.situation), notes: value.notes, contact_info: value.contact_info, data_mode: 'erp_native',
      persons: unique(value.persons.map(person => {
        if (!exact(person, ['id', 'name', 'code', 'situation', 'visible', 'email', 'phone', 'mobile']) || !UUID.test(person.id ?? '') || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 200
          || !nullableText(person.code, 100) || typeof person.visible !== 'boolean' || !nullableText(person.email, 254) || !nullableText(person.phone, 40) || !nullableText(person.mobile, 40)
          || (!person.visible && (person.email !== null || person.phone !== null || person.mobile !== null))) bad();
        return { ...person, situation: situationOf(person.situation) };
      })) };
  }
  if (type === 'history') {
    if (value.scope !== 'contact_history' || value.contact_id !== args.p_contact_id || value.kind !== args.p_kind || typeof value.visible !== 'boolean' || !Array.isArray(value.items) || value.items.length > 10
      || (!value.visible && value.items.length)) bad();
    let coverage;try{coverage=documentNativeCoverage(value);}catch{bad();}
    return { scope: 'contact_history', contact_id: value.contact_id, kind: value.kind, visible: value.visible, data_mode: 'erp_native', items: unique(value.items.map(historyItem)), ...coverage };
  }
  if (type === 'labels') {
    if (value.scope !== 'contact_labels' || !Array.isArray(value.templates) || value.templates.length < 1 || value.templates.length > 101 || !Array.isArray(value.items) || value.items.length !== args.p_ids.length) bad();
    const fields = Object.keys(LABEL_FIELDS.contato);
    const templates = value.templates.map((template, index) => {
      if (!exact(template, ['id', 'type', 'description', 'default', 'config', 'version', 'updated_at']) || template.type !== 'contato' || typeof template.description !== 'string' || !template.description.trim()
        || template.description.length > 80 || CONTROL.test(template.description) || typeof template.default !== 'boolean' || !labelConfigValid('contato', template.config)) bad();
      if (index === 0 ? !template.default || template.id !== 'padrao-contato' || template.version !== 0 || template.updated_at !== null
        : template.default || !UUID.test(template.id ?? '') || !version(template.version) || !STAMP(template.updated_at)) bad();
      return structuredClone(template);
    });
    if (new Set(templates.map(template => template.id)).size !== templates.length) bad();
    return { scope: 'contact_labels', templates, data_mode: 'erp_native', items: value.items.map((item, index) => {
      if (!exact(item, ['id', 'values']) || item.id !== args.p_ids[index] || !exact(item.values, fields) || fields.some(key => !nullableText(item.values[key], 200))) bad();
      return { id: item.id, values: { ...item.values } };
    }) };
  }
  return bad();
}
/** 202610200241 Cadastros › Vendedores: the users linked before and after the seller save and whether each needs the access gate
 * (the Worker writes app_metadata.brufap_access_gate for each). A database before 241 sends none; a malformed list is a 502. */
export function sellerAccessGates(value) {
  const gates = value?.access_gates;
  if (gates === undefined) return [];
  if (!Array.isArray(gates) || gates.length > 2) bad();
  const out = gates.map(gate => {
    if (!exact(gate, ['user_id', 'gate_required']) || typeof gate.user_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(gate.user_id) || typeof gate.gate_required !== 'boolean') bad();
    return { user_id: gate.user_id, gate_required: gate.gate_required };
  });
  if (new Set(out.map(gate => gate.user_id)).size !== out.length) bad();
  return out;
}
