import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { centsInput, financeDate, financeMoney, moneyInput, postingDate, todaySP, type FinanceAccess, financePermitted, titlePermission } from '../lib/real-finance-model';
import { BORDERO_PAGE_SIZE, borderoApiPath, borderoCategories, borderoDetail, borderoPage, borderoParams, borderoPeriod, borderoRoute, borderoTitle, type Bordero, type BorderoLine, type BorderoPage, type BorderoRoute } from '../lib/finance-bordero-route';
import { categoryParam, financeListParams, emptyFinanceRoute } from '../lib/finance-list-route';
import { loadReferenceOptions, type ReferenceOption } from '../lib/finance-title-drawer';
import { ACCOUNT_ALL } from '../lib/finance-title-list';
import { financeLinkActor } from '../lib/document-finance-link';
import { batchSummaryText, planBatch, summarizeBatch, type BatchItem, type BatchPlan, type BatchResult } from '../lib/origin-batch';
import { rangeLabel, selectRange } from '../lib/origin-list';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, OriginSelector, PeriodPicker, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { CategoryTreeFilter, useCategoryTree } from './FinanceCategoryTreeSelect';
import FinanceBorderoPrint from './FinanceBorderoPrint';
import './real-finance.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const noSubscription = () => () => {}, noSnapshot = () => null;
const message = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O borderô mudou ou esta operação já foi usada com outros valores. Atualize a listagem.' : error.status === 400 ? 'A operação não foi aceita. Confira a data e o motivo.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'O borderô não foi encontrado. Atualize a listagem.' : 'Não foi possível concluir a consulta. Tente novamente.' : error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
type DeleteItem = BatchItem & { bordero: Bordero };
type Command = { id: string; body: { data: Record<string, unknown> } };
function BorderoField({ label, children }: { label: string; children: (id: string) => ReactNode }) { const id = useId(); return <div className="form-field"><label htmlFor={id}>{label}</label>{children(id)}</div>; }
function BusyGuard() { useUnsavedChanges(false, true); return null; }
const contactText = (row: Bordero, kind: Bordero['kind']) => row.contact_name ?? `${row.contacts} ${kind === 'receivable' ? 'clientes' : 'fornecedores'}`;

/** Borderô (somente leitura): Data, Histórico, Categoria, Conta e a grade de baixas com os totais. */
function BorderoView({ record, onClose }: { record: Bordero & { lines: BorderoLine[] }; onClose: () => void }) {
  const party = record.kind === 'receivable' ? 'Cliente' : 'Fornecedor', total = record.totals;
  return <Modal title="Borderô" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <dl className="finance-review"><div><dt>Data</dt><dd>{financeDate(record.posted_on)}</dd></div><div><dt>Histórico</dt><dd>{record.note ?? '—'}</dd></div><div><dt>Categoria</dt><dd>{record.category_name ?? (record.lines.length === 1 ? record.lines[0].category_name ?? 'Sem categoria' : 'Sem categoria')}</dd></div><div><dt>Conta</dt><dd>{record.account_name}</dd></div></dl>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>{party}</th><th>Nro. Documento</th><th className="numeric">Juros</th><th className="numeric">Desconto</th><th className="numeric">Acréscimo</th><th className="numeric">Tarifa</th><th className="numeric">Valor Pago</th></tr></thead>
      <tbody>{record.lines.map(line => <tr key={line.settlement_id} className={line.reversed ? 'finance-reversed' : undefined}><td>{line.contact_name}{line.reversed ? ' · estornada' : ''}</td><td>{line.document_number ?? '—'}</td><td className="numeric">{financeMoney(line.interest_cents)}</td><td className="numeric">{financeMoney(line.discount_cents)}</td><td className="numeric">{financeMoney(line.penalty_cents)}</td><td className="numeric">{financeMoney(line.fee_cents)}</td><td className="numeric">{financeMoney(line.paid_cents)}</td></tr>)}
        <tr><th>Totais</th><td /><td className="numeric">{financeMoney(total.interest_cents)}</td><td className="numeric">{financeMoney(total.discount_cents)}</td><td className="numeric">{financeMoney(total.penalty_cents)}</td><td className="numeric">{financeMoney(total.fee_cents)}</td><td className="numeric">{financeMoney(total.paid_cents)}</td></tr></tbody></table></div>
    <p><strong>Total de Pagamento:</strong> {financeMoney(total.paid_cents)}</p>
    {record.deleted_at && <p className="real-notice">Borderô excluído: as baixas foram estornadas e o histórico continua guardado.</p>}
  </Modal>;
}

