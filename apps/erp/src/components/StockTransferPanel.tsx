import { useState } from 'react';
import { useUnsavedForm } from '../hooks/useUnsavedChanges';
import type { AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { quantityText, type StockBalance } from '../lib/stock-model';
import { TRANSFER_COST_INFO, launchBody, parseLaunchResult, priceText, units, type LaunchResult } from '../lib/stock-launch-model';
// 258: Lote of the transfer (Origin field "Lote"): the lot leaves the source and enters the destination.
import { EMPTY_LOT, launchLot } from '../lib/stock-lots-model';
import { LotPicker, useStockLots } from './StockLots';
import { HIDDEN_PRICE_HELP, StockSidePanel, stockFailure, useStockCommand, type LaunchSuggestion } from './StockMovementPanel';
import StockPrintPreview from './StockPrintPreview';
import { Icon } from './Icon';

const localMoment = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
/** "Transferência entre depósitos" of Origin: both lines of the 009 transfer, with Preço un. and Custo Un., and a printable receipt. */
export default function StockTransferPanel({ controller, product, balances, readReady, initialSource, suggestion, negativeAllowed = null, showPrice = true, lotControl = false, onClose, onSaved, onRefresh }: {
  controller: Pick<AccessController, 'stock'>; product: CatalogRecord; balances: StockBalance[]; readReady: boolean; initialSource: string; suggestion: Pick<LaunchSuggestion, 'purchase' | 'cost'>;
  negativeAllowed?: boolean | null; showPrice?: boolean; lotControl?: boolean; onClose: () => void; onSaved: (result: LaunchResult) => void; onRefresh: () => void;
}) {
  const active = balances.filter(item => item.warehouse_active);
  const firstOther = (source: string) => active.find(item => item.warehouse_id !== source)?.warehouse_id ?? '';
  const start = active.some(item => item.warehouse_id === initialSource) ? initialSource : active[0]?.warehouse_id ?? '';
  const [quantity, setQuantity] = useState(''), [price, setPrice] = useState(suggestion.purchase), [cost, setCost] = useState(suggestion.cost);
  const [source, setSource] = useState(start), [destination, setDestination] = useState(firstOther(start)), [note, setNote] = useState('Transferência');
  const [done, setDone] = useState<{ result: LaunchResult; source: string; destination: string } | null>(null), [printing, setPrinting] = useState(false);
  const [lotChoice, setLotChoice] = useState('');
  const lots = useStockLots(controller, lotControl ? product.id : null, source || null, 'ativos', 0);
  const command = useStockCommand(controller), guard = useUnsavedForm({ quantity, price, cost, source, destination, note, lotChoice }, command.busy || command.uncertain);
  const frozen = command.busy || command.uncertain, unit = typeof product.unit === 'string' ? product.unit : '';
  const name = (id: string) => balances.find(item => item.warehouse_id === id)?.warehouse_name ?? 'Depósito';
  const saldo = (id: string) => { const row = balances.find(item => item.warehouse_id === id); return row ? row.version === 0 ? 'sem lançamentos' : `${quantityText(row.quantity)} ${unit}` : '—'; };
  // Origin recalculates the destination when the origin changes.
  const changeSource = (id: string) => { setSource(id); setLotChoice(''); if (!destination || destination === id) setDestination(firstOther(id)); };
  const save = () => {
    if (command.busy || !readReady || done) return;
    let body: Record<string, unknown> | null = null;
    if (!command.uncertain) {
      const from = active.find(item => item.warehouse_id === source), to = active.find(item => item.warehouse_id === destination);
      try {
        if (!from) throw new Error('Selecione um depósito de origem ativo.');
        body = launchBody({ kind: 'transfer', productId: product.id, warehouseId: from.warehouse_id, expectedVersion: from.version, quantity, unitPrice: price, unitCost: cost, note, destinationId: to?.warehouse_id, destinationVersion: to?.version, showPrice });
        if (lotControl && lotChoice) {
          if (!lots.page) throw new Error('Aguarde a consulta dos lotes do produto.');
          const lot = launchLot(lotChoice, EMPTY_LOT, lots.page.settings, 'transfer'), chosen = lots.page.items.find(item => item.id === lotChoice);
          if (chosen && units(chosen.quantity) < units(String(body.quantity))) throw new Error('O lote não tem saldo suficiente no depósito de origem.');
          if (lot) body.lot = lot;
        }
      } catch (problem) { command.setError((problem as Error).message); return; }
    }
    void command.run('/v1/estoque/lancamentos', 'POST', body, parseLaunchResult, result => { setDone({ result, source, destination }); onSaved(result); }, problem => stockFailure(problem, negativeAllowed));
  };
  const close = () => { if (!frozen) done ? onClose() : guard.confirmLeave(onClose); };
  if (done) {
    const out = done.result.movement.items.find(line => line.warehouse_id === done.source), moved = out ? out.quantity.replace(/^-/, '') : '';
    return <StockSidePanel title="Transferência entre depósitos" labelledBy="stock-transfer-title" onClose={onClose}
      footer={<><button type="button" className="secondary-button" onClick={onClose}>Fechar</button><button type="button" className="primary-button" onClick={() => setPrinting(true)}><Icon name="print" size={13} />IMPRIMIR COMPROVANTE TRANSFERÊNCIA</button></>}>
      <p className="real-success" role="status">Transferência registrada.{done.result.replayed ? ' O resultado já tinha sido registrado; nada foi lançado de novo.' : ''}</p>
      <dl className="stock-edit-facts"><div><dt>Quantidade</dt><dd>{quantityText(moved)} {unit}</dd></div>{done.result.lot && <div><dt>Lote</dt><dd>{done.result.lot.code}</dd></div>}<div><dt>Depósito de origem</dt><dd>{name(done.source)}</dd></div><div><dt>Depósito de destino</dt><dd>{name(done.destination)}</dd></div><div><dt>Observações</dt><dd>{done.result.detail.note}</dd></div></dl>
      {printing && <StockPrintPreview title="Comprovante de transferência" onClose={() => setPrinting(false)}>
        <h1>Comprovante de transferência entre depósitos</h1>
        <dl><div><dt>Produto</dt><dd>{[product.code, product.name].filter(Boolean).join(' - ')}</dd></div><div><dt>Quantidade</dt><dd>{quantityText(moved)} {unit}</dd></div>{done.result.lot && <div><dt>Lote</dt><dd>{done.result.lot.code}</dd></div>}
          <div><dt>Depósito de origem</dt><dd>{name(done.source)}</dd></div><div><dt>Depósito de destino</dt><dd>{name(done.destination)}</dd></div>
          <div><dt>Preço un.</dt><dd>{priceText(done.result.detail.unit_price)}</dd></div><div><dt>Custo Un.</dt><dd>{priceText(done.result.detail.unit_cost)}</dd></div>
          <div><dt>Data</dt><dd>{done.result.occurred_on.split('-').reverse().join('/')}</dd></div><div><dt>Observações</dt><dd>{done.result.detail.note}</dd></div></dl>
        <div className="stock-print-signatures"><span>Responsável pela saída</span><span>Responsável pela entrada</span></div>
        <p className="stock-print-foot">Lançamento {done.result.movement.id} · impresso em {localMoment(new Date().toISOString())} (horário de São Paulo).</p>
      </StockPrintPreview>}
    </StockSidePanel>;
  }
  return <StockSidePanel title="Transferência entre depósitos" labelledBy="stock-transfer-title" onClose={close} closeDisabled={frozen}
    footer={<><button type="button" className="secondary-button" disabled={frozen} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={command.busy || !readReady} onClick={save}>{command.busy ? 'Salvando…' : command.uncertain ? 'Conferir resultado' : 'Salvar'}</button></>}>
    {command.error && <p className="real-alert" role="alert">{command.error}{!command.uncertain && <button type="button" className="text-button" disabled={command.busy} onClick={onRefresh}>Atualizar saldos</button>}</p>}
    {!readReady && <p className="real-notice">Consulte os saldos atuais antes de transferir.</p>}
    <form className="stock-panel-form" onSubmit={event => { event.preventDefault(); save(); }}><fieldset disabled={frozen || !readReady}><legend className="real-sr-only">Dados da transferência</legend>
      <div className="form-field"><label htmlFor="stock-transfer-quantity">Quantidade</label><input id="stock-transfer-quantity" required inputMode="decimal" maxLength={20} value={quantity} onChange={event => setQuantity(event.target.value)} /></div>
      {showPrice ? <><div className="form-field"><label htmlFor="stock-transfer-price">Preço un.</label><input id="stock-transfer-price" required inputMode="decimal" maxLength={26} value={price} onChange={event => setPrice(event.target.value)} /></div>
      <div className="form-field"><label htmlFor="stock-transfer-cost">Custo Un. <span className="stock-info" title={TRANSFER_COST_INFO} aria-label={TRANSFER_COST_INFO}><Icon name="circle-info" size={11} /></span></label><input id="stock-transfer-cost" required inputMode="decimal" maxLength={26} value={cost} onChange={event => setCost(event.target.value)} /></div></>
        : <p className="real-help real-field-wide">{HIDDEN_PRICE_HELP}</p>}
      <div className="form-field"><label htmlFor="stock-transfer-source">Depósito de origem</label><select id="stock-transfer-source" value={source} onChange={event => changeSource(event.target.value)}>{active.map(item => <option key={item.warehouse_id} value={item.warehouse_id}>{item.warehouse_name}</option>)}</select><small>Saldo: {saldo(source)}</small></div>
      <div className="form-field"><label htmlFor="stock-transfer-destination">Depósito de destino</label><select id="stock-transfer-destination" value={destination} onChange={event => setDestination(event.target.value)}><option value="">Selecione</option>{active.filter(item => item.warehouse_id !== source).map(item => <option key={item.warehouse_id} value={item.warehouse_id}>{item.warehouse_name}</option>)}</select><small>Saldo: {saldo(destination)}</small></div>
      {lotControl && <LotPicker id="stock-transfer-lot" page={lots.page} error={lots.error} kind="transfer" unit={unit} choice={lotChoice} draft={EMPTY_LOT} onChoice={setLotChoice} onDraft={() => {}} />}
      <div className="form-field real-field-wide"><label htmlFor="stock-transfer-note">Observações</label><textarea id="stock-transfer-note" maxLength={500} rows={3} value={note} onChange={event => setNote(event.target.value)} /></div>
    </fieldset></form>
  </StockSidePanel>;
}
