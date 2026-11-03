import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges,useUnsavedChangesGuard} from '../hooks/useUnsavedChanges';
import {badgeClass} from '../lib/origin-list';
import {DFE_BASE,DFE_KIND_LABELS,DFE_COORDINATORS,dfeSettings,dfeCompany,dfeInitialForm,dfeConfigBody,dfeCommand,dfePage,dfeListParams,dfeFilename,verifyDfeBlob,dfeHasSummary,dfeSummaries,dfeSummaryParams,dfeSummaryResult,DFE_SUMMARY_SITUATIONS,type DfeSummary,type ReceivedDfeController,type DfeEnvironment,type DfeChannel,type DfeDocument,type DfePage,type DfeKind,type DfeForm,type DfeCompany,type DfeConfigBody} from '../lib/received-dfe-model';
import {Icon} from './Icon';
import FiscalImportDialog from './FiscalImportDialog';
import FiscalDanfePrint,{type DanfeDocument} from './FiscalDanfe';
import {DEFAULT_DANFE_SETTINGS,danfeData,danfeErrorText} from '../lib/danfe';
import {SCREENS,importRefusalText,keyParts} from '../lib/fiscal-invoice-list-model';
// Notas fiscais lane (wave F): "Editar NF-e", the received NF-e opened in the note form as an entry note to complete and save.
import FiscalInvoiceForm from './FiscalInvoiceForm';
import {normalizeInvoiceInput,type InvoiceInput} from '../../../../packages/erp-domain/src/fiscal-invoice-contract.mjs';
import {keyLookupRecord} from '../../../../packages/erp-domain/src/fiscal-invoice-order.mjs';
import type {AccessController} from '../lib/real-access';
import './OriginList';
import './received-dfe.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const failure=(e:unknown)=>e instanceof AccessError&&e.status===403?'Seu perfil não permite esta operação.':e instanceof AccessError&&e.status===409?'A configuração mudou ou há uma tentativa pendente. Recarregue para conferir antes de decidir novamente.':'Não foi possível confirmar os dados. Tente novamente.';
const moment=(value:string)=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value));
const environmentLabel=(v:DfeEnvironment)=>v==='1'?'Produção':'Homologação';
const spToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const situation=(row:DfeDocument)=>row.is_complete_invoice?'Arquivo completo preservado':row.kind==='unsupported'?'Formato não reconhecido; revisar separadamente':row.kind==='invoice_summary'?'Somente resumo da nota':row.kind==='event_summary'?'Somente resumo do evento':'Evento associado à nota';

