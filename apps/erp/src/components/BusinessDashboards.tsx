import { nativeIndicatorCoverageText } from '../lib/document-reports-model';
import {PERMISSIONS_PATH} from '../lib/system-model';
import {parseMyPermissions,allowedBy,DASHBOARD_PERMISSIONS,STOCK_DASHBOARD_PERMISSIONS,type MyPermissions} from '../../../../packages/erp-domain/src/user-permissions.mjs';
import {useEffect,useRef,useState,useSyncExternalStore,type FormEvent} from 'react';
import {Link,useLocation} from 'react-router-dom';
import {AccessError,type AccessState,type NativeRequestOptions} from '../lib/real-access';
import {freightPaidPath,readFreightPaid} from '../lib/freight-paid-model';
import {preferencesPagePath} from '../lib/preferences-request';
import {parsePreferencesPage} from '../lib/preferences-model';
import {preferencePage} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import {BUSINESS_MENU,BUSINESS_TITLES,UFS,DEFAULT_STATUSES,businessScreen,businessHref,businessPanelPath,screenAllowed,captureBusinessQuery,parseBusinessPanel,canonicalStatuses,todaySP,shiftDay,monthStart,
 previousMonthRange,forecastPeriod,moneyText,qtyText,pctText,brDate,moment,readError,goalProgress,
 type BusinessController,type BusinessScreen,type BusinessPanel,type BusinessQuery,type BusinessStatus,type BusinessPanelView,type MonthlyPanelView} from '../lib/business-model';
import {KpiCard,StatusChips,DataTable,BarChart,StatusPanel,IndicatorsPanel,dayLabel,monthLabel,type Column} from './BusinessWidgets';
import BusinessGoals from './BusinessGoals';
import {BrazilMap} from './BrazilMap';
import PreferenceSettingsPage from './PreferenceSettingsPage';
import {Icon} from './Icon';
import './business-dashboards.css';

const aborted=(e:unknown)=>e instanceof DOMException&&e.name==='AbortError';
type Draft={statuses:BusinessStatus[];from:string;to:string;compare_from:string;compare_to:string;day:string;compare_day:string;state:string;seller:string;warehouse:string;reserve:'sim'|'nao';mode:'itens'|'desmembrados';
 tab:'todos'|'lucro'|'prejuizo';brand:string;min_days:string;keywords:string[];keyword:string};
function initialDraft(panel:BusinessPanel,today:string,statuses:BusinessStatus[]):Draft{
 const month={from:monthStart(today),to:today},previous=previousMonthRange(month.from,month.to);
 return{statuses,from:panel==='previsao-estoque'?shiftDay(today,-29):panel==='atividade-carteira'?shiftDay(today,-364):month.from,to:today,compare_from:previous.from,compare_to:previous.to,
  day:today,compare_day:shiftDay(today,-1),state:'',seller:'',warehouse:'',reserve:'sim',mode:'itens',tab:'todos',brand:'',min_days:'',keywords:[],keyword:''};
}
/** The request filters of a draft, or null when Origin would answer "Filtros inválidos!". */
function queryOf(panel:BusinessPanel,d:Draft):BusinessQuery|null{
 const statuses=d.statuses.join(',');
 const input:Record<string,string>=panel==='mensal'?{situacoes:statuses,de:d.from,ate:d.to,...(d.compare_from||d.compare_to?{comparar_de:d.compare_from,comparar_ate:d.compare_to}:{})}
  :panel==='diario'?{situacoes:statuses,dia:d.day,...(d.compare_day?{comparar:d.compare_day}:{})}
  :panel==='pedidos-venda'?{situacoes:statuses,de:d.from,ate:d.to,...(d.state?{uf:d.state}:{})}
  :panel==='vendas-vendedor'?{situacoes:statuses,de:d.from,ate:d.to,...(d.seller?{vendedor:d.seller}:{})}
  :panel==='venda-canal'?{}
  :panel==='previsao-estoque'?{de:d.from,ate:d.to,reserva:d.reserve,...(d.warehouse?{deposito:d.warehouse}:{}),...(d.mode!=='itens'?{modo:d.mode}:{})}
  :panel==='margem-pedido'?{situacoes:statuses,de:d.from,ate:d.to,aba:d.tab}
  :panel==='atividade-carteira'?{de:d.from,ate:d.to,...(d.brand.trim()?{marca:d.brand.trim()}:{}),...(d.min_days?{dias:d.min_days}:{}),...(d.keywords.length?{palavras:d.keywords.join(',')}:{})}
  :panel==='curva-abc'?{situacoes:statuses,de:d.from,ate:d.to,...(d.brand.trim()?{marca:d.brand.trim()}:{})}
  :{situacoes:statuses,de:d.from,ate:d.to};
 try{return captureBusinessQuery(panel,input);}catch{return null;}
}
const allowedFor=(s:AccessState,screen:BusinessScreen,actor:string|null)=>s.phase==='ready'&&s.membership?.user_id===actor&&screenAllowed(screen,s.membership?.role);

