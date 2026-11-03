import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AccessController } from '../lib/real-access';
import type { StockWarehouseOption } from '../lib/stock-launch-model';
import { parseSuppliers, parseWarehouseOptions, type StockSupplier } from '../lib/stock-supply-model';
import { Icon } from './Icon';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** The "Depósito" selectors of the stock screens read the light warehouse list (181), never the totals of /totais. */
export function useStockWarehouseOptions(controller: Pick<AccessController, 'stock'>, enabled = true): { options: StockWarehouseOption[]; loaded: boolean; error: string } {
  const [state, setState] = useState<{ options: StockWarehouseOption[]; loaded: boolean; error: string }>({ options: [], loaded: false, error: '' });
  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    void Promise.resolve().then(() => controller.stock('/v1/estoque/depositos/opcoes', { signal: request.signal })).then(raw => { if (!request.signal.aborted) setState({ options: parseWarehouseOptions(raw), loaded: true, error: '' }); })
      .catch(problem => { if (!request.signal.aborted && !aborted(problem)) setState({ options: [], loaded: true, error: 'Não foi possível carregar os depósitos.' }); });
    return () => request.abort();
  }, [controller, enabled]);
  return state;
}

export interface SupplierChoice { id: string; name: string }
/** Filtro "Fornecedor" do Origin: autocomplete dos fornecedores (contatos fornecedores e os ligados a produtos, 119). Late answers are ignored. */
export function StockSupplierPicker({ controller, id, value, disabled, onChange }: { controller: Pick<AccessController, 'stock'>; id: string; value: SupplierChoice | null; disabled?: boolean; onChange: (value: SupplierChoice | null) => void }) {
  const [query, setQuery] = useState(value?.name ?? ''), [open, setOpen] = useState(false), [rows, setRows] = useState<StockSupplier[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => { setQuery(value?.name ?? ''); setOpen(false); }, [value?.id]);
  useEffect(() => {
    if (!open || disabled) return;
    const text = query.trim(), current = ++sequence.current, request = new AbortController();
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      const search = text.slice(0, 120) || null;
      void controller.stock(`/v1/estoque/fornecedores${search ? `?${new URLSearchParams({ q: search })}` : ''}`, { signal: request.signal }).then(raw => {
        if (request.signal.aborted || current !== sequence.current) return;
        setRows(parseSuppliers(raw, search));
      }).catch(problem => { if (!request.signal.aborted && !aborted(problem) && current === sequence.current) { setRows([]); setError('Não foi possível pesquisar os fornecedores.'); } })
        .finally(() => { if (!request.signal.aborted && current === sequence.current) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, query, open, disabled]);
  const choose = (row: StockSupplier) => { setOpen(false); setRows([]); setQuery(row.name); onChange({ id: row.id, name: row.name }); };
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Escape') setOpen(false); if (event.key === 'Enter') { event.preventDefault(); if (rows.length === 1) choose(rows[0]!); } };
  return <div className="stock-supplier-picker">
    <input id={id} type="search" placeholder="Digite o nome do fornecedor" autoComplete="off" maxLength={120} disabled={disabled} value={query}
      onChange={event => { setQuery(event.target.value); setOpen(true); if (value) onChange(null); }} onFocus={() => setOpen(true)} onKeyDown={keydown} />
    {(value || query) && <button type="button" className="stock-product-clear" aria-label="Limpar fornecedor" title="Limpar" disabled={disabled} onClick={() => { setQuery(''); setRows([]); setOpen(false); onChange(null); }}><Icon name="xmark" size={12} /></button>}
    {open && <ul className="stock-product-suggestions" role="listbox" aria-label="Fornecedores encontrados">
      {loading ? <li className="stock-product-status" role="status">Pesquisando…</li> : error ? <li className="stock-product-status" role="alert">{error}</li> : rows.length === 0 ? <li className="stock-product-status">Nenhum fornecedor encontrado.</li>
        : rows.map(row => <li key={row.id} role="option" aria-selected={value?.id === row.id}><button type="button" onClick={() => choose(row)}><strong>{row.name}</strong>{row.code && <small>Cód: {row.code}</small>}<small>{row.products === 1 ? '1 produto' : `${row.products} produtos`}</small>{!row.active && <small>Inativo</small>}</button></li>)}
    </ul>}
  </div>;
}

/** "Depósito" of the document stock conferência (184): the document's warehouse by default or, without one, the depósito padrão; another
 * active warehouse can be chosen for this lançamento only (the document keeps its own). */
export function StockDocumentWarehouse({ controller, id, documentWarehouse, value, disabled, onChange }: { controller: Pick<AccessController, 'stock'>; id: string; documentWarehouse: string | null;
  value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const warehouses = useStockWarehouseOptions(controller);
  useEffect(() => { if (!value && warehouses.loaded) { const start = documentWarehouse ?? warehouses.options.find(item => item.is_default && item.active)?.id ?? ''; if (start) onChange(start); } }, [warehouses.loaded, documentWarehouse]);
  const options = warehouses.options.filter(item => item.active || item.id === value || item.id === documentWarehouse);
  return <label htmlFor={id}>Depósito<select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Selecione o depósito</option>
    {options.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === documentWarehouse ? ' (do documento)' : ''}</option>)}</select>
    {value && value !== documentWarehouse && <small>{documentWarehouse ? 'O lançamento usa este depósito; o documento continua com o depósito salvo.' : 'O documento não tem depósito: o lançamento usa o depósito escolhido.'}</small>}</label>;
}