export default function RealReceivedDfe({controller,canConfigure=false,initialEnvironment=''}:{controller:ReceivedDfeController;canConfigure?:boolean;initialEnvironment?:''|DfeEnvironment}){
 const guard=useUnsavedChangesGuard(),navigate=useNavigate();
 const [environment,setEnvironment]=useState<''|DfeEnvironment>(initialEnvironment),[current,setCurrent]=useState<DfeChannel|null>(null),[settingsReady,setSettingsReady]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0),[editing,setEditing]=useState(false);
 const [kind,setKind]=useState<''|DfeKind>(''),[after,setAfter]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]),[page,setPage]=useState<DfePage|null>(null),[listLoading,setListLoading]=useState(false),[listError,setListError]=useState('');
 const [downloading,setDownloading]=useState(''),[downloadError,setDownloadError]=useState('');const download=useRef<AbortController|null>(null);
 // "Importar NF-e para notas de compra": the screen receives the full session controller (RealAccess); only admin and fiscal import.
 const importer=('fiscalInvoices' in controller&&'getSnapshot' in controller?controller as unknown as AccessController:null);
 const canImport=Boolean(importer&&['admin','fiscal'].includes(importer.getSnapshot?.()?.membership?.role??''));
 const [importing,setImporting]=useState<{name:string;xml:string}|null>(null),[copied,setCopied]=useState('');
 // Notas fiscais lane (wave E): "Pré-visualizar NF-e", the DANFE of a complete received NF-e from its checked XML (read only).
 const [preview,setPreview]=useState<DanfeDocument|null>(null);
 const [editingNote,setEditingNote]=useState<InvoiceInput|null>(null);
 useEffect(()=>{
  const request=new AbortController();setCurrent(null);setSettingsReady(false);setError('');setLoading(Boolean(environment));setPage(null);setAfter(null);setHistory([]);download.current?.abort();download.current=null;setDownloading('');setDownloadError('');
  if(environment)void controller.dfeDistribution(`${DFE_BASE}/settings?environment=${environment}`,{signal:request.signal}).then(value=>{if(!request.signal.aborted){setCurrent(dfeSettings(value,environment));setSettingsReady(true);}}).catch(e=>{if(!request.signal.aborted&&!aborted(e))setError(failure(e));}).finally(()=>{if(!request.signal.aborted)setLoading(false);});
  return()=>{request.abort();download.current?.abort();};
 },[controller,environment,reload]);
 useEffect(()=>{
  const request=new AbortController();download.current?.abort();download.current=null;setDownloading('');setDownloadError('');setPage(null);setListError('');setListLoading(Boolean(settingsReady&&current&&!editing));
  if(settingsReady&&current&&!editing)void controller.dfeDistribution(`${DFE_BASE}/documents?${dfeListParams(current.id,kind,after)}`,{signal:request.signal}).then(value=>{if(!request.signal.aborted)setPage(dfePage(value,current.id,kind,after));}).catch(e=>{if(!request.signal.aborted&&!aborted(e))setListError(failure(e));}).finally(()=>{if(!request.signal.aborted)setListLoading(false);});
  return()=>{request.abort();download.current?.abort();};
 },[controller,current,settingsReady,kind,after,editing,reload]);
 // Leva H (NFE-212): Data emissão, Valor and Fornecedor of the page, read once from the kept bytes and stored (nothing is collected).
 const [summaries,setSummaries]=useState<Map<string,DfeSummary>>(new Map()),[unreadable,setUnreadable]=useState<Set<string>>(new Set());
 useEffect(()=>{
  setSummaries(new Map());setUnreadable(new Set());
  const ids=(page?.items??[]).filter(dfeHasSummary).map(row=>row.id);if(!page||!ids.length)return;
  const request=new AbortController(),channelId=page.channel_id;
  void(async()=>{
   try{
    const stored=dfeSummaries(await controller.dfeDistribution(`${DFE_BASE}/summaries?${dfeSummaryParams(channelId,ids)}`,{signal:request.signal}),channelId,ids);if(request.signal.aborted)return;setSummaries(new Map(stored));
    for(const id of ids.filter(id=>!stored.has(id))){
     if(request.signal.aborted)return;
     try{const read=dfeSummaryResult(await controller.dfeDistribution(`${DFE_BASE}/documents/${id}/summary`,{method:'POST',body:{},signal:request.signal}),id);if(!request.signal.aborted)setSummaries(v=>new Map(v).set(id,read));}
     catch(e){if(request.signal.aborted||aborted(e))return;setUnreadable(v=>new Set(v).add(id));}
    }
   }catch(e){if(!request.signal.aborted&&!aborted(e))setUnreadable(new Set(ids));}
  })();
  return()=>request.abort();
 },[controller,page]);
 const summaryOf=(row:DfeDocument)=>summaries.get(row.id)??null,pending=(row:DfeDocument)=>dfeHasSummary(row)&&!summaries.has(row.id)?(unreadable.has(row.id)?'Não lido':'Lendo…'):'—';
 const importFile=async(row:DfeDocument)=>{
  if(download.current||listLoading||loading||!canImport)return;const request=new AbortController();download.current=request;setDownloading(row.id);setDownloadError('');
  try{const value=await controller.dfeDistributionDownload(`${DFE_BASE}/documents/${row.id}/download`,request.signal);if(request.signal.aborted||download.current!==request)return;const blob=await verifyDfeBlob(value,row,request.signal);if(request.signal.aborted||download.current!==request)return;
   setImporting({name:dfeFilename(row),xml:new TextDecoder('utf-8',{fatal:true}).decode(await blob.arrayBuffer())});
  }catch(e){if(!request.signal.aborted&&!aborted(e))setDownloadError('Não foi possível conferir este arquivo para importar. Tente novamente.');}finally{if(download.current===request){download.current=null;if(!request.signal.aborted)setDownloading('');}}
 };
 const previewFile=async(row:DfeDocument)=>{
  if(download.current||listLoading||loading)return;const request=new AbortController();download.current=request;setDownloading(row.id);setDownloadError('');
  try{const value=await controller.dfeDistributionDownload(`${DFE_BASE}/documents/${row.id}/download`,request.signal);if(request.signal.aborted||download.current!==request)return;const blob=await verifyDfeBlob(value,row,request.signal);if(request.signal.aborted||download.current!==request)return;
   const data=danfeData(new TextDecoder('utf-8',{fatal:true}).decode(await blob.arrayBuffer()));if(row.access_key&&data.key!==row.access_key)throw new Error('DANFE_KEY_INVALID');setPreview({data,status:null});
  }catch(e){if(!request.signal.aborted&&!aborted(e))setDownloadError(e instanceof Error&&e.name==='DanfeError'?danfeErrorText(e):'Não foi possível conferir este arquivo para a pré-visualização.');}finally{if(download.current===request){download.current=null;if(!request.signal.aborted)setDownloading('');}}
 };
 // "Editar NF-e": a note of the Brufap with this key opens as it is; otherwise the checked XML becomes an entry note "Emitida por Terceiros"
 // in the form (number, série and key of the supplier), saved only by the Salvar of the form.
 const editFile=async(row:DfeDocument)=>{
  if(download.current||listLoading||loading||!canImport||!importer||!row.access_key)return;const request=new AbortController();download.current=request;setDownloading(row.id);setDownloadError('');
  try{const value=await controller.dfeDistributionDownload(`${DFE_BASE}/documents/${row.id}/download`,request.signal);if(request.signal.aborted||download.current!==request)return;const blob=await verifyDfeBlob(value,row,request.signal);if(request.signal.aborted||download.current!==request)return;
   const xml=new TextDecoder('utf-8',{fatal:true}).decode(await blob.arrayBuffer());
   const found=keyLookupRecord(await importer.fiscalInvoices(`/v1/notas-fiscais/chave/${row.access_key}`,{signal:request.signal}),row.access_key).items.find(i=>i.origin==='brufap'&&i.direction==='0');
   if(request.signal.aborted||download.current!==request)return;
   if(found){guard.confirmLeave(()=>navigate(`/notas-entrada?origem=brufap&nota=${found.id}`));return;}
   const answer=await importer.fiscalInvoices('/v1/notas-fiscais/importar/previa',{method:'POST',body:{xml},signal:request.signal}) as {previewed?:boolean;refused?:string;field?:string;key?:string;invoice?:unknown};
   if(request.signal.aborted||download.current!==request)return;
   if(answer?.previewed===false&&typeof answer.refused==='string'){setDownloadError(importRefusalText({refused:answer.refused,field:answer.field}));return;}
   const input=normalizeInvoiceInput(answer?.invoice);
   if(answer?.previewed!==true||answer.key!==row.access_key||input.access_key!==row.access_key||input.issue_type!=='T'||input.direction!=='0')throw new AccessError(502);
   setEditingNote(input);
  }catch(e){if(!request.signal.aborted&&!aborted(e))setDownloadError(e instanceof AccessError&&e.status===403?'Seu perfil não inclui notas fiscais.':'Não foi possível conferir este arquivo para editar a nota.');}finally{if(download.current===request){download.current=null;if(!request.signal.aborted)setDownloading('');}}
 };
 const copyKey=async(key:string)=>{try{await globalThis.navigator?.clipboard?.writeText(key);setCopied(key);}catch{setDownloadError('Não foi possível copiar a chave de acesso.');}};
 const getFile=async(row:DfeDocument)=>{
  if(download.current||listLoading||loading)return;const request=new AbortController();download.current=request;setDownloading(row.id);setDownloadError('');
  try{const value=await controller.dfeDistributionDownload(`${DFE_BASE}/documents/${row.id}/download`,request.signal);if(request.signal.aborted||download.current!==request)return;const blob=await verifyDfeBlob(value,row,request.signal);if(request.signal.aborted||download.current!==request)return;
   const address=URL.createObjectURL(blob),link=document.createElement('a');try{link.href=address;link.download=dfeFilename(row);document.body.appendChild(link);link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(address),1000);}
  }catch(e){if(!request.signal.aborted&&!aborted(e))setDownloadError('Não foi possível conferir e baixar este arquivo. Tente novamente.');}finally{if(download.current===request){download.current=null;if(!request.signal.aborted)setDownloading('');}}
 };
 if(editingNote&&importer)return<FiscalInvoiceForm controller={importer} config={SCREENS.entrada} id={null} opening={{kind:'xml',input:editingNote}} today={spToday()}
  onBack={()=>setEditingNote(null)} onSaved={record=>{setEditingNote(null);navigate(`/notas-entrada?origem=brufap&nota=${record.id}`);}}/>;
 return<section className="received-dfe">
  <header className="real-heading"><div><h1>Notas Fiscais de Entrada</h1><p>Documentos de interesse da empresa, separados por ambiente e tipo.</p></div><span className="real-mode">Coleta desativada</span></header>
  <nav className="origin-list-tabs dfe-tabs" role="tablist" aria-label="Notas fiscais de entrada"><button type="button" role="tab" aria-selected={false} onClick={()=>guard.confirmLeave(()=>navigate('/notas-entrada'))}>Notas de compra</button><button type="button" role="tab" aria-selected={true}>Notas recebidas</button></nav>
  <p className="real-notice">A consulta à SEFAZ ainda não está ativada. Combine a coordenação com os outros sistemas e o contador antes de iniciar uma coleta. Salvar esta configuração não consulta a SEFAZ.</p>
  <div className="dfe-toolbar"><div className="form-field"><label htmlFor="received-environment">Ambiente *</label><select id="received-environment" value={environment} onChange={e=>{const next=e.target.value as ''|DfeEnvironment;guard.confirmLeave(()=>{setEditing(false);setEnvironment(next);});}}><option value="">Selecione o ambiente</option><option value="1">Produção</option><option value="2">Homologação</option></select></div>
   {environment&&!editing&&<button type="button" className="secondary-button" disabled={loading||Boolean(downloading)} onClick={()=>setReload(v=>v+1)}>Atualizar consulta</button>}
  </div>
  {!environment&&<p className="empty-state">Escolha o ambiente para consultar a configuração e os documentos preservados.</p>}
  {loading&&<p role="status">Consultando coordenação…</p>}{error&&<p className="real-alert" role="alert">{error} <button className="text-button" type="button" onClick={()=>setReload(v=>v+1)}>Tentar novamente</button></p>}
  {environment&&settingsReady&&!editing&&<>
   <section className="real-editor dfe-coordination" aria-label="Coordenação da coleta"><h2>Coordenação · {environmentLabel(environment)}</h2>{current?<><dl className="dfe-details"><div><dt>Responsável pela coordenação</dt><dd>{DFE_COORDINATORS[current.coordinator]}</dd></div><div><dt>Último NSU informado</dt><dd className="dfe-reference">{current.checkpoint??'Não informado'}{current.checkpoint!==null&&<small>{current.checkpoint_confirmed?'Conferência registrada':'Ainda não confirmado'}</small>}</dd></div><div><dt>Outros consumidores</dt><dd>{current.other_consumers_reviewed?'Conferência registrada':'Coordenação ainda não confirmada'}</dd></div><div><dt>Configuração</dt><dd>Versão {current.version}<small>{moment(current.updated_at)} · São Paulo</small></dd></div></dl>
    {current.company_changed&&<p className="real-alert">Os dados da empresa mudaram. Um administrador precisa reconferir esta configuração.</p>}{current.has_active_attempt&&<p className="real-notice">Há uma tentativa pendente de conferência. A coordenação não pode ser alterada agora.</p>}{current.paused&&<p className="real-notice">Canal pausado para revisão. Salvar a coordenação não autoriza nova consulta.</p>}{current.not_before&&<p className="real-help">Próxima consulta, quando houver liberação, não poderá ocorrer antes de {moment(current.not_before)} (São Paulo).</p>}
   </>:<p>Nenhuma coordenação foi registrada para este ambiente. A ausência de NSU não significa zero ou início do histórico.</p>}
   {canConfigure?<button className="primary-button" type="button" disabled={Boolean(current?.has_active_attempt)||Boolean(downloading)} onClick={()=>setEditing(true)}>{current?'Revisar coordenação':'Configurar coordenação'}</button>:<p className="real-help">Somente o administrador pode alterar a coordenação.</p>}
   </section>
   {current&&<section aria-label="Documentos preservados"><div className="dfe-toolbar"><div className="form-field"><label htmlFor="received-kind">Tipo de documento</label><select id="received-kind" value={kind} onChange={e=>{setKind(e.target.value as ''|DfeKind);setAfter(null);setHistory([]);}}><option value="">Todos os tipos</option>{Object.entries(DFE_KIND_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div></div>
    <p className="real-help">Resumo não é o XML completo da nota. A presença do arquivo não confirma assinatura, autorização ou validade fiscal. Nenhum documento desta lista lança estoque ou financeiro automaticamente.</p>
    {listLoading&&<p role="status">Consultando documentos…</p>}{listError&&<p className="real-alert" role="alert">{listError} <button type="button" className="text-button" onClick={()=>setReload(v=>v+1)}>Tentar novamente</button></p>}{downloadError&&<p role="alert" className="real-alert">{downloadError}</p>}
    {page&&<><div className="table-scroll" role="region" tabIndex={0} aria-label="NF-e e eventos recebidos"><table className="data-table dfe-table"><thead><tr><th>Documento</th><th>Chave de acesso</th><th>Número</th><th>Série</th><th>Data emissão</th><th className="numeric">Valor</th><th>Fornecedor</th><th>CNPJ/CPF</th><th>NSU</th><th>Coleta / conferência</th><th>Status</th><th>Arquivo</th></tr></thead><tbody>{page.items.map(row=><tr key={row.id}><td><strong>{DFE_KIND_LABELS[row.kind]}</strong></td><td className="dfe-reference">{row.access_key??'Não identificada'}{row.access_key&&<button type="button" className="text-button" onClick={()=>void copyKey(row.access_key!)}>{copied===row.access_key?'Chave copiada':'Copiar chave'}</button>}</td>
   {(parts=>parts?<><td>{parts.number}</td><td>{parts.series}</td></>:<><td>—</td><td>—</td></>)(keyParts(row.access_key))}
   {(s=>s?<><td>{s.issue_date?s.issue_date.split('-').reverse().join('/'):'—'}</td><td className="numeric">{s.total?`R$ ${s.total.replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.')}`:'—'}</td><td>{s.supplier_name??'—'}</td></>:<><td>{pending(row)}</td><td className="numeric">—</td><td>—</td></>)(summaryOf(row))}
   <td className="dfe-reference">{keyParts(row.access_key)?.issuer??'—'}</td>
   <td className="dfe-reference">{row.nsu??'Não informado'}</td><td>{moment(row.collected_at)}<small>São Paulo</small>{row.kind==='invoice'&&<small>{row.recipient_match===true?'Destinatário corresponde à empresa':row.recipient_match===false?'Destinatário divergente; conferir antes de usar':'Destinatário não conferido'}</small>}</td><td><span className={badgeClass(situation(row))}>{situation(row)}</span>{summaryOf(row)?.situation&&<small>NF-e {DFE_SUMMARY_SITUATIONS[summaryOf(row)!.situation!].toLowerCase()} no resumo</small>}</td><td><button className="text-button" type="button" disabled={Boolean(downloading)||listLoading} onClick={()=>void getFile(row)} aria-label={`Baixar ${DFE_KIND_LABELS[row.kind]} ${row.id}`}>{downloading===row.id?'Conferindo arquivo…':'Baixar arquivo'}</button><small>{row.size_bytes.toLocaleString('pt-BR')} bytes</small>
   {row.kind==='invoice'&&row.is_complete_invoice&&canImport&&<button className="text-button" type="button" disabled={Boolean(downloading)||listLoading||row.recipient_match===false} title={row.recipient_match===false?'O destinatário desta nota não é a empresa.':undefined} onClick={()=>void importFile(row)}>Importar NF-e para notas de compra</button>}
   {row.kind==='invoice'&&row.is_complete_invoice&&<button className="text-button" type="button" disabled={Boolean(downloading)||listLoading} onClick={()=>void previewFile(row)}>Pré-visualizar NF-e</button>}
   {row.kind==='invoice'&&row.is_complete_invoice&&canImport&&<button className="text-button" type="button" disabled={Boolean(downloading)||listLoading||row.recipient_match===false||!row.access_key} title={row.recipient_match===false?'O destinatário desta nota não é a empresa.':'Abre a nota de compra preenchida com o XML para conferir e salvar.'} onClick={()=>void editFile(row)}>Editar NF-e</button>}</td></tr>)}</tbody></table></div>
     {!page.items.length&&<div className="origin-empty"><span><Icon name="exclamation" size={22}/></span><h2>Nenhum documento preservado neste filtro</h2><p>A coleta continua desativada. Isso não significa ausência de notas na SEFAZ.</p></div>}
     <nav className="origin-pagination dfe-pagination" aria-label="Paginação"><button type="button" disabled={listLoading||!history.length} onClick={()=>{setAfter(null);setHistory([]);}}>Primeira</button><button type="button" disabled={listLoading||!history.length} onClick={()=>{setAfter(history.at(-1)??null);setHistory(v=>v.slice(0,-1));}}>Anterior</button><span className="dfe-page-current" aria-current="page"><span className="sr-only">Página </span>{history.length+1}</span><button type="button" disabled={listLoading||!page.has_more} onClick={()=>{setHistory(v=>[...v,after]);setAfter(page.next_cursor);}}>Próxima</button><span className="origin-range">{page.items.length} documento(s) nesta página</span></nav>
    </>}
   </section>}
  </>}
  {preview&&<FiscalDanfePrint title="Pré-visualizar NF-e" layout={preview.data.model==='65'?'nfce':'a4'} documents={[preview]} settings={DEFAULT_DANFE_SETTINGS} onClose={()=>setPreview(null)}/>}
  {importing&&importer&&<FiscalImportDialog controller={importer} initial={importing} onClose={()=>setImporting(null)} onOpen={(noteId,direction,reconcile)=>{setImporting(null);guard.confirmLeave(()=>navigate(`${direction==='1'?'/historico-fiscal?modelo=55&':'/notas-entrada?'}origem=brufap&nota=${noteId}${reconcile?'&secao=itens':''}`));}}/>}
  {editing&&environment&&canConfigure&&<CoordinationEditor key={environment} controller={controller} environment={environment} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);setReload(v=>v+1);}}/>}
 </section>;
}

