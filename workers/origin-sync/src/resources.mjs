/**
 * Read-only resource plan, verified against the official API v3 OpenAPI on
 *
 * `id` is a polling/checkpoint variant. `entity` is the canonical identity
 * namespace shared across variants and the backup; never deduplicate by id.
 * This is polling, not webhook coverage. A missing row/page is not a deletion.
 * Deleted catalog variants are full sweeps: deletion timestamps are not assumed.
 * Other resources have no generic deleted-record feed in this plan. Historical
 * sweeps must repeat to discover changes outside recent emission-date windows.
 */

export const API_TIME_ZONE = 'America/Sao_Paulo';

export class ResourceConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ResourceConfigError';
    this.code = code;
  }
}

export function sourceId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ResourceConfigError('ORIGIN_INVALID_SOURCE_ID');
    }
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value) || /^0+$/.test(value)) {
    throw new ResourceConfigError('ORIGIN_INVALID_SOURCE_ID');
  }
  return value;
}

const modified = { mode: 'modified', fromParam: 'dataAlteracaoInicial', toParam: 'dataAlteracaoFinal', dateOnly: false };
const undatedSweep = { mode: 'sweep', fromParam: null, toParam: null, dateOnly: false };
const dateSweep = { mode: 'sweep', fromParam: 'dataInicial', toParam: 'dataFinal', dateOnly: true };
const emissionSweep = { mode: 'sweep', fromParam: 'dataEmissaoInicial', toParam: 'dataEmissaoFinal', dateOnly: true };

function resource(id, entity, path, dates, baseParams = {}, options = {}) {
  return Object.freeze({
    id, entity, path, detailPath: (idValue) => `${path}/${sourceId(idValue)}`,
    ...dates,
    baseParams: Object.freeze({ ...baseParams }),
    timeZone: API_TIME_ZONE,
    window: dates.fromParam ? 'month' : null,
    ...options,
  });
}

const balances = [['zero', 0], ['positive', 1], ['negative', 2]];

