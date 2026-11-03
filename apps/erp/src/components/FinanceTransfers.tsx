import {useEffect,useRef,useState,type FormEvent} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {financeDate,financeMoney,todaySP,type FinanceAccount} from '../lib/real-finance-model';
import {TRANSFERS_BASE,transferAccountEnvelope,transferAccountPage,transferBody,transferPage,transferResult,type TransferBody,type TransferPage,type TransferReceipt,type TransferResult} from '../lib/finance-transfers-model';
import './finance-transfers.css';

type Controller=Pick<AccessController,'finance'|'financeTransfers'|'getSnapshot'>;
type Values={amount:string;posted_on:string;note:string};
type Review={from:FinanceAccount;to:FinanceAccount;body:TransferBody};
type Attempt={actor:string;body:TransferBody;ack:TransferReceipt|null;uncertain:boolean;mayRetry:boolean};
const EMPTY:Values={amount:'',posted_on:'',note:''};
const READ=['admin','financeiro','consulta'],WRITE=['admin','financeiro'];
const PREVIEW_ID='00000000-0000-0000-0000-000000000000';
const failureMessage=(error:unknown)=>error instanceof AccessError&&error.status===409?'Uma das contas mudou. Confira novamente os saldos antes de confirmar.':error instanceof AccessError&&error.status===403?'Seu perfil não permite esta operação.':error instanceof AccessError&&error.status===404?'O registro não foi encontrado. Atualize a consulta.':error instanceof AccessError&&error.status===400?'Confira as contas, o valor, a data e o histórico da transferência.':'Não foi possível concluir a consulta. Tente novamente.';
const sameActor=(controller:Controller,actor:string,write=false)=>{const state=controller.getSnapshot();return state.phase==='ready'&&state.membership?.user_id===actor&&(write?WRITE:READ).includes(state.membership.role);};

function AccountPicker({controller,actor,label,prefix,value,disabled,onChange}:{controller:Controller;actor:string;label:string;prefix:string;value:FinanceAccount|null;disabled:boolean;onChange:(value:FinanceAccount|null)=>void}){
 const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[after,setAfter]=useState<string|null>(null),[cursors,setCursors]=useState<(string|null)[]>([]);
 const [page,setPage]=useState<ReturnType<typeof transferAccountPage>|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[tick,setTick]=useState(0);
 const live=useRef({disabled,value,loading,page,after,cursors});live.current={disabled,value,loading,page,after,cursors};
 const mayEdit=()=>!live.current.disabled&&sameActor(controller,actor,true);
 useEffect(()=>{
  if(value||disabled)return;
  const request=new AbortController();setPage(null);setLoading(true);setError('');
  const params=new URLSearchParams({limit:'25',q:search});if(after)params.set('after',after);
  void controller.finance(`/v1/financeiro/accounts?${params}`,{signal:request.signal}).then(raw=>{
   if(!request.signal.aborted&&sameActor(controller,actor,true)){setPage(transferAccountPage(raw,after));setLoading(false);}
  }).catch(error=>{if(!request.signal.aborted&&sameActor(controller,actor,true)){setError(failureMessage(error));setLoading(false);}});
  return()=>request.abort();
 },[controller,actor,value,disabled,search,after,tick]);
 const lookup=()=>{if(!mayEdit())return;setSearch(query.trim());setAfter(null);setCursors([]);setTick(v=>v+1);};
 const options=page?.items.filter(account=>account.active)??[];
 return <fieldset className="transfer-account-picker" disabled={disabled}><legend>{label}</legend>{value?<div className="transfer-selected"><strong>{value.name}</strong><button type="button" className="text-button" onClick={()=>{if(mayEdit()){onChange(null);setAfter(null);setCursors([]);}}}>Trocar {label.toLowerCase()}</button></div>:<>
  <div className="transfer-search"><label htmlFor={`${prefix}-query`} className="real-sr-only">Pesquisar {label.toLowerCase()}</label><input id={`${prefix}-query`} type="search" value={query} maxLength={120} placeholder="Nome da conta" onChange={event=>{if(mayEdit())setQuery(event.target.value);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();lookup();}}}/><button type="button" className="secondary-button" onClick={lookup}>Buscar</button></div>
  {error&&<p role="alert" className="real-alert">{error} <button type="button" className="text-button" onClick={lookup}>Tentar novamente</button></p>}
  <div className="transfer-account-options" aria-live="polite">{loading?<p>Consultando contas…</p>:options.length?options.map(account=><button type="button" key={account.id} onClick={()=>{if(mayEdit()&&!live.current.loading&&live.current.page?.items.some(a=>a.id===account.id&&a.active))onChange(account);}}>{account.name}</button>):!error&&<p>Nenhuma conta ativa nesta página.</p>}</div>
  {page&&<div className="transfer-pagination"><span>Página {cursors.length+1}</span><button type="button" className="text-button" disabled={loading||!cursors.length} onClick={()=>{const s=live.current;if(mayEdit()&&!s.loading&&s.cursors.length){setAfter(s.cursors.at(-1)??null);setCursors(s.cursors.slice(0,-1));}}}>Contas anteriores</button><button type="button" className="text-button" disabled={loading||!page.has_more} onClick={()=>{const s=live.current;if(mayEdit()&&!s.loading&&s.page?.has_more){setAfter(s.page.next_cursor);setCursors([...s.cursors,s.after]);}}}>Mais contas</button></div>}
 </>}</fieldset>;
}

