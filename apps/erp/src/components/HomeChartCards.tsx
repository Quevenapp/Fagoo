import { nativeIndicatorCoverageText } from '../lib/document-reports-model';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {AccessError} from '../lib/real-access';
import {useUnsavedChanges} from '../hooks/useUnsavedChanges';
import {CHARTS_PATH,HOME_CHART_LABELS,TOP_PRODUCT_ROLES,captureHomeChartsSave,parseHomeCharts,parseHomeChartsResult,parseTopProducts,captureTopProductsQuery,topProductsPath,
 type HomeChart,type HomeChartsView,type HomeChartsSaveInput,type TopProductsView} from '../lib/system-model';
import type {NativeRequestOptions} from '../lib/real-access';
import {financeMoney} from '../lib/real-finance-model';
import {homeChartUpdated,homeChartValues,moveChart,type HomePeriod} from '../lib/home-model';
import {Icon} from './Icon';

type Port={system?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};
// Origin tooltips of the home chart cards.
const HINTS:Record<HomeChart,string>={resumo:'Pedidos de venda e contas por dia ou por mês no período escolhido.',ticket_medio:'Valor total das vendas dividida pela quantidade de vendas no período.',
 valor_faturado:'Soma do valor das vendas. Desconsiderando vendas canceladas.',quantidade_pedidos:'Quantidade de pedidos de venda no período, sem os cancelados.',top_skus:'Os 5 produtos com mais unidades vendidas no período, sem pedidos cancelados.'};
