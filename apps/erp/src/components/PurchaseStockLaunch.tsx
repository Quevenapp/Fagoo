import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { quantityText } from '../lib/stock-model';
import { PURCHASE_RECEIPTS_BASE, purchaseItemIssue, purchaseReceiptIntent, purchaseReceiptPreview, purchaseReceiptResult, purchaseReceiptsPage,
  type PurchaseReceiptCurrent, type PurchaseReceiptIntent, type PurchaseReceiptSelection } from '../lib/purchase-receipts-model';
import { selectableWarehouses } from '../lib/stock-supply-model';
import { useStockWarehouseOptions } from './StockSupplierPicker';
import { Modal } from './Modal';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const failure = (error: unknown) => error instanceof AccessError ? error.status === 409 ? 'O pedido ou os saldos mudaram. Feche, atualize a lista e lance de novo.' : error.status === 400 ? 'Confira o depósito (ativo) e os itens do pedido. Itens sem produto, serviços, produtos inativos ou com composição não recebem estoque.' : error.status === 403 ? 'Seu perfil não permite lançar estoque.' : 'Não foi possível concluir. Tente novamente.' : 'Não foi possível concluir. Tente novamente.';
/** The pending quantity of every item that can receive stock ("recebe todo o pendente em um clique"). */
export function pendingItems(current: PurchaseReceiptCurrent): { items: PurchaseReceiptSelection[]; skipped: PurchaseReceiptCurrent['items'] } {
  const open = current.items.filter(item => !/^0(?:\.0+)?$/.test(item.remaining_quantity));
  return { items: open.filter(item => item.eligibility === 'eligible').map(item => ({ item_id: item.item_id, quantity: item.remaining_quantity })),
    skipped: open.filter(item => item.eligibility !== 'eligible') };
}

/** Pedidos de compra > ⋮ Lançar estoque, like Origin: the "Depósitos" modal ("Selecione o depósito", default = depósito do pedido or the
 * depósito padrão) receives every pending item in one click, through the purchase receipts (090) with a chosen warehouse (184).
 * The date follows "Ao lançar estoque utilizar data atual ou data entrada/saída" (277: chosen by the server) and the reason is automatic; partial receipts stay in the order editor. */