function TransferDetail({value}:{value:TransferResult}){
 const {receipt:r,current:c}=value;
 return <section className="transfer-detail" aria-labelledby="transfer-receipt-title"><h2 id="transfer-receipt-title">Transferência registrada</h2><p>Registro interno de {financeMoney(r.amount_cents)} em {financeDate(r.posted_on)}. Nenhum dinheiro foi enviado ao banco pelo FAGOO.</p>
  <dl className="transfer-facts"><div><dt>Saída</dt><dd>{r.from_account.name}</dd></div><div><dt>Entrada</dt><dd>{r.to_account.name}</dd></div><div><dt>Histórico</dt><dd className="transfer-note">{r.note}</dd></div></dl>
  <h3>Saldos capturados no registro</h3><div className="transfer-scroll" tabIndex={0} role="region" aria-label="Saldos capturados na transferência"><table className="data-table"><thead><tr><th>Conta</th><th className="numeric">Antes</th><th className="numeric">Depois</th></tr></thead><tbody>{[r.from_account,r.to_account].map(a=><tr key={a.id}><td>{a.name}</td><td className="numeric">{financeMoney(a.balance_before_cents)}</td><td className="numeric">{financeMoney(a.balance_after_cents)}</td></tr>)}</tbody></table></div>
  <h3>Saldos atuais consultados</h3><p className="real-help">Podem incluir outros lançamentos posteriores. São saldos registrados no FAGOO, sem conciliação bancária automática.</p><dl className="transfer-facts">{[c.from_account,c.to_account].map(a=><div key={a.id}><dt>{a.name}{!a.active?' · arquivada':''}</dt><dd>{financeMoney(a.balance_cents)}</dd></div>)}</dl>
 </section>;
}

