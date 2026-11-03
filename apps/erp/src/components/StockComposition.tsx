import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import type { AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { quantityText, stockDate, type StockBalance } from '../lib/stock-model';
import { launchBody, launchQuantity, parseLaunchResult } from '../lib/stock-launch-model';
import { POST_MODE_LABELS, STOCK_TYPE_LABELS, parseComposition, parseCompositionLaunch, parseCompositionLaunches, type CompositionLaunchResult, type CompositionLaunchRow, type CompositionView } from '../lib/stock-composition-model';
import { StockSidePanel, stockFailure, useStockCommand } from './StockMovementPanel';
import './stock-composition.css';

// Estoque lane (222): a composição no extrato (Estoque > Lançamentos de estoque). The structure, the saldo virtual, the lançamentos
// of the composition (with the joint reversal) and the "Novo Lançamento" that moves the components as "Lançar estoque" says.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
type Launch = CompositionLaunchRow;

/** The structure of the product in the extrato, read again on each reload; another product's late answer is ignored. */
export function useStockComposition(controller: Pick<AccessController, 'stock'>, product: CatalogRecord | null, reload: number) {
  const id = product?.format === 'E' ? product.id : null, key = id ? `${id}:${reload}` : '';
  const [state, setState] = useState<{ key: string; view: CompositionView | null; error: boolean; launches: Launch[] | null }>({ key: '', view: null, error: false, launches: null });
  useEffect(() => {
    if (!id) return;
    const request = new AbortController();
    // The list of lançamentos is optional: without it the box still shows the structure and the saldo virtual.
    void Promise.all([controller.stock(`/v1/estoque/composicoes/${id}`, { signal: request.signal }),
      controller.stock(`/v1/estoque/composicoes/${id}/lancamentos?limit=10`, { signal: request.signal }).then(list => parseCompositionLaunches(list, id)).catch(() => null)])
      .then(([raw, launches]) => { if (!request.signal.aborted) setState({ key, view: parseComposition(raw, id), error: false, launches }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key, view: null, error: true, launches: null }); });
    return () => request.abort();
  }, [controller, key]);
  return id === null ? { loading: false, view: null, error: false, launches: null } : state.key === key ? { loading: false, ...state } : { loading: true, view: null, error: false, launches: null };
}

/** Why a composition cannot receive a lançamento now (null when it can), and which panel it uses. */
export function compositionLaunch(view: CompositionView | null, loading: boolean): { block: string | null; mode: 'common' | 'composition' } {
  if (loading) return { block: 'Carregando a estrutura da composição…', mode: 'common' };
  if (!view?.composition) return { block: 'Informe a estrutura da composição (aba Estrutura do cadastro do produto) para lançar o estoque.', mode: 'common' };
  if (view.composition.post_mode === 'product') return { block: null, mode: 'common' };
  if (!view.items.length) return { block: 'A estrutura da composição não tem componentes.', mode: 'composition' };
  const problem = view.items.find(item => item.problem);
  return problem ? { block: `O componente ${problem.name} não pode receber lançamentos (inativo, excluído ou sem unidade).`, mode: 'composition' } : { block: null, mode: 'composition' };
}

