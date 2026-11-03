import type {AccessRole,NativeRequestOptions} from './real-access';
import type {CatalogEntity} from './catalog-model';
import type {DocumentKind} from './real-documents-model';
import type {NativeReportCoverage} from './document-reports-model';
import {ORIGIN_MENU,resolveMenu,type CompanyAccess} from './origin-menu.ts';
import {financeMoney} from './real-finance-model.ts';
import {HOME_MAX_PERIOD_DAYS,HOME_PATH,HOME_PERIOD_KEYS,homeDayCount,homePeriodParams,homeShortcutBase,homeShortcutPaths,validHomeDate,validHomeLabels,validHomeShortcuts,type HomePeriodKey} from './home-request.ts';
export type {HomePeriodKey} from './home-request.ts';
export type HomeBucket='overdue'|'today'|'next_7_days'|'later';
export interface HomePeriodPoint {bucket:string;sales_cents:string|null;receivable_cents:string|null;payable_cents:string|null}
export interface HomePeriod {
  key:HomePeriodKey;from:string;to:string;day_count:number;grain:'day'|'month';points:HomePeriodPoint[];
  sales:{count:number;statuses:{status:string;count:number;total_cents:string}[]};
  receivable:{count:number;total_cents:string;open_cents:string;fee_cents:string}|null;
  payable:{count:number;total_cents:string;open_cents:string}|null;
  invoices:{count:number;total_cents:string}|null;
}
export interface HomeSummary extends NativeReportCoverage {
  data_mode:'erp_native';as_of:string;business_date:string;timezone:'America/Sao_Paulo';role:AccessRole;
  catalog:{entity:CatalogEntity;active:number;archived:number}[];
  documents:{kind:DocumentKind;count:number;statuses:{status:string;count:number}[]}[];
  stock:{positions:number;positive_positions:number;zero_positions:number;products:number;warehouses:number}|null;
  finance:{titles:{kind:'receivable'|'payable';buckets:{bucket:HomeBucket;count:number;balance_cents:string}[]}[];
    accounts:{active:number;archived:number;opening_pending:number;recorded_balance_cents:string}}|null;
  period?:HomePeriod;
}
export interface HomeController {
  home:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
  getSnapshot?:()=>unknown;subscribe?:(listener:()=>void)=>()=>void;
}
export const HOME_BUCKET_LABELS:Record<HomeBucket,string>={overdue:'Vencidos',today:'Vencem hoje',next_7_days:'Próximos 7 dias',later:'Após os próximos 7 dias'};
export const HOME_CATALOG_LABELS:Record<CatalogEntity,string>={contacts:'Clientes e fornecedores',products:'Produtos',warehouses:'Depósitos'};

// ---- Período do "Resumo diário" e dos gráficos (Origin: Hoje · 7D · 30D · 3M · 6M · 12M · Customizado; 3M, 6M e 12M
// começam no primeiro dia do mês) ----
export const HOME_PERIOD_OPTIONS:readonly {key:HomePeriodKey;label:string}[]=[{key:'hoje',label:'Hoje'},{key:'7d',label:'7D'},{key:'30d',label:'30D'},{key:'3m',label:'3M'},{key:'6m',label:'6M'},{key:'12m',label:'12M'},{key:'customizado',label:'Customizado'}];
export interface HomePeriodRoute {key:HomePeriodKey;from:string|null;to:string|null}
const PERIOD_ERROR='O período do endereço é inválido. Escolha Hoje, 7D, 30D, 3M, 6M, 12M ou um período customizado de até 366 dias.';
/** Reads periodo/de/ate from the page URL. Other parameters of the page are ignored. */
export function homePeriodRoute(search:string):HomePeriodRoute{
  const source=new URLSearchParams(search),params=new URLSearchParams();
  for(const key of ['periodo','de','ate'])for(const value of source.getAll(key))params.append(key,value);
  if(!params.size)return {key:'hoje',from:null,to:null};
  try{return homePeriodParams(params);}catch{throw new Error(PERIOD_ERROR);}
}
export function homeCustomRoute(from:string,to:string):HomePeriodRoute{
  if(!from||!to)throw new Error('Informe o início e o fim do período.');
  if(!validHomeDate(from)||!validHomeDate(to))throw new Error('Informe datas válidas entre 1900 e 2100.');
  const [start,end]=from>to?[to,from]:[from,to];
  if(homeDayCount(start,end)>HOME_MAX_PERIOD_DAYS)throw new Error('Escolha um período de até 366 dias.');
  return {key:'customizado',from:start,to:end};
}
const periodParams=(route:HomePeriodRoute)=>{const params=new URLSearchParams({periodo:route.key});if(route.key==='customizado'&&route.from&&route.to){params.set('de',route.from);params.set('ate',route.to);}return params;};
export const homeSummaryPath=(route:HomePeriodRoute)=>`${HOME_PATH}?${periodParams(route)}`;
/** Page URL search for a period; "Hoje" is the default and keeps the address clean. */
export const homePeriodSearch=(route:HomePeriodRoute)=>route.key==='hoje'?'':`?${periodParams(route)}`;
export function homePeriodMatches(period:HomePeriod|undefined,route:HomePeriodRoute){
  return Boolean(period&&period.key===route.key&&(route.key!=='customizado'||(period.from===route.from&&period.to===route.to)));
}
export const isHomePeriodKey=(value:string):value is HomePeriodKey=>(HOME_PERIOD_KEYS as readonly string[]).includes(value);
const brDate=(value:string)=>value.split('-').reverse().join('/');
export function homePeriodText(period:HomePeriod){return period.from===period.to?brDate(period.from):`${brDate(period.from)} a ${brDate(period.to)}`;}
/** Origin "Atualizado em: dd/mm às hh:mm" above the charts (horário de São Paulo). */
export function homeChartUpdated(asOf:string){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(asOf)).map(p=>[p.type,p.value]));
  return `Atualizado em: ${parts.day}/${parts.month} às ${parts.hour}:${parts.minute}`;
}

