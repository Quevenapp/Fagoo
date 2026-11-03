/** Cadastros > Contas Financeiras and Categorias Financeiras (SQL 135). SQL is the authority for RBAC, CAS and the tree rules. */
import { FinanceError } from './finance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export const ACCOUNT_TYPES = ['checking', 'savings', 'cash', 'receiving', 'other', 'integration'];
const WRITABLE_TYPES = ACCOUNT_TYPES.slice(0, 5);
export const DRE_GROUPS = { receivable: ['none', 'gross_revenue', 'financial_revenue', 'other_revenue'], payable: ['none', 'revenue_deductions', 'operating_expenses', 'financial_expenses', 'other_expenses', 'income_taxes'] };
export const CATEGORY_DEFAULT_KEYS = ['receipt_additions', 'receipt_interest', 'receipt_discounts', 'receipt_fees', 'payment_additions', 'payment_interest', 'payment_discounts', 'sale', 'service', 'transfer_in', 'purchase'];
export const ACCOUNT_ACTIONS = ['account_create', 'account_update', 'account_set_active', 'account_set_default', 'account_delete'];
export const CATEGORY_ACTIONS = ['category_create', 'category_update', 'category_set_active', 'category_delete', 'category_move', 'category_set_default', 'category_import'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw new FinanceError(400, 'ERP_INVALID_QUERY'); };
const upstreamInvalid = () => { throw new FinanceError(502, 'ERP_UPSTREAM_INVALID_RESPONSE'); };
const exact = (value, keys, required = []) => { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) invalid(); };
const id = (value, nullable = false) => { if (nullable && value === null) return; if (typeof value !== 'string' || !UUID.test(value)) invalid(); };
const version = (value, create = false) => { if (!Number.isInteger(value) || value < (create ? 0 : 1) || value > 2147483647) invalid(); };
function day(value) {
  if (typeof value !== 'string' || !DAY.test(value) || value < '1900-01-01' || value > '2100-12-31') invalid();
  const time = Date.parse(`${value}T00:00:00Z`); if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid();
}
const text = (value, max, { nullable = false, pattern = null } = {}) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value) || (pattern && !pattern.test(value))) invalid();
};

function validateAccount(action, data) {
  if (action === 'account_create' || action === 'account_update') {
    const keys = ['account_type', 'institution_code', 'institution_name', 'name', 'agency', 'account_number', 'account_digit', 'start_on', 'opening_cents', 'default_movements'];
    exact(data, action === 'account_create' ? keys : ['id', 'expected_version', 'default_boleto', ...keys], ['account_type', 'name', 'start_on', ...(action === 'account_create' ? ['opening_cents'] : ['id', 'expected_version'])]);
    if (action === 'account_update') { id(data.id); version(data.expected_version); }
    if (!WRITABLE_TYPES.includes(data.account_type)) invalid();
    text(data.name, action === 'account_create' ? 50 : 200); day(data.start_on);
    if (data.institution_code !== undefined) text(data.institution_code, 3, { nullable: true, pattern: /^\d{3}$/ });
    if (data.institution_name !== undefined) text(data.institution_name, 80, { nullable: true });
    if ((data.institution_code ?? null) === null !== ((data.institution_name ?? null) === null)) invalid();
    if (['checking', 'savings', 'receiving'].includes(data.account_type) && (data.institution_code ?? null) === null) invalid();
    if (data.agency !== undefined) text(data.agency, 10, { nullable: true, pattern: /^[0-9A-Za-z-]+$/ });
    if (data.account_number !== undefined) text(data.account_number, 20, { nullable: true, pattern: /^[0-9A-Za-z.-]+$/ });
    if (data.account_digit !== undefined) text(data.account_digit, 2, { nullable: true, pattern: /^[0-9A-Za-z]+$/ });
    if (['checking', 'savings'].includes(data.account_type) && [data.agency, data.account_number, data.account_digit].some(value => (value ?? null) === null)) invalid();
    if (data.opening_cents !== undefined && (typeof data.opening_cents !== 'string' || !/^-?\d{1,15}$/.test(data.opening_cents) || data.opening_cents === '-0')) invalid();
    if (data.default_movements !== undefined && typeof data.default_movements !== 'boolean') invalid();
    if (data.default_boleto !== undefined && (typeof data.default_boleto !== 'boolean' || (data.default_boleto && !['checking', 'savings'].includes(data.account_type)))) invalid();
    return data;
  }
  if (action === 'account_set_active') { exact(data, ['id', 'expected_version', 'active'], ['id', 'expected_version', 'active']); id(data.id); version(data.expected_version); if (typeof data.active !== 'boolean') invalid(); return data; }
  if (action === 'account_set_default') {
    exact(data, ['id', 'expected_version', 'target', 'value'], ['id', 'expected_version', 'target', 'value']); id(data.id); version(data.expected_version);
    if (!['movements', 'boleto'].includes(data.target) || typeof data.value !== 'boolean') invalid(); return data;
  }
  exact(data, ['id', 'expected_version'], ['id', 'expected_version']); id(data.id); version(data.expected_version); return data;
}

