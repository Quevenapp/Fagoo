import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {useSearchParams} from 'react-router-dom';
import type {AccessState} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {LABEL_TYPES,LABEL_TYPE_LABELS,LABEL_FIELDS,LABEL_PRINTABLE,LABEL_FONTS,LABEL_BARCODES,LABEL_BARCODES_UNAVAILABLE,LABELS_PATH,LABELS_DELETE_PATH,labelRecordsPath,labelConfigValid,parseLabels,captureLabelSave,
 captureLabelRecordsQuery,parseLabelRecords,captureFrameworkDelete,parseFrameworkResult,frameworkFailure,labelsPerPage,pageSize,labelText,LABEL_SAMPLE,labelInvoicePath,captureLabelInvoiceQuery,parseLabelInvoiceProducts,
 type ReportsController,type LabelsView,type LabelTemplate,type LabelType,type LabelConfig,type LabelField,type LabelRecords,type LabelSaveInput,type FrameworkDeleteInput} from '../lib/reports-model';
import {barcode,barRuns,dataMatrix,qrMatrix} from '../lib/barcodes';
import {OriginListHeader} from './OriginList';
import {Modal} from './Modal';
import {Icon} from './Icon';
import './reports-labels.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const statusOf=(e:unknown)=>e&&typeof e==='object'&&Number.isInteger((e as {status?:unknown}).status)?(e as {status:number}).status:null;
const admin=(s:AccessState,actor:string|null)=>s.phase==='ready'&&s.membership?.role==='admin'&&s.membership.user_id===actor;
const PT=0.3528;
type Draft={type:LabelType;description:string;config:LabelConfig};
// 230: "Imprimir etiquetas" of a note opens the print with the products of the note, one label per unit (quantity rounded up).
type InvoiceLabels={number:string|null;items:{id:string;values:Record<string,string|null>;copies:number}[]};
type Mode={type:'list'}|{type:'edit';template:LabelTemplate|null;draft:Draft;baseline:string}|{type:'print';template:LabelTemplate;invoice?:InvoiceLabels};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const unitsOf=(quantity:string)=>Math.min(100,Math.max(1,Math.ceil(Number(quantity))));
type Attempt={operation:'label-save'|'labels-delete';body:LabelSaveInput|FrameworkDeleteInput;path:string};
const FONT:Record<string,string>={helvetica:'Helvetica, Arial, sans-serif',courier:'Courier New, monospace',monospace:'monospace',times:'Times New Roman, serif'};

