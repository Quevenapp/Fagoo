import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { financeDate, financeMoney, todaySP, type FinanceKind, type FinanceTitle } from '../lib/real-finance-model';
import { loadReferenceOptions, titleDetail, type ReferenceOption } from '../lib/finance-title-drawer';
import { SETTLE_NOTE_LABEL, SETTLE_NOTE_LIMIT, refreshRows, rowAmounts, settleAccount, settleBatchData, settleInitial, settleLabels, settleTotal, suggestedValue, type SettleRow, type SettleState } from '../lib/finance-settle';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { categoryTree, type CategoryNode } from '../lib/finance-registry-model';
import { CategoryTreePicker } from './FinanceCategoryTreeSelect';
import { Icon } from './Icon';
import './finance-title-drawer.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
// Origin opens the configuration of the categories of juros, multa, desconto and tarifa in a new tab.
const CATEGORIZATION_PATH = '/financeiro-empresa?area=categories&categorizacao=1';
const MARKETPLACE_OUT = 'Taxas de marketplace não fazem parte do FAGOO.';
type Options = { key: string; items: ReferenceOption[]; error: string };
type Command = { id: string; body: { data: Record<string, unknown> }; uncertain: boolean };
function knownText(error: AccessError) {
  return error.status === 409 ? 'Uma das contas mudou desde que a baixa foi aberta. Feche a baixa, atualize a listagem e abra de novo.'
    : error.status === 400 ? 'A baixa não foi aceita. Confira datas, valores, contas financeiras e categorias.' : error.status === 403 ? 'Seu acesso a esta operação foi alterado.' : 'Uma das contas não foi encontrada. Atualize a listagem.';
}
function SettleField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="form-field"><label htmlFor={id}>{label}</label>{children(id)}</div>;
}

/**
 * SlideIn “Baixa de lançamentos” do Origin, para uma conta (baixa total ou parcial) ou várias selecionadas:
 * Lançamento agrupado, Categoria única, Utilizar data de vencimento, Destino, Categoria, Data, Valor total, Histórico e a
 * subtabela “Lançamentos selecionados”. Envia um único comando settle_batch (110), com “Conferir resultado” se incerto.
 */