/** Meu Negócio (Origin dashboard.meu.negocio.php): side menu, filters, Visualizar, tables with exports and the Ajustes modal. */
// 229: Meu Negócio › Dashboard permissions of Sistema › Usuários (the server refuses the panel; the menu says why first).
const NOT_PERMITTED='Seu usuário não tem a permissão deste dashboard (Sistema › Usuários › Permissões).';
export default function BusinessDashboards({controller}:{controller:BusinessController}){
 const location=useLocation(),snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot);
 const actor=useRef(snapshot.membership?.user_id??null),role=snapshot.membership?.role;
 const screen=businessScreen(location.search,role),[help,setHelp]=useState(false),[settings,setSettings]=useState(false),[finished,setFinished]=useState<BusinessStatus[]|null|undefined>(undefined),[reload,setReload]=useState(0);
 // 188: the alíquota of Ajustes (null when the page does not answer it yet).
 const [taxRate,setTaxRate]=useState<string|null>(null);
 const allowed=allowedFor(snapshot,screen,actor.current);
 // "Configurações Meu negócio": the default Situação de Venda of every dashboard (Origin default when unreadable, and when no
 // situação is marked, as the SQL of migration 150 does).
 useEffect(()=>{const p=new AbortController();void(async()=>{try{const raw=await controller.preferences(preferencesPagePath('meu-negocio'),{method:'GET',signal:p.signal});if(p.signal.aborted)return;
  const page=parsePreferencesPage(raw,'meu-negocio'),list=canonicalStatuses(page.items[0]!.value as string[]);setFinished(list.length?list:[...DEFAULT_STATUSES]);
  const rate=page.items.find(i=>i.key==='negocio.aliquota_imposto')?.value;setTaxRate(typeof rate==='string'?rate:null);}catch(e){if(!p.signal.aborted&&!aborted(e)){setFinished(null);setTaxRate(null);}}})();return()=>p.abort();},[controller,reload]);
 const roleOf=(roles:readonly string[])=>Boolean(role)&&roles.includes(role!);
 const [perms,setPerms]=useState<MyPermissions|null>(null);
 useEffect(()=>{const p=new AbortController();setPerms(null);void(async()=>{try{const raw=await controller.system(PERMISSIONS_PATH,{method:'GET',signal:p.signal});if(!p.signal.aborted)setPerms(parseMyPermissions(raw));}
  catch{/* Without the answer every dashboard stays listed; the server still decides. */}})();return()=>p.abort();},[controller,actor.current,role]);
 const permitted=(s:string)=>!perms||allowedBy(perms,'meu_negocio.dashboard')&&(!DASHBOARD_PERMISSIONS[s]||allowedBy(perms,`meu_negocio.dashboard.${DASHBOARD_PERMISSIONS[s]}`));
 // Estoque lane (260): the Produtos entries open /painel-produtos-empresa, whose panels follow their own permission.
 const stockPermitted=(to:string)=>{if(!perms||!to.startsWith('/painel-produtos-empresa'))return true;const panel=new URLSearchParams(to.split('?')[1]??'').get('painel')??'estoque';
  const key=STOCK_DASHBOARD_PERMISSIONS[panel as keyof typeof STOCK_DASHBOARD_PERMISSIONS];return allowedBy(perms,'meu_negocio.dashboard')&&(!key||allowedBy(perms,`meu_negocio.dashboard.${key}`));};
 // The panel is keyed by the role too: after a role change, what the previous role read (custo, estoque) never stays on screen.
 return <div className="business-dashboards">
  <nav className="business-nav" aria-label="Dashboards de Meu Negócio">{BUSINESS_MENU.map(group=>{const entries=group.entries.filter(e=>roleOf(e.roles));if(!entries.length)return null;
   return <section key={group.title}><h2>{group.title}</h2><ul>{entries.map(e=><li key={e.label}>{e.screen&&!permitted(e.screen)?<span className="business-nav-disabled" aria-disabled="true" title={NOT_PERMITTED}>{e.label}</span>
    :e.screen?<Link to={businessHref(e.screen)} aria-current={e.screen===screen?'page':undefined}>{e.label}</Link>
    :e.to&&!stockPermitted(e.to)?<span className="business-nav-disabled" aria-disabled="true" title={NOT_PERMITTED}>{e.label}</span>
    :e.to?<Link to={e.to}>{e.label}</Link>:<span className="business-nav-disabled" aria-disabled="true" title={e.disabledReason}>{e.label}<small>{e.disabledReason}</small></span>}</li>)}</ul></section>;})}
   <button type="button" className="business-nav-settings" onClick={()=>setSettings(true)}><Icon name="gear" size={12}/>Ajustes</button></nav>
  <main className="business-main" id="main-content">
   <header className="business-heading"><h1>{BUSINESS_TITLES[screen]}</h1><button type="button" className="secondary-button" aria-expanded={help} onClick={()=>setHelp(!help)}><Icon name="circle-question" size={12}/>Como funciona</button></header>
   {help&&<aside className="real-notice business-help"><p>Os dashboards usam os pedidos de venda registrados no FAGOO, pela data do pedido (calendário de São Paulo), nas situações escolhidas em “Situação de Venda”. A situação inicial vem de Ajustes (“Situações de pedidos consideradas como Pedido Finalizado”).</p>
    <p>Preço de custo é o custo médio do estoque de cada produto (base de Preferências › Estoque); sem custo médio, o preço de custo do fornecedor padrão do produto e, sem ele, o preço da última compra registrada no FAGOO. Itens sem nenhum deles ficam sem custo e sem margem. Impostos são estimados pela alíquota de Ajustes sobre o faturamento sem frete de cada pedido; taxas de marketplace não existem no FAGOO. Na convivência com o Origin, os pedidos lançados só no Origin não entram nos números.</p></aside>}
   {!allowed?<section className="real-state-panel"><h2>Dashboard não liberado</h2><p>Seu perfil não consulta este dashboard.</p></section>
    :!permitted(screen)?<section className="real-state-panel"><h2>Dashboard não liberado</h2><p>{NOT_PERMITTED}</p></section>
    :screen==='metas'?<BusinessGoals key={actor.current??'none'} controller={controller}/>
    :finished===undefined?<p role="status">Carregando os ajustes de Meu Negócio…</p>
    :<PanelView key={`${actor.current}:${role}:${screen}:${reload}:${(finished??[]).join(',')}`} controller={controller} panel={screen} actor={actor.current} statuses={finished??DEFAULT_STATUSES} warnDefaults={finished===null} taxRate={taxRate} onSettings={()=>setSettings(true)}/>}
  </main>
  {settings&&<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setSettings(false);}}><div className="modal business-settings" role="dialog" aria-modal="true" aria-label="Configurações Meu negócio">
   <PreferenceSettingsPage controller={controller} page={preferencePage('meu-negocio')!} categoryLabel="Meu Negócio" categoryTo={location.pathname+location.search} embedded onClose={()=>{setSettings(false);setFinished(undefined);setReload(n=>n+1);}}/></div></div>}
 </div>;
}

