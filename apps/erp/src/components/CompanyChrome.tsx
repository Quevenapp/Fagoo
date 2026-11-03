import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import type {AccessState} from '../lib/real-access';
import {PROFILE_PATH,STORAGE_PATH,NOTIFICATIONS_READ_PATH,CENTRAL_NOTIFICATIONS,notificationsPath,parseProfile,parseStorage,parseNotifications,parseNotificationsRead,captureNotificationsRead,
 notificationContent,notificationDate,storageSummary,initials as initialsOf,type SystemController,type Profile,type StorageUsage,type NotificationsView,type NotificationsReadInput} from '../lib/system-model';
import {Icon} from './Icon';
import {preferencesPagePath} from '../lib/preferences-request';
import {parsePreferencesPage} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import {applyStoredTheme} from '../hooks/useTheme';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
// The navigation stays free of the controller module (tests stub it): an HTTP refusal is read from its status.
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
type Port=Partial<Pick<SystemController,'system'>>&{getSnapshot?:()=>AccessState};
/** Top bar data of the company area (Meu perfil, Armazenamento, unread notifications), one actor at a time. */
export function useCompanyChrome(controller:Port|undefined,state:AccessState){
 const actor=state.phase==='ready'?state.membership?.user_id??null:null,role=state.membership?.role;
 const [profile,setProfile]=useState<Profile|null>(null),[storage,setStorage]=useState<StorageUsage|null>(null),[unread,setUnread]=useState<number|null>(null);
 useEffect(()=>{setProfile(null);setStorage(null);setUnread(null);if(!actor||typeof controller?.system!=='function')return;const p=new AbortController(),system=controller.system;
  const same=()=>!p.signal.aborted&&(!controller.getSnapshot||controller.getSnapshot().membership?.user_id===actor);
  void system(PROFILE_PATH,{method:'GET',signal:p.signal}).then(raw=>{const v=parseProfile(raw);if(same()&&v.user_id===actor)setProfile(v);}).catch(()=>{});
  void system(STORAGE_PATH,{method:'GET',signal:p.signal}).then(raw=>{if(same())setStorage(parseStorage(raw));}).catch(()=>{});
  void system(notificationsPath('nao_lidas'),{method:'GET',signal:p.signal}).then(raw=>{if(same())setUnread(parseNotifications(raw,{tab:'nao_lidas'}).unread);}).catch(()=>{});
  return()=>p.abort();},[controller,actor,role]);
 return{profile,storage,unread,setUnread,actor};
}

/** Origin notifications popover: "Não lidas (N)" | "Todas", expandable items, ⋮ Configurar notificações and Marcar todas como lida. */
export function NotificationsPanel({controller,actor,onUnread,onNavigate}:{controller:Pick<SystemController,'system'>&{getSnapshot?:()=>AccessState};actor:string;onUnread:(n:number)=>void;onNavigate:()=>void}){
 const [tab,setTab]=useState<'nao_lidas'|'todas'>('nao_lidas'),[view,setView]=useState<NotificationsView|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(''),[menu,setMenu]=useState(false),[reload,setReload]=useState(0);
 const [pending,setPending]=useState<NotificationsReadInput|null>(null),[busy,setBusy]=useState(false);
 const request=useRef<AbortController|null>(null),alive=useRef(true);
 const same=()=>alive.current&&(!controller.getSnapshot||controller.getSnapshot().membership?.user_id===actor);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[controller]);
 useEffect(()=>{const p=new AbortController();request.current?.abort();request.current=p;setError('');void(async()=>{try{
  const raw=await controller.system(notificationsPath(tab),{method:'GET',signal:p.signal});if(p.signal.aborted||!same())return;const v=parseNotifications(raw,{tab});setView(v);onUnread(v.unread);
 }catch(e){if(!p.signal.aborted&&!aborted(e)&&same())setError('Não foi possível carregar as notificações.');}})();return()=>p.abort();},[controller,tab,reload]);
 const mark=async(input:NotificationsReadInput)=>{if(busy)return;setBusy(true);setPending(input);setError('');try{
  const raw=await controller.system(NOTIFICATIONS_READ_PATH,{method:'POST',body:input});if(!same())return;const r=parseNotificationsRead(raw,input);setPending(null);onUnread(r.view.unread);setReload(n=>n+1);
 }catch(e){if(!same()||aborted(e))return;if([400,404,409].includes(statusOf(e)??0)){setPending(null);setReload(n=>n+1);setError('Não foi possível marcar como lida. A lista foi recarregada.');}
  else setError('Não foi possível confirmar se as notificações foram marcadas como lidas.');}finally{if(alive.current)setBusy(false);}};
 const items=view?.items??[];
 return <div className="origin-popover origin-notifications" role="dialog" aria-label="Notificações">
  <header className="origin-notifications-head"><h3>Notificações</h3>
   <button type="button" className="icon-button" aria-label="Mais ações" aria-expanded={menu} onClick={()=>setMenu(!menu)}><Icon name="ellipsis-vertical" size={13}/></button>
   {menu&&<div className="origin-notifications-menu" role="menu"><Link role="menuitem" to={CENTRAL_NOTIFICATIONS} onClick={onNavigate}>Configurar notificações</Link>
    <button type="button" role="menuitem" disabled={busy||!view||view.unread===0} onClick={()=>{setMenu(false);void mark(captureNotificationsRead({command_id:crypto.randomUUID(),ids:null}));}}>Marcar todas como lida</button></div>}</header>
  <div className="origin-popover-tabs" role="tablist">{(['nao_lidas','todas'] as const).map(t=><button type="button" role="tab" key={t} aria-selected={tab===t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t==='nao_lidas'?`Não lidas (${view?.unread??0})`:'Todas'}</button>)}</div>
  {error&&<p className="real-alert" role="alert">{error}{pending&&<button type="button" className="text-button" disabled={busy} onClick={()=>void mark(pending)}>Conferir resultado</button>}</p>}
  {!view&&!error&&<p className="origin-popover-empty" role="status">Carregando notificações…</p>}
  {view&&!items.length&&<p className="origin-popover-empty">No momento não temos notificações!</p>}
  {items.length>0&&<ul className="origin-notification-list">{items.map(n=>{const c=notificationContent(n),expanded=open===n.id;return <li key={n.id} className={n.read?'is-read':undefined}>
   <button type="button" className="origin-notification-item" aria-expanded={expanded} onClick={()=>{setOpen(expanded?'':n.id);if(!n.read&&!expanded)void mark(captureNotificationsRead({command_id:crypto.randomUUID(),ids:[n.id]}));}}>
    <strong>{c.title}</strong><small>{notificationDate(n.created_at)}</small><Icon name={expanded?'chevron-up':'chevron-down'} size={10}/></button>
   {expanded&&<p>{c.text} <Link to={c.to} onClick={onNavigate}>Abrir</Link></p>}</li>;})}</ul>}
 </div>;
}

