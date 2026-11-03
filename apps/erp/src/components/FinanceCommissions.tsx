import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges, useUnsavedForm } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney, moneyInput, todaySP, validFinanceDate, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { financialAccount, type FinancialAccount } from '../lib/finance-registry-model';
import { signedMoney } from '../lib/finance-statement-model';
import { COMMISSION_PAGE_SIZE, COMMISSION_RULES, COMMISSION_SITUATIONS, commissionApiPath, commissionPage, commissionParams, commissionResult, commissionRoute, commissionStatement, monthLabel, monthStart, percentInput, shiftMonth,
  type CommissionEntry, type CommissionLine, type CommissionPage, type CommissionRoute, type CommissionStatement } from '../lib/finance-commissions-model';
import { useFinanceCommand, type FinanceCommand } from '../lib/finance-command';
import { rangeLabel } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { CategoryTreePicker, useCategoryTree } from './FinanceCategoryTreeSelect';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-statement.css';
import './finance-commissions.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O registro mudou ou não pode ser alterado aqui. Atualize o extrato.' : error.status === 400 ? 'A operação não foi aceita. Confira os campos.'
  : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'O vendedor ou o lançamento não foi encontrado. Atualize a tela.' : 'Não foi possível concluir a operação. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
function Field({ label, info, children }: { label: string; info?: string; children: (id: string) => ReactNode }) { const id = useId(); return <div className="form-field"><label htmlFor={id} title={info}>{label}{info && <span className="real-help"> ({info})</span>}</label>{children(id)}</div>; }
function MonthNav({ month, onChange, disabled, label = 'Mês' }: { month: string; onChange: (month: string) => void; disabled?: boolean; label?: string }) {
  return <div className="finance-month-nav" role="group" aria-label={label}><button type="button" className="icon-button" aria-label="Mês anterior" disabled={disabled} onClick={() => onChange(shiftMonth(month, -1))}><Icon name="chevron-left" size={12} /></button>
    <strong>{monthLabel(month)}</strong><button type="button" className="icon-button" aria-label="Próximo mês" disabled={disabled} onClick={() => onChange(shiftMonth(month, 1))}><Icon name="chevron-right" size={12} /></button></div>;
}
type Send = (command: FinanceCommand) => Promise<unknown>;
type Panel = { kind: 'payment' | 'entry' | 'manual'; key: string } | { kind: 'delete'; key: string; target: 'commission' | 'entry'; id: string; version: number; label: string };

/**
 * Financeiro > Comissões do Origin (SQL 171). Listagem do mês base (Este mês): Vendedor, Faturado, Saldo ant., (+)Comis. mês,
 * (+)Out. créditos, (-)Out. débitos, (-)Pgtos, (*)Comis. pend. e (=)Saldo, linha Total; o clique na linha abre o extrato do
 * vendedor com Comissões do mês, Créditos, Débitos, Pagamentos efetuados, Comissões pendentes, Resumo e os botões
 * Pagamento, Outro lançamento e Voltar à listagem. "Ver Comissões" de Vendedores abre o extrato (?vendedor=).
 */