// ---- Cartão "Pedidos de venda": bolinhas do Origin sobre as situações do Brufap ----
export interface HomeSalesLine {id:'total'|'novos'|'andamento'|'cancelados';label:string;dot:'total'|'success'|'progress'|'danger';statuses:readonly string[];detail:string}
export const HOME_SALES_LINES:readonly HomeSalesLine[]=[
  {id:'total',label:'Total de vendas',dot:'total',statuses:['draft','open','verified','in_progress','agency_sale','checkout_partial','partially_fulfilled','partially_invoiced','fulfilled'],detail:'Todas as situações, exceto Cancelado'},
  {id:'novos',label:'Novos',dot:'success',statuses:['draft','open'],detail:'Em digitação e Em aberto'},
  {id:'andamento',label:'Em andamento',dot:'progress',statuses:['verified','in_progress','checkout_partial','partially_fulfilled','partially_invoiced'],detail:'Verificado, Em andamento, Checkout parcial, Atendido parcialmente e Faturado parcialmente'},
  {id:'cancelados',label:'Cancelados',dot:'danger',statuses:['cancelled'],detail:'Cancelado'},
];
export function homeSalesLines(sales:HomePeriod['sales']){
  return HOME_SALES_LINES.map(line=>{
    const rows=sales.statuses.filter(row=>line.statuses.includes(row.status));
    return {...line,count:rows.reduce((total,row)=>total+row.count,0),total_cents:rows.reduce((total,row)=>total+BigInt(row.total_cents),0n).toString()};
  });
}
/** Cards of "Incluir gráficos" (migration 189) from the period's sales, cancelled ones excluded: Quantidade de pedidos de venda,
 * Valor Faturado and Ticket Médio (value ÷ orders, exact cents, half up). */
export function homeChartValues(period:HomePeriod){
  const line=homeSalesLines(period.sales).find(item=>item.id==='total')!,cents=BigInt(line.total_cents),orders=BigInt(line.count);
  return {orders:line.count,billed_cents:cents.toString(),ticket_cents:(orders>0n?(cents*2n+orders)/(2n*orders):0n).toString()};
}
/** The list with `key` moved to `index` (bounded); the other charts keep their order. */
export function moveChart<T extends string>(list:readonly T[],key:T,index:number):T[]{
  const rest=list.filter(item=>item!==key),at=Math.max(0,Math.min(index,rest.length));return [...rest.slice(0,at),key,...rest.slice(at)];
}
/** Origin "Líquido": total dos títulos menos as tarifas registradas nas baixas (pode ficar negativo). */
export const homeNetCents=(receivable:NonNullable<HomePeriod['receivable']>)=>(BigInt(receivable.total_cents)-BigInt(receivable.fee_cents)).toString();

