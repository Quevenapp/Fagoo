import {useEffect,useId,useRef,useState} from 'react';
import {actorForStorageAudit,parseStorageAuditPlan,runStorageAudit,StorageAuditError,type PreparedStorageAuditPlan,type StorageAuditController,type StorageAuditProgress,type StorageAuditReport} from '../lib/storage-audit-model';

const MAX_PLAN_BYTES=16*1024*1024;
const count=(value:number)=>value.toLocaleString('pt-BR');
const bytes=(value:number)=>`${(value/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:2})} MB`;

export default function StorageAudit({controller}:{controller:StorageAuditController}){
 const inputId=useId();
 const[authorized,setAuthorized]=useState(()=>actorForStorageAudit(controller)!==null);
 const[prepared,setPrepared]=useState<PreparedStorageAuditPlan|null>(null),[progress,setProgress]=useState<StorageAuditProgress|null>(null),[report,setReport]=useState<StorageAuditReport|null>(null);
 const[busy,setBusy]=useState<'loading'|'running'|null>(null),[error,setError]=useState(''),[inputKey,setInputKey]=useState(0);
 const[planText,setPlanText]=useState(''),textInput=useRef('');
 const generation=useRef(0),locked=useRef(false),request=useRef<AbortController|null>(null);
 const session=useRef({controller,actor:actorForStorageAudit(controller)});
 const renderedActor=actorForStorageAudit(controller),renderedGeneration=generation.current;

 useEffect(()=>{
  let closed=false;
  const sync=()=>{
   if(closed)return;
   const actor=actorForStorageAudit(controller);setAuthorized(actor!==null);
   if(session.current.controller===controller&&session.current.actor===actor)return;
   generation.current++;request.current?.abort();request.current=null;locked.current=false;
   session.current={controller,actor};textInput.current='';setPlanText('');setPrepared(null);setProgress(null);setReport(null);setBusy(null);setError('');setInputKey(value=>value+1);
  };
  sync();let unsubscribe:(()=>void)|undefined;
  try{unsubscribe=controller.subscribe(sync);sync();}catch{setAuthorized(false);generation.current++;request.current?.abort();session.current={controller,actor:null};textInput.current='';setPlanText('');setPrepared(null);setReport(null);setProgress(null);setBusy(null);locked.current=false;}
  return()=>{closed=true;generation.current++;textInput.current='';request.current?.abort();request.current=null;locked.current=false;try{unsubscribe?.();}catch{/* No session details enter the page. */}};
 },[controller]);

 const current=(ticket:number,actor:string)=>ticket===generation.current&&session.current.controller===controller&&session.current.actor===actor&&actorForStorageAudit(controller)===actor;
 const controlsCurrent=()=>renderedActor!==null&&renderedGeneration===generation.current&&session.current.controller===controller&&session.current.actor===renderedActor&&actorForStorageAudit(controller)===renderedActor;
 const editText=(value:string)=>{
  if(locked.current||!controlsCurrent())return;
  generation.current++;textInput.current=value;setPlanText(value);
  setPrepared(null);setReport(null);setProgress(null);setError('');setInputKey(key=>key+1);
 };
 const load=async(source:{kind:'file';file:File}|{kind:'text';text:string})=>{
  if(locked.current||!controlsCurrent())return;
  const actor=actorForStorageAudit(controller);if(!actor||session.current.controller!==controller||session.current.actor!==actor)return;
  locked.current=true;const ticket=++generation.current,operation=new AbortController();request.current=operation;
  setPrepared(null);setReport(null);setProgress(null);setError('');setBusy('loading');
  try{
   let body:Uint8Array;
   if(source.kind==='file'){
    textInput.current='';setPlanText('');
    if(source.file.size===0||source.file.size>MAX_PLAN_BYTES)throw new StorageAuditError(source.file.size>MAX_PLAN_BYTES?'PLAN_TOO_LARGE':'PLAN_INVALID');
    body=new Uint8Array(await source.file.arrayBuffer());
   }else{
    setInputKey(key=>key+1);
    // Bound allocation first, then enforce the actual UTF8 byte limit. Never trim/reformat JSON.
    if(source.text.length===0||source.text.length>MAX_PLAN_BYTES)throw new StorageAuditError(source.text.length>MAX_PLAN_BYTES?'PLAN_TOO_LARGE':'PLAN_INVALID');
    body=new TextEncoder().encode(source.text);
    if(body.byteLength>MAX_PLAN_BYTES)throw new StorageAuditError('PLAN_TOO_LARGE');
   }
   if(!current(ticket,actor)||operation.signal.aborted)return;
   const value=await parseStorageAuditPlan(body,operation.signal);
   if(current(ticket,actor)&&!operation.signal.aborted)setPrepared(value);
  }catch(failure){if(current(ticket,actor))setError(failure instanceof StorageAuditError&&failure.code==='PLAN_TOO_LARGE'?'O plano da conferência excede o limite de 16 MB.':operation.signal.aborted?'Leitura interrompida.':'Não foi possível carregar o plano de conferência. Verifique o conteúdo.');}
  finally{if(current(ticket,actor)){request.current=null;locked.current=false;setBusy(null);}}
 };
 const start=async()=>{
  if(locked.current||!prepared||!controlsCurrent())return;
  const actor=actorForStorageAudit(controller);if(!actor||session.current.controller!==controller||session.current.actor!==actor)return;
  locked.current=true;const ticket=++generation.current,operation=new AbortController();request.current=operation;
  setReport(null);setProgress(null);setError('');setBusy('running');
  try{
   const value=await runStorageAudit(prepared,controller,{signal:operation.signal,onProgress:value=>{if(current(ticket,actor))setProgress(value);}});
   if(current(ticket,actor))setReport(value);
  }catch{if(current(ticket,actor))setError('Não foi possível concluir a conferência. Carregue novamente o plano antes de tentar outra vez.');}
  finally{if(current(ticket,actor)){request.current=null;locked.current=false;setBusy(null);}}
 };
 const stop=()=>{
  if(!controlsCurrent())return;
  request.current?.abort();
  if(busy==='loading'){generation.current++;request.current=null;locked.current=false;setBusy(null);setError('Leitura interrompida.');}
 };
 const save=()=>{
  if(!report||busy||locked.current||!controlsCurrent())return;
  let url:string|undefined;
  try{
   url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}));
   const anchor=document.createElement('a');anchor.href=url;anchor.download=`conferencia-arquivos-${report.plan_sha256.slice(0,12)}.json`;anchor.click();
  }catch{setError('Não foi possível salvar o relatório. Tente novamente.');}
  finally{if(url)URL.revokeObjectURL(url);}
 };
 if(!authorized)return null;
 const totals=report?report.results.reduce((sum,item)=>({...sum,[item.status]:sum[item.status]+1}),{verified:0,failed:0,not_attempted:0}):null;
 return <section aria-labelledby={`${inputId}-heading`}>
  <h2 id={`${inputId}-heading`}>Conferir arquivos preservados</h2>
  <div className="integration-panel storage-audit">
   <p className="real-help">Carregue a lista de arquivos preparada para a conferência. Cada XML será lido e comparado com o tamanho e a impressão digital esperados, usando sua sessão de administrador. Mantenha esta tela aberta e salve o relatório antes de sair.</p>
   <label className="form-field" htmlFor={inputId}>Arquivo da conferência<input key={inputKey} id={inputId} type="file" accept=".json,application/json" disabled={busy!==null} onChange={event=>{const file=event.target.files?.[0];if(file)void load({kind:'file',file});}}/></label>
   <details className="storage-audit-paste"><summary>Ou colar o plano de conferência</summary>
    <label className="form-field" htmlFor={`${inputId}-text`}>Plano em JSON<textarea id={`${inputId}-text`} rows={6} value={planText} disabled={busy!==null} spellCheck={false} autoComplete="off" onChange={event=>editText(event.target.value)}/></label>
    <button type="button" className="secondary-button" disabled={busy!==null||planText.length===0} onClick={()=>{void load({kind:'text',text:textInput.current});}}>Carregar texto</button>
   </details>
   {prepared&&<><p>Lista carregada: {count(prepared.plan.entries.length)} arquivos · {bytes(prepared.total_bytes)}.</p><p className="storage-audit-hash">SHA-256 do plano: <code>{prepared.plan_sha256}</code></p></>}
   <div className="storage-audit-actions"><button type="button" className="secondary-button" disabled={!prepared||busy!==null} onClick={()=>{void start();}}>Conferir arquivos</button>{busy&&<button type="button" className="secondary-button" onClick={stop}>Interromper</button>}{report&&<button type="button" className="secondary-button" disabled={busy!==null} onClick={save}>Salvar relatório</button>}</div>
   {busy==='loading'&&<p role="status">Lendo lista de arquivos…</p>}
   {progress&&<p role="status">{count(progress.completed)} de {count(progress.total)} conferidos · {count(progress.verified)} confirmados · {count(progress.failed)} com pendência · {bytes(progress.bytes_verified)} confirmados.</p>}
   {report&&totals&&<p role="status">{report.status==='stopped'?'Conferência interrompida.':totals.failed?'Conferência encerrada com pendências.':'Conferência encerrada.'} {count(totals.verified)} confirmados, {count(totals.failed)} com pendência e {count(totals.not_attempted)} não consultados. Salve o relatório para preservar o resultado.</p>}
   {error&&<p className="real-alert" role="alert">{error}</p>}
   <p className="real-help">A conferência descreve os arquivos desta lista no intervalo em que foram lidos. Ela não certifica uma cópia simultânea do armazenamento, uma restauração ou a assinatura e a autorização fiscal dos XMLs.</p>
  </div>
 </section>;
}
