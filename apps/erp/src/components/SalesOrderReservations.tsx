import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import type {DocumentRecord} from '../lib/real-documents-model';
import {quantityText,stockDate} from '../lib/stock-model';
import {STOCK_RESERVATIONS_BASE as BASE,reservationCanRead,reservationCanWrite,reservationPage,reservationPreview,reservationIntent,reservationResult,reservationAvailability,reservationCommandPath,type StockReservationAction,type StockReservationPage,type StockReservationPreview,type StockReservationResult,type StockAvailability,type ReservationIntent,type ReservationPreviewBody} from '../lib/stock-reservations-model';
import './sales-order-reservations.css';
const dayText=(v:string)=>v.split('-').reverse().join('/');
const actionLabel={reserve:'Reservar produtos',release:'Liberar reserva',consume:'Baixar produtos reservados'};
const canReserve=(document:StockReservationPage['current']['document'])=>document.eligible&&document.active_posting_id===null&&['verified','in_progress'].includes(document.status);
const stateLabel={active:'Ativa',released:'Liberada',consumed:'Baixada no estoque'};
const failure=(e:unknown)=>e instanceof AccessError?e.status===403?'Seu perfil não permite esta ação.':e.status===409?'O pedido, a reserva ou os saldos mudaram. Atualize o pedido e confira novamente.':e.status===400?'Confira a data, o motivo, os produtos e o saldo disponível.':'Não foi possível concluir a consulta. Tente novamente.':'Não foi possível conferir a resposta recebida.';
type Attempt={intent:ReservationIntent;ack:StockReservationResult|null;missing:boolean;uncertain:boolean};
export interface SalesOrderReservationsProps{
 controller:Pick<AccessController,'stockReservations'|'getSnapshot'>;record:Pick<DocumentRecord,'id'|'kind'|'version'|'warehouse_id'|'items'>;blocked:boolean;canAct?:()=>boolean;
 onChanged:(version:number)=>Promise<void>|void;onActive:(active:boolean|null)=>void;onBusy:(value:boolean)=>void;onDraft:(value:boolean)=>void;
}
export default function SalesOrderReservations({controller,record,blocked,canAct,onChanged,onActive,onBusy,onDraft}:SalesOrderReservationsProps){
 const uid=useId(),actor=useRef(controller.getSnapshot().membership?.user_id),mounted=useRef(true),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null);
 const callbacks=useRef({onChanged,onActive,onBusy,onDraft});callbacks.current={onChanged,onActive,onBusy,onDraft};
 const [page,setPage]=useState<StockReservationPage|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false);
 const [action,setAction]=useState<StockReservationAction|null>(null),[day,setDay]=useState(''),[reason,setReason]=useState(''),[review,setReview]=useState<StockReservationPreview|null>(null),[confirmed,setConfirmed]=useState(false),[ignored,setIgnored]=useState(false);
 const [result,setResult]=useState<StockReservationResult|null>(null),[pendingVersion,setPendingVersion]=useState(0),[after,setAfter]=useState<string|null>(null),[cursors,setCursors]=useState<(string|null)[]>([]),[reload,setReload]=useState(0);
 const [product,setProduct]=useState(''),[availability,setAvailability]=useState<StockAvailability|null>(null);
 const live=useRef({blocked,canAct,page,stale,action,day,reason,review,confirmed,ignored,product,record});live.current={blocked,canAct,page,stale,action,day,reason,review,confirmed,ignored,product,record};
 const sameActor=()=>mounted.current&&Boolean(actor.current&&controller.getSnapshot().membership?.user_id===actor.current);
 const mayRead=()=>sameActor()&&controller.getSnapshot().phase==='ready'&&reservationCanRead(controller.getSnapshot().membership?.role??'');
 const mayWrite=()=>mayRead()&&reservationCanWrite(controller.getSnapshot().membership?.role??'');
 const draft=Boolean(action||day||reason||review||attempt.current),locked=Boolean(busy||attempt.current),guard=useUnsavedChanges(draft,locked);
 const notify=()=>{callbacks.current.onBusy(Boolean(request.current||attempt.current));callbacks.current.onDraft(Boolean(live.current.action||live.current.day||live.current.reason||live.current.review||attempt.current));};
 const valid=(r:AbortController)=>sameActor()&&!r.signal.aborted&&request.current===r;
 const mayChoose=()=>mayWrite()&&!request.current&&!attempt.current&&!live.current.blocked&&(!live.current.canAct||live.current.canAct())&&!live.current.stale;
 const start=()=>{const r=new AbortController();request.current=r;setBusy(true);setError('');notify();return r;};
 const done=(r:AbortController)=>{if(request.current===r){request.current=null;if(mounted.current)setBusy(false);notify();}};
 const clear=()=>{live.current={...live.current,action:null,day:'',reason:'',review:null,confirmed:false,ignored:false};setAction(null);setDay('');setReason('');setReview(null);setConfirmed(false);setIgnored(false);notify();};
 const changed=()=>{live.current.review=null;live.current.confirmed=false;live.current.ignored=false;setReview(null);setConfirmed(false);setIgnored(false);};
 useLayoutEffect(()=>{notify();},[draft,busy,pendingVersion]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();attempt.current=null;callbacks.current.onBusy(false);callbacks.current.onDraft(false);};},[]);
 const readable=mayRead(),writable=mayWrite();
 useEffect(()=>{
  if(!readable||attempt.current)return;const r=start();setLoading(true);setPage(null);callbacks.current.onActive(null);
  const params=new URLSearchParams({limit:'25'});if(after)params.set('after',after);
  void controller.stockReservations(`${BASE}/pedidos/${record.id}?${params}`,{signal:r.signal}).then(raw=>{
   if(!valid(r))return;const next=reservationPage(raw,record.id,25,after);setPage(next);setStale(next.current.document.version!==record.version);callbacks.current.onActive(Boolean(next.current.active_reservation));
  }).catch(e=>{if(valid(r))setError(failure(e));}).finally(()=>{if(valid(r))setLoading(false);done(r);});
  return()=>{r.abort();done(r);};
 },[controller,record.id,record.version,after,reload,readable]);
 const choose=(value:StockReservationAction)=>{if(!mayChoose()||!live.current.page)return;const current=live.current.page.current;if(value==='reserve'?!canReserve(current.document)||Boolean(current.active_reservation):!current.active_reservation)return;clear();live.current.action=value;setAction(value);setResult(null);notify();};
 const prepare=async()=>{
  const s=live.current;if(!mayChoose()||!s.page||!s.action||s.review)return;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s.day)||!Number.isFinite(Date.parse(s.day))||new Date(s.day+'T00:00:00Z').toISOString().slice(0,10)!==s.day||s.day<s.page.current.document.date||s.day>stockDate()||s.reason.trim().length<3||[...s.reason].length>500||/[\x00-\x1f\x7f]/.test(s.reason)){setError('Informe uma data válida e um motivo com pelo menos três caracteres.');return;}
  const active=s.action==='reserve'?null:s.page.current.active_reservation;if(s.action!=='reserve'&&!active)return;
  const body:ReservationPreviewBody={expected_document_version:s.page.current.document.version,occurred_on:s.day,reason:s.reason.trim(),...(active?{expected_reservation_version:active.version}:{})};
  const path=`${BASE}/pedidos/${record.id}/${active?`${active.id}/${s.action}-preview`:'preview'}`,r=start();
  try{const raw=await controller.stockReservations(path,{method:'POST',body,signal:r.signal});if(!valid(r))return;const preview=reservationPreview(raw,record.id,s.action,body,active?.id??null);live.current.review=preview;setReview(preview);setConfirmed(false);setIgnored(false);}
  catch(e){if(valid(r)){if(e instanceof AccessError&&e.status===409)setStale(true);setError(failure(e));}}finally{done(r);}
 };
 const readCommand=async(r:AbortController,a:Attempt)=>{
  if(!mayRead())return;
  let raw;try{raw=await controller.stockReservations(reservationCommandPath(a.intent),{signal:r.signal});}
  catch(e){if(valid(r)&&e instanceof AccessError&&e.status===404&&!a.ack){a.missing=true;setPendingVersion(x=>x+1);setError('O comando ainda não foi localizado. Você pode consultar novamente ou reenviar exatamente a mesma confirmação.');return;}throw e;}
  if(!valid(r)||attempt.current!==a)return;const current=reservationResult(raw,a.intent,true);a.ack=current;a.missing=false;setResult(current);setPendingVersion(x=>x+1);
  if(!mayRead())return;await callbacks.current.onChanged(current.current.document.version);
  if(!valid(r)||!mayRead())return;setPage(p=>p?{...p,current:current.current}:p);callbacks.current.onActive(Boolean(current.current.active_reservation));attempt.current=null;clear();setStale(current.current.document.version!==live.current.record.version);setError('');setAvailability(null);setAfter(null);setCursors([]);setReload(x=>x+1);
 };
 const consult=async()=>{
  if(!mayRead()||request.current||!attempt.current)return;const a=attempt.current,r=start();
  try{await readCommand(r,a);}catch(e){if(valid(r)){a.missing=false;setError(a.ack?'Registro confirmado. Consulte novamente para atualizar o pedido.':'O resultado continua sem confirmação. Consulte este mesmo comando; a intenção foi preservada.');}}finally{done(r);}
 };
 const send=async(a:Attempt,retry=false)=>{
  if(!mayWrite()||request.current||attempt.current!==a||retry&&(!a.uncertain||!a.missing||a.ack))return;
  const wasUncertain=a.uncertain;a.missing=false;const r=start();
  try{
   const raw=await controller.stockReservations(a.intent.path,{method:'POST',body:a.intent.body,signal:r.signal});if(!valid(r))return;
   a.ack=reservationResult(raw,a.intent);a.uncertain=false;setResult(a.ack);setPendingVersion(x=>x+1);await readCommand(r,a);
  }catch(e){if(valid(r)){
   const closed=!wasUncertain&&!a.ack&&e instanceof AccessError&&[400,403,404,409,422].includes(e.status);
   if(closed){attempt.current=null;changed();setStale(e.status===409);setError(failure(e));}
   else{a.uncertain=true;a.missing=false;setError(a.ack?'Registro confirmado. Falta consultar o resultado e atualizar o pedido.':'Não foi possível confirmar o resultado. Consulte o comando antes de qualquer reenvio.');}
   setPendingVersion(x=>x+1);
  }}finally{done(r);}
 };
 const confirm=()=>{
  const s=live.current;if(!mayChoose()||!s.review)return;
  try{const intent=reservationIntent({id:record.id,version:record.version},s.review,crypto.randomUUID(),s.confirmed,s.ignored);const a={intent,ack:null,missing:false,uncertain:false};attempt.current=a;notify();setPendingVersion(x=>x+1);void send(a);}catch{setError('Confira a prévia e as confirmações antes de continuar.');}
 };
 const refresh=async()=>{if(!mayRead()||request.current||attempt.current||live.current.action)return;const r=start();try{await callbacks.current.onChanged(live.current.page?.current.document.version??record.version);if(valid(r)){setReload(x=>x+1);setAvailability(null);}}catch(e){if(valid(r))setError(failure(e));}finally{done(r);}};
 const consultAvailability=async()=>{
  if(!mayRead()||request.current||attempt.current||!live.current.product||!record.warehouse_id)return;const selected=live.current.product,warehouse=record.warehouse_id,r=start();setAvailability(null);
  try{const raw=await controller.stockReservations(`${BASE}/disponibilidade?${new URLSearchParams({product_id:selected,warehouse_id:warehouse})}`,{signal:r.signal});if(valid(r))setAvailability(reservationAvailability(raw,selected,warehouse));}catch(e){if(valid(r))setError(failure(e));}finally{done(r);}
 };
 const active=page?.current.active_reservation,currentAttempt=attempt.current,disabled=!mayChoose()||loading,products=[...new Map(record.items.filter(i=>i.product_id).map(i=>[i.product_id!,i])).values()];
 if(!sameActor())return null;
 return <><p className="real-notice" hidden={readable}>Seu perfil não permite consultar as reservas. A tentativa desta sessão será preservada até o acesso ser restabelecido.</p><section className="document-section sales-order-reservations" hidden={!readable} inert={!readable} aria-hidden={!readable} aria-labelledby={`${uid}-title`} aria-busy={busy||loading}>
  <div className="reservation-heading"><h3 id={`${uid}-title`}>Reserva de estoque do pedido</h3>{active&&<span className="status-badge status-success">Reserva ativa</span>}</div>
  <p className="real-help">Reserve os produtos do pedido salvo para protegê-los de outras saídas. A reserva mantém o saldo físico; a baixa dos produtos é uma confirmação separada.</p>
  {error&&<p role="alert" className="real-alert">{error}</p>}{loading&&<p role="status">Consultando reservas…</p>}
  {blocked&&<p className="real-notice">Conclua as alterações ou conferências abertas antes de reservar, liberar ou baixar produtos.</p>}
  {currentAttempt?<div className="real-notice"><p>{currentAttempt.ack?'O registro foi confirmado. Falta consultar a situação atual do pedido.':'O resultado desta confirmação ainda precisa ser consultado.'}</p><p className="reservation-command">Comando: {currentAttempt.intent.body.command_id}</p><p className="real-help">Mantenha esta aba aberta. A tentativa local não sobrevive à recarga; o histórico do pedido mostra as reservas registradas.</p><button type="button" className="primary-button" disabled={busy||!readable} onClick={()=>void consult()}>Consultar resultado</button>{currentAttempt.missing&&!currentAttempt.ack&&<button type="button" className="secondary-button" disabled={busy||!writable} onClick={()=>void send(currentAttempt,true)}>Reenviar a mesma confirmação</button>}</div>
   :<button type="button" className="text-button" disabled={busy||loading||draft||!readable} onClick={()=>void refresh()}>Atualizar pedido e reservas</button>}
  {stale&&!currentAttempt&&<p className="real-notice">A versão salva mudou. Atualize o pedido antes de preparar uma nova ação.</p>}
  {active&&<p className="real-help">Os itens e o depósito estão protegidos enquanto esta reserva estiver ativa. Liberar não movimenta estoque; baixar registra a saída integral. Um estorno posterior não reativa a reserva.</p>}
  {page&&!loading&&!action&&!currentAttempt&&writable&&<div className="real-editor-actions">{active?<><button type="button" className="secondary-button" disabled={disabled} onClick={()=>choose('release')}>Liberar reserva</button><button type="button" className="primary-button" disabled={disabled} onClick={()=>choose('consume')}>Baixar produtos reservados</button></>:canReserve(page.current.document)?<button type="button" className="primary-button" disabled={disabled} onClick={()=>choose('reserve')}>Reservar produtos</button>:<p className="real-help">Para reservar, o pedido precisa estar verificado ou em andamento e sem lançamento de estoque ativo.</p>}</div>}
  {action&&!currentAttempt&&!review&&<><fieldset disabled={disabled}><legend>{actionLabel[action]}</legend><label htmlFor={`${uid}-day`}>Data<input id={`${uid}-day`} type="date" min={page?.current.document.date} max={stockDate()} value={day} onChange={e=>{if(!mayChoose())return;live.current.day=e.target.value;setDay(e.target.value);changed();notify();}}/></label><label htmlFor={`${uid}-reason`}>Motivo<input id={`${uid}-reason`} value={reason} maxLength={500} onChange={e=>{if(!mayChoose())return;live.current.reason=e.target.value;setReason(e.target.value);changed();notify();}}/></label></fieldset><div className="real-editor-actions"><button type="button" className="primary-button" disabled={disabled} onClick={()=>void prepare()}>Conferir {action==='reserve'?'reserva':action==='release'?'liberação':'baixa'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(!mayRead()||request.current||attempt.current)return;guard.confirmLeave(clear);}}>Cancelar conferência</button></div></>}
  {review&&!currentAttempt&&<section className="reservation-review" aria-label="Prévia da reserva"><h4>{actionLabel[review.action]}</h4><p className="real-help">Saldos na conferência: atual → previsto.</p><p>Pedido {review.document.number} · {dayText(review.occurred_on)} · {review.reason}</p><div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>Produto</th><th>Quantidade</th><th>Físico</th><th>Reservado</th><th>Disponível</th></tr></thead><tbody>{review.positions.map(row=><tr key={row.product_id}><td>{row.product_name}</td><td>{quantityText(row.quantity)} {row.unit}</td><td>{quantityText(row.physical_before)} → {quantityText(row.physical_after)}</td><td>{quantityText(row.reserved_before)} → {quantityText(row.reserved_after)}</td><td>{quantityText(row.available_before)} → {quantityText(row.available_after)}</td></tr>)}</tbody></table></div>
   {review.ignored.length>0&&<><h5>Itens sem movimentação de estoque</h5><ul>{review.ignored.map(i=><li key={i.id}>{i.position}. {i.description} — {i.reason==='service'?'Serviço':'Sem produto vinculado'}</li>)}</ul>{review.action==='reserve'&&<label className="document-check"><input type="checkbox" checked={ignored} disabled={disabled} onChange={e=>{if(!mayChoose())return;live.current.ignored=e.target.checked;setIgnored(e.target.checked);}}/>Conferi os itens que ficarão fora da reserva.</label>}</>}
   <label className="document-check"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={e=>{if(!mayChoose())return;live.current.confirmed=e.target.checked;setConfirmed(e.target.checked);}}/>{review.action==='consume'?'Conferi os produtos e autorizo a saída integral do estoque.':review.action==='release'?'Conferi e autorizo a liberação integral da reserva.':'Conferi os produtos e autorizo a reserva integral.'}</label><div className="real-editor-actions"><button type="button" className="primary-button" disabled={disabled||!confirmed||review.action==='reserve'&&review.ignored.length>0&&!ignored} onClick={confirm}>Confirmar {review.action==='reserve'?'reserva':review.action==='release'?'liberação':'baixa'}</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(mayChoose())changed();}}>Voltar à conferência</button></div></section>}
  {result&&<div className="real-success" role="status"><strong>{result.receipt.action==='reserve'?'Reserva registrada':result.receipt.action==='release'?'Liberação registrada':'Saída de estoque registrada'}.</strong><p>Recibo da versão {result.receipt.document_version}; situação atual da reserva: {result.current.active_reservation?.id===result.receipt.reservation.id?'Ativa':result.receipt.reservation.state==='active'?'Sem reserva ativa correspondente':stateLabel[result.receipt.reservation.state]}.</p></div>}
  {products.length>0&&record.warehouse_id&&<details className="reservation-availability"><summary>Consultar saldo atual de um produto</summary><label htmlFor={`${uid}-product`}>Produto do pedido<select id={`${uid}-product`} value={product} disabled={busy||Boolean(currentAttempt)} onChange={e=>{if(!mayRead()||request.current||attempt.current)return;live.current.product=e.target.value;setProduct(e.target.value);setAvailability(null);}}><option value="">Selecione um produto</option>{products.map(i=><option key={i.product_id} value={i.product_id!}>{i.description}</option>)}</select></label><button type="button" className="secondary-button" disabled={busy||Boolean(currentAttempt)||!product} onClick={()=>void consultAvailability()}>Consultar saldo</button>{availability&&<><dl className="reservation-balances"><div><dt>Físico</dt><dd>{availability.position.physical_quantity===null?'Não conferido':quantityText(availability.position.physical_quantity)}</dd></div><div><dt>Reservado</dt><dd>{quantityText(availability.position.reserved_quantity)}</dd></div><div><dt>Disponível</dt><dd>{availability.position.available_quantity===null?'Não conferido':quantityText(availability.position.available_quantity)}</dd></div></dl>{availability.position.state!=='recorded'&&<p className="real-help">{availability.position.state==='no_movements'?'Não há lançamentos deste produto no depósito. Ausência de saldo não significa estoque zero.':'O saldo precisa de revisão antes de uma nova ação.'}</p>}</>}</details>}
  {page&&<><h4>Histórico de reservas</h4>{currentAttempt?<p className="real-help">Consulte o resultado para atualizar o histórico.</p>:!page.items.length?<p className="real-help">Nenhuma reserva registrada neste pedido.</p>:<div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>Data</th><th>Situação</th><th>Produtos</th><th>Motivo</th></tr></thead><tbody>{page.items.map(row=><tr key={row.id}><td>{dayText(row.occurred_on)}</td><td>{stateLabel[row.state]}</td><td>{row.positions_count}</td><td>{row.reason}{row.close_reason&&<small>{row.close_reason}</small>}</td></tr>)}</tbody></table></div>}<div className="real-pagination"><span>Página {cursors.length+1}</span><button type="button" className="text-button" disabled={locked||draft||loading||!cursors.length} onClick={()=>{if(!mayRead()||request.current||attempt.current||live.current.action)return;setAfter(cursors.at(-1)??null);setCursors(v=>v.slice(0,-1));}}>Página anterior</button><button type="button" className="text-button" disabled={locked||draft||loading||!page.has_more} onClick={()=>{if(!mayRead()||request.current||attempt.current||live.current.action)return;setCursors(v=>[...v,after]);setAfter(page.next_cursor);}}>Próxima página</button></div></>}
 </section></>;
}