// ---- Gráfico (SVG próprio, sem dependências) ----
export type HomeSeriesKey='sales'|'receivable'|'payable';
export const HOME_CHART_SERIES:readonly {key:HomeSeriesKey;label:string;field:'sales_cents'|'receivable_cents'|'payable_cents'}[]=[
  {key:'sales',label:'Vendas',field:'sales_cents'},{key:'receivable',label:'Contas a receber',field:'receivable_cents'},{key:'payable',label:'Contas a pagar',field:'payable_cents'},
];
const MONTHS=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
export function homeBucketLabel(bucket:string,grain:'day'|'month',full=false){
  if(grain==='month'){const [year,month]=bucket.split('-');return full?`${month}/${year}`:`${MONTHS[Number(month)-1]}/${year.slice(2)}`;}
  const [year,month,day]=bucket.split('-');return full?`${day}/${month}/${year}`:`${day}/${month}`;
}
function niceStep(value:bigint){
  if(value<=1n)return 1n;let power=1n;while(power*10n<value)power*=10n;
  for(const factor of [1n,2n,5n,10n])if(factor*power>=value)return factor*power;return 10n*power;
}
export function homeAxisMoney(cents:string){const text=financeMoney(cents);return text.endsWith(',00')?text.slice(0,-3):text;}
export interface HomeChartBar {series:HomeSeriesKey;cents:string;x:number;y:number;width:number;height:number}
export interface HomeChartModel {
  width:number;height:number;left:number;top:number;bottom:number;series:typeof HOME_CHART_SERIES[number][];empty:boolean;
  ticks:{cents:string;y:number}[];groups:{bucket:string;label:string|null;title:string;x:number;width:number;bars:HomeChartBar[]}[];
}
/** Geometry only; values stay exact strings. Ratios use BigInt before becoming pixels. */
export function homeChart(period:HomePeriod,width=640,height=220):HomeChartModel{
  const left=78,right=8,top=10,bottom=26,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const series=HOME_CHART_SERIES.filter(item=>period.points.some(point=>point[item.field]!==null));
  const max=period.points.reduce((value,point)=>series.reduce((current,item)=>{const cents=BigInt(point[item.field]??'0');return cents>current?cents:current;},value),0n);
  const step=niceStep((max+3n)/4n),topValue=max===0n?4n*step:step*((max+step-1n)/step);
  const ticks=Array.from({length:Number(topValue/step)+1},(_,index)=>{const cents=step*BigInt(index);return {cents:cents.toString(),y:top+plotHeight-plotHeight*Number(cents*10000n/topValue)/10000};});
  const count=period.points.length,groupWidth=plotWidth/count,every=Math.ceil(count/8);
  const inner=groupWidth*0.72,gap=series.length>1?Math.min(2,inner/(series.length*4)):0,barWidth=Math.max(1,Math.min(18,(inner-gap*(series.length-1))/Math.max(series.length,1)));
  const groups=period.points.map((point,index)=>{
    const x=left+groupWidth*index,start=x+(groupWidth-(barWidth*series.length+gap*(series.length-1)))/2;
    const bars=series.map((item,position)=>{
      const cents=point[item.field]??'0',ratio=Number(BigInt(cents)*10000n/topValue)/10000,barHeight=cents==='0'?0:Math.max(1,plotHeight*ratio);
      return {series:item.key,cents,x:start+position*(barWidth+gap),y:top+plotHeight-barHeight,width:barWidth,height:barHeight};
    });
    return {bucket:point.bucket,label:index%every===0?homeBucketLabel(point.bucket,period.grain):null,title:homeBucketLabel(point.bucket,period.grain,true),x,width:groupWidth,bars};
  });
  return {width,height,left,top,bottom,series,empty:max===0n,ticks,groups};
}
/** Bar with 2px rounded data end, anchored to the baseline. */
export function homeBarPath(bar:HomeChartBar){
  const radius=Math.min(2,bar.width/2,bar.height),base=bar.y+bar.height,r=(value:number)=>Math.round(value*100)/100;
  return `M${r(bar.x)},${r(base)}V${r(bar.y+radius)}Q${r(bar.x)},${r(bar.y)} ${r(bar.x+radius)},${r(bar.y)}H${r(bar.x+bar.width-radius)}Q${r(bar.x+bar.width)},${r(bar.y)} ${r(bar.x+bar.width)},${r(bar.y+radius)}V${r(base)}Z`;
}