/** "Composição" box of the extrato: Tipo de estoque, Lançar estoque, components (links to their extrato) and the saldo virtual. */
export function StockCompositionBox({ view, error, launches, writable, onReverse }: { view: CompositionView | null; error: boolean; launches: Launch[] | null; writable: boolean; onReverse: (launch: Launch) => void }) {
  if (error) return <p className="real-alert" role="alert">Não foi possível consultar a estrutura desta composição.</p>;
  if (!view) return <p role="status">Consultando a estrutura…</p>;
  if (!view.composition) return <p className="real-help">Composição sem estrutura: informe os componentes na aba Estrutura do cadastro do produto. As composições espelhadas do Origin chegam sem a estrutura.</p>;
  const virtual = view.composition.stock_type === 'virtual';
  return <section className="stock-composition" aria-labelledby="stock-composition-title">
    <h3 id="stock-composition-title">Estrutura da composição</h3>
    <p>Tipo de estoque: <strong>{STOCK_TYPE_LABELS[view.composition.stock_type]}</strong> · Lançar estoque: <strong>{POST_MODE_LABELS[view.composition.post_mode]}</strong></p>
    <table className="stock-balances"><thead><tr><th>Componente</th><th className="numeric">Qtde</th><th className="numeric">Estoque</th></tr></thead>
      <tbody>{view.items.map(item => <tr key={item.component_id}><td><Link to={`/estoque-empresa?produto=${item.component_id}`}>{[item.code, item.name].filter(Boolean).join(' - ')}</Link></td><td className="numeric">{quantityText(item.quantity)}</td><td className="numeric">{item.stock === null ? '—' : quantityText(item.stock)}</td></tr>)}</tbody></table>
    {virtual && view.virtual && <><p className="real-help">Estoque virtual: <strong>{quantityText(view.virtual.quantity)}</strong> {view.product.unit ?? ''} — máximo de composições completas com os componentes de cada depósito (soma dos depósitos considerados). A composição Virtual não tem saldo próprio: os lançamentos aparecem no extrato de cada componente.</p>
      {view.virtual.warehouses.length > 0 && <table className="stock-balances"><thead><tr><th>Depósito</th><th className="numeric">Estoque virtual</th></tr></thead><tbody>{view.virtual.warehouses.map(w => <tr key={w.warehouse_id} className={w.ignored ? 'is-ignored' : undefined}><td>{w.name}{w.ignored && <small> Saldo deste depósito não é considerado.</small>}</td><td className="numeric">{quantityText(w.quantity)}</td></tr>)}</tbody></table>}</>}
    {!virtual && view.composition.post_mode !== 'product' && <p className="real-help">Entradas e saídas desta composição {view.composition.post_mode === 'components' ? 'movimentam só os componentes' : 'movimentam a composição e os componentes'}; Balanço e transferência valem para o estoque próprio da composição.</p>}
    {launches && launches.length > 0 && <><h3>Lançamentos da composição</h3><table className="stock-balances"><thead><tr><th>Data</th><th>Tipo</th><th>Observação</th><th><span className="real-sr-only">Ações</span></th></tr></thead>
      <tbody>{launches.map(launch => <tr key={launch.movement_id}><td>{launch.occurred_on.split('-').reverse().join('/')}</td><td>{launch.kind === 'issue' ? 'Saída' : 'Entrada'}</td><td>{launch.note}<small className="stock-reference">{launch.lines.map(line => `${line.name}: ${quantityText(line.quantity)}`).join(' · ')}</small></td>
        <td>{launch.reversed_by ? 'Estornado' : writable ? <button type="button" className="text-button" onClick={() => onReverse(launch)}>Estornar lançamento</button> : null}</td></tr>)}</tbody></table></>}
  </section>;
}

/** "Novo Lançamento" of a composition: Tipo Entrada | Saída, Quantidade and Observação, in the header's depósito, dated today. */
export function CompositionLaunchPanel({ controller, product, view, warehouse, readReady, negativeAllowed = null, onClose, onSaved, onRefresh }: {
  controller: Pick<AccessController, 'stock'>; product: CatalogRecord; view: CompositionView; warehouse: StockBalance | null; readReady: boolean; negativeAllowed?: boolean | null;
  onClose: () => void; onSaved: (result: CompositionLaunchResult | { kind: 'balance'; replayed: boolean }) => void; onRefresh: () => void;
}) {
  const [kind, setKind] = useState<'receipt' | 'issue' | 'balance'>('receipt'), [quantity, setQuantity] = useState(''), [note, setNote] = useState('');
  const command = useStockCommand(controller), guard = useUnsavedForm({ kind, quantity, note }, command.busy || command.uncertain);
  const frozen = command.busy || command.uncertain, own = view.composition?.stock_type === 'physical' && view.composition.post_mode === 'both';
  // A Físico composition has a stock of its own: its Balanço is the common lançamento (105) of that stock only.
  const physical = view.composition?.stock_type === 'physical';
  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (command.busy || !readReady || !warehouse) return;
    let body: Record<string, unknown> | null = null;
    if (kind === 'balance') {
      if (!command.uncertain) {
        try { body = launchBody({ kind: 'balance', productId: product.id, warehouseId: warehouse.warehouse_id, expectedVersion: warehouse.version, quantity, unitPrice: '', unitCost: '', note, showPrice: false }); }
        catch (problem) { command.setError((problem as Error).message); return; }
      }
      void command.run('/v1/estoque/lancamentos', 'POST', body, parseLaunchResult, result => onSaved({ kind: 'balance', replayed: result.replayed }), problem => stockFailure(problem, negativeAllowed));
      return;
    }
    if (!command.uncertain) {
      try { body = { kind, warehouse_id: warehouse.warehouse_id, quantity: launchQuantity(quantity, kind), note: note.trim() || null, expected_version: own ? warehouse.version : null }; }
      catch (problem) { command.setError((problem as Error).message); return; }
    }
    void command.run(`/v1/estoque/composicoes/${product.id}/lancamentos`, 'POST', body, (value, sent) => parseCompositionLaunch(value, product.id, sent), onSaved, problem => stockFailure(problem, negativeAllowed));
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  return <StockSidePanel title="Novo Lançamento" labelledBy="composition-launch-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !readReady || !warehouse} onClick={() => save()}>{command.busy ? 'Incluindo…' : command.uncertain ? 'Conferir resultado' : 'Incluir'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}{!command.uncertain && <button type="button" className="text-button" disabled={command.busy} onClick={onRefresh}>Atualizar saldos</button>}</p>}
    <p className="stock-panel-context"><span>Depósito</span><strong>{warehouse?.warehouse_name ?? '—'}</strong></p>
    <form className="stock-panel-form" onSubmit={save}><fieldset disabled={frozen || !readReady}><legend className="real-sr-only">Dados do lançamento da composição</legend>
      <div className="form-field"><label htmlFor="composition-launch-kind">Tipo *</label><select id="composition-launch-kind" value={kind} onChange={event => { setKind(event.target.value as 'receipt' | 'issue' | 'balance'); setQuantity(''); command.setError(''); }}><option value="receipt">Entrada</option><option value="issue">Saída</option>{physical && <option value="balance">Balanço</option>}</select></div>
      <div className="form-field"><label htmlFor="composition-launch-quantity">Quantidade</label><input id="composition-launch-quantity" required inputMode="decimal" maxLength={20} value={quantity} onChange={event => setQuantity(event.target.value)} /><small>{kind === 'balance' ? 'Novo saldo do estoque próprio da composição neste depósito; os componentes não mudam.' : 'Quantidade de composições.'}</small></div>
      <div className="form-field real-field-wide"><label htmlFor="composition-launch-note">Observação</label><textarea id="composition-launch-note" maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} /></div>
    </fieldset></form>
    {kind === 'balance' ? <p className="real-help">Balanço do estoque próprio da composição Físico{warehouse ? ` (saldo atual: ${warehouse.version === 0 ? 'sem lançamentos' : quantityText(warehouse.quantity)})` : ''}.</p> : <>
      <p className="real-help">Lançar estoque: {view.composition ? POST_MODE_LABELS[view.composition.post_mode] : '—'}. Serão lançados{own ? ` a composição (${quantity.trim() || '0'}) e` : ''} os componentes:</p>
      <ul className="stock-composition-lines">{view.items.map(item => <li key={item.component_id}>{item.name}: {quantityText(item.quantity)} por composição</li>)}</ul>
      <p className="real-help">Os componentes são lançados sem preço, num único movimento: ou todos, ou nenhum.{physical ? ' A transferência vale para o estoque próprio da composição.' : ''}</p></>}
  </StockSidePanel>;
}

