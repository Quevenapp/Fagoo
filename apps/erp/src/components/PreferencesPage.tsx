import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import './preferences-page.css';

export type PreferenceItem = { label: string; to?: string; description?: string; disabledReason?: string };
export type PreferenceGroup = { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections?: readonly { title: string; entries: readonly PreferenceItem[] }[]; entries?: readonly PreferenceItem[] };

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Origin "Preferências": breadcrumb, search band, categories on the left and grouped "›" items on the right.
// With categoryHref the selected category comes from the address (/preferencias/<categoria>), so back/forward and
// Ctrl+clique work as in Origin; without it (demonstração) the selection is local.
export default function PreferencesPage({ categories, homeTo, initialCategory, categoryHref }: { categories: readonly PreferenceGroup[]; homeTo: string; initialCategory?: string; categoryHref?: (id: string) => string }) {
  const [local, setLocal] = useState(initialCategory && categories.some(category => category.id === initialCategory) ? initialCategory : categories[0]?.id);
  const selected = categoryHref ? (initialCategory && categories.some(category => category.id === initialCategory) ? initialCategory : categories[0]?.id) : local;
  const [query, setQuery] = useState('');
  const sectionsOf = (category: PreferenceGroup) => category.sections ?? [{ title: `Configurações de ${category.label.toLowerCase()}`, entries: category.entries ?? [] }];
  const term = normalize(query.trim());
  const visible = term
    ? categories.map(category => ({ category, sections: sectionsOf(category).map(section => ({ ...section, entries: section.entries.filter(entry => normalize(entry.label).includes(term)) })).filter(section => section.entries.length) })).filter(item => item.sections.length)
    : categories.filter(category => category.id === selected).map(category => ({ category, sections: sectionsOf(category) }));
  const current = categories.find(category => category.id === selected);
  const categoryButton = (category: PreferenceGroup) => {
    const active = category.id === selected && !term;
    const content = <><span className="preferences-icon"><Icon name={category.icon} size={12} /></span>{category.label}</>;
    return categoryHref
      ? <Link key={category.id} to={categoryHref(category.id)} className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} onClick={() => setQuery('')}>{content}</Link>
      : <button type="button" key={category.id} className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} onClick={() => { setQuery(''); setLocal(category.id); }}>{content}</button>;
  };
  return <main className="preferences-page" id="main-content">
    <nav className="preferences-breadcrumb" aria-label="Localização"><Link to={homeTo}>Home</Link><Icon name="chevron-right" size={10} /><h1>Preferências</h1></nav>
    <div className="preferences-band"><h2>Escolha uma das opções abaixo</h2><label className="preferences-search"><span className="sr-only">Pesquisar preferências</span><input type="search" placeholder="Pesquise aqui..." value={query} onChange={event => setQuery(event.target.value)} /><Icon name="magnifying-glass" size={13} /></label></div>
    <p className="preferences-trail"><Icon name="arrow-left" size={12} />{categoryHref ? <Link to="/preferencias">Preferências</Link> : 'Preferências'}{current && !term ? ` / ${current.label}` : ''}</p>
    <div className="preferences-layout">
      <nav className="preferences-categories" aria-label="Categorias de preferências">{categories.map(categoryButton)}</nav>
      <section className="preferences-content" aria-live="polite">{visible.length === 0 ? <p className="muted">Nenhuma opção encontrada.</p> : visible.map(({ category, sections }) => <div key={category.id}>{term && <h3 className="preferences-category-title">{category.label}</h3>}{sections.map(section => <div className="preferences-section" key={section.title}><h3>{section.title}</h3><ul>{section.entries.map(entry => <li key={entry.label}>{entry.to ? <Link to={entry.to}><Icon name="chevron-right" size={9} />{entry.label}</Link> : <span className="preferences-disabled" title={entry.disabledReason ?? 'Ainda não disponível no FAGOO'} aria-disabled="true"><Icon name="chevron-right" size={9} />{entry.label}</span>}{entry.description && <small>{entry.description}</small>}{!entry.to && entry.disabledReason && <small>{entry.disabledReason}</small>}</li>)}</ul></div>)}
        {!term && category.notice && <aside className="preferences-notice"><strong>{category.notice.title}</strong><p>{category.notice.text}</p></aside>}</div>)}</section>
    </div>
  </main>;
}
