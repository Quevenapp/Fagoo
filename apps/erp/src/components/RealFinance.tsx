import { Link, useLocation, useNavigate } from 'react-router-dom';
import NativeListLayout from './NativeListLayout';
import FinanceTransfers from './FinanceTransfers';
import FinanceMovementHistory from './FinanceMovementHistory';
import FinanceTitleDrawer from './FinanceTitleDrawer';
import FinanceSettleDrawer from './FinanceSettleDrawer';
import FinancePrintPreview, { type FinancePrint } from './FinancePrintPreview';
import { borderoMenuLabel, borderoPath } from '../lib/finance-bordero-route';
import { boletoMenu, sameRemittance, shareableCharge, whatsappMessage, whatsappUrl } from '../lib/finance-title-list';
import FinanceWhatsappShare, { type WhatsappShare } from './FinanceWhatsappShare';
import { Icon } from './Icon';
import { useUnsavedChanges, useUnsavedChangesGuard, useUnsavedForm } from '../hooks/useUnsavedChanges';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { FINANCE_KIND, FINANCE_STATUS, centsInput, financeDate, financeMoney, installmentPlan, moneyInput, postingDate, settlementAmounts, todaySP, validFinanceDate, type FinanceAccess, type FinanceAccount, type FinanceCategory, type FinanceEntity, type FinanceEnvelope, type FinanceKind, type FinanceMovement, type FinancePage, type FinanceRecord, type FinanceSettlement, type FinanceTitle, type FinanceTitlePage, type FinanceTitleRow } from '../lib/real-finance-model';
import { FINANCE_TITLE_PAGE_SIZE, categoryParam, effectivePeriod, emptyFinanceRoute, financeDetailRecord, financeListApiPath, financeListEntity, financeListPage, financeListParams, financeListRoute, financePeriodNotice, financeTitlePage, financeTitlePageApiPath, optionDate, routeCategories, routeStatuses, statusParam, type FinanceArea, type FinanceDateField, type FinanceListRoute, type FinanceTitleOption } from '../lib/finance-list-route';
import { loadReferenceOptions, type ReferenceOption } from '../lib/finance-title-drawer';
import { titleSituation as originSituation, ACCOUNT_ALL, ACCOUNT_NONE, DEFAULT_CUSTOM_COLUMNS, TITLE_COLUMNS, customColumns, panelActions, panelFields, standardColumns, titleColumnOptions, titleIdentification, titleNet, titleOptions, type TitleColumn, TITLE_BATCH_LABEL, batchBalance, dateFieldFromLabel, dateFieldLabel, dateFieldOptions, dateFieldShort, originPath, originText, planTitleBatch, savedTitleId, titleAllows, titleBatchCommand, titleChips, titleRowActions, titleSearchPlaceholder, titleStatusOptions, type TitleBatchAction, type TitleBatchItem, type TitleChipKey, type TitleRowAction } from '../lib/finance-title-list';
import { financeOriginOrigin, type FinanceOriginOrigin } from '../lib/finance-origin-origin';
import { AppliedChips, OriginPagination, OriginSelector, PeriodPicker, RowMenu, ToolButton, ViewToggle, type RowMenuItem } from './OriginList';
import { BatchDialog } from './BatchDialog';
import { recurrencePath } from '../lib/finance-recurrence-model';
import { creditModels } from '../lib/finance-print';
import { Modal } from './Modal';
import { ListColumnsPanel } from './ListColumnsPanel';
import { batchSummaryText, summarizeBatch, type BatchPlan, type BatchResult } from '../lib/origin-batch';
import { badgeClass, opensInNewTab, rangeLabel, selectRange } from '../lib/origin-list';
import './real-finance.css';
import {financeLinkActor} from '../lib/document-finance-link';
import { CategoryTreeFilter, useCategoryTree } from './FinanceCategoryTreeSelect';
import { useFinancePreferences } from '../lib/finance-preferences';
import { useListPreferences, type ListPreferencesPort } from '../hooks/useListPreferences';
import type { AccessState } from '../lib/real-access';
import { FinanceSellerSelect } from './FinanceSellerSelect';
import { TITLE_PAYMENT_TYPES, paymentTypeIcon, paymentTypeLabel } from '../lib/finance-title-list';
import { contactOptionsPath, pickerOptions } from '../lib/contact-picker-model';
import type { SellerOption } from '../lib/finance-sellers';
import { remittancePath } from '../lib/finance-cnab-lists-model';
import { bankShortName, bankTitle } from '../lib/finance-banks';
import { financePermitted, titlePermission } from '../lib/real-finance-model';
import { BATCH_PERMISSION, originNumber } from '../lib/finance-title-list';

// Without the per-user list preferences port (or before the access is known) the list keeps the browser choice.
const LIST_PREFERENCES_IDLE = { phase: 'loading' } as unknown as AccessState;
const LIST_PREFERENCES_OFF: ListPreferencesPort = { getSnapshot: () => LIST_PREFERENCES_IDLE, subscribe: () => () => {}, listPreferences: async () => { throw new Error('LIST_PREFERENCES_UNAVAILABLE'); } };
const TITLE_LIST_PREFERENCE: Readonly<Record<FinanceKind, string>> = { receivable: 'financeiro.contas_receber', payable: 'financeiro.contas_pagar' };
const noFinanceSubscription=()=>()=>{};
const noFinanceSnapshot=()=>null;

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
function message(error: unknown) {
  if (error instanceof AccessError) return error.status === 409 ? 'O registro mudou ou esta operação já foi usada com outros valores. Volte à listagem e reabra o registro antes de confirmar novamente.' : error.status === 400 ? 'A operação não foi aceita. Confira os valores, as datas e os cadastros selecionados.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : error.status === 404 ? 'O registro não foi encontrado. Atualize a listagem.' : 'Não foi possível confirmar o resultado. Tente novamente com os mesmos dados; a operação não será duplicada.';
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}
type Reference = { id: string; name: string };
type Mode = 'account_save' | 'category_save' | 'title_create_group' | 'title_update' | 'title_cancel' | 'settle' | 'reverse' | 'opening';
const MODE_LABELS: Record<Mode, string> = { account_save: 'Salvar conta financeira', category_save: 'Salvar categoria', title_create_group: 'Incluir títulos', title_update: 'Salvar título', title_cancel: 'Cancelar título', settle: 'Registrar baixa', reverse: 'Estornar baixa', opening: 'Registrar saldo inicial' };
// Origin situation badge: label, tone and "Atrasada por N dias".
function titleSituation(title: FinanceTitle, today: string) {
  const origin = originSituation(title, today);
  return { text: origin.label, className: badgeClass(origin.label), hint: origin.hint };
}
function SituationBadge({ title, active, today }: { title?: FinanceTitle | null; active?: boolean; today?: string }) {
  if (title) { const situation = titleSituation(title, today ?? todaySP()); return <span className={situation.className} title={situation.hint}>{situation.text}</span>; }
  const label = active ? 'Ativo' : 'Arquivado'; return <span className={badgeClass(label)}>{label}</span>;
}
type Review = { action: Mode; data: Record<string, unknown>; rows: [string, string][]; installments?: { amount_cents: string; due_on: string }[]; settleAfter?: boolean };
// Origin's drawer footer "Salvar e dar baixa": save first, then open the baixa of the saved conta.
const reviewLabel = (review: Review) => review.settleAfter ? 'Salvar e dar baixa' : MODE_LABELS[review.action];
const stopRow = (event: { stopPropagation: () => void }) => event.stopPropagation();
function OriginLink({ title }: { title: FinanceTitle }) {
  if (!title.origin) return null; const text = originText(title.origin);
  return <p className="finance-origin-line">{text.field}: <Link to={originPath(title.origin)} title={text.menu}>{originNumber(title.origin)}</Link></p>;
}
function useTitleOrigin(controller: AccessController, title: FinanceTitle | null) {
  const [state, setState] = useState<{ key: string; ready: boolean; origin: FinanceOriginOrigin | null; error: string }>({ key: '', ready: false, origin: null, error: '' });
  const [retry, setRetry] = useState(0), key = title ? `${title.id}:${title.kind}` : '';
  useEffect(() => {
    if (!title) return;
    const request = new AbortController(); setState({ key, ready: false, origin: null, error: '' });
    void (async () => {
      try {
        const response = await controller.financialImportOrigin(`/v1/importacao-financeira-origin/titles/${title.id}/origin`, { signal: request.signal });
        const origin = financeOriginOrigin(response, title.id, title.kind);
        if (!request.signal.aborted) setState({ key, ready: true, origin, error: '' });
      } catch (failure) { if (!request.signal.aborted && !aborted(failure)) setState({ key, ready: false, origin: null, error: 'Não foi possível conferir a origem deste título. Consulte novamente antes de editá-lo.' }); }
    })();
    return () => request.abort();
  }, [controller, key, retry]);
  const current = state.key === key ? state : { key, ready: false, origin: null, error: '' };
  return { ...current, retry: () => setRetry(value => value + 1) };
}
function TitleOriginNotice({ state }: { state: ReturnType<typeof useTitleOrigin> }) {
  if (state.error) return <p className="real-alert" role="alert">{state.error} <button type="button" className="text-button" onClick={state.retry}>Conferir origem novamente</button></p>;
  if (!state.ready) return <p className="real-help" role="status">Conferindo a origem do título…</p>;
  if (!state.origin) return null;
  const origin = state.origin;
  return <aside className="real-notice" aria-label="Origem do título"><strong>Importado do Origin</strong><p>{origin.entity === 'receivables' ? 'Conta a receber' : 'Conta a pagar'} · ID {origin.source_id} · Importado em {new Date(origin.imported_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.</p><p>O valor original, o contato, a emissão e a referência da origem são preservados. Você pode ajustar a descrição, a categoria e o vencimento.</p><p>Este título não pode gerar uma nova reserva de boleto CNAB enquanto os boletos do sistema anterior não forem conferidos e homologados.</p></aside>;
}
function Field({ label, children, wide = false }: { label: string; children: (id: string) => ReactNode; wide?: boolean }) { const id = useId(); return <div className={`form-field ${wide ? 'real-field-wide' : ''}`}><label htmlFor={id}>{label}</label>{children(id)}</div>; }
function PageControls({ page, loading, cursors, after, setAfter, setCursors }: { page: FinancePage<unknown>; loading: boolean; cursors: (string | null)[]; after: string | null; setAfter: (value: string | null) => void; setCursors: (value: (string | null)[]) => void }) {
  return <footer className="table-footer real-pagination"><span>Página {cursors.length + 1} · {page.items.length} registro(s)</span><div className="pagination"><button type="button" className="secondary-button" disabled={loading || !cursors.length} onClick={() => { setAfter(null); setCursors([]); }}>Primeira</button><button type="button" className="secondary-button" disabled={loading || !cursors.length} onClick={() => { setAfter(cursors.at(-1) ?? null); setCursors(cursors.slice(0, -1)); }}>Anterior</button><button type="button" className="secondary-button" disabled={loading || !page.has_more} onClick={() => { setAfter(page.next_cursor); setCursors([...cursors, after]); }}>Próxima</button></div></footer>;
}

function Picker({ controller, entity, label, value, onChange, optional = false, kind }: { controller: AccessController; entity: 'contacts' | 'accounts' | 'categories'; label: string; value: Reference | null; onChange: (value: Reference | null) => void; optional?: boolean; kind?: FinanceKind }) {
  const [query, setQuery] = useState(''); const [search, setSearch] = useState(''); const [after, setAfter] = useState<string | null>(null);
  const [page, setPage] = useState<FinancePage<Reference & { active?: boolean; kind?: string }> | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const id = useId();
  useEffect(() => {
    if (value) return; const request = new AbortController(); setLoading(true); setError(''); setPage(null);
    const params = new URLSearchParams({ limit: '10', q: search }); if (after) params.set('after', after);
    // Contacts come from the contacts picker (contatos lane): active only, within the seller portfolio ("Contato acessível somente
    // ao vendedor vinculado"); it has no cursor, so a longer answer asks to refine the search. No papel filter, as in the gaveta: the
    // contacts mirrored from Origin have no papel and must stay selectable.
    const result = entity === 'contacts' ? controller.catalog(contactOptionsPath({ q: search, limit: 10 }), { signal: request.signal }).then(value => {
      const options = pickerOptions(value); if (!options) throw new Error('Não foi possível pesquisar os contatos.');
      return { items: options.items.map(item => ({ id: item.id, name: item.name })), limit: 10, has_more: false, next_cursor: null, refine: options.has_more };
    }) : controller.finance(`/v1/financeiro/${entity}?${params}`, { signal: request.signal });
    void result.then(data => { setPage(data as typeof page); setLoading(false); }).catch(failure => { if (!aborted(failure)) { setError(message(failure)); setLoading(false); } });
    return () => request.abort();
  }, [controller, entity, search, after, value]);
  const options = page?.items.filter(item => item.active !== false && (entity !== 'categories' || !kind || item.kind === kind || item.kind === 'both')) || [];
  return <fieldset className="finance-picker"><legend>{label}{optional ? ' (opcional)' : ' *'}</legend>{value ? <div className="finance-selected"><strong>{value.name}</strong><button className="text-button" type="button" onClick={() => { onChange(null); setAfter(null); }}>Trocar{optional ? ' / remover' : ''}</button></div> : <><div className="finance-picker-search"><label className="real-sr-only" htmlFor={id}>Pesquisar {label.toLowerCase()}</label><input id={id} type="search" maxLength={120} placeholder={`Pesquisar ${label.toLowerCase()}`} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setSearch(query.trim()); setAfter(null); } }} /><button className="secondary-button" type="button" onClick={() => { setSearch(query.trim()); setAfter(null); }} disabled={loading}>Buscar</button></div>{error && <p className="real-alert" role="alert">{error}</p>}<div className="finance-picker-options" aria-live="polite">{loading ? <p>Buscando…</p> : options.length ? options.map(item => <button type="button" key={item.id} onClick={() => onChange({ id: item.id, name: item.name })}>{item.name}</button>) : <p>Nenhum cadastro ativo nesta página. {optional ? 'Você pode continuar sem categoria.' : 'Cadastre-o na área correspondente, se necessário.'}</p>}</div>{(page as { refine?: boolean } | null)?.refine && <p className="real-help">Há mais contatos com este texto. Refine a pesquisa.</p>}{page && (after || page.has_more) && <div className="finance-picker-pages"><button type="button" className="text-button" disabled={loading || !after} onClick={() => setAfter(null)}>Primeira página</button><button type="button" className="text-button" disabled={loading || !page.has_more} onClick={() => setAfter(page.next_cursor)}>Mais resultados</button></div>}</>}</fieldset>;
}

