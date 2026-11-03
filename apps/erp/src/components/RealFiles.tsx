import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Link} from 'react-router-dom';
import {AccessError,type AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {filesPath} from '../lib/activity-request';
import {parseFiles,captureFilesQuery,ORDER_TEXT,todaySP,moment,fileSize,type SystemLogController,type FilesPage,type FilesQuery,type FileEntry,type FileOrder} from '../lib/activity-model';
import {ORIGIN_TEXT,THUMBNAILS_PER_PAGE,deletedFile,fileDigest,fileRoute,sourceText,thumbnailUrl,thumbnailable,type FileOrigin} from '../lib/file-manager-model';
// Mixed lane (wave G, 301): Inserir Arquivo, a file of the company without a document.
import {COMPANY_FILES_PATH,companyFileType,readCompanyFile,type CompanyFileMime} from '../lib/file-manager-model';
import {AppliedChips,OriginActionsPanel,OriginFilterPanel,OriginListHeader,OriginToolbar} from './OriginList';
import {Modal} from './Modal';
import {Icon} from './Icon';
// Documentos lane (wave F): "Fazer download" of the selected files as one ZIP, as in Origin.
import {storedZip,ZIP_MAX_BYTES,ZIP_MAX_FILES} from '../lib/zip-store';
import './real-activity.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const admin=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
/** A refusal that repeating the same command cannot change (the deletion is then no longer pending). */
const definitive=(e:unknown)=>e instanceof AccessError&&[400,403,404,409].includes(e.status);
/** Deletions kept with their commands until confirmed ("Conferir resultado" repeats exactly the same commands). */
type Deletion={files:FileEntry[];commands:Record<string,string>};
type Draft={order:FileOrder;from:string;to:string;origin:FileOrigin|''};
/** One Inserir Arquivo kept with its command until the result is confirmed ("Conferir resultado" repeats exactly the same operation). */
type Insert={file:File;mime:CompanyFileMime;sha:string;commandId:string;id?:string};
/** A refusal of the upload that repeating the same command cannot change. A 409 of the upload itself is not one: another request may
 * still hold the upload of the same reservation, so the attempt stays for "Conferir resultado" or "Descartar o envio". */
const insertDefinitive=(e:unknown,stage:'reserve'|'upload')=>e instanceof AccessError&&[400,403,404,409,413,415].includes(e.status)&&!(stage==='upload'&&e.status===409);
const insertMessage=(e:unknown)=>e instanceof AccessError?e.status===415?'O conteúdo do arquivo não corresponde ao tipo informado (PDF, PNG, JPEG, XML ou TXT).'
 :e.status===400?'Confira o nome, o tipo e o tamanho do arquivo (PDF, PNG, JPEG, XML ou TXT de até 10 MB).':e.status===403?'Somente administradores inserem arquivos.'
 :e.code==='ERP_ATTACHMENT_QUOTA'?'O limite de 5.000 envios de arquivos da empresa foi atingido (os envios descartados e os arquivos excluídos também contam).'
 :e.status===409?'O arquivo já foi incluído, está em envio por outra operação ou o envio foi descartado. Confira a lista de arquivos antes de repetir.':'Não foi possível confirmar o envio do arquivo. Confira o resultado antes de repetir.'
 :'Não foi possível confirmar o envio do arquivo. Confira o resultado antes de repetir.';

/**
 * Sistema > Gerenciador de arquivos (Origin anexos.gerenciador.php), administrador only: every private file of the company (anexos
 * dos documentos, anexos e foto dos contatos, anexos das contas e dos lançamentos de caixa, imagens dos produtos e o logo), with
 * Miniatura of the images, Baixar arquivo, Fazer download of the selected ones and Excluir anexo (the audited logical deletion of
 * the module that owns the file).
 */
export default function RealFiles({controller}:{controller:SystemLogController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null);
 const allowed=admin(snapshot)&&snapshot.membership?.user_id===actor.current;
 const alive=useRef(true),request=useRef<AbortController|null>(null),work=useRef<AbortController|null>(null),thumbs=useRef<AbortController|null>(null);
 const [query,setQuery]=useState<FilesQuery>(()=>captureFilesQuery({})),[search,setSearch]=useState(''),[filterOpen,setFilterOpen]=useState(false),[draft,setDraft]=useState<Draft>({order:'data',from:'',to:'',origin:''});
 const [page,setPage]=useState<FilesPage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(''),[panel,setPanel]=useState(false),[reload,setReload]=useState(0);
 const [selected,setSelected]=useState<Set<string>>(new Set()),[confirm,setConfirm]=useState<FileEntry[]|null>(null),[deletion,setDeletion]=useState<Deletion|null>(null),[images,setImages]=useState<Record<string,string>>({});
 const [insert,setInsert]=useState<Insert|null>(null),picker=useRef<HTMLInputElement>(null);
 useUnsavedChanges(Boolean(deletion)||Boolean(insert),Boolean(busy));
 const may=()=>{const s=controller.getSnapshot();return alive.current&&admin(s)&&s.membership?.user_id===actor.current;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();work.current?.abort();thumbs.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();work.current?.abort();thumbs.current?.abort();request.current=null;setLoading(false);setPage(null);setBusy('');setImages({});},[allowed]);
 useEffect(()=>{if(!allowed||!may())return;const p=new AbortController();request.current=p;setLoading(true);setError('');void(async()=>{try{
  const raw=await controller.systemLog(filesPath(query),{method:'GET',signal:p.signal});if(!may()||p.signal.aborted||request.current!==p)return;
  const next=parseFiles(raw,query);setPage(next);setSelected(current=>new Set([...current].filter(id=>next.items.some(f=>f.id===id))));
 }catch(e){if(may()&&!p.signal.aborted&&request.current===p&&!aborted(e))setError(e instanceof AccessError&&e.status===403?'Somente administradores consultam os arquivos.':'Não foi possível carregar os arquivos. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,query,reload,allowed]);
 // Bytes of one file through the route of its module, checked by size and SHA-256.
 const verified=async(f:FileEntry,signal:AbortSignal)=>{if(!controller.attachments)throw new AccessError(503);
  const blob=await controller.attachments(fileRoute(f,'download'),{download:true,signal}) as Blob;
  if(!(blob instanceof Blob)||blob.size!==f.size_bytes||await fileDigest(blob)!==f.sha256)throw new AccessError(502);return blob;};
 // Miniatura: the images of the page (PNG/JPEG up to 2 MB), one at a time; a page or user change discards what was still loading.
 useEffect(()=>{thumbs.current?.abort();setImages({});if(!page||!allowed||!controller.attachments)return;const p=new AbortController();thumbs.current=p;
  void(async()=>{for(const f of page.items.filter(thumbnailable).slice(0,THUMBNAILS_PER_PAGE)){if(p.signal.aborted||!may())return;
   try{const url=await thumbnailUrl(await verified(f,p.signal),f.mime_type);if(!p.signal.aborted&&may())setImages(current=>({...current,[f.id]:url}));}catch{/* The row keeps its icon. */}}})();
  return()=>p.abort();},[page,allowed]);
 const act=async(label:string,run:(signal:AbortSignal)=>Promise<void>,describe?:(e:unknown)=>string)=>{if(work.current||!may())return;const p=new AbortController();work.current=p;setBusy(label);setError('');setNotice('');
  try{await run(p.signal);if(!may())throw new AccessError(403);}catch(e){if(!p.signal.aborted&&!aborted(e)&&alive.current)setError(describe?describe(e):e instanceof AccessError&&e.status===502?'O conteúdo recebido não confere com o registrado. Tente novamente.':e instanceof AccessError&&e.status===403?'Somente administradores alteram os arquivos.':'Não foi possível concluir. Confira o resultado antes de repetir.');}
  finally{if(work.current===p){work.current=null;if(alive.current)setBusy('');}}};
 const save=(filename:string,blob:Blob)=>{const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.rel='noopener';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 // One file is saved as it is; several are checked one by one and saved as a single ZIP (up to 100 files and 100 MB).
 const download=(list:FileEntry[])=>{
  if(list.length>ZIP_MAX_FILES||list.reduce((sum,f)=>sum+f.size_bytes,0)>ZIP_MAX_BYTES){setNotice('');setError(`Selecione até ${ZIP_MAX_FILES} arquivos e até 100 MB para baixar de uma vez.`);return;}
  void act(list.length===1?`Baixando ${list[0]!.filename}…`:`Baixando ${list.length} arquivos…`,async signal=>{
   if(list.length===1){const blob=await verified(list[0]!,signal);if(signal.aborted||!may())return;save(list[0]!.filename,blob);setNotice('Download preparado.');return;}
   const entries=[];for(const f of list){const blob=await verified(f,signal);if(signal.aborted||!may())return;entries.push({name:f.filename,data:new Uint8Array(await blob.arrayBuffer()),modified:new Date(f.created_at)});}
   if(signal.aborted||!may())return;const zip=storedZip(entries);save(`arquivos-${todaySP()}.zip`,new Blob([zip as Uint8Array<ArrayBuffer>],{type:'application/zip'}));setNotice(`${list.length} arquivos baixados em um ZIP.`);});};
 // Excluir anexo: the audited logical deletion of the module that owns the file, one command per file kept until confirmed.
 const remove=(current:Deletion)=>act(`Excluindo ${current.files.length} arquivo(s)…`,async signal=>{
  for(const f of[...current.files]){
   try{const value=await controller.attachments!(fileRoute(f,'exclusao'),{method:'POST',body:{command_id:current.commands[f.id]},signal});if(!deletedFile(value,f.id))throw new AccessError(502);}
   catch(e){if(definitive(e)){setDeletion(null);setSelected(new Set());setReload(v=>v+1);}throw e;}
   current.files=current.files.filter(x=>x.id!==f.id);
  }
  setDeletion(null);setSelected(new Set());setReload(v=>v+1);setNotice('Arquivos excluídos. A exclusão fica registrada no Registro de atividades.');});
 // Inserir Arquivo (301): reserve by command, send the bytes (checked by size, SHA-256 and content), keep the attempt until confirmed.
 const clearPicker=()=>{if(picker.current)picker.current.value='';};
 const send=(attempt:Insert)=>act(`Enviando ${attempt.file.name}…`,async signal=>{
  const sent={mime:attempt.mime,size:attempt.file.size,sha:attempt.sha};let stage:'reserve'|'upload'='reserve';
  try{
   let status:'reserved'|'ready'|'aborted'='reserved';
   if(!attempt.id){const row=readCompanyFile(await controller.attachments!(COMPANY_FILES_PATH,{method:'POST',signal,body:{command_id:attempt.commandId,filename:attempt.file.name,mime_type:attempt.mime,size_bytes:attempt.file.size,sha256:attempt.sha}}),sent);
    if(row.status==='aborted')throw new AccessError(409);attempt.id=row.id;status=row.status;}
   stage='upload';
   if(status!=='ready'){const row=readCompanyFile(await controller.attachments!(`${COMPANY_FILES_PATH}/${attempt.id}/upload`,{method:'PUT',body:attempt.file,contentType:attempt.mime,signal}),sent);
    if(row.status!=='ready'||row.id!==attempt.id)throw new AccessError(502);}
  }catch(e){if(insertDefinitive(e,stage)){setInsert(null);clearPicker();}throw e;}
  if(signal.aborted)return;
  setInsert(null);clearPicker();setReload(v=>v+1);setNotice(`Arquivo ${attempt.file.name} incluído. Ele aparece na origem Empresa e fica registrado no Registro de atividades.`);
 },insertMessage);
 const choose=async(file:File|null)=>{if(!file||work.current||insert||deletion||!may()||!controller.attachments)return;
  let mime:CompanyFileMime;try{mime=companyFileType(file);}catch(e){setNotice('');setError((e as Error).message);clearPicker();return;}
  const attempt:Insert={file,mime,sha:await fileDigest(file),commandId:crypto.randomUUID()};if(!may())return;setInsert(attempt);void send(attempt);};
 // A refused discard (the file was already included, is being sent by another request or no longer exists) ends the pending attempt:
 // there is nothing left to discard, and the list shows what was kept.
 const discard=(attempt:Insert)=>act('Descartando o envio…',async signal=>{
  try{if(attempt.id)await controller.attachments!(`${COMPANY_FILES_PATH}/${attempt.id}/abort`,{method:'POST',body:{},signal});}
  catch(e){if(!(e instanceof AccessError&&[400,404,409].includes(e.status)))throw e;
   setInsert(null);clearPicker();setReload(v=>v+1);
   setNotice(e.status===409?'O envio não foi descartado: o arquivo já foi incluído ou está em envio por outra operação. Confira a lista de arquivos.':'O envio pendente não existe mais. Confira a lista de arquivos.');return;}
  setInsert(null);clearPicker();setNotice('Envio descartado. Nenhum arquivo foi incluído.');},
  e=>e instanceof AccessError&&e.status===403?'Somente administradores inserem arquivos.':'Não foi possível descartar o envio. Tente novamente.');
 if(!allowed)return <section className="real-state-panel"><h1>Gerenciador de arquivos não liberado</h1><p>Somente administradores consultam os arquivos da empresa.</p></section>;
 const items=page?.items??[],chosen=items.filter(f=>selected.has(f.id)),locked=Boolean(busy)||Boolean(deletion)||Boolean(insert)||!controller.attachments;
 const chips=[...(query.q?[{label:`Pesquisa: ${query.q}`,onRemove:()=>{setSearch('');setQuery(q=>({...q,q:null,offset:0}));}}]:[]),
  ...(query.order!=='data'?[{label:`Ordenação: ${ORDER_TEXT[query.order]}`,onRemove:()=>{setDraft(d=>({...d,order:'data'}));setQuery(q=>({...q,order:'data',offset:0}));}}]:[]),
  ...(query.origin?[{label:`Origem: ${ORIGIN_TEXT[query.origin]}`,onRemove:()=>{setDraft(d=>({...d,origin:''}));setQuery(q=>({...q,origin:null,offset:0}));}}]:[]),
  ...(query.from?[{label:`Período: ${query.from.split('-').reverse().join('/')} a ${query.to!.split('-').reverse().join('/')}`,onRemove:()=>{setDraft(d=>({...d,from:'',to:''}));setQuery(q=>({...q,from:null,to:null,offset:0}));}}]:[])];
 // Captured in the handler, so an out-of-contract search (over 120 characters) is a message, never a render error.
 const find=()=>{try{setQuery(captureFilesQuery({q:search||null,order:query.order,from:query.from,to:query.to,origin:query.origin}));setError('');}catch{setError('A pesquisa aceita até 120 caracteres.');}};
 const apply=()=>{try{setQuery(captureFilesQuery({q:query.q,order:draft.order,from:draft.from||null,to:draft.to||null,origin:draft.origin||null}));setFilterOpen(false);setError('');}catch{setError('Informe as duas datas do período (até 366 dias).');}};
 const toggle=(id:string,on:boolean)=>setSelected(current=>{const next=new Set(current);if(on)next.add(id);else next.delete(id);return next;});
 const ask=(list:FileEntry[])=>{if(locked||!list.length)return;setConfirm(list);};
 return <div className="real-files">
  <OriginListHeader title="Gerenciador de arquivos"/>
  <div className={`origin-list-workspace${panel?' actions-collapsed':''}`}><div>
   <OriginToolbar filterOpen={filterOpen} onToggleFilter={()=>setFilterOpen(!filterOpen)} searchValue={search} searchPlaceholder="Pesquisa por nome de arquivo" onSearchChange={setSearch} onSearch={find}
    tools={<button type="button" className="origin-tool-square" title="Excluir os anexos selecionados" aria-label="Excluir os anexos selecionados" disabled={locked||!chosen.length} onClick={()=>ask(chosen)}><Icon name="trash-can" size={14}/></button>}/>
   <OriginFilterPanel open={filterOpen} onClose={()=>setFilterOpen(false)} onApply={apply}>
    <label className="form-field">Ordenação<select id="files-order" value={draft.order} onChange={e=>setDraft({...draft,order:e.target.value as FileOrder})}>{(Object.keys(ORDER_TEXT) as FileOrder[]).map(o=><option key={o} value={o}>{ORDER_TEXT[o]}</option>)}</select></label>
    <label className="form-field">Origem<select id="files-origin" value={draft.origin} onChange={e=>setDraft({...draft,origin:e.target.value as FileOrigin|''})}><option value="">Todas</option>{(Object.keys(ORIGIN_TEXT) as FileOrigin[]).map(o=><option key={o} value={o}>{ORIGIN_TEXT[o]}</option>)}</select></label>
    <label className="form-field">Início<input type="date" id="files-from" value={draft.from} max={todaySP()} onChange={e=>setDraft({...draft,from:e.target.value})}/></label>
    <label className="form-field">Fim<input type="date" id="files-to" value={draft.to} max={todaySP()} onChange={e=>setDraft({...draft,to:e.target.value})}/></label>
   </OriginFilterPanel>
   <AppliedChips chips={chips} onClear={()=>{setSearch('');setDraft({order:'data',from:'',to:'',origin:''});setQuery(captureFilesQuery({}));}}/>
   {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
   {loading&&<p role="status" className="real-help">Carregando arquivos…</p>}{busy&&<p role="status" className="real-help">{busy}</p>}
   <input ref={picker} id="files-insert-input" className="sr-only" type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.txt" aria-label="Arquivo a inserir" disabled={locked} onChange={e=>void choose(e.target.files?.[0]??null)}/>
   {insert&&<section className="real-notice" aria-label="Envio pendente"><p>O envio de {insert.file.name} precisa ser confirmado. O arquivo e a operação ficam preservados; sair da tela não desfaz um envio já registrado.</p>
    <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={()=>void send(insert)}>Conferir resultado</button>
    <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={()=>void discard(insert)}>Descartar o envio</button></section>}
   {deletion&&<section className="real-notice" aria-label="Exclusão pendente"><p>A exclusão de {deletion.files.length} arquivo(s) precisa ser confirmada. Os comandos ficam preservados.</p>
    <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={()=>void remove(deletion)}>Conferir resultado</button></section>}
   <div className="table-scroll" role="region" aria-label="Arquivos" tabIndex={0}><table className="data-table"><thead><tr><th scope="col"><span className="sr-only">Selecionar</span></th><th scope="col">Nome</th><th scope="col">Privado</th><th scope="col">Dono</th><th scope="col">Tamanho</th><th scope="col">Data</th><th scope="col">Origem</th><th scope="col">Miniatura</th><th scope="col">Ações</th></tr></thead>
    <tbody>{items.map(f=>{const source=sourceText(f);return <tr key={f.id}>
     <td><input type="checkbox" aria-label={`Selecionar ${f.filename}`} checked={selected.has(f.id)} disabled={locked} onChange={e=>toggle(f.id,e.target.checked)}/></td>
     <td><button type="button" className="text-button" disabled={locked} onClick={()=>void download([f])}>{f.filename}</button></td>
     <td><span className="real-files-lock" title="Arquivo privado: só usuários com acesso ao módulo de origem baixam"><Icon name="key" size={12}/><span className="sr-only">Privado</span></span></td><td>{f.owner.label}</td>
     <td>{fileSize(f.size_bytes)}</td><td>{moment(f.created_at)}</td><td>{source.to?<Link to={source.to}>{source.text}</Link>:source.text}</td>
     <td>{images[f.id]?<img className="real-files-thumb" src={images[f.id]} alt={`Miniatura de ${f.filename}`}/>:<span className="real-help" title={thumbnailable(f)?'Carregando a miniatura…':'Miniatura só para imagens PNG ou JPEG de até 2 MB.'}>—</span>}</td>
     <td><button type="button" className="text-button" disabled={locked} onClick={()=>void download([f])}>{busy===`Baixando ${f.filename}…`?'Baixando…':'Baixar arquivo'}</button>
      <button type="button" className="text-button" disabled={locked} onClick={()=>ask([f])}>Excluir anexo</button></td></tr>;})}</tbody></table></div>
   {page&&!items.length&&<div className="empty-state"><h2>Nenhum arquivo encontrado</h2><p>Os anexos dos documentos, dos contatos e das contas, as imagens dos produtos, o logo e os arquivos da empresa (Inserir Arquivo) aparecem aqui.</p></div>}
   {page&&<p className="real-help">{page.total.toLocaleString('pt-BR')} arquivo(s).{page.offset>0&&<button type="button" className="text-button" onClick={()=>setQuery(q=>({...q,offset:Math.max(0,q.offset-q.limit)}))}>Página anterior</button>}{page.has_more&&<button type="button" className="text-button" onClick={()=>setQuery(q=>({...q,offset:q.offset+q.limit}))}>Próxima página</button>}</p>}
  </div>
  <OriginActionsPanel collapsed={panel} onCollapse={()=>setPanel(!panel)} actions={[{label:'Inserir Arquivo',icon:'upload',disabled:locked,disabledReason:insert?'Confirme ou descarte o envio pendente.':'Aguarde a operação em andamento.',onClick:()=>picker.current?.click()},
   {label:'Tornar público selecionados',icon:'eye',disabled:true,disabledReason:'Os arquivos do FAGOO são sempre privados: só usuários com acesso ao módulo de origem os baixam.'},
   {label:'Tornar privado selecionados',icon:'eye-slash',disabled:true,disabledReason:'Todos os arquivos já são privados.'},
   {label:'Fazer download',icon:'download',disabled:locked||!chosen.length,disabledReason:'Selecione os arquivos para baixar.',onClick:()=>void download(chosen)}]}
   info={[{label:'Quantidade de arquivos',value:String(page?.total??0)},{label:'Espaço usado',value:fileSize(page?.total_bytes??'0')}]}/>
  </div>
  {confirm&&<Modal title="Excluir anexos" onClose={()=>setConfirm(null)} actions={<><button type="button" className="secondary-button" onClick={()=>setConfirm(null)}>Cancelar</button>
   <button type="button" className="primary-button" onClick={()=>{const list=confirm;setConfirm(null);const current:Deletion={files:[...list],commands:Object.fromEntries(list.map(f=>[f.id,crypto.randomUUID()]))};setDeletion(current);void remove(current);}}>Excluir</button></>}>
   <p>Excluir {confirm.length===1?`o arquivo ${confirm[0]!.filename}`:`${confirm.length} arquivos`}? O arquivo deixa de aparecer no documento, contato, conta ou produto de origem; a exclusão fica registrada e o conteúdo continua guardado no armazenamento privado.</p></Modal>}
 </div>;
}
