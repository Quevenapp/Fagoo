import type {AccessState,NativeRequestOptions} from './real-access';
import {BUSINESS_BASE,BUSINESS_PANELS,BUSINESS_PANEL_ROLES,BUSINESS_STATUSES,BUSINESS_STATUS_LABELS,COST_ROLES,STOCK_ROLES,UFS,captureBusinessQuery,businessQuerySearch,parseBusinessPanel,
 captureGoalsQuery,parseGoals,captureGoalSave,parseGoalResult,
 type BusinessPanel,type BusinessQuery,type BusinessStatus,type BusinessPanelView,type BusinessRole,type Goal,type GoalsView,type GoalData,type GoalSaveInput,type GoalResult,type MonthlyPanel} from '../../../../packages/erp-domain/src/business-dashboards.mjs';
export {BUSINESS_BASE,BUSINESS_PANELS,BUSINESS_PANEL_ROLES,BUSINESS_STATUSES,BUSINESS_STATUS_LABELS,COST_ROLES,STOCK_ROLES,UFS,captureBusinessQuery,businessQuerySearch,parseBusinessPanel,
 captureGoalsQuery,parseGoals,captureGoalSave,parseGoalResult};
export type {BusinessPanel,BusinessQuery,BusinessStatus,BusinessPanelView,BusinessRole,Goal,GoalsView,GoalData,GoalSaveInput,GoalResult};
export type MonthlyPanelView=MonthlyPanel;
export interface BusinessController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;preferences:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}

/** Screen address: /meu-negocio?painel=<id> (Origin dashboard.meu.negocio.php#<hash>). */
export const BUSINESS_ROUTE='/meu-negocio';
export type BusinessScreen=BusinessPanel|'metas';
export const BUSINESS_TITLES:Record<BusinessScreen,string>={mensal:'Dashboard Mensal',diario:'Dashboard Diário','pedidos-venda':'Dashboard Pedidos de Venda','vendas-vendedor':'Dashboard Vendas por Vendedor',
 'venda-canal':'Venda Canal (24 meses)','previsao-estoque':'Dashboard Previsão de Estoque','margem-pedido':'Dashboard Margem por Pedido','novos-recorrentes':'Dashboard Novos x Recorrentes',
 'atividade-carteira':'Dashboard Atividade da Carteira','curva-abc':'Dashboard Curva ABC',metas:'Dashboard Metas'};
export type MenuEntry={label:string;screen?:BusinessScreen;to?:string;roles:readonly string[];disabledReason?:string};
const ALL=['admin','consulta','vendas','financeiro','estoque','fiscal'] as const;
// Origin side menu, in Origin order. Produtos opens the dashboards of the estoque lane (/painel-produtos-empresa).
export const BUSINESS_MENU:readonly{title:string;entries:readonly MenuEntry[]}[]=[
 {title:'Dashboard',entries:[{label:'Mensal',screen:'mensal',roles:ALL},{label:'Diário',screen:'diario',roles:ALL}]},
 {title:'Vendas',entries:[{label:'Pedidos de Venda',screen:'pedidos-venda',roles:ALL},{label:'Venda por Vendedor',screen:'vendas-vendedor',roles:ALL},{label:'Venda Canal (24 meses)',screen:'venda-canal',roles:ALL},
  {label:'Previsão de Estoque',screen:'previsao-estoque',roles:STOCK_ROLES}]},
 {title:'Gestão de Marketplaces',entries:[{label:'Margem por Pedido',screen:'margem-pedido',roles:COST_ROLES}]},
 {title:'Produtos',entries:[{label:'Estoque de Produtos',to:'/painel-produtos-empresa',roles:STOCK_ROLES},{label:'Sugestão de Compras',to:'/painel-produtos-empresa?painel=sugestao',roles:['admin','consulta','estoque','fiscal']},
  {label:'Sem Movimentação',to:'/painel-produtos-empresa?painel=sem-movimentacao',roles:STOCK_ROLES}]},
 {title:'Clientes',entries:[{label:'Novo x Recorrentes',screen:'novos-recorrentes',roles:ALL},{label:'Atividade da Carteira',screen:'atividade-carteira',roles:ALL}]},
 {title:'Desempenho',entries:[{label:'Curva ABC',screen:'curva-abc',roles:ALL},{label:'Metas',screen:'metas',roles:ALL}]},
 {title:'WhatsApp',entries:[{label:'Acompanhe no WhatsApp',roles:ALL,disabledReason:'Depende de uma integração com o WhatsApp, que o FAGOO não tem.'}]},
];
export const screenAllowed=(screen:BusinessScreen,role:string|undefined)=>Boolean(role)&&(screen==='metas'?(ALL as readonly string[]).includes(role!):(BUSINESS_PANEL_ROLES[screen] as readonly string[]).includes(role!));
export function businessScreen(search:string,role?:string):BusinessScreen{
 const value=new URLSearchParams(search).get('painel');
 const screen=(value==='metas'||(BUSINESS_PANELS as readonly string[]).includes(value??''))?value as BusinessScreen:'mensal';
 return screenAllowed(screen,role)?screen:'mensal';
}
export const businessHref=(screen:BusinessScreen)=>`${BUSINESS_ROUTE}?painel=${screen}`;
export const businessPanelPath=(q:BusinessQuery)=>{const s=businessQuerySearch(q);return `${BUSINESS_BASE}/${q.panel}${s?`?${s}`:''}`;};
export const goalsPath=(tab:'andamento'|'inativas')=>`${BUSINESS_BASE}/metas?aba=${tab}`;
export const goalsSavePath=()=>`${BUSINESS_BASE}/metas`;
export const goalCommandPath=(id:string)=>`${BUSINESS_BASE}/metas/comandos/${id}`;

