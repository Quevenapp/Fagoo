import { useEffect, useMemo, useState, useRef, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import type { ResolvedGroup } from '../lib/origin-menu';
import { Icon } from './Icon';
import { FagooBrand } from './FagooBrand';
import { focusModule, workspaceMenu } from '../lib/fagoo-menu';
import { matchesLocation } from '../lib/origin-menu';
import { goToShortcuts, matchesSearch, shortcutIntent, workspaceActions, type WorkspaceAction } from '../lib/workspace-actions';
import './origin-top-bar.css';

export type TopBarLink = { label: string; to: string; icon?: string };
export type TopBarUser = { name: string; company: string; detail?: string };

type Popover = 'menu' | 'notifications' | 'help' | 'user' | 'search' | 'drawer' | 'create' | null;

export const ORIGIN_SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: 'Enter', action: 'Pesquisar na listagem ou aplicar o período digitado' },
  { keys: 'Esc', action: 'Fechar menus, filtros e janelas' },
  { keys: 'Shift + clique', action: 'Selecionar um intervalo de linhas da listagem' },
  { keys: 'Ctrl + clique', action: 'Abrir o registro em uma nova aba' },
  { keys: 'Alt + letra', action: 'Atalhos da Frente de caixa (Ctrl + Shift no Mac)' },
];

/** Shortcuts of the workspace itself, shown in the help panel next to the list and PDV ones. */
export const WORKSPACE_SHORTCUTS: readonly { group: string; items: readonly { keys: readonly string[]; action: string }[] }[] = [
  { group: 'Em qualquer tela', items: [
    { keys: ['Ctrl', 'K'], action: 'Buscar telas e ações' },
    { keys: ['/'], action: 'Buscar telas e ações' },
    { keys: ['N'], action: 'Novo pedido de venda' },
    { keys: ['O'], action: 'Nova proposta comercial' },
    { keys: ['?'], action: 'Mostrar os atalhos' },
  ] },
  { group: 'Ir para (G e a letra)', items: [
    { keys: ['G', 'I'], action: 'Visão geral' }, { keys: ['G', 'P'], action: 'Pedidos de venda' }, { keys: ['G', 'O'], action: 'Propostas comerciais' },
    { keys: ['G', 'C'], action: 'Clientes' }, { keys: ['G', 'A'], action: 'Catálogo de produtos' }, { keys: ['G', 'E'], action: 'Estoque' },
    { keys: ['G', 'F'], action: 'Frente de caixa' }, { keys: ['G', 'R'], action: 'Relatórios de vendas' },
  ] },
  { group: 'No pedido e na proposta', items: [
    { keys: ['Ctrl', 'S'], action: 'Salvar o documento' },
    { keys: ['Alt', '1…5'], action: 'Ir para Cliente, Itens, Pagamento, Entrega e Observações' },
    { keys: ['Alt', 'Z'], action: 'Incluir uma linha de item' },
    { keys: ['↓'], action: 'Da busca para a lista de resultados' },
  ] },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || 'F';
}

const modalOpen = () => Boolean(globalThis.document?.querySelector?.('dialog[open], [aria-modal="true"]'));

