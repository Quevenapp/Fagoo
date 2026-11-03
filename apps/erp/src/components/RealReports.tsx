import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {REPORT_GROUPS,REPORT_PAGE,REPORT_PREVIEW,REPORT_MAX_LIMIT,REPORT_DEFAULT_LIMIT,REPORTS_PATH,REPORT_RUN_PATH,REPORTS_DELETE_PATH,reportBase,parseReports,captureReportRun,parseReportRows,captureReportSave,
 captureFrameworkDelete,parseFrameworkResult,cellText,brNumber,sumDecimals,frameworkFailure,type ReportsController,type ReportsView,type ReportBase,type ReportGroup,type SavedReport,type ReportRows,
 type ReportFilter,type ReportSaveInput,type FrameworkDeleteInput,type ReportRunInput} from '../lib/reports-model';
import {CSV_TYPE,XLSX_TYPE,downloadFile,numberCell,textCell,toCsv,toXlsx,type SheetCell} from '../lib/spreadsheet-export';
import {OriginListHeader} from './OriginList';
import {Modal} from './Modal';
import {Icon} from './Icon';
import './reports-labels.css';
import {nativeReportCoverageText,type NativeReportCoverage} from '../lib/document-reports-model';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
const reader=(s:AccessState,actor:string|null)=>s.phase==='ready'&&Boolean(s.membership)&&s.membership!.user_id===actor;
type Draft={base:ReportBase['base'];title:string;columns:string[];filters:ReportFilter[];view_limit:string;with_totals:boolean;users:string[]};
type Mode={type:'list'}|{type:'edit';report:SavedReport|null;draft:Draft;baseline:string}|{type:'view';title:string;run:Omit<ReportRunInput,'offset'|'page'>;with_totals:boolean};
type Attempt={operation:'report-save'|'reports-delete';body:ReportSaveInput|FrameworkDeleteInput;path:string};
const draftOf=(base:ReportBase,report:SavedReport|null,clone=false):Draft=>({base:base.base,title:report?(clone?`${report.title} (cópia)`.slice(0,80):report.title):clone?`Relatório de ${base.title}`.slice(0,80):'',
 columns:[...(report?.columns??base.default_columns)],filters:(report?.filters??[]).map(f=>({...f})),view_limit:String(report?.view_limit??REPORT_DEFAULT_LIMIT),with_totals:report?.with_totals??true,users:[...(report?.users??[])]});

/** Column that carries the "Total" label of the totals lines: the first one without a total, so no column ever loses its total
 * (a report may start with Valor); -1 when every column has one. */
const totalLabelAt=(columns:readonly {type:string}[])=>columns.findIndex(c=>!['money','decimal'].includes(c.type));
/** Rows table with the "Total" lines (nesta exibição and todos) for money and decimal columns. */
function ReportTable({base,rows,showTotal}:{base:ReportBase;rows:ReportRows;showTotal:boolean}){
 const columns=rows.columns.map(id=>base.columns.find(c=>c.id===id)!),numeric=(i:number)=>['money','decimal'].includes(columns[i]!.type);
 return <>{nativeReportCoverageText(rows as ReportRows & NativeReportCoverage)&&<p className="real-notice" role="note">{nativeReportCoverageText(rows as ReportRows & NativeReportCoverage)}</p>}<div className="table-scroll" role="region" aria-label="Pré-visualização" tabIndex={0}><table className="data-table reports-table"><thead><tr>{columns.map(c=><th key={c.id} scope="col" className={numeric(columns.indexOf(c))?'numeric':undefined}>{c.label}</th>)}</tr></thead>
  <tbody>{rows.rows.map((row,r)=><tr key={rows.offset+r}>{row.map((v,i)=><td key={columns[i]!.id} className={numeric(i)?'numeric':undefined}>{cellText(columns[i]!,v)}</td>)}</tr>)}</tbody>
  {showTotal&&columns.some((_,i)=>numeric(i))&&<tfoot>{([['Total nesta exibição',(i:number)=>brNumber(sumDecimals(rows.rows.map(r=>r[i]??null)),columns[i]!.type)],['Total (todos)',(i:number)=>brNumber(rows.totals[columns[i]!.id]!,columns[i]!.type)]] as const).map(([title,value])=>
   <tr key={title}>{columns.map((c,i)=>i===totalLabelAt(columns)?<th key={c.id} scope="row">{title}</th>:<td key={c.id} className={numeric(i)?'numeric':undefined}>{numeric(i)?value(i):''}</td>)}</tr>)}</tfoot>}
 </table></div></>;
}

