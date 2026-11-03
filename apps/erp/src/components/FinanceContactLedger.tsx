import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney, todaySP, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { financialAccount, type FinancialAccount } from '../lib/finance-registry-model';
import { LEDGER_ORIGIN, LEDGER_PAGE_SIZE, LEDGER_SCOPES, LEDGER_SITUATION, contactLedger, signedMoney, type Ledger, type LedgerLine } from '../lib/finance-statement-model';
import { definitiveFailure, type FinanceCommand } from '../lib/finance-command';
import { badgeClass } from '../lib/origin-list';
import { CatalogPicker } from './DocumentCatalogPicker';
import { CashEntryDrawer } from './FinanceStatement';
import { useCategoryTree } from './FinanceCategoryTreeSelect';
import { OriginPagination, OriginSelector, PeriodPicker, RowMenu, ToolButton } from './OriginList';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-statement.css';

const noSubscription = () => () => {}, noSnapshot = () => null;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.status === 404 ? 'O contato não foi encontrado.' : failure.status === 403 ? 'Seu acesso a esta operação foi alterado.' : failure.status === 409 ? 'O lançamento mudou. Atualize a ficha.' : 'Não foi possível consultar a ficha financeira. Tente novamente.' : 'Não foi possível consultar a ficha financeira.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
type Entry = Parameters<typeof CashEntryDrawer>[0]['entry'];

/**
 * Financeiro > Ficha financeira do Origin (SQL 136): Todas as contas | Contas a pagar | Contas a receber, busca do contato,
 * Período e Imprimir; contas, baixas e lançamentos da ficha com Débitos, Créditos e Saldo. Lançamentos manuais têm ⋮
 * Editar e Excluir; as contas e baixas são alteradas nas suas telas.
 */
