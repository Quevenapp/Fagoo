import { useId, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import './native-list-layout.css';

type Panels = { filters: boolean; actions: boolean };
const KEY = 'brufap.erp.list-panels.';
function readPanels(scope: string): Panels {
  try { const value = JSON.parse(globalThis.localStorage?.getItem(KEY + scope) || 'null'); if (value && typeof value.filters === 'boolean' && typeof value.actions === 'boolean') return value; } catch { /* Defaults apply. */ }
  return { filters: true, actions: true };
}

/** Shared list arrangement in the Origin layout: "Filtrar" panel on the left (funnel toggles it), records in the
 * middle, actions on the right (› collapses it). Panels stay rendered; collapsing only hides them visually. */
export default function NativeListLayout({ filters, actions, children }: { filters: ReactNode; actions: ReactNode; children: ReactNode }) {
  const id = useId();
  const location = useLocation();
  const scope = `${location.pathname}${['cadastro', 'tipo', 'area', 'modelo'].map(name => new URLSearchParams(location.search).get(name)).filter(Boolean).map(value => `:${value}`).join('')}`;
  const [panels, setPanels] = useState<Panels>(() => readPanels(scope));
  const [panel, setPanel] = useState<'filters' | 'actions' | null>(null);
  const filterButton = useRef<HTMLButtonElement>(null), actionButton = useRef<HTMLButtonElement>(null);
  const persist = (next: Panels) => { setPanels(next); try { globalThis.localStorage?.setItem(KEY + scope, JSON.stringify(next)); } catch { /* Visit only. */ } };
  const close = () => { const previous = panel; setPanel(null); (previous === 'filters' ? filterButton : actionButton).current?.focus(); };
  return <div className={`native-list-layout${panels.filters ? '' : ' filters-collapsed'}${panels.actions ? '' : ' actions-collapsed'}`} onKeyDown={event => { if (event.key === 'Escape' && panel) { event.preventDefault(); close(); } }}>
    <div className="native-list-panel-controls">
      <button ref={filterButton} type="button" className="secondary-button" aria-expanded={panel === 'filters'} aria-controls={`${id}-filters`} onClick={() => setPanel(value => value === 'filters' ? null : 'filters')}><Icon name="filter" /> Filtros</button>
      <button ref={actionButton} type="button" className="secondary-button" aria-expanded={panel === 'actions'} aria-controls={`${id}-actions`} onClick={() => setPanel(value => value === 'actions' ? null : 'actions')}>Ações <Icon name="more" /></button>
    </div>
    <aside className={`native-list-filters ${panel === 'filters' ? 'is-open' : ''}`} id={`${id}-filters`} aria-label="Filtros da listagem">
      <div className="native-list-aside-heading"><h2><Icon name="filter" size={12} />Filtrar</h2><button type="button" className="native-list-minimize" title="Minimizar filtros" aria-label="Minimizar filtros" onClick={() => persist({ ...panels, filters: false })}><Icon name="xmark" size={13} /></button><button type="button" className="icon-button native-list-panel-close" aria-label="Fechar filtros" onClick={close}><Icon name="close" /></button></div>{filters}
    </aside>
    <aside className={`native-list-actions ${panel === 'actions' ? 'is-open' : ''}`} id={`${id}-actions`} aria-label="Ações da listagem">
      <div className="native-list-aside-heading"><h2>Ações</h2><button type="button" className="icon-button native-list-panel-close" aria-label="Fechar ações" onClick={close}><Icon name="close" /></button></div>{actions}
      <button type="button" className="native-list-collapse" title="Minimizar barra de ações" aria-label="Minimizar barra de ações" onClick={() => persist({ ...panels, actions: false })}><Icon name="chevron-right" size={12} /></button>
    </aside>
    {!panels.actions && <button type="button" className="native-list-expand" title="Expandir barra de ações" aria-label="Expandir barra de ações" onClick={() => persist({ ...panels, actions: true })}><Icon name="chevron-left" size={12} /></button>}
    <section className="native-list-content">
      <button type="button" className={`native-list-filter-toggle${panels.filters ? ' is-open' : ''}`} title="Abrir filtro" aria-label={panels.filters ? 'Minimizar filtros' : 'Abrir filtro'} aria-pressed={panels.filters} onClick={() => persist({ ...panels, filters: !panels.filters })}><Icon name="filter" size={13} /></button>
      {children}
    </section>
  </div>;
}
