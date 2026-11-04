import { originHistoryAvailable } from '../lib/integration-capabilities';
import { nativeIndicatorCoverageText } from '../lib/document-reports-model';
import {useEffect,useId,useMemo,useState,useSyncExternalStore} from 'react';
import {Link,useLocation,useNavigate} from 'react-router-dom';
import {AccessError} from '../lib/real-access';
import {badgeClass} from '../lib/origin-list';
import {DOCUMENT_LABELS,STATES} from '../lib/real-documents-model';
import {financeDate,financeMoney,todaySP} from '../lib/real-finance-model';
import HomeNewInvoices from './HomeNewInvoices';
import ReleaseNotesPanel from './ReleaseNotesPanel';
import type {PlatformPort} from '../lib/platform-model';
import {HOME_BUCKET_LABELS,HOME_CATALOG_LABELS,HOME_PERIOD_OPTIONS,homeCustomRoute,homeNetCents,homePeriodMatches,homePeriodRoute,homePeriodSearch,homePeriodText,homeSalesLines,homeSessionAccess,homeSummaryPath,type HomeController,type HomePeriodKey,type HomePeriodRoute,type HomeSummary} from '../lib/home-model';
import {resolveMenu,type CompanyAccess} from '../lib/origin-menu';
import {workspaceActions} from '../lib/workspace-actions';
import {PeriodPicker} from './OriginList';
import {HomeChart} from './HomeChart';
import {HomeChartCards} from './HomeChartCards';
import {HomeFavorites} from './HomeFavorites';
import {HomeProfileCard} from './CompanyChrome';
import {HomeExpiring} from './HomeExpiring';
import {Icon} from './Icon';
import './real-home.css';

const count=(value:number)=>value.toLocaleString('pt-BR');
const ORDER=['sales_orders','sales_proposals','purchase_orders','service_orders'];
const PANEL_KEY='brufap.erp.home-panel',VALUES_KEY='brufap.erp.home-values';
const noSubscription=()=>()=>{},noSnapshot=()=>null;
// Origin "Resumo diário": "Atualizado Hoje às 09:56" (horário de São Paulo).
const updated=(asOf:string,businessDate:string)=>{const date=new Date(asOf),day=todaySP(date),time=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}).format(date);return `${day===businessDate?'hoje':`em ${financeDate(day)}`} às ${time}`;};
function readPanel(){try{return globalThis.localStorage?.getItem(PANEL_KEY)!=='closed';}catch{return true;}}
// O olho do Origin oculta os valores; a escolha fica neste navegador.
function readHidden(){try{return globalThis.localStorage?.getItem(VALUES_KEY)==='hidden';}catch{return false;}}

/** The page belongs to one actor and role: a session or permission change remounts it without old data. */
export default function RealHome({controller}:{controller:HomeController}){
  const tracked=typeof controller.getSnapshot==='function';
  const session=useSyncExternalStore(controller.subscribe??noSubscription,controller.getSnapshot??noSnapshot);
  const access=homeSessionAccess(session);
  if(tracked&&!access)return <p className="real-result-status" role="status">Verificando permissões…</p>;
  const scope=access?`${access.user_id}:${access.role}:${(access.resources||[]).join(',')}`:'isolated';
  return <HomeView key={scope} controller={controller} access={access}/>;
}