/** One label in millimeters: texts at their positions and barcodes drawn from the local encoders. */
export function LabelSvg({type,config,values,onMove}:{type:LabelType;config:LabelConfig;values:Record<string,string|null>;onMove?:(index:number,x:string,y:string)=>void}){
 const w=Number(config.label.width),h=Number(config.label.height),svg=useRef<SVGSVGElement|null>(null),[dragging,setDragging]=useState<number|null>(null);
 const point=(e:{clientX:number;clientY:number})=>{const r=svg.current?.getBoundingClientRect();if(!r||!r.width)return null;const clamp=(v:number,max:number)=>Math.min(max,Math.max(0,Math.round(v*10)/10));
  return[clamp((e.clientX-r.left)/r.width*w,w),clamp((e.clientY-r.top)/r.height*h,h)] as const;};
 return <svg ref={svg} className="label-svg" viewBox={`0 0 ${w} ${h}`} style={{width:`${w}mm`,height:`${h}mm`,fontFamily:FONT[config.label.font]}} role="img" aria-label={`Etiqueta ${w} × ${h} mm`}
  onPointerMove={e=>{if(dragging===null||!onMove)return;const p=point(e);if(p)onMove(dragging,String(p[0]),String(p[1]));}} onPointerUp={()=>setDragging(null)} onPointerLeave={()=>setDragging(null)}>
  <rect x="0" y="0" width={w} height={h} className="label-svg-border"/>
  {config.fields.map((f,i)=>{const x=Number(f.x),y=Number(f.y),size=Number(f.size)*PT,value=values[f.field]??null,start=onMove?{onPointerDown:()=>setDragging(i),style:{cursor:'move'}}:{};
   // 231: QR CODE is a square of dark modules (one rect per run of a row), as large as the space below the field allows (8 to 25 mm).
   // 283: DATA MATRIX is drawn the same way (a square of modules).
   if(f.barcode&&(config.label.barcode==='qr'||config.label.barcode==='datamatrix')){const name=config.label.barcode==='qr'?'QR CODE':'DATA MATRIX',matrix=value?(config.label.barcode==='qr'?qrMatrix:dataMatrix)(value):null,side=Math.max(8,Math.min(25,h-y-(config.label.barcode_text?size+0.5:0),w-x)),cell=matrix?side/matrix.length:0;
    if(!matrix)return <text key={i} x={x} y={y+size} fontSize={size} className="label-svg-missing" {...start}>{value?`Texto longo demais para ${name}`:'Sem código'}</text>;
    return <g key={i} {...start} aria-label={`${name} ${value}`}>{matrix.flatMap((row,r)=>barRuns(row.map(d=>d?'1':'0').join('')).map(([c,n])=><rect key={`${r}-${c}`} x={x+c*cell} y={y+r*cell} width={n*cell} height={cell}/>))}
     {config.label.barcode_text&&<text x={x+side/2} y={y+side+size} fontSize={size} textAnchor="middle">{value}</text>}</g>;}
   if(f.barcode){const bits=barcode(config.label.barcode,value),module=0.33,height=Math.max(4,Math.min(12,h-y-(config.label.barcode_text?size+0.5:0)));
    if(!bits)return <text key={i} x={x} y={y+size} fontSize={size} className="label-svg-missing" {...start}>{value?`Código inválido para ${config.label.barcode.toUpperCase()}`:'Sem código'}</text>;
    return <g key={i} {...start}>{barRuns(bits).map(([s,n])=><rect key={s} x={x+s*module} y={y} width={n*module} height={height}/>)}
     {config.label.barcode_text&&<text x={x+bits.length*module/2} y={y+height+size} fontSize={size} textAnchor="middle">{value}</text>}</g>;}
   return <text key={i} x={x} y={y+size} fontSize={size} fontWeight={f.bold?700:400} {...start}>{labelText(type,f.field,value,config)}</text>;})}
 </svg>;
}