const qty=(value:string)=>{const [whole,fraction='']=value.split('.');const f=fraction.replace(/0+$/,'');return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')}${f?`,${f}`:''}`;};
type Attempt={body:HomeChartsSaveInput;uncertain:boolean};
// The leave guard exists only while a charts command waits for Conferir resultado (the favorites keep their own guard).
function PendingGuard({busy}:{busy:boolean}){useUnsavedChanges(true,busy);return null;}

/** Página inicial: the charts each user chooses and orders (Origin "Incluir gráficos", migration 189). Valores por dia is the
 * chart Brufap already had (`resumo`). Every change is one command (CAS by version, idempotent, audited); an uncertain answer
 * keeps the same command for "Conferir resultado". Without the charts list (before 189, or an error) only Valores por dia shows.
 * Origin "Atualizado em" of the charts: Valores por dia carries it; when that chart is hidden the header carries it instead. */
export function HomeChartCards({controller,role,period,hidden,resumo,asOf}:{controller:Port;role:string|undefined;period:HomePeriod;hidden:boolean;resumo:ReactNode;asOf?:string}){
 const [view,setView]=useState<HomeChartsView|null>(null),[loadFailed,setLoadFailed]=useState(false),[top,setTop]=useState<TopProductsView|null>(null),[topFailed,setTopFailed]=useState(false);
 const [choosing,setChoosing]=useState(false),[draft,setDraft]=useState<HomeChart[]>([]),[menu,setMenu]=useState<HomeChart|null>(null),[dragging,setDragging]=useState<HomeChart|null>(null);
 const [busy,setBusy]=useState(false),[pending,setPending]=useState(false),[message,setMessage]=useState(''),[reload,setReload]=useState(0);
 const attempt=useRef<Attempt|null>(null),alive=useRef(true),system=typeof controller.system==='function'?controller.system:null;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!system)return;const p=new AbortController();setLoadFailed(false);
  void system(CHARTS_PATH,{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setView(parseHomeCharts(raw));}).catch(()=>{if(!p.signal.aborted){setView(null);setLoadFailed(true);}});return()=>p.abort();},[system,reload]);
 const charts:HomeChart[]=view?view.charts:['resumo'];
 const wantsTop=Boolean(system&&role&&TOP_PRODUCT_ROLES.includes(role as never)&&charts.includes('top_skus'));
 const topKey=`${period.key}:${period.from}:${period.to}`;
 useEffect(()=>{setTop(null);setTopFailed(false);if(!wantsTop||!system)return;const p=new AbortController();
  const q=captureTopProductsQuery({periodo:period.key,...(period.key==='customizado'?{de:period.from,ate:period.to}:{})});
  void system(topProductsPath(q.key,q.from,q.to),{method:'GET',signal:p.signal}).then(raw=>{if(!p.signal.aborted)setTop(parseTopProducts(raw,q));}).catch(()=>{if(!p.signal.aborted)setTopFailed(true);});return()=>p.abort();},[system,wantsTop,topKey]);
 const run=async(a:Attempt)=>{if(!system||busy||attempt.current!==a)return;setBusy(true);setMessage('');try{
  const r=parseHomeChartsResult(await system(CHARTS_PATH,{method:'POST',body:a.body}),a.body);if(!alive.current||attempt.current!==a)return;
  attempt.current=null;setPending(false);setView({scope:r.scope,data_mode:r.data_mode,role:r.role,version:r.version,customized:r.customized,charts:r.charts,available:r.available});
  setMessage(r.replayed?'Resultado conferido: os gráficos já estavam salvos.':'Gráficos salvos.');
 }catch(e){if(!alive.current||attempt.current!==a)return;
  // The SQL replays a recorded command before checking the version: on Conferir resultado a 400 or 409 to the same command
  // proves it was never recorded, so the list is reloaded instead of staying pending. A 403 comes before the replay.
  if(e instanceof AccessError&&(a.uncertain?[400,409]:[400,403,409]).includes(e.status)){attempt.current=null;setPending(false);setReload(n=>n+1);
   setMessage(e.status===409?'Os gráficos foram alterados em outra sessão. A lista foi recarregada.':'Não foi possível salvar os gráficos. A lista foi recarregada.');}
  else{a.uncertain=true;setPending(true);setMessage('Não foi possível confirmar se os gráficos foram salvos. Confira o resultado antes de alterar novamente.');}
 }finally{if(alive.current)setBusy(false);}};
 const save=(next:HomeChart[])=>{if(!view||busy||attempt.current)return;const a:Attempt={body:captureHomeChartsSave({command_id:crypto.randomUUID(),expected_version:view.version,charts:next}),uncertain:false};
  attempt.current=a;setMenu(null);void run(a);};
 const locked=!view||busy||pending;
 const values=homeChartValues(period),money=(cents:string)=>hidden?'R$ ••••':financeMoney(cents);
 const body=(key:HomeChart)=>{switch(key){
  case'resumo':return resumo;
  case'ticket_medio':return <strong className="home-chart-card-value">{money(values.ticket_cents)}</strong>;
  case'valor_faturado':return <strong className="home-chart-card-value">{money(values.billed_cents)}</strong>;
  case'quantidade_pedidos':return <strong className="home-chart-card-value">{values.orders.toLocaleString('pt-BR')}</strong>;
  case'top_skus':return topFailed?<p className="real-help">Não foi possível carregar os produtos mais vendidos.</p>:!top?<p role="status" className="real-help">Carregando…</p>
   :top.items.length?<ol className="home-top-skus">{top.items.map(p=><li key={p.product_id}><span>{p.code?`${p.code} · `:''}{p.name}</span><strong>{qty(p.units)} un.</strong></li>)}</ol>:<p className="real-help">Nenhum produto vendido no período.</p>;
 }};
 const shown=charts.filter(key=>key!=='top_skus'||wantsTop||!view);
 return <section className="home-chart-cards" aria-label="Gráficos">
  {view&&<header className="home-chart-cards-head"><h2>Gráficos</h2>{asOf&&!shown.includes('resumo')&&<small className="home-chart-updated">{homeChartUpdated(asOf)}</small>}
   <button type="button" className="home-icon-button" title="Incluir gráficos" aria-label="Incluir gráficos" disabled={locked} onClick={()=>{setDraft([...view.charts]);setChoosing(true);}}><Icon name="plus" size={12}/></button></header>}
  {loadFailed&&<p className="real-help">A escolha de gráficos não está disponível agora; mostrando Valores por dia.</p>}
  {wantsTop && nativeIndicatorCoverageText(top) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(top)}</p>}
  <div className="home-chart-cards-grid">{shown.map((key,index)=><article key={key} className={`home-chart-card home-chart-card-${key}${dragging===key?' is-dragging':''}`} aria-label={HOME_CHART_LABELS[key]}
   onDragOver={event=>{if(dragging&&dragging!==key)event.preventDefault();}} onDrop={event=>{event.preventDefault();if(view&&dragging&&dragging!==key)save(moveChart(view.charts,dragging,view.charts.indexOf(key)));setDragging(null);}}>
   {view&&<header className="home-chart-card-head">
    <span className="home-chart-drag" draggable={!locked} title="Arraste para reordenar" aria-hidden="true" onDragStart={()=>setDragging(key)} onDragEnd={()=>setDragging(null)}><Icon name="grip-vertical" size={12}/></span>
    <h3>{HOME_CHART_LABELS[key]}<span className="home-chart-hint" title={HINTS[key]}><Icon name="circle-info" size={10}/><span className="sr-only">{HINTS[key]}</span></span></h3>
    <button type="button" className="home-icon-button" aria-label={`Ações de ${HOME_CHART_LABELS[key]}`} aria-expanded={menu===key} disabled={locked} onClick={()=>setMenu(menu===key?null:key)}><Icon name="ellipsis-vertical" size={12}/></button>
    {menu===key&&<ul className="home-chart-menu" role="menu">
     <li><button type="button" role="menuitem" disabled={index===0} onClick={()=>save(moveChart(view.charts,key,view.charts.indexOf(key)-1))}>Mover para antes</button></li>
     <li><button type="button" role="menuitem" disabled={index===shown.length-1} onClick={()=>save(moveChart(view.charts,key,view.charts.indexOf(key)+1))}>Mover para depois</button></li>
     <li><button type="button" role="menuitem" onClick={()=>save(view.charts.filter(k=>k!==key))}>Excluir gráfico</button></li></ul>}
   </header>}
   {body(key)}</article>)}</div>
  {view&&!shown.length&&<p className="real-help">Nenhum gráfico escolhido. Use “Incluir gráficos” para exibir os gráficos na home.</p>}
  {busy&&<p role="status" className="real-result-status">Salvando gráficos…</p>}
  {message&&!busy&&<p className={pending?'real-alert':'home-favorites-message'} role={pending?'alert':'status'}>{message}</p>}
  {pending&&<PendingGuard busy={busy}/>}
  {pending&&!busy&&attempt.current&&<button type="button" className="secondary-button" onClick={()=>void run(attempt.current!)}>Conferir resultado</button>}
  {choosing&&view&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setChoosing(false);}}><div className="modal home-charts-modal" role="dialog" aria-modal="true" aria-label="Incluir gráficos">
   <h2>Incluir gráficos</h2><p>Selecione os gráficos que deseja exibir ou ocultar na home</p>
   <ul className="home-charts-toggles">{view.available.map(key=><li key={key}><label className="preference-switch" htmlFor={`home-chart-${key}`}><input id={`home-chart-${key}`} type="checkbox" role="switch" checked={draft.includes(key)}
     onChange={event=>setDraft(list=>event.target.checked?[...list.filter(k=>k!==key),key]:list.filter(k=>k!==key))}/><span>{HOME_CHART_LABELS[key]}</span></label></li>)}</ul>
   <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={()=>setChoosing(false)}>Cancelar</button>
    <button type="button" className="primary-button" disabled={locked||JSON.stringify(draft)===JSON.stringify(view.charts)} onClick={()=>{setChoosing(false);save(draft);}}>Salvar alterações</button></div>
  </div></div>}
 </section>;
}
