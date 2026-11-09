import { lazy, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { AccessState } from '../lib/real-access';
import { fagooError, parseFagooContext, type FagooContext, type FagooPort } from '../lib/fagoo-model';
import NativeModuleBoundary from './NativeModuleBoundary';
import './fagoo-workspace.css';
import FagooHome from './FagooHome';
export { default as FagooHome } from './FagooHome';
const Crm=lazy(()=>import('./FagooCrm'));
const Queues=lazy(()=>import('./FagooQueues'));
const Setup=lazy(()=>import('./FagooSetup'));
const Communication=lazy(()=>import('../../../../workers/communication/web/FagooCommunication'));
export function useFagooContext(controller:Pick<FagooPort,'fagoo'>,state:AccessState){
 const actor=state.phase==='ready'?state.membership?.user_id:null;
 const [result,setResult]=useState<{actor:string;context:FagooContext}|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{setError('');if(!actor){setResult(null);return;}let abort:AbortController|undefined;
  const refresh=()=>{abort?.abort();const request=new AbortController();abort=request;controller.fagoo('/v1/fagoo/context',{signal:request.signal}).then(value=>{if(!request.signal.aborted){const context=parseFagooContext(value,actor);setResult(previous=>previous?.actor===actor&&JSON.stringify(previous.context)===JSON.stringify(context)?previous:{actor,context});setError('');}}).catch(e=>{if(!request.signal.aborted){const status=(e as {status?:number})?.status;if(!(typeof status==='number'&&status>=500)&&!(e instanceof TypeError))setResult(null);setError(fagooError(e));}});};
  refresh();const timer=setInterval(refresh,30000);globalThis.window?.addEventListener?.('fagoo:context-changed',refresh);globalThis.window?.addEventListener?.('focus',refresh);
  return()=>{abort?.abort();clearInterval(timer);globalThis.window?.removeEventListener?.('fagoo:context-changed',refresh);globalThis.window?.removeEventListener?.('focus',refresh);};
 },[controller,actor,state.membership,revision]);
 return {context:result&&result.actor===actor?result.context:null,error,retry:()=>setRevision(v=>v+1)};
}
export default function FagooWorkspace({controller,context,error,retry}:{controller:FagooPort;context:FagooContext|null;error:string;retry:()=>void}){
 const location=useLocation(),params=new URLSearchParams(location.search);
 if(!context)return <section className="real-state-panel"><h1>{error?'Não foi possível carregar seu acesso':'Carregando unidades…'}</h1>{error&&<p role="alert">{error}</p>}<button onClick={retry}>Verificar novamente</button></section>;
 let content;
 if(location.pathname==='/crm')content=<Crm key={context.user_id} controller={controller} context={context}/>;
 else if(location.pathname==='/filas')content=<Queues key={context.user_id} controller={controller} context={context}/>;
 else if(location.pathname==='/configurar')content=<Setup key={context.user_id} controller={controller} context={context}/>;
 else if(location.pathname==='/atendimento'){
  const units=context.units.filter(u=>(u.capabilities.includes('communication.read')||u.capabilities.includes('team.chat')));
  const unit=units.find(u=>u.id===params.get('unit'))??units[0];
  content=unit?<><div className="fagoo-toolbar" aria-label="Unidades de atendimento">{units.map(u=><Link key={u.id} aria-current={u.id===unit.id?'page':undefined} to={`/atendimento?unit=${u.id}&page=${encodeURIComponent(params.get('page')??'overview')}`}>{u.name}</Link>)}</div><Communication key={`${context.user_id}:${unit.id}`} controller={controller} context={context} unitId={unit.id} initialPage={params.get('page')??'overview'}/></>:<section><h1>Atendimento</h1><p>Solicite acesso a uma unidade de atendimento.</p></section>;
 }else content=<><h1>Seu espaço de trabalho</h1><FagooHome context={context}/></>;
 return <NativeModuleBoundary resetKey={`${context.user_id}:${location.pathname}:${params.get('unit')??''}`} label="Carregando área…">{error&&<p role="alert">A conexão precisa ser verificada. {error} <button onClick={retry}>Verificar novamente</button></p>}{content}</NativeModuleBoundary>;
}
