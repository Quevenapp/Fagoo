import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AccessError } from '../lib/real-access';
import { badgeClass } from '../lib/origin-list';
import { financeDate, financeMoney } from '../lib/real-finance-model';
import { dueAddDays, dueCount, duePeriod, duePeriodFromParams, duePeriodParams, dueReport, dueReportCsv,
  type DuePeriod, type DueReport, type DueReportController } from '../lib/due-date-report-model';
import { Icon } from './Icon';
import NativeListLayout from './NativeListLayout';
import './due-date-report.css';

type OpenTitles = (filter: DuePeriod & { kind: 'receivable' | 'payable' }) => void;
const moment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
export default function DueDateReport({ controller, onOpenTitles }: { controller: DueReportController; onOpenTitles?: OpenTitles }) {
  const [params, setParams] = useSearchParams(), queryKey = params.toString();
  const selection = useMemo(() => { try { return { period: duePeriodFromParams(new URLSearchParams(queryKey)), error: '' }; }
    catch (error) { return { period: null, error: (error as Error).message }; } }, [queryKey]);
  const [draft, setDraft] = useState<DuePeriod>(selection.period ?? { from: '', to: '' }), [formError, setFormError] = useState('');
  const [read, setRead] = useState<{ key: string; report: DueReport | null; error: string; loading: boolean }>({ key: '', report: null, error: '', loading: true });
  const [reload, setReload] = useState(0), [hideEmpty, setHideEmpty] = useState(false), requestKey = `${queryKey}|${reload}`;
  useEffect(() => { setDraft(selection.period ?? { from: '', to: '' }); setFormError(''); }, [selection]);
  useEffect(() => {
    const request = new AbortController();
    setRead({ key: requestKey, report: null, error: '', loading: !selection.error });
    if (!selection.error) {
      const query = duePeriodParams(selection.period).toString();
      void controller.dueReport(`/v1/relatorios/vencimentos${query ? `?${query}` : ''}`, { signal: request.signal }).then(raw => {
        if (request.signal.aborted) return;
        const report = dueReport(raw, selection.period);
        setRead({ key: requestKey, report, error: '', loading: false });
        if (!selection.period) setDraft(previous => previous.from || previous.to ? previous : { from: report.from, to: report.to });
      }).catch(error => {
        if (!request.signal.aborted) setRead({ key: requestKey, report: null, loading: false, error: error instanceof AccessError && error.status === 403
          ? 'Seu perfil não permite consultar os vencimentos financeiros.' : 'Não foi possível conferir o relatório. Tente novamente.' });
      });
    }
    return () => request.abort();
  }, [controller, requestKey, selection]);
  const report = read.key === requestKey ? read.report : null, loading = !selection.error && (read.key !== requestKey || read.loading);
  const error = selection.error || (read.key === requestKey ? read.error : '');
  const apply = (event: FormEvent) => { event.preventDefault(); try { const value = duePeriod(draft.from, draft.to); setFormError('');
    const next = duePeriodParams(value); if (next.toString() === queryKey) setReload(value => value + 1); else setParams(next);
  } catch (failure) { setFormError((failure as Error).message); } };
  const reset = () => { setDraft({ from: '', to: '' }); setFormError(''); if (queryKey) setParams(new URLSearchParams()); else setReload(value => value + 1); };
  const shortcut = (offset: number) => { if (report) setParams(duePeriodParams(duePeriod(report.business_date, dueAddDays(report.business_date, offset)))); };
  const download = () => {
    if (!report || loading) return;
    const url = URL.createObjectURL(new Blob([dueReportCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `vencimentos-${report.from}-a-${report.to}.csv`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const rows = report?.days.filter(row => !hideEmpty || row.receivable_count !== '0' || row.payable_count !== '0') ?? [];
  return <div className="due-date-report">
    <header className="real-heading"><div><h1>Relatório de vencimentos</h1><p>Valores previstos dos títulos do FAGOO.</p></div></header>
    <NativeListLayout filters={<><h3 className="due-filter-label">Período de vencimento</h3>
      <div className="due-shortcuts" role="group" aria-label="Atalhos de período"><button type="button" className="due-shortcut" disabled={!report || loading} onClick={() => shortcut(0)}>Hoje</button><button type="button" className="due-shortcut" disabled={!report || loading} onClick={() => shortcut(6)}>Próximos 7 dias</button><button type="button" className="due-shortcut" onClick={reset}>Próximos 30 dias</button></div>
      <p className="real-help">Escolha um período de até 366 dias. As duas datas são incluídas.</p>
      <h3 className="due-filter-label">Visualização</h3>
      <label className="due-empty-option"><input type="checkbox" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />Exibir apenas dias com títulos</label>
      <p className="real-help">Essa opção altera só a visualização. Totais e CSV sempre consideram o período inteiro.</p></>}
      actions={<><button type="button" className="action-button" disabled={loading || Boolean(selection.error)} onClick={() => setReload(value => value + 1)}><Icon name="arrows-rotate" size={14} />Atualizar consulta</button>
        <button type="button" className="action-button" disabled={!report || loading} onClick={download}><Icon name="upload" size={14} />Exportar CSV agregado</button><p className="real-help">A exportação contém apenas datas, quantidades de títulos e valores, sem dados de clientes ou fornecedores.</p>
        <p className="real-help">Os valores não incluem juros futuros nem saldo bancário. Cancelados e totalmente baixados ficam fora do relatório.</p></>}>
      <form className="due-period" onSubmit={apply} aria-label="Período dos vencimentos"><div className="form-field"><label htmlFor="due-from">Início do período</label><input id="due-from" type="date" min="1900-01-01" max="2100-12-31" required value={draft.from} aria-invalid={Boolean(formError)} aria-describedby={formError ? 'due-period-error' : undefined} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></div>
        <div className="form-field"><label htmlFor="due-to">Fim do período</label><input id="due-to" type="date" min="1900-01-01" max="2100-12-31" required value={draft.to} aria-invalid={Boolean(formError)} aria-describedby={formError ? 'due-period-error' : undefined} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></div><button type="submit" className="primary-button">Visualizar</button></form>
      {formError && <p id="due-period-error" role="alert" className="real-alert">{formError}</p>}
      {error && <p role="alert" className="real-alert">{error} <button type="button" className="text-button" onClick={selection.error ? reset : () => setReload(value => value + 1)}>{selection.error ? 'Limpar período' : 'Tentar novamente'}</button></p>}
      {loading && <p role="status" className="real-result-status">Consultando vencimentos…</p>}
      {report && <><p className="due-context">Período consultado: <strong>{financeDate(report.from)} a {financeDate(report.to)}</strong> · {report.day_count} dia(s). Atualizado em {moment(report.as_of)} · São Paulo.</p>
        <div className="due-totals"><article className="due-total-in"><h2>A receber no período</h2><strong>{financeMoney(report.totals.receivable_cents)}</strong><span>{dueCount(report.totals.receivable_count)} título(s)</span>{onOpenTitles && <button className="text-button" type="button" onClick={() => onOpenTitles({ from: report.from, to: report.to, kind: 'receivable' })}>Ver todos os títulos a receber</button>}</article>
          <article className="due-total-out"><h2>A pagar no período</h2><strong>{financeMoney(report.totals.payable_cents)}</strong><span>{dueCount(report.totals.payable_count)} título(s)</span>{onOpenTitles && <button className="text-button" type="button" onClick={() => onOpenTitles({ from: report.from, to: report.to, kind: 'payable' })}>Ver todos os títulos a pagar</button>}</article>
          <article className={BigInt(report.totals.difference_cents) < 0n ? 'due-negative' : ''}><h2>Diferença prevista</h2><strong>{financeMoney(report.totals.difference_cents)}</strong><span>A receber menos a pagar</span></article></div>
        <p className="due-context">Principal ainda pendente após as baixas registradas. Não representa saldo disponível em caixa ou banco. O histórico do Origin não compõe estes valores.</p>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Valores pendentes por dia de vencimento"><table className="data-table real-table"><thead><tr><th scope="col">Vencimento</th><th scope="col">Títulos a receber</th><th scope="col">A receber</th><th scope="col">Títulos a pagar</th><th scope="col">A pagar</th><th scope="col">Diferença prevista</th></tr></thead><tbody>
          {rows.map(row => <tr key={row.day}><th scope="row">{financeDate(row.day)}{row.day < report.business_date && <span className={badgeClass('Vencido')}>Vencido</span>}{row.day === report.business_date && <span className={badgeClass('Vence hoje')}>Vence hoje</span>}</th><td>{dueCount(row.receivable_count)}</td><td>{onOpenTitles && row.receivable_count !== '0' ? <button type="button" className="text-button" aria-label={`Ver todos os títulos a receber de ${financeDate(row.day)}`} onClick={() => onOpenTitles({ from: row.day, to: row.day, kind: 'receivable' })}>{financeMoney(row.receivable_cents)}</button> : financeMoney(row.receivable_cents)}</td><td>{dueCount(row.payable_count)}</td><td>{onOpenTitles && row.payable_count !== '0' ? <button type="button" className="text-button" aria-label={`Ver todos os títulos a pagar de ${financeDate(row.day)}`} onClick={() => onOpenTitles({ from: row.day, to: row.day, kind: 'payable' })}>{financeMoney(row.payable_cents)}</button> : financeMoney(row.payable_cents)}</td><td className={BigInt(row.difference_cents) < 0n ? 'due-negative' : ''}>{financeMoney(row.difference_cents)}</td></tr>)}
        </tbody><tfoot><tr><th scope="row">Total do período</th><td>{dueCount(report.totals.receivable_count)}</td><td>{financeMoney(report.totals.receivable_cents)}</td><td>{dueCount(report.totals.payable_count)}</td><td>{financeMoney(report.totals.payable_cents)}</td><td>{financeMoney(report.totals.difference_cents)}</td></tr></tfoot></table></div>
        {rows.length === 0 && <div className="empty-state"><h2>Nenhum título pendente no período</h2><p>Todos os dias consultados estão incluídos nos totais acima.</p></div>}
        <p className="due-context">{rows.length} dia(s) exibido(s) de {report.day_count}. Os totais abrangem o período completo.</p>
      </>}
    </NativeListLayout>
  </div>;
}