export default function FinanceContactLedger({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), params = new URLSearchParams(location.search), today = todaySP(), year = today.slice(0, 4);
  const contact = params.get('contato') ?? '', name = params.get('nome') ?? '', scope = params.get('tipo') ?? 'all', from = params.get('from') ?? `${year}-01-01`, to = params.get('to') ?? `${year}-12-31`, pageText = params.get('pagina') ?? '1';
  const routeError = (contact && !UUID.test(contact)) || !['all', 'receivable', 'payable'].includes(scope) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || name.length > 200 || !/^[1-9]\d{0,5}$/.test(pageText);
  const page = routeError ? 1 : Number(pageText);
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, authScope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${authScope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === authScope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [ledger, setLedger] = useState<{ key: string; value: Ledger | null; error: string }>({ key: '', value: null, error: '' });
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null), [accounts, setAccounts] = useState<FinancialAccount[]>([]), [menu, setMenu] = useState<string | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [drawer, setDrawer] = useState<{ key: string; entry: Entry } | null>(null), [removal, setRemoval] = useState<{ key: string; line: LedgerLine; command: FinanceCommand; busy: boolean; uncertain: boolean; error: string } | null>(null);
  const finance = access ? (path: string, options?: { signal?: AbortSignal }) => controller.finance(path, options) : null;
  const trees = { receivable: useCategoryTree(finance, 'receivable', authScope), payable: useCategoryTree(finance, 'payable', authScope) };
  const value = ledger.key === listKey ? ledger.value : null, loading = Boolean(contact) && !routeError && (ledger.key !== listKey || (!ledger.value && !ledger.error));
  useEffect(() => { setMenu(null); setDrawer(null); setRemoval(previous => previous?.uncertain ? previous : null); setNotice(''); setError(''); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(result => { const access = result as FinanceAccess; if (!request.signal.aborted && mayRead() && access.data_mode === 'erp_native' && access.read === true && typeof access.write === 'boolean') setPermissions({ scope: authScope, value: access }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, authScope]);
  useEffect(() => {
    if (!access || !contact || routeError || !mayRead()) return; const request = new AbortController();
    void controller.finance(`/v1/financeiro/ficha?${new URLSearchParams({ contact, scope, from, to, page: String(page), limit: String(LEDGER_PAGE_SIZE) })}`, { signal: request.signal }).then(result => { if (!request.signal.aborted && mayRead()) setLedger({ key: listKey, value: contactLedger(result, contact, scope, from, to, page), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setLedger({ key: listKey, value: null, error: failureText(failure) }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    if (!access?.write) return; const request = new AbortController();
    void controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo', { signal: request.signal }).then(result => { if (!request.signal.aborted) setAccounts(((result as { items?: unknown[] })?.items ?? []).map(financialAccount)); }).catch(() => { /* The drawer asks for the conta. */ });
    return () => request.abort();
  }, [controller, access]);
  const go = (next: Record<string, string>) => { const target = new URLSearchParams({ area: 'ficha' }); const merged = { contato: contact, tipo: scope, from, to, pagina: '', ...next }; for (const [key, entry] of Object.entries(merged)) if (entry && !(key === 'tipo' && entry === 'all') && !(key === 'from' && entry === `${year}-01-01`) && !(key === 'to' && entry === `${year}-12-31`)) target.set(key, entry); navigate(`${location.pathname}?${target}`); };
  const send = (command: FinanceCommand) => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const openEntry = async (id: string) => {
    setMenu(null); if (!mayWrite()) return;
    try { const result = await controller.finance(`/v1/financeiro/lancamentos/${id}`) as { record?: NonNullable<Entry> }; if (!mayRead()) return; if (result?.record?.id !== id) throw new Error('mismatch'); setDrawer({ key: routeKey, entry: result.record }); }
    catch (failure) { if (mayRead()) setError(failureText(failure)); }
  };
  const runRemoval = async () => {
    if (!removal || removal.busy) return; if (!mayWrite()) { setRemoval({ ...removal, error: 'Seu acesso a esta operação foi alterado.' }); return; }
    const state = { ...removal, busy: true, error: '' }; setRemoval(state);
    try { await send(state.command); if (!mayRead()) return; setRemoval(null); setNotice('Lançamento excluído da ficha.'); setReload(value => value + 1); }
    catch (failure) { if (!mayRead()) return; const final = definitiveFailure(failure) && !state.uncertain; setRemoval({ ...state, busy: false, uncertain: !final, error: final ? failureText(failure) : 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma exclusão.' }); }
  };
  const scopeLabel = LEDGER_SCOPES.find(item => item.value === scope)?.label ?? 'Todas as contas', writable = Boolean(access?.write) && financePermitted(access, 'financas.caixas_bancos.ie');
  const drawerVisible = drawer && drawer.key === routeKey ? drawer : null, removalVisible = removal && (removal.key === routeKey || removal.uncertain) ? removal : null;
  // The name of the contact never goes to the address (personal data): it comes from the picker or from the ficha read.
  const contactName = value?.contact_name ?? (picked?.id === contact ? picked.name : name);
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{removalVisible?.uncertain && <BusyGuard />}
    <header className="real-heading"><div className="finance-heading-title"><h1>Ficha financeira</h1><OriginSelector label="Contas" value={scopeLabel} options={LEDGER_SCOPES.map(item => item.label)} onChange={label => { const target = LEDGER_SCOPES.find(item => item.label === label)?.value; if (target && target !== scope) go({ tipo: target }); }} /></div>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {routeError ? <section className="real-state-panel"><p role="alert">Filtros inválidos no endereço.</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=ficha`)}>Limpar filtros da URL</button></section> : <>
    <div className="native-list-toolbar finance-ledger-toolbar">
      <div className="form-field finance-ledger-contact">{access && <CatalogPicker controller={controller} entity="contacts" label="Pesquisar" selected={contact ? { id: contact, name: contactName || 'Contato' } : null} onSelect={record => { setPicked(record ? { id: record.id, name: record.name } : null); go({ contato: record?.id ?? '' }); }} />}</div>
      <PeriodPicker from={from} to={to} today={today} onApply={range => { if (range.from && range.to) go({ from: range.from, to: range.to }); }} />
      <div className="origin-toolbar-tools"><ToolButton icon="print" title="Imprimir" disabled={!value} onClick={() => globalThis.window?.print()} /><ToolButton icon="rotate-right" title="Recarregar" disabled={!contact || loading} onClick={() => setReload(previous => previous + 1)} />
        {writable && contact && <button type="button" className="primary-button" onClick={() => { if (mayWrite()) setDrawer({ key: routeKey, entry: null }); }}><Icon name="plus" size={14} />Lançamento</button>}</div></div>
    {!contact ? <div className="finance-ledger-empty"><h2>Selecione um cliente</h2><p>Para realizar a consulta você deve informar um cliente.</p></div>
      : loading ? <p role="status">Carregando ficha financeira…</p> : ledger.key === listKey && ledger.error ? <p className="real-alert" role="alert">{ledger.error} <button type="button" className="text-button" onClick={() => setReload(previous => previous + 1)}>Tentar novamente</button></p>
      : value && <><h2 className="finance-ledger-name">{value.contact_name}</h2>
        {!value.items.length ? <div className="finance-ledger-empty"><p>Nenhum resultado encontrado</p></div> : <div className="table-scroll" tabIndex={0} role="region" aria-label="Ficha financeira"><table className="data-table finance-table"><thead><tr><th>Data</th><th>Histórico</th><th>Forma de Pagamento</th><th>Data vencimento</th><th>Tipo</th><th>Origem</th><th className="numeric">Débitos</th><th className="numeric">Créditos</th><th>Situação</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
          <tbody>{value.items.map(line => { const situation = line.situation ? LEDGER_SITUATION[line.situation] : null;
            return <tr key={`${line.line_kind}:${line.ref_id}`}><td>{financeDate(line.day)}</td>
              <td>{line.line_kind === 'title' ? <Link to={`/financeiro-empresa?area=${line.kind}&titulo=${line.ref_id}`}>{line.note}</Link> : line.note}{line.line_kind === 'reversal' ? ' · estorno' : ''}</td>
              <td>{line.payment_method ?? '—'}</td><td>{line.due_on ? financeDate(line.due_on) : '—'}</td><td>{line.side === 'debit' ? 'Débito' : 'Crédito'}</td>
              <td>{line.origin ? `${LEDGER_ORIGIN[line.origin.kind] ?? 'Documento'} nº ${line.origin.number}` : line.line_kind === 'entry' ? 'Lançamento' : '—'}</td>
              <td className="numeric">{line.side === 'debit' ? financeMoney(line.amount_cents) : ''}</td><td className="numeric">{line.side === 'credit' ? financeMoney(line.amount_cents) : ''}</td>
              <td>{situation && <span className={badgeClass(situation)}>{situation}</span>}</td>
              <td className="row-actions">{writable && line.line_kind === 'entry' && <RowMenu label={line.note} items={[{ label: 'Editar', icon: 'pen-to-square', onClick: () => void openEntry(line.ref_id) },
                // Excluir a lançamento needs Caixas e Bancos > Excluir (SQL 246), as the server checks.
                ...(financePermitted(access, 'financas.caixas_bancos.ex') ? [{ label: 'Excluir', icon: 'trash-can', separatorBefore: true, onClick: () => { setMenu(null); if (mayWrite() && !removal) setRemoval({ key: routeKey, line, command: { id: crypto.randomUUID(), path: '/v1/financeiro/actions/entry_delete', data: { id: line.ref_id, expected_version: line.version } }, busy: false, uncertain: false, error: '' }); } }] : [])]}
                open={menu === line.ref_id} onToggle={() => setMenu(menu === line.ref_id ? null : line.ref_id)} />}</td></tr>; })}</tbody></table></div>}
        {value.total > LEDGER_PAGE_SIZE && <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(page, Math.max(1, Math.ceil(value.total / LEDGER_PAGE_SIZE)))} pages={Math.max(1, Math.ceil(value.total / LEDGER_PAGE_SIZE))} size={LEDGER_PAGE_SIZE} total={value.total} onPage={target => { if (target !== page) go({ pagina: target > 1 ? String(target) : '' }); }} /></footer>}
        <div className="finance-ledger-totals"><span>Débitos: {financeMoney(value.totals.debit_cents)}</span><span>Créditos: {financeMoney(value.totals.credit_cents)}</span><span>Saldo: {signedMoney(value.totals.balance_cents)}</span></div>
        <p className="real-help">Contas canceladas não entram nos totais, que somam todo o período{value.total > LEDGER_PAGE_SIZE ? ` (${value.total.toLocaleString('pt-BR')} lançamentos, ${LEDGER_PAGE_SIZE} por página)` : ''}. Contas e baixas são alteradas em Contas a receber ou a pagar.</p></>}
    </>}
    {drawerVisible && contact && <CashEntryDrawer controller={controller} entry={drawerVisible.entry} accounts={accounts} defaultAccount={accounts.find(item => item.default_movements)?.id ?? ''} trees={trees} contact={{ id: contact, name: contactName || 'Contato' }} origin="ledger" title="Lançamento da ficha"
      send={send} mayWrite={mayWrite} onClose={() => setDrawer(null)} onSaved={(_, created) => { if (!mayRead()) return; setDrawer(null); setNotice(created ? 'Lançamento incluído na ficha.' : 'Lançamento atualizado.'); setReload(previous => previous + 1); }} />}
    {removalVisible && <Modal title={removalVisible.uncertain ? 'Conferir resultado' : 'Excluir lançamento'} onClose={() => { if (!removalVisible.busy && !removalVisible.uncertain) setRemoval(null); }} actions={<><button type="button" className="secondary-button" disabled={removalVisible.busy || removalVisible.uncertain} onClick={() => setRemoval(null)}>Cancelar</button><button type="button" className="danger-button" disabled={removalVisible.busy} onClick={() => void runRemoval()}>{removalVisible.busy ? 'Excluindo…' : removalVisible.uncertain ? 'Conferir resultado' : 'Excluir'}</button></>}>
      <p>Deseja mesmo excluir o lançamento “{removalVisible.line.note}” de {financeMoney(removalVisible.line.amount_cents)}? Ele sai do saldo da conta e fica nos excluídos de Caixas e bancos.</p>{removalVisible.error && <p className="real-alert" role="alert">{removalVisible.error}</p>}
    </Modal>}
  </>;
}
