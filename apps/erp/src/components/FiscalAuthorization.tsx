import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {fiscalMoment} from '../lib/fiscal-drafts-model';
import {isAppImportFailure,APP_UPDATE_MESSAGE} from '../lib/import-failure';
import {AUTHORIZATION_BASE as BASE,AUTHORIZATION_LABELS,AUTHORIZATION_BLOCKERS,captureAuthorizationRequest,authorizationResponse,bindAuthorizationResult,type AuthorizationPreview,type AuthorizationResult,type AuthorizationHistory} from '../lib/fiscal-authorization-model';
import type {NativeRequestOptions} from '../lib/real-access';
import './fiscal-authorization.css';
type Controller=Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalAuthorization'>;
type Props={controller:Controller;candidate:SignedCandidate;blocked?:boolean;onBusy?:(busy:boolean)=>void};
const sourceKey=(c:SignedCandidate)=>[c.candidate_id,c.candidate_version,c.model,c.artifact?.sha256,c.artifact?.size_bytes,c.unsigned_job_id,c.basis_hash,c.completion_version,c.completion_hash,c.a1_version].join(':');
const permitted=(c:Controller)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'');};
const actor=(c:Controller)=>c.getSnapshot().membership?.user_id??null;
const issue=(e:unknown)=>isAppImportFailure(e)?APP_UPDATE_MESSAGE:e instanceof AccessError&&[401,403].includes(e.status)?'Seu acesso precisa ser conferido antes de uma nova consulta.':e instanceof AccessError&&e.status===404?'O comando não foi localizado nesta consulta. Isso não prova que um envio deixou de acontecer.':'Não foi possível concluir a leitura. Você pode consultar novamente; nenhum envio será repetido.';
/** Read-only authorization preparation. Never invokes A1, run, recover or a SEFAZ transport. */
export default function FiscalAuthorization({controller,candidate,blocked=false,onBusy}:Props){
 const uid=useId(),[preview,setPreview]=useState<AuthorizationPreview|null>(null),[history,setHistory]=useState<AuthorizationHistory|null>(null),[selected,setSelected]=useState<AuthorizationResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[,render]=useState(0);
 const alive=useRef(true),request=useRef<AbortController|null>(null),generation=useRef(0),owner=useRef(actor(controller)),scope=useRef(sourceKey(candidate)),callbacks=useRef({onBusy});callbacks.current={onBusy};
 const live=useRef({candidate,blocked,history,selected});live.current={candidate,blocked,history,selected};
 const renderActor=actor(controller),renderScope=sourceKey(candidate);
 const notify=(value:boolean)=>{setBusy(value);callbacks.current.onBusy?.(value);};
 const clear=()=>{generation.current++;request.current?.abort();request.current=null;live.current.history=null;live.current.selected=null;setPreview(null);setHistory(null);setSelected(null);setError('');setNotice('');notify(false);};
 const authorized=()=>permitted(controller)&&actor(controller)===owner.current;
 const sameView=()=>renderActor===owner.current&&renderScope===scope.current;
 const free=()=>alive.current&&sameView()&&authorized()&&!request.current&&!live.current.blocked&&live.current.candidate.status==='stored'&&Boolean(live.current.candidate.artifact);
 const valid=(p:AbortController,epoch:number)=>alive.current&&request.current===p&&!p.signal.aborted&&epoch===generation.current&&authorized()&&scope.current===sourceKey(live.current.candidate);
 useLayoutEffect(()=>()=>callbacks.current.onBusy?.(false),[]);
 useEffect(()=>{
  alive.current=true;const stop=controller.subscribe(()=>{const next=actor(controller);if(next!==owner.current||!permitted(controller)){clear();owner.current=next;}render(n=>n+1);});
  return()=>{alive.current=false;generation.current++;request.current?.abort();request.current=null;stop();};
 },[controller]);
 useEffect(()=>{const key=sourceKey(candidate);if(scope.current!==key){clear();scope.current=key;}},[candidate.candidate_id,candidate.candidate_version,candidate.model,candidate.artifact?.sha256,candidate.artifact?.size_bytes,candidate.unsigned_job_id,candidate.basis_hash,candidate.completion_version,candidate.completion_hash,candidate.a1_version]);
 const query=async(path:string,options:NativeRequestOptions)=>{const captured=captureAuthorizationRequest(path,options);return authorizationResponse(await controller.fiscalAuthorization(path,options),captured);};
 const read=async(kind:'preview'|'history'|'command',before:string|null=null,row:AuthorizationResult|null=null)=>{
  if(!free())return;
  // The server also enforces command ownership. This flag only exposes an action when ownership is known.
  if(kind==='command'&&(!row?.recoverable_by_actor||!row.receipt||!live.current.history?.items.some(r=>r.command_id===row.command_id&&r.recoverable_by_actor)))return;
  const p=new AbortController(),epoch=generation.current,c=live.current.candidate;request.current=p;notify(true);setError('');setNotice('');
  try{
   if(kind==='preview'){
    const value=await query(BASE+'/preview',{method:'POST',body:{candidate_id:c.candidate_id,signed_hash:c.artifact!.sha256},signal:p.signal}) as AuthorizationPreview;
    if(value.model!==c.model)throw Error('AUTHORIZATION_BINDING_MISMATCH');if(valid(p,epoch)){setPreview(value);setNotice('Conferência local concluída. Nenhum pedido de autorização foi enviado.');}
   }else if(kind==='history'){
    const value=await query(`${BASE}/candidates/${c.candidate_id}/history`,{method:'POST',body:{limit:25,before},signal:p.signal}) as AuthorizationHistory;
    value.items.forEach(r=>bindAuthorizationResult(r,c));if(valid(p,epoch)){live.current.history=value;setHistory(value);live.current.selected=null;setSelected(null);}
   }else{
    const value=bindAuthorizationResult(await query(`${BASE}/commands/${row!.command_id}`,{signal:p.signal}) as AuthorizationResult,c,row);
    if(valid(p,epoch)){live.current.selected=value;setSelected(value);setNotice('Comando consultado. Esta leitura não repete nem recupera um envio.');}
   }
  }catch(e){if(valid(p,epoch)&&!(e instanceof DOMException&&e.name==='AbortError'))setError(issue(e));}
  finally{if(valid(p,epoch)){request.current=null;notify(false);}}
 };
 const canUse=authorized()&&sameView(),locked=!canUse||blocked||busy;
 const details=(row:AuthorizationResult)=>{const r=row.receipt!,a=row.artifact,c=row.current!;return <div className="authorization-details">
  <p>Intenção registrada em {fiscalMoment(r.created_at)}. {r.origin==='synthetic'?'Origem sintética de teste; não comprova autorização real.':'Origem operacional registrada; consulte a evidência e a situação observada.'}</p>
  <p>{a?`Situação na resposta guardada: ${a.protocol_cstat??a.cstat??'resposta não aprovada'}.`:'Não há resposta final guardada nesta leitura. Isso não prova ausência de envio.'}</p>
  {a?.outcome==='receipt_pending'&&<p>O recibo ainda requer consulta posterior. Esta tela não consulta a SEFAZ.</p>}
  {c.recovery_required&&<p>O resultado permanece pendente. A recuperação está indisponível nesta etapa; não repita o envio.</p>}
  <p>Estado atual consultado: {c.a1_changed||c.identity_changed||c.policy_changed||c.candidate.basis_changed||!c.candidate.artifact_current?'há diferenças na empresa, no certificado, no perfil ou nas bases. O recibo histórico permanece preservado.':'sem diferenças sinalizadas nesta leitura. Isso não habilita emissão.'}</p>
  <details><summary>Identificação da tentativa</summary><p>Comando: <code>{row.command_id}</code></p><p>Certificado usado: versão {r.a1_version}. Assinatura: versão {r.signing_a1_version}.</p></details>
 </div>;};
 if(!canUse)return <section className="fiscal-authorization"><h4>Autorização de homologação</h4><p role="alert">Seu perfil não permite consultar esta etapa.</p></section>;
 return <section className="fiscal-authorization" aria-labelledby={`${uid}-title`} aria-busy={busy}>
  <header><span>Homologação · São Paulo</span><h4 id={`${uid}-title`}>Autorização de homologação</h4></header>
  <p className="real-notice">O envio para autorização ainda está indisponível. Você pode conferir a preparação local e consultar o histórico, sem usar o certificado ou enviar a nota à SEFAZ.</p>
  <div className="button-group"><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('preview')}>Conferir preparação para autorização</button><button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('history')}>Consultar histórico de autorização</button></div>
  {busy&&<p role="status">Consultando dados da autorização…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {preview&&<section><h5>Resultado da conferência local</h5><p>Assinatura e certificado público do arquivo conferidos. Isso não valida toda a tributação nem autoriza a nota.</p><p>A comunicação operacional de autorização está indisponível; nenhuma intenção pode ser preparada por esta tela.</p>{preview.blockers.length>0&&<ul>{preview.blockers.map(code=><li key={code}>{AUTHORIZATION_BLOCKERS[code]}</li>)}</ul>}</section>}
  {selected&&<section aria-live="polite"><h5>Última consulta do comando · {AUTHORIZATION_LABELS[selected.status]}</h5>{details(selected)}</section>}
  {history&&<section><h5>Histórico desta assinatura</h5><p>O certificado atual não precisa estar disponível para ler o histórico. A consulta de comando aparece somente para tentativas pendentes identificadas como recuperáveis pelo seu usuário; os demais detalhes continuam legíveis abaixo.</p>
   {!history.items.length&&<p>Nenhuma tentativa registrada nesta página.</p>}
   {history.items.map(row=><article key={row.command_id}><h6>Tentativa {row.receipt!.ordinal} · {AUTHORIZATION_LABELS[row.status]}</h6>{details(row)}{row.recoverable_by_actor&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('command',null,row)}>Consultar comando da tentativa {row.receipt!.ordinal}</button>}</article>)}
   {history.has_more&&<button type="button" className="secondary-button" disabled={locked} onClick={()=>void read('history',history.next_cursor)}>Tentativas anteriores de autorização</button>}
  </section>}
 </section>;
}
