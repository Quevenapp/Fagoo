import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Link} from 'react-router-dom';
import type {AccessState,NativeRequestOptions} from '../lib/real-access';
import {captureJobsQuery,parseJobs,captureJobQuery,parseJob,jobsPath,jobPath,jobState,reasonText,KIND_TEXT,STATUS_TEXT,importScreen,plural,
 type ImportJob,type ImportJobsPage,type ImportJobPage} from '../lib/spreadsheet-import';
import {Modal} from './Modal';
import './spreadsheet-import.css';

export interface ImportJobsController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
const PAGE=25;

/** The recorded result of each line of one action, paged; "Somente com erro" lists the refused lines. */
function JobDetail({controller,job,onClose}:{controller:ImportJobsController;job:ImportJob;onClose:()=>void}){
 const [errors,setErrors]=useState(job.invalid>0),[page,setPage]=useState<ImportJobPage|null>(null),[offset,setOffset]=useState(0),[error,setError]=useState('');
 useEffect(()=>{const p=new AbortController(),q=captureJobQuery(job.id,{erros:errors?'1':null,limit:100,offset});setError('');
  void controller.system(jobPath(q),{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setPage(parseJob(raw,q));})
   .catch(e=>{if(!p.signal.aborted&&!aborted(e))setError('Não foi possível carregar o resultado desta ação.');});return()=>p.abort();},[controller,job.id,errors,offset]);
 return <Modal title={`${KIND_TEXT[job.kind]} · ${job.file_name}`} onClose={onClose} actions={<button type="button" className="secondary-button" onClick={onClose}>Fechar</button>}>
  <p className="real-help">{moment(job.created_at)} · {job.actor.label} · {jobState(job)} · {plural(job.rows_done,['registro processado','registros processados'])} de {job.total_rows}</p>
  <label className="product-check"><input type="checkbox" checked={errors} onChange={e=>{setErrors(e.target.checked);setOffset(0);setPage(null);}}/>Somente com erro</label>
  {error&&<p className="real-alert" role="alert">{error}</p>}{!page&&!error&&<p role="status">Carregando…</p>}
  {page&&(page.items.length?<div className="table-scroll"><table className="data-table import-rows"><thead><tr><th scope="col">Linha</th><th scope="col">Situação</th><th scope="col">Detalhe</th></tr></thead>
   <tbody>{page.items.map(r=><tr key={r.row} className={r.status==='invalid'?'is-invalid':undefined}><td>{r.row}</td><td>{STATUS_TEXT[r.status]}</td><td>{r.status==='invalid'?reasonText(job.kind,r):r.reference??'—'}</td></tr>)}</tbody></table></div>
   :<p className="empty-state">{errors?'Nenhuma linha com erro.':'Nenhuma linha registrada.'}</p>)}
  {page&&(page.offset>0||page.has_more)&&<p className="real-editor-actions"><button type="button" className="secondary-button" disabled={page.offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>Anteriores</button>
   <button type="button" className="secondary-button" disabled={!page.has_more} onClick={()=>setOffset(offset+100)}>Próximas</button></p>}
 </Modal>;
}

/**
 * Consultar gestão de ações (menu do usuário, Origin acoes.assincronas.php): the long actions of the user, newest first — today the
 * spreadsheet imports, sent in batches by the browser and recorded by the server. The administrador sees every user's actions.
 */
export default function RealImportJobs({controller}:{controller:ImportJobsController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null),ready=snapshot.phase==='ready'&&snapshot.membership?.user_id===actor.current;
 const [status,setStatus]=useState<''|'em_andamento'|'concluida'>(''),[offset,setOffset]=useState(0),[page,setPage]=useState<ImportJobsPage|null>(null),[error,setError]=useState('');
 const [open,setOpen]=useState<ImportJob|null>(null),[reload,setReload]=useState(0);
 useEffect(()=>{if(!ready){setPage(null);return;}const p=new AbortController(),q=captureJobsQuery({situacao:status||null,limit:PAGE,offset});setError('');
  void controller.system(jobsPath(q),{method:'GET',signal:p.signal}).then(raw=>{const s=controller.getSnapshot();if(!p.signal.aborted&&s.membership?.user_id===actor.current)setPage(parseJobs(raw,q));})
   .catch(e=>{if(!p.signal.aborted&&!aborted(e))setError('Não foi possível carregar as ações agora.');});return()=>p.abort();},[controller,ready,status,offset,reload,snapshot.membership?.role]);
 if(!ready)return <section className="real-state-panel"><h1>Gestão de ações</h1><p>Entre novamente para consultar suas ações.</p></section>;
 return <section className="spreadsheet-import" aria-labelledby="jobs-title">
  <header className="real-heading"><div><h1 id="jobs-title">Gestão de ações</h1><p className="real-help">Ações longas feitas em lotes, como as importações de planilhas, com o andamento e o resultado de cada linha.</p></div>
   <button type="button" className="secondary-button" onClick={()=>setReload(n=>n+1)}>Recarregar</button></header>
  <div className="import-filters"><label htmlFor="jobs-status">Situação</label><select id="jobs-status" value={status} onChange={e=>{setStatus(e.target.value as typeof status);setOffset(0);setPage(null);}}>
   <option value="">Todas</option><option value="em_andamento">Em andamento</option><option value="concluida">Concluída</option></select></div>
  {error&&<p className="real-alert" role="alert">{error}</p>}{!page&&!error&&<p role="status">Carregando…</p>}
  {page&&(page.items.length?<div className="table-scroll"><table className="data-table import-jobs"><thead><tr><th scope="col">Data</th><th scope="col">Ação</th><th scope="col">Arquivo</th>
   {page.all_users&&<th scope="col">Usuário</th>}<th scope="col">Situação</th><th scope="col">Progresso</th><th scope="col">Resultado</th><th scope="col"><span className="real-sr-only">Abrir</span></th></tr></thead>
   <tbody>{page.items.map(j=>{const percent=Math.floor(j.rows_done*100/j.total_rows);return <tr key={j.id}><td>{moment(j.created_at)}</td><td><Link to={importScreen(j.kind)}>{KIND_TEXT[j.kind]}</Link></td><td>{j.file_name}</td>
    {page.all_users&&<td>{j.actor.label}</td>}<td>{jobState(j)}</td>
    <td><progress max={j.total_rows} value={j.rows_done} aria-label={`${percent}%`}/> {j.rows_done}/{j.total_rows}</td>
    <td>{j.created} incluídos · {j.updated} atualizados · {j.unchanged} sem alteração · {j.invalid} com erro</td>
    <td><button type="button" className="text-button" onClick={()=>setOpen(j)}>Ver resultado</button></td></tr>;})}</tbody></table></div>
   :<p className="empty-state">Nenhuma ação registrada{status?' nesta situação':''}.</p>)}
  {page&&<p className="real-help">Quantidade de ações: {page.total}</p>}
  {page&&(page.offset>0||page.has_more)&&<p className="real-editor-actions"><button type="button" className="secondary-button" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-PAGE))}>Anteriores</button>
   <button type="button" className="secondary-button" disabled={!page.has_more} onClick={()=>setOffset(offset+PAGE)}>Próximas</button></p>}
  {open&&<JobDetail controller={controller} job={open} onClose={()=>setOpen(null)}/>}
 </section>;
}
