import {useEffect,useRef,useState} from 'react';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {userControlsPath} from '../lib/access-users-request';
import type {AccessUser,UsersController} from '../lib/access-users-model';
import {USER_TYPES,USER_TYPE_LABELS,WEEKDAYS,WEEKDAY_NAMES,WINDOW_LIMIT,allPermissions,captureControlsSave,parseControls,parseControlsResult,windowValid,
 type AccessWindow,type ControlsSaveInput,type UserControls as Controls,type UserType} from '../../../../packages/erp-domain/src/user-permissions.mjs';
import UserPermissions from './UserPermissions';
import {Icon} from './Icon';

type Draft={user_type:UserType;enabled:boolean;windows:AccessWindow[];custom:boolean;permissions:string[]};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const draftOf=(c:Controls):Draft=>({user_type:c.user_type,enabled:c.schedule.enabled,windows:c.schedule.windows.map(w=>({...w,days:[...w.days]})),custom:c.permissions!==null,permissions:c.permissions?[...c.permissions]:[]});
const same=(a:Draft,b:Draft)=>JSON.stringify({...a,permissions:a.custom?[...a.permissions].sort():[]})===JSON.stringify({...b,permissions:b.custom?[...b.permissions].sort():[]});
const daysText=(days:readonly number[])=>[...days].sort((x,y)=>x-y).map(d=>WEEKDAYS[d]).join(' ');
const failure=(status:number|null)=>status===409?{definitive:true,message:'Os controles deste usuário mudaram desde a consulta ou o comando já existe com outros dados. Nada foi salvo; recarregue e confira.'}
 :status===400?{definitive:true,message:'Nada foi salvo. Confira os horários (Início antes do Fim, ao menos um dia) e as permissões.'}
 :status===403?{definitive:true,message:'Nada foi salvo. Somente administradores alteram os usuários.'}:status===404?{definitive:true,message:'Nada foi salvo. A conta não foi encontrada.'}
 :{definitive:false,message:'Não foi possível confirmar o resultado. Use "Conferir resultado" para enviar o mesmo comando de novo.'};

/**
 * Sistema › Usuários: Tipo de usuário (Normal | Contador), "Restringir horários de acesso" (Início | Fim | D S T Q Q S S, horário de
 * São Paulo) and Permissões, saved by one command with its own version (migration 229). The administrador has every permission
 * and is never blocked by the windows; the windows of a linked seller (Cadastros › Vendedores) also apply and are shown here.
 */
