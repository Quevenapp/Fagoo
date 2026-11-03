import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController,type NativeRequestOptions} from '../lib/real-access';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {REVIEWED_AUTHORIZATION_BASE as BASE,type DispatchResult} from '../lib/fiscal-reviewed-authorization-model';
import {bindRevalidationContext,bindRevalidationResult,revalidationContextPath,revalidationCommandPath,revalidationIntent,type RevalidationInput,type RevalidationContext,type RevalidationResult} from '../lib/fiscal-stored-response-revalidation-model';
import FiscalProcessedDocument from './FiscalProcessedDocument';
import FiscalReceiptQueries from './FiscalReceiptQueries';
import {receiptQueryRevalidationReference,type ReceiptQueryReference} from '../lib/fiscal-receipt-query-model';
import {processedRevalidationReference} from '../lib/fiscal-processed-document-model';
type Controller=Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalReviewedAuthorization'|'fiscalProcessedDocument'>&Partial<Pick<AccessController,'fiscalReceiptQuery'>>;
type Props={controller:Controller;candidate:SignedCandidate;original:DispatchResult;blocked?:boolean;onBusy?:(value:boolean)=>void;onDismiss:()=>boolean};
type Attempt={body:RevalidationInput;context:RevalidationContext;ack:RevalidationResult|null};
const actor=(c:Controller)=>c.getSnapshot().membership?.user_id??null;
const permitted=(c:Controller)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const source=(c:SignedCandidate,r:DispatchResult)=>[c.candidate_id,c.candidate_version,c.model,c.artifact?.sha256,r.command_id,r.receipt?.attempt_id,r.artifact?.response_hash].join(':');
const labels:Record<string,string>={authorized_homologation:'Autorização de homologação conferida',receipt_pending:'Recibo recebido; processamento pendente',rejected:'Resposta de rejeição conferida',review_required:'Resposta ainda requer conferência'};
/** Separate append-only revalidation. A pending POST is recovered only with its own command GET. */
export default function FiscalStoredResponseRevalidation({controller,candidate,original,blocked=false,onBusy,onDismiss}:Props){
 const [context,setContext]=useState<RevalidationContext|null>(null),[result,setResult]=useState<RevalidationResult|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[refused,setRefused]=useState(false),[,render]=useState(0);
 const [receiptQueryTarget,setReceiptQueryTarget]=useState<ReceiptQueryReference|null>(null),querying=useRef<ReceiptQueryReference|null>(null),receiptQueryGuard=useRef(false);
 const alive=useRef(true),owner=useRef(actor(controller)),scope=useRef(source(candidate,original)),epoch=useRef(0),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),retired=useRef(false),rejected=useRef(false);
 const live=useRef({candidate,original,blocked,onBusy,onDismiss,context,result,confirmed});live.current={candidate,original,blocked,onBusy,onDismiss,context,result,confirmed};
 const renderedActor=actor(controller),renderedSource=source(candidate,original);
 const authorized=()=>permitted(controller)&&actor(controller)===owner.current;
 const same=()=>renderedActor===owner.current&&renderedSource===scope.current;
 const notify=()=>{setBusy(Boolean(request.current));setPending(Boolean(attempt.current));live.current.onBusy?.(Boolean(request.current||attempt.current||live.current.confirmed||receiptQueryGuard.current));};
 const invalidate=()=>{live.current.confirmed=false;setConfirmed(false);};
 const stop=()=>{epoch.current++;request.current?.abort();request.current=null;invalidate();notify();};
 const clear=()=>{querying.current=null;receiptQueryGuard.current=false;setReceiptQueryTarget(null);attempt.current=null;rejected.current=false;setRefused(false);live.current.context=null;live.current.result=null;setContext(null);setResult(null);setError('');stop();};
 const available=()=>alive.current&&!retired.current&&same()&&authorized()&&!request.current&&!live.current.blocked&&!querying.current;
 const valid=(p:AbortController,generation:number)=>alive.current&&!retired.current&&request.current===p&&!p.signal.aborted&&epoch.current===generation&&authorized()&&scope.current===source(live.current.candidate,live.current.original);
 useLayoutEffect(()=>()=>live.current.onBusy?.(false),[]);
 useEffect(()=>{alive.current=true;const unsubscribe=controller.subscribe(()=>{const next=actor(controller);if(next!==owner.current||controller.getSnapshot().phase==='signed_out'){clear();owner.current=next;}else if(!permitted(controller))stop();render(n=>n+1);});return()=>{alive.current=false;epoch.current++;request.current?.abort();request.current=null;unsubscribe();};},[controller]);
 useEffect(()=>{const next=source(candidate,original);if(scope.current!==next){clear();scope.current=next;}},[candidate.candidate_id,candidate.candidate_version,candidate.model,candidate.artifact?.sha256,original.command_id,original.receipt?.attempt_id,original.artifact?.response_hash]);
 const query=(path:string,options:NativeRequestOptions)=>controller.fiscalReviewedAuthorization(path,options);
 const readContext=async()=>{
  if(!available()||attempt.current||rejected.current)return;const p=new AbortController(),generation=epoch.current;request.current=p;invalidate();live.current.context=null;live.current.result=null;setContext(null);setResult(null);setError('');notify();
  try{const value=bindRevalidationContext(await query(revalidationContextPath(live.current.original),{signal:p.signal}),live.current.candidate,live.current.original);if(valid(p,generation)){live.current.context=value;live.current.result=value.existing;setContext(value);setResult(value.existing);}}
  catch(e){if(valid(p,generation)&&!(e instanceof DOMException&&e.name==='AbortError'))setError(e instanceof AccessError&&[401,403].includes(e.status)?'A consulta exige o usuário original da tentativa e acesso fiscal ativo.':'Não foi possível conferir a resposta armazenada. Consulte novamente; nenhuma revalidação foi iniciada.');}
  finally{if(valid(p,generation)){request.current=null;notify();}}
 };
 useEffect(()=>{void readContext();},[]);
 const execute=async(post:boolean)=>{
  const op=attempt.current;if(!op||!available())return;const p=new AbortController(),generation=epoch.current;request.current=p;setError('');notify();
  try{
   if(post){const raw=await query(BASE+'/revalidations',{method:'POST',body:op.body,signal:p.signal});if(!valid(p,generation))return;op.ack=bindRevalidationResult(raw,op.body,op.context,live.current.candidate,null,false);}
   const raw=await query(revalidationCommandPath(op.body),{signal:p.signal});if(!valid(p,generation))return;
   const value=bindRevalidationResult(raw,op.body,op.context,live.current.candidate,op.ack);attempt.current=null;live.current.result=value;setResult(value);invalidate();
  }catch(e){if(valid(p,generation)&&!(e instanceof DOMException&&e.name==='AbortError')){
   const definite=post&&!op.ack&&e instanceof AccessError&&[400,401,403,404,409,413,415,422,503].includes(e.status)&&(e as AccessError&{recovery_required?:boolean}).recovery_required===false;
   if(definite){attempt.current=null;rejected.current=true;setRefused(true);setError('A revalidação não foi registrada. Feche esta conferência e consulte novamente a resposta armazenada.');}
   else setError(e instanceof AccessError&&[401,403].includes(e.status)?'Seu acesso precisa ser reconfirmado. Depois consulte o mesmo comando de revalidação.':e instanceof AccessError&&e.status===404?'O comando não foi localizado nesta consulta. O resultado permanece pendente; não repita a operação.':'Não foi possível confirmar a revalidação. Consulte o mesmo comando para verificar o resultado.');
  }}finally{if(valid(p,generation)){request.current=null;notify();}}
 };
 const canConfirm=()=>available()&&!attempt.current&&!rejected.current&&!live.current.result&&live.current.context?.can_revalidate===true;
 const confirm=()=>{if(!canConfirm()||!live.current.confirmed)return;try{const checked=live.current.context!,body=revalidationIntent(checked,live.current.candidate,crypto.randomUUID(),true);attempt.current={body,context:checked,ack:null};invalidate();notify();void execute(true);}catch{invalidate();setError('Consulte novamente a resposta armazenada antes de confirmar.');}};
 const canDismiss=()=>alive.current&&!retired.current&&same()&&authorized()&&!request.current&&!attempt.current&&!querying.current;
 const dismiss=()=>{if(canDismiss()&&live.current.onDismiss()){retired.current=true;invalidate();}};
 const canUse=authorized()&&same(),locked=!canUse||blocked||busy||pending||Boolean(receiptQueryTarget);
 const queryReference=result?receiptQueryRevalidationReference(result,candidate,original):null;
 const openReceiptQuery=()=>{if(!available()||attempt.current||!live.current.result||typeof controller.fiscalReceiptQuery!=='function')return;const reference=receiptQueryRevalidationReference(live.current.result,live.current.candidate,live.current.original);if(!reference)return;invalidate();querying.current=reference;setReceiptQueryTarget(reference);notify();};
 const processed=result?processedRevalidationReference(result,candidate):null;
 return <section className="reviewed-authorization-closure" hidden={!canUse} inert={!canUse} aria-hidden={!canUse||undefined} aria-busy={busy} aria-label="Conferência da resposta armazenada">
  <h5>Conferir resposta armazenada</h5><p>Esta ação confere a resposta já guardada. Não envia a nota novamente nem consulta a SEFAZ.</p>
  <p><strong>Registro original:</strong> resposta requer conferência por falha de validação. Esse registro será preservado.</p>
  {busy&&<p role="status">Conferindo resposta armazenada…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {!pending&&!result&&!refused&&<><button type="button" className="secondary-button" disabled={locked} onClick={()=>void readContext()}>Atualizar conferência da resposta</button>
   {context?.can_revalidate&&<><label className="reviewed-authorization-confirm"><input type="checkbox" checked={confirmed} disabled={!canConfirm()} aria-label="Confirmo a revalidação da resposta armazenada" onChange={e=>{if(canConfirm()){live.current.confirmed=e.target.checked;setConfirmed(e.target.checked);notify();}}}/>Confirmo a revalidação da resposta armazenada, sem novo envio da nota.</label><button type="button" className="primary-button" disabled={!canConfirm()||!confirmed} onClick={confirm}>Revalidar resposta armazenada</button></>}
   {context&&!context.can_revalidate&&<p>A revalidação não está disponível para esta tentativa.</p>}</>}
  {pending&&<><p>O resultado ainda precisa ser confirmado. Consulte o mesmo comando. A tentativa em memória não sobrevive ao recarregamento; após recarregar, esta conferência procura um recibo já registrado.</p><p>Comando de revalidação: <code>{attempt.current?.body.command_id}</code></p><button type="button" className="primary-button" disabled={!canUse||blocked||busy} onClick={()=>void execute(false)}>Consultar resultado da revalidação</button></>}
  {result&&<section aria-live="polite"><h6>Resultado da revalidação</h6><p><strong>{labels[result.receipt.state]}</strong> · {fiscalMoment(result.receipt.created_at)}.</p><p>Código do lote: <code>{result.receipt.artifact.cstat}</code>. {result.receipt.artifact.protocol_cstat&&<>Código do protocolo: <code>{result.receipt.artifact.protocol_cstat}</code>.</>}</p>
   {result.receipt.state==='authorized_homologation'&&<p>A resposta de autorização de homologação foi conferida e registrada separadamente. Não tem valor fiscal de produção e não representa validação tributária integral.</p>}
   {result.receipt.state==='receipt_pending'&&<p>O recibo continua pendente de processamento. Esta revalidação não consulta o recibo na SEFAZ.</p>}
   <p>O registro original continua preservado. Este resultado não autoriza repetir o envio.</p><details><summary>Identificação da revalidação</summary><p>Comando: <code>{result.command_id}</code></p><p>Comando original: <code>{result.receipt.authorization_command_id}</code></p></details>
   {processed&&typeof controller.fiscalProcessedDocument==='function'&&<FiscalProcessedDocument controller={controller} source={processed} blocked={locked}/>}</section>}
  {queryReference&&typeof controller.fiscalReceiptQuery==='function'&&<button type="button" className="secondary-button" disabled={locked} onClick={openReceiptQuery}>Ver processamento da resposta conferida</button>}
  {receiptQueryTarget&&typeof controller.fiscalReceiptQuery==='function'&&<FiscalReceiptQueries controller={controller as Controller&Pick<AccessController,'fiscalReceiptQuery'>} reference={receiptQueryTarget} blocked={blocked||busy||pending}
   onBusy={value=>{if(querying.current===receiptQueryTarget){receiptQueryGuard.current=value;notify();}}}
   onDismiss={()=>{if(!alive.current||retired.current||!same()||!authorized()||request.current||attempt.current||querying.current!==receiptQueryTarget)return false;querying.current=null;receiptQueryGuard.current=false;setReceiptQueryTarget(null);notify();return true;}}/>}
  {!pending&&<button type="button" className="secondary-button" disabled={!canDismiss()} onClick={dismiss}>Fechar conferência da resposta</button>}
 </section>;
}
