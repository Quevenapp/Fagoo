import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import { ITEM_STOCK_TONES, itemStockView, type ItemStockView } from '../lib/document-item-stock-model';
import { EMPTY_POSITION_FILTERS, positionParams, stockPositionPage } from '../lib/stock-positions-model';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'stock' | 'stockPositions' | 'getSnapshot'>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;

/**
 * Origin "Todos os depósitos" (cubos) of an item: estoque atual, reservado and disponível per depósito, mínimo and máximo of the
 * cadastro and the balance after the document in its depósito. Two reads (GET); nothing is reserved or posted.
 */
export default function DocumentItemStock({ controller, kind, item, warehouseId, onClose }: {
  controller: Controller; kind: DocumentKind; item: { productId: string; description: string; code: string | null; quantity: string }; warehouseId: string | null; onClose: () => void;
}) {
  const [view, setView] = useState<ItemStockView | null>(null), [error, setError] = useState(''), [limitsKnown, setLimitsKnown] = useState(true);
  const actor = useRef(actorOf(controller));
  useEffect(() => {
    const request = new AbortController();
    const query = (item.code || item.description).slice(0, 120);
    const limits = Promise.resolve().then(() => controller.stockPositions(`/v1/posicoes-estoque?${positionParams({ ...EMPTY_POSITION_FILTERS, q: query })}`, { signal: request.signal }))
      .then(value => stockPositionPage(value, { ...EMPTY_POSITION_FILTERS, q: query }).items.find(row => row.product.id === item.productId)?.product ?? null).catch(() => null);
    void Promise.all([Promise.resolve().then(() => controller.stock(`/v1/estoque/saldos?product_id=${item.productId}`, { signal: request.signal })), limits]).then(([balances, product]) => {
      if (request.signal.aborted) return;
      if (actorOf(controller) !== actor.current) { setError('A sessão mudou. Feche e abra a consulta novamente.'); return; }
      setLimitsKnown(Boolean(product));
      setView(itemStockView(kind, item.productId, balances, item.quantity, warehouseId, { min: product?.stock_min ?? null, max: product?.stock_max ?? null }));
    }).catch(failure => {
      if (request.signal.aborted || aborted(failure)) return;
      setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não permite consultar o estoque.' : 'Não foi possível consultar o estoque deste produto. Tente novamente.');
    });
    return () => request.abort();
  }, [controller, kind, item.productId, item.code, item.description, item.quantity, warehouseId]);
  const unit = view?.unit ? ` ${view.unit}` : '';
  return <Modal title="Todos os depósitos" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <p><strong>{item.description}</strong>{item.code ? ` · ${item.code}` : ''}</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!error && !view && <p role="status">Consultando o estoque…</p>}
    {view && <>
      <dl className="document-total-summary"><div><dt>Estoque mínimo</dt><dd>{view.min ?? 'Não informado'}</dd></div><div><dt>Estoque máximo</dt><dd>{view.max ?? 'Não informado'}</dd></div>
        <div className={`document-item-stock-${view.tone}`}><dt>{view.afterLabel} (total)</dt><dd>{view.totalAfter}{unit} · {ITEM_STOCK_TONES[view.tone]}</dd></div></dl>
      {view.rows.length ? <table className="data-table"><thead><tr><th>Depósito</th><th>Estoque atual</th><th>Reservado</th><th>Disponível</th><th>{view.afterLabel}</th></tr></thead>
        <tbody>{view.rows.map(row => <tr key={row.warehouseId}><td>{row.name}{row.isDefault ? ' (padrão)' : ''}{row.ignored ? ' · saldo desconsiderado' : ''}</td><td className="numeric">{row.current}{unit}</td>
          <td className="numeric">{row.reserved}{unit}</td><td className="numeric">{row.available}{unit}</td><td className="numeric">{row.after === null ? '—' : `${row.after}${unit}`}</td></tr>)}
          <tr><th scope="row">Total dos depósitos considerados</th><td className="numeric">{view.total}{unit}</td><td /><td /><td className="numeric">{view.totalAfter}{unit}</td></tr></tbody></table>
        : <p className="real-help">Nenhum depósito ativo tem saldo lançado deste produto.</p>}
      {!limitsKnown && <small className="real-help">O mínimo e o máximo do cadastro não foram encontrados nesta consulta.</small>}
      <small className="real-help">{warehouseId ? 'O saldo depois do documento é calculado no depósito do documento.' : 'Sem depósito no documento, o saldo depois do documento é calculado no depósito padrão.'} Informativo: o saldo pode mudar depois desta consulta.</small></>}
  </Modal>;
}