export const RESOURCES = Object.freeze([
  resource('contacts', 'contacts', '/contatos', modified, { criterio: 1 }),
  resource('contacts_deleted', 'contacts', '/contatos', undatedSweep, { criterio: 2 }),
  // OpenAPI's stock filter defaults to positive (1); there is no documented
  // all-stock value. Explicitly cover all three partitions, including deleted.
  ...balances.map(([label, balance]) => resource(`products_${label}`, 'products', '/produtos', modified, { criterio: 5, tipo: 'T', filtroSaldoEstoque: balance })),
  ...balances.map(([label, balance]) => resource(`products_deleted_${label}`, 'products', '/produtos', undatedSweep, { criterio: 4, tipo: 'T', filtroSaldoEstoque: balance })),
  resource('sales_orders', 'sales_orders', '/pedidos/vendas', modified),
  // Proposals expose document dates, not modification/deletion timestamps.
  resource('sales_proposals', 'sales_proposals', '/propostas-comerciais', dateSweep),
  resource('purchase_orders', 'purchase_orders', '/pedidos/compras', dateSweep),
  // Explicit dates avoid the endpoint's default one-year lookback.
  resource('receivables', 'receivables', '/contas/receber', dateSweep, { tipoFiltroData: 'E' }),
  resource('payables', 'payables', '/contas/pagar', emissionSweep),
  // NF-e examples explicitly require date+time, despite OpenAPI format=date.
  // Cancelled notes are excluded unless situacao=2 is queried separately.
  resource('nfe_in', 'nfe', '/nfe', { ...emissionSweep, dateOnly: false }, { tipo: '0' }),
  resource('nfe_out', 'nfe', '/nfe', { ...emissionSweep, dateOnly: false }, { tipo: '1' }),
  resource('nfe_in_cancelled', 'nfe', '/nfe', { ...emissionSweep, dateOnly: false }, { tipo: '0', situacao: 2 }),
  resource('nfe_out_cancelled', 'nfe', '/nfe', { ...emissionSweep, dateOnly: false }, { tipo: '1', situacao: 2 }),
  // NFC-e has its own endpoint and canonical identity. Unlike /nfe, its
  // documentation does not state that unfiltered lists exclude cancellations.
  resource('nfce', 'nfce', '/nfce', { ...emissionSweep, dateOnly: false }),
  // Existing authorization was verified on 2026-10-16. Cover inactive payment
  // methods explicitly and deleted sellers independently of modification dates.
  resource('payment_methods_active', 'payment_methods', '/formas-pagamentos', undatedSweep, { situacao: 1 }),
  resource('payment_methods_inactive', 'payment_methods', '/formas-pagamentos', undatedSweep, { situacao: 0 }),
  resource('sellers', 'sellers', '/vendedores', modified, { situacaoContato: 'T' }),
  resource('sellers_deleted', 'sellers', '/vendedores', undatedSweep, { situacaoContato: 'E' }),
  // 063: explicitly gated; dates are entry/movement dates, never updated-at.
  resource('service_orders', 'service_orders', '/ordens/servico', dateSweep, {}, { extra: true }),
  resource('warehouses_active', 'warehouses', '/depositos', undatedSweep, { situacao: 1 }, { extra: true }),
  resource('warehouses_inactive', 'warehouses', '/depositos', undatedSweep, { situacao: 0 }, { extra: true }),
  resource('product_categories', 'product_categories', '/categorias/produtos', undatedSweep, {}, { extra: true }),
  // This endpoint can return more rows than `limite` while respecting `pagina`.
  // Keep the documented parameter, but consume bounded portions of that page.
  resource('financial_categories', 'financial_categories', '/categorias/receitas-despesas', undatedSweep, { tipo: 0, situacao: 0 }, { extra: true, strategy: 'source_page', listLimit: true }),
  resource('ledger_accounts', 'ledger_accounts', '/contas-contabeis', undatedSweep, { ocultarInvisiveis: false, ocultarTipoContaBancaria: false, situacoes: Object.freeze([1,2,3,4]) }, { extra: true }),
  // /caixas has pagina, but no documented limite. Split a bounded source page
  // locally; only an empty source page closes the date window.
  resource('cash_entries_registered', 'cash_entries', '/caixas', dateSweep, { situacao: 'R', situacaoConciliacao: 3 }, { extra: true, strategy: 'source_page' }),
  resource('cash_entries_deleted', 'cash_entries', '/caixas', dateSweep, { situacao: 'E', situacaoConciliacao: 3 }, { extra: true, strategy: 'source_page' }),
  resource('stock_balances', 'stock_balances', '/estoques/saldos', undatedSweep, {}, { extra: true, strategy: 'stock' }),
]);

export function getResource(id) {
  const result = RESOURCES.find((entry) => entry.id === id);
  if (!result) throw new ResourceConfigError('ORIGIN_UNKNOWN_RESOURCE');
  return result;
}

function dateMillis(value, dateOnly) {
  const pattern = dateOnly ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (typeof value !== 'string' || !pattern.test(value)) throw new ResourceConfigError('ORIGIN_INVALID_LOCAL_DATE');
  // UTC is used here only for validation/span arithmetic on wall-clock parts;
  // no conversion or reinterpretation of the configured Brazil timezone occurs.
  const iso = dateOnly ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, dateOnly ? 10 : 19) !== value.replace(' ', 'T')) {
    throw new ResourceConfigError('ORIGIN_INVALID_LOCAL_DATE');
  }
  return parsed;
}

export function buildListParams(resourceOrId, { from, to, page = 1, limit = 100 } = {}) {
  const config = typeof resourceOrId === 'string' ? getResource(resourceOrId) : resourceOrId;
  if (!RESOURCES.includes(config)) throw new ResourceConfigError('ORIGIN_UNKNOWN_RESOURCE');
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ResourceConfigError('ORIGIN_INVALID_PAGINATION');
  }
  const params = { ...config.baseParams, pagina: page, limite: limit };
  if (config.strategy === 'source_page' && !config.listLimit) delete params.limite;
  if (config.strategy === 'stock') throw new ResourceConfigError('ORIGIN_STOCK_IDS_REQUIRED');
  if (config.fromParam) {
    const start = dateMillis(from, config.dateOnly);
    const end = dateMillis(to, config.dateOnly);
    if (end < start || end - start >= 32 * 24 * 60 * 60 * 1000) {
      throw new ResourceConfigError('ORIGIN_MONTHLY_WINDOW_REQUIRED');
    }
    params[config.fromParam] = from;
    params[config.toParam] = to;
  }
  return params;
}