export default function UserControls({controller,user,actor}:{controller:UsersController;user:AccessUser;actor:string|null}){
 const [loaded,setLoaded]=useState<Controls|null>(null),[draft,setDraft]=useState<Draft|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false),[pending,setPending]=useState<ControlsSaveInput|null>(null),[reload,setReload]=useState(0);
 const request=useRef<AbortController|null>(null),alive=useRef(true);
 const dirty=Boolean(loaded&&draft&&!same(draft,draftOf(loaded)));
 useUnsavedChanges(dirty,busy||Boolean(pending));
 const may=()=>{const s=controller.getSnapshot();return alive.current&&s.phase==='ready'&&s.membership?.role==='admin'&&s.membership.user_id===actor;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[controller]);
 useEffect(()=>{const p=new AbortController();request.current?.abort();request.current=p;setError('');void(async()=>{try{
  const raw=await controller.accessUsers(userControlsPath(user.user_id),{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;
  const c=parseControls(raw,user.user_id);setLoaded(c);setDraft(draftOf(c));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may())setError('Não foi possível carregar os horários e as permissões deste usuário.');}
 finally{if(request.current===p)request.current=null;}})();return()=>p.abort();},[controller,user.user_id,reload]);
 const send=async(body:ControlsSaveInput)=>{
  if(!may()||request.current)return;const p=new AbortController();request.current=p;setBusy(true);setError('');setNotice('');
  try{
   const raw=await controller.accessUsers(userControlsPath(user.user_id),{method:'POST',body,signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;
   const r=parseControlsResult(raw,{target:user.user_id,input:body});setPending(null);setLoaded(r.controls);setDraft(draftOf(r.controls));
   setNotice(`Horários e permissões salvos${r.replayed?' (comando já registrado)':''}. Valem na próxima ação do usuário.`);
  }catch(e){if(p.signal.aborted||request.current!==p||aborted(e)||!may())return;const f=failure(e instanceof AccessError?e.status:null);
   if(f.definitive&&!pending){setPending(null);setError(f.message);}else{setPending(body);setError(f.definitive?'O resultado não pôde ser conferido. Tente conferir de novo.':f.message);}}
  finally{if(request.current===p){request.current=null;setBusy(false);}}
 };
 const save=()=>{if(!loaded||!draft||pending||busy)return;
  let body:ControlsSaveInput;try{body=captureControlsSave({command_id:crypto.randomUUID(),expected_version:loaded.version,data:{user_type:draft.user_type,schedule:{enabled:draft.enabled,windows:draft.windows},
   permissions:draft.custom?allPermissions().filter(k=>draft.permissions.includes(k)):null}});}
  catch{setError('Confira os horários: Início antes do Fim, ao menos um dia por horário e ao menos um horário quando a restrição estiver ligada.');return;}
  setPending(body);void send(body);};
 if(!draft||!loaded)return <section className="user-controls" aria-label="Horários e permissões">{error?<p className="real-alert" role="alert">{error}</p>:<p role="status" className="real-help">Carregando horários e permissões…</p>}</section>;
 const isAdmin=loaded.role==='admin',locked=busy||Boolean(pending),set=(patch:Partial<Draft>)=>{if(!locked)setDraft({...draft,...patch});};
 const setWindow=(i:number,patch:Partial<AccessWindow>)=>set({windows:draft.windows.map((w,j)=>j===i?{...w,...patch}:w)});
 const toggleDay=(i:number,d:number)=>{const w=draft.windows[i]!;setWindow(i,{days:w.days.includes(d)?w.days.filter(x=>x!==d):[...w.days,d].sort((a,b)=>a-b)});};
 return <section className="user-controls" aria-label="Horários e permissões">
  <header className="real-editor-heading"><div><h3>Tipo, horários e permissões</h3><p className="real-help">Salvos à parte das informações da conta.</p></div>
   <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={locked||!dirty} onClick={()=>setDraft(draftOf(loaded))}>Cancelar</button>
    <button type="button" className="primary-button" disabled={locked||!dirty} onClick={save}>{busy?'Salvando…':'Salvar'}</button></div></header>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {pending&&!busy&&error&&<p><button type="button" className="primary-button" onClick={()=>void send(pending)}>Conferir resultado</button></p>}
  <fieldset disabled={locked} className="real-users-fields">
   <label className="form-field" htmlFor="controls-type">Tipo de usuário<select id="controls-type" value={draft.user_type} onChange={e=>set({user_type:e.target.value as UserType})}>
    {USER_TYPES.map(t=><option key={t} value={t}>{USER_TYPE_LABELS[t]}</option>)}</select>
    <small className="real-help">Contador: o usuário do escritório de contabilidade (Espaço Meu Contador). O tipo aparece na lista e no filtro de usuários.</small></label>
   <label className="preference-switch" htmlFor="controls-schedule"><input id="controls-schedule" type="checkbox" checked={draft.enabled} disabled={isAdmin}
    onChange={e=>set({enabled:e.target.checked,windows:e.target.checked&&!draft.windows.length?[{start:'08:00',end:'18:00',days:[1,2,3,4,5]}]:draft.windows})}/><span>Restringir horários de acesso</span></label>
   {isAdmin&&<p className="real-help">O administrador tem todas as permissões e nunca é bloqueado por horário.</p>}
   {draft.enabled&&<div className="table-scroll"><table className="data-table controls-windows"><thead><tr><th scope="col">Nº</th><th scope="col">Início</th><th scope="col">Fim</th>
    {WEEKDAYS.map((d,i)=><th scope="col" key={i} title={WEEKDAY_NAMES[i]}>{d}</th>)}<th scope="col"><span className="sr-only">Excluir</span></th></tr></thead>
    <tbody>{draft.windows.map((w,i)=><tr key={i} className={windowValid(w)?undefined:'is-invalid'}><td>{i+1}</td>
     <td><input id={`controls-start-${i}`} type="time" aria-label={`Início do horário ${i+1}`} value={w.start} onChange={e=>setWindow(i,{start:e.target.value})}/></td>
     <td><input id={`controls-end-${i}`} type="time" aria-label={`Fim do horário ${i+1}`} value={w.end} onChange={e=>setWindow(i,{end:e.target.value})}/></td>
     {WEEKDAYS.map((d,day)=><td key={day}><input id={`controls-day-${i}-${day}`} type="checkbox" aria-label={`${WEEKDAY_NAMES[day]} no horário ${i+1}`} checked={w.days.includes(day)} onChange={()=>toggleDay(i,day)}/></td>)}
     <td><button type="button" className="icon-button" aria-label={`Excluir horário ${i+1}`} disabled={draft.windows.length===1} onClick={()=>set({windows:draft.windows.filter((_,j)=>j!==i)})}><Icon name="trash-can" size={12}/></button></td></tr>)}</tbody></table>
    <button type="button" className="secondary-button" disabled={draft.windows.length>=WINDOW_LIMIT} onClick={()=>set({windows:[...draft.windows,{start:'08:00',end:'18:00',days:[1,2,3,4,5]}]})}><Icon name="plus" size={11}/>Adicionar horário</button>
    <p className="real-help">Horário de São Paulo. Fora dos horários, o FAGOO encerra o acesso do usuário na próxima ação.</p></div>}
   {loaded.seller&&<p className="real-help">Vendedor vinculado ({loaded.seller.name}): {loaded.seller.enabled&&loaded.seller.windows.length?`os horários do vendedor também valem (${loaded.seller.windows.map(w=>`${w.start}–${w.end} ${daysText(w.days)}`).join('; ')}).`:'sem horários de acesso no cadastro do vendedor.'}</p>}
   <div className="form-field"><span>Permissões</span>
    <label className="preference-check"><input type="radio" name={`controls-mode-${user.user_id}`} id="controls-mode-profile" checked={!draft.custom} disabled={isAdmin} onChange={()=>set({custom:false})}/><span>Todas as permissões do perfil de acesso</span></label>
    <label className="preference-check"><input type="radio" name={`controls-mode-${user.user_id}`} id="controls-mode-custom" checked={draft.custom} disabled={isAdmin} onChange={()=>set({custom:true,permissions:draft.permissions.length?draft.permissions:allPermissions()})}/><span>Personalizar permissões</span></label>
    <small className="real-help">As permissões só restringem o que o perfil de acesso já permite. As marcadas como Aplicada valem na próxima ação do usuário; as Guardadas ficam para quando o módulo seguir a permissão.</small></div>
  </fieldset>
  {draft.custom&&!isAdmin&&<UserPermissions value={draft.permissions} disabled={locked} onChange={keys=>set({permissions:keys})}/>}
  <p className="real-help"><button type="button" className="text-button" disabled={locked} onClick={()=>setReload(n=>n+1)}>Recarregar</button></p>
 </section>;
}
