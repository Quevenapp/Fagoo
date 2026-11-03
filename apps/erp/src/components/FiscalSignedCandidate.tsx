import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {a1Metadata,type A1Current} from '../lib/a1-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import type {UnsignedJob} from '../lib/fiscal-unsigned-model';
import {SIGNED_BASE,signedCandidate,signedOutcome,signedHistory,signedRun,sameSignedCandidate,signedMessage,
 type SignedRun,type SignedCandidate,type SignedHistory} from '../lib/fiscal-signed-model';
import './fiscal-signed-candidate.css';
import FiscalDanfePreview from './FiscalDanfePreview';
import FiscalReconciliation from './FiscalReconciliation';
import FiscalAuthorization from './FiscalAuthorization';
import FiscalReviewedAuthorization from './FiscalReviewedAuthorization';
import FiscalSubsetReview from './FiscalSubsetReview';

type Controller=Pick<AccessController,'getSnapshot'|'a1'|'fiscalSigned'>&Partial<Pick<AccessController,'subscribe'|'fiscalDanfe'|'company'|'fiscalReconciliation'|'fiscalAuthorization'|'fiscalSubsetReview'|'fiscalReviewedAuthorization'|'fiscalProcessedDocument'>>;
type Props={controller:Controller;job:UnsignedJob;model:'55'|'65';blocked?:boolean;onBusy?:(busy:boolean)=>void;onDraft?:(dirty:boolean)=>void};
type Attempt={body:SignedRun;ack:SignedCandidate|null;uncertain:boolean;resend:boolean};
const cancelled=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const issue=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu acesso a esta etapa precisa ser conferido.':e instanceof AccessError&&e.status===409?'O arquivo ou o certificado mudou. Recarregue e confira antes de uma nova confirmação.':'Não foi possível consultar o resultado da assinatura. Tente consultar novamente.';
const states={pending:'Assinatura pendente',stored:'Arquivo assinado guardado',failed:'Assinatura não concluída'};
const readyJob=(job:UnsignedJob)=>job.status==='stored'&&Boolean(job.artifact)&&job.current.artifact_current&&job.current.is_latest_job&&job.current.series_enabled&&!job.current.basis_changed&&!job.current.draft_archived&&!job.current.source_cancelled;
const readyA1=(a1:A1Current|null)=>a1?.state==='configured_offline'&&a1.time_valid_now&&!a1.company_changed;

