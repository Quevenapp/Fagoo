import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { quantityText, stockDate, type StockBalance, type StockLedgerMovement, type StockMovement } from '../lib/stock-model';
import { COST_INFO, EDIT_NOTICE, STOCK_LAUNCH_LABELS, amendBody, balanceSuffix, launchBody, launchQuantity, parseAmendResult, parseLaunchResult, priceDraft, units, type LaunchResult, type StockLaunchKind } from '../lib/stock-launch-model';
// 258: the Lote of the Novo Lançamento (optional, as in Origin).
import { EMPTY_LOT, NEW_LOT, launchLot, type LotDraft } from '../lib/stock-lots-model';
import { LotPicker, useStockLots } from './StockLots';
import { Icon } from './Icon';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const KNOWN = [400, 403, 404, 409];
const UNCERTAIN = 'Não foi possível confirmar o resultado. Use “Conferir resultado” para repetir a mesma operação sem lançar a quantidade novamente.';
// The company policy (migration100) explains a refused decrease; when it is unknown the message stays neutral.
const insufficient = (negative?: boolean | null) => negative === false ? 'Confira a quantidade e o saldo disponível. A política da empresa não permite estoque negativo.' : negative === true ? 'Confira a quantidade e o saldo disponível. O estoque negativo é permitido, mas reservas ativas continuam protegidas.' : 'Confira a quantidade e o saldo disponível. A operação não pode gerar estoque negativo quando a política da empresa não permite.';
export const stockFailure = (error: unknown, negative?: boolean | null) => error instanceof AccessError ? error.status === 409 ? 'O saldo foi alterado por outra operação. Atualize os saldos e confira novamente antes de confirmar.' : error.status === 400 ? insufficient(negative) : error.status === 403 ? 'Seu perfil não permite esta operação.' : error.status === 404 ? 'O lançamento, o produto ou o depósito não está mais disponível. Atualize os saldos.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';

/** One stock command at a time. A dispatched command whose answer is unknown keeps its UUID and body: "Conferir
 * resultado" sends exactly the same request (idempotent in SQL), and a later rejection never releases it. */
export function useStockCommand(controller: Pick<AccessController, 'stock'>, uncertainText = UNCERTAIN) {
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const command = useRef<{ id: string; path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown>; uncertain: boolean } | null>(null), pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const run = async <T,>(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown> | null, parse: (value: unknown, body: Record<string, unknown>) => T, done: (value: T) => void, explain: (error: unknown) => string) => {
    if (pending.current) return;
    if (!command.current) { if (!body) return; command.current = { id: crypto.randomUUID(), path, method, body: structuredClone(body), uncertain: false }; }
    const operation = command.current, request = new AbortController(); pending.current = request; setBusy(true); setError('');
    try {
      const raw = await controller.stock(operation.path, { method: operation.method, body: { ...operation.body, command_id: operation.id }, signal: request.signal });
      if (request.signal.aborted) return;
      let value: T; try { value = parse(raw, { ...operation.body, command_id: operation.id }); } catch { throw new AccessError(502); }
      command.current = null; setUncertain(false); done(value);
    } catch (problem) {
      if (request.signal.aborted || aborted(problem)) return;
      const known = !operation.uncertain && problem instanceof AccessError && KNOWN.includes(problem.status);
      if (known) command.current = null; else operation.uncertain = true;
      setUncertain(!known); setError(known ? explain(problem) : uncertainText);
    } finally { if (pending.current === request) pending.current = null; if (!request.signal.aborted) setBusy(false); }
  };
  return { busy, uncertain, error, setError, run, pending: () => Boolean(command.current || pending.current) };
}

