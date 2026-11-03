import { useEffect, useMemo, useState, useRef, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import type { ResolvedGroup } from '../lib/origin-menu';
import { Icon } from './Icon';
import { FagooBrand } from './FagooBrand';
import { workspaceMenu } from '../lib/fagoo-menu';
import { matchesLocation } from '../lib/origin-menu';
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

export default function OriginTopBar({ groups, activeGroup, homeTo, preferencesTo, user, theme, onTheme, onLogout, userLinks = [], searchLinks = [], userTitle, companyTo, storage, notificationCount, notificationsPanel, actionsTo, helpLinks = [], syncTool }: {
  groups: readonly ResolvedGroup[]; activeGroup?: string; homeTo: string; preferencesTo: string; user: TopBarUser;
  theme: 'light' | 'dark'; onTheme: () => void; onLogout?: () => void; userLinks?: readonly TopBarLink[]; searchLinks?: readonly TopBarLink[];
  userTitle?: string; companyTo?: string; storage?: { label: string; to: string } | null; notificationCount?: number | null; notificationsPanel?: (close: () => void) => ReactNode;
  /** Background operations available to the current user. */
  actionsTo?: string;
  /** Leva H (PRF-287): the Brufap help of the company area (/ajuda), shown above the keyboard shortcuts. */
  helpLinks?: readonly TopBarLink[];
  /** 202610220009: the "Sincronizar" tool of the two-way sync with the Origin (company area only). */
  syncTool?: ReactNode;
}) {
  const navigate = useNavigate(), location = useLocation();
  const navigation=useMemo(()=>workspaceMenu(groups),[groups]);
  const currentModule=navigation.find(group=>group.columns.some(column=>column.items.some(item=>matchesLocation(item.to,location.pathname,location.search))))?.name;
  const [popover, setPopover] = useState<Popover>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(currentModule ?? null);
  const [query, setQuery] = useState('');
  const drawerButton=useRef<HTMLButtonElement>(null);
  const close = () => { setPopover(null); if(popover==='drawer')drawerButton.current?.focus(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPopover(null); if(popover==='drawer')drawerButton.current?.focus(); } };
    globalThis.window?.addEventListener('keydown', onKey);
    return () => globalThis.window?.removeEventListener('keydown', onKey);
  }, [popover]);
  const destinations = useMemo(() => {
    const items: TopBarLink[] = [];
    for (const group of navigation) for (const column of group.columns) for (const item of column.items) if (item.to) items.push({ label: item.label, to: item.to });
    return [...items, ...searchLinks].filter((item, index, all) => all.findIndex(other => other.label === item.label && other.to === item.to) === index);
  }, [navigation, searchLinks]);
  const normalized = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const matches = query.trim() ? destinations.filter(item => normalized(item.label).includes(normalized(query))).slice(0, 8) : [];
  const go = (to: string) => { close(); setQuery(''); navigate(to); };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); if (matches[0]) go(matches[0].to); };
  const toggleGroup = (name: string) => { setOpenGroup(openGroup === name ? null : name); };
  useEffect(() => { setOpenGroup(currentModule ?? null); }, [currentModule]);
  const toggle = (name: Exclude<Popover, null>) => { setPopover(popover === name ? null : name); };



  return <>
    {popover === 'drawer' && <button type="button" className="fagoo-nav-backdrop" aria-label="Fechar menu" onClick={close}/>}
    <aside className={`fagoo-navigation${popover === 'drawer' ? ' is-open' : ''}`} aria-label="Navegação do FAGOO">
      <Link className="fagoo-nav-brand" to={homeTo} aria-label="FAGOO, página inicial" onClick={close}><FagooBrand/></Link>
      <div className="fagoo-workspace"><span className="fagoo-workspace-mark"><Icon name="building" size={19}/></span><span><small>ESPAÇO DE TRABALHO</small><strong>{user.company}</strong></span></div>
      <nav className="fagoo-modules" aria-label="Módulos">
        <Link className="fagoo-home-link" to={homeTo} aria-current={location.pathname === homeTo ? 'page' : undefined} onClick={close}><Icon name="house" size={19}/>Visão geral</Link>
        <p className="fagoo-nav-label">OPERAÇÃO</p>
        {navigation.map((group,index)=><section className="fagoo-module" key={group.name}>
          <button type="button" className={currentModule===group.name?'is-active':''} aria-expanded={openGroup===group.name} aria-controls={`fagoo-module-${index}`} onClick={()=>toggleGroup(group.name)}><Icon name={group.icon} size={19}/><span>{group.name}</span><Icon name={openGroup===group.name?'chevron-up':'chevron-down'} size={13}/></button>
          <div id={`fagoo-module-${index}`} hidden={openGroup!==group.name} className="fagoo-module-links">{group.columns.map(column=><div key={column.title}>{column.title&&<h3>{column.title}</h3>}{column.items.map(item=>item.to?<Link key={item.label} to={item.to} onClick={close} aria-current={matchesLocation(item.to,location.pathname,location.search)?'page':undefined}>{item.label}</Link>:<span key={item.label} aria-disabled="true">{item.label}</span>)}</div>)}</div>
        </section>)}
      </nav>
      <div className="fagoo-nav-bottom"><Link to={preferencesTo} onClick={close}><Icon name="gear" size={18}/>Configurações</Link><span>FAGOO · Gestão na sua direção</span></div>
    </aside>
    <header className="origin-topbar fagoo-topbar">
    <button ref={drawerButton} type="button" className="origin-drawer-toggle" aria-label="Abrir menu" aria-expanded={popover === 'drawer'} onClick={() => toggle('drawer')}><Icon name="bars" size={20}/></button>
    <span className="fagoo-context-title">{currentModule||'Seu espaço de trabalho'}</span>
    <form className="origin-global-search" role="search" onSubmit={submitSearch}>
      <Icon name="magnifying-glass" size={14} />
      <input type="search" aria-label="Pesquisar" placeholder="Encontrar uma tela…" value={query} onFocus={() => { setPopover('search'); }} onChange={event => { setQuery(event.target.value); setPopover('search'); }} />
      {popover === 'search' && query.trim() !== '' && <div className="origin-search-results" role="listbox" aria-label="Telas encontradas">{matches.length ? matches.map(item => <button type="button" role="option" aria-selected="false" key={`${item.label}-${item.to}`} onClick={() => go(item.to)}>{item.label}</button>) : <p>Nenhuma tela encontrada.</p>}</div>}
    </form>
    <div className="origin-tools">
      {syncTool}
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label={notificationCount ? `Notificações: ${notificationCount} não lidas` : 'Notificações'} title="Notificações" aria-expanded={popover === 'notifications'} onClick={() => toggle('notifications')}><Icon name="bell" size={15} />{notificationCount ? <span className="origin-badge" aria-hidden="true">{notificationCount > 99 ? '99+' : notificationCount}</span> : null}</button>
        {popover === 'notifications' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar notificações" onClick={close} />{notificationsPanel ? notificationsPanel(close) : <div className="origin-popover origin-notifications"><h3>Notificações</h3><div className="origin-popover-tabs"><span aria-current="true">Não lidas (0)</span><span>Todas</span></div><p className="origin-popover-empty">No momento não temos notificações!</p></div>}</>}</div>
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label="Central de ajuda" title="Central de ajuda" aria-expanded={popover === 'help'} onClick={() => toggle('help')}><Icon name="circle-question" size={15} /></button>
        {popover === 'help' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar ajuda" onClick={close} /><div className="origin-popover origin-help">{helpLinks.length > 0 && <><h3>Central de ajuda</h3><nav className="origin-help-links" aria-label="Ajuda do FAGOO">{helpLinks.map(link => <Link key={link.to} to={link.to} onClick={close}><Icon name={link.icon || 'circle-question'} size={13} />{link.label}</Link>)}</nav></>}<h3>Atalhos de teclado</h3><dl>{ORIGIN_SHORTCUTS.map(item => <div key={item.keys}><dt><kbd>{item.keys}</kbd></dt><dd>{item.action}</dd></div>)}</dl><p className="origin-help-credit">FAGOO Line · Manrope e Source Sans 3 (SIL OFL 1.1). Atribuições em THIRD_PARTY_NOTICES.md.</p></div></>}</div>
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
  </header></>;
}
