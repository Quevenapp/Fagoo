import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges, useUnsavedForm } from '../hooks/useUnsavedChanges';
import { centsInput, financeDate, financeMoney, moneyInput, todaySP, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { financialAccount, type FinancialAccount } from '../lib/finance-registry-model';
import { signedMoney } from '../lib/finance-statement-model';
import { CASH_CONTROL_PAGE_SIZE, CASH_CONTROL_STATES, cashControlApiPath, cashControlParams, cashControlRoute, cashSessionPage, cashSessionRead, cashSessionResult, type CashControlRoute, type CashSession, type CashSessionPage } from '../lib/finance-cash-control-model';
import { useFinanceCommand, type FinanceCommand } from '../lib/finance-command';
import { badgeClass, rangeLabel } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, PeriodPicker, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { PdvCashGroups, PdvCashMethods, usePdvCashSummary } from './PdvCashSummary';
import './real-finance.css';
import './finance-statement.css';
import './finance-commissions.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const failureText = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O caixa mudou, já está aberto ou não aceita esta operação na situação atual. Atualize a tela.' : error.status === 400 ? 'A operação não foi aceita. Confira os campos.'
  : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'O caixa não foi encontrado. Atualize a listagem.' : 'Não foi possível concluir a operação. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) { const id = useId(); return <div className="form-field"><label htmlFor={id}>{label}</label>{children(id)}</div>; }
const dateTime = (value: string | null) => value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
type Send = (command: FinanceCommand) => Promise<unknown>;
type Method = { id: string; description: string };
type Panel = { kind: 'open'; key: string } | { kind: 'move'; key: string; move: 'withdrawal' | 'supply' } | { kind: 'confirm'; key: string; action: 'session_reopen' | 'session_delete' | 'session_close' | 'session_move_delete'; session: CashSession; moveId?: string; title: string; text: string };

/**
 * Financeiro > Controle de caixa do Origin (SQL 173). Listagem: Pesquisar por operador, Situação (Todos | Abertos | Fechados |
 * Conferidos), "Listar todos os caixas", Período, Excluir, Recarregar e + Abrir Caixa; colunas Loja, Operador, Data, Situação e
 * ⋮ Reabrir Caixa. Detalhe: Conferido, cabeçalho da abertura e do fechamento, Valores informados, Formas de pagamento,
 * Sangrias/Suprimentos e os totais registrados. Sem a frente de caixa, o registrado por forma é zero.
 */
export default function FinanceCashControl({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), today = todaySP();
  let parsed: { route: CashControlRoute; error: string };
  try { parsed = { route: cashControlRoute(new URLSearchParams(location.search)), error: '' }; } catch (failure) { parsed = { route: { situacao: 'all', todos: false, q: '', from: '', to: '', page: 1, caixa: null }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [data, setData] = useState<{ key: string; page: CashSessionPage | null; record: CashSession | null; error: string }>({ key: '', page: null, record: null, error: '' });
  const page = data.key === listKey ? data.page : null, record = data.key === listKey ? data.record : null, loading = !parsed.error && (data.key !== listKey || (!data.page && !data.record && !data.error));
  const [draft, setDraft] = useState({ q: route.q, situacao: route.situacao, todos: route.todos }), [menu, setMenu] = useState<string | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [panel, setPanel] = useState<Panel | null>(null), [selection, setSelection] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] }), selected = selection.key === listKey ? selection.ids : [];
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]), [methods, setMethods] = useState<Method[]>([]);
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'vendas.controle_caixa.ie'), removable = writable && financePermitted(access, 'vendas.controle_caixa.ex');
  useEffect(() => { setDraft({ q: route.q, situacao: route.situacao, todos: route.todos }); setMenu(null); setError(''); setPanel(previous => previous && previous.kind === 'confirm' ? previous : null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(cashControlApiPath(route), { signal: request.signal }).then(value => {
      if (request.signal.aborted || !mayRead()) return;
      setData(route.caixa ? { key: listKey, page: null, record: cashSessionRead(value, route.caixa), error: '' } : { key: listKey, page: cashSessionPage(value, route), record: null, error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setData({ key: listKey, page: null, record: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    if (!access?.write) return; const request = new AbortController();
    void controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo', { signal: request.signal }).then(value => { if (!request.signal.aborted) setAccounts(((value as { items?: unknown[] })?.items ?? []).map(financialAccount).filter(item => item.kind === 'cash')); }).catch(() => { /* Abrir Caixa asks for the conta. */ });
    if (route.caixa) void controller.catalog('/v1/cadastros/formas-pagamento?page=1&size=100', { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const items = (value as { items?: unknown[] })?.items;
      setMethods(Array.isArray(items) ? items.flatMap(item => item && typeof item === 'object' && typeof (item as Method).id === 'string' && typeof (item as Method).description === 'string' && (item as { active?: unknown }).active !== false ? [{ id: (item as Method).id, description: (item as Method).description }] : []) : []);
    }).catch(() => { /* The Valores informados keep the formas already saved. */ });
    return () => request.abort();
  }, [controller, access, route.caixa]);
  const go = (next: Partial<CashControlRoute>) => navigate(`${location.pathname}?${cashControlParams({ ...route, page: 1, caixa: null, ...next })}`);
  const apply = (event?: FormEvent) => { event?.preventDefault(); go({ q: draft.q.trim(), situacao: draft.situacao, todos: draft.todos }); };
  const clear = () => go({ situacao: 'all', todos: false, q: '', from: '', to: '' });
  const send: Send = command => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const saved = (text: string, next?: Partial<CashControlRoute>) => { if (!mayRead()) return; setPanel(null); setNotice(text); if (next) go(next); else setReload(value => value + 1); };
  const panelVisible = panel && panel.key === routeKey ? panel : null;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const errorBox = data.key === listKey && data.error ? <p className="real-alert" role="alert">{data.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p> : null;
  const confirm = (action: Extract<Panel, { kind: 'confirm' }>['action'], target: CashSession, title: string, text: string, moveId?: string) => { setMenu(null); if (mayWrite()) setPanel({ kind: 'confirm', key: routeKey, action, session: target, title, text, moveId }); };
  const label = (item: CashSession) => `${item.account_name} · ${item.operator_name} · ${financeDate(item.opened_on)}`;

  if (route.caixa) return <>{panelVisible?.kind === 'confirm' && <BusyGuard />}
    <header className="real-heading"><h1>Controle de caixa</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p></section> : loading ? <p role="status">Carregando caixa…</p> : errorBox ?? (record && <CashSessionDetail key={`${record.id}:${record.version}`} controller={controller} record={record} methods={methods} writable={writable} send={send} mayWrite={mayWrite}
      onBack={() => go({ caixa: null })} onSaved={text => saved(text)} onMove={move => { if (mayWrite()) setPanel({ kind: 'move', key: routeKey, move }); }}
      onConfirm={(action, title, text, moveId) => confirm(action, record, title, text, moveId)} />)}
    {panelVisible?.kind === 'move' && record && <MoveModal session={record} move={panelVisible.move} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={text => saved(text)} />}
    {panelVisible?.kind === 'confirm' && <ConfirmModal panel={panelVisible} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={(text, gone) => saved(text, gone ? { caixa: null } : undefined)} />}
  </>;

  const rows = page?.items ?? [], pages = page ? Math.max(1, Math.ceil(page.total / CASH_CONTROL_PAGE_SIZE)) : 1;
  const chips = [...(route.q ? [{ label: `Operador: ${route.q}`, onRemove: () => go({ q: '' }) }] : []), ...(route.situacao !== 'all' ? [{ label: `Situação: ${CASH_CONTROL_STATES.find(item => item.id === route.situacao)!.label}`, onRemove: () => go({ situacao: 'all' }) }] : []),
    ...(route.todos ? [{ label: 'Listar todos os caixas', onRemove: () => go({ todos: false }) }] : []), ...(route.from || route.to ? [{ label: `Período: ${route.from ? financeDate(route.from) : '…'} a ${route.to ? financeDate(route.to) : '…'}`, onRemove: () => go({ from: '', to: '' }) }] : [])];
  const rowMenu = (item: CashSession): RowMenuItem[] => !writable ? [] : [
    ...(item.state === 'closed' && !item.checked ? [{ label: 'Reabrir Caixa', icon: 'rotate-left', onClick: () => confirm('session_reopen', item, 'Reabrir Caixa', `Reabrir o caixa ${label(item)}? Os valores informados ficam e o caixa volta a aceitar sangrias e suprimentos.`) }] : []),
    // Controle de caixa > Excluir (vendas.controle_caixa.ex): the server refuses Excluir caixa without it.
    ...(removable ? [{ label: 'Excluir', icon: 'trash-can', separatorBefore: item.state === 'closed', onClick: () => confirm('session_delete', item, 'Excluir caixa', `Excluir o caixa ${label(item)}? Só um caixa sem sangrias nem suprimentos é excluído.`) }] : [])];
  const toggleRow = (id: string) => setSelection(previous => { const ids = previous.key === listKey ? previous.ids : []; return { key: listKey, ids: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] }; });
  const allSelected = rows.length > 0 && rows.every(row => selected.includes(row.id)), selectedOne = selected.length === 1 ? rows.find(row => row.id === selected[0]) ?? null : null;
  return <>{panelVisible?.kind === 'confirm' && <BusyGuard />}
    <header className="real-heading"><h1>Controle de caixa</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=controle-caixa`)}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros do controle de caixa"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{CASH_CONTROL_STATES.map(option => <label key={option.id} htmlFor={`cash-state-${option.id}`}><input id={`cash-state-${option.id}`} type="radio" name="cash-state" checked={draft.situacao === option.id} onChange={() => setDraft(previous => ({ ...previous, situacao: option.id }))} />{option.label}</label>)}</fieldset>
      <label className="finance-drawer-switch" htmlFor="cash-all"><input id="cash-all" type="checkbox" checked={draft.todos} onChange={event => { const checked = event.target.checked; setDraft(previous => ({ ...previous, todos: checked })); }} />Listar todos os caixas</label>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      {writable && <button type="button" className="primary-button" disabled={!accounts.length} title={accounts.length ? undefined : 'Cadastre uma conta financeira do tipo Caixa.'} onClick={() => { if (mayWrite()) setPanel({ kind: 'open', key: routeKey }); }}><Icon name="plus" size={14} />Abrir Caixa</button>}
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de controle de caixa</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl><p className="real-help">Informações baseadas nos filtros aplicados na listagem.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to="/financeiro-empresa?area=accounts">Caixas e bancos</Link><Link to="/formas-pagamento-empresa">Gerenciar formas de pagamento</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="cash-search">Pesquisar na listagem</label><input id="cash-search" type="search" maxLength={120} placeholder="Pesquisar por operador" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div><button type="submit" className="secondary-button" disabled={loading || !access}>Pesquisar</button>
        <PeriodPicker from={route.from} to={route.to} today={today} onApply={range => go({ from: range.from ?? '', to: range.to ?? '' })} />
        <div className="origin-toolbar-tools">{removable && <ToolButton icon="trash-can" title={selectedOne ? 'Excluir' : 'Selecione um caixa para excluir'} disabled={!selectedOne} onClick={() => { if (selectedOne) confirm('session_delete', selectedOne, 'Excluir caixa', `Excluir o caixa ${label(selectedOne)}? Só um caixa sem sangrias nem suprimentos é excluído.`); }} />}
          <ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={clear} />
      <div className="real-result-status" role="status">{loading ? 'Carregando caixas…' : page ? rangeLabel(route.page, CASH_CONTROL_PAGE_SIZE, page.total) : data.error || 'Controle de caixa indisponível.'}</div>
      {errorBox}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Controle de caixa"><table className="data-table finance-table"><thead><tr>{removable && <th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todos" checked={allSelected} onChange={() => setSelection({ key: listKey, ids: allSelected ? [] : rows.map(row => row.id) })} /></th>}<th>Loja</th><th>Operador</th><th>Data</th><th>Situação</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{rows.map(item => { const items = rowMenu(item); return <tr key={item.id} className="finance-row" onClick={event => { if (!(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, label')) go({ caixa: item.id }); }}>
          {removable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${label(item)}`} checked={selected.includes(item.id)} onChange={() => toggleRow(item.id)} /></td>}
          <td><button type="button" className="text-button finance-open" onClick={() => go({ caixa: item.id })}>{item.account_name}</button></td><td>{item.operator_name}</td><td>{dateTime(item.opened_at)}</td>
          <td><span className={badgeClass(item.state === 'open' ? 'Aberto' : 'Fechado')}>{item.state === 'open' ? 'Aberto' : 'Fechado'}</span>{item.checked && <small className="real-help"> · Conferido</small>}</td>
          <td className="row-actions">{items.length > 0 && <RowMenu label={label(item)} items={items} open={menu === item.id} onToggle={() => setMenu(menu === item.id ? null : item.id)} />}</td></tr>; })}</tbody></table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhum caixa encontrado</h2><p>{route.todos ? 'Ajuste os filtros ou abra um caixa.' : 'Marque “Listar todos os caixas” para ver os caixas dos outros operadores.'}</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={CASH_CONTROL_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.page) go({ page: target, situacao: route.situacao, todos: route.todos, q: route.q, from: route.from, to: route.to }); }} /></footer></>}
    </NativeListLayout></form>}
    {panelVisible?.kind === 'open' && <OpenModal accounts={accounts} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={(text, id) => saved(text, { caixa: id })} />}
    {panelVisible?.kind === 'confirm' && <ConfirmModal panel={panelVisible} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={text => saved(text)} />}
  </>;
}

