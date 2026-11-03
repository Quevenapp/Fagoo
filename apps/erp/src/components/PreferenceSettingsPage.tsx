import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {AccessError,type AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {applyStoredTheme} from '../hooks/useTheme';
import {Icon} from './Icon';
import FiscalNumberingSummary from './FiscalNumberingSummary';
import NotificationRecipients from './NotificationRecipients';
import {preferencesPagePath,preferencesCommandPath} from '../lib/preferences-request';
import {parseStockPolicy} from '../../../../packages/erp-domain/src/stock-opening-dto.mjs';
import {parsePreferencesPage,parsePreferencesResult,draftOf,draftState,visible,sectionEntries,choiceOptions,integerOptions,invalidText,readError,saveFailure,saveNotice,moment,fieldId,
 keymapOptions,formatDocument,policyText,normalizedValue,NOT_APPLIED,ROLE_NAMES,type PreferencesController,type PreferencesPageView,type PreferencesSaveInput,type PreferencePageSchema,type PreferenceField,
 type PreferenceInfo,type Draft,type PreferenceDocument} from '../lib/preferences-model';
import './preferences-page.css';

type Attempt={body:PreferencesSaveInput;uncertain:boolean;retryAllowed:boolean};
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const readable=(s:AccessState,page:PreferencePageSchema)=>s.phase==='ready'&&Boolean(s.membership&&page.readRoles.includes(s.membership.role));

function Status({field}:{field:PreferenceField}){
 if(field.status==='applied')return field.note?<small className="preference-note">{field.note}</small>:null;
 return <small className="preference-note"><span className="status-badge status-neutral">Ainda não aplicada</span> {field.note??NOT_APPLIED}</small>;
}
function Hint({text}:{text?:string}){return text?<span className="preference-hint" title={text}><Icon name="circle-info" size={11}/><span className="sr-only">{text}</span></span>:null;}

/** Origin Preferências page: subsections on the left (when the page has them), fields on the right, Salvar and Voltar.
 * `embedded` renders the same page inside a modal (Origin "Configurações Meu negócio"): no trail, Salvar and Cancelar, and
 * `onClose` after Cancelar or after a confirmed save. */
export default function PreferenceSettingsPage({controller,page,section,categoryLabel,categoryTo,homeTo='/acesso',embedded=false,onClose}:{controller:PreferencesController;page:PreferencePageSchema;section?:string;categoryLabel:string;categoryTo:string;homeTo?:string;embedded?:boolean;onClose?:()=>void}){
 const navigate=useNavigate();
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null);
 const allowed=readable(snapshot,page)&&snapshot.membership?.user_id===actor.current;
 const stored=page.storedKeys.length>0,policySource=page.fields.some(f=>f.info&&f.source==='stock_negative_policy');
 const alive=useRef(true),request=useRef<AbortController|null>(null),meta=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null);
 const [view,setView]=useState<PreferencesPageView|null>(null),[draft,setDraft]=useState<Draft>({}),[loading,setLoading]=useState(stored),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false),[pending,setPending]=useState<'none'|'uncertain'|'missing'>('none'),[reload,setReload]=useState(0),[policy,setPolicy]=useState<boolean|null>(null),[discard,setDiscard]=useState(false);
 const current=page.sections.some(s=>s.id===section)?section!:page.sections[0].id;
 const state=view?draftState(page,view,draft):{changes:[],invalid:[],dirty:false};
 const guard=useUnsavedChanges(state.dirty,busy||pending!=='none');
 const may=()=>{const s=controller.getSnapshot();return alive.current&&readable(s,page)&&s.membership?.user_id===actor.current;};
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 const start=()=>{const p=new AbortController();request.current=p;setBusy(true);setError('');return p;};
 const finish=(p:AbortController)=>{if(request.current===p){request.current=null;setBusy(false);}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();meta.current?.abort();attempt.current=null;};},[controller]);
 // A role that no longer reads the page cancels reads; a captured command of the same actor is kept for "Conferir resultado".
 useEffect(()=>{if(allowed)return;request.current?.abort();request.current=null;meta.current?.abort();meta.current=null;setBusy(false);if(attempt.current){attempt.current.uncertain=true;attempt.current.retryAllowed=false;setPending('uncertain');}},[allowed]);
 useEffect(()=>{if(!stored||!may())return;const p=start();setLoading(true);void(async()=>{try{
  const raw=await controller.preferences(preferencesPagePath(page.id),{method:'GET',signal:p.signal});if(!valid(p))return;
  const next=parsePreferencesPage(raw,page.id);setView(next);setDraft(draftOf(next));setDiscard(false);
  // Only a value the user saved replaces this browser's theme; merely opening the page never flips it.
  if(page.id==='sistema-interface'&&next.items[0].version>0)applyStoredTheme(next.items[0].value===true?'dark':'light');
 }catch(e){if(valid(p)&&!aborted(e))setError(readError(e instanceof AccessError?e.status:null));}finally{if(request.current===p)setLoading(false);finish(p);}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,page.id,reload,allowed]);
 useEffect(()=>{if(!policySource||!controller.stockOpening||!may())return;meta.current?.abort();const p=new AbortController();meta.current=p;void(async()=>{try{
  const raw=await controller.stockOpening!('/v1/politica-estoque',{method:'GET',signal:p.signal});if(may()&&!p.signal.aborted&&meta.current===p)setPolicy(parseStockPolicy(raw).policy.allow_negative);
 }catch{/* The policy stays "não consultada"; the field still links to its own screen. */}finally{if(meta.current===p)meta.current=null;}})();return()=>p.abort();},[controller,policySource,reload,allowed]);

 const run=async(a:Attempt,post:boolean)=>{
  if(!may()||request.current||attempt.current!==a||post&&a.uncertain&&!a.retryAllowed)return;
  const p=start();setNotice('');a.retryAllowed=false;let reading=false;
  try{
   const raw=post?await controller.preferences(preferencesPagePath(page.id),{method:'POST',body:a.body,signal:p.signal})
    :(reading=true,await controller.preferences(preferencesCommandPath(a.body.command_id),{method:'GET',signal:p.signal}));
   if(!valid(p)||attempt.current!==a)return;
   const result=post?parsePreferencesResult(raw,{commandId:a.body.command_id,pageId:page.id,input:a.body}):parsePreferencesResult(raw,{commandId:a.body.command_id,pageId:page.id,input:a.body,lookup:true});
   attempt.current=null;setPending('none');setView(result.page);setDraft(draftOf(result.page));setNotice(saveNotice(result));
   if(page.id==='sistema-interface')applyStoredTheme(result.page.items[0].value===true?'dark':'light');
   if(embedded)onClose?.();
  }catch(e){if(valid(p)&&attempt.current===a&&!aborted(e)){
   if(reading&&e instanceof AccessError&&e.status===404){a.retryAllowed=true;setPending('missing');setError('Este comando não foi registrado. Você pode reenviar exatamente as mesmas alterações.');}
   else{const failure=saveFailure(e instanceof AccessError?e.status:null,page.scope==='user');
    if(post&&!a.uncertain&&failure.definitive){attempt.current=null;setPending('none');setError(failure.message);}
    else{a.uncertain=true;setPending('uncertain');setError(reading&&failure.definitive?'O resultado não pôde ser conferido com o seu acesso atual. Tente conferir de novo.':saveFailure(null,false).message);}}
  }}finally{finish(p);}
 };
 const save=()=>{if(!view||!view.can_manage||!may()||request.current||attempt.current||!state.changes.length||state.invalid.length)return;
  const a:Attempt={body:{command_id:crypto.randomUUID(),changes:state.changes},uncertain:false,retryAllowed:false};attempt.current=a;void run(a,true);};
 const go=(id:string)=>guard.store.runConfirmed(()=>navigate(`/preferencias/${page.category}/${page.path}/${id}`));
 const set=(key:string,value:unknown)=>{if(busy||pending!=='none'||!view?.can_manage)return;setNotice('');setDraft(d=>({...d,[key]:value as Draft[string]}));};
 const index=page.sections.findIndex(s=>s.id===current);
 const shown=page.subsections?page.sections.filter(s=>s.id===current):page.sections;
 const editable=Boolean(view?.can_manage)&&!busy&&pending==='none';
 const directory=view?.directory??[];

 const renderInfo=(entry:PreferenceInfo)=>{
  const role=snapshot.membership?.role;const link=entry.link&&(!entry.link.roles||role&&entry.link.roles.includes(role))?entry.link:null;
  return <div className={`preference-field preference-info${entry.status==='unavailable'?' is-unavailable':''}`} key={entry.id}>
   <span className="preference-label">{entry.label}</span>
   <div>{entry.source==='stock_negative_policy'&&<p className="preference-value"><strong>{policy===null?'Situação ainda não consultada.':policyText(policy)}</strong></p>}
    {(entry.source==='fiscal_numbering_55'||entry.source==='fiscal_numbering_65')&&controller.fiscalNumbering&&<FiscalNumberingSummary read={controller.fiscalNumbering} model={entry.source==='fiscal_numbering_55'?'55':'65'}/>}
    <p className="preference-note">{entry.status==='unavailable'&&<span className="status-badge status-neutral">Indisponível</span>} {entry.text}</p>
    {link&&<Link to={link.to} className="text-button">{link.label}<Icon name="chevron-right" size={9}/></Link>}</div>
  </div>;
 };
 const renderField=(field:PreferenceField)=>{
  const id=fieldId(field.key),raw=draft[field.key],bad=state.invalid.includes(field.key);
  const label=<label htmlFor={id} className="preference-label">{field.label}<Hint text={field.hint}/></label>;
  let control;
  switch(field.kind){
   case'toggle':return <div className="preference-field preference-toggle" key={field.key}><label className="preference-switch" htmlFor={id}><input id={id} type="checkbox" role="switch" checked={raw===true} disabled={!editable} onChange={e=>set(field.key,e.target.checked)}/><span>{field.label}</span>{field.widget==='legend'&&<em>{raw===true?'Ativado':'Desativado'}</em>}<Hint text={field.hint}/></label><Status field={field}/></div>;
   case'choice':control=field.widget==='radio'?<div className="preference-radios" role="radiogroup" aria-label={field.label}>{choiceOptions(field).map(([value,text])=><label key={value}><input type="radio" id={fieldId(field.key,value)} name={id} checked={raw===value} disabled={!editable} onChange={()=>set(field.key,value)}/>{text}</label>)}</div>
    :<select id={id} value={String(raw)} disabled={!editable} onChange={e=>set(field.key,e.target.value)}>{choiceOptions(field).map(([value,text])=><option key={value} value={value}>{text}</option>)}</select>;break;
   case'multi':{const list=Array.isArray(raw)?raw as string[]:[];const options=choiceOptions(field);
    // 299: the custom situações of the kind come after the default options (Sistema › Gerenciador de transições).
    if(field.situations){const sit=field.situations,custom=(view?.situations??[]).filter(s=>s.kind===sit.kind),base=options.map(o=>o[0]).filter(v=>list.includes(v));
     const ids=list.filter(v=>!options.some(o=>o[0]===v)),unknown=ids.filter(id=>!custom.some(s=>s.id===id));
     const coveredBy=(status:string)=>options.find(([value])=>sit.bases[value]===status&&list.includes(value));
     // Choosing a default option drops the custom ones based on it (already considered by it).
     const choose=(value:string,on:boolean)=>{const nextBase=options.map(o=>o[0]).filter(v=>v===value?on:list.includes(v));
      const covered=new Set(nextBase.map(v=>sit.bases[v]).filter(Boolean));set(field.key,[...nextBase,...ids.filter(id=>!covered.has(custom.find(s=>s.id===id)?.base_status??''))]);};
     const pick=(id:string,on:boolean)=>set(field.key,[...base,...[...ids.filter(v=>v!==id),...(on?[id]:[])].sort()]);
     control=<div><div className="preference-chips" role="group" aria-label={field.label}>{options.map(([value,text])=><label key={value} className={list.includes(value)?'is-on':undefined}><input type="checkbox" id={fieldId(field.key,value)} checked={list.includes(value)} disabled={!editable||!list.includes(value)&&base.length>=(field.maxItems??options.length)} onChange={e=>choose(value,e.target.checked)}/>{text}</label>)}</div>
      {(custom.length>0||unknown.length>0)&&<><p className="preference-note">Situações personalizadas</p><div className="preference-chips" role="group" aria-label={`${field.label}: situações personalizadas`}>
       {custom.filter(s=>s.active||list.includes(s.id)).map(s=>{const by=coveredBy(s.base_status),on=list.includes(s.id)||Boolean(by);
        return <label key={s.id} className={on?'is-on':undefined} title={by?`Já considerada pela situação ${by[1]}.`:s.active?`Baseada em ${s.base_label}.`:'Situação inativa no Gerenciador de transições: pode ser desmarcada.'}>
         <input type="checkbox" id={fieldId(field.key,s.id)} checked={on} disabled={!editable||Boolean(by)||!s.active&&!list.includes(s.id)} onChange={e=>pick(s.id,e.target.checked)}/>
         <span className="preference-situation-dot" style={{backgroundColor:s.color}} aria-hidden="true"/>{s.name}<small>{s.active?s.base_label:'inativa'}</small></label>;})}
       {unknown.map(id=><label key={id} className="is-on" title="Esta situação não existe mais no Gerenciador de transições: desmarque para retirá-la."><input type="checkbox" id={fieldId(field.key,id)} checked disabled={!editable} onChange={()=>pick(id,false)}/>Situação não encontrada</label>)}</div></>}
      {custom.length===0&&!unknown.length&&<small className="preference-note">Nenhuma situação personalizada de pedido de venda. Crie em Sistema › Gerenciador de transições.</small>}</div>;break;}
    control=<div className="preference-chips" role="group" aria-label={field.label}>{options.map(([value,text])=><label key={value} className={list.includes(value)?'is-on':undefined}><input type="checkbox" id={fieldId(field.key,value)} checked={list.includes(value)} disabled={!editable||!list.includes(value)&&list.length>=(field.maxItems??options.length)} onChange={e=>set(field.key,options.map(o=>o[0]).filter(v=>v===value?e.target.checked:list.includes(v)))}/>{text}</label>)}</div>;break;}
   case'integer':control=field.widget==='select'?<select id={id} value={String(raw)} disabled={!editable} onChange={e=>set(field.key,Number(e.target.value))}>{integerOptions(field).map(n=><option key={n} value={n}>{n}</option>)}</select>
    :<input id={id} inputMode="numeric" maxLength={9} value={String(raw??'')} disabled={!editable} aria-invalid={bad||undefined} onChange={e=>set(field.key,e.target.value)}/>;break;
   case'decimal':control=<input id={id} inputMode="decimal" maxLength={16} value={String(raw??'').replace('.',',')} disabled={!editable} aria-invalid={bad||undefined} onChange={e=>set(field.key,e.target.value)}/>;break;
   case'text':control=<input id={id} type={field.format==='email'?'email':'text'} inputMode={field.format==='digits'?'numeric':undefined} maxLength={field.maxLength} value={String(raw??'')} disabled={!editable} aria-invalid={bad||undefined} onChange={e=>set(field.key,e.target.value)}/>;break;
   case'textarea':control=<textarea id={id} rows={4} maxLength={field.maxLength} value={String(raw??'')} disabled={!editable} aria-invalid={bad||undefined} onChange={e=>set(field.key,e.target.value)}/>;break;
   case'users':{const list=Array.isArray(raw)?raw as string[]:[],stale=list.filter(v=>!directory.some(u=>u.user_id===v));
    control=view?.directory?<div className="preference-chips" role="group" aria-label={field.label}>{directory.map(user=><label key={user.user_id} className={list.includes(user.user_id)?'is-on':undefined}><input type="checkbox" id={fieldId(field.key,user.user_id)} checked={list.includes(user.user_id)} disabled={!editable}
      onChange={e=>set(field.key,[...list.filter(v=>v!==user.user_id),...(e.target.checked?[user.user_id]:[])].sort())}/>{user.label??`Usuário ${user.user_id.slice(0,8)}`}<small>{ROLE_NAMES[user.role]}</small></label>)}
      {stale.length>0&&<small className="preference-note">{stale.length} usuário(s) marcado(s) não estão mais ativos. <button type="button" className="text-button" disabled={!editable} onClick={()=>set(field.key,list.filter(v=>!stale.includes(v)))}>Desmarcar usuários inativos</button></small>}</div>
     :<p className="preference-value">{list.length?`${list.length} usuário(s) marcado(s).`:'Nenhum usuário marcado.'}</p>;break;}
   case'keymap':{const options=keymapOptions(field),map=(raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{}) as Record<string,string>;
    control=<div><table className="data-table preference-keymap"><thead><tr><th scope="col">Descrição</th><th scope="col">Tecla</th></tr></thead><tbody>{options.actions.map((action,i)=><tr key={action}><td>{options.labels[i]}</td><td><input id={fieldId(field.key,action)} aria-label={`Tecla de ${options.labels[i]}`} maxLength={1} value={map[action]??''} disabled={!editable} onChange={e=>set(field.key,{...map,[action]:e.target.value.toUpperCase()})}/></td></tr>)}</tbody></table>
     <button type="button" className="text-button" disabled={!editable} onClick={()=>set(field.key,{...(field.default as Record<string,string>)})}>Redefinir</button></div>;break;}
   case'documents':{const rows=(Array.isArray(raw)?raw:[]) as PreferenceDocument[];
    control=<div><table className="data-table preference-documents"><thead><tr><th scope="col">Contato</th><th scope="col">CPF/CNPJ</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{rows.map((row,i)=><tr key={i}>
      <td><input id={fieldId(field.key,`${i}-name`)} aria-label="Contato" maxLength={80} value={row.name} disabled={!editable} onChange={e=>set(field.key,rows.map((r,j)=>j===i?{...r,name:e.target.value}:r))}/></td>
      <td><input id={fieldId(field.key,`${i}-document`)} aria-label="CPF/CNPJ" maxLength={18} value={row.document} disabled={!editable} onChange={e=>set(field.key,rows.map((r,j)=>j===i?{...r,document:e.target.value}:r))}/>{normalizedValue(field,[{document:row.document,name:''}])&&<small>{formatDocument(row.document)}</small>}</td>
      <td><button type="button" className="text-button" disabled={!editable} onClick={()=>set(field.key,rows.filter((_,j)=>j!==i))}>Remover</button></td></tr>)}</tbody></table>
     <button type="button" className="text-button" disabled={!editable||rows.length>=(field.maxItems??10)} onClick={()=>set(field.key,[...rows,{document:'',name:''}])}>Adicionar outro contato</button></div>;break;}
  }
  return <div className="preference-field" key={field.key}>{label}<div>{control}{bad&&<small className="preference-invalid" role="alert">{invalidText(field)}</small>}<Status field={field}/></div></div>;
 };
 const renderSection=(id:string)=>{let group:string|undefined;const out=[];
  // Central de Notificações (187): the Origin table "Notificação | Destinatários | Editar" instead of the field list.
  if(page.id==='central-notificacoes')return [<NotificationRecipients key="recipients" page={page} draft={draft} set={set} editable={editable} directory={view?.directory??null}/>];
  for(const entry of sectionEntries(page,id)){if(!visible(entry,draft))continue;if(entry.group&&entry.group!==group)out.push(<h4 className="preference-group" key={`g-${entry.group}`}>{entry.group}</h4>);group=entry.group;out.push(entry.info?renderInfo(entry):renderField(entry));}
  return out;};

 const Root=embedded?'section':'main';
 return <Root className={`preferences-page preference-settings${embedded?' preference-embedded':''}`} {...(embedded?{'aria-label':page.title}:{id:'main-content'})}>
  {embedded?<h2 className="preference-embedded-title">{page.title}</h2>:<><nav className="preferences-breadcrumb" aria-label="Localização"><Link to={homeTo}>Home</Link><Icon name="chevron-right" size={10}/><Link to="/preferencias">Preferências</Link><Icon name="chevron-right" size={10}/><h1>{page.title}</h1></nav>
  <p className="preferences-trail"><Link to={categoryTo} aria-label="Voltar para a categoria"><Icon name="arrow-left" size={12}/></Link><Link to="/preferencias">Preferências</Link> / <Link to={categoryTo}>{categoryLabel}</Link> / <span aria-current="page">{page.title}</span></p></>}
  {!allowed?<section className="real-state-panel"><h2>Preferência não liberada</h2><p>Seu perfil atual não consulta esta página de preferências.{attempt.current?' A confirmação pendente fica preservada até o acesso ser restabelecido.':''}</p></section>:<div className={page.subsections?'preferences-layout preference-has-subsections':'preference-single'}>
   {page.subsections&&<nav className="preferences-subsections" aria-label={`Seções de ${page.title}`}>{page.sections.map(s=><button type="button" key={s.id} className={s.id===current?'active':''} aria-current={s.id===current?'true':undefined} onClick={()=>go(s.id)}>{s.title}</button>)}</nav>}
   <section className="preference-form" aria-busy={busy||loading}>
    {page.scope==='user'?<p className="real-help">Estas preferências valem somente para o seu usuário.</p>:view&&!view.can_manage?<p className="real-notice">Somente administradores alteram estas preferências. Você pode consultar os valores atuais.</p>:null}
    {stored&&<p className="real-help">As opções marcadas com “Ainda não aplicada” ficam guardadas e passam a valer quando a função correspondente existir no FAGOO.</p>}
    {loading&&!view&&<p role="status">Carregando preferências…</p>}
    {error&&<p className="real-alert" role="alert">{error}{!view&&!attempt.current&&<button type="button" className="text-button" onClick={()=>setReload(n=>n+1)}>Tentar novamente</button>}</p>}
    {notice&&<p className="real-success" role="status">{notice}</p>}
    {pending!=='none'&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de editar de novo. Sair da tela não desfaz uma gravação já realizada.</p>
     <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void run(attempt.current!,false)}>Conferir resultado</button>
      {pending==='missing'&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(attempt.current!,true)}>Reenviar o mesmo comando</button>}</div></section>}
    {(view||!stored)&&shown.map(s=><section className="preference-section" key={s.id}>{(!page.subsections||page.sections.length>1)&&<h3>{s.title}</h3>}<div className="preference-fields">{renderSection(s.id)}</div>
     {view&&<p className="real-help preference-updated">{(()=>{const keys=sectionEntries(page,s.id).filter(e=>!e.info).map(e=>(e as PreferenceField).key);const stamps=view.items.filter(i=>keys.includes(i.key)&&i.updated_at).map(i=>i.updated_at!).sort();return stamps.length?`Última alteração nesta seção: ${moment(stamps.at(-1)!)}.`:'Nesta seção, os valores ainda são os padrões.';})()}</p>}</section>)}
    {page.subsections&&<div className="preference-steps">{index>0&&<button type="button" className="text-button" onClick={()=>go(page.sections[index-1].id)}><Icon name="arrow-left" size={11}/>{page.sections[index-1].title}</button>}{index<page.sections.length-1&&<button type="button" className="text-button" onClick={()=>go(page.sections[index+1].id)}>{page.sections[index+1].title}<Icon name="arrow-right" size={11}/></button>}</div>}
    <footer className="preference-actions">{view?.can_manage&&<button type="button" className="primary-button" disabled={!state.changes.length||state.invalid.length>0||busy||pending!=='none'} onClick={save}>Salvar</button>}
     {embedded?<button type="button" className="secondary-button" disabled={busy} onClick={()=>guard.confirmLeave(()=>onClose?.())}>Cancelar</button>:<Link to={categoryTo} className="secondary-button">Voltar</Link>}
     {view&&(discard?<span className="preference-discard"><span>Descartar as alterações e recarregar?</span><button type="button" className="text-button" onClick={()=>setDiscard(false)}>Continuar editando</button><button type="button" className="text-button" disabled={busy||pending!=='none'} onClick={()=>setReload(n=>n+1)}>Descartar e recarregar</button></span>
      :<button type="button" className="text-button" disabled={busy||pending!=='none'} onClick={()=>state.dirty?setDiscard(true):setReload(n=>n+1)}>Recarregar</button>)}
     {notice&&!state.dirty&&<span className="preference-saved" aria-hidden="true">{notice}</span>}
     {state.dirty&&!busy&&pending==='none'&&<span className="real-help">{state.changes.length} alteração(ões) não salva(s){state.invalid.length?`, ${state.invalid.length} com valor a corrigir`:''}.</span>}</footer>
   </section>
  </div>}
 </Root>;
}