/** Mount only reads metadata. Parent must preserve this component while a request or uncertain command exists. */
export default function FiscalSignedCandidate({controller,job,model,blocked=false,onBusy,onDraft}:Props){
 const uid=useId(),[a1,setA1]=useState<A1Current|null>(null),[page,setPage]=useState<SignedHistory|null>(null),[candidate,setCandidate]=useState<SignedCandidate|null>(null),[cursors,setCursors]=useState<(number|null)[]>([null]);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[recovering,setRecovering]=useState(false),[confirmed,setConfirmed]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
 const [dispatchBusy,setDispatchBusy]=useState(false),dispatchState=useRef(false);
 const dispatchCallback=useRef((value:boolean)=>{dispatchState.current=value;setDispatchBusy(value);}).current;
 const [authorizationBusy,setAuthorizationBusy]=useState(false),authorizationState=useRef(false);
 const authorizationCallback=useRef((value:boolean)=>{authorizationState.current=value;setAuthorizationBusy(value);}).current;
 const [protocolBusy,setProtocolBusy]=useState(false),[protocolDirty,setProtocolDirty]=useState(false),protocolState=useRef({busy:false,dirty:false});
 const protocolCallbacks=useRef({busy:(value:boolean)=>{protocolState.current.busy=value;setProtocolBusy(value);},dirty:(value:boolean)=>{protocolState.current.dirty=value;setProtocolDirty(value);}}).current;
 const [reviewBusy,setReviewBusy]=useState(false),[reviewDirty,setReviewDirty]=useState(false),reviewState=useRef({busy:false,dirty:false});
 const [reviewRevision,setReviewRevision]=useState(0),reviewEpoch=useRef(0);
 const reviewChanged=useRef(()=>{reviewEpoch.current++;setReviewRevision(reviewEpoch.current);}).current;
 const getReviewRevision=useRef(()=>reviewEpoch.current).current;
 const reviewCallbacks=useRef({busy:(value:boolean)=>{reviewState.current.busy=value;setReviewBusy(value);},dirty:(value:boolean)=>{reviewState.current.dirty=value;setReviewDirty(value);}}).current;
 const request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),knownRun=useRef<SignedRun|null>(null),alive=useRef(true);
 const snapshot=controller.getSnapshot(),canUse=snapshot.phase==='ready'&&['admin','fiscal'].includes(snapshot.membership?.role??''),ownGuarded=loading||busy||recovering,guarded=ownGuarded||protocolBusy||authorizationBusy||reviewBusy||dispatchBusy;
 const guard=useUnsavedChanges(confirmed||protocolDirty||reviewDirty,guarded),live=useRef({blocked,canUse,confirmed,job,a1,candidate,conflict});live.current={blocked,canUse,confirmed,job,a1,candidate,conflict};
 useLayoutEffect(()=>{onBusy?.(guarded);},[guarded,onBusy]);useLayoutEffect(()=>{onDraft?.(confirmed||protocolDirty||reviewDirty);},[confirmed,protocolDirty,reviewDirty,onDraft]);
 useLayoutEffect(()=>()=>{onBusy?.(false);onDraft?.(false);},[onBusy,onDraft]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
 const valid=(p:AbortController)=>alive.current&&!p.signal.aborted;
 const free=()=>!request.current&&!attempt.current&&!live.current.blocked&&live.current.canUse&&!protocolState.current.busy&&!protocolState.current.dirty&&!authorizationState.current&&!dispatchState.current&&!reviewState.current.busy&&!reviewState.current.dirty;
 const binding=(source=job)=>({unsigned_job_id:source.job_id,unsigned_hash:source.artifact!.sha256,basis_hash:source.basis_hash,completion_version:source.completion_version,completion_hash:source.completion_hash,model});
 const bound=(row:SignedCandidate,source=job)=>{for(const[k,v]of Object.entries(binding(source)))if(row[k as keyof SignedCandidate]!==v)throw new Error('SIGNED_SOURCE_MISMATCH');return row;};
 const readHistory=async(before:number|null,signal:AbortSignal)=>{
  const history=signedHistory(await controller.fiscalSigned(`${SIGNED_BASE}/jobs/${job.job_id}/history`,{method:'POST',body:{limit:25,before},signal}),job.job_id,{limit:25,before});
  history.items.forEach(row=>bound(row));return history;
 };
 const clearConfirmation=()=>{setConfirmed(false);live.current.confirmed=false;};
 useEffect(()=>{
  if(attempt.current||live.current.confirmed||protocolState.current.busy||protocolState.current.dirty||authorizationState.current||dispatchState.current||reviewState.current.busy||reviewState.current.dirty){setConflict(true);setNotice('O arquivo foi atualizado. A confirmação anterior permanece preservada; consulte ou descarte antes de continuar.');return;}
  const p=new AbortController(),readActor=controller.getSnapshot().membership?.user_id;
  const validInitial=()=>valid(p)&&controller.getSnapshot().phase==='ready'&&controller.getSnapshot().membership?.user_id===readActor&&['admin','fiscal'].includes(controller.getSnapshot().membership?.role??'');
  request.current=p;setLoading(true);setA1(null);setPage(null);setCandidate(null);setError('');
  if(!live.current.canUse){request.current=null;setLoading(false);setError('Seu perfil não permite consultar esta etapa.');return()=>p.abort();}
  void Promise.allSettled([
   controller.a1('/v1/a1',{signal:p.signal}).then(a1Metadata).then(certificate=>{if(validInitial())setA1(certificate);}),
   readHistory(null,p.signal).then(history=>{if(validInitial()){setPage(history);setCandidate(history.items[0]??null);setCursors([null]);setConflict(false);knownRun.current=null;}})
  ]).then(results=>{if(validInitial()&&results.some(r=>r.status==='rejected'))setError('Algumas leituras falharam. A assinatura exige certificado atual; os históricos que foram conferidos continuam disponíveis.');}).finally(()=>{if(validInitial()){request.current=null;setLoading(false);}});return()=>p.abort();
 },[controller,job.job_id,job.artifact?.sha256,job.basis_hash,job.completion_hash,model,reload,snapshot.membership?.user_id]);
 const canRunNow=()=>{
  const x=live.current,c=x.candidate;if(!free()||loading||x.conflict||!readyJob(x.job)||!readyA1(x.a1))return false;
  if(!c)return true;
  if(c.status==='pending')return c.current.is_latest_candidate&&!c.current.basis_changed&&!c.current.draft_archived&&!c.current.source_cancelled&&c.current.unsigned_artifact_current&&c.current.series_enabled&&!c.current.a1_changed&&c.current.certificate_time_valid_now&&c.a1_version===x.a1!.version;
  // A new certificate version may create a different candidate; never retry a terminal failure for the same version.
  return c.current.is_latest_candidate&&c.a1_version!==x.a1!.version;
 };
 const readback=async(op:Attempt,p:AbortController)=>{
  const expected={...binding(),a1_version:op.body.expected_a1_version};
  const receipt=signedCandidate(await controller.fiscalSigned(`${SIGNED_BASE}/commands/${op.body.command_id}`,{signal:p.signal}),{...expected,command_id:op.body.command_id,read_only:true});if(!valid(p))return;
  if(op.ack&&!sameSignedCandidate(op.ack,receipt))throw new Error('SIGNED_RECEIPT_MISMATCH');op.ack=receipt;
  const current=signedCandidate(await controller.fiscalSigned(`${SIGNED_BASE}/candidates/${receipt.candidate_id}`,{signal:p.signal}),{...expected,candidate_id:receipt.candidate_id,read_only:true});if(!valid(p))return;
  if(!sameSignedCandidate(receipt,current))throw new Error('SIGNED_CURRENT_MISMATCH');
  setCandidate(current);setPage(null);setCursors([null]);knownRun.current=current.status==='pending'?structuredClone(op.body):null;attempt.current=null;setRecovering(false);clearConfirmation();
  setNotice(current.status==='stored'?'Arquivo assinado guardado e situação atual consultada. A assinatura não é uma autorização fiscal.':current.status==='pending'?'A assinatura permanece pendente. Você pode consultar depois; nenhuma retomada será feita automaticamente.':signedMessage(current.error_code));
 };
 const execute=async(mode:'post'|'read')=>{
  const op=attempt.current;if(!op||request.current||live.current.blocked||!live.current.canUse)return;
  const p=new AbortController(),priorUncertain=op.uncertain;request.current=p;setBusy(true);setError('');
  try{
   if(mode==='post'&&!op.ack){
    op.resend=false;const result=signedOutcome(await controller.fiscalSigned(`${SIGNED_BASE}/run`,{method:'POST',body:op.body,signal:p.signal}),op.body);if(!valid(p))return;
    if(result.status==='blocked'||result.status==='recoverable'){
     if(result.status==='blocked'&&!priorUncertain){attempt.current=null;setRecovering(false);clearConfirmation();setConflict(true);setError(signedMessage(result.code));return;}
     op.uncertain=true;setRecovering(true);setError('O resultado ainda não foi confirmado. Consulte a mesma operação antes de qualquer reenvio.');return;
    }op.ack=bound(result as SignedCandidate);
   }
   if(valid(p))await readback(op,p);
  }catch(e){if(valid(p)&&!cancelled(e)){
   const known=mode==='post'&&!priorUncertain&&!op.ack&&e instanceof AccessError&&[400,403,404,409].includes(e.status);
   if(known){attempt.current=null;setRecovering(false);clearConfirmation();setConflict(true);setError(issue(e));}
   else{op.uncertain=true;op.resend=mode==='read'&&!op.ack&&e instanceof AccessError&&e.status===404;setRecovering(true);setError(op.ack?'A operação foi confirmada, mas a consulta atual falhou. Consulte novamente; a assinatura não será reenviada.':op.resend?'A operação não foi localizada nesta consulta. Você pode consultar novamente ou reenviar explicitamente a mesma confirmação.':'O resultado permanece incerto. A mesma confirmação foi preservada; consulte novamente.');}
  }}finally{if(valid(p)){request.current=null;setBusy(false);}}
 };
 const run=()=>{
  if(!canRunNow()||!live.current.confirmed)return;
  try{const prior=knownRun.current,c=live.current.candidate;const body=c?.status==='pending'&&prior?structuredClone(prior):signedRun(live.current.job,live.current.a1!,true,crypto.randomUUID());
   if(c?.status==='pending'&&(body.expected_a1_version!==c.a1_version||body.unsigned_job_id!==c.unsigned_job_id||body.unsigned_hash!==c.unsigned_hash||body.basis_hash!==c.basis_hash))throw new Error('SIGNED_RESUME_MISMATCH');
   attempt.current={body,ack:null,uncertain:false,resend:false};setPage(null);setCursors([null]);setRecovering(true);void execute('post');
  }catch{setError('Confira o XML atual e o certificado antes de confirmar a assinatura.');}
 };
 const reloadAll=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;clearConfirmation();setNotice('');setReload(n=>n+1);});};
 const discard=()=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;clearConfirmation();setNotice('Confirmação local descartada. Arquivos e tentativas registrados permanecem no histórico.');});};
 const refreshCandidate=async()=>{
  if(!free()||!candidate)return;const p=new AbortController();request.current=p;setBusy(true);setError('');
  try{const current=signedCandidate(await controller.fiscalSigned(`${SIGNED_BASE}/candidates/${candidate.candidate_id}`,{signal:p.signal}),{...binding(),candidate_id:candidate.candidate_id,a1_version:candidate.a1_version,read_only:true});if(!sameSignedCandidate(candidate,current))throw new Error('SIGNED_CURRENT_MISMATCH');if(valid(p)){setCandidate(current);if(current.status!=='pending'){knownRun.current=null;clearConfirmation();}}}
  catch(e){if(valid(p)&&!cancelled(e))setError(issue(e));}finally{if(valid(p)){request.current=null;setBusy(false);}}
 };
 const historyPage=async(before:number|null,previous=false)=>{
  if(!free()||live.current.confirmed)return;const p=new AbortController();request.current=p;setBusy(true);setError('');setPage(null);
  try{const next=await readHistory(before,p.signal);if(valid(p)){setPage(next);setCursors(x=>before===null?[null]:previous?x.slice(0,-1):[...x,before]);}}
  catch(e){if(valid(p)&&!cancelled(e))setError(issue(e));}finally{if(valid(p)){request.current=null;setBusy(false);}}
 };
 const locked=blocked||!canUse||guarded||protocolDirty||reviewDirty,canRun=canRunNow();
 return <section className="fiscal-signed-candidate" aria-labelledby={`${uid}-title`} aria-busy={loading||busy}>
  <header><div><h3 id={`${uid}-title`}>4. Assinar XML de homologação</h3><p>Use o certificado cadastrado para assinar o arquivo já gerado.</p></div><button type="button" className="secondary-button" disabled={locked} onClick={reloadAll}>Atualizar certificado e assinaturas</button></header>
  <p className="real-notice">A assinatura não é autorização fiscal. Esta etapa não envia documentos à SEFAZ, não movimenta estoque ou financeiro e não disponibiliza o XML para download.</p>
  {loading&&<p role="status">Consultando certificado e assinaturas registradas…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status" className="real-success">{notice}</p>}
  {!readyJob(job)&&<p className="real-alert">O XML sem assinatura não corresponde às bases atuais consultadas. Confira a preparação antes de assinar.</p>}
  {a1&&<div className="signed-certificate"><h4>Certificado consultado</h4><p>{a1.state==='unconfigured'?'Nenhum certificado cadastrado.':a1.state==='disabled'?'Certificado desativado.':a1.company_changed?'A identidade da empresa mudou; confira o certificado.':!a1.time_valid_now?'Certificado fora do período de validade.':'Certificado cadastrado para homologação.'}</p>{a1.metadata&&<p>Validade até {fiscalMoment(a1.metadata.not_after)}.</p>}</div>}
  {recovering?<div className="signed-recovery"><p>A confirmação está preservada. Consulte o resultado antes de editar ou iniciar outra assinatura.</p><button type="button" className="primary-button" disabled={busy||blocked||!canUse} onClick={()=>void execute('read')}>Conferir resultado da assinatura</button>{attempt.current?.resend&&!attempt.current.ack&&<button type="button" className="secondary-button" disabled={busy||blocked||!canUse} onClick={()=>{if(attempt.current?.resend&&!attempt.current.ack)void execute('post');}}>Reenviar a mesma assinatura</button>}</div>:<>
   <label className="signed-check"><input type="checkbox" checked={confirmed} disabled={locked||!canRun} onChange={e=>{if(canRunNow()){setConfirmed(e.target.checked);live.current.confirmed=e.target.checked;}}}/>Confirmo a assinatura deste XML de homologação com o certificado consultado, sem envio à SEFAZ.</label>
   <div className="button-group"><button type="button" className="primary-button" disabled={locked||!canRun||!confirmed} onClick={run}>{candidate?.status==='pending'?'Solicitar retomada da assinatura pendente':'Assinar XML de homologação'}</button><button type="button" className="secondary-button" disabled={locked||!confirmed} onClick={discard}>Descartar confirmação de assinatura</button></div>
  </>}
  {candidate&&<section className="signed-result"><h4>{states[candidate.status]}</h4>{candidate.artifact&&<p>Guardado em {fiscalMoment(candidate.artifact.created_at)}. Assinatura e esquema fiscal conferidos localmente.</p>}
   <p>{candidate.current.artifact_current?'O arquivo assinado corresponde ao XML e ao certificado atuais consultados.':candidate.current.a1_changed?'O certificado mudou depois desta tentativa. O resultado anterior permanece no histórico.':candidate.current.basis_changed||!candidate.current.unsigned_artifact_current?'As bases do XML mudaram. O resultado anterior não representa a preparação atual.':candidate.status==='pending'?'Esta tentativa está registrada. Consulte ou retome explicitamente; você pode sair e consultar depois.':candidate.status==='failed'?signedMessage(candidate.error_code):'Este é um resultado histórico; confira a situação atual antes de prosseguir.'}</p>
   <button type="button" className="secondary-button" disabled={locked} onClick={()=>void refreshCandidate()}>Consultar andamento da assinatura</button>
   {candidate.status==='stored'&&candidate.artifact&&controller.fiscalDanfe&&controller.subscribe&&<FiscalDanfePreview key={candidate.candidate_id} controller={controller as Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalDanfe'>} candidate={candidate} blocked={locked||confirmed}/>}
   {candidate.status==='stored'&&candidate.artifact&&controller.fiscalReconciliation&&controller.company&&controller.subscribe&&<FiscalReconciliation key={`protocol:${candidate.candidate_id}`} controller={controller as Pick<AccessController,'getSnapshot'|'subscribe'|'a1'|'company'|'fiscalReconciliation'>} candidate={candidate} enabled={false} blocked={blocked||!canUse||ownGuarded||confirmed||authorizationBusy||dispatchBusy||reviewBusy||reviewDirty} onBusy={protocolCallbacks.busy} onDraft={protocolCallbacks.dirty}/>}
   {candidate.status==='stored'&&candidate.artifact&&controller.fiscalSubsetReview&&controller.subscribe&&<FiscalSubsetReview key={`review:${candidate.candidate_id}`} controller={controller as Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalSubsetReview'>} candidate={candidate} blocked={blocked||!canUse||ownGuarded||confirmed||protocolBusy||protocolDirty||authorizationBusy||dispatchBusy} onBusy={reviewCallbacks.busy} onDraft={reviewCallbacks.dirty} onChanged={reviewChanged}/>}
   {candidate.status==='stored'&&candidate.artifact&&controller.fiscalAuthorization&&controller.subscribe&&<FiscalAuthorization key={`authorization:${candidate.candidate_id}`} controller={controller as Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalAuthorization'>} candidate={candidate} blocked={blocked||!canUse||ownGuarded||confirmed||protocolBusy||protocolDirty||reviewBusy||reviewDirty||dispatchBusy} onBusy={authorizationCallback}/>}
   {candidate.status==='stored'&&candidate.artifact&&controller.fiscalReviewedAuthorization&&controller.subscribe&&<FiscalReviewedAuthorization key={`reviewed-authorization:${candidate.candidate_id}`} controller={controller as Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalReviewedAuthorization'|'fiscalProcessedDocument'>} candidate={candidate} blocked={blocked||!canUse||ownGuarded||confirmed||protocolBusy||protocolDirty||reviewBusy||reviewDirty||authorizationBusy} reviewRevision={reviewRevision} getReviewRevision={getReviewRevision} onBusy={dispatchCallback}/>}
  </section>}
  {!loading&&<section className="signed-history"><h4>Assinaturas deste XML</h4><p>O resultado registrado e sua validade para as bases atuais são informações diferentes.</p>{page?<><div className="table-scroll" role="region" tabIndex={0} aria-label="Histórico de assinaturas de homologação"><table className="data-table"><thead><tr><th>Tentativa</th><th>Resultado registrado</th><th>Situação atual</th><th>Ações</th></tr></thead><tbody>{page.items.map(row=><tr key={row.candidate_id}><th scope="row">{row.candidate_version}</th><td>{states[row.status]}</td><td>{row.current.artifact_current?'Corresponde às bases consultadas':row.current.a1_changed?'Certificado alterado':row.current.basis_changed?'Bases alteradas':row.current.is_latest_candidate?'Última tentativa consultada':'Tentativa anterior'}</td><td><button type="button" className="secondary-button" disabled={locked||confirmed||row.candidate_id===candidate?.candidate_id} onClick={()=>{if(!free()||live.current.confirmed)return;knownRun.current=null;setCandidate(row);live.current.candidate=row;setNotice('Assinatura selecionada para consulta. Nenhuma nova assinatura foi criada.');}}>Abrir assinatura</button></td></tr>)}</tbody></table></div>{!page.items.length&&<p>Nenhuma assinatura registrada para este XML.</p>}</>:<p>Consulte o histórico para atualizar esta lista.</p>}<div className="button-group"><button type="button" className="secondary-button" disabled={locked||confirmed} onClick={()=>void historyPage(null)}>Atualizar histórico de assinaturas</button><button type="button" disabled={locked||confirmed||cursors.length===1} onClick={()=>void historyPage(cursors.at(-2)??null,true)}>Assinaturas mais recentes</button><button type="button" disabled={locked||confirmed||!page?.has_more} onClick={()=>void historyPage(page!.next_cursor)}>Assinaturas mais antigas</button></div></section>}
  <details className="signed-technical"><summary>Versões e conferência técnica</summary><p>XML sem assinatura: geração {job.job_version}, complemento {job.completion_version}. Certificado consultado: versão {a1?.version??'não disponível'}.</p>{candidate&&<p>Tentativa {candidate.candidate_version}: certificado capturado na versão {candidate.a1_version}; versão atual consultada {candidate.current.a1_version}.</p>}{candidate?.artifact&&<p className="signed-hash">Resumo do arquivo assinado: {candidate.artifact.sha256}</p>}<p>Revisão tributária, cadeia ICP-Brasil, revogação e autorização fiscal continuam fora desta conferência local.</p></details>
 </section>;
}
