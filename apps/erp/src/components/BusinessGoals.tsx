import { nativeIndicatorCoverageText } from '../lib/document-reports-model';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {goalsPath,goalsSavePath,goalCommandPath,parseGoals,parseGoalResult,captureGoalsQuery,blankGoal,goalBody,goalFailure,goalProgress,moneyText,brDate,todaySP,
 type BusinessController,type Goal,type GoalsView,type GoalData,type GoalSaveInput} from '../lib/business-model';
import {Icon} from './Icon';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const reader=(s:AccessState,actor:string|null)=>s.phase==='ready'&&s.membership?.user_id===actor;
type Attempt={body:GoalSaveInput;uncertain:boolean;retryAllowed:boolean};

/** Meu Negócio > Desempenho > Metas: tabs "Metas em andamento" and "Metas inativas", "+ Nova meta" drawer (administrador). */
export default function BusinessGoals({controller}:{controller:BusinessController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot),actor=useRef(snapshot.membership?.user_id??null);
 const allowed=reader(snapshot,actor.current),admin=allowed&&snapshot.membership?.role==='admin';
 const [tab,setTab]=useState<'andamento'|'inativas'>('andamento'),[view,setView]=useState<GoalsView|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [editing,setEditing]=useState<{goal:Goal|null;draft:GoalData;baseline:string}|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState<'none'|'uncertain'|'missing'>('none'),[reload,setReload]=useState(0);
 const request=useRef<AbortController|null>(null),save=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),alive=useRef(true);
 const may=()=>alive.current&&reader(controller.getSnapshot(),actor.current);
 const dirty=Boolean(editing&&JSON.stringify(editing.draft)!==editing.baseline);
 const guard=useUnsavedChanges(dirty,busy||pending!=='none');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();save.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();save.current?.abort();setBusy(false);if(attempt.current){attempt.current.uncertain=true;attempt.current.retryAllowed=false;setPending('uncertain');}},[allowed]);
 useEffect(()=>{if(!allowed||!may())return;const q=captureGoalsQuery({aba:tab}),p=new AbortController();request.current?.abort();request.current=p;setLoading(true);setError('');void(async()=>{try{
  const raw=await controller.system(goalsPath(tab),{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;setView(parseGoals(raw,q));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may())setError(e instanceof AccessError&&e.status===403?'Seu perfil não consulta as metas.':'Não foi possível carregar as metas. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,tab,reload,allowed]);
 const open=(goal:Goal|null)=>{if(!admin||busy||pending!=='none')return;const draft=goal?{name:goal.name,start_on:goal.start_on,end_on:goal.end_on,segment:goal.segment,seller:goal.seller,target:goal.target.replace('.',','),active:goal.active}:blankGoal(todaySP());
  setEditing({goal,draft,baseline:JSON.stringify(draft)});setError('');setNotice('');};
 const run=async(a:Attempt,post:boolean)=>{
  if(!may()||save.current||attempt.current!==a||post&&a.uncertain&&!a.retryAllowed)return;
  const p=new AbortController();save.current=p;setBusy(true);setError('');a.retryAllowed=false;let reading=false;
  try{
   const raw=post?await controller.system(goalsSavePath(),{method:'POST',body:a.body,signal:p.signal}):(reading=true,await controller.system(goalCommandPath(a.body.command_id),{method:'GET',signal:p.signal}));
   if(p.signal.aborted||attempt.current!==a||!may())return;
   const result=parseGoalResult(raw,{commandId:a.body.command_id,input:a.body,lookup:!post});
   attempt.current=null;setPending('none');setEditing(null);setNotice(`Meta ${a.body.goal_id?'alterada':'incluída'}${result.replayed?' (comando já registrado)':''}.`);setReload(n=>n+1);
  }catch(e){if(!p.signal.aborted&&attempt.current===a&&!aborted(e)&&may()){
   if(reading&&e instanceof AccessError&&e.status===404){a.retryAllowed=true;setPending('missing');setError('Este comando não foi registrado. Você pode reenviar exatamente a mesma meta.');}
   else{const f=goalFailure(e instanceof AccessError?e.status:null);
    if(post&&!a.uncertain&&f.definitive){attempt.current=null;setPending('none');setError(f.message);}
    else{a.uncertain=true;setPending('uncertain');setError(reading&&f.definitive?'O resultado não pôde ser conferido com o seu acesso atual. Tente conferir de novo.':goalFailure(null).message);}}
  }}finally{if(save.current===p){save.current=null;setBusy(false);}}
 };
 const submit=()=>{if(!editing||!admin||busy||attempt.current)return;const {body,problem}=goalBody(editing.draft,editing.goal,crypto.randomUUID());if(!body){setError(problem!);return;}
  const a:Attempt={body,uncertain:false,retryAllowed:false};attempt.current=a;void run(a,true);};
 const set=(patch:Partial<GoalData>)=>{if(busy||pending!=='none')return;setEditing(e=>e&&{...e,draft:{...e.draft,...patch}});};
 const close=()=>guard.confirmLeave(()=>{if(!busy&&pending==='none')setEditing(null);});
 const items=view?.items??[],locked=busy||pending!=='none';
 return <div className="business-goals">
  {!loading && nativeIndicatorCoverageText(view) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(view)}</p>}
  <div className="business-tabs" role="tablist" aria-label="Metas">{(['andamento','inativas'] as const).map(t=><button type="button" role="tab" key={t} aria-selected={tab===t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t==='andamento'?'Metas em andamento':'Metas inativas'}</button>)}
   {admin&&<button type="button" className="primary-button business-goal-new" disabled={locked} onClick={()=>open(null)}><Icon name="plus" size={11}/>Nova meta</button>}</div>
  {view&&!view.can_manage&&<p className="real-help">Somente administradores incluem e alteram metas.</p>}
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{loading&&<p role="status">Carregando metas…</p>}
  {pending!=='none'&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de editar de novo.</p>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void run(attempt.current!,false)}>Conferir resultado</button>
    {pending==='missing'&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void run(attempt.current!,true)}>Reenviar o mesmo comando</button>}</div></section>}
  {view&&!items.length&&!loading&&<div className="empty-state"><h2>Você ainda não possui metas cadastradas</h2><p>Crie uma para acompanhar seu objetivo de vendas.</p></div>}
  {items.length>0&&<ul className="business-goal-list">{items.map(g=><li key={g.id}><div><strong>{g.name}</strong><small>{brDate(g.start_on)} a {brDate(g.end_on)} · {g.segment==='geral'?'Geral':`Vendedor: ${g.seller}`}{g.active?'':' · inativa'}</small></div>
   <progress max={100} value={goalProgress(g)} aria-label={`${g.name}: ${goalProgress(g)}% atingido`}/><span>{moneyText(g.achieved)} de {moneyText(g.target)} ({goalProgress(g).toLocaleString('pt-BR')}%)</span>
   {admin&&<button type="button" className="text-button" disabled={locked} onClick={()=>open(g)}>Editar</button>}</li>)}</ul>}
  {view&&<p className="real-help">Atingido: Valor Total dos pedidos de venda nas situações de Ajustes, entre a Data início e a Data conclusão.</p>}
  {editing&&<aside className="business-drawer" role="dialog" aria-modal="true" aria-label={editing.goal?'Editar meta':'Nova meta'}><header><h2>{editing.goal?'Editar meta':'Nova meta'}</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={close}><Icon name="xmark" size={14}/></button></header>
   <p className="real-help">Objetivo: O que você gostaria de acompanhar?</p>
   <fieldset disabled={locked} className="business-drawer-fields">
    <label className="form-field">Nome da meta *<input id="goal-name" maxLength={120} value={editing.draft.name} onChange={e=>set({name:e.target.value})}/></label>
    <label className="form-field">Data início *<input id="goal-start" type="date" value={editing.draft.start_on} onChange={e=>set({start_on:e.target.value})}/></label>
    <label className="form-field">Data conclusão *<input id="goal-end" type="date" value={editing.draft.end_on} onChange={e=>set({end_on:e.target.value})}/></label>
    <label className="form-field">Segmentação<select id="goal-segment" value={editing.draft.segment} onChange={e=>set({segment:e.target.value as GoalData['segment'],seller:e.target.value==='vendedor'?editing.draft.seller:null})}>
     <option value="geral">Geral</option><option value="loja" disabled>Loja (lojas virtuais estão fora do escopo)</option><option value="vendedor" disabled={!view?.sellers.length}>Vendedor{view?.sellers.length?'':' (nenhum vendedor nos pedidos)'}</option></select></label>
    {editing.draft.segment==='vendedor'&&<label className="form-field">Vendedor<select id="goal-seller" value={editing.draft.seller??''} onChange={e=>set({seller:e.target.value||null})}><option value="">Selecione</option>{view?.sellers.map(s=><option key={s} value={s}>{s}</option>)}</select></label>}
    <label className="form-field">Valor da meta *<input id="goal-target" inputMode="decimal" placeholder="Ex. 1000000,00" maxLength={18} value={editing.draft.target} onChange={e=>set({target:e.target.value})}/></label>
    {editing.goal&&<label className="preference-switch"><input id="goal-active" type="checkbox" role="switch" checked={editing.draft.active} onChange={e=>set({active:e.target.checked})}/><span>Meta ativa</span></label>}
   </fieldset>
   <footer className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancelar</button><button type="button" className="primary-button" disabled={locked||!dirty} onClick={submit}>{busy?'Salvando…':'Salvar'}</button></footer></aside>}
 </div>;
}
