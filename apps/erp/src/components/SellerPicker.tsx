import { useEffect, useId, useRef, useState } from 'react';
import type { AccessController } from '../lib/real-access';
import { Icon } from './Icon';

// Autocomplete de vendedores (Origin CL-08, CL-20 e CF-34): busca os vendedores ativos pelo nome; a escolha é um chip
// removível. Nenhuma resposta atrasada substitui a de uma busca mais nova.
export type SellerOption = { id: string; name: string; code: string | null };
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function SellerPicker({ controller, id, label, value, onChange, disabled = false }: { controller: AccessController; id: string; label: string; value: SellerOption | null; onChange: (seller: SellerOption | null) => void; disabled?: boolean }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState<SellerOption[]>([]), [open, setOpen] = useState(false), [error, setError] = useState('');
  const listId = useId(), request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || value) return;
    const current = new AbortController(); request.current?.abort(); request.current = current;
    const timer = setTimeout(() => {
      const params = new URLSearchParams(); if (query.trim()) params.set('q', query.trim());
      void controller.catalog(`/v1/cadastros/vendedores/opcoes${params.size ? `?${params}` : ''}`, { signal: current.signal }).then(raw => {
        if (current.signal.aborted || request.current !== current) return;
        const items = (raw as { items?: unknown }).items;
        if (!Array.isArray(items)) throw new Error('Invalid response');
        setOptions(items as SellerOption[]); setError('');
      }).catch(failure => { if (!aborted(failure) && !current.signal.aborted) { setOptions([]); setError('Não foi possível buscar os vendedores.'); } });
    }, 250);
    return () => { clearTimeout(timer); current.abort(); };
  }, [controller, query, open, value]);
  useEffect(() => () => request.current?.abort(), []);
  if (value) return <div className="form-field contact-picker"><label htmlFor={id}>{label}</label>
    <span className="contact-chip" id={id}>{value.name}{!disabled && <button type="button" aria-label={`Remover ${label.toLowerCase()} ${value.name}`} onClick={() => { onChange(null); setQuery(''); }}><Icon name="xmark" size={10} /></button>}</span></div>;
  return <div className="form-field contact-picker">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="search" autoComplete="off" role="combobox" aria-expanded={open} aria-controls={listId} disabled={disabled} maxLength={120} value={query} placeholder="Pesquise pelo nome do vendedor"
      onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }} />
    {open && <ul className="contact-picker-options" id={listId} role="listbox" aria-label={label}>
      {options.map(option => <li key={option.id} role="option" aria-selected={false}><button type="button" onClick={() => { onChange(option); setOpen(false); setQuery(''); }}>{option.name}{option.code ? ` (${option.code})` : ''}</button></li>)}
      {!options.length && <li className="contact-picker-empty">{error || 'Nenhum vendedor encontrado.'}</li>}
    </ul>}
  </div>;
}