/** Origin side panel ("Novo Lançamento", "Lançamento de estoque"): fixed on the right, Cancelar and the action in the footer. */
export function StockSidePanel({ title, wide, onClose, closeDisabled, footer, children, labelledBy }: { title: string; wide?: boolean; onClose: () => void; closeDisabled?: boolean; footer: ReactNode; children: ReactNode; labelledBy: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <div className="stock-panel-layer"><button type="button" className="stock-panel-backdrop" tabIndex={-1} aria-label="Fechar painel" disabled={closeDisabled} onClick={onClose} />
    <section className={`stock-panel${wide ? ' is-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <header className="stock-panel-head"><h2 id={labelledBy} ref={heading} tabIndex={-1}>{title}</h2><button type="button" className="icon-button" aria-label="Fechar" disabled={closeDisabled} onClick={onClose}><Icon name="xmark" size={14} /></button></header>
      <div className="stock-panel-body">{children}</div>
      <footer className="stock-panel-foot">{footer}</footer>
    </section></div>;
}

export interface LaunchSuggestion { sale: string; purchase: string; cost: string }
/** 145: Preferências > Suprimentos > Estoque "Exibir campo preço unitário nos lançamentos de estoque manual". */
export const HIDDEN_PRICE_HELP = 'O preço unitário não é exibido nos lançamentos manuais, conforme Preferências › Suprimentos › Estoque; o lançamento fica sem preço.';
/** "Novo Lançamento" of Origin: Tipo Entrada | Saída | Balanço in the header's depósito, dated now (America/Sao_Paulo). */
export function StockLaunchPanel({ controller, product, warehouse, readReady, suggestion, negativeAllowed = null, showPrice = true, priceHelp = null, lotControl = false, entryDecimals = 10, onClose, onSaved, onRefresh }: {
  controller: Pick<AccessController, 'stock'>; product: CatalogRecord; warehouse: StockBalance | null; readReady: boolean; suggestion: LaunchSuggestion; negativeAllowed?: boolean | null;
  showPrice?: boolean; priceHelp?: string | null; lotControl?: boolean; /** 277: Preferências › Empresa › Geral, decimals of the entry prices. */ entryDecimals?: number;
  onClose: () => void; onSaved: (result: LaunchResult) => void; onRefresh: () => void;
}) {
  const [kind, setKind] = useState<StockLaunchKind>('receipt'), [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState(suggestion.purchase), [cost, setCost] = useState(suggestion.cost), [note, setNote] = useState('');
  const [lotChoice, setLotChoice] = useState(''), [lotDraft, setLotDraft] = useState<LotDraft>(EMPTY_LOT);
  const lots = useStockLots(controller, lotControl ? product.id : null, warehouse?.warehouse_id ?? null, 'ativos', 0);
  const command = useStockCommand(controller), guard = useUnsavedForm({ kind, quantity, price, cost, note, lotChoice, lotDraft }, command.busy || command.uncertain);
  // Origin: changing Tipo clears Quantidade and suggests the price of that type; a "Novo lote" only enters by Entrada or Balanço.
  const changeKind = (next: StockLaunchKind) => { setKind(next); setQuantity(''); setPrice(next === 'issue' ? suggestion.sale : suggestion.purchase); setCost(next === 'issue' ? '' : suggestion.cost); if (next === 'issue' && lotChoice === NEW_LOT) setLotChoice(''); command.setError(''); };
  const frozen = command.busy || command.uncertain;
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (command.busy || !readReady || !warehouse) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) {
      try {
        body = launchBody({ kind, productId: product.id, warehouseId: warehouse.warehouse_id, expectedVersion: warehouse.version, quantity, unitPrice: price, unitCost: kind === 'issue' ? null : cost, note, showPrice, entryDecimals });
        if (lotControl) {
          if (!lots.page) throw new Error('Aguarde a consulta dos lotes do produto.');
          const lot = launchLot(lotChoice, lotDraft, lots.page.settings, kind);
          if (lot && kind === 'balance' && launchQuantity(quantity, kind).startsWith('-')) throw new Error('O saldo de um lote não pode ser negativo.');
          const chosen = lot && 'lot_id' in lot ? lots.page.items.find(item => item.id === lot.lot_id) : null;
          if (chosen && kind === 'issue' && units(chosen.quantity) < units(launchQuantity(quantity, kind))) throw new Error('O lote não tem saldo suficiente neste depósito.');
          if (lot) body.lot = lot;
        }
      }
      catch (problem) { command.setError((problem as Error).message); return; }
    }
    void command.run('/v1/estoque/lancamentos', 'POST', body, parseLaunchResult, onSaved, problem => stockFailure(problem, negativeAllowed));
  };
  const unit = typeof product.unit === 'string' ? product.unit : '';
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  return <StockSidePanel title="Novo Lançamento" labelledBy="stock-launch-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !readReady || !warehouse} onClick={() => save()}>{command.busy ? 'Incluindo…' : command.uncertain ? 'Conferir resultado' : 'Incluir'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}{!command.uncertain && <button type="button" className="text-button" disabled={command.busy} onClick={onRefresh}>Atualizar saldos</button>}</p>}
    {!readReady && <p className="real-notice">Consulte os saldos atuais antes de incluir um lançamento.</p>}
    <p className="stock-panel-context"><span>Depósito</span><strong>{warehouse?.warehouse_name ?? '—'}</strong>{warehouse && <small>Saldo atual: {warehouse.version === 0 ? 'sem lançamentos' : `${quantityText(warehouse.quantity)} ${unit}`}</small>}</p>
    <form className="stock-panel-form" onSubmit={save}><fieldset disabled={frozen || !readReady}><legend className="real-sr-only">Dados do lançamento</legend>
      <div className="form-field"><label htmlFor="stock-launch-kind">Tipo *</label><select id="stock-launch-kind" value={kind} onChange={event => changeKind(event.target.value as StockLaunchKind)}>{(Object.keys(STOCK_LAUNCH_LABELS) as StockLaunchKind[]).map(value => <option key={value} value={value}>{STOCK_LAUNCH_LABELS[value]}</option>)}</select></div>
      <div className="form-field"><label htmlFor="stock-launch-quantity">Quantidade</label><input id="stock-launch-quantity" required inputMode="decimal" maxLength={20} value={quantity} onChange={event => setQuantity(event.target.value)} /><small>{kind === 'balance' ? lotChoice ? 'Informe o novo saldo do lote neste depósito.' : 'Informe o novo saldo do depósito; a diferença para o saldo atual é lançada.' : 'Informe uma quantidade positiva.'}</small></div>
      {showPrice ? <><div className="form-field"><label htmlFor="stock-launch-price">{kind === 'issue' ? 'Preço de Venda *' : 'Preço de Compra *'}</label><input id="stock-launch-price" required inputMode="decimal" maxLength={26} value={price} onChange={event => setPrice(event.target.value)} />{kind !== 'issue' && priceHelp && <small>{priceHelp}</small>}
        {kind !== 'issue' && entryDecimals < 10 && <small>Preço de Compra e Preço de Custo com até {entryDecimals} {entryDecimals === 1 ? 'casa decimal' : 'casas decimais'} (Preferências › Empresa › Geral).</small>}</div>
      {kind !== 'issue' && <div className="form-field"><label htmlFor="stock-launch-cost">Preço de Custo * <span className="stock-info" title={COST_INFO} aria-label={COST_INFO}><Icon name="circle-info" size={11} /></span></label><input id="stock-launch-cost" required inputMode="decimal" maxLength={26} value={cost} onChange={event => setCost(event.target.value)} /></div>}</>
        : <p className="real-help real-field-wide">{HIDDEN_PRICE_HELP}</p>}
      <div className="form-field real-field-wide"><label htmlFor="stock-launch-note">Observação</label><textarea id="stock-launch-note" maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} /></div>
      {lotControl && <LotPicker page={lots.page} error={lots.error} kind={kind} unit={unit} choice={lotChoice} draft={lotDraft} onChoice={setLotChoice} onDraft={setLotDraft} />}
    </fieldset></form>
  </StockSidePanel>;
}

const directionOf = (row: StockLedgerMovement) => row.balance ? 'balance' : row.items.every(line => line.quantity.startsWith('-')) ? 'issue' : 'receipt';
/** "Lançamento de estoque" (click on the row): Depósito, Data, Hora, Tipo and Quantidade read-only; prices and Observação editable. */
export function StockEditPanel({ controller, product, row, warehouseName, writable, reversalBlock, readOnlyReason = null, entryDecimals = 10, onClose, onSaved, onReverse, onLots }: {
  controller: Pick<AccessController, 'stock'>; product: CatalogRecord; row: StockLedgerMovement; warehouseName: (id: string) => string; writable: boolean; reversalBlock: string | null;
  readOnlyReason?: string | null; entryDecimals?: number; onClose: () => void; onSaved: () => void; onReverse?: () => void;
  /** 278: "Informar lotes de produtos" of this line (product with Controle de lote). */
  onLots?: (warehouseId: string) => void;
}) {
  const direction = directionOf(row), out = direction === 'issue';
  const [price, setPrice] = useState(priceDraft(row.unit_price)), [cost, setCost] = useState(priceDraft(row.unit_cost)), [note, setNote] = useState(row.note ?? row.reason);
  const command = useStockCommand(controller), guard = useUnsavedForm({ price, cost, note }, command.busy || command.uncertain);
  const frozen = command.busy || command.uncertain, local = row.recorded_at_local.split('T');
  const save = () => {
    if (command.busy || !writable) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = amendBody(row, product.id, price, cost, note, entryDecimals); } catch (problem) { command.setError((problem as Error).message); return; } }
    void command.run(`/v1/estoque/movimentos/${row.id}`, 'PATCH', body, (value, sent) => parseAmendResult(value, row.id, sent), () => onSaved(), problem => problem instanceof AccessError && problem.status === 400 ? 'Altere o preço, o custo ou a observação antes de salvar.' : stockFailure(problem));
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const lines = row.items.filter(line => line.product_id === product.id);
  return <StockSidePanel title="Lançamento de estoque" wide labelledBy="stock-edit-title" onClose={close} closeDisabled={frozen}
    footer={<>{writable && onReverse && row.kind !== 'reversal' && !row.reversed_by && <button type="button" className="text-button stock-panel-reverse" disabled={frozen || Boolean(reversalBlock)} title={reversalBlock ?? undefined} onClick={() => { if (!frozen && !reversalBlock) guard.confirmLeave(onReverse); }}>Estornar lançamento</button>}
      <button type="button" className="secondary-button" disabled={frozen} onClick={close}>{writable ? 'Cancelar' : 'Fechar'}</button>{writable && <button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    <div className="real-notice stock-edit-notice"><strong>{EDIT_NOTICE}</strong><p>Somente os preços e a observação podem ser alterados. Quantidade, data, depósito e tipo ficam como foram lançados; para corrigi-los, estorne o lançamento.</p></div>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {readOnlyReason && <p className="real-help">{readOnlyReason}</p>}
    <dl className="stock-edit-facts">
      <div><dt>Depósito</dt><dd>{lines.map(line => warehouseName(line.warehouse_id)).join(' → ')}</dd></div>
      <div><dt>Data *</dt><dd>{row.occurred_on.split('-').reverse().join('/')}</dd></div>
      <div><dt>Hora</dt><dd>{local[1] ?? '—'}</dd></div>
      <div><dt>Tipo *</dt><dd>{direction === 'balance' ? 'Balanço' : out ? 'Saída' : 'Entrada'}</dd></div>
      <div><dt>Quantidade *</dt><dd>{row.balance ? quantityText(row.balance.counted) : lines.map(line => quantityText(line.quantity.replace(/^-/, ''))).join(' / ')} {String(product.unit ?? '')}</dd></div>
      <div><dt>Situação</dt><dd>{row.reversed_by ? 'Estornado' : row.kind === 'reversal' ? 'Correção registrada' : 'Registrado'}</dd></div>
    </dl>
    {onLots && ['receipt', 'issue'].includes(row.kind) && lines.length === 1 && <p className="stock-lot-link"><button type="button" className="secondary-button" disabled={frozen} onClick={() => guard.confirmLeave(() => onLots(lines[0]!.warehouse_id))}>{row.reversed_by ? 'Lotes do lançamento' : 'Informar lotes'}</button></p>}
    <form className="stock-panel-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={frozen || !writable}><legend className="real-sr-only">Preços e observação do lançamento</legend>
      <div className="form-field"><label htmlFor="stock-edit-price">{out ? 'Preço de Venda' : 'Preço de Compra'}</label><input id="stock-edit-price" inputMode="decimal" maxLength={26} value={price} onChange={event => setPrice(event.target.value)} /></div>
      {!out && <div className="form-field"><label htmlFor="stock-edit-cost">Preço de Custo * <span className="stock-info" title={COST_INFO} aria-label={COST_INFO}><Icon name="circle-info" size={11} /></span></label><input id="stock-edit-cost" inputMode="decimal" maxLength={26} value={cost} onChange={event => setCost(event.target.value)} /></div>}
      <div className="form-field real-field-wide"><label htmlFor="stock-edit-note">Observação</label><textarea id="stock-edit-note" maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} />{row.balance && <small>{balanceSuffix(row.balance).trim()}</small>}</div>
    </fieldset></form>
    {row.revision > 1 && <p className="real-help">Este lançamento já foi editado {row.revision - 1} {row.revision === 2 ? 'vez' : 'vezes'}; o histórico de cada edição é preservado.</p>}
  </StockSidePanel>;
}

/** Estorno: the opposite movement of a single-product lançamento (009), dated from the original date up to today. */
export function StockReversalForm({ controller, product, balances, readReady, reversal, onClose, onSaved, onRefresh, negativeAllowed = null }: {
  controller: Pick<AccessController, 'stock'>; product: CatalogRecord; balances: StockBalance[]; readReady: boolean; reversal: StockMovement; onClose: () => void;
  /** balanceKept: a Balanço after the original kept the current balance (145, "Considerar estorno ... se houver balanço" off). */
  onSaved: (result: { balanceKept: boolean }) => void; onRefresh: () => void; negativeAllowed?: boolean | null;
}) {
  const [date, setDate] = useState(stockDate()), [reason, setReason] = useState(''), [review, setReview] = useState<Record<string, unknown> | null>(null);
  const command = useStockCommand(controller), guard = useUnsavedForm({ date, reason }, command.busy || command.uncertain);
  // A newly fetched balance invalidates a review based on the previous versions.
  useEffect(() => { if (!command.pending()) setReview(null); }, [balances]);
  const prepare = (event: FormEvent) => {
    event.preventDefault(); if (command.busy || command.uncertain || !readReady) return; command.setError('');
    try {
      if (reason.trim().length < 3) throw new Error('Informe o motivo do estorno.');
      if (!date || date > stockDate() || date < reversal.occurred_on) throw new Error('Informe uma data entre a do lançamento e hoje.');
      if (reversal.items.some(item => item.product_id !== product.id)) throw new Error('Este movimento contém outros produtos e precisa de estorno conjunto.');
      const versions = reversal.items.map(item => { const balance = balances.find(row => row.warehouse_id === item.warehouse_id); if (!balance) throw new Error('Atualize os saldos antes de estornar.'); return { product_id: product.id, warehouse_id: item.warehouse_id, expected_version: balance.version }; });
      setReview({ occurred_on: date, reason: reason.trim(), versions });
    } catch (problem) { command.setError((problem as Error).message); }
  };
  const confirm = () => { if (!readReady || (!review && !command.uncertain)) return; void command.run(`/v1/estoque/movimentos/${reversal.id}/estorno`, 'POST', review, value => {
    const answer = value as { movement?: { reverses_id?: unknown }; balance_adjustments?: unknown } | null;
    if (answer?.movement?.reverses_id !== reversal.id || (answer.balance_adjustments !== undefined && !Array.isArray(answer.balance_adjustments))) throw new Error('INVALID_REVERSAL');
    return { balanceKept: Array.isArray(answer.balance_adjustments) && answer.balance_adjustments.length > 0 }; }, result => onSaved(result), problem => stockFailure(problem, negativeAllowed)); };
  const frozen = command.busy || command.uncertain, close = () => { if (!frozen) guard.confirmLeave(onClose); };
  return <StockSidePanel title="Estornar lançamento" wide labelledBy="stock-reversal-title" onClose={close} closeDisabled={frozen}
    footer={review || command.uncertain ? <><button type="button" className="secondary-button" disabled={frozen} onClick={() => { if (!frozen && !command.pending()) setReview(null); }}>Voltar e corrigir</button><button type="button" className="primary-button" disabled={command.busy || !readReady} onClick={confirm}>{command.busy ? 'Registrando…' : command.uncertain ? 'Conferir resultado' : 'Confirmar estorno'}</button></>
      : <><button type="button" className="secondary-button" onClick={close}>Cancelar</button><button type="submit" form="stock-reversal-form" className="primary-button" disabled={!readReady}>Revisar estorno</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}{!command.uncertain && <button type="button" className="text-button" disabled={command.busy} onClick={onRefresh}>Atualizar saldos</button>}</p>}
    {!readReady && <p className="real-notice">Consulte os saldos atuais antes de conferir ou confirmar o estorno.</p>}
    <p className="real-help">Lançamento original de {reversal.occurred_on.split('-').reverse().join('/')} — {reversal.reason}. Será registrado o movimento oposto; o histórico é preservado.</p>
    {review || command.uncertain ? <dl className="stock-edit-facts"><div><dt>Data</dt><dd>{date.split('-').reverse().join('/')}</dd></div><div><dt>Motivo</dt><dd>{reason}</dd></div></dl>
      : <form id="stock-reversal-form" className="stock-panel-form" onSubmit={prepare}><fieldset disabled={!readReady}><legend className="real-sr-only">Dados do estorno</legend>
        <div className="form-field"><label htmlFor="stock-reversal-date">Data</label><input id="stock-reversal-date" type="date" required min={reversal.occurred_on} max={stockDate()} value={date} onChange={event => setDate(event.target.value)} /></div>
        <div className="form-field real-field-wide"><label htmlFor="stock-reversal-reason">Motivo</label><textarea id="stock-reversal-reason" required minLength={3} maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></div>
      </fieldset></form>}
  </StockSidePanel>;
}
