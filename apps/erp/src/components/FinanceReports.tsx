import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { financeDate, todaySP } from '../lib/real-finance-model';
import { signedMoney } from '../lib/finance-statement-model';
import { loadReferenceOptions, type ReferenceOption } from '../lib/finance-title-drawer';
import { FINANCE_REPORTS, REPORT_PAGE_SIZE, bucketLabel, categoryKind, categoryLabel, defaultReportPeriod, reportApiPath, reportPaged, reportParams, reportResult, reportRoute,
  type CategoryRow, type ContactRow, type FinanceReport, type FlowRow, type ReportGroup, type ReportResult, type ReportRoute } from '../lib/finance-reports-model';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-statement.css';
import './finance-reports.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 403 ? 'Seu perfil não consulta os relatórios financeiros.' : error.status === 400 ? 'Confira o período (até um ano por dia ou dez anos por mês) e os filtros.'
  : error.status === 404 ? 'A conta financeira não foi encontrada. Atualize a tela.' : 'Não foi possível gerar o relatório. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível gerar o relatório.';
/** Saídas, a pagar and pagos are shown leaving: "1000" → "-1000" (zero stays zero). */
const negate = (cents: string) => cents === '0' ? '0' : cents.startsWith('-') ? cents.slice(1) : `-${cents}`;
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) { const id = useId(); return <div className="form-field"><label htmlFor={id}>{label}</label>{children(id)}</div>; }

function ReportTable({ result, group }: { result: ReportResult; group: ReportGroup }) {
  if (result.report === 'cash_flow' || result.report === 'forecast') {
    const realized = result.report === 'cash_flow', rows = result.items as FlowRow[];
    return <table className="data-table finance-report-table"><thead><tr><th>{group === 'day' ? 'Dia' : 'Mês'}</th><th className="numeric">{realized ? 'Entradas' : 'A receber'}</th><th className="numeric">{realized ? 'Saídas' : 'A pagar'}</th><th className="numeric">Resultado</th><th className="numeric">{realized ? 'Saldo' : 'Saldo previsto'}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.start_on}><td>{bucketLabel(row, group)}</td><td className="numeric">{signedMoney((realized ? row.in_cents : row.receivable_cents) ?? '0')}</td><td className="numeric">{signedMoney(negate((realized ? row.out_cents : row.payable_cents) ?? '0'))}</td>
        <td className="numeric">{signedMoney(row.net_cents)}</td><td className="numeric">{signedMoney(row.balance_cents)}</td></tr>)}</tbody></table>;
  }
  if (result.report === 'categories') return <table className="data-table finance-report-table"><thead><tr><th>Categoria</th><th>Tipo</th><th className="numeric">Valor</th></tr></thead>
    <tbody>{(result.items as CategoryRow[]).map(row => <tr key={row.category_id ?? 'none'}><td>{categoryLabel(row)}</td><td>{categoryKind(row)}</td><td className="numeric">{signedMoney(row.amount_cents)}</td></tr>)}</tbody></table>;
  return <table className="data-table finance-report-table"><thead><tr><th>Cliente/Fornecedor</th><th className="numeric">Recebido</th><th className="numeric">Pago</th><th className="numeric">Saldo</th></tr></thead>
    <tbody>{(result.items as ContactRow[]).map(row => <tr key={row.contact_id}><td>{row.name}</td><td className="numeric">{signedMoney(row.received_cents)}</td><td className="numeric">{signedMoney(negate(row.paid_cents))}</td><td className="numeric">{signedMoney(row.net_cents)}</td></tr>)}</tbody></table>;
}
const SUMMARY: Readonly<Record<FinanceReport, readonly [string, string][]>> = {
  cash_flow: [['previous_cents', 'Saldo anterior'], ['in_cents', 'Entradas'], ['out_cents', 'Saídas'], ['net_cents', 'Resultado do período'], ['closing_cents', 'Saldo final']],
  forecast: [['current_cents', 'Saldo atual'], ['receivable_cents', 'A receber no período'], ['payable_cents', 'A pagar no período'], ['projected_cents', 'Saldo previsto'], ['overdue_receivable_cents', 'A receber atrasadas'], ['overdue_payable_cents', 'A pagar atrasadas']],
  categories: [['in_cents', 'Receitas'], ['out_cents', 'Despesas'], ['net_cents', 'Resultado']],
  contacts: [['received_cents', 'Recebido'], ['paid_cents', 'Pago'], ['net_cents', 'Saldo']],
};
const NEGATIVE = ['out_cents', 'payable_cents', 'overdue_payable_cents', 'paid_cents'];
function Summary({ result }: { result: ReportResult }) {
  return <dl className="native-list-stat finance-report-summary">{SUMMARY[result.report].map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{signedMoney(NEGATIVE.includes(key) ? negate(result.summary[key] ?? '0') : result.summary[key] ?? '0')}</dd></div>)}</dl>;
}

