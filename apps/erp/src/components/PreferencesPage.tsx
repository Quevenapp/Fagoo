import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import './preferences-page.css';

export type PreferenceItem = { label: string; to?: string; description?: string; disabledReason?: string };
export type PreferenceGroup = { id: string; label: string; icon: string; notice?: { title: string; text: string }; sections?: readonly { title: string; entries: readonly PreferenceItem[] }[]; entries?: readonly PreferenceItem[] };

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Configuration hub: category cards and grouped destinations, retaining address-driven selection.
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
    const count = sectionsOf(category).reduce((total, section) => total + section.entries.length, 0);
    const content = <><span className="preferences-icon"><Icon name={category.icon} size={21} /></span><span><strong>{category.label}</strong><small>{count} {count === 1 ? 'opção' : 'opções'}</small></span><Icon name="chevron-right" size={14}/></>;
    return categoryHref
      ? <Link key={category.id} to={categoryHref(category.id)} className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} onClick={() => setQuery('')}>{content}</Link>
      : <button type="button" key={category.id} className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} onClick={() => { setQuery(''); setLocal(category.id); }}>{content}</button>;
  };
  return <main className="preferences-page fagoo-settings-hub" id="main-content">
    <header className="fagoo-settings-heading"><div><p className="fagoo-eyebrow">DO SEU JEITO</p><h1>Preferências</h1><p>Organize as regras e os recursos da sua operação.</p></div><Link className="secondary-button" to={homeTo}><Icon name="house" size={16}/>Visão geral</Link></header>
    <div className="fagoo-settings-search"><label htmlFor="fagoo-preference-search">Encontre uma configuração</label><span><Icon name="magnifying-glass" size={20}/><input id="fagoo-preference-search" type="search" aria-label="Pesquisar preferências" placeholder="Busque por assunto, por exemplo: estoque ou pagamento" value={query} onChange={event => setQuery(event.target.value)} /></span></div>
    <div className="preferences-layout">
      <nav className="preferences-categories" aria-label="Categorias de preferências">{categories.map(categoryButton)}</nav>
      <section className="preferences-content" aria-live="polite"><div className="fagoo-settings-selection"><p className="fagoo-eyebrow">{term ? 'RESULTADOS DA BUSCA' : 'CATEGORIA SELECIONADA'}</p><h2>{term ? `Resultados para “${query.trim()}”` : current?.label}</h2></div>{visible.length === 0 ? <p className="muted">Nenhuma opção encontrada.</p> : visible.map(({ category, sections }) => <div className="fagoo-settings-groups" key={category.id}>{term && <h3 className="preferences-category-title">{category.label}</h3>}{sections.map(section => <div className="preferences-section" key={section.title}><h3>{section.title}</h3><ul>{section.entries.map(entry => <li key={entry.label}>{entry.to ? <Link to={entry.to}><span>{entry.label}</span><Icon name="arrow-right" size={15} /></Link> : <span className="preferences-disabled" title={entry.disabledReason ?? 'Ainda não disponível no FAGOO'} aria-disabled="true">{entry.label}</span>}{entry.description && <small>{entry.description}</small>}{!entry.to && entry.disabledReason && <small>{entry.disabledReason}</small>}</li>)}</ul></div>)}
        {!term && category.notice && <aside className="preferences-notice"><strong>{category.notice.title}</strong><p>{category.notice.text}</p></aside>}</div>)}</section>
    </div>
  </main>;
}