/**
 * “Gerenciar recebimentos” / “Gerenciar pagamentos” do Origin (SQL 110): borderôs ativos com seletor de contas
 * financeiras, Pesquisar, Abrir períodos (Este mês), Categoria e Valor, Informações do filtro e “Excluir borderôs
 * selecionados”, que estorna as baixas de cada borderô por um comando próprio com “Conferir resultado”.
 */
export default function FinanceBorderos({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate();
  let parsed: { value: BorderoRoute | null; error: string };
  try { parsed = { value: borderoRoute(new URLSearchParams(location.search)), error: '' }; } catch (error) { parsed = { value: null, error: (error as Error).message }; }
  const route = parsed.value ?? { kind: 'receivable' as const, q: '', account: '', category: '', from: '', to: '', value: '', title: '', page: 1 };
  const kind = route.kind, today = todaySP();
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, active = useRef(routeKey); active.current = routeKey;
  const mayRead = () => allowed && active.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  // Painel "Imprimir": every borderô of the filter applied, read for the preview (never the browser page).
  const [printRoute, setPrintRoute] = useState<{ key: string; route: typeof route } | null>(null);
  const [list, setList] = useState<{ key: string; page: BorderoPage | null; error: string }>({ key: '', page: null, error: '' });
  const page = list.key === listKey ? list.page : null, loading = !parsed.error && (list.key !== listKey || (!list.page && !list.error));
  const [search, setSearch] = useState(route.q), [draft, setDraft] = useState({ categories: borderoCategories(route), value: route.value ? centsInput(route.value) : '' });
  const [accounts, setAccounts] = useState<{ key: string; items: ReferenceOption[] }>({ key: '', items: [] });
  // Categoria (SQL 135): the tree of the tab, multi-select with search; a parent checks its subcategorias.
  const categories = useCategoryTree(access ? (path, options) => controller.finance(path, options) : null, kind, scope);
  const [selection, setSelection] = useState<{ key: string; ids: string[]; anchor: string | null }>({ key: '', ids: [], anchor: null });
  const [detail, setDetail] = useState<{ key: string; id: string; record: (Bordero & { lines: BorderoLine[] }) | null; error: string } | null>(null), detailRequest = useRef<AbortController | null>(null);
  const [removal, setRemoval] = useState<{ key: string; step: 'params' | 'run'; rows: Bordero[]; note: string; postedOn: string; error: string; plan: BatchPlan<DeleteItem> | null; recovery: boolean } | null>(null);
  const [pending, setPending] = useState<{ owner: string; items: DeleteItem[]; note: string; postedOn: string } | null>(null), [running, setRunning] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const commands = useRef(new Map<string, Command>()), uncertain = useRef(new Set<string>());
  const owner = tracked ? actor ?? '' : 'isolated';
  useEffect(() => { setSearch(route.q); setDraft({ categories: borderoCategories(route), value: route.value ? centsInput(route.value) : '' }); setDetail(null); setRemoval(null); setNotice(''); setError(''); detailRequest.current?.abort(); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(message(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController(), day = todaySP();
    void controller.finance(borderoApiPath(route, day), { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setList({ key: listKey, page: borderoPage(value, route, day), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setList({ key: listKey, page: null, error: failure instanceof AccessError ? message(failure) : 'Não foi possível conferir os borderôs. Tente novamente.' }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    if (!access) return; const request = new AbortController(), finance = (path: string, options: { signal: AbortSignal }) => controller.finance(path, options);
    void loadReferenceOptions(finance, 'accounts', request.signal).then(items => { if (!request.signal.aborted) setAccounts({ key: scope, items }); }).catch(() => { /* The selector keeps "Todas as contas financeiras". */ });
    return () => request.abort();
  }, [controller, access, kind]);
  const go = (next: Partial<BorderoRoute>) => { try { navigate(`${location.pathname}?${borderoParams({ ...route, page: 1, ...next })}`); } catch (failure) { setError((failure as Error).message); } };
  const apply = (event?: FormEvent) => { event?.preventDefault(); try { const value = draft.value.trim() ? moneyInput(draft.value) : ''; if (value === '0') throw new Error('Informe um valor maior que zero.'); if (draft.categories.length > 50) throw new Error('Selecione até 50 categorias (as subcategorias contam).'); go({ q: search.trim(), category: categoryParam(draft.categories), value }); } catch (failure) { setError((failure as Error).message); } };
  const rows = page?.items ?? [], selected = selection.key === listKey ? selection.ids : [], chosen = rows.filter(row => selected.includes(row.id));
  // Sistema › Usuários › Permissões › Finanças (SQL 246): Excluir borderô estorna baixas, so it needs Baixar of the kind, as the server checks.
  const writable = Boolean(access?.write) && financePermitted(access, titlePermission(kind, 'baixar'));
  const toggle = (id: string, shift: boolean) => { const result = selectRange(rows.map(row => row.id), new Set(selected), selection.key === listKey ? selection.anchor : null, id, shift); setSelection({ key: listKey, ids: [...result.selected], anchor: result.anchor }); };
  const open = async (id: string) => {
    if (!mayRead()) return; detailRequest.current?.abort(); const request = new AbortController(); detailRequest.current = request; setDetail({ key: routeKey, id, record: null, error: '' });
    try { const value = await controller.finance(`/v1/financeiro/borderos/${id}`, { signal: request.signal }); if (!request.signal.aborted && detailRequest.current === request && mayRead()) setDetail({ key: routeKey, id, record: borderoDetail(value, id, kind), error: '' }); }
    catch (failure) { if (!request.signal.aborted && !aborted(failure) && mayRead()) setDetail({ key: routeKey, id, record: null, error: failure instanceof AccessError ? message(failure) : 'Não foi possível conferir o borderô.' }); }
  };
  const mayWrite = () => mayRead() && Boolean(permissions?.scope === scope && permissions.value.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const plan = (items: Bordero[]) => planBatch(items.map(row => ({ id: row.id, label: `${financeDate(row.posted_on)} · ${contactText(row, kind)} · ${financeMoney(row.totals.paid_cents)}`, bordero: row })), ({ bordero }) => bordero.posted_on > today ? 'Data futura.' : null);
  const run = (state: NonNullable<typeof removal>) => async (item: DeleteItem) => {
    const replay = uncertain.current.has(item.id);
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso foi alterado. O borderô não foi reenviado e o envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado. Este borderô não foi enviado.'); }
    let command = commands.current.get(item.id);
    if (!command) { command = { id: crypto.randomUUID(), body: { data: { id: item.id, expected_version: item.bordero.version, posted_on: state.postedOn, note: state.note } } }; commands.current.set(item.id, command); }
    setRunning(true);
    try { await controller.finance('/v1/financeiro/actions/bordero_delete', { method: 'POST', body: { ...command.body, command_id: command.id } }); uncertain.current.delete(item.id); commands.current.delete(item.id); }
    catch (failure) {
      const known = failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known && !replay) { commands.current.delete(item.id); throw new Error(message(failure)); }
      uncertain.current.add(item.id);
      return { uncertain: true, message: known ? `${message(failure)} O envio anterior continua sem confirmação.` : 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma exclusão; ela não será duplicada.' };
    }
  };
  const finish = (state: NonNullable<typeof removal>, results: BatchResult[] | null) => {
    setRemoval(null); setRunning(false); if (results === null) return;
    const left = state.plan!.eligible.filter(item => uncertain.current.has(item.id));
    setPending(left.length ? { owner, items: left, note: state.note, postedOn: state.postedOn } : null);
    setSelection({ key: '', ids: [], anchor: null }); setNotice(`${state.recovery ? 'Conferir resultado' : 'Excluir borderôs selecionados'}: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1);
  };
  const pendingVisible = pending && pending.owner === owner && allowed ? pending : null, removalVisible = removal && removal.key === routeKey ? removal : null;
  const accountChoices = accounts.key === scope ? accounts.items : [], accountLabel = route.account ? accountChoices.find(item => item.id === route.account)?.name ?? 'Conta financeira selecionada' : ACCOUNT_ALL;
  const categoryChoices = categories.items, period = borderoPeriod(route, today), party = kind === 'receivable' ? 'Cliente' : 'Fornecedor';
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []), ...(route.account ? [{ label: `Conta financeira: ${accountLabel}`, onRemove: () => go({ account: '' }) }] : []),
    ...(route.category ? [{ label: `Categoria: ${borderoCategories(route).map(value => value === 'none' ? 'Sem categoria' : categoryChoices.find(item => item.id === value)?.name ?? 'selecionada').join(', ')}`, onRemove: () => go({ category: '' }) }] : []),
    ...(route.value ? [{ label: `Valor: ${financeMoney(route.value)}`, onRemove: () => go({ value: '' }) }] : []), ...(route.title ? [{ label: 'Conta selecionada na listagem', onRemove: () => go({ title: '' }) }] : [])];
  const pages = page ? Math.max(1, Math.ceil(page.total / BORDERO_PAGE_SIZE)) : 1;
  const back = `/financeiro-empresa?${financeListParams(emptyFinanceRoute(kind))}`;
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{(running || pendingVisible) && <BusyGuard />}
    <header className="real-heading"><div className="finance-heading-title"><h1>{borderoTitle(kind)}</h1>{access && !parsed.error && <OriginSelector label="Conta financeira" value={accountLabel} options={[ACCOUNT_ALL, ...accountChoices.filter(item => item.active).map(item => item.name)]} onChange={label => { const target = label === ACCOUNT_ALL ? '' : accountChoices.find(item => item.name === label)?.id; if (target !== undefined && target !== route.account) go({ account: target }); }} />}</div>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?${borderoParams({ ...route, q: '', account: '', category: '', from: '', to: '', value: '', title: '', page: 1 })}`)}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros dos borderôs"><NativeListLayout filters={<>
      <CategoryTreeFilter idPrefix="bordero-category" items={categoryChoices} value={draft.categories} onChange={next => setDraft(previous => ({ ...previous, categories: next }))} error={categories.error} onRetry={categories.retry} />
      <BorderoField label="Valor">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={16} value={draft.value} onChange={event => { const value = event.target.value; setDraft(previous => ({ ...previous, value })); }} />}</BorderoField>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={() => go({ q: '', account: '', category: '', from: '', to: '', value: '', title: '' })}>Limpar filtros</button>
    </>} actions={<>
      <button type="button" className="action-button" disabled={!page || !mayRead()} title={page ? 'Imprime todos os borderôs do filtro aplicado' : undefined} onClick={() => { if (page && mayRead()) setPrintRoute({ key: routeKey, route: { ...route, page: 1 } }); }}><Icon name="print" size={15} />Imprimir</button>
      <div className="native-list-summary"><h3>Informações</h3>
        <dl className="native-list-stat"><dt>{kind === 'receivable' ? 'Quantidade de Borderôs' : 'Quantidade de Pagamentos'}</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl>
        {([['Valor Total', 'paid_cents'], ['Acréscimos', 'penalty_cents'], ['Descontos', 'discount_cents'], ['Juros', 'interest_cents'], ['Tarifas', 'fee_cents']] as const).map(([label, key]) => <dl key={key} className="native-list-stat"><dt>{label}</dt><dd>{page ? financeMoney(page.totals[key]) : '—'}</dd></dl>)}
        <p className="real-help">Informações baseadas nos filtros aplicados na listagem.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to={back}>{kind === 'receivable' ? 'Contas a receber' : 'Contas a pagar'}</Link></div>
    </>}>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="bordero-search">Pesquisar na listagem</label><input id="bordero-search" type="search" maxLength={120} placeholder="Pesquisar" value={search} onChange={event => setSearch(event.target.value)} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !access}><Icon name="search" size={16} /></button>
        <PeriodPicker from={period.from} to={period.to} today={today} onApply={range => go({ from: range.from, to: range.to })} />
        <div className="origin-toolbar-tools">{writable && <ToolButton icon="trash-can" title="Excluir borderôs selecionados" disabled={!chosen.length || Boolean(pendingVisible) || Boolean(removalVisible)} onClick={() => { if (mayWrite()) setRemoval({ key: routeKey, step: 'params', rows: chosen, note: '', postedOn: today, error: '', plan: null, recovery: false }); }} />}<ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={() => go({ q: '', account: '', category: '', from: '', to: '', value: '', title: '' })} />
      {pendingVisible && <p className="real-alert" role="alert">{pendingVisible.items.length === 1 ? '1 borderô' : `${pendingVisible.items.length} borderôs`} sem resultado confirmado. <button type="button" className="text-button" disabled={Boolean(removalVisible)} onClick={() => { if (!mayWrite()) return; setRemoval({ key: routeKey, step: 'run', rows: pendingVisible.items.map(item => item.bordero), note: pendingVisible.note, postedOn: pendingVisible.postedOn, error: '', plan: { eligible: pendingVisible.items, skipped: [] }, recovery: true }); }}>Conferir resultado</button> <button type="button" className="text-button" onClick={() => setPending(null)}>Conferir depois</button></p>}
      <div className="real-result-status" role="status">{loading ? 'Carregando borderôs…' : page ? rangeLabel(route.page, BORDERO_PAGE_SIZE, page.total) : list.error || 'Borderôs indisponíveis.'}</div>
      {list.key === listKey && list.error && <p className="real-alert" role="alert">{list.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Borderôs"><table className="data-table finance-table"><thead><tr>{writable && <th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todos" title="Selecionar todos" checked={rows.length > 0 && chosen.length === rows.length} onChange={() => setSelection({ key: listKey, ids: chosen.length === rows.length ? [] : rows.map(row => row.id), anchor: null })} /></th>}<th>Data</th><th>{party}</th><th>Histórico</th><th className="numeric">Valor</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className={`finance-row${selected.includes(row.id) ? ' selected' : ''}`} onClick={event => { if (!(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, label')) void open(row.id); }}>
          {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar borderô de ${financeDate(row.posted_on)}`} checked={selected.includes(row.id)} onClick={event => toggle(row.id, event.shiftKey)} onChange={() => undefined} /></td>}
          <td>{financeDate(row.posted_on)}</td><td><button type="button" className="text-button finance-open" onClick={() => void open(row.id)}>{contactText(row, kind)}</button>{row.grouped && <small className="real-help"> · agrupado</small>}</td><td>{row.note ?? '—'}</td><td className="numeric">{financeMoney(row.totals.paid_cents)}</td></tr>)}</tbody></table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhum borderô encontrado</h2><p>As baixas de contas aparecem aqui. Ajuste o período ou os filtros.</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.page, pages)} pages={pages} size={BORDERO_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.page) go({ page: target }); }} /></footer></>}
    </NativeListLayout></form>}
    {detail && detail.key === routeKey && (detail.record ? <BorderoView record={detail.record} onClose={() => setDetail(null)} /> : <Modal title="Borderô" onClose={() => setDetail(null)} actions={<><button type="button" className="secondary-button" onClick={() => setDetail(null)}>Fechar</button>{detail.error && <button type="button" className="primary-button" onClick={() => void open(detail.id)}>Tentar novamente</button>}</>}><p role={detail.error ? 'alert' : 'status'}>{detail.error || 'Carregando borderô…'}</p></Modal>)}
    {removalVisible && removalVisible.step === 'params' && <Modal title="Excluir borderôs selecionados" onClose={() => setRemoval(null)} actions={<><button type="button" className="secondary-button" onClick={() => setRemoval(null)}>Cancelar</button><button type="button" className="primary-button" onClick={() => {
      try { postingDate(removalVisible.postedOn); if (!removalVisible.note.trim()) throw new Error('Informe o motivo da exclusão.'); if (removalVisible.rows.some(row => removalVisible.postedOn < row.posted_on)) throw new Error('A data do estorno não pode ser anterior à data do borderô.');
        commands.current = new Map(); uncertain.current = new Set(); setRemoval({ ...removalVisible, step: 'run', note: removalVisible.note.trim(), plan: plan(removalVisible.rows) }); }
      catch (failure) { setRemoval({ ...removalVisible, error: (failure as Error).message }); } }}>Continuar</button></>}>
      <p>{removalVisible.rows.length === 1 ? 'Deseja mesmo excluir este borderô?' : `Deseja mesmo excluir os ${removalVisible.rows.length} borderôs selecionados?`} As baixas de cada borderô serão estornadas na data informada; o histórico continua guardado.</p>
      <BorderoField label="Data do estorno *">{id => <input id={id} type="date" max={today} value={removalVisible.postedOn} onChange={event => { const value = event.target.value; setRemoval(previous => previous && { ...previous, postedOn: value }); }} />}</BorderoField>
      <div className="form-field"><label htmlFor="bordero-delete-note">Motivo *</label><textarea id="bordero-delete-note" rows={3} maxLength={500} value={removalVisible.note} onChange={event => { const value = event.target.value; setRemoval(previous => previous && { ...previous, note: value }); }} /></div>
      {removalVisible.error && <p className="real-alert" role="alert">{removalVisible.error}</p>}
    </Modal>}
    {removalVisible && removalVisible.step === 'run' && removalVisible.plan && <BatchDialog title={removalVisible.recovery ? 'Conferir resultado' : 'Excluir borderôs selecionados'} description={<dl className="finance-review"><div><dt>Data do estorno</dt><dd>{financeDate(removalVisible.postedOn)}</dd></div><div><dt>Motivo</dt><dd>{removalVisible.note}</dd></div></dl>}
      plan={removalVisible.plan} confirmLabel={removalVisible.recovery ? 'Conferir resultado' : 'Excluir borderôs'} canConfirm={writable} run={run(removalVisible)} onClose={results => finish(removalVisible, results)} />}
    {printRoute && printRoute.key === routeKey && <FinanceBorderoPrint controller={controller} route={printRoute.route} onClose={() => setPrintRoute(null)} />}
  </>;
}