function CashSessionDetail({ controller, record, methods, writable, send, mayWrite, onBack, onSaved, onMove, onConfirm }: { controller: AccessController; record: CashSession; methods: readonly Method[]; writable: boolean; send: Send; mayWrite: () => boolean; onBack: () => void; onSaved: (text: string) => void;
  onMove: (move: 'withdrawal' | 'supply') => void; onConfirm: (action: Extract<Panel, { kind: 'confirm' }>['action'], title: string, text: string, moveId?: string) => void }) {
  const open = record.state === 'open';
  // Frente de caixa (202610200206): vendas registradas neste caixa por forma e por grupo de produtos.
  const pdv = usePdvCashSummary(controller, record.id), cashSales = (pdv?.summary?.methods ?? []).filter(item => item.payment_type === '01').reduce((sum, item) => sum + BigInt(item.registered_cents), 0n) - BigInt(pdv?.summary?.returns_cents ?? '0');
  const [values, setValues] = useState(() => (record.values ?? []).map(item => ({ method: item.payment_method_id, amount: centsInput(item.amount_cents) })));
  const [checked, setChecked] = useState(record.checked);
  const command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm({ values, checked }, command.locked);
  const known = [...methods, ...(record.values ?? []).filter(item => !methods.some(method => method.id === item.payment_method_id)).map(item => ({ id: item.payment_method_id, description: item.payment_method_name }))];
  const payload = () => values.filter(item => item.method || item.amount.trim()).map(item => { if (!item.method) throw new Error('Escolha a forma de pagamento de cada valor informado.'); return { payment_method_id: item.method, amount_cents: moneyInput(item.amount || '0') }; });
  const save = () => void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_save', data: { id: record.id, expected_version: record.version, checked, ...(open ? { values: payload() } : {}) } }), value => { cashSessionResult(value, 'session_save'); onSaved('Caixa salvo.'); });
  const close = () => void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_close', data: { id: record.id, expected_version: record.version, values: payload() } }), value => { cashSessionResult(value, 'session_close'); onSaved('Caixa fechado.'); });
  const totals = (record.methods ?? []).reduce((sum, item) => ({ registered: sum.registered + BigInt(item.registered_cents), informed: sum.informed + BigInt(item.informed_cents), difference: sum.difference + BigInt(item.difference_cents) }), { registered: 0n, informed: 0n, difference: 0n });
  const supplies = (record.moves ?? []).reduce((sum, item) => sum + (item.kind === 'supply' ? BigInt(item.amount_cents) : -BigInt(item.amount_cents)), 0n);
  return <section className="finance-cash-control-detail" aria-label="Caixa">
    {command.uncertain && <BusyGuard />}
    {!open && writable && <label className="finance-drawer-switch" htmlFor="cash-checked"><input id="cash-checked" type="checkbox" role="switch" checked={checked} disabled={command.locked} onChange={event => setChecked(event.target.checked)} />Conferido</label>}
    <dl className="finance-cash-control-head"><div><dt>Loja</dt><dd>{record.account_name}</dd></div><div><dt>Operador da abertura</dt><dd>{record.operator_name}</dd></div><div><dt>Abertura</dt><dd>{dateTime(record.opened_at)}</dd></div>
      <div><dt>Troco caixa anterior</dt><dd>{financeMoney(record.previous_change_cents)}</dd></div><div><dt>Troco</dt><dd>{financeMoney(record.change_cents)}</dd></div>
      <div><dt>Operador fechamento</dt><dd>{record.closed_by_name ?? '—'}</dd></div><div><dt>Fechamento</dt><dd>{dateTime(record.closed_at)}</dd></div></dl>
    <div className="finance-cash-control-cards"><section aria-label="Totais Registrados"><h3>Totais Registrados</h3><dl className="finance-commission-summary"><dt>Troco</dt><dd>{financeMoney(record.change_cents)}</dd><dt>Suprimentos</dt><dd>{financeMoney(record.supply_cents)}</dd>
      <dt>Sangrias</dt><dd>{financeMoney(record.withdrawal_cents)}</dd>{pdv?.summary && <><dt>Vendas em dinheiro (Frente de caixa)</dt><dd>{signedMoney(cashSales.toString())}</dd></>}<dt>Dinheiro esperado</dt><dd><strong>{signedMoney((BigInt(record.expected_cash_cents) + cashSales).toString())}</strong></dd></dl></section></div>
    <section className="finance-commission-section" aria-label="Valores informados"><h3>Valores informados</h3>
      <fieldset className="finance-drawer-fields" disabled={!open || !writable || command.locked}><legend className="real-sr-only">Valores informados</legend>
        {!values.length && <p className="real-help">{open ? 'Informe o valor contado de cada forma de pagamento.' : 'Nenhum valor informado.'}</p>}
        {values.map((item, index) => <div key={index} className="finance-cash-control-value">
          <label className="real-sr-only" htmlFor={`cash-value-method-${index}`}>Forma de pagamento</label><select id={`cash-value-method-${index}`} value={item.method} onChange={event => { const method = event.target.value; setValues(previous => previous.map((row, i) => i === index ? { ...row, method } : row)); }}><option value="">Forma de pagamento</option>{known.map(method => <option key={method.id} value={method.id}>{method.description}</option>)}</select>
          <label className="real-sr-only" htmlFor={`cash-value-amount-${index}`}>Valor</label><input id={`cash-value-amount-${index}`} inputMode="decimal" placeholder="0,00" maxLength={17} value={item.amount} onChange={event => { const amount = event.target.value; setValues(previous => previous.map((row, i) => i === index ? { ...row, amount } : row)); }} />
          <button type="button" className="icon-button" aria-label="Remover valor" title="Remover valor" onClick={() => setValues(previous => previous.filter((_, i) => i !== index))}><Icon name="trash-can" size={14} /></button></div>)}
        {open && writable && <button type="button" className="text-button" disabled={values.length >= 50} onClick={() => setValues(previous => [...previous, { method: '', amount: '' }])}>Adicionar valor</button>}</fieldset></section>
    <section className="finance-commission-section" aria-label="Formas de pagamento"><h3>Formas de pagamento</h3><PdvCashMethods controller={controller} sessionId={record.id} informed={record.methods ?? []} summary={pdv} /></section>
    <section className="finance-commission-section" aria-label="Sangrias/Suprimentos"><h3>Sangrias/Suprimentos {open && writable && <><button type="button" className="secondary-button" disabled={command.locked} onClick={() => onMove('withdrawal')}>Sangria</button><button type="button" className="secondary-button" disabled={command.locked} onClick={() => onMove('supply')}>Suprimento</button></>}</h3>
      {!(record.moves ?? []).length ? <p className="real-help">Nenhuma sangria ou suprimento.</p> : <div className="table-scroll"><table className="data-table finance-table"><thead><tr><th>Data</th><th>Observação</th><th>Tipo</th><th className="numeric">Valor</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{(record.moves ?? []).map(item => <tr key={item.id}><td>{financeDate(item.posted_on)}</td><td>{item.note ?? '—'}</td><td>{item.kind === 'supply' ? 'Suprimento' : 'Sangria'}</td><td className={`numeric ${item.kind === 'supply' ? 'finance-positive' : 'finance-negative'}`}>{financeMoney(item.amount_cents)}</td>
          <td className="row-actions">{open && writable && <button type="button" className="icon-button" aria-label="Excluir movimento" title="Excluir" disabled={command.locked} onClick={() => onConfirm('session_move_delete', item.kind === 'supply' ? 'Excluir suprimento' : 'Excluir sangria', `Excluir ${item.kind === 'supply' ? 'o suprimento' : 'a sangria'} de ${financeMoney(item.amount_cents)}? O lançamento é desfeito na mesma data em Caixas e bancos.`, item.id)}><Icon name="trash-can" size={14} /></button>}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={3}>Total</td><td className="numeric">{signedMoney(supplies.toString())}</td><td /></tr></tfoot></table></div>}</section>
    <PdvCashGroups summary={pdv} />
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={() => globalThis.window?.print()}>Imprimir</button><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onBack)}>Cancelar</button>
      {writable && <button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}
      {writable && open && !command.uncertain && <button type="button" className="danger-button" disabled={command.busy} onClick={close}>Fechar caixa</button>}</div>
  </section>;
}
function OpenModal({ accounts, send, mayWrite, onClose, onSaved }: { accounts: readonly FinancialAccount[]; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string, id: string) => void }) {
  const [values, setValues] = useState({ account: accounts.find(item => item.default_movements)?.id ?? accounts[0]?.id ?? '', change: '' });
  const command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  const save = () => void command.run(() => { if (!values.account) throw new Error('Escolha a conta do caixa.'); return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_open', data: { account_id: values.account, change_cents: moneyInput(values.change || '0') } }; },
    value => { const record = cashSessionResult(value, 'session_open'); onSaved('Caixa aberto.', String(record.id)); });
  return <Modal title="Abrir Caixa" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Abrindo…' : command.uncertain ? 'Conferir resultado' : 'Abrir Caixa'}</button></>}>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Abrir Caixa</legend>
      <Field label="Loja (conta caixa) *">{id => <select id={id} value={values.account} onChange={event => { const account = event.target.value; setValues(previous => ({ ...previous, account })); }}><option value="">Selecione</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>
      <Field label="Troco (R$)">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.change} onChange={event => { const change = event.target.value; setValues(previous => ({ ...previous, change })); }} />}</Field></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function MoveModal({ session, move, send, mayWrite, onClose, onSaved }: { session: CashSession; move: 'withdrawal' | 'supply'; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ amount: '', note: '' }), command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked), title = move === 'supply' ? 'Suprimento' : 'Sangria';
  const save = () => void command.run(() => { const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.'); return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/session_move', data: { id: session.id, expected_version: session.version, kind: move, amount_cents: amount, note: values.note.trim() || null } }; },
    value => { cashSessionResult(value, 'session_move'); onSaved(move === 'supply' ? 'Suprimento registrado no caixa.' : 'Sangria registrada no caixa.'); });
  return <Modal title={title} onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    <p className="real-help">{move === 'supply' ? 'Entrada' : 'Saída'} em {session.account_name}, hoje, como lançamento de Caixas e bancos.</p>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">{title}</legend>
      <Field label="Valor *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} value={values.amount} onChange={event => { const amount = event.target.value; setValues(previous => ({ ...previous, amount })); }} />}</Field>
      <Field label="Observação">{id => <input id={id} maxLength={240} value={values.note} onChange={event => { const note = event.target.value; setValues(previous => ({ ...previous, note })); }} />}</Field></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function ConfirmModal({ panel, send, mayWrite, onClose, onSaved }: { panel: Extract<Panel, { kind: 'confirm' }>; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string, gone: boolean) => void }) {
  const command = useFinanceCommand(send, mayWrite, failureText);
  const save = () => void command.run(() => ({ id: crypto.randomUUID(), path: `/v1/financeiro/actions/${panel.action}`, data: { id: panel.session.id, expected_version: panel.session.version, ...(panel.moveId ? { move_id: panel.moveId } : {}) } }),
    value => { cashSessionResult(value, panel.action); onSaved(panel.action === 'session_reopen' ? 'Caixa reaberto.' : panel.action === 'session_delete' ? 'Caixa excluído.' : 'Movimento excluído do caixa.', panel.action === 'session_delete'); });
  return <Modal title={command.uncertain ? 'Conferir resultado' : panel.title} onClose={() => { if (!command.busy && !command.uncertain) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={command.busy || command.uncertain} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Confirmando…' : command.uncertain ? 'Conferir resultado' : 'Confirmar'}</button></>}>
    <p>{panel.text}</p>{command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
