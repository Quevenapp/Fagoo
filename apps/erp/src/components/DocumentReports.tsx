import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AccessError, decimalMoney, type AccessController } from '../lib/real-access';
import { STATES } from '../lib/real-documents-model';
import { brDay } from '../lib/document-list-model';
import { DOCUMENT_LIST_UFS } from '../lib/document-list-model';
import { printDecimal } from '../lib/document-print-model';
import {
  GROUP_LABELS, ORDER_LABELS, PROFIT_BASE_LABELS, PROFIT_BASE_NOTE, REPORT_CATALOG, REPORT_TITLES, ROMANEIO_DATES, SERVICE_COLUMNS, SUBGROUP_LABELS, choiceAll, choiceHas, conditionText, defaultRomaneioParams, defaultSalesParams, lastDays, monthOf,
  readReport, readSalesOptions, nativeReportCoverageText, romaneioAddressText, romaneioQuery, salesReportQuery, serviceCondition, toggleChoice,
  type AbcReport, type Choice, type ProfitBase, type ReportId, type RomaneioParams, type RomaneioReport, type SalesReport, type SalesReportOptions, type SalesReportParams, type SalesReportRow, type ServiceColumn, type ServiceCondition, type ServiceOccurrenceReport, type ServiceReport,
} from '../lib/document-reports-model';
import { readCategoryChoices, type CategoryOption } from '../lib/document-category-model';
import {
  COVERAGE_LABELS, EMPTY_LABELS, FISCAL_UFS, GROUP_HEADERS, barWidths, coverageText, defaultFiscalParams, fiscalReportPath, isFiscalReport, originLabel, readFiscalReport, sourcesText,
  type DifalReport, type FiscalReport, type FiscalReportId, type FiscalReportParams, type InvoiceReport,
} from '../lib/fiscal-reports-model';
import { FREIGHT_MODES } from '../lib/document-commercial-model';
import { Link } from 'react-router-dom';
import { CatalogPicker } from './DocumentCatalogPicker';
import './document-reports.css';

// 202610200238 (wave E): CRIAR RELATÓRIO and Configurar open the gerenciador de relatórios customizados of Preferências › Sistema
// (bases Ordens de Serviço, Pedidos de Venda, Propostas, Compras and the notas), like the Origin gerenciador.relatorio.php.
const CUSTOM_REPORTS_PATH = '/preferencias/sistema/relatorios-customizados';

// Origin "Relatórios de vendas" / "Relatórios de serviço" (202610200130): catalog, parameters, Visualizar and Imprimir.
// Read-only screens: each request is tied to the user and the parameters it was made with; late answers are dropped.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: AccessController) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const failure = (error: unknown) => error instanceof AccessError ? error.status === 403 ? 'Seu perfil não permite consultar este relatório.' : error.status === 400 ? 'Confira os parâmetros do relatório.' : 'Não foi possível gerar o relatório. Tente novamente.' : 'Não foi possível gerar o relatório. Tente novamente.';
const quantity = (value: string) => printDecimal(value);

function useReport<T>(controller: AccessController) {
  const [result, setResult] = useState<T | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const run = (path: string, read: (value: unknown) => T) => {
    current.current?.abort(); const request = new AbortController(), actor = actorOf(controller); current.current = request; setBusy(true); setError('');
    void Promise.resolve().then(() => controller.documents(path, { signal: request.signal })).then(value => {
      if (request.signal.aborted || current.current !== request) return;
      if (actorOf(controller) !== actor) { setError('A sessão mudou durante a consulta. Gere o relatório de novo.'); setResult(null); return; }
      setResult(read(value));
    }).catch(failed => { if (!request.signal.aborted && !aborted(failed)) { setResult(null); setError(failed instanceof Error && failed.message === 'REPORT_INVALID' ? 'O relatório recebido não confere com a consulta. Tente novamente.' : failure(failed)); } })
      .finally(() => { if (current.current === request) { current.current = null; if (!request.signal.aborted) setBusy(false); } });
  };
  return { result, busy, error, setError, run, clear: () => { current.current?.abort(); current.current = null; setBusy(false); setResult(null); } };
}

