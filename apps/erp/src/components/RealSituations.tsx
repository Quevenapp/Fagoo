import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {SITUATION_KINDS,SITUATION_KIND_LABELS,TRANSITION_ACTIONS,TRANSITION_ACTION_LABELS,SITUATION_LIMIT,DEFAULT_COLOR,situationsPath,SITUATION_SAVE_PATH,TRANSITION_SAVE_PATH,TRANSITIONS_DELETE_PATH,
 captureSituationsQuery,parseSituationsPage,captureSituationSave,captureTransitionSave,captureTransitionsDelete,parseSituationsResult,openDestinations,effective,actionsText,toggleAction,commandFailure,
 type FrameworksController,type SituationKind,type Situation,type Transition,type SituationsPage,type TransitionAction,type SituationSaveInput,type TransitionSaveInput,type TransitionsDeleteInput} from '../lib/frameworks-model';
import {OriginListHeader} from './OriginList';
import {Modal} from './Modal';
import {Icon} from './Icon';
import './system-frameworks.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
// HTTP refusals are read from their status (AccessError and the QA ports carry it).
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
const admin=(s:AccessState,actor:string|null)=>s.phase==='ready'&&s.membership?.role==='admin'&&s.membership.user_id===actor;
type SituationDraft={base_status:string;name:string;color:string;active:boolean};
type Editor={type:'situation';situation:Situation|null;draft:SituationDraft;baseline:string}|{type:'transition';from:string;transition:Transition|null;draft:{to:string;active:boolean;actions:TransitionAction[]};baseline:string}
 |{type:'graph';from:string}|{type:'delete';from:string;items:Transition[]};
type Attempt={action:'situation';path:string;body:SituationSaveInput;subject:string}|{action:'transition';path:string;body:TransitionSaveInput;subject:string}|{action:'delete';path:string;body:TransitionsDeleteInput;subject:string};
const NOT_ADOPTED='Disponível quando os pedidos passarem a seguir o Gerenciador de transições.';

/** Badge with the color of the situação (Origin "selo"). */
function Badge({situation}:{situation:Situation|undefined}){
 if(!situation)return <span className="situation-badge">—</span>;
 return <span className={`situation-badge${situation.active?'':' is-inactive'}`}><span className="situation-dot" style={{background:situation.color}} aria-hidden="true"/>{situation.name}</span>;
}