export default function FinanceCommissions({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), today = todaySP();
  let parsed: { route: CommissionRoute; error: string };
  try { parsed = { route: commissionRoute(new URLSearchParams(location.search), today), error: '' }; } catch (failure) { parsed = { route: { mes: today.slice(0, 7), situacao: 'all', todos: false, q: '', page: 1, vendedor: null }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [data, setData] = useState<{ key: string; page: CommissionPage | null; statement: CommissionStatement | null; error: string }>({ key: '', page: null, statement: null, error: '' });
  const page = data.key === listKey ? data.page : null, statement = data.key === listKey ? data.statement : null, loading = !parsed.error && (data.key !== listKey || (!data.page && !data.statement && !data.error));
  const [draft, setDraft] = useState({ q: route.q, situacao: route.situacao, todos: route.todos }), [menu, setMenu] = useState<string | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel | null>(null), [showPending, setShowPending] = useState(false), [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'vendas.comissoes');
  const finance = access && writable ? (path: string, options?: { signal?: AbortSignal }) => controller.finance(path, options) : null;
  const payableTree = useCategoryTree(finance, 'payable', scope);
  useEffect(() => { setDraft({ q: route.q, situacao: route.situacao, todos: route.todos }); setMenu(null); setError(''); setPanel(previous => previous && previous.kind === 'delete' ? previous : null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(commissionApiPath(route), { signal: request.signal }).then(value => {
      if (request.signal.aborted || !mayRead()) return;
      setData(route.vendedor ? { key: listKey, page: null, statement: commissionStatement(value, route), error: '' } : { key: listKey, page: commissionPage(value, route), statement: null, error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setData({ key: listKey, page: null, statement: null, error: failure instanceof AccessError ? failureText(failure) : (failure as Error).message || 'Não foi possível conferir as comissões. Tente novamente.' }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    if (!access?.write || !route.vendedor) return; const request = new AbortController();
    void controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo', { signal: request.signal }).then(value => { if (!request.signal.aborted) setAccounts(((value as { items?: unknown[] })?.items ?? []).map(financialAccount)); }).catch(() => { /* The modal asks for the conta. */ });
    return () => request.abort();
  }, [controller, access, route.vendedor]);
  const go = (next: Partial<CommissionRoute>) => navigate(`${location.pathname}?${commissionParams({ ...route, page: 1, ...next }, today)}`);
  const apply = (event?: FormEvent) => { event?.preventDefault(); go({ q: draft.q.trim(), situacao: draft.situacao, todos: draft.todos }); };
  const clear = () => go({ situacao: 'all', todos: false, q: '', mes: route.mes });
  const send: Send = command => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const saved = (text: string) => { if (!mayRead()) return; setPanel(null); setNotice(text); setReload(value => value + 1); };
  const panelVisible = panel && (panel.key === routeKey) ? panel : null;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const errorBox = data.key === listKey && data.error ? <p className="real-alert" role="alert">{data.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p> : null;

  if (route.vendedor) {
    const s = statement;
    const entryMenu = (item: CommissionEntry): RowMenuItem[] => !writable ? [] : item.source === 'payable' ? [{ label: 'Abrir conta a pagar', icon: 'arrow-up-right-from-square', to: `/financeiro-empresa?area=payable&titulo=${item.title_id}` }]
      : [{ label: 'Excluir', icon: 'trash-can', onClick: () => { setMenu(null); if (mayWrite()) setPanel({ kind: 'delete', key: routeKey, target: 'entry', id: item.id, version: item.version, label: `${item.description} de ${financeMoney(item.amount_cents)}` }); } }];
    const lineMenu = (line: CommissionLine): RowMenuItem[] => line.origin === 'manual' && writable ? [{ label: 'Excluir', icon: 'trash-can', onClick: () => { setMenu(null); if (mayWrite()) setPanel({ kind: 'delete', key: routeKey, target: 'commission', id: line.id, version: line.version, label: `${line.description} de ${financeMoney(line.commission_cents)}` }); } }]
      : line.document ? [{ label: 'Abrir conta a receber', icon: 'arrow-up-right-from-square', to: `/financeiro-empresa?area=receivable&titulo=${line.title_id}` }] : [];
    const entries = (title: string, part: CommissionStatement['credits'], columns: 'credit' | 'debit' | 'payment') => <section className="finance-commission-section" aria-label={title}><h3>{title}</h3>
      {!part.items.length ? <p className="real-help">Nenhum lançamento no mês.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr>{columns === 'payment' ? <th>Data</th> : <th>Data operação</th>}{columns === 'credit' && <th>Data crédito</th>}<th>Descrição</th><th className="numeric">{columns === 'payment' ? 'Valor pago' : 'Valor'}</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{part.items.map(item => { const items = entryMenu(item); return <tr key={item.id}><td>{financeDate(item.posted_on)}</td>{columns === 'credit' && <td>{financeDate(item.posted_on)}</td>}<td>{item.description}{item.source === 'cash' && item.account_name ? <small className="real-help"> · {item.account_name}</small> : item.source === 'payable' ? <small className="real-help"> · conta a pagar</small> : null}</td><td className="numeric">{financeMoney(item.amount_cents)}</td>
          <td className="row-actions">{items.length > 0 && <RowMenu label={item.description} items={items} open={menu === item.id} onToggle={() => setMenu(menu === item.id ? null : item.id)} />}</td></tr>; })}</tbody>
        <tfoot><tr><td colSpan={columns === 'credit' ? 3 : 2}>{columns === 'credit' ? 'Total de créditos' : columns === 'debit' ? 'Total de débitos' : 'Total pago'}</td><td className="numeric">{financeMoney(part.amount_cents)}</td><td /></tr></tfoot></table></div>}
      {part.total > part.items.length && <p className="real-help">Mostrando {part.items.length} de {part.total} lançamentos; o total considera todos.</p>}</section>;
    return <>{panelVisible?.kind === 'delete' && <BusyGuard />}
      <header className="real-heading"><div className="finance-heading-title"><h1>Comissões</h1>{s && <span className="real-help">Extrato do vendedor · {s.seller.name}</span>}</div>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
      {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
      {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=comissoes`)}>Limpar filtros da URL</button></section> : <>
        <div className="native-list-toolbar finance-commission-toolbar"><MonthNav month={route.mes} disabled={loading} label="Mês do extrato" onChange={mes => go({ mes, vendedor: route.vendedor })} />
          <div className="origin-toolbar-tools"><ToolButton icon="print" title="Imprimir" disabled={!s} onClick={() => globalThis.window?.print()} /><ToolButton icon="rotate-right" title="Recarregar" disabled={loading} onClick={() => setReload(value => value + 1)} /></div>
          {writable && s && <><button type="button" className="primary-button" onClick={() => { if (mayWrite()) setPanel({ kind: 'payment', key: routeKey }); }}>Pagamento</button><button type="button" className="secondary-button" onClick={() => { if (mayWrite()) setPanel({ kind: 'entry', key: routeKey }); }}>Outro lançamento</button>
            <button type="button" className="secondary-button" onClick={() => { if (mayWrite()) setPanel({ kind: 'manual', key: routeKey }); }}>Comissão manual</button></>}
          <button type="button" className="text-button" onClick={() => go({ vendedor: null, mes: route.mes })}>Voltar à listagem</button></div>
        {loading ? <p role="status">Carregando extrato do vendedor…</p> : errorBox ?? (s && <>
          <section className="finance-commission-rules" aria-label="Tipos de comissões"><h3>Tipos de comissões</h3><ul>{COMMISSION_RULES.map(rule => <li key={rule.id}>{rule.id === s.seller.rule ? <strong>{rule.label}</strong> : rule.label}</li>)}</ul></section>
          <section className="finance-commission-section" aria-label="Comissões do mês"><h3>Comissões do mês</h3>
            {!s.commissions.items.length ? <p className="real-help">Nenhuma comissão liberada no mês.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Data</th><th>Descrição</th><th className="numeric">Valor parcela</th><th className="numeric" title="Descontado o ICMS ST">Base comissão</th><th className="numeric" title="Sobre a base">Comissão Média</th><th className="numeric">Valor comissão</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
              <tbody>{s.commissions.items.map(line => { const items = lineMenu(line); return <tr key={line.id}><td>{financeDate(line.day)}</td><td>{line.description}</td><td className="numeric">{financeMoney(line.parcel_cents)}</td><td className="numeric">{financeMoney(line.base_cents)}</td><td className="numeric">{line.rate.replace('.', ',')}%</td><td className="numeric">{financeMoney(line.commission_cents)}</td>
                <td className="row-actions">{items.length > 0 && <RowMenu label={line.description} items={items} open={menu === line.id} onToggle={() => setMenu(menu === line.id ? null : line.id)} />}</td></tr>; })}</tbody>
              <tfoot><tr><td colSpan={5}>Total de comissões do mês</td><td className="numeric">{financeMoney(s.commissions.commission_cents)}</td><td /></tr></tfoot></table></div>}
            {s.commissions.total > s.commissions.items.length && <p className="real-help">Mostrando {s.commissions.items.length} de {s.commissions.total} comissões; o total considera todas.</p>}</section>
          {entries('(+) Créditos', s.credits, 'credit')}{entries('(-) Débitos', s.debits, 'debit')}{entries('(-) Pagamentos efetuados', s.payments, 'payment')}
          <section className="finance-commission-section" aria-label="Comissões ainda pendentes"><h3>Comissões ainda pendentes <button type="button" className="text-button" onClick={() => setShowPending(value => !value)}>{showPending ? 'Ocultar' : 'Exibir'}</button></h3>
            {showPending && (!s.pending.items.length ? <p className="real-help">Nenhuma comissão pendente.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Data vcto</th><th>Descrição</th><th>Situação</th><th className="numeric">Valor</th></tr></thead>
              <tbody>{s.pending.items.map(item => <tr key={item.id}><td>{financeDate(item.due_on)}</td><td>{item.description}</td><td>{item.situation === 'overdue' ? 'Parcela atrasada' : 'Parcela a vencer'}</td><td className="numeric">{financeMoney(item.commission_cents)}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={3}>Total de comissões pendentes</td><td className="numeric">{financeMoney(s.pending.commission_cents)}</td></tr></tfoot></table></div>)}
            {!showPending && <p className="real-help">Total de comissões pendentes: {financeMoney(s.pending.commission_cents)}</p>}</section>
          <section className="finance-commission-summary" aria-label="Resumo"><h3>Resumo</h3><dl>
            <dt>Saldo anterior</dt><dd>{signedMoney(s.summary.previous_cents)}</dd><dt>(+) Comissões do mês</dt><dd>{financeMoney(s.summary.commission_cents)}</dd><dt>(+) Créditos</dt><dd>{financeMoney(s.summary.credit_cents)}</dd>
            <dt>(-) Débitos</dt><dd>{financeMoney(s.summary.debit_cents)}</dd><dt>(-) Pagamentos</dt><dd>{financeMoney(s.summary.payment_cents)}</dd><dt>Saldo</dt><dd><strong>{signedMoney(s.summary.balance_cents)}</strong></dd></dl></section>
          <p className="real-help">As comissões nascem das contas lançadas pelos pedidos de venda e ordens de serviço do FAGOO, com o vendedor do documento ligado a um vendedor cadastrado. A liberação segue a regra do vendedor e a parcela conta como paga quando o saldo dela chega a zero.</p></>)}
      </>}
      {panelVisible?.kind === 'payment' && s && <PaymentModal statement={s} accounts={accounts} tree={payableTree} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
      {panelVisible?.kind === 'entry' && s && <EntryModal statement={s} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
      {panelVisible?.kind === 'manual' && s && <ManualModal statement={s} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
      {panelVisible?.kind === 'delete' && <DeleteModal panel={panelVisible} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    </>;
  }

  const rows = page?.items ?? [], pages = page ? Math.max(1, Math.ceil(page.total / COMMISSION_PAGE_SIZE)) : 1;
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []),
    ...(route.situacao !== 'all' ? [{ label: `Situação: ${COMMISSION_SITUATIONS.find(item => item.id === route.situacao)!.label}`, onRemove: () => go({ situacao: 'all' }) }] : []),
    ...(route.todos ? [{ label: 'Listar vendedores sem movimentações', onRemove: () => go({ todos: false }) }] : [])];
  const money = (row: CommissionPage['totals'], key: keyof CommissionPage['totals']) => key === 'previous_cents' || key === 'balance_cents' ? signedMoney(row[key]) : financeMoney(row[key]);
  const columns: readonly [keyof CommissionPage['totals'], string, string?][] = [['billed_cents', 'Faturado', 'Somatório total das vendas faturadas que originaram as comissões'], ['previous_cents', 'Saldo ant.'], ['commission_cents', '(+)Comis. mês'], ['credit_cents', '(+)Out. créditos'],
    ['debit_cents', '(-)Out. débitos'], ['payment_cents', '(-)Pgtos'], ['pending_cents', '(*)Comis. pend.'], ['balance_cents', '(=)Saldo']];
  return <>
    <header className="real-heading"><h1>Comissões</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=comissoes`)}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros das comissões"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{COMMISSION_SITUATIONS.map(option => <label key={option.id} htmlFor={`commission-situation-${option.id}`}><input id={`commission-situation-${option.id}`} type="radio" name="commission-situation" checked={draft.situacao === option.id} onChange={() => setDraft(previous => ({ ...previous, situacao: option.id }))} />{option.label}</label>)}</fieldset>
      <label className="finance-drawer-switch" htmlFor="commission-idle"><input id="commission-idle" type="checkbox" checked={draft.todos} onChange={event => { const checked = event.target.checked; setDraft(previous => ({ ...previous, todos: checked })); }} />Listar vendedores sem movimentações</label>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de comissões</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl><p className="real-help">Informações baseadas nos filtros aplicados na listagem.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to="/vendedores-empresa">Vendedores</Link><Link to="/financeiro-empresa?area=receivable">Contas a receber</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="commission-search">Pesquisar na listagem</label><input id="commission-search" type="search" maxLength={120} placeholder="Pesquisar por vendedor" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div><button type="submit" className="secondary-button" disabled={loading || !access}>Pesquisar</button>
        <MonthNav month={route.mes} disabled={loading} label="Data base mensal" onChange={mes => go({ mes })} />
        <div className="origin-toolbar-tools"><ToolButton icon="print" title="Imprimir" disabled={!page} onClick={() => globalThis.window?.print()} /><ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={clear} />
      <div className="real-result-status" role="status">{loading ? 'Carregando comissões…' : page ? rangeLabel(route.page, COMMISSION_PAGE_SIZE, page.total) : data.error || 'Comissões indisponíveis.'}</div>
      {errorBox}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Comissões"><table className="data-table finance-table"><thead><tr><th>Vendedor</th>{columns.map(([key, label, info]) => <th key={key} className="numeric" title={info}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.seller_id} className="finance-row" onClick={event => { if (!(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a')) go({ vendedor: row.seller_id, mes: route.mes }); }}>
          <td><button type="button" className="text-button finance-open" onClick={() => go({ vendedor: row.seller_id, mes: route.mes })}>{row.name}</button></td>{columns.map(([key]) => <td key={key} className="numeric">{money(row, key)}</td>)}</tr>)}</tbody>
        {rows.length > 0 && <tfoot><tr><td>Total</td>{columns.map(([key]) => <td key={key} className="numeric">{money(page.totals, key)}</td>)}</tr></tfoot>}</table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhuma comissão no mês</h2><p>Marque “Listar vendedores sem movimentações” para ver todos os vendedores.</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={COMMISSION_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.page) go({ page: target, mes: route.mes, q: route.q, situacao: route.situacao, todos: route.todos }); }} /></footer></>}
    </NativeListLayout></form>}
  </>;
}

/** Pagamento de comissões: Referente ao mês, Data operação, Categoria, Conta origem, Valor e Descrição. */
function PaymentModal({ statement, accounts, tree, send, mayWrite, onClose, onSaved }: { statement: CommissionStatement; accounts: readonly FinancialAccount[]; tree: ReturnType<typeof useCategoryTree>; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const today = todaySP(), payable = statement.payable;
  const [values, setValues] = useState({ month: statement.month, posted_on: today, category: '', account: accounts.find(item => item.default_movements)?.id ?? '', amount: '', description: 'Pagamento de comissões' });
  const command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  useEffect(() => { if (!values.account && accounts.length) { const fallback = accounts.find(item => item.default_movements)?.id; if (fallback) setValues(previous => previous.account ? previous : { ...previous, account: fallback }); } }, [accounts]);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const save = () => void command.run(() => {
    validFinanceDate(values.posted_on); const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.');
    const description = values.description.trim(); if (!description) throw new Error('Informe a descrição.');
    if (!payable && !values.account) throw new Error('Selecione a conta de origem.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/commission_payment', data: { seller_id: statement.seller.id, month: monthStart(values.month), posted_on: values.posted_on, category_id: values.category || null, account_id: values.account || null, amount_cents: amount, description } };
  }, value => { commissionResult(value, 'commission_payment'); onSaved(payable ? 'Pagamento registrado: a conta a pagar ao vendedor foi incluída.' : 'Pagamento registrado com o lançamento no caixa.'); });
  return <Modal title="Pagamento" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    {payable && <p className="real-notice">“Gerenciar comissões através de contas à pagar” está ligado: o pagamento inclui uma conta a pagar ao vendedor, com vencimento na data da operação.</p>}
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Pagamento de comissões</legend>
      <div className="form-field"><span className="finance-field-label">Referente ao mês *</span><MonthNav month={values.month} label="Referente ao mês" onChange={month => set('month', month)} /></div>
      <Field label="Data operação *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.posted_on} onChange={event => set('posted_on', event.target.value)} />}</Field>
      <Field label="Categoria" info="Categoria de receita/despesa">{id => <CategoryTreePicker id={id} items={tree.items} value={values.category} onChange={next => set('category', next)} error={tree.error} />}</Field>
      <Field label={payable ? 'Conta financeira' : 'Conta origem *'} info="Conta utilizada no lançamento de caixa">{id => <select id={id} value={values.account} onChange={event => set('account', event.target.value)}><option value="">Selecione</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>
      <Field label="Valor *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.amount} onChange={event => set('amount', event.target.value)} />}</Field>
      <Field label="Descrição *">{id => <input id={id} maxLength={240} value={values.description} onChange={event => set('description', event.target.value)} />}</Field></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
/** Outro lançamento: Referente ao mês, Data operação, Valor, Tipo (Crédito | Débito) e Descrição. */
function EntryModal({ statement, send, mayWrite, onClose, onSaved }: { statement: CommissionStatement; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ month: statement.month, posted_on: todaySP(), amount: '', kind: 'credit' as 'credit' | 'debit', description: 'Outro lançamento' });
  const command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const save = () => void command.run(() => {
    validFinanceDate(values.posted_on); const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.');
    const description = values.description.trim(); if (!description) throw new Error('Informe a descrição.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/commission_entry', data: { seller_id: statement.seller.id, month: monthStart(values.month), posted_on: values.posted_on, amount_cents: amount, kind: values.kind, description } };
  }, value => { commissionResult(value, 'commission_entry'); onSaved(values.kind === 'credit' ? 'Crédito incluído no extrato do vendedor.' : 'Débito incluído no extrato do vendedor.'); });
  return <Modal title="Outro lançamento" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Outro lançamento</legend>
      <div className="form-field"><span className="finance-field-label">Referente ao mês *</span><MonthNav month={values.month} label="Referente ao mês" onChange={month => set('month', month)} /></div>
      <Field label="Data operação *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.posted_on} onChange={event => set('posted_on', event.target.value)} />}</Field>
      <Field label="Valor *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.amount} onChange={event => set('amount', event.target.value)} />}</Field>
      <Field label="Tipo *">{id => <select id={id} value={values.kind} onChange={event => set('kind', event.target.value as 'credit' | 'debit')}><option value="credit">Crédito</option><option value="debit">Débito</option></select>}</Field>
      <Field label="Descrição *">{id => <input id={id} maxLength={240} value={values.description} onChange={event => set('description', event.target.value)} />}</Field></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
/** Comissão manual: Data vencimento, Data crédito, Valor parcela e a alíquota (a do vendedor por padrão). */
function ManualModal({ statement, send, mayWrite, onClose, onSaved }: { statement: CommissionStatement; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const today = todaySP(), sellerRate = statement.seller.mode === 'fixa' && statement.seller.rate ? statement.seller.rate.replace(/\.?0+$/, '').replace('.', ',') : '';
  const [values, setValues] = useState({ due_on: today, credit_on: today, amount: '', rate: sellerRate });
  const command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const save = () => void command.run(() => {
    validFinanceDate(values.due_on); validFinanceDate(values.credit_on); const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.');
    const rate = percentInput(values.rate); if (!rate) throw new Error('Informe a alíquota de comissão.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/commission_manual', data: { seller_id: statement.seller.id, due_on: values.due_on, credit_on: values.credit_on, parcel_cents: amount, rate } };
  }, value => { commissionResult(value, 'commission_manual'); onSaved('Comissão manual incluída.'); });
  return <Modal title="Comissão manual" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Comissão manual</legend>
      <Field label="Data vencimento *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.due_on} onChange={event => set('due_on', event.target.value)} />}</Field>
      <Field label="Data crédito *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.credit_on} onChange={event => set('credit_on', event.target.value)} />}</Field>
      <Field label="Valor parcela *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.amount} onChange={event => set('amount', event.target.value)} />}</Field>
      <Field label="Alíquota de comissão (%) *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={8} value={values.rate} onChange={event => set('rate', event.target.value)} />}</Field></fieldset>
    <p className="real-help">A comissão é liberada na data de crédito.</p>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function DeleteModal({ panel, send, mayWrite, onClose, onSaved }: { panel: Extract<Panel, { kind: 'delete' }>; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const command = useFinanceCommand(send, mayWrite, failureText);
  const save = () => void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/commission_delete', data: { target: panel.target, id: panel.id, expected_version: panel.version } }), value => { commissionResult(value, 'commission_delete'); onSaved('Lançamento excluído do extrato do vendedor.'); });
  return <Modal title={command.uncertain ? 'Conferir resultado' : 'Excluir'} onClose={() => { if (!command.busy && !command.uncertain) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={command.busy || command.uncertain} onClick={onClose}>Cancelar</button><button type="button" className="danger-button" disabled={command.busy} onClick={save}>{command.busy ? 'Excluindo…' : command.uncertain ? 'Conferir resultado' : 'Excluir'}</button></>}>
    <p>Deseja mesmo excluir “{panel.label}”?{panel.target === 'entry' ? ' Um pagamento por caixa tem o lançamento desfeito na mesma data.' : ''}</p>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