/** Printable A4 sheet of the report shown on the screen (React text only). */
function ReportPrint({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  const [portal] = useState(() => { const node = document.createElement('div'); node.className = 'document-print-root'; return node; });
  const [printError, setPrintError] = useState(false);
  useEffect(() => { document.body.append(portal); document.body.classList.add('document-print-open'); return () => { document.body.classList.remove('document-print-open'); portal.remove(); }; }, [portal]);
  return createPortal(<div className="document-print-dialog" role="dialog" aria-modal="true" aria-label={`Impressão · ${title}`}>
    <header className="document-print-controls"><div><h2>{title}</h2><p>{subtitle}</p></div><div><button type="button" className="secondary-button" onClick={onClose}>Fechar prévia</button><button type="button" className="primary-button" onClick={() => { setPrintError(false); try { window.print(); } catch { setPrintError(true); } }}>Imprimir relatório</button></div></header>
    {printError && <p className="document-print-error" role="alert">Não foi possível abrir a impressão. Confira as permissões do navegador e tente novamente.</p>}
    <div className="document-print-scroll" tabIndex={0}><article className="commercial-sheet document-report-sheet"><header className="commercial-heading"><div><p className="commercial-brand">FAGOO · Relatório</p><h2>{title}</h2></div><div className="commercial-identity"><span>{subtitle}</span></div></header>{children}</article></div>
  </div>, portal);
}

function Catalog({ kind, onOpen }: { kind: 'sales_orders' | 'service_orders'; onOpen: (id: ReportId) => void }) {
  const groups = REPORT_CATALOG[kind], [tab, setTab] = useState(kind === 'service_orders' ? 'Customizáveis' : '');
  const shown = kind === 'service_orders' ? groups.filter(group => group.title === tab) : groups;
  return <div className="document-reports-catalog">
    {kind === 'service_orders' && <div className="document-reports-tabs" role="tablist">{groups.map(group => <button key={group.title} type="button" role="tab" aria-selected={tab === group.title} className={tab === group.title ? 'is-active' : undefined} onClick={() => setTab(group.title)}>{group.title}</button>)}</div>}
    {shown.map(group => <section key={group.title} className="document-reports-group"><h2>{group.title}</h2><div className="document-reports-cards">{group.cards.map(card => card.id
      ? <button key={card.title} type="button" className="document-report-card" onClick={() => onOpen(card.id!)}><strong>{card.title}</strong><span>{card.description}</span></button>
      : <div key={card.title} className="document-report-card is-unavailable" aria-disabled="true" title={card.reason}><strong>{card.title}</strong><span>{card.description}</span><small>{card.reason}</small></div>)}</div></section>)}
    {kind === 'service_orders' && <aside className="document-reports-tips"><h3>Dicas</h3><p><strong>Relatórios Customizados</strong></p><p>Monte relatórios com as colunas que precisar.</p><Link className="secondary-button" to={CUSTOM_REPORTS_PATH} title="Abre o gerenciador de relatórios customizados (base Ordens de Serviço).">CRIAR RELATÓRIO</Link></aside>}
  </div>;
}

/** Origin checkbox list with Marcar todas / Desmarcar todas and the "Sem vínculo" box (202610200271). */
function Checklist({ prefix, legend, items, choice, noneLabel, note, onChange }: { prefix: string; legend: string; items: { id: string; label: string }[]; choice: Choice | null; noneLabel: string; note?: string; onChange: (next: Choice | null) => void }) {
  const all = items.map(item => item.id);
  return <fieldset className="document-report-checklist"><legend>{legend}</legend>
    <div className="document-report-checklist-tools"><button type="button" className="text-button" onClick={() => onChange(choiceAll(true))}>Marcar todas</button><button type="button" className="text-button" onClick={() => onChange(choiceAll(false))}>Desmarcar todas</button></div>
    <div className="document-report-checklist-items">{items.map(item => <label key={item.id} className="document-check"><input id={`${prefix}-${item.id}`} type="checkbox" checked={choiceHas(choice, item.id)} onChange={event => onChange(toggleChoice(choice, all, item.id, event.target.checked))} />{item.label}</label>)}
      <label className="document-check"><input id={`${prefix}-none`} type="checkbox" checked={choiceHas(choice, '', true)} onChange={event => onChange(toggleChoice(choice, all, '', event.target.checked, true))} />{noneLabel}</label></div>
    {note && <small>{note}</small>}</fieldset>;
}

function SalesReportView({ controller, today, byDistrict }: { controller: AccessController; today: string; byDistrict: boolean }) {
  const [params, setParams] = useState<SalesReportParams>(() => defaultSalesParams(today, byDistrict ? 'district' : 'contact'));
  const [periodMode, setPeriodMode] = useState<'month' | 'day' | 'period'>('month'), [more, setMore] = useState(false), [printing, setPrinting] = useState(false);
  const report = useReport<SalesReport>(controller);
  // 202610200271: Vendedor, Tipo de contato, Tags and what the profile may use; Categorias de receitas e despesas.
  const [options, setOptions] = useState<SalesReportOptions | null>(null), [optionsError, setOptionsError] = useState(false), [categories, setCategories] = useState<CategoryOption[] | null>(null);
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller), current = () => !request.signal.aborted && actorOf(controller) === actor;
    void Promise.resolve().then(() => controller.documents('/v1/documentos/sales_orders/relatorio-vendas/opcoes', { signal: request.signal })).then(value => { if (current()) setOptions(readSalesOptions(value)); })
      .catch(failed => { if (!request.signal.aborted && !aborted(failed)) setOptionsError(true); });
    void Promise.resolve().then(() => controller.documents('/v1/documentos/sales_orders/categorias', { signal: request.signal })).then(value => { if (current()) setCategories(readCategoryChoices(value).items); })
      .catch(failed => { if (!request.signal.aborted && !aborted(failed)) setCategories([]); });
    return () => request.abort();
  }, [controller]);
  // The Brufap notas are read only by admin and fiscal (the server refuses the filter and the Data do faturamento to the other profiles).
  const invoiceReader = ['admin', 'fiscal'].includes(controller.getSnapshot?.()?.membership?.role ?? '');
  const optionsReason = optionsError ? 'Não foi possível carregar as opções do relatório. Volte aos relatórios e abra este de novo.' : 'Carregando as opções do relatório…';
  const profitReason = !options ? optionsReason : options.profit_visible ? undefined : 'Disponível para os perfis que consultam os pedidos de compra (preços de custo e de compra).';
  const change = <K extends keyof SalesReportParams>(key: K, value: SalesReportParams[K]) => { setParams(previous => ({ ...previous, [key]: value })); report.clear(); };
  const view = () => { let query: URLSearchParams; try { query = salesReportQuery({ ...params, showProfit: params.showProfit && Boolean(options?.profit_visible) }); } catch (failed) { report.setError((failed as Error).message); return; }
    if (!invoiceReader) query.delete('without_invoice');
    const sent = { from: params.from, to: params.to, group: params.group };
    report.run(`/v1/documentos/sales_orders/relatorio-vendas?${query}`, value => readReport<SalesReport>(value, 'sales', r => r.from === sent.from && r.to === sent.to && r.group === sent.group)); };
  const shift = (step: number) => { const range = monthOf(params.from, step); setParams(previous => ({ ...previous, ...range })); report.clear(); };
  const period = `${brDay(params.from)} a ${brDay(params.to)}`;
  const money = (value: string | null | undefined) => decimalMoney(value ?? null);
  const table = (result: SalesReport) => { const profit = result.show_profit === true;
    const cells = (row: SalesReportRow) => <><td className="numeric">{row.sales.toLocaleString('pt-BR')}</td><td className="numeric">{quantity(row.items)}</td><td className="numeric">{decimalMoney(row.amount)}</td>{profit && <><td className="numeric">{money(row.cost)}</td><td className="numeric">{money(row.profit)}</td></>}</>;
    return <table className="data-table document-report-table"><thead><tr><th>{byDistrict ? 'Bairro' : GROUP_LABELS[params.group as Exclude<typeof params.group, 'district'>] ?? 'Grupo'}</th><th className="numeric">Quantidade Vendas</th><th className="numeric">Quantidade Itens</th><th className="numeric">Valor</th>{profit && <><th className="numeric">Custo</th><th className="numeric">Lucro</th></>}</tr></thead>
      <tbody>{result.groups.flatMap(group => [<tr key={group.key} className="document-report-group"><td>{group.label}</td>{cells(group)}</tr>,
        ...(group.subgroups ?? []).map(sub => <tr key={`${group.key}/${sub.key}`} className="document-report-sub"><td>{sub.label}</td>{cells(sub)}</tr>)])}</tbody>
      <tfoot><tr><th>Total</th><th className="numeric">{result.totals.sales.toLocaleString('pt-BR')}</th><th className="numeric">{quantity(result.totals.items)}</th><th className="numeric">{decimalMoney(result.totals.amount)}</th>{profit && <><th className="numeric">{money(result.totals.cost)}</th><th className="numeric">{money(result.totals.profit)}</th></>}</tr></tfoot></table>; };
  const profitNote = (result: SalesReport) => result.show_profit ? ` Lucro = Valor − ${(PROFIT_BASE_LABELS[result.profit_base ?? 'cost'] ?? '').toLocaleLowerCase('pt-BR')} × quantidade${result.totals.items_without_cost ? `; ${result.totals.items_without_cost.toLocaleString('pt-BR')} ${result.totals.items_without_cost === 1 ? 'item sem preço base entrou' : 'itens sem preço base entraram'} com custo zero` : ''}.` : '';
  return <div className="document-report">
    <form className="document-report-params" onSubmit={event => { event.preventDefault(); view(); }}>
      <fieldset><legend>Período</legend><div className="document-report-period" role="radiogroup" aria-label="Período">{([['month', 'Do mês'], ['day', 'Do dia'], ['period', 'De um período']] as const).map(([value, label]) => <label key={value}><input type="radio" name="report-period" checked={periodMode === value} onChange={() => { setPeriodMode(value); if (value === 'month') { setParams(previous => ({ ...previous, ...monthOf(previous.from) })); } if (value === 'day') setParams(previous => ({ ...previous, from: today, to: today })); report.clear(); }} />{label}</label>)}</div>
        {periodMode === 'month' && <div className="document-report-month"><button type="button" className="secondary-button" aria-label="Mês anterior" onClick={() => shift(-1)}>‹</button><span>{params.from.slice(5, 7)}/{params.from.slice(0, 4)}</span><button type="button" className="secondary-button" aria-label="Próximo mês" onClick={() => shift(1)}>›</button></div>}
        {periodMode === 'day' && <div className="form-field"><label htmlFor="report-day">Dia</label><input id="report-day" type="date" value={params.from} onChange={event => { const value = event.target.value; setParams(previous => ({ ...previous, from: value, to: value })); report.clear(); }} /></div>}
        {periodMode === 'period' && <div className="document-grid"><div className="form-field"><label htmlFor="report-from">Data inicial</label><input id="report-from" type="date" value={params.from} onChange={event => change('from', event.target.value)} /></div><div className="form-field"><label htmlFor="report-to">Data final</label><input id="report-to" type="date" value={params.to} onChange={event => change('to', event.target.value)} /></div></div>}</fieldset>
      {!byDistrict && <div className="form-field"><label htmlFor="report-group">Agrupar por</label><select id="report-group" value={params.group} onChange={event => { const group = event.target.value as SalesReportParams['group']; setParams(previous => ({ ...previous, group, subgroup: previous.subgroup === group ? 'none' : previous.subgroup })); report.clear(); }}>{Object.entries(GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{params.group === 'seller' && <small>Vendedor do pedido (Cadastros › Vendedores); sem ele, a referência de origem Origin.</small>}</div>}
      <div className="form-field"><label htmlFor="report-status">Situação do pedido</label><select id="report-status" value={params.statuses.length === 1 ? params.statuses[0] : ''} onChange={event => change('statuses', event.target.value ? [event.target.value] : [])}><option value="">Todos</option>{Object.entries(STATES.sales_orders).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <button type="button" className="text-button" aria-expanded={more} onClick={() => setMore(value => !value)}>{more ? 'Ocultar outras opções de pesquisa' : 'Outras opções de pesquisa ›'}</button>
      {more && <div className="document-grid document-report-more">
        <div className="form-field"><label htmlFor="report-date-type">Data a ser considerada na consulta</label><select id="report-date-type" value={params.dateType} onChange={event => change('dateType', event.target.value as SalesReportParams['dateType'])}><option value="date">Data do pedido</option><option value="invoice" disabled={!invoiceReader} title={invoiceReader ? 'Emissão da primeira nota fiscal do FAGOO vinculada ao pedido (não cancelada nem denegada).' : 'Disponível para os perfis Administrador e Fiscal, que consultam as notas fiscais do FAGOO.'}>Data do faturamento</option><option value="expected_date">Data prevista</option></select>{params.dateType === 'invoice' && <small>Emissão da primeira nota fiscal do FAGOO vinculada ao pedido; os pedidos sem nota no FAGOO não entram.</small>}</div>
        {!byDistrict && <div className="form-field"><label htmlFor="report-subgroup">Sub agrupar por</label><select id="report-subgroup" value={params.subgroup} onChange={event => change('subgroup', event.target.value as SalesReportParams['subgroup'])}>{Object.entries(SUBGROUP_LABELS).filter(([value]) => value !== params.group).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>}
        <div className="form-field"><label htmlFor="report-order">Ordenar por</label><select id="report-order" value={params.order} onChange={event => change('order', event.target.value as SalesReportParams['order'])}>{Object.entries(ORDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="form-field"><label className="document-check" title={profitReason}><input id="report-profit" type="checkbox" disabled={!options?.profit_visible} checked={Boolean(options?.profit_visible) && params.showProfit} onChange={event => change('showProfit', event.target.checked)} />Exibir lucro</label>
          {params.showProfit && options?.profit_visible && <><label htmlFor="report-profit-base">Utilizar como base</label><select id="report-profit-base" value={params.profitBase} onChange={event => change('profitBase', event.target.value as SalesReportParams['profitBase'])}>{(Object.entries(PROFIT_BASE_LABELS) as [ProfitBase, string][]).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{PROFIT_BASE_NOTE}</small></>}
          {profitReason && <small>{profitReason}</small>}</div>
        <CatalogPicker controller={controller} entity="warehouses" label="Depósito" selected={params.warehouse} onSelect={row => change('warehouse', row ? { id: row.id, name: row.name } : null)} />
        <label className="document-check"><input id="report-freight" type="checkbox" checked={params.includeFreight} onChange={event => change('includeFreight', event.target.checked)} />Incluir Frete</label>
        <CatalogPicker controller={controller} entity="contacts" label="Cliente" selected={params.contact} onSelect={row => change('contact', row ? { id: row.id, name: row.name } : null)} />
        <div className="form-field"><label htmlFor="report-city">Cidade</label><input id="report-city" maxLength={100} value={params.city} onChange={event => change('city', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="report-state">Estado (UF)</label><select id="report-state" value={params.state} onChange={event => change('state', event.target.value)}><option value="">Todos</option>{DOCUMENT_LIST_UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}</select></div>
        <CatalogPicker controller={controller} entity="contacts" label="Fornecedor" selected={params.supplier} onSelect={row => change('supplier', row ? { id: row.id, name: row.name } : null)} />
        <CatalogPicker controller={controller} entity="products" label="Produtos" selected={params.product} onSelect={row => change('product', row ? { id: row.id, name: row.name } : null)} />
        <div className="form-field"><label htmlFor="report-seller">Vendedor</label><select id="report-seller" value={params.seller} disabled={!options} title={options ? undefined : optionsReason} onChange={event => change('seller', event.target.value)}><option value="">Todos</option>{options?.sellers.map(seller => <option key={seller.id} value={seller.id}>{seller.name}</option>)}</select>{options && options.seller_count > options.sellers.length && <small>São listados os 500 primeiros vendedores por nome.</small>}</div>
        <fieldset className="document-report-checklist"><legend>Categorias de receitas e despesas</legend>
          {categories === null ? <small>Carregando as categorias…</small> : !categories.length ? <small>Nenhuma categoria de receita disponível.</small> : <div className="document-report-checklist-items">{categories.map(category => <label key={category.id} className="document-check" style={{ paddingLeft: `${(category.depth - 1) * 16}px` }}><input id={`report-category-${category.id}`} type="checkbox" checked={params.categories.includes(category.id)} onChange={event => change('categories', event.target.checked ? [...params.categories, category.id] : params.categories.filter(id => id !== category.id))} />{category.name}</label>)}</div>}
          <small>Sem nenhuma marcada, todas entram; uma categoria marcada inclui as subcategorias.</small></fieldset>
        {options ? <Checklist prefix="report-type" legend="Tipo de contato" items={options.contact_types.map(type => ({ id: type.id, label: type.label }))} choice={params.contactTypes} noneLabel="Sem vínculo" onChange={next => change('contactTypes', next)} />
          : <p className="real-help">Tipo de contato: {optionsReason}</p>}
        <label className="document-check" title={invoiceReader ? undefined : 'Disponível para os perfis Administrador e Fiscal, que consultam as notas fiscais do FAGOO.'}><input id="report-without-invoice" type="checkbox" disabled={!invoiceReader} checked={invoiceReader && params.withoutInvoice} onChange={event => change('withoutInvoice', event.target.checked)} />Não considerar pedidos com nota fiscal gerada</label>
        <label className="document-check"><input id="report-first-purchase" type="checkbox" checked={params.firstPurchase} onChange={event => change('firstPurchase', event.target.checked)} />Filtrar por primeira compra</label>
        {options ? <Checklist prefix="report-tag" legend="Tags" items={options.tags.map(tag => ({ id: tag.id, label: tag.name }))} choice={params.tags} noneLabel="Incluir produtos sem classificação" onChange={next => change('tags', next)}
          note={options.tag_count > options.tags.length ? `São listadas as 500 primeiras de ${options.tag_count.toLocaleString('pt-BR')} tags; com todas marcadas, todas entram.` : undefined} />
          : <p className="real-help">Tags: {optionsReason}</p>}
        <p className="real-help">Lojas, Unidades e as origens de canal de venda e de loja virtual não existem no FAGOO.</p>
      </div>}
      <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={report.busy}>{report.busy ? 'Gerando…' : 'Visualizar'}</button><button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div>
    </form>
    {nativeReportCoverageText(report.result) && <p className="real-notice" role="note">{nativeReportCoverageText(report.result)}</p>}
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && <section className="document-report-result" aria-label="Resultado do relatório"><p className="real-help">{period} · {report.result.item_values ? 'Valor = total dos itens (sem frete e sem o desconto do pedido).' : report.result.include_freight ? 'Valor = total dos pedidos, com o frete.' : 'Valor = total dos pedidos, sem o frete.'}{profitNote(report.result)}{report.result.truncated ? ` São exibidos os 2.000 primeiros de ${report.result.group_count.toLocaleString('pt-BR')} grupos.` : ''}</p>
      {report.result.groups.length ? <div className="table-scroll" tabIndex={0}>{table(report.result)}</div> : <p className="empty-state">Nenhuma venda encontrada para os parâmetros informados.</p>}</section>}
    {printing && report.result && <ReportPrint title={byDistrict ? REPORT_TITLES.bairro : REPORT_TITLES.vendas} subtitle={period} onClose={() => setPrinting(false)}>{nativeReportCoverageText(report.result) && <p className="real-notice">{nativeReportCoverageText(report.result)}</p>}{table(report.result)}</ReportPrint>}
  </div>;
}

/** Relatório de Romaneio (202610200271): the pedidos to deliver, with address, transportador, volumes, peso bruto and items. */
function RomaneioView({ controller, today }: { controller: AccessController; today: string }) {
  const [params, setParams] = useState<RomaneioParams>(() => defaultRomaneioParams(today)), [printing, setPrinting] = useState(false), report = useReport<RomaneioReport>(controller);
  const change = <K extends keyof RomaneioParams>(key: K, value: RomaneioParams[K]) => { setParams(previous => ({ ...previous, [key]: value })); report.clear(); };
  const view = () => { let query: URLSearchParams; try { query = romaneioQuery(params); } catch (failed) { report.setError((failed as Error).message); return; }
    const sent = { from: params.from, to: params.to, dateType: params.dateType };
    report.run(`/v1/documentos/sales_orders/romaneio?${query}`, value => readReport<RomaneioReport>(value, 'romaneio', r => r.from === sent.from && r.to === sent.to && r.date_type === sent.dateType)); };
  const freight = (code: string | null) => code === null ? '—' : FREIGHT_MODES[code as keyof typeof FREIGHT_MODES] ?? code;
  const sheet = (result: RomaneioReport) => <div className="document-romaneio">{result.rows.map(row => <section key={row.id} className="document-romaneio-order" aria-label={`Pedido ${row.number}`}>
    <h3>Pedido nº {row.number} · {brDay(row.date)} · {STATES.sales_orders[row.status] ?? row.status}</h3>
    <dl className="document-romaneio-facts"><div><dt>Cliente</dt><dd>{row.contact_name}{row.phone ? ` · ${row.phone}` : ''}</dd></div>
      <div><dt>{row.address.source === 'delivery' ? 'Endereço de entrega' : 'Endereço do cliente'}</dt><dd>{row.address.name ? `${row.address.name} · ` : ''}{romaneioAddressText(row.address)}</dd></div>
      <div><dt>Transportador</dt><dd>{row.carrier ?? '—'}</dd></div><div><dt>Frete por conta</dt><dd>{freight(row.freight_mode)}</dd></div>
      <div><dt>Volumes</dt><dd>{row.volumes === null ? '—' : quantity(row.volumes)}</dd></div><div><dt>Peso bruto</dt><dd>{row.gross_weight === null ? '—' : `${quantity(row.gross_weight)} kg`}</dd></div>
      {row.ship_date && <div><dt>Data saída</dt><dd>{brDay(row.ship_date)}</dd></div>}{row.expected_date && <div><dt>Data prevista</dt><dd>{brDay(row.expected_date)}</dd></div>}</dl>
    <table className="data-table document-report-table"><thead><tr><th>Código</th><th>Descrição</th><th>Un</th><th className="numeric">Quantidade</th></tr></thead>
      <tbody>{row.items.map((item, index) => <tr key={index}><td>{item.code ?? ''}</td><td>{item.description}</td><td>{item.unit ?? ''}</td><td className="numeric">{quantity(item.quantity)}</td></tr>)}</tbody></table></section>)}
    <p className="document-romaneio-totals"><strong>Pedidos:</strong> {result.totals.orders.toLocaleString('pt-BR')} · <strong>Volumes:</strong> {quantity(result.totals.volumes)} · <strong>Peso bruto:</strong> {quantity(result.totals.gross_weight)} kg</p></div>;
  return <div className="document-report">
    <form className="document-report-params" onSubmit={event => { event.preventDefault(); view(); }}>
      <div className="document-grid"><div className="form-field"><label htmlFor="romaneio-from">Data inicial</label><input id="romaneio-from" type="date" value={params.from} onChange={event => change('from', event.target.value)} /></div><div className="form-field"><label htmlFor="romaneio-to">Data final</label><input id="romaneio-to" type="date" value={params.to} onChange={event => change('to', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="romaneio-date-type">Data a ser considerada na consulta</label><select id="romaneio-date-type" value={params.dateType} onChange={event => change('dateType', event.target.value as RomaneioParams['dateType'])}>{Object.entries(ROMANEIO_DATES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="romaneio-status">Situação do pedido</label><select id="romaneio-status" value={params.status} onChange={event => change('status', event.target.value)}><option value="">Todas, exceto canceladas</option>{Object.entries(STATES.sales_orders).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <CatalogPicker controller={controller} entity="contacts" label="Transportador" selected={params.carrier} onSelect={row => change('carrier', row ? { id: row.id, name: row.name } : null)} />
        <CatalogPicker controller={controller} entity="contacts" label="Cliente" selected={params.contact} onSelect={row => change('contact', row ? { id: row.id, name: row.name } : null)} /></div>
      <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={report.busy}>{report.busy ? 'Gerando…' : 'Visualizar'}</button><button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div></form>
    {nativeReportCoverageText(report.result) && <p className="real-notice" role="note">{nativeReportCoverageText(report.result)}</p>}
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && (report.result.rows.length ? <section className="document-report-result" aria-label="Resultado do relatório">{report.result.truncated && <p className="real-help">São exibidos os 100 primeiros de {report.result.row_count.toLocaleString('pt-BR')} pedidos; os totais são de todos. Refine o período ou os filtros.</p>}{sheet(report.result)}</section>
      : <p className="empty-state">Nenhum pedido encontrado para os parâmetros informados.</p>)}
    {printing && report.result && <ReportPrint title={REPORT_TITLES.romaneio} subtitle={`${ROMANEIO_DATES[report.result.date_type]}: ${brDay(report.result.from)} a ${brDay(report.result.to)}`} onClose={() => setPrinting(false)}>{nativeReportCoverageText(report.result) && <p className="real-notice">{nativeReportCoverageText(report.result)}</p>}{sheet(report.result)}</ReportPrint>}
  </div>;
}

function AbcReportView({ controller, today }: { controller: AccessController; today: string }) {
  const [range, setRange] = useState(() => lastDays(today, 30)), [printing, setPrinting] = useState(false), report = useReport<AbcReport>(controller);
  const view = () => { if (!range.from || !range.to || range.from > range.to) { report.setError('Informe um período válido.'); return; } const sent = { ...range };
    report.run(`/v1/documentos/sales_orders/curva-abc?${new URLSearchParams(range)}`, value => readReport<AbcReport>(value, 'abc', r => r.from === sent.from && r.to === sent.to)); };
  useEffect(() => { view(); }, []);
  const table = (result: AbcReport) => <table className="data-table document-report-table"><thead><tr><th>#</th><th>Código</th><th>Descrição</th><th className="numeric">Quantidade</th><th className="numeric">Valor</th><th className="numeric">%</th><th className="numeric">% acumulado</th><th>Curva</th></tr></thead>
    <tbody>{result.items.map(item => <tr key={item.position} className={`document-abc-${item.class.toLowerCase()}`}><td>{item.position}</td><td>{item.code ?? ''}</td><td>{item.description}</td><td className="numeric">{quantity(item.quantity)}</td><td className="numeric">{decimalMoney(item.amount)}</td><td className="numeric">{item.percent.replace('.', ',')}</td><td className="numeric">{item.accumulated.replace('.', ',')}</td><td>{item.class}</td></tr>)}</tbody>
    <tfoot><tr><th colSpan={4}>Total</th><th className="numeric">{decimalMoney(result.total)}</th><th colSpan={3} /></tr></tfoot></table>;
  return <div className="document-report">
    <form className="document-report-params" onSubmit={event => { event.preventDefault(); view(); }}><div className="document-grid"><div className="form-field"><label htmlFor="abc-from">Data inicial</label><input id="abc-from" type="date" value={range.from} onChange={event => { const from = event.target.value; setRange(previous => ({ ...previous, from })); report.clear(); }} /></div><div className="form-field"><label htmlFor="abc-to">Data final</label><input id="abc-to" type="date" value={range.to} onChange={event => { const to = event.target.value; setRange(previous => ({ ...previous, to })); report.clear(); }} /></div></div>
      <p className="real-help">Curva A: itens que somam até 80% do valor vendido; B: até 95%; C: o restante. Pedidos cancelados não entram.</p>
      <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={report.busy}>{report.busy ? 'Gerando…' : 'Visualizar'}</button><button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div></form>
    {nativeReportCoverageText(report.result) && <p className="real-notice" role="note">{nativeReportCoverageText(report.result)}</p>}
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && (report.result.items.length ? <div className="table-scroll" tabIndex={0}>{table(report.result)}</div> : <p className="empty-state">Nenhum item vendido no período.</p>)}
    {printing && report.result && <ReportPrint title={REPORT_TITLES['curva-abc']} subtitle={`${brDay(report.result.from)} a ${brDay(report.result.to)}`} onClose={() => setPrinting(false)}>{nativeReportCoverageText(report.result) && <p className="real-notice">{nativeReportCoverageText(report.result)}</p>}{table(report.result)}</ReportPrint>}
  </div>;
}

function ServiceReportView({ controller, onBack }: { controller: AccessController; onBack: () => void }) {
  const [column, setColumn] = useState<ServiceColumn>('number'), [value, setValue] = useState(''), [conditions, setConditions] = useState<ServiceCondition[]>([]), [printing, setPrinting] = useState(false);
  const report = useReport<ServiceReport>(controller);
  const add = () => { try { const next = serviceCondition(column, value); if (conditions.length >= 10) throw new Error('Use até 10 condições.'); setConditions(previous => [...previous, next]); setValue(''); report.setError(''); report.clear(); } catch (failed) { report.setError((failed as Error).message); } };
  const view = () => report.run(`/v1/documentos/service_orders/relatorio-os${conditions.length ? `?${new URLSearchParams({ condicoes: JSON.stringify(conditions) })}` : ''}`, result => readReport<ServiceReport>(result, 'service_orders', () => true));
  const table = (result: ServiceReport) => <table className="data-table document-report-table"><thead><tr>{Object.values(SERVICE_COLUMNS).map(label => <th key={label} className={['Total das peças', 'Total de serviços', 'Preço total'].includes(label) ? 'numeric' : undefined}>{label}</th>)}</tr></thead>
    <tbody>{result.rows.map(row => <tr key={row.id}><td>{row.number}</td><td>{row.name}</td><td>{brDay(row.date)}</td><td className="numeric">{decimalMoney(row.parts)}</td><td className="numeric">{decimalMoney(row.services)}</td><td className="numeric">{decimalMoney(row.total)}</td><td>{STATES.service_orders[row.status] ?? row.status}</td></tr>)}</tbody></table>;
  return <div className="document-report">
    <div className="document-report-params document-report-conditions"><div className="form-field"><label htmlFor="service-column">Coluna (Ordem de Serviço)</label><select id="service-column" value={column} onChange={event => setColumn(event.target.value as ServiceColumn)}>{Object.entries(SERVICE_COLUMNS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {column === 'status' ? <div className="form-field"><label htmlFor="service-value">Valor</label><select id="service-value" value={value} onChange={event => setValue(event.target.value)}><option value="">Selecione</option>{Object.entries(STATES.service_orders).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
        : <div className="form-field"><label htmlFor="service-value">Valor</label><input id="service-value" maxLength={120} placeholder={column === 'date' ? 'dd/mm/aaaa' : undefined} value={value} onChange={event => setValue(event.target.value)} /></div>}
      <button type="button" className="secondary-button" aria-label="Adicionar condição" onClick={add}>+</button>
      <button type="button" className="primary-button" disabled={report.busy} onClick={view}>{report.busy ? 'Gerando…' : 'Visualizar'}</button>
      <button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div>
    {conditions.length > 0 && <div className="origin-chips" aria-label="Condições">{conditions.map((condition, index) => <span className="origin-chip" key={`${condition.column}:${condition.value}:${index}`}>{conditionText(condition)}<button type="button" aria-label={`Remover condição ${conditionText(condition)}`} onClick={() => { setConditions(previous => previous.filter((_, i) => i !== index)); report.clear(); }}>×</button></span>)}</div>}
    <aside className="document-report-panel"><Link className="secondary-button" to={CUSTOM_REPORTS_PATH} title="Monte no gerenciador de relatórios customizados um relatório de Ordens de Serviço com as colunas e a ordem que precisar.">Configurar</Link><button type="button" className="secondary-button" onClick={onBack}>Voltar à listagem</button>{report.result && <dl className="native-list-stat"><dt>Registros nesta exibição</dt><dd>{report.result.row_count.toLocaleString('pt-BR')}</dd></dl>}</aside>
    {nativeReportCoverageText(report.result) && <p className="real-notice" role="note">{nativeReportCoverageText(report.result)}</p>}
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && (report.result.rows.length ? <div className="table-scroll" tabIndex={0}>{table(report.result)}</div> : <p className="empty-state">A consulta não retornou nenhum registro. Verifique os filtros utilizados nas opções das colunas disponíveis para este relatório customizado ou clique no botão Visualizar.</p>)}
    {printing && report.result && <ReportPrint title={REPORT_TITLES.os} subtitle={conditions.map(conditionText).join(' · ') || 'Todas as ordens de serviço'} onClose={() => setPrinting(false)}>{nativeReportCoverageText(report.result) && <p className="real-notice">{nativeReportCoverageText(report.result)}</p>}{table(report.result)}</ReportPrint>}
  </div>;
}

function ServiceOccurrenceView({ controller, today }: { controller: AccessController; today: string }) {
  const [range, setRange] = useState(() => lastDays(today, 30)), [status, setStatus] = useState(''), [printing, setPrinting] = useState(false), report = useReport<ServiceOccurrenceReport>(controller);
  const view = () => { if (!range.from || !range.to || range.from > range.to) { report.setError('Informe um período válido.'); return; } const sent = { ...range };
    report.run(`/v1/documentos/service_orders/relatorio-ocorrencias?${new URLSearchParams({ ...range, ...(status ? { status } : {}) })}`, value => readReport<ServiceOccurrenceReport>(value, 'service_occurrences', r => r.from === sent.from && r.to === sent.to)); };
  const label = (code: string | null) => code ? STATES.service_orders[code] ?? code : '';
  const table = (result: ServiceOccurrenceReport) => <table className="data-table document-report-table"><thead><tr><th>OS</th><th>Cliente</th><th>Data</th><th>Hora</th><th>Ocorrência</th><th>Usuário</th><th>Situação</th></tr></thead>
    <tbody>{result.rows.map((row, index) => <tr key={`${row.document_id}:${index}`}><td>{row.number}</td><td>{row.name}</td><td>{brDay(row.occurred_on)}</td><td>{row.occurred_time}</td><td>{row.text ?? '—'}</td><td>{row.actor_name ?? 'Usuário'}</td><td>{row.status_after ? `${label(row.status_before)} → ${label(row.status_after)}` : label(row.status_before)}</td></tr>)}</tbody></table>;
  return <div className="document-report">
    <form className="document-report-params" onSubmit={event => { event.preventDefault(); view(); }}><div className="document-grid"><div className="form-field"><label htmlFor="occ-from">Data inicial</label><input id="occ-from" type="date" value={range.from} onChange={event => { const from = event.target.value; setRange(previous => ({ ...previous, from })); report.clear(); }} /></div><div className="form-field"><label htmlFor="occ-to">Data final</label><input id="occ-to" type="date" value={range.to} onChange={event => { const to = event.target.value; setRange(previous => ({ ...previous, to })); report.clear(); }} /></div>
      <div className="form-field"><label htmlFor="occ-status">Situação</label><select id="occ-status" value={status} onChange={event => { setStatus(event.target.value); report.clear(); }}><option value="">Todas</option>{Object.entries(STATES.service_orders).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></div></div>
      <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={report.busy}>{report.busy ? 'Gerando…' : 'Visualizar'}</button><button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div></form>
    {nativeReportCoverageText(report.result) && <p className="real-notice" role="note">{nativeReportCoverageText(report.result)}</p>}
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && (report.result.rows.length ? <><p className="real-help">Registros nesta exibição: {report.result.row_count.toLocaleString('pt-BR')}</p><div className="table-scroll" tabIndex={0}>{table(report.result)}</div></> : <p className="empty-state">Nenhuma ocorrência no período.</p>)}
    {printing && report.result && <ReportPrint title={REPORT_TITLES.ocorrencias} subtitle={`${brDay(report.result.from)} a ${brDay(report.result.to)}`} onClose={() => setPrinting(false)}>{nativeReportCoverageText(report.result) && <p className="real-notice">{nativeReportCoverageText(report.result)}</p>}{table(report.result)}</ReportPrint>}
  </div>;
}

// Leva H (362): Relatórios de Notas Fiscais over the real notes (imported XMLs and the Origin mirror), with origin, coverage and the
// last sync. A value the notes do not bring is "Indisponível", never zero.
const fiscalAmount = (value: string | null) => value === null ? 'Indisponível' : decimalMoney(value);
function FiscalReportView({ controller, today, id }: { controller: AccessController; today: string; id: FiscalReportId }) {
  const [params, setParams] = useState<FiscalReportParams>(() => defaultFiscalParams(id, today)), [printing, setPrinting] = useState(false), report = useReport<FiscalReport>(controller);
  const change = <K extends keyof FiscalReportParams>(key: K, value: FiscalReportParams[K]) => { setParams(previous => ({ ...previous, [key]: value })); report.clear(); };
  const view = () => { let path: string; try { path = fiscalReportPath(id, params); } catch (failed) { report.setError((failed as Error).message); return; }
    const sent = { ...params }; report.run(path, value => readFiscalReport(value, id, sent)); };
  const info = (result: FiscalReport) => <div className="document-report-panel fiscal-report-info">
    <p><strong>Cobertura:</strong> {coverageText(result.coverage)}{result.coverage.notes ? ` — ${COVERAGE_LABELS[id]}` : ''}</p>
    <p><strong>Origem:</strong> {sourcesText(result.sources).join(' · ')}</p>
    <p className="real-help">Faturamento fiscal: só notas de saída autorizadas ou registradas, contadas uma vez (o XML importado prevalece sobre a cópia do Origin). Canceladas, denegadas e as notas de homologação do FAGOO não entram; pedidos e recebimentos não fazem parte deste relatório.</p>
  </div>;
  const difal = (result: DifalReport) => <>
    {result.totals.notes > 0 && result.totals.detailed === 0 && <p className="real-alert" role="status">DIFAL indisponível: nenhuma NF-e do período traz o detalhamento. As notas do espelho do Origin não trazem o grupo do DIFAL; importe o XML autorizado para detalhar.</p>}
    <table className="data-table document-report-table"><thead><tr><th>UF de destino</th><th className="numeric">Notas</th><th className="numeric">Com detalhamento</th><th className="numeric">Sem detalhamento</th><th className="numeric">Valor das notas</th><th className="numeric">ICMS UF destino</th><th className="numeric">ICMS UF remetente</th><th className="numeric">FCP UF destino</th></tr></thead>
      <tbody>{result.groups.map(group => <tr key={group.state ?? 'SEM'}><td>{group.state ?? 'Sem UF'}</td><td className="numeric">{group.notes.toLocaleString('pt-BR')}</td><td className="numeric">{group.detailed.toLocaleString('pt-BR')}</td><td className="numeric">{group.without_detail.toLocaleString('pt-BR')}</td>
        <td className="numeric">{fiscalAmount(group.amount)}</td><td className="numeric">{fiscalAmount(group.dest)}</td><td className="numeric">{fiscalAmount(group.remet)}</td><td className="numeric">{fiscalAmount(group.fcp)}</td></tr>)}</tbody>
      <tfoot><tr><th>Total</th><th className="numeric">{result.totals.notes.toLocaleString('pt-BR')}</th><th className="numeric">{result.totals.detailed.toLocaleString('pt-BR')}</th><th className="numeric">{(result.totals.notes - result.totals.detailed).toLocaleString('pt-BR')}</th>
        <th className="numeric">{fiscalAmount(result.totals.amount)}</th><th className="numeric">{fiscalAmount(result.totals.dest)}</th><th className="numeric">{fiscalAmount(result.totals.remet)}</th><th className="numeric">{fiscalAmount(result.totals.fcp)}</th></tr></tfoot></table>
    {result.truncated && <p className="real-help">São exibidas as 1.000 primeiras de {result.row_count.toLocaleString('pt-BR')} notas; os totais são de todas.</p>}
    <table className="data-table document-report-table"><thead><tr><th>Número</th><th>Série</th><th>Data</th><th>Cliente</th><th>UF</th><th>Origem</th><th className="numeric">Valor</th><th className="numeric">ICMS UF destino</th><th className="numeric">ICMS UF remetente</th><th className="numeric">FCP UF destino</th></tr></thead>
      <tbody>{result.rows.map(row => <tr key={row.ref}><td>{row.number === null ? '—' : String(row.number).padStart(6, '0')}</td><td>{row.series ?? ''}</td><td>{brDay(row.issue_date)}</td><td>{row.contact_name ?? ''}</td><td>{row.state ?? ''}</td><td>{originLabel(row.origin)}</td><td className="numeric">{fiscalAmount(row.amount)}</td>
        {row.detail ? <><td className="numeric">{decimalMoney(row.dest)}</td><td className="numeric">{decimalMoney(row.remet)}</td><td className="numeric">{decimalMoney(row.fcp)}</td></> : <td colSpan={3} className="numeric fiscal-report-missing">Sem detalhamento</td>}</tr>)}</tbody></table>
  </>;
  const grouped = (result: InvoiceReport) => { const kind = id as Exclude<FiscalReportId, 'nf-difal'>, widths = id === 'nf-evolucao' ? barWidths(result.groups) : [], coded = id === 'nf-cliente' || id === 'nf-produto';
    return <>
      {id === 'nf-evolucao' && <div className="fiscal-report-chart" role="img" aria-label="Gráfico do faturamento mês a mês">{result.groups.map((group, index) => <div key={group.key} className="fiscal-report-bar" title={`${group.label ?? group.key}: ${fiscalAmount(group.amount)}`}>
        <span className="fiscal-report-bar-value">{fiscalAmount(group.amount)}</span><span className={widths[index] === null ? 'fiscal-report-bar-fill is-missing' : 'fiscal-report-bar-fill'} style={{ height: `${widths[index] ?? 0}%` }} /><span className="fiscal-report-bar-label">{group.label}</span></div>)}</div>}
      {result.truncated && <p className="real-help">São exibidos os 2.000 primeiros de {result.group_count.toLocaleString('pt-BR')} grupos; os totais são de todos.</p>}
      <table className="data-table document-report-table"><thead><tr><th>{GROUP_HEADERS[kind]}</th>{coded && <th>{id === 'nf-cliente' ? 'CPF/CNPJ' : 'Código'}</th>}<th className="numeric">Notas</th>{id === 'nf-produto' && <th className="numeric">Quantidade</th>}<th className="numeric">{id === 'nf-produto' ? 'Valor dos itens' : 'Valor'}</th><th>Origem</th></tr></thead>
        <tbody>{result.groups.map(group => <tr key={group.key}><td>{group.label ?? EMPTY_LABELS[kind]}</td>{coded && <td>{group.document ?? ''}</td>}<td className="numeric">{group.notes.toLocaleString('pt-BR')}</td>{id === 'nf-produto' && <td className="numeric">{group.quantity === null ? 'Indisponível' : quantity(group.quantity)}</td>}
          <td className="numeric">{fiscalAmount(group.amount)}</td><td>{[group.xml_notes ? `${group.xml_notes} XML` : '', group.origin_notes ? `${group.origin_notes} Origin` : ''].filter(Boolean).join(' · ') || '—'}</td></tr>)}</tbody>
        <tfoot><tr><th>Total das notas</th>{coded && <th />}<th className="numeric">{result.totals.notes.toLocaleString('pt-BR')}</th>{id === 'nf-produto' && <th />}<th className="numeric">{fiscalAmount(result.totals.amount)}</th><th /></tr></tfoot></table>
      {id === 'nf-produto' && <p className="real-help">O valor dos itens não inclui frete, IPI e outras despesas; o total das notas é o valor de cada nota.</p>}
    </>; };
  const body = (result: FiscalReport) => result.report === 'difal' ? difal(result) : grouped(result);
  return <div className="document-report">
    <form className="document-report-params" onSubmit={event => { event.preventDefault(); view(); }}><div className="document-grid">
      <div className="form-field"><label htmlFor="fiscal-report-from">Data inicial</label><input id="fiscal-report-from" type="date" value={params.from} onChange={event => change('from', event.target.value)} /></div>
      <div className="form-field"><label htmlFor="fiscal-report-to">Data final</label><input id="fiscal-report-to" type="date" value={params.to} onChange={event => change('to', event.target.value)} /></div>
      {id === 'nf-difal'
        ? <div className="form-field"><label htmlFor="fiscal-report-state">UF de destino</label><select id="fiscal-report-state" value={params.state} onChange={event => change('state', event.target.value)}><option value="">Todas</option>{FISCAL_UFS.map(uf => <option key={uf} value={uf}>{uf}</option>)}<option value="SEM">Sem UF</option></select></div>
        : <div className="form-field"><label htmlFor="fiscal-report-model">Modelo</label><select id="fiscal-report-model" value={params.model} onChange={event => change('model', event.target.value as FiscalReportParams['model'])}><option value="">NF-e e NFC-e</option><option value="55">NF-e</option><option value="65">NFC-e</option></select></div>}
    </div>
      <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={report.busy}>{report.busy ? 'Gerando…' : 'Visualizar'}</button><button type="button" className="secondary-button" disabled={!report.result || report.busy} onClick={() => setPrinting(true)}>Imprimir</button></div></form>
    {report.error && <p className="real-alert" role="alert">{report.error}</p>}
    {report.result && <section className="document-report-result" aria-label="Resultado do relatório">{info(report.result)}{report.result.coverage.notes || id === 'nf-evolucao' ? body(report.result) : <p className="empty-state">Nenhuma nota autorizada no período.</p>}</section>}
    {printing && report.result && <ReportPrint title={REPORT_TITLES[id]} subtitle={`${brDay(report.result.from)} a ${brDay(report.result.to)}`} onClose={() => setPrinting(false)}>{info(report.result)}{body(report.result)}</ReportPrint>}
  </div>;
}

/** `/documentos-empresa?tipo=<pedidos|OS>&acao=relatorios[&relatorio=<id>]`: the catalog or one report. */
export default function DocumentReports({ controller, kind, report, today, onOpen, onClose }: { controller: AccessController; kind: 'sales_orders' | 'service_orders'; report: ReportId | null; today: string; onOpen: (id: ReportId | null) => void; onClose: () => void }) {
  const title = report ? REPORT_TITLES[report] : kind === 'sales_orders' ? 'Relatórios de vendas' : 'Relatórios de serviço';
  return <section className="real-editor document-reports" aria-labelledby="document-reports-title">
    <header className="real-editor-heading"><div><h2 id="document-reports-title">{title}</h2><p>{kind === 'sales_orders' ? 'Pedidos de venda' : 'Ordens de serviço'} · relatórios somente leitura</p></div><div className="document-editor-buttons"><div>{report && <button type="button" className="secondary-button" onClick={() => onOpen(null)}>Voltar aos relatórios</button>}<button type="button" className="secondary-button" onClick={onClose}>Voltar à listagem</button></div></div></header>
    {!report ? <Catalog kind={kind} onOpen={onOpen} /> : isFiscalReport(report) ? <FiscalReportView key={report} controller={controller} today={today} id={report} /> : report === 'vendas' || report === 'bairro' ? <SalesReportView key={report} controller={controller} today={today} byDistrict={report === 'bairro'} />
      : report === 'romaneio' ? <RomaneioView controller={controller} today={today} />
      : report === 'curva-abc' ? <AbcReportView controller={controller} today={today} /> : report === 'os' ? <ServiceReportView controller={controller} onBack={onClose} /> : <ServiceOccurrenceView controller={controller} today={today} />}
  </section>;
}
