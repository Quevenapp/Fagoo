import { billingAddressText, contactBilling, contactBillingPath } from '../lib/contact-billing-model';
import { Link } from 'react-router-dom';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeDate, financeMoney, moneyInput, todaySP, type FinanceKind, type FinanceTitle } from '../lib/real-finance-model';
import { BANK_NUMBER_LIMIT, DESCRIPTION_LIMIT, DRAWER_TABS, descriptionLimit, settlementDue, titleHistory, DrawerError, END_ON_INFO, OCCURRENCES, PERCENT_INFO, RECURRENCE_UNAVAILABLE, WEEKDAYS, createsRecurrence, percentText, drawerCreateData, drawerEditData, drawerInitial, drawerLocks, drawerPlan, isRecurring, loadReferenceOptions, nextWeekday, recurrenceChanges, recurrenceCreateData, titleCharges, titleDetail, weekdayOf, type DrawerTab, type DrawerValues, type ReferenceOption, type TitleDetail } from '../lib/finance-title-drawer';
import { recurrencePath, recurrenceRead } from '../lib/finance-recurrence-model';
import { originNumber, originPath, originText, savedTitleId, titleSituation } from '../lib/finance-title-list';
import { quickContactAllowed, quickContactInitial, type QuickContactValues } from '../lib/document-editor-pickers';
import { badgeClass } from '../lib/origin-list';
import { categoryTree, type CategoryNode } from '../lib/finance-registry-model';
import { CategoryTreePicker } from './FinanceCategoryTreeSelect';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { FinanceSellerSelect } from './FinanceSellerSelect';
import { CatalogPicker } from './DocumentCatalogPicker';
import DocumentQuickContact from './DocumentQuickContact';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './finance-title-drawer.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
import FinanceAttachments from './FinanceAttachments';
// SQL 175: the formas de pagamento of the kind (Cadastros > Formas de pagamento); choosing one brings its juros, multa and conta.
// SQL 210: the Prazo de recebimento (dias, úteis) of the forma sets the vencimento of a new conta, as in Origin.
type PaymentMethodOption = { id: string; description: string; account_id: string | null; interest_rate: string | null; fine_rate: string | null; settlement_days?: number | null; business_days?: boolean };
/** "1.2350" (% of the cadastro, 4 casas) → "1,24" (centésimos de %, half up), without floating point. */
const rateText = (rate: string | null) => { if (rate === null || !/^\d{1,3}(?:\.\d{1,4})?$/.test(rate)) return null; const [whole, fraction = ''] = rate.split('.'), digits = fraction.padEnd(4, '0'); return percentText(Number(whole) * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0)); };
const SELLER_INFO = 'Vendedor da conta (Cadastros > Vendedores). Nas contas lançadas por um pedido, vale o vendedor do pedido enquanto a conta não tiver um próprio.';
const SELLER_RECURRING = 'Contas recorrentes e parceladas não guardam o vendedor; escolha-o em cada conta gerada.';
function failureText(error: unknown) {
  if (error instanceof AccessError) return error.status === 409 ? 'A conta mudou ou esta operação já foi usada com outros valores. Feche a gaveta e abra a conta novamente antes de salvar.'
    : error.status === 400 ? 'A conta não foi aceita. Confira os valores, as datas e os cadastros selecionados.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.'
    : error.status === 404 ? 'A conta não foi encontrada. Atualize a listagem.' : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.';
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}
/** A recurrence_update (step 2 of "Alterar contas em aberto") reads the recurrence version once, then keeps the same body for "Conferir resultado". */
type Command = { id: string; path: string; action: 'title_create' | 'title_edit' | 'recurrence_create' | 'recurrence_update'; body: { data: Record<string, unknown> }; settleAfter: boolean; uncertain: boolean; next?: Command; recurrence?: string };
type Propagation = { data: Record<string, unknown>; changes: Record<string, unknown>; settleAfter: boolean; alter: boolean; scope: 'following' | 'all'; future: boolean };
function propagationFailure(error: unknown) {
  const reason = error instanceof AccessError ? error.status === 409 ? 'a recorrência mudou enquanto a conta era salva' : error.status === 403 ? 'seu acesso a esta operação foi alterado' : error.status === 404 ? 'a recorrência não foi encontrada' : 'a alteração não foi aceita' : 'a alteração não foi aceita';
  return `A conta foi salva, mas as outras contas da recorrência não foram alteradas: ${reason}. Feche a gaveta e confira as contas em aberto.`;
}
type Options = { key: string; items: ReferenceOption[]; error: string };
type Controller = Pick<AccessController, 'finance' | 'catalog'> & Partial<Pick<AccessController, 'getSnapshot' | 'stockPositions' | 'attachments'>>;

