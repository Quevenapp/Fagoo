import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {Link} from 'react-router-dom';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {SCREEN_TEMPLATES,readSpreadsheet,SheetReadError,autoMapping,batches,batchPath,reasonText,STATUS_TEXT,ACTION_TEXT,IMPORT_JOBS_SCREEN,importScreen,parseImportBatchResult,plural,
 IMPORT_FILE_ROWS,type ImportKind,type ImportItem,type ImportResult,type ImportJob} from '../lib/spreadsheet-import';
import {CSV_TYPE,XLSX_TYPE,downloadFile} from '../lib/spreadsheet-export';
import type {ContactTypeItem} from '../lib/contact-list-model';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {Icon} from './Icon';
import './spreadsheet-import.css';

export interface ImportController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
 catalog?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
type Step='file'|'mapping'|'checked'|'done';
type Batch={id:string;items:ImportItem[];uncertain:boolean};
const STEPS=['Procurar arquivo','Relacionar colunas','Validar','Conferir registros','Importar'];
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const admin=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
// An answer that did not arrive (timeout, network, 5xx or "unconfirmed") may have been recorded: only the same command can tell.
const uncertain=(e:unknown)=>!(e instanceof AccessError)||[0,408,500,502,503,504].includes(e.status);
const refusal=(e:unknown)=>e instanceof AccessError&&e.status===403?'Somente administradores importam planilhas.'
 :e instanceof AccessError&&e.status===409?'Esta importação mudou ou já foi concluída. Valide a planilha de novo.':'O servidor recusou o lote; nada dele foi gravado. Confira a planilha e valide de novo.';

/**
 * Importações de Dados (Origin "Planilhas modelo"): Procurar arquivo → Relacionar colunas → Validar → Conferir registros → Importar.
 * The file is read in this browser; Validar runs every row through the server rules without writing; Importar sends batches with
 * one command each, so an uncertain answer offers "Conferir resultado" (the same batch again, never a second import of a row).
 */
