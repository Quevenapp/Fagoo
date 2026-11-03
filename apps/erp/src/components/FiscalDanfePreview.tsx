import {useEffect,useId,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
import type {SignedCandidate} from '../lib/fiscal-signed-model';
import {DANFE_BASE} from '../lib/fiscal-danfe-client';
import {publicResult,type DanfePreview} from '../../../../packages/fiscal-danfe-runtime/src/dto.mjs';
import './fiscal-danfe-preview.css';

type Controller=Pick<AccessController,'getSnapshot'|'subscribe'|'fiscalDanfe'>;
type Props={controller:Controller;candidate:SignedCandidate;blocked?:boolean};
const actorFor=(controller:Controller)=>{const s=controller.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'')?s.membership!.user_id:null;};
const message=(error:unknown)=>error instanceof AccessError&&error.status===403?'Seu perfil não permite abrir esta prévia.':error instanceof AccessError&&[404,409].includes(error.status)?'O arquivo mudou ou não está disponível para esta prévia. Consulte a assinatura novamente.':error instanceof AccessError&&error.status===422?'O conteúdo deste XML ainda não é suportado pela prévia de impressão.':'Não foi possível abrir a prévia. Tente consultar novamente.';

/** Displays only a hash-checked, inactive server rendering. Opening and printing never sign or query SEFAZ. */
export default function FiscalDanfePreview({controller,candidate,blocked=false}:Props){
 const uid=useId(),frame=useRef<HTMLIFrameElement>(null),request=useRef<AbortController|null>(null),alive=useRef(true);
 const [loaded,setLoaded]=useState<{actor:string;value:DanfePreview}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[frameReady,setFrameReady]=useState(false),[,changed]=useState(0);
 const loadedRef=useRef<typeof loaded>(null);
 const live=useRef({candidate,blocked});live.current={candidate,blocked};
 const close=()=>{request.current?.abort();request.current=null;loadedRef.current=null;setLoaded(null);setBusy(false);setFrameReady(false);setError('');};
 useEffect(()=>{alive.current=true;let priorActor=actorFor(controller);const unsubscribe=controller.subscribe(()=>{
  const actor=actorFor(controller);if(!actor||actor!==priorActor){close();}priorActor=actor;changed(n=>n+1);
 });return()=>{alive.current=false;request.current?.abort();unsubscribe();};},[controller]);
 useEffect(()=>{close();},[candidate.candidate_id,candidate.candidate_version,candidate.model,candidate.artifact?.sha256,candidate.artifact?.size_bytes,candidate.status]);
 const actor=actorFor(controller),preview=loaded?.actor===actor&&loaded.value.candidate_id===candidate.candidate_id&&loaded.value.candidate_version===candidate.candidate_version&&loaded.value.model===candidate.model&&loaded.value.source_sha256===candidate.artifact?.sha256&&loaded.value.source_size_bytes===candidate.artifact?.size_bytes?loaded.value:null,stored=candidate.status==='stored'&&candidate.artifact!==null;
 const open=async()=>{
  const actor=actorFor(controller),c=live.current.candidate;
  if(!actor||live.current.blocked||request.current||c.status!=='stored'||!c.artifact)return;
  const expected={id:c.candidate_id,version:c.candidate_version,hash:c.artifact.sha256,size:c.artifact.size_bytes,model:c.model},p=new AbortController();
  request.current=p;loadedRef.current=null;setBusy(true);setLoaded(null);setFrameReady(false);setError('');
  const valid=()=>{const c=live.current.candidate;return alive.current&&!p.signal.aborted&&request.current===p&&actorFor(controller)===actor&&c.status==='stored'&&c.candidate_id===expected.id&&c.candidate_version===expected.version&&c.model===expected.model&&c.artifact?.sha256===expected.hash&&c.artifact?.size_bytes===expected.size;};
  try{
   const raw=await controller.fiscalDanfe(`${DANFE_BASE}/candidates/${expected.id}/preview`,{signal:p.signal});if(!valid())return;
   const value=await publicResult(raw,{candidateId:expected.id});if(!valid())return;
   if(value.candidate_version!==expected.version||value.source_sha256!==expected.hash||value.source_size_bytes!==expected.size||value.model!==expected.model)throw new Error('DANFE_SOURCE_MISMATCH');
   const shown={actor,value};loadedRef.current=shown;setLoaded(shown);
  }catch(e){if(valid()&&!(e instanceof DOMException&&e.name==='AbortError'))setError(message(e));}
  finally{if(valid()){request.current=null;setBusy(false);}}
 };
 const print=()=>{
  if(!preview||loadedRef.current!==loaded||request.current||!frameReady||busy||live.current.blocked||actorFor(controller)!==loaded?.actor)return;
  try{const window=frame.current?.contentWindow;if(!window)throw new Error('DANFE_FRAME_UNAVAILABLE');window.focus();window.print();}
  catch{setError('Não foi possível abrir a impressão. Reabra a prévia e tente novamente.');}
 };
 return <section className="fiscal-danfe-preview" aria-labelledby={`${uid}-title`} aria-busy={busy}>
  <h4 id={`${uid}-title`}>{candidate.model==='65'?'Prévia do DANFE NFC-e':'Prévia do DANFE'}</h4>
  <p>Conferência do XML de homologação assinado. Sem autorização fiscal e sem valor fiscal.</p>
  <div className="button-group"><button type="button" className="secondary-button" disabled={!actor||blocked||busy||!stored} onClick={()=>void open()}>{preview?'Atualizar prévia':'Visualizar prévia de impressão'}</button>{(preview||busy)&&<button type="button" className="secondary-button" onClick={close}>Fechar prévia</button>}{preview&&<button type="button" className="secondary-button" disabled={!frameReady||busy||blocked||!actor} onClick={print}>Imprimir prévia sem valor fiscal</button>}</div>
  {busy&&<p role="status">Conferindo o arquivo e preparando a impressão…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {preview&&<><p role="status">{preview.model==='65'?'Bobina de 80 mm':`${preview.page_count} ${preview.page_count===1?'página':'páginas'} em A4`} · assinatura {preview.candidate_version}.{!preview.current.artifact_current&&' Arquivo histórico: confira as bases atuais antes de continuar.'}</p>
   <iframe ref={frame} title={`${candidate.model==='65'?'DANFE NFC-e':'DANFE'} — prévia sem valor fiscal`} srcDoc={preview.html} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" onLoad={event=>{if(event.currentTarget===frame.current&&loadedRef.current===loaded&&actorFor(controller)===loaded?.actor)setFrameReady(true);}} />
  </>}
 </section>;
}
