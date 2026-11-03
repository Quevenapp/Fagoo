import { useEffect, useState } from 'react';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { lotDay } from '../lib/stock-lots-model';
import { LINE_REASON_TEXT, NEW_LOT_CHOICE, allocation, directionText, freeQuantity, lotsBody, offeredLots, parseLotsAssign, parseMovementLots, parseSourceLots,
  type LineReason, type LotAllocation, type LotLine, type MovementLots, type SourceLots } from '../lib/stock-movement-lots-model';
import { StockSidePanel, useStockCommand } from './StockMovementPanel';
import { Icon } from './Icon';
import './stock.css';

// Estoque lane, onda F (278): "Informar lotes de produtos" (Origin side panel: Produto, Quantidade, Lote, Validade, Fabricação and the
// menu "Dividir os lotes / Adicionar novo lote / Remover lote", with "Novo lote" and "Sem lote") for a recorded line of the razão, and
// the "Informações de lote lançado" of an item of a pedido, OS or nota fiscal. The server keeps every rule (lot never negative, never
// more than the line or the "Sem lote" of the warehouse, required dates); the panel explains them first.
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const ORIGIN_TEXT: Record<string, string> = { sales: 'Pedido de venda', purchases: 'Pedido de compra', services: 'Ordem de serviço', transfers: 'Transferência', invoices: 'Nota fiscal', none: 'Lançamento manual' };
const KIND_TEXT: Record<string, string> = { sales_orders: 'Pedido de venda', purchase_orders: 'Pedido de compra', service_orders: 'Ordem de serviço' };
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'Os lotes deste lançamento mudaram em outra operação. Feche, abra de novo e confira antes de salvar.'
  : error.status === 400 ? 'Confira os lotes: o lote precisa ter saldo no depósito (Saída), o código não pode se repetir no produto, as datas obrigatórias de Preferências › Cadastros › Controle de lotes precisam estar preenchidas e a soma não pode passar do que está sem lote.'
    : error.status === 403 ? 'Seu perfil não permite informar lotes deste lançamento.' : error.status === 404 ? 'O lançamento ou o lote não está mais disponível.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
const readFailure = (error: unknown) => error instanceof AccessError && error.status === 403 ? 'Seu perfil não consulta os lotes deste lançamento.'
  : error instanceof AccessError && error.status === 404 ? 'O lançamento não está mais disponível.' : 'Não foi possível consultar os lotes. Tente novamente.';
const strip = (rows: readonly LotAllocation[]) => JSON.stringify(rows.map(({ key: _key, ...row }) => row));
const originText = (line: LotLine) => `${ORIGIN_TEXT[line.origin.type] ?? 'Lançamento'}${line.origin.document_number ? ` nº ${line.origin.document_number}` : ''}`;

/** The lots already informed in a line and what stays "Sem lote". */
function InformedLots({ line, unit }: { line: LotLine; unit: string }) {
  return <>{line.lots.length > 0 ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Lote</th><th>Validade</th><th>Fabricação</th><th className="numeric">Quantidade</th></tr></thead>
    <tbody>{line.lots.map(lot => <tr key={lot.lot_id}><td>{lot.code}</td><td>{lotDay(lot.expires_on)}</td><td>{lotDay(lot.manufactured_on)}</td><td className="numeric">{quantityText(lot.quantity)} {unit}</td></tr>)}</tbody></table></div>
    : <p className="real-help">Nenhum lote informado neste lançamento.</p>}
    <p className="stock-lot-unassigned">Sem lote: <strong>{quantityText(line.unassigned)} {unit}</strong></p></>;
}