export default function FinanceSettleDrawer({ controller, kind, titles, partial = false, useDueDateDefault = false, onClose, onSaved }: {
  controller: Pick<AccessController, 'finance'> & Partial<Pick<AccessController, 'getSnapshot'>>; kind: FinanceKind; titles: readonly FinanceTitle[]; partial?: boolean;
  /** Preferências > Finanças > Contas a receber: "Utilizar data do vencimento do título como data da baixa". */
  useDueDateDefault?: boolean;
  onClose: () => void; onSaved: (result: { items: number; borderos: number }) => void;
}) {
  const today = todaySP(), labels = settleLabels(kind), multiple = titles.length > 1;
  const [state, setState] = useState<SettleState>(() => { const initial = settleInitial(kind, titles, today, partial); return useDueDateDefault ? refreshRows(kind, { ...initial, useDueDate: true }, titles) : initial; });
  const [accounts, setAccounts] = useState<Options>({ key: '', items: [], error: '' }), [categories, setCategories] = useState<{ key: string; items: CategoryNode[]; error: string }>({ key: '', items: [], error: '' }), [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [rowsOpen, setRowsOpen] = useState(true);
  // "Tornar conta padrão de movimentações" (Origin AF-08): a conta without conta financeira starts from the default account.
  const [defaultAccount, setDefaultAccount] = useState('');
  const command = useRef<Command | null>(null), pending = useRef<AbortController | null>(null), heading = useRef<HTMLHeadingElement>(null);
  // Origin prefills the Histórico with the whole histórico of the conta: past 240 characters it is read from the conta (SQL 210) and
  // replaces the prefill while the user has not changed it; that replacement is not an unsaved change.
  const single = titles.length === 1 ? titles[0] : null, [longHistory, setLongHistory] = useState('');
  const guard = useUnsavedForm(single && longHistory && state.note === longHistory ? { ...state, note: single.description } : state, busy || uncertain);
  useEffect(() => {
    if (!single?.long_history) return; const request = new AbortController(), source = single;
    void Promise.resolve().then(() => controller.finance(`/v1/financeiro/titles/${source.id}/detalhe`, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return; const history = titleDetail(value, source.id, kind).history;
      // A baixa already sent keeps the Histórico it was sent with.
      if (!history || history.length > SETTLE_NOTE_LIMIT || command.current) return;
      setLongHistory(history); setState(previous => previous.note === source.description ? { ...previous, note: history } : previous);
    }).catch(() => { /* The Histórico keeps the first 240 characters of the conta. */ });
    return () => request.abort();
  }, [controller, kind, single?.id]);
  useEffect(() => { heading.current?.focus?.(); return () => pending.current?.abort(); }, []);
  useEffect(() => {
    const request = new AbortController(), key = `${kind}:${retry}`, finance = (path: string, options: { signal: AbortSignal }) => controller.finance(path, options);
    void loadReferenceOptions(finance, 'accounts', request.signal).then(items => { if (!request.signal.aborted) setAccounts({ key, items: items.filter(item => item.active), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setAccounts({ key, items: [], error: 'Não foi possível carregar as contas financeiras.' }); });
    void Promise.resolve().then(() => controller.finance('/v1/financeiro/contas-financeiras?page=1&limit=100&situacao=ativo', { signal: request.signal })).then(value => { const items = (value as { items?: { id?: unknown; default_movements?: unknown; active?: unknown }[] })?.items;
      const chosen = Array.isArray(items) ? items.find(item => item.default_movements === true && item.active !== false && typeof item.id === 'string') : undefined; if (!request.signal.aborted) setDefaultAccount(typeof chosen?.id === 'string' ? chosen.id : ''); }).catch(() => { /* No default account: Selecione. */ });
    void controller.finance(`/v1/financeiro/categorias-arvore?kind=${kind}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setCategories({ key, items: categoryTree(value, kind).items, error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setCategories({ key, items: [], error: 'Não foi possível carregar as categorias.' }); });
    return () => request.abort();
  }, [controller, kind, retry]);
  const update = (change: (previous: SettleState) => SettleState, refresh = false) => setState(previous => { const next = change(previous); return refresh ? refreshRows(kind, next, titles) : next; });
  const setRow = (id: string, patch: Partial<SettleRow>) => update(previous => ({ ...previous, rows: previous.rows.map(row => {
    if (row.id !== id) return row;
    const next = { ...row, ...patch }, title = titles.find(item => item.id === id)!;
    return next.valueTouched || 'value' in patch ? next : { ...next, value: suggestedValue(kind, title, next) };
  }) }));
  const requestClose = () => { if (busy) return; guard.confirmLeave(onClose); };
  const writer = () => { const snapshot = controller.getSnapshot?.(); return !snapshot || (snapshot.phase === 'ready' && ['admin', 'financeiro'].includes(snapshot.membership?.role ?? '')); };
  const submit = async () => {
    if (busy || pending.current) return;
    if (!command.current?.uncertain) {
      setError('');
      try { command.current = { id: crypto.randomUUID(), body: { data: settleBatchData(kind, withDefault(state), titles, today) }, uncertain: false }; }
      catch (failure) { setError((failure as Error).message); return; }
    }
    const operation = command.current!;
    if (!writer()) { setError(operation.uncertain ? 'Seu acesso a esta operação foi alterado. A baixa não foi reenviada e o envio anterior continua sem confirmação.' : 'Seu acesso a esta operação foi alterado. A baixa não foi enviada.'); return; }
    const request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const result = await controller.finance('/v1/financeiro/actions/settle_batch', { method: 'POST', body: { ...operation.body, command_id: operation.id }, signal: request.signal }) as { items?: unknown[]; borderos?: unknown[] };
      if (request.signal.aborted) return;
      command.current = null; setUncertain(false);
      onSaved({ items: Array.isArray(result?.items) ? result.items.length : 0, borderos: Array.isArray(result?.borderos) ? result.borderos.length : 0 });
    } catch (failure) {
      if (request.signal.aborted || aborted(failure)) return;
      const known = !operation.uncertain && failure instanceof AccessError && [400, 403, 404, 409].includes(failure.status);
      if (known) command.current = null; else operation.uncertain = true;
      setUncertain(!known);
      setError(known ? knownText(failure as AccessError) : 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma baixa; ela não será duplicada.');
    } finally { if (pending.current === request) pending.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  const disabled = busy || uncertain;
  const accountChoices = accounts.key ? accounts.items : [], categoryChoices = categories.key ? categories.items : [];
  const usable = defaultAccount && accounts.items.some(item => item.id === defaultAccount) ? defaultAccount : '';
  // The default shows selected and goes with the baixa; the form stays unchanged until the user chooses another conta.
  function withDefault(current: SettleState): SettleState { return usable ? { ...current, destination: current.destination || (current.grouped ? usable : ''), rows: current.rows.map(row => ({ ...row, account_id: settleAccount(row.account_id, usable) })) } : current; }
  const accountSelect = (id: string, value: string, onChange: (value: string) => void, off = false) => <select id={id} value={value} disabled={off} onChange={event => onChange(event.target.value)}><option value="">Selecione</option>{value && !accountChoices.some(item => item.id === value) && <option value={value}>Conta financeira da conta</option>}{accountChoices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>;
  const categorySelect = (id: string, value: string, onChange: (value: string) => void, off = false) => <CategoryTreePicker id={id} items={categoryChoices} value={value} disabled={off} currentName={titles.find(item => item.category_id === value)?.category_name} onChange={onChange} />;
  return <div className="finance-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) requestClose(); }}>
    <section className="finance-drawer finance-settle" role="dialog" aria-modal="true" aria-label="Baixa de lançamentos">
      <header className="finance-drawer-head"><div className="finance-drawer-title"><h2 ref={heading} tabIndex={-1}>Baixa de lançamentos</h2></div><button type="button" className="icon-button" aria-label="Fechar" title="Fechar" disabled={busy} onClick={requestClose}><Icon name="close" /></button></header>
      <form className="finance-drawer-form" onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy}>
        <fieldset className="finance-drawer-fields" disabled={disabled}>
          <legend className="real-sr-only">Geral</legend>
          <label className="finance-drawer-switch"><input type="checkbox" role="switch" checked={state.grouped} disabled={!multiple} title={multiple ? undefined : 'Disponível com duas ou mais contas.'} onChange={event => { const checked = event.target.checked; update(previous => ({ ...previous, grouped: checked })); }} />Lançamento agrupado</label>
          <label className="finance-drawer-switch"><input type="checkbox" role="switch" checked={state.singleCategory} disabled={!multiple} title={multiple ? undefined : 'Disponível com duas ou mais contas.'} onChange={event => { const checked = event.target.checked; update(previous => ({ ...previous, singleCategory: checked })); }} />Categoria única para todos registros</label>
          <label className="finance-drawer-switch"><input type="checkbox" role="switch" checked={state.useDueDate} onChange={event => { const checked = event.target.checked; update(previous => ({ ...previous, useDueDate: checked }), true); }} />Utilizar data de vencimento</label>
          <SettleField label="Destino">{id => accountSelect(id, state.destination || (state.grouped ? usable : ''), value => update(previous => ({ ...previous, destination: value })), !state.grouped)}</SettleField>
          {/* Leva H (CTT-161): the conta of the título first, then the conta padrão de movimentações; choosing it never settles anything. */}
          <p className="real-help finance-settle-account-help">Conta financeira: a da própria conta; sem ela, a conta padrão de movimentações. Escolher a conta não registra a baixa, que só acontece ao salvar.</p>
          <SettleField label="Categoria">{id => multiple ? categorySelect(id, state.category, value => update(previous => ({ ...previous, category: value })), !state.singleCategory) : categorySelect(id, state.rows[0].category_id, value => setRow(state.rows[0].id, { category_id: value }))}</SettleField>
          <SettleField label={labels.date}>{id => <input id={id} type="date" max={today} value={state.postedOn} disabled={state.useDueDate} onChange={event => { const value = event.target.value; update(previous => ({ ...previous, postedOn: value }), true); }} />}</SettleField>
          <SettleField label="Valor total">{id => <input id={id} readOnly value={financeMoney(settleTotal(state))} />}</SettleField>
          <div className="form-field finance-drawer-wide"><label htmlFor="finance-settle-note">Histórico</label><textarea id="finance-settle-note" rows={3} maxLength={SETTLE_NOTE_LIMIT} value={state.note} onChange={event => { const value = event.target.value; update(previous => ({ ...previous, note: value })); }} /><small className="finance-drawer-counter">{state.note.length} de {SETTLE_NOTE_LABEL} caracteres</small></div>
        </fieldset>
        {(accounts.error || categories.error) && <p className="real-alert" role="alert">{accounts.error || categories.error} <button type="button" className="text-button" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></p>}
        <section className="finance-settle-rows" aria-label="Lançamentos selecionados">
          <h3><button type="button" className="text-button" aria-expanded={rowsOpen} onClick={() => setRowsOpen(!rowsOpen)}><Icon name={rowsOpen ? 'chevron-down' : 'chevron-right'} size={11} />Lançamentos selecionados ({titles.length})</button></h3>
          <p className="real-help">Os cálculos de juros e multa são realizados automaticamente caso haja valores fornecidos na inclusão da conta.</p>
          {rowsOpen && titles.map(title => {
            const row = state.rows.find(item => item.id === title.id)!; let remaining = '';
            try { const amounts = rowAmounts(kind, title, row); remaining = amounts.remaining_cents === '0' ? 'Baixa total' : `Baixa parcial · saldo após a baixa ${financeMoney(amounts.remaining_cents)}`; } catch (failure) { remaining = (failure as Error).message; }
            return <fieldset key={title.id} className="finance-settle-row" disabled={disabled}>
              <legend>{labels.contact}: <strong>{title.contact_name}</strong> · Nº do documento: {title.source_reference || title.origin?.number || '—'} · Vencimento: {financeDate(title.due_on)} · Valor original: {financeMoney(title.amount_cents)}</legend>
              <div className="finance-settle-grid">
                <SettleField label="Conta financeira">{id => accountSelect(id, state.grouped ? state.destination || usable : row.account_id || usable, value => setRow(title.id, { account_id: value }), state.grouped)}</SettleField>
                {multiple && <SettleField label="Categoria">{id => categorySelect(id, state.singleCategory ? state.category : row.category_id, value => setRow(title.id, { category_id: value }), state.singleCategory)}</SettleField>}
                <SettleField label="Juros">{id => <input id={id} inputMode="decimal" maxLength={17} value={row.interest} onChange={event => setRow(title.id, { interest: event.target.value, chargesTouched: true })} />}</SettleField>
                <SettleField label="Desconto">{id => <input id={id} inputMode="decimal" maxLength={17} value={row.discount} onChange={event => setRow(title.id, { discount: event.target.value })} />}</SettleField>
                <SettleField label="Multa">{id => <input id={id} inputMode="decimal" maxLength={17} value={row.penalty} onChange={event => setRow(title.id, { penalty: event.target.value, chargesTouched: true })} />}</SettleField>
                <SettleField label="Tarifa">{id => <input id={id} inputMode="decimal" maxLength={17} value={row.fee} onChange={event => setRow(title.id, { fee: event.target.value })} />}</SettleField>
                {kind === 'receivable' && <SettleField label="Taxas de Marketplace">{id => <input id={id} disabled value="0,00" title={MARKETPLACE_OUT} />}</SettleField>}
                <SettleField label={labels.value}>{id => <input id={id} inputMode="decimal" maxLength={17} autoFocus={partial && !multiple} value={row.value} onChange={event => setRow(title.id, { value: event.target.value, valueTouched: true })} />}</SettleField>
              </div>
              <small className="real-help" aria-live="polite">{remaining}</small>
            </fieldset>;
          })}
        </section>
        <a className="text-button" href={CATEGORIZATION_PATH} target="_blank" rel="noopener">Categorização dos valores adicionais</a>
        {error && <p className="real-alert" role="alert">{error}</p>}
        <footer className="finance-drawer-actions">
          <button type="button" className="text-button" disabled={busy} onClick={requestClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Baixando…' : uncertain ? 'Conferir resultado' : 'Baixar Pagamento'}</button>
        </footer>
      </form>
    </section>
  </div>;
}
