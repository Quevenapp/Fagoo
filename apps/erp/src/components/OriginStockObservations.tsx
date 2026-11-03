import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {parseStockObservationsPage,parseStockObservationsDetail,stockObservationsListPath,stockObservationsDetailPath,stockObservationSourceId,stockObserved,stockObservedMoment,stockProductName,stockProductBinding,stockObservationLabel,stockObservationIssues,type StockObservationsPage,type StockObservationsDetail,type StockObservationRow,type StockWarehouseContext} from '../lib/origin-stock-observations-model';
import './origin-stock-observations.css';
export interface StockObservationsController {
 getSnapshot:()=>AccessState;
 subscribe:(listener:()=>void)=>()=>void;
 stockObservations:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
}
const canRead=(s:AccessState)=>s.phase==='ready'&&s.membership?.role==='admin';
const message=(e:unknown)=>e instanceof AccessError&&[401,403].includes(e.status)?'O acesso de administrador precisa ser confirmado.':e instanceof AccessError&&e.status===404?'O depósito vinculado ou o produto não está disponível nesta consulta. Isso não significa estoque zero.':'Não foi possível concluir a consulta. Tente novamente.';
const yesNo=(value:boolean|null|undefined)=>value==null?'Não conferido':value?'Sim':'Não';
function Warehouse({value}:{value:StockWarehouseContext}){
 return <section className="stock-observations-warehouse" aria-label="Depósito consultado">
  <h2>{value.record.name}</h2><p>{value.record.active?'Cadastro ativo no FAGOO':'Cadastro inativo no FAGOO'} · ID no Origin {value.source_id}</p>
  {value.source_state!=='same'&&<p>{value.source_state==='missing'?'O depósito não está disponível na coleta atual. O vínculo anterior permanece preservado.':'Os dados do depósito na origem mudaram depois do vínculo.'}</p>}
  {value.record_state==='changed'&&<p>O cadastro no FAGOO foi alterado depois do vínculo.</p>}
  <details><summary>Dados do depósito e vínculo</summary><dl className="stock-observations-values">
   <div><dt>Nome na origem atual</dt><dd>{value.source?.name??'Não disponível'}</dd></div>
   <div><dt>Situação na origem</dt><dd>{value.source?.status===1?'Ativo':value.source?.status===0?'Inativo':'Não conferida'}</dd></div>
   <div><dt>Depósito padrão na origem</dt><dd>{yesNo(value.source?.is_default)}</dd></div>
   <div><dt>Desconsiderar saldo na origem</dt><dd>{yesNo(value.source?.exclude_balance)}</dd></div>
   <div><dt>Origem observada em</dt><dd>{stockObservedMoment(value.source?.last_seen_at??null)}</dd></div>
   <div><dt>Vínculo criado em</dt><dd>{stockObservedMoment(value.imported_at)}</dd></div>
  </dl><p>Essas configurações são informações da origem. Elas não definem saldos de abertura no FAGOO.</p>
  <small>Versão da origem no vínculo: {value.binding_source_version}. Versão da origem atual: {value.source?.source_version??'não disponível'}. Versão do cadastro: {value.record.version}.</small></details>
 </section>;
}
function Quantities({row}:{row:StockObservationRow}){
 const o=row.observation;
 return <><p>{stockObservationLabel(row)}.</p><dl className="stock-observations-values stock-observations-quantities">
  <div><dt>Físico no depósito</dt><dd>{stockObserved(o.warehouse.physical,true)}</dd></div>
  <div><dt>Virtual no depósito</dt><dd>{stockObserved(o.warehouse.virtual,true)}</dd></div>
  <div><dt>Estoque observado em</dt><dd>{stockObservedMoment(o.source?.last_seen_at??null)}</dd></div>
 </dl>{o.issues.length>0&&<ul>{o.issues.map(code=><li key={code}>{stockObservationIssues[code]}</li>)}</ul>}</>;
}
function ProductDetail({value,loading,onBack,onRefresh}:{value:StockObservationsDetail;loading:boolean;onBack:()=>void;onRefresh:()=>void}){
 const r=value.item,p=r.product,o=r.observation;
 return <section className="stock-observations-panel" aria-label="Estoque observado do produto"><header><div><h2>{stockProductName(r)}</h2><p>Código na origem: {stockObserved(p.source_code)} · ID {r.product_source_id}</p></div><div className="stock-observations-actions"><button type="button" className="secondary-button" onClick={onBack}>Voltar à lista</button><button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>Atualizar produto</button></div></header>
  <Quantities row={r}/><p>Quantidades informadas pelo Origin, sem recálculo ou comparação com o estoque do FAGOO.</p>
  <details><summary>Cadastro correspondente no FAGOO</summary><p>{stockProductBinding[p.binding_state]}.</p>{p.record_name&&<><p>{p.record_name} · {p.active?'Ativo':'Inativo'}</p><p>Unidade do cadastro: {p.record_unit??'Não informada'}. Esta consulta não compara unidades entre os sistemas.</p>{p.human_edited&&<p>O cadastro foi editado no FAGOO.</p>}</>}</details>
  <details><summary>Totais gerais informados na origem</summary><p>Valores gerais do produto, separados das quantidades deste depósito. Não são somados nem distribuídos nesta tela.</p><dl className="stock-observations-values"><div><dt>Físico total informado</dt><dd>{stockObserved(o.physical_total,true)}</dd></div><div><dt>Virtual total informado</dt><dd>{stockObserved(o.virtual_total,true)}</dd></div></dl></details>
  <details><summary>Detalhes desta observação</summary><p>Código no registro de estoque: {stockObserved(o.product_code)}.</p><p>Consulta realizada em {stockObservedMoment(value.observed_at)}. A observação pode ter sido atualizada desde a lista.</p><p>Os números foram interpretados na coleta. Esta exibição preserva o texto disponível, mas não certifica a precisão do número original recebido.</p>{o.source&&<small>Versão da observação: {o.source.source_version}. Identificador do conteúdo: <code>{o.source.source_hash}</code>.</small>}</details>
 </section>;
}
type Selection={id:string};
function ObservationsView({controller,actor,warehouseSourceId}:{controller:StockObservationsController;actor:string;warehouseSourceId:string}){
 const alive=useRef(true),request=useRef<AbortController|null>(null),selected=useRef<Selection|null>(null);
 const [page,setPage]=useState<StockObservationsPage|null>(null),[detail,setDetail]=useState<StockObservationsDetail|null>(null),[selection,setSelection]=useState<Selection|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState(''),[cursors,setCursors]=useState<(string|null)[]>([null]),[reload,setReload]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const live=useRef({page,query,cursors});live.current={page,query,cursors};
 const may=()=>alive.current&&canRead(controller.getSnapshot())&&controller.getSnapshot().membership?.user_id===actor;
 const valid=(p:AbortController)=>may()&&!p.signal.aborted&&request.current===p;
 const start=()=>{request.current?.abort();const p=new AbortController();request.current=p;setBusy(true);setError('');return p;};
 const finish=(p:AbortController)=>{if(request.current===p){request.current=null;if(may())setBusy(false);}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();selected.current=null;};},[]);
 const after=cursors.at(-1)??null;
 useEffect(()=>{if(!may())return;const p=start();live.current.page=null;setPage(null);
  void(async()=>{try{const raw=await controller.stockObservations(stockObservationsListPath(warehouseSourceId,filter,after),{method:'GET',signal:p.signal});if(valid(p))setPage(parseStockObservationsPage(raw,{warehouseSourceId,limit:25,after}));}catch(e){if(valid(p))setError(message(e));}finally{finish(p);}})();
  return()=>{p.abort();if(request.current===p)request.current=null;};
 },[filter,after,reload]);
 const loadDetail=async(expected:Selection)=>{if(!may()||request.current||selected.current!==expected)return;const p=start();setDetail(null);
  try{const raw=await controller.stockObservations(stockObservationsDetailPath(warehouseSourceId,expected.id),{method:'GET',signal:p.signal});if(valid(p)&&selected.current===expected)setDetail(parseStockObservationsDetail(raw,{warehouseSourceId,productSourceId:expected.id}));}catch(e){if(valid(p)&&selected.current===expected)setError(message(e));}finally{finish(p);}
 };
 const inspect=(row:StockObservationRow,expected:StockObservationsPage)=>{if(!may()||request.current||selected.current||live.current.page!==expected||!expected.items.includes(row))return;const s={id:row.product_source_id};selected.current=s;setSelection(s);void loadDetail(s);};
 const back=(expected:Selection)=>{if(!may()||selected.current!==expected)return;request.current?.abort();request.current=null;selected.current=null;setSelection(null);setDetail(null);setBusy(false);setError('');};
 const listFree=(expected:StockObservationsPage|null)=>may()&&!request.current&&!selected.current&&live.current.page===expected;
 const refreshList=(expected:StockObservationsPage|null)=>{if(!listFree(expected))return;live.current.page=null;setPage(null);setReload(n=>n+1);};
 const search=(e:FormEvent)=>{e.preventDefault();if(!listFree(page))return;live.current.page=null;setPage(null);setFilter(live.current.query.trim());setCursors([null]);setReload(n=>n+1);};
 const pageChange=(expected:StockObservationsPage,next:boolean)=>{if(!listFree(expected))return;if(next&&!expected.next_cursor||!next&&live.current.cursors.length===1)return;live.current.page=null;setPage(null);setCursors(c=>next?[...c,expected.next_cursor]:c.slice(0,-1));};
 const warehouse=detail?.warehouse??page?.warehouse;
 return <section className="stock-observations" aria-busy={busy}><header className="real-heading"><div><h1>Estoque informado pelo Origin</h1><p>Consulte as quantidades observadas no depósito vinculado.</p></div><span className="real-mode">Somente consulta</span></header>
  {warehouse&&<Warehouse value={warehouse}/>}<p>Esta consulta não altera o estoque do FAGOO. Ausência de informação não significa quantidade zero.</p>
  {error&&<p className="real-error" role="alert">{error}</p>}
  {selection?<>{busy&&<p role="status">Consultando produto…</p>}{detail?<ProductDetail value={detail} loading={busy} onBack={()=>back(selection)} onRefresh={()=>void loadDetail(selection)}/>:<div className="stock-observations-actions"><button type="button" className="secondary-button" onClick={()=>back(selection)}>Voltar à lista</button>{!busy&&<button type="button" className="secondary-button" onClick={()=>void loadDetail(selection)}>Tentar consulta novamente</button>}</div>}</>:<>
   <form className="stock-observations-actions" onSubmit={search}><label htmlFor="stock-observed-query">Produto, código ou ID no Origin<input id="stock-observed-query" type="search" maxLength={100} value={query} disabled={busy} onChange={e=>{if(listFree(page)){live.current.query=e.target.value;setQuery(e.target.value);}}}/></label><button type="submit" className="secondary-button" disabled={busy}>Pesquisar</button><button type="button" className="secondary-button" disabled={busy} onClick={()=>refreshList(page)}>Atualizar lista</button></form>
   <p role="status">{busy?'Consultando estoque…':page?`${page.items.length} produto(s) nesta página`:'Lista não conferida'}</p>
   {page&&<>{page.items.length?<div className="table-scroll" role="region" aria-label="Produtos e quantidades observadas" tabIndex={0}><table className="data-table"><thead><tr><th>Produto</th><th>Físico no depósito</th><th>Virtual no depósito</th><th>Observação</th><th>Consulta</th></tr></thead><tbody>{page.items.map(row=><tr key={row.product_source_id}><td><strong>{stockProductName(row)}</strong><small>Código: {stockObserved(row.product.source_code)}</small><small>ID {row.product_source_id}</small></td><td>{stockObserved(row.observation.warehouse.physical,true)}</td><td>{stockObserved(row.observation.warehouse.virtual,true)}</td><td>{stockObservationLabel(row)}<small>{stockObservedMoment(row.observation.source?.last_seen_at??null)}</small></td><td><button type="button" className="text-button" onClick={()=>inspect(row,page)}>Conferir produto {row.product_source_id}</button></td></tr>)}</tbody></table></div>:<p>Nenhum produto encontrado nesta consulta.</p>}
    <footer className="stock-observations-actions"><span>Página {cursors.length}</span><button type="button" className="secondary-button" disabled={busy||cursors.length===1} onClick={()=>pageChange(page,false)}>Página anterior</button><button type="button" className="secondary-button" disabled={busy||!page.has_more} onClick={()=>pageChange(page,true)}>Próxima página</button></footer>
    <details className="stock-observations-panel"><summary>Sobre esta consulta</summary><p>A lista inclui produtos coletados e observações de estoque. As contagens abaixo abrangem a coleta disponível antes do filtro, sem certificar a cobertura completa do Origin.</p><dl className="stock-observations-values"><div><dt>Produtos com identificação na coleta</dt><dd>{page.counts.known_product_ids}</dd></div><div><dt>Produtos com estoque observado</dt><dd>{page.counts.stock_observation_ids}</dd></div><div><dt>Produtos sem observação de estoque</dt><dd>{page.counts.known_without_observation}</dd></div><div><dt>Observações sem cadastro de produto coletado</dt><dd>{page.counts.observation_without_product}</dd></div></dl><p>Identificações inválidas não são associadas: {page.counts.invalid_product_ids} em produtos e {page.counts.invalid_stock_ids} em estoque.</p><p>Os números já foram interpretados na coleta. Não há cálculo de saldo disponível, comparação de unidades, conciliação ou abertura de estoque nesta tela.</p><small>Consulta realizada em {stockObservedMoment(page.observed_at)}.</small></details>
   </>}
  </>}
 </section>;
}
export default function OriginStockObservations({controller,warehouseSourceId}:{controller:StockObservationsController;warehouseSourceId:string}){
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot),identity=useRef({controller,version:0});
 if(identity.current.controller!==controller)identity.current={controller,version:identity.current.version+1};
 if(!canRead(snapshot))return <section className="stock-observations"><h1>Estoque informado pelo Origin</h1><p role="alert">Esta consulta exige acesso ativo de administrador.</p></section>;
 if(!stockObservationSourceId(warehouseSourceId))return <section className="stock-observations"><h1>Estoque informado pelo Origin</h1><p role="alert">Selecione um depósito vinculado para consultar as observações.</p></section>;
 return <ObservationsView key={`${snapshot.membership!.user_id}:${warehouseSourceId}:${identity.current.version}`} controller={controller} actor={snapshot.membership!.user_id} warehouseSourceId={warehouseSourceId}/>;
}
