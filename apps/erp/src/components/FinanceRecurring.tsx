import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { financeDate, financeMoney, type FinanceAccess, financePermitted, titlePermission } from '../lib/real-finance-model';
import { FREQUENCY_LABEL, RECURRENCE_PAGE_SIZE, RECURRENCE_SITUATIONS, generateSkip, recurrenceApiPath, recurrencePage, recurrenceParams, recurrenceResult, recurrenceRoute, recurrenceSchedule, type Recurrence, type RecurrencePage, type RecurrenceRoute } from '../lib/finance-recurrence-model';
import { batchSummaryText, planBatch, summarizeBatch, type BatchPlan, type BatchResult, type BatchStep } from '../lib/origin-batch';
import { definitiveFailure, useFinanceCommand } from '../lib/finance-command';
import { rangeLabel } from '../lib/origin-list';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Modal } from './Modal';
import './real-finance.css';
import './finance-registry.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const message = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'A recorrência mudou, está inativa ou chegou à data limite. Atualize a listagem.' : error.status === 400 ? 'A operação não foi aceita para esta recorrência.'
  : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'A recorrência não foi encontrada. Atualize a listagem.' : 'Não foi possível concluir a consulta. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
const EMPTY = (kind: RecurrenceRoute['kind']): RecurrenceRoute => ({ kind, situacao: 'todas', q: '', page: 1 });
type GenerateItem = { id: string; label: string; record: Recurrence };
type Sent = { id: string; data: Record<string, unknown> };
type Generate = { plan: BatchPlan<GenerateItem>; recovery: boolean };
const label = (record: Recurrence) => `${record.contact_name} · ${record.description}`;

/**
 * Contas recorrentes do Origin (SQL 138): Pesquisar, Situação (Todas | Ativas | Inativas, padrão Ativas), colunas ☐, Contato,
 * Histórico, Categoria, Tipo recorrência, situação e ⋮ Inativar; o clique na linha não abre nada. "Gerar contas" gera a
 * próxima conta de cada recorrência selecionada, uma por vez, com o mesmo command_id em "Conferir resultado".
 */
