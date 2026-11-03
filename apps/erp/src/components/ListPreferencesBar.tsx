import {useEffect,useState} from 'react';
import {Icon} from './Icon';
import {ListColumnsPanel} from './ListColumnsPanel';
import type {ListPreferencesState,ListFilters} from '../hooks/useListPreferences';
import type {NativeRequestOptions} from '../lib/real-access';
import {PROFILE_PATH,parseProfile} from '../lib/system-model';
import './list-preferences.css';

const sameFilters=(a:ListFilters|null,b:ListFilters|null)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());

/**
 * Origin list tools backed by the per-user store (migration 116): "Listagem customizada" (choose and order the columns) and
 * "Tornar padrão" (keep the current filters as this user's default). The list keeps its own filtering; this bar only saves.
 * With `drawer` (PRD-054), "Listagem customizada" opens the Origin drawer "Informações visíveis" (ListColumnsPanel) with the name
 * of the signed-in user, read from Sistema › Meu perfil when the screen gives the `system` port.
 */
export type ListColumnsDrawer={note?:string;system?:((path:string,options?:NativeRequestOptions)=>Promise<unknown>)|undefined};
/** The `system` port of a controller that has one (the real controller does; QA ports may not). */
export const systemPortOf=(controller:unknown)=>{const port=(controller as {system?:unknown}|null)?.system;return typeof port==='function'?port as NonNullable<ListColumnsDrawer['system']>:undefined;};
export default function ListPreferencesBar({prefs,columns,currentFilters,drawer}:{prefs:ListPreferencesState;columns:readonly{id:string;label:string}[];currentFilters:ListFilters;drawer?:ListColumnsDrawer}){
 const [editing,setEditing]=useState<string[]|null>(null),[userName,setUserName]=useState<string|null>(null);
 const open=Boolean(drawer)&&editing!==null,system=drawer?.system;
 useEffect(()=>{setUserName(null);if(!open||!system)return;const p=new AbortController();
  void Promise.resolve().then(()=>system(PROFILE_PATH,{method:'GET',signal:p.signal})).then(raw=>{if(!p.signal.aborted){const v=parseProfile(raw);setUserName(v.name??v.email);}}).catch(()=>{/* The card says "o seu usuário". */});
  return()=>p.abort();},[open,system]);
 const busy=prefs.pending!=='none'||prefs.loading;
 const label=(id:string)=>columns.find(c=>c.id===id)?.label??id;
 const move=(index:number,delta:number)=>setEditing(list=>{if(!list)return list;const next=[...list],target=index+delta;if(target<0||target>=next.length)return list;[next[index],next[target]]=[next[target],next[index]];return next;});
 const toggle=(id:string,on:boolean)=>setEditing(list=>list?on?[...list,id]:list.filter(x=>x!==id):list);
 const hasCurrent=Object.keys(currentFilters).length>0;
 return <div className="list-preferences">
  <button type="button" className="text-button" disabled={busy} onClick={()=>setEditing(editing?null:[...prefs.columns])} aria-expanded={editing!==null}><Icon name="table-columns" size={12}/>Listagem customizada</button>
  <button type="button" className="text-button" disabled={busy||!hasCurrent||sameFilters(currentFilters,prefs.filters)} title={hasCurrent?undefined:'Aplique um filtro para torná-lo padrão.'} onClick={()=>prefs.saveFilters(currentFilters)}><Icon name="star" size={12}/>Tornar padrão</button>
  {prefs.filters&&<button type="button" className="text-button" disabled={busy} onClick={()=>prefs.saveFilters(null)}>Remover filtro padrão</button>}
  {prefs.pending==='saving'&&<span className="real-help" role="status">Salvando a listagem…</span>}
  {prefs.notice&&<span className="real-help" role="status">{prefs.notice}</span>}
  {prefs.error&&<span className="list-preferences-error" role="alert">{prefs.error}</span>}
  {(prefs.pending==='uncertain'||prefs.pending==='missing')&&<span className="list-preferences-recovery"><button type="button" className="secondary-button" onClick={prefs.check}>Conferir resultado</button>{prefs.pending==='missing'&&<button type="button" className="secondary-button" onClick={prefs.resend}>Reenviar o mesmo comando</button>}</span>}
  {open&&<ListColumnsPanel columns={columns} selected={editing!} busy={busy} userName={userName} note={drawer?.note} onCancel={()=>setEditing(null)}
   onReset={prefs.customized?()=>{prefs.saveColumns(null);setEditing(null);}:undefined} onApply={chosen=>{prefs.saveColumns(chosen);setEditing(null);}}/>}
  {editing&&!drawer&&<section className="list-preferences-panel" aria-label="Listagem customizada"><h3>Listagem customizada</h3><p className="real-help">Escolha as colunas e a ordem. Vale só para o seu usuário.</p>
   <ol>{editing.map((id,index)=><li key={id}><label><input type="checkbox" id={`list-column-${id}`} checked onChange={e=>toggle(id,e.target.checked)}/>{label(id)}</label>
    <button type="button" className="icon-button" aria-label={`Mover ${label(id)} para cima`} disabled={index===0} onClick={()=>move(index,-1)}><Icon name="arrow-up" size={10}/></button>
    <button type="button" className="icon-button" aria-label={`Mover ${label(id)} para baixo`} disabled={index===editing.length-1} onClick={()=>move(index,1)}><Icon name="arrow-down" size={10}/></button></li>)}
    {columns.filter(c=>!editing.includes(c.id)).map(c=><li key={c.id} className="is-off"><label><input type="checkbox" id={`list-column-${c.id}`} checked={false} onChange={e=>toggle(c.id,e.target.checked)}/>{c.label}</label></li>)}</ol>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy||editing.length===0} onClick={()=>{prefs.saveColumns(editing);setEditing(null);}}>Salvar</button>
    <button type="button" className="secondary-button" disabled={busy||!prefs.customized} onClick={()=>{prefs.saveColumns(null);setEditing(null);}}>Restaurar listagem padrão</button>
    <button type="button" className="text-button" onClick={()=>setEditing(null)}>Cancelar</button></div></section>}
 </div>;
}
