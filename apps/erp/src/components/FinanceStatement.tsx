import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeLinkActor } from '../lib/document-finance-link';
import { useUnsavedChanges, useUnsavedForm } from '../hooks/useUnsavedChanges';
import { centsInput, financeDate, financeMoney, moneyInput, postingDate, todaySP, validFinanceDate, type FinanceAccess, type FinanceKind, financePermitted } from '../lib/real-finance-model';
import { financialAccount, type FinancialAccount } from '../lib/finance-registry-model';
import { OWNED_ORIGIN, ownedLine, STATEMENT_PAGE_SIZE, STATEMENT_TABS, categorizePlan, deletePlan, lineHistory, originBadge, restorePlan, signedMoney, statementApiPath, statementPage, statementParams, statementRoute, statementRows, statementSheet,
  type LineBatchItem, type StatementLine, type StatementPage, type StatementRoute } from '../lib/finance-statement-model';
import { useFinanceCommand, definitiveFailure, type FinanceCommand } from '../lib/finance-command';
import { batchSummaryText, summarizeBatch, type BatchPlan, type BatchResult } from '../lib/origin-batch';
import { rangeLabel, selectRange } from '../lib/origin-list';
import { CSV_TYPE, XLSX_TYPE, downloadFile, toCsv, toXlsx } from '../lib/spreadsheet-export';
import { quickContactAllowed, quickContactInitial, type QuickContactValues } from '../lib/document-editor-pickers';
import { CategoryTreeFilter, CategoryTreePicker, useCategoryTree } from './FinanceCategoryTreeSelect';
import { CatalogPicker } from './DocumentCatalogPicker';
import DocumentQuickContact from './DocumentQuickContact';
import NativeListLayout from './NativeListLayout';
import { AppliedChips, OriginPagination, OriginSelector, IndicatorLetter, PeriodPicker, RowMenu, ToolButton, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { Modal } from './Modal';
import FinanceStatementPrint from './FinanceStatementPrint';
import { Icon } from './Icon';
import './real-finance.css';
import './finance-title-drawer.css';
import './finance-registry.css';
import './finance-statement.css';
import FinanceAttachments from './FinanceAttachments';

const noSubscription = () => () => {}, noSnapshot = () => null;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const ALL = 'Todas contas';
const EDITABLE_ORIGINS = ['manual', 'ledger', 'reconciliation', 'import'];
const failureText = (failure: unknown) => failure instanceof AccessError ? failure.status === 409 ? 'O lançamento, a conta ou o saldo mudou desde que foi aberto. Atualize o extrato e confira antes de repetir.' : failure.status === 400 ? 'A operação não foi aceita. Confira a conta (ativa), a data (sem lançamentos antes do início da conta), o valor e a categoria.' : failure.status === 403 ? 'Seu acesso a esta operação foi alterado.' : failure.status === 404 ? 'O lançamento não foi encontrado. Atualize o extrato.' : 'Não foi possível concluir a consulta. Tente novamente.' : failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.';
function BusyGuard() { useUnsavedChanges(false, true); return null; }
function Field({ label, children, wide = false, hint }: { label: string; children: (id: string) => ReactNode; wide?: boolean; hint?: ReactNode }) { const id = useId(); return <div className={`form-field${wide ? ' finance-drawer-wide' : ''}`}><label htmlFor={id}>{label}</label>{children(id)}{hint}</div>; }
type Send = (command: FinanceCommand) => Promise<unknown>;
type Entry = { id: string; account_id: string; kind: 'in' | 'out'; amount_cents: string; posted_on: string; competence_on: string; category_id: string | null; category_name: string | null; contact_id: string | null; contact_name: string | null; note: string; origin: string; version: number; deleted: boolean };
type Trees = { receivable: ReturnType<typeof useCategoryTree>; payable: ReturnType<typeof useCategoryTree> };

/** Gaveta "Lançamento caixa": Categoria, Data*, Valor (R$)*, Tipo, Competência*, Conta financeira, Histórico*, Cliente ou fornecedor e Anexos. */
export function CashEntryDrawer({ controller, entry, accounts, defaultAccount, trees, contact, origin = 'manual', title = 'Lançamento caixa', send, mayWrite, onClose, onSaved }: { controller: AccessController; entry: Entry | null; accounts: readonly FinancialAccount[]; defaultAccount: string; trees: Trees;
  contact?: { id: string; name: string } | null; origin?: 'manual' | 'ledger'; title?: string; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (entry: Entry, created: boolean) => void }) {
  // Lançamentos created by the conciliação or by the importação are edited here too (SQL 136); a reconciled one keeps its value and date.
  const today = todaySP(), editable = !entry || (!entry.deleted && EDITABLE_ORIGINS.includes(entry.origin)), fixedContact = Boolean(contact);
  const [values, setValues] = useState(() => ({ kind: (entry?.kind ?? 'out') as 'in' | 'out', category: entry?.category_id ?? '', posted_on: entry?.posted_on ?? today, competence_on: entry?.competence_on ?? today, amount: entry ? centsInput(entry.amount_cents) : '',
    account: entry?.account_id ?? defaultAccount, note: entry?.note ?? '', contact: entry?.contact_id ? { id: entry.contact_id, name: entry.contact_name ?? 'Contato' } : contact ?? null }));
  const command = useFinanceCommand(send, mayWrite, failureText), [quick, setQuick] = useState<QuickContactValues | null>(null), [quickBusy, setQuickBusy] = useState(false), [status, setStatus] = useState('');
  const [catalogAccess, setCatalogAccess] = useState<{ write: string[] } | null>(null);
  const guard = useUnsavedForm(values, command.locked || quickBusy);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const categoryKind: FinanceKind = values.kind === 'in' ? 'receivable' : 'payable', categoryItems = trees[categoryKind].items;
  useEffect(() => { if (!editable || fixedContact) return; const request = new AbortController(); void controller.catalog('/v1/cadastros', { signal: request.signal }).then(value => { if (!request.signal.aborted) setCatalogAccess(value as { write: string[] }); }).catch(() => { /* Adicionar novo stays hidden. */ }); return () => request.abort(); }, [controller, editable]);
  const quickAllowed = editable && !fixedContact && quickContactAllowed(catalogAccess, controller.getSnapshot?.()?.membership?.role);
  const save = () => void command.run(() => {
    const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.');
    validFinanceDate(values.posted_on); validFinanceDate(values.competence_on); if (!values.account) throw new Error('Selecione a conta financeira.');
    const note = values.note.trim(); if (!note) throw new Error('Informe o histórico.'); if (note.length > 2000) throw new Error('O histórico tem no máximo 2.000 caracteres.');
    // The current category stays even while the tree is loading (or failed): only a category chosen now must be in the tree.
    const category = values.category && (categoryItems.some(item => item.id === values.category) || values.category === entry?.category_id) ? values.category : null;
    const data: Record<string, unknown> = { expected_version: entry?.version ?? 0, account_id: values.account, kind: values.kind, amount_cents: amount, posted_on: values.posted_on, competence_on: values.competence_on, category_id: category, contact_id: values.contact?.id ?? null, note, ...(origin === 'ledger' ? { origin } : {}) };
    if (entry) data.id = entry.id;
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/entry_save', data };
  }, value => onSaved((value as { record: Entry }).record, !entry));
  const busy = command.busy, locked = command.locked || !editable;
  return <div className="finance-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) guard.confirmLeave(onClose); }}>
    <section className="finance-drawer finance-cash-drawer" role="dialog" aria-modal="true" aria-label={title}>
      <header className="finance-drawer-head"><div className="finance-drawer-title"><h2>{title}</h2></div><button type="button" className="icon-button" aria-label="Fechar" disabled={busy} onClick={() => guard.confirmLeave(onClose)}><Icon name="xmark" size={16} /></button></header>
      {entry && !editable && <p className="real-notice">{Object.hasOwn(OWNED_ORIGIN, entry.origin) ? OWNED_ORIGIN[entry.origin] : entry.deleted ? 'Lançamento excluído: restaure-o na situação Excluídos para alterar.' : 'Ajuste de saldo: para corrigir, exclua este ajuste ou faça um novo.'}</p>}
      <form className="finance-drawer-form" onSubmit={event => { event.preventDefault(); save(); }} aria-busy={busy}><fieldset className="finance-drawer-fields" disabled={locked}><legend className="real-sr-only">{title}</legend>
        <Field label="Tipo">{id => <select id={id} value={values.kind} onChange={event => { const kind = event.target.value as 'in' | 'out'; setValues(previous => ({ ...previous, kind, category: '' })); }}><option value="out">Saída</option><option value="in">Entrada</option></select>}</Field>
        <Field label="Categoria">{id => <CategoryTreePicker id={id} items={categoryItems} value={values.category} currentName={entry?.category_name} disabled={locked} onChange={next => set('category', next)} error={trees[categoryKind].error} />}</Field>
        <Field label="Data *">{id => <input id={id} type="date" required value={values.posted_on} onChange={event => set('posted_on', event.target.value)} />}</Field>
        <Field label="Valor (R$) *">{id => <input id={id} inputMode="decimal" required maxLength={17} placeholder="0,00" value={values.amount} onChange={event => set('amount', event.target.value)} />}</Field>
        <Field label="Competência *">{id => <input id={id} type="date" required value={values.competence_on} onChange={event => set('competence_on', event.target.value)} />}</Field>
        <Field label={origin === 'ledger' ? values.kind === 'in' ? 'Destino deste recebimento' : 'Origem deste pagamento' : 'Conta financeira'}>{id => <select id={id} value={values.account} onChange={event => set('account', event.target.value)}><option value="">Selecione</option>{accounts.filter(item => item.active || item.id === values.account).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>
        <Field label="Histórico *" wide hint={<small className="finance-drawer-counter">{values.note.length} de 2.000 caracteres</small>}>{id => <textarea id={id} rows={3} required maxLength={2000} value={values.note} onChange={event => set('note', event.target.value)} />}</Field>
        <div className="form-field finance-drawer-wide"><label htmlFor="cash-entry-contact">Cliente ou fornecedor</label>{fixedContact ? <p id="cash-entry-contact"><strong>{contact!.name}</strong></p>
          : <CatalogPicker controller={controller} entity="contacts" label="Cliente ou fornecedor" selected={values.contact} disabled={locked} status={status} onSelect={record => set('contact', record ? { id: record.id, name: record.name } : null)} onCreate={quickAllowed ? query => { if (!quick) setQuick(quickContactInitial(values.kind === 'in' ? 'sales_orders' : 'purchase_orders', query)); } : undefined} />}
          {!fixedContact && <small className="real-help">Digite parte do nome e pressione ENTER.</small>}</div>
      </fieldset>
      {/* SQL 211: Anexos of the lançamento, outside the fields so a consulta still downloads; a new lançamento gets them once saved. */}
      <section className="finance-drawer-files" aria-label="Anexos"><h3>Anexos</h3>{entry ? <FinanceAttachments controller={controller} owner="lancamentos" ownerId={entry.id} writable={!entry.deleted && mayWrite()} canAct={() => !busy} />
        : <p className="real-help">Salve o lançamento para incluir anexos.</p>}</section>{command.error && <p className="real-alert" role="alert">{command.error}</p>}
      <div className="finance-drawer-actions"><button type="button" className="text-button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button>{editable && <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</div></form>
    </section>
    {quick && <DocumentQuickContact controller={controller} kind={values.kind === 'in' ? 'sales_orders' : 'purchase_orders'} initial={quick} onState={state => setQuickBusy(state.busy || state.uncertain)}
      onCreated={row => { setQuick(null); setQuickBusy(false); setStatus(`Contato ${row.name} cadastrado e selecionado.`); set('contact', { id: row.id, name: row.name }); }}
      onClose={wasUncertain => { setQuick(null); setQuickBusy(false); setStatus(wasUncertain ? 'O resultado do cadastro rápido não foi confirmado. Pesquise o contato antes de cadastrá-lo de novo.' : ''); }} />}
  </div>;
}

/** Modal "Transferência entre contas": origem e destino com o saldo, valor, data e float bancário. */
function TransferModal({ accounts, from, send, mayWrite, onClose, onSaved }: { accounts: readonly FinancialAccount[]; from: string; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ from, to: '', amount: '', posted_on: todaySP(), float: '0' }), command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  const active = accounts.filter(item => item.active), balanceOf = (id: string) => accounts.find(item => item.id === id)?.balance_cents;
  const save = () => void command.run(() => {
    if (!values.from || !values.to) throw new Error('Selecione a conta de origem e a de destino.'); if (values.from === values.to) throw new Error('A conta de destino deve ser diferente da origem.');
    const amount = moneyInput(values.amount); if (amount === '0') throw new Error('Informe um valor maior que zero.'); postingDate(values.posted_on);
    if (!/^\d{1,2}$/.test(values.float) || Number(values.float) > 30) throw new Error('Float bancário: de 0 a 30 dias.');
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/transfer_create', data: { from_account_id: values.from, to_account_id: values.to, amount_cents: amount, posted_on: values.posted_on, float_days: Number(values.float) } };
  }, value => onSaved(`Transferência registrada: ${(value as { record: { note: string } }).record.note}.`));
  const select = (key: 'from' | 'to', label: string) => <Field label={label} hint={values[key] && balanceOf(values[key]) !== undefined ? <small className="real-help">Saldo: {financeMoney(balanceOf(values[key])!)}</small> : undefined}>{id => <select id={id} value={values[key]} onChange={event => { const value = event.target.value; setValues(previous => ({ ...previous, [key]: value })); }}><option value="">Selecione uma opção</option>{active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</Field>;
  return <Modal title="Transferência entre contas" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Transferindo…' : command.uncertain ? 'Conferir resultado' : 'Transferir'}</button></>}>
    <p className="real-help">A transferência usa somente o saldo entre as contas financeiras cadastradas; nenhum banco é acionado.</p>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Transferência</legend>
      {select('from', 'Conta Origem *')}{select('to', 'Conta Destino *')}
      <Field label="Valor (R$) *">{id => <input id={id} inputMode="decimal" maxLength={17} value={values.amount} onChange={event => { const amount = event.target.value; setValues(previous => ({ ...previous, amount })); }} />}</Field>
      <Field label="Data da transferência *">{id => <input id={id} type="date" max={todaySP()} value={values.posted_on} onChange={event => { const posted_on = event.target.value; setValues(previous => ({ ...previous, posted_on })); }} />}</Field>
      <Field label="Float bancário (dias)" hint={<small className="real-help">Prazo entre a solicitação e o recebimento efetivo na instituição de destino.</small>}>{id => <input id={id} inputMode="numeric" maxLength={2} value={values.float} onChange={event => { const float = event.target.value; setValues(previous => ({ ...previous, float })); }} />}</Field>
    </fieldset>
    <p className="real-notice">As transferências de entrada e de saída são categorizadas automaticamente.</p>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

/** Modal "Ajuste de saldo": saldo desejado, diferença do saldo atual e data de ajuste. */
function AdjustModal({ account, send, mayWrite, onClose, onSaved }: { account: FinancialAccount; send: Send; mayWrite: () => boolean; onClose: () => void; onSaved: (text: string) => void }) {
  const [values, setValues] = useState({ desired: centsInput(account.balance_cents), posted_on: todaySP() }), command = useFinanceCommand(send, mayWrite, failureText), guard = useUnsavedForm(values, command.locked);
  let difference = ''; try { difference = (BigInt(moneyInput(values.desired, true)) - BigInt(account.balance_cents)).toString(); } catch { /* Shown after a valid value. */ }
  const save = () => void command.run(() => {
    const desired = moneyInput(values.desired, true); if (desired === account.balance_cents) throw new Error('O saldo desejado é igual ao saldo atual.'); postingDate(values.posted_on);
    return { id: crypto.randomUUID(), path: '/v1/financeiro/actions/balance_adjust', data: { account_id: account.id, desired_cents: desired, current_cents: account.balance_cents, posted_on: values.posted_on } };
  }, () => onSaved(`Saldo de ${account.name} ajustado.`));
  return <Modal title="Ajuste de saldo" onClose={() => { if (!command.busy) guard.confirmLeave(onClose); }} actions={<><button type="button" className="secondary-button" disabled={command.busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar Ajuste'}</button></>}>
    <fieldset className="finance-drawer-fields" disabled={command.locked}><legend className="real-sr-only">Ajuste de saldo de {account.name}</legend>
      <Field label="Saldo desejado (R$)">{id => <input id={id} inputMode="decimal" maxLength={18} value={values.desired} onChange={event => { const desired = event.target.value; setValues(previous => ({ ...previous, desired })); }} />}</Field>
      <Field label="Data de ajuste">{id => <input id={id} type="date" max={todaySP()} value={values.posted_on} onChange={event => { const posted_on = event.target.value; setValues(previous => ({ ...previous, posted_on })); }} />}</Field>
    </fieldset>
    <p>Diferença do saldo atual: <strong>{difference ? signedMoney(difference) : '—'}</strong></p>
    <p className="real-notice">O ajuste é feito por um lançamento na data de ajuste, com a diferença entre o saldo desejado e o saldo atual ({financeMoney(account.balance_cents)}).</p>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
  </Modal>;
}

/** Comprovante de um lançamento do extrato (impressão do navegador). */
function Receipt({ line, onClose }: { line: StatementLine; onClose: () => void }) {
  return <Modal title="Comprovante" onClose={onClose} actions={<><button type="button" className="secondary-button" onClick={onClose}>Fechar</button><button type="button" className="primary-button" onClick={() => globalThis.window?.print()}><Icon name="print" size={14} />Imprimir</button></>}>
    <div className="finance-receipt"><h3>{BigInt(line.amount_cents) < 0n ? 'Comprovante de pagamento' : 'Comprovante de recebimento'}</h3>
      <dl className="finance-review"><div><dt>Data</dt><dd>{financeDate(line.posted_on)}</dd></div><div><dt>Conta financeira</dt><dd>{line.account_name}</dd></div><div><dt>Histórico</dt><dd>{lineHistory(line)}</dd></div>
        <div><dt>Cliente/Fornecedor</dt><dd>{line.contact_name ?? '—'}</dd></div><div><dt>Categoria</dt><dd>{line.category_name ?? 'Sem categoria'}</dd></div><div><dt>Valor</dt><dd>{financeMoney(line.amount_cents.replace('-', ''))}</dd></div></dl></div>
  </Modal>;
}

type BatchKind = 'delete' | 'restore' | 'categorize';
type Panel = { kind: 'entry'; entry: Entry | null } | { kind: 'transfer' } | { kind: 'adjust'; account: FinancialAccount } | { kind: 'categorize' } | { kind: 'receipt'; line: StatementLine } | { kind: 'print' };

/**
 * Financeiro > Caixas e bancos do Origin (SQL 136): seletor Todas contas | conta, Pesquisa por nome ou histórico, período
 * (Este mês), abas Movimentações | Entradas | Saídas | Conciliação, Situação, Categoria e Valor, linhas com badges de
 * origem e "Saldo em dd/mm/aaaa", Informações, Incluir lançamento, Transferência, Alterar categorias, Ajustar saldos,
 * Excluir / Restaurar selecionadas, Exportar e Imprimir.
 */
export default function FinanceStatement({ controller }: { controller: AccessController }) {
  const location = useLocation(), navigate = useNavigate(), params = new URLSearchParams(location.search), today = todaySP();
  let parsed: { route: StatementRoute; error: string };
  try { parsed = { route: statementRoute(params, today), error: '' }; } catch (failure) { parsed = { route: statementRoute(new URLSearchParams(), today), error: (failure as Error).message }; }
  const route = parsed.route;
  const tracked = typeof controller.getSnapshot === 'function', session = useSyncExternalStore(controller.subscribe ?? noSubscription, controller.getSnapshot ?? noSnapshot);
  const actor = financeLinkActor(session), allowed = !tracked || actor !== null, scope = tracked ? `${actor ?? ''}:${session?.phase ?? ''}:${session?.membership?.role ?? ''}` : 'isolated';
  const routeKey = `${location.key}:${location.search}:${scope}`, current = useRef(routeKey); current.current = routeKey;
  const mayRead = () => allowed && current.current === routeKey && (!tracked || financeLinkActor(controller.getSnapshot()) === actor);
  const [permissions, setPermissions] = useState<{ scope: string; value: FinanceAccess } | null>(null), access = permissions?.scope === scope ? permissions.value : null;
  const mayWrite = () => mayRead() && Boolean(access?.write) && (!tracked || ['admin', 'financeiro'].includes(controller.getSnapshot()?.membership?.role ?? ''));
  const [reload, setReload] = useState(0), listKey = `${routeKey}:${reload}`;
  const [list, setList] = useState<{ key: string; page: StatementPage | null; error: string }>({ key: '', page: null, error: '' });
  const page = list.key === listKey ? list.page : null, loading = !parsed.error && (list.key !== listKey || (!list.page && !list.error));
  const [accounts, setAccounts] = useState<{ key: string; items: FinancialAccount[] }>({ key: '', items: [] });
  const finance = access ? (path: string, options?: { signal?: AbortSignal }) => controller.finance(path, options) : null;
  const trees: Trees = { receivable: useCategoryTree(finance, 'receivable', scope), payable: useCategoryTree(finance, 'payable', scope) };
  const [draft, setDraft] = useState({ q: route.q, situacao: route.situacao, conciliacao: route.conciliacao, categoria: route.categoria, valor: route.valor ? centsInput(route.valor) : '' });
  const [selection, setSelection] = useState<{ key: string; ids: string[]; anchor: string | null }>({ key: '', ids: [], anchor: null }), [menu, setMenu] = useState<string | null>(null);
  const [panel, setPanel] = useState<(Panel & { key: string }) | null>(null), [notice, setNotice] = useState(''), [error, setError] = useState(''), [infoOpen, setInfoOpen] = useState(true);
  const [batch, setBatch] = useState<{ key: string; kind: BatchKind; plan: BatchPlan<LineBatchItem>; category: string | null; recovery: boolean } | null>(null), [pending, setPending] = useState<{ owner: string; kind: BatchKind; items: LineBatchItem[]; category: string | null } | null>(null), [running, setRunning] = useState(false);
  const [categorizeTarget, setCategorizeTarget] = useState({ id: '', confirmed: false });
  const commands = useRef(new Map<string, FinanceCommand>()), uncertain = useRef(new Set<string>());
  const owner = tracked ? actor ?? '' : 'isolated';
  useEffect(() => { setDraft({ q: route.q, situacao: route.situacao, conciliacao: route.conciliacao, categoria: route.categoria, valor: route.valor ? centsInput(route.valor) : '' }); setMenu(null); setError(''); setPanel(null); setBatch(null); }, [location.search]);
  useEffect(() => {
    if (!allowed) return; const request = new AbortController();
    void controller.finance('/v1/financeiro', { signal: request.signal }).then(value => { const result = value as FinanceAccess; if (!request.signal.aborted && mayRead() && result.data_mode === 'erp_native' && result.read === true && typeof result.write === 'boolean') setPermissions({ scope, value: result }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setError(failureText(failure)); });
    return () => request.abort();
  }, [controller, scope]);
  useEffect(() => {
    if (!access || parsed.error || !mayRead()) return; const request = new AbortController();
    void controller.finance(statementApiPath(route), { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setList({ key: listKey, page: statementPage(value, route), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) setList({ key: listKey, page: null, error: failure instanceof AccessError ? failureText(failure) : 'Não foi possível conferir o extrato. Tente novamente.' }); });
    return () => request.abort();
  }, [controller, access, listKey]);
  useEffect(() => {
    // Contas financeiras for the selector, the drawers and the balances (Saldo: R$ in the transferência).
    if (!access) return; const request = new AbortController();
    void controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100', { signal: request.signal }).then(value => { if (!request.signal.aborted && mayRead()) setAccounts({ key: `${scope}:${reload}`, items: ((value as { items?: unknown[] })?.items ?? []).map(financialAccount) }); })
      .catch(() => { /* The selector keeps "Todas contas"; the drawers show the error when they need the accounts. */ });
    return () => request.abort();
  }, [controller, access, reload]);
  // Deep links of the Origin SlideIns: #add/lancamento, #add/transferencia, #add/ajuste-saldo, #edit/<id>.
  useEffect(() => {
    if (!access?.write || !mayRead()) return; const add = params.get('incluir'), edit = params.get('editar');
    if (add === 'lancamento') setPanel({ kind: 'entry', entry: null, key: routeKey }); else if (add === 'transferencia') setPanel({ kind: 'transfer', key: routeKey });
    else if (edit && /^[a-f0-9-]{36}$/.test(edit)) void openEntry(edit);
  }, [access, routeKey]);
  const go = (next: Partial<StatementRoute>) => { try { navigate(`${location.pathname}?${statementParams({ ...route, pagina: 1, ...next }, today)}`); } catch (failure) { setError((failure as Error).message); } };
  const apply = (event?: FormEvent) => { event?.preventDefault(); try { const valor = draft.valor.trim() ? moneyInput(draft.valor) : ''; if (valor === '0') throw new Error('Informe um valor maior que zero.'); go({ q: draft.q.trim(), situacao: draft.situacao, conciliacao: draft.situacao !== 'registrados' ? '' : draft.conciliacao, categoria: draft.categoria, valor }); } catch (failure) { setError((failure as Error).message); } };
  const clear = () => go({ q: '', situacao: 'registrados', conciliacao: '', categoria: [], valor: '', from: statementRoute(new URLSearchParams(), today).from, to: statementRoute(new URLSearchParams(), today).to });
  const send: Send = command => { if (!mayWrite()) return Promise.reject(new AccessError(403)); return controller.finance(command.path, { method: 'POST', body: { command_id: command.id, data: structuredClone(command.data) } } as never); };
  const saved = (text: string) => { if (!mayRead()) return; setPanel(null); setNotice(text); setReload(value => value + 1); };
  const open = (next: Panel) => { setMenu(null); if (!mayWrite() || running) return; setNotice(''); setPanel({ ...next, key: routeKey }); };
  async function openEntry(id: string) {
    if (!mayRead()) return; setMenu(null);
    try { const value = await controller.finance(`/v1/financeiro/lancamentos/${id}`) as { record?: Entry }; if (!mayRead()) return; if (value?.record?.id !== id) throw new Error('mismatch'); setPanel({ kind: 'entry', entry: value.record, key: routeKey }); }
    catch (failure) { if (mayRead()) setError(failure instanceof AccessError ? failureText(failure) : 'Não foi possível abrir o lançamento.'); }
  }
  const accountItems = accounts.items, accountName = route.conta ? accountItems.find(item => item.id === route.conta)?.name ?? 'Conta selecionada' : ALL;
  const selectedAccount = accountItems.find(item => item.id === route.conta) ?? null;
  // #add/ajuste-saldo needs the active conta of the topo, known once the contas are read.
  const adjustTarget = params.get('incluir') === 'ajuste-saldo' && selectedAccount?.active ? selectedAccount.id : '';
  useEffect(() => {
    if (!adjustTarget || !access?.write || !mayRead() || !selectedAccount) return; const account = selectedAccount;
    setPanel(previous => previous && previous.key === routeKey ? previous : { kind: 'adjust', account, key: routeKey });
  }, [access, routeKey, adjustTarget]);
  const defaultAccount = route.conta || (accountItems.find(item => item.default_movements && item.active)?.id ?? '');
  const rows = page?.items ?? [], selected = selection.key === listKey ? selection.ids : [], chosen = rows.filter(line => selected.includes(line.line_id));
  // Sistema › Usuários › Permissões › Finanças (SQL 246): the server refuses without the key; the screen does not offer it.
  const writable = Boolean(access?.write) && financePermitted(access, 'financas.caixas_bancos.ie'), pages = page ? Math.max(1, Math.ceil(page.total / STATEMENT_PAGE_SIZE)) : 1, deleted = route.situacao === 'excluidos', cancelled = route.situacao === 'cancelados';
  const toggle = (id: string, shift: boolean) => { const result = selectRange(rows.map(line => line.line_id), new Set(selected), selection.key === listKey ? selection.anchor : null, id, shift); setSelection({ key: listKey, ids: [...result.selected], anchor: result.anchor }); };
  const categoryNames = new Map([...trees.receivable.items, ...trees.payable.items].map(item => [item.id, item.name] as [string, string]));
  const startBatch = (kind: BatchKind, lines: StatementLine[], category: string | null = null) => {
    setMenu(null); if (!mayWrite() || pending || batch || !lines.length) return; commands.current = new Map(); uncertain.current = new Set();
    const target = category ? { id: category, kind: trees.receivable.items.some(item => item.id === category) ? 'receivable' as const : 'payable' as const } : { id: null, kind: null };
    setBatch({ key: routeKey, kind, category, recovery: false, plan: kind === 'delete' ? deletePlan(lines) : kind === 'restore' ? restorePlan(lines) : categorizePlan(lines, target) });
  };
  const runItem = (state: NonNullable<typeof batch>) => async (item: LineBatchItem) => {
    const replay = uncertain.current.has(item.id);
    if (!mayWrite()) { if (replay) return { uncertain: true, message: 'Seu acesso foi alterado. O lançamento não foi reenviado e o envio anterior continua sem confirmação.' }; throw new Error('Seu acesso a esta operação foi alterado.'); }
    let command = commands.current.get(item.id);
    if (!command) {
      const line = item.line;
      command = state.kind === 'categorize' ? { id: crypto.randomUUID(), path: '/v1/financeiro/actions/line_categorize', data: { line_kind: line.line_kind, line_id: line.line_kind === 'entry' ? line.entry_id : line.line_id, expected_category_id: line.category_id, category_id: state.category } }
        : line.line_kind === 'transfer' ? { id: crypto.randomUUID(), path: '/v1/financeiro/actions/transfer_delete', data: { transfer_id: line.transfer_id } }
        : { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${state.kind === 'delete' ? 'entry_delete' : 'entry_restore'}`, data: { id: line.entry_id, expected_version: line.entry_version } };
      commands.current.set(item.id, command);
    }
    setRunning(true);
    try { await send(command); uncertain.current.delete(item.id); commands.current.delete(item.id); }
    catch (failure) { if (definitiveFailure(failure) && !replay) { commands.current.delete(item.id); throw new Error(failureText(failure)); } uncertain.current.add(item.id); return { uncertain: true, message: 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma operação.' }; }
  };
  const finish = (state: NonNullable<typeof batch>, results: BatchResult[] | null) => {
    setBatch(null); setRunning(false); if (results === null) return;
    const left = state.plan.eligible.filter(item => uncertain.current.has(item.id));
    setPending(left.length ? { owner, kind: state.kind, items: left, category: state.category } : null); setSelection({ key: '', ids: [], anchor: null });
    setNotice(`${state.kind === 'delete' ? 'Excluir selecionadas' : state.kind === 'restore' ? 'Restaurar selecionadas' : 'Alterar categorias'}: ${batchSummaryText(summarizeBatch(results))}.`); setReload(value => value + 1);
  };
  const exportStatement = async (format: 'csv' | 'xlsx') => {
    if (!mayRead()) return; setError('');
    try {
      const lines: StatementLine[] = []; let pageNumber = 1, total = 0;
      do { const value = statementPage(await controller.finance(statementApiPath(route, 100, pageNumber)), route, pageNumber, 100); lines.push(...value.items); total = value.total; pageNumber++; } while (lines.length < total && lines.length < 5000);
      if (!mayRead()) return;
      const sheet = statementSheet(lines), name = `extrato-${route.from}-${route.to}`;
      if (format === 'xlsx') downloadFile(`${name}.xlsx`, toXlsx('Extrato', sheet) as unknown as BlobPart, XLSX_TYPE); else downloadFile(`${name}.csv`, toCsv(sheet), CSV_TYPE);
    } catch (failure) { if (mayRead()) setError(failure instanceof AccessError ? failureText(failure) : 'Não foi possível exportar o extrato.'); }
  };
  const lineMenu = (line: StatementLine): RowMenuItem[] => {
    const items: RowMenuItem[] = [{ label: 'Imprimir comprovante', icon: 'print', onClick: () => { setMenu(null); setPanel({ kind: 'receipt', line, key: routeKey }); } }];
    if (line.line_kind === 'settlement' && line.title_id) items.push({ label: 'Abrir conta', icon: 'arrow-up-right-from-square', to: `/financeiro-empresa?area=${line.title_kind}&titulo=${line.title_id}` });
    if (writable && financePermitted(access, 'financas.caixas_bancos.ex') && !deleted && (line.line_kind === 'entry' || line.line_kind === 'transfer') && !line.reconciled && !ownedLine(line)) items.push({ label: 'Excluir', icon: 'trash-can', separatorBefore: true, onClick: () => startBatch('delete', [line]) });
    if (writable && deleted && line.line_kind === 'entry' && !ownedLine(line)) items.push({ label: 'Restaurar', icon: 'rotate-left', onClick: () => startBatch('restore', [line]) });
    return items;
  };
  const chips = [...(route.q ? [{ label: `Pesquisa: ${route.q}`, onRemove: () => go({ q: '' }) }] : []), { label: `Situação: ${deleted ? 'Excluídos' : cancelled ? 'Cancelados' : 'Registrados'}`, onRemove: () => go({ situacao: 'registrados' }) },
    ...(route.categoria.length ? [{ label: `Categoria: ${route.categoria.map(value => value === 'none' ? 'Sem categoria' : categoryNames.get(value) ?? 'selecionada').join(', ')}`, onRemove: () => go({ categoria: [] }) }] : []),
    ...(route.conciliacao ? [{ label: `Situação da conciliação: ${route.conciliacao === 'conciliados' ? 'Conciliados' : 'Não Conciliados'}`, onRemove: () => go({ conciliacao: '' }) }] : []),
    ...(route.valor ? [{ label: `Valor: ${financeMoney(route.valor)}`, onRemove: () => go({ valor: '' }) }] : [])].filter(chip => chip.label !== 'Situação: Registrados');
  const panelVisible = panel && panel.key === routeKey ? panel : null, pendingVisible = pending && pending.owner === owner && allowed ? pending : null;
  const displayRows = page ? statementRows(page, route, pages) : [];
  // Origin: the Conciliação column appears only when the period has reconciled lines.
  const reconciliationColumn = Boolean(page && (page.summary.reconciled_lines ?? 0) > 0);
  if (!allowed) return <section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  return <>{(running || pendingVisible) && <BusyGuard />}
    <header className="real-heading"><div className="finance-heading-title"><h1>Caixas e bancos</h1>{access && <OriginSelector label="Conta financeira" value={accountName} options={[ALL, ...accountItems.filter(item => item.active || item.id === route.conta).map(item => item.name)]} onChange={label => { const target = label === ALL ? '' : accountItems.find(item => item.name === label)?.id; if (target !== undefined && target !== route.conta) go({ conta: target }); }} />}</div>{access && !access.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}</p>}
    {parsed.error ? <section className="real-state-panel"><p role="alert">{parsed.error}</p><button type="button" className="secondary-button" onClick={() => navigate(`${location.pathname}?area=accounts`)}>Limpar filtros da URL</button></section> :
    <form onSubmit={apply} aria-label="Filtros do extrato"><NativeListLayout filters={<>
      <fieldset className="finance-option-filter"><legend>Situação</legend>{([['registrados', 'Registrados'], ['excluidos', 'Excluídos'], ['cancelados', 'Cancelados']] as const).map(([value, label]) => <label key={value} htmlFor={`statement-situation-${value}`}><input id={`statement-situation-${value}`} type="radio" name="statement-situation" checked={draft.situacao === value} onChange={() => setDraft(previous => ({ ...previous, situacao: value }))} />{label}</label>)}
        <p className="real-help">Pendentes, Conciliados e Ocultos ficam na aba Conciliação. Cancelados mostra as baixas estornadas e os estornos, que continuam nos saldos de Registrados.</p></fieldset>
      {draft.situacao === 'registrados' && <fieldset className="finance-option-filter"><legend>Situação da conciliação</legend>{([['', 'Todas'], ['conciliados', 'Conciliados'], ['nao-conciliados', 'Não Conciliados']] as const).map(([value, label]) => <label key={label} htmlFor={`statement-reconciliation-${value || 'todas'}`}><input id={`statement-reconciliation-${value || 'todas'}`} type="radio" name="statement-reconciliation" checked={draft.conciliacao === value} onChange={() => setDraft(previous => ({ ...previous, conciliacao: value }))} />{label}</label>)}</fieldset>}
      <CategoryTreeFilter idPrefix="statement-category-in" legend="Categoria · Receitas" items={trees.receivable.items} value={draft.categoria} onChange={next => setDraft(previous => ({ ...previous, categoria: next }))} error={trees.receivable.error} onRetry={trees.receivable.retry} />
      <CategoryTreeFilter idPrefix="statement-category-out" legend="Categoria · Despesas" includeNone={false} items={trees.payable.items} value={draft.categoria} onChange={next => setDraft(previous => ({ ...previous, categoria: next }))} error={trees.payable.error} onRetry={trees.payable.retry} />
      <Link className="text-button" to="/financeiro-empresa?area=categories" title="Gerenciar categorias"><Icon name="gear" size={13} /> Gerenciar categorias</Link>
      <Field label="Valor">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={16} value={draft.valor} onChange={event => { const valor = event.target.value; setDraft(previous => ({ ...previous, valor })); }} />}</Field>
      <button type="submit" className="primary-button" disabled={loading || !access}>Filtrar</button><button type="button" className="text-button" onClick={clear}>Limpar filtros</button>
    </>} actions={<>
      {writable && <button type="button" className="primary-button" onClick={() => open({ kind: 'entry', entry: null })}><Icon name="plus" size={16} />Incluir lançamento</button>}
      {writable && financePermitted(access, 'financas.caixas_bancos.transferencia') && <button type="button" className="action-button" onClick={() => open({ kind: 'transfer' })}><Icon name="right-left" size={15} />Transferência entre contas</button>}
      {writable && <button type="button" className="action-button" disabled={!chosen.length || Boolean(pendingVisible) || deleted} title={chosen.length ? undefined : 'Selecione lançamentos no extrato.'} onClick={() => { setCategorizeTarget({ id: '', confirmed: false }); open({ kind: 'categorize' }); }}><Icon name="bookmark" size={15} />Alterar categorias</button>}
      {writable && <button type="button" className="action-button" disabled={!selectedAccount || !selectedAccount.active} title={selectedAccount ? undefined : 'Selecione uma conta no topo para ajustar o saldo.'} onClick={() => selectedAccount && open({ kind: 'adjust', account: selectedAccount })}><Icon name="scale-balanced" size={15} />Ajustar saldos</button>}
      <div className="native-list-summary"><h3>Informações</h3>
        <dl className="native-list-stat"><dt>Quantidade de registros</dt><dd>{page ? page.total.toLocaleString('pt-BR') : '—'}</dd></dl>
        <dl className="native-list-stat"><dt>{route.conta ? 'Saldo atual da conta' : 'Saldo atual de todas as contas'}</dt><dd>{page ? signedMoney(page.summary.current_cents) : '—'}</dd></dl>
        <button type="button" className="text-button" aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}><Icon name={infoOpen ? 'chevron-up' : 'chevron-down'} size={10} /> Período</button>
        {infoOpen && page && !deleted && !cancelled && <>{([['Saldo inicial', page.summary.previous_cents], ['Entradas', page.summary.in_cents], ['Saídas', page.summary.out_cents === '0' ? '0' : `-${page.summary.out_cents}`], ['Saldo final', page.summary.closing_cents]] as const).map(([label, cents]) => <dl key={label} className="native-list-stat"><dt>{label}</dt><dd>{signedMoney(cents)}</dd></dl>)}</>}
        <p className="real-help">Saldos dos lançamentos registrados no FAGOO; não consultam o banco.</p></div>
      <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to="/financeiro-empresa?area=contas-financeiras">Contas financeiras</Link><Link to="/financeiro-empresa?area=importacao&tipo=caixa">Importação de registros financeiros</Link></div>
    </>}>
      <nav className="finance-tabs" aria-label="Abas do extrato">{STATEMENT_TABS.map(tab => tab.id === 'conciliacao' ? <Link key={tab.id} to={`/financeiro-empresa?area=conciliacao${route.conta ? `&conta=${route.conta}` : ''}`}>{tab.label}</Link> : <button key={tab.id} type="button" aria-current={route.aba === tab.id ? 'page' : undefined} onClick={() => go({ aba: tab.id as StatementRoute['aba'] })}>{tab.label}</button>)}</nav>
      <div className="native-list-toolbar"><div className="form-field"><label htmlFor="statement-search">Pesquisar no extrato</label><input id="statement-search" type="search" maxLength={120} placeholder="Pesquisa por nome ou histórico" value={draft.q} onChange={event => { const q = event.target.value; setDraft(previous => ({ ...previous, q })); }} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !access}><Icon name="search" size={16} /></button>
        <PeriodPicker from={route.from} to={route.to} today={today} onApply={range => { if (range.from && range.to) go({ from: range.from, to: range.to }); }} />
        <div className="origin-toolbar-tools"><ToolButton icon="file-export" title="Exportar extrato" disabled={!page || loading} onClick={() => void exportStatement('xlsx')} /><ToolButton icon="print" title="Imprimir saldos" disabled={!page || loading} onClick={() => { setMenu(null); if (mayRead()) setPanel({ kind: 'print', key: routeKey }); }} />
          {writable && financePermitted(access, 'financas.caixas_bancos.ex') && (deleted ? <ToolButton icon="rotate-left" title="Restaurar selecionadas" disabled={!chosen.length || Boolean(pendingVisible) || Boolean(batch)} onClick={() => startBatch('restore', chosen)} /> : <ToolButton icon="trash-can" title="Excluir selecionadas" disabled={!chosen.length || Boolean(pendingVisible) || Boolean(batch)} onClick={() => startBatch('delete', chosen)} />)}
          <ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !access} onClick={() => setReload(value => value + 1)} /></div></div>
      <AppliedChips chips={chips} onClear={clear} />
      {pendingVisible && <p className="real-alert" role="alert">{pendingVisible.items.length === 1 ? '1 lançamento' : `${pendingVisible.items.length} lançamentos`} sem resultado confirmado. <button type="button" className="text-button" disabled={Boolean(batch)} onClick={() => { if (!mayWrite()) return; uncertain.current = new Set(pendingVisible.items.map(item => item.id)); setBatch({ key: routeKey, kind: pendingVisible.kind, category: pendingVisible.category, recovery: true, plan: { eligible: pendingVisible.items, skipped: [] } }); setPending(null); }}>Conferir resultado</button></p>}
      <div className="real-result-status" role="status">{loading ? 'Carregando extrato…' : page ? rangeLabel(route.pagina, STATEMENT_PAGE_SIZE, page.total) : list.error || 'Extrato indisponível.'}</div>
      {list.key === listKey && list.error && <p className="real-alert" role="alert">{list.error} <button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></p>}
      {page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Extrato"><table className="data-table finance-table finance-statement-table"><thead><tr>{writable && <th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todos" checked={rows.length > 0 && chosen.length === rows.length} onChange={() => setSelection({ key: listKey, ids: chosen.length === rows.length ? [] : rows.map(line => line.line_id), anchor: null })} /></th>}
        <th aria-sort={route.ordem === 'asc' ? 'ascending' : 'descending'}><button type="button" className="finance-sort" title="Ordenar por data" onClick={() => go({ ordem: route.ordem === 'asc' ? 'desc' : 'asc' })}>Data<Icon name={route.ordem === 'asc' ? 'arrow-up' : 'arrow-down'} size={9} /></button></th><th>Categoria</th><th>Histórico</th><th>Cliente/Fornecedor</th>{reconciliationColumn && <th>Conciliação</th>}<th className="numeric">Valor</th><th><span className="real-sr-only">Origem</span></th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead>
        <tbody>{displayRows.map(row => row.type === 'balance' ? <tr key={row.key} className="finance-statement-balance"><td colSpan={(writable ? 8 : 7) + (reconciliationColumn ? 1 : 0)}>{row.label}: <strong>{signedMoney(row.cents)}</strong></td></tr> : (() => {
          const line = row.line, badge = originBadge(line), items = lineMenu(line), negative = line.amount_cents.startsWith('-');
          return <tr key={line.line_id} className={`finance-row${selected.includes(line.line_id) ? ' selected' : ''}`} onClick={event => { if (line.line_kind === 'entry' && line.entry_id && !(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, label')) void openEntry(line.entry_id); }}>
            {writable && <td className="checkbox-cell" onClick={event => event.stopPropagation()}><input type="checkbox" aria-label={`Selecionar ${lineHistory(line)}`} checked={selected.includes(line.line_id)} onClick={event => toggle(line.line_id, event.shiftKey)} onChange={() => undefined} /></td>}
            <td>{financeDate(line.posted_on)}</td><td>{line.category_name ?? (line.line_kind === 'opening' ? '—' : 'Sem categoria')}</td>
            <td>{line.line_kind === 'entry' && line.entry_id ? <button type="button" className="text-button finance-open" onClick={() => void openEntry(line.entry_id!)}>{lineHistory(line)}</button> : lineHistory(line)}{!route.conta && <small className="real-help"> · {line.account_name}</small>}</td>
            <td>{line.contact_name ?? '—'}</td>{reconciliationColumn && <td>{line.reconciled ? <span className="finance-reconciled" title="Conciliado"><Icon name="circle-check" size={13} />Conciliado</span> : ''}</td>}<td className={`numeric ${negative ? 'finance-negative' : 'finance-positive'}`}>{signedMoney(line.amount_cents)}</td>
            <td>{badge && <IndicatorLetter text={badge.text} color={badge.color} title={badge.title} />}</td>
            <td className="row-actions" onClick={event => event.stopPropagation()}><RowMenu label={lineHistory(line)} items={items} open={menu === line.line_id} onToggle={() => setMenu(menu === line.line_id ? null : line.line_id)} /></td></tr>; })())}</tbody></table></div>
        {!rows.length && <div className="empty-state"><h2>Nenhum lançamento no período</h2><p>{writable && !deleted ? 'Inclua um lançamento ou ajuste o período e os filtros.' : 'Ajuste o período e os filtros.'}</p></div>}
        <footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.pagina, pages)} pages={pages} size={STATEMENT_PAGE_SIZE} total={page.total} onPage={target => { if (!loading && target !== route.pagina) go({ pagina: target }); }} /></footer></>}
    </NativeListLayout></form>}
    {panelVisible?.kind === 'entry' && <CashEntryDrawer controller={controller} entry={panelVisible.entry} accounts={accountItems} defaultAccount={defaultAccount} trees={trees} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={(entry, created) => saved(created ? `Lançamento incluído: ${entry.note}.` : `Lançamento atualizado: ${entry.note}.`)} />}
    {panelVisible?.kind === 'transfer' && <TransferModal accounts={accountItems} from={route.conta} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'adjust' && <AdjustModal account={panelVisible.account} send={send} mayWrite={mayWrite} onClose={() => setPanel(null)} onSaved={saved} />}
    {panelVisible?.kind === 'receipt' && <Receipt line={panelVisible.line} onClose={() => setPanel(null)} />}
    {panelVisible?.kind === 'print' && <FinanceStatementPrint controller={controller} route={route} accountName={accountName} onClose={() => setPanel(null)} />}
    {panelVisible?.kind === 'categorize' && <Modal title="Alterar categoria financeira" onClose={() => setPanel(null)} actions={<><button type="button" className="secondary-button" onClick={() => setPanel(null)}>Cancelar</button><button type="button" className="primary-button" disabled={!categorizeTarget.confirmed} onClick={() => { setPanel(null); startBatch('categorize', chosen, categorizeTarget.id || null); }}>Alterar categorias</button></>}>
      <p className="real-notice">Nem todos os lançamentos poderão ser atualizados: o saldo inicial não tem categoria e a baixa só aceita categoria do tipo da conta.</p>
      <Field label="Categoria financeira">{id => <CategoryTreePicker id={id} items={[...trees.receivable.items, ...trees.payable.items]} value={categorizeTarget.id} onChange={next => setCategorizeTarget(previous => ({ ...previous, id: next }))} />}</Field>
      <label className="finance-drawer-switch" htmlFor="statement-categorize-confirm"><input id="statement-categorize-confirm" type="checkbox" checked={categorizeTarget.confirmed} onChange={event => { const confirmed = event.target.checked; setCategorizeTarget(previous => ({ ...previous, confirmed })); }} />Confirmo que desejo alterar a categoria dos itens selecionados</label>
      <ul className="real-help"><li>A categoria atual será substituída.</li><li>A alteração vale para todos os lançamentos selecionados.</li><li>A mudança aparece nos relatórios financeiros.</li></ul>
    </Modal>}
    {batch && batch.key === routeKey && <BatchDialog title={batch.recovery ? 'Conferir resultado' : batch.kind === 'delete' ? 'Excluir selecionadas' : batch.kind === 'restore' ? 'Restaurar selecionadas' : 'Alterar categorias'}
      description={<p>{batch.recovery ? 'Cada lançamento é enviado de novo com o mesmo comando.' : batch.kind === 'delete' ? 'Os lançamentos excluídos saem do saldo e ficam na situação Excluídos; a transferência é desfeita nas duas contas.' : batch.kind === 'restore' ? 'Os lançamentos voltam ao saldo na data original.' : `Nova categoria: ${batch.category ? categoryNames.get(batch.category) ?? 'selecionada' : 'Sem categoria'}.`}</p>}
      plan={batch.plan} confirmLabel={batch.recovery ? 'Conferir resultado' : batch.kind === 'delete' ? 'Excluir' : batch.kind === 'restore' ? 'Restaurar' : 'Alterar categorias'} canConfirm={writable} run={runItem(batch)} onClose={results => finish(batch, results)} />}
  </>;
}