/** Sistema > Relatórios customizados (Origin relatorios.customizados.php): padrões and customizados, editor and viewer. */
export default function RealReports({controller}:{controller:ReportsController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot),actor=useRef(snapshot.membership?.user_id??null),allowed=reader(snapshot,actor.current);
 const [view,setView]=useState<ReportsView|null>(null),[mode,setMode]=useState<Mode>({type:'list'}),[search,setSearch]=useState(''),[groupFilter,setGroupFilter]=useState<ReportGroup|''>('');
 const [loadError,setLoadError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false),[reload,setReload]=useState(0);
 const [rows,setRows]=useState<ReportRows|null>(null),[running,setRunning]=useState(false),[showTotal,setShowTotal]=useState(true),[pick,setPick]=useState(''),[filter,setFilter]=useState<ReportFilter>({column:'',value:''});
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[confirm,setConfirm]=useState<SavedReport|null>(null),[drag,setDrag]=useState<number|null>(null);
 const request=useRef<AbortController|null>(null),runner=useRef<AbortController|null>(null),save=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),alive=useRef(true);
 // Every member opens this screen, but the bases, the reports and the rows depend on the role: an answer is used only while
 // the role it was asked with is still the current one.
 const role=snapshot.membership?.role,roleRef=useRef(role);
 const may=()=>alive.current&&reader(controller.getSnapshot(),actor.current)&&controller.getSnapshot().membership?.role===roleRef.current;
 const dirty=mode.type==='edit'&&JSON.stringify(mode.draft)!==mode.baseline,guard=useUnsavedChanges(dirty,busy||pending);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();runner.current?.abort();save.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();runner.current?.abort();save.current?.abort();setBusy(false);setRunning(false);setView(null);setRows(null);setMode({type:'list'});if(attempt.current)setPending(true);},[allowed]);
 // A role change of the same user drops what the previous role read and reloads the list; a command in flight stays for Conferir resultado.
 useEffect(()=>{if(roleRef.current===role)return;roleRef.current=role;request.current?.abort();runner.current?.abort();save.current?.abort();setBusy(false);setRunning(false);
  setView(null);setRows(null);setMode({type:'list'});if(attempt.current)setPending(true);setReload(n=>n+1);},[role]);
 useEffect(()=>{if(!allowed||!may())return;const p=new AbortController();request.current?.abort();request.current=p;setLoading(true);setLoadError('');void(async()=>{try{
  const raw=await controller.system(REPORTS_PATH,{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;setView(parseReports(raw));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may())setLoadError(statusOf(e)===403?'Seu perfil não consulta relatórios, ou seu usuário não tem a permissão Relatórios customizados (Sistema › Usuários › Permissões › Outros).':'Não foi possível carregar os relatórios. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,reload,allowed]);
 // One page of a definition; late answers of another run are dropped.
 const fetchPage=async(run:Omit<ReportRunInput,'offset'|'page'>,offset:number,page:number,signal:AbortSignal)=>{const body=captureReportRun({...run,offset,page});
  return parseReportRows(await controller.system(REPORT_RUN_PATH,{method:'POST',body,signal}),body);};
 const preview=async(run:Omit<ReportRunInput,'offset'|'page'>,offset=0,page=REPORT_PREVIEW)=>{runner.current?.abort();const p=new AbortController();runner.current=p;setRunning(true);setError('');
  try{const r=await fetchPage(run,offset,page,p.signal);if(p.signal.aborted||runner.current!==p||!may())return;setRows(r);}
  catch(e){if(!p.signal.aborted&&runner.current===p&&!aborted(e)&&may())setError(statusOf(e)===403?'Seu perfil não lê os dados deste relatório.':statusOf(e)===400?'Confira as colunas e os filtros do relatório.':'Não foi possível consultar o relatório. Tente novamente.');}
  finally{if(runner.current===p){runner.current=null;setRunning(false);}}};
 const exportAs=async(format:'csv'|'xlsx')=>{if(mode.type!=='view'||!rows||running)return;const base=reportBase(mode.run.base)!,run=mode.run,p=new AbortController();runner.current?.abort();runner.current=p;setRunning(true);setError('');setNotice('');
  try{const all:(string|null)[][]=[];let offset=0,last:ReportRows|null=null;
   do{last=await fetchPage(run,offset,REPORT_PAGE,p.signal);if(p.signal.aborted||runner.current!==p||!may())return;all.push(...last.rows);offset+=last.rows.length;}while(last.rows.length>0&&offset<last.total_rows);
   const columns=run.columns.map(id=>base.columns.find(c=>c.id===id)!),numeric=(i:number)=>['money','decimal','int'].includes(columns[i]!.type);
   const sheet:SheetCell[][]=[columns.map(c=>textCell(c.label)),...all.map(r=>r.map((v,i)=>numeric(i)?numberCell(v):textCell(columns[i]!.type==='date'?cellText(columns[i]!,v):v)))];
   if(mode.with_totals)sheet.push(columns.map((c,i)=>last!.totals[c.id]!==undefined?numberCell(last!.totals[c.id]!):textCell(i===totalLabelAt(columns)?'Total':'')));
   const coverage=nativeReportCoverageText(last as (ReportRows & NativeReportCoverage)|null);if(coverage)sheet.push([textCell(coverage)]);
   const file=mode.title.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\w-]+/g,'-').replace(/^-|-$/g,'').toLowerCase()||'relatorio';
   if(format==='xlsx')downloadFile(`${file}.xlsx`,toXlsx(mode.title.slice(0,31),sheet) as unknown as BlobPart,XLSX_TYPE);else downloadFile(`${file}.csv`,toCsv(sheet),CSV_TYPE);
   setNotice(`${all.length.toLocaleString('pt-BR')} linha(s) exportada(s).`);
  }catch(e){if(!p.signal.aborted&&!aborted(e)&&may())setError('Não foi possível exportar o relatório. Tente novamente.');}finally{if(runner.current===p){runner.current=null;setRunning(false);}}};
 const runCommand=async(a:Attempt)=>{
  if(!may()||save.current||attempt.current!==a)return;const p=new AbortController();save.current=p;setBusy(true);setError('');setNotice('');
  try{const raw=await controller.system(a.path,{method:'POST',body:a.body,signal:p.signal});if(p.signal.aborted||attempt.current!==a||!may())return;const r=parseFrameworkResult(raw,a.body,a.operation);
   attempt.current=null;setPending(false);setConfirm(null);setMode({type:'list'});setRows(null);
   setNotice(`${a.operation==='reports-delete'?'Relatório excluído':`Relatório ${r.receipt.action==='report_create'?'salvo; ele aparece em Relatórios customizados':'alterado'}`}${r.replayed?' (comando já registrado)':''}.`);setReload(n=>n+1);
  }catch(e){if(p.signal.aborted||attempt.current!==a||aborted(e)||!may())return;const f=frameworkFailure(statusOf(e),'O relatório');
   if(f.definitive){attempt.current=null;setPending(false);setError(f.message);if(f.reload){setConfirm(null);setMode({type:'list'});setReload(n=>n+1);}}else{setPending(true);setError(f.message);}}
  finally{if(save.current===p){save.current=null;setBusy(false);}}};
 const start=(a:Attempt)=>{if(attempt.current||busy)return;attempt.current=a;void runCommand(a);};
 const locked=busy||pending;
 if(!allowed)return <section className="real-state-panel"><h1>Relatórios customizados não liberados</h1><p>Entre novamente para consultar os relatórios.</p></section>;
 const manage=Boolean(view?.can_manage);
 const openEdit=(base:ReportBase,report:SavedReport|null,clone=false)=>{if(locked||!manage)return;const draft=draftOf(base,report,clone);setMode({type:'edit',report:clone?null:report,draft,baseline:clone?'':JSON.stringify(draft)});setRows(null);setError('');setNotice('');};
 const openView=(title:string,run:Omit<ReportRunInput,'offset'|'page'>,with_totals:boolean)=>{setMode({type:'view',title,run,with_totals});setRows(null);setError('');setNotice('');void preview(run,0,REPORT_PAGE);};
 const back=()=>guard.confirmLeave(()=>{if(busy||pending)return;runner.current?.abort();setMode({type:'list'});setRows(null);setError('');});
 const set=(patch:Partial<Draft>)=>{if(locked)return;setMode(m=>m.type==='edit'?{...m,draft:{...m.draft,...patch}}:m);setRows(null);};
 if(mode.type==='edit'&&view){
  const d=mode.draft,base=reportBase(d.base)!,label=(id:string)=>`${base.columns.find(c=>c.id===id)?.label} - ${base.title}`,available=base.columns.filter(c=>!d.columns.includes(c.id));
  // Marked users who lost access are not in the directory (active members only); they can stay or be unmarked.
  const stale=d.users.filter(id=>!(view.directory??[]).some(u=>u.user_id===id));
  const limit=Number(d.view_limit),limitOk=/^\d{1,4}$/.test(d.view_limit)&&limit>=1&&limit<=REPORT_MAX_LIMIT;
  const run=limitOk&&d.columns.length?{base:d.base,columns:d.columns,filters:d.filters,view_limit:limit}:null;
  const move=(from:number,to:number)=>{if(to<0||to>=d.columns.length)return;const next=[...d.columns];const [x]=next.splice(from,1);next.splice(to,0,x!);set({columns:next});};
  const submit=()=>{let body:ReportSaveInput;try{body=captureReportSave({command_id:crypto.randomUUID(),id:mode.report?.id??null,expected_version:mode.report?.version??0,
    data:{base:d.base,title:d.title.trim(),columns:d.columns,filters:d.filters,view_limit:limit,with_totals:d.with_totals,users:d.users}});}catch{setError('Informe o Título, ao menos uma coluna e um Limite para visualização de 1 a 2.000.');return;}
   start({operation:'report-save',body,path:REPORTS_PATH});};
  return <div className="real-reports">
   <OriginListHeader title={mode.report?'Configurar relatório':'Novo relatório customizado'}/>
   <p className="real-help">Relatório de {base.title}. Após salvar, aparecerá em Relatórios customizados.</p>
   {error&&<p className="real-alert" role="alert">{error}</p>}
   {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de alterar de novo.</p>
    <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runCommand(attempt.current!)}>Conferir resultado</button></div></section>}
   <fieldset disabled={locked} className="reports-editor">
    <label className="form-field">Título *<input id="report-title" maxLength={80} value={d.title} onChange={e=>set({title:e.target.value})}/></label>
    <label className="form-field">Limite para visualização<input id="report-limit" inputMode="numeric" maxLength={4} value={d.view_limit} onChange={e=>set({view_limit:e.target.value})}/></label>
    <section className="reports-columns" aria-label="Colunas"><h2>Colunas</h2>
     <ol>{d.columns.map((id,i)=><li key={id} draggable onDragStart={()=>setDrag(i)} onDragOver={e=>e.preventDefault()} onDrop={()=>{if(drag!==null)move(drag,i);setDrag(null);}}>
      <Icon name="grip-vertical" size={11}/><span>{label(id)}</span>
      <button type="button" className="icon-button" aria-label={`Subir ${label(id)}`} disabled={i===0} onClick={()=>move(i,i-1)}><Icon name="arrow-up" size={11}/></button>
      <button type="button" className="icon-button" aria-label={`Descer ${label(id)}`} disabled={i===d.columns.length-1} onClick={()=>move(i,i+1)}><Icon name="arrow-down" size={11}/></button>
      <button type="button" className="icon-button" aria-label={`Remover ${label(id)}`} disabled={d.columns.length===1} onClick={()=>set({columns:d.columns.filter(c=>c!==id)})}><Icon name="xmark" size={11}/></button></li>)}</ol>
     <div className="reports-inline"><select id="report-add-column" aria-label="Coluna a incluir" value={pick} onChange={e=>setPick(e.target.value)}><option value="">Selecione uma coluna</option>{available.map(c=><option key={c.id} value={c.id}>{label(c.id)}</option>)}</select>
      <button type="button" className="secondary-button" disabled={!pick||d.columns.length>=30} onClick={()=>{set({columns:[...d.columns,pick]});setPick('');}}><Icon name="plus" size={11}/>Incluir coluna</button></div></section>
    <label className="preference-switch"><input id="report-totals" type="checkbox" checked={d.with_totals} onChange={e=>set({with_totals:e.target.checked})}/><span>Exportar com totalizadores</span></label>
    <section className="reports-users" aria-label="Usuários"><h2>Usuários</h2><p className="real-help">Os usuários marcados veem este relatório (os administradores veem todos). Cada um só vê os dados que o seu perfil já consulta.</p>
     {view.directory?.filter(u=>u.role!=='admin').map(u=><label key={u.user_id} className="preference-check"><input id={`report-user-${u.user_id}`} type="checkbox" checked={d.users.includes(u.user_id)}
      onChange={e=>set({users:e.target.checked?[...d.users,u.user_id]:d.users.filter(x=>x!==u.user_id)})}/><span>{u.label??u.user_id}</span></label>)}
     {stale.length>0&&<p className="real-help">{stale.length} usuário(s) marcado(s) não estão mais ativos. <button type="button" className="text-button" onClick={()=>set({users:d.users.filter(x=>!stale.includes(x))})}>Desmarcar usuários inativos</button></p>}</section>
    <section className="reports-filters" aria-label="Filtro por coluna"><h2>Filtro por coluna</h2>
     <ul>{d.filters.map((f,i)=><li key={`${f.column}:${i}`}><span>{label(f.column)}: {f.value}</span><button type="button" className="icon-button" aria-label={`Remover filtro ${label(f.column)}`} onClick={()=>set({filters:d.filters.filter((_,j)=>j!==i)})}><Icon name="xmark" size={11}/></button></li>)}</ul>
     <div className="reports-inline"><select id="report-filter-column" aria-label="Coluna" value={filter.column} onChange={e=>setFilter({...filter,column:e.target.value})}><option value="">Coluna</option>{base.columns.map(c=><option key={c.id} value={c.id}>{label(c.id)}</option>)}</select>
      <input id="report-filter-value" aria-label="Valor" placeholder="Valor" maxLength={100} value={filter.value} onChange={e=>setFilter({...filter,value:e.target.value})}/>
      <button type="button" className="secondary-button" disabled={!filter.column||!filter.value.trim()||d.filters.length>=10} onClick={()=>{set({filters:[...d.filters,{column:filter.column,value:filter.value.trim()}]});setFilter({column:'',value:''});}}>Incluir filtro</button></div>
     <p className="real-help">Texto: contém o valor. Valores e números: igual ao valor (use ponto para decimais).</p></section>
   </fieldset>
   <section className="reports-preview" aria-label="Pré-visualização"><div className="reports-inline"><h2>Pré-visualização de {REPORT_PREVIEW} registros</h2>
    <button type="button" className="secondary-button" disabled={!run||running||locked} onClick={()=>run&&void preview(run)}>{running?'Consultando…':'Visualizar'}</button>
    <button type="button" className="icon-button" aria-pressed={showTotal} aria-label="Mostrar total" title="Mostrar total" onClick={()=>setShowTotal(!showTotal)}><Icon name={showTotal?'eye':'eye-slash'} size={13}/></button></div>
    {rows&&<ReportTable base={base} rows={rows} showTotal={showTotal}/>}{rows&&<p className="real-help">{rows.total_rows.toLocaleString('pt-BR')} registro(s) no limite{rows.truncated?' (há mais registros além do limite)':''}.</p>}</section>
   <footer className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={back}>Cancelar</button>
    <button type="button" className="primary-button" disabled={locked||Boolean(mode.report)&&!dirty} onClick={submit}>{busy?'Salvando…':'Salvar'}</button></footer>
  </div>;
 }
 if(mode.type==='view'){const base=reportBase(mode.run.base)!;
  return <div className="real-reports">
   <OriginListHeader title={mode.title} primary={<button type="button" className="secondary-button" onClick={back}><Icon name="chevron-left" size={11}/>Voltar</button>}/>
   {error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{running&&<p role="status" className="real-help">Consultando…</p>}
   <div className="reports-inline"><button type="button" className="secondary-button" disabled={!rows||running||!rows.rows.length} onClick={()=>void exportAs('xlsx')}><Icon name="file-excel" size={12}/>Exportar XLSX</button>
    <button type="button" className="secondary-button" disabled={!rows||running||!rows.rows.length} onClick={()=>void exportAs('csv')}><Icon name="file-lines" size={12}/>Exportar CSV</button></div>
   {rows&&<ReportTable base={base} rows={rows} showTotal={true}/>}
   {rows&&!rows.rows.length&&<div className="empty-state"><h2>Nenhum registro encontrado</h2><p>Revise os filtros do relatório.</p></div>}
   {rows&&<p className="real-help">{rows.total_rows.toLocaleString('pt-BR')} registro(s){rows.truncated?`; o limite de ${mode.run.view_limit.toLocaleString('pt-BR')} foi atingido`:''}.
    {rows.offset>0&&<button type="button" className="text-button" disabled={running} onClick={()=>void preview(mode.run,Math.max(0,rows.offset-REPORT_PAGE),REPORT_PAGE)}>Página anterior</button>}
    {rows.offset+rows.rows.length<rows.total_rows&&<button type="button" className="text-button" disabled={running} onClick={()=>void preview(mode.run,rows.offset+rows.rows.length,REPORT_PAGE)}>Próxima página</button>}</p>}
  </div>;}
 const term=search.trim().toLowerCase(),match=(title:string,group:ReportGroup)=>(!groupFilter||group===groupFilter)&&(!term||title.toLowerCase().includes(term));
 const standards=(view?.bases??[]).filter(b=>match(`Relatório de ${b.title}`,b.group)),customs=(view?.reports??[]).filter(r=>match(r.title,reportBase(r.base)!.group));
 const remove=()=>{if(!confirm)return;start({operation:'reports-delete',body:captureFrameworkDelete({command_id:crypto.randomUUID(),items:[{id:confirm.id,expected_version:confirm.version}]}),path:REPORTS_DELETE_PATH});};
 return <div className="real-reports">
  <OriginListHeader title="Relatórios customizados"/>
  <div className="reports-inline reports-toolbar"><input type="search" id="reports-search" aria-label="Pesquisar relatórios" placeholder="Pesquisar" maxLength={80} value={search} onChange={e=>setSearch(e.target.value)}/>
   <label className="form-field">Tipo de relatório<select id="reports-group" value={groupFilter} onChange={e=>setGroupFilter(e.target.value as ReportGroup|'')}><option value="">Todos</option>{(Object.keys(REPORT_GROUPS) as ReportGroup[]).map(g=><option key={g} value={g}>{REPORT_GROUPS[g]}</option>)}</select></label></div>
  {loadError&&<p className="real-alert" role="alert">{loadError}</p>}{error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{loading&&<p role="status" className="real-help">Carregando relatórios…</p>}
  {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de alterar de novo.</p>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runCommand(attempt.current!)}>Conferir resultado</button></div></section>}
  {view&&<><section className="reports-section"><h2>Relatórios padrão</h2><ul className="reports-list">{standards.map(b=><li key={b.base}><div><strong>Relatório de {b.title}</strong><small>Visão de {b.title} · {REPORT_GROUPS[b.group]}</small></div>
    <div className="reports-actions"><button type="button" className="text-button" onClick={()=>openView(`Relatório de ${b.title}`,{base:b.base,columns:b.default_columns,filters:[],view_limit:REPORT_DEFAULT_LIMIT},true)}>Visualizar</button>
     {manage&&<button type="button" className="text-button" disabled={locked} onClick={()=>openEdit(b,null,true)}>Clonar</button>}</div></li>)}</ul>
    {!standards.length&&<p className="empty-state">Nenhum relatório padrão para este filtro.</p>}</section>
   <section className="reports-section"><h2>Relatórios customizados</h2><ul className="reports-list">{customs.map(r=>{const b=reportBase(r.base)!;return <li key={r.id}><div><strong>{r.title}</strong><small>Visão de {b.title} · {r.columns.length} coluna(s){r.filters.length?` · ${r.filters.length} filtro(s)`:''}</small></div>
     <div className="reports-actions"><button type="button" className="text-button" onClick={()=>openView(r.title,{base:r.base,columns:r.columns,filters:r.filters,view_limit:r.view_limit},r.with_totals)}>Visualizar</button>
      {manage&&<><button type="button" className="text-button" disabled={locked} onClick={()=>openEdit(b,r)}>Configurar</button><button type="button" className="text-button" disabled={locked} onClick={()=>openEdit(b,r,true)}>Clonar</button>
       <button type="button" className="text-button" disabled={locked} onClick={()=>setConfirm(r)}>Excluir</button></>}</div></li>;})}</ul>
    {!customs.length&&<p className="empty-state">{manage?'Nenhum relatório customizado. Clone um relatório padrão para criar o seu.':'Nenhum relatório customizado liberado para você.'}</p>}</section>
   <p className="real-help reports-totals">Totais — Quantidade: {(standards.length+customs.length).toLocaleString('pt-BR')}</p></>}
  {confirm&&<Modal title="Excluir relatório" onClose={()=>{if(!busy)setConfirm(null);}} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={()=>setConfirm(null)}>Cancelar</button>
   <button type="button" className="danger-button" disabled={locked} onClick={remove}>{busy?'Excluindo…':'Excluir'}</button></>}><p>Excluir o relatório "{confirm.title}"?</p></Modal>}
 </div>;
}
