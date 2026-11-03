import {useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {journalEnvelope,journalPage,journalPath,journalTextError,journalTime,sameJournalEntry,type JournalCommand,type ServiceJournalController,type ServiceJournalEntry,type ServiceJournalPage} from '../lib/service-journal-model';
import './service-order-journal.css';

interface Attempt {path:string;documentId:string;command:JournalCommand;saved:ServiceJournalEntry|null;uncertain:boolean}
interface Props {controller:ServiceJournalController;documentId:string;documentVersion:number;writable:boolean;actorId?:string;blocked?:boolean;onDraft?:(value:boolean)=>void;onBusy?:(value:boolean)=>void;onRefreshDocument?:()=>void}
const cancelled=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';
const message=(error:unknown)=>error instanceof AccessError&&error.status===403?'Seu perfil não permite esta operação.':error instanceof AccessError&&error.status===409?'A OS mudou. Atualize o documento antes de registrar este texto.':error instanceof AccessError&&error.status===404?'A OS ou o registro não está disponível.':'Não foi possível concluir a operação. Tente novamente.';
export default function ServiceOrderJournal({controller,documentId,documentVersion,writable,actorId,blocked=false,onDraft,onBusy,onRefreshDocument}:Props){
 const [page,setPage]=useState<ServiceJournalPage|null>(null),[text,setText]=useState(''),[before,setBefore]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]);
 const [loading,setLoading]=useState(true),[reload,setReload]=useState(0),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const attempt=useRef<Attempt|null>(null),pending=useRef<AbortController|null>(null),listRequest=useRef<AbortController|null>(null),generation=useRef(0),scope=useRef(documentId),input=useRef<HTMLTextAreaElement>(null);
 const callbacks=useRef({onDraft,onBusy});callbacks.current={onDraft,onBusy};
 const dirty=text.length>0;useUnsavedChanges(dirty,busy||unresolved);
 useLayoutEffect(()=>{callbacks.current.onDraft?.(dirty);callbacks.current.onBusy?.(busy||unresolved);},[dirty,busy,unresolved]);
 useLayoutEffect(()=>()=>{callbacks.current.onDraft?.(false);callbacks.current.onBusy?.(false);},[]);
 useEffect(()=>()=>{pending.current?.abort();listRequest.current?.abort();generation.current++;},[]);
 const readPage=async(signal:AbortSignal,cursor:string|null)=>journalPage(await controller.serviceJournal(`${journalPath(documentId)}?limit=25${cursor?`&before=${cursor}`:''}`,{signal}),documentId,cursor);
 useEffect(()=>{
  if(scope.current!==documentId){pending.current?.abort();attempt.current=null;scope.current=documentId;setText('');setUnresolved(false);setBusy(false);setBefore(null);setHistory([]);setNotice('');}
  const request=new AbortController(),current=++generation.current;listRequest.current?.abort();listRequest.current=request;setLoading(true);setPage(null);
  void readPage(request.signal,before).then(value=>{if(!request.signal.aborted&&generation.current===current){setPage(value);setLoading(false);}}).catch(failure=>{if(!request.signal.aborted&&generation.current===current){setError(message(failure));setLoading(false);}});
  return()=>request.abort();
 },[controller,documentId,documentVersion,before,reload]);
 const current=page?.document_id===documentId?page:null,stale=current!==null&&current.document_version!==documentVersion;
 const locked=busy||unresolved,canWrite=writable&&current?.can_write===true&&!stale&&!loading;
 const recover=async()=>{
  const operation=attempt.current;if(!operation||pending.current&&!pending.current.signal.aborted||blocked)return;
  const request=new AbortController();pending.current=request;listRequest.current?.abort();generation.current++;setBusy(true);setError('');setNotice('');
  try{
   if(!operation.saved){
    const raw=await controller.serviceJournal(operation.path,{method:'POST',body:operation.command,signal:request.signal});if(request.signal.aborted)return;
    operation.saved=journalEnvelope(raw,operation.documentId,{command:operation.command,actorId}).entry;operation.uncertain=false;
   }
   const raw=await controller.serviceJournal(journalPath(operation.documentId,operation.saved.id),{signal:request.signal});if(request.signal.aborted)return;
   const found=journalEnvelope(raw,operation.documentId,{entryId:operation.saved.id});if(!sameJournalEntry(found.entry,operation.saved))throw new AccessError(502);
   const latest=await readPage(request.signal,null);if(request.signal.aborted)return;
   attempt.current=null;setUnresolved(false);setText('');setBefore(null);setHistory([]);setPage(latest);setLoading(false);setNotice(`Registro ${found.entry.sequence} incluído no diário. A OS e seus lançamentos foram preservados.`);
  }catch(failure){if(!request.signal.aborted&&!cancelled(failure)){
   const known=!operation.saved&&!operation.uncertain&&failure instanceof AccessError&&[400,401,403,404,409].includes(failure.status);
   if(known){attempt.current=null;setUnresolved(false);setError(message(failure));setReload(value=>value+1);}
   else{operation.uncertain=true;setError(operation.saved?'O registro foi confirmado, mas a consulta atual falhou. Consulte novamente antes de continuar.':'O registro pode ter sido salvo. Repita a mesma confirmação para recuperar o resultado.');}
  }}finally{if(!request.signal.aborted){pending.current=null;setBusy(false);}}
 };
 const submit=(event:FormEvent)=>{
  event.preventDefault();if(!canWrite||blocked||locked||attempt.current)return;
  const problem=journalTextError(text);if(problem){setError(problem);input.current?.focus();return;}
  attempt.current={path:journalPath(documentId),documentId,command:{command_id:crypto.randomUUID(),expected_document_version:documentVersion,text},saved:null,uncertain:false};setUnresolved(true);void recover();
 };
 const clear=()=>{if(locked)return;setText('');setError('');input.current?.focus();};
 const refresh=()=>{if(loading||locked)return;setError('');setBefore(null);setHistory([]);setReload(value=>value+1);};
 const recent=()=>{if(locked||loading||!history.length)return;setError('');setBefore(history.at(-1)??null);setHistory(value=>value.slice(0,-1));};
 const older=()=>{if(locked||loading||!current?.has_more)return;setError('');setHistory(value=>[...value,before]);setBefore(current.next_before);};
 return <section className="service-journal document-section" aria-labelledby="service-journal-title"><h3 id="service-journal-title">Diário da ordem de serviço</h3>
  <p className="real-help">Registre diagnóstico, atividades, testes e entrega. Cada texto permanece no histórico; esta ação não altera a situação, peças, valores ou pagamentos.</p>
  {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {stale&&<p className="real-notice">A OS mudou desde que este formulário foi aberto. Atualize o documento antes de registrar.{onRefreshDocument&&<button type="button" className="text-button" disabled={locked||dirty} onClick={()=>{if(!locked&&!dirty)onRefreshDocument();}}>Atualizar documento</button>}</p>}
  {writable&&<form onSubmit={submit}><div className="form-field"><label htmlFor="service-journal-text">Atividade ou observação</label><textarea id="service-journal-text" ref={input} rows={4} maxLength={8000} value={text} disabled={!canWrite||blocked||locked} aria-describedby="service-journal-text-help" onChange={event=>{if(canWrite&&!blocked&&!locked)setText(event.target.value);}}/><small id="service-journal-text-help">Até 4.000 caracteres. Para corrigir um registro anterior, acrescente um novo texto. O diário não aparece na impressão comercial.</small></div>
   <div className="real-editor-actions"><button type="submit" className="primary-button" disabled={!canWrite||blocked||locked}>Registrar atividade</button><button type="button" className="secondary-button" disabled={locked||!dirty} onClick={clear}>Limpar texto</button></div></form>}
  {unresolved&&<div className="service-journal-recovery" role="status"><p>{attempt.current?.saved?'Consulte o registro confirmado. Nenhum novo texto será enviado.':'A mesma confirmação será repetida, com o texto e a identificação originais.'}</p><button type="button" className="primary-button" disabled={busy||blocked} onClick={()=>void recover()}>{attempt.current?.saved?'Consultar registro confirmado':'Repetir a mesma confirmação'}</button></div>}
  <div className="service-journal-toolbar"><strong>Registros mais recentes primeiro</strong><button type="button" className="text-button" disabled={loading||locked} onClick={refresh}>Atualizar diário</button></div>
  {loading?<p role="status">Consultando diário…</p>:current?<>{!current.items.length?<p>Nenhum registro nesta página.</p>:<ol className="service-journal-entries">{current.items.map(row=><li key={row.id}><header><strong>Registro {row.sequence}</strong><time dateTime={row.recorded_at}>{journalTime(row.recorded_at)}</time><span title={`Identificação do autor: ${row.actor_id}`}>{actorId===row.actor_id?'Registrado por você':'Registrado por outro usuário'}</span><small>Versão da OS no registro: {row.document_version}</small></header><p>{row.text}</p></li>)}</ol>}
   <div className="real-pagination"><span>Página {history.length+1}</span><button type="button" className="text-button" disabled={locked||!history.length} onClick={recent}>Mais recentes</button><button type="button" className="text-button" disabled={locked||!current.has_more} onClick={older}>Mais antigos</button></div></>:<p>Atualize o diário para consultar os registros.</p>}
 </section>;
}