type FreightController=BusinessController&{documents?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>};
function FreightPaidEditor({controller,orders,onSaved}:{controller:Required<FreightController>;orders:readonly{id:string;number:string;freight_paid:string|null}[];onSaved:()=>void}){
 const [order,setOrder]=useState(''),[amount,setAmount]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failure,setFailure]=useState('');
 if(!orders.length)return null;
 const save=async(e:FormEvent)=>{e.preventDefault();if(busy||!order)return;const value=amount.trim().replace(/\./g,'').replace(',','.');if(!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)){setFailure('Informe o valor do frete pago, por exemplo 25,00.');return;}
  setBusy(true);setFailure('');setMessage('');try{const path=freightPaidPath(order),current=readFreightPaid(await controller.documents(path,{method:'GET'}),order);
   readFreightPaid(await controller.documents(path,{method:'POST',body:{command_id:crypto.randomUUID(),expected_version:current.version,data:{amount:value,note:note.trim()||null}}}),order);
   setMessage('Frete pago registrado. A margem foi recalculada.');setAmount('');setNote('');onSaved();}
  catch(error){setFailure(error instanceof AccessError&&error.status===403?'Seu perfil não pode informar o frete pago.':error instanceof AccessError&&error.status===409?'O frete pago deste pedido mudou. Tente novamente.':'Não foi possível registrar o frete pago.');}
  finally{setBusy(false);}};
 return <form className="business-freight-paid" onSubmit={e=>void save(e)} aria-label="Frete pago pela empresa"><h3>Frete pago pela empresa</h3>
  <p className="real-help">Custo de envio pago à transportadora, fora do total cobrado do cliente. Não gera conta a pagar.</p>
  <label className="form-field">Pedido<select value={order} onChange={e=>setOrder(e.target.value)} required><option value="">Escolha o pedido</option>{orders.map(o=><option key={o.id} value={o.id}>Pedido {o.number}{o.freight_paid===null?' · frete pago pendente':` · ${moneyText(o.freight_paid)}`}</option>)}</select></label>
  <label className="form-field">Valor pago<input inputMode="decimal" maxLength={18} value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
  <label className="form-field">Observação<input maxLength={200} value={note} onChange={e=>setNote(e.target.value)}/></label>
  <button type="submit" className="secondary-button" disabled={busy||!order}>{busy?'Salvando…':'Salvar frete pago'}</button>
  {message&&<p className="real-notice" role="status">{message}</p>}{failure&&<p className="real-alert" role="alert">{failure}</p>}</form>;
}
function PanelView({controller,panel,actor,statuses,warnDefaults,taxRate,onSettings}:{controller:BusinessController;panel:BusinessPanel;actor:string|null;statuses:BusinessStatus[];warnDefaults:boolean;taxRate:string|null;onSettings:()=>void}){
 const today=todaySP(),[draft,setDraft]=useState<Draft>(()=>initialDraft(panel,today,statuses)),[query,setQuery]=useState<BusinessQuery|null>(()=>queryOf(panel,initialDraft(panel,today,statuses)));
 const [data,setData]=useState<BusinessPanelView|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[warehouses,setWarehouses]=useState<{id:string;name:string}[]>([]);
 const request=useRef<AbortController|null>(null),[forecast,setForecast]=useState(false);
 const may=()=>allowedFor(controller.getSnapshot(),panel,actor);
 useEffect(()=>{if(!query||!may())return;request.current?.abort();const p=new AbortController();request.current=p;setLoading(true);setError('');void(async()=>{try{
  const raw=await controller.system(businessPanelPath(query),{method:'GET',signal:p.signal});if(p.signal.aborted||request.current!==p||!may())return;setData(parseBusinessPanel(raw,query));
 }catch(e){if(!p.signal.aborted&&request.current===p&&!aborted(e)&&may()){setData(null);setError(readError(e instanceof AccessError?e.status:null));}}
 finally{if(request.current===p){request.current=null;setLoading(false);}}})();return()=>{p.abort();if(request.current===p)request.current=null;};},[controller,query]);
 // Depósito of Previsão de Estoque: the stock totals list of the estoque lane, when the controller offers it.
 useEffect(()=>{const c=controller as BusinessController&{stock?:(path:string,o?:{signal?:AbortSignal})=>Promise<unknown>};if(panel!=='previsao-estoque'||!c.stock)return;const p=new AbortController();
  void c.stock('/v1/estoque/totais',{signal:p.signal}).then(raw=>{const list=(raw as {warehouses?:{warehouse_id?:string;id?:string;name?:string}[]})?.warehouses;if(!p.signal.aborted&&Array.isArray(list))
   setWarehouses(list.flatMap(w=>{const id=w.warehouse_id??w.id;return typeof id==='string'&&typeof w.name==='string'?[{id,name:w.name}]:[];}));}).catch(()=>{});return()=>p.abort();},[controller,panel]);
 const set=(patch:Partial<Draft>)=>setDraft(d=>({...d,...patch}));
 const submit=(event?:FormEvent)=>{event?.preventDefault();if(panel!=='venda-canal'&&panel!=='previsao-estoque'&&panel!=='atividade-carteira'&&!draft.statuses.length){setError('Escolha ao menos uma Situação de Venda.');return;}
  const q=queryOf(panel,draft);if(!q){setError('Filtros inválidos!');return;}setError('');setQuery(q);};
 const range=(labels=['Data','até'])=> <div className="business-range"><label className="form-field">{labels[0]}<input type="date" id={`business-${panel}-from`} value={draft.from} max={today} onChange={e=>set({from:e.target.value})}/></label>
  <label className="form-field">{labels[1]}<input type="date" id={`business-${panel}-to`} value={draft.to} max={today} onChange={e=>set({to:e.target.value})}/></label></div>;
 const chips=panel==='venda-canal'||panel==='previsao-estoque'||panel==='atividade-carteira'?null:<StatusChips idPrefix={`business-${panel}-status`} value={draft.statuses} onChange={next=>set({statuses:next})}/>;
 const filters=panel==='venda-canal'?null:<form className="business-filters" onSubmit={submit}>
  {chips}
  {panel==='diario'?<div className="business-range"><label className="form-field">Data<input type="date" id="business-diario-day" value={draft.day} max={today} onChange={e=>set({day:e.target.value})}/></label>
   <label className="form-field">Data de comparação<input type="date" id="business-diario-compare" value={draft.compare_day} max={today} onChange={e=>set({compare_day:e.target.value})}/></label></div>
   :range(panel==='previsao-estoque'?['Período de venda de','Período de venda até']:panel==='atividade-carteira'?['Período de Venda','até']:['Data','até'])}
  {panel==='mensal'&&<div className="business-range"><label className="form-field">Data de comparação<input type="date" id="business-mensal-compare-from" value={draft.compare_from} max={today} onChange={e=>set({compare_from:e.target.value})}/></label>
   <label className="form-field">até<input type="date" id="business-mensal-compare-to" value={draft.compare_to} max={today} onChange={e=>set({compare_to:e.target.value})}/></label></div>}
  {panel==='pedidos-venda'&&<label className="form-field">Filtro por Estados<select id="business-pedidos-uf" value={draft.state} onChange={e=>set({state:e.target.value})}><option value="">Todos</option>{UFS.map(uf=><option key={uf} value={uf}>{uf}</option>)}</select></label>}
  {panel==='vendas-vendedor'&&<label className="form-field">Vendedor<select id="business-seller" value={draft.seller} onChange={e=>set({seller:e.target.value})}><option value="">Todos</option>{(data?.panel==='vendas-vendedor'?data.sellers:[]).map(s=><option key={s} value={s}>{s}</option>)}</select></label>}
  {panel==='previsao-estoque'&&<><label className="form-field">Depósito<select id="business-warehouse" value={draft.warehouse} onChange={e=>set({warehouse:e.target.value})}><option value="">Todos</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
   <label className="form-field">Reserva<select id="business-reserve" value={draft.reserve} onChange={e=>set({reserve:e.target.value as 'sim'|'nao'})}><option value="sim">Sim</option><option value="nao">Não</option></select></label></>}
  {panel==='margem-pedido'&&<label className="form-field">Tipo de custo<select id="business-cost-type" value="aplicado" disabled title="Custo aplicado na confirmação de cada pedido; sem ele, o preço de custo do cadastro na data do pedido e, por fim, a última compra até essa data."><option value="aplicado">Custo aplicado no pedido</option></select></label>}
  {(panel==='atividade-carteira'||panel==='curva-abc')&&<label className="form-field">Marca<input id={`business-${panel}-brand`} maxLength={100} value={draft.brand} onChange={e=>set({brand:e.target.value})}/></label>}
  {panel==='curva-abc'&&<label className="form-field">Curva ABC<select id="business-abc-kind" value="produtos" disabled><option value="produtos">Produtos</option></select></label>}
  {panel==='atividade-carteira'&&<><label className="form-field">Dias sem comprar<input id="business-portfolio-days" inputMode="numeric" maxLength={5} value={draft.min_days} onChange={e=>set({min_days:e.target.value.replace(/\D/g,'')})}/></label>
   <div className="form-field business-keywords"><label htmlFor="business-portfolio-keyword">Palavras chave</label><input id="business-portfolio-keyword" maxLength={60} value={draft.keyword} placeholder="Digite e tecle Enter"
    onChange={e=>set({keyword:e.target.value.replace(/,/g,'')})} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();const k=draft.keyword.trim();if(k&&!draft.keywords.includes(k)&&draft.keywords.length<10)set({keywords:[...draft.keywords,k],keyword:''});}}}/>
    <span className="business-tags">{draft.keywords.map(k=><button type="button" key={k} className="business-tag" onClick={()=>set({keywords:draft.keywords.filter(x=>x!==k)})} aria-label={`Remover ${k}`}>{k} ×</button>)}</span>
    <small className="real-help">Cada palavra encontra os clientes com a tag de Contatos de mesmo nome ou com a palavra no nome.</small></div></>}
  <button type="submit" className="primary-button" disabled={loading}>Visualizar</button>
  {panel==='mensal'&&<button type="button" className="secondary-button" disabled={!data||loading} aria-pressed={forecast} title="Projeção linear do período pela média diária dos dias já passados." onClick={()=>setForecast(f=>!f)}>Previsão Inteligente</button>}
 </form>;
 return <div className="business-panel">
  {!loading && nativeIndicatorCoverageText(data) && <p className="real-notice" role="note">{nativeIndicatorCoverageText(data)}</p>}
  {filters}{warnDefaults&&<p className="real-help">Não foi possível ler os Ajustes de Meu Negócio; a Situação de Venda começa com Em andamento, Atendido e Verificado.</p>}
  {error&&<p className="real-alert" role="alert">{error}</p>}{loading&&<p role="status">Carregando dashboard…</p>}
  {data&&!loading&&panel==='pedidos-venda'&&data.panel==='pedidos-venda'&&<BrazilMap rows={data.by_state} selected={data.filters.state} disabled={loading} onSelect={uf=>{const d={...draft,state:uf??''};setDraft(d);const q=queryOf(panel,d);if(q)setQuery(q);}}/>}
  {data&&!loading&&<PanelBody data={data} forecast={forecast} taxRate={taxRate} onSettings={onSettings} onTab={tab=>{const d={...draft,tab};setDraft(d);const q=queryOf(panel,d);if(q)setQuery(q);}}
   onMode={mode=>{const d={...draft,mode};setDraft(d);const q=queryOf(panel,d);if(q)setQuery(q);}}/>}
  {/* Leva H (374): the frete pago pela empresa of a pedido, informed here (not part of the total of the customer; no conta is created). */}
  {data&&!loading&&data.panel==='margem-pedido'&&(controller as FreightController).documents&&<FreightPaidEditor controller={controller as Required<FreightController>} orders={data.orders} onSaved={()=>{if(query)setQuery({...query});}}/>}
  {data&&<p className="real-help business-updated">Última atualização: {moment(data.as_of)} (horário de São Paulo). Pedidos registrados no FAGOO.</p>}
 </div>;
}

