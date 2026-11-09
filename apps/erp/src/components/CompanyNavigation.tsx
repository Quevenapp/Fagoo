import { originIntegrationEnabled, originConnectionAvailable, originHistoryAvailable, isOriginIntegrationRoute } from '../lib/integration-capabilities';
import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { AccessState } from '../lib/real-access';
import { ROLE_LABELS } from '../lib/real-access';
import { activeGroupFor, matchesLocation, resolveMenu, resolvePreferences } from '../lib/origin-menu';
import { workspaceMenu } from '../lib/fagoo-menu';
import { useTheme } from '../hooks/useTheme';
import OriginTopBar from './OriginTopBar';
import OriginSyncButton from './OriginSyncButton';
import type { OriginSyncController } from '../lib/origin-sync-model';
import { NotificationsPanel, useCompanyChrome, useStoredThemeAtLogin } from './CompanyChrome';
import { storageSummary, type SystemController } from '../lib/system-model';
import './company-navigation.css';
import type { FagooContext } from '../lib/fagoo-model';
import type { ResolvedGroup } from '../lib/origin-menu';

// Leva H (PRF-287, PRF-255): the help of the Brufap itself, inside the app; no external help domain.
const COMPANY_HELP_LINKS = [{ label: 'Central de ajuda do FAGOO', to: '/ajuda', icon: 'circle-question' }, { label: 'Convivência com o Origin', to: '/ajuda/convivencia', icon: 'arrows-rotate' },
  { label: 'Novidades no FAGOO', to: '/ajuda/novidades', icon: 'star' }];

