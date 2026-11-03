import { useEffect, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentKind, ItemLot } from '../../../../packages/erp-domain/src/index.mjs';
import { formatUnits, lotOptionsPath, lotProductsPath, lotsProblem, readLotOptions, readLotProducts, withoutLot, type LotOptions } from '../lib/document-item-lots';
import { documentDecimalDisplay, documentDecimalInput, limitedDecimal } from '../lib/document-decimals';
import { Modal } from './Modal';
import { Icon } from './Icon';
import './document-wave-g.css';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
const actorOf = (controller: Controller) => controller.getSnapshot?.()?.membership?.user_id ?? null;
const date = (value: string | null) => value ? value.split('-').reverse().join('/') : '—';

/** The products of the document with "Controle de lote" (Cadastros › Produtos), read once per set of products. */
export function useLotProducts(controller: Controller, kind: DocumentKind, productIds: readonly string[], enabled = true): ReadonlySet<string> {
  const [found, setFound] = useState<ReadonlySet<string>>(() => new Set());
  const key = enabled ? [...new Set(productIds)].sort().join(',') : '';
  useEffect(() => {
    if (!key || (kind !== 'sales_orders' && kind !== 'service_orders')) { setFound(new Set()); return; }
    const request = new AbortController(), actor = actorOf(controller), ids = key.split(',').slice(0, 250);
    void Promise.resolve().then(() => controller.documents(lotProductsPath(kind, ids), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted && actorOf(controller) === actor) setFound(readLotProducts(value, ids)); })
      .catch(() => { if (!request.signal.aborted) setFound(new Set()); });
    return () => request.abort();
  }, [controller, kind, key]);
  return found;
}

/**
 * Origin "Informar lotes" of an item (pedido de venda, peça da OS): Lote (the lots of the product with the quantity in the depósito
 * of the document), Quantidade and "Sem lote" for what is left. Aplicar keeps the lots in the item; the Salvar of the document saves
 * them (with the posted stock the items stay read-only, as the stock guards require).
 */
export default function DocumentItemLots({ controller, kind, item, warehouseId, editable, places, onApply, onClose }: {
  controller: Controller; kind: DocumentKind; warehouseId: string | null; editable: boolean; places: number;
  item: { index: number; product_id: string; description: string; quantity: string; lots: readonly ItemLot[] };
  onApply: (lots: ItemLot[]) => void; onClose: () => void;
}) {
  const [options, setOptions] = useState<LotOptions | null>(null), [error, setError] = useState(''), [problem, setProblem] = useState('');
  const [rows, setRows] = useState(() => item.lots.map(lot => ({ lot_id: lot.lot_id, quantity: lot.quantity.replace(/\.?0+$/, '') })));
  useEffect(() => {
    const request = new AbortController(), actor = actorOf(controller);
    void Promise.resolve().then(() => controller.documents(lotOptionsPath(kind, item.product_id, warehouseId), { signal: request.signal }))
      .then(value => { if (!request.signal.aborted && actorOf(controller) === actor) setOptions(readLotOptions(value, item.product_id)); })
      .catch(() => { if (!request.signal.aborted) setError('Não foi possível consultar os lotes do produto. Feche e tente de novo.'); });
    return () => request.abort();
  }, [controller, kind, item.product_id, warehouseId]);
  const lots = options?.items ?? [];
  const label = (id: string) => { const lot = lots.find(row => row.id === id); return lot ? `${lot.code}${lot.active ? '' : ' (inativo)'}` : 'Lote não encontrado'; };
  const change = (index: number, patch: Partial<{ lot_id: string; quantity: string }>) => { setProblem(''); setRows(current => current.map((row, i) => i === index ? { ...row, ...patch } : row)); };
  const left = withoutLot(rows, item.quantity);
  const apply = () => {
    const message = lotsProblem(rows, item.quantity);
    if (message) { setProblem(message); return; }
    onApply(rows.map(row => ({ lot_id: row.lot_id, quantity: row.quantity })));
  };
  const actions = <>{editable && <button type="button" className="primary-button" disabled={!options} onClick={apply}>Aplicar</button>}<button type="button" className="secondary-button" onClick={onClose}>{editable ? 'Cancelar' : 'Fechar'}</button></>;
  return <Modal title="Informar lotes" onClose={onClose} actions={actions}>
    <p><strong>{item.description}</strong> · Quantidade do item: {documentDecimalDisplay(item.quantity.replace(/\.?0+$/, ''))}{options?.product.unit ? ` ${options.product.unit}` : ''}</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!options && !error && <p role="status">Carregando lotes…</p>}
    {options && !options.product.lot_control && <p className="real-notice" role="note">O produto não tem Controle de lote (Cadastros › Produtos); os lotes já informados podem ser retirados.</p>}
    {options && <table className="data-table document-item-lots"><thead><tr><th>Lote</th><th>Validade</th><th>Saldo</th><th>Quantidade</th>{editable && <th>Ações</th>}</tr></thead>
      <tbody>{rows.map((row, index) => { const lot = lots.find(option => option.id === row.lot_id);
        return <tr key={index}><td>{editable ? <select aria-label={`Lote da linha ${index + 1}`} value={row.lot_id} onChange={event => change(index, { lot_id: event.target.value })}>
          <option value="">Selecione o lote</option>
          {lots.filter(option => option.active || option.id === row.lot_id).map(option => <option key={option.id} value={option.id} disabled={rows.some((other, i) => i !== index && other.lot_id === option.id)}>{option.code}{option.active ? '' : ' (inativo)'}</option>)}</select> : label(row.lot_id)}</td>
          <td>{date(lot?.expires_on ?? null)}</td><td className="numeric">{lot ? formatUnits(BigInt(lot.quantity.replace('.', ''))) : '—'}</td>
          <td>{editable ? <input aria-label={`Quantidade do lote da linha ${index + 1}`} inputMode="decimal" value={documentDecimalDisplay(row.quantity)} onChange={event => change(index, { quantity: documentDecimalInput(limitedDecimal(event.target.value, places)) })} /> : documentDecimalDisplay(row.quantity)}</td>
          {editable && <td><button type="button" className="icon-button" aria-label={`Remover lote da linha ${index + 1}`} onClick={() => { setProblem(''); setRows(current => current.filter((_, i) => i !== index)); }}><Icon name="trash-can" size={12} /></button></td>}</tr>; })}</tbody></table>}
    {options && editable && rows.length < 50 && <button type="button" className="text-button" disabled={!lots.some(option => option.active)} onClick={() => { setProblem(''); setRows(current => [...current, { lot_id: '', quantity: current.length ? '' : item.quantity.replace(/\.?0+$/, '') }]); }}>+ Adicionar lote</button>}
    {options && !lots.some(option => option.active) && editable && <p className="real-help">O produto não tem lotes ativos. Cadastre os lotes em Estoque › Lotes e validades.</p>}
    {left !== null && <p className="real-help">Sem lote: {left}{rows.length ? '' : ' (sem lotes informados, o estoque é lançado sem lote)'}</p>}
    {problem && <p className="real-alert" role="alert">{problem}</p>}
  </Modal>;
}