function validateCategory(action, data) {
  if (action === 'category_create') {
    exact(data, ['kind', 'parent_id', 'name', 'dre_group'], ['kind', 'name']);
    if (!['receivable', 'payable'].includes(data.kind)) invalid(); text(data.name, 100);
    if (data.parent_id !== undefined) id(data.parent_id, true);
    if (data.dre_group !== undefined && data.dre_group !== null && (data.parent_id || !DRE_GROUPS[data.kind].includes(data.dre_group))) invalid();
    return data;
  }
  if (action === 'category_update') {
    exact(data, ['id', 'expected_version', 'name', 'dre_group'], ['id', 'expected_version', 'name']); id(data.id); version(data.expected_version); text(data.name, 100);
    if (data.dre_group !== undefined && data.dre_group !== null && !Object.values(DRE_GROUPS).flat().includes(data.dre_group)) invalid();
    return data;
  }
  if (action === 'category_set_active') { exact(data, ['id', 'expected_version', 'active'], ['id', 'expected_version', 'active']); id(data.id); version(data.expected_version); if (typeof data.active !== 'boolean') invalid(); return data; }
  if (action === 'category_delete') { exact(data, ['id', 'expected_version'], ['id', 'expected_version']); id(data.id); version(data.expected_version); return data; }
  if (action === 'category_move') {
    exact(data, ['id', 'expected_version', 'target_id', 'confirmed'], ['id', 'expected_version', 'target_id', 'confirmed']); id(data.id); version(data.expected_version); id(data.target_id);
    if (data.confirmed !== true || data.id.toLowerCase() === data.target_id.toLowerCase()) invalid(); return data;
  }
  if (action === 'category_set_default') {
    exact(data, ['key', 'category_id', 'expected_version'], ['key', 'category_id', 'expected_version']);
    if (!CATEGORY_DEFAULT_KEYS.includes(data.key)) invalid(); id(data.category_id, true); version(data.expected_version); return data;
  }
  exact(data, ['kind', 'rows'], ['kind', 'rows']);
  if (!['receivable', 'payable'].includes(data.kind) || !Array.isArray(data.rows) || data.rows.length < 1 || data.rows.length > 500) invalid();
  for (const row of data.rows) {
    exact(row, ['name', 'parent', 'dre_group'], ['name']); text(row.name, 100);
    if (row.parent !== undefined) text(row.parent, 100, { nullable: true });
    if (row.dre_group !== undefined && row.dre_group !== null && ((row.parent ?? null) !== null || !DRE_GROUPS[data.kind].includes(row.dre_group))) invalid();
  }
  return data;
}