export default function SpreadsheetImport({controller,kind}:{controller:ImportController;kind:ImportKind}){
 const template=SCREEN_TEMPLATES[kind];
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null);
 const allowed=admin(snapshot)&&snapshot.membership?.user_id===actor.current;
 const [file,setFile]=useState<{name:string;cells:string[][]}|null>(null),[mapping,setMapping]=useState<Record<string,string>>({}),[step,setStep]=useState<Step>('file');
 const [results,setResults]=useState<Map<number,ImportResult>>(new Map()),[job,setJob]=useState<ImportJob|null>(null),[pending,setPending]=useState<Batch|null>(null);
 const [busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState(''),[types,setTypes]=useState<ContactTypeItem[]>([]);
 const request=useRef<AbortController|null>(null),remaining=useRef<Batch[]>([]),alive=useRef(true),generation=useRef(0),jobRef=useRef<{id:string;total:number}|null>(null);
 const guard=useUnsavedChanges(Boolean(file)&&step!=='done',busy||Boolean(pending?.uncertain));
 const may=(gen:number)=>{const s=controller.getSnapshot();return alive.current&&gen===generation.current&&admin(s)&&s.membership?.user_id===actor.current;};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[controller]);
 // A change of user or of role drops the pending answers; the screen hides itself for a non-administrador.
 useEffect(()=>{if(allowed)return;request.current?.abort();request.current=null;setBusy(false);setProgress('');},[allowed]);
 useEffect(()=>{if(kind!=='contacts'||!controller.catalog)return;const p=new AbortController();
  void controller.catalog('/v1/cadastros/tipos-contato',{signal:p.signal}).then(v=>{const items=(v as {items?:ContactTypeItem[]}).items;if(!p.signal.aborted&&Array.isArray(items))setTypes(items);}).catch(()=>undefined);
  return()=>p.abort();},[controller,kind]);
 const parsed=useMemo(()=>file?template.parse(file.cells,mapping,{types}):null,[file,mapping,types,template]);
 const reset=()=>{generation.current++;request.current?.abort();request.current=null;setResults(new Map());setJob(null);setPending(null);remaining.current=[];jobRef.current=null;setError('');setProgress('');setBusy(false);};
 const read=async(selected:File)=>{
  reset();setFile(null);setStep('file');const gen=generation.current;
  try{
   const cells=await readSpreadsheet(selected.name,new Uint8Array(await selected.arrayBuffer()));
   if(!may(gen))return;
   if(cells.length<2){setError('A planilha não tem linhas para importar: a primeira linha deve ter os títulos das colunas.');return;}
   if(cells.length-1>IMPORT_FILE_ROWS){setError(`Limite de ${IMPORT_FILE_ROWS.toLocaleString('pt-BR')} linhas por planilha.`);return;}
   setFile({name:selected.name.slice(0,200).trim()||'planilha',cells});setMapping(autoMapping(template,cells[0]!));setStep('mapping');
  }catch(e){if(may(gen))setError(e instanceof SheetReadError?e.message:'Não foi possível ler a planilha. Confira se o arquivo é um .XLSX, .XLS ou .CSV válido.');}
 };
 const choose=(selected:File|undefined)=>{if(selected)void guard.confirmLeave(()=>void read(selected));};
 const relate=(label:string,header:string)=>{reset();setMapping(previous=>({...previous,[label]:header}));setStep('mapping');};
 const send=async(body:Record<string,unknown>,signal:AbortSignal,items:ImportItem[],dry:boolean)=>{
  const raw=await controller.system(batchPath(kind),{method:'POST',body,signal});
  return parseImportBatchResult(raw,{kind,dry_run:dry,job_id:body.job_id as string|null,file_name:body.file_name as string,total_rows:body.total_rows as number,items});
 };
 const payload=(items:ImportItem[])=>items.map(({row,lines,data})=>({row,lines,data}));
 const validate=async()=>{
  if(!parsed||!file||busy||!allowed)return;
  const gen=generation.current,current=new AbortController();request.current=current;setBusy(true);setError('');
  const found=new Map<number,ImportResult>(),ready=parsed.items.filter(i=>!i.problems.length),list=batches(ready);
  try{
   for(let i=0;i<list.length;i++){
    setProgress(`Validando: lote ${i+1} de ${list.length}`);
    const out=await send({command_id:null,job_id:null,file_name:file.name,total_rows:Math.max(1,ready.length),dry_run:true,items:payload(list[i]!)},current.signal,list[i]!,true);
    if(!may(gen)||current.signal.aborted)return;
    for(const r of out.items)found.set(r.row,r);
   }
   setResults(found);setStep('checked');
  }catch(e){if(may(gen)&&!aborted(e))setError('Não foi possível validar a planilha agora. Tente de novo.');}
  finally{if(request.current===current){request.current=null;setBusy(false);setProgress('');}}
 };
 const run=async(list:Batch[])=>{
  const gen=generation.current,current=new AbortController(),target=jobRef.current;if(!target||!file)return;
  request.current=current;setBusy(true);setError('');
  // The same file and screen (only the user's role changed, or the request was cut): the batch may have been recorded, so it
  // stays as "Conferir resultado" with the same command for when the administrador is back, never as a new import of its rows.
  const sameFile=()=>alive.current&&gen===generation.current;
  const unconfirmed=(batch:Batch,i:number)=>{setPending({...batch,uncertain:true});remaining.current=list.slice(i+1);
   setError('Não foi possível confirmar a importação deste lote. Use “Conferir resultado” para enviar o mesmo lote de novo, sem duplicar registros.');};
  try{
   for(let i=0;i<list.length;i++){
    const batch=list[i]!;setPending(batch);setProgress(`Importando lote ${i+1} de ${list.length}`);
    let out;
    try{out=await send({command_id:batch.id,job_id:target.id,file_name:file.name,total_rows:target.total,dry_run:false,items:payload(batch.items)},current.signal,batch.items,false);}
    catch(e){
     if(!sameFile())return;
     if(!may(gen)||current.signal.aborted){unconfirmed(batch,i);return;}
     if(!batch.uncertain&&!uncertain(e)){setPending(null);remaining.current=[];setError(`Lote ${i+1}: ${refusal(e)}`);setStep('checked');return;}
     unconfirmed(batch,i);return;
    }
    if(!sameFile())return;
    if(!may(gen)){unconfirmed(batch,i);return;}
    setResults(previous=>{const next=new Map(previous);for(const r of out.items)next.set(r.row,r);return next;});setJob(out.job);
   }
   setPending(null);remaining.current=[];setStep('done');
  }finally{if(request.current===current){request.current=null;setBusy(false);setProgress('');}}
 };
 const importValid=()=>{
  if(!parsed||busy||step!=='checked'||!allowed||pending)return;
  const valid=parsed.items.filter(i=>results.get(i.row)?.status==='valid');if(!valid.length)return;
  jobRef.current={id:crypto.randomUUID(),total:valid.length};
  void run(batches(valid).map(items=>({id:crypto.randomUUID(),items,uncertain:false})));
 };
 if(!allowed)return <section className="real-state-panel"><h1>{template.title}</h1><p>Importar planilhas é uma ferramenta do administrador da empresa.</p></section>;
 const items=parsed?.items??[],missing=parsed?.missing??[],header=file?.cells[0]??[];
 const valid=items.filter(i=>results.get(i.row)?.status==='valid').length,problems=items.filter(i=>i.problems.length||results.get(i.row)?.status==='invalid').length;
 const current=step==='file'?0:step==='mapping'?1:step==='checked'?3:4;
 const status=(item:ImportItem)=>{const r=results.get(item.row);
  if(item.problems.length)return{bad:true,text:item.problems.join('; ')};
  if(!r)return{bad:false,text:step==='mapping'?'Aguardando validação':'—'};
  if(r.status==='invalid')return{bad:true,text:reasonText(kind,r)};
  return{bad:false,text:r.status==='valid'?`${STATUS_TEXT.valid} · ${ACTION_TEXT[r.action!]}`:`${STATUS_TEXT[r.status]}${r.reference?` · ${r.reference}`:''}`};};
 const download=(format:'xlsx'|'csv')=>downloadFile(`${template.kind==='contacts'?'modelo-contatos':SCREEN_TEMPLATES[kind].slug}.${format}`,template.model(format) as BlobPart,format==='xlsx'?XLSX_TYPE:CSV_TYPE);
 return <section className="spreadsheet-import" aria-labelledby="import-title">
  <header className="real-heading"><div><h1 id="import-title">{template.title}</h1><p className="real-help">Importações de Dados · planilha modelo</p></div>
   <Link className="secondary-button" to={IMPORT_JOBS_SCREEN}>Consultar gestão de ações</Link></header>
  {(kind==='receivables'||kind==='payables')&&<nav className="import-tabs" aria-label="Tipo de conta">{(['receivables','payables'] as const).map(k=>
   <Link key={k} to={importScreen(k)} aria-current={k===kind?'page':undefined} className={k===kind?'is-active':undefined}>{k==='receivables'?'Contas a receber':'Contas a pagar'}</Link>)}</nav>}
  <ol className="import-steps">{STEPS.map((label,i)=><li key={label} className={i===current?'is-current':i<current?'is-done':undefined}>{label}</li>)}</ol>
  <div className="import-grid">
   <section className="import-card"><h2>Selecione o arquivo</h2><p>Planilha .XLSX, .XLS ou .CSV com a primeira linha de títulos. Limite de {IMPORT_FILE_ROWS.toLocaleString('pt-BR')} linhas por planilha.</p>
    <label className="secondary-button"><Icon name="file-upload" size={12}/>Procurar arquivo<input type="file" id="import-file" className="real-sr-only" accept=".xlsx,.xls,.csv" disabled={busy||Boolean(pending?.uncertain)}
     onChange={event=>choose((event.target as HTMLInputElement).files?.[0])}/></label>
    {file&&<p className="real-help">{file.name} · {plural(file.cells.length-1,['linha','linhas'])}{items.length!==file.cells.length-1?` · ${plural(items.length,template.noun)}`:''}</p>}</section>
   <aside className="import-card"><h2>Instruções</h2><p>{template.rule}</p>
    <p><button type="button" className="text-button" onClick={()=>download('xlsx')}>Baixar planilha modelo (.XLSX)</button> · <button type="button" className="text-button" onClick={()=>download('csv')}>(.CSV)</button></p>
    <p className="real-help">Na convivência com o Origin, os registros importados aqui existem só no FAGOO; o Origin continua sendo o sistema principal.</p></aside>
  </div>
  {file&&<section className="import-card"><h2>Relacionar colunas</h2><p className="real-help">Escolha a coluna da planilha de cada campo. As colunas com o mesmo nome do modelo já vêm relacionadas.</p>
   <div className="table-scroll"><table className="data-table import-mapping"><thead><tr><th scope="col">Campo do FAGOO</th><th scope="col">Coluna da planilha</th></tr></thead>
    <tbody>{template.columns.map((c,i)=><tr key={c.key}><th scope="row"><label htmlFor={`import-map-${i}`}>{c.label}{c.required?' *':''}</label></th>
     <td><select id={`import-map-${i}`} value={mapping[c.label]??''} disabled={busy||Boolean(pending)} onChange={event=>relate(c.label,event.target.value)}>
      <option value="">Não importar</option>{header.filter(h=>String(h).trim()).map((h,j)=><option key={`${h}-${j}`} value={String(h).trim()}>{String(h).trim()}</option>)}</select></td></tr>)}</tbody></table></div>
   {missing.length>0&&<p className="real-alert" role="alert">Relacione as colunas obrigatórias: {missing.join(', ')}.</p>}
   {parsed&&parsed.readOnly.length>0&&<p className="real-help">Colunas só de consulta, não importadas: {parsed.readOnly.join(', ')}.</p>}
   {parsed&&parsed.unknown.length>0&&<p className="real-help">Colunas da planilha sem campo relacionado (ignoradas): {parsed.unknown.join(', ')}.</p>}</section>}
  {error&&<p className="real-alert" role="alert">{error}</p>}
  {progress&&<p role="status">{progress}</p>}
  {pending?.uncertain&&<p><button type="button" className="primary-button" disabled={busy} onClick={()=>void run([pending,...remaining.current])}>Conferir resultado</button></p>}
  {file&&<div className="real-editor-actions">
   <button type="button" className="secondary-button" disabled={busy||missing.length>0||Boolean(pending)||!items.some(i=>!i.problems.length)} onClick={()=>void validate()}>Validar</button>
   <button type="button" className="primary-button" disabled={busy||step!=='checked'||!valid||Boolean(pending)} onClick={importValid}>Importar {valid?plural(valid,template.noun):''}</button></div>}
  {step==='done'&&job&&<p className="real-success" role="status">Importação concluída: {plural(job.created,['incluído','incluídos'])}, {plural(job.updated,['atualizado','atualizados'])}, {plural(job.unchanged,['sem alteração','sem alteração'])} e {plural(job.invalid,['com erro','com erro'])}. <Link to={IMPORT_JOBS_SCREEN}>Consultar gestão de ações</Link></p>}
  {file&&items.length>0&&<>
   {step!=='mapping'&&<p className="real-help">{plural(items.length,template.noun)} · {plural(problems,['com problema','com problema'])}{step==='checked'?` · ${plural(valid,['válido','válidos'])}`:''}</p>}
   <div className="table-scroll"><table className="data-table import-rows"><thead><tr><th scope="col">Linha</th><th scope="col">Registro</th><th scope="col">Situação</th></tr></thead>
    <tbody>{items.slice(0,500).map(item=>{const s=status(item);return <tr key={item.row} className={s.bad?'is-invalid':undefined}><td>{item.lines.length>1?`${item.row}–${item.lines.at(-1)}`:item.row}</td>
     <td>{template.identity(item)}</td><td>{s.text}</td></tr>;})}</tbody></table></div>
   {items.length>500&&<p className="real-help">Mostrando os 500 primeiros de {plural(items.length,template.noun)}.</p>}
  </>}
 </section>;
}