/** Joint reversal of a composition lançamento (every position of the movement), dated from its date up to today. */
export function CompositionReversalPanel({ controller, launch, negativeAllowed = null, onClose, onSaved }: { controller: Pick<AccessController, 'stock'>; launch: Launch; negativeAllowed?: boolean | null; onClose: () => void; onSaved: () => void }) {
  const today = stockDate();
  const [day, setDay] = useState(today), [reason, setReason] = useState('');
  const command = useStockCommand(controller), guard = useUnsavedForm({ day, reason }, command.busy || command.uncertain), frozen = command.busy || command.uncertain;
  const save = () => {
    if (command.busy) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < launch.occurred_on || day > today) { command.setError('Informe uma data entre a data do lançamento e hoje.'); return; }
      if (reason.trim().length < 3 || /[\n\r]/.test(reason)) { command.setError('Informe o motivo do estorno, em uma linha, com pelo menos 3 caracteres.'); return; }
      body = { occurred_on: day, reason: reason.trim(), versions: launch.lines.map(line => ({ product_id: line.product_id, warehouse_id: line.warehouse_id, expected_version: line.expected_version })) };
    }
    void command.run(`/v1/estoque/movimentos/${launch.movement_id}/estorno`, 'POST', body, value => { const movement = (value as { movement?: { kind?: unknown; reverses_id?: unknown } }).movement; if (movement?.kind !== 'reversal' || movement.reverses_id !== launch.movement_id) throw new Error('INVALID'); return value; },
      () => onSaved(), problem => stockFailure(problem, negativeAllowed));
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  return <StockSidePanel title="Estornar lançamento" labelledBy="composition-reversal-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Estornando…' : command.uncertain ? 'Conferir resultado' : 'Estornar'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    <p>O estorno lança o movimento oposto em todas as posições deste lançamento da composição:</p>
    <ul className="stock-composition-lines">{launch.lines.map(line => <li key={`${line.product_id}:${line.warehouse_id}`}>{line.name}: {quantityText(line.quantity.startsWith('-') ? line.quantity.slice(1) : `-${line.quantity}`)}</li>)}</ul>
    <form className="stock-panel-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={frozen}><legend className="real-sr-only">Estorno</legend>
      <div className="form-field"><label htmlFor="composition-reversal-date">Data *</label><input id="composition-reversal-date" type="date" min={launch.occurred_on} max={today} value={day} onChange={event => setDay(event.target.value)} /></div>
      <div className="form-field real-field-wide"><label htmlFor="composition-reversal-reason">Motivo *</label><input id="composition-reversal-reason" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></div>
    </fieldset></form>
  </StockSidePanel>;
}
export type { Launch as CompositionLaunch };
