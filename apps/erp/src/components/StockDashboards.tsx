import { nativeIndicatorCoverageText } from '../lib/document-reports-model';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText, stockDate } from '../lib/stock-model';
import { moneyText, priceText } from '../lib/stock-launch-model';
import { DASHBOARD_TABS, INVALID_FILTERS, dashboardTabAllowed, NO_RESULT, PRICE_SOURCE_LABELS, PURCHASE_STATUS_LABELS, SALES_STATUS_LABELS, STOCK_DASHBOARD_HINT, STOCK_TYPE_OPTIONS, currentStock, dashboardTab, defaultPeriod,
  parseIdle, parseStockDashboard, parseSuggestion, proposedSupplier, purchaseOrderItems, rowCost, rowCostSource, sortSuggestion, stockDashboardPath, suggestionPath, suggestionTotals, totalCost, totalUncosted,
  type DashboardTab, type IdleRow, type PriceMode, type StockDashboardFilters, type StockDashboardPage, type StockTypeFilter, type SuggestionFilters, type SuggestionRow, type SuggestionSort } from '../lib/stock-dashboards-model';
import { selectableWarehouses } from '../lib/stock-supply-model';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { StockSupplierPicker, useStockWarehouseOptions, type SupplierChoice } from './StockSupplierPicker';
import { CSV_TYPE, XLSX_TYPE, downloadFile, numberCell, textCell, toCsv, toXlsx, type SheetCell } from '../lib/spreadsheet-export';
import { OriginPagination } from './OriginList';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
// 260: Sistema › Usuários › Permissões › Meu Negócio › Dashboard of each panel (the server refuses; the menu says why first).
import { PERMISSIONS_PATH } from '../lib/system-model';
import { allowedBy, parseMyPermissions, STOCK_DASHBOARD_PERMISSIONS, type MyPermissions } from '../../../../packages/erp-domain/src/user-permissions.mjs';
import './stock.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const readError = (error: unknown) => error instanceof AccessError ? error.status === 400 ? INVALID_FILTERS : error.status === 403 ? 'Seu perfil não permite consultar os dashboards de estoque.' : 'Não foi possível consultar. Tente novamente.' : 'Não foi possível consultar. Tente novamente.';
const brDate = (value: string) => value.split('-').reverse().join('/');
type Controller = Pick<AccessController, 'stock' | 'getSnapshot' | 'documents'>;
const exportRows = (format: 'xlsx' | 'csv', name: string, rows: SheetCell[][]) => format === 'xlsx' ? downloadFile(`${name}.xlsx`, toXlsx(name, rows) as unknown as BlobPart, XLSX_TYPE) : downloadFile(`${name}.csv`, toCsv(rows), CSV_TYPE);

const NOT_PERMITTED = 'Seu usuário não tem a permissão deste dashboard (Sistema › Usuários › Permissões › Meu Negócio).';
/** Whether the user may open a panel: without the answer every panel stays listed (the server still decides). */
export const panelPermitted = (perms: MyPermissions | null, tab: DashboardTab) => !perms || (allowedBy(perms, 'meu_negocio.dashboard') && allowedBy(perms, `meu_negocio.dashboard.${STOCK_DASHBOARD_PERMISSIONS[tab]}`));
/** Menu lateral de dashboards do Origin: Produtos > Estoque de Produtos, Sugestão de Compras e Sem Movimentação. */
export function StockDashboardsNav({ tab, role, perms = null }: { tab: DashboardTab; role?: string; perms?: MyPermissions | null }) {
  return <nav className="stock-dash-nav" aria-label="Dashboards"><h2>Produtos</h2><ul>{DASHBOARD_TABS.filter(item => dashboardTabAllowed(item.id, role)).map(item => <li key={item.id}>{panelPermitted(perms, item.id)
    ? <Link to={`/painel-produtos-empresa?painel=${item.id}`} aria-current={item.id === tab ? 'page' : undefined}>{item.label}</Link> : <span className="business-nav-disabled" aria-disabled="true" title={NOT_PERMITTED}>{item.label}</span>}</li>)}</ul></nav>;
}
// 181: the selectors read the light warehouse list (/v1/estoque/depositos/opcoes), not the totals.
const useWarehouses = (controller: Controller) => useStockWarehouseOptions(controller).options;
const costSourceText = (source: 'supplier' | 'average' | null) => source === 'supplier' ? 'Custo do fornecedor padrão' : source === 'average' ? 'Custo médio (o produto não tem custo do fornecedor padrão)' : '';