/** POST /v1/financeiro/actions/{account_*|category_*}: validated body for the 135 RPCs, or null for other actions. */
export function registryAction(action, value) {
  if (ACCOUNT_ACTIONS.includes(action)) return { kind: 'execute', action, registry: 'accounts', rpc: 'erp_finance_account_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validateAccount(action, value.data) } };
  if (CATEGORY_ACTIONS.includes(action)) return { kind: 'execute', action, registry: 'categories', rpc: 'erp_finance_category_execute', args: { p_command_id: value.command_id, p_action: action, p_data: validateCategory(action, value.data) } };
  return null;
}

const ACCOUNT_PAGE_PARAMS = ['page', 'limit', 'q', 'situacao', 'tipos'];
/** GET /v1/financeiro/contas-financeiras[/{id}] and /v1/financeiro/categorias-arvore?kind=…; null for other paths. */
export function parseRegistryRead(url) {
  const account = /^\/v1\/financeiro\/contas-financeiras(?:\/([^/]+))?$/.exec(url.pathname);
  if (account) {
    if (account[1] !== undefined) { if (!UUID.test(account[1])) throw new FinanceError(404, 'ERP_NOT_FOUND'); if (url.search) invalid(); return { kind: 'account_detail', registry: 'accounts', rpc: 'erp_finance_account_detail', args: { p_id: account[1].toLowerCase() } }; }
    const params = url.searchParams;
    for (const key of params.keys()) if (!ACCOUNT_PAGE_PARAMS.includes(key) || params.getAll(key).length !== 1) invalid();
    const page = params.get('page'), limit = params.get('limit') ?? '100', query = params.get('q'), situation = params.get('situacao'), types = params.get('tipos');
    if (!/^[1-9]\d{0,5}$/.test(page ?? '') || Number(page) > 100000 || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) invalid();
    if (query !== null && (query.length > 120 || CONTROL.test(query))) invalid();
    if (situation !== null && !['ativo', 'inativo'].includes(situation)) invalid();
    let list = null;
    if (types !== null) { list = types.split(','); if (!list.length || list.length > 6 || new Set(list).size !== list.length || list.some(type => !ACCOUNT_TYPES.includes(type))) invalid(); }
    return { kind: 'account_page', registry: 'accounts', rpc: 'erp_finance_account_page', args: { p_page: Number(page), p_limit: Number(limit), p_query: query?.trim() || null, p_active: situation === null ? null : situation === 'ativo', p_types: list } };
  }
  if (url.pathname === '/v1/financeiro/categorias-arvore') {
    const params = url.searchParams;
    for (const key of params.keys()) if (key !== 'kind' || params.getAll(key).length !== 1) invalid();
    const kind = params.get('kind'); if (!['receivable', 'payable'].includes(kind)) invalid();
    return { kind: 'category_tree', registry: 'categories', rpc: 'erp_finance_category_tree', args: { p_kind: kind } };
  }
  return null;
}

const cents = (value, signed = false) => typeof value === 'string' && (signed ? /^-?\d{1,30}$/ : /^\d{1,30}$/).test(value);
const textOk = (value, max, nullable = false) => (nullable && value === null) || (typeof value === 'string' && value.length <= max);
const dayOk = (value, nullable = false) => (nullable && value === null) || (typeof value === 'string' && DAY.test(value));
const intOk = (value, min = 1) => Number.isSafeInteger(value) && value >= min && value <= 2147483647;
function projectAccount(value) {
  if (!object(value) || !UUID.test(value.id ?? '') || !textOk(value.name, 200) || !['bank', 'cash', 'other'].includes(value.kind) || !ACCOUNT_TYPES.includes(value.account_type)
    || !textOk(value.institution_code, 3, true) || !textOk(value.institution_name, 80, true) || !textOk(value.agency, 10, true) || !textOk(value.account_number, 20, true) || !textOk(value.account_digit, 2, true)
    || !dayOk(value.start_on, true) || typeof value.active !== 'boolean' || typeof value.default_movements !== 'boolean' || typeof value.default_boleto !== 'boolean'
    || !['default', 'active', 'none'].includes(value.boleto) || (value.boleto === 'default') !== value.default_boleto || typeof value.opening_recorded !== 'boolean'
    || (value.opening_cents !== null && !cents(value.opening_cents, true)) || !cents(value.balance_cents, true) || !dayOk(value.first_movement_on, true) || typeof value.in_use !== 'boolean'
    || !intOk(value.version) || !textOk(value.created_at, 100) || !textOk(value.updated_at, 100)) upstreamInvalid();
  let cnab = null;
  if (value.cnab !== null) {
    if (!object(value.cnab) || !['bank', 'agency', 'account', 'account_digit'].every(key => textOk(value.cnab[key], 20, true))) upstreamInvalid();
    cnab = { bank: value.cnab.bank, agency: value.cnab.agency, account: value.cnab.account, account_digit: value.cnab.account_digit };
  }
  if ((value.boleto === 'none' && cnab !== null) || (value.boleto === 'active' && cnab === null)) upstreamInvalid();
  return { id: value.id, name: value.name, kind: value.kind, account_type: value.account_type, institution_code: value.institution_code, institution_name: value.institution_name,
    agency: value.agency, account_number: value.account_number, account_digit: value.account_digit, start_on: value.start_on, active: value.active,
    default_movements: value.default_movements, default_boleto: value.default_boleto, boleto: value.boleto, opening_recorded: value.opening_recorded, opening_cents: value.opening_cents,
    balance_cents: value.balance_cents, first_movement_on: value.first_movement_on, in_use: value.in_use, cnab, version: value.version, created_at: value.created_at, updated_at: value.updated_at };
}
function projectCategory(value, kind) {
  if (!object(value) || !UUID.test(value.id ?? '') || (value.parent_id !== null && !UUID.test(value.parent_id ?? '')) || !textOk(value.name, 200) || (kind && value.kind !== kind)
    || !['receivable', 'payable'].includes(value.kind) || (value.dre_group !== null && (value.parent_id !== null || !DRE_GROUPS[value.kind].includes(value.dre_group)))
    || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.depth) || value.depth < 1 || value.depth > (value.kind === 'payable' ? 3 : 2) || (value.depth === 1) !== (value.parent_id === null)
    || !Array.isArray(value.defaults) || value.defaults.some(key => !CATEGORY_DEFAULT_KEYS.includes(key)) || !Number.isSafeInteger(value.children) || value.children < 0
    || typeof value.in_use !== 'boolean' || !intOk(value.version) || !textOk(value.updated_at, 100)) upstreamInvalid();
  return { id: value.id, parent_id: value.parent_id, name: value.name, kind: value.kind, dre_group: value.dre_group, active: value.active, depth: value.depth, defaults: [...value.defaults],
    children: value.children, in_use: value.in_use, version: value.version, updated_at: value.updated_at };
}
function projectDefaults(value) {
  if (!object(value) || Object.keys(value).length !== CATEGORY_DEFAULT_KEYS.length || CATEGORY_DEFAULT_KEYS.some(key => !object(value[key]) || (value[key].category_id !== null && !UUID.test(value[key].category_id ?? '')) || !intOk(value[key].version))) upstreamInvalid();
  return Object.fromEntries(CATEGORY_DEFAULT_KEYS.map(key => [key, { category_id: value[key].category_id, version: value[key].version }]));
}

