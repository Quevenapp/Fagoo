import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import type {CompanyAccess} from '../lib/origin-menu';
import {HOME_LABEL_MAX,HOME_MAX_SHORTCUTS,HOME_SHORTCUTS_PATH,homeShortcutBase} from '../lib/home-request';
import {homeFavoriteLabel,homeShortcutOptions,homeShortcutsResult,type HomeController,type HomeShortcuts} from '../lib/home-model';
import {Icon} from './Icon';

type Command={command_id:string;expected_version:number;shortcuts:string[];labels?:Record<string,string>};
// Origin "Link": a Brufap address of this site (same origin) or a path; the origin is dropped, the rest is checked as the server does.
export function favoriteTarget(text:string,origin=globalThis.location?.origin??''){const value=text.trim();return origin&&value.startsWith(origin)?value.slice(origin.length):value;}
const aborted=(failure:unknown)=>failure instanceof DOMException&&failure.name==='AbortError';

// Origin "Atalhos favoritos": botão verde "+" adiciona, "x" remove. A lista pertence ao usuário e fica no
// servidor; cada alteração é um comando idempotente com versão esperada. Resultado incerto → "Conferir resultado".
// Escolher a tela não grava nada: só "Adicionar" envia (setas do teclado num select disparam change).
// 189: Origin "Adicionar atalho" with Nome and Link; the link is a menu screen, possibly with more filters (then Nome is required).
export function HomeFavorites({controller,access}:{controller:HomeController;access:CompanyAccess|null}){
  const [state,setState]=useState<HomeShortcuts|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[reload,setReload]=useState(0);
  const [picking,setPicking]=useState(false),[choice,setChoice]=useState(''),[name,setName]=useState(''),[link,setLink]=useState(''),[pending,setPending]=useState<(Command&{uncertain:boolean})|null>(null),[saving,setSaving]=useState(false),[message,setMessage]=useState('');
  const save=useRef<AbortController|null>(null),addButton=useRef<HTMLButtonElement|null>(null),pickerId=useId(),selectId=useId(),nameId=useId(),linkId=useId();
  useUnsavedChanges(pending?.uncertain===true,saving);
  useEffect(()=>{
    const request=new AbortController();setLoading(true);setLoadError('');
    void controller.home(HOME_SHORTCUTS_PATH,{signal:request.signal}).then(value=>{
      if(request.signal.aborted)return;setState(homeShortcutsResult(value));setLoading(false);
    }).catch(failure=>{
      if(request.signal.aborted||aborted(failure))return;
      setState(null);setLoading(false);setLoadError(failure instanceof AccessError&&failure.status===403?'Seu acesso aos atalhos precisa ser verificado.':'Não foi possível carregar os atalhos favoritos.');
    });
    return()=>request.abort();
  },[controller,reload]);
  useEffect(()=>()=>save.current?.abort(),[]);
  const options=useMemo(()=>state?homeShortcutOptions(state.available,access):[],[state,access]);
  const labels=state?.labels??{};
  const favorites=state?state.shortcuts.flatMap(to=>{const label=homeFavoriteLabel(to,labels,options);return label?[{to,label}]:[];}):[];
  const addable=options.filter(option=>!state?.shortcuts.includes(option.to));
  const target=favoriteTarget(link),base=homeShortcutBase(target),baseOption=options.find(option=>option.to===base),typedName=name.trim();
  const linkProblem=!link.trim()?'':!baseOption?'Informe uma tela do FAGOO que o seu perfil abre (por exemplo, /documentos-empresa?tipo=sales_orders).':state?.shortcuts.includes(target)?'Este atalho já está nos favoritos.'
   :target!==base&&!typedName?'Dê um nome ao atalho com filtros.':'';
  const canAdd=Boolean(baseOption)&&!linkProblem&&[...typedName].length<=HOME_LABEL_MAX;
  // While the list reloads no command is sent: a read started before a save could otherwise replace the newer list.
  const blocked=!state||loading||saving||pending!==null;
  const send=(command:Command)=>{
    save.current?.abort();const request=new AbortController();save.current=request;
    setSaving(true);setMessage('');setPending({...command,uncertain:false});
    void controller.home(HOME_SHORTCUTS_PATH,{method:'POST',body:command,signal:request.signal}).then(value=>{
      if(request.signal.aborted)return;
      const result=homeShortcutsResult(value,{version:command.expected_version+1,shortcuts:command.shortcuts,labels:command.labels??{}});
      setState(result);setPending(null);setSaving(false);setMessage(result.replayed?'Resultado conferido: os atalhos já estavam salvos.':'Atalhos salvos.');
    }).catch(failure=>{
      if(request.signal.aborted||aborted(failure))return;
      setSaving(false);
      if(failure instanceof AccessError&&[400,403,409].includes(failure.status)){
        setPending(null);setReload(value=>value+1);
        setMessage(failure.status===409?'Os atalhos foram alterados em outra sessão. A lista foi recarregada.':failure.status===403?'Seu perfil não permite salvar este atalho. A lista foi recarregada.':'Não foi possível salvar este atalho. A lista foi recarregada.');
        return;
      }
      setPending({...command,uncertain:true});setMessage('Não foi possível confirmar se os atalhos foram salvos. Confira o resultado antes de alterar novamente.');
    }).finally(()=>{if(save.current===request)save.current=null;});
  };
  // Names follow their favorites: removing a favorite drops its name.
  const commit=(shortcuts:string[],names:Record<string,string>=labels)=>{if(blocked||!state)return;const kept=Object.fromEntries(Object.entries(names).filter(([to])=>shortcuts.includes(to)));
    send({command_id:crypto.randomUUID(),expected_version:state.version,shortcuts,...(Object.keys(kept).length?{labels:kept}:{})});};
  const closePicker=()=>{setPicking(false);setChoice('');setName('');setLink('');addButton.current?.focus();};
  const add=()=>{if(!state||!canAdd||!baseOption||state.shortcuts.length>=HOME_MAX_SHORTCUTS)return;const own=typedName&&!(target===base&&typedName===baseOption.label)?typedName:null;
    setPicking(false);setChoice('');setName('');setLink('');commit([...state.shortcuts,target],own?{...labels,[target]:own}:labels);};
  const groups=[...new Set(addable.map(option=>option.group))];
  return <section className="home-favorites-panel" aria-label="Atalhos favoritos">
    <h2><Icon name="bookmark" size={13}/>Atalhos favoritos
      <button type="button" ref={addButton} className="home-favorite-add" title="Adicionar atalho" aria-label="Adicionar atalho" aria-expanded={picking} aria-controls={picking?pickerId:undefined}
        disabled={!state||blocked||addable.length===0||state.shortcuts.length>=HOME_MAX_SHORTCUTS} onClick={()=>{setChoice('');setPicking(value=>!value);}}><Icon name="plus" size={11}/></button></h2>
    {picking&&!blocked&&<div className="home-favorite-picker" id={pickerId} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();closePicker();}}}>
      <label htmlFor={nameId}>Nome</label>
      <input id={nameId} placeholder="Digite o nome do atalho" maxLength={HOME_LABEL_MAX} value={name} onChange={event=>setName(event.target.value)}/>
      <label htmlFor={linkId}>Link <span className="home-favorite-hint" title="Endereço de uma tela do FAGOO, com os filtros que quiser. Ex.: /documentos-empresa?tipo=sales_orders&situacao=open"><Icon name="circle-info" size={10}/></span></label>
      <input id={linkId} placeholder="URL do destino" maxLength={260} value={link} aria-invalid={Boolean(linkProblem)||undefined} onChange={event=>{setLink(event.target.value);setChoice('');}}/>
      {linkProblem&&<small className="real-help" role="alert">{linkProblem}</small>}
      <label htmlFor={selectId}>Escolha uma tela</label>
      <select id={selectId} value={choice} autoFocus onChange={event=>{setChoice(event.target.value);setLink(event.target.value);}}>
        <option value="" disabled>Selecione</option>
        {groups.map(group=><optgroup key={group} label={group}>{addable.filter(option=>option.group===group).map(option=><option key={option.to} value={option.to}>{option.label}</option>)}</optgroup>)}
      </select>
      <div className="home-favorite-picker-actions"><button type="button" className="secondary-button" onClick={closePicker}>Cancelar</button>
        <button type="button" className="primary-button" disabled={!canAdd} onClick={add}>Adicionar</button></div>
    </div>}
    {loading?<p className="real-result-status" role="status">Carregando atalhos…</p>
      :loadError?<div className="home-favorites-error"><p className="real-alert" role="alert">{loadError}</p><button type="button" className="secondary-button" onClick={()=>setReload(value=>value+1)}>Tentar novamente</button></div>
      :favorites.length===0?<p className="home-favorites-empty">Adicione as telas que você mais usa.</p>
      :<nav aria-label="Atalhos favoritos"><ul className="home-favorites">{favorites.map(favorite=><li key={favorite.to}>
        <Link to={favorite.to}><Icon name="bookmark" size={12}/>{favorite.label}</Link>
        <button type="button" className="home-favorite-remove" title="Remover atalho" aria-label={`Remover atalho ${favorite.label}`} disabled={blocked}
          onClick={()=>{if(state)commit(state.shortcuts.filter(to=>to!==favorite.to));}}><Icon name="xmark" size={10}/></button>
      </li>)}</ul></nav>}
    {saving&&<p className="real-result-status" role="status">Salvando atalhos…</p>}
    {message&&!saving&&<p className={pending?.uncertain?'real-alert':'home-favorites-message'} role={pending?.uncertain?'alert':'status'}>{message}</p>}
    {pending?.uncertain&&!saving&&<button type="button" className="secondary-button" onClick={()=>send({command_id:pending.command_id,expected_version:pending.expected_version,shortcuts:pending.shortcuts,...(pending.labels?{labels:pending.labels}:{})})}>Conferir resultado</button>}
  </section>;
}