/** Meu Negócio > Página inicial, painel esquerdo: avatar, nome e e-mail do usuário e o cartão de armazenamento. */
export function HomeProfileCard({controller}:{controller:Port}){
 const snapshot=controller.getSnapshot?.()??null,state=(snapshot??{phase:'ready',membership:null}) as AccessState,chrome=useCompanyChrome(controller,state);
 if(typeof controller.system!=='function'||!chrome.profile)return null;
 const name=chrome.profile.name??chrome.profile.email??'Usuário';
 return <section className="home-profile" aria-label="Meu perfil">
  <div className="home-profile-user"><span className="home-profile-avatar" aria-hidden="true">{initialsOf(name)}</span><div><strong>{name}</strong>{chrome.profile.email&&<small>{chrome.profile.email}</small>}</div></div>
  {chrome.storage&&(()=>{const s=storageSummary(chrome.storage);return <div className={`home-storage${s.warn?' is-warning':''}`}><p><Icon name="database" size={12}/>Armazenamento <strong>{s.label}</strong> {s.percent===null?'usados':`(${s.percent.toLocaleString('pt-BR')}%)`}</p>
   {s.percent!==null?<progress className="home-storage-bar" max={100} value={s.percent} aria-label={`Armazenamento usado: ${s.percent.toLocaleString('pt-BR')}%`}/>:<p className="real-help">Sem limite definido em Espaço e armazenamento. Consulte o administrador sobre a capacidade disponível nesta instalação.</p>}
   <Link to="/empresa-configuracoes?secao=armazenamento">Gerenciar armazenamento</Link></div>;})()}
 </section>;
}

// Sistema > Interface ("Habilita tema escuro", per user): applied once per sign-in of each actor in this page, so the saved
// theme follows the user to any browser. Opening the page without a saved value never flips the browser's theme.
const themeApplied=new Set<string>();
export function useStoredThemeAtLogin(controller:{preferences?:(path:string,options?:{method?:'GET';signal?:AbortSignal})=>Promise<unknown>;getSnapshot?:()=>AccessState}|undefined,state:AccessState){
 const actor=state.phase==='ready'?state.membership?.user_id??null:null;
 useEffect(()=>{if(!actor||typeof controller?.preferences!=='function'||themeApplied.has(actor))return;themeApplied.add(actor);const p=new AbortController();let done=false;
  void controller.preferences(preferencesPagePath('sistema-interface'),{method:'GET',signal:p.signal}).then(raw=>{done=true;if(p.signal.aborted||controller.getSnapshot&&controller.getSnapshot().membership?.user_id!==actor)return;
   const page=parsePreferencesPage(raw,'sistema-interface');if(page.items[0]!.version>0)applyStoredTheme(page.items[0]!.value===true?'dark':'light');}).catch(()=>{done=true;themeApplied.delete(actor);});
  return()=>{p.abort();if(!done)themeApplied.delete(actor);};},[controller,actor]);
}