function StockProducts({ controller }: { controller: Controller }) {
  const warehouses = useWarehouses(controller);
  const [draft, setDraft] = useState<StockDashboardFilters>({ query: '', searchBy: 'description', warehouse: '', brand: '', supplier: null, stockType: '' }), [filters, setFilters] = useState(draft), [page, setPage] = useState(1);
  const [data, setData] = useState<StockDashboardPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [exporting, setExporting] = useState(''), [printing, setPrinting] = useState<{ rows: StockDashboardPage['items']; cost: boolean } | null>(null);
  useEffect(() => { const request = new AbortController(); setLoading(true); setError('');
    void controller.stock(stockDashboardPath(filters, page), { signal: request.signal }).then(raw => { if (!request.signal.aborted) setData(parseStockDashboard(raw, page)); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setData(null); setError(readError(problem)); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort(); }, [controller, filters, page]);
  const submit = (event: FormEvent) => { event.preventDefault(); setFilters(draft); setPage(1); };
  // Exports cover the whole filter (every page), not only the page on screen.
  const everything = async () => { const rows: StockDashboardPage['items'] = []; let cost = false; for (let n = 1; n <= 100; n++) { const value = parseStockDashboard(await controller.stock(stockDashboardPath(filters, n)), n); cost = value.costVisible; rows.push(...value.items); if (rows.length >= value.total || !value.items.length) break; } return { rows, cost }; };
  const run = async (format: 'xlsx' | 'csv' | 'pdf') => { if (exporting) return; setExporting(format); setError('');
    try { const { rows, cost } = await everything(); if (format === 'pdf') setPrinting({ rows, cost }); else exportRows(format, 'estoque-de-produtos', [[textCell('Código'), textCell('Descrição'), textCell('Estoque'), ...(cost ? [textCell('Custo')] : []), textCell('Valor')], ...rows.map(row => [textCell(row.code), textCell(row.name), numberCell(row.quantity), ...(cost ? [numberCell(rowCost(row))] : []), numberCell(row.value)])]); }
    catch (problem) { setError(readError(problem)); } finally { setExporting(''); } };
  const costTitle = data ? `Custo do fornecedor padrão × quantidade, como no Origin. Sem custo do fornecedor padrão, o custo médio × quantidade; o custo médio usa o ${data.costBasis === 'custo_lancamento' ? 'custo do lançamento' : 'preço de compra'} das entradas (Preferências › Suprimentos › Estoque)` : '';
  const uncosted = data ? totalUncosted(data.totals) : null, supplierCosted = data?.totals.supplier_costed ?? 0;
  return <section className="stock-dash-panel" aria-labelledby="stock-dash-stock-title"><h1 id="stock-dash-stock-title">Estoque de Produtos</h1>
    {nativeIndicatorCoverageText(data) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(data)}</p>}
    <form className="stock-dash-filters" onSubmit={submit}>
      <div className="form-field"><label htmlFor="stock-dash-query">Pesquisar</label><input id="stock-dash-query" maxLength={120} placeholder="Informe o termo para pesquisa" value={draft.query} onChange={event => setDraft({ ...draft, query: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="stock-dash-by">Pesquisar por</label><select id="stock-dash-by" value={draft.searchBy} onChange={event => setDraft({ ...draft, searchBy: event.target.value as StockDashboardFilters['searchBy'] })}><option value="code">Código</option><option value="description">Descrição</option><option value="gtin">GTIN</option></select></div>
      <div className="form-field"><label htmlFor="stock-dash-warehouse">Depósito</label><select id="stock-dash-warehouse" value={draft.warehouse} onChange={event => setDraft({ ...draft, warehouse: event.target.value })}><option value="">Todos</option>{selectableWarehouses(warehouses, draft.warehouse).map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' · inativo'}</option>)}</select></div>
      <div className="form-field"><label htmlFor="stock-dash-brand">Marca</label><input id="stock-dash-brand" maxLength={100} value={draft.brand} onChange={event => setDraft({ ...draft, brand: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="stock-dash-supplier">Fornecedor</label><StockSupplierPicker controller={controller} id="stock-dash-supplier" value={draft.supplier ?? null} onChange={(value: SupplierChoice | null) => setDraft(previous => ({ ...previous, supplier: value }))} /></div>
      <div className="form-field"><label htmlFor="stock-dash-type">Tipo de Estoque <span className="stock-info" title="Virtual: composições com tipo de estoque Virtual, com o estoque calculado pelos componentes de cada depósito (máximo de composições completas). Físico: os demais produtos, inclusive a composição Físico, que tem estoque próprio." aria-label="Virtual: composições, cujo estoque vem dos componentes"><Icon name="circle-info" size={10} /></span></label><select id="stock-dash-type" value={draft.stockType ?? ''} onChange={event => setDraft({ ...draft, stockType: event.target.value as StockTypeFilter })}>{STOCK_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>
      <button type="submit" className="primary-button">Visualizar</button>
    </form>
    <p className="real-help stock-dash-hint"><span className="stock-info" aria-hidden="true"><Icon name="circle-info" size={10} /></span> {STOCK_DASHBOARD_HINT}</p>
    <div className="stock-dash-tools"><button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void run('pdf')}><Icon name="file-pdf" size={12} />PDF</button><button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void run('xlsx')}><Icon name="file-excel" size={12} />XLSX</button><button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void run('csv')}><Icon name="file-lines" size={12} />CSV</button>{exporting && <span role="status">Preparando exportação…</span>}</div>
    {error && <p className="real-alert" role="alert">{error}</p>}{loading && <p role="status">Consultando…</p>}
    {data && <div className="stock-dash-grid"><section><h2>Tabela de Estoques</h2><div className="table-scroll" tabIndex={0} role="region" aria-label="Tabela de Estoques"><table className="data-table real-table"><thead><tr><th>Código</th><th>Descrição</th><th className="numeric">Estoque</th>{data.costVisible && <th className="numeric">Custo <span className="stock-info" title={costTitle} aria-label={costTitle}><Icon name="circle-info" size={10} /></span></th>}<th className="numeric">Valor <span className="stock-info" title="Preço unitário × quantidade" aria-label="Preço unitário × quantidade"><Icon name="circle-info" size={10} /></span></th></tr></thead>
      <tbody>{data.items.map(row => { const cost = rowCost(row), source = rowCostSource(row);
        return <tr key={row.product_id}><td>{row.code ?? ''}</td><td>{row.name}</td><td className={`numeric${row.quantity.startsWith('-') ? ' is-negative' : ''}`}>{quantityText(row.quantity)}</td>{data.costVisible && <td className="numeric" title={[costSourceText(source), row.supplier_cost ? `Custo do fornecedor padrão: ${priceText(row.supplier_cost)}` : '', row.average_cost ? `Custo médio: ${priceText(row.average_cost)}` : ''].filter(Boolean).join(' · ') || undefined}>{cost ? moneyText(cost) : '-'}{source === 'average' && <small className="stock-reference"> médio</small>}</td>}<td className="numeric">{row.value === null ? '-' : moneyText(row.value)}</td></tr>; })}</tbody>
      <tfoot><tr><th colSpan={2}>TOTAL</th><th className="numeric">{quantityText(data.totals.quantity)}</th>{data.costVisible && <th className="numeric">{totalCost(data.totals) ? moneyText(totalCost(data.totals)!) : '-'}</th>}<th className="numeric">{moneyText(data.totals.value)}</th></tr></tfoot></table></div>
      {!data.items.length && <p className="empty-state">{NO_RESULT}</p>}{data.total > 0 && <OriginPagination page={page} pages={Math.max(1, Math.ceil(data.total / 100))} size={100} total={data.total} onPage={setPage} />}
      <p className="real-help">Sem depósito escolhido, o estoque soma os depósitos considerados. {data.costVisible ? `Custo: custo do fornecedor padrão × quantidade (${supplierCosted} produto(s)); sem custo do fornecedor padrão, o custo médio, marcado como "médio"${uncosted ? `; ${uncosted} produto(s) com estoque e sem custo ficam sem custo` : ''}.` : 'Custo não aparece: ele usa preços de compra, que seu perfil não consulta.'}{data.totals.unpriced ? ` ${data.totals.unpriced} produto(s) sem preço de venda ficam sem valor.` : ''}{filters.stockType === 'virtual' ? ' O FAGOO ainda não tem composições com estoque virtual: aparecem só as composições com saldo registrado.' : ''}</p></section>
      <section><h2>Estoque por Depósito</h2><table className="data-table real-table"><thead><tr><th>Nome</th><th className="numeric">Estoque</th>{data.costVisible && <th className="numeric">Custo</th>}<th className="numeric">Valor</th></tr></thead><tbody>{data.warehouses.map(item => <tr key={item.warehouse_id} className={item.ignored ? 'is-ignored' : undefined} title={item.ignored ? 'Saldo deste depósito não é considerado.' : undefined}><td>{item.name}{item.ignored && <small className="stock-reference">Saldo desconsiderado</small>}</td><td className="numeric">{quantityText(item.quantity)}</td>{data.costVisible && <td className="numeric">{rowCost(item) ? moneyText(rowCost(item)!) : '-'}</td>}<td className="numeric">{moneyText(item.value)}</td></tr>)}</tbody></table></section></div>}
    {printing && <StockPrintPreview title="Estoque de Produtos" onClose={() => setPrinting(null)}><h1>Estoque de Produtos</h1>{nativeIndicatorCoverageText(data) && <p>{nativeIndicatorCoverageText(data)}</p>}<table><thead><tr><th>Código</th><th>Descrição</th><th className="numeric">Estoque</th>{printing.cost && <th className="numeric">Custo</th>}<th className="numeric">Valor</th></tr></thead><tbody>{printing.rows.map(row => <tr key={row.product_id}><td>{row.code ?? ''}</td><td>{row.name}</td><td className="numeric">{quantityText(row.quantity)}</td>{printing.cost && <td className="numeric">{rowCost(row) ? moneyText(rowCost(row)!) : '-'}</td>}<td className="numeric">{row.value === null ? '-' : moneyText(row.value)}</td></tr>)}</tbody></table><p className="stock-print-foot">Emitido em {brDate(stockDate())}.</p></StockPrintPreview>}
  </section>;
}

function IdleProducts({ controller }: { controller: Controller }) {
  const today = stockDate(), [draft, setDraft] = useState(`${today.slice(0, 8)}01`), [since, setSince] = useState(draft), [page, setPage] = useState(1);
  const [data, setData] = useState<ReturnType<typeof parseIdle> | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [exporting, setExporting] = useState(false);
  useEffect(() => { const request = new AbortController(); setLoading(true); setError('');
    void controller.stock(`/v1/estoque/painel/sem-movimentacao?data=${since}${page > 1 ? `&pagina=${page}` : ''}`, { signal: request.signal }).then(raw => { if (!request.signal.aborted) setData(parseIdle(raw, since, page)); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setData(null); setError(readError(problem)); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort(); }, [controller, since, page]);
  const exportAll = async () => { if (exporting) return; setExporting(true);
    try { const rows: IdleRow[] = []; for (let n = 1; n <= 100; n++) { const value = parseIdle(await controller.stock(`/v1/estoque/painel/sem-movimentacao?data=${since}${n > 1 ? `&pagina=${n}` : ''}`), since, n); rows.push(...value.items); if (rows.length >= value.total || !value.items.length) break; }
      exportRows('xlsx', 'sem-movimentacao', [[textCell('Código'), textCell('Descrição'), textCell('Estoque'), textCell('Última Venda')], ...rows.map(row => [textCell(row.code), textCell(row.name), numberCell(row.quantity), textCell(row.last_sale ? brDate(row.last_sale) : 'Sem Venda')])]); }
    catch (problem) { setError(readError(problem)); } finally { setExporting(false); } };
  return <section className="stock-dash-panel" aria-labelledby="stock-dash-idle-title"><h1 id="stock-dash-idle-title">Sem Movimentação</h1>
    {nativeIndicatorCoverageText(data) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(data)}</p>}
    <form className="stock-dash-filters" onSubmit={event => { event.preventDefault(); if (!/^\d{4}-\d{2}-\d{2}$/.test(draft)) { setError(INVALID_FILTERS); return; } setSince(draft); setPage(1); }}>
      <div className="form-field"><label htmlFor="stock-dash-since">Data</label><input id="stock-dash-since" type="date" min="1900-01-01" max="2100-12-31" value={draft} onChange={event => setDraft(event.target.value)} /></div>
      <button type="submit" className="primary-button">Visualizar</button><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportAll()}><Icon name="file-excel" size={12} />XLSX</button></form>
    {error && <p className="real-alert" role="alert">{error}</p>}{loading && <p role="status">Consultando…</p>}
    {data && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Sem Movimentação"><table className="data-table real-table"><thead><tr><th>Código</th><th>Descrição</th><th className="numeric">Estoque</th><th>Última Venda</th></tr></thead>
      <tbody>{data.items.map(row => <tr key={row.product_id}><td>{row.code ?? ''}</td><td>{row.name}</td><td className="numeric">{quantityText(row.quantity)}</td><td>{row.last_sale ? brDate(row.last_sale) : <span className="status-badge status-danger is-bold">Sem Venda</span>}</td></tr>)}</tbody></table></div>
      {!data.items.length && <p className="empty-state">{NO_RESULT}</p>}{data.total > 0 && <OriginPagination page={page} pages={Math.max(1, Math.ceil(data.total / 100))} size={100} total={data.total} onPage={setPage} />}
      <p className="real-help">Produtos com estoque nos depósitos considerados cuja última venda registrada no FAGOO é anterior a {brDate(since)}. Durante a convivência, as vendas feitas no Origin não entram nesta conta.</p></>}
  </section>;
}

type Preference = { purchase_statuses: string[]; sales_statuses: string[]; version: number };
function PurchaseSuggestion({ controller }: { controller: Controller }) {
  const warehouses = useWarehouses(controller), period = defaultPeriod(stockDate());
  const role = controller.getSnapshot().membership?.role, ordersWritable = role === 'admin' || role === 'estoque';
  // Origin defaults: Cobertura de Estoque 30 days and Reserva = Sim.
  const [draft, setDraft] = useState<SuggestionFilters>({ ...period, coverage: '30', warehouse: '', reserve: true, purchase: [], sales: [], brand: '', supplier: null }), [filters, setFilters] = useState<SuggestionFilters | null>(null);
  const [preference, setPreference] = useState<Preference | null>(null), [data, setData] = useState<ReturnType<typeof parseSuggestion> | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set()), [ordering, setOrdering] = useState<SuggestionRow[] | null>(null), [created, setCreated] = useState<{ id: string; number: string } | null>(null);
  const [sort, setSort] = useState<SuggestionSort>({ key: 'suggestion', direction: 'desc' }), [local, setLocal] = useState(''), [settings, setSettings] = useState(false), [printing, setPrinting] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => { const request = new AbortController(); void controller.stock('/v1/estoque/painel/ajustes', { signal: request.signal }).then(raw => {
    const value = (raw as { preference?: Preference }).preference; if (request.signal.aborted || !value || !Array.isArray(value.purchase_statuses) || !Array.isArray(value.sales_statuses)) return;
    setPreference(value); setDraft(previous => ({ ...previous, purchase: previous.purchase.length ? previous.purchase : value.purchase_statuses, sales: value.sales_statuses }));
  }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setError(readError(problem)); }); return () => request.abort(); }, [controller, reload]);
  useEffect(() => { if (!filters) return; const request = new AbortController(); setLoading(true); setError('');
    let path: string; try { path = suggestionPath(filters); } catch { setLoading(false); setError(INVALID_FILTERS); return; }
    void controller.stock(path, { signal: request.signal }).then(raw => { if (!request.signal.aborted) { setData(parseSuggestion(raw, filters)); setSelected(new Set()); } })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setData(null); setError(readError(problem)); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort(); }, [controller, filters]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (ordering) return; try { suggestionPath(draft); } catch { setError(INVALID_FILTERS); return; } setCreated(null); setFilters({ ...draft, purchase: [...draft.purchase], sales: [...draft.sales] }); };
  const reserve = filters?.reserve ?? false;
  const shown = data ? sortSuggestion(data.items.filter(row => !local.trim() || `${row.code ?? ''} ${row.name}`.toLowerCase().includes(local.trim().toLowerCase())), sort, reserve) : [];
  const totals = suggestionTotals(shown, reserve);
  const header = (key: SuggestionSort['key'], label: string, numeric = true) => <th className={numeric ? 'numeric' : undefined} aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button type="button" className="stock-sort" onClick={() => setSort(previous => ({ key, direction: previous.key === key && previous.direction === 'desc' ? 'asc' : 'desc' }))}>{label}<Icon name="sort" size={9} /></button></th>;
  const rows = (): SheetCell[][] => [[textCell('SKU'), textCell('Descrição'), textCell('Peças Vendidas'), textCell('Estoque Atual'), textCell('Pedido de Compra'), textCell('Sugestão de Compra'), textCell('Valor Estimado')],
    ...shown.map(row => [textCell(row.code), textCell(row.name), numberCell(row.sold), numberCell(currentStock(row, reserve)), numberCell(row.ordered), numberCell(row.suggestion), numberCell(row.value)]),
    [textCell('TOTAL'), textCell(''), numberCell(totals.sold), numberCell(totals.stock), numberCell(totals.ordered), numberCell(totals.suggestion), numberCell(totals.value)]];
  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];
  // "Gerar pedido de compra com os selecionados": rows with a suggestion; the order is created by the documentos API.
  const orderable = (row: SuggestionRow) => /^[1-9][0-9]*$/.test(row.suggestion) && Boolean(row.unit);
  const chosen = shown.filter(row => selected.has(row.product_id) && orderable(row));
  const pick = (id: string) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allShown = shown.filter(orderable), allPicked = allShown.length > 0 && allShown.every(row => selected.has(row.product_id));
  const priceNote = data ? data.priceMode === 'ultima_compra' ? 'O Valor Estimado usa o preço da última compra registrada no FAGOO.' : `O Valor Estimado usa o preço de ${data.priceMode === 'custo' ? 'custo' : 'compra'} do fornecedor (Preferências › Suprimentos › Configurações de pedidos de compras › Definir o preço padrão dos pedidos de compra) e, sem ele, o preço da última compra registrada no FAGOO.` : '';
  return <section className="stock-dash-panel" aria-labelledby="stock-dash-suggestion-title"><header className="stock-dash-heading"><h1 id="stock-dash-suggestion-title">Sugestão de Compras</h1><button type="button" className="secondary-button" disabled={!preference} onClick={() => setSettings(true)}><Icon name="gear" size={12} />Ajustes</button></header>
    {nativeIndicatorCoverageText(data) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(data)}</p>}
    <form className="stock-dash-filters" onSubmit={submit}>
      <div className="form-field"><label htmlFor="stock-sug-from">Período de Venda</label><span className="stock-dash-range"><input id="stock-sug-from" type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /><input id="stock-sug-to" type="date" aria-label="Fim do período de venda" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></span></div>
      <div className="form-field"><label htmlFor="stock-sug-coverage">Cobertura de Estoque <span className="stock-info" title="Em dias. Ex: 30" aria-label="Em dias. Ex: 30"><Icon name="circle-info" size={10} /></span></label><input id="stock-sug-coverage" inputMode="numeric" maxLength={4} value={draft.coverage} onChange={event => setDraft({ ...draft, coverage: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="stock-sug-warehouse">Depósito</label><select id="stock-sug-warehouse" value={draft.warehouse} onChange={event => setDraft({ ...draft, warehouse: event.target.value })}><option value="">Todos</option>{selectableWarehouses(warehouses, draft.warehouse).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="form-field"><label htmlFor="stock-sug-reserve">Reserva</label><select id="stock-sug-reserve" value={draft.reserve ? 'sim' : 'nao'} onChange={event => setDraft({ ...draft, reserve: event.target.value === 'sim' })}><option value="sim">Sim</option><option value="nao">Não</option></select></div>
      <fieldset className="stock-dash-statuses"><legend>Pedidos de compra</legend>{Object.entries(PURCHASE_STATUS_LABELS).map(([value, label]) => <label key={value} className="stock-radio"><input type="checkbox" id={`stock-sug-purchase-${value}`} checked={draft.purchase.includes(value)} onChange={() => setDraft({ ...draft, purchase: toggle(draft.purchase, value) })} />{label}</label>)}</fieldset>
      <div className="form-field"><label htmlFor="stock-sug-supplier">Fornecedor</label><StockSupplierPicker controller={controller} id="stock-sug-supplier" value={draft.supplier ?? null} onChange={(value: SupplierChoice | null) => setDraft(previous => ({ ...previous, supplier: value }))} /></div>
      <div className="form-field"><label htmlFor="stock-sug-brand">Marca <span className="stock-info" title="Informe o nome da marca dos produtos" aria-label="Informe o nome da marca dos produtos"><Icon name="circle-info" size={10} /></span></label><input id="stock-sug-brand" maxLength={100} value={draft.brand} onChange={event => setDraft({ ...draft, brand: event.target.value })} /></div>
      <button type="submit" className="primary-button" disabled={!preference || Boolean(ordering)}>Visualizar</button>
    </form>
    {error && <p className="real-alert" role="alert">{error}</p>}{loading && <p role="status">Calculando…</p>}
    {created && <p className="real-success" role="status">Pedido de compra nº {created.number} gerado com os produtos selecionados. <Link to={`/documentos-empresa?${new URLSearchParams({ tipo: 'purchase_orders', documento: created.id })}`}>Abrir pedido de compra</Link></p>}
    {data && <><div className="stock-dash-tools"><button type="button" className="secondary-button" onClick={() => exportRows('xlsx', 'sugestao-de-compras', rows())}><Icon name="file-excel" size={12} />Excel</button><button type="button" className="secondary-button" onClick={() => exportRows('csv', 'sugestao-de-compras', rows())}><Icon name="file-lines" size={12} />CSV</button><button type="button" className="secondary-button" onClick={() => setPrinting(true)}><Icon name="file-pdf" size={12} />PDF</button>
      <label className="stock-dash-local" htmlFor="stock-sug-local">Procurar:<input id="stock-sug-local" type="search" value={local} onChange={event => setLocal(event.target.value)} /></label>
      {ordersWritable && <button type="button" className="primary-button" disabled={!chosen.length || Boolean(ordering)} title={chosen.length ? undefined : 'Selecione produtos com sugestão de compra'} onClick={() => { setCreated(null); setOrdering(chosen); }}><Icon name="cart-shopping" size={12} />Gerar pedido de compra com os selecionados</button>}</div>
      {shown.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Sugestão de Compras"><table className="data-table real-table stock-suggestion-table"><thead><tr>{ordersWritable && <th className="stock-select"><input type="checkbox" id="stock-sug-all" aria-label="Selecionar todos com sugestão" checked={allPicked} disabled={!allShown.length || Boolean(ordering)} onChange={() => setSelected(allPicked ? new Set() : new Set(allShown.map(row => row.product_id)))} /></th>}{header('code', 'SKU', false)}{header('name', 'Descrição', false)}{header('sold', 'Peças Vendidas')}{header('stock', 'Estoque Atual')}{header('ordered', 'Pedido de Compra')}{header('suggestion', 'Sugestão de Compra')}{header('value', 'Valor Estimado')}</tr></thead>
        <tbody>{shown.map(row => <tr key={row.product_id}>{ordersWritable && <td className="stock-select"><input type="checkbox" id={`stock-sug-pick-${row.product_id}`} aria-label={`Selecionar ${row.name}`} checked={selected.has(row.product_id)} disabled={!orderable(row) || Boolean(ordering)} title={orderable(row) ? undefined : 'Sem sugestão de compra'} onChange={() => pick(row.product_id)} /></td>}<td>{row.code ?? ''}</td><td>{row.name}</td><td className="numeric">{quantityText(row.sold)}</td><td className="numeric">{quantityText(currentStock(row, reserve))}</td><td className="numeric">{quantityText(row.ordered)}</td><td className="numeric"><strong>{quantityText(row.suggestion)}</strong></td><td className="numeric" title={row.unit_price ? `${row.price_source ? PRICE_SOURCE_LABELS[row.price_source] : 'Preço da última compra'}: ${priceText(row.unit_price)}` : undefined}>{row.value === null ? '-' : moneyText(row.value)}</td></tr>)}</tbody>
        <tfoot><tr>{ordersWritable && <th />}<th colSpan={2}>TOTAL</th><th className="numeric">{quantityText(totals.sold)}</th><th className="numeric">{quantityText(totals.stock)}</th><th className="numeric">{quantityText(totals.ordered)}</th><th className="numeric">{quantityText(totals.suggestion)}</th><th className="numeric">{moneyText(totals.value)}</th></tr></tfoot></table></div>
        : <p className="empty-state">{NO_RESULT}</p>}
      {data.total > data.items.length && <p className="real-help">Mostrando os {data.items.length} produtos com maior sugestão de {data.total}.</p>}
      <p className="real-help">Sugestão = arredondar para baixo(peças vendidas ÷ dias do período × cobertura − estoque atual − quantidade a receber dos pedidos de compra), com mínimo 0.{reserve ? ' Com Reserva = Sim, o estoque atual já desconta o reservado.' : ''} Vendas e compras são as registradas no FAGOO; durante a convivência, as vendas do Origin não entram. {priceNote}</p></>}
    {ordering && filters && <PurchaseOrderPanel controller={controller} rows={ordering} supplier={proposedSupplier(ordering, filters.supplier)} warehouses={warehouses} warehouse={filters.warehouse || warehouses.find(item => item.is_default && item.active)?.id || ''}
      onClose={() => setOrdering(null)} onCreated={value => { setOrdering(null); setSelected(new Set()); setCreated(value); }} />}
    {settings && preference && <SuggestionSettings controller={controller} preference={preference} onClose={() => setSettings(false)} onSaved={value => { setSettings(false); setPreference(value); setDraft(previous => ({ ...previous, sales: value.sales_statuses })); setReload(n => n + 1); }} />}
    {printing && data && <StockPrintPreview title="Sugestão de Compras" onClose={() => setPrinting(false)}><h1>Sugestão de Compras</h1>{nativeIndicatorCoverageText(data) && <p>{nativeIndicatorCoverageText(data)}</p>}<p>Período de venda {brDate(filters!.from)} a {brDate(filters!.to)} · cobertura de {filters!.coverage} dias</p>
      <table><thead><tr>{rows()[0]!.map((cell, index) => <th key={index}>{'text' in cell ? cell.text : ''}</th>)}</tr></thead><tbody>{shown.map(row => <tr key={row.product_id}><td>{row.code ?? ''}</td><td>{row.name}</td><td className="numeric">{quantityText(row.sold)}</td><td className="numeric">{quantityText(currentStock(row, reserve))}</td><td className="numeric">{quantityText(row.ordered)}</td><td className="numeric">{quantityText(row.suggestion)}</td><td className="numeric">{row.value === null ? '-' : moneyText(row.value)}</td></tr>)}</tbody></table></StockPrintPreview>}
  </section>;
}

/** "Gerar pedido de compra com os selecionados": a new purchase order (Em aberto) with the suggested quantities and the estimated price,
 * created by the documentos API (POST /v1/documentos/purchase_orders) with command_id; an unknown result is checked with the same command. */
function PurchaseOrderPanel({ controller, rows, supplier: proposed, warehouses, warehouse: initialWarehouse, onClose, onCreated }: { controller: Controller; rows: SuggestionRow[]; supplier: SupplierChoice | null;
  warehouses: ReturnType<typeof useWarehouses>; warehouse: string; onClose: () => void; onCreated: (value: { id: string; number: string }) => void }) {
  const [supplier, setSupplier] = useState<SupplierChoice | null>(proposed), [warehouse, setWarehouse] = useState(initialWarehouse), day = stockDate();
  const command = useStockCommand({ stock: (path, options) => controller.documents(path, options) }, 'Não foi possível confirmar se o pedido de compra foi gerado. Use “Conferir resultado” para repetir o mesmo pedido sem gerar outro.');
  const guard = useUnsavedForm({ supplier: supplier?.id ?? null, warehouse }, command.busy || command.uncertain), frozen = command.busy || command.uncertain;
  const items = purchaseOrderItems(rows);
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const save = () => {
    if (command.busy) return;
    if (!command.uncertain && !supplier) { command.setError('Informe o fornecedor do pedido de compra.'); return; }
    void command.run('/v1/documentos/purchase_orders', 'POST', command.uncertain ? null : { data: { date: day, contact_id: supplier!.id, ...(warehouse ? { warehouse_id: warehouse } : {}), items } },
      value => { const raw = value as { document?: { id?: unknown; number?: unknown; kind?: unknown } }; const doc = raw.document;
        if (!doc || doc.kind !== 'purchase_orders' || typeof doc.id !== 'string' || (typeof doc.number !== 'string' && typeof doc.number !== 'number')) throw new Error('INVALID'); return { id: doc.id, number: String(doc.number) }; },
      onCreated, problem => problem instanceof AccessError ? problem.status === 403 ? 'Seu perfil não permite incluir pedidos de compra.' : problem.status === 400 ? 'Confira o fornecedor (ativo), o depósito e os produtos selecionados.' : 'Os dados mudaram. Feche e confira a sugestão de novo.' : 'Não foi possível gerar o pedido de compra.');
  };
  return <StockSidePanel title="Gerar pedido de compra" labelledBy="stock-sug-order-title" wide onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !items.length} onClick={save}>{command.busy ? 'Gerando pedido…' : command.uncertain ? 'Conferir resultado' : 'Gerar pedido de compra'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <fieldset className="stock-panel-form" disabled={frozen}><legend className="real-sr-only">Pedido de compra</legend>
      <div className="form-field"><label htmlFor="stock-order-supplier">Fornecedor *</label><StockSupplierPicker controller={controller} id="stock-order-supplier" value={supplier} disabled={frozen} onChange={setSupplier} /></div>
      <div className="form-field"><label htmlFor="stock-order-warehouse">Depósito</label><select id="stock-order-warehouse" value={warehouse} onChange={event => setWarehouse(event.target.value)}><option value="">Sem depósito</option>{selectableWarehouses(warehouses, warehouse).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <p className="real-help">Data do pedido: {brDate(day)}. O pedido nasce Em aberto; ele não lança estoque nem contas, e pode ser conferido e alterado em Pedidos de compra.</p>
    </fieldset>
    <table className="data-table real-table"><thead><tr><th>SKU</th><th>Descrição</th><th className="numeric">Quantidade</th><th className="numeric">Preço un.</th></tr></thead>
      <tbody>{items.map(item => <tr key={item.product_id}><td>{item.code ?? ''}</td><td>{item.description}</td><td className="numeric">{quantityText(item.quantity)}</td><td className="numeric">{priceText(item.unit_price)}</td></tr>)}</tbody></table>
    <p className="real-help">Quantidade = Sugestão de Compra; Preço un. = o preço do Valor Estimado (sem ele, zero, para informar no pedido).</p>
  </StockSidePanel>;
}

/** Ajustes do dashboard: "Situações de venda consideradas" and the default purchase situations, per user, audited. */
function SuggestionSettings({ controller, preference, onClose, onSaved }: { controller: Pick<AccessController, 'stock'>; preference: Preference; onClose: () => void; onSaved: (value: Preference) => void }) {
  const [sales, setSales] = useState(preference.sales_statuses), [purchase, setPurchase] = useState(preference.purchase_statuses), command = useStockCommand(controller);
  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];
  const save = () => {
    if (command.busy) return;
    if (!command.uncertain && (!sales.length || !purchase.length)) { command.setError('Escolha ao menos uma situação de venda e uma de pedido de compra.'); return; }
    void command.run('/v1/estoque/painel/ajustes', 'POST', command.uncertain ? null : { expected_version: preference.version, purchase_statuses: purchase, sales_statuses: sales },
      value => { const raw = value as { preference?: Preference }; if (!raw.preference || !Array.isArray(raw.preference.sales_statuses)) throw new Error('INVALID'); return raw.preference; }, onSaved,
      problem => problem instanceof AccessError && problem.status === 409 ? 'Os ajustes foram alterados em outra tela. Feche e abra de novo.' : 'Não foi possível salvar os ajustes.');
  };
  const frozen = command.busy || command.uncertain;
  return <StockSidePanel title="Ajustes do dashboard" labelledBy="stock-dash-settings-title" onClose={() => { if (!frozen) onClose(); }} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <fieldset className="stock-panel-form" disabled={frozen}><legend>Situações de venda consideradas</legend>{Object.entries(SALES_STATUS_LABELS).map(([value, label]) => <label key={value} className="stock-radio"><input type="checkbox" id={`stock-settings-sales-${value}`} checked={sales.includes(value)} onChange={() => setSales(toggle(sales, value))} />{label}</label>)}</fieldset>
    <fieldset className="stock-panel-form" disabled={frozen}><legend>Pedidos de compra (padrão do filtro)</legend>{Object.entries(PURCHASE_STATUS_LABELS).map(([value, label]) => <label key={value} className="stock-radio"><input type="checkbox" id={`stock-settings-purchase-${value}`} checked={purchase.includes(value)} onChange={() => setPurchase(toggle(purchase, value))} />{label}</label>)}</fieldset>
  </StockSidePanel>;
}

/** Meu Negócio > Dashboard produtos (and Estoque > Sugestão de Compras): the three Origin product dashboards. */
export default function StockDashboards({ controller }: { controller: AccessController }) {
  const location = useLocation(), tab = dashboardTab(location.search), role = controller.getSnapshot().membership?.role;
  const allowed = ['admin', 'consulta', 'vendas', 'fiscal', 'estoque'].includes(role ?? ''), actor = controller.getSnapshot().membership?.user_id, key = useRef(0), last = useRef(actor);
  if (last.current !== actor) { last.current = actor; key.current++; }
  const [perms, setPerms] = useState<MyPermissions | null>(null);
  useEffect(() => { const request = new AbortController(); setPerms(null); const read = (controller as { system?: AccessController['system'] }).system; if (typeof read !== 'function') return;
    void (async () => { try { const raw = await read(PERMISSIONS_PATH, { method: 'GET', signal: request.signal }); if (!request.signal.aborted) setPerms(parseMyPermissions(raw)); } catch { /* Every panel stays listed; the server decides. */ } })();
    return () => request.abort(); }, [controller, actor, role]);
  if (!allowed) return <section className="real-state-panel"><h1>Dashboards de produtos não liberados</h1><p>Seu perfil não possui acesso aos dashboards de estoque.</p></section>;
  return <div className="stock-dashboards"><StockDashboardsNav tab={tab} role={role} perms={perms} /><div className="stock-dash-main" key={`${tab}:${key.current}`}>
    {!panelPermitted(perms, tab) ? <section className="real-state-panel"><h1>Dashboard não liberado</h1><p>{NOT_PERMITTED}</p></section> : !dashboardTabAllowed(tab, role) ? <section className="real-state-panel"><h1>Sugestão de Compras não liberada</h1><p>A sugestão usa pedidos de compra e preços de compra, que seu perfil não pode consultar.</p></section>
      : tab === 'estoque' ? <StockProducts controller={controller} /> : tab === 'sugestao' ? <PurchaseSuggestion controller={controller} /> : <IdleProducts controller={controller} />}
  </div></div>;
}
