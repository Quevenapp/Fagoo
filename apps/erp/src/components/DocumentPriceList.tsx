import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { applicableListsPath, readApplicableLists, type PriceListOption } from '../lib/document-price-list-model';

type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;

/**
 * Origin "Lista de preço" of the pedido de venda and of the proposta (Cadastros › Listas de preços): only the lists that apply now to
 * the cliente, its UF, the vendedor of the document and the formas de pagamento of its parcelas (202610200282, decided on the server).
 * The chosen list prices the products included afterwards; "Aplicar a lista aos itens" prices the current lines. The price stays
 * editable and nothing is saved until the document is saved.
 */
export default function DocumentPriceList({ controller, contact, seller = null, paymentMethods = [], selected, disabled, busy, applicable, onSelect, onApply }: {
  controller: Controller; contact: { id: string; state: string | null } | null; seller?: string | null; paymentMethods?: readonly string[];
  selected: { id: string; name: string } | null; disabled: boolean; busy: string;
  applicable: number; onSelect: (list: { id: string; name: string } | null, reason?: string) => void; onApply: () => void;
}) {
  const [lists, setLists] = useState<PriceListOption[] | null>(null), [error, setError] = useState('');
  const actor = useRef(actorOf(controller)), live = useRef({ selected, onSelect }); live.current = { selected, onSelect };
  const path = applicableListsPath(contact, seller, paymentMethods);
  useEffect(() => {
    const request = new AbortController(); setError('');
    void (async () => {
      const usable = readApplicableLists(await controller.catalog(path, { signal: request.signal }));
      // A late answer (another cliente, vendedor or forma already chosen) or another signed-in user is dropped.
      if (request.signal.aborted || actorOf(controller) !== actor.current) return;
      setLists(usable);
      const current = live.current.selected;
      if (current && !usable.some(list => list.id === current.id)) live.current.onSelect(null, `A lista ${current.name} não vale agora para este cliente, vendedor ou forma de pagamento.`);
    })().catch(() => { if (!request.signal.aborted) { setLists(null); setError('Não foi possível consultar as listas de preços. Os preços seguem o cadastro do produto.'); } });
    return () => request.abort();
  }, [controller, path]);
  if (!lists?.length && !selected && !error) return null;
  return <div className="form-field document-price-list">
    <label htmlFor="doc-price-list">Lista de preço</label>
    <select id="doc-price-list" value={selected?.id ?? ''} disabled={disabled || !lists} onChange={event => {
      const found = lists?.find(list => list.id === event.target.value); onSelect(found ? { id: found.id, name: found.name } : null);
    }}>
      <option value="">Preço de venda do produto</option>
      {selected && !lists?.some(list => list.id === selected.id) && <option value={selected.id}>{selected.name}</option>}
      {lists?.map(list => <option key={list.id} value={list.id}>{list.name} · {list.rule}</option>)}
    </select>
    {selected && <button type="button" className="text-button" disabled={disabled || Boolean(busy) || !applicable} onClick={onApply}>Aplicar a lista aos itens</button>}
    {busy ? <small role="status">{busy}</small> : error ? <small className="real-help" role="status">{error}</small>
      : <small className="real-help">{selected ? 'Os produtos incluídos usam o preço desta lista; o preço continua editável.' : 'Sem lista, vale o preço de venda do cadastro.'}</small>}
  </div>;
}
