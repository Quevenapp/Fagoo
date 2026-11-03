// QA_SYNTHETIC_BUSINESS — synthetic local ports for Meu Negócio (dashboards, Metas and Ajustes), no network and no real data.
import {AccessError,type AccessState,type AccessRole,type NativeRequestOptions} from '../lib/real-access.ts';
import {captureSystemPortRequest} from '../lib/system-request.ts';
import {capturePreferencesRequest} from '../lib/preferences-request.ts';
import {captureBusinessQuery,COST_ROLES,STOCK_ROLES,BUSINESS_PANEL_ROLES,type BusinessQuery,type Goal,type GoalSaveInput} from '../../../../packages/erp-domain/src/business-dashboards.mjs';
export const BUSINESS_QA_ACTOR='10000000-0000-4000-8000-000000000150';
const PRODUCT='70000000-0000-4000-8000-000000000150',CONTACT='71000000-0000-4000-8000-000000000150',ORDER='72000000-0000-4000-8000-000000000150',STAMP='2026-10-20T12:00:00.000000+00:00';
const days=(from:string,to:string)=>{const out:string[]=[];for(let t=Date.parse(`${from}T00:00:00Z`);t<=Date.parse(`${to}T00:00:00Z`)&&out.length<366;t+=86400000)out.push(new Date(t).toISOString().slice(0,10));return out;};
const months=(from:string,to:string)=>{const out:string[]=[];let [y,m]=from.split('-').map(Number) as [number,number];const end=to.slice(0,7);for(;;){const v=`${y}-${String(m).padStart(2,'0')}`;out.push(v);if(v>=end)break;m++;if(m>12){m=1;y++;}}return out;};
export type BusinessQaCall={path:string;method:string;body?:unknown};
/** One order of R$ 16,00 (Caneta azul x2 + Lápis x5, frete R$ 5,00) on the first day of every requested period. */
function panelValue(q:BusinessQuery,role:AccessRole,today:string){
 const cost=COST_ROLES.includes(role),stock=STOCK_ROLES.includes(role),statuses=q.statuses??['verified','in_progress','fulfilled'];
 const base={scope:'business_dashboard',data_mode:'erp_native',panel:q.panel,role,as_of:STAMP,business_date:today,cost_visible:cost,stock_visible:stock};
 const kpis={total:'16.00',orders:1,units:'7.000000',ticket:'16.00'},status=statuses.map((s,i)=>({status:s,orders:i===0?1:0,total:i===0?'16.00':'0.00'}));
 const indicators={revenue_without_freight:'11.00',cost:cost?'2.50':null,gross_margin:cost?'8.50':null,gross_margin_pct:cost?'77.27':null,lines_without_cost:cost?1:null,taxes:null,fees:null,profit:null};
 const product=(over={})=>({product_id:PRODUCT,code:'CAN-1',name:'Caneta azul',units:'2.000000',total:'6.00',cost:null,margin_pct:null,stock:null,...over});
 switch(q.panel){
  case'mensal':{const current=days(q.from!,q.to!);return{...base,filters:{statuses,from:q.from,to:q.to,compare_from:q.compare_from,compare_to:q.compare_to},
   kpis:{current:kpis,previous:q.compare_from?{total:'8.00',orders:1,units:'2.000000',ticket:'8.00'}:null},daily:{current:current.map((day,i)=>({day,orders:i===0?1:0,total:i===0?'16.00':'0.00'})),previous:q.compare_from?days(q.compare_from,q.compare_to!).map(day=>({day,orders:0,total:'0.00'})):[]},
   statuses:status,indicators,channels:[{channel:'Pedido Manual',orders:1,total:'16.00'}],top_skus:[{...product({stock:stock?'4.000000':null}),forecast_days:stock?20:null}],
   months:months(`${Number(q.to!.slice(0,4))-1}-${q.to!.slice(5,7)}`,q.to!).slice(1).map(month=>({month,total:month===q.to!.slice(0,7)?'16.00':'0.00'})),annual:kpis,
   goals:[{id:ORDER,name:'Meta de outubro',start_on:`${today.slice(0,7)}-01`,end_on:`${today.slice(0,4)}-12-31`,segment:'geral',seller:null,target:'100.00',achieved:'16.00',active:true,version:1,updated_at:STAMP}]};}
  case'diario':return{...base,filters:{statuses,day:q.day,compare_day:q.compare_day},kpis:{current:{...kpis,new_customers:1},previous:q.compare_day?{total:'0.00',orders:0,units:'0.000000',ticket:'0.00',new_customers:0}:null},statuses:status,indicators,top_skus:[product({stock:stock?'4.000000':null})]};
  case'pedidos-venda':return{...base,filters:{statuses,from:q.from,to:q.to,state:q.state},totals:{orders:1,units:'7.000000',total:'16.00',freight:'5.00',ticket:'16.00'},statuses:status,
   by_state:[{state:'SP',orders:1,units:'7.000000',total:'16.00',freight_avg:'5.00',ticket:'16.00'}],by_product:[product({cost:cost?'2.50':null,margin_pct:cost?'58.33':null})],
   by_channel:[{channel:'Pedido Manual',orders:1,ticket:'16.00',units:'7.000000',cost:null,total:'16.00',freight:'5.00',unit_value:'1.57',margin_pct:null,taxes:null,fees:null,contribution_pct:null}]};
  case'vendas-vendedor':return{...base,filters:{statuses,from:q.from,to:q.to,seller:q.seller},sellers:['Ana Sintética'],by_seller:[{seller:'Ana Sintética',orders:1,units:'7.000000',freight:'5.00',total:'16.00',ticket:'16.00',margin_pct:null}],
   by_product:[product()],evolution:days(q.from!,q.to!).slice(0,62).map(bucket=>({bucket,total:'0.00'})),statuses:status};
  case'venda-canal':{const end=today.slice(0,7),list=months(`${Number(end.slice(0,4))-2}-${end.slice(5,7)}`,end).slice(1);
   return{...base,filters:{statuses,from:`${list[0]}-01`,to:today},channels:['Pedido Manual'],months:list.map(month=>({month,values:[{channel:'Pedido Manual',total:month===end?'16.00':'0.00'}]}))};}
  case'previsao-estoque':return{...base,filters:{statuses,from:q.from,to:q.to,warehouse_id:q.warehouse_id,reserve:q.reserve,mode:q.mode},turnover:[{product_id:PRODUCT,code:'CAN-1',name:'Caneta azul',sold:'2.000000',per_day:'0.066667',stock:'4.000000',composition:null,coverage_days:60}],
   by_channel:[{channel:'Pedido Manual',orders:1,units:'7.000000',total:'16.00'}],by_day:days(q.from!,q.to!).map(day=>({day,units:'0.000000',total:'0.00'}))};
  case'margem-pedido':{const orders=[{id:ORDER,number:'1',day:q.from,contact:'Cliente Alfa',channel:'Pedido Manual',total:'16.00',freight:'5.00',freight_paid:null,revenue:'11.00',cost:'2.50',contribution:'8.50',contribution_pct:'77.27'}].filter(()=>q.tab!=='prejuizo');
   return{...base,filters:{statuses,from:q.from,to:q.to,tab:q.tab},indicators:{revenue:'16.00',ticket:'16.00',orders:1,freight_buyer:'5.00',freight_seller:'0.00',freight_paid_pending:1,cost:'2.50',taxes:null,fees:null,contribution:'8.50',contribution_pct:'77.27',orders_without_cost:0},
    progression:days(q.from!,q.to!).map(day=>({day,revenue:'0.00',contribution:'0.00'})),total:orders.length,orders};}
  case'novos-recorrentes':return{...base,filters:{statuses,from:q.from,to:q.to},cards:{recorrentes:{customers:0,orders:0,total:'0.00',units:'0.000000',ticket:'0.00',share_pct:null},novos:{customers:1,orders:1,total:'16.00',units:'7.000000',ticket:'16.00',share_pct:'100.00'}},
   chart:months(q.from!,q.to!).map(bucket=>({bucket,new:'16.00',recurring:'0.00'})),total:1,customers:[{contact_id:CONTACT,name:'Cliente Alfa',kind:'novo',channel:'Pedido Manual',orders:1,units:'7.000000',total:'16.00',margin_pct:cost?'77.27':null,profit:cost?'8.50':null,mobile:'11999990000'}]};
  case'atividade-carteira':return{...base,filters:{statuses,from:q.from,to:q.to,brand:q.brand,min_days:q.min_days,keywords:q.keywords},total:1,sum:'16.00',
   customers:[{contact_id:CONTACT,name:'Cliente Alfa',orders:2,total:'16.00',first_purchase:q.from,last_purchase:q.from,cycle_days:null,days_without:10,document:null,state:'SP',email:'alfa@sintetico.test',mobile:null}]};
  case'curva-abc':return{...base,filters:{statuses,from:q.from,to:q.to,brand:q.brand},total:'11.00',counts:{A:1,B:0,C:1},products:[{product_id:PRODUCT,code:'CAN-1',name:'Caneta azul',units:'2.000000',total:'6.00',share_pct:'54.55',cumulative_pct:'54.55',curve:'A'},
   {product_id:null,code:null,name:'Lápis',units:'5.000000',total:'5.00',share_pct:'45.45',cumulative_pct:'100.00',curve:'C'}]};
 }
 return null;
}
export function createBusinessFixture({role='admin',before,finished=['fulfilled','in_progress','verified'],today='2026-10-20',lostAck=false,taxRate:taxRateInitial='0'}:{taxRate?:string;role?:AccessRole;before?:(call:BusinessQaCall)=>unknown|Promise<unknown>;finished?:string[];today?:string;lostAck?:boolean}={}){
 let state:AccessState={phase:'ready',membership:{user_id:BUSINESS_QA_ACTOR,role,resources:[],data_mode:'staging_readonly'},records:null,listPending:false,loginPending:false,message:null,logoutFailed:false};
 const listeners=new Set<()=>void>(),calls:BusinessQaCall[]=[],goals:Goal[]=[],commands=new Map<string,unknown>();let lose=lostAck,finishedVersion=0,taxRate=taxRateInitial,taxVersion=taxRateInitial==='0'?0:1;
 const goalsView=(tab:string)=>({scope:'business_goals',data_mode:'erp_native',role:state.membership!.role,tab,can_manage:state.membership!.role==='admin',business_date:today,statuses:['verified','in_progress','fulfilled'],
  total:goals.filter(g=>(g.active&&g.end_on>=today)===(tab==='andamento')).length,items:goals.filter(g=>(g.active&&g.end_on>=today)===(tab==='andamento')),sellers:['Ana Sintética']});
 const controller={getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
  async system(path:string,options:NativeRequestOptions={}){
   const captured=captureSystemPortRequest(path,options),call={path,method:captured.options.method,body:captured.options.body};calls.push(call);
   const replacement=await before?.(call);if(replacement!==undefined)return replacement;
   const [pathname,search='']=path.split('?'),rest=pathname.slice('/v1/meu-negocio/'.length),r=state.membership!.role;
   if(rest==='metas'&&call.method==='GET')return structuredClone(goalsView(new URLSearchParams(search).get('aba')??'andamento'));
   if(rest==='metas'){if(r!=='admin')throw new AccessError(403);const body=call.body as GoalSaveInput,known=commands.get(body.command_id);if(known)return structuredClone({...(known as object),replayed:true});
    const target=body.data.target.includes('.')?`${body.data.target.split('.')[0]}.${body.data.target.split('.')[1]!.padEnd(2,'0')}`:`${body.data.target}.00`;
    let goal=goals.find(g=>g.id===body.goal_id);if(body.goal_id&&!goal)throw new AccessError(404);if(goal&&goal.version!==body.expected_version)throw new AccessError(409);
    const next:Goal={id:goal?.id??crypto.randomUUID(),...body.data,target,achieved:'16.00',version:(goal?.version??0)+1,updated_at:STAMP};
    if(goal)Object.assign(goal,next);else goals.push(next);goal=next;
    const result={scope:'business_goal_command',data_mode:'erp_native',receipt:{command_id:body.command_id,goal_id:next.id,changed_at:STAMP,from_version:body.expected_version,to_version:body.expected_version+1},goal:structuredClone(next),replayed:false};
    commands.set(body.command_id,result);if(lose){lose=false;throw new AccessError(503);}return structuredClone(result);}
   if(rest.startsWith('metas/comandos/')){const known=commands.get(rest.slice(15));if(!known)throw new AccessError(404);return structuredClone({...(known as object),replayed:true});}
   const q=captureBusinessQuery(rest,Object.fromEntries(new URLSearchParams(search)));
   if(!(BUSINESS_PANEL_ROLES[q.panel] as readonly string[]).includes(r))throw new AccessError(403);
   return structuredClone(panelValue(q,r,today));
  },
  async preferences(path:string,options:NativeRequestOptions={}){
   const captured=capturePreferencesRequest(path,options);calls.push({path,method:captured.options.method});
   // 188: the page also carries the alíquota de imposto (version 0, value "0" until saved).
   const items=()=>[{key:'negocio.situacoes_finalizado',value:[...finished],version:finishedVersion,updated_at:finishedVersion?STAMP:null},{key:'negocio.aliquota_imposto',value:taxRate,version:taxVersion,updated_at:taxVersion?STAMP:null}];
   if(captured.options.method==='POST'){if(state.membership!.role!=='admin')throw new AccessError(403);const body=captured.options.body as {command_id:string;changes:{key:string;expected_version:number;value:string[]|string}[]};const changes=[];
    for(const c of body.changes){if(c.key==='negocio.aliquota_imposto'){if(c.expected_version!==taxVersion)throw new AccessError(409);changes.push({key:c.key,from_version:taxVersion,to_version:taxVersion+1,before:taxRate,after:c.value});taxRate=c.value as string;taxVersion++;}
     else{if(c.expected_version!==finishedVersion)throw new AccessError(409);const before=finished;finished=[...c.value as string[]];finishedVersion++;changes.push({key:c.key,from_version:finishedVersion-1,to_version:finishedVersion,before,after:finished});}}
    const page={scope:'preferences_page',data_mode:'erp_native',page:'meu-negocio',owner:'company',role:state.membership!.role,can_manage:true,items:items(),directory:null};
    return{scope:'preferences_command',data_mode:'erp_native',replayed:false,receipt:{command_id:body.command_id,page:'meu-negocio',changed_at:STAMP,changes},page};}
   return{scope:'preferences_page',data_mode:'erp_native',page:'meu-negocio',owner:'company',role:state.membership!.role,can_manage:state.membership!.role==='admin',items:items(),directory:null};
  }};
 return{controller,calls,goals,setAccess(patch:{role?:AccessRole;actor?:string}){state={...state,membership:{...state.membership!,role:patch.role??state.membership!.role,user_id:patch.actor??state.membership!.user_id}};for(const fn of listeners)fn();}};
}
