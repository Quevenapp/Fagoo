import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { centsInput, financeDate, financeMoney, moneyInput, todaySP, type FinanceAccess, financePermitted } from '../lib/real-finance-model';
import { financialAccount, type FinancialAccount } from '../lib/finance-registry-model';
import { CANDIDATE_TYPE, RECONCILIATION_PAGE, RECONCILIATION_STATES, decodeOfx, reconciliationApiPath, reconciliationPage, reconciliationParams, reconciliationRoute, sumCents, toReconcile,
  type BankLine, type BankStatementFile, type Candidate, type ReconciliationPage, type ReconciliationRoute, type TitleCandidate } from '../lib/finance-reconciliation-model';
import { OWNED_ORIGIN, signedMoney } from '../lib/finance-statement-model';
import { useFinanceCommand, definitiveFailure, type FinanceCommand } from '../lib/finance-command';
import { planBatch, batchSummaryText, summarizeBatch, type BatchItem, type BatchPlan, type BatchResult } from '../lib/origin-batch';
import { PERIOD_PRESETS, addDays, presetRange, type PeriodPreset } from '../lib/origin-list';
import { CategoryTreePicker, useCategoryTree } from './FinanceCategoryTreeSelect';
import { CatalogPicker } from './DocumentCatalogPicker';
import { OriginSelector, ToolButton } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { CashEntryDrawer } from './FinanceStatement';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-title-drawer.css';
import './finance-statement.css';
import './finance-reconciliation.css';