export default function FinanceTransfers({controller,onBack}:{controller:Controller;onBack:()=>void}){
 const auth=controller.getSnapshot(),actor=auth.phase==='ready'?auth.membership?.user_id??'':'',role=auth.phase==='ready'?auth.membership?.role??'':'';
 const readable=Boolean(actor&&READ.includes(role)),writable=Boolean(actor&&WRITE.includes(role));
 const [mode,setMode]=useState<'list'|'form'|'detail'>('list'),[page,setPage]=useState<TransferPage|null>(null),[detail,setDetail]=useState<TransferResult|null>(null);
 const [after,setAfter]=useState<string|null>(null),[cursors,setCursors]=useState<(string|null)[]>([]),[tick,setTick]=useState(0),[loading,setLoading]=useState(false);
 const [from,setFrom]=useState<FinanceAccount|null>(null),[to,setTo]=useState<FinanceAccount|null>(null),[values,setValues]=useState<Values>({...EMPTY}),[review,setReview]=useState<Review|null>(null);
 const [busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retryAvailable,setRetryAvailable]=useState(false);
 const pending=useRef<AbortController|null>(null),listRequest=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),scope=useRef(actor),listEpoch=useRef(0);
 const locked=busy||unresolved,dirty=mode==='form'&&Boolean(from||to||values.amount||values.posted_on||values.note||review);
 const guard=useUnsavedChanges(dirty,locked);
 const latest=useRef({actor,mode,values,from,to,review,loading,page,after,cursors});latest.current={actor,mode,values,from,to,review,loading,page,after,cursors};
 const alive=useRef(true);
 const active=(request:AbortController,expectedActor=actor)=>alive.current&&!request.signal.aborted&&latest.current.actor===expectedActor&&sameActor(controller,expectedActor);
 const free=()=>!attempt.current&&!pending.current&&sameActor(controller,actor);
 const mayEdit=()=>free()&&sameActor(controller,actor,true)&&latest.current.mode==='form'&&!latest.current.review;
 const resetForm=()=>{setFrom(null);setTo(null);setValues({...EMPTY});setReview(null);setRetryAvailable(false);};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;pending.current?.abort();listRequest.current?.abort();listEpoch.current++;};},[]);
 useEffect(()=>{
  if(scope.current===actor)return;
  scope.current=actor;pending.current?.abort();listRequest.current?.abort();pending.current=null;attempt.current=null;listEpoch.current++;
  resetForm();setMode('list');setPage(null);setDetail(null);setAfter(null);setCursors([]);setBusy(false);setUnresolved(false);setError('');setNotice('');
 },[actor]);
 useEffect(()=>{
  if(!readable||mode!=='list')return;
  const request=new AbortController(),epoch=++listEpoch.current;listRequest.current?.abort();listRequest.current=request;setPage(null);setLoading(true);setError('');
  const cursor=scope.current===actor?after:null;
  void controller.financeTransfers(`${TRANSFERS_BASE}?limit=25${cursor?`&after=${cursor}`:''}`,{signal:request.signal}).then(raw=>{
   if(active(request)&&epoch===listEpoch.current){setPage(transferPage(raw,cursor));setLoading(false);}
  }).catch(failure=>{if(active(request)&&epoch===listEpoch.current){setError(failureMessage(failure));setLoading(false);}});
  return()=>request.abort();
 },[controller,actor,role,readable,mode,after,tick]);
 const start=()=>{if(!free()||!sameActor(controller,actor,true))return;listRequest.current?.abort();listEpoch.current++;resetForm();setDetail(null);setError('');setNotice('');setMode('form');};
 const list=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;resetForm();setDetail(null);setError('');setNotice('');setAfter(null);setCursors([]);setMode('list');setTick(v=>v+1);});};
 const back=()=>{if(!free())return;guard.confirmLeave(()=>{if(free())onBack();});};
 const update=(name:keyof Values,value:string)=>{if(!mayEdit())return;setValues(v=>({...v,[name]:value}));setError('');};
 const select=(side:'from'|'to',account:FinanceAccount|null)=>{if(!mayEdit())return;(side==='from'?setFrom:setTo)(account);setError('');};
 const preview=async(event:FormEvent)=>{
  event.preventDefault();if(!mayEdit())return;const state=latest.current;
  if(!state.from||!state.to){setError('Selecione as contas de saída e entrada.');return;}
  const input={...state.values},fromId=state.from.id,toId=state.to.id;
  try{transferBody(state.from,state.to,input,PREVIEW_ID);}catch(failure){setError(failure instanceof Error?failure.message:'Confira os dados.');return;}
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setNotice('');
  try{
   const [a,b]=await Promise.all([controller.finance(`/v1/financeiro/accounts/${fromId}`,{signal:request.signal}),controller.finance(`/v1/financeiro/accounts/${toId}`,{signal:request.signal})]);
   if(!active(request)||!sameActor(controller,actor,true))return;
   const fromNow=transferAccountEnvelope(a,fromId),toNow=transferAccountEnvelope(b,toId),body=transferBody(fromNow,toNow,input,PREVIEW_ID);
   setReview({from:fromNow,to:toNow,body:Object.freeze(body)});
  }catch(failure){if(active(request))setError(failureMessage(failure));}
  finally{if(pending.current===request){pending.current=null;if(alive.current)setBusy(false);}}
 };
 const finish=(result:TransferResult)=>{
  attempt.current=null;setUnresolved(false);setRetryAvailable(false);setDetail(result);resetForm();setMode('detail');setNotice('Transferência confirmada e consultada.');setError('');setPage(null);setAfter(null);setCursors([]);
 };
 const readCommand=async(operation:Attempt,request:AbortController)=>{
  const raw=await controller.financeTransfers(`${TRANSFERS_BASE}/commands/${operation.body.command_id}`,{signal:request.signal});
  if(!active(request,operation.actor))return;
  finish(transferResult(raw,{body:operation.body,ack:operation.ack,readOnly:true}));
 };
 const recover=async()=>{
  const operation=attempt.current;if(!operation||pending.current||!sameActor(controller,operation.actor))return;
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setRetryAvailable(false);operation.mayRetry=false;
  try{await readCommand(operation,request);}
  catch(failure){if(active(request,operation.actor)){
   operation.uncertain=true;
   if(!operation.ack&&failure instanceof AccessError&&failure.status===404){operation.mayRetry=true;setRetryAvailable(true);setError('O comando ainda não foi localizado. Isso não comprova que foi rejeitado. Você pode consultar novamente ou reenviar exatamente a mesma confirmação.');}
   else setError(operation.ack?'O registro já foi confirmado, mas a consulta atual não terminou. Consulte novamente; nenhum novo registro será enviado.':'O resultado continua sem confirmação. Consulte novamente pelo mesmo comando antes de qualquer reenvio.');
  }}finally{if(pending.current===request){pending.current=null;if(alive.current)setBusy(false);}}
 };
 const send=async(operation:Attempt)=>{
  if(attempt.current!==operation||pending.current||!sameActor(controller,operation.actor,true))return;
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setNotice('');setRetryAvailable(false);operation.mayRetry=false;listRequest.current?.abort();listEpoch.current++;setPage(null);
  try{
   const raw=await controller.financeTransfers(TRANSFERS_BASE,{method:'POST',body:operation.body,signal:request.signal});
   if(!active(request,operation.actor))return;
   operation.ack=transferResult(raw,{body:operation.body}).receipt;
   await readCommand(operation,request);
  }catch(failure){if(active(request,operation.actor)){
   const definitive=!operation.ack&&!operation.uncertain&&failure instanceof AccessError&&[400,401,403,404,409].includes(failure.status);
   if(definitive){attempt.current=null;setUnresolved(false);setReview(null);setError(failureMessage(failure));}
   else{operation.uncertain=true;setError(operation.ack?'O registro já foi confirmado, mas a consulta atual não terminou. Consulte novamente; nenhum novo registro será enviado.':'A transferência pode ter sido registrada. Os dados estão preservados; confira o resultado pelo mesmo comando.');}
  }}finally{if(pending.current===request){pending.current=null;if(alive.current)setBusy(false);}}
 };
 const confirm=()=>{
  const value=latest.current.review;if(!free()||!sameActor(controller,actor,true)||!value)return;
  const operation:Attempt={actor,body:Object.freeze({...value.body,command_id:crypto.randomUUID()}),ack:null,uncertain:false,mayRetry:false};
  attempt.current=operation;setUnresolved(true);void send(operation);
 };
 const retry=()=>{const operation=attempt.current;if(!operation||operation.ack||!operation.mayRetry||pending.current||!sameActor(controller,operation.actor,true))return;void send(operation);};
 const edit=()=>{if(!free()||!sameActor(controller,actor,true))return;setReview(null);setError('');};
 const open=async(id:string)=>{
  if(!free()||latest.current.mode!=='list')return;
  const request=new AbortController();pending.current=request;setBusy(true);setError('');setDetail(null);
  try{const raw=await controller.financeTransfers(`${TRANSFERS_BASE}/${id}`,{signal:request.signal});if(active(request)){setDetail(transferResult(raw,{transferId:id,readOnly:true}));setMode('detail');setNotice('');}}
  catch(failure){if(active(request))setError(failureMessage(failure));}
  finally{if(pending.current===request){pending.current=null;if(alive.current)setBusy(false);}}
 };
 const changePage=(next:boolean)=>{const state=latest.current;if(!free()||state.loading||state.mode!=='list')return;if(next&&state.page?.has_more){setCursors([...state.cursors,state.after]);setAfter(state.page.next_cursor);}else if(!next&&state.cursors.length){setAfter(state.cursors.at(-1)??null);setCursors(state.cursors.slice(0,-1));}};
 if(!readable)return <section className="finance-transfers"><h1>Transferências entre contas</h1><p>Seu acesso a esta área não está disponível.</p></section>;
 return <section className="finance-transfers" aria-labelledby="transfers-title"><header className="transfer-heading"><div><h1 id="transfers-title">Transferências entre contas</h1><p>Registre uma transferência já feita entre contas da empresa. O FAGOO não envia dinheiro ao banco.</p></div><button type="button" className="secondary-button" disabled={locked} onClick={back}>Voltar ao financeiro</button></header>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{busy&&<p role="status">{attempt.current?'Conferindo o resultado da transferência…':mode==='form'?'Conferindo os dados atuais das contas…':'Consultando a transferência…'}</p>}
  {mode==='list'&&<><div className="transfer-toolbar"><button type="button" className="secondary-button" disabled={loading||locked} onClick={()=>{if(free()){setAfter(null);setCursors([]);setTick(v=>v+1);}}}>Atualizar transferências</button>{writable&&<button type="button" className="primary-button" disabled={locked} onClick={start}>Registrar transferência</button>}</div>
   {loading?<p role="status">Consultando transferências…</p>:page?<><div className="transfer-scroll" tabIndex={0} role="region" aria-label="Transferências registradas"><table className="data-table"><thead><tr><th>Data</th><th>Conta de saída</th><th>Conta de entrada</th><th className="numeric">Valor</th><th>Histórico</th></tr></thead><tbody>{page.items.map(({receipt:r})=><tr key={r.id}><td><button type="button" className="text-button" disabled={locked} aria-label={`Ver transferência de ${financeMoney(r.amount_cents)} em ${financeDate(r.posted_on)}, de ${r.from_account.name} para ${r.to_account.name}`} onClick={()=>void open(r.id)}>{financeDate(r.posted_on)}</button></td><td>{r.from_account.name}</td><td>{r.to_account.name}</td><td className="numeric">{financeMoney(r.amount_cents)}</td><td>{r.note}</td></tr>)}</tbody></table></div>{!page.items.length&&<p>Nenhuma transferência registrada nesta página.</p>}<div className="transfer-pagination"><span>Página {cursors.length+1} · {page.items.length} registro(s)</span><button type="button" className="secondary-button" disabled={loading||locked||!cursors.length} onClick={()=>changePage(false)}>Anterior</button><button type="button" className="secondary-button" disabled={loading||locked||!page.has_more} onClick={()=>changePage(true)}>Próxima</button></div></>:<p>Atualize a consulta para ver os registros.</p>}</>}
  {mode==='form'&&<><form onSubmit={event=>void preview(event)} noValidate><h2>Registrar transferência interna</h2><div className="transfer-grid"><AccountPicker controller={controller} actor={actor} prefix="transfer-from" label="Conta de saída" value={from} disabled={!writable||locked||Boolean(review)} onChange={account=>select('from',account)}/><AccountPicker controller={controller} actor={actor} prefix="transfer-to" label="Conta de entrada" value={to} disabled={!writable||locked||Boolean(review)} onChange={account=>select('to',account)}/></div>
   <fieldset disabled={!writable||locked||Boolean(review)} className="transfer-fields"><legend>Dados da transferência feita</legend><div className="transfer-grid"><div className="form-field"><label htmlFor="transfer-amount">Valor (R$)</label><input id="transfer-amount" inputMode="decimal" maxLength={16} placeholder="0,00" value={values.amount} onChange={e=>update('amount',e.target.value)}/></div><div className="form-field"><label htmlFor="transfer-date">Data da transferência</label><input id="transfer-date" type="date" min="1900-01-01" max={todaySP()} value={values.posted_on} onChange={e=>update('posted_on',e.target.value)}/></div><div className="form-field transfer-wide"><label htmlFor="transfer-note">Histórico</label><input id="transfer-note" maxLength={500} placeholder="Descreva a transferência realizada" value={values.note} onChange={e=>update('note',e.target.value)}/></div></div></fieldset>
   {!review&&<div className="transfer-actions"><button type="submit" className="primary-button" disabled={!writable||locked}>Conferir transferência</button><button type="button" className="secondary-button" disabled={locked} onClick={list}>Cancelar</button></div>}
  </form>{review&&<section className="transfer-review" aria-labelledby="transfer-review-title"><h2 id="transfer-review-title">Conferir antes de registrar</h2><p>{financeMoney(review.body.amount_cents)} · {financeDate(review.body.posted_on)}</p><p className="transfer-note">{review.body.note}</p><div className="transfer-scroll" tabIndex={0} role="region" aria-label="Saldos previstos após o registro"><table className="data-table"><thead><tr><th>Conta</th><th className="numeric">Saldo consultado</th><th className="numeric">Movimento</th><th className="numeric">Saldo previsto</th></tr></thead><tbody>{[review.from,review.to].map((a,i)=>{const amount=BigInt(review.body.amount_cents)*(i?1n:-1n);return <tr key={a.id}><td>{i?'Entrada':'Saída'} · {a.name}</td><td className="numeric">{financeMoney(a.balance_cents)}</td><td className="numeric">{financeMoney(amount.toString())}</td><td className="numeric">{financeMoney((BigInt(a.balance_cents)+amount).toString())}</td></tr>;})}</tbody></table></div><p className="real-help">A confirmação registra os dois movimentos juntos. Não altera títulos nem saldos iniciais, e não envia dinheiro ao banco. Os saldos são os registrados no FAGOO; podem ficar negativos.</p><div className="transfer-actions"><button type="button" className="primary-button" disabled={!writable||locked} onClick={confirm}>Confirmar registro interno</button><button type="button" className="secondary-button" disabled={!writable||locked} onClick={edit}>Editar dados</button></div></section>}
   {unresolved&&<aside className="transfer-recovery" aria-live="polite"><h2>Conferir resultado</h2><p>{attempt.current?.ack?'O registro foi confirmado. Falta consultar os saldos atuais.':'Não edite nem registre outra transferência para substituir esta tentativa.'}</p><div className="transfer-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void recover()}>{attempt.current?.ack?'Consultar registro confirmado':'Conferir resultado'}</button>{retryAvailable&&<button type="button" className="secondary-button" disabled={!writable||busy} onClick={retry}>Reenviar a mesma confirmação</button>}</div></aside>}
  </>}
  {mode==='detail'&&detail&&<><TransferDetail value={detail}/><div className="transfer-actions"><button type="button" className="secondary-button" disabled={locked} onClick={list}>Voltar às transferências</button>{writable&&<button type="button" className="primary-button" disabled={locked} onClick={start}>Registrar outra transferência</button>}</div></>}
 </section>;
}
