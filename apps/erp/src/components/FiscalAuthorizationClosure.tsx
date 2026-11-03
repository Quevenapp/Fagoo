import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController,type NativeRequestOptions} from '../lib/real-access';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {REVIEWED_AUTHORIZATION_BASE as BASE,captureReviewedAuthorizationRequest,reviewedAuthorizationResponse,type DispatchResult} from '../lib/fiscal-reviewed-authorization-model';
import {expiredClosureEligible,closureIntent,bindClosureResult,closureCommandPath,type ClosureInput,type ClosureResult} from '../lib/fiscal-authorization-closure-model';
type Controller=Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalReviewedAuthorization'>;
type Props={controller:Controller;candidate:SignedCandidate;original:DispatchResult;blocked?:boolean;onBusy?:(value:boolean)=>void;onClosed?:(value:ClosureResult)=>void;onDismiss:()=>void};
type Attempt={body:ClosureInput;ack:ClosureResult|null};
const actor=(c:Controller)=>c.getSnapshot().membership?.user_id??null;
const permitted=(c:Controller)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const source=(c:SignedCandidate,r:DispatchResult)=>[c.candidate_id,c.candidate_version,c.artifact?.sha256,r.command_id,r.receipt?.attempt_id].join(':');
/** A separate command closes only an expired unused preparation. After POST: GET only. */
export default function FiscalAuthorizationClosure({controller,candidate,original,blocked=false,onBusy,onClosed,onDismiss}:Props){
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[closed,setClosed]=useState<ClosureResult|null>(null),[refused,setRefused]=useState(false),[error,setError]=useState(''),[,render]=useState(0);
 const alive=useRef(true),owner=useRef(actor(controller)),scope=useRef(source(candidate,original)),epoch=useRef(0),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),completed=useRef<ClosureResult|null>(null),rejected=useRef(false),retired=useRef(false);
 const live=useRef({candidate,original,blocked,onBusy,onClosed,onDismiss});live.current={candidate,original,blocked,onBusy,onClosed,onDismiss};
 const renderedActor=actor(controller),renderedScope=source(candidate,original);
 const notify=()=>{setBusy(Boolean(request.current));setPending(Boolean(attempt.current));live.current.onBusy?.(Boolean(request.current||attempt.current));};
 const stop=()=>{epoch.current++;request.current?.abort();request.current=null;notify();};
 const clear=()=>{attempt.current=null;completed.current=null;rejected.current=false;stop();setClosed(null);setRefused(false);setError('');};
 const authorized=()=>permitted(controller)&&actor(controller)===owner.current;
 const same=()=>renderedActor===owner.current&&renderedScope===scope.current;
 const available=()=>alive.current&&!retired.current&&same()&&authorized()&&!request.current&&!live.current.blocked;
 const valid=(p:AbortController,generation:number)=>alive.current&&request.current===p&&!p.signal.aborted&&epoch.current===generation&&authorized()&&scope.current===source(live.current.candidate,live.current.original);
 useLayoutEffect(()=>()=>live.current.onBusy?.(false),[]);
 useEffect(()=>{alive.current=true;const unsubscribe=controller.subscribe(()=>{const next=actor(controller);if(next!==owner.current||controller.getSnapshot().phase==='signed_out'){clear();owner.current=next;}else if(!permitted(controller))stop();render(n=>n+1);});return()=>{alive.current=false;epoch.current++;request.current?.abort();request.current=null;unsubscribe();};},[controller]);
 useEffect(()=>{const next=source(candidate,original);if(scope.current!==next){clear();scope.current=next;}},[candidate.candidate_id,candidate.candidate_version,candidate.artifact?.sha256,original.command_id,original.receipt?.attempt_id]);
 const query=async(path:string,options:NativeRequestOptions)=>{const captured=captureReviewedAuthorizationRequest(path,options);return reviewedAuthorizationResponse(await controller.fiscalReviewedAuthorization(path,options),captured) as ClosureResult;};
 const execute=async(post:boolean)=>{
  const op=attempt.current;if(!op||!available())return;
  const p=new AbortController(),generation=epoch.current;request.current=p;notify();setError('');
  try{
   if(post){const value=bindClosureResult(await query(BASE+'/close-expired',{method:'POST',body:op.body,signal:p.signal}),op.body,live.current.candidate,null,live.current.original);if(!valid(p,generation))return;op.ack=value;}
   const value=bindClosureResult(await query(closureCommandPath(op.body),{signal:p.signal}),op.body,live.current.candidate,op.ack,live.current.original);
   if(valid(p,generation)){attempt.current=null;completed.current=value;setClosed(value);live.current.onClosed?.(value);}
  }catch(e){if(valid(p,generation)&&!(e instanceof DOMException&&e.name==='AbortError')){
   const definite=post&&!op.ack&&e instanceof AccessError&&[400,401,403,404,409,413,415,422,503].includes(e.status)&&(e as AccessError&{recovery_required?:boolean}).recovery_required===false;
   if(definite){attempt.current=null;rejected.current=true;setRefused(true);setError('O encerramento não foi registrado. Feche esta conferência e consulte novamente a situação da tentativa.');}
   else setError(e instanceof AccessError&&[401,403].includes(e.status)?'Seu acesso precisa ser reconfirmado. Depois consulte o mesmo comando de encerramento.':e instanceof AccessError&&e.status===404?'O comando de encerramento não foi localizado nesta consulta. O resultado permanece pendente; não repita a operação.':'O encerramento ainda não foi confirmado. Consulte o mesmo comando para verificar o resultado.');
  }}finally{if(valid(p,generation)){request.current=null;notify();}}
 };
 const confirm=()=>{if(!available()||attempt.current||completed.current||rejected.current||!expiredClosureEligible(live.current.original))return;try{attempt.current={body:closureIntent(live.current.original,live.current.candidate,crypto.randomUUID(),true),ack:null};notify();void execute(true);}catch{setError('Consulte novamente a situação da tentativa antes de encerrar.');rejected.current=true;setRefused(true);}};
 const dismiss=()=>{if(available()&&!attempt.current){retired.current=true;live.current.onDismiss();}};
 const canUse=authorized()&&same(),locked=!canUse||blocked||busy||pending;
 return <section className="reviewed-authorization-closure" hidden={!canUse} inert={!canUse} aria-hidden={!canUse||undefined} aria-busy={busy} aria-label="Encerramento da preparação expirada">
  <h5>{closed?'Encerramento confirmado':'Encerrar preparação expirada'}</h5>
  {!closed&&<><p>A consulta indica que esta preparação expirou antes do envio. O sistema verificará essa condição novamente ao confirmar.</p><p>Tentativa {original.receipt?.ordinal} · expirada em {fiscalMoment(original.current?.expires_at??'')}.</p></>}
  {!pending&&!closed&&!refused&&<div className="button-group"><button type="button" className="primary-button" disabled={locked} onClick={confirm}>Confirmar encerramento sem envio</button><button type="button" className="secondary-button" disabled={locked} onClick={dismiss}>Cancelar encerramento</button></div>}
  {busy&&<p role="status">Consultando encerramento…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {pending&&<><p>O resultado permanece protegido nesta aba. Consulte o mesmo comando; não haverá reenvio. A tentativa em memória não sobrevive ao recarregamento da página.</p><p>Comando de encerramento: <code>{attempt.current?.body.command_id}</code></p><button type="button" className="primary-button" disabled={!canUse||blocked||busy} onClick={()=>void execute(false)}>Consultar resultado do encerramento</button></>}
  {closed&&<div aria-live="polite"><p>A preparação foi encerrada antes do envio em {fiscalMoment(closed.receipt.closed_at)}. A preparação e a revisão originais foram preservadas.</p>{closed.current.successor_exists&&<p>Há uma tentativa posterior para esta nota. Consulte seu histórico para verificar a situação atual.</p>}<p>O encerramento não autoriza novo envio. Qualquer nova tentativa exige outra conferência e confirmação.</p><details><summary>Recibo do encerramento</summary><p>Comando: <code>{closed.command_id}</code></p><p>Tentativa original: <code>{closed.receipt.authorization_command_id}</code></p></details></div>}
  {(closed||refused)&&<button type="button" className="secondary-button" disabled={locked} onClick={dismiss}>Fechar conferência do encerramento</button>}
 </section>;
}
