import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ResolvedGroup } from '../lib/origin-menu';
import { Icon } from './Icon';
import './origin-top-bar.css';

export type TopBarLink = { label: string; to: string; icon?: string };
export type TopBarUser = { name: string; company: string; detail?: string };

type Popover = 'menu' | 'notifications' | 'help' | 'user' | 'search' | 'drawer' | null;

export const ORIGIN_SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Enter', action: 'Pesquisar na listagem ou aplicar o período digitado' },
  { keys: 'Esc', action: 'Fechar menus, filtros e janelas' },
  { keys: 'Shift + clique', action: 'Selecionar um intervalo de linhas da listagem' },
  { keys: 'Ctrl + clique', action: 'Abrir o registro em uma nova aba' },
  { keys: 'Alt + letra', action: 'Atalhos da Frente de caixa (Ctrl + Shift no Mac)' },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || 'F';
}

// Company area extras (optional, the demo keeps the static versions): "Meu Perfil" tooltip, razão social linking to the company
// data, Armazenamento in the user menu, and the live notifications popover with its unread badge.
export default function OriginTopBar({ groups, activeGroup, homeTo, preferencesTo, user, theme, onTheme, onLogout, userLinks = [], searchLinks = [], userTitle, companyTo, storage, notificationCount, notificationsPanel, actionsTo, helpLinks = [], syncTool }: {
  groups: readonly ResolvedGroup[]; activeGroup?: string; homeTo: string; preferencesTo: string; user: TopBarUser;
  theme: 'light' | 'dark'; onTheme: () => void; onLogout?: () => void; userLinks?: readonly TopBarLink[]; searchLinks?: readonly TopBarLink[];
  userTitle?: string; companyTo?: string; storage?: { label: string; to: string } | null; notificationCount?: number | null; notificationsPanel?: (close: () => void) => ReactNode;
  /** Origin "Consultar gestão de ações" (migration 228): the long actions of the user, such as spreadsheet imports. */
  actionsTo?: string;
  /** Leva H (PRF-287): the Brufap help of the company area (/ajuda), shown above the keyboard shortcuts. */
  helpLinks?: readonly TopBarLink[];
  /** 202610220009: the "Sincronizar" tool of the two-way sync with the Origin (company area only). */
  syncTool?: ReactNode;
}) {
  const navigate = useNavigate();
  const [popover, setPopover] = useState<Popover>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const close = () => { setPopover(null); setOpenGroup(null); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopover(null); setOpenGroup(null); } };
    globalThis.window?.addEventListener('keydown', onKey);
    return () => globalThis.window?.removeEventListener('keydown', onKey);
  }, []);
  const destinations = useMemo(() => {
    const items: TopBarLink[] = [];
    for (const group of groups) for (const column of group.columns) for (const item of column.items) if (item.to) items.push({ label: item.label, to: item.to });
    return [...items, ...searchLinks].filter((item, index, all) => all.findIndex(other => other.label === item.label && other.to === item.to) === index);
  }, [groups, searchLinks]);
  const normalized = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const matches = query.trim() ? destinations.filter(item => normalized(item.label).includes(normalized(query))).slice(0, 8) : [];
  const go = (to: string) => { close(); setQuery(''); navigate(to); };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); if (matches[0]) go(matches[0].to); };
  const toggleGroup = (name: string) => { setPopover(openGroup === name ? null : 'menu'); setOpenGroup(openGroup === name ? null : name); };
  const toggle = (name: Exclude<Popover, null>) => { setOpenGroup(null); setPopover(popover === name ? null : name); };

  return <header className="origin-topbar">
    <button type="button" className="origin-drawer-toggle" aria-label="Abrir menu" aria-expanded={popover === 'drawer'} onClick={() => toggle('drawer')}><Icon name="bars" size={16} /></button>
    <Link className="origin-brand" to={homeTo} aria-label="FAGOO, página inicial" onClick={close}><svg width="22" height="22" viewBox="0 0 28 28" aria-hidden="true"><rect x="4" y="2" width="6" height="24" rx="2" fill="currentColor" /><path d="M12 2h12v6H12V2Zm0 10h10v6H12v-6Z" fill="currentColor" opacity=".65" /></svg><span>fagoo</span></Link>
    <nav className="origin-menu" aria-label="Módulos">{groups.map((group, index) => <div className="origin-menu-group" key={group.name}>
      <button type="button" className={`origin-menu-trigger${activeGroup === group.name ? ' active' : ''}`} aria-expanded={openGroup === group.name} aria-controls={`origin-mega-${index}`} onClick={() => toggleGroup(group.name)}>{group.name}<Icon name="chevron-down" size={9} /></button>
      {openGroup === group.name && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar menu" onClick={close} /><div className="origin-mega" id={`origin-mega-${index}`}>
        <div className="origin-mega-columns">{group.columns.map(column => <div className="origin-mega-column" key={column.title}><h3>{column.title}</h3>{column.items.map(item => item.to
          ? <Link key={item.label} to={item.to} onClick={close}>{item.label}</Link>
          : <span key={item.label} className="origin-mega-disabled" aria-disabled="true" title="Ainda não disponível no FAGOO">{item.label}</span>)}</div>)}</div>
        {group.footer?.to && <Link className="origin-mega-footer" to={group.footer.to} onClick={close}>{group.footer.label}</Link>}
      </div></>}
    </div>)}</nav>
    <form className="origin-global-search" role="search" onSubmit={submitSearch}>
      <Icon name="magnifying-glass" size={14} />
      <input type="search" aria-label="Pesquisar" placeholder="Pesquisar" value={query} onFocus={() => { setOpenGroup(null); setPopover('search'); }} onChange={event => { setQuery(event.target.value); setPopover('search'); }} />
      {popover === 'search' && query.trim() !== '' && <div className="origin-search-results" role="listbox" aria-label="Telas encontradas">{matches.length ? matches.map(item => <button type="button" role="option" aria-selected="false" key={`${item.label}-${item.to}`} onClick={() => go(item.to)}>{item.label}</button>) : <p>Nenhuma tela encontrada.</p>}</div>}
    </form>
    <div className="origin-tools">
      {syncTool}
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label={notificationCount ? `Notificações: ${notificationCount} não lidas` : 'Notificações'} title="Notificações" aria-expanded={popover === 'notifications'} onClick={() => toggle('notifications')}><Icon name="bell" size={15} />{notificationCount ? <span className="origin-badge" aria-hidden="true">{notificationCount > 99 ? '99+' : notificationCount}</span> : null}</button>
        {popover === 'notifications' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar notificações" onClick={close} />{notificationsPanel ? notificationsPanel(close) : <div className="origin-popover origin-notifications"><h3>Notificações</h3><div className="origin-popover-tabs"><span aria-current="true">Não lidas (0)</span><span>Todas</span></div><p className="origin-popover-empty">No momento não temos notificações!</p></div>}</>}</div>
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label="Central de ajuda" title="Central de ajuda" aria-expanded={popover === 'help'} onClick={() => toggle('help')}><Icon name="circle-question" size={15} /></button>
        {popover === 'help' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar ajuda" onClick={close} /><div className="origin-popover origin-help">{helpLinks.length > 0 && <><h3>Central de ajuda</h3><nav className="origin-help-links" aria-label="Ajuda do FAGOO">{helpLinks.map(link => <Link key={link.to} to={link.to} onClick={close}><Icon name={link.icon || 'circle-question'} size={13} />{link.label}</Link>)}</nav></>}<h3>Atalhos de teclado</h3><dl>{ORIGIN_SHORTCUTS.map(item => <div key={item.keys}><dt><kbd>{item.keys}</kbd></dt><dd>{item.action}</dd></div>)}</dl><p className="origin-help-credit">Ícones <a href="https://fontawesome.com" target="_blank" rel="noreferrer">Font Awesome Free</a> (CC BY 4.0) · fonte Inter (SIL OFL 1.1)</p></div></>}</div>
      <Link className="origin-tool-button" to={preferencesTo} aria-label="Preferências" title="Preferências" onClick={close}><Icon name="gear" size={15} /></Link>
      <div className="origin-tool"><button type="button" className="origin-user-button" aria-label={`Menu do usuário ${user.name}`} title={userTitle} aria-expanded={popover === 'user'} onClick={() => toggle('user')}><span className="origin-avatar" aria-hidden="true">{initials(user.name)}</span><span className="origin-user-name">{user.name}</span></button>
        {popover === 'user' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar menu do usuário" onClick={close} /><div className="origin-popover origin-user-menu">
          {companyTo ? <Link className="origin-user-company" to={companyTo} onClick={close}><Icon name="building" size={13} /><span>{user.company}</span></Link> : <p className="origin-user-company"><Icon name="building" size={13} /><span>{user.company}</span></p>}
          {user.detail && <p className="origin-user-detail">{user.detail}</p>}
          {userLinks.map(link => <Link key={link.to} to={link.to} onClick={close}><Icon name={link.icon || 'arrow-right'} size={13} />{link.label}</Link>)}
          <Link to={preferencesTo} onClick={close}><Icon name="gear" size={13} />Todas as configurações</Link>
          {actionsTo && <Link to={actionsTo} onClick={close}><Icon name="list-check" size={13} />Consultar gestão de ações</Link>}
          {storage && <Link to={storage.to} onClick={close}><Icon name="database" size={13} />{storage.label}<Icon name="up-right-from-square" size={10} /></Link>}
          <label className="origin-theme-switch"><span>Tema escuro</span><input type="checkbox" role="switch" checked={theme === 'dark'} onChange={onTheme} /></label>
          {onLogout && <button type="button" onClick={() => { close(); onLogout(); }}><Icon name="arrow-right-from-bracket" size={13} />Sair da conta</button>}
        </div></>}</div>
    </div>
    {popover === 'drawer' && <><button type="button" className="origin-drawer-backdrop" aria-label="Fechar menu" onClick={close} /><nav className="origin-drawer" aria-label="Menu completo">
      <Link to={homeTo} onClick={close}><Icon name="house" size={13} />Início</Link>
      {groups.map(group => <section key={group.name}><h3>{group.name}</h3>{group.columns.flatMap(column => column.items).filter(item => item.to).map(item => <Link key={`${group.name}-${item.label}`} to={item.to!} onClick={close}>{item.label}</Link>)}</section>)}
      <Link to={preferencesTo} onClick={close}><Icon name="gear" size={13} />Preferências</Link>
    </nav></>}
  </header>;
}
