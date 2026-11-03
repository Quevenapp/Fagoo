import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {parsePurchaseReadinessPage,parsePurchaseReadinessDetail,purchaseReadinessListPath,purchaseReadinessDetailPath,purchaseReadinessMoment,purchaseObserved,purchaseSituation,purchaseCaptureLabels,purchaseBindingLabel,purchasePendingLabels,purchaseIssueLabel,type PurchaseReadinessPage,type PurchaseReadinessDetail,type PurchaseReadinessSource,type PurchaseReadinessBinding} from '../lib/origin-purchase-readiness-model';
import NativeListLayout from './NativeListLayout';
import './origin-purchase-readiness.css';

/** A GET-only port; shared route/controller wiring is deliberately separate. */
export interface PurchaseReadinessController {
 getSnapshot:()=>AccessState;
 subscribe:(listener:()=>void)=>()=>void;
 purchaseReadiness:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
}
const canRead=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
const errorText=(error:unknown)=>error instanceof AccessError&&[401,403].includes(error.status)
 ?'O acesso de administrador precisa ser confirmado para consultar estas compras.'
 :error instanceof AccessError&&error.status===404?'Esta compra não está disponível na observação atual. Volte à lista e atualize a consulta.'
 :'Não foi possível concluir a consulta. Tente novamente.';
const aborted=(error:unknown)=>error instanceof DOMException&&error.name==='AbortError';

function SourceDescription({source}:{source:PurchaseReadinessSource}){
 return <><dl className="purchase-readiness-values">
  <div><dt>Número observado</dt><dd>{purchaseObserved(source.number)}</dd></div>
  <div><dt>Data observada</dt><dd>{purchaseObserved(source.date,'date')}</dd></div>
  <div><dt>Situação observada</dt><dd>{purchaseSituation(source.situation.value)}</dd></div>
  <div><dt>Última observação</dt><dd>{purchaseReadinessMoment(source.last_seen_at)}</dd></div>
  <div><dt>Itens na origem</dt><dd>{source.item_count??'Quantidade não informada'}</dd></div>
 </dl><p>{purchaseCaptureLabels[source.capture.state]}.</p>{source.capture.observed_at&&<small>Captura observada em {purchaseReadinessMoment(source.capture.observed_at)}.</small>}</>;
}
function BindingDescription({binding}:{binding:PurchaseReadinessBinding}){
 return <><strong>{binding.name??'Sem nome de cadastro disponível'}</strong><small>{purchaseBindingLabel(binding)}</small>
  {binding.active===false&&<small>Cadastro inativo.</small>}{binding.human_edited&&<small>Cadastro editado no FAGOO; a correspondência precisa ser preservada e revisada.</small>}
 </>;
}
const invoiceLabels={absent:'Referência não informada',null:'Sem referência declarada',empty:'Referência vazia, sem vínculo fiscal confirmado',zero:'Identificador zero, sem vínculo fiscal confirmado',declared:'Referência declarada, sem vínculo fiscal confirmado',invalid:'Referência em formato não suportado'} as const;

