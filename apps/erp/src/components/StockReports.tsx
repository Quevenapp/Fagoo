import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { quantityText, stockDate } from '../lib/stock-model';
import { moneyText, priceText, type StockWarehouseOption } from '../lib/stock-launch-model';
import { parseWarehouseOptions, selectableWarehouses } from '../lib/stock-supply-model';
import { PURCHASE_STATUSES, REPORTS, REPORTS_PATH, chartPoints, defaultReportFilters, parseReport, reportAllowed, reportBlockReason, reportParam, reportPath,
  type ReportColumn, type ReportDefinition, type ReportFilters, type ReportResult } from '../lib/stock-reports-model';
import { CSV_TYPE, XLSX_TYPE, downloadFile, numberCell, textCell, toCsv, toXlsx, type SheetCell } from '../lib/spreadsheet-export';
import { opensInNewTab } from '../lib/origin-list';
import StockProductSearch from './StockProductSearch';
import StockPrintPreview from './StockPrintPreview';
// 260: "Exibir localização nos relatórios de estoque" (Preferências › Cadastros › Configurações de produtos).
import { loadLocations, useStockLocationSettings, withLocation, withLocations } from '../lib/stock-location-model';
import { Icon } from './Icon';
import './stock.css';
import './stock-reports.css';
import {nativeReportCoverageText} from '../lib/document-reports-model';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const brDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—';
const failure = (error: unknown) => error instanceof AccessError ? error.status === 400 ? 'Filtros inválidos!' : error.status === 403 ? 'Seu perfil não permite consultar este relatório.'
  : error.status === 404 ? 'O depósito ou o produto escolhido não está disponível.' : 'Não foi possível gerar o relatório. Tente novamente.' : 'Não foi possível gerar o relatório. Tente novamente.';
function cell(column: ReportColumn, value: unknown, report: ReportDefinition): string {
  if (column.key === 'location' && value === undefined) return '…';
  if (value === null || value === undefined || value === '') return column.key === 'last_movement' ? 'Sem lançamento' : '-';
  switch (column.kind) {
    case 'quantity': case 'quantity4': return quantityText(String(value));
    case 'money': return moneyText(String(value));
    case 'price': return priceText(String(value));
    case 'date': return brDate(value);
    case 'count': return String(value);
    default: return report.id === 'notas-fornecedor' && column.key === 'code' ? String(value).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : String(value);
  }
}
const sheetCell = (column: ReportColumn, value: unknown): SheetCell => value === null || value === undefined ? textCell('') : ['quantity', 'quantity4', 'money', 'price', 'count'].includes(column.kind) ? numberCell(String(value)) : column.kind === 'date' ? textCell(brDate(value)) : textCell(String(value));