export default function PurchaseStockLaunch({ controller, documentId, number, onClose }: { controller: AccessController; documentId: string; number: string; onClose: (changed: boolean) => void }) {
  const warehouses = useStockWarehouseOptions(controller);
  const [current, setCurrent] = useState<PurchaseReceiptCurrent | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [warehouse, setWarehouse] = useState('');
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [done, setDone] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    const request = new AbortController();
    void Promise.resolve().then(() => controller.purchaseReceipts(`${PURCHASE_RECEIPTS_BASE}/${documentId}?limit=25`, { signal: request.signal })).then(raw => {
      if (request.signal.aborted) return; setCurrent(purchaseReceiptsPage(raw, documentId).current); setLoading(false);
    }).catch(problem => { if (!request.signal.aborted && !aborted(problem)) { setError(failure(problem)); setLoading(false); } });
    return () => request.abort();
  }, [controller, documentId]);
  const fixed = current?.document.warehouse_id ?? null;
  // The order's own warehouse always wins, whichever answer arrives first; only an order without one proposes the depósito padrão.
  useEffect(() => { if (warehouse || !warehouses.loaded || !current || fixed) return; setWarehouse(warehouses.options.find(item => item.is_default && item.active)?.id ?? ''); }, [warehouses.loaded, current, fixed]);
  const chosen = fixed ?? warehouse;
  const pending = current ? pendingItems(current) : { items: [], skipped: [] };
  const blocked = !current ? '' : current.document.mode === 'legacy_full' ? 'O estoque deste pedido foi lançado pelo documento inteiro; use Estornar estoque.' : !current.document.eligible ? 'A situação do pedido não permite lançar o estoque (Em andamento, Atendido parcialmente ou Atendido).'
    : !pending.items.length ? 'Não há quantidade pendente para lançar neste pedido.' : '';
  // One receive command at a time: a refusal before any doubt releases it; once the answer is unknown, only the same command settles it.
  const command = useRef<{ intent: PurchaseReceiptIntent; uncertain: boolean } | null>(null);
  const launch = async () => {
    if (busy || done !== null || !current || blocked) return;
    setBusy(true); setError('');
    try {
      if (!command.current) {
        if (!chosen) throw new Error('Selecione o depósito.');
        // 277: no date is asked: the server dates the recebimento by "Ao lançar estoque utilizar data atual ou data entrada/saída".
        const body = { expected_document_version: current.document.version, occurred_on: null, reason: `Lançamento de estoque do pedido de compra nº ${current.document.number}`, items: pending.items,
          ...(fixed ? {} : { warehouse_id: warehouse }) };
        const preview = purchaseReceiptPreview(await controller.purchaseReceipts(`${PURCHASE_RECEIPTS_BASE}/${documentId}/preview`, { method: 'POST', body }), documentId, body, null);
        command.current = { intent: purchaseReceiptIntent(current.document, preview, crypto.randomUUID(), true), uncertain: false };
      }
      const operation = command.current;
      try { purchaseReceiptResult(await controller.purchaseReceipts(operation.intent.path, { method: 'POST', body: operation.intent.body }), operation.intent); }
      catch (problem) {
        if (!operation.uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) { command.current = null; throw problem; }
        operation.uncertain = true; if (alive.current) { setUncertain(true); setError('Não foi possível confirmar o lançamento. Use “Conferir resultado” para repetir o mesmo lançamento sem lançar de novo.'); } return;
      }
      command.current = null; if (alive.current) { setUncertain(false); setDone(operation.intent.body.occurred_on); }
    } catch (problem) { if (alive.current) setError(problem instanceof Error && !(problem instanceof AccessError) && problem.message.startsWith('Selecione') ? problem.message : failure(problem)); }
    finally { if (alive.current) setBusy(false); }
  };
  const close = () => { if (!busy && !uncertain) onClose(done !== null); };
  return <Modal title={`Depósitos · Pedido de compra nº ${number}`} onClose={close}
    actions={done !== null ? <button type="button" className="primary-button" onClick={() => onClose(true)}>Fechar</button>
      : <><button type="button" className="secondary-button" disabled={busy || uncertain} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={busy || loading || Boolean(blocked) || !chosen} onClick={() => void launch()}>{uncertain ? 'Conferir resultado' : 'Lançar'}</button></>}>
    {loading && <p role="status">Consultando o pedido…</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {done !== null ? <p className="real-success" role="status">Estoque lançado no pedido de compra nº {number} em {done.split('-').reverse().join('/')}.</p> : current && <>
      {blocked && <p className="real-notice">{blocked}</p>}
      <div className="form-field"><label htmlFor="purchase-launch-warehouse">Selecione o depósito</label><select id="purchase-launch-warehouse" value={chosen} disabled={busy || uncertain || Boolean(fixed)} onChange={event => setWarehouse(event.target.value)}>
        <option value="">Selecione</option>{selectableWarehouses(warehouses.options, chosen).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {fixed && <small>O pedido já tem depósito; o estoque é lançado nele.</small>}</div>
      {pending.items.length > 0 && <p className="real-help">Serão recebidos {pending.items.length} item(ns) com a quantidade pendente, na data definida em Preferências › Suprimentos › Estoque (data atual, ou a data prevista do pedido). O recebimento parcial continua no pedido de compra.</p>}
      {pending.skipped.length > 0 && <><p className="real-help">Itens que não recebem estoque:</p><ul>{pending.skipped.map(item => <li key={item.item_id}>{item.description} ({quantityText(item.remaining_quantity)} {item.unit}): {purchaseItemIssue(item.eligibility)}</li>)}</ul></>}
    </>}
    {busy && <p className="real-help" role="status">Lançando estoque, aguarde...</p>}
  </Modal>;
}

/** Pedidos de compra > ⋮ "Estornar estoque", like Origin: "Estorno de estoque - Confirmar estorno de estoque?" Sim | Não. One command
 * (225) reverses every active receipt of the order with today's date and the automatic reason; an unknown outcome keeps the command
 * for "Conferir resultado". */
export function PurchaseStockReverse({ controller, documentId, number, version, onClose }: { controller: AccessController; documentId: string; number: string; version: number; onClose: (changed: boolean) => void }) {
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [done, setDone] = useState<number | null>(null);
  const command = useRef<{ id: string; uncertain: boolean } | null>(null), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const confirm = async () => {
    if (busy || done !== null) return;
    command.current ??= { id: crypto.randomUUID(), uncertain: false };
    const operation = command.current; setBusy(true); setError('');
    try {
      const raw = await controller.stock(`/v1/estoque/compras/${documentId}/estorno`, { method: 'POST', body: { command_id: operation.id, expected_version: version } }) as { document_id?: unknown; reversed?: unknown };
      if (raw?.document_id !== documentId || !Array.isArray(raw.reversed)) throw new AccessError(502);
      command.current = null; if (alive.current) { setUncertain(false); setDone(raw.reversed.length); }
    } catch (problem) {
      if (!alive.current) return;
      if (!operation.uncertain && problem instanceof AccessError && [400, 403, 404, 409].includes(problem.status)) {
        command.current = null;
        setError(problem.status === 409 ? 'O pedido ou os saldos mudaram, ou um recebimento não pode ser estornado (o estoque já saiu). Feche, atualize a lista e confira os recebimentos no pedido.'
          : problem.status === 403 ? 'Seu perfil não permite estornar estoque.' : problem.status === 400 ? 'Não há recebimentos ativos para estornar neste pedido.' : 'O pedido não está mais disponível.');
      } else { operation.uncertain = true; setUncertain(true); setError('Não foi possível confirmar o estorno. Use “Conferir resultado” para repetir o mesmo estorno sem estornar de novo.'); }
    } finally { if (alive.current) setBusy(false); }
  };
  const close = () => { if (!busy && !uncertain) onClose(done !== null); };
  return <Modal title="Estorno de estoque" onClose={close}
    actions={done !== null ? <button type="button" className="primary-button" onClick={() => onClose(true)}>Fechar</button>
      : <><button type="button" className="secondary-button" disabled={busy || uncertain} onClick={close}>Não</button><button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>{uncertain ? 'Conferir resultado' : 'Sim'}</button></>}>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {done !== null ? <p className="real-success" role="status">Estoque estornado no pedido de compra nº {number}: {done} recebimento(s).</p> : <>
      <p>Confirmar estorno de estoque?</p>
      <p className="real-help">Todos os recebimentos ativos do pedido de compra nº {number} são estornados, cada um no depósito em que foi recebido, com a data de hoje e o motivo “Estorno do pedido de compra {number}”. Ou todos, ou nenhum.</p></>}
    {busy && <p className="real-help" role="status">Estornando estoque, aguarde...</p>}
  </Modal>;
}