export default function OriginTopBar({ groups, activeGroup, homeTo, preferencesTo, user, theme, onTheme, onLogout, userLinks = [], searchLinks = [], userTitle, companyTo, storage, notificationCount, notificationsPanel, actionsTo, helpLinks = [], syncTool, role, trail }: {
  groups: readonly ResolvedGroup[]; activeGroup?: string; homeTo: string; preferencesTo: string; user: TopBarUser;
  theme: 'light' | 'dark'; onTheme: () => void; onLogout?: () => void; userLinks?: readonly TopBarLink[]; searchLinks?: readonly TopBarLink[];
  userTitle?: string; companyTo?: string; storage?: { label: string; to: string } | null; notificationCount?: number | null; notificationsPanel?: (close: () => void) => ReactNode;
  /** Background operations available to the current user. */
  actionsTo?: string;
  /** Leva H (PRF-287): the Brufap help of the company area (/ajuda), shown above the keyboard shortcuts. */
  helpLinks?: readonly TopBarLink[];
  /** 202610220009: the "Sincronizar" tool of the two-way sync with the Origin (company area only). */
  syncTool?: ReactNode;
  /** Profile of the signed-in user: orders the modules and offers the quick actions it may use. */
  role?: string;
  /** Location trail shown in the bar (Início › módulo › tela). */
  trail?: ReactNode;
}) {
  const navigate = useNavigate(), location = useLocation();
  const navigation = useMemo(() => workspaceMenu(groups, role), [groups, role]);
  const actions = useMemo(() => workspaceActions(groups, role), [groups, role]);
  const goTo = useMemo(() => goToShortcuts(groups, homeTo), [groups, homeTo]);
  const createActions = actions.filter(action => action.create || action.id === 'pdv');
  const primaryAction = actions.find(action => action.create);
  // On the overview the sidebar opens the module the profile works in (Comercial for sellers), not the dashboards.
  const onHome = location.pathname === homeTo;
  const currentModule = onHome ? undefined : navigation.find(group => group.columns.some(column => column.items.some(item => matchesLocation(item.to, location.pathname, location.search))))?.name;
  const openTarget = currentModule ?? (onHome ? navigation.find(group => group.name === focusModule(role))?.name : undefined);
  const defaultGroup = openTarget ?? null;
  const [popover, setPopover] = useState<Popover>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(defaultGroup);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pendingGo, setPendingGo] = useState(false);
  const drawerButton = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const goTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const close = () => { setPopover(null); if (popover === 'drawer') drawerButton.current?.focus(); };
  const destinations = useMemo(() => {
    const items: TopBarLink[] = [];
    for (const group of navigation) for (const column of group.columns) for (const item of column.items) if (item.to) items.push({ label: item.label, to: item.to });
    return [...items, ...searchLinks].filter((item, index, all) => all.findIndex(other => other.label === item.label && other.to === item.to) === index);
  }, [navigation, searchLinks]);
  type Result = { key: string; label: string; detail: string; to: string; icon: string; keys?: readonly string[] };
  const actionResult = (action: WorkspaceAction): Result => ({ key: `action:${action.id}`, label: action.label, detail: action.description, to: action.to, icon: action.icon, keys: action.keys });
  const results: Result[] = query.trim()
    ? [...actions.filter(action => matchesSearch(action.label, query)).map(actionResult),
      ...destinations.filter(item => matchesSearch(item.label, query)).map(item => ({ key: `screen:${item.to}:${item.label}`, label: item.label, detail: navigation.find(group => group.columns.some(column => column.items.some(entry => entry.to === item.to)))?.name ?? 'Configurações', to: item.to, icon: 'arrow-right' }))].slice(0, 8)
    : actions.map(actionResult);
  const go = (to: string) => { close(); setQuery(''); setActive(0); searchInput.current?.blur(); navigate(to); };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); const target = results[Math.min(active, results.length - 1)]; if (query.trim() && target) go(target.to); else if (!query.trim() && target && popover === 'search') go(target.to); };
  const searchKeys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setPopover('search');
      if (results.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
    } else if (event.key === 'Escape') { setQuery(''); setPopover(null); searchInput.current?.blur(); }
  };
  const toggleGroup = (name: string) => { setOpenGroup(openGroup === name ? null : name); };
  useEffect(() => { if (openTarget) setOpenGroup(openTarget); }, [openTarget]);
  useEffect(() => { setActive(0); }, [query]);
  const toggle = (name: Exclude<Popover, null>) => { setPopover(popover === name ? null : name); };
  // Keyboard: the latest values are read through a ref so the listener is bound once per bar.
  const live = useRef({ popover, pendingGo, actions, goTo });
  live.current = { popover, pendingGo, actions, goTo };
  useEffect(() => {
    const cancelGo = () => { if (goTimer.current) clearTimeout(goTimer.current); goTimer.current = null; setPendingGo(false); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { cancelGo(); if (live.current.popover === 'drawer') drawerButton.current?.focus(); setPopover(null); return; }
      if (event.defaultPrevented || event.repeat || modalOpen()) return;
      const intent = shortcutIntent(event, { pendingGo: live.current.pendingGo, actions: live.current.actions, goTo: live.current.goTo });
      if (live.current.pendingGo && intent?.kind !== 'palette') cancelGo();
      if (!intent) return;
      event.preventDefault();
      if (intent.kind === 'palette') { setPopover('search'); searchInput.current?.focus(); searchInput.current?.select(); }
      else if (intent.kind === 'help') setPopover('help');
      else if (intent.kind === 'go-pending') { setPendingGo(true); if (goTimer.current) clearTimeout(goTimer.current); goTimer.current = setTimeout(() => { goTimer.current = null; setPendingGo(false); }, 1600); }
      else { setPopover(null); navigate(intent.to); }
    };
    globalThis.window?.addEventListener('keydown', onKey);
    return () => { globalThis.window?.removeEventListener('keydown', onKey); if (goTimer.current) clearTimeout(goTimer.current); };
  }, [navigate]);
  const searchOpen = popover === 'search' && (query.trim() !== '' || results.length > 0);

  return <>
    {popover === 'drawer' && <button type="button" className="fagoo-nav-backdrop" aria-label="Fechar menu" onClick={close}/>}
    <aside className={`fagoo-navigation${popover === 'drawer' ? ' is-open' : ''}`} aria-label="Navegação do FAGOO">
      <Link className="fagoo-nav-brand" to={homeTo} aria-label="FAGOO, página inicial" onClick={close}><FagooBrand/></Link>
      <div className="fagoo-workspace"><span className="fagoo-workspace-mark" aria-hidden="true">{initials(user.company)}</span><span><small>Espaço de trabalho</small><strong>{user.company}</strong></span></div>
      {primaryAction && <Link className="fagoo-nav-cta" to={primaryAction.to} onClick={close}><Icon name="plus" size={17}/><span>{primaryAction.label.replace(' de venda', '')}</span><kbd aria-hidden="true">{primaryAction.keys[0]}</kbd></Link>}
      <nav className="fagoo-modules" aria-label="Módulos">
        <Link className="fagoo-home-link" to={homeTo} aria-current={location.pathname === homeTo ? 'page' : undefined} onClick={close}><Icon name="house" size={18}/>Visão geral</Link>
        <p className="fagoo-nav-label">Operação</p>
        {navigation.map((group, index) => <section className="fagoo-module" key={group.name}>
          <button type="button" className={currentModule === group.name ? 'is-active' : ''} aria-expanded={openGroup === group.name} aria-controls={`fagoo-module-${index}`} onClick={() => toggleGroup(group.name)}><Icon name={group.icon} size={18}/><span>{group.name}</span><Icon name={openGroup === group.name ? 'chevron-up' : 'chevron-down'} size={13}/></button>
          <div id={`fagoo-module-${index}`} hidden={openGroup !== group.name} className="fagoo-module-links">{group.columns.map(column => <div key={column.title}>{column.title && <h3>{column.title}</h3>}{column.items.map(item => item.to ? <Link key={item.label} to={item.to} onClick={close} aria-current={matchesLocation(item.to, location.pathname, location.search) ? 'page' : undefined}>{item.label}</Link> : <span key={item.label} aria-disabled="true">{item.label}</span>)}</div>)}</div>
        </section>)}
      </nav>
      <div className="fagoo-nav-bottom">
        <Link to={preferencesTo} onClick={close}><Icon name="gear" size={17}/>Configurações</Link>
        <button type="button" onClick={() => { setPopover('help'); }}><Icon name="keyboard" size={17}/>Atalhos do teclado<kbd aria-hidden="true">?</kbd></button>
      </div>
    </aside>
    <header className="origin-topbar fagoo-topbar">
    <button ref={drawerButton} type="button" className="origin-drawer-toggle" aria-label="Abrir menu" aria-expanded={popover === 'drawer'} onClick={() => toggle('drawer')}><Icon name="bars" size={20}/></button>
    <div className="fagoo-topbar-trail">{trail ?? <span className="fagoo-context-title">{currentModule || activeGroup || 'Seu espaço de trabalho'}</span>}</div>
    <form className="origin-global-search" role="search" onSubmit={submitSearch}>
      <Icon name="magnifying-glass" size={15} />
      <input ref={searchInput} type="search" aria-label="Pesquisar" placeholder="Buscar telas e ações…" autoComplete="off" role="combobox" aria-expanded={searchOpen} aria-controls="fagoo-command-results" aria-autocomplete="list"
        aria-activedescendant={searchOpen && results[active] ? `fagoo-command-${active}` : undefined} value={query}
        onFocus={() => { setPopover('search'); }} onKeyDown={searchKeys} onChange={event => { setQuery(event.target.value); setPopover('search'); }} />
      <kbd className="origin-search-kbd" aria-hidden="true">Ctrl K</kbd>
      {searchOpen && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar busca" onClick={() => setPopover(null)} /><div className="origin-search-results" id="fagoo-command-results" role="listbox" aria-label={query.trim() ? 'Telas e ações encontradas' : 'Ações rápidas'}>
        {!query.trim() && <p className="origin-search-heading">Ações rápidas</p>}
        {results.length ? results.map((item, index) => <button type="button" role="option" id={`fagoo-command-${index}`} aria-selected={index === active} className={index === active ? 'is-active' : undefined} key={item.key} onMouseEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => go(item.to)}>
          <span className="origin-search-icon" aria-hidden="true"><Icon name={item.icon} size={15}/></span><span className="origin-search-text"><strong>{item.label}</strong><small>{item.detail}</small></span>{item.keys && <span className="origin-search-keys" aria-hidden="true">{item.keys.map(key => <kbd key={key}>{key}</kbd>)}</span>}</button>)
          : <p>Nenhuma tela ou ação encontrada.</p>}
        <p className="origin-search-footer" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> abrir</span><span><kbd>Esc</kbd> fechar</span></p>
      </div></>}
    </form>
    <div className="origin-tools">
      {createActions.length > 0 && <div className="origin-tool"><button type="button" className="origin-create-button" aria-haspopup="menu" aria-expanded={popover === 'create'} onClick={() => toggle('create')}><Icon name="plus" size={15}/><span>Novo</span><Icon name="chevron-down" size={11}/></button>
        {popover === 'create' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar menu de criação" onClick={close} /><div className="origin-popover origin-create-menu" role="menu" aria-label="Criar">
          {createActions.map(action => <Link role="menuitem" key={action.id} to={action.to} onClick={close}><span className="origin-search-icon" aria-hidden="true"><Icon name={action.icon} size={15}/></span><span className="origin-search-text"><strong>{action.label}</strong><small>{action.description}</small></span><span className="origin-search-keys" aria-hidden="true">{action.keys.map(key => <kbd key={key}>{key}</kbd>)}</span></Link>)}
        </div></>}</div>}
      {syncTool}
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label={notificationCount ? `Notificações: ${notificationCount} não lidas` : 'Notificações'} title="Notificações" aria-expanded={popover === 'notifications'} onClick={() => toggle('notifications')}><Icon name="bell" size={17} />{notificationCount ? <span className="origin-badge" aria-hidden="true">{notificationCount > 99 ? '99+' : notificationCount}</span> : null}</button>
        {popover === 'notifications' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar notificações" onClick={close} />{notificationsPanel ? notificationsPanel(close) : <div className="origin-popover origin-notifications"><h3>Notificações</h3><div className="origin-popover-tabs"><span aria-current="true">Não lidas (0)</span><span>Todas</span></div><p className="origin-popover-empty">No momento não temos notificações!</p></div>}</>}</div>
      <div className="origin-tool"><button type="button" className="origin-tool-button" aria-label="Central de ajuda" title="Ajuda e atalhos (?)" aria-expanded={popover === 'help'} onClick={() => toggle('help')}><Icon name="circle-question" size={17} /></button>
        {popover === 'help' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar ajuda" onClick={close} /><div className="origin-popover origin-help" role="dialog" aria-label="Ajuda e atalhos de teclado">{helpLinks.length > 0 && <><h3>Central de ajuda</h3><nav className="origin-help-links" aria-label="Ajuda do FAGOO">{helpLinks.map(link => <Link key={link.to} to={link.to} onClick={close}><Icon name={link.icon || 'circle-question'} size={14} />{link.label}</Link>)}</nav></>}
          <h3>Atalhos de teclado</h3>
          {WORKSPACE_SHORTCUTS.map(section => <section className="origin-help-group" key={section.group}><h4>{section.group}</h4><dl>{section.items.map(item => <div key={item.action + item.keys.join('+')}><dt>{item.keys.map((key, index) => <span key={key}>{index > 0 && <i aria-hidden="true">{item.keys.length > 1 && section.group.startsWith('Ir para') ? 'e' : '+'}</i>}<kbd>{key}</kbd></span>)}</dt><dd>{item.action}</dd></div>)}</dl></section>)}
          <section className="origin-help-group"><h4>Listagens e frente de caixa</h4><dl>{ORIGIN_SHORTCUTS.map(item => <div key={item.keys}><dt><kbd>{item.keys}</kbd></dt><dd>{item.action}</dd></div>)}</dl></section>
          <p className="origin-help-credit">Os atalhos de uma letra ficam desligados enquanto você digita em um campo.</p></div></>}</div>
      <Link className="origin-tool-button" to={preferencesTo} aria-label="Preferências" title="Preferências" onClick={close}><Icon name="gear" size={17} /></Link>
      <div className="origin-tool"><button type="button" className="origin-user-button" aria-label={`Menu do usuário ${user.name}`} title={userTitle} aria-expanded={popover === 'user'} onClick={() => toggle('user')}><span className="origin-avatar" aria-hidden="true">{initials(user.name)}</span><span className="origin-user-name">{user.name}</span></button>
        {popover === 'user' && <><button type="button" className="origin-dismiss" tabIndex={-1} aria-label="Fechar menu do usuário" onClick={close} /><div className="origin-popover origin-user-menu">
          {companyTo ? <Link className="origin-user-company" to={companyTo} onClick={close}><Icon name="building" size={14} /><span>{user.company}</span></Link> : <p className="origin-user-company"><Icon name="building" size={14} /><span>{user.company}</span></p>}
          {user.detail && <p className="origin-user-detail">{user.detail}</p>}
          {userLinks.map(link => <Link key={link.to} to={link.to} onClick={close}><Icon name={link.icon || 'arrow-right'} size={14} />{link.label}</Link>)}
          <Link to={preferencesTo} onClick={close}><Icon name="gear" size={14} />Todas as configurações</Link>
          {actionsTo && <Link to={actionsTo} onClick={close}><Icon name="list-check" size={14} />Consultar gestão de ações</Link>}
          {storage && <Link to={storage.to} onClick={close}><Icon name="database" size={14} />{storage.label}<Icon name="up-right-from-square" size={11} /></Link>}
          <label className="origin-theme-switch"><span>Tema escuro</span><input type="checkbox" role="switch" checked={theme === 'dark'} onChange={onTheme} /></label>
          {onLogout && <button type="button" onClick={() => { close(); onLogout(); }}><Icon name="arrow-right-from-bracket" size={14} />Sair da conta</button>}
        </div></>}</div>
    </div>
  </header>
  {pendingGo && <div className="fagoo-go-hint" role="status"><strong>Ir para</strong>{goTo.map(item => <span key={item.key}><kbd>{item.key.toUpperCase()}</kbd>{item.label}</span>)}</div>}
  </>;
}