function HomeView({controller,access}:{controller:HomeController;access:CompanyAccess|null}){
  const location=useLocation(),navigate=useNavigate();
  const route=useMemo<{value:HomePeriodRoute|null;error:string}>(()=>{try{return {value:homePeriodRoute(location.search),error:''};}catch(failure){return {value:null,error:(failure as Error).message};}},[location.search]);
  const routeKey=route.value?homeSummaryPath(route.value):'';
  const [summary,setSummary]=useState<HomeSummary|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const [panel,setPanel]=useState(readPanel),[hidden,setHidden]=useState(readHidden),[customizing,setCustomizing]=useState(false),[periodError,setPeriodError]=useState(''),sideId=useId();
  const documents=summary?.documents.slice().sort((a,b)=>ORDER.indexOf(a.kind)-ORDER.indexOf(b.kind))??[];
  const financeTitles=summary?.finance?.titles.slice().sort((a,b)=>a.kind===b.kind?0:a.kind==='receivable'?-1:1)??[];
  const period=summary?.period;
  const money=(cents:string)=>hidden?'R$ ••••':financeMoney(cents);
  const role=access?.role??summary?.role;
  // Quick actions come from the destinations this access already has in the menu; nothing new is granted here.
  const quick=useMemo(()=>access?workspaceActions(resolveMenu('real',access),access.role):[],[access]);
  const togglePanel=()=>{const next=!panel;setPanel(next);try{globalThis.localStorage?.setItem(PANEL_KEY,next?'open':'closed');}catch{/* Visit only. */}};
  const toggleHidden=()=>{const next=!hidden;setHidden(next);try{globalThis.localStorage?.setItem(VALUES_KEY,next?'hidden':'visible');}catch{/* Visit only. */}};
  useEffect(()=>{
    setSummary(null);setError('');
    if(!route.value){setLoading(false);return;}
    const request=new AbortController(),expected=route.value;setLoading(true);
    void controller.home(homeSummaryPath(expected),{signal:request.signal}).then(value=>{
      if(request.signal.aborted)return;
      const result=value as HomeSummary;
      if(!homePeriodMatches(result?.period,expected))throw new AccessError(502);
      setSummary(result);setLoading(false);
    }).catch(failure=>{
      if(request.signal.aborted)return;
      setLoading(false);setError(failure instanceof AccessError&&failure.status===403?'Seu acesso ao painel precisa ser verificado.':'Não foi possível carregar o resumo. Tente novamente.');
    });return()=>request.abort();
  },[controller,reload,routeKey]);
  // Back/forward changes the period from outside the selector: an open "Customizado" choice no longer applies.
  useEffect(()=>{setCustomizing(false);setPeriodError('');},[routeKey]);
  const go=(next:HomePeriodRoute)=>{setPeriodError('');navigate(`${location.pathname}${homePeriodSearch(next)}`);};
  const choose=(key:HomePeriodKey)=>{setPeriodError('');if(key==='customizado'){setCustomizing(true);return;}setCustomizing(false);go({key,from:null,to:null});};
  const applyCustom=(range:{from:string;to:string})=>{try{const next=homeCustomRoute(range.from,range.to);setCustomizing(false);go(next);}catch(failure){setPeriodError((failure as Error).message);}};
  const activeKey=customizing?'customizado':route.value?.key;
  const today=summary?.business_date??todaySP();
  const pickerRange=route.value?.key==='customizado'?{from:route.value.from??'',to:route.value.to??''}:period?{from:period.from,to:period.to}:{from:today,to:today};
  const documentCard=(row:HomeSummary['documents'][number])=><article className="home-card" key={row.kind}>
    <header><h3><Link className="home-card-title" to={`/documentos-empresa?tipo=${row.kind}`}>{DOCUMENT_LABELS[row.kind]}<Icon name="right" size={11}/></Link></h3></header>
    <ul className="home-dots"><li><span className="home-dot home-dot-total" aria-hidden="true"/><span>Total</span><strong>{count(row.count)}</strong></li>
      {row.statuses.filter(status=>status.count>0).map(status=>{const label=(STATES[row.kind] as Record<string,string>)[status.status]||status.status;return <li key={status.status}><span className={`home-dot ${badgeClass(label)}`} aria-hidden="true"/><span>{label}</span><strong>{count(status.count)}</strong></li>;})}</ul>
    {row.count===0&&<p className="real-help">Nenhum documento registrado.</p>}
    <p className="home-card-note">Todo o histórico registrado no FAGOO.</p>
  </article>;
  const financeLink=(kind:'receivable'|'payable')=>period?`/financeiro-empresa?${new URLSearchParams({area:kind,from:period.from,to:period.to})}`:`/financeiro-empresa?area=${kind}`;
  return <div className="home-page fagoo-overview">
    <header className="fagoo-overview-header"><div><p className="fagoo-eyebrow">{role==='vendas'?'PAINEL DE VENDAS':'PAINEL DA EMPRESA'}</p><h1>{role==='vendas'?'Suas vendas, em perspectiva.':'Seu negócio, em perspectiva.'}</h1><p>{role==='vendas'?'Comece um pedido, consulte clientes e produtos e acompanhe o período.':'Uma visão dos resultados e do que precisa da sua atenção.'}</p></div><span className="fagoo-overview-date"><Icon name="calendar-days" size={17}/>{financeDate(today)}</span></header>
    {quick.length>0&&<nav className="fagoo-quick-actions" aria-label="Ações rápidas">{quick.map(action=><Link key={action.id} to={action.to} className={action.create?'is-create':undefined}>
      <span className="fagoo-quick-icon" aria-hidden="true"><Icon name={action.icon} size={18}/></span><span className="fagoo-quick-text"><strong>{action.label}</strong><small>{action.description}</small></span>
      <span className="fagoo-quick-keys"><span className="sr-only">Atalho:</span>{action.keys.map(key=><kbd key={key}>{key}</kbd>)}</span></Link>)}</nav>}
    <div className="home-main">

      <p className="home-alert"><Icon name="circle-info" size={16}/><span>{nativeIndicatorCoverageText(summary) ?? 'Este resumo considera os registros da sua empresa no FAGOO. Os indicadores serão preenchidos conforme os cadastros e movimentações forem registrados.'}</span></p>
      <HomeExpiring controller={controller as Parameters<typeof HomeExpiring>[0]['controller']} role={role}/>

      <section className="home-daily" aria-labelledby="home-daily-title">
        <header className="home-daily-head"><h2 id="home-daily-title">Resumo diário</h2>
          {summary&&<span className="home-updated">Atualizado {updated(summary.as_of,summary.business_date)} · São Paulo</span>}
          <button type="button" className="home-icon-button" title="Atualizar resumo" aria-label="Atualizar resumo" onClick={()=>setReload(value=>value+1)} disabled={loading||!route.value}><Icon name="arrows-rotate" size={13}/></button>
          <button type="button" className="home-icon-button" title={hidden?'Exibir valores':'Ocultar valores'} aria-label={hidden?'Exibir valores':'Ocultar valores'} aria-pressed={hidden} onClick={toggleHidden}><Icon name={hidden?'eye-slash':'eye'} size={13}/></button>
        </header>
        <div className="home-period" role="group" aria-label="Período do resumo">
          <div className="home-period-options">{HOME_PERIOD_OPTIONS.map(option=><button type="button" key={option.key} className={activeKey===option.key?'is-active':''} aria-pressed={activeKey===option.key} onClick={()=>choose(option.key)}>{option.label}</button>)}</div>
          {activeKey==='customizado'&&<PeriodPicker from={pickerRange.from} to={pickerRange.to} today={today} noFuture onApply={range=>applyCustom({from:range.from,to:range.to})}/>}
          {period&&<span className="home-period-text">Período: {homePeriodText(period)}</span>}
        </div>
        {(periodError||route.error)&&<p className="real-alert" role="alert">{periodError||route.error}</p>}
        {error&&<p className="real-alert" role="alert">{error}</p>}{loading&&<p className="real-result-status" role="status">Carregando resumo da empresa…</p>}
        {period&&<><div className="fagoo-metrics" aria-label="Indicadores do período">
          <article className="fagoo-metric fagoo-metric-sales"><span><Icon name="chart-line" size={20}/>Vendas no período</span><strong>{money(homeSalesLines(period.sales)[0]?.total_cents??'0')}</strong><small>{count(homeSalesLines(period.sales)[0]?.count??0)} pedido(s), sem os cancelados</small></article>
          {period.receivable&&<article className="fagoo-metric"><span><Icon name="arrow-down" size={20}/>A receber no período</span><strong>{money(period.receivable.open_cents)}</strong><small>Saldo em aberto dos títulos por vencimento</small></article>}
          {period.payable&&<article className="fagoo-metric"><span><Icon name="arrow-up" size={20}/>A pagar no período</span><strong>{money(period.payable.open_cents)}</strong><small>Saldo em aberto dos títulos por vencimento</small></article>}
        </div>
        <HomeChartCards controller={controller as Parameters<typeof HomeChartCards>[0]['controller']} role={role} period={period} hidden={hidden} asOf={summary!.as_of} resumo={<HomeChart period={period} hidden={hidden} asOf={summary!.as_of}/>}/>
        <details className="fagoo-home-details"><summary>Detalhamento do período<Icon name="chevron-down" size={15}/></summary><div className="home-cards">
          <article className="home-card"><header><h3><Link className="home-card-title" to="/documentos-empresa?tipo=sales_orders">Pedidos de venda<Icon name="right" size={11}/></Link></h3></header>
            <ul className="home-dots home-sales">{homeSalesLines(period.sales).map(line=><li key={line.id} title={line.detail}><span className={`home-dot home-dot-${line.dot}`} aria-hidden="true"/><strong>{count(line.count)}</strong><span>{line.label}</span><em>{money(line.total_cents)}</em></li>)}</ul>
            <p className="home-card-note">Pedidos pela data do pedido no período.</p>
          </article>
          {period.receivable&&<article className="home-card"><header><h3><Link className="home-card-title" to={financeLink('receivable')}><Icon name="arrow-down" size={12} className="home-arrow-receivable"/><span className="home-card-count">{count(period.receivable.count)}</span>{' '}Contas a receber<Icon name="right" size={11}/></Link></h3></header>
            <dl className="home-values"><div><dt>Total</dt><dd>{money(period.receivable.total_cents)}</dd></div><div className="home-muted"><dt>Taxas</dt><dd>{money(period.receivable.fee_cents)}</dd></div>
              <div className="home-net"><dt>Líquido</dt><dd>{money(homeNetCents(period.receivable))}</dd></div><div className="home-muted"><dt>Saldo em aberto</dt><dd>{money(period.receivable.open_cents)}</dd></div></dl>
            <p className="home-card-note">Títulos com vencimento no período, sem os cancelados. Taxas são as tarifas registradas nas baixas.</p>
          </article>}
          {period.payable&&<article className="home-card"><header><h3><Link className="home-card-title" to={financeLink('payable')}><Icon name="arrow-up" size={12} className="home-arrow-payable"/><span className="home-card-count">{count(period.payable.count)}</span>{' '}Contas a pagar<Icon name="right" size={11}/></Link></h3></header>
            <dl className="home-values"><div className="home-total"><dt>Valor total a pagar</dt><dd>{money(period.payable.total_cents)}</dd></div><div className="home-muted"><dt>Saldo em aberto</dt><dd>{money(period.payable.open_cents)}</dd></div></dl>
            <p className="home-card-note">Títulos com vencimento no período, sem os cancelados.</p>
          </article>}
          {/* Leva H (PRF-252): real NF-es synced from Origin or received from SEFAZ since the last view, never drafts or homologation. */}
          {role&&['admin','consulta','fiscal'].includes(role)&&<HomeNewInvoices controller={controller as unknown as Partial<PlatformPort>}/>}
        </div></details></>}
      </section>
      {summary?.finance&&<section className="home-section" aria-labelledby="home-due-title"><h2 id="home-due-title">Contas em aberto por vencimento</h2><div className="home-cards">
        {financeTitles.map(row=>{const total=row.buckets.reduce((sum,bucket)=>sum+BigInt(bucket.balance_cents),0n).toString(),titles=row.buckets.reduce((sum,bucket)=>sum+bucket.count,0);return <article className="home-card" key={row.kind}>
          <header><h3><Link className="home-card-title" to={`/financeiro-empresa?area=${row.kind}`}><Icon name={row.kind==='receivable'?'arrow-down':'arrow-up'} size={12} className={`home-arrow-${row.kind}`}/><span className="home-card-count">{count(titles)}</span>{' '}{row.kind==='receivable'?'Contas a receber':'Contas a pagar'}<Icon name="right" size={11}/></Link></h3></header>
          <dl className="home-values"><div className="home-total"><dt>{row.kind==='receivable'?'Total':'Valor total a pagar'}</dt><dd>{money(total)}</dd></div>
            {row.buckets.map(bucket=><div key={bucket.bucket} className={bucket.bucket==='overdue'&&bucket.count>0?'home-overdue':''}><dt>{HOME_BUCKET_LABELS[bucket.bucket]}<small>{count(bucket.count)} título(s)</small></dt><dd>{money(bucket.balance_cents)}</dd></div>)}</dl>
          <p className="home-card-note">Valores pendentes por vencimento, descontando as baixas já registradas.</p>
        </article>;})}
        <article className="home-card home-cash"><header><h3><Link className="home-card-title" to="/financeiro-empresa?area=accounts">Caixas e bancos<Icon name="right" size={11}/></Link></h3></header>
          <dl className="home-values"><div className="home-total"><dt>Saldo registrado em caixas e bancos</dt><dd>{money(summary.finance.accounts.recorded_balance_cents)}</dd></div><div><dt>Contas ativas</dt><dd>{count(summary.finance.accounts.active)}</dd></div></dl>
          {summary.finance.accounts.opening_pending>0&&<p className="home-pending">{count(summary.finance.accounts.opening_pending)} sem saldo inicial informado</p>}
          <p className="home-card-note">Soma dos movimentos de todas as contas, inclusive arquivadas. Não é consulta ao banco nem conciliação bancária.</p>
        </article>
      </div></section>}
      {summary&&<section className="home-section" aria-labelledby="home-documents-title"><h2 id="home-documents-title">Documentos por situação</h2><div className="home-cards">{documents.map(documentCard)}</div></section>}
      {summary?.stock&&<section className="home-section" aria-labelledby="home-stock-title"><h2 id="home-stock-title">Estoque</h2><article className="home-card"><header><Link className="home-card-title" to="/estoque-empresa">Lançamentos de estoque<Icon name="right" size={11}/></Link></header><div className="home-stock-grid"><div><strong>{count(summary.stock.products)}</strong><span>Produtos com posição controlada</span></div><div><strong>{count(summary.stock.positive_positions)}</strong><span>Posições com saldo positivo</span></div><div><strong>{count(summary.stock.zero_positions)}</strong><span>Posições com saldo zero</span></div>{summary.stock.positions-summary.stock.positive_positions-summary.stock.zero_positions>0&&<div className="home-stock-negative"><strong>{count(summary.stock.positions-summary.stock.positive_positions-summary.stock.zero_positions)}</strong><span>Posições com saldo negativo</span></div>}</div><p className="home-card-note">Cada posição corresponde a um produto em um depósito. Produtos sem posição registrada não entram nessa contagem.</p></article></section>}
      {summary&&<section className="home-section" aria-labelledby="home-catalog-title"><h2 id="home-catalog-title">Cadastros</h2><div className="home-catalog-grid">{summary.catalog.map(row=><Link className="home-card home-catalog-card" key={row.entity} to={`/cadastros-reais?cadastro=${row.entity}`}><h3 className="home-card-title">{HOME_CATALOG_LABELS[row.entity]}<Icon name="right" size={11}/></h3><strong>{count(row.active)}</strong><span>ativo(s) · {count(row.archived)} arquivado(s)</span></Link>)}</div></section>}
      <ReleaseNotesPanel/>
    </div>
    <aside className="home-side fagoo-overview-side" aria-label="Atalhos da empresa">
      <section className="fagoo-priorities" aria-labelledby="fagoo-priority-title"><p className="fagoo-eyebrow">ACOMPANHAMENTO</p><h2 id="fagoo-priority-title">Precisa de atenção</h2>
        {summary?.finance&&financeTitles.map(row=>{const due=row.buckets.filter(bucket=>bucket.bucket==='overdue'||bucket.bucket==='today');const quantity=due.reduce((sum,bucket)=>sum+bucket.count,0);return <Link key={row.kind} to={`/financeiro-empresa?area=${row.kind}`}><span className="fagoo-priority-icon"><Icon name={row.kind==='payable'?'arrow-up':'arrow-down'} size={18}/></span><span><strong>{row.kind==='payable'?'Pagamentos':'Recebimentos'}</strong><small>{count(quantity)} título(s) vencido(s) ou para hoje</small></span><Icon name="chevron-right" size={13}/></Link>;})}
        {summary?.stock&&<Link to="/estoque-empresa"><span className="fagoo-priority-icon"><Icon name="box" size={18}/></span><span><strong>Posições sem saldo</strong><small>{count(summary.stock.zero_positions)} posição(ões) com saldo zero</small></span><Icon name="chevron-right" size={13}/></Link>}
        {summary&&!summary.finance&&!summary.stock&&<p className="real-help">Acompanhe seus documentos no resumo ao lado.</p>}
      </section>
      <button type="button" className="home-side-toggle" aria-expanded={panel} aria-controls={sideId} aria-label={panel?'Recolher painel lateral':'Expandir painel lateral'} title={panel?'Recolher painel lateral':'Expandir painel lateral'} onClick={togglePanel}><Icon name="bars" size={15}/></button>
      <div className="home-side-body" id={sideId} hidden={!panel}>
        <HomeProfileCard controller={controller as Parameters<typeof HomeProfileCard>[0]["controller"]}/>
        <HomeFavorites controller={controller} access={access}/>
        <nav aria-label="Outras consultas"><ul className="home-favorites home-favorites-brufap">
          {originHistoryAvailable(access)&&<li><Link to="/dados-origin"><Icon name="bookmark" size={12}/>Consultar histórico do Origin</Link></li>}
          {role&&['admin','financeiro','consulta'].includes(role)&&<li><Link to="/cobranca-empresa"><Icon name="bookmark" size={12}/>Cobrança bancária</Link></li>}
          {role==='admin'&&<li><Link to="/importar-cadastros"><Icon name="bookmark" size={12}/>Importar cadastros</Link></li>}
        </ul></nav>
      </div>
    </aside>
  </div>;
}
