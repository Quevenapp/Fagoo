import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController,type NativeRequestOptions} from '../lib/real-access';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {isAppImportFailure,APP_UPDATE_MESSAGE} from '../lib/import-failure';
import {REVIEWED_AUTHORIZATION_BASE as BASE,REVIEWED_AUTHORIZATION_LABELS as LABELS,captureReviewedAuthorizationRequest,reviewedAuthorizationResponse,bindReviewedAuthorizationResult,bindReviewedPreflight,reviewedAuthorizationRun,REVIEWED_PREFLIGHT_BLOCKERS,type PreflightResult,type DispatchRunInput,type DispatchStatus,type DispatchHistory,type DispatchResult} from '../lib/fiscal-reviewed-authorization-model';
import {expiredClosureEligible} from '../lib/fiscal-authorization-closure-model';
import FiscalAuthorizationClosure from './FiscalAuthorizationClosure';
import FiscalAuthorizationClosureReceipt from './FiscalAuthorizationClosureReceipt';
import {closureLookupEligible,closureLookupInput,closureLookupPath,bindClosureLookupResult,type ClosureResult} from '../lib/fiscal-authorization-closure-lookup-model';
import {reviewedResponseDiagnostic} from '../lib/fiscal-reviewed-response-diagnostic';
import {revalidationContextAvailable} from '../lib/fiscal-stored-response-revalidation-model';
import FiscalStoredResponseRevalidation from './FiscalStoredResponseRevalidation';
import FiscalReceiptQueries from './FiscalReceiptQueries';
import {receiptQueryAuthorizationReference,type ReceiptQueryReference} from '../lib/fiscal-receipt-query-model';
import FiscalProcessedDocument from './FiscalProcessedDocument';
import {processedAuthorizationReference} from '../lib/fiscal-processed-document-model';
import {reviewedPreflightWindow} from '../lib/fiscal-reviewed-authorization-model';
import {EMISSION_WINDOW_BLOCKERS} from '../../../../packages/fiscal-authorization/src/preflight-dto.mjs';
import './fiscal-reviewed-authorization.css';
type Controller=Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalReviewedAuthorization'|'fiscalProcessedDocument'>&Partial<Pick<AccessController,'fiscalReceiptQuery'>>;
type Props={controller:Controller;candidate:SignedCandidate;blocked?:boolean;reviewRevision?:number;getReviewRevision?:()=>number;onBusy?:(value:boolean)=>void};
type Attempt={kind:'run'|'recover';commandId:string;previous:DispatchResult|null;ack:DispatchResult|null;body:DispatchRunInput|null};
const sourceKey=(c:SignedCandidate)=>[c.candidate_id,c.candidate_version,c.model,c.artifact?.sha256,c.artifact?.size_bytes,c.unsigned_job_id,c.basis_hash,c.completion_version,c.completion_hash,c.a1_version].join(':');
const actor=(c:Controller)=>c.getSnapshot().membership?.user_id??null;
const permitted=(c:Controller)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const message=(e:unknown,action:'read'|'command'|'run'|'recover'='command')=>{
 if(isAppImportFailure(e))return APP_UPDATE_MESSAGE;
 if(e instanceof AccessError&&[401,403].includes(e.status))return 'Seu acesso precisa ser reconfirmado antes da próxima consulta.';
 if(e instanceof AccessError&&e.status===404)return action==='read'?'A consulta não encontrou o registro solicitado.':'O comando não foi localizado nesta consulta. Isso não autoriza repetir o envio.';
 if(action==='run'||action==='recover')return `Não foi possível confirmar o resultado ${action==='run'?'do envio':'da recuperação'}. Consulte o mesmo comando; não repita o envio.`;
 return action==='read'?'A consulta não foi concluída. Tente consultar novamente.':'A consulta não foi concluída. Tente consultar o mesmo comando novamente.';
};
/** The displayed backend selection is immutable per command; uncertainty permits GET only. */
export default function FiscalReviewedAuthorization({controller,candidate,blocked=false,reviewRevision=0,getReviewRevision,onBusy}:Props){
 const uid=useId(),[preflight,setPreflight]=useState<PreflightResult|null>(null),[confirmed,setConfirmed]=useState(false),[status,setStatus]=useState<DispatchStatus|null>(null),[history,setHistory]=useState<DispatchHistory|null>(null),[selected,setSelected]=useState<DispatchResult|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[,render]=useState(0);
 const [closureTarget,setClosureTarget]=useState<DispatchResult|null>(null),closing=useRef<DispatchResult|null>(null);
 const [closureReadback,setClosureReadback]=useState<ClosureResult|null>(null);
 const [revalidationTarget,setRevalidationTarget]=useState<DispatchResult|null>(null),revalidating=useRef<DispatchResult|null>(null),revalidationGuard=useRef(false);
 const [receiptQueryTarget,setReceiptQueryTarget]=useState<ReceiptQueryReference|null>(null),querying=useRef<ReceiptQueryReference|null>(null),receiptQueryGuard=useRef(false);
 const alive=useRef(true),owner=useRef(actor(controller)),scope=useRef(sourceKey(candidate)),epoch=useRef(0),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),callbacks=useRef({onBusy});callbacks.current={onBusy};
 const live=useRef({candidate,blocked,history,selected,preflight,confirmed,reviewRevision,getReviewRevision});live.current={candidate,blocked,history,selected,preflight,confirmed,reviewRevision,getReviewRevision};
 const checkedRevision=useRef(reviewRevision),preflightClock=useRef<{value:PreflightResult;started:number}|null>(null);
 const invalidate=()=>{live.current.preflight=null;live.current.confirmed=false;preflightClock.current=null;setPreflight(null);setConfirmed(false);};
 const renderedActor=actor(controller),renderedScope=sourceKey(candidate);
 const notify=()=>{setBusy(Boolean(request.current));setPending(Boolean(attempt.current));callbacks.current.onBusy?.(Boolean(request.current||attempt.current||closing.current||revalidationGuard.current||receiptQueryGuard.current));};
 const stop=()=>{epoch.current++;request.current?.abort();request.current=null;notify();};
 const clear=()=>{invalidate();attempt.current=null;closing.current=null;revalidating.current=null;revalidationGuard.current=false;querying.current=null;receiptQueryGuard.current=false;setReceiptQueryTarget(null);setRevalidationTarget(null);setClosureTarget(null);setClosureReadback(null);stop();setStatus(null);setHistory(null);setSelected(null);live.current.history=null;live.current.selected=null;setError('');setNotice('');};
 const authorized=()=>permitted(controller)&&actor(controller)===owner.current;
 const sameView=()=>renderedActor===owner.current&&renderedScope===scope.current;
 const available=()=>alive.current&&sameView()&&authorized()&&!request.current&&!live.current.blocked&&live.current.candidate.status==='stored'&&Boolean(live.current.candidate.artifact);
 const free=()=>available()&&!attempt.current&&!closing.current&&!revalidating.current&&!querying.current;
 const valid=(p:AbortController,generation:number)=>alive.current&&request.current===p&&!p.signal.aborted&&epoch.current===generation&&authorized()&&scope.current===sourceKey(live.current.candidate);
 useLayoutEffect(()=>()=>callbacks.current.onBusy?.(false),[]);
 useEffect(()=>{
  alive.current=true;const unsubscribe=controller.subscribe(()=>{const next=actor(controller);if(next!==owner.current||controller.getSnapshot().phase==='signed_out'){clear();owner.current=next;}else if(!permitted(controller)){invalidate();stop();}render(n=>n+1);});
  return()=>{alive.current=false;epoch.current++;request.current?.abort();request.current=null;unsubscribe();};
 },[controller]);
 useEffect(()=>{const next=sourceKey(candidate);if(scope.current!==next){clear();scope.current=next;}},[candidate.candidate_id,candidate.candidate_version,candidate.model,candidate.artifact?.sha256,candidate.artifact?.size_bytes,candidate.unsigned_job_id,candidate.basis_hash,candidate.completion_version,candidate.completion_hash,candidate.a1_version]);
 useEffect(()=>{invalidate();},[reviewRevision]);
 const revisionCurrent=()=>checkedRevision.current===live.current.reviewRevision&&(!live.current.getReviewRevision||checkedRevision.current===live.current.getReviewRevision());
 const preflightNow=()=>{const mark=preflightClock.current,v=live.current.preflight;return Math.max(Date.now(),mark?.value===v&&v?.emission_window?Date.parse(v.emission_window.observed_at)+Math.max(0,performance.now()-mark.started):0);};
 const emissionBlocker=()=>{const v=live.current.preflight;if(!v)return null;const w=reviewedPreflightWindow(v,Math.ceil(preflightNow()));return w&&w.status!=='valid'?EMISSION_WINDOW_BLOCKERS[w.status]:null;};
 const withinPreflight=()=>{const v=live.current.preflight,now=preflightNow();return Boolean(v&&v.review&&v.policy&&now<Date.parse(v.review.valid_until)&&now<Date.parse(v.policy.valid_until)&&!emissionBlocker());};
 useEffect(()=>{if(!preflight?.can_run||!preflight.review||!preflight.policy)return;const end=Math.min(Date.parse(preflight.review.valid_until),Date.parse(preflight.policy.valid_until),preflight.emission_window?Date.parse(preflight.emission_window.send_before):Infinity),timer=setTimeout(()=>{if(live.current.preflight===preflight){const code=emissionBlocker();if(code){live.current.confirmed=false;setConfirmed(false);render(n=>n+1);setError(REVIEWED_PREFLIGHT_BLOCKERS[code]);}else{invalidate();setError('A conferência expirou. Confira novamente antes de confirmar o envio.');}}},Math.max(0,Math.min(2147483647,end-preflightNow())));return()=>clearTimeout(timer);},[preflight]);
 const unfinished=(row:DispatchResult|null)=>Boolean(row&&['prepared','request_ready','dispatched','submission_uncertain','receipt_pending'].includes(row.status));
 const canSend=()=>free()&&revisionCurrent()&&withinPreflight()&&live.current.preflight?.can_run===true&&!unfinished(live.current.selected)&&!(live.current.history?.items.some(unfinished));
 const query=async(path:string,options:NativeRequestOptions)=>{const captured=captureReviewedAuthorizationRequest(path,options);return reviewedAuthorizationResponse(await controller.fiscalReviewedAuthorization(path,options),captured);};
 const start=()=>{const p=new AbortController();request.current=p;notify();setError('');setNotice('');setClosureReadback(null);return{p,generation:epoch.current};};
 const shownRow=(row:DispatchResult)=>Boolean(row.receipt&&[...(live.current.history?.items??[]),...(live.current.selected?[live.current.selected]:[])].some(r=>r===row));
 const ownRow=(row:DispatchResult)=>Boolean(row.recoverable_by_actor&&shownRow(row));
 const read=async(kind:'preflight'|'status'|'history'|'command'|'closure'|'closureLookup',before:string|null=null,row:DispatchResult|null=null)=>{
  if(!free()||kind==='command'&&(!row||!ownRow(row))||kind==='closure'&&(!row||!shownRow(row)||!expiredClosureEligible(row))||kind==='closureLookup'&&(!row||!shownRow(row)||!closureLookupEligible(row)))return;
  const {p,generation}=start(),c=live.current.candidate,revision=live.current.reviewRevision,started=performance.now();
  if(kind==='preflight')invalidate();
  try{
   if(kind==='preflight'){const value=bindReviewedPreflight(await query(BASE+'/preflight',{method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact!.sha256},signal:p.signal}) as PreflightResult,c);if(valid(p,generation)&&revision===live.current.reviewRevision&&(!live.current.getReviewRevision||revision===live.current.getReviewRevision())){checkedRevision.current=revision;preflightClock.current={value,started};live.current.preflight=value;setPreflight(value);}}
   else if(kind==='status'){const value=await query(BASE+'/status',{signal:p.signal}) as DispatchStatus;if(valid(p,generation))setStatus(value);}
   else if(kind==='closureLookup'){
    const input=closureLookupInput(row!,c),value=bindClosureLookupResult(await query(closureLookupPath(input),{signal:p.signal}),input,c,row!);
    if(valid(p,generation))setClosureReadback(value);
   }else if(kind==='history'){
    const value=await query(`${BASE}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before},signal:p.signal}) as DispatchHistory;
    value.items.forEach(item=>bindReviewedAuthorizationResult(item,c));if(valid(p,generation)){live.current.history=value;setHistory(value);live.current.selected=null;setSelected(null);}
   }else{
    const value=bindReviewedAuthorizationResult(await query(`${BASE}/commands/${row!.command_id}`,{signal:p.signal}) as DispatchResult,c,row);
    if(valid(p,generation)){live.current.selected=value;setSelected(value);
     if(kind==='closure'&&expiredClosureEligible(value)){invalidate();closing.current=value;setClosureTarget(value);}
     else setNotice(kind==='closure'?'A situação da tentativa mudou. O encerramento não está disponível nesta consulta.':'Comando consultado. Nenhum envio foi repetido.');}
   }
  }catch(e){if(valid(p,generation)&&!(e instanceof DOMException&&e.name==='AbortError'))setError(kind==='closureLookup'?(e instanceof AccessError&&e.status===404?'Nenhum recibo de encerramento foi localizado nesta consulta. Isso não autoriza encerrar novamente ou enviar a nota.':e instanceof AccessError&&[401,403].includes(e.status)?'Somente o usuário que registrou o encerramento, com acesso fiscal ativo, pode consultar este recibo. O histórico da tentativa permanece disponível.':'Não foi possível consultar o recibo de encerramento. Tente consultar novamente; nenhuma operação será repetida.'):kind==='preflight'?'Não foi possível conferir as condições de envio. Faça uma nova conferência.':message(e,kind==='command'||kind==='closure'?'command':'read'));}
  finally{if(valid(p,generation)){request.current=null;notify();}}
 };
 const executeRecovery=async(post:boolean)=>{
  const op=attempt.current;if(!op||!available())return;
  const {p,generation}=start(),c=live.current.candidate;
  try{
   if(post){
    const value=await query(BASE+(op.kind==='run'?'/run':'/recover'),{method:'POST',body:op.body??{command_id:op.commandId},signal:p.signal}) as DispatchResult;if(!valid(p,generation))return;
    if(value.status==='unconfirmed'){setError(`${value.failure_code&&REVIEWED_PREFLIGHT_BLOCKERS[value.failure_code]?REVIEWED_PREFLIGHT_BLOCKERS[value.failure_code]+' ':''}O resultado não foi confirmado. Consulte o mesmo comando; o envio não será repetido.`);return;}
    op.ack=bindReviewedAuthorizationResult(value,c,op.previous,op.body);
   }
   const value=bindReviewedAuthorizationResult(await query(`${BASE}/commands/${op.commandId}`,{signal:p.signal}) as DispatchResult,c,op.ack??op.previous,op.body);
   if(valid(p,generation)){attempt.current=null;live.current.selected=value;setSelected(value);setNotice(op.kind==='run'?'Resultado do comando consultado. Nenhum envio será repetido automaticamente.':'Resultado consultado. A recuperação utiliza apenas registros já guardados, sem novo envio à SEFAZ.');}
  }catch(e){if(valid(p,generation)&&!(e instanceof DOMException&&e.name==='AbortError')){
   const definite=post&&op.kind==='run'&&!op.ack&&e instanceof AccessError&&[400,401,403,404,409,413,415,422,503].includes(e.status)&&(e as AccessError&{recovery_required?:boolean}).recovery_required===false;
   if(definite){const code=(e as AccessError&{code?:string}).code;attempt.current=null;invalidate();setError(code&&REVIEWED_PREFLIGHT_BLOCKERS[code]?REVIEWED_PREFLIGHT_BLOCKERS[code]:'O envio não foi iniciado. Confira novamente as condições antes de confirmar.');}else setError(message(e,op.kind));
  }}
  finally{if(valid(p,generation)){request.current=null;notify();}}
 };
 const send=()=>{if(free()&&live.current.preflight?.can_run&&!withinPreflight()){const code=emissionBlocker();live.current.confirmed=false;setConfirmed(false);if(!code)invalidate();setError(code?REVIEWED_PREFLIGHT_BLOCKERS[code]:'A conferência expirou. Confira novamente antes de confirmar o envio.');return;}if(!canSend()||!live.current.confirmed)return;try{const body=reviewedAuthorizationRun(live.current.preflight!,live.current.candidate,true,crypto.randomUUID(),Math.ceil(preflightNow()));attempt.current={kind:'run',commandId:body.command_id,body,previous:null,ack:null};invalidate();setHistory(null);live.current.history=null;setSelected(null);live.current.selected=null;notify();void executeRecovery(true);}catch{invalidate();setError('Confira novamente as condições de envio.');}};
 const recover=(row:DispatchResult)=>{
  if(!free()||!ownRow(row)||!row.current?.recovery_required)return;
  // The original command identifies the existing journal. Never create a new command or retry submission.
  attempt.current={kind:'recover',commandId:row.command_id,previous:row,ack:null,body:null};invalidate();setHistory(null);live.current.history=null;notify();void executeRecovery(true);
 };
 const openRevalidation=(row:DispatchResult)=>{if(!free()||!shownRow(row)||!revalidationContextAvailable(row))return;invalidate();revalidating.current=row;revalidationGuard.current=true;setRevalidationTarget(row);notify();};
 const openReceiptQuery=(row:DispatchResult)=>{if(!free()||!shownRow(row)||typeof controller.fiscalReceiptQuery!=='function')return;const reference=receiptQueryAuthorizationReference(row,live.current.candidate);if(!reference)return;invalidate();querying.current=reference;setReceiptQueryTarget(reference);notify();};
 const canUse=authorized()&&sameView(),locked=!canUse||blocked||busy||pending||Boolean(closureTarget)||Boolean(revalidationTarget)||Boolean(receiptQueryTarget);
 const emissionMoment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'medium'});
 const timeBlocker=emissionBlocker(),visibleBlockers=preflight?[...new Set([...preflight.blockers,...(timeBlocker?[timeBlocker]:[])])]:[];
 const details=(row:DispatchResult)=>{const r=row.receipt!,a=row.artifact,c=row.current!,diagnostic=reviewedResponseDiagnostic(a),processed=processedAuthorizationReference(row,candidate);return <div className="reviewed-authorization-details">
  <p>Registrada em {fiscalMoment(r.created_at)}. {!a&&'Nenhuma resposta final foi confirmada nesta consulta.'}</p>
  {diagnostic?.kind==='validation'&&<div><p><strong>Falha na validação da resposta.</strong> {diagnostic.message}</p>{diagnostic.code&&<p>Código de validação: <code>{diagnostic.code}</code>.</p>}<p>Este registro não confirma autorização. Consulte esta tentativa; não repita o envio.</p></div>}
  {diagnostic?.kind==='sefaz'&&<p>Código de resposta da SEFAZ: <code>{diagnostic.code}</code>. {diagnostic.batchCode&&<>Código do lote: <code>{diagnostic.batchCode}</code>.</>}</p>}
  {row.status==='rejected'&&diagnostic?.kind==='sefaz'&&diagnostic.code==='245'&&<p><strong>CNPJ do emitente não cadastrado.</strong> Confira os dados do emitente e o credenciamento de {candidate.model==='65'?'NFC-e':'NF-e'} no ambiente de homologação da SEFAZ-SP. Esta tentativa foi rejeitada; o envio não será repetido automaticamente.</p>}
  {a&&!diagnostic&&<p>A resposta foi guardada, mas não há diagnóstico disponível nesta consulta.</p>}
  {row.authorized_in_homologation&&<p>Autorização de homologação registrada. Não tem valor fiscal de produção.</p>}
  {a?.outcome==='receipt_pending'&&<p>O registro original contém um recibo pendente. Abra as consultas de processamento para conferir os resultados posteriores.</p>}
  {['prepared','request_ready'].includes(row.status)&&<p>Esta tentativa ainda está pendente, sem envio confirmado. A consulta não autoriza um novo envio. {c.lease_expired?'É possível conferir o encerramento desta preparação expirada; o servidor verifica o usuário original e a ausência de envio registrado.':'O prazo da preparação ainda não terminou.'}</p>}
  {c.recovery_required&&<p>O resultado está pendente. Recuperar utiliza somente o registro já guardado; não reenvia a nota.</p>}
  <p>{c.identity_changed||c.a1_changed||c.policy_changed||c.candidate.basis_changed||!c.candidate.artifact_current?'As bases atuais diferem da captura desta tentativa. O registro histórico continua preservado.':'Situação atual consultada sem diferenças sinalizadas nas bases.'}</p>
  {row.subset_review&&<p>Revisão fiscal usada: versão {row.subset_review.review_version}. Abrange apenas as regras listadas no perfil; não representa validação tributária integral.</p>}
  <details><summary>Identificação da tentativa</summary><p>Comando: <code>{row.command_id}</code></p><p>Política {r.policy_version} · empresa {r.identity_version} · certificado {r.a1_version} · assinatura {r.signing_a1_version}.</p></details>
  {processed&&typeof controller.fiscalProcessedDocument==='function'&&<FiscalProcessedDocument controller={controller} source={processed} blocked={locked}/>}
 </div>;};
 const actions=(row:DispatchResult)=><div className="button-group">{row.recoverable_by_actor&&<><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('command',null,row)}>Consultar comando da tentativa {row.receipt!.ordinal}</button>{row.current?.recovery_required&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>recover(row)}>Recuperar registro da tentativa {row.receipt!.ordinal}</button>}</>}{expiredClosureEligible(row)&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('closure',null,row)}>Conferir encerramento da tentativa {row.receipt!.ordinal}</button>}{revalidationContextAvailable(row)&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>openRevalidation(row)}>Conferir resposta armazenada da tentativa {row.receipt!.ordinal}</button>}{typeof controller.fiscalReceiptQuery==='function'&&receiptQueryAuthorizationReference(row,candidate)&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>openReceiptQuery(row)}>Ver processamento da tentativa {row.receipt!.ordinal}</button>}{closureLookupEligible(row)&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('closureLookup',null,row)}>Consultar encerramento da tentativa {row.receipt!.ordinal}</button>}</div>;
 return <>
  {!canUse&&<p role="alert">Seu perfil não permite consultar a autorização revisada. Uma tentativa pendente permanece protegida para este mesmo usuário.</p>}
  <section className="fiscal-reviewed-authorization" hidden={!canUse} inert={!canUse} aria-hidden={!canUse||undefined} aria-labelledby={`${uid}-title`} aria-busy={busy}>
   <header><span>Homologação · São Paulo</span><h4 id={`${uid}-title`}>Autorização com revisão fiscal</h4></header>
   <p className="real-notice">Confira esta assinatura e a revisão fiscal antes de confirmar o envio de homologação. Essa conferência não valida todos os tributos.</p>
   <div className="button-group"><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('preflight')}>Conferir antes do envio</button><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('history')}>Consultar histórico da autorização revisada</button></div>
   {preflight&&<section className="reviewed-authorization-preflight" aria-live="polite"><h5>{preflight.can_run&&!timeBlocker?'Condições de envio conferidas':'Pendências para o envio'}</h5>
    {visibleBlockers.length>0&&<ul>{visibleBlockers.map(code=><li key={code}>{REVIEWED_PREFLIGHT_BLOCKERS[code]}</li>)}</ul>}
    {preflight.can_run&&!timeBlocker&&<p>Esta conferência corresponde à assinatura atual e à revisão fiscal exibida. Confirme somente se deseja enviar esta nota de homologação.</p>}
    {preflight.emission_window&&<p>Data de emissão do XML: {emissionMoment(preflight.emission_window.issued_at)}. Inicie o envio antes de {emissionMoment(preflight.emission_window.send_before)}. O prazo fiscal é de 5 minutos. O FAGOO reserva os últimos 30 segundos para o envio; a recepção pela SEFAZ ainda precisa ocorrer no prazo.</p>}
    {preflight.review&&<p>Revisão fiscal {preflight.review.review_version} · válida até {fiscalMoment(preflight.review.valid_until)}.</p>}
    <details><summary>Detalhes da conferência</summary><p>Conferido em {fiscalMoment(preflight.observed_at)}. Assinatura {preflight.candidate.candidate_version} · empresa {preflight.versions.identity??'indisponível'} · certificado {preflight.versions.a1??'indisponível'} · política {preflight.versions.policy??'indisponível'}.</p><p>Hash da assinatura: <code>{preflight.candidate.signed_hash}</code></p>{preflight.review&&<p>Hash da revisão: <code>{preflight.review.review_hash}</code></p>}</details>
   </section>}
   {preflight?.can_run&&<label className="reviewed-authorization-confirm"><input type="checkbox" aria-label="Confirmo o envio desta nota de homologação" checked={confirmed} disabled={!canSend()} onChange={e=>{if(canSend()){live.current.confirmed=e.target.checked;setConfirmed(e.target.checked);}}}/>Confirmo o envio desta nota de homologação com a revisão fiscal conferida.</label>}
   <button type="button" className="primary-button" disabled={!canSend()||!confirmed} onClick={send}>Enviar para autorização de homologação</button>
   <details><summary>Disponibilidade técnica</summary><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('status')}>Consultar disponibilidade do envio</button>
   {status&&<p>{status.runtime_enabled?'O serviço está disponível, mas essa consulta não confere a política nem habilita o envio.':'O envio está desativado neste ambiente. As consultas e a recuperação de registros não habilitam emissão.'}</p>}
   </details>
   {busy&&<p role="status">Consultando autorização revisada…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
   {pending&&<div className="reviewed-authorization-recovery"><p>Consulte o mesmo comando para confirmar o resultado. A tentativa permanece nesta aba; não é salva localmente após recarregar.</p><p>Comando: <code>{attempt.current?.commandId}</code></p><button type="button" className="primary-button" disabled={!canUse||blocked||busy} onClick={()=>void executeRecovery(false)}>{attempt.current?.kind==='run'?'Consultar resultado do envio':'Consultar resultado da recuperação'}</button></div>}
   {closureTarget&&<FiscalAuthorizationClosure controller={controller} candidate={candidate} original={closureTarget} blocked={blocked||busy||pending}
    onBusy={()=>{if(closing.current===closureTarget)notify();}}
    onClosed={()=>{if(alive.current&&authorized()&&closing.current===closureTarget){invalidate();setHistory(null);live.current.history=null;setSelected(null);live.current.selected=null;setNotice('');}}}
    onDismiss={()=>{if(available()&&!attempt.current&&closing.current===closureTarget){closing.current=null;setClosureTarget(null);notify();}}}/>}
   {revalidationTarget&&<FiscalStoredResponseRevalidation controller={controller} candidate={candidate} original={revalidationTarget} blocked={blocked||busy||pending}
    onBusy={value=>{if(revalidating.current===revalidationTarget){revalidationGuard.current=value;notify();}}}
    onDismiss={()=>{if(!alive.current||!sameView()||!authorized()||request.current||attempt.current||revalidating.current!==revalidationTarget)return false;revalidating.current=null;revalidationGuard.current=false;setRevalidationTarget(null);notify();return true;}}/>}
   {receiptQueryTarget&&typeof controller.fiscalReceiptQuery==='function'&&<FiscalReceiptQueries controller={controller as Controller&Pick<AccessController,'fiscalReceiptQuery'>} reference={receiptQueryTarget} blocked={blocked||busy||pending}
    onBusy={value=>{if(querying.current===receiptQueryTarget){receiptQueryGuard.current=value;notify();}}}
    onDismiss={()=>{if(!alive.current||!sameView()||!authorized()||request.current||attempt.current||querying.current!==receiptQueryTarget)return false;querying.current=null;receiptQueryGuard.current=false;setReceiptQueryTarget(null);notify();return true;}}/>}
   {closureReadback&&<FiscalAuthorizationClosureReceipt value={closureReadback}/>}
   {selected&&<section aria-live="polite"><h5>Última consulta · {LABELS[selected.status]}</h5>{details(selected)}{actions(selected)}</section>}
   {history?<section><h5>Histórico da autorização revisada</h5><p>As capturas são históricas. A disponibilidade atual do certificado não impede esta leitura. Recuperar exige uma tentativa identificada como sua. Conferir encerramento faz uma consulta de acesso antes de permitir qualquer alteração. Consultar encerramento procura um recibo já registrado, sem repetir a operação.</p>
    {!history.items.length&&<p>Nenhuma tentativa registrada nesta página.</p>}{history.items.map(row=><article key={row.command_id}><h6>Tentativa {row.receipt!.ordinal} · {LABELS[row.status]}</h6>{details(row)}{actions(row)}</article>)}
    {history.has_more&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('history',history.next_cursor)}>Tentativas anteriores da autorização revisada</button>}
   </section>:<p>Consulte o histórico para ver as tentativas registradas desta assinatura.</p>}
  </section>
 </>;
}
