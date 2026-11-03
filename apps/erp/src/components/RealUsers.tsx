import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {useListPreferences} from '../hooks/useListPreferences';
import {AppliedChips,OriginActionsPanel,OriginFilterPanel,OriginListHeader,OriginToolbar,ListControls,RowMenu} from './OriginList';
import {BatchDialog} from './BatchDialog';
import ListPreferencesBar from './ListPreferencesBar';
import {Icon} from './Icon';
import type {NativeRequestOptions} from '../lib/real-access';
import {planBatch,type BatchStep} from '../lib/origin-batch';
import {usersListPath,userPath,userInvitePath,userCommandPath} from '../lib/access-users-request';
import {parseUsersList,parseUserResult,parseInvitePending,captureUsersQuery,ACCESS_ROLES,ROLE_TEXT,STATUS_TEXT,FILTER_TEXT,USER_COLUMNS,USER_DEFAULT_COLUMNS,userLabel,moment,statusTone,draftOf,saveBody,inviteBody,saveFailure,inviteFailure,
 type UsersController,type UsersPage,type AccessUser,type AccessRole,type UserFilter,type UserSaveInput,type UserInviteInput,type Draft} from '../lib/access-users-model';
import {UserSecurityModal,SECURITY_TITLES,type SecurityView} from './UserSecurity';
import UserControls from './UserControls';
import {USER_TYPE_LABELS} from '../../../../packages/erp-domain/src/user-permissions.mjs';
import type {UserTypeFilter} from '../../../../packages/erp-domain/src/access-users.mjs';
const TYPE_FILTER_TEXT:Record<UserTypeFilter,string>={todos:'Todos',normal:'Normal',contador:'Contador'};
import type {SystemController} from '../lib/system-model';
import './real-users.css';

const LIST_ID='sistema.usuarios',PAGE=100;
type Attempt={kind:'save'|'invite';body:UserSaveInput|UserInviteInput;target?:string;uncertain:boolean;retryAllowed:boolean};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const admin=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';