const noSubscription = () => () => {}, noSnapshot = () => null;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.status === 422 ? 'O arquivo não é um extrato OFX válido.' : failure.status === 409 ? 'A linha, o extrato ou o lançamento mudou, já está conciliado ou este arquivo já foi importado. Atualize a conciliação.' : failure.status === 400 ? 'A operação não foi aceita. Confira se os valores somam o valor do extrato e se a conta e as datas são válidas.' : failure.status === 403 ? 'Seu acesso a esta operação foi alterado.' : failure.status === 404 ? 'O registro não foi encontrado. Atualize a conciliação.' : 'Não foi possível concluir a consulta. Tente novamente.' : failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.';
function ReconciliationBusyGuard() { useUnsavedChanges(false, true); return null; }
function ReconciliationField({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) { const id = useId(); return <div className="form-field finance-drawer-wide"><label htmlFor={id}>{label}</label>{children(id)}{hint}</div>; }
type Send = (command: FinanceCommand) => Promise<unknown>;
/** Período of Buscar: around the date of the bank line (padrão), the Origin presets or Período customizado. */
const SEARCH_PERIODS = [{ id: 'extrato', label: '30 dias antes e depois do extrato' }, ...PERIOD_PRESETS.filter(item => item.id !== 'selecionar-mes')] as const;
type SearchPeriod = (typeof SEARCH_PERIODS)[number]['id'];
const candidateText = (item: Candidate) => `${CANDIDATE_TYPE[item.line_kind]} · ${financeDate(item.posted_on)} · ${signedMoney(item.amount_cents)}${item.note ? ` · ${item.note}` : ''}`;

/** "Buscar": lançamentos sem vínculo e contas em aberto para conciliar com a linha, com "Valor no extrato" e "Para conciliar". */
// Origin "Múltiplos lançamentos" opens the same search to add several lançamentos that together make the value of the line.
function SearchDrawer({ controller, line, send, mayWrite, onClose, onSaved, multiple = false }: { controller: AccessController; line: BankLine; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void; multiple?: boolean }) {
  const [query, setQuery] = useState(''), [range, setRange] = useState({ from: addDays(line.posted_on, -30), to: addDays(line.posted_on, 30) }), [reload, setReload] = useState(0), [period, setPeriod] = useState<SearchPeriod>('extrato');
  const choosePeriod = (next: SearchPeriod) => { setPeriod(next); if (next === 'extrato') setRange({ from: addDays(line.posted_on, -30), to: addDays(line.posted_on, 30) }); else if (next !== 'customizado') setRange(presetRange(next as PeriodPreset, todaySP())); };
  const [result, setResult] = useState<{ key: string; movements: Candidate[]; titles: TitleCandidate[]; error: string } | null>(null), [chosen, setChosen] = useState<{ movements: string[]; titles: string[] }>({ movements: [], titles: [] });
  const command = useFinanceCommand(send, mayWrite, failureText), key = `${query}:${range.from}:${range.to}:${reload}`, [adjusting, setAdjusting] = useState(false), [adjustError, setAdjustError] = useState('');
  useEffect(() => {
    const request = new AbortController(); setResult(null);
    const params = new URLSearchParams({ account: line.account_id, from: range.from, to: range.to }); if (query.trim()) params.set('q', query.trim());
    void controller.finance(`/v1/financeiro/conciliacao/candidatos?${params}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) { const raw = value as { movements?: Candidate[]; titles?: TitleCandidate[]; entity?: string }; if (raw?.entity !== 'reconciliation_candidates') throw new Error('x'); setResult({ key, movements: raw.movements ?? [], titles: (raw.titles ?? []).filter(item => item.kind === (BigInt(line.amount_cents) > 0n ? 'receivable' : 'payable')), error: '' }); } })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setResult({ key, movements: [], titles: [], error: failureText(failure) }); });
    return () => request.abort();
  }, [key]);
  const movements = result?.movements.filter(item => chosen.movements.includes(`${item.kind}:${item.id}`)) ?? [], titles = result?.titles.filter(item => chosen.titles.includes(item.id)) ?? [];
  const selectedSum = titles.length ? (BigInt(line.amount_cents) > 0n ? 1n : -1n) * titles.reduce((sum, item) => sum + BigInt(item.balance_cents), 0n) : BigInt(sumCents(movements));
  const left = (BigInt(line.amount_cents) - selectedSum).toString(), single = movements.length === 1 && !titles.length && movements[0].kind === 'entry' && ['manual', 'ledger', 'reconciliation', 'import'].includes(movements[0].entry_origin ?? 'manual');
  const conciliate = () => void command.run(() => {
    if (left !== '0') throw new Error('Os lançamentos selecionados devem somar o valor do extrato.');
    if (titles.length) return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_settle_titles', data: { line_id: line.id, expected_version: line.version, items: titles.map(item => ({ id: item.id, expected_version: item.version, principal_cents: item.balance_cents })) } };
    if (!movements.length) throw new Error('Selecione os lançamentos para conciliar.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_reconcile', data: { line_id: line.id, expected_version: line.version, links: movements.map(item => ({ kind: item.kind, id: item.id })) } };
  }, () => onSaved('Linha conciliada.'));
  // "Ajustar valor": the lançamento de caixa takes the value of the bank line; the conciliation is a second step.
  const adjust = async () => {
    if (!single || adjusting || !mayWrite()) return; setAdjusting(true); setAdjustError('');
    try {
      const entry = (await controller.finance(`/v1/financeiro/lancamentos/${movements[0].id}`) as { record: { id: string; version: number; account_id: string; posted_on: string; competence_on: string; category_id: string | null; contact_id: string | null; note: string; origin: string } }).record;
      const amount = BigInt(line.amount_cents), data = { id: entry.id, expected_version: entry.version, account_id: entry.account_id, kind: amount > 0n ? 'in' : 'out', amount_cents: (amount < 0n ? -amount : amount).toString(), posted_on: entry.posted_on, competence_on: entry.competence_on, category_id: entry.category_id, contact_id: entry.contact_id, note: entry.note };
      await send({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/entry_save', data }); setReload(value => value + 1);
    } catch (failure) { setAdjustError(definitiveFailure(failure) ? `Ajustar valor: ${failureText(failure)}` : 'Não foi possível confirmar o ajuste do valor. Confira o lançamento em Caixas e bancos antes de repetir.'); } finally { setAdjusting(false); }
  };
  const toggle = (group: 'movements' | 'titles', value: string, checked: boolean) => setChosen(previous => ({ movements: group === 'titles' ? [] : checked ? [...previous.movements, value] : previous.movements.filter(item => item !== value), titles: group === 'movements' ? [] : checked ? [...previous.titles, value] : previous.titles.filter(item => item !== value) }));
  return <div className="finance-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !command.busy) onClose(); }}>
    <section className="finance-drawer" role="dialog" aria-modal="true" aria-label={multiple ? 'Múltiplos lançamentos' : 'Buscar lançamentos'}>
      <header className="finance-drawer-head"><div className="finance-drawer-title"><h2>{multiple ? 'Múltiplos lançamentos' : 'Buscar lançamentos'}</h2></div><button type="button" className="icon-button" aria-label="Fechar" disabled={command.busy} onClick={onClose}><Icon name="xmark" size={16} /></button></header>
      <p>{multiple ? 'Selecione os lançamentos que, somados, correspondem ao valor do extrato. A diferença aparece abaixo até zerar.' : 'Pesquise e adicione os lançamentos que você deseja conciliar.'}</p>
      <div className="finance-drawer-fields"><ReconciliationField label="Pesquisar">{id => <input id={id} type="search" maxLength={120} placeholder="Busque por fornecedor, forma de pagamento, vencimento ou valor.." value={query} onChange={event => setQuery(event.target.value)} />}</ReconciliationField>
        <ReconciliationField label="Período">{id => <select id={id} value={period} onChange={event => choosePeriod(event.target.value as SearchPeriod)}>{SEARCH_PERIODS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}</ReconciliationField>
        {period === 'customizado' ? <><ReconciliationField label="De">{id => <input id={id} type="date" value={range.from} onChange={event => { const from = event.target.value; if (from) setRange(previous => ({ ...previous, from })); }} />}</ReconciliationField>
        <ReconciliationField label="Até">{id => <input id={id} type="date" value={range.to} onChange={event => { const to = event.target.value; if (to) setRange(previous => ({ ...previous, to })); }} />}</ReconciliationField></>
          : <p className="real-help">De {financeDate(range.from)} até {financeDate(range.to)}.</p>}</div>
      {!result ? <p role="status">Buscando lançamentos…</p> : result.error ? <p className="real-alert" role="alert">{result.error}</p> : <>
        <h3>Movimentações sem conciliação</h3>
        {!result.movements.length ? <p className="real-help">Nenhum lançamento sem vínculo no período.</p> : <ul className="finance-candidate-list">{result.movements.map(item => <li key={`${item.kind}:${item.id}`}><label htmlFor={`candidate-${item.kind}-${item.id}`}><input id={`candidate-${item.kind}-${item.id}`} type="checkbox" checked={chosen.movements.includes(`${item.kind}:${item.id}`)} disabled={command.locked} onChange={event => toggle('movements', `${item.kind}:${item.id}`, event.target.checked)} />{candidateText(item)}{item.contact_name ? ` · ${item.contact_name}` : ''}</label></li>)}</ul>}
        <h3>{BigInt(line.amount_cents) > 0n ? 'Contas a receber em aberto' : 'Contas a pagar em aberto'}</h3>
        {!result.titles.length ? <p className="real-help">Nenhuma conta em aberto com vencimento no período.</p> : <table className="data-table"><thead><tr><th /><th>{BigInt(line.amount_cents) > 0n ? 'Cliente' : 'Fornecedor'}</th><th>Forma de pagamento</th><th>Tipo</th><th>Vencimento</th><th className="numeric">Valor</th></tr></thead><tbody>{result.titles.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`Selecionar ${item.description}`} checked={chosen.titles.includes(item.id)} disabled={command.locked} onChange={event => toggle('titles', item.id, event.target.checked)} /></td><td>{item.contact_name}</td><td>{item.payment_method_name ?? '—'}</td><td>{item.installments > 1 ? 'Contas a receber/pagar parcelamento' : 'Contas a receber/pagar'}</td><td>{financeDate(item.due_on)}</td><td className="numeric">{financeMoney(item.balance_cents)}</td></tr>)}</tbody></table>}
      </>}
      <dl className="finance-review"><div><dt>Valor no extrato</dt><dd>{signedMoney(line.amount_cents)}</dd></div><div><dt>Lançamentos selecionados</dt><dd>{signedMoney(selectedSum.toString())}</dd></div><div><dt>Para conciliar</dt><dd>{signedMoney(left)}</dd></div></dl>
      {left !== '0' && (movements.length > 0 || titles.length > 0) && <p className="real-alert" role="alert">Divergência entre registro e movimentação.{single && <> <button type="button" className="text-button" disabled={adjusting || command.locked} onClick={() => void adjust()}>Ajustar valor</button></>}</p>}
      {adjustError && <p className="real-alert" role="alert">{adjustError}</p>}{command.error && <p className="real-alert" role="alert">{command.error}</p>}
      <div className="finance-drawer-actions"><button type="button" className="text-button" disabled={command.busy} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || (!command.uncertain && left !== '0')} onClick={conciliate}>{command.busy ? 'Conciliando…' : command.uncertain ? 'Conferir resultado' : 'Conciliar'}</button></div>
    </section></div>;
}

type EntryRecord = NonNullable<Parameters<typeof CashEntryDrawer>[0]['entry']>;
/** Lançamentos de caixa that "Editar registro" opens (the same origins Caixas e bancos edits). */
const EDITABLE_ORIGINS = ['manual', 'ledger', 'reconciliation', 'import'];
type Panel = { kind: 'edit'; entry: EntryRecord } | { kind: 'search'; line: BankLine; multiple?: boolean } | { kind: 'entry'; line: BankLine } | { kind: 'transfer'; line: BankLine } | { kind: 'revert'; line: BankLine; reverse: boolean } | { kind: 'statements' };

/**
 * Caixas e bancos > aba Conciliação do Origin (SQL 137): upload do .OFX (sem API bancária), Extrato do Banco x Movimentações
 * no Brufap em cards, Situação (Pendentes | Conciliados | Ocultos) e Valor, CONCILIAR TODOS as sugestões, Carregar mais
 * movimentações, Buscar, Novo (Registro de Caixa | Transferência | Pagamento/Recebimento), Ocultar/Exibir, Desvincular,
 * Reverter conciliação com estorno e Extratos importados.
 */
export default function FinanceReconciliation({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate();
  let parsed: { route: ReconciliationRoute; error: string };
  try { parsed = { route: reconciliationRoute(new URLSearchParams(location.search)), error: '' }; } catch (failure) { parsed = { route: { conta: '', situacao: 'pending', valor: '' }, error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [list, setList] = useState<{ key: string; page: ReconciliationPage | null; items: BankLine[]; error: string; loadingMore: boolean }>({ key: '', page: null, items: [], error: '', loadingMore: false });
  const page = list.key === listKey ? list.page : null, items = list.key === listKey ? list.items : [], loading = Boolean(route.conta) && !parsed.error && (list.key !== listKey || (!list.page && !list.error));
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]), [panel, setPanel] = useState<(Panel & { key: string }) | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState(''), [valor, setValor] = useState(route.valor ? centsInput(route.valor) : '');
  const [quick, setQuick] = useState<{ command: FinanceCommand; done: string; busy: boolean; uncertain: boolean } | null>(null), [importing, setImporting] = useState<{ command: FinanceCommand | null; busy: boolean; uncertain: boolean } | null>(null);
  const [batch, setBatch] = useState<{ key: string; plan: BatchPlan<BatchItem & { line: BankLine }> } | null>(null), commands = useRef(new Map<string, FinanceCommand>()), uncertain = useRef(new Set<string>()), [running, setRunning] = useState(false);
  const finance = access ? (path: string, options?: { signal?: AbortSignal }) => controller.finance(path, options) : null;
  const trees = { receivable: useCategoryTree(finance, 'receivable', scope), payable: useCategoryTree(finance, 'payable', scope) };
  // Mostrar detalhes (bank line) and Mostrar mais/menos (Movimentações no Brufap), per line, reset by the route.
  const [shown, setShown] = useState<{ key: string; details: string[]; more: string[] }>({ key: '', details: [], more: [] });
  const opened = shown.key === routeKey ? shown : { key: routeKey, details: [] as string[], more: [] as string[] };
  const toggleShown = (group: 'details' | 'more', id: string) => setShown(previous => { const base = previous.key === routeKey ? previous : { key: routeKey, details: [], more: [] }; return { ...base, [group]: base[group].includes(id) ? base[group].filter(item => item !== id) : [...base[group], id] }; });
  useEffect(() => { setPanel(null); setError(''); setValor(route.valor ? centsInput(route.valor) : ''); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access) return; const request = new AbortController();
    void controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo', { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setAccounts(((value as { items?: unknown[] })?.items ?? []).map(financialAccount)); }).catch(() => { /* The selector stays empty. */ });
    return () => request.abort();
  }, [controller, access]);
  useEffect(() => {
    if (!access || !route.conta || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(reconciliationApiPath(route, 1), { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) { const loaded = reconciliationPage(value, route, 1); setList({ key: listKey, page: loaded, items: loaded.items, error: '', loadingMore: false }); } })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setList({ key: listKey, page: null, items: [], error: failureText(failure), loadingMore: false }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  const go = (next: Partial<ReconciliationRoute>) => navigate(`${location.pathname}?${reconciliationParams({ ...route, ...next })}`);
  const send: Send = command => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const saved = (text: string) => { if (!mayRead()) return; setPanel(null); setNotice(text); setReload(value => value + 1); };
  // Editar registro: the lançamento de caixa of the Brufap card opens in the gaveta of Caixas e bancos (a reconciled one keeps its value and date).
  const editEntry = async (id: string) => {
    if (!mayWrite() || quick) return; setError(''); setNotice('');
    try { const value = await controller.finance(`/v1/financeiro/lancamentos/${id}`) as { record?: EntryRecord }; if (!mayRead()) return; if (value?.record?.id !== id) throw new Error('mismatch'); setPanel({ kind: 'edit', entry: value.record, key: routeKey }); }
    catch (failure) { if (mayRead()) setError(failure instanceof AccessError ? failureText(failure) : 'Não foi possível abrir o lançamento.'); }
  };
  const loadMore = async () => {
    if (!page || list.loadingMore || items.length >= page.total || !mayRead()) return; const key = listKey, next = Math.floor(items.length / RECONCILIATION_PAGE) + 1; setList(previous => ({ ...previous, loadingMore: true }));
    try { const loaded = reconciliationPage(await controller.finance(reconciliationApiPath(route, next)), route, next); if (mayRead()) setList(previous => previous.key === key ? { ...previous, items: [...previous.items, ...loaded.items.filter(item => !previous.items.some(old => old.id === item.id))], loadingMore: false } : previous); }
    catch (failure) { if (mayRead()) setList(previous => previous.key === key ? { ...previous, loadingMore: false, error: failureText(failure) } : previous); }
  };
  const runQuick = async (state: { command: FinanceCommand; done: string; uncertain: boolean }) => {
    if (!mayWrite()) { setError('Seu acesso a esta operação foi alterado.'); return; } setQuick({ ...state, busy: true }); setError('');
    try { await send(state.command); if (!mayRead()) return; setQuick(null); saved(state.done); }
    catch (failure) { if (!mayRead()) return; if (definitiveFailure(failure) && !state.uncertain) { setQuick(null); setError(failureText(failure)); } else setQuick({ ...state, busy: false, uncertain: true }); }
  };
  const startQuick = (data: Record<string, unknown>, action: string, done: string) => { if (quick || !mayWrite()) return; void runQuick({ command: { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${action}`, data }, done, uncertain: false }); };
  const importFile = async (file: File | null | undefined) => {
    if (!file || !route.conta || !mayWrite() || importing?.busy) return; setError(''); setNotice('');
    if (!/\.ofx$/i.test(file.name)) { setError('Selecione um arquivo .OFX do seu banco.'); return; }
    if (file.size > 2 * 1024 * 1024) { setError('O arquivo passa de 2 MB.'); return; }
    const command = importing?.uncertain && importing.command ? importing.command : { id: crypto.randomUUID(), path: '/v1/financeiro/actions/statement_import', data: { account_id: route.conta, file_name: file.name, content: decodeOfx(new Uint8Array(await file.arrayBuffer())) } };
    setImporting({ command, busy: true, uncertain: Boolean(importing?.uncertain) });
    try { const value = await send(command) as { record: { new_lines: number; bank_lines: number } }; if (!mayRead()) return; setImporting(null); saved(`Extrato importado: ${value.record.new_lines} de ${value.record.bank_lines} lançamento(s) novo(s).`); }
    catch (failure) { if (!mayRead()) return; if (definitiveFailure(failure) || (failure instanceof AccessError && failure.status === 422)) { setImporting(null); setError(failureText(failure)); } else { setImporting({ command, busy: false, uncertain: true }); setError('Não foi possível confirmar a importação. Use “Conferir resultado” para repetir o mesmo envio; nada será duplicado.'); } }
  };
  const conciliateAll = () => {
    if (!mayWrite() || batch) return; commands.current = new Map(); uncertain.current = new Set();
    setBatch({ key: routeKey, plan: planBatch(items.filter(line => line.state === 'pending').map(line => ({ id: line.id, label: `${financeDate(line.posted_on)} · ${line.memo ?? line.fitid} · ${signedMoney(line.amount_cents)}`, line })), ({ line }) => line.suggestion ? null : 'Sem sugestão: use Buscar ou Novo.') });
  };
  const runItem = async (item: BatchItem & { line: BankLine }) => {
    const replay = uncertain.current.has(item.id);
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso foi alterado; o envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado.'); }
    let command = commands.current.get(item.id); if (!command) { command = { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_reconcile', data: { line_id: item.line.id, expected_version: item.line.version, links: [{ kind: item.line.suggestion!.kind, id: item.line.suggestion!.id }] } }; commands.current.set(item.id, command); }
    setRunning(true);
    try { await send(command); uncertain.current.delete(item.id); commands.current.delete(item.id); }
    catch (failure) { if (definitiveFailure(failure) && !replay) { commands.current.delete(item.id); throw new Error(failureText(failure)); } uncertain.current.add(item.id); return { uncertain: true, message: 'Resultado não confirmado. Use “Conferir resultado”.' }; }
  };
  const finishBatch = (results: BatchResult[] | null) => { setBatch(null); setRunning(false); if (results === null) return; setNotice(`Conciliar todos: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1); };
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'financas.conciliacao'), account = accounts.find(item => item.id === route.conta), panelVisible = panel && panel.key === routeKey ? panel : null;
  const options = accounts.filter(item => item.account_type !== 'integration');
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const fileInput = (label: string) => <label className="primary-button finance-ofx-upload" htmlFor="reconciliation-ofx"><Icon name="plus" size={14} />{label}<input id="reconciliation-ofx" type="file" accept=".ofx" className="real-sr-only" disabled={!writable || Boolean(importing?.busy)} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></label>;
  return <>{(running || quick || importing?.uncertain) && <ReconciliationBusyGuard />}
    <header className="real-heading"><div className="finance-heading-title"><h1>Caixas e bancos</h1>{access && <OriginSelector label="Conta financeira" value={account?.name ?? 'Selecione a conta'} options={options.map(item => item.name)} onChange={label => { const target = options.find(item => item.name === label)?.id; if (target && target !== route.conta) go({ conta: target }); }} />}</div>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    <nav className="finance-tabs" aria-label="Abas do extrato">{[['movimentacoes', 'Movimentações'], ['entradas', 'Entradas'], ['saidas', 'Saídas']].map(([tab, label]) => <Link key={tab} to={`/financeiro-empresa?area=accounts${route.conta ? `&conta=${route.conta}` : ''}${tab === 'movimentacoes' ? '' : `&aba=${tab}`}`}>{label}</Link>)}<button type="button" aria-current="page">Conciliação</button></nav>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}{importing?.uncertain && <> Anexe o mesmo arquivo de novo em “Conferir resultado”.</>}</p>}
    {quick?.uncertain && <p className="real-alert" role="alert">Resultado não confirmado. <button type="button" className="text-button" disabled={quick.busy} onClick={() => void runQuick(quick)}>Conferir resultado</button></p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=conciliacao`)}>Limpar filtros da URL</button></section>
      : !route.conta ? <section className="real-state-panel"><h2>Conciliação bancária</h2><p>Selecione no topo a conta financeira cujo extrato você vai conciliar.</p></section>
      : loading ? <p role="status">Carregando conciliação…</p> : list.error && !page ? <p className="real-alert" role="alert">{list.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>
      : page && !page.statements.length && route.situacao === 'pending' ? <section className="finance-reconciliation-welcome"><h2>Bem-vindo a conciliação bancária</h2><p>Faça o upload do arquivo .OFX do seu banco</p>{writable ? fileInput(importing?.uncertain ? 'Conferir resultado' : 'Selecione um arquivo') : <p className="real-help">Seu perfil consulta a conciliação, sem importar.</p>}<p className="real-help">O arquivo é lido pelo FAGOO; nenhuma API bancária é acionada.</p></section>
      : page && <div className="finance-reconciliation">
        <div className="native-list-toolbar">
          <fieldset className="finance-option-filter finance-inline"><legend>Situação</legend>{RECONCILIATION_STATES.map(state => <label key={state.value} htmlFor={`reconciliation-state-${state.param}`}><input id={`reconciliation-state-${state.param}`} type="radio" name="reconciliation-state" checked={route.situacao === state.value} onChange={() => go({ situacao: state.value })} />{state.label} ({page.counts[state.value]})</label>)}</fieldset>
          <div className="form-field"><label htmlFor="reconciliation-value">Valor</label><input id="reconciliation-value" inputMode="decimal" placeholder="0,00" maxLength={16} value={valor} onChange={event => setValor(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); try { const cents = valor.trim() ? moneyInput(valor) : ''; go({ valor: cents === '0' ? '' : cents }); } catch (failure) { setError((failure as Error).message); } } }} /></div>
          <div className="origin-toolbar-tools">{writable && route.situacao === 'pending' && <button type="button" className="secondary-button" disabled={!items.some(line => line.suggestion) || Boolean(batch) || Boolean(quick)} onClick={conciliateAll}>CONCILIAR TODOS</button>}
            {writable && fileInput(importing?.uncertain ? 'Conferir resultado' : 'Importar .OFX')}
            <button type="button" className="text-button" onClick={() => setPanel({ kind: 'statements', key: routeKey })}>Extratos importados</button>
            <Link className="text-button" to={`/financeiro-empresa?area=accounts&conta=${route.conta}`}>Alterar categorias</Link>
            <ToolButton icon="rotate-right" title="Recarregar" onClick={() => setReload(value => value + 1)} /></div></div>
        <div className="finance-reconciliation-head"><span>Extrato do Banco</span><span /><span>Movimentações no FAGOO</span></div>
        {!items.length ? <div className="empty-state"><h2>Nenhum lançamento {RECONCILIATION_STATES.find(state => state.value === route.situacao)!.label.toLowerCase()}</h2></div> : <ul className="finance-reconciliation-list">{items.map(line => {
          const target = line.state === 'reconciled' ? line.links : line.suggestion ? [line.suggestion] : [], more = opened.more.includes(line.id), details = opened.details.includes(line.id);
          const file = page.statements.find(item => item.id === line.statement_id), visible = more ? target : target.slice(0, 2);
          return <li key={line.id} className={`finance-reconciliation-row ${line.state}`}>
            <div className="finance-bank-card"><strong>{line.memo ?? 'Lançamento do extrato'}</strong><span className={BigInt(line.amount_cents) < 0n ? 'finance-negative' : 'finance-positive'}>{signedMoney(line.amount_cents)}</span><span>{financeDate(line.posted_on)}</span><small className="real-help">Detalhamento: {line.fitid}{line.trntype ? ` · ${line.trntype}` : ''}</small>
              <button type="button" className="text-button" aria-expanded={details} onClick={() => toggleShown('details', line.id)}>{details ? 'Ocultar detalhes' : 'Mostrar detalhes'}</button>
              {details && <dl className="finance-review"><div><dt>Identificador do banco (FITID)</dt><dd>{line.fitid}</dd></div><div><dt>Tipo da transação</dt><dd>{line.trntype ?? '—'}</dd></div>
                <div><dt>Arquivo</dt><dd>{file ? `${file.file_name} (${financeDate(file.period_from)} a ${financeDate(file.period_to)})` : '—'}</dd></div><div><dt>Importado em</dt><dd>{file ? financeDate(file.created_at.slice(0, 10)) : '—'}</dd></div></dl>}
              {writable && line.state !== 'reconciled' && <button type="button" className="icon-button" aria-label={line.state === 'hidden' ? 'Exibir lançamento' : 'Ocultar lançamento'} title={line.state === 'hidden' ? 'Exibir lançamento' : 'Ocultar lançamento'} disabled={Boolean(quick)} onClick={() => startQuick({ line_id: line.id, expected_version: line.version }, line.state === 'hidden' ? 'line_show' : 'line_hide', line.state === 'hidden' ? 'Lançamento exibido de novo.' : 'Lançamento oculto.')}><Icon name={line.state === 'hidden' ? 'eye' : 'eye-slash'} size={14} /></button>}</div>
            <div className="finance-reconciliation-check">{line.state === 'reconciled' ? <button type="button" className="icon-button finance-reconciled" aria-label="Reverter conciliação" title="Reverter conciliação" disabled={!writable || Boolean(quick)} onClick={() => setPanel({ kind: 'revert', line, reverse: false, key: routeKey })}><Icon name="circle-check" size={20} /></button>
              : line.state === 'pending' && line.suggestion && writable ? <button type="button" className="primary-button" disabled={Boolean(quick)} onClick={() => startQuick({ line_id: line.id, expected_version: line.version, links: [{ kind: line.suggestion!.kind, id: line.suggestion!.id }] }, 'line_reconcile', 'Linha conciliada.')}>Conciliar</button> : <Icon name="circle" size={18} />}</div>
            <div className="finance-brufap-card">{target.length ? <>{visible.map(item => <div key={`${item.kind}:${item.id}`} className="finance-brufap-item"><strong>{CANDIDATE_TYPE[item.line_kind]}</strong><span>{signedMoney(item.amount_cents)}</span><span>{financeDate(item.posted_on)}</span><small className="real-help">{item.note ?? ''}{item.contact_name ? ` · ${item.contact_name}` : ''}</small>
                {more && <small className="real-help">Categoria: {item.category_name ?? 'Sem categoria'}</small>}
                {writable && item.kind === 'entry' && EDITABLE_ORIGINS.includes(item.entry_origin ?? 'manual') && <button type="button" className="text-button" disabled={Boolean(quick)} onClick={() => void editEntry(item.id)}>Editar registro</button>}</div>)}
                <button type="button" className="text-button" aria-expanded={more} onClick={() => toggleShown('more', line.id)}>{more ? 'Mostrar menos' : target.length > 2 ? `Mostrar mais (${target.length - 2})` : 'Mostrar mais'}</button></>
              : <p className="real-help">{line.state === 'hidden' ? 'Lançamento oculto: fica fora da fila de pendentes.' : 'Nenhuma sugestão com o mesmo valor e data próxima.'}</p>}
              {line.state === 'pending' && line.suggestion && <small className="real-help">Sugestão pelo valor e pela data.</small>}
              {/* SQL 212: Desfazer vínculo discards the sugestão; the next one, if any, takes its place. */}
              {writable && line.state === 'pending' && line.suggestion && <button type="button" className="text-button" disabled={Boolean(quick)} onClick={() => startQuick({ line_id: line.id, expected_version: line.version, target: { kind: line.suggestion!.kind, id: line.suggestion!.id } }, 'line_dismiss', 'Sugestão descartada.')}>Desfazer vínculo</button>}
              {writable && line.state === 'pending' && <div className="finance-brufap-actions"><button type="button" className="text-button" onClick={() => setPanel({ kind: 'search', line, key: routeKey })}>Buscar</button>
                <button type="button" className="text-button" onClick={() => setPanel({ kind: 'search', line, multiple: true, key: routeKey })}>Múltiplos lançamentos</button>
                <button type="button" className="text-button" onClick={() => setPanel({ kind: 'entry', line, key: routeKey })}>Novo Registro de Caixa</button><button type="button" className="text-button" onClick={() => setPanel({ kind: 'transfer', line, key: routeKey })}>Nova Transferência</button>
                <button type="button" className="text-button" onClick={() => setPanel({ kind: 'search', line, key: routeKey })}>{BigInt(line.amount_cents) > 0n ? 'Novo Recebimento' : 'Novo Pagamento'}</button></div>}
              {writable && line.state === 'reconciled' && <div className="finance-brufap-actions"><button type="button" className="text-button" disabled={Boolean(quick)} onClick={() => setPanel({ kind: 'revert', line, reverse: false, key: routeKey })}>Desvincular lançamento</button></div>}</div>
          </li>; })}</ul>}
        {items.length < page.total && <button type="button" className="secondary-button" disabled={list.loadingMore} onClick={() => void loadMore()}>{list.loadingMore ? 'Carregando…' : 'Carregar mais movimentações'}</button>}
        <p className="real-help">{items.length} de {page.total} lançamento(s) do extrato.</p>
      </div>}
    {panelVisible?.kind === 'edit' && <CashEntryDrawer controller={controller} entry={panelVisible.entry} accounts={options} defaultAccount={route.conta} trees={trees} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={entry => saved(`Lançamento atualizado: ${entry.note}.`)} />}
    {panelVisible?.kind === 'search' && <SearchDrawer controller={controller} line={panelVisible.line} multiple={panelVisible.multiple} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'entry' && <EntryModal controller={controller} line={panelVisible.line} items={BigInt(panelVisible.line.amount_cents) > 0n ? trees.receivable.items : trees.payable.items} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'transfer' && <TransferFromLine line={panelVisible.line} accounts={options.filter(item => item.id !== route.conta)} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'revert' && <RevertModal line={panelVisible.line} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'statements' && page && <StatementsModal account={account?.name ?? ''} statements={page.statements} writable={writable} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {batch && batch.key === routeKey && <BatchDialog title="Conciliar todos" description={<p>Cada linha com sugestão é conciliada com o lançamento sugerido, uma por vez.</p>} plan={batch.plan} confirmLabel="Conciliar" canConfirm={writable} run={runItem} onClose={finishBatch} />}
  </>;
}

/** "Novo Registro de Caixa" a partir da linha: "<memo> - Criado via conciliação", com categoria e cliente ou fornecedor. */
function EntryModal({ controller, line, items, send, mayWrite, onClose, onSaved }: { controller: AccessController; line: BankLine; items: Parameters<typeof CategoryTreePicker>[0]['items']; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ category: '', contact: null as { id: string; name: string } | null, note: `${line.memo ?? 'Lançamento do extrato'} - Criado via conciliação` }), command = useFinanceCommand(send, mayWrite, failureText);
  const save = () => void command.run(() => { const note = values.note.trim(); if (!note) throw new Error('Informe o histórico.'); return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_create_entry', data: { line_id: line.id, expected_version: line.version, category_id: values.category || null, contact_id: values.contact?.id ?? null, note } }; }, () => onSaved('Registro de caixa criado e conciliado.'));
  return <Modal title="Novo Registro de Caixa" onClose={() => { if (!command.busy) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    <p>{financeDate(line.posted_on)} · {signedMoney(line.amount_cents)}</p>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Registro de caixa</legend>
      <ReconciliationField label="Categoria">{id => <CategoryTreePicker id={id} items={items} value={values.category} onChange={category => setValues(previous => ({ ...previous, category }))} />}</ReconciliationField>
      <div className="form-field finance-drawer-wide"><CatalogPicker controller={controller} entity="contacts" label="Cliente ou fornecedor" selected={values.contact} onSelect={record => setValues(previous => ({ ...previous, contact: record ? { id: record.id, name: record.name } : null }))} /></div>
      <ReconciliationField label="Histórico *">{id => <textarea id={id} rows={2} maxLength={2000} value={values.note} onChange={event => { const note = event.target.value; setValues(previous => ({ ...previous, note })); }} />}</ReconciliationField></fieldset>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function TransferFromLine({ line, accounts, send, mayWrite, onClose, onSaved }: { line: BankLine; accounts: readonly FinancialAccount[]; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [other, setOther] = useState(''), command = useFinanceCommand(send, mayWrite, failureText), out = BigInt(line.amount_cents) < 0n;
  const save = () => void command.run(() => { if (!other) throw new Error('Selecione a outra conta da transferência.'); return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_create_transfer', data: { line_id: line.id, expected_version: line.version, other_account_id: other } }; }, () => onSaved('Transferência criada e conciliada.'));
  return <Modal title="Nova Transferência" onClose={() => { if (!command.busy) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={onClose}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Transferindo…' : command.uncertain ? 'Conferir resultado' : 'Transferir'}</button></>}>
    <p>{out ? 'Saída' : 'Entrada'} de {financeMoney(line.amount_cents.replace('-', ''))} em {financeDate(line.posted_on)}.</p>
    <ReconciliationField label={out ? 'Conta Destino *' : 'Conta Origem *'}>{id => <select id={id} value={other} disabled={command.locked} onChange={event => setOther(event.target.value)}><option value="">Selecione uma opção</option>{accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</ReconciliationField>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function RevertModal({ line, send, mayWrite, onClose, onSaved }: { line: BankLine; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  // Estornar (SQL 172): lançamentos de caixa are excluded, baixas estornadas and transferências inverted, as in Origin.
  const [reverse, setReverse] = useState(false), command = useFinanceCommand(send, mayWrite, failureText);
  // Pagamentos de comissão and sangrias/suprimentos are excluded only in their screens (SQL 171/173 refuse it here).
  const owned = line.links.some(item => item.kind === 'entry' && Object.hasOwn(OWNED_ORIGIN, item.entry_origin ?? ''));
  const save = () => void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_unreconcile', data: { line_id: line.id, expected_version: line.version, ...(reverse && !owned ? { reverse: true } : {}) } }), () => onSaved(reverse && !owned ? 'Conciliação revertida e lançamentos estornados.' : 'Vínculo removido.'));
  return <Modal title="Reverter conciliação" onClose={() => { if (!command.busy) onClose(); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={onClose}>Cancelar</button><button type="button" className="danger-button" disabled={command.busy} onClick={save}>{command.busy ? 'Revertendo…' : command.uncertain ? 'Conferir resultado' : 'Confirmar'}</button></>}>
    <p>Tem certeza que deseja remover o vínculo do lançamento?</p>
    <p className="real-notice">Se houver nota fiscal ou pedido de venda, os valores não serão alterados.</p>
    <label className="finance-drawer-switch" htmlFor="reconciliation-reverse" title={owned ? 'Pagamento de comissão ou sangria/suprimento do Controle de caixa: remova o vínculo aqui e exclua o lançamento na própria tela.' : 'Exclui os lançamentos de caixa, estorna as baixas na data da baixa e desfaz as transferências.'}><input id="reconciliation-reverse" type="checkbox" checked={reverse && !owned} disabled={command.locked || owned} onChange={event => setReverse(event.target.checked)} />Estornar a(s) movimentação(ções) relacionada(s) a esse registro</label>
    {owned && <p className="real-help">Pagamentos de comissão e sangrias ou suprimentos são excluídos em Financeiro &gt; Comissões ou no Controle de caixa.</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
function StatementsModal({ account, statements, writable, send, mayWrite, onClose, onSaved }: { account: string; statements: readonly BankStatementFile[]; writable: boolean; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [target, setTarget] = useState<BankStatementFile | null>(null), command = useFinanceCommand(send, mayWrite, failureText);
  const remove = () => void command.run(() => ({ id: crypto.randomUUID(), path: '/v1/financeiro/actions/statement_delete', data: { id: target!.id } }), () => onSaved(`Extrato ${target!.file_name} excluído.`));
  return <Modal title="Extratos importados" onClose={() => { if (!command.busy) onClose(); }} actions={<>{target && <button type="button" className="danger-button" disabled={command.busy} onClick={remove}>{command.busy ? 'Excluindo…' : command.uncertain ? 'Conferir resultado' : `Excluir ${target.file_name}`}</button>}<button type="button" className="secondary-button" disabled={command.busy} onClick={onClose}>Fechar</button></>}>
    <p><strong>{account}</strong></p>
    {!statements.length ? <p className="real-help">Nenhum extrato importado.</p> : <table className="data-table"><thead><tr><th>Data de importação</th><th>Arquivo</th><th>Período</th><th className="numeric">Total de registros</th><th className="numeric">Total de conciliados</th><th /></tr></thead>
      <tbody>{statements.map(item => <tr key={item.id}><td>{new Date(item.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td><td>{item.file_name}</td><td>{financeDate(item.period_from)} a {financeDate(item.period_to)}</td><td className="numeric">{item.lines}</td><td className="numeric">{item.reconciled}</td>
        <td>{writable && <button type="button" className="text-button" disabled={item.reconciled > 0 || command.locked} title={item.reconciled > 0 ? 'Desvincule as linhas conciliadas antes de excluir o extrato.' : undefined} onClick={() => setTarget(item)}>Excluir extrato</button>}</td></tr>)}</tbody></table>}
    {target && <p className="real-alert" role="alert">Excluir o extrato {target.file_name}? As linhas saem da conciliação e podem ser importadas de novo.</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}