/** Sistema > Etiquetas customizadas (Origin etiquetas.customizadas.php): Padrões and Customizadas, editor and printing. */
export default function RealLabels({controller}:{controller:ReportsController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot),actor=useRef(snapshot.membership?.user_id??null),allowed=admin(snapshot,actor.current);
 const [view,setView]=useState<LabelsView|null>(null),[mode,setMode]=useState<Mode>({type:'list'}),[search,setSearch]=useState(''),[typeFilter,setTypeFilter]=useState<LabelType|''>('');
 const [loadError,setLoadError]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false),[reload,setReload]=useState(0);
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[confirm,setConfirm]=useState<LabelTemplate|null>(null);
 const [query,setQuery]=useState(''),[records,setRecords]=useState<LabelRecords|null>(null),[chosen,setChosen]=useState<string[]>([]),[copies,setCopies]=useState('1'),[sheet,setSheet]=useState(false),[finding,setFinding]=useState(false);
 const [params]=useSearchParams(),nota=params.get('nota'),[byQuantity,setByQuantity]=useState(true),opened=useRef<string|null>(null);
 const request=useRef<AbortController|null>(null),finder=useRef<AbortController|null>(null),save=useRef<AbortController|null>(null),attempt=useRef<Attempt|null>(null),alive=useRef(true);
 const may=()=>alive.current&&admin(controller.getSnapshot(),actor.current);
 const dirty=mode.type==='edit'&&JSON.stringify(mode.draft)!==mode.baseline,guard=useUnsavedChanges(dirty,busy||pending);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();finder.current?.abort();save.current?.abort();};},[controller]);
 useEffect(()=>{if(allowed)return;request.current?.abort();finder.current?.abort();save.current?.abort();setBusy(false);setView(null);setRecords(null);setSheet(false);setMode({type:'list'});if(attempt.current)setPending(true);},[allowed]);
 useEffect(()=>{if(!allowed||!may())return;const p=new AbortController();request.current?.abort();request.current=p;setLoading(true);setLoadError('');void(async()=>{try{
  const raw=await controller.system(LABELS_PATH,{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;setView(parseLabels(raw));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may())setLoadError(statusOf(e)===403?'Somente administradores gerenciam as etiquetas.':'Não foi possível carregar as etiquetas. Tente novamente.');}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,reload,allowed]);
 useEffect(()=>{if(!sheet)return;document.body.classList.add('labels-print-open');return()=>document.body.classList.remove('labels-print-open');},[sheet]);
 // ?nota=<id>: once the models are read, the product labels of that note open in the print with the first product model.
 useEffect(()=>{if(!view||!nota||opened.current===nota||!may())return;opened.current=nota;
  if(!UUID.test(nota)){setError('Nota fiscal inválida para imprimir etiquetas.');return;}
  const template=view.items.find(t=>t.type==='produto');if(!template){setError('Nenhum modelo de etiqueta de produto disponível.');return;}
  const p=new AbortController();finder.current?.abort();finder.current=p;setFinding(true);setError('');void(async()=>{try{
   const q=captureLabelInvoiceQuery({id:nota}),raw=await controller.system(labelInvoicePath(nota),{method:'GET',signal:p.signal});if(p.signal.aborted||finder.current!==p||!may())return;
   const r=parseLabelInvoiceProducts(raw,q),items=r.items.map(i=>({id:`item-${i.position}`,values:i.values,copies:unitsOf(i.quantity)}));
   setChosen(items.map(i=>i.id));setCopies('1');setByQuantity(true);setMode({type:'print',template,invoice:{number:r.invoice.number,items}});
  }catch(e){if(!p.signal.aborted&&finder.current===p&&!aborted(e)&&may())setError(statusOf(e)===404?'Nota fiscal não encontrada.':statusOf(e)===403?'Seu perfil não consulta as notas fiscais e os produtos.':'Não foi possível ler os produtos da nota. Tente novamente.');}
  finally{if(finder.current===p){finder.current=null;setFinding(false);}}})();},[view,nota]);
 const runCommand=async(a:Attempt)=>{
  if(!may()||save.current||attempt.current!==a)return;const p=new AbortController();save.current=p;setBusy(true);setError('');setNotice('');
  try{const raw=await controller.system(a.path,{method:'POST',body:a.body,signal:p.signal});if(p.signal.aborted||attempt.current!==a||!may())return;const r=parseFrameworkResult(raw,a.body,a.operation);
   attempt.current=null;setPending(false);setConfirm(null);setMode({type:'list'});setNotice(`${a.operation==='labels-delete'?'Etiqueta excluída':`Etiqueta ${r.receipt.action==='label_create'?'salva em Customizadas':'alterada'}`}${r.replayed?' (comando já registrado)':''}.`);setReload(n=>n+1);
  }catch(e){if(p.signal.aborted||attempt.current!==a||aborted(e)||!may())return;const f=frameworkFailure(statusOf(e),'A etiqueta');
   if(f.definitive){attempt.current=null;setPending(false);setError(f.message);if(f.reload){setConfirm(null);setMode({type:'list'});setReload(n=>n+1);}}else{setPending(true);setError(f.message);}}
  finally{if(save.current===p){save.current=null;setBusy(false);}}};
 const start=(a:Attempt)=>{if(attempt.current||busy)return;attempt.current=a;void runCommand(a);};
 const locked=busy||pending;
 if(!allowed)return <section className="real-state-panel"><h1>Etiquetas customizadas não liberadas</h1><p>Somente administradores gerenciam os modelos de etiqueta.</p></section>;
 const openEdit=(t:LabelTemplate,clone:boolean)=>{if(locked)return;const draft:Draft={type:t.type,description:clone?`${t.description} (cópia)`.slice(0,80):t.description,config:structuredClone(t.config)};
  setMode({type:'edit',template:clone?null:t,draft,baseline:clone?'':JSON.stringify(draft)});setError('');setNotice('');};
 const openPrint=(t:LabelTemplate)=>{if(locked||!LABEL_PRINTABLE.includes(t.type))return;finder.current?.abort();setRecords(null);setChosen([]);setQuery('');setCopies('1');setMode({type:'print',template:t});setError('');setNotice('');};
 const back=()=>guard.confirmLeave(()=>{if(busy||pending)return;finder.current?.abort();setSheet(false);setMode({type:'list'});setError('');});
 if(mode.type==='edit'){
  const d=mode.draft,c=d.config,fields=LABEL_FIELDS[d.type],valid=labelConfigValid(d.type,c)&&d.description.trim().length>0;
  const set=(patch:Partial<Draft>)=>{if(locked)return;setMode(m=>m.type==='edit'?{...m,draft:{...m.draft,...patch}}:m);};
  const label=(patch:Partial<LabelConfig['label']>)=>set({config:{...c,label:{...c.label,...patch}}}),page=(patch:Partial<LabelConfig['page']>)=>set({config:{...c,page:{...c.page,...patch}}});
  const field=(i:number,patch:Partial<LabelField>)=>set({config:{...c,fields:c.fields.map((f,j)=>j===i?{...f,...patch}:f)}});
  const mm=(id:string,text:string,value:string,onChange:(v:string)=>void)=><label className="form-field">{text}<input id={id} inputMode="decimal" maxLength={5} value={value} onChange={e=>onChange(e.target.value.replace(',','.'))}/></label>;
  const submit=()=>{let body:LabelSaveInput;try{body=captureLabelSave({command_id:crypto.randomUUID(),id:mode.template?.id??null,expected_version:mode.template?.version??0,data:{type:d.type,description:d.description.trim(),config:c}});}
   catch{setError('Confira a Descrição e as medidas: números em milímetros com até uma casa decimal, e cada campo dentro da etiqueta.');return;}start({operation:'label-save',body,path:LABELS_PATH});};
  const per=labelsPerPage(c);
  return <div className="real-labels">
   <OriginListHeader title={mode.template?'Editar etiqueta':'Nova etiqueta customizada'} primary={<button type="button" className="secondary-button" disabled={busy} onClick={back}><Icon name="chevron-left" size={11}/>Voltar</button>}/>
   {error&&<p className="real-alert" role="alert">{error}</p>}
   {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de alterar de novo.</p>
    <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runCommand(attempt.current!)}>Conferir resultado</button></div></section>}
   <div className="labels-editor"><fieldset disabled={locked} className="labels-fields">
    <section aria-label="Dados do Modelo"><h2>Dados do Modelo</h2>
     <label className="form-field">Descrição *<input id="label-description" maxLength={80} value={d.description} onChange={e=>set({description:e.target.value})}/></label>
     <label className="form-field">Tipo<select id="label-type" value={d.type} disabled><option value={d.type}>{LABEL_TYPE_LABELS[d.type]}</option></select></label></section>
    <section aria-label="Etiqueta"><h2>Etiqueta</h2><div className="labels-grid">
     {mm('label-width','Largura (mm)',c.label.width,v=>label({width:v}))}{mm('label-height','Altura (mm)',c.label.height,v=>label({height:v}))}
     <label className="form-field">Fonte<select id="label-font" value={c.label.font} onChange={e=>label({font:e.target.value})}>{LABEL_FONTS.map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
     {mm('label-font-size','Tamanho da fonte (pt)',c.label.font_size,v=>label({font_size:v}))}
     <label className="form-field">Formato do código<select id="label-barcode" value={c.label.barcode} onChange={e=>label({barcode:e.target.value as LabelConfig['label']['barcode']})}>
      {LABEL_BARCODES.map(([v,t])=><option key={v} value={v}>{t}</option>)}{LABEL_BARCODES_UNAVAILABLE.map(t=><option key={t} value={t} disabled>{t} (ainda não disponível)</option>)}</select></label>
     {mm('label-columns-gap','Espaço entre colunas (mm)',c.label.columns_gap,v=>label({columns_gap:v}))}{mm('label-rows-gap','Espaço entre linhas (mm)',c.label.rows_gap,v=>label({rows_gap:v}))}</div>
     <label className="preference-switch"><input id="label-barcode-text" type="checkbox" checked={c.label.barcode_text} onChange={e=>label({barcode_text:e.target.checked})}/><span>Código em texto</span></label>
     <label className="preference-switch"><input id="label-currency" type="checkbox" checked={c.label.currency} onChange={e=>label({currency:e.target.checked})}/><span>Moeda (R$)</span></label>
     <label className="preference-switch"><input id="label-show-labels" type="checkbox" checked={c.label.show_labels} onChange={e=>label({show_labels:e.target.checked})}/><span>Rótulo dos campos</span></label></section>
    <section aria-label="Página"><h2>Página</h2><div className="labels-grid">
     <label className="form-field">Tamanho<select id="label-page" value={c.page.size} onChange={e=>{const size=e.target.value as LabelConfig['page']['size'];page(size==='custom'?{size,width:'210',height:'297'}:{size,width:null,height:null});}}>
      {['A2','A3','A4','A5'].map(s=><option key={s} value={s}>{s}</option>)}<option value="custom">Customizado</option></select></label>
     {c.page.size==='custom'&&<>{mm('label-page-width','Largura da página (mm)',c.page.width??'',v=>page({width:v}))}{mm('label-page-height','Altura da página (mm)',c.page.height??'',v=>page({height:v}))}</>}
     <label className="form-field">Orientação<select id="label-orientation" value={c.page.orientation} onChange={e=>page({orientation:e.target.value as LabelConfig['page']['orientation']})}><option value="portrait">Retrato</option><option value="landscape">Paisagem</option></select></label>
     {mm('label-margin-left','Margem esquerda (mm)',c.page.margin_left,v=>page({margin_left:v}))}{mm('label-margin-top','Margem superior (mm)',c.page.margin_top,v=>page({margin_top:v}))}</div>
     {labelConfigValid(d.type,c)&&<p className="real-help">{per.cols} × {per.rows} = {per.total} etiqueta(s) por página.</p>}</section>
    <section aria-label="Campos"><h2>Campos</h2><table className="data-table labels-fields-table"><thead><tr><th scope="col">Campo</th><th scope="col">X (mm)</th><th scope="col">Y (mm)</th><th scope="col">Tamanho</th><th scope="col">Negrito</th><th scope="col">Código de barras</th><th scope="col"><span className="sr-only">Remover</span></th></tr></thead>
     <tbody>{c.fields.map((f,i)=><tr key={i}><td><select id={`label-field-${i}`} aria-label={`Campo ${i+1}`} value={f.field} onChange={e=>field(i,{field:e.target.value})}>{Object.entries(fields).map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></td>
      <td><input id={`label-field-${i}-x`} aria-label={`X do campo ${i+1}`} inputMode="decimal" maxLength={5} value={f.x} onChange={e=>field(i,{x:e.target.value.replace(',','.')})}/></td>
      <td><input id={`label-field-${i}-y`} aria-label={`Y do campo ${i+1}`} inputMode="decimal" maxLength={5} value={f.y} onChange={e=>field(i,{y:e.target.value.replace(',','.')})}/></td>
      <td><input id={`label-field-${i}-size`} aria-label={`Tamanho do campo ${i+1}`} inputMode="decimal" maxLength={4} value={f.size} onChange={e=>field(i,{size:e.target.value.replace(',','.')})}/></td>
      <td><input id={`label-field-${i}-bold`} type="checkbox" aria-label={`Negrito do campo ${i+1}`} checked={f.bold} onChange={e=>field(i,{bold:e.target.checked})}/></td>
      <td><input id={`label-field-${i}-barcode`} type="checkbox" aria-label={`Código de barras do campo ${i+1}`} checked={f.barcode} onChange={e=>field(i,{barcode:e.target.checked})}/></td>
      <td><button type="button" className="icon-button" aria-label={`Remover campo ${i+1}`} disabled={c.fields.length===1} onClick={()=>set({config:{...c,fields:c.fields.filter((_,j)=>j!==i)}})}><Icon name="xmark" size={11}/></button></td></tr>)}</tbody></table>
     <button type="button" className="secondary-button" disabled={c.fields.length>=20} onClick={()=>set({config:{...c,fields:[...c.fields,{field:Object.keys(fields)[0]!,x:'2',y:'2',size:c.label.font_size,bold:false,barcode:false}]}})}><Icon name="plus" size={11}/>Incluir campo</button></section>
   </fieldset>
   <section className="labels-preview" aria-label="Pré-visualização"><h2>Pré-visualização</h2>
    {labelConfigValid(d.type,c)?<LabelSvg type={d.type} config={c} values={LABEL_SAMPLE[d.type]} onMove={locked?undefined:(i,x,y)=>field(i,{x,y})}/>:<p className="real-alert">Confira as medidas: números em milímetros com até uma casa decimal e campos dentro da etiqueta.</p>}
    <p className="real-help">Arraste um campo para posicioná-lo ou informe X e Y. Dados de exemplo.</p></section></div>
   <footer className="real-editor-actions"><button type="button" className="secondary-button" disabled={busy} onClick={back}>Voltar</button><button type="button" className="primary-button" disabled={locked||!valid||Boolean(mode.template)&&!dirty} onClick={submit}>{busy?'Salvando…':'Salvar'}</button></footer>
  </div>;
 }
 if(mode.type==='print'){const t=mode.template,n=Number(copies),copiesOk=/^\d{1,3}$/.test(copies)&&n>=1&&n<=100,invoice=mode.invoice;
  const find=async()=>{let q;try{q=captureLabelRecordsQuery({tipo:t.type,...(query.trim()?{busca:query.trim()}:{})});}catch{setError('A pesquisa aceita até 60 caracteres.');return;}
   finder.current?.abort();const p=new AbortController();finder.current=p;setFinding(true);setError('');
   try{const raw=await controller.system(labelRecordsPath(q),{method:'GET',signal:p.signal});if(p.signal.aborted||finder.current!==p||!may())return;const r=parseLabelRecords(raw,q);setRecords(r);setChosen(list=>list.filter(id=>r.items.some(i=>i.id===id)));}
   catch(e){if(!p.signal.aborted&&finder.current===p&&!aborted(e)&&may())setError(statusOf(e)===403?'Seu perfil não consulta estes registros.':'Não foi possível pesquisar os registros. Tente novamente.');}
   finally{if(finder.current===p){finder.current=null;setFinding(false);}}};
  const items=invoice?invoice.items.filter(i=>chosen.includes(i.id)).flatMap(i=>Array.from({length:byQuantity?i.copies:copiesOk?n:1},()=>i))
   :(records?.items??[]).filter(i=>chosen.includes(i.id)).flatMap(i=>Array.from({length:copiesOk?n:1},()=>i)),per=labelsPerPage(t.config),[pw,ph]=pageSize(t.config);
  const productModels=(view?.items??[]).filter(m=>m.type==='produto');
  const pages=Array.from({length:Math.ceil(items.length/per.total)},(_,k)=>items.slice(k*per.total,(k+1)*per.total));
  return <div className="real-labels">
   <OriginListHeader title={`Imprimir etiquetas · ${t.description}`} primary={<button type="button" className="secondary-button" onClick={back}><Icon name="chevron-left" size={11}/>Voltar</button>}/>
   {error&&<p className="real-alert" role="alert">{error}</p>}
   {invoice?<section className="labels-invoice" aria-label="Produtos da nota"><p className="real-help">Produtos da nota fiscal {invoice.number?`nº ${invoice.number}`:'(rascunho, sem número)'}: uma etiqueta por unidade de cada item.</p>
    <div className="reports-inline"><label className="form-field">Modelo de etiqueta<select id="labels-invoice-model" value={t.id} onChange={e=>{const m=productModels.find(x=>x.id===e.target.value);if(m)setMode({type:'print',template:m,invoice});}}>
     {productModels.map(m=><option key={m.id} value={m.id}>{m.description}</option>)}</select></label>
     <label className="preference-switch"><input id="labels-by-quantity" type="checkbox" checked={byQuantity} onChange={e=>setByQuantity(e.target.checked)}/><span>Cópias pela quantidade da nota</span></label>
     {!byQuantity&&<label className="form-field">Cópias de cada<input id="labels-copies" inputMode="numeric" maxLength={3} value={copies} onChange={e=>setCopies(e.target.value)}/></label>}</div>
    <ul className="labels-records">{invoice.items.map(i=><li key={i.id}><label className="preference-check"><input type="checkbox" id={`labels-record-${i.id}`} checked={chosen.includes(i.id)} onChange={e=>setChosen(list=>e.target.checked?[...list,i.id]:list.filter(x=>x!==i.id))}/>
     <span>{[i.values.codigo,i.values.descricao].filter(Boolean).join(' · ')} · {i.copies} etiqueta(s)</span></label></li>)}</ul>
    {!invoice.items.length&&<p className="empty-state">A nota não tem itens.</p>}</section>:<>
   <form className="reports-inline" role="search" onSubmit={e=>{e.preventDefault();void find();}}><input type="search" id="labels-records-search" aria-label={`Pesquisar ${LABEL_TYPE_LABELS[t.type]}`} placeholder={`Pesquisar ${LABEL_TYPE_LABELS[t.type].toLowerCase()}`} maxLength={60} value={query} onChange={e=>setQuery(e.target.value)}/>
    <button type="submit" className="secondary-button" disabled={finding}>{finding?'Pesquisando…':'Pesquisar'}</button>
    <label className="form-field">Cópias de cada<input id="labels-copies" inputMode="numeric" maxLength={3} value={copies} onChange={e=>setCopies(e.target.value)}/></label></form>
   {records&&<ul className="labels-records">{records.items.map(i=><li key={i.id}><label className="preference-check"><input type="checkbox" id={`labels-record-${i.id}`} checked={chosen.includes(i.id)} onChange={e=>setChosen(list=>e.target.checked?[...list,i.id]:list.filter(x=>x!==i.id))}/>
    <span>{Object.values(i.values).filter(Boolean).slice(0,3).join(' · ')}</span></label></li>)}</ul>}
   {records&&!records.items.length&&<p className="empty-state">Nenhum registro encontrado.</p>}</>}
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={!items.length||!(copiesOk||invoice&&byQuantity)} onClick={()=>setSheet(true)}><Icon name="print" size={12}/>Visualizar impressão</button>
    <span className="real-help">{items.length} etiqueta(s) em {pages.length} página(s) de {per.total}.</span></div>
   {sheet&&createPortal(<div className="labels-print-root" role="dialog" aria-modal="true" aria-label="Impressão de etiquetas"><header className="labels-print-controls"><h2>Prévia de impressão · {items.length} etiqueta(s)</h2>
     <div><button type="button" className="secondary-button" onClick={()=>setSheet(false)}>Fechar prévia</button><button type="button" className="primary-button" onClick={()=>window.print()}>Imprimir etiquetas</button></div></header>
    <div className="labels-print-scroll">{pages.map((list,k)=><div key={k} className="labels-print-page" style={{width:`${pw}mm`,height:`${ph}mm`,paddingLeft:`${t.config.page.margin_left}mm`,paddingTop:`${t.config.page.margin_top}mm`,
     gridTemplateColumns:`repeat(${per.cols}, ${t.config.label.width}mm)`,gridAutoRows:`${t.config.label.height}mm`,columnGap:`${t.config.label.columns_gap}mm`,rowGap:`${t.config.label.rows_gap}mm`}}>
     {list.map((i,j)=><LabelSvg key={`${i.id}:${j}`} type={t.type} config={t.config} values={i.values}/>)}</div>)}</div></div>,document.body)}
  </div>;}
 const term=search.trim().toLowerCase(),items=(view?.items??[]).filter(t=>(!typeFilter||t.type===typeFilter)&&(!term||t.description.toLowerCase().includes(term)));
 const defaults=items.filter(t=>t.default),customs=items.filter(t=>!t.default);
 const remove=()=>{if(!confirm)return;start({operation:'labels-delete',body:captureFrameworkDelete({command_id:crypto.randomUUID(),items:[{id:confirm.id,expected_version:confirm.version}]}),path:LABELS_DELETE_PATH});};
 const row=(t:LabelTemplate)=><li key={t.id}><div><strong>{t.description}</strong><small>{LABEL_TYPE_LABELS[t.type]} · {t.config.label.width} × {t.config.label.height} mm · {t.config.fields.length} campo(s)</small></div>
  <div className="reports-actions">{!t.default&&<button type="button" className="text-button" disabled={locked} onClick={()=>openEdit(t,false)}>Editar</button>}
   <button type="button" className="text-button" disabled={locked} onClick={()=>openEdit(t,true)}>Clonar</button>
   <button type="button" className="text-button" disabled={locked||!LABEL_PRINTABLE.includes(t.type)} onClick={()=>openPrint(t)}>Imprimir</button>
   {!t.default&&<button type="button" className="text-button" disabled={locked} onClick={()=>setConfirm(t)}>Excluir</button>}</div></li>;
 return <div className="real-labels">
  <OriginListHeader title="Etiquetas customizadas"/>
  <div className="reports-inline reports-toolbar"><input type="search" id="labels-search" aria-label="Pesquisar etiquetas" placeholder="Pesquisar" maxLength={80} value={search} onChange={e=>setSearch(e.target.value)}/>
   <label className="form-field">Tipo de etiqueta<select id="labels-type" value={typeFilter} onChange={e=>setTypeFilter(e.target.value as LabelType|'')}><option value="">Todos</option>{LABEL_TYPES.map(t=><option key={t} value={t}>{LABEL_TYPE_LABELS[t]}</option>)}</select></label></div>
  {loadError&&<p className="real-alert" role="alert">{loadError}</p>}{error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}{loading&&<p role="status" className="real-help">Carregando etiquetas…</p>}
  {pending&&attempt.current&&<section className="real-notice" aria-label="Confirmação pendente"><p>Comando {attempt.current.body.command_id}: o resultado precisa ser confirmado antes de alterar de novo.</p>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={busy} onClick={()=>void runCommand(attempt.current!)}>Conferir resultado</button></div></section>}
  {view&&<><section className="reports-section"><h2>Padrões ({defaults.length})</h2><ul className="reports-list">{defaults.map(row)}</ul></section>
   <section className="reports-section"><h2>Customizadas ({customs.length})</h2><ul className="reports-list">{customs.map(row)}</ul>
    {!customs.length&&<p className="empty-state">Nenhuma etiqueta customizada: edite ou clone uma etiqueta padrão.</p>}</section>
   <p className="real-help reports-totals">Totais — Quantidade: {items.length.toLocaleString('pt-BR')}</p></>}
  {confirm&&<Modal title="Excluir etiqueta" onClose={()=>{if(!busy)setConfirm(null);}} actions={<><button type="button" className="secondary-button" disabled={busy} onClick={()=>setConfirm(null)}>Cancelar</button>
   <button type="button" className="danger-button" disabled={locked} onClick={remove}>{busy?'Excluindo…':'Excluir'}</button></>}><p>Excluir a etiqueta "{confirm.description}"?</p></Modal>}
 </div>;
}