/** São Paulo calendar date (contrato 8). */
export const todaySP=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(now);
export const shiftDay=(day:string,days:number)=>new Date(Date.parse(`${day}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
const lastDay=(year:number,month:number)=>new Date(Date.UTC(year,month,0)).getUTCDate();
export const monthStart=(day:string)=>`${day.slice(0,7)}-01`;
export const monthEnd=(day:string)=>{const [y,m]=day.split('-').map(Number) as [number,number];return `${day.slice(0,7)}-${String(lastDay(y,m)).padStart(2,'0')}`;};
/** Same days of the previous month (Origin "Data de comparação" of the Mensal), clamped to the month end. */
export function previousMonthRange(from:string,to:string){
 const back=(day:string)=>{const [y,m,d]=day.split('-').map(Number) as [number,number,number],year=m===1?y-1:y,month=m===1?12:m-1;return `${year}-${String(month).padStart(2,'0')}-${String(Math.min(d,lastDay(year,month))).padStart(2,'0')}`;};
 return{from:back(from),to:back(to)};
}
export const brDate=(day:string|null)=>day?day.split('-').reverse().join('/'):'—';
export const brMonth=(month:string)=>{const [y,m]=month.split('-');return `${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][Number(m)-1]}/${y.slice(2)}`;};
export const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
// Exact decimal strings formatted without floating point.
function group(digits:string){return digits.replace(/\B(?=(\d{3})+(?!\d))/g,'.');}
export function moneyText(value:string|null){if(value===null)return '—';const negative=value.startsWith('-'),[whole,cents='00']=value.replace('-','').split('.');return `${negative?'-':''}R$ ${group(whole)},${cents.padEnd(2,'0').slice(0,2)}`;}
export function qtyText(value:string|null){if(value===null)return '—';const negative=value.startsWith('-'),[whole,fraction='']=value.replace('-','').split('.');const f=fraction.replace(/0+$/,'');return `${negative?'-':''}${group(whole)}${f?`,${f}`:''}`;}
export const pctText=(value:string|null)=>value===null?'—':`${value.replace('.',',')}%`;
export const cents=(value:string)=>BigInt(value.replace('.','').replace(/^(-?)0+(?=\d)/,'$1'));
/** Variation of a KPI against the previous period, in whole tenths of percent; null without a base. */
export function variation(current:string,previous:string|null):{text:string;up:boolean}|null{
 if(previous===null)return null;const a=cents(current.includes('.')?current:`${current}.00`),b=cents(previous.includes('.')?previous:`${previous}.00`);if(b===0n)return null;
 const tenths=((a-b)*1000n)/(b<0n?-b:b),abs=tenths<0n?-tenths:tenths;return{text:`${tenths<0n?'-':'+'}${abs/10n},${abs%10n}%`,up:tenths>=0n};
}
export const statusText=(s:BusinessStatus)=>BUSINESS_STATUS_LABELS[s];
/** Default "Situação de Venda" (Origin: Em andamento, Atendido e Verificado), replaced by Configurações Meu negócio once read. */
export const DEFAULT_STATUSES:BusinessStatus[]=['verified','in_progress','fulfilled'];
export const canonicalStatuses=(list:readonly string[])=>BUSINESS_STATUSES.filter(s=>list.includes(s));
export const NO_RESULT='Nenhum resultado encontrado - Verifique os filtros utilizados.';
export function readError(status:number|null){
 if(status===400)return 'Filtros inválidos!';if(status===403)return 'Seu perfil não permite consultar este dashboard.';if(status===404)return 'Este dashboard não está disponível.';
 return 'Não foi possível consultar. Tente novamente.';
}
/** Bars of one chart: heights are proportional to exact cents (BigInt), only the pixel math uses numbers. */
export function barHeights(values:readonly string[],height:number){
 const list=values.map(v=>cents(v)),max=list.reduce((m,v)=>v>m?v:m,0n);
 return list.map(v=>max<=0n||v<=0n?0:Math.max(1,Math.round(Number((v*1000n)/max)*height/1000)));
}
/** Origin "Previsão Inteligente" (Dashboard Mensal), as a plain linear projection: the value of the days already passed in the
 * period, divided by those days and multiplied by every day of the period. Exact cents (half up). Null when the period has not
 * started yet. A period that already ended is its own total. */
export function forecastPeriod(daily:readonly{day:string;total:string}[],from:string,to:string,today:string){
 if(today<from||!daily.length)return null;
 const last=today<to?today:to,days=(a:string,b:string)=>(Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000+1;
 const elapsed=days(from,last),all=days(from,to),sum=daily.filter(d=>d.day<=last).reduce((s,d)=>s+cents(d.total),0n);
 const round=(n:bigint,d:bigint)=>(n*2n+d)/(2n*d),text=(v:bigint)=>{const neg=v<0n,a=neg?-v:v;return `${neg?'-':''}${a/100n}.${String(a%100n).padStart(2,'0')}`;};
 const projected=round(sum*BigInt(all),BigInt(elapsed));
 return{elapsed,days:all,sum:text(sum),per_day:text(round(sum,BigInt(elapsed))),projected:text(projected),complete:last===to};
}
/** Tile places (column, row) of the states on the Pedidos de Venda map, approximately where each UF is. */
export const BRAZIL_TILES:Readonly<Record<string,readonly[number,number]>>={RR:[2,0],AP:[4,0],AM:[1,1],PA:[3,1],MA:[4,1],CE:[5,1],RN:[6,1],AC:[0,2],RO:[1,2],MT:[2,2],TO:[3,2],PI:[4,2],PE:[5,2],PB:[6,2],
 MS:[2,3],GO:[3,3],BA:[4,3],AL:[5,3],DF:[3,4],MG:[4,4],SE:[5,4],PR:[2,5],SP:[3,5],RJ:[4,5],ES:[5,5],SC:[2,6],RS:[2,7]};
/** Shade 0 to 4 of a state's value against the biggest one (exact cents, rounded up). */
export function mapShade(total:string|undefined,max:bigint){if(!total||max<=0n)return 0;const v=cents(total);if(v<=0n)return 0;return Number((v*4n+max-1n)/max);}
export const goalProgress=(g:Goal)=>{const t=cents(g.target),a=cents(g.achieved);return t<=0n?0:Number(a*1000n/t>1000n?1000n:a*1000n/t)/10;};
export const blankGoal=(today:string):GoalData=>({name:'',start_on:monthStart(today),end_on:monthEnd(today),segment:'geral',seller:null,target:'',active:true});
/** Body of a goal command, or the reason it cannot be sent (Origin field names in the messages). */
export function goalBody(draft:GoalData,goal:Goal|null,commandId:string):{body?:GoalSaveInput;problem?:string}{
 const name=draft.name.replace(/^ +| +$/g,''),target=draft.target.trim().replace(/\./g,'').replace(',','.');
 if(!name||[...name].length>120)return{problem:'Informe o Nome da meta (até 120 caracteres).'};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(draft.start_on)||!/^\d{4}-\d{2}-\d{2}$/.test(draft.end_on)||draft.start_on>draft.end_on)return{problem:'Informe a Data início e a Data conclusão (início antes da conclusão).'};
 if(!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(target)||!/[1-9]/.test(target))return{problem:'Informe o Valor da meta, maior que zero, com até duas casas decimais.'};
 if(draft.segment==='vendedor'&&!draft.seller)return{problem:'Escolha o vendedor da meta.'};
 try{return{body:captureGoalSave({command_id:commandId,goal_id:goal?.id??null,expected_version:goal?.version??0,data:{...draft,name,target,seller:draft.segment==='vendedor'?draft.seller:null}})};}
 catch{return{problem:'Confira os campos da meta (o período tem no máximo 10 anos).'};}
}
export function goalFailure(status:number|null):{definitive:boolean;message:string}{
 if(status===409)return{definitive:true,message:'A meta mudou desde a consulta ou o comando já existe com outros dados. Nada foi salvo; recarregue e confira.'};
 if(status===400)return{definitive:true,message:'Nada foi salvo. Confira os campos da meta (ou nada mudou).'};
 if(status===403)return{definitive:true,message:'Nada foi salvo. Somente administradores incluem e alteram metas.'};
 if(status===404)return{definitive:true,message:'Nada foi salvo. A meta não foi encontrada.'};
 return{definitive:false,message:'Não foi possível confirmar se a meta foi salva. Confira o resultado do mesmo comando antes de tentar de novo.'};
}