function DrawerInfo({ text }: { text: string }) { return <span className="finance-drawer-info" title={text} aria-label={text} role="img"><Icon name="circle-info" size={11} /></span>; }
function DrawerField({ label, info, wide, children }: { label: string; info?: string; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className={`form-field${wide ? ' finance-drawer-wide' : ''}`}><label htmlFor={id}>{label}{info && <DrawerInfo text={info} />}</label>{children(id)}</div>;
}

const PROPAGATED_LABEL: Readonly<Record<string, string>> = { description: 'histórico', amount_cents: 'valor', category_id: 'categoria', account_id: 'conta financeira', interest_month_bp: 'juros mensal', penalty_bp: 'multa' };
const loadOptions = (controller: Controller, entity: 'accounts' | 'categories', signal: AbortSignal) => loadReferenceOptions((path, options) => controller.finance(path, options), entity, signal);

/**
 * Gaveta “Conta a receber” / “Conta a pagar” do Origin, aberta sobre a listagem: abas Cabeçalho, Pagamento,
 * Ocorrência e Anexos, Resumo sempre visível e rodapé Cancelar · Salvar e dar baixa · Salvar. Grava pelos comandos
 * title_create / title_edit da 108, com command_id próprio e “Conferir resultado” quando o retorno é incerto.
 */
function BillingAddressLine({ controller, contactId }: { controller: Controller; contactId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const request = new AbortController(); setText(null);
    if (typeof controller.catalog !== 'function') return () => request.abort();
    void controller.catalog(contactBillingPath(contactId), { signal: request.signal }).then(value => { if (!request.signal.aborted) { const item = contactBilling(value, contactId); setText(billingAddressText(item.address)); } })
      .catch(() => { if (!request.signal.aborted) setText(null); });
    return () => request.abort();
  }, [controller, contactId]);
  return text ? <p className="finance-origin-line">Endereço de cobrança: {text}</p> : null;
}

