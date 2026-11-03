import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ResolvedGroup } from '../lib/origin-menu';
import { Icon } from './Icon';
import './origin-home.css';

export type Favorite = { label: string; to: string };

function readFavorites(storageKey: string, defaults: readonly Favorite[]): Favorite[] {
  try { const value = JSON.parse(globalThis.localStorage?.getItem(storageKey) || 'null'); if (Array.isArray(value) && value.every(item => typeof item?.label === 'string' && typeof item?.to === 'string')) return value.slice(0, 20); } catch { /* Defaults apply. */ }
  return [...defaults];
}

// Origin home left panel: user card and editable "Atalhos favoritos" (kept per browser).
export function FavoritesPanel({ user, detail, groups, storageKey, defaults }: { user: string; detail?: string; groups: readonly ResolvedGroup[]; storageKey: string; defaults: readonly Favorite[] }) {
  const [favorites, setFavorites] = useState<Favorite[]>(() => readFavorites(storageKey, defaults));
  const [picking, setPicking] = useState(false);
  useEffect(() => { try { globalThis.localStorage?.setItem(storageKey, JSON.stringify(favorites)); } catch { /* Visit only. */ } }, [favorites, storageKey]);
  const options = groups.flatMap(group => group.columns.flatMap(column => column.items)).filter(item => item.to && !favorites.some(favorite => favorite.to === item.to));
  return <aside className="origin-home-side" aria-label="Painel do usuário">
    <div className="origin-home-user"><span className="origin-home-avatar" aria-hidden="true"><Icon name="user" size={24} /></span><div><strong>{user}</strong>{detail && <small>{detail}</small>}</div></div>
    <section className="origin-favorites" aria-label="Atalhos favoritos">
      <h2><Icon name="bookmark" size={14} />Atalhos favoritos<button type="button" className="origin-favorite-add" title="Adicionar atalho" aria-label="Adicionar atalho" aria-expanded={picking} onClick={() => setPicking(!picking)}><Icon name="plus" size={11} /></button></h2>
      {picking && <div className="origin-favorite-picker"><label htmlFor="origin-favorite-select">Escolha uma tela</label><select id="origin-favorite-select" defaultValue="" onChange={event => { const item = options.find(option => option.to === event.target.value); if (item) { setFavorites([...favorites, { label: item.label, to: item.to! }]); setPicking(false); } }}><option value="" disabled>Selecione</option>{options.map(option => <option key={option.to} value={option.to}>{option.label}</option>)}</select></div>}
      {favorites.length === 0 ? <p className="origin-favorites-empty">Adicione as telas que você mais usa.</p> : <ul>{favorites.map(favorite => <li key={favorite.to}><Link to={favorite.to}><Icon name="bookmark" size={11} />{favorite.label}</Link><button type="button" title="Remover atalho" aria-label={`Remover atalho ${favorite.label}`} onClick={() => setFavorites(favorites.filter(item => item.to !== favorite.to))}><Icon name="xmark" size={10} /></button></li>)}</ul>}
    </section>
  </aside>;
}

export type SummaryLine = { label: string; value: string; dot?: 'gray' | 'green' | 'blue' | 'red'; muted?: boolean };
export type SummaryCard = { title: string; to?: string; count?: string; arrow?: 'down' | 'up'; lines: readonly SummaryLine[]; footer?: SummaryLine };

// Origin "Resumo diário": counted cards with colored dots and values that can be hidden (eye icon).
export function DailySummary({ cards, updatedAt, aside }: { cards: readonly SummaryCard[]; updatedAt: string; aside?: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  return <section className="origin-daily" aria-label="Resumo diário">
    <header><h2>Resumo diário</h2><span className="origin-daily-updated"><Icon name="arrows-rotate" size={11} />{updatedAt}</span><button type="button" title={hidden ? 'Mostrar valores' : 'Ocultar valores'} aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} aria-pressed={hidden} onClick={() => setHidden(!hidden)}><Icon name={hidden ? 'eye' : 'eye-slash'} size={13} /></button></header>
    <div className="origin-daily-grid">{cards.map(card => {
      const body = <><h3>{card.arrow && <span className={`origin-daily-arrow is-${card.arrow}`}><Icon name={card.arrow === 'down' ? 'arrow-down' : 'arrow-up'} size={10} /></span>}{card.count && <span className={`origin-daily-count is-${card.arrow || 'none'}`}>{card.count}</span>}{card.title}</h3>
        <dl>{card.lines.map(line => <div key={line.label} className={line.muted ? 'is-muted' : undefined}><dt>{line.dot && <span className={`origin-dot is-${line.dot}`} />}{line.dot ? <strong>{hidden ? '••••' : line.value}</strong> : line.label}</dt><dd>{line.dot ? line.label : hidden ? '••••' : line.value}</dd></div>)}</dl>
        {card.footer && <p className="origin-daily-footer"><span>{card.footer.label}</span><strong>{hidden ? '••••' : card.footer.value}</strong></p>}</>;
      return card.to ? <Link key={card.title} className="origin-daily-card" to={card.to}>{body}</Link> : <div key={card.title} className="origin-daily-card">{body}</div>;
    })}{aside}</div>
  </section>;
}

export function HomeTabs({ tabs, active, onChange }: { tabs: readonly { id: string; label: string; icon: string; badge?: number }[]; active: string; onChange: (id: string) => void }) {
  return <nav className="origin-home-tabs" role="tablist" aria-label="Página inicial">{tabs.map(tab => <button type="button" role="tab" key={tab.id} aria-selected={active === tab.id} onClick={() => onChange(tab.id)}><Icon name={tab.icon} size={13} />{tab.label}{tab.badge ? <span className="origin-home-badge">{tab.badge}</span> : null}</button>)}</nav>;
}
