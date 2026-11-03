import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {fiscalDecimal,fiscalUnitPrice,fiscalMoment,type FiscalDraftEnvelope} from '../lib/fiscal-drafts-model';
import {fiscalReviewPath,fiscalReviewView,type FiscalReviewView} from '../lib/fiscal-review-model';
import {ITEM_FIELDS,ITEM_LABELS,ITEM_PENDING,choicesFromReceipt,fiscalItemEnvelope,fiscalItemHistory,fiscalItemWrite,itemValueValid,itemChoicesKey,
 type FiscalItemController,type FiscalItemEnvelope,type FiscalItemHistory,type ItemChoices,type ItemChoice,type ItemField,type ItemWrite} from '../lib/fiscal-item-model';
import './fiscal-item-preparation.css';

const BASE='/v1/preparacao-itens-fiscais';
const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const message=(e:unknown)=>e instanceof AccessError?e.status===409?'A versão do rascunho, preparação ou produto mudou. Recarregue e confira novamente as escolhas.':e.status===403?'Seu acesso à preparação fiscal não está disponível.':e.status===400?'Confira os identificadores e as confirmações.':'Não foi possível concluir a consulta. Tente novamente.':e instanceof Error?e.message:'Não foi possível conferir a preparação.';
const plain=(v:string|null|undefined)=>v??'Não informado';
type Props={controller:FiscalItemController;value:FiscalDraftEnvelope;blocked?:boolean;onBusy?:(busy:boolean)=>void;onDraft?:(dirty:boolean)=>void;onChanged?:()=>void};

