import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeDate, financeMoney, todaySP } from '../lib/real-finance-model';
import { signedMoney } from '../lib/finance-statement-model';
import { COMMISSION_ADDITION_LABELS, COMMISSION_RULE_LABELS } from '../lib/document-commissions';
import { COMMISSION_REPORT_PAGE, COMMISSION_REPORT_STATES, commissionReport, commissionReportParams, commissionReportPath, commissionReportRoute, type CommissionReport, type CommissionReportRoute, type CommissionReportState } from '../lib/finance-commission-report';
import './real-finance.css';
import './financeiro-h.css';

const percent = (value: string) => `${value.replace(/\.?0+$/, '').replace('.', ',') || '0'}%`;
const documentLink = (kind: 'sales_orders' | 'service_orders', id: string) => `/documentos-empresa?${new URLSearchParams({ tipo: kind, documento: id })}`;

/**
 * Relatório complementar de comissões (Origin: Vendas › Relatórios › Comissões; leva H, SQL 370). Lê o mesmo registro das comissões:
 * por vendedor, estimada, ajustada, elegível e paga; por operação, a venda, a base, o percentual e a regra congelados na confirmação
 * comercial, o recebido das contas ligadas e o elegível. Nada é recalculado com as regras de hoje.
 */
export default function FinanceCommissionReport({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), today = todaySP();
  let parsed: { route: CommissionReportRoute; error: string };
  try { parsed = { route: commissionReportRoute(new URLSearchParams(location.search), today), error: '' }; }
  catch (failure) { parsed = { route: { de: `${today.slice(0, 7)}-01`, ate: today, situacao: 'all', vendedor: null, page: 1 }, error: (failure as Error).message }; }
  const route = parsed.route, key = `${location.key}:${location.search}`;
  const [draft, setDraft] = useState({ de: route.de, ate: route.ate, situacao: route.situacao });
  const [data, setData] = useState<{ key: string; report: CommissionReport | null; error: string }>({ key: '', report: null, error: '' });
  useEffect(() => { setDraft({ de: route.de, ate: route.ate, situacao: route.situacao }); }, [location.search]);
  useEffect(() => {
    if (parsed.error) return; const request = new AbortController();
    void controller.finance(commissionReportPath(route), { signal: request.signal }).then(value => { if (!request.signal.aborted) setData({ key, report: commissionReport(value, route), error: '' }); })
      .catch(failure => { if (!request.signal.aborted) setData({ key, report: null, error: failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não tem acesso às comissões (Vendas › Comissões).' : (failure as Error).message || 'Não foi possível carregar o relatório.' }); });
    return () => request.abort();
  }, [controller, key]);
  const go = (next: Partial<CommissionReportRoute>) => navigate(`${location.pathname}?${commissionReportParams({ ...route, page: 1, ...next })}`);
  const apply = (event: FormEvent) => { event.preventDefault(); go({ de: draft.de, ate: draft.ate, situacao: draft.situacao }); };
  const report = data.key === key ? data.report : null, failure = parsed.error || (data.key === key ? data.error : '');
  const pages = report ? Math.max(1, Math.ceil(report.total / COMMISSION_REPORT_PAGE)) : 1;
  return <main className="finance-commission-report" id="main-content">
    <header className="real-page-header"><h1>Relatório complementar de comissões</h1>
      <p className="real-help">Comissões estimadas na confirmação comercial de pedidos e OS, com a regra, a base e o percentual daquele momento. O elegível segue a regra do vendedor (na parcial, o recebido das contas da venda); devoluções e cancelamentos ajustam, e os pagamentos vêm do extrato de Financeiro › Comissões.</p>
      <Link to="/financeiro-empresa?area=comissoes" className="text-button">Abrir Comissões</Link></header>
    <form className="finance-commission-report-filters" onSubmit={apply} aria-label="Filtros do relatório">
      <label>Confirmadas de<input type="date" value={draft.de} onChange={event => setDraft({ ...draft, de: event.target.value })} required /></label>
      <label>até<input type="date" value={draft.ate} onChange={event => setDraft({ ...draft, ate: event.target.value })} required /></label>
      <label>Situação<select value={draft.situacao} onChange={event => setDraft({ ...draft, situacao: event.target.value as CommissionReportState })}>{COMMISSION_REPORT_STATES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button type="submit" className="primary-button">Aplicar</button>
      {route.vendedor && <button type="button" className="text-button" onClick={() => go({ vendedor: null })}>Todos os vendedores</button>}
    </form>
    {failure && <p className="real-alert" role="alert">{failure}</p>}
    {!failure && !report && <p role="status">Carregando o relatório…</p>}
    {report && <>
      <section aria-label="Por vendedor"><h2>Por vendedor</h2>
        {!report.sellers.length ? <p className="real-help">Nenhuma comissão no período.</p> : <div className="table-scroll" tabIndex={0}><table className="data-table finance-table"><thead><tr><th>Vendedor</th><th className="numeric">Operações</th><th className="numeric">Estimada</th><th className="numeric">Ajustes</th><th className="numeric">Elegível</th><th className="numeric">Paga no período</th></tr></thead>
          <tbody>{report.sellers.map(item => <tr key={item.seller_id}><td><button type="button" className="text-button" onClick={() => go({ vendedor: item.seller_id })}>{item.name}</button></td><td className="numeric">{item.operations}</td>
            <td className="numeric">{financeMoney(item.estimated_cents)}</td><td className="numeric">{signedMoney(item.adjusted_cents)}</td><td className="numeric">{financeMoney(item.eligible_cents)}</td><td className="numeric">{financeMoney(item.paid_cents)}</td></tr>)}</tbody>
          <tfoot><tr><th colSpan={2}>Total</th><td className="numeric">{financeMoney(report.totals.estimated_cents)}</td><td className="numeric">{signedMoney(report.totals.adjusted_cents)}</td><td className="numeric">{financeMoney(report.totals.eligible_cents)}</td><td className="numeric">{financeMoney(report.totals.paid_cents)}</td></tr></tfoot></table></div>}
      </section>
      <section aria-label="Operações"><h2>Operações</h2>
        {!report.items.length ? <p className="real-help">Nenhuma operação confirmada no período.</p> : <div className="table-scroll" tabIndex={0}><table className="data-table finance-table"><thead><tr><th>Confirmação</th><th>Venda</th><th>Cliente</th><th>Vendedor</th><th>Regra</th><th>Adicionais da base</th><th className="numeric">Base</th><th className="numeric">Alq (%)</th><th className="numeric">Estimada</th><th className="numeric">Ajustes</th><th className="numeric">Recebido</th><th className="numeric">Elegível</th></tr></thead>
          <tbody>{report.items.map(item => <tr key={item.id}><td>{financeDate(item.confirmed_on)}{item.state === 'cancelled' && <small className="real-help"> · cancelada</small>}</td>
            <td><Link to={documentLink(item.kind, item.document_id)}>{item.kind === 'sales_orders' ? 'Pedido' : 'OS'} nº {item.document_number}</Link></td><td>{item.contact_name || '—'}</td><td>{item.seller_name}</td>
            <td>{COMMISSION_RULE_LABELS[item.rule]}</td><td>{item.policy.additions.map(addition => COMMISSION_ADDITION_LABELS[addition]).join(', ') || 'Nenhum'}</td>
            <td className="numeric">{financeMoney(item.base_cents)}</td><td className="numeric">{percent(item.rate)}</td><td className="numeric">{financeMoney(item.estimated_cents)}</td><td className="numeric">{signedMoney(item.adjusted_cents)}</td>
            <td className="numeric">{financeMoney(item.received_cents)} <small className="real-help">de {financeMoney(item.total_cents)}</small></td><td className="numeric">{financeMoney(item.eligible_cents)}</td></tr>)}</tbody></table></div>}
        {pages > 1 && <nav className="finance-commission-report-pages" aria-label="Páginas"><button type="button" className="secondary-button" disabled={route.page <= 1} onClick={() => go({ page: route.page - 1 })}>Anterior</button>
          <span>Página {route.page} de {pages}</span><button type="button" className="secondary-button" disabled={route.page >= pages} onClick={() => go({ page: route.page + 1 })}>Próxima</button></nav>}
      </section></>}
  </main>;
}
