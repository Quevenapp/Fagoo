import { useEffect, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import './document-pickers.css';

type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
export type SellerOption = { id: string; name: string; code?: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `/v1/cadastros/vendedores/opcoes` (Cadastros › Vendedores, active contacts): at most 25 by name or code. */
export function sellerOptions(value: unknown): SellerOption[] {
  const page = value as { items?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 25) throw new Error('SELLER_OPTIONS_INVALID');
  return page.items.map(item => {
    const row = item as SellerOption;
    if (!row || typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.name !== 'string' || !row.name) throw new Error('SELLER_OPTIONS_INVALID');
    return { id: row.id, name: row.name, code: typeof row.code === 'string' ? row.code : null };
  });
}

/**
 * Origin "Vendedor" (autocomplete) of pedidos, propostas, OS and their lists (202610200164): the native vendedor of
 * Cadastros › Vendedores. The search reads the registry; the server checks the vendedor again when saving.
 */
export default function DocumentSellerPicker({ controller, id, label, selected, disabled, invalid, required, onSelect }: {
  controller: Controller; id: string; label: string; selected: SellerOption | null; disabled?: boolean; invalid?: boolean; required?: boolean; onSelect: (seller: SellerOption | null) => void;
}) {
  const [query, setQuery] = useState(''), [rows, setRows] = useState<SellerOption[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const actor = useRef(controller.getSnapshot().membership?.user_id ?? null);
  useEffect(() => {
    if (disabled || selected) return;
    const request = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      const params = new URLSearchParams(); if (query.trim()) params.set('q', query.trim());
      void Promise.resolve().then(() => controller.catalog(`/v1/cadastros/vendedores/opcoes${params.size ? `?${params}` : ''}`, { signal: request.signal })).then(value => {
        if (request.signal.aborted || controller.getSnapshot().membership?.user_id !== actor.current) return;
        setRows(sellerOptions(value)); setLoading(false);
      }).catch(() => { if (!request.signal.aborted) { setRows([]); setLoading(false); setError('Não foi possível consultar os vendedores.'); } });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, query, disabled, selected]);
  return <div className="form-field document-seller-picker">
    <label htmlFor={`${id}-search`}>{label}{required ? ' *' : ''}</label>
    {selected ? <span className="documents-picked" id={id} aria-invalid={invalid || undefined}><span>{selected.name}</span>{!disabled && <button type="button" className="text-button" onClick={() => onSelect(null)}>Trocar</button>}</span>
      : <><input id={`${id}-search`} type="search" maxLength={120} placeholder="Digite o nome do vendedor" disabled={disabled} aria-invalid={invalid || undefined} value={query} onChange={event => setQuery(event.target.value)} />
        <select id={id} aria-label={`Selecionar ${label.toLowerCase()}`} value="" disabled={disabled || !rows.length} onChange={event => { const found = rows.find(row => row.id === event.target.value); if (found) { onSelect(found); setQuery(''); } }}>
          <option value="">{loading ? 'Pesquisando…' : rows.length ? 'Selecione o vendedor' : 'Nenhum vendedor encontrado'}</option>
          {rows.map(row => <option key={row.id} value={row.id}>{row.name}{row.code ? ` · ${row.code}` : ''}</option>)}
        </select></>}
    {error && <small className="real-help" role="status">{error}</small>}
    {!required && !disabled && <small className="real-help">Campo opcional</small>}
  </div>;
}
