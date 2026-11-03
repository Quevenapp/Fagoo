import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {AccessError,type AccessController} from '../lib/real-access';
// Estoque lane (184): "Depósitos" of Origin, the warehouse of this lançamento.
import {StockDocumentWarehouse} from './StockSupplierPicker';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {quantityText,stockDate} from '../lib/stock-model';
import {documentStockPreviewInput,documentStockMutationInput,documentStockLotsText,type DocumentStockPage,type DocumentStockPreview,type DocumentStockResult} from '../lib/document-stock-model';
import type {DocumentRecord} from '../lib/real-documents-model';
import './document-stock.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
const dateText=(value:string)=>value.split('-').reverse().join('/');
const message=(e:unknown)=>e instanceof AccessError?e.status===409?'Os dados mudaram ou existe um efeito que impede esta ação. Atualize o documento e faça uma nova conferência.'
 :e.status===400?'Confira a data, o motivo, o depósito, a unidade dos produtos e o saldo disponível. Composições precisam da estrutura (aba Estrutura do produto) com componentes ativos; produtos com variações não lançam estoque. Os lotes informados nos itens precisam ser ativos, do produto com Controle de lote, com saldo no depósito e sem passar da quantidade do item.'
 :e.status===403?'Seu perfil não permite esta operação.':'Não foi possível confirmar a operação. Você pode tentar novamente com a mesma conferência.'
 :e instanceof Error?e.message:'Não foi possível concluir a operação.';

