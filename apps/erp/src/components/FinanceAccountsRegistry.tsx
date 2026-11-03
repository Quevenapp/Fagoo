import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { ACCOUNTS_PAGE_SIZE, ACCOUNT_TYPES, ACCOUNT_TYPE_LABEL, BOLETO_LABEL, accountBankText, accountMenuShape, accountPage, accountsApiPath, accountsParams, accountsRoute, financialAccount, type AccountPage, type AccountType, type AccountsRoute, type FinancialAccount } from '../lib/finance-registry-model';
import { badgeClass, rangeLabel } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import FinanceAccountEditor from './FinanceAccountEditor';
import { AppliedChips, OriginPagination, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-registry.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const message = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A conta mudou ou está em uso. Atualize a listagem.' : error.status === 400 ? 'A operação não foi aceita para esta conta.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'A conta não foi encontrada. Atualize a listagem.' : 'Não foi possível concluir a consulta. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
type Action = { kind: 'account_set_active' | 'account_set_default' | 'account_delete'; account: FinancialAccount; data: Record<string, unknown>; label: string; confirm: string };
const EMPTY: AccountsRoute = { q: '', situacao: 'ativo', tipos: [], page: 1 };

/**
 * Cadastros > Contas Financeiras do Origin (SQL 135): Situação (Todos | Ativo | Inativo, padrão Ativo), Tipo de Conta (vários),
 * Pesquisar, colunas Instituição, Descrição, Tipo, Situação, Emissão de boleto e Tipo de conta, menu ⋮ que varia pelo tipo,
 * "Quantidade de contas financeiras" do filtro e paginação numerada. O saldo e as transferências ficam em Caixas e bancos.
 */
export default function FinanceAccountsRegistry({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), params = new URLSearchParams(location.search);
  let parsed: { route: AccountsRoute; error: string };
  try { parsed = { route: accountsRoute(params), error: '' }; } catch (failure) { parsed = { route: EMPTY, error: (failure as Error).message }; }
  const route = parsed.route, editId = params.get('editar'), creating = params.get('incluir') === '1';
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  // Sistema › Usuários › Permissões › Finanças (SQL 246): Caixas e Bancos incluir/editar for every change of a conta, excluir to delete it.
  const editable = Boolean(access?.write) && financePermitted(access, 'financas.caixas_bancos.ie'), removable = editable && financePermitted(access, 'financas.caixas_bancos.ex');
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [list, setList] = useState<{ key: string; page: AccountPage | null; error: string }>({ key: '', page: null, error: '' });
  const page = list.key === listKey ? list.page : null, loading = !parsed.error && !editId && !creating && (list.key !== listKey || (!list.page && !list.error));
  const [editing, setEditing] = useState<{ key: string; account: FinancialAccount | null; error: string } | null>(null);
  const [draft, setDraft] = useState({ q: route.q, situacao: route.situacao, tipos: route.tipos }), [menu, setMenu] = useState<string | null>(null);
  const [action, setAction] = useState<(Action & { key: string; command: string; uncertain: boolean; busy: boolean; error: string; minimized?: boolean }) | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const finance = (path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }) => controller.finance(path, options as never);
  useEffect(() => { setDraft({ q: route.q, situacao: route.situacao, tipos: route.tipos }); setMenu(null); setError(''); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(message(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || editId || creating || !mayRead()) return; const request = new AbortController();
    void controller.finance(accountsApiPath(route), { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setList({ key: listKey, page: accountPage(value, route), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setList({ key: listKey, page: null, error: failure instanceof AccessError ? message(failure) : 'Não foi possível conferir as contas financeiras. Tente novamente.' }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    // Editar (deep link ?editar=<id>) reads the account again, so the form starts from its current version.
    if (!access || !editId || !mayRead()) { setEditing(null); return; } const request = new AbortController(); setEditing({ key: routeKey, account: null, error: '' });
    void controller.finance(`/v1/financeiro/contas-financeiras/${encodeURIComponent(editId)}`, { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) { const record = financialAccount((value as { record?: unknown })?.record); if (record.id !== editId) throw new Error('mismatch'); setEditing({ key: routeKey, account: record, error: '' }); } })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setEditing({ key: routeKey, account: null, error: failure instanceof AccessError ? message(failure) : 'Não foi possível abrir a conta financeira.' }); });
    return () => request.abort();
  }, [controller, access, routeKey]);
  const go = (next: Partial<AccountsRoute>, extra: Record<string, string> = {}) => { const target = accountsParams({ ...route, page: 1, ...next }); for (const [key, value] of Object.entries(extra)) target.set(key, value); navigate(`${location.pathname}?${target}`); };
  const apply = (event?: FormEvent) => { event?.preventDefault(); go({ q: draft.q.trim(), situacao: draft.situacao, tipos: draft.tipos }); };
  const clear = () => go(EMPTY);
  const backToList = () => navigate(`${location.pathname}?${accountsParams({ ...route })}`);
  const start = (kind: Action['kind'], account: FinancialAccount, data: Record<string, unknown>, label: string, confirm: string) => { setMenu(null); if (!mayWrite() || action?.uncertain) return; setAction({ kind, account, data: { id: account.id, expected_version: account.version, ...data }, label, confirm, key: routeKey, command: crypto.randomUUID(), uncertain: false, busy: false, error: '' }); };
  const run = async () => {
    if (!action || action.busy) return; if (!mayWrite()) { setAction({ ...action, error: 'Seu acesso a esta operação foi alterado.' }); return; }
    const state = { ...action, busy: true, error: '' }; setAction(state);
    try { await controller.finance(`/v1/financeiro/actions/${state.kind}`, { method: 'POST', body: { command_id: state.command, data: structuredClone(state.data) } } as never); if (!mayRead()) return; setAction(null); setNotice(`${state.label}: ${state.account.name}.`); setReload(value => value + 1); }
    catch (failure) {
      if (!mayRead()) return;
      const definitive = failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status) && !state.uncertain;
      setAction({ ...state, busy: false, uncertain: !definitive, error: definitive ? message(failure) : 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.' });
    }
  };
  const items = (account: FinancialAccount): RowMenuItem[] => {
    const shape = accountMenuShape(account); if (shape === 'none' || !editable) return [];
    const toDefault: RowMenuItem = { label: 'Tornar padrão movimentações', icon: 'star', disabled: account.default_movements || !account.active, title: account.default_movements ? 'Esta já é a conta padrão de movimentações.' : !account.active ? 'Ative a conta antes.' : undefined,
      onClick: () => start('account_set_default', account, { target: 'movements', value: true }, 'Conta padrão de movimentações', `Tornar “${account.name}” a conta padrão de movimentações? A conta padrão atual deixa de ser.`) };
    if (shape === 'cash') return [toDefault];
    const list: RowMenuItem[] = [{ label: 'Editar', icon: 'pen-to-square', onClick: () => { setMenu(null); go({}, { editar: account.id }); } },
      account.active ? { label: 'Inativar', icon: 'ban', onClick: () => start('account_set_active', account, { active: false }, 'Conta inativada', `Inativar “${account.name}”? Ela deixa de aparecer nas baixas e transferências e sai dos padrões.`) }
        : { label: 'Ativar', icon: 'check', onClick: () => start('account_set_active', account, { active: true }, 'Conta ativada', `Ativar “${account.name}”?`) }];
    if (account.boleto !== 'none') list.push(account.default_boleto ? { label: 'Desmarcar padrão boleto', icon: 'file-invoice-dollar', onClick: () => start('account_set_default', account, { target: 'boleto', value: false }, 'Padrão boleto desmarcado', `Desmarcar “${account.name}” como padrão de emissão de boletos?`) }
      : { label: 'Marcar padrão boleto', icon: 'file-invoice-dollar', disabled: !account.active, onClick: () => start('account_set_default', account, { target: 'boleto', value: true }, 'Padrão boleto marcado', `Tornar “${account.name}” a conta padrão de emissão de boletos?`) });
    list.push(toDefault);
    if (removable) list.push({ label: 'Excluir', icon: 'trash-can', disabled: account.in_use, title: account.in_use ? 'A conta tem lançamentos, contas, cobrança, borderôs, extratos ou formas de pagamento. Use Inativar.' : undefined, separatorBefore: true,
      onClick: () => start('account_delete', account, {}, 'Conta excluída', `Deseja mesmo excluir a conta “${account.name}”? ${account.opening_cents && account.opening_cents !== '0' ? 'O saldo inicial é compensado na mesma data. ' : ''}O cadastro e a auditoria continuam guardados.`) });
    return list;
  };
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []),
    ...(route.situacao !== 'todos' ? [{ label: `Situação: ${route.situacao === 'ativo' ? 'Ativo' : 'Inativo'}`, onRemove: () => go({ situacao: 'todos' }) }] : []),
    ...(route.tipos.length ? [{ label: `Tipo de Conta: ${route.tipos.map(type => ACCOUNT_TYPE_LABEL[type]).join(', ')}`, onRemove: () => go({ tipos: [] }) }] : [])];
  const pages = page ? Math.max(1, Math.ceil(page.total / ACCOUNTS_PAGE_SIZE)) : 1, rows = page?.items ?? [];
  const actionVisible = action && action.key === routeKey ? action : null;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  if (editId || creating) {
    if (!access) return <section className="real-state-panel"><p role="status">{error || 'Conferindo acesso ao financeiro…'}</p></section>;
    if (creating && !editable) return <section className="real-state-panel"><h1>Inclusão não liberada</h1><p>Seu perfil consulta as contas financeiras, sem incluir.</p><button type="button" className="secondary-button" onClick={backToList}>Voltar</button></section>;
    const loaded = editing && editing.key === routeKey ? editing : null;
    if (editId && !loaded?.account) return <section className="real-state-panel"><p role={loaded?.error ? 'alert' : 'status'}>{loaded?.error || 'Carregando conta financeira…'}</p><button type="button" className="secondary-button" onClick={backToList}>Voltar</button></section>;
    return <FinanceAccountEditor key={`${editId ?? 'new'}:${loaded?.account?.version ?? 0}:${scope}`} finance={finance} account={loaded?.account ?? null} writable={editable} mayWrite={mayWrite} onBack={backToList}
      onSaved={(saved, created) => { if (!mayRead()) return; setNotice(created ? `Conta financeira “${saved.name}” incluída.` : `Conta financeira “${saved.name}” atualizada.`); setReload(value => value + 1); backToList(); }} />;
  }
  return <>{actionVisible?.uncertain && <BusyGuard />}
    <header className="real-heading"><h1>Contas Financeiras</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={clear}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros das contas financeiras"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{([['todos', 'Todos'], ['ativo', 'Ativo'], ['inativo', 'Inativo']] as const).map(([value, label]) => <label key={value} htmlFor={`account-situation-${value}`}><input id={`account-situation-${value}`} type="radio" name="account-situation" checked={draft.situacao === value} onChange={() => setDraft(previous => ({ ...previous, situacao: value }))} />{label}</label>)}</fieldset>
      <fieldset className="finance-status-filter"><legend>Tipo de Conta</legend>
        <label htmlFor="account-type-all"><input id="account-type-all" type="checkbox" checked={!draft.tipos.length} onChange={() => setDraft(previous => ({ ...previous, tipos: [] }))} />Todos</label>
        {ACCOUNT_TYPES.map(type => <label key={type} htmlFor={`account-type-filter-${type}`}><input id={`account-type-filter-${type}`} type="checkbox" checked={draft.tipos.includes(type)} onChange={event => { const checked = event.target.checked; setDraft(previous => ({ ...previous, tipos: checked ? [...previous.tipos.filter(item => item !== type), type] as AccountType[] : previous.tipos.filter(item => item !== type) })); }} />{ACCOUNT_TYPE_LABEL[type]}</label>)}</fieldset>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      {editable && <button type="button" className="primary-button" onClick={() => go({}, { incluir: '1' })}><Icon name="plus" size={16} />Incluir conta financeira</button>}
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de contas financeiras</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl><p className="real-help">Informações baseadas nos filtros aplicados na listagem.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to="/financeiro-empresa?area=accounts">Caixas e bancos</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="accounts-search">Pesquisar na listagem</label><input id="accounts-search" type="search" maxLength={120} placeholder="Pesquisar" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !access}><Icon name="search" size={16} /></button>
        <div className="origin-toolbar-tools"><ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={clear} />
      <div className="real-result-status" role="status">{loading ? 'Carregando contas financeiras…' : page ? rangeLabel(route.page, ACCOUNTS_PAGE_SIZE, page.total) : list.error || 'Contas financeiras indisponíveis.'}</div>
      {list.key === listKey && list.error && <p className="real-alert" role="alert">{list.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Contas financeiras"><table className="data-table finance-table"><thead><tr><th>Instituição</th><th>Descrição</th><th>Tipo</th><th>Situação</th><th>Emissão de boleto</th><th>Tipo de conta</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{rows.map(account => { const menuItems = items(account), openable = account.account_type !== 'integration';
          return <tr key={account.id} className="finance-row" onClick={event => { if (openable && !(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, label')) go({}, { editar: account.id }); }}>
            <td><span className="finance-institution"><Icon name={account.account_type === 'cash' ? 'cash-register' : account.institution_name ? 'building-columns' : 'money-bill-1'} size={14} />{account.institution_name ?? '—'}</span></td>
            <td><button type="button" className="text-button finance-open" disabled={!openable} onClick={() => go({}, { editar: account.id })}>{account.name}</button>{accountBankText(account) && <small className="real-help"> · {accountBankText(account)}</small>}{account.default_movements && <span className="finance-pill" title="Conta padrão de movimentações">Padrão movimentações</span>}</td>
            <td>{account.account_type === 'integration' ? 'Integração' : 'Manual'}</td>
            <td><span className={badgeClass(account.active ? 'Ativo' : 'Inativo')}>{account.active ? 'Ativo' : 'Inativo'}</span></td>
            <td><span className={`finance-boleto ${account.boleto}`}>{BOLETO_LABEL[account.boleto]}</span></td>
            <td>{ACCOUNT_TYPE_LABEL[account.account_type]}</td>
            <td className="row-actions" onClick={event => event.stopPropagation()}>{menuItems.length > 0 && <RowMenu label={account.name} items={menuItems} open={menu === account.id} onToggle={() => setMenu(menu === account.id ? null : account.id)} />}</td></tr>; })}</tbody></table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhuma conta financeira encontrada</h2><p>{access?.write ? 'Inclua uma conta financeira ou ajuste os filtros.' : 'Ajuste os filtros.'}</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={ACCOUNTS_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.page) go({ page: target }); }} /></footer></>}
    </NativeListLayout></form>}
    {actionVisible?.minimized && <p className="real-alert" role="alert">“{actionVisible.label}” de {actionVisible.account.name} sem resultado confirmado. <button type="button" className="text-button" onClick={() => setAction({ ...actionVisible, minimized: false })}>Conferir resultado</button></p>}
    {actionVisible && !actionVisible.minimized && <Modal title={actionVisible.uncertain ? 'Conferir resultado' : actionVisible.label} onClose={() => { if (!actionVisible.busy) setAction(actionVisible.uncertain ? { ...actionVisible, minimized: true } : null); }} actions={<><button type="button" className="secondary-button" disabled={actionVisible.busy} onClick={() => setAction(actionVisible.uncertain ? { ...actionVisible, minimized: true } : null)}>{actionVisible.uncertain ? 'Conferir depois' : 'Cancelar'}</button><button type="button" className={actionVisible.kind === 'account_delete' ? 'danger-button' : 'primary-button'} disabled={actionVisible.busy} onClick={() => void run()}>{actionVisible.busy ? 'Confirmando…' : actionVisible.uncertain ? 'Conferir resultado' : 'Confirmar'}</button></>}>
      <p>{actionVisible.confirm}</p>{actionVisible.error && <p className="real-alert" role="alert">{actionVisible.error}</p>}
    </Modal>}
  </>;
}
