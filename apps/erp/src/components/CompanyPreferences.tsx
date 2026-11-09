import {Link,Navigate,useLocation} from 'react-router-dom';
import type {AccessState} from '../lib/real-access';
import {COMPANY_PREFERENCES,resolvePreferences} from '../lib/origin-menu';
import {parsePreferencesPath,SYSTEM_SCREENS} from '../lib/preferences-route';
import type {PreferencesController} from '../lib/preferences-model';
import PreferencesPage from './PreferencesPage';
import SystemUpdates from './SystemUpdates';
import WabotiaPairing from './WabotiaPairing';
import type {UpdatePort} from '../lib/system-updates';
import PreferenceSettingsPage from './PreferenceSettingsPage';
import RealUsers from './RealUsers';
import RealActivity from './RealActivity';
import RealFiles from './RealFiles';
import type {SystemLogController} from '../lib/activity-model';
import type {UsersController} from '../lib/access-users-model';
import type {BusinessController} from '../lib/business-model';
import BusinessDashboards from './BusinessDashboards';
import RealSituations from './RealSituations';
import RealReports from './RealReports';
import RealLabels from './RealLabels';
import SpreadsheetImport from './SpreadsheetImport';
import RealImportJobs from './RealImportJobs';
import PlatformTasks from './PlatformTasks';
import CompanyExport from './CompanyExport';
import type {PlatformPort} from '../lib/platform-model';
import {SCREEN_TEMPLATES} from '../lib/spreadsheet-import';
import type {NativeRequestOptions} from '../lib/real-access';

/**
 * Preferências of the company area: the hub (categories) and every settings page, routed by the address. A settings page
 * stays mounted when the role changes, so it can hide itself and keep a pending command of the same user. Sistema screens
 * that Origin opens from Preferências › Sistema (Usuários, Registro de atividades, Consulta de exclusões realizadas and
 * Gerenciador de arquivos and, from migrations 148-149, Gerenciador de transições, Relatórios customizados and Etiquetas customizadas) are served under /preferencias/sistema/<tela>;
 * Gerenciar grupos de tags and Gerenciar tags under /preferencias/suprimentos/<tela> open the product tag screens (/grupos-tags,
 * /tags, migration 119), whose tags are the ones linked to products. Meu Negócio (/meu-negocio, migration 150) is
 * served by this same module, so the company router needs no new entry.
 */
export default function CompanyPreferences({controller,state}:{controller:PreferencesController&UsersController&SystemLogController&BusinessController&{catalog?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};state:AccessState}){
 const {pathname}=useLocation();
 if(pathname==='/preferencias/sistema/wabotia')return <WabotiaPairing controller={controller as unknown as Parameters<typeof WabotiaPairing>[0]['controller']} state={state}/>;
 if(pathname==='/preferencias/sistema/atualizacoes')return <SystemUpdates controller={controller as unknown as Partial<UpdatePort>} state={state}/>;
 if(pathname==='/meu-negocio')return <BusinessDashboards key={state.membership!.user_id} controller={controller}/>;
 const categories=resolvePreferences({role:state.membership!.role,resources:state.membership!.resources,capabilities:state.membership!.capabilities}),route=parsePreferencesPath(pathname);
 if(route.kind==='hub'&&(!route.category||categories.some(c=>c.id===route.category)))return <PreferencesPage key={state.membership!.user_id} homeTo="/acesso" categories={categories} initialCategory={route.category} categoryHref={id=>`/preferencias/${id}`}/>;
 if(route.kind==='page'){const category=COMPANY_PREFERENCES.find(c=>c.id===route.page.category);
  // A page outside the hub (Meu Negócio > Ajustes, migration 150) returns to its own screen.
  const back=category?{label:category.label,to:`/preferencias/${category.id}`}:{label:'Meu Negócio',to:'/meu-negocio'};
  return <PreferenceSettingsPage key={`${state.membership!.user_id}:${route.page.id}`} controller={controller} page={route.page} section={route.section} categoryLabel={back.label} categoryTo={back.to}/>;}
 if(route.kind==='screen')return <><nav className="preferences-breadcrumb preferences-screen-trail" aria-label="Localização"><Link to="/acesso">Home</Link> › <Link to="/preferencias">Preferências</Link> › <Link to="/preferencias/sistema">Sistema</Link> › <span aria-current="page">{SYSTEM_SCREENS[route.screen]}</span></nav>
  {route.screen==='usuarios'?<RealUsers key={state.membership!.user_id} controller={controller}/>:route.screen==='gerenciador-arquivos'?<RealFiles key={state.membership!.user_id} controller={controller}/>
   :route.screen==='gerenciador-transicoes'?<RealSituations key={state.membership!.user_id} controller={controller}/>
   :route.screen==='relatorios-customizados'?<RealReports key={state.membership!.user_id} controller={controller}/>:route.screen==='etiquetas-customizadas'?<RealLabels key={state.membership!.user_id} controller={controller}/>
   :<RealActivity key={`${state.membership!.user_id}:${route.screen}`} controller={controller} mode={route.screen==='consulta-exclusoes'?'deletions':'activity'}/>}</>;
 // 228: Importações de Dados and Consultar gestão de ações (menu do usuário).
 if(route.kind==='import')return <><nav className="preferences-breadcrumb preferences-screen-trail" aria-label="Localização"><Link to="/acesso">Home</Link> › <Link to="/preferencias">Preferências</Link> › <Link to="/preferencias/importacoes">Importações de Dados</Link> › <span aria-current="page">{SCREEN_TEMPLATES[route.importKind].title}</span></nav>
  <SpreadsheetImport key={`${state.membership!.user_id}:${route.importKind}`} controller={controller} kind={route.importKind}/></>;
 if(route.kind==='actions')return <><nav className="preferences-breadcrumb preferences-screen-trail" aria-label="Localização"><Link to="/acesso">Home</Link> › <span aria-current="page">Gestão de ações</span></nav>
  <RealImportJobs key={state.membership!.user_id} controller={controller}/>
  {/* Leva H (PRF-280): the server tasks (notifications, exports, cleanups) below the browser imports. */}
  <PlatformTasks key={`tasks:${state.membership!.user_id}`} controller={controller as unknown as Partial<PlatformPort>}/></>;
 // Leva H (PRF-029): Backup e Exportação › Backup.
 if(route.kind==='backup')return <CompanyExport key={state.membership!.user_id} controller={controller as unknown as Partial<PlatformPort>&{getSnapshot:()=>AccessState}}/>;
 if(route.kind==='supply')return <Navigate to={route.screen==='grupos-tags'?'/grupos-tags':'/tags'} replace/>;
 return <section className="real-state-panel"><h1>Preferência não encontrada</h1><p>Esta página de preferências não existe ou não está liberada para o seu perfil.</p></section>;
}