export default function FinanceRecurring({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), params = new URLSearchParams(location.search);
  let parsed: { route: RecurrenceRoute; error: string };
  try { parsed = { route: recurrenceRoute(params), error: '' }; } catch (failure) { parsed = { route: EMPTY(params.get('tipo') === 'P' ? 'payable' : 'receivable'), error: (failure as Error).message }; }
  const route = parsed.route, receivable = route.kind === 'receivable';
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [list, setList] = useState<{ key: string; page: RecurrencePage | null; error: string }>({ key: '', page: null, error: '' });
  const page = list.key === listKey ? list.page : null, loading = !parsed.error && (list.key !== listKey || (!list.page && !list.error));
  const [draft, setDraft] = useState({ q: route.q, situacao: route.situacao }), [menu, setMenu] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] }), selected = selection.key === listKey ? selection.ids : [];
  const [toggle, setToggle] = useState<{ record: Recurrence; active: boolean; minimized: boolean; tried?: boolean } | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [generate, setGenerate] = useState<Generate | null>(null), [pending, setPending] = useState<{ key: string; items: GenerateItem[] } | null>(null);
  const sent = useRef(new Map<string, Sent>());
  const command = useFinanceCommand(next => controller.finance(next.path, { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never), mayWrite, message);
  useEffect(() => { setDraft({ q: route.q, situacao: route.situacao }); setMenu(null); setError(''); setToggle(previous => previous && command.uncertain ? { ...previous, minimized: true } : null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(message(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(recurrenceApiPath(route), { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setList({ key: listKey, page: recurrencePage(value, route), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setList({ key: listKey, page: null, error: failure instanceof AccessError ? message(failure) : 'Não foi possível conferir as contas recorrentes. Tente novamente.' }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  const go = (next: Partial<RecurrenceRoute>) => navigate(`${location.pathname}?${recurrenceParams({ ...route, page: 1, ...next })}`);
  const apply = (event?: FormEvent) => { event?.preventDefault(); go({ q: draft.q.trim(), situacao: draft.situacao }); };
  const clear = () => go(EMPTY(route.kind));
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the recorrências create and generate contas of their kind (incluir/editar).
  const writable = Boolean(access?.write) && financePermitted(access, titlePermission(route.kind, 'ie'));
  const rows = page?.items ?? [], pages = page ? Math.max(1, Math.ceil(page.total / RECURRENCE_PAGE_SIZE)) : 1;
  const locked = Boolean(generate) || command.locked;
  const startToggle = (record: Recurrence, active: boolean) => { setMenu(null); if (!mayWrite() || locked) return; setNotice(''); setToggle({ record, active, minimized: false }); };
  const runToggle = () => {
    if (!toggle) return; const state = toggle; setToggle({ ...state, tried: true });
    void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/recurrence_set_active', data: { id: state.record.id, expected_version: state.record.version, active: state.active } }), value => {
      if (!mayRead()) return; recurrenceResult(value, 'recurrence_set_active', state.record.id);
      setToggle(null); setNotice(`${state.active ? 'Recorrência ativada' : 'Recorrência inativada'}: ${label(state.record)}.`); setReload(value => value + 1);
    });
  };
  // "Gerar contas": one versioned recurrence_generate per recurrência; an unconfirmed one keeps its command for "Conferir resultado".
  const sendGenerate = async (item: GenerateItem): Promise<BatchStep> => {
    const replay = sent.current.get(item.id), next = replay ?? { id: crypto.randomUUID(), data: { id: item.record.id, expected_version: item.record.version } };
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso a esta operação foi alterado. A recorrência não foi reenviada e o envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado. Esta recorrência não foi enviada.'); }
    sent.current.set(item.id, next);
    try {
      const value = await controller.finance('/v1/financeiro/actions/recurrence_generate', { method: 'POST', body: { command_id: next.id, data: structuredClone(next.data) } } as never);
      recurrenceResult(value, 'recurrence_generate', item.record.id); sent.current.delete(item.id);
      const due = (value as { title?: { due_on?: unknown } }).title?.due_on;
      return { message: typeof due === 'string' ? `Conta com vencimento em ${financeDate(due)} incluída.` : 'Conta incluída.' };
    } catch (failure) {
      if (definitiveFailure(failure) && !replay) { sent.current.delete(item.id); throw new Error(message(failure)); }
      return { uncertain: true, message: definitiveFailure(failure) ? `${message(failure)} O envio anterior continua sem confirmação: confira as contas antes de repetir.` : 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.' };
    }
  };
  const startGenerate = () => {
    if (!mayWrite() || !selected.length || locked || pending) return; setNotice(''); sent.current = new Map();
    const items = rows.filter(row => selected.includes(row.id)).map(record => ({ id: record.id, label: `${label(record)}${record.next_on ? ` · vencimento ${financeDate(record.next_on)}` : ''}`, record }));
    setGenerate({ plan: planBatch(items, item => generateSkip(item.record)), recovery: false });
  };
  const recover = () => { if (!pending || generate || !mayWrite()) return; setGenerate({ plan: { eligible: pending.items, skipped: [] }, recovery: true }); };
  const finishGenerate = (state: Generate, results: BatchResult[] | null) => {
    setGenerate(null); if (results === null) return;
    const left = state.plan.eligible.filter(item => sent.current.has(item.id));
    setPending(left.length ? { key: scope, items: left } : null); setSelection({ key: '', ids: [] });
    setNotice(`${state.recovery ? 'Conferir resultado' : 'Gerar contas'}: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1);
  };
  const toggleRow = (id: string) => setSelection(previous => { const ids = previous.key === listKey ? previous.ids : []; return { key: listKey, ids: ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id] }; });
  const allSelected = rows.length > 0 && rows.every(row => selected.includes(row.id));
  const items = (record: Recurrence): RowMenuItem[] => !writable ? [] : [record.active ? { label: 'Inativar', icon: 'ban', onClick: () => startToggle(record, false) } : { label: 'Ativar', icon: 'check', onClick: () => startToggle(record, true) }];
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []),
    ...(route.situacao !== 'todas' ? [{ label: `Situação: ${route.situacao === 'ativas' ? 'Ativas' : 'Inativas'}`, onRemove: () => go({ situacao: 'todas' }) }] : [])];
  const pendingVisible = pending && pending.key === scope ? pending : null, toggleVisible = toggle && !toggle.minimized ? toggle : null, generateVisible = generate;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{(pendingVisible || command.uncertain) && <BusyGuard />}
    <header className="real-heading"><h1>Contas recorrentes</h1>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    <nav className="finance-tabs" aria-label="Contas recorrentes">{(['receivable', 'payable'] as const).map(kind => <button key={kind} type="button" aria-current={route.kind === kind ? 'page' : undefined} disabled={locked} onClick={() => go({ ...EMPTY(kind), situacao: 'ativas' })}>{kind === 'receivable' ? 'Contas a receber' : 'Contas a pagar'}</button>)}</nav>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    <p className="real-notice">As contas recorrentes nascem das contas com ocorrência diferente de Única. Mensal, trimestral, semestral e anual (e as demais) geram a próxima conta em “Gerar contas” enquanto ativas, até a data limite; a Parcelada gera até atingir o nº de parcelas.</p>
    {toggle?.minimized && command.uncertain && <p className="real-alert" role="alert">“{toggle.active ? 'Ativar' : 'Inativar'}” de {label(toggle.record)} sem resultado confirmado. <button type="button" className="text-button" onClick={() => setToggle({ ...toggle, minimized: false })}>Conferir resultado</button></p>}
    {pendingVisible && <p className="real-alert" role="alert">{pendingVisible.items.length === 1 ? '1 recorrência' : `${pendingVisible.items.length} recorrências`} de “Gerar contas” sem resultado confirmado. <button type="button" className="text-button" disabled={Boolean(generateVisible)} onClick={recover}>Conferir resultado</button></p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={clear}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros das contas recorrentes"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{RECURRENCE_SITUATIONS.map(option => <label key={option.id} htmlFor={`recurrence-situation-${option.id}`}><input id={`recurrence-situation-${option.id}`} type="radio" name="recurrence-situation" checked={draft.situacao === option.id} onChange={() => setDraft(previous => ({ ...previous, situacao: option.id }))} />{option.label}</label>)}</fieldset>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      {writable && <button type="button" className="primary-button" disabled={!selected.length || locked || Boolean(pendingVisible)} title={selected.length ? 'Gera a próxima conta de cada recorrência selecionada' : 'Selecione as recorrências'} onClick={startGenerate}>Gerar contas</button>}
      <div className="native-list-summary"><h3>Informações</h3><dl className="native-list-stat"><dt>Quantidade de recorrências</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl><p className="real-help">Informações baseadas nos filtros aplicados na listagem.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to={`/financeiro-empresa?area=${route.kind}`}>{receivable ? 'Contas a receber' : 'Contas a pagar'}</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="recurrence-search">Pesquisar na listagem</label><input id="recurrence-search" type="search" maxLength={120} placeholder="Pesquisar" value={draft.q} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, q: value })); }} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !access}>Pesquisar</button>
        <div className="origin-toolbar-tools"><ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={clear} />
      <div className="real-result-status" role="status">{loading ? 'Carregando contas recorrentes…' : page ? rangeLabel(route.page, RECURRENCE_PAGE_SIZE, page.total) : list.error || 'Contas recorrentes indisponíveis.'}</div>
      {list.key === listKey && list.error && <p className="real-alert" role="alert">{list.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Contas recorrentes"><table className="data-table finance-table"><thead><tr>{writable && <th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todas" title="Selecionar todas" checked={allSelected} disabled={locked} onChange={() => setSelection({ key: listKey, ids: allSelected ? [] : rows.map(row => row.id) })} /></th>}<th>Contato</th><th>Histórico</th><th>Categoria</th><th>Tipo recorrência</th><th><span className="real-sr-only">Situação</span></th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{rows.map(record => { const menuItems = items(record);
          return <tr key={record.id}>
            {writable && <td className="checkbox-cell"><input type="checkbox" aria-label={`Selecionar ${label(record)}`} checked={selected.includes(record.id)} disabled={locked} onChange={() => toggleRow(record.id)} /></td>}
            <td>{record.contact_name}</td>
            <td>{record.description}<small className="real-help finance-recurrence-detail">{financeMoney(record.amount_cents)}{record.next_on ? ` · próxima conta em ${financeDate(record.next_on)}` : record.active ? ' · data limite atingida' : ''}</small></td>
            <td>{record.category_name ?? 'Sem categoria'}</td>
            <td title={recurrenceSchedule(record, financeDate)}>{FREQUENCY_LABEL[record.frequency]}<small className="real-help finance-recurrence-detail">{recurrenceSchedule(record, financeDate)}</small></td>
            <td><span className={`finance-recurrence-dot${record.active ? ' is-active' : ''}`} role="img" title={record.active ? 'Ativa' : 'Inativa'} aria-label={record.active ? 'Ativa' : 'Inativa'} /></td>
            <td className="row-actions">{menuItems.length > 0 && <RowMenu label={label(record)} items={menuItems} open={menu === record.id} onToggle={() => setMenu(menu === record.id ? null : record.id)} />}</td></tr>; })}</tbody></table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhuma conta recorrente encontrada</h2><p>Inclua uma conta com ocorrência recorrente ou ajuste os filtros.</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={RECURRENCE_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.page) go({ page: target }); }} /></footer></>}
    </NativeListLayout></form>}
    {toggleVisible && <Modal title={command.uncertain ? 'Conferir resultado' : toggleVisible.active ? 'Ativar recorrência' : 'Inativar recorrência'} onClose={() => { if (!command.busy) setToggle(command.uncertain ? { ...toggleVisible, minimized: true } : null); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => setToggle(command.uncertain ? { ...toggleVisible, minimized: true } : null)}>{command.uncertain ? 'Conferir depois' : 'Cancelar'}</button><button type="button" className="primary-button" disabled={command.busy} onClick={runToggle}>{command.busy ? 'Confirmando…' : command.uncertain ? 'Conferir resultado' : 'Confirmar'}</button></>}>
      <p>{toggleVisible.active ? `Ativar a recorrência de ${label(toggleVisible.record)}? “Gerar contas” volta a gerar as próximas contas.` : `Inativar a recorrência de ${label(toggleVisible.record)}? Nenhuma nova conta é gerada; as contas já incluídas continuam como estão.`}</p>
      {toggleVisible.tried && command.error && <p className="real-alert" role="alert">{command.error}</p>}
    </Modal>}
    {generateVisible && <BatchDialog title={generateVisible.recovery ? 'Conferir resultado' : 'Gerar contas'} description={<p className="real-help">Cada recorrência gera a sua próxima conta, com o vencimento mostrado. Uma data nunca é gerada duas vezes.</p>} plan={generateVisible.plan}
      confirmLabel={generateVisible.recovery ? 'Conferir resultado' : 'Gerar contas'} canConfirm={writable} run={sendGenerate} onClose={results => finishGenerate(generateVisible, results)} progressLabel={(at, count) => `Gerando contas, ${at} de ${count}…`} />}
  </>;
}