export interface DocumentStockProps {
 controller:AccessController;record:Pick<DocumentRecord,'id'|'kind'|'version'>;blocked:boolean;canAct?:()=>boolean;
 /** Preferências › Estoque "data atual ou data entrada/saída" (202610200164): the day of a lançamento, shown without a field (277).
  * Absent while the preference is unknown: the date is asked, today by default. */
 launchDay?:string;
 onChanged:(version:number)=>Promise<void>|void;onActive:(active:boolean|null)=>void;onBusy:(busy:boolean)=>void;onDraft:(dirty:boolean)=>void;
}
export default function DocumentStock({controller,record,blocked,canAct,onChanged,onActive,onBusy,onDraft,launchDay}:DocumentStockProps){
 const base=`/v1/documentos-estoque/${record.kind}/${record.id}`,uid=useId();
 const [page,setPage]=useState<DocumentStockPage|null>(null),[loading,writeLoading]=useState(true),[busy,writeBusy]=useState(false),[error,setError]=useState('');
 const [after,setAfter]=useState<string|null>(null),[history,setHistory]=useState<(string|null)[]>([]),[reload,setReload]=useState(0);
 const firstDay=()=>launchDay&&/^\d{4}-\d{2}-\d{2}$/.test(launchDay)&&launchDay<=stockDate()?launchDay:stockDate();
 const [initialDate]=useState(firstDay),[day,writeDay]=useState(firstDay),[reason,writeReason]=useState(''),[review,writeReview]=useState<DocumentStockPreview|null>(null);
 const [warehouse,setWarehouse]=useState('');
 const [confirmed,writeConfirmed]=useState(false),[ignoredConfirmed,writeIgnoredConfirmed]=useState(false),[refreshRequired,writeRefreshRequired]=useState(false),[uncertain,writeUncertain]=useState(false);
 const request=useRef<AbortController|null>(null),command=useRef<{path:string;body:Record<string,unknown>;uncertain:boolean}|null>(null),stored=useRef(false),callbacks=useRef({onChanged,onActive,onBusy,onDraft});callbacks.current={onChanged,onActive,onBusy,onDraft};
 // Publish coordination before React renders so retained siorigin handlers cannot race.
 const coordination=useRef({loading,busy,day,reason,review,confirmed,ignoredConfirmed,refreshRequired,uncertain});coordination.current={loading,busy,day,reason,review,confirmed,ignoredConfirmed,refreshRequired,uncertain};
 const publish=()=>{const s=coordination.current;callbacks.current.onDraft(Boolean(s.day!==initialDate||s.reason||s.review||s.confirmed||s.ignoredConfirmed));callbacks.current.onBusy(Boolean(s.loading||s.busy||s.refreshRequired||s.uncertain));};
 const sync=<K extends keyof typeof coordination.current,>(key:K,value:(typeof coordination.current)[K],write:(value:(typeof coordination.current)[K])=>void)=>{coordination.current[key]=value;write(value);publish();};
 const setLoading:typeof writeLoading=value=>sync('loading',typeof value==='function'?value(coordination.current.loading):value,writeLoading);
 const setBusy:typeof writeBusy=value=>sync('busy',typeof value==='function'?value(coordination.current.busy):value,writeBusy);
 const setDay:typeof writeDay=value=>sync('day',typeof value==='function'?value(coordination.current.day):value,writeDay);
 const setReason:typeof writeReason=value=>sync('reason',typeof value==='function'?value(coordination.current.reason):value,writeReason);
 const setReview:typeof writeReview=value=>sync('review',typeof value==='function'?value(coordination.current.review):value,writeReview);
 const setConfirmed:typeof writeConfirmed=value=>sync('confirmed',typeof value==='function'?value(coordination.current.confirmed):value,writeConfirmed);
 const setIgnoredConfirmed:typeof writeIgnoredConfirmed=value=>sync('ignoredConfirmed',typeof value==='function'?value(coordination.current.ignoredConfirmed):value,writeIgnoredConfirmed);
 const setRefreshRequired:typeof writeRefreshRequired=value=>sync('refreshRequired',typeof value==='function'?value(coordination.current.refreshRequired):value,writeRefreshRequired);
 const setUncertain:typeof writeUncertain=value=>sync('uncertain',typeof value==='function'?value(coordination.current.uncertain):value,writeUncertain);
 const mayEdit=()=>!blocked&&!request.current&&!command.current&&!coordination.current.loading&&!coordination.current.busy&&!coordination.current.refreshRequired&&!coordination.current.uncertain&&canAct?.()!==false;
 const reloadList=(change:()=>void)=>{const s=coordination.current;if(!mayEdit()||s.day!==initialDate||s.reason||s.review||s.confirmed||s.ignoredConfirmed)return;setLoading(true);change();};
 const role=controller.getSnapshot().membership?.role,permitted=Boolean(role&&['admin','estoque'].includes(role)&&record.kind!=='sales_proposals');
 const dirty=Boolean(day!==initialDate||reason||review||confirmed||ignoredConfirmed),guard=useUnsavedChanges(dirty||uncertain,busy||refreshRequired||uncertain);
 useLayoutEffect(publish,[loading,busy,day,reason,review,confirmed,ignoredConfirmed,refreshRequired,uncertain]);
 useLayoutEffect(()=>()=>{callbacks.current.onDraft(false);callbacks.current.onBusy(false);},[]);
 useEffect(()=>()=>request.current?.abort(),[]);
 useEffect(()=>{
  if(!permitted)return;const pending=new AbortController();setPage(null);setLoading(true);setError('');callbacks.current.onActive(null);
  const params=new URLSearchParams({limit:'25'});if(after)params.set('after',after);
  void controller.documentStock(`${base}?${params}`,{signal:pending.signal}).then(value=>{
   if(pending.signal.aborted)return;const next=value as DocumentStockPage;setPage(next);setLoading(false);callbacks.current.onActive(Boolean(next.active_posting));
   if(next.document.version!==record.version)setRefreshRequired(true);
  }).catch(e=>{if(!pending.signal.aborted){setError(message(e));setLoading(false);}});
  return()=>pending.abort();
 },[controller,base,record.version,after,reload,permitted]);
 const resetReview=()=>{setReview(null);setConfirmed(false);setIgnoredConfirmed(false);};
 const resetDraft=()=>{resetReview();setDay(initialDate);setReason('');};
 const start=()=>{request.current?.abort();const pending=new AbortController();request.current=pending;setBusy(true);setError('');return pending;};
 const loadCurrent=async(pending:AbortController)=>{
  const params=new URLSearchParams({limit:'25'});if(after)params.set('after',after);
  const result=await controller.documentStock(`${base}?${params}`,{signal:pending.signal}) as DocumentStockPage;
  if(pending.signal.aborted)return;
  if(result.document.id!==record.id||result.document.kind!==record.kind)throw new Error('Não foi possível conferir o documento atualizado.');
  setPage(result);callbacks.current.onActive(Boolean(result.active_posting));await callbacks.current.onChanged(result.document.version);
  if(!pending.signal.aborted){resetDraft();setRefreshRequired(false);}
 };
 const refresh=async()=>{if(busy||uncertain||request.current||canAct?.()===false)return;const pending=start();try{await loadCurrent(pending);}catch(e){if(!aborted(e))setError(message(e));}finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}};
 const conflict=(e:unknown)=>{if(e instanceof AccessError&&e.status===409){resetReview();setRefreshRequired(true);}};
 const prepare=async()=>{
  if(!page||blocked||busy||request.current||loading||refreshRequired||uncertain||review||canAct?.()===false)return;let input;
  try{input=documentStockPreviewInput(page.document,day,reason,stockDate(),page.active_posting??undefined);}catch(e){setError(message(e));return;}
  // 184: a chosen warehouse (document without one, or another one) goes with the preview and the post.
  if(!page.active_posting&&!warehouse&&!page.document.warehouse_id){setError('Selecione o depósito do lançamento.');return;}
  if(!page.active_posting&&warehouse&&warehouse!==page.document.warehouse_id)input={...input,warehouse_id:warehouse};
  const pending=start(),path=page.active_posting?`${base}/${page.active_posting.id}/reverse-preview`:`${base}/preview`;
  try{const response=await controller.documentStock(path,{method:'POST',body:input,signal:pending.signal}) as {preview:DocumentStockPreview};if(!pending.signal.aborted){setReview(response.preview);setConfirmed(false);setIgnoredConfirmed(false);}}
  catch(e){if(!aborted(e)){conflict(e);setError(message(e));}}finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 // Retrying an uncertain outcome reuses the frozen body; only a fresh read can unlock it.
 const execute=async()=>{
  if(busy||request.current||!command.current)return;const pending=start();
  try{if(!stored.current){const result=await controller.documentStock(command.current.path,{method:'POST',body:command.current.body,signal:pending.signal}) as DocumentStockResult;
    if(pending.signal.aborted)return;if(result.document_id!==record.id)throw new Error('Não foi possível conferir o resultado.');
    stored.current=true;setRefreshRequired(true);resetReview();}
   await loadCurrent(pending);if(!pending.signal.aborted){command.current=null;stored.current=false;setUncertain(false);}
  }catch(e){if(!pending.signal.aborted&&!aborted(e)){const known=!stored.current&&!command.current?.uncertain&&e instanceof AccessError&&[400,401,403,404,409].includes(e.status);
    if(!known&&command.current)command.current.uncertain=true;setUncertain(!known);if(known){command.current=null;conflict(e);}setError(stored.current?'Movimentação registrada. Consulte o documento atualizado para continuar.':message(e));}}
  finally{if(!pending.signal.aborted){request.current=null;setBusy(false);}}
 };
 const mutate=async()=>{
  if(!page||!review||blocked||busy||request.current||refreshRequired||uncertain||canAct?.()===false)return;let input;
  try{input=documentStockMutationInput(page.document,review,confirmed,ignoredConfirmed);}catch(e){setError(message(e));return;}
  if(review.action==='post'&&review.warehouse.id!==page.document.warehouse_id)input={...input,warehouse_id:review.warehouse.id};
  const path=review.action==='post'?`${base}/post`:`${base}/${review.posting!.id}/reverse`;
  command.current={path,body:structuredClone({...input,command_id:crypto.randomUUID()}),uncertain:false};stored.current=false;await execute();
 };
 if(!permitted)return null;
 const disabled=blocked||busy||loading||refreshRequired||uncertain,active=page?.active_posting,canPrepare=Boolean(page&&(active||page.document.eligible));
 return <section className="document-section document-stock" aria-labelledby={`${uid}-title`} aria-busy={busy||loading}>
  <div className="document-stock-heading"><h3 id={`${uid}-title`}>Estoque do documento</h3>{active&&<span className="status-badge status-success">Lançamento ativo</span>}</div>
  <p className="real-help">O lançamento usa as quantidades salvas neste documento e o depósito da conferência (o do documento, por padrão). A ação registra {record.kind==='purchase_orders'?'uma entrada':'uma saída'} de estoque e mantém a situação do documento.</p>
  {error&&<p className="real-alert" role="alert">{error}</p>}{loading&&<p role="status">Consultando lançamentos de estoque…</p>}
  {blocked&&<p className="real-notice">Conclua ou descarte as alterações do documento e as conferências de outros módulos antes de movimentar o estoque.</p>}
  {uncertain?<p className="real-notice">Os dados desta confirmação estão preservados até conferir o resultado. <button type="button" className="primary-button" disabled={busy} onClick={()=>void execute()}>{stored.current?'Consultar documento atualizado':'Repetir a mesma confirmação'}</button></p>:refreshRequired?<button type="button" className="primary-button" disabled={busy} onClick={()=>guard.confirmLeave(()=>void refresh())}>Atualizar documento e lançamentos</button>
   :<button type="button" className="text-button" disabled={busy||uncertain||dirty||loading} onClick={()=>reloadList(()=>setReload(v=>v+1))}>Atualizar lançamentos de estoque</button>}
  {active&&<p className="real-notice">Este lançamento protege os dados do documento. Para corrigir quantidades ou depósito, estorne o lançamento inteiro. Outros efeitos ativos também podem impedir alterações.</p>}
  {page&&!loading&&!review&&<>
   {!canPrepare?<p className="real-help">A situação atual não permite lançar o estoque. Confira o andamento do documento.</p>:<>
    <fieldset className="document-stock-fields" disabled={disabled}><legend>{active?'Dados do estorno integral':'Dados da movimentação'}</legend>
     {/* 277 (EST-135): Lançar estoque does not ask the date, as in Origin: today or the date of the document, by Preferências › Suprimentos › Estoque. */}
     {active||!launchDay?<label htmlFor={`${uid}-date`}>Data da movimentação<input id={`${uid}-date`} type="date" min={active?.occurred_on??'1900-01-01'} max={stockDate()} required value={day} onChange={event=>mayEdit()&&setDay(event.target.value)}/></label>
      :<p className="real-help">Data da movimentação: {dateText(day)} (“Ao lançar estoque utilizar data atual ou data entrada/saída”, Preferências › Suprimentos › Estoque).</p>}
     {!active&&<StockDocumentWarehouse controller={controller} id={`${uid}-warehouse`} documentWarehouse={page.document.warehouse_id} value={warehouse} disabled={disabled} onChange={value=>{if(mayEdit())setWarehouse(value);}}/>}
     <label htmlFor={`${uid}-reason`}>Motivo<input id={`${uid}-reason`} maxLength={500} minLength={3} required value={reason} onChange={event=>mayEdit()&&setReason(event.target.value)} placeholder={active?'Descreva a correção necessária':'Descreva a entrada ou saída conferida'}/></label>
    </fieldset>
    <div className="real-editor-actions"><button type="button" className="primary-button" disabled={disabled} onClick={()=>void prepare()}>{active?'Conferir estorno de estoque':'Conferir lançamento de estoque'}</button>
     {dirty&&<button type="button" className="secondary-button" disabled={busy||uncertain} onClick={()=>{if(busy||uncertain||request.current)return;guard.confirmLeave(resetDraft);}}>Descartar conferência</button>}</div>
   </>}
  </>}
  {review&&<section className={`document-stock-review ${review.action==='reverse'?'document-stock-reversal':''}`} aria-label={review.action==='reverse'?'Conferência do estorno de estoque':'Conferência do lançamento de estoque'}>
   <h4>{review.action==='reverse'?'Estornar o lançamento inteiro':review.direction==='receipt'?'Conferir entrada de estoque':'Conferir saída de estoque'}</h4>
   <p>Documento nº <strong>{review.document.number}</strong> · Depósito: <strong>{review.warehouse.name}</strong> · Data: {dateText(review.occurred_on)}</p><p>Motivo: {review.reason}</p>
   <div className="table-scroll" tabIndex={0} aria-label="Quantidades e saldos da conferência"><table className="data-table"><thead><tr><th>Produto</th><th>Un.</th><th className="numeric">Saldo atual</th><th className="numeric">Movimentação</th><th className="numeric">Saldo previsto</th></tr></thead><tbody>{review.positions.map(row=><tr key={`${row.product_id}:${row.warehouse_id}`}>
    <td>{row.product_name}{row.sources.length>1&&<small className="document-stock-sources">Itens agrupados: {row.sources.map(source=>source.position).join(', ')}</small>}{row.sources.filter(source=>source.kit_product_id).map(source=><small className="document-stock-sources" key={source.id}>Componente da composição do item {source.position}: {quantityText(source.kit_quantity??'0')} × {quantityText(source.component_quantity??'0')}</small>)}{documentStockLotsText(row,review.action)&&<small className="document-stock-sources">{documentStockLotsText(row,review.action)}</small>}</td><td>{row.unit}</td><td className="numeric">{quantityText(row.balance_before)}</td><td className="numeric">{quantityText(row.quantity)}</td><td className="numeric">{row.balance_kept?<>{quantityText(row.balance_before)}<small className="document-stock-sources">Saldo mantido: há balanço depois do lançamento (Preferências › Suprimentos › Estoque)</small></>:quantityText(row.balance_after)}</td>
   </tr>)}</tbody></table></div>
   {review.ignored.length>0&&<section className="document-stock-ignored"><h5>Itens que não movimentam estoque</h5><p>Confira todos os itens abaixo. Itens livres não serão transformados em produtos.</p>
    <div className="table-scroll" tabIndex={0} aria-label="Itens excluídos do lançamento"><table className="data-table"><thead><tr><th>Item</th><th>Descrição</th><th>Quantidade</th><th>Motivo</th></tr></thead><tbody>{review.ignored.map(row=><tr key={row.id}><td>{row.position}</td><td>{row.description}</td><td>{quantityText(row.quantity)} {row.unit}</td><td>{row.reason==='service'?'Serviço':'Sem produto vinculado'}</td></tr>)}</tbody></table></div>
    <label className="document-check"><input type="checkbox" checked={ignoredConfirmed} disabled={disabled} onChange={event=>mayEdit()&&setIgnoredConfirmed(event.target.checked)}/>Conferi estes {review.ignored.length} itens e confirmo que ficarão fora da movimentação.</label>
   </section>}
   {review.action==='reverse'&&<p className="real-help">Será criado um movimento oposto ao original. O histórico será preservado; a reversão não pode deixar saldo negativo nem remove outros efeitos ativos do documento.</p>}
   <label className="document-check"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event=>mayEdit()&&setConfirmed(event.target.checked)}/>{review.action==='reverse'?'Conferi os saldos previstos e autorizo o estorno integral.':'Conferi os produtos, depósito e saldos previstos e autorizo esta movimentação.'}</label>
   <div className="real-editor-actions"><button type="button" className="primary-button" disabled={disabled||!confirmed||(review.ignored.length>0&&!ignoredConfirmed)} onClick={()=>void mutate()}>{busy?'Registrando…':review.action==='reverse'?'Confirmar estorno integral':'Lançar estoque confirmado'}</button><button type="button" className="secondary-button" disabled={busy||uncertain} onClick={()=>{if(busy||uncertain||request.current)return;resetReview();}}>Voltar aos dados</button></div>
   {busy&&<p className="real-help" role="status">{review.action==='reverse'?'Estornando estoque, aguarde...':'Lançando estoque...'}</p>}
  </section>}
  {page&&<><h4>Histórico de estoque deste documento</h4>{!page.postings.length?<p className="real-help">Nenhum lançamento de estoque registrado.</p>:<div className="table-scroll" tabIndex={0} aria-label="Histórico de lançamentos"><table className="data-table"><thead><tr><th>Data</th><th>Movimento</th><th>Produtos</th><th>Origem</th><th>Situação</th></tr></thead><tbody>{page.postings.map(posting=><tr key={posting.id}>
   <td>{dateText(posting.occurred_on)}</td><td>{posting.direction==='receipt'?'Entrada':'Saída'}</td><td>{posting.positions}{posting.ignored_items>0&&<small className="document-stock-sources">{posting.ignored_items} itens fora do estoque</small>}</td><td>Versão {posting.source_document_version}</td><td><span className={`status-badge ${posting.state==='active'?'status-success':'status-neutral'}`}>{posting.state==='active'?'Ativo':'Estornado'}</span>{posting.reason&&<small className="document-stock-sources">{posting.reason}</small>}</td>
  </tr>)}</tbody></table></div>}
   <div className="real-pagination"><span>Página {history.length+1}</span><button type="button" className="text-button" disabled={busy||uncertain||dirty||loading||!history.length} onClick={()=>reloadList(()=>{setAfter(history.at(-1)??null);setHistory(previous=>previous.slice(0,-1));})}>Lançamentos anteriores</button><button type="button" className="text-button" disabled={busy||uncertain||dirty||loading||!page.has_more} onClick={()=>reloadList(()=>{setHistory(previous=>[...previous,after]);setAfter(page.next_cursor);})}>Próximos lançamentos</button></div>
  </>}
 </section>;
}