/** Sistema > Usuários (Origin usuarios.php): accounts of the company, invite, perfil, situação. Administrador only. */
export default function RealUsers({controller}:{controller:UsersController&Partial<Pick<SystemController,'system'>>&{security?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}}){
 const system=typeof controller.system==='function'?controller as Pick<SystemController,'system'>:null;
 // Leva H (PRF-209): Redefinir segundo fator through /v1/seguranca.
 const securityPort=typeof controller.security==='function'?controller.security:null;
 const [security,setSecurity]=useState<{user:AccessUser;view:SecurityView}|null>(null);
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null);
 const allowed=admin(snapshot)&&snapshot.membership?.user_id===actor.current;
 const prefs=useListPreferences(controller,LIST_ID,{available:USER_COLUMNS.map(c=>c.id),defaults:USER_DEFAULT_COLUMNS});
 const alive=useRef(true),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),applied=useRef(false);
 const [query,setQuery]=useState<{q:string|null;status:UserFilter;type:UserTypeFilter;offset:number}>({q:null,status:'todos',type:'todos',offset:0}),[search,setSearch]=useState(''),[filterOpen,setFilterOpen]=useState(false),[filterDraft,setFilterDraft]=useState<UserFilter>('todos');
 const [typeDraft,setTypeDraft]=useState<UserTypeFilter>('todos'),[controlsFor,setControlsFor]=useState<string|null>(null);
 const [page,setPage]=useState<UsersPage|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
 const [selected,setSelected]=useState<string[]>([]),[menu,setMenu]=useState<string|null>(null),[panel,setPanel]=useState(false),[batch,setBatch]=useState(false);
 const [editing,setEditing]=useState<{user:AccessUser;draft:Draft}|null>(null),[invite,setInvite]=useState<{email:string;name:string;role:AccessRole}|null>(null),[pending,setPending]=useState<'none'|'uncertain'|'missing'|'invite-pending'>('none');
 const dirty=Boolean(editing&&JSON.stringify(editing.draft)!==JSON.stringify(draftOf(editing.user))||invite&&(invite.email||invite.name));
 useUnsavedChanges(dirty,busy||pending!=='none');
 const may=()=>{const s=controller.getSnapshot();return alive.current&&admin(s)&&s.membership?.user_id===actor.current;};
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 const start=()=>{const p=new AbortController();request.current=p;setBusy(true);setError('');return p;};
 const finish=(p:AbortController)=>{if(request.current===p){request.current=null;setBusy(false);}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();attempt.current=null;};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();request.current=null;setBusy(false);setPage(null);if(attempt.current){attempt.current.uncertain=true;attempt.current.retryAllowed=false;setPending(p=>p==='none'?'uncertain':p);}},[allowed]);
 // "Tornar padrão" filters are applied once, when they arrive and the user has not filtered yet.
 useEffect(()=>{if(applied.current||prefs.loading)return;applied.current=true;const f=prefs.filters;if(!f)return;
  const status=typeof f.situacao==='string'&&(['todos','ativo','inativo','sem_acesso'] as string[]).includes(f.situacao)?f.situacao as UserFilter:'todos',q=typeof f.q==='string'?f.q:'';
  const type=typeof f.tipo==='string'&&(['todos','normal','contador'] as string[]).includes(f.tipo)?f.tipo as UserTypeFilter:'todos';
  setSearch(q);setFilterDraft(status);setTypeDraft(type);setQuery({q:q||null,status,type,offset:0});},[prefs.loading,prefs.filters]);
 useEffect(()=>{if(!allowed||!may())return;const p=start();setLoading(true);void(async()=>{try{
  const q=captureUsersQuery({q:query.q,status:query.status,type:query.type,limit:PAGE,offset:query.offset});
  const raw=await controller.accessUsers(usersListPath(q),{method:'GET',signal:p.signal});if(!valid(p))return;
  const next=parseUsersList(raw,q);setPage(next);setSelected(s=>s.filter(id=>next.items.some(u=>u.user_id===id)));
 }catch(e){if(valid(p)&&!aborted(e))setError(e instanceof AccessError&&e.status===403?'Somente administradores consultam os usuários.':'Não foi possível carregar os usuários. Tente novamente.');}
 finally{if(request.current===p)setLoading(false);finish(p);}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,query,reload,allowed]);

 const run=async(a:Attempt,post:boolean)=>{
  if(!may()||request.current||attempt.current!==a||post&&a.uncertain&&!a.retryAllowed&&a.kind==='save')return;
  const p=start();setNotice('');a.retryAllowed=false;let reading=false;
  try{
   const raw=post?await controller.accessUsers(a.kind==='invite'?userInvitePath():userPath(a.target!),{method:'POST',body:a.body,signal:p.signal})
    :(reading=true,await controller.accessUsers(userCommandPath(a.body.command_id),{method:'GET',signal:p.signal}));
   if(!valid(p)||attempt.current!==a)return;
   if(reading&&a.kind==='invite'&&raw&&typeof raw==='object'&&(raw as {scope?:string}).scope==='access_invite'){
    const open=parseInvitePending(raw,{commandId:a.body.command_id,email:(a.body as UserInviteInput).email});setPending('invite-pending');
    setError(open.existing_user_id?'A conta já foi criada pelo convite, mas o acesso ainda não foi liberado. Conclua o mesmo convite.':'O convite ainda não foi concluído. Você pode reenviar o mesmo comando: ele não cria outra conta para o mesmo e-mail.');return;}
   const result=a.kind==='invite'?parseUserResult(raw,{commandId:a.body.command_id,invite:a.body,lookup:reading}):parseUserResult(raw,{commandId:a.body.command_id,target:a.target,input:a.body,lookup:reading});
   attempt.current=null;setPending('none');setEditing(null);setInvite(null);
   setNotice(a.kind==='invite'?`Convite registrado para ${result.user.email}. O acesso à empresa já está liberado com o perfil ${ROLE_TEXT[result.user.role!]}; a pessoa define a senha pelo link recebido.`:`${userLabel(result.user)}: alterações salvas.`);
   setReload(n=>n+1);
  }catch(e){if(valid(p)&&attempt.current===a&&!aborted(e)){
   const status=e instanceof AccessError?e.status:null,failure=a.kind==='invite'?inviteFailure(status):saveFailure(status);
   if(reading&&status===404){a.retryAllowed=true;setPending('missing');setError(a.kind==='invite'?'O convite não foi registrado. Você pode reenviar exatamente o mesmo convite.':'Este comando não foi registrado. Você pode reenviar exatamente as mesmas alterações.');}
   // Auth refusing the invite is authoritative even after an uncertain answer: this command left no account behind.
   else if(post&&failure.definitive&&(!a.uncertain||a.kind==='invite'&&status===422)){attempt.current=null;setPending('none');setError(failure.message);}
   else{a.uncertain=true;setPending('uncertain');setError(failure.definitive&&reading?'O resultado não pôde ser conferido com o seu acesso atual. Tente conferir de novo.':(a.kind==='invite'?inviteFailure(null):saveFailure(null)).message);}
  }}finally{finish(p);}
 };
 const saveEditor=()=>{if(!editing||!may()||request.current||attempt.current)return;const r=saveBody(editing.user,editing.draft,crypto.randomUUID());if(!r.body){setError(r.problem!);return;}
  const a:Attempt={kind:'save',body:r.body,target:editing.user.user_id,uncertain:false,retryAllowed:false};attempt.current=a;void run(a,true);};
 const sendInvite=()=>{if(!invite||!may()||request.current||attempt.current)return;const r=inviteBody(invite.email,invite.name,invite.role,crypto.randomUUID());if(!r.body){setError(r.problem!);return;}
  const a:Attempt={kind:'invite',body:r.body,uncertain:false,retryAllowed:false};attempt.current=a;void run(a,true);};
 const resendInvite=()=>{const a=attempt.current;if(!a||a.kind!=='invite')return;a.retryAllowed=true;void run(a,true);};
 const deactivate=async(user:AccessUser):Promise<BatchStep>=>{
  const r=saveBody(user,{...draftOf(user),name:user.name??user.email??'Usuário',active:false},crypto.randomUUID());if(!r.body)throw new Error(r.problem);
  try{const raw=await controller.accessUsers(userPath(user.user_id),{method:'POST',body:r.body});parseUserResult(raw,{commandId:r.body.command_id,target:user.user_id,input:r.body});}
  catch(e){const status=e instanceof AccessError?e.status:null;const f=saveFailure(status);if(f.definitive)throw new Error(f.message);return{uncertain:true,message:`Comando ${r.body.command_id}: confira o usuário antes de repetir.`};}
 };
 const items=page?.items??[],me=actor.current;
 const toggle=(id:string)=>setSelected(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
 const openEditor=(u:AccessUser,patch:Partial<Draft>={})=>{if(attempt.current||busy)return;setInvite(null);setNotice('');setError('');setEditing({user:u,draft:{...draftOf(u),...patch}});};
 const plan=planBatch(items.filter(u=>selected.includes(u.user_id)).map(u=>({...u,id:u.user_id,label:userLabel(u)})),u=>u.user_id===me?'Você não pode desativar o próprio usuário.':u.status!=='ativo'?'O usuário já está sem acesso ativo.':null);
 const cell=(u:AccessUser,column:string)=>{switch(column){
  case'nome':return <strong>{u.name??<em className="muted">Nome não informado</em>}</strong>;
  case'login':return u.email??'—';case'tipo':return USER_TYPE_LABELS[(u as AccessUser&{user_type?:'normal'|'contador'}).user_type??'normal'];case'perfil':return u.role?ROLE_TEXT[u.role]:'—';
  case'situacao':return <span className={`status-badge ${statusTone(u)}`}>{STATUS_TEXT[u.status]}</span>;
  // Leva H (PRF-208): aplicativo autenticador confirmado no Supabase Auth.
  case'mfa':{const mfa=(u as AccessUser&{mfa?:boolean}).mfa;return mfa===undefined?'—':<span className={`status-badge ${mfa?'status-success':'status-neutral'}`} title={mfa?'Aplicativo autenticador cadastrado':'Sem aplicativo autenticador'}><Icon name="shield-halved" size={10}/> {mfa?'Ativo':'Inativo'}</span>;}
  default:return moment(u.last_sign_in_at);}};
 const chips=[...(query.q?[{label:`Pesquisa: ${query.q}`,onRemove:()=>{setSearch('');setQuery(q=>({...q,q:null,offset:0}));}}]:[]),
  ...(query.status!=='todos'?[{label:`Situação: ${FILTER_TEXT[query.status]}`,onRemove:()=>{setFilterDraft('todos');setQuery(q=>({...q,status:'todos',offset:0}));}}]:[]),
  ...(query.type!=='todos'?[{label:`Tipo de usuário: ${TYPE_FILTER_TEXT[query.type]}`,onRemove:()=>{setTypeDraft('todos');setQuery(q=>({...q,type:'todos',offset:0}));}}]:[])];
 if(!allowed)return <section className="real-state-panel"><h1>Usuários não liberados</h1><p>Somente administradores consultam e alteram os usuários da empresa.{attempt.current?' A confirmação pendente fica preservada até o acesso de administrador voltar.':''}</p></section>;
 return <div className="real-users">
  <OriginListHeader title="Usuários" primary={<button type="button" className="primary-button" disabled={busy||pending!=='none'} onClick={()=>{setEditing(null);setNotice('');setError('');setInvite({email:'',name:'',role:'consulta'});}}><Icon name="plus" size={12}/>Incluir usuário</button>}/>
  <div className={`origin-list-workspace${panel?' actions-collapsed':''}`}><div className="real-users-main">
   <OriginToolbar filterOpen={filterOpen} onToggleFilter={()=>setFilterOpen(!filterOpen)} searchValue={search} searchPlaceholder="Pesquisar por nome ou login" onSearchChange={setSearch} onSearch={()=>setQuery(q=>({...q,q:search.trim()||null,offset:0}))}
    tools={<button type="button" className="origin-tool-square" title="Excluir os usuários selecionados" aria-label="Excluir os usuários selecionados" disabled={!selected.length||busy||pending!=='none'} onClick={()=>setBatch(true)}><Icon name="trash-can" size={14}/></button>}/>
   <OriginFilterPanel open={filterOpen} onClose={()=>setFilterOpen(false)} onApply={()=>{setQuery(q=>({...q,status:filterDraft,type:typeDraft,offset:0}));setFilterOpen(false);}}>
    <label className="form-field">Tipo de usuário<select id="users-type" value={typeDraft} onChange={e=>setTypeDraft(e.target.value as UserTypeFilter)}>{(Object.keys(TYPE_FILTER_TEXT) as UserTypeFilter[]).map(t=><option key={t} value={t}>{TYPE_FILTER_TEXT[t]}</option>)}</select></label>
    <label className="form-field">Situação<select id="users-status" value={filterDraft} onChange={e=>setFilterDraft(e.target.value as UserFilter)}>{(Object.keys(FILTER_TEXT) as UserFilter[]).map(s=><option key={s} value={s}>{FILTER_TEXT[s]}</option>)}</select></label>
   </OriginFilterPanel>
   <AppliedChips chips={chips} onClear={()=>{setSearch('');setFilterDraft('todos');setTypeDraft('todos');setQuery({q:null,status:'todos',type:'todos',offset:0});}}/>
   <ListPreferencesBar prefs={prefs} columns={USER_COLUMNS} currentFilters={{...(query.q?{q:query.q}:{}),...(query.status!=='todos'?{situacao:query.status}:{}),...(query.type!=='todos'?{tipo:query.type}:{})}}/>
   <ListControls checked={items.length>0&&items.every(u=>selected.includes(u.user_id))} indeterminate={selected.length>0&&!items.every(u=>selected.includes(u.user_id))} onToggleAll={()=>setSelected(items.every(u=>selected.includes(u.user_id))?[]:items.map(u=>u.user_id))} onRefresh={()=>setReload(n=>n+1)}/>
   {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
   {pending!=='none'&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: confira o resultado antes de editar de novo. Sair da tela não desfaz uma gravação já realizada.</p>
    <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void run(attempt.current!,false)}>Conferir resultado</button>
     {pending==='missing'&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(attempt.current!,true)}>Reenviar o mesmo comando</button>}
     {pending==='invite-pending'&&<button type="button" className="secondary-button" disabled={busy} onClick={resendInvite}>Concluir o mesmo convite</button>}</div></section>}
   <div className="table-scroll" role="region" aria-label="Usuários" tabIndex={0} aria-busy={loading}><table className="data-table real-users-table"><thead><tr><th scope="col"><span className="sr-only">Seleção</span></th>{prefs.columns.map(c=><th scope="col" key={c}>{USER_COLUMNS.find(x=>x.id===c)?.label}</th>)}<th scope="col"><span className="sr-only">Ações</span></th></tr></thead>
    <tbody>{items.map(u=><tr key={u.user_id} className={editing?.user.user_id===u.user_id?'is-selected':undefined}><td><input type="checkbox" aria-label={`Selecionar ${userLabel(u)}`} checked={selected.includes(u.user_id)} onChange={()=>toggle(u.user_id)}/></td>
     {prefs.columns.map(c=><td key={c} onClick={()=>openEditor(u)}>{cell(u,c)}</td>)}
     <td><RowMenu label={userLabel(u)} open={menu===u.user_id} onToggle={()=>setMenu(menu===u.user_id?null:u.user_id)} items={[{label:'Editar',icon:'pen-to-square',onClick:()=>openEditor(u)},
      {label:u.status==='ativo'?'Desativar':'Liberar acesso',icon:u.status==='ativo'?'ban':'check',disabled:u.user_id===me,title:u.user_id===me?'Você não pode desativar o próprio usuário.':undefined,onClick:()=>openEditor(u,{active:u.status!=='ativo'})},
      ...(system?(['historico','dispositivos','seguranca'] as SecurityView[]).map(view=>({label:SECURITY_TITLES[view],icon:view==='dispositivos'?'desktop':'shield-halved',onClick:()=>{setMenu(null);setSecurity({user:u,view});}})):[])]}/></td></tr>)}</tbody></table></div>
   {page&&!items.length&&<div className="empty-state"><h2>Nenhum usuário encontrado</h2><p>Ajuste a pesquisa ou os filtros.</p></div>}
   {page&&<p className="real-help">{page.total.toLocaleString('pt-BR')} usuário(s){page.has_more?` · mostrando ${page.offset+1} a ${page.offset+items.length}`:''}.{page.has_more&&<button type="button" className="text-button" onClick={()=>setQuery(q=>({...q,offset:q.offset+PAGE}))}>Próxima página</button>}{page.offset>0&&<button type="button" className="text-button" onClick={()=>setQuery(q=>({...q,offset:Math.max(0,q.offset-PAGE)}))}>Página anterior</button>}</p>}
   {invite&&<section className="real-editor real-users-editor" aria-label="Incluir usuário"><header className="real-editor-heading"><div><h2>Incluir usuário</h2><p>O convite chega por e-mail; a pessoa define a própria senha em Ativar acesso. O perfil escolhido vale assim que ela entrar.</p></div>
     <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy||pending!=='none'} onClick={()=>setInvite(null)}>Cancelar</button><button type="button" className="primary-button" disabled={busy||pending!=='none'} onClick={sendInvite}>Salvar</button></div></header>
    <fieldset disabled={busy||pending!=='none'} className="real-users-fields"><legend className="sr-only">Informações da conta</legend>
     <label className="form-field" htmlFor="invite-name">Nome *<input id="invite-name" maxLength={120} value={invite.name} onChange={e=>setInvite({...invite,name:e.target.value})}/></label>
     <label className="form-field" htmlFor="invite-email">E-mail *<input id="invite-email" type="email" maxLength={254} value={invite.email} onChange={e=>setInvite({...invite,email:e.target.value})}/><small className="real-help">O e-mail é o login da conta.</small></label>
     <label className="form-field" htmlFor="invite-role">Perfil de acesso *<select id="invite-role" value={invite.role} onChange={e=>setInvite({...invite,role:e.target.value as AccessRole})}>{ACCESS_ROLES.map(r=><option key={r} value={r}>{ROLE_TEXT[r]}</option>)}</select></label>
    </fieldset><p className="real-help">(*) Campos obrigatórios</p></section>}
   {editing&&<section className="real-editor real-users-editor" aria-label={`Usuário ${userLabel(editing.user)}`}><header className="real-editor-heading"><div><h2>{userLabel(editing.user)}</h2><p>{STATUS_TEXT[editing.user.status]} · último acesso {moment(editing.user.last_sign_in_at)}</p></div>
     <div className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy||pending!=='none'} onClick={()=>setEditing(null)}>Cancelar</button><button type="button" className="primary-button" disabled={busy||pending!=='none'||!dirty} onClick={saveEditor}>Salvar</button></div></header>
    <p className="real-notice">Ao alterar o perfil ou a situação, a mudança vale na próxima ação do usuário, sem precisar sair da conta.</p>
    <fieldset disabled={busy||pending!=='none'} className="real-users-fields"><legend className="sr-only">Informações da conta</legend>
     <label className="form-field" htmlFor="user-name">Nome *<input id="user-name" maxLength={120} value={editing.draft.name} onChange={e=>setEditing({...editing,draft:{...editing.draft,name:e.target.value}})}/></label>
     <label className="form-field" htmlFor="user-login">Login<input id="user-login" value={editing.user.email??''} readOnly aria-describedby="user-login-help"/><small id="user-login-help" className="real-help">O login é o e-mail da conta. Para trocar o e-mail, a pessoa confirma o novo endereço pelo serviço de autenticação desta instalação.</small></label>
     <label className="form-field" htmlFor="user-phone">Celular<input id="user-phone" inputMode="tel" maxLength={20} value={editing.draft.phone} onChange={e=>setEditing({...editing,draft:{...editing.draft,phone:e.target.value}})}/></label>
     <label className="form-field" htmlFor="user-role">Perfil de acesso *<select id="user-role" value={editing.draft.role} disabled={editing.user.user_id===me} onChange={e=>setEditing({...editing,draft:{...editing.draft,role:e.target.value as AccessRole}})}>{ACCESS_ROLES.map(r=><option key={r} value={r}>{ROLE_TEXT[r]}</option>)}</select>
      {editing.user.user_id===me&&<small className="real-help">Você não pode alterar o próprio perfil de administrador.</small>}</label>
     <label className="preference-switch" htmlFor="user-active"><input id="user-active" type="checkbox" role="switch" checked={editing.draft.active} disabled={editing.user.user_id===me} onChange={e=>setEditing({...editing,draft:{...editing.draft,active:e.target.checked}})}/><span>Acesso à empresa ativo</span></label>
     <div className="form-field"><span>Usuário vendedor (acesso restrito)</span><select disabled aria-describedby="user-seller-help"><option>Não</option></select><small id="user-seller-help" className="real-help">Indisponível: o vínculo do usuário a um vendedor e a restrição aos contatos desse vendedor dependem de decisão do dono sobre os vendedores no FAGOO.</small></div>
    </fieldset>
    {editing.user.status==='sem_acesso'?<p className="real-help">Libere o acesso à empresa para definir o tipo, os horários e as permissões deste usuário.</p>
     :controlsFor===editing.user.user_id?<UserControls key={editing.user.user_id} controller={controller} user={editing.user} actor={me}/>
     :<p><button type="button" className="secondary-button" onClick={()=>setControlsFor(editing.user.user_id)}><Icon name="shield-halved" size={12}/>Tipo, horários e permissões</button>
      <small className="real-help"> Tipo de usuário, Restringir horários de acesso e Permissões, salvos à parte.</small></p>}</section>}
  </div>
  <OriginActionsPanel collapsed={panel} onCollapse={()=>setPanel(!panel)} info={[{label:'Quantidade de usuários',value:String(page?.total??0)},...(page?[{label:'Ativos',value:String(page.counts.ativo)},{label:'Inativos',value:String(page.counts.inativo)},{label:'Sem acesso à empresa',value:String(page.counts.sem_acesso)}]:[])]}
   support={[{label:'Preferências › Sistema',to:'/preferencias/sistema'}]}/>
  </div>
  {security&&system&&<UserSecurityModal controller={system} reset={security.user.user_id!==me?securityPort:null} userId={security.user.user_id} label={userLabel(security.user)} view={security.view} onClose={()=>setSecurity(null)}/>}
  {batch&&<BatchDialog title="Excluir os usuários selecionados" description={<p>No FAGOO, excluir um usuário desativa o acesso dele à empresa; a conta continua registrada para manter o histórico e a auditoria.</p>} plan={plan} confirmLabel="Desativar acesso"
   run={item=>deactivate(item)} onClose={results=>{setBatch(false);if(results){setSelected([]);setReload(n=>n+1);}}}/>}
 </div>;
}