// ---- Atalhos favoritos (lista por usuário no servidor) ----
export interface HomeShortcuts {scope:'home_shortcuts';data_mode:'erp_native';role:AccessRole;version:number;customized:boolean;shortcuts:string[];/** 189: Nome of the favorites that have one. */labels?:Record<string,string>;available:string[];replayed?:boolean}
const ROLES:readonly string[]=['admin','consulta','vendas','financeiro','estoque','fiscal'];
// The available list is the catalog of real menu screens; only the saved favorites are limited to HOME_MAX_SHORTCUTS.
const validHomeAvailable=(value:unknown):value is string[]=>{const paths=homeShortcutPaths();return Array.isArray(value)&&value.length<=paths.length&&value.every(path=>typeof path==='string'&&paths.includes(path))&&new Set(value).size===value.length;};
export function homeShortcutsResult(value:unknown,expected?:{version:number;shortcuts:readonly string[];labels?:Readonly<Record<string,string>>}):HomeShortcuts{
  const item=value as HomeShortcuts;
  if(!item||typeof item!=='object'||item.scope!=='home_shortcuts'||item.data_mode!=='erp_native'||!ROLES.includes(item.role)
    ||!Number.isInteger(item.version)||item.version<0||typeof item.customized!=='boolean'||item.customized!==(item.version>0)
    ||!validHomeShortcuts(item.shortcuts)||!validHomeAvailable(item.available)||item.shortcuts.some(path=>!item.available.includes(homeShortcutBase(path)??''))
    ||item.labels!==undefined&&!validHomeLabels(item.labels,item.shortcuts))throw new Error('Resposta de atalhos inválida.');
  const labels=item.labels??{},names=expected?.labels??{};
  if(expected&&(typeof item.replayed!=='boolean'||item.version!==expected.version||item.shortcuts.length!==expected.shortcuts.length
    ||item.shortcuts.some((path,index)=>path!==expected.shortcuts[index])||Object.keys(labels).length!==Object.keys(names).length||Object.entries(names).some(([link,label])=>labels[link]!==label)))throw new Error('Resposta de atalhos inválida.');
  return {scope:'home_shortcuts',data_mode:'erp_native',role:item.role,version:item.version,customized:item.customized,shortcuts:[...item.shortcuts],labels:{...labels},available:[...item.available],...(expected?{replayed:item.replayed}:{})};
}
/** Shown name of a favorite: its own Nome, else the menu name of its screen (with "filtrado" for a link with filters). A
 * favorite whose screen this session's menu does not open is not shown, named or not (null). */
export function homeFavoriteLabel(link:string,labels:Readonly<Record<string,string>>,options:readonly HomeShortcutOption[]){
  const base=homeShortcutBase(link),option=options.find(o=>o.to===base);if(!option)return null;
  return labels[link]||(base===link?option.label:`${option.label} (filtrado)`);
}
// Origin's "Atalhos favoritos" names two screens differently from the menu.
export const HOME_SHORTCUT_LABELS:Readonly<Record<string,string>>={'/cadastros-reais?cadastro=products':'Listagem de produtos','/historico-fiscal?modelo=55':'Notas fiscais'};
export interface HomeShortcutOption {to:string;label:string;group:string}
/** Screens the server allows for the role, labeled from the Origin menu and, with a session, limited to what the menu opens. */
export function homeShortcutOptions(available:readonly string[],access?:CompanyAccess|null):HomeShortcutOption[]{
  const menu=access?.role?new Set(resolveMenu('real',access).flatMap(group=>[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])]).map(item=>item.to).filter(Boolean)):null;
  const options:HomeShortcutOption[]=[];
  for(const group of ORIGIN_MENU)for(const item of [...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])]){
    const to=item.real?.to;
    if(!to||to==='/acesso'||options.some(option=>option.to===to)||!available.includes(to)||(menu&&!menu.has(to)))continue;
    options.push({to,label:HOME_SHORTCUT_LABELS[to]??item.label,group:group.name});
  }
  return options;
}
export function homeSessionAccess(state:unknown):(CompanyAccess&{user_id:string})|null{
  const s=state as {phase?:string;membership?:{user_id?:unknown;role?:unknown;resources?:unknown}}|null;
  const member=s?.membership;
  if(s?.phase!=='ready'||!member||typeof member.user_id!=='string'||typeof member.role!=='string'||!ROLES.includes(member.role)||!Array.isArray(member.resources))return null;
  return {user_id:member.user_id,role:member.role,resources:member.resources.filter((value):value is string=>typeof value==='string')};
}