/** Relatórios de suprimentos like Origin: Controle de Estoque, Notas de Entrada and Pedidos de Compra. Read-only. */
export default function StockReports({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), guard = useUnsavedChangesGuard();
  const snapshot = controller.getSnapshot(), role = snapshot.membership?.role, actor = snapshot.membership?.user_id ?? '';
  const report = reportParam(location.search), today = stockDate();
  const [filters, setFilters] = useState<ReportFilters>(defaultReportFilters(today)), [product, setProduct] = useState<CatalogRecord | null>(null);
  const [warehouses, setWarehouses] = useState<StockWarehouseOption[]>([]);
  // The request keeps the filters it was made with: pages and exports follow the report on screen, never fields edited after Visualizar.
  const [result, setResult] = useState<{ key: string; value: ReportResult } | null>(null), [request, setRequest] = useState<{ key: string; path: string; offset: number; filters: ReportFilters } | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [exporting, setExporting] = useState(false), [printing, setPrinting] = useState(false);
  const reportKey = `${report?.id ?? ''}:${actor}`, lastKey = useRef(reportKey);
  // A new report or another actor starts clean; a late answer of the previous report never shows.
  useEffect(() => { if (lastKey.current === reportKey) return; lastKey.current = reportKey; setResult(null); setRequest(null); setError(''); setProduct(null); setFilters(defaultReportFilters(stockDate())); }, [reportKey]);
  const stockReport = Boolean(report && report.filters.includes('warehouse'));
  const locationSettings = useStockLocationSettings(controller), columns = report ? withLocation(report.columns, locationSettings.reports) : [], locationOn = columns.some(column => column.key === 'location');
  const [locations, setLocations] = useState<{ key: string; value: Map<string, string | null> | null } | null>(null), [locationError, setLocationError] = useState('');
  const resultKey = result?.key ?? '';
  // The Localização of the products on screen (100 per request); a late answer of another page never shows.
  useEffect(() => { setLocationError(''); if (!locationOn || !result) return; const abort = new AbortController(), key = result.key;
    void loadLocations(controller, result.value.items, abort.signal).then(value => { if (!abort.signal.aborted) setLocations({ key, value }); })
      .catch(problem => { if (!abort.signal.aborted && !aborted(problem)) { setLocations({ key, value: new Map() }); setLocationError('Não foi possível consultar a localização dos produtos.'); } });
    return () => abort.abort(); }, [controller, resultKey, locationOn]);
  useEffect(() => { if (!stockReport) return; const abort = new AbortController();
    // 181: the Depósito selector reads the light warehouse list, not the totals of /totais.
    void Promise.resolve().then(() => controller.stock('/v1/estoque/depositos/opcoes', { signal: abort.signal })).then(raw => { if (!abort.signal.aborted) setWarehouses(parseWarehouseOptions(raw)); }).catch(() => {});
    return () => abort.abort(); }, [controller, stockReport]);
  useEffect(() => {
    if (!request || !report) return;
    const abort = new AbortController(), key = request.key; setLoading(true); setError('');
    void Promise.resolve().then(() => controller.stock(request.path, { signal: abort.signal })).then(raw => { if (!abort.signal.aborted) setResult({ key, value: parseReport(raw, report) }); })
      .catch(problem => { if (!abort.signal.aborted && !aborted(problem)) { setResult(null); setError(failure(problem)); } }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [controller, request?.key]);
  const run = (offset = 0, base?: ReportFilters) => { if (!report) return; setError('');
    const used = base ?? { ...filters, productId: product?.id ?? '' };
    try { const path = reportPath(report, used, offset); setRequest({ key: `${reportKey}:${path}`, path, offset, filters: used }); } catch (problem) { setError((problem as Error).message); } };
  const submit = (event: FormEvent) => { event.preventDefault(); run(0); };
  const turn = (offset: number) => { if (request) run(offset, request.filters); };
  const open = (event: MouseEvent<HTMLAnchorElement>, href: string) => { if (opensInNewTab(event) || event.shiftKey) return; event.preventDefault(); guard.confirmLeave(() => navigate(href)); };
  if (!report) return <section className="stock-reports"><header className="real-heading"><h1>Relatórios</h1><span className="real-mode">Somente consulta</span></header>
    <p className="real-notice">Relatórios de suprimentos sobre os lançamentos, notas e pedidos registrados no FAGOO. Na convivência, o que foi feito só no Origin não entra.</p>
    {(['Controle de Estoque', 'Notas de Entrada', 'Pedidos de Compra'] as const).map(group => <section key={group} className="stock-report-group"><h2>{group}</h2><ul>{REPORTS.filter(item => item.group === group).map(item => <li key={item.id}>
      {reportAllowed(item, role) ? <a href={`${REPORTS_PATH}?relatorio=${item.id}`} onClick={event => open(event, `${REPORTS_PATH}?relatorio=${item.id}`)}>{item.label}</a> : <span className="is-disabled" aria-disabled="true" title={reportBlockReason(item)}>{item.label}<small>{reportBlockReason(item)}</small></span>}</li>)}</ul></section>)}
  </section>;
  if (!reportAllowed(report, role)) return <section className="real-state-panel"><h1>{report.label}</h1><p>{reportBlockReason(report)}</p></section>;
  const shown = result && request && result.key === request.key ? result.value : null;
  const everything = async () => { if (!shown || !request) return []; if (shown.total === null || shown.limit === null || shown.total <= shown.items.length) return shown.items;
    const rows: Record<string, unknown>[] = [], used = request.filters; for (let offset = 0, n = 0; n < 20 && offset < shown.total; n++, offset += shown.limit) rows.push(...parseReport(await controller.stock(reportPath(report, used, offset)), report).items); return rows; };
  const exportRows = async (format: 'csv' | 'xlsx') => { if (exporting || !shown) return; setExporting(true);
    try { const all = await everything(), rows = locationOn ? withLocations(all, await loadLocations(controller, all)) : all, sheet = [columns.map(column => textCell(column.label)), ...rows.map(row => columns.map(column => sheetCell(column, row[column.key])))], name = report.label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const coverage = nativeReportCoverageText(shown); if (coverage) sheet.push([textCell(coverage)]);
      if (format === 'csv') downloadFile(`${name}.csv`, toCsv(sheet), CSV_TYPE); else downloadFile(`${name}.xlsx`, toXlsx(report.label.slice(0, 31), sheet) as unknown as BlobPart, XLSX_TYPE); }
    catch (problem) { setError(failure(problem)); } finally { setExporting(false); } };
  const set = (patch: Partial<ReportFilters>) => setFilters(previous => ({ ...previous, ...patch }));
  const shownRows = locationOn && shown ? withLocations(shown.items, locations && request && locations.key === request.key ? locations.value : null) : shown?.items ?? [];
  const table = (rows: Record<string, unknown>[]) => <table className="data-table real-table stock-report-table"><thead><tr>{columns.map(column => <th key={column.key} className={column.kind === 'text' || column.kind === 'date' ? undefined : 'numeric'}>{column.label}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={String(row.product_id ?? row.key ?? row.movement_id ?? row.date ?? index)}>{columns.map(column => <td key={column.key} className={column.kind === 'text' || column.kind === 'date' ? undefined : 'numeric'}>{cell(column, row[column.key], report)}</td>)}</tr>)}</tbody>
    {shown?.totals && report.totals && <tfoot><tr>{columns.map((column, index) => <th key={column.key} className={column.kind === 'text' || column.kind === 'date' ? undefined : 'numeric'}>{index === 0 ? 'TOTAL' : report.totals!.includes(column.key) ? cell(column, shown.totals![column.key], report) : ''}</th>)}</tr></tfoot>}</table>;
  const points = report.id === 'movimentacao-produto' && shown?.opening ? chartPoints(shown.opening, shown.items as { date: string; balance: string }[], 560, 160) : [];
  return <section className="stock-reports">
    <header className="real-heading"><div className="stock-title"><a className="text-button" href={REPORTS_PATH} onClick={event => open(event, REPORTS_PATH)}><Icon name="chevron-left" size={12} />Relatórios</a><h1>{report.label}</h1></div><span className="real-mode">Somente consulta</span></header>
    <p className="real-help">{report.help}</p>
    <form className="stock-dash-filters" onSubmit={submit}>
      {report.filters.includes('productRequired') || report.filters.includes('product') ? <div className="form-field stock-report-product"><span>Produto{report.filters.includes('productRequired') ? ' *' : ''}</span><StockProductSearch controller={controller} selected={product} disabled={loading} onSelect={setProduct} /></div> : null}
      {report.filters.includes('period') && <><div className="form-field"><label htmlFor="stock-report-from">De</label><input id="stock-report-from" type="date" min="1900-01-01" max="2100-12-31" value={filters.from} onChange={event => set({ from: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="stock-report-to">Até</label><input id="stock-report-to" type="date" min="1900-01-01" max="2100-12-31" value={filters.to} onChange={event => set({ to: event.target.value })} /></div></>}
      {(report.filters.includes('date') || report.filters.includes('since')) && <div className="form-field"><label htmlFor="stock-report-date">{report.filters.includes('since') ? 'Sem movimentação desde' : 'Data'}</label><input id="stock-report-date" type="date" min="1900-01-01" max="2100-12-31" value={filters.date} onChange={event => set({ date: event.target.value })} /></div>}
      {report.filters.includes('warehouse') && <div className="form-field"><label htmlFor="stock-report-warehouse">Depósito</label><select id="stock-report-warehouse" value={filters.warehouse} onChange={event => set({ warehouse: event.target.value })}><option value="">Todos (depósitos considerados)</option>{selectableWarehouses(warehouses, filters.warehouse).map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' · inativo'}{item.ignore_balance ? ' · saldo desconsiderado' : ''}</option>)}</select></div>}
      {report.filters.includes('limit') && <div className="form-field"><label htmlFor="stock-report-limit">Quantidade de produtos</label><input id="stock-report-limit" inputMode="numeric" maxLength={3} value={filters.limit} onChange={event => set({ limit: event.target.value })} /></div>}
      {report.filters.includes('statuses') && <fieldset className="form-field"><legend>Situações</legend>{PURCHASE_STATUSES.map(([value, label]) => <label key={value}><input type="checkbox" checked={filters.statuses.includes(value)} onChange={() => set({ statuses: filters.statuses.includes(value) ? filters.statuses.filter(item => item !== value) : PURCHASE_STATUSES.map(([key]) => key).filter(key => key === value || filters.statuses.includes(key)) })} />{label}</label>)}</fieldset>}
      {report.filters.includes('poGroup') && <div className="form-field"><label htmlFor="stock-report-group">Agrupar por</label><select id="stock-report-group" value={filters.poGroup} onChange={event => set({ poGroup: event.target.value as ReportFilters['poGroup'] })}><option value="fornecedor">Fornecedor</option><option value="produto">Produto</option></select></div>}
      <button type="submit" className="primary-button" disabled={loading}>Visualizar</button>
    </form>
    {error && <p className="real-alert" role="alert">{error}</p>}{loading && <p role="status">Gerando relatório…</p>}
    {shown && <>
      {nativeReportCoverageText(shown) && <p className="real-notice" role="note">{nativeReportCoverageText(shown)}</p>}
      <div className="stock-dash-tools"><button type="button" className="secondary-button" onClick={() => setPrinting(true)}><Icon name="print" size={12} />Imprimir</button><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportRows('xlsx')}><Icon name="file-excel" size={12} />XLSX</button><button type="button" className="secondary-button" disabled={exporting} onClick={() => void exportRows('csv')}><Icon name="file-lines" size={12} />CSV</button>{exporting && <span role="status">Preparando exportação…</span>}</div>
      {report.id === 'movimentacao-produto' && shown.product && <dl className="stock-edit-facts"><div><dt>Produto</dt><dd>{[shown.product.code, shown.product.name].filter(Boolean).join(' - ')}</dd></div><div><dt>Saldo anterior</dt><dd>{quantityText(shown.opening ?? '0')}</dd></div><div><dt>Saldo final</dt><dd>{quantityText(shown.closing ?? '0')}</dd></div></dl>}
      {points.length > 1 && <figure className="stock-report-chart"><svg viewBox="-10 -10 580 180" role="img" aria-label="Gráfico do saldo do produto"><polyline fill="none" stroke="currentColor" strokeWidth="2" points={points.map(point => `${point.x},${point.y}`).join(' ')} />{points.map(point => <circle key={point.label} cx={point.x} cy={point.y} r="3"><title>{`${point.label === 'Saldo anterior' ? point.label : brDate(point.label)}: ${quantityText(point.value)}`}</title></circle>)}</svg><figcaption>Saldo ao fim de cada dia com lançamento.</figcaption></figure>}
      {locationError && <p className="real-help" role="status">{locationError}</p>}
      <div className="table-scroll" tabIndex={0} role="region" aria-label={report.label}>{table(shownRows)}</div>
      {!shown.items.length && <p className="empty-state">Nenhum resultado encontrado - Verifique os filtros utilizados.</p>}
      {shown.total !== null && shown.limit !== null && shown.offset !== null && shown.total > shown.items.length && <p className="stock-report-pages"><span>{shown.offset + 1}–{shown.offset + shown.items.length} de {shown.total}</span>
        <button type="button" className="text-button" disabled={loading || shown.offset === 0} onClick={() => turn(Math.max(0, shown.offset! - shown.limit!))}>Página anterior</button>
        <button type="button" className="text-button" disabled={loading || shown.offset + shown.items.length >= shown.total} onClick={() => turn(shown.offset! + shown.limit!)}>Próxima página</button></p>}
      {printing && <StockPrintPreview title={report.label} onClose={() => setPrinting(false)}><h1>{report.label}</h1>{nativeReportCoverageText(shown) && <p>{nativeReportCoverageText(shown)}</p>}{table(shownRows)}<p className="stock-print-foot">Emitido em {brDate(today)} (horário de São Paulo).</p></StockPrintPreview>}
    </>}
  </section>;
}
