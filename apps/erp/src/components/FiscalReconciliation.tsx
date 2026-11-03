import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {a1Metadata,a1Company,type A1Current,type A1Company,type A1Controller} from '../lib/a1-model';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {isAppImportFailure,APP_UPDATE_MESSAGE} from '../lib/import-failure';
import {RECONCILIATION_BASE as BASE,RECONCILIATION_LABELS,captureReconciliationRequest,reconciliationResponse,reconciliationReady,reconciliationRun,bindReconciliationResult,type ReconciliationRun,type ReconciliationResult,type ReconciliationHistory} from '../lib/fiscal-reconciliation-model';
import './fiscal-reconciliation.css';

export interface ReconciliationController extends A1Controller {getSnapshot:()=>AccessState;subscribe:(callback:()=>void)=>()=>void;fiscalReconciliation:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;}
type Props={controller:ReconciliationController;candidate:SignedCandidate;enabled?:boolean;blocked?:boolean;onBusy?:(busy:boolean)=>void;onDraft?:(dirty:boolean)=>void;};
type Bases={a1:A1Current;company:A1Company|null};
type Attempt={id:string;body:ReconciliationRun|null;ack:ReconciliationResult|null;unresolved:boolean;};
const ownerOf=(controller:ReconciliationController)=>{const s=controller.getSnapshot();return s.phase==='signed_out'?null:s.membership?.user_id;};
const permitted=(controller:ReconciliationController)=>{const s=controller.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const sourceKey=(c:SignedCandidate)=>[c.status,c.candidate_id,c.candidate_version,c.model,c.artifact?.sha256,c.artifact?.size_bytes,c.unsigned_job_id,c.basis_hash,c.completion_version,c.completion_hash,c.a1_version].join(':');
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const issue=(e:unknown)=>e instanceof AccessError&&[401,403].includes(e.status)?'Seu acesso precisa ser conferido. A tentativa permanece preservada para consulta.':e instanceof AccessError&&e.status===404?'A tentativa não foi localizada. Consulte o mesmo comando novamente; nenhum envio será repetido.':'Não foi possível conferir o resultado. Consulte a mesma tentativa novamente.';

/** Explicit homologation query. History and journal recovery never invoke a new external query. */
export default function FiscalReconciliation({controller,candidate,enabled=false,blocked=false,onBusy,onDraft}:Props){
 const uid=useId(),[bases,setBases]=useState<Bases|null>(null),[history,setHistory]=useState<ReconciliationHistory|null>(null),[result,setResult]=useState<ReconciliationResult|null>(null);
 const [confirmed,setConfirmed]=useState(false),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[disabled,setDisabled]=useState(false),[updateRequired,setUpdateRequired]=useState(false),[reload,setReload]=useState(0),[,changed]=useState(0);
 const alive=useRef(true),request=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),owner=useRef(ownerOf(controller)),scope=useRef(sourceKey(candidate)),generation=useRef(0),updateBlocked=useRef(false),disabledRef=useRef(false);
 const live=useRef({candidate,enabled,blocked,bases,result,confirmed,history});live.current={candidate,enabled,blocked,bases,result,confirmed,history};
 const renderOwner=ownerOf(controller),renderSource=sourceKey(candidate);
 const sameView=()=>renderOwner===owner.current&&renderSource===scope.current;
 const authorized=()=>permitted(controller)&&ownerOf(controller)===owner.current;
 const resetConfirmation=()=>{live.current.confirmed=false;setConfirmed(false);};
 const clear=()=>{generation.current++;request.current?.abort();request.current=null;attempt.current=null;live.current.result=null;live.current.bases=null;live.current.history=null;resetConfirmation();setResult(null);setBases(null);setHistory(null);setBusy(false);setUnresolved(false);setError('');setNotice('');setLoading(false);};
 const free=()=>alive.current&&sameView()&&authorized()&&!request.current&&!attempt.current?.unresolved&&!live.current.blocked;
 const valid=(p:AbortController,epoch:number)=>alive.current&&request.current===p&&!p.signal.aborted&&epoch===generation.current&&authorized()&&scope.current===sourceKey(live.current.candidate);
 const guard=useUnsavedChanges(confirmed,loading||busy||unresolved);
 useLayoutEffect(()=>{onBusy?.(loading||busy||unresolved);return()=>onBusy?.(false);},[loading,busy,unresolved,onBusy]);
 useLayoutEffect(()=>{onDraft?.(confirmed);return()=>onDraft?.(false);},[confirmed,onDraft]);
 useEffect(()=>{
  alive.current=true;const stop=controller.subscribe(()=>{
   const next=ownerOf(controller);
   if(next!==undefined&&next!==owner.current){clear();owner.current=next;setReload(n=>n+1);}
   else if(!permitted(controller)){generation.current++;request.current?.abort();request.current=null;setBusy(false);setLoading(false);}
   changed(n=>n+1);
  });return()=>{alive.current=false;generation.current++;request.current?.abort();request.current=null;attempt.current=null;stop();};
 },[controller]);
 useEffect(()=>{const next=sourceKey(candidate);if(scope.current!==next){clear();scope.current=next;setReload(n=>n+1);}},[candidate.status,candidate.candidate_id,candidate.candidate_version,candidate.model,candidate.artifact?.sha256,candidate.artifact?.size_bytes,candidate.unsigned_job_id,candidate.basis_hash,candidate.completion_version,candidate.completion_hash,candidate.a1_version]);
 const query=async(path:string,options:NativeRequestOptions={})=>{const selected=captureReconciliationRequest(path,options);return reconciliationResponse(await controller.fiscalReconciliation(path,options),selected);};
 const readHistory=async(p:AbortController,epoch:number,before:string|null=null)=>{
  const c=live.current.candidate,raw=await query(`${BASE}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before},signal:p.signal}) as ReconciliationHistory;
  raw.items.forEach(r=>bindReconciliationResult(r,c));
  if(valid(p,epoch)){live.current.history=raw;setHistory(raw);}
 };
 useEffect(()=>{
  if(attempt.current?.unresolved||request.current)return;
  if(!authorized()||candidate.status!=='stored'||!candidate.artifact){setLoading(false);return;}
  const p=new AbortController(),epoch=generation.current;request.current=p;setLoading(true);setError('');
  // History remains useful even when certificate/identity metadata cannot be read.
  void Promise.allSettled([readHistory(p,epoch),Promise.all([controller.a1('/v1/a1',{signal:p.signal}).then(a1Metadata),controller.company('/v1/empresa/identidade',{signal:p.signal}).then(a1Company)]).then(([a1,company])=>{if(valid(p,epoch)){const b={a1,company};live.current.bases=b;setBases(b);}})]).then(results=>{if(valid(p,epoch)&&results.some(v=>v.status==='rejected'))setError('Alguns dados não puderam ser consultados. Atualize as leituras antes de confirmar uma nova consulta.');}).finally(()=>{if(valid(p,epoch)){request.current=null;setLoading(false);}});
  return()=>p.abort();
 },[controller,reload]);
 const remember=(r:ReconciliationResult,op:Attempt)=>{op.ack=r;live.current.result=r;setResult(r);};
 const lookup=async(op:Attempt,p:AbortController,epoch:number)=>{
  const raw=await query(`${BASE}/commands/${op.id}`,{signal:p.signal}) as ReconciliationResult;
  const current=bindReconciliationResult(raw,live.current.candidate,op.body,op.ack);
  if(!valid(p,epoch))return;
  remember(current,op);op.unresolved=false;setUnresolved(false);resetConfirmation();
  setNotice('Tentativa consultada. A leitura não repete a consulta à SEFAZ.');
 };
 const execute=async(mode:'run'|'read'|'recover')=>{
  const op=attempt.current;if(!op||!alive.current||!sameView()||!authorized()||request.current||live.current.blocked)return;
  if(mode==='run'&&(!op.body||!live.current.enabled||disabledRef.current||updateBlocked.current||!live.current.confirmed))return;
  if(mode==='recover'&&(!op.ack?.recoverable_by_actor||!op.ack.current?.grant_consumed||!op.ack.current.recovery_required||op.unresolved))return;
  const p=new AbortController(),epoch=generation.current,priorUnresolved=op.unresolved,priorAck=op.ack;let mutationReturned=false;request.current=p;setBusy(true);setError('');
  if(mode!=='read'){op.unresolved=true;setUnresolved(true);}
  try{
   if(mode!=='read'){
    const body=mode==='run'?op.body!:{command_id:op.id};
    const raw=await query(`${BASE}/${mode}`,{method:'POST',body,signal:p.signal}) as ReconciliationResult;
    mutationReturned=true;const r=bindReconciliationResult(raw,live.current.candidate,op.body,priorAck);
    if(!valid(p,epoch))return;
    // Keep a known receipt even when this reply is uncertain; never replace a prior ACK by absence.
    if(r.receipt)remember(r,op);else{live.current.result=r;setResult(r);}
    resetConfirmation();
   }
   if(valid(p,epoch))await lookup(op,p,epoch);
  }catch(e){if(valid(p,epoch)&&!aborted(e)){
   if(isAppImportFailure(e)){updateBlocked.current=true;setUpdateRequired(true);}
   const recovery=Boolean(e&&typeof e==='object'&&'recovery_required'in e&&e.recovery_required===true);
   const unsent=isAppImportFailure(e)&&mode==='run'&&!mutationReturned&&!op.ack&&!priorAck&&!priorUnresolved;
   const definitive=mode==='run'&&!mutationReturned&&!op.ack&&!priorAck&&!priorUnresolved&&!recovery&&e instanceof AccessError&&[400,401,403,404,409,413,415,422].includes(e.status);
   if(mode==='read'&&!priorUnresolved&&op.body===null){op.unresolved=false;setUnresolved(false);setError('Não foi possível consultar este comando diretamente. A captura histórica permanece disponível; atualize o histórico para conferir seu estado.');}
   else if(unsent||definitive){attempt.current=null;setUnresolved(false);resetConfirmation();setBases(null);live.current.bases=null;if(e instanceof AccessError&&e.code==='RECONCILIATION_DISABLED'){disabledRef.current=true;setDisabled(true);}setError(unsent?`${APP_UPDATE_MESSAGE} Nenhuma consulta foi enviada nesta tentativa.`:'A consulta não foi iniciada. Confira o acesso, a empresa e o certificado antes de confirmar novamente.');}
   else{op.unresolved=true;setUnresolved(true);setError(op.ack?'Há um recibo conhecido, mas a leitura final não foi confirmada. Consulte o mesmo comando; nenhum envio será repetido.':issue(e));}
  }}finally{if(valid(p,epoch)){request.current=null;setBusy(false);}}
 };
 const run=()=>{
  const x=live.current;if(!free()||!x.enabled||disabledRef.current||updateBlocked.current||!x.confirmed||!reconciliationReady(x.candidate,x.bases?.a1??null,x.bases?.company??null))return;
  const prior=attempt.current;
  if(prior){if(!prior.body||prior.ack?.status!=='prepared'||prior.ack.current?.lease_expired||prior.ack.current?.grant_consumed)return;}
  else{if(x.result)return;try{const body=reconciliationRun(x.candidate,x.bases!.a1,x.bases!.company,true,crypto.randomUUID());attempt.current={id:body.command_id,body,ack:null,unresolved:false};}catch{setError('Confira a empresa, o certificado e o candidato antes de confirmar.');return;}}
  setNotice('');void execute('run');
 };
 const selectResult=(r:ReconciliationResult)=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;resetConfirmation();attempt.current={id:r.command_id,body:null,ack:r,unresolved:false};live.current.result=r;setResult(r);setError('');setNotice('');void execute('read');});};
 const refresh=(before:string|null=null)=>{if(!free())return;guard.confirmLeave(()=>{if(!free())return;resetConfirmation();if(before===null){setReload(n=>n+1);return;}const p=new AbortController(),epoch=generation.current;request.current=p;setBusy(true);setError('');void readHistory(p,epoch,before).catch(e=>{if(valid(p,epoch))setError(issue(e));}).finally(()=>{if(valid(p,epoch)){request.current=null;setBusy(false);}});});};
 const newAllowed=()=>{const r=live.current.result;return Boolean(r&&(r.status==='stored'||r.status==='failed_before_dispatch'||r.status==='uncertain'||r.current?.lease_expired));};
 const prepareNew=()=>{if(!free()||!newAllowed())return;guard.confirmLeave(()=>{if(!free()||!newAllowed())return;attempt.current=null;live.current.result=null;live.current.bases=null;setResult(null);setBases(null);resetConfirmation();setNotice('Uma nova consulta exige dados atuais e uma nova confirmação.');setReload(n=>n+1);});};
 const canUse=authorized(),locked=!canUse||blocked||busy||loading||unresolved,ready=reconciliationReady(candidate,bases?.a1??null,bases?.company??null),resume=result?.status==='prepared'&&attempt.current?.body&&!result.current?.lease_expired&&!result.current?.grant_consumed;
 const canConfirm=!locked&&enabled&&!disabled&&!updateRequired&&ready&&(!result||Boolean(resume));
 if(!canUse)return <section className="fiscal-reconciliation"><h4>Consulta de protocolo</h4><p role="alert">Seu perfil não permite acessar esta etapa.</p></section>;
 return <section className="fiscal-reconciliation" aria-labelledby={`${uid}-title`} aria-busy={loading||busy}>
  <header><div><span className="fiscal-reconciliation-environment">Homologação · São Paulo</span><h4 id={`${uid}-title`}>Consulta de protocolo</h4></div><button type="button" className="secondary-button" disabled={locked} onClick={()=>refresh()}>Atualizar leituras</button></header>
  <p>Consulta a situação da chave deste candidato {candidate.model==='55'?'NF-e':'NFC-e'}. Usa o certificado atual para uma consulta; não envia o XML como nota e não emite, cancela ou movimenta estoque e financeiro.</p>
  {(!enabled||disabled)&&<p role="status" className="real-notice">Novas consultas estão indisponíveis. O histórico e a recuperação de respostas já guardadas continuam disponíveis.</p>}
  {loading&&<p role="status">Consultando histórico, empresa e certificado…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {bases&&<p>Certificado: {ready?'cadastrado e válido na leitura atual':'confira a validade e a identidade da empresa'}. Versão {bases.a1.version}. Empresa: versão {bases.company?.version??'não cadastrada'}.</p>}
  <label className="fiscal-reconciliation-confirm"><input type="checkbox" checked={confirmed} disabled={!canConfirm} onChange={e=>{if(free()&&live.current.enabled&&!disabledRef.current&&!updateBlocked.current&&reconciliationReady(live.current.candidate,live.current.bases?.a1??null,live.current.bases?.company??null)&&(!live.current.result||attempt.current?.body&&live.current.result.status==='prepared'&&!live.current.result.current?.lease_expired)){live.current.confirmed=e.target.checked;setConfirmed(e.target.checked);}}}/>Confirmo o uso do certificado atual para consultar somente esta chave em homologação. Esta ação não emite a nota.</label>
  <div className="button-group"><button type="button" className="primary-button" disabled={!canConfirm||!confirmed} onClick={run}>{resume?'Confirmar envio da consulta preparada':'Consultar situação desta chave em homologação'}</button><button type="button" className="secondary-button" disabled={locked||!confirmed} onClick={()=>{if(free())guard.confirmLeave(()=>{if(free())resetConfirmation();});}}>Descartar confirmação</button></div>
  {unresolved&&<div className="fiscal-reconciliation-recovery"><p>A tentativa e o comando estão preservados. A próxima ação apenas consulta o resultado; não repete o envio.</p><button type="button" className="primary-button" disabled={busy||blocked||!canUse} onClick={()=>void execute('read')}>Conferir mesma tentativa</button></div>}
  {result&&<section className="fiscal-reconciliation-result" aria-live="polite"><h5>{RECONCILIATION_LABELS[result.status]}</h5>
   {result.receipt&&<p>Tentativa {result.receipt.ordinal}, confirmada em {fiscalMoment(result.receipt.created_at)}. Certificado usado: versão {result.receipt.a1_version}; assinatura do candidato: versão {result.receipt.signing_a1_version}.</p>}
   {result.artifact?<><p>{result.artifact.outcome==='validated'?`Resposta conferida. Código de situação observado: ${result.artifact.cstat}.`:'Resposta preservada, mas não aprovada pela validação local.'}</p>{result.artifact.event_reconciliation_required&&<p>Há eventos que precisam de reconciliação específica.</p>}<p>Uma resposta guardada não conclui a homologação nem marca a nota como autorizada para emissão neste sistema.</p></>:<p>Não há resposta final conferida nesta leitura. Isso não prova que a consulta deixou de acontecer.</p>}
   {result.current&&(result.current.a1_changed||result.current.company_changed)&&<p>A empresa ou o certificado mudou após a intenção registrada. O histórico permanece separado do estado atual.</p>}
   {!unresolved&&<div className="button-group"><button type="button" className="secondary-button" disabled={locked} onClick={()=>void execute('read')}>Consultar esta tentativa</button>{result.recoverable_by_actor&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void execute('recover')}>Recuperar resposta já guardada</button>}{newAllowed()&&<button type="button" className="secondary-button" disabled={locked||!enabled||disabled||updateRequired} onClick={prepareNew}>Preparar nova consulta</button>}</div>}
  </section>}
  <section className="fiscal-reconciliation-history"><h5>Histórico desta chave</h5><p>Consultar uma tentativa ou recuperar seu diário não envia uma nova consulta à SEFAZ.</p>{history?.items.length===0&&<p>Nenhuma tentativa registrada nesta página.</p>}
   {history?.items.map(row=><article key={row.command_id}><div><strong>Tentativa {row.receipt!.ordinal} · {RECONCILIATION_LABELS[row.status]}</strong><p>{fiscalMoment(row.receipt!.created_at)}{row.recoverable_by_actor?' · Recuperação disponível para seu usuário.':row.current?.recovery_required?' · Recuperação vinculada ao usuário que confirmou.':''}</p></div><button type="button" className="secondary-button" disabled={locked} onClick={()=>selectResult(row)}>Consultar tentativa {row.receipt!.ordinal}</button></article>)}
   {history?.has_more&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>refresh(history.next_cursor)}>Tentativas anteriores</button>}
  </section>
 </section>;
}
