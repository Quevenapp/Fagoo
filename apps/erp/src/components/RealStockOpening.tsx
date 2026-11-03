import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {Modal} from './Modal';
import {BATCH_OUTCOME_LABEL,batchSummaryText,summarizeBatch,type BatchResult} from '../lib/origin-batch';
import {parseStockOpeningWarehouses,parseStockOpeningPage,parseStockOpeningBatch,parseStockOpeningResult,parseStockPolicy,parseStockPolicyResult,stockOpeningIntent,policyIntent,
 stockOpeningWarehousesPath,stockOpeningPagePath,stockOpeningActionPath,stockOpeningCommandPath,stockPolicyPath,stockPolicyCommandPath,
 OPENING_GROUP_LABELS,OPENING_STATUS_LABELS,OPENING_REASON_LABELS,POLICY_CONFIRMATION,STOCK_OPENING_GROUPS,openingToday,openingNegative,openingQuantity,openingStatusTone,openingProductLabel,
 openingCode,openingPolicyLabel,openingDateProblem,openingBatchPreview,openingResults,
 type StockOpeningWarehouses,type StockOpeningPage,type StockOpeningBatch,type StockOpeningApplyInput,type StockOpeningGroup,type StockPolicyView,type StockPolicyInput,type StockOpeningRow} from '../lib/stock-opening-model';
import './batch-dialog.css';
import './stock-opening.css';

export interface StockOpeningController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;stockOpening:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
const authorized=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
const denied=(e:unknown)=>e instanceof AccessError&&[401,403].includes(e.status);
const readError=(e:unknown)=>denied(e)?'O acesso de administrador precisa ser confirmado.':e instanceof AccessError&&e.status===409?'Os dados mudaram. Atualize e confira novamente.':e instanceof AccessError&&e.status===404?'O depósito vinculado não está disponível nesta consulta.':e instanceof AccessError&&e.status===400?'Confira a data de corte e os filtros informados.':'Não foi possível concluir a consulta. Tente novamente.';
const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
type OpeningAttempt={source:string;body:StockOpeningApplyInput;batch:StockOpeningBatch;uncertain:boolean;ack:boolean;retryAllowed:boolean};
type PolicyAttempt={body:StockPolicyInput;uncertain:boolean;ack:boolean;retryAllowed:boolean};
type Dialog={phase:'preview'|'running'|'done'|'uncertain'|'failed';batch:StockOpeningBatch;results:BatchResult[];message:string};
type PolicyEdit={allow:boolean;reason:string;confirmed:boolean};

function Quantity({value,empty='—'}:{value:string|null;empty?:string}){return <span className={openingNegative(value)?'stock-opening-negative':undefined}>{value===null?empty:openingQuantity(value)}</span>;}
function Row({row}:{row:StockOpeningRow}){
 return <tr><td><strong>{openingProductLabel(row)}</strong><small>ID {row.product_source_id} no Origin{row.product?.unit?` · ${row.product.unit}`:''}</small></td><td>{openingCode(row)}</td>
  <td className="numeric"><Quantity value={row.physical}/></td><td className="numeric"><Quantity value={row.current.quantity} empty="Sem lançamentos"/></td><td className="numeric"><Quantity value={row.adjustment}/></td>
  <td><span className={`status-badge status-${openingStatusTone(row.status)}`}>{OPENING_STATUS_LABELS[row.status]}</span>{row.reason&&row.reason!=='ALREADY_ADOPTED'&&<small>{OPENING_REASON_LABELS[row.reason]}</small>}{row.receipt&&<small>Data de corte {row.receipt.occurred_on.split('-').reverse().join('/')}{row.receipt.state==='reversed'?' · estornado pelo estoque':''}</small>}</td></tr>;
}