/** Projects the 135 responses; anything outside the contract is a 502. */
export function projectRegistryResult(route, value) {
  if (route.kind === 'account_page') {
    const { p_page: page, p_limit: limit, p_active: active, p_types: types } = route.args;
    if (value.entity !== 'financial_accounts' || value.page !== page || value.limit !== limit || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
      || value.items.length !== Math.max(0, Math.min(limit, value.total - (page - 1) * limit))) upstreamInvalid();
    const seen = new Set();
    const items = value.items.map(item => { const account = projectAccount(item); if (seen.has(account.id) || (active !== null && account.active !== active) || (types && !types.includes(account.account_type))) upstreamInvalid(); seen.add(account.id); return account; });
    return { entity: 'financial_accounts', items, page, limit, total: value.total, data_mode: 'erp_native' };
  }
  if (route.kind === 'account_detail') { if (value.entity !== 'financial_accounts') upstreamInvalid(); const record = projectAccount(value.record); if (record.id !== route.args.p_id) upstreamInvalid(); return { entity: 'financial_accounts', record, data_mode: 'erp_native' }; }
  if (route.kind === 'category_tree') {
    if (value.entity !== 'category_tree' || value.kind !== route.args.p_kind || !Array.isArray(value.items) || value.items.length > 2000) upstreamInvalid();
    const items = value.items.map(item => projectCategory(item, route.args.p_kind)), ids = new Set(items.map(item => item.id));
    if (ids.size !== items.length || items.some(item => item.parent_id !== null && !ids.has(item.parent_id))) upstreamInvalid();
    return { entity: 'category_tree', kind: value.kind, items, defaults: projectDefaults(value.defaults), data_mode: 'erp_native' };
  }
  // Commands.
  if (value.action !== route.action || typeof value.replayed !== 'boolean') upstreamInvalid();
  const output = { action: value.action, replayed: value.replayed, data_mode: 'erp_native' };
  if (route.registry === 'accounts') {
    if (value.entity !== 'financial_accounts') upstreamInvalid();
    if (route.action === 'account_delete') { if (!object(value.record) || value.record.deleted !== true || value.record.id !== route.args.p_data.id.toLowerCase()) upstreamInvalid(); return { ...output, entity: 'financial_accounts', record: { id: value.record.id, deleted: true } }; }
    const record = projectAccount(value.record); if (route.action !== 'account_create' && record.id !== route.args.p_data.id.toLowerCase()) upstreamInvalid();
    return { ...output, entity: 'financial_accounts', record };
  }
  if (value.entity !== 'categories_tree') upstreamInvalid();
  if (route.action === 'category_import') {
    if (!Array.isArray(value.created) || value.created.length > 500 || value.created.some(item => typeof item !== 'string' || !UUID.test(item)) || !Number.isSafeInteger(value.skipped) || value.skipped < 0
      || value.created.length + value.skipped !== route.args.p_data.rows.length) upstreamInvalid();
    return { ...output, entity: 'categories_tree', created: [...value.created], skipped: value.skipped };
  }
  if (route.action === 'category_set_default') {
    const record = value.record; if (!object(record) || record.key !== route.args.p_data.key || record.category_id !== (route.args.p_data.category_id?.toLowerCase() ?? null) || !intOk(record.version, 2)) upstreamInvalid();
    return { ...output, entity: 'categories_tree', record: { key: record.key, category_id: record.category_id, version: record.version } };
  }
  if (route.action === 'category_delete') { if (!object(value.record) || value.record.deleted !== true || value.record.id !== route.args.p_data.id.toLowerCase()) upstreamInvalid(); return { ...output, entity: 'categories_tree', record: { id: value.record.id, deleted: true } }; }
  const record = projectCategory(value.record);
  if (route.action !== 'category_create' && record.id !== route.args.p_data.id.toLowerCase()) upstreamInvalid();
  if (route.action === 'category_move') {
    const target = projectCategory(value.target), moved = value.moved;
    if (target.id !== route.args.p_data.target_id.toLowerCase() || !object(moved) || ['titles', 'borderos', 'settlements', 'movements'].some(key => !Number.isSafeInteger(moved[key]) || moved[key] < 0)) upstreamInvalid();
    return { ...output, entity: 'categories_tree', record, target, moved: { titles: moved.titles, borderos: moved.borderos, settlements: moved.settlements, movements: moved.movements } };
  }
  return { ...output, entity: 'categories_tree', record };
}