/**
 * Financeiro > Ver relatórios financeiros (Origin, catálogo de relatórios de finanças): Fluxo de caixa realizado e previsto, Receitas e
 * despesas por categoria (com a Categorização para DRE das baixas) e Recebimentos e pagamentos por cliente/fornecedor, com Imprimir.
 * Somente leitura; a resposta mais recente vence e nada aparece depois de uma troca de sessão ou de perfil.
 */
export default function FinanceReports({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), today = todaySP();
  let parsed: { route: ReportRoute; error: string };
  try { parsed = { route: reportRoute(new URLSearchParams(location.search), today), error: '' }; }
  catch (failure) { const period = defaultReportPeriod('cash_flow', today); parsed = { route: { report: 'cash_flow', ...period, account: '', group: 'month', page: 1 }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const key = `${location.search}:${scope}`, current = useRef(key); current.current = key;
  const [reload, setReload] = useState(0), [state, setState] = useState<{ key: string; result: ReportResult | null; error: string }>({ key: '', result: null, error: '' });
  const [accounts, setAccounts] = useState<{ scope: string; items: ReferenceOption[] }>({ scope: '', items: [] }), [printing, setPrinting] = useState(false);
  const [draft, setDraft] = useState({ report: route.report, from: route.from, to: route.to, account: route.account, group: route.group }), [formError, setFormError] = useState('');
  const loadKey = `${key}:${reload}`, result = state.key === loadKey ? state.result : null, loadError = state.key === loadKey ? state.error : '', loading = !parsed.error && allowed && state.key !== loadKey;
  useEffect(() => { setDraft({ report: route.report, from: route.from, to: route.to, account: route.account, group: route.group }); setFormError(''); setPrinting(false); }, [location.search]);
  useEffect(() => {
    if (parsed.error || !allowed) return; const request = new AbortController(), mine = loadKey;
    void controller.finance(reportApiPath(route), { signal: request.signal }).then(value => { if (!request.signal.aborted && current.current === key) setState({ key: mine, result: reportResult(value, route), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && current.current === key) setState({ key: mine, result: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, loadKey]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void loadReferenceOptions((path, options) => controller.finance(path, options), 'accounts', request.signal).then(items => { if (!request.signal.aborted) setAccounts({ scope, items }); }).catch(() => { /* The selector keeps "Todas". */ });
    return () => request.abort();
  }, [controller, scope]);
  const go = (next: ReportRoute) => { try { const search = `?${reportParams(next, today)}`; if (search === location.search) setReload(value => value + 1); else navigate(`${location.pathname}${search}`); } catch (failure) { setFormError((failure as Error).message); } };
  const apply = (event: FormEvent) => { event.preventDefault(); setFormError(''); go({ ...draft, page: 1 }); };
  const choose = (report: FinanceReport) => { const period = defaultReportPeriod(report, today); go({ report, ...period, account: route.account, group: route.group, page: 1 }); };
  const options = accounts.scope === scope ? accounts.items : [], accountName = route.account ? options.find(item => item.id === route.account)?.name ?? 'Conta financeira selecionada' : 'Todas as contas financeiras';
  const meta = FINANCE_REPORTS.find(item => item.id === route.report)!, pages = result && reportPaged(route.report) ? Math.max(1, Math.ceil(result.total / REPORT_PAGE_SIZE)) : 1;
  if (!allowed) return <section className="real-state-panel"><h1>Relatórios financeiros indisponíveis</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <section className="finance-reports">
    <header className="real-heading"><div><h1>Relatórios financeiros</h1><p>{meta.description}</p></div>
      <div><button type="button" className="secondary-button" disabled={!result || !result.items.length} onClick={() => setPrinting(true)}><Icon name="print" size={14} />Imprimir</button></div></header>
    <nav className="cnab-tabs finance-report-tabs" aria-label="Relatórios">{FINANCE_REPORTS.map(item => <button key={item.id} type="button" aria-current={route.report === item.id ? 'page' : undefined} onClick={() => choose(item.id)}>{item.label}</button>)}</nav>
    <form className="finance-report-filters" onSubmit={apply} aria-label="Filtros do relatório">
      <Field label="De">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={draft.from} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, from: value })); }} />}</Field>
      <Field label="Até">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={draft.to} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, to: value })); }} />}</Field>
      <Field label="Conta financeira">{id => <select id={id} value={draft.account} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, account: value })); }}><option value="">Todas as contas financeiras</option>
        {draft.account && !options.some(item => item.id === draft.account) && <option value={draft.account}>Conta financeira selecionada</option>}{options.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (arquivada)'}</option>)}</select>}</Field>
      {!reportPaged(draft.report) && <Field label="Agrupar por">{id => <select id={id} value={draft.group} onChange={event => { const value = event.target.value as ReportGroup; setDraft(previous => ({ ...previous, group: value })); }}><option value="month">Mês</option><option value="day">Dia</option></select>}</Field>}
      <button type="submit" className="primary-button">Gerar relatório</button>
    </form>
    {(parsed.error || formError) && <p className="real-alert" role="alert">{parsed.error || formError}</p>}
    {loadError && <p className="real-alert" role="alert">{loadError} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
    {route.report === 'forecast' && <p className="real-help">Contas em aberto (não canceladas nem excluídas) pelo vencimento{route.account ? ', com esta conta financeira como portador' : ''}. As atrasadas, vencidas antes de hoje, ficam no resumo; as do período também entram nos dias em que venceram.</p>}
    {route.report === 'categories' && <p className="real-help">Valores pela data da baixa ou do lançamento. Juros, multas, descontos e taxas das baixas vão para as categorias da Categorização para DRE gravadas em cada baixa; sem elas, ficam na categoria da conta. Estornos desfazem a baixa no período do estorno. Transferências entre contas ficam de fora.</p>}
    {route.report === 'cash_flow' && !route.account && <p className="real-help">Com todas as contas financeiras, as transferências entre elas não entram em Entradas e Saídas. O saldo é o de todo o razão até o fim de cada período.</p>}
    {loading ? <p role="status">Gerando relatório…</p> : result && <>
      <Summary result={result} />
      <p className="real-help">{accountName} · {financeDate(result.from)} a {financeDate(result.to)}{reportPaged(route.report) ? ` · ${result.total} linha(s)` : ''}</p>
      {result.items.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label={meta.label}><ReportTable result={result} group={route.group} /></div> : <div className="empty-state"><h2>Nada no período</h2><p>Não há valores para os filtros escolhidos.</p></div>}
      {reportPaged(route.report) && pages > 1 && <footer className="table-footer real-pagination"><span>Página {route.page} de {pages}</span><div className="pagination">
        <button type="button" className="secondary-button" disabled={route.page <= 1} onClick={() => go({ ...route, page: route.page - 1 })}>Anterior</button>
        <button type="button" className="secondary-button" disabled={route.page >= pages} onClick={() => go({ ...route, page: route.page + 1 })}>Próxima</button></div></footer>}
    </>}
    {printing && result && <StockPrintPreview title={meta.label} onClose={() => setPrinting(false)}>
      <h1>{meta.label}</h1><p>{accountName} · {financeDate(result.from)} a {financeDate(result.to)}{reportPaged(route.report) && pages > 1 ? ` · página ${route.page} de ${pages}` : ''}</p>
      <Summary result={result} /><ReportTable result={result} group={route.group} /><p className="stock-print-foot">Emitido em {financeDate(today)} (horário de São Paulo).</p>
    </StockPrintPreview>}
  </section>;
}