function Detail({detail,onBack,onRefresh,loading}:{detail:PurchaseReadinessDetail;onBack:()=>void;onRefresh:()=>void;loading:boolean}){
 const c=detail.commercial,h=detail.history;
 return <section className="purchase-readiness-panel" aria-label="Conferência da compra observada">
  <header><div><h2>Compra {purchaseObserved(detail.source.number)}</h2><p>ID no Origin: <code>{detail.source.source_id}</code></p></div><div className="purchase-readiness-buttons"><button type="button" className="secondary-button" onClick={onBack}>Voltar à lista</button><button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>Atualizar conferência</button></div></header>
  <div className="purchase-readiness-columns"><section><h3>Origem observada</h3><SourceDescription source={detail.source}/></section><section><h3>Fornecedor correspondente</h3><BindingDescription binding={detail.supplier}/></section></div>
  <p className="real-help">A última observação indica quando o conteúdo foi coletado. Não certifica que todo o histórico esteja disponível nem que o pedido continue igual no Origin.</p>
  {detail.issues.length>0&&<section className="purchase-readiness-issues" aria-label="Pendências desta compra"><h3>Pendências desta compra</h3><ul>{detail.issues.map((issue,index)=><li key={index}>{purchaseIssueLabel(issue)}</li>)}</ul></section>}
  <h3>Itens observados</h3><p>Quantidade, preço e IPI são apresentados como recebidos. A captura exata, quando disponível, cobre somente os preços unitários; não comprova a conciliação dos demais valores.</p>
  {detail.items.length?<div className="table-scroll" role="region" tabIndex={0} aria-label="Itens observados da compra"><table className="data-table"><thead><tr><th>Item / descrição</th><th>Produto correspondente</th><th>Unidade observada</th><th>Quantidade observada</th><th>Preço unitário observado</th><th>Alíquota IPI observada</th><th>Referência fiscal</th></tr></thead><tbody>{detail.items.map(item=><tr key={item.position}>
   <td><strong>{item.position}. {purchaseObserved(item.description)}</strong><small>Código do produto: {purchaseObserved(item.code)}</small></td>
   <td><BindingDescription binding={item.product}/>{item.product.record_id&&<small>Unidade do cadastro: {item.product.unit??'não informada'}</small>}</td>
   <td>{purchaseObserved(item.unit)}</td><td className="purchase-readiness-number">{purchaseObserved(item.quantity,'decimal')}{!item.quantity_supported&&<small>Fora dos limites atuais para uma compra nativa.</small>}</td>
   <td className="purchase-readiness-number">{purchaseObserved(item.unit_price,'money')}{!item.unit_price_supported&&<small>Fora dos limites atuais para uma compra nativa.</small>}</td>
   <td className="purchase-readiness-number">{purchaseObserved(item.ipi,'decimal')}{item.ipi.state==='value'?'%':''}</td><td>{invoiceLabels[item.invoice_reference.state]}</td>
  </tr>)}</tbody></table></div>:<p>Não foi possível apresentar os itens desta observação. Consulte as pendências acima.</p>}
  <h3>Valores comerciais observados</h3><dl className="purchase-readiness-values">
   <div><dt>Total da compra</dt><dd>{purchaseObserved(c.total,'money')}</dd></div><div><dt>Total dos produtos</dt><dd>{purchaseObserved(c.total_products,'money')}</dd></div><div><dt>Frete</dt><dd>{purchaseObserved(c.freight,'money')}</dd></div>
   <div><dt>Desconto declarado</dt><dd>{purchaseObserved(c.discount_value,'decimal')}<small>Unidade do desconto na origem: {purchaseObserved(c.discount_unit)}</small></dd></div>
   <div><dt>Parcelas informadas</dt><dd>{c.installment_count??'Quantidade não informada'}</dd></div><div><dt>Dados de tributação</dt><dd>{c.taxation_present?'Conteúdo presente, ainda não conferido':'Conteúdo não identificado nesta observação'}</dd></div>
  </dl><p>Os valores acima não são recalculados nesta conferência. Não são criadas parcelas, contas a pagar ou movimentações de estoque.</p>
  <section className="purchase-readiness-notice"><h3>O que falta para adotar compras</h3><p>A importação ainda não está disponível, mesmo quando os cadastros e preços já possuem correspondência.</p><ul>{detail.pending_contracts.map(code=><li key={code}>{purchasePendingLabels[code]}</li>)}</ul></section>
  <details><summary>Histórico e comparação com o backup</summary><p>A comparação por compra está indisponível: o backup de compras não fornece um identificador de API confiável para este vínculo. Número, código e nome não são usados para associar registros.</p>
   <dl className="purchase-readiness-values"><div><dt>Linhas de compras no backup</dt><dd>{h.backup_rows}</dd></div><div><dt>Lotes de backup</dt><dd>{h.backup_batches}</dd></div><div><dt>Linhas sem ID de origem</dt><dd>{h.backup_rows_without_source_id}</dd></div><div><dt>Último armazenamento de backup</dt><dd>{purchaseReadinessMoment(h.last_backup_stored_at)}</dd></div></dl>
   {h.exact_id_rows_uncompared!=='0'&&<p>{h.exact_id_rows_uncompared} linha(s) possuem um ID igual ao desta compra, mas não foram comparadas nem adotadas.</p>}
   <p>Estas contagens abrangem os arquivos de backup, não o histórico desta compra. A captura atual não substitui o histórico e não comprova diferenças em relação ao backup.</p>
  </details>
  <details><summary>Identificação da observação</summary><dl className="purchase-readiness-values"><div><dt>ID no Origin</dt><dd><code>{detail.source.source_id}</code></dd></div><div><dt>Versão observada</dt><dd>{detail.source.source_version}</dd></div><div><dt>Identificador do conteúdo</dt><dd><code>{detail.source.source_hash}</code></dd></div><div><dt>Conferência realizada</dt><dd>{purchaseReadinessMoment(detail.observed_at)}</dd></div></dl></details>
 </section>;
}

