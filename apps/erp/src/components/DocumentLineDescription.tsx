import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AccessController } from '../lib/real-access';
import type { CatalogPage, CatalogRecord } from '../lib/catalog-model';
import type { DocumentKind } from '../lib/real-documents-model';
import './document-line-description.css';

// Documentos lane (wave F): the Origin Descrição of each item line with its own search ("Pesquise por código, descrição ou GTIN").
// The editor keeps its Descrição input; this list opens under it only for a free line, only after the user types there, and
// choosing a product turns that line into the product of the cadastro. Answers are bound to the query and the user; late ones drop.
// 202610200288: the lines of the pedido de venda, the proposta and the OS search /v1/documentos/{tipo}/produtos (Origin: no matéria-prima,
// produto em processo, uso e consumo nor ativo imobilizado); the pedido de compra keeps the search of every product.
type Controller = Pick<AccessController, 'catalog' | 'getSnapshot'> & Partial<Pick<AccessController, 'documents'>>;
export const linesSearchPath = (kind: DocumentKind | undefined, text: string) => kind && kind !== 'purchase_orders'
  ? `/v1/documentos/${kind}/produtos?${new URLSearchParams({ q: text, limit: String(LINE_SEARCH_LIMIT) })}` : null;
/** Origin info of the Descrição of the sales lines (review fix): what the line search leaves out. */
export const LINE_SEARCH_INFO = 'Matéria-prima, produto em processo, uso e consumo e ativo imobilizado não são listados.';
export type LineKeyHandler = (event: { key: string; preventDefault(): void }) => void;
const actorOf = (controller: Controller) => controller.getSnapshot?.()?.membership?.user_id ?? null;
export const LINE_SEARCH_LIMIT = 8;

export function DocumentLineSuggestions({ controller, kind, index, query, open, keys, onPick, onClose }: {
  controller: Controller; kind?: DocumentKind; index: number; query: string; open: boolean; keys: MutableRefObject<LineKeyHandler | null>; onPick: (row: CatalogRecord) => void; onClose: () => void;
}) {
  const [rows, setRows] = useState<CatalogRecord[]>([]), [active, setActive] = useState(-1), [loading, setLoading] = useState(false), [failed, setFailed] = useState(false);
  const text = query.trim().slice(0, 120), searching = open && text.length >= 2;
  useEffect(() => {
    if (!searching) { setRows([]); setActive(-1); setLoading(false); setFailed(false); return; }
    const request = new AbortController(), actor = actorOf(controller);
    const timer = setTimeout(() => {
      setLoading(true); setFailed(false);
      const sold = linesSearchPath(kind, text);
      void Promise.resolve().then(() => sold && controller.documents ? controller.documents(sold, { signal: request.signal })
        : controller.catalog(`/v1/cadastros/products?${new URLSearchParams({ limit: String(LINE_SEARCH_LIMIT), active: 'true', q: text })}`, { signal: request.signal })).then(page => {
        if (request.signal.aborted || actorOf(controller) !== actor) return;
        const items = (page as CatalogPage | null)?.items;
        setRows(Array.isArray(items) ? items.filter(row => row && typeof row.id === 'string' && typeof row.name === 'string').slice(0, LINE_SEARCH_LIMIT) : []); setActive(-1);
      }).catch(() => { if (!request.signal.aborted) { setRows([]); setFailed(true); } }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); request.abort(); };
  }, [controller, kind, searching, text]);
  // The keys of the Descrição input (↓ ↑ Enter Esc) reach the list of the line being typed.
  const state = useRef({ rows, active, onPick, onClose }); state.current = { rows, active, onPick, onClose };
  useEffect(() => {
    if (!searching) return;
    const handler: LineKeyHandler = event => {
      const { rows: list, active: current } = state.current;
      if (event.key === 'Escape') { event.preventDefault(); state.current.onClose(); return; }
      if (!list.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(Math.min(list.length - 1, current + 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(Math.max(0, current - 1)); }
      else if (event.key === 'Enter' && current >= 0) { event.preventDefault(); state.current.onPick(list[current]!); }
    };
    keys.current = handler;
    return () => { if (keys.current === handler) keys.current = null; };
  }, [keys, searching]);
  if (!searching || (!rows.length && !loading && !failed)) return null;
  const listId = `doc-item-suggest-${index}`;
  return <div className="document-line-suggest"><ul id={listId} role="listbox" className="document-line-suggestions" aria-label={`Produtos para o item ${index + 1}`}>
    {loading && !rows.length ? <li role="presentation" className="real-help">Pesquisando…</li>
      : failed ? <li role="presentation" className="real-help">Não foi possível pesquisar. A descrição digitada continua no item.</li>
        : rows.map((row, i) => <li key={row.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'is-active' : undefined}
          onMouseDown={event => { event.preventDefault(); onPick(row); }}>{row.name}{row.code ? <small> · {row.code}</small> : null}</li>)}
  </ul></div>;
}
