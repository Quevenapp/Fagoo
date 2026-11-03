import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { stockAvailabilityActor, stockAvailabilitySelection, stockAvailabilityView } from '../lib/stock-availability';
import './document-pickers.css';

type Controller = Pick<AccessController, 'stockReservations' | 'getSnapshot'>;
type View = ReturnType<typeof stockAvailabilityView>;
const failure = (error: unknown) => { const status = error && typeof error === 'object' && 'status' in error ? (error as { status: unknown }).status : null; return status === 403 ? 'Seu perfil não permite consultar a disponibilidade.' : status === 404 ? 'O produto ou o depósito não está disponível para consulta.' : 'Não foi possível conferir o disponível.'; };

/**
 * Saldo do produto recém-incluído no depósito do documento: físico, reservado e disponível.
 * Uma única leitura (GET); nunca reserva, lança ou impede a inclusão do item.
 */
export default function DocumentProductStock({ controller, product, warehouseId }: { controller: Controller; product: { id: string; name: string; seq: number }; warehouseId: string | null }) {
  const [result, setResult] = useState<{ key: string; view: View | null; error: string } | null>(null);
  const key = `${product.id}:${product.seq}:${warehouseId ?? ''}`, mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const actor = stockAvailabilityActor(controller.getSnapshot());
    if (!warehouseId || !actor) return;
    let selection: ReturnType<typeof stockAvailabilitySelection>;
    try { selection = stockAvailabilitySelection(product.id, warehouseId, [{ warehouse_id: warehouseId, warehouse_name: '', warehouse_active: true }]); } catch { return; }
    const request = new AbortController(), current = () => mounted.current && !request.signal.aborted && stockAvailabilityActor(controller.getSnapshot()) === actor;
    void controller.stockReservations(selection.path, { method: 'GET', signal: request.signal }).then(raw => {
      if (!current()) return;
      let view: View; try { view = stockAvailabilityView(raw, selection); } catch { setResult({ key, view: null, error: 'Não foi possível validar a disponibilidade recebida.' }); return; }
      setResult({ key, view, error: '' });
    }).catch(problem => { if (current()) setResult({ key, view: null, error: failure(problem) }); });
    return () => request.abort();
  }, [controller, product.id, product.seq, warehouseId, key]);
  if (!stockAvailabilityActor(controller.getSnapshot())) return null;
  const shown = result?.key === key ? result : null;
  return <div className="document-product-stock" role="status" aria-live="polite">
    {!warehouseId ? <p className="real-help">{product.name}: o documento não tem depósito previsto, por isso o saldo e o disponível por depósito não foram consultados.</p>
      : !shown ? <p className="real-help">Conferindo o saldo de {product.name} no depósito do documento…</p>
      : shown.view ? <><p><strong>{product.name}</strong> no depósito do documento: Físico {shown.view.physical}{shown.view.physical !== 'Não conferido' && shown.view.unit ? ` ${shown.view.unit}` : ''} · Reservado {shown.view.reserved}{shown.view.unit ? ` ${shown.view.unit}` : ''} · Disponível {shown.view.available}{shown.view.available !== 'Não conferido' && shown.view.unit ? ` ${shown.view.unit}` : ''}</p>
        {shown.view.note && <p className="real-notice">{shown.view.note}</p>}<p className="real-help">Informativo: a inclusão do item não depende do saldo, e ele pode mudar depois desta consulta.</p></>
      : <p className="real-help">{shown.error} O item continua no documento.</p>}
  </div>;
}
