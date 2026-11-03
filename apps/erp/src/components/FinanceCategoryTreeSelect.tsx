import { useEffect, useId, useState, type ReactNode } from 'react';
import type { FinanceKind } from '../lib/real-finance-model';
import { categoryPathName, categoryTree, toggleTreeSelection, treeRows, type CategoryNode, type CategoryTree } from '../lib/finance-registry-model';
import { Icon } from './Icon';

type Finance = (path: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Loads the category tree of one tab (SQL 135) for a scope; a new scope (session, role, kind) discards the previous answer. */
export function useCategoryTree(finance: Finance | null, kind: FinanceKind, scope: string) {
  const key = finance ? `${scope}:${kind}` : '';
  const [state, setState] = useState<{ key: string; tree: CategoryTree | null; error: string }>({ key: '', tree: null, error: '' }), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!finance) return; const request = new AbortController(); setState({ key, tree: null, error: '' });
    void finance(`/v1/financeiro/categorias-arvore?kind=${kind}`, { signal: request.signal }).then(value => { if (!request.signal.aborted) setState({ key, tree: categoryTree(value, kind), error: '' }); })
      .catch(failure => { if (!request.signal.aborted && !aborted(failure)) setState({ key, tree: null, error: 'Não foi possível carregar as categorias.' }); });
    return () => request.abort();
  }, [key, retry]);
  const current = state.key === key ? state : { key, tree: null, error: '' };
  return { tree: current.tree, items: current.tree?.items ?? [], error: current.error, loading: Boolean(key) && !current.tree && !current.error, retry: () => setRetry(value => value + 1) };
}

function TreeList({ items, query, render, expanded, onToggle, onlyActive }: { items: readonly CategoryNode[]; query: string; render: (node: CategoryNode) => ReactNode; expanded: ReadonlySet<string>; onToggle: (id: string) => void; onlyActive: boolean }) {
  const rows = treeRows(items, { expanded, query, onlyActive });
  return <ul className="finance-tree-list" role="tree">{rows.map(row => <li key={row.node.id} role="treeitem" aria-level={row.level} aria-expanded={row.hasChildren ? expanded.has(row.node.id) || Boolean(query.trim()) : undefined} className={`finance-tree-item level-${row.level}${row.node.active ? '' : ' inactive'}`}>
    {row.hasChildren && !query.trim() ? <button type="button" className="finance-tree-toggle" aria-label={`${expanded.has(row.node.id) ? 'Recolher' : 'Expandir'} ${row.node.name}`} onClick={() => onToggle(row.node.id)}><Icon name={expanded.has(row.node.id) ? 'chevron-down' : 'chevron-right'} size={10} /></button> : <span className="finance-tree-spacer" />}
    {render(row.node)}</li>)}</ul>;
}

/** "Categoria" multi-select of the Origin filters: tree with search, "Sem categoria" and expandable levels; a parent checks its subcategorias. */
export function CategoryTreeFilter({ items, value, onChange, legend = 'Categoria', error, onRetry, includeNone = true, idPrefix }: { items: readonly CategoryNode[]; value: readonly string[]; onChange: (next: string[]) => void; legend?: string; error?: string; onRetry?: () => void; includeNone?: boolean; idPrefix?: string }) {
  const generated = useId(), id = idPrefix ?? generated, [query, setQuery] = useState(''), [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (node: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(node)) next.delete(node); else next.add(node); return next; });
  return <fieldset className="finance-category-filter finance-tree-filter"><legend>{legend}</legend>
    <label className="real-sr-only" htmlFor={`${id}-search`}>Pesquisar categoria</label><input id={`${id}-search`} type="search" placeholder="Pesquisar categoria" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p className="real-alert" role="alert">{error}{onRetry && <> <button type="button" className="text-button" onClick={onRetry}>Tentar novamente</button></>}</p>}
    <div className="finance-category-options">
      {includeNone && !query.trim() && <label htmlFor={`${id}-none`}><input id={`${id}-none`} type="checkbox" checked={value.includes('none')} onChange={event => onChange(toggleTreeSelection(items, value, 'none', event.target.checked))} />Sem categoria</label>}
      <TreeList items={items} query={query} expanded={expanded} onToggle={toggle} onlyActive={false} render={node => <label htmlFor={`${id}-${node.id}`}><input id={`${id}-${node.id}`} type="checkbox" checked={value.includes(node.id)} onChange={event => onChange(toggleTreeSelection(items, value, node.id, event.target.checked))} />{node.name}{node.active ? '' : ' (inativa)'}</label>} />
    </div></fieldset>;
}

/** "Categoria" single field of the drawers: árvore com busca, "Sem categoria" and only active categories (the current one stays). */
export function CategoryTreePicker({ id, items, value, currentName, onChange, disabled = false, allowNone = true, error }: { id: string; items: readonly CategoryNode[]; value: string; currentName?: string | null; onChange: (next: string) => void; disabled?: boolean; allowNone?: boolean; error?: string }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [expanded, setExpanded] = useState<Set<string>>(() => new Set(items.filter(item => item.children > 0).map(item => item.id)));
  const label = value ? categoryPathName(items, value) || currentName || 'Categoria atual' : 'Sem categoria';
  const choose = (next: string) => { onChange(next); setOpen(false); setQuery(''); };
  const toggle = (node: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(node)) next.delete(node); else next.add(node); return next; });
  const selectable = (node: CategoryNode) => node.active || node.id === value;
  return <div className="finance-tree-picker" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <button id={id} type="button" className="finance-tree-picker-value" aria-haspopup="tree" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}><span>{label}</span><Icon name="chevron-down" size={10} /></button>
    {open && <div className="finance-tree-panel">
      <label className="real-sr-only" htmlFor={`${id}-search`}>Pesquisar categoria</label><input id={`${id}-search`} type="search" placeholder="Pesquisar categoria" maxLength={120} value={query} autoFocus onChange={event => setQuery(event.target.value)} />
      {error && <p className="real-alert" role="alert">{error}</p>}
      {allowNone && !query.trim() && <button type="button" className={`finance-tree-choice${value ? '' : ' selected'}`} onClick={() => choose('')}>Sem categoria</button>}
      <TreeList items={items.filter(selectable)} query={query} expanded={expanded} onToggle={toggle} onlyActive={false} render={node => <button type="button" className={`finance-tree-choice${node.id === value ? ' selected' : ''}`} aria-pressed={node.id === value} onClick={() => choose(node.id)}>{node.name}</button>} />
    </div>}
  </div>;
}