// Company area navigation: the Origin top bar (same menu as the demo) plus the location trail.
// Brufap-only tools live in Preferências (gear), like Origin's own settings. With a controller that offers the Sistema port,
// the bar shows the user's name, the razão social, Armazenamento and the live notifications (migration 151).
export default function CompanyNavigation({ state, onLogout, controller, fagooContext }: { state: AccessState; onLogout: () => void; fagooContext?: FagooContext|null; controller?: Partial<SystemController> & Partial<OriginSyncController> & { preferences?: (path: string, options?: { method?: 'GET'; signal?: AbortSignal }) => Promise<unknown> } }) {
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const ready = state.phase === 'ready';
  const role = state.membership?.role;
  const resources = ready ? state.membership!.resources : [];
  const authenticated = ['checking', 'pending', 'ready', 'error'].includes(state.phase);
  const originIntegration = ready && originIntegrationEnabled(state.membership);
  const originHistory = ready && originHistoryAvailable(state.membership);
  const access = ready && role ? { role, resources, capabilities: state.membership?.capabilities } : {};
  const groups = useMemo(() => {
    const existing=resolveMenu('real', access),caps=new Set(fagooContext?.units.flatMap(u=>u.capabilities)??[]);
    const items=[...((caps.has('communication.read')||caps.has('team.chat'))?[{label:'Central de atendimento',to:'/atendimento'}]:[]),...(['queue.read','queue.operate','panel.read','ticket.issue'].some(c=>caps.has(c))?[{label:'Filas e painéis',to:'/filas'}]:[]),...(caps.has('crm.read')?[{label:'Relacionamento e oportunidades',to:'/crm'}]:[]),...(fagooContext&&role==='admin'?[{label:'Configurar Fagoo',to:'/configurar'}]:[])];
    return items.length?[...existing,{name:'Meu Negócio',columns:[{title:'Fagoo',items:items.map(item=>({...item,disabled:false}))}]} as ResolvedGroup]:existing;
  }, [ready, role, resources.join(','), originIntegration, originHistory,fagooContext]);
  const preferences = useMemo(() => resolvePreferences(access), [ready, role, originIntegration, originHistory]);
  const preferenceLinks = preferences.flatMap(category => category.entries.map(entry => ({ label: entry.label, to: entry.to })));
  const preparationPage = originHistory && ready && role === 'admin' && ['/preparacao-virada/depositos', '/preparacao-virada/depositos/estoque'].includes(location.pathname);
  const stockPage = preparationPage && location.pathname.endsWith('/estoque');
  const active = activeGroupFor(groups, location.pathname, location.search);
  const current = active?.columns.flatMap(column => column.items).find(item => item.to && matchesLocation(item.to, location.pathname, location.search));
  const preference = preferences.flatMap(category => category.entries.map(entry => ({ category, entry }))).find(({ entry }) => matchesLocation(entry.to, location.pathname, location.search) || entry.to.startsWith('/preferencias/') && location.pathname.startsWith(`${entry.to}/`));
  const hubCategory = preferences.find(category => `/preferencias/${category.id}` === location.pathname);
  const chrome = useCompanyChrome(controller, state);
  useStoredThemeAtLogin(controller as Parameters<typeof useStoredThemeAtLogin>[0], state);
  const person = chrome.profile?.name ?? chrome.profile?.email ?? null;
  const user = { name: ready && role ? person ?? ROLE_LABELS[role] : authenticated ? 'Verificando acesso' : 'Visitante', company: chrome.profile?.company?.legal_name ?? 'FAGOO', detail: ready ? person && role ? `Perfil: ${ROLE_LABELS[role]}` : 'Área da empresa' : undefined };
  const system = ready && typeof controller?.system === 'function' ? controller as SystemController : null;
  const sync = originConnectionAvailable(state.membership) && ready && typeof controller?.originSync === 'function' ? controller as OriginSyncController : null;
  // The trail names the same module the sidebar shows (Comercial, Catálogo…), so both read alike.
  const moduleName = useMemo(() => current?.to ? workspaceMenu(groups, role).find(group => group.columns.some(column => column.items.some(item => item.to === current.to)))?.name ?? active?.name : active?.name, [groups, role, current?.to, active?.name]);
  const trail = ready ? location.pathname === '/acesso' ? <nav aria-label="Localização"><span aria-current="page">Visão geral</span></nav> : <nav aria-label="Localização"><Link to="/acesso">Início</Link>
      {preparationPage ?<><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span><Link to="/preparacao-virada">Preparação da virada</Link><span aria-hidden="true">›</span>{stockPage ? <><Link to="/preparacao-virada/depositos">Depósitos do Origin</Link><span aria-hidden="true">›</span><span aria-current="page">Estoque informado pelo Origin</span></> : <span aria-current="page">Depósitos do Origin</span>}</>
        : active ? <><span aria-hidden="true">›</span><span>{moduleName}</span>{current && current.label !== 'Dashboard geral' && <><span aria-hidden="true">›</span><span aria-current="page">{current.label}</span></>}</>
        : location.pathname === '/preferencias' ? <><span aria-hidden="true">›</span><span aria-current="page">Preferências</span></>
        : hubCategory ? <><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span><span aria-current="page">{hubCategory.label}</span></>
        : preference ? <><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span>{preference.entry.to.startsWith('/preferencias/') ? <Link to={`/preferencias/${preference.category.id}`}>{preference.category.label}</Link> : <span>{preference.category.label}</span>}<span aria-hidden="true">›</span><span aria-current="page">{preference.entry.label}</span></> : null}
    </nav> : undefined;
  return <>
    <OriginTopBar groups={ready ? groups : []} activeGroup={active?.name} homeTo="/acesso" preferencesTo="/preferencias" user={user} theme={theme} onTheme={toggle} role={ready ? role : undefined} trail={trail}
      userTitle="Meu Perfil" companyTo={ready ? '/empresa-configuracoes' : undefined} storage={ready && chrome.storage ? { label: `Armazenamento ${storageSummary(chrome.storage).label}`, to: '/empresa-configuracoes?secao=armazenamento' } : null}
      notificationCount={ready ? chrome.unread : null} notificationsPanel={system && chrome.actor ? close => <NotificationsPanel controller={system} actor={chrome.actor!} onUnread={chrome.setUnread} onNavigate={close} /> : undefined}
      onLogout={authenticated ? onLogout : undefined} actionsTo={ready ? '/preferencias/sistema/gestao-acoes' : undefined} helpLinks={ready ? COMPANY_HELP_LINKS.filter(link => originHistory || !isOriginIntegrationRoute(link.to)) : []} syncTool={sync ? <OriginSyncButton controller={sync} canRequest={role !== 'consulta'} canConfigure={role === 'admin'} /> : undefined} userLinks={ready ? [{ label: 'Dados da empresa', to: '/empresa-configuracoes', icon: 'building' }] : []} searchLinks={preferenceLinks} />
  </>;
}
