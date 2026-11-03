import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {parseSalesHistoryPage,historyDetailForRow,salesHistoryListPath,salesHistoryDetailPath,historyObserved,historyMoment,historyCaptureLabels,historyBindingLabels,historyCurrentSourceLabels,type SalesHistoryId,type SalesHistoryPage,type SalesHistoryDetail,type HistorySummary,type HistoryBinding} from '../lib/origin-sales-history-model';
import NativeListLayout from './NativeListLayout';
import './origin-sales-history.css';

/** Isolated GET-only port. Shared routing/controller wiring is a separate release step. */
export interface SalesHistoryController{getSnapshot:()=>AccessState;subscribe:(listener:()=>void)=>()=>void;salesHistory:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
const canRead=(state:AccessState)=>state.phase==='ready'&&state.membership?.role==='admin';
const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';
const failure=(error:unknown)=>error instanceof AccessError&&[401,403].includes(error.status)?'O acesso de administrador precisa ser confirmado para consultar este histórico.':error instanceof AccessError&&error.status===404?'O registro não está disponível nesta consulta. Atualize a lista.':'Não foi possível consultar o histórico. Tente novamente.';

function Source({value}:{value:HistorySummary}){return <dl className="sales-history-values">
 <div><dt>Número na origem</dt><dd>{historyObserved(value.number)}</dd></div><div><dt>Data na origem</dt><dd>{historyObserved(value.date)}</dd></div>
 <div><dt>Situação na origem</dt><dd>{historyObserved(value.situation.value)}<small>ID: {historyObserved(value.situation.id)} · sem classificação presumida</small></dd></div>
 <div><dt>Preservado em</dt><dd>{historyMoment(value.captured_at)}</dd></div><div><dt>Origem observada em</dt><dd>{historyMoment(value.source.last_seen_at)}</dd></div>
 <div><dt>Itens na captura</dt><dd>{value.item_count??'Quantidade não informada'}</dd></div>
 </dl>;}
function Binding({value}:{value:HistoryBinding}){return <><strong>{historyBindingLabels[value.state]}</strong>{value.unit!==null&&<small>Unidade do cadastro atual: {value.unit}</small>}{value.record_id&&<details><summary>Identificação do cadastro</summary><p>{value.record_id} · versão {value.record_version}</p></details>}</>;}
function Detail({value,onBack,onRefresh}:{value:SalesHistoryDetail;onBack:()=>void;onRefresh:()=>void}){
 const s=value.snapshot,c=value.commercial,now=value.current;
 return <section className="sales-history-panel" aria-label="Registro comercial preservado">
  <header><h2>Venda {historyObserved(s.number)}</h2><div className="sales-history-buttons"><button type="button" className="secondary-button" onClick={onBack}>Voltar à lista</button><button type="button" className="secondary-button" onClick={onRefresh}>Atualizar consulta</button></div></header>
  <section aria-label="Captura histórica imutável">
   <dl className="sales-history-customer"><dt>Cliente</dt><dd>{historyObserved(value.customer.name)}</dd></dl>
   <h3>Itens</h3>
   {s.capture.state!=='bound'&&<p className="sales-history-capture-status" role="status">{historyCaptureLabels[s.capture.state]}.</p>}
   {value.items.length?<div className="table-scroll" role="region" tabIndex={0} aria-label="Itens da captura histórica"><table className="data-table"><thead><tr><th>Item / produto na origem</th><th>Unidade</th><th>Quantidade</th><th>Preço unitário</th><th>Desconto</th><th>Valor de lista</th><th>Alíquota IPI</th></tr></thead><tbody>{value.items.map(item=><tr key={item.position}>
    <td><strong>{item.position}. {historyObserved(item.description)}</strong><small>Código: {historyObserved(item.code)}</small>{item.item_state==='invalid'&&<small>Formato do item não conferido.</small>}</td>
    <td>{historyObserved(item.unit)}</td><td>{historyObserved(item.quantity,'decimal')}</td><td>{historyObserved(item.unit_price,'money')}</td><td>{historyObserved(item.discount,'decimal')}</td><td>{historyObserved(item.list_price,'decimal')}</td><td>{historyObserved(item.ipi,'decimal')}</td>
   </tr>)}</tbody></table></div>:<p>{value.items_state==='array'?'A captura contém uma lista vazia de itens.':'Os itens não estão disponíveis em uma lista conferida nesta captura.'}</p>}
   <p className="sales-history-caption">Preços e valores observados na origem, sem recálculo.</p>
   <h3>Valores</h3><dl className="sales-history-values sales-history-totals">
    <div><dt>Total na origem</dt><dd>{historyObserved(c.total,'money')}</dd></div><div><dt>Total dos produtos</dt><dd>{historyObserved(c.total_products,'money')}</dd></div><div><dt>Frete</dt><dd>{historyObserved(c.freight,'money')}</dd></div><div><dt>Outras despesas</dt><dd>{historyObserved(c.other_expenses,'money')}</dd></div><div><dt>Desconto declarado</dt><dd>{historyObserved(c.discount_value,'decimal')}<small>Unidade: {historyObserved(c.discount_unit)}</small></dd></div><div><dt>Parcelas informadas</dt><dd>{c.installment_count??'Quantidade não informada'}</dd></div>
   </dl>
  </section>
  {now.source.state!=='same'&&<p className="sales-history-origin-status">{historyCurrentSourceLabels[now.source.state]}. Os dados desta venda permanecem preservados.</p>}
  <details className="sales-history-disclosure" aria-label="Correspondências atuais"><summary>Correspondências atuais</summary><p>Consultadas em {historyMoment(value.observed_at)}. Estes vínculos não alteram os dados preservados acima.</p><p>{historyCurrentSourceLabels[now.source.state]}.</p><small>A comparação da origem considera conteúdo e versão; datas de observação e captura exata de preços não fazem parte dessa comparação.</small>
   <h4>Cliente</h4><Binding value={now.customer}/>
   {now.products.length>0&&<div className="table-scroll"><table className="data-table"><thead><tr><th>Item da captura</th><th>Correspondência atual</th></tr></thead><tbody>{now.products.map(item=><tr key={item.position}><td>{item.position}</td><td><Binding value={item.binding}/></td></tr>)}</tbody></table></div>}
  </details>
  <details className="sales-history-disclosure"><summary>Detalhes da importação</summary>
   <div className="sales-history-columns"><Source value={s}/><dl className="sales-history-values"><div><dt>ID da venda no Origin</dt><dd>{s.source.source_id}</dd></div><div><dt>ID do cliente na origem</dt><dd>{historyObserved(value.customer.source_id)}</dd></div><div><dt>Referência fiscal observada</dt><dd>{value.invoice_reference.structure_present?historyObserved(value.invoice_reference.source_id):'Não informada na origem'}<small>Presença de referência, inclusive zero, não comprova uma nota fiscal vinculada ou autorizada.</small></dd></div></dl></div>
   <p>{historyCaptureLabels[s.capture.state]}. A conferência da captura numérica cobre apenas o campo de preço unitário; não define preço líquido ou total conciliado.</p>
   <p>Quantidade, unidade, desconto e valor de lista são observações separadas. Não são convertidos nem usados para recalcular os valores.</p>
   {value.items.some(item=>item.price_lexeme!==null)&&<div className="table-scroll"><table className="data-table"><thead><tr><th>Item</th><th>Texto numérico original do preço</th></tr></thead><tbody>{value.items.filter(item=>item.price_lexeme!==null).map(item=><tr key={item.position}><td>{item.position}</td><td><code>{item.price_lexeme}</code></td></tr>)}</tbody></table></div>}
   <dl className="sales-history-values"><div><dt>Histórico</dt><dd>{s.history_id}</dd></div><div><dt>Versão da origem capturada</dt><dd>{s.source.source_version}</dd></div><div><dt>Identificador da captura</dt><dd>{s.snapshot_hash}</dd></div><div><dt>Atualização declarada pela origem</dt><dd>{historyMoment(s.source.source_updated_at)}</dd></div></dl>
  </details>
 </section>;
}

function HistoryView({controller,actor}:{controller:SalesHistoryController;actor:string}){
 const alive=useRef(true),identity=useRef({controller,actor}),listRequest=useRef<AbortController|null>(null),detailRequest=useRef<AbortController|null>(null),selected=useRef<SalesHistoryId|null>(null);identity.current={controller,actor};
 const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[cursors,setCursors]=useState<(SalesHistoryId|null)[]>([null]),[reload,setReload]=useState(0);
 const [page,setPage]=useState<SalesHistoryPage|null>(null),[detail,setDetail]=useState<SalesHistoryDetail|null>(null),[selectedId,setSelectedId]=useState<SalesHistoryId|null>(null),[listLoading,setListLoading]=useState(false),[detailLoading,setDetailLoading]=useState(false),[listError,setListError]=useState(''),[detailError,setDetailError]=useState('');
 const live=useRef({page,query,cursors});live.current={page,query,cursors};const after=cursors.at(-1)??null;
 const allowed=()=>{const s=controller.getSnapshot();return alive.current&&identity.current.controller===controller&&identity.current.actor===actor&&canRead(s)&&s.membership?.user_id===actor;};
 useEffect(()=>{alive.current=true;selected.current=null;setSelectedId(null);setDetail(null);setDetailError('');setDetailLoading(false);return()=>{alive.current=false;listRequest.current?.abort();detailRequest.current?.abort();};},[controller,actor]);
 useEffect(()=>{
  const pending=new AbortController();listRequest.current=pending;live.current.page=null;setPage(null);setListError('');setListLoading(true);
  if(!allowed())return()=>pending.abort();
  void(async()=>{try{const raw=await controller.salesHistory(salesHistoryListPath(filter,after),{method:'GET',signal:pending.signal});if(!allowed()||pending.signal.aborted||listRequest.current!==pending)return;const value=parseSalesHistoryPage(raw,{limit:25,after});if(allowed()&&!pending.signal.aborted&&listRequest.current===pending)setPage(value);}catch(error){if(allowed()&&!pending.signal.aborted&&listRequest.current===pending&&!aborted(error))setListError(failure(error));}finally{if(listRequest.current===pending){listRequest.current=null;if(allowed())setListLoading(false);}}})();
  return()=>{pending.abort();if(listRequest.current===pending)listRequest.current=null;};
 },[controller,actor,filter,after,reload]);
 const inspect=async(id:SalesHistoryId,sourcePage:SalesHistoryPage,refresh=false)=>{
  if(!allowed()||listRequest.current||detailRequest.current||selected.current!==null&&(!refresh||selected.current!==id)||live.current.page!==sourcePage)return;
  const row=sourcePage.items.find(row=>row.history_id===id);if(!row)return;
  const pending=new AbortController();detailRequest.current=pending;selected.current=id;setSelectedId(id);setDetail(null);setDetailError('');setDetailLoading(true);
  try{const raw=await controller.salesHistory(salesHistoryDetailPath(id),{method:'GET',signal:pending.signal});if(!allowed()||pending.signal.aborted||detailRequest.current!==pending||selected.current!==id)return;const value=historyDetailForRow(raw,row);if(allowed()&&!pending.signal.aborted&&detailRequest.current===pending&&selected.current===id)setDetail(value);}catch(error){if(allowed()&&!pending.signal.aborted&&detailRequest.current===pending&&!aborted(error))setDetailError(failure(error));}finally{if(detailRequest.current===pending){detailRequest.current=null;if(allowed())setDetailLoading(false);}}
 };
 const back=(expected:SalesHistoryId)=>{if(!allowed()||selected.current!==expected)return;detailRequest.current?.abort();detailRequest.current=null;selected.current=null;setSelectedId(null);setDetail(null);setDetailError('');setDetailLoading(false);};
 const listFree=()=>allowed()&&!listRequest.current&&!selected.current;
 const invalidate=()=>{live.current.page=null;setPage(null);};
 const search=(event:FormEvent)=>{event.preventDefault();if(!listFree())return;invalidate();setFilter(live.current.query.trim());setCursors([null]);setReload(n=>n+1);};
 const nextPage=(next:boolean)=>{if(!listFree())return;const p=live.current.page;if(next&&p?.has_more&&p.next_cursor){invalidate();setCursors(v=>[...v,p.next_cursor]);}else if(!next&&live.current.cursors.length>1){invalidate();setCursors(v=>v.slice(0,-1));}};
 return <section className="origin-sales-history" aria-busy={listLoading||detailLoading}>
  <header className="real-heading"><div><h1>Histórico de vendas do Origin</h1><p>Vendas trazidas do Origin, disponíveis para consulta.</p></div><span className="real-mode">Somente consulta</span></header>
  <details className="sales-history-about"><summary>Sobre este histórico</summary><p>Os dados preservados não são pedidos operacionais e não podem ser convertidos. A consulta não cria entregas, cobranças, estoque ou notas fiscais, nem certifica a cobertura completa das vendas e dos backups.</p></details>
  {selectedId?<>{detailError&&<p className="real-error" role="alert">{detailError}</p>}{detailLoading&&<p role="status">Consultando registro preservado…</p>}{detail&&page?<Detail value={detail} onBack={()=>back(detail.snapshot.history_id)} onRefresh={()=>{if(selected.current===detail.snapshot.history_id&&!detailRequest.current)void inspect(detail.snapshot.history_id,page,true);}}/>:<div className="sales-history-buttons"><button type="button" className="secondary-button" onClick={()=>back(selectedId)}>Voltar à lista</button>{!detailLoading&&page&&<button type="button" className="secondary-button" onClick={()=>{if(selected.current===selectedId&&!detailRequest.current)void inspect(selectedId,page,true);}}>Tentar consulta novamente</button>}</div>}</>
  :<NativeListLayout filters={<form onSubmit={search}><label htmlFor="sales-history-query">Número ou ID no Origin</label><input id="sales-history-query" type="search" maxLength={100} disabled={listLoading} value={query} onChange={event=>{if(listFree()){live.current.query=event.target.value;setQuery(event.target.value);}}}/><button type="submit" className="secondary-button" disabled={listLoading}>Pesquisar</button></form>} actions={<><button type="button" className="secondary-button" disabled={listLoading} onClick={()=>{if(listFree()){invalidate();setReload(n=>n+1);}}}>Atualizar lista</button></>}>
   {listError&&<p className="real-error" role="alert">{listError}</p>}<p role="status">{listLoading?'Consultando histórico…':page?`${page.items.length} registro(s) nesta página`:'Lista indisponível'}</p>
   {page&&<>{!page.items.length?<p>Nenhum registro preservado encontrado nesta consulta.</p>:<div className="table-scroll" role="region" tabIndex={0} aria-label="Vendas preservadas do Origin"><table className="data-table"><thead><tr><th>Número / ID no Origin</th><th>Data na origem</th><th>Situação na origem</th><th>Preservado em</th><th>Consulta</th></tr></thead><tbody>{page.items.map(row=><tr key={row.history_id}><td><strong>{historyObserved(row.number)}</strong><small>{row.source.source_id}</small></td><td>{historyObserved(row.date)}</td><td>{historyObserved(row.situation.value)}<small>Sem classificação presumida</small></td><td>{historyMoment(row.captured_at)}</td><td><button type="button" className="text-button" onClick={()=>void inspect(row.history_id,page)} aria-label={`Consultar histórico ${row.source.source_id}`}>Consultar histórico <span className="sr-only">{row.source.source_id}</span></button></td></tr>)}</tbody></table></div>}
   <footer className="sales-history-pagination"><span>Página {cursors.length} · horários de São Paulo</span><div><button type="button" className="secondary-button" disabled={listLoading||cursors.length===1} onClick={()=>nextPage(false)}>Página anterior</button><button type="button" className="secondary-button" disabled={listLoading||!page.has_more} onClick={()=>nextPage(true)}>Próxima página</button></div></footer></>}
  </NativeListLayout>}
 </section>;
}
export default function OriginSalesHistory({controller}:{controller:SalesHistoryController}){
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 if(!canRead(state))return<section className="origin-sales-history"><h1>Histórico de vendas do Origin</h1><p role="alert">Esta consulta requer acesso ativo de administrador.</p></section>;
 return <HistoryView key={state.membership!.user_id} controller={controller} actor={state.membership!.user_id}/>;
}