function OpeningView({controller,actor,allowed}:{controller:StockOpeningController;actor:string;allowed:boolean}){
 const alive=useRef(true),request=useRef<AbortController|null>(null),meta=useRef<AbortController|null>(null),opening=useRef<OpeningAttempt|null>(null),policyAttempt=useRef<PolicyAttempt|null>(null);
 const [warehouses,setWarehouses]=useState<StockOpeningWarehouses|null>(null),[policy,setPolicy]=useState<StockPolicyView|null>(null),[source,setSource]=useState(''),[day,setDay]=useState(openingToday());
 const [group,setGroup]=useState<StockOpeningGroup|null>(null),[cursors,setCursors]=useState<(string|null)[]>([null]),[page,setPage]=useState<StockOpeningPage|null>(null),[reload,setReload]=useState(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dialog,setDialog]=useState<Dialog|null>(null),[confirmed,setConfirmed]=useState(false),[edit,setEdit]=useState<PolicyEdit|null>(null),[pending,setPending]=useState(0);
 const live=useRef({page,dialog,edit,confirmed,source,day,policy});live.current={page,dialog,edit,confirmed,source,day,policy};
 const may=()=>alive.current&&authorized(controller.getSnapshot())&&controller.getSnapshot().membership?.user_id===actor;
 const free=()=>may()&&!request.current;
 useUnsavedChanges(Boolean(dialog&&dialog.phase==='preview')||Boolean(edit),busy||Boolean(opening.current)||Boolean(policyAttempt.current));
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 const start=()=>{const p=new AbortController();request.current=p;setBusy(true);setError('');return p;};
 const finish=(p:AbortController)=>{if(request.current===p){request.current=null;setBusy(false);}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();meta.current?.abort();opening.current=null;policyAttempt.current=null;};},[controller]);
 // Losing the role cancels reads but keeps an already captured command for the same administrador.
 useEffect(()=>{if(!allowed){request.current?.abort();request.current=null;meta.current?.abort();meta.current=null;setBusy(false);for(const a of[opening.current,policyAttempt.current])if(a){a.uncertain=true;a.retryAllowed=false;}
  if(opening.current)setDialog(d=>d&&{...d,phase:'uncertain',results:[],message:'O acesso mudou durante a adoção. Confira o resultado do mesmo comando quando o acesso de administrador voltar.'});else setDialog(null);
  if(!policyAttempt.current)setEdit(null);setPage(null);}},[allowed]);
 // Linked warehouses and the policy load beside the page, with their own cancellation.
 useEffect(()=>{if(!may())return;meta.current?.abort();const p=new AbortController();meta.current=p;const ok=()=>may()&&!p.signal.aborted&&meta.current===p;void(async()=>{try{
  const [w,v]=await Promise.all([controller.stockOpening(stockOpeningWarehousesPath(),{method:'GET',signal:p.signal}),controller.stockOpening(stockPolicyPath(),{method:'GET',signal:p.signal})]);
  if(!ok())return;const list=parseStockOpeningWarehouses(w);setWarehouses(list);setPolicy(parseStockPolicy(v));if(!live.current.source&&list.items.length===1)setSource(list.items[0].source_id);
 }catch(e){if(ok())setError(readError(e));}finally{if(meta.current===p)meta.current=null;}})();return()=>{p.abort();if(meta.current===p)meta.current=null;};},[controller,actor,allowed,reload]);
 const after=cursors.at(-1)??null;
 useEffect(()=>{if(!source||!may())return;const p=start();live.current.page=null;setPage(null);void(async()=>{try{
  const raw=await controller.stockOpening(stockOpeningPagePath(source,{limit:50,after,group}),{method:'GET',signal:p.signal});
  if(valid(p))setPage(parseStockOpeningPage(raw,{warehouseSourceId:source,limit:50,after,group}));
 }catch(e){if(valid(p))setError(readError(e));}finally{finish(p);}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,actor,allowed,source,group,after,reload]);

 const refresh=()=>{setCursors([null]);setReload(n=>n+1);};
 const changeSource=(value:string)=>{if(!free()||opening.current||live.current.dialog)return;setSource(value);setGroup(null);setCursors([null]);setNotice('');};
 const changeGroup=(value:string)=>{if(!free())return;setGroup((STOCK_OPENING_GROUPS as readonly string[]).includes(value)?value as StockOpeningGroup:null);setCursors([null]);};
 const dateProblem=openingDateProblem(day);
 const previewBatch=async()=>{const current=live.current.page;if(!free()||opening.current||!current||live.current.dialog||openingDateProblem(live.current.day))return;
  const p=start(),target=current.warehouse.source_id,cut=live.current.day;setNotice('');
  try{const raw=await controller.stockOpening(stockOpeningActionPath(target,'lote'),{method:'POST',body:{occurred_on:cut,limit:100},signal:p.signal});if(!valid(p))return;
   const batch=parseStockOpeningBatch(raw,{warehouseSourceId:target,occurredOn:cut,limit:100});
   if(!batch.items.length){setNotice('Não há pares pendentes para adotar neste depósito.');return;}
   setConfirmed(false);setDialog({phase:'preview',batch,results:openingBatchPreview(batch),message:''});
  }catch(e){if(valid(p))setError(readError(e));}finally{finish(p);}};
 const runOpening=async(a:OpeningAttempt|null,send=false)=>{if(!may()||request.current||!a||opening.current!==a||send&&a.uncertain&&!a.retryAllowed)return;const p=start();a.retryAllowed=false;let reading=false;
  setDialog(d=>d&&{...d,phase:'running',message:''});
  try{
   if(send){const raw=await controller.stockOpening(stockOpeningActionPath(a.source,'adotar'),{method:'POST',body:a.body,signal:p.signal});if(!valid(p)||opening.current!==a)return;
    parseStockOpeningResult(raw,{commandId:a.body.command_id,warehouseSourceId:a.source,input:a.body});a.ack=true;}
   if(!valid(p)||opening.current!==a)return;reading=true;
   const raw=await controller.stockOpening(stockOpeningCommandPath(a.body.command_id),{method:'GET',signal:p.signal});if(!valid(p)||opening.current!==a)return;
   const result=parseStockOpeningResult(raw,{commandId:a.body.command_id,warehouseSourceId:a.source,input:a.body,lookup:true});
   opening.current=null;setPending(n=>n+1);setDialog({phase:'done',batch:a.batch,results:openingResults(result,a.batch),message:''});refresh();
  }catch(e){if(valid(p)&&opening.current===a){
   if(send&&!reading&&!a.uncertain&&!a.ack&&e instanceof AccessError&&[400,404,409].includes(e.status)){opening.current=null;setPending(n=>n+1);
    setDialog({phase:'failed',batch:a.batch,results:[],message:e.status===409?'O lote mudou depois da prévia ou o comando já foi usado. Nada foi adotado; prepare o próximo lote novamente.':'O lote não foi aceito. Nada foi adotado; confira a data de corte e prepare o lote novamente.'});}
   else{a.uncertain=true;a.retryAllowed=reading&&!a.ack&&e instanceof AccessError&&e.status===404;setPending(n=>n+1);
    setDialog({phase:'uncertain',batch:a.batch,results:[],message:a.retryAllowed?'A consulta ainda não encontrou o comando. Isso não comprova que nada foi adotado. Confira de novo ou reenvie exatamente o mesmo comando.':'Não foi possível confirmar o resultado. Use “Conferir resultado”: a consulta não repete a adoção.'});}
  }}finally{finish(p);}};
 const confirm=(expected:Dialog)=>{if(!free()||opening.current||live.current.dialog!==expected||expected.phase!=='preview'||!live.current.confirmed)return;
  const a:OpeningAttempt={source:expected.batch.warehouse.source_id,body:stockOpeningIntent(expected.batch,crypto.randomUUID()),batch:expected.batch,uncertain:false,ack:false,retryAllowed:false};
  opening.current=a;setPending(n=>n+1);void runOpening(a,true);};
 const closeDialog=()=>{const d=live.current.dialog;if(!d||d.phase==='running')return;setDialog(null);setConfirmed(false);};
 // Policy switch: explicit confirmation text and reason; the server checks the version and the administrador role again.
 const runPolicy=async(a:PolicyAttempt|null,send=false)=>{if(!may()||request.current||!a||policyAttempt.current!==a||send&&a.uncertain&&!a.retryAllowed)return;const p=start();a.retryAllowed=false;let reading=false;
  try{
   if(send){const raw=await controller.stockOpening(stockPolicyPath(),{method:'POST',body:a.body,signal:p.signal});if(!valid(p)||policyAttempt.current!==a)return;parseStockPolicyResult(raw,{commandId:a.body.command_id,input:a.body});a.ack=true;}
   if(!valid(p)||policyAttempt.current!==a)return;reading=true;
   const result=parseStockPolicyResult(await controller.stockOpening(stockPolicyCommandPath(a.body.command_id),{method:'GET',signal:p.signal}),{commandId:a.body.command_id,input:a.body,lookup:true});
   if(!valid(p)||policyAttempt.current!==a)return;policyAttempt.current=null;setPending(n=>n+1);setEdit(null);
   setPolicy(v=>v&&{...v,policy:result.policy});setNotice(result.receipt.to.allow_negative?'Estoque negativo permitido a partir de agora. A alteração ficou registrada.':'Estoque negativo não permitido a partir de agora. Saldos negativos existentes foram mantidos.');refresh();
  }catch(e){if(valid(p)&&policyAttempt.current===a){
   if(send&&!reading&&!a.uncertain&&!a.ack&&e instanceof AccessError&&[400,404,409].includes(e.status)){policyAttempt.current=null;setPending(n=>n+1);setEdit(null);setError(e.status===409?'A política foi alterada por outra pessoa. Atualize e confira antes de mudar.':'A alteração não foi aceita. Confira o motivo informado.');setReload(n=>n+1);}
   else{a.uncertain=true;a.retryAllowed=reading&&!a.ack&&e instanceof AccessError&&e.status===404;setPending(n=>n+1);setError(a.retryAllowed?'A consulta ainda não encontrou a alteração. Isso não comprova que nada mudou.':'Não foi possível confirmar a alteração da política. Use “Conferir resultado da política”.');}
  }}finally{finish(p);}};
 const startPolicy=(allow:boolean)=>{const v=live.current.policy;if(!free()||policyAttempt.current||!v||!v.can_manage||allow===v.policy.allow_negative&&!live.current.edit)return;
  setEdit(allow===v.policy.allow_negative?null:{allow,reason:'',confirmed:false});setNotice('');};
 const submitPolicy=()=>{const v=live.current.policy,e=live.current.edit;if(!free()||policyAttempt.current||!v||!e||!e.confirmed||e.reason.trim().length<3)return;
  let body:StockPolicyInput;try{body=policyIntent(v.policy,e.allow,e.reason,crypto.randomUUID(),true);}catch{setError('Informe o motivo e confirme o texto da alteração.');return;}
  const a:PolicyAttempt={body,uncertain:false,ack:false,retryAllowed:false};policyAttempt.current=a;setPending(n=>n+1);void runPolicy(a,true);};

 const current=page,activeOpening=opening.current,activePolicy=policyAttempt.current,today=openingToday();
 const selected=warehouses?.items.find(w=>w.source_id===source)??null;
 const canAdopt=Boolean(current&&!busy&&!activeOpening&&!dialog&&!dateProblem&&current.counts.pending>0&&current.warehouse.active);
 void pending;
 return <section className="stock-opening" aria-busy={busy}>
  <header className="real-heading"><div><h1>Saldo de abertura do estoque (Origin)</h1><p>Adote o estoque físico observado no Origin para cada depósito vinculado, na data de corte da virada.</p></div><span className="real-mode">Administrador</span></header>
  <div className="real-notice stock-opening-warning" role="note"><strong>O Origin continua mudando até a virada.</strong> Faça a adoção no momento da virada, depois de encerrar as movimentações no Origin. Cada produto é adotado uma única vez por depósito; mudanças posteriores no Origin não são reaplicadas.</div>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {policy&&<section className="stock-opening-panel" aria-label="Política de estoque negativo"><header><h2>Permitir estoque negativo</h2><span className={`status-badge status-${policy.policy.allow_negative?'warning':'neutral'}`}>{openingPolicyLabel(policy.policy)}</span></header>
   <p>Desligada (padrão), nenhuma baixa deixa o saldo abaixo de zero. Ligada, como no Origin, vendas, saídas, transferências e estornos podem deixar o saldo negativo; reservas continuam exigindo saldo disponível.</p>
   {policy.can_manage&&<label className="stock-opening-switch" htmlFor="policy-switch"><input id="policy-switch" type="checkbox" role="switch" checked={edit?edit.allow:policy.policy.allow_negative} disabled={busy||Boolean(activePolicy)} onChange={e=>startPolicy(e.target.checked)}/>Permitir estoque negativo</label>}
   {edit&&!activePolicy&&<div className="stock-opening-confirm"><p><strong>{edit.allow?'Ligar a política':'Desligar a política'}</strong></p>
    <label className="stock-opening-check" htmlFor="policy-confirm"><input id="policy-confirm" type="checkbox" checked={edit.confirmed} disabled={busy} onChange={e=>{if(free()&&live.current.edit===edit)setEdit({...edit,confirmed:e.target.checked});}}/>{POLICY_CONFIRMATION[edit.allow?'enable':'disable']}</label>
    <label htmlFor="policy-reason">Motivo da alteração<input id="policy-reason" maxLength={500} value={edit.reason} disabled={busy} onChange={e=>{if(free()&&live.current.edit===edit)setEdit({...edit,reason:e.target.value});}}/></label>
    <div className="stock-opening-actions"><button type="button" className="primary-button" disabled={busy||!edit.confirmed||edit.reason.trim().length<3} onClick={submitPolicy}>Confirmar alteração da política</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(free())setEdit(null);}}>Cancelar alteração</button></div></div>}
   {activePolicy&&<div className="stock-opening-confirm" aria-label="Alteração da política pendente"><p>A alteração da política aguarda confirmação. Identificador: <code>{activePolicy.body.command_id}</code>.</p><div className="stock-opening-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runPolicy(activePolicy)}>Conferir resultado da política</button>{activePolicy.retryAllowed&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void runPolicy(activePolicy,true)}>Reenviar a mesma alteração</button>}</div></div>}
   <small>Versão {policy.policy.version}{policy.policy.updated_at?` · alterada em ${moment(policy.policy.updated_at)}`:' · configuração inicial'}</small>
  </section>}
  {activeOpening&&!dialog&&<section className="stock-opening-panel" aria-label="Adoção pendente"><h2>Conferir resultado da adoção</h2><p>O lote confirmado está preservado. Identificador do comando: <code>{activeOpening.body.command_id}</code>.</p>
   <div className="stock-opening-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>{if(!free()||opening.current!==activeOpening)return;setDialog({phase:'uncertain',batch:activeOpening.batch,results:[],message:'Confira o resultado do mesmo comando. A consulta não repete a adoção.'});void runOpening(activeOpening);}}>Conferir resultado</button></div></section>}
  <section className="stock-opening-panel" aria-label="Depósito e data de corte"><div className="stock-opening-fields">
   <label htmlFor="opening-warehouse">Depósito vinculado<select id="opening-warehouse" value={source} disabled={busy||Boolean(activeOpening)||!warehouses} onChange={e=>changeSource(e.target.value)}><option value="">Selecione o depósito</option>{warehouses?.items.map(w=><option key={w.source_id} value={w.source_id}>{w.name}{w.active?'':' (inativo)'} · ID {w.source_id}</option>)}</select></label>
   <label htmlFor="opening-date">Data de corte<input id="opening-date" type="date" min="1900-01-01" max={today} value={day} disabled={busy||Boolean(activeOpening)} onChange={e=>{if(free()&&!opening.current)setDay(e.target.value);}}/></label>
  </div>{dateProblem&&<p className="real-alert" role="alert">{dateProblem}</p>}
   {warehouses&&!warehouses.items.length&&<p>Nenhum depósito do Origin foi vinculado ainda. Importe os depósitos antes de adotar saldos.</p>}
   {selected&&!selected.active&&<p className="real-alert">O depósito está inativo no FAGOO. Reative o cadastro para adotar saldos.</p>}
   <p className="real-help">A observação do Origin não informa unidade: o saldo é adotado na unidade do cadastro do produto no FAGOO. Produtos sem cadastro nativo, sem observação no depósito ou com lançamentos no FAGOO ficam fora da adoção.</p>
  </section>
  {current&&<section className="stock-opening-panel" aria-label="Prévia da adoção">
   <dl className="stock-opening-counts">{STOCK_OPENING_GROUPS.map(g=><div key={g} className={g==='negative'&&current.counts.negative>0?'stock-opening-negative':undefined}><dt>{OPENING_GROUP_LABELS[g]}</dt><dd>{current.counts[g].toLocaleString('pt-BR')}</dd></div>)}</dl>
   {current.counts.negative_blocked>0&&<p className="real-notice">{current.counts.negative_blocked.toLocaleString('pt-BR')} saldo(s) negativo(s) ficam fora da adoção: estoque negativo não permitido. Para adotá-los, ligue a política acima.</p>}
   <div className="stock-opening-actions"><label htmlFor="opening-group">Situação<select id="opening-group" value={group??''} disabled={busy} onChange={e=>changeGroup(e.target.value)}><option value="">Todas</option>{STOCK_OPENING_GROUPS.map(g=><option key={g} value={g}>{OPENING_GROUP_LABELS[g]}</option>)}</select></label>
    <button type="button" className="primary-button" disabled={!canAdopt} onClick={()=>void previewBatch()}>Adotar próximo lote</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>{if(free())refresh();}}>Atualizar prévia</button>
    <span role="status">{current.counts.pending.toLocaleString('pt-BR')} par(es) pendente(s) · até 100 por lote</span></div>
   <div className="table-scroll" role="region" tabIndex={0} aria-label="Prévia por produto"><table className="data-table real-table stock-opening-table"><thead><tr><th>Produto</th><th>Código</th><th className="numeric">Saldo no Origin</th><th className="numeric">Saldo atual</th><th className="numeric">Ajuste</th><th>Situação</th></tr></thead>
    <tbody>{current.items.map(row=><Row key={row.product_source_id} row={row}/>)}</tbody></table></div>
   {!current.items.length&&<p>Nenhum produto nesta situação.</p>}
   <footer className="stock-opening-actions"><span>Página {cursors.length}</span><button type="button" className="secondary-button" disabled={busy||cursors.length===1} onClick={()=>{if(free())setCursors(c=>c.slice(0,-1));}}>Página anterior</button><button type="button" className="secondary-button" disabled={busy||!current.has_more} onClick={()=>{if(free()&&current.next_cursor)setCursors(c=>[...c,current.next_cursor]);}}>Próxima página</button></footer>
   <small>Prévia consultada em {moment(current.observed_at)}. Política: estoque negativo {openingPolicyLabel(current.policy).toLowerCase()}.</small>
  </section>}
  {dialog&&<Modal title="Adotar saldo de abertura (Origin)" onClose={closeDialog} actions={dialog.phase==='preview'
   ?<><button type="button" className="secondary-button" onClick={closeDialog}>Cancelar</button><button type="button" className="primary-button" disabled={busy||!confirmed} onClick={()=>confirm(dialog)}>Adotar lote</button></>
   :dialog.phase==='running'?<button type="button" className="secondary-button" disabled>Adotando…</button>
   :dialog.phase==='uncertain'&&activeOpening?<><button type="button" className="secondary-button" disabled={busy} onClick={closeDialog}>Fechar</button>{activeOpening.retryAllowed&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>void runOpening(activeOpening,true)}>Reenviar o mesmo comando</button>}<button type="button" className="primary-button" disabled={busy} onClick={()=>void runOpening(activeOpening)}>Conferir resultado</button></>
   :<button type="button" className="primary-button" onClick={closeDialog}>Fechar</button>}>
   <div className="batch-dialog">
    <p className="batch-dialog-lead">{dialog.phase==='preview'?<><strong>{dialog.batch.items.length}</strong> {dialog.batch.items.length===1?'par será adotado':'pares serão adotados'} em <strong>{dialog.batch.warehouse.name}</strong> com data de corte <strong>{dialog.batch.occurred_on.split('-').reverse().join('/')}</strong>. Cada par é conferido de novo no servidor.</>
     :dialog.phase==='running'?'Adotando o lote…':dialog.phase==='done'?batchSummaryText(summarizeBatch(dialog.results)):dialog.message}</p>
    {dialog.phase==='preview'&&<label className="stock-opening-check" htmlFor="opening-confirm"><input id="opening-confirm" type="checkbox" checked={confirmed} disabled={busy} onChange={e=>{if(free()&&live.current.dialog===dialog)setConfirmed(e.target.checked);}}/>Conferi os saldos e a data de corte. Confirmo a adoção deste lote no estoque do FAGOO: cada saldo diferente de zero vira um ajuste “Saldo de abertura (Origin)”, que só pode ser desfeito pelo estorno normal do lançamento.</label>}
    {activeOpening&&dialog.phase!=='preview'&&<small>Identificador do comando: <code>{activeOpening.body.command_id}</code></small>}
    {dialog.results.length>0&&<ul className="batch-dialog-list">{dialog.results.map(r=><li key={r.id} className={`is-${dialog.phase==='preview'?'pending':r.outcome}`}><span className="batch-dialog-label">{r.label}</span>{dialog.phase!=='preview'&&<span className="batch-dialog-outcome">{BATCH_OUTCOME_LABEL[r.outcome]}</span>}{r.message&&<small>{r.message}</small>}</li>)}</ul>}
   </div>
  </Modal>}
 </section>;
}
// The route renders this screen for every role (as086): a role that never was administrador sees the refusal and sends
// nothing, while the same administrador losing the role keeps a captured command hidden until the role returns.
function Held({controller,actor,allowed}:{controller:StockOpeningController;actor:string;allowed:boolean}){const[opened,setOpened]=useState(allowed);useEffect(()=>{if(allowed)setOpened(true);},[allowed]);
 if(!opened)return <section className="real-state-panel"><h1>Saldo de abertura não liberado</h1><p>Somente administradores podem adotar o saldo de abertura do estoque e alterar a política de estoque negativo.</p></section>;
 return <>{!allowed&&<p role="alert">Esta preparação exige acesso ativo de administrador. Um comando pendente do mesmo usuário permanece preservado para conferência quando o acesso voltar.</p>}{opened&&<div hidden={!allowed} inert={!allowed} aria-hidden={!allowed}><OpeningView controller={controller} actor={actor} allowed={allowed}/></div>}</>;}
export default function RealStockOpening({controller}:{controller:StockOpeningController}){const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot),identity=useRef({controller,key:0});if(identity.current.controller!==controller)identity.current={controller,key:identity.current.key+1};const actor=state.membership?.user_id;
 if(!actor||state.phase==='signed_out')return <p role="alert">Entre com acesso de administrador para preparar o saldo de abertura do estoque.</p>;
 return <Held key={`${actor}:${identity.current.key}`} actor={actor} controller={controller} allowed={authorized(state)}/>;}
