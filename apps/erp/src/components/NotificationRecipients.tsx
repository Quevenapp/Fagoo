import {useState} from 'react';
import {fieldId,ROLE_NAMES,type Draft,type PreferenceField,type PreferenceInfo,type PreferencePageSchema,type PreferencesPageView} from '../lib/preferences-model';
import {Icon} from './Icon';

type Directory=NonNullable<PreferencesPageView['directory']>;
// Origin order of the rows in scope (central.notificacoes.php lists them alphabetically); the lot notification has recipients since 283.
export const NOTIFICATION_CENTER_ORDER=['cliente_visitado','contas_pagar_atrasadas','contas_receber_atrasadas','estoque_abaixo_minimo','estoque_maximo','estoque_zerado',
 'lote_vencimento','pagamento_efetuado','pagamento_recebido','validade','proximo_contato',
 // Brufap notice beside the Origin types.
 'certificado_a1'] as const;
const userLabel=(user:Directory[number])=>user.label??`Usuário ${user.user_id.slice(0,8)}`;

/** Origin Central de Notificações (central.notificacoes.php): a table "Notificação | Destinatários | Editar". Editar turns the
 * Destinatários cell into an "Adicionar Usuário" autocomplete with the active users and removable names; the page's Salvar
 * records every change by one command (CAS by key), as the other Preferências pages. */
export default function NotificationRecipients({page,draft,set,editable,directory}:{page:PreferencePageSchema;draft:Draft;set:(key:string,value:unknown)=>void;editable:boolean;directory:Directory|null}){
 const [editing,setEditing]=useState<string|null>(null),[typed,setTyped]=useState('');
 const entry=(type:string)=>page.fields.find(f=>f.info?f.id===`notificacoes.${type}`:f.key===`notificacoes.${type}`);
 const rows=NOTIFICATION_CENTER_ORDER.map(entry).filter((e):e is PreferenceField|PreferenceInfo=>Boolean(e));
 const note=(rows.find(r=>!r.info) as PreferenceField|undefined)?.note;
 const nameOf=(id:string)=>{const user=directory?.find(u=>u.user_id===id);return user?userLabel(user):null;};
 return <div className="notification-center">
  <div className="table-scroll" role="region" aria-label="Central de Notificações" tabIndex={0}><table className="data-table notification-center-table">
   <thead><tr><th scope="col">Notificação</th><th scope="col">Destinatários</th><th scope="col">Editar</th></tr></thead>
   <tbody>{rows.map(row=>{
    if(row.info)return <tr key={row.id} className="is-unavailable"><td>{row.label}</td><td><span className="status-badge status-neutral">Indisponível</span> <small>{row.text}</small></td><td aria-label="Sem edição">—</td></tr>;
    const list=Array.isArray(draft[row.key])?draft[row.key] as string[]:[],names=list.map(nameOf),known=names.filter((n):n is string=>Boolean(n)),stale=list.length-known.length;
    const open=editing===row.key&&editable&&directory!==null,inputId=fieldId(row.key,'add'),available=(directory??[]).filter(u=>!list.includes(u.user_id));
    const add=(text:string)=>{setTyped(text);const user=available.find(u=>userLabel(u)===text||`${userLabel(u)} · ${ROLE_NAMES[u.role]}`===text);if(user){set(row.key,[...list,user.user_id].sort());setTyped('');}};
    return <tr key={row.key}><td>{row.label}{row.hint&&<small className="notification-center-hint">{row.hint}</small>}</td>
     <td>{open?<div className="notification-recipients-edit">
       <ul className="notification-recipients-chips">{list.map(id=><li key={id}>{nameOf(id)??'Usuário inativo'}<button type="button" className="icon-button" aria-label={`Remover ${nameOf(id)??'usuário inativo'}`} disabled={!editable} onClick={()=>set(row.key,list.filter(v=>v!==id))}><Icon name="xmark" size={10}/></button></li>)}</ul>
       <label className="sr-only" htmlFor={inputId}>Adicionar Usuário em {row.label}</label>
       <input id={inputId} list={`${inputId}-options`} placeholder="Adicionar Usuário" autoComplete="off" maxLength={200} value={typed} disabled={!editable||available.length===0} onChange={e=>add(e.target.value)}/>
       <datalist id={`${inputId}-options`}>{available.map(u=><option key={u.user_id} value={`${userLabel(u)} · ${ROLE_NAMES[u.role]}`}/>)}</datalist>
       {available.length===0&&<small className="real-help">Todos os usuários ativos já recebem esta notificação.</small>}
       {stale>0&&<small className="preference-note">{stale} usuário(s) marcado(s) não estão mais ativos. <button type="button" className="text-button" disabled={!editable} onClick={()=>set(row.key,list.filter(v=>nameOf(v)!==null))}>Desmarcar usuários inativos</button></small>}
      </div>
      :list.length?<span>{known.join(', ')}{stale>0?`${known.length?', ':''}${stale} inativo(s)`:''} <span className="notification-recipients-count">({list.length})</span></span>
      :<span className="real-help">Administradores (padrão)</span>}</td>
     <td>{editable&&directory!==null?<button type="button" className="icon-button" aria-label={open?`Concluir edição de ${row.label}`:`Editar destinatários de ${row.label}`} title={open?'Concluir':'Editar'} aria-pressed={open}
       onClick={()=>{setTyped('');setEditing(open?null:row.key);}}><Icon name={open?'check':'pen-to-square'} size={12}/></button>:<span aria-label="Sem edição">—</span>}</td></tr>;})}
   </tbody></table></div>
  {note&&<p className="preference-note">{note}</p>}
 </div>;
}
