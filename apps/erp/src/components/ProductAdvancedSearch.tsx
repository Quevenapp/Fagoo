import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';
import { unitMoney } from '../lib/pdv-model';
import { EMPTY_PRODUCT_SEARCH as EMPTY, PRODUCT_SEARCH_SIZE as SIZE, productSearchPath, type ProductSearchFilters as Filters } from '../lib/product-search-model';
import { Modal } from './Modal';

type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOf = (controller: Controller) => controller.getSnapshot()?.membership?.user_id ?? null;
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
function readPage(value: unknown): { items: CatalogRecord[]; next: string | null } {
  const page = value as CatalogPage | null;
  if (!page || page.entity !== 'products' || !Array.isArray(page.items) || page.items.length > SIZE || (page.next_cursor !== null && !UUID.test(page.next_cursor ?? ''))) throw new AccessError(502);
  for (const row of page.items) if (!row || !UUID.test(row.id) || typeof row.name !== 'string' || row.entity !== 'products') throw new AccessError(502);
  return { items: page.items, next: page.has_more ? page.next_cursor : null };
}

/**
 * Origin "Pesquisa avançada" (Alt+A) of the product of the Frente de caixa: código, descrição ou GTIN, Tipo, Formato and Marca over the
 * active products of Cadastros › Produtos, 10 at a time ("Mais resultados"). Selecionar fills the Produto panel, which then applies the
 * Lista de preço, the stock rules and the Inserir of the sale, exactly as the search field does.
 */
export default function ProductAdvancedSearch({ controller, initialQuery, onSelect, onClose }: {
  controller: Controller; initialQuery: string; onSelect: (record: CatalogRecord) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<Filters>({ ...EMPTY, q: initialQuery.slice(0, 120) }), [filters, setFilters] = useState<Filters>({ ...EMPTY, q: initialQuery.slice(0, 120) });
  const [rows, setRows] = useState<CatalogRecord[] | null>(null), [next, setNext] = useState<string | null>(null), [after, setAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const actor = useRef(actorOf(controller));
  useEffect(() => {
    const request = new AbortController(); let path: string;
    try { path = productSearchPath(filters, after); } catch (failure) { setError((failure as Error).message); setLoading(false); return; }
    setLoading(true); setError('');
    void Promise.resolve().then(() => controller.catalog(path, { signal: request.signal })).then(value => {
      if (request.signal.aborted) return;
      if (actorOf(controller) !== actor.current) { setError('A sessão mudou. Feche e abra a pesquisa novamente.'); setLoading(false); return; }
      const page = readPage(value);
      setRows(previous => after && previous ? [...previous, ...page.items.filter(item => !previous.some(row => row.id === item.id))] : page.items); setNext(page.next); setLoading(false);
    }).catch(failure => { if (!request.signal.aborted) { setLoading(false); setError(failure instanceof AccessError && failure.status === 403 ? 'Seu perfil não consulta os produtos.' : 'Não foi possível pesquisar agora.'); } });
    return () => request.abort();
  }, [controller, filters, after]);
  const submit = (event: FormEvent) => { event.preventDefault(); event.stopPropagation(); setAfter(null); setRows(null); setFilters({ ...draft }); };
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setDraft(current => ({ ...current, [key]: value }));
  return <Modal title="Pesquisa avançada de produtos" onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
    <form className="document-contact-search" onSubmit={submit}>
      <div className="document-grid">
        <div className="form-field document-wide"><label htmlFor="product-search-q">Pesquise por código, descrição ou GTIN</label><input id="product-search-q" type="search" maxLength={120} value={draft.q} onChange={event => set('q', event.target.value)} /></div>
        <div className="form-field"><label htmlFor="product-search-kind">Tipo</label><select id="product-search-kind" value={draft.kind} onChange={event => set('kind', event.target.value as Filters['kind'])}><option value="">Todos</option><option value="P">Produto</option><option value="S">Serviço</option></select></div>
        <div className="form-field"><label htmlFor="product-search-format">Formato</label><select id="product-search-format" value={draft.format} onChange={event => set('format', event.target.value as Filters['format'])}><option value="">Todos</option><option value="S">Simples</option><option value="V">Com variações</option><option value="E">Com composição</option></select></div>
        <div className="form-field"><label htmlFor="product-search-brand">Marca</label><input id="product-search-brand" maxLength={100} value={draft.brand} onChange={event => set('brand', event.target.value)} /></div>
      </div>
      <button type="submit" className="primary-button" disabled={loading}>Pesquisar</button>
    </form>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {rows === null ? loading && <p role="status">Pesquisando…</p> : rows.length ? <div className="table-scroll" tabIndex={0} aria-label="Resultado da pesquisa"><table className="data-table"><thead><tr><th>Descrição</th><th>Código</th><th>GTIN/EAN</th><th>Unidade</th><th className="numeric">Preço</th><th><span className="sr-only">Ação</span></th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.code ?? '—'}</td><td>{text(row.gtin) ?? '—'}</td><td>{text(row.unit) ?? '—'}</td><td className="numeric">{unitMoney(text(row.price))}</td>
        <td><button type="button" className="text-button" onClick={() => onSelect(row)}>Selecionar</button></td></tr>)}</tbody></table></div>
      : !loading && <p className="real-help">Nenhum produto encontrado com estes filtros.</p>}
    {rows && next && <div className="document-contact-search-pages"><button type="button" className="text-button" disabled={loading} onClick={() => setAfter(next)}>{loading ? 'Pesquisando…' : 'Mais resultados'}</button></div>}
  </Modal>;
}