function CoordinationEditor({controller,environment,onClose,onSaved}:{controller:ReceivedDfeController;environment:DfeEnvironment;onClose:()=>void;onSaved:()=>void}){
 const guard=useUnsavedChangesGuard();const [current,setCurrent]=useState<DfeChannel|null>(null),[company,setCompany]=useState<DfeCompany|null>(null),[form,setForm]=useState<DfeForm>(()=>dfeInitialForm(null)),[baseline,setBaseline]=useState(()=>JSON.stringify(dfeInitialForm(null)));
 const [loading,setLoading]=useState(true),[ready,setReady]=useState(false),[reload,setReload]=useState(0),[busy,setBusy]=useState(false),[unresolved,setUnresolved]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const pending=useRef<AbortController|null>(null),attempt=useRef<{body:DfeConfigBody;ack:boolean;uncertain:boolean}|null>(null);
 const read=async(signal:AbortSignal)=>{const [s,i]=await Promise.all([controller.dfeDistribution(`${DFE_BASE}/settings?environment=${environment}`,{signal}),controller.company('/v1/empresa/identidade',{signal})]);const c=dfeSettings(s,environment),identity=dfeCompany(i);if(c&&!c.company_changed&&c.identity_version!==identity?.version)throw new AccessError(502);return{current:c,company:identity};};
 useEffect(()=>{const request=new AbortController();setLoading(true);setReady(false);setError('');setConflict(false);void read(request.signal).then(value=>{if(request.signal.aborted)return;setCurrent(value.current);setCompany(value.company);const fields=dfeInitialForm(value.current);setForm(fields);setBaseline(JSON.stringify(fields));setReady(true);}).catch(e=>{if(!request.signal.aborted&&!aborted(e))setError(failure(e));}).finally(()=>{if(!request.signal.aborted)setLoading(false);});return()=>{request.abort();pending.current?.abort();};},[controller,environment,reload]);
 const dirty=JSON.stringify(form)!==baseline;useUnsavedChanges(dirty,busy||unresolved);
 const locked=!ready||loading||busy||unresolved||conflict;
 const edit=(patch:Partial<DfeForm>)=>{if(!pending.current&&!attempt.current&&ready&&!loading&&!conflict)setForm(v=>({...v,...patch}));};
 const recover=async()=>{
  if(pending.current||!attempt.current)return;const operation=attempt.current,request=new AbortController();pending.current=request;setBusy(true);setError('');
  try{
   if(!operation.ack){const response=await controller.dfeDistribution(`${DFE_BASE}/settings`,{method:'POST',body:operation.body,signal:request.signal});if(request.signal.aborted)return;dfeCommand(response,operation.body.command_id,operation.body);operation.ack=true;}
   const stored=dfeCommand(await controller.dfeDistribution(`${DFE_BASE}/commands/${operation.body.command_id}`,{signal:request.signal}),operation.body.command_id,operation.body);if(request.signal.aborted)return;
   const fresh=await read(request.signal);if(request.signal.aborted)return;
   if(!fresh.current||fresh.current.id!==stored.current.id||fresh.current.version<stored.current.version)throw new AccessError(502);
   attempt.current=null;setUnresolved(false);pending.current=null;setBusy(false);onSaved();
  }catch(e){if(!request.signal.aborted&&!aborted(e)){const definitive=!operation.ack&&!operation.uncertain&&e instanceof AccessError&&[400,403,404,409].includes(e.status);if(definitive){attempt.current=null;setUnresolved(false);setConflict(e.status===409);}else operation.uncertain=true;setError(operation.ack?'A configuração foi registrada. Consulte o resultado e os dados atuais para continuar; nenhum novo salvamento será enviado.':failure(e));}}
  finally{if(!request.signal.aborted&&pending.current===request){pending.current=null;setBusy(false);}}
 };
 const save=(event:FormEvent)=>{event.preventDefault();if(locked||pending.current||attempt.current||!company)return;try{attempt.current={body:dfeConfigBody(form,current,company,environment,crypto.randomUUID()),ack:false,uncertain:false};setUnresolved(true);void recover();}catch(e){setError((e as Error).message);}};
 const close=()=>{if(pending.current)return;guard.confirmLeave(onClose);};
 return<section className="real-editor dfe-config" aria-label="Configurar coordenação das NF-e recebidas"><header className="real-editor-heading"><div><h2>Coordenação · {environmentLabel(environment)}</h2><p>Registrar decisões e ponto de continuidade, mantendo a coleta desativada.</p></div><button className="secondary-button" type="button" disabled={busy} onClick={close}>{unresolved?'Sair e conferir depois':'Voltar aos documentos'}</button></header>
  {loading&&<p role="status">Consultando empresa e configuração atual…</p>}{error&&<p role="alert" className="real-alert">{error}</p>}
  {company&&<p className="real-help">Empresa: {company.legal_name} · CNPJ {company.cnpj} · identidade versão {company.version}.</p>}
  {!loading&&!company&&<p className="real-notice">Cadastre a identidade da empresa em Dados da empresa antes de continuar.</p>}
  {unresolved&&<section className="real-notice" aria-label="Resultado pendente"><p>Os campos e o comando desta decisão estão preservados. Sair não desfaz uma gravação que já tenha ocorrido.</p><button className="primary-button" type="button" disabled={busy} onClick={()=>void recover()}>{attempt.current?.ack?'Consultar resultado e dados atuais':'Conferir a mesma operação'}</button></section>}
  <form onSubmit={save} aria-busy={busy}><fieldset disabled={locked||!company||Boolean(current?.has_active_attempt)}><legend>Decisão de coordenação</legend><div className="dfe-config-grid">
   <div className="form-field"><label htmlFor="dfe-coordinator">Quem coordena as consultas? *</label><select id="dfe-coordinator" value={form.coordinator} onChange={e=>edit({coordinator:e.target.value as DfeForm['coordinator'],other_consumers_reviewed:false})}>{Object.entries(DFE_COORDINATORS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><small>Se outro sistema ou o contador consulta a SEFAZ, combine quem continuará e de qual ponto.</small></div>
   <div className="form-field"><label htmlFor="dfe-checkpoint">Último NSU conferido</label><input id="dfe-checkpoint" value={form.checkpoint} type="text" inputMode="numeric" maxLength={15} autoComplete="off" onChange={e=>edit({checkpoint:e.target.value,checkpoint_confirmed:false})} aria-describedby="dfe-checkpoint-help"/><small id="dfe-checkpoint-help">São 15 dígitos, inclusive zeros à esquerda. Deixe em branco se desconhecido; não informe zero por suposição. Um histórico iniciado não permite reescrever esse ponto.</small></div>
  </div><label className="dfe-check"><input type="checkbox" checked={form.checkpoint_confirmed} onChange={e=>edit({checkpoint_confirmed:e.target.checked})}/>Conferi o último NSU e a origem desse ponto de continuidade.</label><label className="dfe-check"><input type="checkbox" checked={form.other_consumers_reviewed} onChange={e=>edit({other_consumers_reviewed:e.target.checked})}/>Conferi a coordenação com os outros sistemas e o contador.</label>
   <div className="form-field"><label htmlFor="dfe-reason">Motivo ou referência da conferência *</label><input id="dfe-reason" required minLength={3} maxLength={240} autoComplete="off" value={form.reason} onChange={e=>edit({reason:e.target.value})}/><small>Registre o que foi combinado. Não inclua senhas ou certificados.</small></div>
   <p className="real-notice">A coleta permanecerá desativada, inclusive se você escolher o FAGOO como futuro coordenador. Nenhuma consulta ou manifestação será enviada à SEFAZ.</p><button className="primary-button" type="submit">Salvar coordenação com coleta desativada</button>
  </fieldset></form>
  {!unresolved&&<button className="text-button" type="button" disabled={loading||busy} onClick={()=>{if(!pending.current&&!attempt.current)guard.confirmLeave(()=>setReload(v=>v+1));}}>Descartar alterações e recarregar</button>}
 </section>;
}