export default function FinanceTitleDrawer({ controller, kind, mode, title, clone, history, onClose, onSaved }: {
  controller: Controller; kind: FinanceKind; mode: 'create' | 'edit' | 'view'; title: FinanceTitle | null; clone?: FinanceTitle | null;
  history?: ReactNode; onClose: () => void; onSaved: (next?: { settleId: string | null }) => void;
}) {
  const today = todaySP(), receivable = kind === 'receivable';
  const [values, setValues] = useState<DrawerValues>(() => drawerInitial(today, title, clone));
  const [tab, setTab] = useState<DrawerTab>('cabecalho');
  const [detail, setDetail] = useState<{ key: string; value: TitleDetail | null; error: string }>({ key: '', value: null, error: '' }), [detailRetry, setDetailRetry] = useState(0);
  const [accounts, setAccounts] = useState<Options>({ key: '', items: [], error: '' }), [categories, setCategories] = useState<{ key: string; items: CategoryNode[]; error: string }>({ key: '', items: [], error: '' }), [optionsRetry, setOptionsRetry] = useState(0);
  const [catalogAccess, setCatalogAccess] = useState<{ write: string[] } | null>(null), [methods, setMethods] = useState<{ key: string; items: PaymentMethodOption[] }>({ key: '', items: [] });
  const [quickContact, setQuickContact] = useState<QuickContactValues | null>(null), [quickBusy, setQuickBusy] = useState(false), [contactStatus, setContactStatus] = useState('');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [originalOpen, setOriginalOpen] = useState(false), [dueHint, setDueHint] = useState('');
  // "Conta recorrente ao salvar" (Origin) and, after the conta was saved, the state of the step that changes the other contas.
  const [propagation, setPropagation] = useState<Propagation | null>(null), [saved, setSaved] = useState(false);
  const command = useRef<Command | null>(null), pending = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null), panel = useRef<HTMLElement>(null);
  // The baseline follows the whole Histórico read with the conta (SQL 210), so filling it in is not an unsaved change.
  const [baseline, setBaseline] = useState(() => JSON.stringify(values));
  const guard = useUnsavedChanges(JSON.stringify(values) !== baseline, busy || uncertain || quickBusy);
  const detailKey = title ? `${title.id}:${title.version}:${detailRetry}` : '';
  const loaded = title ? detail.key === detailKey ? detail.value : null : null;
  const detailError = title && detail.key === detailKey ? detail.error : '';
  const readOnly = mode === 'view' || Boolean(title && (title.cancelled || title.deleted_at));
  const locks = drawerLocks(title, loaded);
  const waiting = Boolean(title && !loaded);
  useEffect(() => { heading.current?.focus?.(); return () => pending.current?.abort(); }, []);
  useEffect(() => {
    if (!title || !loaded?.history) return;
    setValues(previous => {
      if (previous.description !== title.description) return previous;
      const next = { ...previous, description: loaded.history! };
      setBaseline(current => current === JSON.stringify(previous) ? JSON.stringify(next) : current);
      return next;
    });
  }, [loaded]);
  // Clonar copies the whole Histórico (SQL 210): the list row carries only its first 240 characters, so a long one is read here and
  // replaces the prefill while the user has not changed it. The baseline follows, so it is not an unsaved change.
  useEffect(() => {
    if (!clone?.long_history || title) return; const request = new AbortController(), source = clone;
    void controller.finance(`/v1/financeiro/titles/${source.id}/detalhe`, { signal: request.signal }).then(value => {
      if (request.signal.aborted) return; const history = titleDetail(value, source.id, kind).history;
      if (!history) return;
      setValues(previous => { if (previous.description !== source.description) return previous; const next = { ...previous, description: history }; setBaseline(current => current === JSON.stringify(previous) ? JSON.stringify(next) : current); return next; });
    }).catch(() => { /* The clone keeps the first 240 characters; nothing is saved until the user confirms. */ });
    return () => request.abort();
  }, [controller, clone?.id]);
  useEffect(() => {
    if (!title) return; const request = new AbortController(); setDetail({ key: detailKey, value: null, error: '' });
    void controller.finance(`/v1/financeiro/titles/${title.id}/detalhe`, { signal: request.signal })
      .then(value => { if (!request.signal.aborted) setDetail({ key: detailKey, value: titleDetail(value, title.id, kind), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setDetail({ key: detailKey, value: null, error: 'Não foi possível conferir a conta financeira, o boleto e a origem desta conta.' }); });
    return () => request.abort();
  }, [controller, detailKey]);
  // Options are only needed to edit; a consulta shows the names read with the conta.
  useEffect(() => {
    if (readOnly) return;
    const request = new AbortController(), key = `${kind}:${optionsRetry}`;
    void loadOptions(controller, 'accounts', request.signal).then(items => { if (!request.signal.aborted) setAccounts({ key, items, error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setAccounts({ key, items: [], error: 'Não foi possível carregar as contas financeiras.' }); });
    // Categoria: the tree of the tab (SQL 135), as the Origin árvore com busca.
    void controller.finance(`/v1/financeiro/formas-pagamento?kind=${kind}`, { signal: request.signal }).then(value => { const items = (value as { items?: unknown })?.items; if (!request.signal.aborted && Array.isArray(items)) setMethods({ key, items: items as PaymentMethodOption[] }); }).catch(() => { /* The forma stays as read with the conta. */ });
    void controller.finance(`/v1/financeiro/categorias-arvore?kind=${kind}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setCategories({ key, items: categoryTree(value, kind).items, error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setCategories({ key, items: [], error: 'Não foi possível carregar as categorias.' }); });
    return () => request.abort();
  }, [controller, kind, optionsRetry, readOnly]);
  useEffect(() => {
    if (readOnly) return; const request = new AbortController();
    void controller.catalog('/v1/cadastros', { signal: request.signal }).then(value => { if (!request.signal.aborted) setCatalogAccess(value as { write: string[] }); }).catch(() => { /* Quick contact stays hidden; reads are enforced separately. */ });
    return () => request.abort();
  }, [controller, readOnly]);
  // Esc closes with the unsaved-changes guard; Tab stays inside the drawer.
  useEffect(() => {
    const target = globalThis.document;
    if (!target?.addEventListener) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !quickContact && !originalOpen && !propagation) { event.preventDefault(); requestClose(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const fields = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')];
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && target.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && target.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    target.addEventListener('keydown', keydown);
    return () => target.removeEventListener('keydown', keydown);
  });
  const set = <K extends keyof DrawerValues>(key: K, value: DrawerValues[K]) => setValues(previous => ({ ...previous, [key]: value }));
  // Once the conta is saved (step 2 of "Alterar contas em aberto" pending or refused), closing refreshes the list.
  const requestClose = () => { if (busy) return; if (saved) { onSaved(); return; } guard.confirmLeave(onClose); };
  const writer = () => { const snapshot = controller.getSnapshot?.(); return !snapshot || (snapshot.phase === 'ready' && ['admin', 'financeiro'].includes(snapshot.membership?.role ?? '')); };
  const send = async (operation: Command): Promise<void> => {
    if (pending.current) return;
    const step = operation.action === 'recurrence_update';
    if (!writer()) { setError(step ? propagationFailure(new AccessError(403)) : 'Seu acesso a esta operação foi alterado. A conta não foi enviada.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError('');
    let result: unknown, done = false;
    try {
      if (operation.recurrence && operation.body.data.expected_version === undefined) {
        const read = recurrenceRead(await controller.finance(`/v1/financeiro/recorrentes/${operation.recurrence}`, { signal: request.signal }), operation.recurrence);
        if (request.signal.aborted) return;
        operation.body = { data: { ...operation.body.data, expected_version: read.version } };
      }
      result = await controller.finance(operation.path, { method: 'POST', body: { ...operation.body, command_id: operation.id }, signal: request.signal });
      if (request.signal.aborted) return;
      done = true;
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !operation.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known) command.current = null; else operation.uncertain = true;
      setUncertain(!known);
      setError(step ? known ? propagationFailure(failure) : 'A conta foi salva. Não foi possível confirmar a alteração das outras contas da recorrência: use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.'
        : known ? failureText(failure) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação. Os dados ficam preservados até a confirmação.');
    } finally { if (pending.current === request) pending.current = null; if (!request.signal.aborted) setBusy(false); }
    if (!done) return;
    command.current = null; setUncertain(false);
    // Step 2 of "Alterar contas em aberto": the conta is already saved; the other contas follow with their own command.
    if (operation.next) { setSaved(true); command.current = operation.next; await send(operation.next); return; }
    onSaved(operation.settleAfter ? { settleId: step ? title?.id ?? null : operation.action === 'recurrence_create' ? null : savedTitleId(result, operation.action, kind, title?.id) } : undefined);
  };
  const settleAllowed = mode === 'create' ? values.occurrence === 'unica' : Boolean(title && !title.cancelled && BigInt(title.balance_cents) > 0n);
  const save = async (settleAfter: boolean) => {
    if (busy || readOnly || waiting || propagation || (settleAfter && !settleAllowed) || (saved && !command.current)) return;
    if (command.current?.uncertain) { await send(command.current); return; }
    setError('');
    try {
      if (mode === 'create') {
        const recurring = createsRecurrence(values.occurrence);
        command.current = recurring ? { id: crypto.randomUUID(), path: '/v1/financeiro/actions/recurrence_create', action: 'recurrence_create', body: { data: recurrenceCreateData(kind, values) }, settleAfter: false, uncertain: false }
          : { id: crypto.randomUUID(), path: '/v1/financeiro/actions/title_create', action: 'title_create', body: { data: drawerCreateData(kind, values) }, settleAfter, uncertain: false };
      } else if (title) {
        const data = drawerEditData(title, values, locks, titleHistory(title, loaded));
        if (!data) { if (settleAfter) onSaved({ settleId: title.id }); else onClose(); return; }
        // Origin "Esta é uma conta recorrente": what changed can also go to the contas em aberto and to the next ones.
        const changes = title.recurrence_id ? recurrenceChanges(data) : null;
        if (changes) { setPropagation({ data, changes, settleAfter, alter: false, scope: 'following', future: false }); return; }
        command.current = { id: crypto.randomUUID(), path: '/v1/financeiro/actions/title_edit', action: 'title_edit', body: { data }, settleAfter, uncertain: false };
      } else return;
    } catch (failure) { if (failure instanceof DrawerError) setTab(failure.tab); setError(failureText(failure)); return; }
    await send(command.current);
  };
  const confirmPropagation = async () => {
    if (!propagation || !title?.recurrence_id || busy) return;
    const { data, changes, settleAfter, alter, scope, future } = propagation;
    const next: Command | undefined = alter || future ? { id: crypto.randomUUID(), path: '/v1/financeiro/actions/recurrence_update', action: 'recurrence_update', recurrence: title.recurrence_id,
      body: { data: { id: title.recurrence_id, from_title_id: title.id, scope: alter ? scope : 'none', future, changes } }, settleAfter, uncertain: false } : undefined;
    setPropagation(null);
    command.current = { id: crypto.randomUUID(), path: '/v1/financeiro/actions/title_edit', action: 'title_edit', body: { data }, settleAfter, uncertain: false, next };
    await send(command.current);
  };
  const recurring = mode === 'create' && isRecurring(values.occurrence);
  // The Dia de vencimento (and the Dia da semana of Semanal) follow the vencimento typed; the user can still change the day.
  const changeDue = (next: string) => setValues(previous => /^\d{4}-\d{2}-\d{2}$/.test(next) && mode === 'create' ? { ...previous, due_on: next, due_day: String(Number(next.slice(8, 10))), weekday: String(weekdayOf(next)) } : { ...previous, due_on: next });
  const changeOccurrence = (next: DrawerValues['occurrence']) => setValues(previous => ({ ...previous, occurrence: next, ...(next === 'semanal' ? { weekday: String(weekdayOf(previous.due_on)) } : {}) }));
  // Dia da semana: the vencimento moves to the next day with that weekday, so both always agree.
  const chooseWeekday = (weekday: number) => setValues(previous => { const due = /^\d{4}-\d{2}-\d{2}$/.test(previous.due_on) ? nextWeekday(previous.due_on, weekday) : previous.due_on; return { ...previous, weekday: String(weekday), due_on: due }; });
  const closeSaved = () => { if (!busy) onSaved(); };
  let plan: { amount_cents: string; due_on: string }[] | null = null, planError = '';
  if (mode === 'create' && values.occurrence === 'parcelada') { try { plan = drawerPlan(values); } catch (failure) { planError = (failure as Error).message; } }
  let typed = '';
  try { typed = values.amount.trim() ? moneyInput(values.amount) : ''; } catch { typed = ''; }
  const charges = title && !title.cancelled ? titleCharges(title.balance_cents, title.due_on, title.interest_month_bp ?? 0, title.penalty_bp ?? 0, today) : null;
  const situation = title ? titleSituation(title, today) : null;
  const origin = loaded?.origin ?? title?.origin ?? null;
  const accountChoices = accounts.items.filter(item => item.active || item.id === values.account_id);
  const optionsError = accounts.error || categories.error;
  const quickAllowed = !readOnly && !locks.contact && quickContactAllowed(catalogAccess, controller.getSnapshot?.()?.membership?.role);
  const contactLabel = receivable ? 'Cliente *' : 'Fornecedor *';
  const disabled = readOnly || busy || uncertain;
  // SQL 210: a recurrence keeps 240 characters and no Vendedor; a conta keeps the whole Histórico (2.000).
  const recurringCreate = mode === 'create' && createsRecurrence(values.occurrence), historyLimit = mode === 'create' ? descriptionLimit(values.occurrence) : DESCRIPTION_LIMIT;
  return <div className="finance-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <section ref={panel} className="finance-drawer" role="dialog" aria-modal="true" aria-label={receivable ? 'Conta a receber' : 'Conta a pagar'}>
      <header className="finance-drawer-head">
        <div className="finance-drawer-title"><h2 ref={heading} tabIndex={-1}>{receivable ? 'Conta a receber' : 'Conta a pagar'}</h2>{situation && <span className={badgeClass(situation.label)} title={situation.hint}>{situation.label}</span>}</div>
        <button type="button" className="icon-button" aria-label="Fechar" title="Fechar" disabled={busy} onClick={requestClose}><Icon name="close" /></button>
      </header>
      {title && <p className="finance-drawer-sub">{title.contact_name} · Parcela {title.installment}/{title.installments}</p>}
      {waiting && !detailError && <p className="real-help" role="status">Conferindo a conta financeira, o boleto e a origem desta conta…</p>}
      {detailError && <p className="real-alert" role="alert">{detailError} <button type="button" className="text-button" onClick={() => setDetailRetry(value => value + 1)}>Conferir novamente</button></p>}
      {title?.deleted_at ? <p className="real-notice">Esta conta foi excluída e fica disponível somente para consulta.</p> : title?.cancelled ? <p className="real-notice">Esta conta está cancelada e fica disponível somente para consulta.</p> : null}
      {loaded?.imported && <p className="real-notice"><strong>Importado do Origin.</strong> O valor original, o contato, a emissão e a referência da origem são preservados.</p>}
      {title?.document_linked && <p className="real-help">Esta conta foi gerada por um documento da empresa. O contato, a emissão, o valor e o nº documento ficam com o documento.</p>}
      {title?.grouped_billing_id && <p className="real-help">Esta conta foi gerada por um faturamento agrupado. O cliente, a emissão e o valor ficam com o faturamento; para desfazer, exclua o faturamento em Listar Faturamentos Gerados.</p>}
      {loaded?.billing?.file_generated && <p className="real-alert" role="note">Esta conta está na remessa nº {loaded.billing.remittance_sequence}, com arquivo gerado. Alterar vencimento ou dados do boleto pode exigir registrar o título de novo no banco.</p>}
      <div className="finance-drawer-tabs" role="tablist" aria-label="Seções da conta">{DRAWER_TABS.map(item => <button key={item.id} type="button" role="tab" id={`finance-drawer-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="finance-drawer-panel" onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      <form className="finance-drawer-form" onSubmit={event => { event.preventDefault(); void save(false); }} aria-busy={busy}>
        {/* SQL 211: Anexos of the conta, outside the fields so a consulta still downloads; a new conta gets them once saved. */}
        {tab === 'anexos' ? <section id="finance-drawer-panel" role="tabpanel" aria-labelledby="finance-drawer-tab-anexos" className="finance-drawer-files">
          {title && controller.attachments ? <FinanceAttachments controller={controller as Controller & Pick<AccessController, 'attachments'>} owner="contas" ownerId={title.id} writable={!title.deleted_at && writer()} canAct={() => !busy} />
            : <p className="real-help">Salve a conta para incluir anexos. Depois de salva, os arquivos ficam nesta aba.</p>}
        </section> : <fieldset id="finance-drawer-panel" role="tabpanel" aria-labelledby={`finance-drawer-tab-${tab}`} className="finance-drawer-fields" disabled={disabled}>
          <legend className="real-sr-only">{DRAWER_TABS.find(item => item.id === tab)?.label}</legend>
          {tab === 'cabecalho' && <>
            <div className="finance-drawer-wide finance-drawer-contact">
              <CatalogPicker controller={controller as AccessController} entity="contacts" label={contactLabel} contactTools={{}} selected={values.contact} disabled={disabled || locks.contact} status={contactStatus} onCreate={quickAllowed ? query => { if (!quickContact) setQuickContact(quickContactInitial(receivable ? 'sales_orders' : 'purchase_orders', query)); } : undefined}
                onSelect={row => { if (!locks.contact) { setContactStatus(''); set('contact', row ? { id: row.id, name: row.name } : null); } }} />
              <small className="real-help">{locks.contact && title ? 'O contato fica com a origem, o boleto ou as baixas desta conta.' : 'Digite parte do nome e pressione ENTER.'}</small>
            </div>
            <DrawerField label="Valor (R$) *">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={17} required value={values.amount} readOnly={locks.amount} onChange={event => set('amount', event.target.value)} />}</DrawerField>
            <DrawerField label="Emissão *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.issued_on} readOnly={locks.issued} onChange={event => set('issued_on', event.target.value)} />}</DrawerField>
            <DrawerField label="Competência *">{id => <input id={id} type="date" required min="1900-01-01" max="2100-12-31" value={values.competence_on} onChange={event => set('competence_on', event.target.value)} />}</DrawerField>
            <DrawerField label="Vencimento *">{id => <input id={id} type="date" required min={values.issued_on || '1900-01-01'} max="2100-12-31" value={values.due_on} onChange={event => changeDue(event.target.value)} />}</DrawerField>
            <DrawerField label="Histórico" wide>{id => <><textarea id={id} rows={4} maxLength={historyLimit} value={values.description} onChange={event => set('description', event.target.value)} /><small className="finance-drawer-counter">{values.description.length} de {historyLimit.toLocaleString('pt-BR')} caracteres</small></>}</DrawerField>
          </>}
          {tab === 'pagamento' && <>
            <DrawerField label="Forma de Pagamento">{id => <select id={id} value={values.payment_method_id ?? ''} onChange={event => { const chosen = methods.items.find(item => item.id === event.target.value);
              setValues(previous => { const due = mode === 'create' && chosen ? settlementDue(previous.issued_on, chosen.settlement_days, chosen.business_days === true) : null;
                return { ...previous, payment_method_id: event.target.value, ...(chosen && rateText(chosen.interest_rate) ? { interest: rateText(chosen.interest_rate)! } : {}), ...(chosen && rateText(chosen.fine_rate) ? { penalty: rateText(chosen.fine_rate)! } : {}), ...(chosen?.account_id && !previous.account_id ? { account_id: chosen.account_id } : {}),
                  ...(due && due >= previous.issued_on ? { due_on: due, due_day: String(Number(due.slice(8, 10))), weekday: String(weekdayOf(due)) } : {}) }; });
              setDueHint(mode === 'create' && chosen && settlementDue(values.issued_on, chosen.settlement_days, chosen.business_days === true) ? `Vencimento pelo prazo de recebimento da forma: ${chosen.settlement_days} dia(s)${chosen.business_days ? ', em dia útil' : ''} após a emissão.` : ''); }}>
              <option value="">Selecione</option>{values.payment_method_id && !methods.items.some(item => item.id === values.payment_method_id) && <option value={values.payment_method_id}>{title?.payment_method_name ?? 'Forma atual'}</option>}{methods.items.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}</select>}</DrawerField>
            {dueHint && <p className="real-help finance-drawer-wide" role="status">{dueHint}</p>}
            <DrawerField label="Conta Financeira">{id => <select id={id} value={values.account_id} onChange={event => set('account_id', event.target.value)}><option value="">Selecione</option>{values.account_id && !accountChoices.some(item => item.id === values.account_id) && <option value={values.account_id}>{loaded?.account?.name ?? 'Conta financeira atual'}</option>}{accountChoices.map(item => <option key={item.id} value={item.id}>{item.name}{item.active ? '' : ' (arquivada)'}</option>)}</select>}</DrawerField>
            {receivable && <DrawerField label="Nº no banco">{id => loaded?.billing ? <input id={id} readOnly value={loaded.billing.our_number ?? ''} title="Nosso número do boleto registrado pela cobrança do FAGOO." /> : <input id={id} maxLength={BANK_NUMBER_LIMIT} value={values.bank_number} readOnly={locks.bank} onChange={event => set('bank_number', event.target.value)} />}</DrawerField>}
            <DrawerField label="Categoria">{id => <CategoryTreePicker id={id} items={categories.items} value={values.category_id} currentName={title?.category_name} onChange={next => set('category_id', next)} />}</DrawerField>
            {receivable && <DrawerField label="Vendedor" info={recurringCreate ? SELLER_RECURRING : SELLER_INFO}>{id => <><FinanceSellerSelect controller={controller as AccessController} id={id} label="Vendedor" emptyLabel="Selecione" disabled={disabled || recurringCreate} value={recurringCreate ? null : values.seller ?? null} onChange={next => set('seller', next)} />{title?.seller_source === 'documento' && values.seller?.id === title.seller_id && <small className="real-help">Vendedor do documento de origem. Limpe o campo para deixar a conta sem vendedor.</small>}{title?.seller_cleared && !values.seller && <small className="real-help">Sem vendedor: esta conta não usa o vendedor do documento de origem.</small>}</>}</DrawerField>}
            <DrawerField label="Nº documento" info="Número para controle interno da empresa">{id => <input id={id} maxLength={200} value={values.source_reference} readOnly={locks.reference} onChange={event => set('source_reference', event.target.value)} />}</DrawerField>
            <DrawerField label="Juros mensal (%)" info={PERCENT_INFO}>{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={6} value={values.interest} onChange={event => set('interest', event.target.value)} />}</DrawerField>
            <DrawerField label="Multa (%)" info={PERCENT_INFO}>{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={6} value={values.penalty} onChange={event => set('penalty', event.target.value)} />}</DrawerField>
            {optionsError && <p className="real-alert finance-drawer-wide" role="alert">{optionsError} <button type="button" className="text-button" onClick={() => setOptionsRetry(value => value + 1)}>Tentar novamente</button></p>}
          </>}
          {tab === 'ocorrencia' && <>
            <DrawerField label="Ocorrência" info="Única ou recorrente">{id => <select id={id} value={values.occurrence} disabled={mode !== 'create'} onChange={event => changeOccurrence(event.target.value as DrawerValues['occurrence'])}>{OCCURRENCES.map(option => <option key={option.id} value={option.id} disabled={!option.available} title={option.available ? undefined : RECURRENCE_UNAVAILABLE}>{option.label}</option>)}</select>}</DrawerField>
            {mode !== 'create' && title && (title.recurrence_id ? <p className="real-help finance-drawer-wide">Esta é uma conta recorrente. A ocorrência não muda depois de incluída; a recorrência fica em <Link to={recurrencePath(kind)}>Gerenciar contas recorrentes</Link>.</p>
              : <p className="real-help finance-drawer-wide">Parcela {title.installment} de {title.installments}. A ocorrência não muda depois de incluída.</p>)}
            {recurring && <>
              {values.occurrence === 'semanal'
                ? <DrawerField label="Dia da semana *">{id => <select id={id} required value={values.weekday ?? '0'} onChange={event => chooseWeekday(Number(event.target.value))}>{WEEKDAYS.map((label, index) => <option key={label} value={String(index)}>{label}</option>)}</select>}</DrawerField>
                : <DrawerField label="Dia de vencimento *">{id => <input id={id} inputMode="numeric" maxLength={2} required value={values.due_day} onChange={event => set('due_day', event.target.value)} />}</DrawerField>}
              {values.occurrence === 'quinzenal' && <DrawerField label="Dia do 2º vencimento *">{id => <input id={id} inputMode="numeric" maxLength={2} required value={values.second_day ?? ''} onChange={event => set('second_day', event.target.value)} />}</DrawerField>}
              <DrawerField label="Data limite" info={END_ON_INFO}>{id => <input id={id} type="date" min={values.due_on || '1900-01-01'} max="2100-12-31" value={values.end_on ?? ''} onChange={event => set('end_on', event.target.value)} />}</DrawerField>
              <label className="finance-drawer-switch finance-drawer-wide"><input type="checkbox" role="switch" checked={values.business_days} onChange={event => set('business_days', event.target.checked)} />Considerar dias úteis</label>
              <p className="real-help finance-drawer-wide">A primeira conta é incluída agora, com o vencimento informado{values.occurrence === 'semanal' ? '' : ' (as próximas no dia de vencimento de cada período)'}. As seguintes são geradas em Gerenciar contas recorrentes, pelo painel Gerar contas, até a data limite. Com dias úteis, sábados, domingos e feriados nacionais passam para o próximo dia útil.</p>
            </>}
            {mode === 'create' && values.occurrence === 'parcelada' && <>
              <DrawerField label="Dia de vencimento *">{id => <input id={id} inputMode="numeric" maxLength={2} required value={values.due_day} onChange={event => set('due_day', event.target.value)} />}</DrawerField>
              <DrawerField label="Parcelas *" info="Nº de parcelas">{id => <input id={id} inputMode="numeric" maxLength={3} required value={values.count} onChange={event => set('count', event.target.value)} />}</DrawerField>
              <label className="finance-drawer-switch finance-drawer-wide"><input type="checkbox" role="switch" checked={values.business_days} onChange={event => set('business_days', event.target.checked)} />Considerar dias úteis</label>
              {plan ? <div className="finance-installments finance-drawer-wide"><table className="data-table"><thead><tr><th>Parcela</th><th>Vencimento</th><th className="numeric">Valor</th></tr></thead><tbody>{plan.map((part, index) => <tr key={index}><td>{index + 1}/{plan!.length}</td><td>{financeDate(part.due_on)}</td><td className="numeric">{financeMoney(part.amount_cents)}</td></tr>)}</tbody></table></div>
                : <p className="real-help finance-drawer-wide">{planError || 'Informe o valor e o vencimento para ver as parcelas.'}</p>}
              <p className="real-help finance-drawer-wide">Cada parcela tem o valor informado, como no Origin. A primeira (1/{plan?.length ?? values.count}) é incluída agora, na data de Vencimento; as seguintes, no dia de vencimento de cada mês, são geradas em Gerenciar contas recorrentes, pelo painel Gerar contas, até a última parcela. Com dias úteis, sábados, domingos e feriados nacionais passam para o próximo dia útil.</p>
            </>}
          </>}
        </fieldset>}
        <section className="finance-drawer-summary" aria-label="Resumo">
          <h3>Resumo</h3>
          <dl>
            <div><dt>Vencimento original</dt><dd>{financeDate(title ? title.original_due_on ?? title.due_on : values.due_on)}</dd></div>
            <div><dt>Valor original</dt><dd>{title ? financeMoney(title.amount_cents) : typed ? financeMoney(typed) : '—'}</dd></div>
            <div><dt>Juros</dt><dd>{financeMoney(charges?.interest_cents ?? '0')}</dd></div>
            <div><dt>Multa</dt><dd>{financeMoney(charges?.penalty_cents ?? '0')}</dd></div>
            <div><dt>Valor total</dt><dd>{charges ? financeMoney(charges.total_cents) : title ? financeMoney(title.balance_cents) : typed ? financeMoney(typed) : '—'}</dd></div>
          </dl>
          {charges && charges.days > 0 && <p className="real-help">Juros mensais proporcionais aos {charges.days} dias de atraso e multa sobre o saldo, calculados até hoje.</p>}
          {/* Leva H (CTT-050): the endereço de cobrança of the contact (or the general one), read-only; no bank operation. */}
          {title && title.kind === 'receivable' && <BillingAddressLine controller={controller} contactId={title.contact_id} />}
          {origin && <p className="finance-origin-line">{originText(origin).field}: <Link to={originPath(origin)} title={originText(origin).menu}>{originNumber(origin)}</Link></p>}
          {title && <button type="button" className="text-button" onClick={() => setOriginalOpen(true)}>Histórico original da conta</button>}
        </section>
        {history}
        {error && <p className="real-alert" role="alert">{error}</p>}
        <footer className="finance-drawer-actions">
          {saved ? <>
            <button type="button" className="secondary-button" disabled={busy} onClick={closeSaved}>Fechar</button>
            {command.current && <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Salvando…' : 'Conferir resultado'}</button>}
          </> : readOnly ? <button type="button" className="secondary-button" onClick={requestClose}>Fechar</button> : <>
            <button type="button" className="text-button" disabled={busy} onClick={requestClose}>Cancelar</button>
            {!uncertain && settleAllowed && <button type="button" className="secondary-button" disabled={busy || waiting} title="Salva a conta e abre a baixa em seguida" onClick={() => void save(true)}>Salvar e dar baixa</button>}
            <button type="submit" className="primary-button" disabled={busy || waiting}>{busy ? 'Salvando…' : uncertain ? 'Conferir resultado' : 'Salvar'}</button>
          </>}
        </footer>
      </form>
    </section>
    {propagation && <Modal title="Conta recorrente" onClose={() => setPropagation(null)} actions={<><button type="button" className="secondary-button" onClick={() => setPropagation(null)}>Cancelar</button><button type="button" className="primary-button" onClick={() => void confirmPropagation()}>Salvar</button></>}>
      <div className="finance-propagation">
        <p>Esta é uma conta recorrente. O que deseja fazer com as contas em aberto vinculadas à esta?</p>
        <label htmlFor="finance-propagation-alter"><input id="finance-propagation-alter" type="checkbox" checked={propagation.alter} onChange={event => { const checked = event.target.checked; setPropagation(previous => previous && { ...previous, alter: checked }); }} />Alterar contas em aberto.</label>
        <fieldset disabled={!propagation.alter}><legend className="real-sr-only">Contas em aberto</legend>
          <label htmlFor="finance-propagation-following"><input id="finance-propagation-following" type="radio" name="finance-propagation-scope" checked={propagation.scope === 'following'} onChange={() => setPropagation(previous => previous && { ...previous, scope: 'following' })} />Atualizar contas em aberto vinculadas e seguintes à esta conta</label>
          <label htmlFor="finance-propagation-all"><input id="finance-propagation-all" type="radio" name="finance-propagation-scope" checked={propagation.scope === 'all'} onChange={() => setPropagation(previous => previous && { ...previous, scope: 'all' })} />Atualizar todas as contas em aberto vinculadas</label>
        </fieldset>
        <label htmlFor="finance-propagation-future"><input id="finance-propagation-future" type="checkbox" checked={propagation.future} onChange={event => { const checked = event.target.checked; setPropagation(previous => previous && { ...previous, future: checked }); }} />Alterar lançamentos de contas futuras.</label>
        <p className="real-help">Vão para as outras contas: {Object.keys(propagation.changes).map(key => PROPAGATED_LABEL[key]).join(', ')}. Contas com baixa, boleto, documento de origem ou importadas do Origin ficam como estão.</p>
      </div>
    </Modal>}
    {originalOpen && title && <Modal title="Histórico original da conta" onClose={() => setOriginalOpen(false)} actions={<button type="button" className="secondary-button" onClick={() => setOriginalOpen(false)}>Fechar</button>}>
      <dl className="finance-review">
        <div><dt>Id</dt><dd>{title.id}</dd></div>
        <div><dt>{receivable ? 'Cliente' : 'Fornecedor'}</dt><dd>{loaded?.original?.contact_name ?? title.contact_name}</dd></div>
        <div><dt>Vencimento</dt><dd>{financeDate(loaded?.original?.due_on ?? title.original_due_on ?? title.due_on)}</dd></div>
        <div><dt>Valor original</dt><dd>{financeMoney(loaded?.original?.amount_cents ?? title.amount_cents)}</dd></div>
        <div><dt>Saldo</dt><dd>{financeMoney(title.balance_cents)}</dd></div>
      </dl>
      <p className="real-help">Somente consulta. Os dados vêm do registro de criação da conta.</p>
    </Modal>}
    {quickContact && <DocumentQuickContact controller={controller as AccessController} kind={receivable ? 'sales_orders' : 'purchase_orders'} initial={quickContact}
      onState={state => setQuickBusy(state.busy || state.uncertain)}
      onCreated={row => { setQuickContact(null); setQuickBusy(false); setContactStatus(`Contato ${row.name} cadastrado e selecionado.`); set('contact', { id: row.id, name: row.name }); }}
      onClose={wasUncertain => { setQuickContact(null); setQuickBusy(false); setContactStatus(wasUncertain ? 'O resultado do cadastro rápido não foi confirmado. Pesquise o contato pelo nome ou CPF/CNPJ antes de cadastrá-lo de novo.' : ''); }} />}
  </div>;
}
