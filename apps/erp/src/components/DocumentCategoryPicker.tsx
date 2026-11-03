import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import type { DocumentKind } from '../lib/real-documents-model';
import { readCategoryChoices, type CategoryChoices } from '../lib/document-category-model';

type Controller = Pick<AccessController, 'documents' | 'getSnapshot'>;
export type CategoryKind = Extract<DocumentKind, 'sales_orders' | 'purchase_orders' | 'service_orders'>;
/**
 * Origin "Categoria" of the pedido de venda, da OS e do pedido de compra (padrão "Sem categoria"): the categoria financeira that
 * "Lançar contas" uses when none is chosen in the conferência. The server checks it again when saving.
 */
export default function DocumentCategoryPicker({ controller, kind, id, selected, disabled, onSelect }: {
  controller: Controller; kind: CategoryKind; id: string; selected: { id: string; name: string } | null; disabled?: boolean;
  onSelect: (category: { id: string; name: string } | null) => void;
}) {
  const [choices, setChoices] = useState<CategoryChoices | null>(null), [error, setError] = useState('');
  const actor = useRef(controller.getSnapshot().membership?.user_id ?? null);
  useEffect(() => {
    if (disabled) return;
    const request = new AbortController();
    setError('');
    void Promise.resolve().then(() => controller.documents(`/v1/documentos/${kind}/categorias`, { signal: request.signal })).then(value => {
      if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
      setChoices(readCategoryChoices(value));
    }).catch(() => { if (!request.signal.aborted) { setChoices(null); setError('Não foi possível consultar as categorias. O documento continua com a categoria atual.'); } });
    return () => request.abort();
  }, [controller, kind, disabled]);
  const listed = choices?.items ?? [], outside = selected && !listed.some(row => row.id === selected.id);
  const kindLabel = kind === 'purchase_orders' ? 'despesa' : 'receita';
  return <div className="form-field document-category-picker">
    <label htmlFor={id}>Categoria</label>
    <select id={id} value={selected?.id ?? ''} disabled={disabled || (!choices && !selected)} onChange={event => {
      const value = event.target.value; if (!value) { onSelect(null); return; }
      const found = listed.find(row => row.id === value); if (found) onSelect({ id: found.id, name: found.name });
    }}>
      <option value="">Sem categoria</option>
      {outside && <option value={selected.id}>{selected.name}</option>}
      {listed.map(row => <option key={row.id} value={row.id}>{`${'  '.repeat(row.depth - 1)}${row.name}`}</option>)}
    </select>
    {error ? <small className="real-help" role="status">{error}</small>
      : <small className="real-help">{`Categoria de ${kindLabel}. Sem categoria, o Lançar contas usa ${choices?.default ? `a categoria padrão (${choices.default.name})` : 'a categoria padrão, se houver'}.`}{choices?.has_more ? ' Mostrando as 500 primeiras categorias.' : ''}</small>}
  </div>;
}