const product=(withStock:boolean,withCost:boolean):Column<{code:string|null;name:string;units:string;total:string;cost:string|null;margin_pct:string|null;stock:string|null}>[]=>[
 {key:'code',label:'Código',value:r=>r.code},{key:'name',label:'Descrição',value:r=>r.name},{key:'units',label:'Quantidade',kind:'qty',value:r=>r.units},
 ...(withCost?[{key:'cost',label:'Custo',kind:'money' as const,value:(r:{cost:string|null})=>r.cost}]:[]),{key:'total',label:'Valor',kind:'money',value:r=>r.total},
 ...(withCost?[{key:'margin',label:'Margem Bruta %',kind:'pct' as const,value:(r:{margin_pct:string|null})=>r.margin_pct}]:[]),
 ...(withStock?[{key:'stock',label:'Em estoque',kind:'qty' as const,value:(r:{stock:string|null})=>r.stock}]:[])];
const ordersHref='/documentos-empresa?tipo=sales_orders';

function PanelBody({data,onTab,onMode=()=>{},forecast=false,taxRate=null,onSettings}:{data:BusinessPanelView;onTab:(tab:'todos'|'lucro'|'prejuizo')=>void;onMode?:(mode:'itens'|'desmembrados')=>void;forecast?:boolean;taxRate?:string|null;onSettings?:()=>void}){
 const [curve,setCurve]=useState<'A'|'B'|'C'>('A');
 switch(data.panel){
  case'mensal':return <MonthlyBody data={data} forecast={forecast}/>;
  case'diario':{const c=data.kpis.current,p=data.kpis.previous;return <>
   <div className="business-kpis"><KpiCard label="Pedidos de Venda" icon="cart-shopping" tone="blue" value={c.orders.toLocaleString('pt-BR')} raw={`${c.orders}.00`} previousRaw={p?`${p.orders}.00`:null} previous={p?p.orders.toLocaleString('pt-BR'):null}/>
    <KpiCard label="Produtos Vendidos" icon="cubes" tone="purple" value={qtyText(c.units)} raw={c.units} previousRaw={p?.units??null} previous={p?qtyText(p.units):null}/>
    <KpiCard label="Ticket Médio" icon="receipt" tone="orange" value={moneyText(c.ticket)} raw={c.ticket} previousRaw={p?.ticket??null} previous={p?moneyText(p.ticket):null} hint="Valor total das vendas dividido pela quantidade de vendas."/>
    <KpiCard label="Novos Clientes" icon="user" tone="green" value={c.new_customers.toLocaleString('pt-BR')} raw={`${c.new_customers}.00`} previousRaw={p?`${p.new_customers}.00`:null} previous={p?p.new_customers.toLocaleString('pt-BR'):null} hint="Clientes cuja primeira venda (nas situações escolhidas) é deste dia."/></div>
   <div className="business-grid"><StatusPanel rows={data.statuses}/><IndicatorsPanel value={data.indicators}/></div>
   <DataTable title="Top 10 SKUs Mais Vendidos" file="top-10-skus-diario" columns={product(data.stock_visible,false)} rows={data.top_skus} rowKey={(r,i)=>r.product_id??`${r.name}-${i}`}/></>;}
  case'pedidos-venda':return <>
   <div className="business-kpis"><KpiCard label="Pedidos" icon="cart-shopping" tone="blue" value={data.totals.orders.toLocaleString('pt-BR')}/><KpiCard label="Quantidade" icon="cubes" tone="purple" value={qtyText(data.totals.units)}/>
    <KpiCard label="Valor" icon="dollar-sign" tone="green" value={moneyText(data.totals.total)}/><KpiCard label="Frete" icon="truck" tone="gray" value={moneyText(data.totals.freight)}/><KpiCard label="Ticket Médio" icon="receipt" tone="orange" value={moneyText(data.totals.ticket)}/></div>
   <BarChart title="Pedidos por Situação" buckets={data.statuses.map(s=>s.status)} labels={b=>statusLabel(b)} series={[{label:'Valor',tone:'blue',values:data.statuses.map(s=>s.total)}]}/>
   <DataTable title="Vendas por estado" file="vendas-por-estado" rows={data.by_state} rowKey={r=>r.state??'-'} columns={[{key:'state',label:'Estado',value:r=>r.state??'Não informado'},{key:'freight',label:'Frete Médio',kind:'money',value:r=>r.freight_avg},
    {key:'units',label:'Pecas',kind:'qty',value:r=>r.units},{key:'orders',label:'Pedidos',kind:'int',value:r=>r.orders},{key:'ticket',label:'Ticket Médio',kind:'money',value:r=>r.ticket},{key:'total',label:'Valor',kind:'money',value:r=>r.total}]}
    footer={[null,null,data.totals.units,String(data.totals.orders),data.totals.ticket,data.totals.total]}/>
   <DataTable title="Vendas por produto" file="vendas-por-produto" rows={data.by_product} rowKey={(r,i)=>r.product_id??`${r.name}-${i}`} columns={product(false,data.cost_visible)} limit={300}/>
   <DataTable title="Vendas por canal" file="vendas-por-canal" rows={data.by_channel} rowKey={r=>r.channel} columns={[{key:'channel',label:'Loja',value:r=>r.channel},{key:'orders',label:'Pedidos',kind:'int',value:r=>r.orders},
    {key:'ticket',label:'Ticket Médio',kind:'money',value:r=>r.ticket},{key:'units',label:'Quantidade',kind:'qty',value:r=>r.units},...(data.cost_visible?[{key:'cost',label:'Custo',kind:'money' as const,value:(r:{cost:string|null})=>r.cost}]:[]),
    {key:'total',label:'Valor',kind:'money',value:r=>r.total},{key:'freight',label:'Frete',kind:'money',value:r=>r.freight},{key:'unit',label:'Valor Peça',kind:'money',value:r=>r.unit_value},
    ...(data.cost_visible?[{key:'margin',label:'Margem Bruta %',kind:'pct' as const,value:(r:{margin_pct:string|null})=>r.margin_pct}]:[]),
    {key:'taxes',label:'Impostos',kind:'money',value:r=>r.taxes,title:'Faturamento sem frete × alíquota de imposto de Ajustes.'},{key:'fees',label:'Taxas',value:()=>null,title:'Sem taxas de marketplace.'},
    ...(data.cost_visible?[{key:'contribution',label:'Margem Contribuição %',kind:'pct' as const,value:(r:{contribution_pct:string|null})=>r.contribution_pct,title:'(Faturamento sem frete − custo − impostos) ÷ faturamento sem frete.'}]:[])]}/></>;
  case'vendas-vendedor':return <>
   <div className="business-grid"><BarChart title="Evolução" buckets={data.evolution.map(e=>e.bucket)} labels={b=>b.length===10?dayLabel(b):monthLabel(b)} series={[{label:'Faturamento',tone:'blue',values:data.evolution.map(e=>e.total)}]}/>
    <BarChart title="Status" buckets={data.statuses.map(s=>s.status)} labels={b=>statusLabel(b)} series={[{label:'Valor',tone:'green',values:data.statuses.map(s=>s.total)}]}/></div>
   <DataTable title="Vendas Por Vendedor" file="vendas-por-vendedor" rows={data.by_seller} rowKey={r=>r.seller??'-'} columns={[{key:'seller',label:'Vendedor',value:r=>r.seller??'Sem vendedor'},{key:'orders',label:'Pedidos',kind:'int',value:r=>r.orders},
    {key:'units',label:'Peças Vendidas',kind:'qty',value:r=>r.units},{key:'freight',label:'Frete',kind:'money',value:r=>r.freight},{key:'total',label:'Faturamento',kind:'money',value:r=>r.total},{key:'ticket',label:'Ticket Médio',kind:'money',value:r=>r.ticket},
    ...(data.cost_visible?[{key:'margin',label:'Margem Bruta %',kind:'pct' as const,value:(r:{margin_pct:string|null})=>r.margin_pct}]:[])]}
    note={<p className="real-help">O vendedor vem da referência de vendedor do pedido; pedidos sem vendedor aparecem como “Sem vendedor”.</p>}/>
   <DataTable title="Vendas Por Produto" file="vendas-vendedor-por-produto" rows={data.by_product} rowKey={(r,i)=>r.product_id??`${r.name}-${i}`} columns={product(false,data.cost_visible)} limit={300}/></>;
  case'venda-canal':return <>
   <BarChart title="Evolução por canal" buckets={data.months.map(m=>m.month)} labels={b=>monthLabel(b)} series={data.channels.map((c,i)=>({label:c,tone:['blue','green','orange','purple','gray'][i%5]!,values:data.months.map(m=>m.values.find(v=>v.channel===c)?.total??'0.00')}))}/>
   <DataTable title="Valor por canal e mês" file="venda-canal-24-meses" rows={data.months} rowKey={m=>m.month} columns={[{key:'month',label:'Mês',value:m=>monthLabel(m.month)},...data.channels.map(c=>({key:c,label:c,kind:'money' as const,value:(m:{values:{channel:string;total:string}[]})=>m.values.find(v=>v.channel===c)?.total??'0.00'}))]}/>
   <p className="real-help">Situações consideradas: as de Ajustes ({data.filters.statuses.map(statusLabel).join(', ')}).</p></>;
  case'previsao-estoque':return <>
   {/* 265: Variações + Simples + Composições | Produtos | Desmembrados (Origin). FAGOO has no variations: Produtos would repeat the first view. */}
   <div className="business-tabs" role="tablist" aria-label="Giro de Produto">
    <button type="button" role="tab" aria-selected={data.filters.mode==='itens'} className={data.filters.mode==='itens'?'active':''} onClick={()=>onMode('itens')}>Variações + Simples + Composições</button>
    <button type="button" role="tab" aria-selected={false} disabled title="O FAGOO não tem produtos com variações: a visão por produto pai seria igual a Variações + Simples + Composições.">Produtos</button>
    <button type="button" role="tab" aria-selected={data.filters.mode==='desmembrados'} className={data.filters.mode==='desmembrados'?'active':''} onClick={()=>onMode('desmembrados')}>Desmembrados</button></div>
   <DataTable title="Giro de Produto" file="giro-de-produto" rows={data.turnover} rowKey={r=>r.product_id} limit={300} columns={[{key:'code',label:'Código',value:r=>r.code},{key:'name',label:'Descrição',value:r=>r.name},
    {key:'composition',label:'Composição',value:r=>r.composition==='virtual'?'Virtual':r.composition==='physical'?'Físico':null},
    {key:'sold',label:'Vendidos',kind:'qty',value:r=>r.sold},{key:'day',label:'Média por dia',kind:'qty',value:r=>r.per_day},{key:'stock',label:data.filters.reserve?'Estoque (sem reservado)':'Estoque',kind:'qty',value:r=>r.stock},
    {key:'coverage',label:'Previsão (dias)',kind:'int',value:r=>r.coverage_days}]} note={<p className="real-help">{data.filters.mode==='desmembrados'?'Cada composição com estrutura vendida entra pelos seus componentes (quantidade vendida × quantidade por composição).':'Produtos simples e composições como foram vendidos; a composição Virtual mostra o saldo que os componentes permitem, sem descontar reservas.'}</p>}/>
   <div className="business-grid"><DataTable title="Vendas por Canal" file="previsao-vendas-por-canal" rows={data.by_channel} rowKey={r=>r.channel} columns={[{key:'channel',label:'Loja',value:r=>r.channel},{key:'orders',label:'Pedidos',kind:'int',value:r=>r.orders},
     {key:'units',label:'Quantidade',kind:'qty',value:r=>r.units},{key:'total',label:'Valor',kind:'money',value:r=>r.total}]}/>
    <BarChart title="Vendas por dia" buckets={data.by_day.map(d=>d.day)} labels={dayLabel} money={false} series={[{label:'Quantidade',tone:'purple',values:data.by_day.map(d=>d.units)}]}/></div></>;
  case'margem-pedido':{const i=data.indicators;return <>
   <aside className="real-notice"><strong>Informações importantes sobre o cálculo</strong><p>Margem de contribuição = faturamento com o frete cobrado do cliente − custo dos produtos − frete pago pela empresa − imposto. O custo é o aplicado na confirmação comercial de cada pedido; sem ele, o preço de custo do cadastro na data do pedido e, por fim, a última compra até essa data. Mudar o custo atual do produto não altera vendas antigas. Sem o frete pago informado, a margem é estimada e o frete pago fica pendente. O imposto é o faturamento sem frete de cada pedido × a alíquota de Ajustes{taxRate!==null?` (hoje ${taxRate.replace('.',',')}%)`:''}. Pedidos com item sem custo ficam sem margem. Taxas de marketplace não existem no FAGOO.</p></aside>
   {(taxRate===null||/^0(\.0+)?$/.test(taxRate))&&<aside className="real-notice"><strong>Configure sua alíquota de imposto</strong><p>Sem alíquota, o imposto entra como zero na margem de contribuição.</p>{onSettings&&<button type="button" className="text-button" onClick={onSettings}>Ir para ajustes</button>}</aside>}
   <div className="business-kpis"><KpiCard label="Faturamento total" icon="dollar-sign" tone="green" value={moneyText(i.revenue)}/><KpiCard label="Ticket médio" icon="receipt" tone="orange" value={moneyText(i.ticket)}/>
    <KpiCard label="Quantidade de pedidos" icon="cart-shopping" tone="blue" value={i.orders.toLocaleString('pt-BR')}/><KpiCard label="Frete (comprador)" icon="truck" tone="gray" value={moneyText(i.freight_buyer)} hint="Frete cobrado do cliente, incluído no faturamento."/>
    <KpiCard label="Frete (vendedor)" icon="truck" tone="gray" value={moneyText(i.freight_seller)} hint={`Frete pago pela empresa, informado por pedido.${i.freight_paid_pending?` ${i.freight_paid_pending} pedido(s) sem frete pago informado.`:''}`}/>
    <KpiCard label="Custos variáveis (Custo)" icon="calculator" tone="purple" value={moneyText(i.cost)} hint="Preço de custo dos pedidos com custo conhecido."/>
    <KpiCard label="Custos variáveis (Imposto)" icon="percent" tone="gray" value={i.taxes===null?'—':moneyText(i.taxes)} hint="Faturamento sem frete × alíquota de imposto de Ajustes. Sem taxas de marketplace."/>
    <KpiCard label="Margem de contribuição" icon="chart-line" tone="green" value={`${moneyText(i.contribution)}${i.contribution_pct?` (${pctText(i.contribution_pct)})`:''}`}/></div>
   {i.orders_without_cost>0&&<p className="real-help">{i.orders_without_cost} pedido(s) com item sem preço de custo ficam fora da margem.</p>}
   <BarChart title="Gráfico de progressão" buckets={data.progression.map(p=>p.day)} labels={dayLabel} series={[{label:'Faturamento',tone:'blue',values:data.progression.map(p=>p.revenue)},{label:'Margem de contribuição',tone:'green',values:data.progression.map(p=>p.contribution)}]}/>
   <div className="business-tabs" role="tablist" aria-label="Pedidos">{(['todos','lucro','prejuizo'] as const).map(t=><button type="button" role="tab" key={t} aria-selected={data.filters.tab===t} className={data.filters.tab===t?'active':''} onClick={()=>onTab(t)}>{t==='todos'?'Todos':t==='lucro'?'Lucro':'Prejuízo'}</button>)}</div>
   <DataTable title="Margem de Contribuição por pedido" file="margem-por-pedido" rows={data.orders} rowKey={o=>o.id} limit={500} total={data.total} columns={[{key:'number',label:'Pedido',value:o=>o.number,link:()=>ordersHref},{key:'day',label:'Data',kind:'date',value:o=>o.day},
    {key:'contact',label:'Cliente',value:o=>o.contact},{key:'channel',label:'Loja',value:o=>o.channel},{key:'revenue',label:'Faturamento sem frete',kind:'money',value:o=>o.revenue},{key:'freight',label:'Frete cobrado',kind:'money',value:o=>o.freight},{key:'freight_paid',label:'Frete pago',kind:'money',value:o=>o.freight_paid},
    {key:'cost',label:'Custo',kind:'money',value:o=>o.cost},{key:'contribution',label:'Margem de contribuição',kind:'money',value:o=>o.contribution},{key:'pct',label:'%',kind:'pct',value:o=>o.contribution_pct}]}/></>;}
  case'novos-recorrentes':{const card=(title:string,c:typeof data.cards.novos,tone:string)=><article className={`business-card business-tone-${tone}`}><h2>{title}</h2><dl className="business-indicators">
    <div><dt>CLIENTES</dt><dd>{c.customers.toLocaleString('pt-BR')}</dd></div><div><dt>TICKET MÉDIO</dt><dd>{moneyText(c.ticket)}</dd></div><div><dt>PRODUTOS</dt><dd>{qtyText(c.units)}</dd></div><div><dt>SHARE</dt><dd>{pctText(c.share_pct)}</dd></div></dl></article>;
   return <><div className="business-grid">{card('Clientes Recorrentes',data.cards.recorrentes,'blue')}{card('Clientes Novos',data.cards.novos,'green')}</div>
    <BarChart title="Gráfico Recorrentes X Novos" buckets={data.chart.map(c=>c.bucket)} labels={monthLabel} series={[{label:'Recorrentes',tone:'blue',values:data.chart.map(c=>c.recurring)},{label:'Novos',tone:'green',values:data.chart.map(c=>c.new)}]}/>
    <DataTable title="Clientes" file="novos-x-recorrentes" rows={data.customers} rowKey={c=>c.contact_id} limit={300} total={data.total} columns={[{key:'name',label:'Nome',value:c=>c.name},{key:'kind',label:'Tipo',value:c=>c.kind==='novo'?'Novo':'Recorrente'},
     {key:'channel',label:'Loja',value:c=>c.channel},{key:'units',label:'Produtos',kind:'qty',value:c=>c.units},{key:'total',label:'Valor',kind:'money',value:c=>c.total},
     ...(data.cost_visible?[{key:'margin',label:'Margem Bruta %',kind:'pct' as const,value:(c:{margin_pct:string|null})=>c.margin_pct},{key:'profit',label:'Lucro Venda',kind:'money' as const,value:(c:{profit:string|null})=>c.profit,title:'Faturamento sem frete menos o preço de custo.'}]:[]),
     {key:'mobile',label:'Celular',value:c=>c.mobile},{key:'history',label:'Histórico',value:()=>'Ver pedidos',link:()=>ordersHref}]}/></>;}
  case'atividade-carteira':return <DataTable title="Atividade da Carteira" file="atividade-da-carteira" rows={data.customers} rowKey={c=>c.contact_id} limit={500} total={data.total} footer={[null,null,data.sum,null,null,null,null,null,null,null,null,null]}
   columns={[{key:'name',label:'Nome',value:c=>c.name},{key:'orders',label:'Pedidos',kind:'int',value:c=>c.orders},{key:'total',label:'Valor',kind:'money',value:c=>c.total},{key:'first',label:'Primeira Compra',kind:'date',value:c=>c.first_purchase},
    {key:'last',label:'Última Compra',kind:'date',value:c=>c.last_purchase},{key:'cycle',label:'Ciclo Médio de Compra (dias)',kind:'int',value:c=>c.cycle_days},{key:'idle',label:'Dias Sem Comprar',kind:'int',value:c=>c.days_without},
    {key:'document',label:'Documento',value:c=>c.document},{key:'state',label:'Estado',value:c=>c.state},{key:'email',label:'Email',value:c=>c.email},{key:'mobile',label:'Celular',value:c=>c.mobile},{key:'history',label:'Histórico',value:()=>'Ver pedidos',link:()=>ordersHref}]}
   note={<p className="real-help">Situações consideradas: as de Ajustes ({data.filters.statuses.map(statusLabel).join(', ')}). {data.total} cliente(s).</p>}/>;
  case'curva-abc':{const rows=data.products.filter(p=>p.curve===curve);return <>
   <section className="business-chart" aria-label="Gráfico da Curva ABC"><h2>Gráfico da Curva ABC</h2><div className="business-abc-cards">{(['A','B','C'] as const).map(k=><button type="button" key={k} className={`business-abc business-abc-${k.toLowerCase()}${curve===k?' active':''}`} onClick={()=>setCurve(k)}><strong>Curva {k}</strong><span>{data.counts[k]} SKUs</span></button>)}</div>
    <p className="real-help">A: produtos até 80% do faturamento acumulado; B: até 95%; C: o restante. Total do período: {moneyText(data.total)}.</p></section>
   <div className="business-tabs" role="tablist" aria-label="Curvas">{(['A','B','C'] as const).map(k=><button type="button" role="tab" key={k} aria-selected={curve===k} className={curve===k?'active':''} onClick={()=>setCurve(k)}>Curva {k}</button>)}</div>
   <DataTable title={`Curva ABC — Curva ${curve}`} file={`curva-abc-${curve.toLowerCase()}`} rows={rows} total={data.counts[curve]} rowKey={(r,i)=>r.product_id??`${r.name}-${i}`} columns={[{key:'code',label:'Código',value:r=>r.code},{key:'name',label:'Descrição',value:r=>r.name},
    {key:'units',label:'Quantidade',kind:'qty',value:r=>r.units},{key:'total',label:'Valor',kind:'money',value:r=>r.total},{key:'share',label:'%',kind:'pct',value:r=>r.share_pct},{key:'cumulative',label:'% acumulado',kind:'pct',value:r=>r.cumulative_pct}]}/></>;}
 }
}
const statusLabel=(s:string)=>({draft:'Em digitação',open:'Em aberto',verified:'Verificado',in_progress:'Em andamento',partially_fulfilled:'Atendido parcialmente',fulfilled:'Atendido',cancelled:'Cancelado'} as Record<string,string>)[s]??s;

