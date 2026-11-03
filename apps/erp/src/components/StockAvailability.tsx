import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import {stockAvailabilityActor,stockAvailabilitySelection,stockAvailabilityView,type AvailabilityWarehouse} from '../lib/stock-availability';
import './stock-availability.css';

type Controller=Pick<AccessController,'stockReservations'|'getSnapshot'|'subscribe'>;
export interface StockAvailabilityProps{controller:Controller;productId:string;warehouses:readonly AvailabilityWarehouse[];basis:string;blocked?:boolean}
const sessionKey=(controller:Controller)=>{const s=controller.getSnapshot();return `${s.phase}:${s.membership?.user_id??''}:${s.membership?.role??''}`;};
const failure=(error:unknown)=>error instanceof AccessError&&error.status===403?'Seu perfil não permite consultar a disponibilidade.':error instanceof AccessError&&error.status===404?'O produto ou depósito não está disponível para consulta. Atualize os saldos.':'Não foi possível conferir a disponibilidade. Tente consultar novamente.';
const observed=(value:string)=>new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value));

/** One explicit GET. This panel never prepares, reserves, or posts stock. */
export default function StockAvailability({controller,productId,warehouses,basis,blocked=false}:StockAvailabilityProps){
 const uid=useId(),mounted=useRef(true),request=useRef<AbortController|null>(null),fence=useRef(0);
 const [epoch,setEpoch]=useState(0),[warehouse,setWarehouse]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [result,setResult]=useState<{scope:object;warehouse:string;value:ReturnType<typeof stockAvailabilityView>;receivedAt:string}|null>(null);
 const scope=useMemo(()=>({}),[controller,productId,warehouses,basis,blocked,epoch]),actor=stockAvailabilityActor(controller.getSnapshot()),generation=fence.current;
 const live=useRef({controller,scope,warehouse,blocked,actor});live.current={controller,scope,warehouse,blocked,actor};
 const cancel=()=>{request.current?.abort();request.current=null;setBusy(false);setResult(null);setError('');};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();request.current=null;};},[]);
 useEffect(()=>{cancel();live.current.warehouse='';setWarehouse('');},[scope]);
 useEffect(()=>{
  let previous=sessionKey(controller);
  return controller.subscribe(()=>{const next=sessionKey(controller);if(next===previous)return;previous=next;fence.current++;cancel();live.current.warehouse='';setWarehouse('');setEpoch(v=>v+1);});
 },[controller]);
 const allowed=()=>mounted.current&&live.current.controller===controller&&live.current.scope===scope&&fence.current===generation&&!live.current.blocked&&Boolean(actor&&stockAvailabilityActor(controller.getSnapshot())===actor);
 const valid=(r:AbortController,id:string)=>allowed()&&request.current===r&&!r.signal.aborted&&live.current.warehouse===id;
 const consult=async()=>{
  if(!allowed()||request.current||warehouse!==live.current.warehouse)return;
  let selection;try{selection=stockAvailabilitySelection(productId,warehouse,warehouses);}catch{return;}
  const r=new AbortController();request.current=r;setBusy(true);setResult(null);setError('');
  try{const raw=await controller.stockReservations(selection.path,{method:'GET',signal:r.signal});if(!valid(r,selection.warehouseId))return;
   const value=stockAvailabilityView(raw,selection);if(!valid(r,selection.warehouseId))return;
   setResult({scope,warehouse:selection.warehouseId,value,receivedAt:new Date().toISOString()});
  }catch(problem){if(valid(r,selection.warehouseId))setError(failure(problem));}
  finally{if(request.current===r){request.current=null;if(mounted.current)setBusy(false);}}
 };
 if(!actor)return <p className="real-help">Consulta de disponibilidade indisponível nesta sessão.</p>;
 const current=result&&result.scope===scope&&result.warehouse===warehouse&&!blocked?result:null;
 return <section className="stock-availability" aria-labelledby={`${uid}-heading`} aria-busy={busy}>
  <h3 id={`${uid}-heading`}>Disponibilidade por depósito</h3>
  <p className="real-help">Confira o saldo físico, a quantidade reservada em pedidos e o disponível para novas saídas.</p>
  <div className="stock-availability-controls"><div className="form-field"><label htmlFor={`${uid}-warehouse`}>Depósito para consulta</label><select id={`${uid}-warehouse`} value={warehouse} disabled={blocked||!warehouses.length} onChange={event=>{if(!allowed())return;const id=event.target.value;if(id&&!warehouses.some(w=>w.warehouse_id===id))return;cancel();live.current.warehouse=id;setWarehouse(id);}}><option value="">Selecione um depósito</option>{warehouses.map(w=><option key={w.warehouse_id} value={w.warehouse_id}>{w.warehouse_name}{w.warehouse_active?'':' · arquivado'}</option>)}</select></div>
   <button type="button" className="secondary-button" disabled={blocked||busy||!warehouse} onClick={()=>void consult()}>{busy?'Consultando…':'Conferir disponível'}</button>
   {busy&&<button type="button" className="text-button" onClick={()=>{if(allowed())cancel();}}>Cancelar consulta</button>}
  </div>
  {blocked?<p className="real-help">Conclua a edição de estoque antes de conferir a disponibilidade.</p>:busy?<p role="status">Consultando o depósito selecionado…</p>:!current&&<p className="real-help">Disponibilidade não conferida.</p>}
  {!blocked&&error&&<p className="real-alert" role="alert">{error}</p>}
  {current&&<><dl className="stock-availability-values">{([['Físico',current.value.physical],['Reservado',current.value.reserved],['Disponível',current.value.available]] as const).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}{value!=='Não conferido'&&current.value.unit&&<small> {current.value.unit}</small>}</dd></div>)}</dl>
   {current.value.note&&<p className="real-notice">{current.value.note}</p>}<p className="real-help">Consulta recebida em <time dateTime={current.receivedAt}>{observed(current.receivedAt)}</time> (horário de São Paulo). Os saldos podem mudar depois da consulta.</p></>}
 </section>;
}