/** "Visualizar gráfico de transições": radial diagram in local SVG (origin at the center, destinations around it). */
export function SituationGraph({page,from}:{page:SituationsPage;from:string}){
 const origin=page.situations.find(s=>s.key===from),rows=page.transitions.filter(t=>t.from===from),size=360,c=size/2,r=130;
 if(!origin)return null;
 return <svg className="situation-graph" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Transições a partir de ${origin.name}: ${rows.length} destino(s)`}>
  <defs><marker id="situation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  {rows.map((t,i)=>{const angle=(2*Math.PI*i)/Math.max(rows.length,1)-Math.PI/2,x=c+r*Math.cos(angle),y=c+r*Math.sin(angle),to=page.situations.find(s=>s.key===t.to),on=effective(page,t);
   const ex=c+(r-26)*Math.cos(angle),ey=c+(r-26)*Math.sin(angle),sx=c+34*Math.cos(angle),sy=c+34*Math.sin(angle);
   return <g key={t.to} className={on?'is-active':'is-inactive'}><line x1={sx} y1={sy} x2={ex} y2={ey} markerEnd="url(#situation-arrow)"/>
    <circle cx={x} cy={y} r={22} fill={to?.color??'#607d8b'}/>{on&&<path className="situation-graph-check" d={`M${x-6} ${y}l4 4l8-8`}/>}
    <text x={x} y={y+36} textAnchor="middle">{to?.name??t.to}</text><title>{`${origin.name} → ${to?.name??t.to}: ${on?'ativa':'inativa'}`}</title></g>;})}
  <circle cx={c} cy={c} r={30} fill={origin.color}/><text x={c} y={c+48} textAnchor="middle" className="situation-graph-origin">{origin.name}</text>
 </svg>;
}

/** Sistema > Gerenciador de transições (Origin situacoes.transicoes.php): abas, acordeão por origem, modais e exclusão. */
export default function RealSituations({controller}:{controller:FrameworksController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot),actor=useRef(snapshot.membership?.user_id??null),allowed=admin(snapshot,actor.current);
 const [kind,setKind]=useState<SituationKind>('sales_orders'),[page,setPage]=useState<SituationsPage|null>(null),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [open,setOpen]=useState(''),[selected,setSelected]=useState<string[]>([]),[editor,setEditor]=useState<Editor|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[reload,setReload]=useState(0);
 const request=useRef<AbortController|null>(null),save=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),alive=useRef(true);
 const may=()=>alive.current&&admin(controller.getSnapshot(),actor.current);
 const dirty=Boolean(editor&&(editor.type==='situation'||editor.type==='transition')&&JSON.stringify(editor.draft)!==editor.baseline);
 const guard=useUnsavedChanges(dirty,busy||pending);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();save.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();save.current?.abort();setBusy(false);setLoading(false);setPage(null);setEditor(null);if(attempt.current)setPending(true);},[allowed]);
 useEffect(()=>{if(!allowed||!may())return;const q=captureSituationsQuery({tipo:kind}),p=new AbortController();request.current?.abort();request.current=p;setLoading(true);setLoadError('');void(async()=>{try{
  const raw=await controller.system(situationsPath(kind),{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;const v=parseSituationsPage(raw,q);setPage(v);
  setSelected(s=>s.filter(id=>v.transitions.some(t=>!t.default&&`${t.from}>${t.to}`===id)));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may())setLoadError(statusOf(e)===403?'Somente administradores configuram as situações.':'Não foi possível carregar as situações. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,kind,reload,allowed]);
 const run=async(a:Attempt)=>{
  if(!may()||save.current||attempt.current!==a)return;const p=new AbortController();save.current=p;setBusy(true);setError('');setNotice('');
  try{const raw=await controller.system(a.path,{method:'POST',body:a.body,signal:p.signal});if(p.signal.aborted||attempt.current!==a||!may())return;
   const result=a.action==='situation'?parseSituationsResult(raw,a.body,'situation'):a.action==='transition'?parseSituationsResult(raw,a.body,'transition'):parseSituationsResult(raw,a.body,'delete');
   attempt.current=null;setPending(false);setEditor(null);if(a.action==='delete')setSelected([]);
   setNotice(`${a.action==='delete'?`${result.receipt.count} transição(ões) excluída(s)`:a.action==='situation'?`Situação ${a.body.id?'alterada':'criada'}`:'Transição salva'}${result.replayed?' (comando já registrado)':''}.`);setReload(n=>n+1);
  }catch(e){if(p.signal.aborted||attempt.current!==a||aborted(e)||!may())return;const f=commandFailure(statusOf(e),a.subject);
   if(f.definitive){attempt.current=null;setPending(false);setError(f.message);if(f.reload){setEditor(null);setReload(n=>n+1);}}else{setPending(true);setError(f.message);}}
  finally{if(save.current===p){save.current=null;setBusy(false);}}
 };
 const start=(a:Attempt)=>{if(attempt.current||busy)return;attempt.current=a;void run(a);};
 const locked=busy||pending;
 const switchKind=(k:SituationKind)=>{if(locked||k===kind)return;guard.confirmLeave(()=>{setEditor(null);setOpen('');setSelected([]);setPage(null);setNotice('');setKind(k);});};
 if(!allowed)return <section className="real-state-panel"><h1>Gerenciador de transições não liberado</h1><p>Somente administradores configuram as situações e transições.</p></section>;
 const find=(key:string)=>page?.situations.find(s=>s.key===key);
 const custom=page?.situations.filter(s=>!s.default).length??0;
 const openSituation=(s:Situation|null)=>{if(locked||!page)return;const draft={base_status:s?.base_status??page.situations[0]!.key,name:s?.name??'',color:s?.color??DEFAULT_COLOR,active:s?.active??true};
  setEditor({type:'situation',situation:s,draft,baseline:JSON.stringify(draft)});setError('');setNotice('');};
 const openTransition=(from:string,t:Transition|null)=>{if(locked||!page)return;const options=openDestinations(page,from);if(!t&&!options.length)return;
  const draft={to:t?.to??options[0]!.key,active:t?.active??true,actions:[...(t?.actions??[])]};setEditor({type:'transition',from,transition:t,draft,baseline:JSON.stringify(draft)});setError('');setNotice('');};
 const close=()=>guard.confirmLeave(()=>{if(!busy&&!pending)setEditor(null);});
 const submitSituation=()=>{if(!editor||editor.type!=='situation'||!page)return;let body:SituationSaveInput;
  try{body=captureSituationSave({command_id:crypto.randomUUID(),kind,id:editor.situation?.key??null,expected_version:editor.situation?.version??0,data:{...editor.draft,name:editor.draft.name.trim()}});}
  catch{setError('Informe o Nome (até 40 caracteres) e escolha a Cor.');return;}
  start({action:'situation',path:SITUATION_SAVE_PATH,body,subject:'A situação'});};
 const submitTransition=()=>{if(!editor||editor.type!=='transition'||!page)return;const current=editor.transition??page.transitions.find(t=>t.from===editor.from&&t.to===editor.draft.to)??null;let body:TransitionSaveInput;
  try{body=captureTransitionSave({command_id:crypto.randomUUID(),kind,from:editor.from,to:editor.draft.to,expected_version:current?.version??0,data:{active:editor.draft.active,actions:editor.draft.actions}});}
  catch{setError('Escolha a situação de destino.');return;}
  start({action:'transition',path:TRANSITION_SAVE_PATH,body,subject:'A transição'});};
 const submitDelete=()=>{if(!editor||editor.type!=='delete')return;const body=captureTransitionsDelete({command_id:crypto.randomUUID(),kind,items:editor.items.map(t=>({from:t.from,to:t.to,expected_version:t.version}))});
  start({action:'delete',path:TRANSITIONS_DELETE_PATH,body,subject:'A transição'});};
 const setSituation=(patch:Partial<SituationDraft>)=>{if(locked)return;setEditor(e=>e&&e.type==='situation'?{...e,draft:{...e.draft,...patch}}:e);};
 const setTransition=(patch:Partial<{to:string;active:boolean;actions:TransitionAction[]}>)=>{if(locked)return;setEditor(e=>e&&e.type==='transition'?{...e,draft:{...e.draft,...patch}}:e);};
 return <div className="real-situations">
  <OriginListHeader title="Gerenciador de transições"/>
  <div className="frameworks-tabs" role="tablist" aria-label="Tipo de documento">{SITUATION_KINDS.map(k=><button type="button" role="tab" key={k} aria-selected={kind===k} className={kind===k?'active':''} disabled={locked&&kind!==k} onClick={()=>switchKind(k)}>{SITUATION_KIND_LABELS[k]}</button>)}
   <button type="button" role="tab" aria-selected={false} disabled title="Ordens de produção estão fora do escopo do FAGOO.">Ordens de Produção</button></div>
  {page&&!page.adopted&&<p className="real-notice situations-adoption" role="note">As situações e transições ficam guardadas aqui, mas os {SITUATION_KIND_LABELS[kind].toLowerCase()} ainda seguem as situações padrão: criar situações ou desativar transições ainda não muda os documentos, e as ações de estoque e contas ficam indisponíveis até o módulo adotar o gerenciador.</p>}
  <div className="situations-toolbar"><button type="button" className="primary-button" disabled={locked||!page||custom>=SITUATION_LIMIT} title={custom>=SITUATION_LIMIT?`Limite de ${SITUATION_LIMIT} situações personalizadas por aba.`:undefined} onClick={()=>openSituation(null)}><Icon name="circle-plus" size={12}/>Criar nova situação</button></div>
  {loadError&&<p className="real-alert" role="alert">{loadError}</p>}{error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{loading&&<p role="status" className="real-help">Carregando situações…</p>}
  {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de alterar de novo.</p>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy||!allowed} onClick={()=>void run(attempt.current!)}>Conferir resultado</button></div></section>}
  {page&&<ul className="situations-list">{page.situations.map(s=>{const expanded=open===s.key,rows=page.transitions.filter(t=>t.from===s.key),destinations=openDestinations(page,s.key);
   const removable=rows.filter(t=>!t.default).map(t=>`${t.from}>${t.to}`),marked=selected.filter(id=>removable.includes(id));
   return <li key={s.key} className={expanded?'is-open':undefined}>
    <div className="situation-origin"><button type="button" className="situation-toggle" aria-expanded={expanded} onClick={()=>{setOpen(expanded?'':s.key);setSelected([]);}}>
     <Icon name={expanded?'chevron-up':'chevron-down'} size={10}/>Estado de origem: <Badge situation={s}/></button>
     {!s.default&&<small className="situation-based">Baseada em {find(s.base_status)?.name}{s.active?'':' · inativa'}</small>}
     <button type="button" className="icon-button" aria-label={`Visualizar gráfico de transições de ${s.name}`} title="Visualizar gráfico de transições" onClick={()=>setEditor({type:'graph',from:s.key})} disabled={locked}><Icon name="sitemap" size={13}/></button>
     {!s.default&&<button type="button" className="icon-button" aria-label={`Editar situação ${s.name}`} disabled={locked} onClick={()=>openSituation(s)}><Icon name="pencil" size={12}/></button>}</div>
    {expanded&&<div className="situation-transitions">
     <div className="situations-row-tools"><button type="button" className="secondary-button" disabled={locked||!destinations.length} title={destinations.length?undefined:'Todos os destinos já foram configurados.'} onClick={()=>openTransition(s.key,null)}>Criar nova transição</button>
      <button type="button" className="secondary-button" disabled={locked||!marked.length} onClick={()=>setEditor({type:'delete',from:s.key,items:rows.filter(t=>marked.includes(`${t.from}>${t.to}`))})}><Icon name="trash-can" size={12}/>Excluir selecionados</button></div>
     {rows.length?<table className="data-table situations-table"><thead><tr><th scope="col"><input type="checkbox" aria-label="Selecionar todas as transições personalizadas" disabled={locked||!removable.length} checked={removable.length>0&&marked.length===removable.length}
      onChange={e=>setSelected(e.target.checked?removable:[])}/></th><th scope="col">Situação de destino</th><th scope="col">Ações</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Editar</span></th></tr></thead>
      <tbody>{rows.map(t=>{const id=`${t.from}>${t.to}`,to=find(t.to),on=effective(page,t);return <tr key={id}>
       <td><input type="checkbox" aria-label={`Selecionar transição para ${to?.name??t.to}`} disabled={locked||t.default} title={t.default?'Transições padrão só podem ser desativadas.':undefined} checked={selected.includes(id)}
        onChange={e=>setSelected(list=>e.target.checked?[...list,id]:list.filter(x=>x!==id))}/></td>
       <td><Badge situation={to}/>{t.default?<small className="situation-default"> padrão</small>:null}</td><td>{actionsText(t.actions)}</td>
       <td>{on?<span className="situation-status is-active"><Icon name="circle-check" size={12}/>Ativa</span>:<span className="situation-status">{t.active?'Inativa (situação inativa)':'Inativa'}</span>}</td>
       <td><button type="button" className="icon-button" aria-label={`Editar transição para ${to?.name??t.to}`} disabled={locked} onClick={()=>openTransition(s.key,t)}><Icon name="pencil" size={12}/></button></td></tr>;})}</tbody></table>
      :<p className="empty-state">Nenhuma transição a partir desta situação.</p>}
    </div>}
   </li>;})}</ul>}
  {page&&editor?.type==='graph'&&<Modal title={`Gráfico de transições · ${find(editor.from)?.name??''}`} onClose={()=>setEditor(null)} actions={<button type="button" className="secondary-button" onClick={()=>setEditor(null)}>Fechar</button>}>
   <SituationGraph page={page} from={editor.from}/><p className="real-help">Verde: transição ativa. Cinza: inativa.</p></Modal>}
  {page&&editor?.type==='situation'&&<Modal title={editor.situation?'Editar situação':'Criar nova situação'} onClose={close} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancelar</button>
   <button type="button" className="primary-button" disabled={locked||!dirty} onClick={submitSituation}>{busy?'Salvando…':'Salvar'}</button></>}>
   <fieldset disabled={locked} className="situations-fields">
    <label className="form-field">Baseada em<select id="situation-base" value={editor.draft.base_status} disabled={Boolean(editor.situation)} onChange={e=>setSituation({base_status:e.target.value})}>
     {page.situations.filter(s=>s.default).map(s=><option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
    <p className="real-help">A nova situação herda as regras da situação padrão escolhida{editor.situation?'; a base não muda depois de criada':''}.</p>
    <label className="form-field">Nome *<input id="situation-name" maxLength={40} value={editor.draft.name} onChange={e=>setSituation({name:e.target.value})}/></label>
    <label className="form-field">Cor<input id="situation-color" type="color" value={editor.draft.color} onChange={e=>setSituation({color:e.target.value.toLowerCase()})}/></label>
    {editor.situation&&<label className="preference-switch"><input id="situation-active" type="checkbox" role="switch" checked={editor.draft.active} onChange={e=>setSituation({active:e.target.checked})}/><span>Situação ativa</span></label>}
   </fieldset></Modal>}
  {page&&editor?.type==='transition'&&<Modal title={editor.transition?'Editar transição':'Criar transição'} onClose={close} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancelar</button>
   <button type="button" className="primary-button" disabled={locked||!dirty&&Boolean(editor.transition)} onClick={submitTransition}>{busy?'Salvando…':'Salvar'}</button></>}>
   <fieldset disabled={locked} className="situations-fields">
    <p className="form-field">Origem<span><Badge situation={find(editor.from)}/></span></p>
    <label className="form-field">Destino<select id="transition-to" value={editor.draft.to} disabled={Boolean(editor.transition)} onChange={e=>setTransition({to:e.target.value})}>
     {(editor.transition?[find(editor.transition.to)!]:openDestinations(page,editor.from)).map(s=><option key={s.key} value={s.key}>{s.name}</option>)}</select></label>
    <fieldset className="transition-actions"><legend>Ações</legend>{TRANSITION_ACTIONS.map(a=><label key={a} className="preference-switch" title={page.adopted?undefined:NOT_ADOPTED}>
     <input id={`transition-${a}`} type="checkbox" role="switch" disabled={!page.adopted} checked={editor.draft.actions.includes(a)} onChange={e=>setTransition({actions:toggleAction(editor.draft.actions,a,e.target.checked)})}/><span>{TRANSITION_ACTION_LABELS[a]}</span></label>)}
     {!page.adopted&&<p className="real-help">{NOT_ADOPTED}</p>}</fieldset>
    <label className="form-field">Status da transição<select id="transition-active" value={editor.draft.active?'ativa':'inativa'} onChange={e=>setTransition({active:e.target.value==='ativa'})}><option value="ativa">Ativa</option><option value="inativa">Inativa</option></select></label>
   </fieldset></Modal>}
  {page&&editor?.type==='delete'&&<Modal title="Excluir transições" onClose={()=>{if(!busy)setEditor(null);}} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={()=>setEditor(null)}>Cancelar</button>
   <button type="button" className="danger-button" disabled={locked} onClick={submitDelete}>{busy?'Excluindo…':'Excluir'}</button></>}>
   <p>Excluir {editor.items.length} transição(ões) a partir de <Badge situation={find(editor.from)}/>?</p><ul>{editor.items.map(t=><li key={t.to}>{find(t.to)?.name??t.to}</li>)}</ul>
   <p className="real-help">Transições padrão não aparecem aqui: elas só podem ser desativadas.</p></Modal>}
 </div>;
}