function MonthlyBody({data,forecast=false}:{data:MonthlyPanelView;forecast?:boolean}){
 const c=data.kpis.current,p=data.kpis.previous,daily=data.daily,length=Math.max(daily.current.length,daily.previous.length);
 const projection=forecast?forecastPeriod(daily.current,data.filters.from,data.filters.to,data.business_date):null;
 const align=(rows:{total:string}[])=>Array.from({length},(_,i)=>rows[i]?.total??'0.00');
 return <>
  <div className="business-kpis"><KpiCard label="Valor Total" icon="dollar-sign" tone="green" value={moneyText(c.total)} raw={c.total} previousRaw={p?.total??null} previous={p?moneyText(p.total):null}/>
   <KpiCard label="Quantidade de Pedidos" icon="cart-shopping" tone="blue" value={c.orders.toLocaleString('pt-BR')} raw={`${c.orders}.00`} previousRaw={p?`${p.orders}.00`:null} previous={p?p.orders.toLocaleString('pt-BR'):null}/>
   <KpiCard label="Produtos Vendidos" icon="cubes" tone="purple" value={qtyText(c.units)} raw={c.units} previousRaw={p?.units??null} previous={p?qtyText(p.units):null}/>
   <KpiCard label="Ticket Médio" icon="receipt" tone="orange" value={moneyText(c.ticket)} raw={c.ticket} previousRaw={p?.ticket??null} previous={p?moneyText(p.ticket):null} hint="Valor total das vendas dividido pela quantidade de vendas no período."/></div>
  {forecast&&<section className="business-card business-forecast" aria-label="Previsão Inteligente"><h2>Previsão Inteligente</h2>
   {projection?<><p><strong>{moneyText(projection.projected)}</strong> previstos para o período ({brDate(data.filters.from)} a {brDate(data.filters.to)}).</p>
    <p className="real-help">{projection.complete?'O período já terminou: a previsão é o valor total.':`Média de ${moneyText(projection.per_day)} por dia nos ${projection.elapsed} dia(s) já passados (${moneyText(projection.sum)}), projetada para os ${projection.days} dias do período.`} Projeção linear, sem sazonalidade.</p></>
    :<p className="real-help">O período ainda não começou: não há dias para projetar.</p>}</section>}
  <section className="business-card" aria-label="Metas em andamento"><header className="business-card-heading"><h2>Metas em andamento</h2><Link to={businessHref('metas')} className="text-button">Todas as metas</Link></header>
   {data.goals.length?<ul className="business-goals-mini">{data.goals.map(g=><li key={g.id}><span>{g.name}</span><progress max={100} value={goalProgress(g)} aria-label={`${g.name}: ${goalProgress(g)}%`}/><small>{moneyText(g.achieved)} de {moneyText(g.target)}</small></li>)}</ul>
    :<p className="real-help">Nenhuma meta em andamento. <Link to={businessHref('metas')}>+ Nova Meta</Link></p>}</section>
  <BarChart title="Valor total de pedidos por dia" buckets={Array.from({length},(_,i)=>String(i))} labels={(_,i)=>daily.current[i]?dayLabel(daily.current[i]!.day):`+${i+1}`}
   series={[...(p?[{label:'Período Anterior',tone:'gray',values:align(daily.previous)}]:[]),{label:'Período Atual',tone:'blue',values:align(daily.current)}]}/>
  <p><Link to={ordersHref} className="text-button">Todos os pedidos</Link></p>
  <div className="business-grid"><StatusPanel rows={data.statuses}/><IndicatorsPanel value={data.indicators}/></div>
  <DataTable title="Valor Total por Canal no Período" file="valor-por-canal" rows={data.channels} rowKey={r=>r.channel} columns={[{key:'channel',label:'Loja',value:r=>r.channel},{key:'orders',label:'Pedidos',kind:'int',value:r=>r.orders},{key:'total',label:'Valor',kind:'money',value:r=>r.total}]}/>
  <DataTable title="Top 10 SKUs Mais Vendidos" file="top-10-skus" rows={data.top_skus} rowKey={(r,i)=>r.product_id??`${r.name}-${i}`} columns={[{key:'code',label:'SKU',value:r=>r.code},{key:'name',label:'Descrição',value:r=>r.name},
   {key:'units',label:'Unidades',kind:'qty',value:r=>r.units},...(data.stock_visible?[{key:'stock',label:'Em estoque',kind:'qty' as const,value:(r:{stock:string|null})=>r.stock},{key:'days',label:'Dias de Previsão',kind:'int' as const,value:(r:{forecast_days:number|null})=>r.forecast_days}]:[])]}/>
  <BarChart title="Valor Total Bruto" buckets={data.months.map(m=>m.month)} labels={monthLabel} series={[{label:'Valor total',tone:'green',values:data.months.map(m=>m.total)}]}/>
  <section className="business-card" aria-label="Estatísticas Anual"><h2>Estatísticas Anual</h2><dl className="business-indicators"><div><dt>Valor Total Anual</dt><dd>{moneyText(data.annual.total)}</dd></div>
   <div><dt>Quantidade de Pedidos</dt><dd>{data.annual.orders.toLocaleString('pt-BR')}</dd></div><div><dt>Produtos Vendidos</dt><dd>{qtyText(data.annual.units)}</dd></div><div><dt>Ticket Médio</dt><dd>{moneyText(data.annual.ticket)}</dd></div></dl>
   <p className="real-help">Ano de {data.filters.to.slice(0,4)}, de {brDate(`${data.filters.to.slice(0,4)}-01-01`)} a {brDate(`${data.filters.to.slice(0,4)}-12-31`)}.</p></section>
 </>;
}
