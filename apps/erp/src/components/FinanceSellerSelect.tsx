import { useEffect, useState } from 'react';
import { AccessError, type NativeRequestOptions } from '../lib/real-access';
import { sellerOptions, sellerOptionsPath, type SellerOption } from '../lib/finance-sellers';
import './finance-seller-select.css';

const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Vendedor (autocomplete) of the contas a receber, as in Origin: type part of the name and choose one of the sellers of
 * Cadastros > Vendedores (SQL 126, read only, up to 25 per search). The current seller stays listed while it is chosen.
 */
export function FinanceSellerSelect({ controller, id, value, onChange, disabled, label = 'Vendedor', emptyLabel = 'Todos' }: {
  controller: { catalog: (path: string, options?: NativeRequestOptions) => Promise<unknown> }; id: string; value: SellerOption | null; onChange: (value: SellerOption | null) => void;
  disabled?: boolean; label?: string; emptyLabel?: string;
}) {
  // The options load on first use (focus or typing), so a list that never touches the field asks nothing.
  const [wanted, setWanted] = useState(false), [query, setQuery] = useState(''), [state, setState] = useState<{ key: string; items: SellerOption[]; error: string; loading: boolean }>({ key: '', items: [], error: '', loading: false });
  const key = disabled || !wanted ? '' : query.trim();
  useEffect(() => {
    if (disabled || !wanted) return;
    const request = new AbortController(), timer = setTimeout(() => {
      setState({ key, items: [], error: '', loading: true });
      void controller.catalog(sellerOptionsPath(key), { signal: request.signal }).then(raw => { if (!request.signal.aborted) setState({ key, items: sellerOptions(raw), error: '', loading: false }); })
        .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key, items: [], loading: false, error: failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta o cadastro de vendedores.' : 'Não foi possível carregar os vendedores.' }); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, key, disabled, wanted]);
  const current = state.key === key ? state : { key, items: [], error: '', loading: !disabled && wanted };
  const want = () => { if (!wanted) setWanted(true); };
  return <div className="finance-seller-select">
    <input id={`${id}-search`} type="search" maxLength={120} aria-label={`Pesquisar ${label.toLowerCase()}`} placeholder="Pesquisar vendedor" value={query} disabled={disabled} onFocus={want} onChange={event => { want(); setQuery(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    <select id={id} value={value?.id ?? ''} disabled={disabled} onFocus={want} onMouseDown={want} aria-busy={current.loading || undefined} onChange={event => { const chosen = current.items.find(item => item.id === event.target.value); onChange(chosen ?? (event.target.value && value?.id === event.target.value ? value : null)); }}>
      <option value="">{current.loading ? 'Pesquisando…' : emptyLabel}</option>
      {value && !current.items.some(item => item.id === value.id) && <option value={value.id}>{value.name}</option>}
      {current.items.map(item => <option key={item.id} value={item.id}>{item.name}{item.code ? ` · ${item.code}` : ''}</option>)}
    </select>
    {current.error && <small role="alert">{current.error}</small>}
  </div>;
}