/** "Informar lotes de produtos" of one line (movement, product, warehouse). */
export function MovementLotsPanel({ controller, movementId, productId, warehouseId, onClose, onSaved }: {
  controller: Pick<AccessController, 'stock'>; movementId: string; productId: string; warehouseId: string; onClose: () => void; onSaved: (view: MovementLots) => void;
}) {
  const [view, setView] = useState<MovementLots | null>(null), [readError, setReadError] = useState(''), [reload, setReload] = useState(0);
  const [rows, setRows] = useState<LotAllocation[]>([]), [baseline, setBaseline] = useState('[]');
  const command = useStockCommand(controller, 'Não foi possível confirmar os lotes. Use “Conferir resultado” para repetir o mesmo comando sem informar os lotes de novo.');
  const frozen = command.busy || command.uncertain;
  const guard = useUnsavedChanges(strip(rows) !== baseline, frozen);
  useEffect(() => {
    const request = new AbortController(), query = new URLSearchParams({ product_id: productId, warehouse_id: warehouseId });
    setView(null); setReadError('');
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/lotes/movimentos/${movementId}?${query}`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return;
      const value = parseMovementLots(raw, movementId, productId, warehouseId);
      const first = value.can_write && value.line.assignable ? [allocation('', freeQuantity([], value.room))] : [];
      setView(value); setRows(first); setBaseline(strip(first));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) setReadError(problem instanceof Error && problem.message === 'INVALID_MOVEMENT_LOTS_RESPONSE' ? 'Não foi possível validar a consulta dos lotes. Tente novamente.' : readFailure(problem)); });
    return () => request.abort();
  }, [controller, movementId, productId, warehouseId, reload]);
  const unit = view?.product.unit ?? '';
  const editing = Boolean(view && view.can_write && view.line.assignable);
  const set = (key: string, patch: Partial<LotAllocation>) => { if (!frozen) setRows(current => current.map(row => row.key === key ? { ...row, ...patch } : row)); };
  // Origin menu of a row: "Dividir os lotes" (a new row with what is still free), "Adicionar novo lote", "Remover lote".
  const split = () => { if (!frozen && view) setRows(current => [...current, allocation('', freeQuantity(current, view.room))]); };
  const addNew = () => { if (!frozen && view) setRows(current => [...current, allocation(NEW_LOT_CHOICE, freeQuantity(current, view.room))]); };
  const remove = (key: string) => { if (!frozen) setRows(current => current.filter(row => row.key !== key)); };
  const save = () => {
    if (!view || command.busy) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) { try { body = lotsBody(view, rows); } catch (problem) { command.setError((problem as Error).message); return; } }
    void command.run(`/v1/estoque/lotes/movimentos/${movementId}`, 'POST', body, (value, sent) => parseLotsAssign(value, movementId, sent), result => {
      setRows([]); setBaseline('[]'); onSaved(result);
    }, failure);
  };
  const close = () => { if (!frozen) guard.confirmLeave(onClose); };
  const line = view?.line;
  return <StockSidePanel title="Informar lotes de produtos" wide labelledBy="stock-movement-lots-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>{editing ? 'Cancelar' : 'Fechar'}</button>
      {editing && <button type="button" className="primary-button" disabled={command.busy} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button>}</>}>
    {readError && <p className="real-alert" role="alert">{readError}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Consultar de novo</button></p>}
    {!view && !readError && <p role="status">Consultando os lotes do lançamento…</p>}
    {command.error && <p className="real-alert" role="alert">{command.error}</p>}
    {view && line && <>
      <dl className="stock-edit-facts">
        <div><dt>Produto</dt><dd>{view.product.name}{view.product.code ? ` · ${view.product.code}` : ''}</dd></div>
        <div><dt>Depósito</dt><dd>{line.warehouse_name}</dd></div>
        <div><dt>Lançamento</dt><dd>{directionText(line.direction)} de {lotDay(line.occurred_on)} · {originText(line)}</dd></div>
        <div><dt>Quantidade</dt><dd>{quantityText(line.quantity)} {unit}</dd></div>
      </dl>
      <h3>Lotes informados</h3>
      <InformedLots line={line} unit={unit} />
      {!line.assignable && line.reason_code && <p className="real-help">{LINE_REASON_TEXT[line.reason_code as Exclude<LineReason, null>]}</p>}
      {line.assignable && !view.can_write && <p className="real-help">Somente administrador e estoque informam lotes.</p>}
      {editing && <fieldset className="stock-lot-rows" disabled={frozen}><legend>Informar lotes</legend>
        {line.direction === 'receipt' && view.room !== line.unassigned && <p className="real-help">Pode ser informado até {quantityText(view.room)} {unit}: o resto do saldo deste lançamento já saiu do depósito sem lote.</p>}
        {rows.map((row, index) => <div className="stock-lot-row" key={row.key}>
          <div className="form-field"><label htmlFor={`${row.key}-lot`}>Lote</label><select id={`${row.key}-lot`} value={row.choice} onChange={event => set(row.key, { choice: event.target.value })}>
            <option value="">Selecione</option>{offeredLots(view).map(lot => <option key={lot.id} value={lot.id}>{lot.code}{lot.expires_on ? ` · validade ${lotDay(lot.expires_on)}` : ''}{line.direction === 'issue' ? ` · saldo ${quantityText(lot.quantity)} ${unit}` : ''}</option>)}
            {line.direction === 'receipt' && <option value={NEW_LOT_CHOICE}>Novo lote</option>}</select></div>
          {row.choice === NEW_LOT_CHOICE && <>
            <div className="form-field"><label htmlFor={`${row.key}-code`}>Código do Lote *</label><input id={`${row.key}-code`} maxLength={60} value={row.code} onChange={event => set(row.key, { code: event.target.value })} /></div>
            <div className="form-field"><label htmlFor={`${row.key}-expires`}>Validade{view.settings.require_expiry ? ' *' : ''}</label><input id={`${row.key}-expires`} type="date" min="1900-01-01" max="2100-12-31" value={row.expires_on} onChange={event => set(row.key, { expires_on: event.target.value })} /></div>
            <div className="form-field"><label htmlFor={`${row.key}-made`}>Fabricação{view.settings.require_manufacture ? ' *' : ''}</label><input id={`${row.key}-made`} type="date" min="1900-01-01" max="2100-12-31" value={row.manufactured_on} onChange={event => set(row.key, { manufactured_on: event.target.value })} /></div></>}
          <div className="form-field"><label htmlFor={`${row.key}-quantity`}>Quantidade</label><input id={`${row.key}-quantity`} inputMode="decimal" maxLength={20} value={row.quantity} onChange={event => set(row.key, { quantity: event.target.value })} /></div>
          <div className="stock-lot-row-actions" role="group" aria-label={`Ações do lote ${index + 1}`}>
            <button type="button" className="text-button" onClick={split}>Dividir os lotes</button>
            {line.direction === 'receipt' && <button type="button" className="text-button" onClick={addNew}>Adicionar novo lote</button>}
            <button type="button" className="text-button" onClick={() => remove(row.key)}><Icon name="trash-can" size={11} /> Remover lote</button></div>
        </div>)}
        {!rows.length && <button type="button" className="secondary-button" onClick={split}>Informar lote</button>}
        <p className="real-help">O que não for informado continua “Sem lote”.</p>
      </fieldset>}
    </>}
  </StockSidePanel>;
}

/** "Informações de lote lançado" of an item: the lines posted by the document (pedido, OS, compra) or by the note, with their lots. */
export function SourceLotsPanel({ controller, source, sourceId, productId, description, onClose }: {
  controller: Pick<AccessController, 'stock'>; source: 'document' | 'invoice'; sourceId: string; productId: string; description: string; onClose: () => void;
}) {
  const [view, setView] = useState<SourceLots | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [open, setOpen] = useState<LotLine | null>(null), [notice, setNotice] = useState('');
  useEffect(() => {
    const request = new AbortController(), query = new URLSearchParams({ [source === 'document' ? 'documento' : 'nota']: sourceId, product_id: productId });
    setError('');
    void Promise.resolve().then(() => controller.stock(`/v1/estoque/lotes/origem?${query}`, { signal: request.signal })).then(raw => {
      if (!request.signal.aborted) setView(parseSourceLots(raw, source, sourceId, productId));
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setView(null); setError(readFailure(problem)); } });
    return () => request.abort();
  }, [controller, source, sourceId, productId, reload]);
  const unit = view?.product.unit ?? '';
  if (open) return <MovementLotsPanel controller={controller} movementId={open.movement_id} productId={productId} warehouseId={open.warehouse_id}
    onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setNotice('Lotes informados.'); setReload(value => value + 1); }} />;
  return <StockSidePanel title="Informações de lote lançado" wide labelledBy="stock-source-lots-title" onClose={onClose}
    footer={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <p className="stock-panel-context"><span>Item</span><strong>{description}</strong></p>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error}<button type="button" className="text-button" onClick={() => setReload(value => value + 1)}>Consultar de novo</button></p>}
    {!view && !error && <p role="status">Consultando o estoque lançado…</p>}
    {view && <>
      {!view.product.lot_control && <p className="real-notice">O produto não está com “Controle de lote” ligado (Cadastros › Produtos › Estoque). Os lotes já informados continuam aparecendo.</p>}
      {view.reference && <p className="real-help">Estoque lançado pela referência: {KIND_TEXT[view.reference.kind] ?? 'Documento'} nº {view.reference.number}.</p>}
      {!view.posted ? <p className="real-help">{source === 'document' ? 'O estoque deste documento ainda não foi lançado (ou foi estornado). Os lotes são informados depois de “Lançar estoque”.'
        : 'O estoque desta nota ainda não foi lançado (ou foi estornado). Os lotes são informados depois de “Lançar estoque”.'}</p>
        : !view.lines.length ? <p className="real-help">Este produto não está no estoque lançado (serviço, item sem produto ou composição desmembrada).</p>
          : view.lines.map(line => <section className="stock-lot-source" key={`${line.movement_id}:${line.warehouse_id}`} aria-label={`${directionText(line.direction)} de ${lotDay(line.occurred_on)}`}>
            <h3>{directionText(line.direction)} de {lotDay(line.occurred_on)} · {line.warehouse_name} · {quantityText(line.quantity)} {unit}</h3>
            <InformedLots line={line} unit={unit} />
            {line.assignable && view.can_write ? <button type="button" className="secondary-button" onClick={() => { setNotice(''); setOpen(line); }}>Informar lotes</button>
              : line.reason_code && line.reason_code !== 'assigned' ? <p className="real-help">{LINE_REASON_TEXT[line.reason_code as Exclude<LineReason, null>]}</p> : null}
          </section>)}
    </>}
  </StockSidePanel>;
}