function Confirmation({ review, busy, uncertain, error, onBack, onConfirm }: { review: Review; busy: boolean; uncertain: boolean; error: string; onBack: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.focus(); }; }, []);
  return <dialog ref={dialog} className="finance-confirm" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onBack(); }}><h2 id={titleId}>{reviewLabel(review)}?</h2><p>Confira os dados antes de confirmar.</p><dl className="finance-review">{review.rows.map(([label, value], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{review.installments && <div className="finance-installments"><table className="data-table"><thead><tr><th>Parcela</th><th>Vencimento</th><th className="numeric">Valor</th></tr></thead><tbody>{review.installments.map((part, index) => <tr key={index}><td>{index + 1}/{review.installments!.length}</td><td>{financeDate(part.due_on)}</td><td className="numeric">{financeMoney(part.amount_cents)}</td></tr>)}</tbody></table></div>}{review.action === 'opening' && <p className="real-notice">O saldo inicial só pode ser registrado uma vez nesta conta. Confira o valor, o sinal e a data com o responsável financeiro.</p>}{error && <p className="real-alert" role="alert">{error}</p>}<div className="real-editor-actions"><button type="button" className="secondary-button" onClick={onBack} disabled={busy} autoFocus>{uncertain?'Fechar e conferir depois':'Voltar e conferir'}</button><button type="button" className={review.action === 'reverse' || review.action === 'title_cancel' ? 'danger-button' : 'primary-button'} onClick={onConfirm} disabled={busy}>{busy ? 'Confirmando…' : uncertain ? 'Conferir resultado' : reviewLabel(review)}</button></div></dialog>;
}

function FinanceEditor({ controller, mode, record, kind, payment, partial = false, onClose, onSaved }: { controller: AccessController; mode: Mode; record: FinanceRecord | null; kind: FinanceKind; payment?: FinanceSettlement; partial?: boolean; onClose: () => void; onSaved: (next?: { settleId: string | null }) => void }) {
  const title = mode === 'title_update' || mode === 'title_cancel' || mode === 'settle' || mode === 'reverse' ? record as FinanceTitle : null;
  const originState = useTitleOrigin(controller, title), originRef = useRef(originState); originRef.current = originState;
  const originLocked = Boolean(originState.origin?.core_fields_locked), awaitingOrigin = mode === 'title_update' && !originState.ready;
  const accountRecord = mode === 'account_save' || mode === 'opening' ? record as FinanceAccount | null : null;
  const named = mode === 'account_save' || mode === 'category_save' ? record as FinanceAccount | FinanceCategory | null : null;
  const [values, setValues] = useState<Record<string, string>>({ name: named?.name || '', kind: named?.kind || (mode === 'account_save' ? 'bank' : 'both'), description: title?.description || '', source_reference: title?.source_reference || '', issued_on: title?.issued_on || todaySP(), due_on: title?.due_on || todaySP(), amount: title ? centsInput(title.amount_cents) : '', count: '1', posted_on: todaySP(), note: '', principal: title && !partial ? centsInput(title.balance_cents) : '', interest: '0,00', penalty: '0,00', discount: '0,00', fee: '0,00' });
  const [active, setActive] = useState(named?.active ?? true); const [contact, setContact] = useState<Reference | null>(null); const [category, setCategory] = useState<Reference | null>(title?.category_id ? { id: title.category_id, name: title.category_name || 'Categoria atual' } : null); const [account, setAccount] = useState<Reference | null>(null);
  const [review, setReview] = useState<Review | null>(null); const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false); const [error, setError] = useState(''); const [originalAccount, setOriginalAccount] = useState('');
  const guard = useUnsavedForm({ values, active, contact: contact?.id || null, category: category?.id || null, account: account?.id || null }, busy || uncertain);
  const pending = useRef<AbortController | null>(null); const command = useRef<{ id: string; path: string; body: Record<string, unknown>; uncertain: boolean } | null>(null); const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); return () => pending.current?.abort(); }, []);
  useEffect(() => { if (!payment) return; const request = new AbortController(); void controller.finance(`/v1/financeiro/accounts/${payment.account_id}`, { signal: request.signal }).then(result => setOriginalAccount((result as FinanceEnvelope<FinanceAccount>).record.name)).catch(failure => { if (!aborted(failure)) { setOriginalAccount(''); setError(message(failure)); } }); return () => request.abort(); }, [controller, payment]);
  const set = (key: string, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  const drawer = mode === 'title_create_group' || mode === 'title_update', originSave = drawer || mode === 'account_save' || mode === 'category_save';
  const drawerTitle = `Conta a ${(title?.kind || kind) === 'receivable' ? 'receber' : 'pagar'}`;
  const input = (key: string, label: string, options: { type?: string; required?: boolean; max?: number; wide?: boolean; readOnly?: boolean; min?: string; maxDate?: string } = {}) => <Field label={label} wide={options.wide}>{id => <input id={id} type={options.type || 'text'} required={options.required} value={values[key]} maxLength={options.max} readOnly={options.readOnly} min={options.min} max={options.maxDate} inputMode={['amount', 'principal', 'interest', 'penalty', 'discount', 'fee'].includes(key) ? 'decimal' : key === 'count' ? 'numeric' : undefined} onChange={event => set(key, event.target.value)} />}</Field>;
  let cashPreview = ''; if (mode === 'settle' && title) { try { const amounts = settlementAmounts(title.kind, title.balance_cents, values); cashPreview = `${title.kind === 'receivable' ? 'Entrada' : 'Saída'} na conta: ${financeMoney(amounts.net_cash_cents)} · Saldo do título: ${financeMoney(amounts.remaining_cents)}`; } catch { /* Full validation runs before review. */ } }
  const settleAfterAllowed = mode === 'title_create_group' ? values.count.trim() === '1' : mode === 'title_update' && Boolean(title && !title.cancelled && BigInt(title.balance_cents) > 0n);
  const prepare = (event: Pick<FormEvent, 'preventDefault'>, settleAfter = false) => {
    event.preventDefault(); if (busy || uncertain || (settleAfter && !settleAfterAllowed)) return; setError('');
    try {
      let data: Record<string, unknown> = {}; let rows: [string, string][] = []; let installments: Review['installments'];
      if (mode === 'account_save' || mode === 'category_save') {
        if (!values.name.trim()) throw new Error('Informe o nome.');
        data = { ...(named ? { id: named.id } : {}), expected_version: named?.version || 0, name: values.name.trim(), kind: values.kind, active };
        rows = [['Nome', values.name.trim()], ['Tipo', FINANCE_KIND[values.kind]], ['Situação', active ? 'Ativo' : 'Arquivado']];
      } else if (mode === 'title_create_group') {
        if (!contact) throw new Error('Selecione um contato ativo da empresa.'); if (!values.description.trim()) throw new Error('Informe a descrição.');
        const total = moneyInput(values.amount); installments = installmentPlan(total, values.count, values.due_on, values.issued_on);
        data = { kind, contact_id: contact.id, category_id: category?.id || null, description: values.description.trim(), source_reference: values.source_reference.trim() || null, issued_on: values.issued_on, total_cents: total, installments };
        rows = [['Tipo', FINANCE_KIND[kind]], ['Contato', contact.name], ['Descrição', values.description.trim()], ['Emissão', financeDate(values.issued_on)], ['Total', financeMoney(total)], ['Categoria', category?.name || 'Sem categoria']];
      } else if (mode === 'title_update' && title) {
        if (!originRef.current.ready) throw new Error('Aguarde a conferência da origem do título antes de editar.');
        const preserveCore = Boolean(title.document_linked || originRef.current.origin?.core_fields_locked);
        validFinanceDate(values.due_on); if (values.due_on < title.issued_on || !values.description.trim()) throw new Error('Confira a descrição e o vencimento do título.');
        data = { id: title.id, expected_version: title.version, description: values.description.trim(), source_reference: preserveCore ? title.source_reference : values.source_reference.trim() || null, due_on: values.due_on, category_id: category?.id || null };
        const amount = preserveCore ? title.amount_cents : moneyInput(values.amount); if (BigInt(amount) <= 0n) throw new Error('O valor do título deve ser maior que zero.'); if (amount !== title.amount_cents) data.amount_cents = amount;
        rows = [['Contato', title.contact_name], ['Descrição', values.description.trim()], ['Vencimento', financeDate(values.due_on)], ['Valor', financeMoney(amount)], ['Categoria', category?.name || 'Sem categoria']];
      } else if (mode === 'settle' && title) {
        if (!account) throw new Error('Selecione uma conta financeira ativa.'); postingDate(values.posted_on, title.issued_on);
        const amounts = settlementAmounts(title.kind, title.balance_cents, values);
        data = { id: title.id, expected_version: title.version, account_id: account.id, posted_on: values.posted_on, ...amounts.components, note: values.note.trim() || null };
        rows = [['Título', `${title.description} · ${title.contact_name}`], ['Conta', account.name], ['Data', financeDate(values.posted_on)], ['Principal baixado', financeMoney(amounts.components.principal_cents)], ['Juros', financeMoney(amounts.components.interest_cents)], ['Multa', financeMoney(amounts.components.penalty_cents)], ['Desconto', financeMoney(amounts.components.discount_cents)], ['Tarifa', financeMoney(amounts.components.fee_cents)], [title.kind === 'receivable' ? 'Entrada na conta' : 'Saída da conta', financeMoney(amounts.net_cash_cents)], ['Saldo restante do título', financeMoney(amounts.remaining_cents)]];
      } else if (mode === 'reverse' && title && payment) {
        if (!originalAccount) throw new Error('Aguarde a identificação da conta original. Se ela não carregar, volte à listagem e reabra o título.');
        postingDate(values.posted_on, payment.posted_on); if (!values.note.trim()) throw new Error('Informe o motivo do estorno.');
        data = { id: title.id, expected_version: title.version, settlement_id: payment.id, posted_on: values.posted_on, note: values.note.trim() };
        rows = [['Título', `${title.description} · ${title.contact_name}`], ['Conta original', originalAccount], ['Data do estorno', financeDate(values.posted_on)], ['Principal devolvido ao título', financeMoney(payment.principal_cents)], [title.kind === 'receivable' ? 'Saída da conta' : 'Entrada na conta', financeMoney(payment.net_cash_cents)], ['Saldo do título após estorno', financeMoney((BigInt(title.balance_cents) + BigInt(payment.principal_cents)).toString())], ['Motivo', values.note.trim()]];
      } else if (mode === 'opening' && accountRecord) {
        postingDate(values.posted_on); if (!values.note.trim()) throw new Error('Informe a justificativa do saldo inicial.'); const amount = moneyInput(values.amount, true);
        data = { id: accountRecord.id, expected_version: accountRecord.version, amount_cents: amount, posted_on: values.posted_on, note: values.note.trim() };
        rows = [['Conta', accountRecord.name], ['Data de abertura', financeDate(values.posted_on)], ['Saldo inicial', financeMoney(amount)], ['Saldo após o lançamento', financeMoney((BigInt(accountRecord.balance_cents) + BigInt(amount)).toString())], ['Justificativa', values.note.trim()]];
      } else if (mode === 'title_cancel' && title) {
        if (!values.note.trim()) throw new Error('Informe o motivo do cancelamento.'); data = { id: title.id, expected_version: title.version, note: values.note.trim() };
        rows = [['Título', `${title.description} · ${title.contact_name}`], ['Valor', financeMoney(title.amount_cents)], ['Parcela', `${title.installment}/${title.installments}`], ['Motivo', values.note.trim()], ['Efeito', 'Cancela apenas este título, sem movimentar a conta.']];
      } else throw new Error('A operação selecionada não está disponível.');
      if (settleAfter) rows = [...rows, ['Em seguida', 'Abre a baixa desta conta para você conferir a conta financeira e os valores.']];
      setReview({ action: mode, data, rows, installments, settleAfter });
    } catch (failure) { setError(message(failure)); }
  };
  const confirm = async () => {
    if (!review || busy || pending.current) return;
    if (!command.current) command.current = { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${review.action}`, body: structuredClone({ data: review.data }), uncertain: false };
    const operation = command.current;
    const request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try { const result = await controller.finance(operation.path, { method: 'POST', body: { ...operation.body, command_id: operation.id }, signal: request.signal }); if (!request.signal.aborted) onSaved(review.settleAfter ? { settleId: savedTitleId(result, review.action, title?.kind || kind, title?.id) } : undefined); }
    catch (failure) { if (!request.signal.aborted && !aborted(failure)) {
      const known = !operation.uncertain && failure instanceof AccessError && [400,403,404,409].includes(failure.status);
      if (!known) operation.uncertain = true;
      if (known) command.current = null; setUncertain(!known);
      setError(known ? message(failure) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação. Os dados ficam preservados até a confirmação.');
    } }
    finally { if (pending.current === request) pending.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  return <section className="real-editor finance-editor"><header className="real-editor-heading"><div><div className="finance-editor-title"><h2 ref={heading} tabIndex={-1}>{drawer ? drawerTitle : MODE_LABELS[mode]}</h2>{mode === 'title_update' && title && <SituationBadge title={title} />}</div><p>{title ? `${title.contact_name} · Parcela ${title.installment}/${title.installments}` : accountRecord?.name || 'Financeiro da empresa'}</p>{mode === 'title_update' && title && <OriginLink title={title} />}</div><button type="button" className="secondary-button" onClick={() => guard.confirmLeave(onClose)} disabled={busy}>Voltar</button></header>{title && <TitleOriginNotice state={originState} />}{error && !review && <p className="real-alert" role="alert">{error}</p>}<form onSubmit={prepare} aria-busy={busy}><fieldset className="real-editor-fields" disabled={busy || uncertain}><legend className="real-sr-only">Dados da operação</legend>
    {(mode === 'account_save' || mode === 'category_save') && <>{input('name', 'Nome *', { required: true, max: 200 })}<Field label="Tipo *">{id => <select id={id} value={values.kind} onChange={event => set('kind', event.target.value)}>{(mode === 'account_save' ? ['bank', 'cash', 'other'] : ['receivable', 'payable', 'both']).map(value => <option key={value} value={value}>{FINANCE_KIND[value]}</option>)}</select>}</Field><Field label="Situação">{id => <select id={id} value={String(active)} onChange={event => setActive(event.target.value === 'true')}><option value="true">Ativo</option><option value="false">Arquivado</option></select>}</Field>{mode === 'account_save' && !record && <p className="real-help real-field-wide">A conta começa com saldo zero. O saldo inicial é informado em uma operação separada, após criar a conta.</p>}</>}
    {(mode === 'title_create_group' || mode === 'title_update') && <>{mode === 'title_create_group' && <div className="real-field-wide"><Picker controller={controller} entity="contacts" kind={kind} label={kind === 'receivable' ? 'Cliente' : 'Fornecedor'} value={contact} onChange={setContact} /></div>}{input('description', 'Histórico *', { required: true, max: 240, wide: true })}{input('source_reference', 'Referência / documento', { max: 200, readOnly: Boolean(title?.document_linked || originLocked || awaitingOrigin) })}{mode === 'title_create_group' && input('issued_on', 'Emissão *', { type: 'date', required: true })}{input('due_on', mode === 'title_create_group' ? 'Primeiro vencimento *' : 'Vencimento *', { type: 'date', required: true, min: title?.issued_on || values.issued_on })}{input('amount', mode === 'title_create_group' ? 'Valor total (R$) *' : 'Valor (R$) *', { required: true, readOnly: Boolean(title && (title.document_linked || originLocked || awaitingOrigin || title.installments > 1 || title.settled_cents !== '0')) })}{mode === 'title_create_group' && input('count', 'Parcelas *', { required: true, max: 3 })}<div className="real-field-wide"><Picker controller={controller} entity="categories" label="Categoria" optional kind={title?.kind || kind} value={category} onChange={setCategory} /></div><p className="real-help real-field-wide">{mode === 'title_create_group' ? 'Parcelas mensais. O total é distribuído em centavos; confira todos os vencimentos na próxima etapa.' : title?.document_linked ? 'Este título foi gerado por um documento da empresa. O valor original e a referência são preservados; você pode ajustar a descrição, a categoria e o vencimento.' : 'O principal de títulos parcelados ou com histórico de baixas é preservado. O vencimento e a descrição podem ser ajustados.'} {!title?.document_linked && !originLocked && !awaitingOrigin && 'A referência é uma anotação, sem vínculo automático com pedidos.'}</p></>}
    {mode === 'settle' && title && <><div className="real-field-wide"><Picker controller={controller} entity="accounts" label="Conta financeira" value={account} onChange={setAccount} /></div>{input('posted_on', 'Data da baixa *', { type: 'date', required: true, min: title.issued_on, maxDate: todaySP() })}{input('principal', 'Principal em reais *', { required: true })}{input('interest', 'Juros em reais')}{input('penalty', 'Multa em reais')}{input('discount', 'Desconto em reais')}{input('fee', 'Tarifa em reais')}<p className="finance-cash-preview real-field-wide" aria-live="polite">{cashPreview || `Saldo disponível para baixar: ${financeMoney(title.balance_cents)}`}</p><p className="real-help real-field-wide">O principal reduz o saldo do título. Juros e multa aumentam o valor de caixa; o desconto reduz. {title.kind === 'receivable' ? 'A tarifa reduz a entrada líquida.' : 'A tarifa aumenta a saída da conta.'}</p></>}
    {mode === 'reverse' && payment && <><dl className="finance-review real-field-wide"><div><dt>Baixa original</dt><dd>{financeDate(payment.posted_on)} · Principal {financeMoney(payment.principal_cents)}</dd></div><div><dt>Conta</dt><dd>{originalAccount}</dd></div><div><dt>Valor de caixa a estornar</dt><dd>{financeMoney(payment.net_cash_cents)}</dd></div></dl>{input('posted_on', 'Data do estorno *', { type: 'date', required: true, min: payment.posted_on, maxDate: todaySP() })}<p className="real-help real-field-wide">O estorno preserva a baixa original, desfaz seus valores na mesma conta e reabre o principal correspondente no título.</p></>}
    {mode === 'opening' && <>{input('amount', 'Saldo inicial em reais *', { required: true })}{input('posted_on', 'Data do saldo inicial *', { type: 'date', required: true, maxDate: todaySP() })}<p className="real-notice real-field-wide">Use sinal negativo para saldo devedor. Este lançamento só pode ocorrer uma vez e não pode ter data posterior a movimentos existentes na conta.</p></>}
    {['settle', 'reverse', 'opening', 'title_cancel'].includes(mode) && <Field label={mode === 'settle' ? 'Observação' : 'Justificativa *'} wide>{id => <textarea id={id} rows={3} maxLength={500} required={mode !== 'settle'} value={values.note} onChange={event => set('note', event.target.value)} />}</Field>}
    </fieldset><div className={`real-editor-actions${originSave ? ' finance-drawer-actions' : ''}`}>{originSave && <button className="text-button" type="button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Cancelar</button>}{drawer && (mode === 'title_create_group' || settleAfterAllowed) && <button className="secondary-button" type="button" disabled={busy || uncertain || awaitingOrigin || !settleAfterAllowed} title={settleAfterAllowed ? 'Salva a conta e abre a baixa em seguida' : 'Disponível para conta com parcela única'} onClick={event => prepare(event, true)}>Salvar e dar baixa</button>}<button className="primary-button" type="submit" disabled={busy || uncertain || awaitingOrigin}>{originSave ? 'Salvar' : 'Conferir operação'}</button>{!originSave && <button className="secondary-button" type="button" disabled={busy} onClick={() => guard.confirmLeave(onClose)}>Voltar sem salvar</button>}</div></form>{review && <Confirmation review={review} busy={busy} uncertain={uncertain} error={error} onBack={() => { if (uncertain) { guard.confirmLeave(onClose); return; } command.current = null; setReview(null); setError(''); }} onConfirm={() => void confirm()} />}</section>;
}

function FinancialHistory({ controller, title, account, writable, onReverse }: { controller: AccessController; title?: FinanceTitle; account?: FinanceAccount; writable: boolean; onReverse: (payment: FinanceSettlement) => void }) {
  const entity = title ? 'settlements' : 'movements'; const parent = title?.id || account!.id;
  const [page, setPage] = useState<FinancePage<FinanceSettlement | FinanceMovement> | null>(null); const [after, setAfter] = useState<string | null>(null); const [cursors, setCursors] = useState<(string | null)[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { const request = new AbortController(); setLoading(true); setPage(null); setError(''); const params = new URLSearchParams({ parent_id: parent, limit: '25' }); if (after) params.set('after', after); void controller.finance(`/v1/financeiro/${entity}?${params}`, { signal: request.signal }).then(result => { setPage(result as typeof page); setLoading(false); }).catch(failure => { if (!aborted(failure)) { setError(message(failure)); setLoading(false); } }); return () => request.abort(); }, [controller, parent, entity, after]);
  return <section className="finance-history"><h3>{title ? 'Histórico de baixas e estornos' : 'Movimentos da conta'}</h3>{error && <p className="real-alert" role="alert">{error}</p>}{loading && <p role="status">Carregando histórico…</p>}{page && <><div className="table-scroll"><table className="data-table"><thead><tr><th>Data</th><th>Operação</th>{title && <th className="numeric">Principal</th>}<th className="numeric">{title ? 'Valor de caixa' : 'Movimento'}</th><th>Observação</th>{title && <th>Ação</th>}</tr></thead><tbody>{page.items.map(item => { const payment = item as FinanceSettlement; const movement = item as FinanceMovement; return <tr key={item.id}><td>{financeDate(item.posted_on)}</td><td>{FINANCE_KIND[item.kind]}{payment.reversed ? ' · estornada' : ''}</td>{title && <td className="numeric">{financeMoney(payment.principal_cents)}</td>}<td className="numeric">{financeMoney(title ? payment.net_cash_cents : movement.delta_cents)}</td><td className="finance-history-note">{(title && payment.history) || item.note || '—'}</td>{title && <td>{writable && payment.kind === 'payment' && !payment.reversed && !title.cancelled && <button className="text-button" onClick={() => onReverse(payment)}>Estornar</button>}</td>}</tr>; })}</tbody></table></div>{!page.items.length && <p className="real-help">Nenhum movimento registrado.</p>}<PageControls page={page} loading={loading} cursors={cursors} setCursors={setCursors} after={after} setAfter={setAfter} /></>}</section>;
}

function FinanceDetail({ controller, entity, record, writable, onClose, onEdit }: { controller: AccessController; entity: FinanceEntity; record: FinanceRecord; writable: boolean; onClose: () => void; onEdit: (mode: Mode, payment?: FinanceSettlement) => void }) {
  const title = entity === 'titles' ? record as FinanceTitle : null; const account = entity === 'accounts' ? record as FinanceAccount : null; const category = entity === 'categories' ? record as FinanceCategory : null;
  const originState = useTitleOrigin(controller, title), originRef = useRef(originState); originRef.current = originState;
  return <section className="real-editor"><header className="real-editor-heading"><div><h2>{title?.description || account?.name || category?.name}</h2><p>{title ? `${FINANCE_KIND[title.kind]} · ${title.contact_name} · Parcela ${title.installment}/${title.installments}` : FINANCE_KIND[(account || category)!.kind]}</p></div><button className="secondary-button" onClick={onClose}>Voltar à listagem</button></header><dl className="finance-summary">{title ? <><div><dt>Valor original</dt><dd>{financeMoney(title.amount_cents)}</dd></div><div><dt>Principal baixado</dt><dd>{financeMoney(title.settled_cents)}</dd></div><div><dt>Saldo do título</dt><dd>{financeMoney(title.balance_cents)}</dd></div><div><dt>Vencimento</dt><dd>{financeDate(title.due_on)}</dd></div><div><dt>Situação</dt><dd><SituationBadge title={title} /></dd></div><div><dt>Categoria</dt><dd>{title.category_name || 'Sem categoria'}</dd></div><div><dt>Referência</dt><dd>{title.source_reference || '—'}</dd></div>{title.origin && <div><dt>{originText(title.origin).field}</dt><dd><Link to={originPath(title.origin)} title={originText(title.origin).menu}>{originNumber(title.origin)}</Link></dd></div>}</> :
 <><div><dt>Situação</dt><dd><SituationBadge active={(account || category)!.active} /></dd></div>{account && <><div><dt>Saldo registrado no FAGOO</dt><dd>{financeMoney(account.balance_cents)}</dd></div><div><dt>Saldo inicial</dt><dd>{account.opening_recorded ? 'Já registrado' : 'Ainda não informado'}</dd></div></>}</>}</dl>{title && <TitleOriginNotice state={originState} />}{writable && <div className="real-editor-actions">{title ? <>{!title.cancelled && <button className="secondary-button" disabled={!originState.ready} onClick={() => { if (originRef.current.ready) onEdit('title_update'); }}>Editar título</button>}{!title.cancelled && BigInt(title.balance_cents) > 0n && <button className="primary-button" onClick={() => onEdit('settle')}>Registrar baixa</button>}{!title.cancelled && title.settled_cents === '0' && <button className="danger-button" onClick={() => onEdit('title_cancel')}>Cancelar título</button>}</> : <><button className="secondary-button" onClick={() => onEdit(account ? 'account_save' : 'category_save')}>Editar {account ? 'conta' : 'categoria'}</button>{account?.active && !account.opening_recorded && <button className="primary-button" onClick={() => onEdit('opening')}>Informar saldo inicial</button>}</>}</div>}{account && <p className="real-help">Este saldo resulta dos lançamentos feitos no FAGOO. Ele não consulta o banco e não representa uma conciliação bancária.</p>}{title && <FinancialHistory key={record.id} controller={controller} title={title} writable={writable} onReverse={payment => onEdit('reverse', payment)} />}{account && <FinanceMovementHistory key={record.id} controller={controller} accountId={account.id} />}</section>;
}

// ---- Batch actions on selected contas (Origin right panel). Each item runs the existing single-title command ----
type BatchParams = { categoryId?: string; categoryName?: string; accountId?: string; accountName?: string; postedOn?: string; note?: string };
type BatchCommand = { id: string; path: string; body: { data: Record<string, unknown> } };
type PendingItem = TitleBatchItem & { command: BatchCommand };
type BatchState = { scope: string; action: TitleBatchAction; titles: FinanceTitle[]; step: 'params' | 'run'; params: BatchParams; plan: BatchPlan<TitleBatchItem> | null; recovery: PendingItem[] | null };
const BATCH_ICON: Record<TitleBatchAction, string> = { settle: 'check-circle', category: 'bookmark', cancel: 'ban', delete: 'trash-can' };
/** Keeps the global leave guard busy while a batch runs or has results to confirm. */
function BatchGuard({ busy }: { busy: boolean }) { useUnsavedChanges(false, busy); return null; }
function FinanceBatchParams({ controller, action, kind, count, onCancel, onContinue }: { controller: AccessController; action: TitleBatchAction; kind: FinanceKind; count: number; onCancel: () => void; onContinue: (params: BatchParams) => void }) {
  const [category, setCategory] = useState<Reference | null>(null), [account, setAccount] = useState<Reference | null>(null), [postedOn, setPostedOn] = useState(todaySP()), [note, setNote] = useState(''), [error, setError] = useState('');
  const next = () => {
    try {
      if (action === 'category') { if (!category) throw new Error('Selecione a categoria.'); onContinue({ categoryId: category.id, categoryName: category.name }); return; }
      if (action === 'settle') { if (!account) throw new Error('Selecione uma conta financeira ativa.'); postingDate(postedOn); onContinue({ accountId: account.id, accountName: account.name, postedOn, note: note.trim() }); return; }
      if (!note.trim()) throw new Error('Informe o motivo do cancelamento.'); onContinue({ note: note.trim() });
    } catch (failure) { setError(message(failure)); }
  };
  return <Modal title={TITLE_BATCH_LABEL[action]} onClose={onCancel} actions={<><button type="button" className="secondary-button" onClick={onCancel}>Cancelar</button><button type="button" className="primary-button" onClick={next}>Continuar</button></>}>
    <div className="finance-batch-params">
      <p>{count === 1 ? '1 conta selecionada.' : `${count} contas selecionadas.`} Na próxima etapa você confere cada conta antes de confirmar.</p>
      {action === 'category' && <Picker controller={controller} entity="categories" label="Categoria" kind={kind} value={category} onChange={setCategory} />}
      {action === 'settle' && <><Picker controller={controller} entity="accounts" label="Conta financeira" value={account} onChange={setAccount} /><Field label="Data da baixa *">{id => <input id={id} type="date" required max={todaySP()} value={postedOn} onChange={event => setPostedOn(event.target.value)} />}</Field><Field label="Observação" wide>{id => <textarea id={id} rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} />}</Field><p className="real-help">Cada conta é baixada pelo saldo em aberto, sem juros, multa, desconto ou tarifa. Para outros valores, use a baixa parcial da conta.</p></>}
      {action === 'cancel' && <><Field label="Justificativa *" wide>{id => <textarea id={id} rows={3} maxLength={500} required value={note} onChange={event => setNote(event.target.value)} />}</Field><p className="real-help">Somente contas sem baixa são canceladas. O cancelamento não movimenta caixa nem banco.</p></>}
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  </Modal>;
}
function batchDescription(state: BatchState) {
  if (state.recovery) return <p className="real-notice">Cada conta é enviada de novo com o mesmo comando. O que já foi registrado não é repetido.</p>;
  if (state.action === 'settle') return <dl className="finance-review"><div><dt>Conta financeira</dt><dd>{state.params.accountName}</dd></div><div><dt>Data da baixa</dt><dd>{financeDate(state.params.postedOn || '')}</dd></div><div><dt>Total baixado</dt><dd>{financeMoney(state.plan ? batchBalance(state.plan) : '0')}</dd></div></dl>;
  if (state.action === 'category') return <dl className="finance-review"><div><dt>Nova categoria</dt><dd>{state.params.categoryName}</dd></div></dl>;
  if (state.action === 'delete') return <><p><strong>{state.titles.length === 1 ? 'Deseja mesmo excluir esta conta?' : 'Deseja mesmo excluir as contas selecionadas?'}</strong></p><p className="real-help">A conta sai das listagens e dos totais. O registro e a auditoria continuam guardados. Contas com baixa, boleto ou documento de origem não são excluídas.</p></>;
  return <dl className="finance-review"><div><dt>Motivo</dt><dd>{state.params.note}</dd></div><div><dt>Efeito</dt><dd>Cancela cada conta, sem movimentar caixa ou banco.</dd></div></dl>;
}
// SQL 210: Tipo de pagamento, Forma de pagamento and Vendedor (contas a receber) join the Origin filters.
type FilterDraft = { option: FinanceTitleOption; status: string[]; date: FinanceDateField; categories: string[]; remittance: '' | 'yes' | 'no'; value: string; doc: string; paymentType: string; paymentMethod: string; seller: SellerOption | null };
const draftFilters = (value: FinanceListRoute, sellerName?: string | null): FilterDraft => ({ option: value.option, status: routeStatuses(value), date: value.date, categories: routeCategories(value), remittance: value.remittance, value: value.value ? centsInput(value.value) : '', doc: value.doc,
  paymentType: value.paymentType ?? '', paymentMethod: value.paymentMethod ?? '', seller: value.seller ? { id: value.seller, name: sellerName || 'Vendedor selecionado' } : null });
const CHIP_RESET: Record<TitleChipKey, Partial<FinanceListRoute>> = { q: { q: '' }, option: { option: 'open', status: '', date: 'due', remittance: '' }, status: { status: '' }, date: { date: 'due' }, account: { account: '' }, category: { category: '' }, remittance: { remittance: '' }, value: { value: '' }, doc: { doc: '' },
  payment_type: { paymentType: '' }, payment_method: { paymentMethod: '' }, seller: { seller: '' } };
type MethodOption = { id: string; description: string };
// "Listagem customizada": the optional columns are remembered for the user in this browser.
const columnsKey = (kind: FinanceKind, actor: string) => `brufap.finance.columns.${kind}.${actor}`;
function storedColumns(kind: FinanceKind, actor: string): { view: 'padrao' | 'customizada'; columns: TitleColumn[] } {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(columnsKey(kind, actor)) ?? 'null') as { view?: unknown; columns?: unknown } | null;
    if (value && (value.view === 'padrao' || value.view === 'customizada') && Array.isArray(value.columns)) return { view: value.view, columns: customColumns(kind, value.columns.filter((item): item is string => typeof item === 'string')) };
  } catch { /* Browser storage is a convenience only. */ }
  return { view: 'padrao', columns: [...DEFAULT_CUSTOM_COLUMNS] };
}
function storeColumns(kind: FinanceKind, actor: string, value: { view: 'padrao' | 'customizada'; columns: TitleColumn[] }) { try { globalThis.localStorage?.setItem(columnsKey(kind, actor), JSON.stringify(value)); } catch { /* Ignored: the list keeps working. */ } }
const NUMERIC_COLUMNS: readonly TitleColumn[] = ['fee', 'net', 'interest', 'additions', 'discounts', 'balance'];
/**
 * Informações visíveis / Colunas customizadas (Origin): the optional columns with the alça (or ↑ ↓) to reorder and the switch;
 * Cliente/Fornecedor, Valor and Situação stay fixed around them. The chosen order is the order of the listagem.
 */
function ColumnsDialog({ kind, chosen, onCancel, onApply }: { kind: FinanceKind; chosen: readonly TitleColumn[]; onCancel: () => void; onApply: (columns: TitleColumn[]) => void }) {
  return <ListColumnsPanel columns={titleColumnOptions(kind).map(column => ({ id: column.id, label: column.id === 'net' ? `${column.label} (valor menos taxas e tarifas)` : column.label }))} selected={chosen} onCancel={onCancel} onApply={columns => onApply(customColumns(kind, columns))} />;
}
const isUuid = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export default function RealFinance({ controller, initialTab = 'receivable' }: { controller: AccessController; initialTab?: 'receivable' | 'payable' | 'accounts' | 'categories' }) {
  const location = useLocation(), navigate = useNavigate();
  const route = useMemo(() => { try { return { value: financeListRoute(new URLSearchParams(location.search), initialTab), error: '' }; }
    catch (error) { return { value: emptyFinanceRoute(initialTab), error: (error as Error).message }; } }, [location.search, initialTab]);
  const sessionTracked=typeof controller.getSnapshot==='function',session=useSyncExternalStore(controller.subscribe??noFinanceSubscription,controller.getSnapshot??noFinanceSnapshot);
  const actor=financeLinkActor(session),sessionAllowed=!sessionTracked||actor!==null,authScope=sessionTracked?`${actor??''}:${session?.phase??''}:${session?.membership?.role??''}`:'isolated';
  const controllerScope=useRef(controller);controllerScope.current=controller;
  const routeKey = `${location.key}:${location.pathname}:${location.search}:${initialTab}:${sessionTracked?session?.membership?.user_id??'no-actor':'isolated'}`, activeScope = useRef(routeKey); activeScope.current = routeKey;
  const mayRead=()=>sessionAllowed&&controllerScope.current===controller&&activeScope.current===routeKey&&(!sessionTracked||financeLinkActor(controller.getSnapshot())===actor);
  const permissionScope=useRef('');
  const { area: tab, q: query } = route.value;
  const [filterDraft, setFilterDraft] = useState<FilterDraft>(() => draftFilters(route.value)), [draft, setDraft] = useState(query);
  const [permissions, setPermissions] = useState<FinanceAccess | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const permissionsRef = useRef(permissions); permissionsRef.current = permissions;
  const [pagination, setPagination] = useState<{ scope: string; after: string | null; cursors: (string | null)[] }>({ scope: routeKey, after: null, cursors: [] });
  const after = pagination.scope === routeKey ? pagination.after : null, cursors = pagination.scope === routeKey ? pagination.cursors : [];
  const setAfter = (value: string | null) => setPagination(previous => ({ scope: routeKey, after: value, cursors: previous.scope === routeKey ? previous.cursors : [] }));
  const setCursors = (value: (string | null)[]) => setPagination(previous => ({ scope: routeKey, after: previous.scope === routeKey ? previous.after : null, cursors: value }));
  const listKey = `${routeKey}:${after ?? ''}:${reload}`;
  const [list, setList] = useState<{ key: string; page: FinancePage | null; titles: FinanceTitlePage | null; loading: boolean }>({ key: '', page: null, titles: null, loading: true });
  const page = list.key === listKey ? list.page : null, titlesPage = list.key === listKey ? list.titles : null, loading = !route.error && (list.key !== listKey || list.loading);
  type View = { scope: string; record: FinanceRecord | null; editor: { mode: Mode; payment?: FinanceSettlement; partial?: boolean; clone?: FinanceTitle } | null; id: string | null; loading: boolean; error: string };
  const [view, setView] = useState<View>({ scope: routeKey, record: null, editor: null, id: null, loading: false, error: '' });
  const viewRef = useRef(view); viewRef.current = view;
  const [transferScope, setTransferScope] = useState<string | null>(null), transferScopeRef = useRef<string | null>(null);
  const transfersOpen = transferScope === routeKey && tab === 'accounts';
  const record = view.scope === routeKey ? view.record : null, editor = view.scope === routeKey ? view.editor : null;
  const detail = view.scope === routeKey && view.id !== null && !record ? view : null, detailRequest = useRef<AbortController | null>(null);
  const entity = financeListEntity(tab), kind: FinanceKind = tab === 'payable' ? 'payable' : 'receivable';
  // Origin list state of contas: selection (Shift + clique), row ⋮, batches and their unconfirmed results.
  const [selection, setSelection] = useState<{ scope: string; ids: string[]; anchor: string | null }>({ scope: '', ids: [], anchor: null });
  const [rowMenu, setRowMenu] = useState<{ scope: string; id: string } | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null), [batchRunning, setBatchRunning] = useState(false);
  const [settleSelection, setSettleSelection] = useState<{ scope: string; titles: FinanceTitle[] } | null>(null);
  const [share, setShare] = useState<WhatsappShare | null>(null);
  const [printJob, setPrintJob] = useState<{ scope: string; print: FinancePrint } | null>(null), [printMenu, setPrintMenu] = useState(false), [printNotes, setPrintNotes] = useState(false);
  const [pending, setPending] = useState<{ scope: string; owner: string; action: TitleBatchAction; items: PendingItem[] } | null>(null);
  const owner = sessionTracked ? actor ?? '' : 'isolated';
  const uncertain = useRef(new Map<string, PendingItem>());
  const [categoriesWanted, setCategoriesWanted] = useState(false), [categoryRetry, setCategoryRetry] = useState(0);
  const categoryKey = entity === 'titles' && permissions && (categoriesWanted || routeCategories(route.value).some(isUuid)) ? `${authScope}:${tab}:${categoryRetry}` : '';
  // Categoria filter (SQL 135): the tree of the tab, loaded on first use or when the URL already filters by one.
  const categoryOptions = useCategoryTree(categoryKey ? (path, options) => controller.finance(path, options) : null, kind, categoryKey);
  // Preferências > Finanças (applied): default of "Utilizar data de vencimento" in the baixa of contas a receber.
  const financePreferences = useFinancePreferences(controller, entity === 'titles' && permissions ? `${authScope}:${kind}` : '', kind);
  // Opening the filter again after a failed load really retries it, as the error message says.
  const [accountOptions, setAccountOptions] = useState<{ key: string; items: ReferenceOption[]; error: string }>({ key: '', items: [], error: '' });
  const accountKey = entity === 'titles' && permissions && !route.value.titleId && !route.error ? `${authScope}:${tab}` : '';
  const [methodOptions, setMethodOptions] = useState<{ key: string; items: MethodOption[]; error: string }>({ key: '', items: [], error: '' });
  // Loaded on first use of the Forma de pagamento filter, or when the URL already filters by a forma.
  const [methodsWanted, setMethodsWanted] = useState(false);
  const methodKey = accountKey && (methodsWanted || route.value.paymentMethod) ? accountKey : '', sellerNames = useRef(new Map<string, string>());
  const [columnState, setColumnState] = useState<{ key: string; view: 'padrao' | 'customizada'; columns: TitleColumn[] }>({ key: '', view: 'padrao', columns: [...DEFAULT_CUSTOM_COLUMNS] });
  const [columnsOpen, setColumnsOpen] = useState(false);
  // Listagem customizada: the columns and the padrão/customizada choice are saved per user on the server (SQL 116), with "Conferir resultado".
  const listPreferencesOn = entity === 'titles' && Boolean(permissions) && typeof controller.listPreferences === 'function' && typeof controller.getSnapshot === 'function' && typeof controller.subscribe === 'function';
  const listPort = useMemo<ListPreferencesPort>(() => listPreferencesOn ? controller as unknown as ListPreferencesPort : LIST_PREFERENCES_OFF, [controller, listPreferencesOn]);
  const listPrefs = useListPreferences(listPort, TITLE_LIST_PREFERENCE[kind], { available: TITLE_COLUMNS.map(item => item.id), defaults: DEFAULT_CUSTOM_COLUMNS });
  // "Estornar" inside the drawer replaces it: the drawer's draft or pending save goes through the leave guard first.
  const leaveGuard = useUnsavedChangesGuard();
  const wantCategories = () => { setCategoriesWanted(true); if (categoryKey && categoryOptions.error) setCategoryRetry(value => value + 1); };
  useEffect(() => { const request = new AbortController(); permissionScope.current='';setPermissions(null);if(!sessionAllowed)return; void controller.finance('/v1/financeiro', { signal: request.signal }).then(result => { if (request.signal.aborted||controllerScope.current!==controller||sessionTracked&&financeLinkActor(controller.getSnapshot())!==actor) return; const access = result as FinanceAccess; if (access.data_mode !== 'erp_native' || access.read !== true || typeof access.write !== 'boolean') throw new Error('Acesso financeiro indisponível.'); permissionScope.current=authScope;setPermissions(access); }).catch(failure => { if (!request.signal.aborted && !aborted(failure)&&controllerScope.current===controller&&(!sessionTracked||financeLinkActor(controller.getSnapshot())===actor)) { setError(message(failure)); setList({ key: listKey, page: null, titles: null, loading: false }); } }); return () => { request.abort(); detailRequest.current?.abort(); }; }, [controller,authScope]);
  useEffect(() => {
    // Runs only after the router commits navigation; the global guard retains drafts until then.
    detailRequest.current?.abort(); detailRequest.current = null;
    transferScopeRef.current = null; setTransferScope(null);
    setView({ scope: routeKey, record: null, editor: null, id: null, loading: false, error: '' });
    setDraft(query); setFilterDraft(draftFilters(route.value, route.value.seller ? sellerNames.current.get(route.value.seller) : null)); setNotice(''); setError(''); setRowMenu(null); setBatch(null); setBatchRunning(false);
  }, [routeKey]);
  useEffect(() => {
    if (!permissions || permissionScope.current!==authScope || route.error || route.value.titleId || !mayRead()) return;
    // SQL 246: without the Contas a Receber / Contas a Pagar permission the server refuses the list; say why instead of asking.
    if (entity === 'titles' && !financePermitted(permissions, titlePermission(kind))) { setList({ key: listKey, page: null, titles: null, loading: false }); setError(`Seu usuário não tem a permissão ${kind === 'receivable' ? 'Contas a Receber' : 'Contas a Pagar'} (Sistema › Usuários › Permissões › Finanças).`); return; }
    const request = new AbortController(); setList({ key: listKey, page: null, titles: null, loading: true }); setError('');
    const titles = entity === 'titles';
    const day = todaySP();
    void controller.finance(titles ? financeTitlePageApiPath(route.value, day) : financeListApiPath(route.value, after), { signal: request.signal }).then(result => { if (!request.signal.aborted && mayRead()) setList(titles ? { key: listKey, page: null, titles: financeTitlePage(result, route.value, day), loading: false } : { key: listKey, page: financeListPage(result, route.value, after), titles: null, loading: false }); }).catch(failure => { if (!request.signal.aborted && !aborted(failure) && mayRead()) { setError(message(failure)); setList({ key: listKey, page: null, titles: null, loading: false }); } }); return () => request.abort();
  }, [controller, permissions, route, routeKey, after, listKey]);
  useEffect(() => {
    // Options of the Origin selector "Todas as contas financeiras", up to 500 contas.
    if (!accountKey) return; const request = new AbortController(); setAccountOptions({ key: accountKey, items: [], error: '' });
    void loadReferenceOptions((path, options) => controller.finance(path, options), 'accounts', request.signal)
      .then(items => { if (!request.signal.aborted && mayRead()) setAccountOptions({ key: accountKey, items, error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setAccountOptions({ key: accountKey, items: [], error: 'Não foi possível carregar as contas financeiras.' }); });
    return () => request.abort();
  }, [controller, accountKey]);
  useEffect(() => {
    // Forma de pagamento filter (SQL 175/210): the formas applicable to the kind, as the gaveta offers them.
    if (!methodKey) return; const request = new AbortController(); setMethodOptions({ key: methodKey, items: [], error: '' });
    void controller.finance(`/v1/financeiro/formas-pagamento?kind=${kind}`, { signal: request.signal }).then(value => {
      const items = (value as { items?: unknown })?.items;
      if (!Array.isArray(items) || items.some(item => !item || typeof (item as MethodOption).id !== 'string' || typeof (item as MethodOption).description !== 'string')) throw new Error('invalid');
      if (!request.signal.aborted && mayRead()) setMethodOptions({ key: methodKey, items: (items as MethodOption[]).map(item => ({ id: item.id, description: item.description })), error: '' });
    }).catch(failure => { if (!request.signal.aborted && !aborted(failure)) setMethodOptions({ key: methodKey, items: [], error: 'Não foi possível carregar as formas de pagamento.' }); });
    return () => request.abort();
  }, [controller, methodKey]);
  const columnKey = entity === 'titles' ? `${kind}:${owner}` : '';
  useEffect(() => { if (columnKey) setColumnState({ key: columnKey, ...storedColumns(kind, owner) }); }, [columnKey]);
  const close = () => { if (!mayRead()||transferScopeRef.current === activeScope.current) return; detailRequest.current?.abort(); detailRequest.current = null; if(route.value.titleId){const {titleId,...filters}=route.value;navigate(`${location.pathname}?${financeListParams(filters)}`);return;}setView({ scope: routeKey, record: null, editor: null, id: null, loading: false, error: '' }); };
  // Every row action and "Salvar e dar baixa" reads the title again, so the editor starts from its current version.
  const open = async (id: string, then?: { mode: Mode; partial?: boolean }) => {
    if (route.error || !permissions?.read || permissionScope.current!==authScope || !mayRead() || transferScopeRef.current === activeScope.current) return; detailRequest.current?.abort(); const request = new AbortController(); detailRequest.current = request; setError(''); setRowMenu(null);
    setView({ scope: routeKey, record: null, editor: null, id, loading: true, error: '' });
    try { const response = await controller.finance(`/v1/financeiro/${entity}/${id}`, { signal: request.signal });
      if (!request.signal.aborted && detailRequest.current === request && mayRead()) {
        const loaded = financeDetailRecord(response, entity, id, tab);
        const clone = then?.mode === 'title_create_group';
        const writer = entity === 'titles' && permissionsRef.current?.write && permissionScope.current === authScope;
        // As in Origin, opening a conta (row click or link) edits it; the drawer then keeps its draft like any editor.
        const wanted = then ?? (writer && financePermitted(permissionsRef.current, titlePermission(kind, 'ie')) && titleAllows(loaded as FinanceTitle, 'title_update') ? { mode: 'title_update' as Mode } : undefined);
        const edit = wanted && writer && (clone || titleAllows(loaded as FinanceTitle, wanted.mode)) ? { mode: wanted.mode, ...(wanted.partial ? { partial: true } : {}), ...(clone ? { clone: loaded as FinanceTitle } : {}) } : null;
        // "Clonar" starts a new conta: the source is only the prefill, never the record being edited.
        setView({ scope: routeKey, record: clone && edit ? null : loaded, editor: edit, id: clone && edit ? null : id, loading: false, error: '' });
      }
    } catch (failure) { if (!request.signal.aborted && !aborted(failure) && mayRead()) setView({ scope: routeKey, record: null, editor: null, id, loading: false, error: message(failure) }); }
    finally { if (detailRequest.current === request) detailRequest.current = null; }
  };
  useEffect(()=>{if(!route.value.titleId||route.error||!permissions?.read||permissionScope.current!==authScope||!mayRead()||viewRef.current.scope===routeKey&&viewRef.current.editor)return;void open(route.value.titleId);return()=>{detailRequest.current?.abort();};},[controller,routeKey,permissions]);
  const tabLabels: Record<string, string> = { receivable: 'Contas a receber', payable: 'Contas a pagar', accounts: 'Caixas e Bancos', categories: 'Categorias Financeiras' };
  const go = (params: URLSearchParams) => { if (`?${params}` === location.search) { setPagination({ scope: routeKey, after: null, cursors: [] }); setReload(value => value + 1); } else navigate(`${location.pathname}?${params}`); };
  const changeTab = (value: string) => go(financeListParams(emptyFinanceRoute(value as FinanceArea)));
  const apply = (event: FormEvent) => {
    event.preventDefault();
    try {
      const base = { ...emptyFinanceRoute(tab), q: draft.trim() };
      const fields = panelFields(filterDraft.option, kind), value = filterDraft.value.trim() ? moneyInput(filterDraft.value) : '';
      if (filterDraft.categories.length > 50) throw new Error('Selecione até 50 categorias (as subcategorias contam).');
      if (value === '0') throw new Error('Informe um valor maior que zero.');
      go(financeListParams(entity === 'titles' ? { ...base, option: filterDraft.option, status: fields.status ? statusParam(filterDraft.status) : '', from: route.value.from, to: route.value.to,
        date: fields.date ? filterDraft.date : optionDate(filterDraft.option, 'due'), account: route.value.account, category: categoryParam(filterDraft.categories),
        remittance: fields.remittance ? filterDraft.remittance : '', value, doc: fields.document ? filterDraft.doc.trim() : '', order: route.value.order,
        paymentType: filterDraft.paymentType, paymentMethod: filterDraft.paymentMethod, seller: fields.seller ? filterDraft.seller?.id ?? '' : '' } : base));
    }
    catch (failure) { setError((failure as Error).message); }
  };
  const clear = () => { setDraft(''); setFilterDraft(draftFilters(emptyFinanceRoute(tab))); setError(''); go(financeListParams(emptyFinanceRoute(tab))); };
  // Any filter change returns to the first page, as in Origin; the page buttons pass their own number.
  const applyFilters = (next: Partial<FinanceListRoute>) => { try { const { titleId, ...filters } = route.value; go(financeListParams({ ...filters, page: 1, ...next })); } catch (failure) { setError((failure as Error).message); } };
  // Origin rows: a click anywhere opens the record; Ctrl/Cmd + click or middle click opens the title deep link (titulo=) in a new tab.
  const openRow = (id: string, event?: { ctrlKey?: boolean; metaKey?: boolean; button?: number }) => {
    if (entity === 'titles' && event && opensInNewTab(event)) {
      if (route.error || !permissions?.read || permissionScope.current !== authScope || !mayRead()) return;
      try { const { titleId, ...filters } = route.value; window.open(`${location.pathname}?${financeListParams({ ...filters, titleId: id })}`, '_blank', 'noopener'); } catch (failure) { setError((failure as Error).message); }
      return;
    }
    void open(id);
  };
  const titleRows = entity === 'titles' && titlesPage ? titlesPage.items : [];
  const selectedIds = selection.scope === routeKey ? selection.ids : [], selectedTitles = titleRows.filter(title => selectedIds.includes(title.id));
  const canBatch = entity === 'titles' && Boolean(permissions?.write) && permissionScope.current === authScope;
  // Unconfirmed batch results belong to their actor: shown only in the same session state, guarded while that actor stays.
  const pendingOwned = pending && pending.owner === owner ? pending : null, pendingVisible = pendingOwned && pendingOwned.scope === authScope && sessionAllowed ? pendingOwned : null;
  const batchVisible = batch && batch.scope === routeKey ? batch : null;
  const mayWrite = () => mayRead() && permissionScope.current === authScope && permissionsRef.current?.write === true;
  const toggleRow = (id: string, shift: boolean) => { const result = selectRange(titleRows.map(title => title.id), new Set(selectedIds), selection.scope === routeKey ? selection.anchor : null, id, shift); setSelection({ scope: routeKey, ids: [...result.selected], anchor: result.anchor }); };
  const allSelected = titleRows.length > 0 && selectedTitles.length === titleRows.length;
  const toggleAll = () => setSelection({ scope: routeKey, ids: allSelected ? [] : titleRows.map(title => title.id), anchor: null });
  const rowAction = (title: FinanceTitle, action: TitleRowAction) => { setRowMenu(null); if (action === 'reverse') { void open(title.id); return; }
    if (action === 'clone') { void open(title.id, { mode: 'title_create_group' }); return; }
    if (action === 'delete') { startBatch('delete', [title]); return; } void open(title.id, { mode: action === 'edit' ? 'title_update' : action === 'cancel' ? 'title_cancel' : 'settle', partial: action === 'settle_partial' }); };
  // One request per conta with its own command_id and the version shown in the list; unknown outcomes stay for "Conferir resultado".
  // As in the single editor, a conta already "a conferir" leaves that state only when a replay confirms it: a known error on
  // the replay (for example 403 after a role change) does not prove that the first send was not registered.
  const sendBatch = async (item: TitleBatchItem, command: BatchCommand) => {
    const replay = uncertain.current.has(item.id);
    if (!mayWrite()) {
      if (replay) return { uncertain: true, message: 'Seu acesso a esta operação foi alterado. A conta não foi reenviada e o envio anterior continua sem confirmação.' };
      throw new Error('Seu acesso a esta operação foi alterado. Esta conta não foi enviada.');
    }
    setBatchRunning(true);
    try { await controller.finance(command.path, { method: 'POST', body: { ...command.body, command_id: command.id } }); uncertain.current.delete(item.id); }
    catch (failure) {
      const known = failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known && !replay) throw new Error(message(failure));
      uncertain.current.set(item.id, { ...item, command });
      return { uncertain: true, message: known ? `${message(failure)} O envio anterior continua sem confirmação: confira a conta antes de repetir.` : 'Resultado não confirmado. Use “Conferir resultado” para repetir a mesma operação; ela não será duplicada.' };
    }
  };
  const runBatchItem = (state: BatchState) => (item: TitleBatchItem) => {
    const recovered = state.recovery?.find(entry => entry.id === item.id);
    if (recovered) return sendBatch(recovered, recovered.command);
    const { action, data } = titleBatchCommand(state.action, item.title, state.params);
    return sendBatch(item, { id: crypto.randomUUID(), path: `/v1/financeiro/actions/${action}`, body: { data } });
  };
  const startBatch = (action: TitleBatchAction, only?: FinanceTitle[]) => {
    const titles = only ?? selectedTitles;
    if (!canBatch || !mayWrite() || !titles.length || pendingVisible || batchVisible || activeScope.current !== routeKey) return;
    setRowMenu(null); setNotice('');
    // Baixar selecionados opens the Origin "Baixa de lançamentos" with one line per conta (one settle_batch command).
    if (action === 'settle') { setSettleSelection({ scope: routeKey, titles }); return; }
    // Excluir has no parameters: Origin confirms "Deseja mesmo excluir esta conta?" before running.
    if (action === 'delete') { uncertain.current = new Map(); setBatch({ scope: routeKey, action, titles, step: 'run', params: {}, plan: planTitleBatch(action, titles, {}), recovery: null }); return; }
    setBatch({ scope: routeKey, action, titles, step: 'params', params: {}, plan: null, recovery: null });
  };
  const continueBatch = (params: BatchParams) => { uncertain.current = new Map(); setBatch(previous => previous && previous.scope === routeKey && previous.step === 'params' ? { ...previous, step: 'run', params, plan: planTitleBatch(previous.action, previous.titles, params) } : previous); };
  const recoverBatch = () => {
    if (!pendingVisible || batchVisible || !mayWrite()) return;
    uncertain.current = new Map(pendingVisible.items.map(item => [item.id, item]));
    setBatch({ scope: routeKey, action: pendingVisible.action, titles: [], step: 'run', params: {}, plan: { eligible: pendingVisible.items, skipped: [] }, recovery: pendingVisible.items });
  };
  const finishBatch = (state: BatchState, results: BatchResult[] | null) => {
    setBatch(null); setBatchRunning(false);
    if (results === null) return;
    const left = [...uncertain.current.values()];
    setPending(left.length ? { scope: authScope, owner, action: state.action, items: left } : null);
    setSelection({ scope: '', ids: [], anchor: null });
    setNotice(`${state.recovery ? 'Conferir resultado' : TITLE_BATCH_LABEL[state.action]}: ${batchSummaryText(summarizeBatch(results))}.`);
    setReload(value => value + 1);
  };
  const today = todaySP();
  const searchPlaceholder = entity === 'titles' ? titleSearchPlaceholder(kind) : entity === 'accounts' ? 'Pesquisa por nome' : 'Pesquise por nome da categoria..';
  const includeLabel = entity === 'titles' ? 'Incluir conta' : entity === 'accounts' ? 'Incluir conta financeira' : 'Incluir categoria';
  const countLabel = entity === 'titles' ? `Quantidade de contas a ${kind === 'receivable' ? 'receber' : 'pagar'}` : entity === 'accounts' ? 'Quantidade de contas financeiras' : 'Quantidade de categorias';
  const categoryChoices = categoryOptions.items;
  const categoryNames = new Map<string, string>([...titleRows.filter(item => item.category_id && item.category_name).map(item => [item.category_id!, item.category_name!] as [string, string]), ...categoryChoices.map(item => [item.id, item.name] as [string, string])]);
  const accountChoices = accountOptions.key === accountKey ? accountOptions.items : [];
  const accountName = route.value.account && route.value.account !== 'none' ? accountChoices.find(item => item.id === route.value.account)?.name ?? titleRows.find(item => item.account_id === route.value.account)?.account_name ?? null : null;
  // Origin selector: names must be unique to map back to the conta financeira.
  const accountSelector = (() => { const seen = new Map<string, number>(), options: { label: string; value: string }[] = [{ label: ACCOUNT_ALL, value: '' }, { label: ACCOUNT_NONE, value: 'none' }];
    for (const item of accountChoices.filter(item => item.active || item.id === route.value.account)) { const count = (seen.get(item.name) ?? 0) + 1; seen.set(item.name, count); options.push({ label: count > 1 ? `${item.name} (${count})` : item.name, value: item.id }); }
    if (route.value.account && route.value.account !== 'none' && !options.some(option => option.value === route.value.account)) options.push({ label: accountName ?? 'Conta financeira selecionada', value: route.value.account });
    return options; })();
  const accountLabel = accountSelector.find(option => option.value === route.value.account)?.label ?? ACCOUNT_ALL;
  // Names of the Forma de pagamento and of the Vendedor of the applied filters: the options, else a row of the filtered page.
  const methodChoices = methodOptions.key === methodKey ? methodOptions.items : [];
  const methodName = route.value.paymentMethod ? methodChoices.find(item => item.id === route.value.paymentMethod)?.description ?? titleRows.find(item => item.payment_method_id === route.value.paymentMethod)?.payment_method_name ?? null : null;
  const sellerName = route.value.seller ? sellerNames.current.get(route.value.seller) ?? titleRows.find(item => item.seller_id === route.value.seller)?.seller_name ?? null : null;
  if (route.value.seller && sellerName) sellerNames.current.set(route.value.seller, sellerName);
  const chips = entity === 'titles' ? titleChips(route.value, kind, { account: accountName, categories: categoryNames, paymentMethod: methodName, seller: sellerName }).map(chip => ({ label: chip.label, onRemove: () => applyFilters(CHIP_RESET[chip.key]) })) : query ? [{ label: `Pesquisa: ${query}`, onRemove: () => applyFilters({ q: '' }) }] : [];
  const pages = titlesPage ? Math.max(1, Math.ceil(titlesPage.total / FINANCE_TITLE_PAGE_SIZE)) : 1;
  // A page beyond the last one (records removed meanwhile) moves to the current last page.
  // It replaces the history entry, so Back does not return to the empty page and bounce forward again.
  useEffect(() => {
    if (entity !== 'titles' || !titlesPage || titlesPage.items.length || route.value.page <= pages || !mayRead()) return;
    try { const { titleId, ...filters } = route.value; navigate(`${location.pathname}?${financeListParams({ ...filters, page: pages })}`, { replace: true }); } catch (failure) { setError((failure as Error).message); }
  }, [titlesPage]);
  const showTransfers = () => {
    const current = viewRef.current;
    if (activeScope.current !== routeKey || tab !== 'accounts' || !permissions?.read || current.scope === routeKey && (current.record || current.editor || current.id) || transferScopeRef.current === routeKey) return;
    detailRequest.current?.abort(); detailRequest.current = null; transferScopeRef.current = routeKey; setTransferScope(routeKey);
  };
  const menuItems = (title: FinanceTitle): RowMenuItem[] => {
    const items: RowMenuItem[] = titleRowActions(title, Boolean(permissions?.write) && permissionScope.current === authScope, action => financePermitted(permissions, titlePermission(title.kind, action))).map(entry => ({ label: entry.label, icon: entry.icon, onClick: () => rowAction(title, entry.action) }));
    // Origin: contas with boleto offer "Enviar por whatsapp" (wa.me with the celular of the contato; no API). Leva H (FIN-044): only an
    // existing valid cobrança (the remessa file generated), after the user reviews the recipient and the text.
    if (shareableCharge(title as FinanceTitleRow)) { const at = items.findIndex(item => item.label === 'Clonar' || item.label === 'Excluir');
      items.splice(at < 0 ? items.length : at, 0, { label: 'Enviar por whatsapp', icon: 'comments', onClick: () => void sendWhatsapp(title) }); }
    // Leva H (FIN-052): the boleto entries by the real situation of the conta and of its cobrança.
    { const boleto = boletoMenu(title as FinanceTitleRow, Boolean(permissions?.write) && financePermitted(permissions, 'financas.remessas.ie')); if (boleto.length) { const at = items.findIndex(item => item.label === 'Clonar' || item.label === 'Excluir');
      items.splice(at < 0 ? items.length : at, 0, ...boleto); } }
    // Origin order: the print item comes after the baixas and Cancelar, before Clonar and Excluir.
    // A cancelled (or excluded) conta never gets a recibo; a conta a pagar gets the comprovante only after a baixa.
    if (!title.cancelled && !title.deleted_at && (title.kind === 'receivable' || title.settled_cents !== '0')) { const at = items.findIndex(item => item.label === 'Clonar' || item.label === 'Excluir');
      items.splice(at < 0 ? items.length : at, 0, { label: title.kind === 'receivable' ? 'Imprimir recibo' : 'Imprimir comprovante', icon: 'print', onClick: () => startPrint({ mode: 'receipts', source: { kind: 'rows', rows: [title as FinanceTitleRow] } }) }); }
    // "Imprimir duplicata": the models of Preferências > Finanças "Habilitar tipo de título de crédito para impressão".
    if (title.kind === 'receivable' && !title.cancelled && !title.deleted_at) { const at = items.findIndex(item => item.label === 'Clonar' || item.label === 'Excluir');
      items.splice(at < 0 ? items.length : at, 0, { label: 'Imprimir duplicata', icon: 'file-invoice', onClick: () => startPrint({ mode: 'credit', models: creditModels(financePreferences.values['financas.receber_titulo_credito']), source: { kind: 'rows', rows: [title as FinanceTitleRow] } }) }); }
    // "Acessar remessa" (SQL 213): the remessa of the boleto of this conta, in the Origin list of Remessas.
    const remittance = (title as FinanceTitleRow).remittance;
    if (remittance) { const at = items.findIndex(item => item.label === 'Clonar' || item.label === 'Excluir'); items.splice(at < 0 ? items.length : at, 0, { label: 'Acessar remessa', icon: 'file-export', to: remittancePath(remittance.id) }); }
    // Recebida/Paga (or with a baixa): "Gerenciar recebimentos / pagamentos" shows the borderôs of this conta.
    if (title.settled_cents !== '0') items.unshift({ label: borderoMenuLabel(title.kind), icon: 'eye', to: borderoPath(title.kind, title.id) });
    if (title.origin) items.push({ label: originText(title.origin).menu, icon: 'arrow-up-right-from-square', to: originPath(title.origin), separatorBefore: items.length > 0 });
    return items;
  };
  const statusOptions = titleStatusOptions(kind), panel = panelFields(filterDraft.option, kind), period = effectivePeriod(route.value, today);
  const savedColumns = listPreferencesOn && listPrefs.customized && listPrefs.pending === 'none' ? customColumns(kind, listPrefs.columns) : null;
  // FIN-017: the padrão/customizada choice also goes to the user's list preferences (filters.listagem, as Clientes e fornecedores);
  // without it (or before it loads) the browser choice stays.
  const serverView = listPreferencesOn && !listPrefs.loading && listPrefs.pending === 'none' && listPrefs.filters && typeof listPrefs.filters.listagem === 'string' ? (listPrefs.filters.listagem === 'customizada' ? 'customizada' : 'padrao') : null;
  const listView = serverView ?? (columnState.key === columnKey ? columnState.view : 'padrao'), chosenColumns = savedColumns ?? (columnState.key === columnKey ? columnState.columns : [...DEFAULT_CUSTOM_COLUMNS]);
  const columns: TitleColumn[] = listView === 'customizada' ? chosenColumns : standardColumns(kind, route.value.option);
  const titleDrawer = entity === 'titles' && !route.error ? editor && (editor.mode === 'title_create_group' || editor.mode === 'title_update') ? { mode: editor.mode === 'title_create_group' ? 'create' as const : 'edit' as const, title: editor.mode === 'title_update' ? record as FinanceTitle : null, clone: editor.clone ?? null }
    : !editor && record ? { mode: permissions?.write && permissionScope.current === authScope && financePermitted(permissions, titlePermission(kind, 'ie')) && titleAllows(record as FinanceTitle, 'title_update') ? 'edit' as const : 'view' as const, title: record as FinanceTitle, clone: null } : null : null;
  const sendWhatsapp = async (title: FinanceTitle) => {
    setRowMenu(null); if (!mayRead()) return;
    try {
      const value = await controller.catalog(`/v1/cadastros/contacts/${title.contact_id}`) as { entity?: unknown; record?: { id?: unknown; mobile?: unknown; phone?: unknown } };
      if (!mayRead()) return;
      if (value?.entity !== 'contacts' || value.record?.id !== title.contact_id) throw new Error('contact');
      const message = whatsappMessage(title as FinanceTitleRow), phone = [value.record.mobile, value.record.phone].find(item => whatsappUrl(item, message)) as string | undefined;
      // Leva H (FIN-044): the user reviews (and may correct) the recipient and the text before WhatsApp opens; nothing is sent by the Brufap.
      setShare({ scope: routeKey, title: title as FinanceTitleRow, phone: phone ?? '', message });
    } catch { if (mayRead()) setError('Não foi possível ler o celular do contato. Tente novamente.'); }
  };
  const startPrint = (print: FinancePrint) => { if (!mayRead() || entity !== 'titles') return; setRowMenu(null); setPrintMenu(false); setPrintJob({ scope: routeKey, print }); };
  const printVisible = printJob && printJob.scope === routeKey ? printJob : null;
  const settleDrawer = entity === 'titles' && !route.error ? editor?.mode === 'settle' && record ? { titles: [record as FinanceTitle], partial: Boolean(editor.partial), selection: false }
    : settleSelection && settleSelection.scope === routeKey && !editor && !record ? { titles: settleSelection.titles, partial: false, selection: true } : null : null;
  const settleSaved = (result: { items: number; borderos: number }) => {
    setSettleSelection(null); setSelection({ scope: '', ids: [], anchor: null }); setReload(value => value + 1);
    setNotice(`Baixa registrada: ${result.items === 1 ? '1 conta' : `${result.items} contas`} em ${result.borderos === 1 ? '1 borderô' : `${result.borderos} borderôs`}.`); close();
  };
  const drawerSaved = (next?: { settleId: string | null }) => { setReload(value => value + 1); if (next?.settleId) { setNotice('Conta salva. Confira a conta financeira e os valores para registrar a baixa.'); void open(next.settleId, { mode: 'settle' }); return; } setNotice(next ? 'Conta salva. Abra a conta na listagem para registrar a baixa.' : 'Operação registrada no financeiro da empresa.'); close(); };
  const accessNotice=!sessionAllowed&&<section className="real-state-panel"><h1>Consulta financeira indisponível</h1><p>Confirme sua sessão e seu acesso ao financeiro para continuar.</p></section>;
  const guard = (batchRunning || pendingOwned) && <BatchGuard busy />;
  if (transfersOpen) return <>{accessNotice}<div hidden={!sessionAllowed} inert={!sessionAllowed} aria-hidden={!sessionAllowed||undefined}><FinanceTransfers controller={controller} onBack={() => {
    if (!mayRead() || transferScopeRef.current !== routeKey) return;
    transferScopeRef.current = null; setTransferScope(null); setReload(value => value + 1);
  }} /></div></>;
  return <>{accessNotice}{guard}<div hidden={!sessionAllowed} inert={!sessionAllowed} aria-hidden={!sessionAllowed||undefined}><header className="real-heading"><div className="finance-heading-title"><h1>{tabLabels[tab]}</h1>{entity === 'titles' && permissions && !route.error && <OriginSelector label="Conta financeira" value={accountLabel} options={accountSelector.map(option => option.label)} onChange={label => { const target = accountSelector.find(option => option.label === label); if (target && target.value !== route.value.account) applyFilters({ account: target.value }); }} />}{accountOptions.key === accountKey && accountOptions.error && <small className="real-help" role="status">{accountOptions.error}</small>}</div>{permissions && !permissions.write && <span className="real-mode">Somente consulta</span>}</header>
    {notice && <p className="real-success" role="status">{notice}</p>}{error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => permissions ? setReload(value => value + 1) : controller.retry()}>Tentar novamente</button></p>}
    {route.value.titleId&&!permissions&&!route.error&&!record&&!editor?<section className="real-state-panel"><p role="status">{error?'A parcela não foi aberta. Confirme o acesso e tente consultar novamente.':'Conferindo acesso à parcela…'}</p></section>:route.error ? <section className="real-state-panel"><p role="alert">{route.error}</p><button className="secondary-button" onClick={clear}>Limpar filtros da URL</button></section> : editor && !titleDrawer && !settleDrawer ? <FinanceEditor key={`${editor.mode}:${record?.id || 'new'}:${editor.partial ? 'parcial' : ''}`} controller={controller} mode={editor.mode} record={record} payment={editor.payment} partial={editor.partial} kind={kind} onClose={close} onSaved={next => { setReload(value => value + 1); if (next?.settleId) { setNotice('Conta salva. Confira a conta financeira e os valores para registrar a baixa.'); void open(next.settleId, { mode: 'settle' }); return; } setNotice(next ? 'Conta salva. Abra a conta na listagem para registrar a baixa.' : 'Operação registrada no financeiro da empresa.'); close(); }} /> : record && !titleDrawer && !settleDrawer ? <FinanceDetail controller={controller} entity={entity} record={record} writable={Boolean(permissions?.write)} onClose={close} onEdit={(mode, payment) => { if(!mayRead()||permissionScope.current!==authScope||!permissions?.write)return;setNotice(''); setView(previous => ({ ...previous, editor: { mode, payment } })); }} /> : detail ? <section className="real-state-panel">{detail.loading ? <p role="status">Carregando registro financeiro…</p> : <><p role="alert">{detail.error}</p><button className="secondary-button" onClick={() => void open(detail.id!)}>Tentar consultar registro novamente</button></>}<button className="secondary-button" onClick={close}>Voltar à listagem</button></section> : <><form onSubmit={apply} aria-label="Filtros do financeiro">
      <NativeListLayout filters={<>
        {entity === 'titles' ? <>
          <fieldset className="finance-option-filter"><legend>Opção</legend>{titleOptions(kind).map(option => <label key={option.value} htmlFor={`finance-option-${option.value}`}><input id={`finance-option-${option.value}`} type="radio" name="finance-option" checked={filterDraft.option === option.value} onChange={() => setFilterDraft(previous => ({ ...previous, option: option.value }))} />{option.label}</label>)}</fieldset>
          {panel.date && <Field label="Filtrar por">{id => <select id={id} value={filterDraft.date} onChange={event => { const value = event.target.value as FinanceDateField; setFilterDraft(previous => ({ ...previous, date: value })); }}>{dateFieldOptions(kind).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Field>}
          <div className="finance-category-lazy" onFocus={wantCategories} onMouseDown={wantCategories}><CategoryTreeFilter idPrefix="finance-category" items={categoryChoices} value={filterDraft.categories} onChange={next => setFilterDraft(previous => ({ ...previous, categories: next }))} error={categoryOptions.error ? 'Não foi possível carregar as categorias. Abra o filtro novamente para tentar outra vez.' : ''} onRetry={() => setCategoryRetry(value => value + 1)} />
            {filterDraft.categories.some(value => value !== 'none' && !categoryChoices.some(item => item.id === value)) && <p className="real-help">{categoryOptions.loading ? 'Carregando as categorias…' : 'Há categorias selecionadas que não estão na árvore atual.'}</p>}</div>
          <Field label="Tipo de pagamento">{id => <select id={id} value={filterDraft.paymentType} onChange={event => { const value = event.target.value; setFilterDraft(previous => ({ ...previous, paymentType: value })); }}><option value="">Todas</option>{TITLE_PAYMENT_TYPES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</Field>
          <Field label="Forma de pagamento">{id => <select id={id} value={filterDraft.paymentMethod} onFocus={() => setMethodsWanted(true)} onMouseDown={() => setMethodsWanted(true)} onChange={event => { const value = event.target.value; setFilterDraft(previous => ({ ...previous, paymentMethod: value })); }}><option value="">Todas</option>{filterDraft.paymentMethod && !methodChoices.some(item => item.id === filterDraft.paymentMethod) && <option value={filterDraft.paymentMethod}>{methodName ?? 'Forma selecionada'}</option>}{methodChoices.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}</select>}</Field>
          {methodOptions.key === methodKey && methodOptions.error && <p className="real-help" role="status">{methodOptions.error}</p>}
          {panel.remittance && <Field label="Em remessa">{id => <select id={id} value={filterDraft.remittance} onChange={event => { const value = event.target.value as FilterDraft['remittance']; setFilterDraft(previous => ({ ...previous, remittance: value })); }}><option value="">Todas</option><option value="yes">Incluídas em remessa</option><option value="no">Não incluídas em remessa</option></select>}</Field>}
          {panel.status && <fieldset className="finance-status-filter"><legend>Situação</legend>{statusOptions.map(option => <label key={option.value} htmlFor={`finance-status-${option.value}`}><input id={`finance-status-${option.value}`} type="checkbox" checked={filterDraft.status.includes(option.value)} onChange={event => { const checked = event.target.checked; setFilterDraft(previous => ({ ...previous, status: checked ? [...previous.status.filter(value => value !== option.value), option.value] : previous.status.filter(value => value !== option.value) })); }} />{option.label}</label>)}</fieldset>}
          <Field label="Valor">{id => <input id={id} inputMode="decimal" placeholder="0,00" maxLength={16} value={filterDraft.value} onChange={event => { const value = event.target.value; setFilterDraft(previous => ({ ...previous, value })); }} />}</Field>
          {panel.seller && <Field label="Vendedor">{id => <FinanceSellerSelect controller={controller} id={id} value={filterDraft.seller} onChange={next => { if (next) sellerNames.current.set(next.id, next.name); setFilterDraft(previous => ({ ...previous, seller: next })); }} />}</Field>}
          {panel.document && <Field label="N° documento">{id => <input id={id} maxLength={60} value={filterDraft.doc} onChange={event => { const value = event.target.value; setFilterDraft(previous => ({ ...previous, doc: value })); }} />}</Field>}
        </> : <p className="real-help">Use a pesquisa para localizar {entity === 'accounts' ? 'uma conta financeira' : 'uma categoria'} pelo nome.</p>}
        <button type="submit" className="primary-button" disabled={loading || !permissions}>Filtrar</button><button type="button" className="text-button" disabled={loading} onClick={clear}>Limpar filtros</button>
        {entity === 'titles' && <p className="real-help">{filterDraft.option === 'issued' ? 'Situações marcadas somam-se entre si. O período usa o tipo de data escolhido.' : filterDraft.option === 'settled' ? 'O período usa a data das baixas não estornadas.' : 'O período usa o vencimento.'}</p>}
      </>} actions={<>
        {permissions?.write && financePermitted(permissions, entity === 'titles' ? titlePermission(kind, 'ie') : entity === 'accounts' ? 'financas.caixas_bancos.ie' : 'financas.categorias.ie') && <button type="button" className="primary-button" onClick={() => { if (activeScope.current !== routeKey || transferScopeRef.current === activeScope.current) return; detailRequest.current?.abort(); detailRequest.current = null; setNotice(''); setView({ scope: routeKey, record: null, editor: { mode: entity === 'titles' ? 'title_create_group' : entity === 'accounts' ? 'account_save' : 'category_save' }, id: null, loading: false, error: '' }); }}><Icon name="plus" size={16}/>{includeLabel}</button>}
        {entity === 'accounts' && permissions?.read && <button type="button" className="action-button" onClick={showTransfers}><Icon name="comments-dollar" size={15}/>Transferência entre contas</button>}
        {canBatch && <div className="finance-batch-actions">{panelActions(filterDraft.option).filter(action => financePermitted(permissions, titlePermission(kind, BATCH_PERMISSION[action]))).map(action => <button key={action} type="button" className="action-button" disabled={!selectedTitles.length || Boolean(pendingVisible) || Boolean(batchVisible) || loading} title={!selectedTitles.length ? 'Selecione contas na listagem.' : pendingVisible ? 'Confira antes o resultado pendente.' : TITLE_BATCH_LABEL[action]} onClick={() => startBatch(action)}><Icon name={BATCH_ICON[action]} size={15}/>{TITLE_BATCH_LABEL[action]}</button>)}{kind === 'payable' && <button type="button" className="action-button" disabled={!selectedTitles.length} title={selectedTitles.length ? 'Imprimir agrupado por fornecedor' : 'Selecione contas na listagem.'} onClick={() => startPrint({ mode: 'listing', grouped: true, source: { kind: 'rows', rows: selectedTitles as FinanceTitleRow[] } })}><Icon name="print" size={15}/>Imprimir agrupado por fornecedor</button>}
          {/* FIN-054: Gerar remessa (Em aberto) takes the contas chosen here to Incluir Remessa of the cobrança Itaú, up to 30. */}
          {kind === 'receivable' && filterDraft.option === 'open' && route.value.option === 'open' && financePermitted(permissions, 'financas.remessas.ie') && <button type="button" className="action-button" disabled={!selectedTitles.length || selectedTitles.length > 30 || selectedTitles.some(title => (title as FinanceTitleRow).remittance)} title={!selectedTitles.length ? 'Selecione contas na listagem.' : selectedTitles.length > 30 ? 'Uma remessa tem até 30 contas.' : selectedTitles.some(title => (title as FinanceTitleRow).remittance) ? 'Há contas já incluídas em remessa.' : 'Gerar remessa com as contas selecionadas'}
            onClick={() => { if (!mayWrite() || !selectedTitles.length || selectedTitles.length > 30) return; navigate(`/cobranca-operacional?${new URLSearchParams({ titulos: selectedTitles.map(title => title.id).join(',') })}`); }}><Icon name="file-export" size={15}/>Gerar remessa</button>}
          {/* FIN-176/FIN-059 (leva H): the contas of one remessa reopen it by its id: resume a reservation, or the NÃO PAGAR preview of its file. */}
          {kind === 'receivable' && financePermitted(permissions, 'financas.remessas') && (() => { const remittance = sameRemittance(selectedTitles as FinanceTitleRow[]); return remittance && <button type="button" className="action-button"
            title={remittance.state === 'reserved' ? `Retomar a reserva da remessa ${remittance.sequence}` : `Prévia dos boletos da remessa ${remittance.sequence}, marcada NÃO PAGAR`}
            onClick={() => { if (mayRead()) navigate(`/cobranca-operacional?${new URLSearchParams({ remessa: remittance.id })}`); }}><Icon name="file-export" size={15}/>{remittance.state === 'reserved' ? 'Retomar remessa' : 'Prévia dos boletos'}</button>; })()}
          <button type="button" className="action-button" disabled={!selectedTitles.length} title={selectedTitles.length ? 'Recibos agrupados por contato' : 'Selecione contas na listagem.'} onClick={() => startPrint({ mode: 'receipts', source: { kind: 'rows', rows: selectedTitles as FinanceTitleRow[] } })}><Icon name="file-lines" size={15}/>Gerar recibos</button>
          <p className="real-help">{selectedTitles.length ? `${selectedTitles.length === 1 ? '1 conta selecionada' : `${selectedTitles.length} contas selecionadas`} nesta página.` : 'Marque as contas na listagem; Shift + clique marca um intervalo.'}</p></div>}
        <p className="real-help">{entity === 'titles' ? 'Clique na linha para abrir a conta. Ctrl + clique abre em nova aba.' : 'Clique na linha para consultar os detalhes.'}</p><hr/>
        <div className="native-list-summary"><h3>Informações</h3>{entity === 'titles' ? <><dl className="native-list-stat"><dt>{countLabel}</dt><dd>{titlesPage ? titlesPage.total.toLocaleString('pt-BR') : '—'}</dd></dl><dl className="native-list-stat"><dt>Valor total</dt><dd>{titlesPage ? financeMoney(titlesPage.totals.amount_cents) : '—'}</dd></dl><dl className="native-list-stat"><dt>Saldo em aberto</dt><dd>{titlesPage ? financeMoney(titlesPage.totals.balance_cents) : '—'}</dd></dl>{kind === 'receivable' && route.value.option === 'settled' && <dl className="native-list-stat"><dt>Taxa total</dt><dd>{titlesPage ? financeMoney(titlesPage.totals.fee_cents) : '—'}</dd></dl>}<p className="real-help">Informações baseadas nos filtros aplicados na listagem. O saldo em aberto não considera contas canceladas.</p></> : <><dl className="native-list-stat"><dt>{countLabel}</dt><dd>{page ? page.items.length : '—'}</dd></dl><p className="real-help">Quantidade referente apenas à página atual.</p></>}</div>
        {entity === 'titles' && <div className="finance-support"><h3>Ferramentas de apoio</h3><Link to={borderoPath(kind)}>{borderoMenuLabel(kind)}</Link><Link to={recurrencePath(kind)}>Gerenciar contas recorrentes</Link><button type="button" className="text-button" onClick={() => changeTab('categories')}>Gerenciar categorias</button><Link to={`/financeiro-empresa?area=importacao&tipo=${kind}`}>Importação de registros financeiros</Link></div>}
        <p className="real-help">Saldos consideram os lançamentos registrados no FAGOO. Confira o extrato bancário pela conciliação.</p>
      </>}>
        <nav className="finance-tabs" aria-label="Áreas do financeiro">{Object.entries(tabLabels).map(([value, label]) => <button key={value} type="button" aria-current={tab === value ? 'page' : undefined} onClick={() => changeTab(value)}>{label}</button>)}</nav>
        {financePeriodNotice(route.value) && <p className="real-notice">{financePeriodNotice(route.value)}</p>}
        <div className="native-list-toolbar"><div className="form-field"><label htmlFor="finance-search">Pesquisar na listagem</label><input id="finance-search" type="search" value={draft} onChange={event => setDraft(event.target.value)} maxLength={120} placeholder={searchPlaceholder} /></div><button type="submit" className="secondary-button" title="Pesquisar" aria-label="Pesquisar" disabled={loading || !permissions}><Icon name="search" size={16}/></button>{entity === 'titles' && <PeriodPicker from={period.from} to={period.to} today={today} dateType={dateFieldLabel(optionDate(route.value.option, route.value.date), kind)} dateTypes={route.value.option === 'issued' ? dateFieldOptions(kind).map(option => option.label) : undefined} prefixLabel onApply={range => applyFilters({ from: range.from, to: range.to, ...(route.value.option === 'issued' ? { date: dateFieldFromLabel(range.dateType, kind) } : {}) })} />}<div className="origin-toolbar-tools">{entity === 'titles' ? <span className="finance-print-menu"><ToolButton icon="print" title="Imprimir" disabled={!titlesPage} onClick={() => setPrintMenu(!printMenu)} />{printMenu && <div className="origin-dropdown" role="menu" aria-label="Imprimir"><button type="button" role="menuitem" onClick={() => { const { titleId, ...filters } = route.value; startPrint({ mode: 'listing', notes: printNotes, source: { kind: 'route', route: { ...filters, page: 1 } } }); }}>Listagem simples</button><button type="button" role="menuitem" onClick={() => { const { titleId, ...filters } = route.value; startPrint({ mode: 'listing', grouped: true, notes: printNotes, source: { kind: 'route', route: { ...filters, page: 1 } } }); }}>{kind === 'receivable' ? 'Agrupado por cliente' : 'Agrupado por fornecedor'}</button><label htmlFor="finance-print-notes"><input id="finance-print-notes" type="checkbox" checked={printNotes} onChange={event => setPrintNotes(event.target.checked)} />Imprimir observação do contato</label></div>}</span> : <ToolButton icon="print" title="Imprimir listagem" onClick={() => window.print()} />}{canBatch && financePermitted(permissions, titlePermission(kind, 'ex')) && <ToolButton icon="trash-can" title="Excluir selecionados" disabled={!selectedTitles.length || Boolean(pendingVisible) || Boolean(batchVisible) || loading} onClick={() => startBatch('delete')} />}<ToolButton icon="rotate-right" title="Recarregar" disabled={loading || !permissions} onClick={() => setReload(value => value + 1)} />{entity === 'titles' && <><ViewToggle active={listView} onChange={next => { if (next === listView) return; const value = { view: next, columns: chosenColumns }; setColumnState({ key: columnKey, ...value }); storeColumns(kind, owner, value);
          if (listPreferencesOn) { const { listagem: _previous, ...others } = listPrefs.filters ?? {}; listPrefs.saveFilters(next === 'customizada' ? { ...others, listagem: 'customizada' } : { ...others, listagem: 'padrao' }); } }} />{listView === 'customizada' && <ToolButton icon="table-columns" title="Colunas customizadas" onClick={() => setColumnsOpen(true)} />}</>}</div></div>
        <AppliedChips chips={chips} onClear={clear} />
        {entity === 'titles' && listView === 'customizada' && listPreferencesOn && listPrefs.error && <p className="real-alert" role="alert">{listPrefs.error} {listPrefs.pending === 'uncertain' && <button type="button" className="text-button" onClick={listPrefs.check}>Conferir resultado</button>}{listPrefs.pending === 'missing' && <button type="button" className="text-button" onClick={listPrefs.resend}>Reenviar a mesma listagem</button>}</p>}
        {pendingVisible && <p className="real-alert" role="alert">{pendingVisible.items.length === 1 ? '1 conta' : `${pendingVisible.items.length} contas`} de “{TITLE_BATCH_LABEL[pendingVisible.action]}” sem resultado confirmado. <button type="button" className="text-button" disabled={Boolean(batchVisible)} onClick={recoverBatch}>Conferir resultado</button> <button type="button" className="text-button" disabled={Boolean(batchVisible)} onClick={() => setPending(null)}>Conferir depois</button></p>}
        <div className="real-result-status" role="status">{loading ? 'Carregando financeiro…' : entity === 'titles' ? titlesPage ? rangeLabel(route.value.page, FINANCE_TITLE_PAGE_SIZE, titlesPage.total) : 'Financeiro indisponível.' : page ? `${page.items.length} registro(s) nesta página` : 'Financeiro indisponível.'}</div>
        {entity === 'titles' ? titlesPage && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Registros financeiros"><table className="data-table finance-table"><thead><tr>{canBatch && <th className="checkbox-cell"><input type="checkbox" aria-label="Selecionar todos" title="Selecionar todos" checked={allSelected} aria-checked={!allSelected && selectedTitles.length > 0 ? 'mixed' : allSelected} onChange={toggleAll} /></th>}<th>{kind === 'receivable' ? 'Cliente' : 'Fornecedor'}</th>{columns.map(column => column === 'due' ? <th key={column} aria-sort={route.value.order === 'due_asc' ? 'ascending' : 'descending'}><button type="button" className="finance-sort" title="Ordena por vencimento (crescente/decrescente)" disabled={loading} onClick={() => applyFilters({ order: route.value.order === 'due_asc' ? 'due_desc' : 'due_asc' })}>Vencimento<Icon name={route.value.order === 'due_asc' ? 'arrow-up' : 'arrow-down'} size={9} /></button></th> : <th key={column} className={NUMERIC_COLUMNS.includes(column) ? 'numeric' : undefined}>{column === 'identification' && listView === 'padrao' ? 'Nº de identificação' : column === 'document' && listView === 'padrao' ? 'N° documento' : TITLE_COLUMNS.find(item => item.id === column)!.label}</th>)}<th className="numeric">Valor</th><th>Situação</th><th className="row-actions"><span className="real-sr-only">Ações</span></th></tr></thead><tbody>{titleRows.map(title => { const checked = selectedIds.includes(title.id), items = menuItems(title), label = title.installments > 1 ? `${title.description} ${title.installment}/${title.installments}` : title.description;
          const cell = (column: TitleColumn) => column === 'history' ? <td key={column}><button type="button" className="text-button finance-open" onClick={event => openRow(title.id, event)}>{label}{title.payments.settled_by_return ? ', Baixa de conta por retorno' : ''}</button>{title.origin && <Link className="finance-origin" to={originPath(title.origin)} title={originText(title.origin).menu} onClick={stopRow} onMouseDown={stopRow} onAuxClick={stopRow}>{originText(title.origin).reference} {title.origin.number ?? '(sem número)'}</Link>}</td>
            : <td key={column} className={NUMERIC_COLUMNS.includes(column) ? 'numeric' : undefined}>{column === 'payment_method' ? title.payment_method_name ? <span className="finance-payment-method" title={title.payment_type ? paymentTypeLabel(title.payment_type) : undefined}>{title.payment_bank ? <span className="finance-bank-badge" title={bankTitle(title.payment_bank)}><Icon name="building-columns" size={11} />{bankShortName(title.payment_bank)}</span> : <Icon name={paymentTypeIcon(title.payment_type)} size={12} />} {title.payment_method_name}</span> : '—' : column === 'account' ? title.account_name ?? '—' : column === 'category' ? title.category_name ?? 'Sem categoria' : column === 'identification' ? titleIdentification(title) || '—'
              : column === 'document' ? title.source_reference || (title.origin?.number ?? '—') : column === 'due' ? financeDate(title.due_on) : column === 'competence' ? financeDate(title.competence_on ?? title.issued_on) : column === 'issued' ? financeDate(title.issued_on)
              : column === 'settled_on' ? title.payments.settled_on ? financeDate(title.payments.settled_on) : '—' : column === 'fee' ? title.payments.fee_cents === '0' ? '-' : financeMoney(title.payments.fee_cents) : column === 'net' ? financeMoney(titleNet(title))
              : column === 'interest' ? financeMoney(title.payments.interest_cents) : column === 'additions' ? financeMoney(title.payments.penalty_cents) : column === 'discounts' ? financeMoney(title.payments.discount_cents) : column === 'installment' ? `${title.installment}/${title.installments}` : financeMoney(title.balance_cents)}</td>;
          return <tr key={title.id} className={`finance-row${checked ? ' selected' : ''}`} onClick={event => { if (!(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, select, textarea, label')) openRow(title.id, event); }} onMouseDown={event => { if (event.button === 1) event.preventDefault(); }} onAuxClick={event => { if (event.button === 1) openRow(title.id, event); }}>
            {canBatch && <td className="checkbox-cell" onClick={stopRow} onMouseDown={stopRow} onAuxClick={stopRow}><input type="checkbox" aria-label={`Selecionar ${label}`} checked={checked} onClick={event => toggleRow(title.id, event.shiftKey)} onChange={() => undefined} /></td>}
            <td>{title.contact_name}</td>{columns.map(cell)}<td className="numeric">{financeMoney(title.amount_cents)}</td><td><SituationBadge title={title} today={today} />{title.recurrence_id && <span className="finance-recurring" title="Conta recorrente" aria-label="Conta recorrente" role="img"><Icon name="retweet" size={11} /></span>}</td>
            <td className="row-actions" onClick={stopRow} onMouseDown={stopRow} onAuxClick={stopRow}>{items.length > 0 && <RowMenu label={label} items={items} open={rowMenu?.scope === listKey && rowMenu.id === title.id} onToggle={() => setRowMenu(rowMenu?.scope === listKey && rowMenu.id === title.id ? null : { scope: listKey, id: title.id })} />}</td></tr>; })}</tbody></table></div>{!titleRows.length && <div className="empty-state"><h2>Nenhum registro encontrado</h2><p>{permissions?.write ? 'Inclua uma conta ou ajuste os filtros.' : 'Ajuste os filtros ou aguarde os lançamentos da equipe financeira.'}</p></div>}<footer className="table-footer real-pagination finance-pagination"><OriginPagination page={Math.min(route.value.page, pages)} pages={pages} size={FINANCE_TITLE_PAGE_SIZE} total={titlesPage.total} onPage={target => { if (!loading && target !== route.value.page) applyFilters({ page: target }); }} /></footer></>
        : page && <><div className="table-scroll" tabIndex={0} role="region" aria-label="Registros financeiros"><table className="data-table finance-table"><thead><tr><th>{entity === 'accounts' ? 'Descrição' : 'Categorias'}</th><th>{entity === 'accounts' ? 'Tipo de conta' : 'Tipo'}</th>{entity === 'accounts' && <th className="numeric">Saldo no FAGOO</th>}<th>Situação</th></tr></thead><tbody>{page.items.map(item => { const named = item as FinanceAccount | FinanceCategory;
          return <tr key={item.id} className="finance-row" onClick={event => { if (!(event.target as { closest?: (selector: string) => Element | null } | null)?.closest?.('button, a, input, select, textarea, label')) openRow(item.id, event); }}><td><button type="button" className="text-button finance-open" onClick={event => openRow(item.id, event)}>{named.name}</button></td><td>{FINANCE_KIND[named.kind]}</td>{entity === 'accounts' && <td className="numeric">{financeMoney((item as FinanceAccount).balance_cents)}</td>}<td><SituationBadge active={named.active} /></td></tr>; })}</tbody></table></div>{!page.items.length && <div className="empty-state"><h2>Nenhum registro encontrado</h2><p>{permissions?.write ? 'Inclua um registro ou ajuste os filtros.' : 'Ajuste os filtros ou aguarde os lançamentos da equipe financeira.'}</p></div>}<PageControls page={page} loading={loading} cursors={cursors} setCursors={setCursors} after={after} setAfter={setAfter} /></>}
      </NativeListLayout>
    </form>
    {settleDrawer && <FinanceSettleDrawer key={`${settleDrawer.selection ? 'selection' : settleDrawer.titles[0].id}:${settleDrawer.titles.map(title => title.version).join(',')}:${settleDrawer.partial ? 'parcial' : ''}`} controller={controller} kind={kind} titles={settleDrawer.titles} partial={settleDrawer.partial} useDueDateDefault={kind === 'receivable' && financePreferences.values['financas.receber_data_baixa'] === true} onClose={() => { if (settleDrawer.selection) setSettleSelection(null); else close(); }} onSaved={settleSaved} />}
    {titleDrawer && <FinanceTitleDrawer key={`${titleDrawer.mode}:${titleDrawer.title?.id ?? 'new'}:${titleDrawer.title?.version ?? titleDrawer.clone?.id ?? ''}`} controller={controller} kind={kind} mode={titleDrawer.mode} title={titleDrawer.title} clone={titleDrawer.clone} onClose={close} onSaved={drawerSaved}
      history={titleDrawer.title && <FinancialHistory key={titleDrawer.title.id} controller={controller} title={titleDrawer.title} writable={titleDrawer.mode === 'edit'} onReverse={payment => leaveGuard.confirmLeave(() => { if (!mayRead() || permissionScope.current !== authScope || !permissions?.write) return; setNotice(''); setView(previous => ({ ...previous, editor: { mode: 'reverse', payment } })); })} />} />}
    {share && share.scope === routeKey && <FinanceWhatsappShare share={share} onClose={() => setShare(null)} />}
    {printVisible && entity === 'titles' && <FinancePrintPreview controller={controller} kind={kind} print={printVisible.print} receiptHeader={financePreferences.values[kind === 'receivable' ? 'financas.receber_cabecalho_recibo' : 'financas.pagar_cabecalho_recibo'] === true} onClose={() => setPrintJob(null)} />}
    {columnsOpen && entity === 'titles' && <ColumnsDialog kind={kind} chosen={chosenColumns} onCancel={() => setColumnsOpen(false)} onApply={next => { const value = { view: 'customizada' as const, columns: customColumns(kind, next) }; setColumnState({ key: columnKey, ...value }); storeColumns(kind, owner, value); if (listPreferencesOn) listPrefs.saveColumns(value.columns); setColumnsOpen(false); }} />}
    {batchVisible && batchVisible.step === 'params' && <FinanceBatchParams key={`${batchVisible.action}:${batchVisible.scope}`} controller={controller} action={batchVisible.action} kind={kind} count={batchVisible.titles.length} onCancel={() => setBatch(null)} onContinue={continueBatch} />}
    {batchVisible && batchVisible.step === 'run' && batchVisible.plan && <BatchDialog title={batchVisible.recovery ? 'Conferir resultado' : TITLE_BATCH_LABEL[batchVisible.action]} description={batchDescription(batchVisible)} plan={batchVisible.plan} confirmLabel={batchVisible.recovery ? 'Conferir resultado' : TITLE_BATCH_LABEL[batchVisible.action]} canConfirm={canBatch} run={runBatchItem(batchVisible)} onClose={results => finishBatch(batchVisible, results)} />}
    </>}</div></>;
}
