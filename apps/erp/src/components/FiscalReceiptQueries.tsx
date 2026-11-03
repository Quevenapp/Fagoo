import {useEffect,useRef,useState} from 'react';
import {AccessError,type AccessController,type NativeRequestOptions} from '../lib/real-access';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import type {ReceiptQueryPublicResolution} from '../../../../packages/fiscal-authorization/src/receipt-query-public-dto.mjs';
import {RECEIPT_QUERY_BASE as BASE,receiptQueryReferenceKey,receiptQueryContextInput,receiptQueryHistoryInput,receiptQueryCommandPath,receiptQueryContext,receiptQueryHistory,receiptQueryIntent,receiptQueryResult,receiptQueryStateLabel,receiptQueryBlockerLabel,type ReceiptQueryReference,type ReceiptQueryPublicContext,type ReceiptQueryPublicResult,type ReceiptQueryPublicHistory,type ReceiptQueryRunInput} from '../lib/fiscal-receipt-query-model';
import FiscalProcessedDocument from './FiscalProcessedDocument';
import {receiptQueryProcessedReference} from '../lib/fiscal-receipt-query-processed-model';
import {processedReferenceKey} from '../lib/fiscal-processed-document-model';
import './fiscal-receipt-queries.css';
export type ReceiptQueryController=Pick<AccessController,'getSnapshot'|'subscribe'>&{fiscalReceiptQuery:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;fiscalProcessedDocument?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};
type Props={controller:ReceiptQueryController;reference:ReceiptQueryReference;blocked?:boolean;onBusy?:(busy:boolean)=>void;onDismiss:()=>boolean};
type Attempt={kind:'run'|'recover';commandId:string;body:ReceiptQueryRunInput|Readonly<{confirmed:true}>;input:ReceiptQueryRunInput|null;previous:ReceiptQueryPublicResult|null};
const actor=(c:ReceiptQueryController)=>c.getSnapshot().membership?.user_id??null;
const allowed=(c:ReceiptQueryController)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const identities=new WeakMap<object,number>();let counter=0;
function identity(x:object){if(!identities.has(x))identities.set(x,++counter);return identities.get(x);}
/** Explicit local boundary: same-actor role loss preserves an uncertain UUID; actor/controller/source changes remount. */
export default function FiscalReceiptQueries(props:Props){
 const [,tick]=useState(0),owner=useRef(actor(props.controller));
 useEffect(()=>props.controller.subscribe(()=>tick(n=>n+1)),[props.controller]);
 const snapshot=props.controller.getSnapshot();if(snapshot.phase==='signed_out')owner.current=null;else if(snapshot.phase==='ready')owner.current=actor(props.controller);
 return <ReceiptQueriesPanel key={`${identity(props.controller)}:${owner.current??'none'}:${receiptQueryReferenceKey(props.reference)}`} {...props}/>;
}
function ReceiptQueriesPanel({controller,reference,blocked=false,onBusy,onDismiss}:Props){
 const [context,setContext]=useState<ReceiptQueryPublicContext|null>(null),[history,setHistory]=useState<ReceiptQueryPublicHistory|null>(null),[result,setResult]=useState<ReceiptQueryPublicResult|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[,tick]=useState(0);
 const alive=useRef(true),retired=useRef(false),owner=useRef(actor(controller)),scope=useRef(receiptQueryReferenceKey(reference)),epoch=useRef(0),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),accepted=useRef<ReceiptQueryPublicContext|null>(null),clock=useRef({server:0,local:0});
 const live=useRef({reference,blocked,onBusy,onDismiss,context,history,result});live.current={reference,blocked,onBusy,onDismiss,context,history,result};
 const authorized=()=>alive.current&&!retired.current&&allowed(controller)&&actor(controller)===owner.current&&receiptQueryReferenceKey(live.current.reference)===scope.current;
 const notify=()=>{setBusy(Boolean(request.current));setPending(Boolean(attempt.current));live.current.onBusy?.(Boolean(request.current||attempt.current||accepted.current));};
 const revokeConsent=()=>{accepted.current=null;setConfirmed(false);};
 const stop=()=>{epoch.current++;request.current?.abort();request.current=null;revokeConsent();notify();};
 const available=(allowBlocked=false)=>authorized()&&!request.current&&(allowBlocked||!live.current.blocked);
 const valid=(p:AbortController,n:number)=>authorized()&&request.current===p&&!p.signal.aborted&&epoch.current===n;
 const clearContext=()=>{revokeConsent();live.current.context=null;setContext(null);};
 const finish=(p:AbortController,n:number)=>{if(valid(p,n)){request.current=null;notify();}};
 useEffect(()=>{alive.current=true;const cancel=controller.subscribe(()=>{if(!allowed(controller)||actor(controller)!==owner.current)stop();tick(n=>n+1);});return()=>{alive.current=false;epoch.current++;request.current?.abort();request.current=null;cancel();live.current.onBusy?.(false);};},[controller]);
 const policyCurrent=()=>{const c=live.current.context;if(!c?.policy)return false;const estimated=clock.current.server+Math.max(0,Date.now()-clock.current.local);return estimated>=Date.parse(c.policy.valid_from)&&estimated<Date.parse(c.policy.valid_until);};
 useEffect(()=>{if(!context)return;const timer=setInterval(()=>{if(!policyCurrent()&&accepted.current){revokeConsent();notify();}tick(n=>n+1);},1000);return()=>clearInterval(timer);},[context]);
 const begin=()=>{const p=new AbortController(),n=epoch.current;request.current=p;setError('');revokeConsent();notify();return {p,n};};
 const query=(path:string,options:NativeRequestOptions)=>controller.fiscalReceiptQuery(path,options);
 const readContext=async()=>{
  if(!available()||attempt.current)return;const {p,n}=begin();live.current.context=null;live.current.history=null;setContext(null);setHistory(null);
  try{const value=receiptQueryContext(await query(BASE+'/receipt-query-context',{method:'POST',body:receiptQueryContextInput(reference),signal:p.signal}),reference);if(valid(p,n)){clock.current={server:Date.parse(value.observed_at),local:Date.now()};live.current.context=value;live.current.result=null;setContext(value);setResult(null);}}
  catch(e){if(valid(p,n))setError(e instanceof AccessError&&[401,403].includes(e.status)?'Confirme o acesso do usuário que iniciou esta tentativa.':'Não foi possível ler as condições da consulta. Nenhuma consulta à SEFAZ foi iniciada.');}
  finally{finish(p,n);}
 };
 const readHistory=async(expected:ReceiptQueryPublicHistory|null=null)=>{
  if(!available()||attempt.current||expected!==null&&live.current.history!==expected)return;const input=receiptQueryHistoryInput(reference,expected?.next_before??null);if(expected&&expected.next_before===null)return;const {p,n}=begin();
  try{const value=receiptQueryHistory(await query(BASE+'/receipt-query-history',{method:'POST',body:input,signal:p.signal}),reference,input);if(valid(p,n)){clearContext();live.current.history=value;live.current.result=null;setHistory(value);setResult(null);}}
  catch(e){if(valid(p,n))setError(e instanceof AccessError&&[401,403].includes(e.status)?'Confirme o acesso do usuário que iniciou esta tentativa.':'Não foi possível ler as consultas registradas. Isso não significa ausência de resultado.');}
  finally{finish(p,n);}
 };
 const displayed=()=>live.current.history?.items??live.current.context?.history??[];
 const resolved=()=>live.current.result?.resolution??live.current.history?.resolution??live.current.context?.resolution;
 const readSelected=async(expected:ReceiptQueryPublicResolution)=>{
  if(!available()||attempt.current||resolved()!==expected||!expected.selected_query_id)return;const commandId=expected.selected_query_id,{p,n}=begin();
  try{const value=receiptQueryResult(await query(receiptQueryCommandPath(commandId),{signal:p.signal}),reference,commandId);if(valid(p,n)){clearContext();live.current.result=value;setResult(value);}}
  catch(e){if(valid(p,n))setError(e instanceof AccessError&&e.status===404?'O registro que sustenta o resultado não foi localizado nesta leitura. Não repita o envio.':'Não foi possível conferir o registro que sustenta este resultado. Consulte novamente o mesmo comando.');}
  finally{finish(p,n);}
 };
 const registered=async(row:ReceiptQueryPublicResult)=>{
  if(!available()||attempt.current||!displayed().includes(row)&&live.current.result!==row)return;const {p,n}=begin();
  try{const value=receiptQueryResult(await query(receiptQueryCommandPath(row.command_id),{signal:p.signal}),reference,row.command_id,{previous:row});if(valid(p,n)){clearContext();live.current.result=value;setResult(value);}}
  catch(e){if(valid(p,n))setError(e instanceof AccessError&&e.status===404?'O comando não foi localizado nesta leitura. A consulta não autoriza repetir o envio da nota.':'Não foi possível conferir este comando. Consulte novamente o mesmo registro.');}
  finally{finish(p,n);}
 };
 const execute=async(op:Attempt,post:boolean)=>{
  if(attempt.current!==op||!available(!post))return;const {p,n}=begin();
  try{
   if(post){const path=op.kind==='run'?BASE+'/receipt-queries':receiptQueryCommandPath(op.commandId)+'/recover';const raw=await query(path,{method:'POST',body:op.body,signal:p.signal});if(!valid(p,n)||attempt.current!==op)return;op.previous=receiptQueryResult(raw,reference,op.commandId,{input:op.input,previous:op.previous,mode:op.kind});}
   const raw=await query(receiptQueryCommandPath(op.commandId),{signal:p.signal});if(!valid(p,n)||attempt.current!==op)return;
   const value=receiptQueryResult(raw,reference,op.commandId,{input:op.input,previous:op.previous});attempt.current=null;clearContext();live.current.history=null;live.current.result=value;setHistory(null);setResult(value);
  }catch(e){if(valid(p,n)&&attempt.current===op){
   const definite=post&&op.kind==='run'&&!op.previous&&e instanceof AccessError&&[400,401,403,404,409,413,415,422,503].includes(e.status)&&(e as AccessError&{recovery_required?:boolean}).recovery_required===false;
   if(definite){attempt.current=null;clearContext();setError('A nova consulta foi recusada antes do registro. Atualize as condições antes de decidir outra consulta.');}
   else setError(e instanceof AccessError&&[401,403].includes(e.status)?'Seu acesso precisa ser reconfirmado. Depois consulte o mesmo comando.':e instanceof AccessError&&e.status===404?'O comando não foi localizado nesta leitura. O resultado continua incerto; consulte o mesmo identificador, sem repetir a operação.':'Não foi possível confirmar o resultado. Consulte o mesmo comando; não repita a operação.');
  }}finally{finish(p,n);}
 };
 const canConfirm=(expected:ReceiptQueryPublicContext|null)=>available()&&!attempt.current&&expected!==null&&live.current.context===expected&&expected.can_query&&policyCurrent();
 const confirm=(expected:ReceiptQueryPublicContext)=>{if(!canConfirm(expected)||accepted.current!==expected)return;try{const body=receiptQueryIntent(expected,reference,crypto.randomUUID(),true),op:Attempt={kind:'run',commandId:body.command_id,body,input:body,previous:null};attempt.current=op;revokeConsent();notify();void execute(op,true);}catch{clearContext();setError('Atualize as condições antes de confirmar a consulta.');}};
 const recover=(row:ReceiptQueryPublicResult)=>{if(!available()||attempt.current||live.current.result!==row||!row.current.can_recover)return;const op:Attempt={kind:'recover',commandId:row.command_id,body:Object.freeze({confirmed:true}),input:null,previous:row};attempt.current=op;revokeConsent();notify();void execute(op,true);};
 const dismiss=()=>{if(authorized()&&!request.current&&!attempt.current&&live.current.onDismiss()){retired.current=true;revokeConsent();live.current.onBusy?.(false);}};
 const canUse=authorized(),locked=!canUse||busy||blocked,activeAttempt=attempt.current,rows=history?.items??context?.history??[],resolution=result?.resolution??history?.resolution??context?.resolution;
 const files=result&&!pending&&!busy&&canUse?receiptQueryProcessedReference(result):null;
 return <section className="fiscal-receipt-queries" aria-label="Consultas de processamento" aria-busy={busy} hidden={!canUse} inert={!canUse}>
  <h5>Consultas de processamento</h5><p>Confira o resultado do recibo desta nota de homologação. Consultar o processamento não envia a nota novamente.</p>
  <div className="receipt-query-actions"><button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void readContext()}>Atualizar condições da consulta</button><button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void readHistory()}>Ver consultas registradas</button></div>
  {busy&&<p role="status">Conferindo a consulta…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {pending&&<div role="status"><p>Resultado ainda não confirmado. Consulte este comando antes de qualquer nova ação.</p><p>Comando: <code>{activeAttempt?.commandId}</code></p><button type="button" className="primary-button" disabled={!canUse||busy} onClick={()=>activeAttempt&&void execute(activeAttempt,false)}>Consultar o mesmo comando</button></div>}
  {resolution&&<section aria-label="Resolução das consultas" className="receipt-query-resolution"><h6>Resultado registrado pelas consultas</h6><p><strong>{resolution.state==='authorized_homologation'?'Autorizada em homologação · consulta de recibo':resolution.state==='conflict'?'Respostas divergentes; requer conferência':resolution.state==='rejected'?'Rejeição registrada · consulta de recibo':resolution.state==='review_required'?'Resposta requer conferência':'Processamento ainda sem resolução conclusiva'}</strong></p>{resolution.protocol&&<p>Código do protocolo: {resolution.protocol.protocol_cstat}.{resolution.protocol.protocol_number&&<> Protocolo: <code>{resolution.protocol.protocol_number}</code>.</>} Recebido em {fiscalMoment(resolution.protocol.received_at)}.</p>}{resolution.selected_query_id&&resolution.selected_query_id!==result?.command_id&&<button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void readSelected(resolution)}>Conferir consulta que sustenta o resultado</button>}<p className="receipt-query-note">Registro de homologação, sem valor fiscal de produção. Não informa eventos posteriores, como cancelamento.</p></section>}
  {result&&<section aria-label="Comando consultado"><h6>Consulta selecionada</h6><p>{receiptQueryStateLabel[result.current.state]} · consulta {result.receipt.ordinal}.</p>{result.observation&&<p>Código do lote: {result.observation.cstat??'Não validado'}.{result.observation.protocol_cstat&&<> Código do protocolo: {result.observation.protocol_cstat}.</>}</p>}{result.observation?.outcome==='invalid_response'&&<p>A resposta foi guardada, mas não passou na conferência local.</p>}<button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void registered(result)}>Atualizar este comando</button>{result.current.can_recover&&<button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>recover(result)}>Conferir resposta já guardada</button>}<details><summary>Identificação da consulta</summary><p>Comando: <code>{result.command_id}</code></p><p>Registrado em {fiscalMoment(result.receipt.created_at)}.</p></details></section>}
  {files&&controller.fiscalProcessedDocument&&<FiscalProcessedDocument key={processedReferenceKey(files)} controller={controller as ReceiptQueryController&Required<Pick<ReceiptQueryController,'fiscalProcessedDocument'>>} source={files} blocked={locked||pending}/>}
  {context&&!pending&&<section aria-label="Condições da consulta">{context.blockers.length>0&&<ul>{context.blockers.map(b=><li key={b}>{receiptQueryBlockerLabel[b]}</li>)}</ul>}{context.next_query_at&&<p>Próximo horário indicado: {fiscalMoment(context.next_query_at)}. Atualize as condições para conferir se uma nova consulta está disponível.</p>}{context.can_query&&<><label className="receipt-query-confirm"><input type="checkbox" checked={confirmed} disabled={!canConfirm(context)} aria-label="Confirmo a consulta de processamento" onChange={e=>{if(canConfirm(context)){accepted.current=e.target.checked?context:null;setConfirmed(e.target.checked);notify();}}}/>Confirmo a consulta deste recibo na SEFAZ, sem reenviar a nota.</label><button type="button" className="primary-button" disabled={!canConfirm(context)||!confirmed} onClick={()=>confirm(context)}>Consultar processamento na SEFAZ</button>{!policyCurrent()&&<p>Atualize as condições: a janela exibida não permite confirmar uma consulta agora.</p>}</>}</section>}
  {(context||history)&&<details><summary>Consultas registradas ({rows.length})</summary>{rows.length===0?<p>Nenhuma consulta registrada nesta leitura.</p>:<ol className="receipt-query-history">{rows.map(row=><li key={row.command_id}><span>Consulta {row.receipt.ordinal} · {receiptQueryStateLabel[row.current.state]} · {fiscalMoment(row.receipt.created_at)}</span><button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void registered(row)}>Conferir consulta {row.receipt.ordinal}</button></li>)}</ol>}{history?.next_before!==null&&history!==null&&<button type="button" className="secondary-button" disabled={locked||pending} onClick={()=>void readHistory(history)}>Página anterior de consultas</button>}{!history&&rows.length===25&&<p>São mostradas as 25 consultas mais recentes. Abra as consultas registradas para navegar pelas páginas.</p>}</details>}
  {(context||history||result)&&<details><summary>Registros que deram origem a esta consulta</summary><p><strong>Resultado original:</strong> {reference.original.state==='receipt_pending'?'recibo103 recebido, com processamento pendente.':'resposta guardada; conferência local necessária.'}</p>{reference.revalidation&&<p><strong>Conferência posterior:</strong> recibo103 confirmado por revalidação; o registro original permanece preservado.</p>}<p>Comando original: <code>{reference.authorization_command_id}</code></p></details>}
  {!pending&&<button type="button" className="secondary-button" disabled={!canUse||busy} onClick={dismiss}>Fechar consultas de processamento</button>}
 </section>;
}
