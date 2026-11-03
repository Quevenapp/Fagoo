import { Link, useLocation } from 'react-router-dom';
import { HELP_ROOT, HELP_TOPICS, helpHref, helpTopic, type HelpLink } from '../lib/help-content';
import { RELEASE_NOTES } from '../lib/release-notes';
import './help-center.css';

// Leva H (PRF-287, NFE-187, NFE-222, PRF-255): Central de ajuda do Brufap (/ajuda, /ajuda/<tema>, /ajuda/novidades).
const linkOf = (link: HelpLink) => link.to ? <Link key={link.label} to={link.to}>{link.label}</Link>
  : <a key={link.label} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>;
const date = (iso: string) => iso.split('-').reverse().join('/');

export function ReleaseNotesList() {
  return <div className="help-releases">{RELEASE_NOTES.map(note => <article key={note.version} className="help-release">
    <h2>Versão {note.version} <small>{date(note.date)}</small></h2><p className="help-release-title">{note.title}</p>
    <ul>{note.items.map(item => <li key={item}>{item}</li>)}</ul></article>)}</div>;
}

export default function HelpCenter() {
  const { pathname } = useLocation();
  const slug = pathname.startsWith(`${HELP_ROOT}/`) ? pathname.slice(HELP_ROOT.length + 1) : '';
  const topic = helpTopic(slug), news = slug === 'novidades';
  const trail = <nav className="preferences-breadcrumb" aria-label="Localização"><Link to="/acesso">Home</Link> › <Link to={HELP_ROOT}>Central de ajuda</Link>{topic || news ? <> › <span aria-current="page">{topic?.title ?? 'Novidades'}</span></> : null}</nav>;
  if (slug && !topic && !news) return <section className="real-state-panel">{trail}<h1>Tema não encontrado</h1><p>Este tema não existe na Central de ajuda.</p><Link className="primary-button" to={HELP_ROOT}>Ver os temas</Link></section>;
  return <div className="help-center">{trail}
    <header className="real-heading"><div><h1>{topic?.title ?? (news ? 'Novidades no FAGOO' : 'Central de ajuda do FAGOO')}</h1>
      <p>{topic?.summary ?? (news ? 'O que mudou em cada versão publicada.' : 'Como usar o FAGOO hoje, as regras de convivência com o Origin e os temas fiscais.')}</p></div></header>
    {news ? <ReleaseNotesList /> : topic ? topic.sections.map(section => <section key={section.title} className="help-section"><h2>{section.title}</h2>
      {section.paragraphs.map(text => <p key={text}>{text}</p>)}
      {section.links?.length ? <p className="help-links">{section.links.map(linkOf)}</p> : null}</section>)
      : <ul className="help-topics">{HELP_TOPICS.map(t => <li key={t.slug}><Link to={helpHref(t.slug)}><strong>{t.title}</strong><span>{t.summary}</span></Link></li>)}
        <li><Link to={helpHref('novidades')}><strong>Novidades</strong><span>As mudanças de cada versão do FAGOO.</span></Link></li></ul>}
  </div>;
}