function PurchaseReadinessView({controller,actor}:{controller:PurchaseReadinessController;actor:string}){
 const alive=useRef(true),listRequest=useRef<AbortController|null>(null),detailRequest=useRef<AbortController|null>(null),selected=useRef<string|null>(null);
 const identity=useRef({controller,actor});identity.current={controller,actor};
 const [query,setQuery]=useState(''),[filter,setFilter]=useState(''),[cursors,setCursors]=useState<(string|null)[]>([null]),[reload,setReload]=useState(0);
 const [page,setPage]=useState<{actor:string;value:PurchaseReadinessPage}|null>(null),[detail,setDetail]=useState<{actor:string;value:PurchaseReadinessDetail}|null>(null);
 const [selectedId,setSelectedId]=useState<string|null>(null),[listLoading,setListLoading]=useState(false),[detailLoading,setDetailLoading]=useState(false),[listError,setListError]=useState(''),[detailError,setDetailError]=useState('');
 const authorized=()=>{const s=controller.getSnapshot();return alive.current&&identity.current.controller===controller&&identity.current.actor===actor&&canRead(s)&&s.membership?.user_id===actor;};
 const currentPage=page?.actor===actor?page.value:null,currentDetail=detail?.actor===actor?detail.value:null,after=cursors.at(-1)??null;
 const live=useRef({page:currentPage,query,cursors});live.current={page:currentPage,query,cursors};
 useEffect(()=>{alive.current=true;selected.current=null;setSelectedId(null);setDetail(null);setDetailError('');setDetailLoading(false);return()=>{alive.current=false;listRequest.current?.abort();detailRequest.current?.abort();};},[controller,actor]);
 useEffect(()=>{
  const p=new AbortController();listRequest.current?.abort();listRequest.current=p;setPage(null);setListError('');
  if(!authorized())return()=>p.abort();setListLoading(true);
  void(async()=>{try{
   const raw=await controller.purchaseReadiness(purchaseReadinessListPath(filter,after),{method:'GET',signal:p.signal});
   if(!authorized()||p.signal.aborted||listRequest.current!==p)return;
   const value=parsePurchaseReadinessPage(raw,{limit:25,after});setPage({actor,value});
  }catch(error){if(authorized()&&!p.signal.aborted&&listRequest.current===p&&!aborted(error))setListError(errorText(error));}
  finally{if(listRequest.current===p){listRequest.current=null;if(authorized())setListLoading(false);}}})();
  return()=>{p.abort();if(listRequest.current===p)listRequest.current=null;};
 },[controller,actor,filter,after,reload]);
 const inspect=async(sourceId:string)=>{
  if(!authorized()||!live.current.page?.items.some(row=>row.source_id===sourceId))return;
  const p=new AbortController();detailRequest.current?.abort();detailRequest.current=p;selected.current=sourceId;setSelectedId(sourceId);setDetail(null);setDetailError('');setDetailLoading(true);
  try{
   const raw=await controller.purchaseReadiness(purchaseReadinessDetailPath(sourceId),{method:'GET',signal:p.signal});
   if(!authorized()||p.signal.aborted||detailRequest.current!==p||selected.current!==sourceId)return;
   const value=parsePurchaseReadinessDetail(raw,{sourceId});setDetail({actor,value});
  }catch(error){if(authorized()&&!p.signal.aborted&&detailRequest.current===p&&!aborted(error))setDetailError(errorText(error));}
  finally{if(detailRequest.current===p){detailRequest.current=null;if(authorized())setDetailLoading(false);}}
 };
 const back=()=>{if(!authorized())return;selected.current=null;detailRequest.current?.abort();detailRequest.current=null;setSelectedId(null);setDetail(null);setDetailError('');setDetailLoading(false);};
 const listFree=()=>authorized()&&!selected.current&&!listRequest.current;
 const search=(event:FormEvent)=>{event.preventDefault();if(!listFree())return;setFilter(live.current.query.trim());setCursors([null]);setReload(value=>value+1);};
 const changePage=(next:boolean)=>{if(!listFree())return;const p=live.current.page;if(next&&p?.has_more&&p.next_cursor)setCursors(value=>[...value,p.next_cursor]);else if(!next&&live.current.cursors.length>1)setCursors(value=>value.slice(0,-1));};
 return <section className="origin-purchase-readiness" aria-labelledby="purchase-readiness-title" aria-busy={listLoading||detailLoading}>
  <header className="real-heading"><div><h1 id="purchase-readiness-title">Conferir compras do Origin</h1><p>Consulte os pedidos observados e as pendências para uma futura adoção no FAGOO.</p></div><span className="real-mode">Somente leitura</span></header>
  <p className="purchase-readiness-notice">A importação de compras ainda não está disponível. Esta consulta não registra recebimentos nem altera estoque ou financeiro.</p>
  {selectedId?<>
   {detailError&&<p role="alert" className="real-error">{detailError}</p>}
   {detailLoading&&<p role="status">Consultando compra…</p>}
   {currentDetail?<Detail detail={currentDetail} loading={detailLoading} onBack={back} onRefresh={()=>{if(selected.current===currentDetail.source.source_id&&!detailRequest.current)void inspect(currentDetail.source.source_id);}}/>:<div className="purchase-readiness-buttons"><button type="button" className="secondary-button" onClick={back}>Voltar à lista</button>{!detailLoading&&<button type="button" className="secondary-button" onClick={()=>{if(selected.current===selectedId&&!detailRequest.current)void inspect(selectedId);}}>Tentar consulta novamente</button>}</div>}
  </>:<NativeListLayout filters={<form onSubmit={search}><label htmlFor="purchase-readiness-query">Número ou ID no Origin</label><input id="purchase-readiness-query" type="search" maxLength={100} value={query} disabled={listLoading} onChange={event=>{if(listFree()){live.current.query=event.target.value;setQuery(event.target.value);}}}/><button type="submit" className="secondary-button" disabled={listLoading}>Pesquisar</button></form>} actions={<><button type="button" className="secondary-button" disabled={listLoading} onClick={()=>{if(listFree())setReload(value=>value+1);}}>Atualizar lista</button><p>A lista apresenta observações coletadas. Ela não certifica a cobertura completa dos pedidos ou de seu histórico.</p></>}>
   {listError&&<p role="alert" className="real-error">{listError}</p>}<p role="status">{listLoading?'Consultando compras…':currentPage?`${currentPage.items.length} compra(s) nesta página`:'Lista indisponível'}</p>
   {currentPage&&<>{!currentPage.items.length?<p>Nenhuma compra encontrada nesta consulta.</p>:<div className="table-scroll" role="region" tabIndex={0} aria-label="Compras observadas no Origin"><table className="data-table"><thead><tr><th>Número / ID no Origin</th><th>Data observada</th><th>Situação observada</th><th>Última observação</th><th>Preços unitários</th><th>Conferência</th></tr></thead><tbody>{currentPage.items.map(row=><tr key={row.source_id}><td><strong>{purchaseObserved(row.number)}</strong><small>{row.source_id}</small></td><td>{purchaseObserved(row.date,'date')}</td><td>{purchaseSituation(row.situation.value)}</td><td>{purchaseReadinessMoment(row.last_seen_at)}</td><td>{purchaseCaptureLabels[row.capture.state]}</td><td><button type="button" className="text-button" onClick={()=>void inspect(row.source_id)} aria-label={`Conferir compra ${row.source_id}`}>Conferir compra <span className="sr-only">{row.source_id}</span></button></td></tr>)}</tbody></table></div>}
    <footer className="purchase-readiness-pagination"><span>Página {cursors.length}</span><div><button type="button" className="secondary-button" disabled={listLoading||cursors.length===1} onClick={()=>changePage(false)}>Página anterior</button><button type="button" className="secondary-button" disabled={listLoading||!currentPage.has_more} onClick={()=>changePage(true)}>Próxima página</button></div></footer>
   </>}
  </NativeListLayout>}
 </section>;
}

export default function OriginPurchaseReadiness({controller}:{controller:PurchaseReadinessController}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 if(!canRead(snapshot))return<section className="origin-purchase-readiness"><h1>Conferir compras do Origin</h1><p role="alert">Esta conferência está disponível apenas para administradores com acesso ativo.</p></section>;
 return <PurchaseReadinessView key={snapshot.membership!.user_id} controller={controller} actor={snapshot.membership!.user_id}/>;
}
