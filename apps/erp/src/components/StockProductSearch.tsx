import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AccessController } from '../lib/real-access';
import type { CatalogRecord } from '../lib/catalog-model';
import { Icon } from './Icon';

const PLACEHOLDER = 'Pesquise por código, descrição ou GTIN';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
const valid = (value: unknown): value is { items: CatalogRecord[] } => Boolean(value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
  && (value as { items: unknown[] }).items.every(item => item && typeof item === 'object' && typeof (item as CatalogRecord).id === 'string' && typeof (item as CatalogRecord).name === 'string'));

/** Origin's extrato search: suggestions with the description and "Cód: <sku>"; X clears the product. Late answers are ignored. */
export default function StockProductSearch({ controller, selected, disabled, onSelect }: { controller: Pick<AccessController, 'catalog'>; selected: CatalogRecord | null; disabled?: boolean; onSelect: (record: CatalogRecord | null) => void }) {
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [rows, setRows] = useState<CatalogRecord[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => { setQuery(selected ? [selected.name, selected.code ? `Cód: ${selected.code}` : ''].filter(Boolean).join(' · ') : ''); setOpen(false); }, [selected?.id]);
  useEffect(() => {
    if (!open || disabled) return;
    const text = query.trim(), current = ++sequence.current, request = new AbortController();
    if (text.length < 1) { setRows([]); setLoading(false); return; }
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: '10', kind: 'P', q: text.slice(0, 120) });
      void controller.catalog(`/v1/cadastros/products?${params}`, { signal: request.signal }).then(value => {
        if (request.signal.aborted || current !== sequence.current) return;
        if (!valid(value)) throw new Error('INVALID_PRODUCTS');
        setRows(value.items.slice(0, 10));
      }).catch(problem => { if (!request.signal.aborted && !aborted(problem) && current === sequence.current) { setRows([]); setError('Não foi possível pesquisar os produtos. Tente novamente.'); } })
        .finally(() => { if (!request.signal.aborted && current === sequence.current) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, query, open, disabled]);
  const choose = (record: CatalogRecord) => { setOpen(false); setRows([]); onSelect(record); };
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Escape') setOpen(false); if (event.key === 'Enter') { event.preventDefault(); if (rows.length === 1) choose(rows[0]!); } };
  return <div className="stock-product-search" role="search">
    <input id="stock-product-search" type="search" aria-label={PLACEHOLDER} placeholder={PLACEHOLDER} autoComplete="off" maxLength={120} disabled={disabled} value={query}
      onChange={event => { setQuery(event.target.value); setOpen(true); }} onFocus={() => { if (!selected) setOpen(true); }} onKeyDown={keydown} />
    {(selected || query) && <button type="button" className="stock-product-clear" aria-label="Limpar produto" title="Limpar" disabled={disabled} onClick={() => { setQuery(''); setRows([]); setOpen(false); onSelect(null); }}><Icon name="xmark" size={12} /></button>}
    <span className="stock-product-search-icon" aria-hidden="true"><Icon name="magnifying-glass" size={13} /></span>
    {open && query.trim() && <ul className="stock-product-suggestions" role="listbox" aria-label="Produtos encontrados">
      {loading ? <li className="stock-product-status" role="status">Pesquisando…</li> : error ? <li className="stock-product-status" role="alert">{error}</li> : rows.length === 0 ? <li className="stock-product-status">Nenhum produto encontrado.</li>
        : rows.map(row => <li key={row.id} role="option" aria-selected={selected?.id === row.id}><button type="button" onClick={() => choose(row)}><strong>{row.name}</strong>{row.code && <small>Cód: {row.code}</small>}{!row.active && <small>Inativo</small>}</button></li>)}
    </ul>}
  </div>;
}