/** The parent keys this section by the exact022 revision/hash. Never carries choices across revisions. */
export default function FiscalItemPreparation({controller,value,blocked=false,onBusy,onDraft,onChanged}:Props){
 const uid=useId(),id=value.record.id,revision=value.record.version,hash=value.record.snapshot_hash;
 const [latest,setLatest]=useState<FiscalItemEnvelope|null>(null),[catalog,setCatalog]=useState<FiscalReviewView|null>(null);
 const [choices,setChoices]=useState<ItemChoices>({}),[baseline,setBaseline]=useState(itemChoicesKey({})),[selected,setSelected]=useState(0);
 const [preview,setPreview]=useState<FiscalItemEnvelope|null>(null),[previewBody,setPreviewBody]=useState<ItemWrite|null>(null),[confirmed,setConfirmed]=useState(false);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[retry,setRetry]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
 const [historyOpen,setHistoryOpen]=useState(false),[history,setHistory]=useState<FiscalItemHistory|null>(null),[historyCursors,setHistoryCursors]=useState<(number|null)[]>([null]),[historical,setHistorical]=useState<FiscalItemEnvelope|null>(null);
 const request=useRef<AbortController|null>(null),command=useRef<ItemWrite|null>(null),saved=useRef<number|null>(null),uncertain=useRef(false);
 const currentProps=useRef({value,blocked,onChanged});currentProps.current={value,blocked,onChanged};
 const dirty=itemChoicesKey(choices)!==baseline||Boolean(preview),guard=useUnsavedChanges(dirty,busy||retry);
 useLayoutEffect(()=>{onDraft?.(dirty);},[dirty,onDraft]);useLayoutEffect(()=>{onBusy?.(busy||retry||loading);},[busy,retry,loading,onBusy]);
 useLayoutEffect(()=>()=>{onDraft?.(false);onBusy?.(false);},[onDraft,onBusy]);
 useEffect(()=>()=>request.current?.abort(),[]);
 const canReset=()=>!request.current&&!command.current&&!saved.current&&!uncertain.current;
 const clearPreview=()=>{setPreview(null);setPreviewBody(null);setConfirmed(false);};
 const accept=(next:FiscalItemEnvelope)=>{
  const initial=choicesFromReceipt(next.record,value);setLatest(next);setChoices(initial);setBaseline(itemChoicesKey(initial));setConflict(false);clearPreview();
 };
 useEffect(()=>{
  const pending=new AbortController();request.current=pending;setLoading(true);setError('');setLatest(null);setCatalog(null);setChoices({});setBaseline(itemChoicesKey({}));setSelected(0);clearPreview();
  void (async()=>{
   const [raw,comparison]=await Promise.all([controller.fiscalItem(`${BASE}/${id}`,{signal:pending.signal}),controller.fiscalDraft(fiscalReviewPath(id,revision),{signal:pending.signal})]);
   if(pending.signal.aborted)return;
   const next=fiscalItemEnvelope(raw,id),checked=fiscalReviewView(comparison,id,revision,hash);
   accept(next);setCatalog(checked);
  })().catch(e=>{if(!pending.signal.aborted&&!aborted(e))setError(message(e));}).finally(()=>{if(!pending.signal.aborted){request.current=null;setLoading(false);}});
  return()=>pending.abort();
 },[controller,id,revision,hash,reload]);
 const parentHistorical=value.current.version!==revision||value.current.status!=='draft';
 const contextChanged=Boolean(latest&&(latest.current.draft_version!==revision||latest.draft.current.status!=='draft'||latest.draft.current.source_status==='cancelled'));
 const readOnly=parentHistorical||contextChanged||Boolean(historical)||historyOpen;
 const locked=blocked||loading||busy||retry||conflict||!latest||!catalog||readOnly;
 const editableNow=()=>canReset()&&!currentProps.current.blocked&&!loading&&!conflict&&!parentHistorical&&!contextChanged&&!historyOpen&&!historical&&Boolean(latest&&catalog);
 const reloadAll=()=>{if(!canReset())return;guard.confirmLeave(()=>{if(!canReset())return;setHistoryOpen(false);setHistorical(null);setHistory(null);setHistoryCursors([null]);setNotice('');setReload(n=>n+1);});};
 const update=(itemId:string,field:ItemField,choice:ItemChoice|null)=>{
  if(!editableNow())return;setChoices(old=>{const fields={...old[itemId]};if(choice)fields[field]=choice;else delete fields[field];const next={...old};if(Object.keys(fields).length)next[itemId]=fields;else delete next[itemId];return next;});clearPreview();setNotice('');setError('');
 };
 const discard=()=>{if(!canReset())return;guard.confirmLeave(()=>{if(!canReset()||!latest)return;accept(latest);setError('');setNotice('Alterações locais descartadas.');});};
 const doPreview=async()=>{
  if(!editableNow()||!latest)return;let body:ItemWrite;try{body=fiscalItemWrite(value,latest.current.preparation_version,choices);}catch(e){setError(message(e));return;}
  const pending=new AbortController();request.current=pending;setBusy(true);setError('');setNotice('');clearPreview();
  try{const next=fiscalItemEnvelope(await controller.fiscalItem(`${BASE}/${id}/preview`,{method:'POST',body,signal:pending.signal}),id,{request:body,preview:true});if(pending.signal.aborted)return;setPreview(next);setPreviewBody(structuredClone(body));}
  catch(e){if(!pending.signal.aborted&&!aborted(e)){setError(message(e));if(e instanceof AccessError&&e.status===409)setConflict(true);}}
  finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 const execute=async()=>{
  if(request.current||!command.current)return;const priorUncertain=uncertain.current,pending=new AbortController();request.current=pending;setBusy(true);setRetry(false);setError('');
  try{
   if(saved.current===null){const response=fiscalItemEnvelope(await controller.fiscalItem(`${BASE}/${id}`,{method:'POST',body:command.current,signal:pending.signal}),id,{request:command.current});if(pending.signal.aborted)return;saved.current=response.record!.version;}
   const current=fiscalItemEnvelope(await controller.fiscalItem(`${BASE}/${id}`,{signal:pending.signal}),id);
   if(pending.signal.aborted)return;if(!current.record||current.record.version!==current.current.preparation_version||current.record.version<saved.current)throw new Error('A versão atual ainda não pôde ser conferida.');
   command.current=null;saved.current=null;uncertain.current=false;setRetry(false);accept(current);setHistory(null);setNotice('Preparação registrada. A versão atual foi consultada; a emissão continua indisponível.');currentProps.current.onChanged?.();
  }catch(e){if(!pending.signal.aborted&&!aborted(e)){
   const known=e instanceof AccessError&&[400,403,404,409].includes(e.status)&&saved.current===null&&!priorUncertain;
   uncertain.current=!known;setRetry(!known);setConflict(known&&e.status===409);
   if(known){command.current=null;clearPreview();setError(message(e));}
   else setError(saved.current!==null?'A preparação foi registrada, mas a consulta da versão atual falhou. Consulte novamente antes de editar.':'O resultado permanece incerto. Os campos e o mesmo comando estão preservados; repita a confirmação para conferir o resultado.');
  }}finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 const save=()=>{
  if(!editableNow()||!confirmed||!preview||!previewBody||!latest)return;
  if(JSON.stringify(fiscalItemWrite(value,latest.current.preparation_version,choices))!==JSON.stringify(previewBody)){setError('Refaça a prévia após alterar as escolhas.');return;}
  command.current={...structuredClone(previewBody),command_id:crypto.randomUUID()};saved.current=null;void execute();
 };
 const loadHistory=async(before:number|null)=>{
  if(!canReset())return;const pending=new AbortController();request.current=pending;setBusy(true);setError('');setHistory(null);
  try{const page=fiscalItemHistory(await controller.fiscalItem(`${BASE}/${id}/history?limit=25${before===null?'':`&before=${before}`}`,{signal:pending.signal}),id,before);if(!pending.signal.aborted)setHistory(page);}
  catch(e){if(!pending.signal.aborted)setError(message(e));}finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 const openHistory=()=>{if(!canReset())return;guard.confirmLeave(()=>{if(!canReset())return;if(latest)accept(latest);setHistoryOpen(true);setHistorical(null);setHistoryCursors([null]);void loadHistory(null);});};
 const viewHistory=async(version:number)=>{
  if(!canReset())return;const pending=new AbortController();request.current=pending;setBusy(true);setError('');setHistorical(null);
  try{const next=fiscalItemEnvelope(await controller.fiscalItem(`${BASE}/${id}?version=${version}`,{signal:pending.signal}),id,{version});if(!pending.signal.aborted){setHistorical(next);setSelected(0);}}
  catch(e){if(!pending.signal.aborted)setError(message(e));}finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 const displayDraft=historical?.draft??value,items=displayDraft.record.snapshot.items,item=items[Math.min(selected,items.length-1)];
 const displayReceipt=historical?.record??(latest?.record?.draft_version===revision&&latest.record.snapshot_hash===hash?latest.record:null);
 const resolved=(historical??preview)?.record?.items.find(i=>i.item_id===item.id)??displayReceipt?.items.find(i=>i.item_id===item.id);
 const currentProduct=catalog?.basis.catalog.find(p=>p.product_id===item.product_id)?.record??null;
 const initialField=(field:ItemField)=>displayReceipt?.items.find(i=>i.item_id===item.id)?.fields[field];
 const chosenValue=(field:ItemField)=>{const c=choices[item.id]?.[field];if(!c)return null;if(c.source==='manual')return c.value;
  if(currentProduct?.version===c.expected_version)return currentProduct[field];const savedValue=initialField(field);return savedValue?.provenance.source==='catalog'&&savedValue.provenance.product_version===c.expected_version?savedValue.value:null;};
 return <section className="fiscal-item-preparation" aria-labelledby={`${uid}-title`} aria-busy={loading||busy}>
  <header className="fiscal-item-heading"><div><h3 id={`${uid}-title`}>Preparação dos identificadores dos itens</h3><p>Revisão {revision} do rascunho · {latest?.current.preparation_version?`preparação ${latest.current.preparation_version}`:'sem preparação salva'}</p></div><div className="button-group"><button type="button" className="secondary-button" disabled={loading||busy||retry} onClick={reloadAll}>Recarregar preparação e catálogo</button><button type="button" className="secondary-button" disabled={loading||busy||retry} onClick={openHistory}>Histórico da preparação</button></div></header>
  <p className="real-notice">Escolhas de identificação não validam classificação, CEST aplicável ou cadastro GTIN. CFOP, CST/CSOSN e tributos continuam pendentes. Não há emissão nesta etapa.</p>
  {loading&&<p role="status">Consultando preparação e catálogo…</p>}{error&&<p className="real-alert" role="alert">{error}</p>}{notice&&<p className="real-success" role="status">{notice}</p>}
  {retry&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void execute()}>{saved.current!==null?'Consultar preparação salva':'Repetir a mesma confirmação'}</button>}
  {contextChanged&&<p className="real-notice">O rascunho atual mudou ou não permite novas decisões. Recarregue a versão atual do rascunho no início da página.</p>}
  {latest?.record&&!latest.current.matches_current_draft&&<p className="real-notice">A última preparação pertence à revisão {latest.record.draft_version}. Suas escolhas continuam no histórico e não foram aplicadas à revisão {revision}.</p>}
  {parentHistorical&&<p className="real-help">Esta revisão do rascunho é somente para consulta. Abra o histórico para ver preparações já registradas.</p>}
  {historyOpen&&<section className="fiscal-item-history"><h4>Versões registradas da preparação</h4><button type="button" className="secondary-button" disabled={busy||retry} onClick={()=>{if(canReset()){setHistoryOpen(false);setHistorical(null);setSelected(0);}}}>Voltar à preparação atual</button>
   {history&&<><div className="table-scroll"><table className="data-table"><thead><tr><th>Preparação</th><th>Revisão do rascunho</th><th>Registrada em</th><th>Consultar</th></tr></thead><tbody>{history.items.map(row=><tr key={row.version}><th scope="row">{row.version}</th><td>{row.draft_version}</td><td>{fiscalMoment(row.created_at!)}</td><td><button type="button" className="text-button" disabled={busy||retry} onClick={()=>void viewHistory(row.version)}>Consultar preparação {row.version}</button></td></tr>)}</tbody></table></div>{!history.items.length&&<p>Nenhuma preparação registrada.</p>}
    <div className="table-footer"><span>Página {historyCursors.length}</span><div className="button-group"><button type="button" className="secondary-button" disabled={busy||retry||historyCursors.length===1} onClick={()=>{if(!canReset())return;const cursors=historyCursors.slice(0,-1);setHistoryCursors(cursors);void loadHistory(cursors.at(-1)??null);}}>Histórico anterior</button><button type="button" className="secondary-button" disabled={busy||retry||!history.has_more} onClick={()=>{if(!canReset())return;setHistoryCursors(v=>[...v,history.next_cursor]);void loadHistory(history.next_cursor);}}>Mais antigas</button></div></div></>}
   {historical&&<p className="real-notice">Consulta imutável da preparação {historical.record!.version}, vinculada à revisão {historical.record!.draft_version}. Valores e proveniência pertencem àquela captura.</p>}
  </section>}
  {!loading&&latest&&(!historyOpen||historical)&&(!parentHistorical||historical)&&<>
   <div className="fiscal-item-workspace"><aside className="fiscal-item-selector"><label htmlFor={`${uid}-item`}>Item a conferir</label><select id={`${uid}-item`} size={Math.min(8,items.length)} value={item.id} disabled={busy||retry} onChange={e=>{if(canReset())setSelected(items.findIndex(i=>i.id===e.target.value));}}>{items.map(i=><option key={i.id} value={i.id}>{i.position}. {i.description}{choices[i.id]&&!historical?' · escolha registrada no formulário':''}</option>)}</select><p className="real-help">{items.length} itens · {readOnly?'selecione um item para consultar.':'apenas o item selecionado é editado.'}</p></aside>
    <div className="fiscal-item-fields"><h4>{item.position}. {item.description}</h4><p className="real-help">{item.code||'Sem código'} · {item.product_id?'Produto vinculado':'Item livre; sem captura de catálogo'}</p><dl className="fiscal-item-commercial"><div><dt>Quantidade comercial</dt><dd>{fiscalDecimal(item.quantity)} {item.unit}</dd></div><div><dt>Preço comercial</dt><dd>{fiscalUnitPrice(item.unit_price)}</dd></div><div><dt>Total comercial</dt><dd>{fiscalDecimal(item.total,true)}</dd></div></dl>
     {ITEM_FIELDS.map(field=>{
      const choice=choices[item.id]?.[field],entry=resolved?.fields[field],raw=chosenValue(field),mode=!choice?'unreviewed':choice.source==='catalog'?'catalog':choice.value===null?'empty':'manual';
      const invalid=choice?.source==='manual'&&!itemValueValid(choice.value,field),fieldId=`${uid}-${field}`,catalogValue=currentProduct?.[field]??null;
      return <fieldset key={field} className="fiscal-item-field" disabled={locked}><legend>{ITEM_LABELS[field]}</legend>{historical||parentHistorical?<><p><strong>{plain(entry?.value)}</strong></p><p className="real-help">{entry?.provenance.source==='catalog'?`Capturado do catálogo v${entry.provenance.product_version}${entry.provenance.active?'':' · inativo'}`:entry?.provenance.source==='manual'?'Informado manualmente':'Não conferido'}</p></>:<>
       <label htmlFor={`${fieldId}-source`}>Escolha para {ITEM_LABELS[field]}</label><select id={`${fieldId}-source`} value={mode} onChange={e=>update(item.id,field,e.target.value==='unreviewed'?null:{source:'manual',value:e.target.value==='empty'?null:''})}><option value="unreviewed">Não conferido</option><option value="manual">Informar manualmente</option><option value="empty">Não informado — manter pendência</option>{mode==='catalog'&&<option value="catalog">Valor do catálogo confirmado</option>}</select>
       {mode==='manual'&&<><label htmlFor={fieldId}>Valor de {ITEM_LABELS[field]}</label>{field==='origin'?<select id={fieldId} value={raw??''} aria-invalid={invalid} aria-describedby={`${fieldId}-help`} onChange={e=>update(item.id,field,{source:'manual',value:e.target.value})}><option value="">Escolha o código</option>{['0','1','2','3','4','5','6','7','8'].map(v=><option key={v} value={v}>{v}</option>)}</select>:<input id={fieldId} value={raw??''} maxLength={field==='ncm'?8:field==='cest'?7:14} autoComplete="off" aria-invalid={invalid} aria-describedby={`${fieldId}-help`} onChange={e=>update(item.id,field,{source:'manual',value:e.target.value})}/>}</>}
       {mode==='catalog'&&<p className="fiscal-item-captured">Valor capturado: <strong>{plain(raw)}</strong> · versão {choice?.source==='catalog'?choice.expected_version:''}{choice?.source==='catalog'&&currentProduct?.version!==choice.expected_version&&<small>O cadastro consultado tem outra versão. Confirme novamente para usar seu valor atual.</small>}</p>}
       <div className="fiscal-item-catalog"><span>Catálogo atual: <strong>{plain(catalogValue)}</strong>{currentProduct?` · v${currentProduct.version}${currentProduct.active?'':' · inativo'}`:' · indisponível'}</span><button type="button" className="text-button" disabled={locked||!currentProduct} onClick={()=>{if(currentProduct)update(item.id,field,{source:'catalog',expected_product_id:currentProduct.id,expected_version:currentProduct.version});}}>Usar {ITEM_LABELS[field]} do catálogo</button></div>
       {(field==='gtin'||field==='gtin_tax')&&<button type="button" className="text-button" onClick={()=>update(item.id,field,{source:'manual',value:'SEM GTIN'})}>Declarar SEM GTIN para {ITEM_LABELS[field]}</button>}
      </>}<small id={`${fieldId}-help`} className={invalid?'fiscal-item-error':'real-help'}>{invalid?'Formato ou dígito inválido. Confira o valor antes da prévia.':field==='ncm'?'Formato: 2 ou 8 dígitos. Classificação e exceção não verificadas.':field==='origin'?'Código estrutural 0–8. A origem efetiva deve ser conferida.':field==='cest'?'7 dígitos quando informado. Ausência não significa inaplicabilidade.':'Código com dígito verificador ou declaração explícita SEM GTIN; atribuição ao produto não verificada.'}</small></fieldset>;
     })}
     {resolved&&<details className="fiscal-item-pending"><summary>{resolved.pending.length} pendências {preview&&!historical?'da prévia':'da versão salva'} para o item</summary><ul>{resolved.pending.map(code=><li key={code}>{ITEM_PENDING[code]||'Conferência fiscal pendente.'}</li>)}</ul></details>}
    </div>
   </div>
   {!readOnly&&<div className="fiscal-item-actions"><button type="button" className="primary-button" disabled={locked} onClick={()=>void doPreview()}>Conferir prévia dos itens</button><button type="button" className="secondary-button" disabled={locked||!dirty} onClick={discard}>Descartar escolhas locais</button></div>}
   {preview&&!readOnly&&<section className="fiscal-item-preview"><h4>Prévia conferida no servidor</h4><p>{preview.record!.items.length} itens · nova preparação {preview.record!.version} · revisão {preview.record!.draft_version}. A conferência não calculou tributos nem habilitou emissão.</p><p className="real-help">As escolhas de todos os itens serão registradas juntas. Dados não escolhidos continuam pendentes.</p>
    <label className="fiscal-check"><input type="checkbox" checked={confirmed} disabled={locked} onChange={e=>{if(editableNow())setConfirmed(e.target.checked);}}/>Conferi as escolhas e quero registrar esta versão sem emissão.</label><button type="button" className="primary-button" disabled={locked||!confirmed} onClick={save}>Salvar versão da preparação</button>
   </section>}
  </>}
 </section>;
}
