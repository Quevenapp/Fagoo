import {useEffect,useId,useRef,useState} from 'react';
import {AccessError,type AccessController,type NativeRequestOptions} from '../lib/real-access';
import {checkedProcessedDocument,processedDocumentPath,processedReferenceKey,type ProcessedDocumentReference} from '../lib/fiscal-processed-document-model';
import {decodeProcessedXml,type ProcessedPrint} from '../../../../packages/fiscal-danfe-runtime/src/processed-dto.mjs';
import './fiscal-danfe-preview.css';
type Controller=Pick<AccessController,'getSnapshot'|'subscribe'>&{fiscalProcessedDocument:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};
type Props={controller:Controller;source:ProcessedDocumentReference;blocked?:boolean};
const actorFor=(c:Controller)=>{const s=c.getSnapshot();return s.phase==='ready'&&['admin','fiscal'].includes(s.membership?.role??'')?s.membership!.user_id:null;};
const message=(e:unknown)=>e instanceof AccessError&&e.status===403?'O acesso a este arquivo exige o usuário original da operação e permissão fiscal atual.':e instanceof AccessError&&e.status===422?'Este XML está disponível para download, mas o conteúdo ainda não é suportado pela impressão.':e instanceof AccessError&&[404,409].includes(e.status)?'O arquivo não está disponível ou não corresponde ao recibo consultado. Atualize a consulta do recibo.':'Não foi possível conferir o arquivo. Tente consultar novamente.';
/** Standalone until explicit controller/receipt wiring. Only authenticated GETs; no fiscal mutations. */
export default function FiscalProcessedDocument({controller,source,blocked=false}:Props){
 const uid=useId(),frame=useRef<HTMLIFrameElement>(null),alive=useRef(true),request=useRef<AbortController|null>(null),urls=useRef(new Set<string>());
 const [print,setPrint]=useState<{actor:string;key:string;value:ProcessedPrint}|null>(null),[busy,setBusy]=useState(false),[frameReady,setFrameReady]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[,changed]=useState(0);
 const live=useRef({source,blocked});live.current={source,blocked};const printRef=useRef(print);printRef.current=print;
 const revoke=()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();};
 const close=()=>{request.current?.abort();request.current=null;printRef.current=null;setPrint(null);setFrameReady(false);setBusy(false);setError('');setNotice('');revoke();};
 useEffect(()=>{alive.current=true;let previous=actorFor(controller);const unsub=controller.subscribe(()=>{const actor=actorFor(controller);if(!actor||actor!==previous)close();previous=actor;changed(n=>n+1);});return()=>{alive.current=false;request.current?.abort();revoke();unsub();};},[controller]);
 const key=processedReferenceKey(source);useEffect(()=>close(),[key]);
 const actor=actorFor(controller),shown=print?.actor===actor&&print.key===key?print:null;
 const open=async(action:'xml'|'print')=>{
  if(!alive.current||key!==processedReferenceKey(live.current.source)||!actor||actorFor(controller)!==actor)return;
  const reference={...live.current.source},requestKey=processedReferenceKey(reference);if(live.current.blocked||request.current)return;
  const abort=new AbortController();request.current=abort;setBusy(true);setError('');setNotice('');
  const valid=()=>alive.current&&!abort.signal.aborted&&request.current===abort&&actorFor(controller)===actor&&!live.current.blocked&&processedReferenceKey(live.current.source)===requestKey;
  try{
   const raw=await controller.fiscalProcessedDocument(processedDocumentPath(reference,action),{signal:abort.signal});if(!valid())return;
   const value=await checkedProcessedDocument(raw,reference,action);if(!valid())return;
   if(value.action==='print'){const loaded={actor,key:requestKey,value};printRef.current=loaded;setPrint(loaded);setFrameReady(false);}
   else{const bytes=decodeProcessedXml(value.xml_base64);try{if(!valid())return;const blob=new Blob([new Uint8Array(bytes)],{type:'application/xml;charset=utf-8'}),url=URL.createObjectURL(blob);urls.current.add(url);const a=document.createElement('a');a.href=url;a.download=value.filename;a.rel='noopener';a.click();setNotice('Download do XML de homologação preparado.');setTimeout(()=>{if(urls.current.delete(url))URL.revokeObjectURL(url);},0);}finally{bytes.fill(0);}}
  }catch(e){if(valid()&&!(e instanceof DOMException&&e.name==='AbortError'))setError(message(e));}
  finally{if(request.current===abort){request.current=null;setBusy(false);}}
 };
 const printNow=()=>{if(!alive.current||!shown||printRef.current!==print||!frameReady||request.current||live.current.blocked||actorFor(controller)!==shown.actor||processedReferenceKey(live.current.source)!==shown.key)return;try{frame.current?.contentWindow?.focus();frame.current?.contentWindow?.print();}catch{setError('Não foi possível abrir a impressão. Reabra o documento e tente novamente.');}};
 if(!actor)return null;
 return <section className="fiscal-danfe-preview" aria-labelledby={`${uid}-title`} aria-busy={busy}>
  <h4 id={`${uid}-title`}>Arquivos do teste autorizado</h4>
  <p>XML processado e {source.model==='65'?'DANFE NFC-e':'DANFE'} de homologação com o protocolo registrado. Sem valor fiscal. A situação atual da nota não é consultada aqui.</p>
  <div className="button-group"><button type="button" className="secondary-button" disabled={blocked||busy} onClick={()=>void open('xml')}>Baixar XML do teste</button><button type="button" className="secondary-button" disabled={blocked||busy} onClick={()=>void open('print')}>{shown?'Atualizar impressão':'Visualizar DANFE de homologação'}</button>{(shown||busy)&&<button type="button" className="secondary-button" onClick={close}>Fechar arquivos</button>}{shown&&<button type="button" className="secondary-button" disabled={!frameReady||blocked||busy} onClick={printNow}>Imprimir DANFE sem valor fiscal</button>}</div>
  {busy&&<p role="status">Conferindo o arquivo e o acesso…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {shown&&<><p>{shown.value.source.model==='65'?'Bobina de 80 mm':`${shown.value.page_count} folha(s) em A4`} · Protocolo {shown.value.source.protocol.number}</p><iframe ref={frame} title="DANFE de homologação com protocolo — sem valor fiscal" srcDoc={shown.value.html} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer" onLoad={e=>{if(e.currentTarget===frame.current&&printRef.current===shown&&actorFor(controller)===shown.actor&&processedReferenceKey(live.current.source)===shown.key)setFrameReady(true);}} /></>}
 </section>;
}
