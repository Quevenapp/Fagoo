/** Closed150 contract: Meu Negócio dashboards (read-only) and Metas (one audited command per change), shared by the API
 * boundary and the browser. Values are decimal strings (money with 2 places, quantities with 6, percentages with 2); a
 * response that does not match its panel, filters or the role's visibility (custo, estoque) is refused. */
import { documentNativeCoverage } from './document-mirror.mjs';
export const BUSINESS_BASE='/v1/meu-negocio';
// Same bound as every Preferências and Sistema route (256 KiB): the SQL keeps each long table inside a byte budget
// (erp_home.biz_fit), so a panel returns the first rows that fit; the panel totals still count every row.
export const BUSINESS_MAX_BYTES=262144;
export const BUSINESS_BODY_BYTES=4096;
export const BUSINESS_ROLES=Object.freeze(['admin','consulta','vendas','financeiro','estoque','fiscal']);
// Canonical (Brufap) order of the sales order statuses; requests and responses use it.
export const BUSINESS_STATUSES=Object.freeze(['draft','open','verified','in_progress','partially_fulfilled','fulfilled','cancelled']);
export const BUSINESS_STATUS_LABELS=Object.freeze({draft:'Em digitação',open:'Em aberto',verified:'Verificado',in_progress:'Em andamento',partially_fulfilled:'Atendido parcialmente',fulfilled:'Atendido',cancelled:'Cancelado'});
export const BUSINESS_PANELS=Object.freeze(['mensal','diario','pedidos-venda','vendas-vendedor','venda-canal','previsao-estoque','margem-pedido','novos-recorrentes','atividade-carteira','curva-abc']);
export const BUSINESS_RPC=Object.freeze({mensal:'erp_home_business_monthly',diario:'erp_home_business_daily','pedidos-venda':'erp_home_business_orders','vendas-vendedor':'erp_home_business_sellers',
 'venda-canal':'erp_home_business_channels','previsao-estoque':'erp_home_business_forecast','margem-pedido':'erp_home_business_margin','novos-recorrentes':'erp_home_business_customers',
 'atividade-carteira':'erp_home_business_portfolio','curva-abc':'erp_home_business_abc'});
/** Roles of each panel: sales order readers (008); Margem por Pedido also reads purchase orders (cost); Previsão reads stock. */
export const COST_ROLES=Object.freeze(['admin','consulta','financeiro','estoque','fiscal']);
export const STOCK_ROLES=Object.freeze(['admin','consulta','vendas','estoque','fiscal']);
export const BUSINESS_PANEL_ROLES=Object.freeze(Object.fromEntries(BUSINESS_PANELS.map(p=>[p,p==='margem-pedido'?COST_ROLES:p==='previsao-estoque'?STOCK_ROLES:BUSINESS_ROLES])));
export const UFS=Object.freeze(['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO','EX']);
const PARAMS=Object.freeze({mensal:['situacoes','de','ate','comparar_de','comparar_ate'],diario:['situacoes','dia','comparar'],'pedidos-venda':['situacoes','de','ate','uf'],
 'vendas-vendedor':['situacoes','de','ate','vendedor'],'venda-canal':[],'previsao-estoque':['de','ate','deposito','reserva','modo'],'margem-pedido':['situacoes','de','ate','aba'],
 'novos-recorrentes':['situacoes','de','ate'],'atividade-carteira':['de','ate','marca','dias','palavras'],'curva-abc':['situacoes','de','ate','marca']});
export const BUSINESS_PANEL_PARAMS=PARAMS;
export const FORECAST_MODES=Object.freeze(['itens','desmembrados']);
export class BusinessContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new BusinessContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,CONTROL=/[\u0000-\u001f\u007f]/;
export const businessUuid=v=>typeof v==='string'&&UUID.test(v);
export const businessDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const month=v=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const span=(from,to)=>(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000+1;
const addDays=(day,n)=>new Date(Date.parse(`${day}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
const chars=v=>[...v].length;
const text=(v,max)=>typeof v==='string'&&chars(v)>=1&&chars(v)<=max&&!CONTROL.test(v)&&v===v.trim();
const snapshot=raw=>{try{return JSON.parse(JSON.stringify(raw));}catch{return fail();}};

/** Request filters of one panel from string parameters (URL search or UI form). Invalid input is a 400. */
export function captureBusinessQuery(panel,input={}){
 need(BUSINESS_PANELS.includes(panel),404,'ERP_NOT_FOUND');need(plain(input),400,'ERP_INVALID_QUERY');
 for(const k of Object.keys(input))need(PARAMS[panel].includes(k)&&(input[k]===null||input[k]===undefined||typeof input[k]==='string'),400,'ERP_INVALID_QUERY');
 const get=k=>input[k]===undefined||input[k]===null||input[k]===''?null:input[k];
 const statuses=()=>{const raw=get('situacoes');need(raw!==null,400,'ERP_INVALID_QUERY');const list=raw.split(',');
  need(list.length>=1&&list.length<=7&&list.every(s=>BUSINESS_STATUSES.includes(s))&&new Set(list).size===list.length,400,'ERP_INVALID_QUERY');return BUSINESS_STATUSES.filter(s=>list.includes(s));};
 const range=(a,b,max)=>{const from=get(a),to=get(b);need(businessDay(from)&&businessDay(to)&&from<=to&&span(from,to)<=max&&from>='2000-01-01'&&to<='2100-12-31',400,'ERP_INVALID_QUERY');return[from,to];};
 const q={panel};
 switch(panel){
  case'mensal':{q.statuses=statuses();[q.from,q.to]=range('de','ate',366);const a=get('comparar_de'),b=get('comparar_ate');need((a===null)===(b===null),400,'ERP_INVALID_QUERY');
   [q.compare_from,q.compare_to]=a===null?[null,null]:range('comparar_de','comparar_ate',366);break;}
  case'diario':q.statuses=statuses();q.day=get('dia');need(businessDay(q.day)&&q.day>='2000-01-01'&&q.day<='2100-12-31',400,'ERP_INVALID_QUERY');
   q.compare_day=get('comparar');need(q.compare_day===null||businessDay(q.compare_day)&&q.compare_day>='2000-01-01'&&q.compare_day<='2100-12-31',400,'ERP_INVALID_QUERY');break;
  case'pedidos-venda':q.statuses=statuses();[q.from,q.to]=range('de','ate',732);q.state=get('uf');need(q.state===null||UFS.includes(q.state),400,'ERP_INVALID_QUERY');break;
  case'vendas-vendedor':q.statuses=statuses();[q.from,q.to]=range('de','ate',732);q.seller=get('vendedor');need(q.seller===null||text(q.seller,80),400,'ERP_INVALID_QUERY');break;
  case'venda-canal':break;
  case'previsao-estoque':[q.from,q.to]=range('de','ate',732);q.warehouse_id=get('deposito');need(q.warehouse_id===null||businessUuid(q.warehouse_id),400,'ERP_INVALID_QUERY');
   need(['sim','nao'].includes(get('reserva')),400,'ERP_INVALID_QUERY');q.reserve=get('reserva')==='sim';
   // 265: Giro de Produto by Variações + Simples + Composições (itens) or Desmembrados (the composições by their components).
   q.mode=get('modo')??'itens';need(FORECAST_MODES.includes(q.mode),400,'ERP_INVALID_QUERY');break;
  case'margem-pedido':q.statuses=statuses();[q.from,q.to]=range('de','ate',732);q.tab=get('aba')??'todos';need(['todos','lucro','prejuizo'].includes(q.tab),400,'ERP_INVALID_QUERY');break;
  case'novos-recorrentes':q.statuses=statuses();[q.from,q.to]=range('de','ate',732);break;
  case'atividade-carteira':{[q.from,q.to]=range('de','ate',3661);q.brand=get('marca');need(q.brand===null||text(q.brand,100),400,'ERP_INVALID_QUERY');
   const days=get('dias');need(days===null||/^(0|[1-9][0-9]{0,4})$/.test(days)&&Number(days)<=36600,400,'ERP_INVALID_QUERY');q.min_days=days===null?null:Number(days);
   const words=get('palavras');q.keywords=words===null?[]:words.split(',');need(q.keywords.length<=10&&q.keywords.every(k=>text(k,60)&&!k.includes(','))&&new Set(q.keywords).size===q.keywords.length,400,'ERP_INVALID_QUERY');break;}
  case'curva-abc':q.statuses=statuses();[q.from,q.to]=range('de','ate',732);q.brand=get('marca');need(q.brand===null||text(q.brand,100),400,'ERP_INVALID_QUERY');break;
 }
 return Object.freeze(q);
}
/** URL parameters of a captured query, in a fixed order (the UI builds paths with it). */
export function businessQuerySearch(q){
 const p=new URLSearchParams(),set=(k,v)=>{if(v!==null&&v!==undefined&&v!=='')p.set(k,String(v));};
 if(q.statuses)set('situacoes',q.statuses.join(','));
 if(q.panel==='diario'){set('dia',q.day);set('comparar',q.compare_day);}else if(q.from){set('de',q.from);set('ate',q.to);}
 if(q.panel==='mensal'){set('comparar_de',q.compare_from);set('comparar_ate',q.compare_to);}
 if(q.panel==='pedidos-venda')set('uf',q.state);if(q.panel==='vendas-vendedor')set('vendedor',q.seller);
 if(q.panel==='previsao-estoque'){set('deposito',q.warehouse_id);set('reserva',q.reserve?'sim':'nao');if(q.mode!=='itens')set('modo',q.mode);}
 if(q.panel==='margem-pedido')set('aba',q.tab);
 if(q.panel==='atividade-carteira'||q.panel==='curva-abc')set('marca',q.brand);
 if(q.panel==='atividade-carteira'){set('dias',q.min_days);if(q.keywords.length)set('palavras',q.keywords.join(','));}
 return p.toString();
}
export function businessArgs(q){
 switch(q.panel){
  case'mensal':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to,p_compare_from:q.compare_from,p_compare_to:q.compare_to};
  case'diario':return{p_statuses:q.statuses,p_day:q.day,p_compare_day:q.compare_day};
  case'pedidos-venda':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to,p_state:q.state};
  case'vendas-vendedor':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to,p_seller:q.seller};
  case'venda-canal':return{};
  case'previsao-estoque':return{p_from:q.from,p_to:q.to,p_warehouse_id:q.warehouse_id,p_reserve:q.reserve,p_mode:q.mode};
  case'margem-pedido':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to,p_tab:q.tab};
  case'novos-recorrentes':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to};
  case'atividade-carteira':return{p_from:q.from,p_to:q.to,p_brand:q.brand,p_min_days:q.min_days,p_keywords:[...q.keywords]};
  case'curva-abc':return{p_statuses:q.statuses,p_from:q.from,p_to:q.to,p_brand:q.brand};
 }
 return fail(404,'ERP_NOT_FOUND');
}

// Response shapes. A schema is a scalar check, an object of schemas (exact keys) or [schema,max] for arrays.
const money=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(v);
const qty=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,17})\.[0-9]{6}$/.test(v);
const pct=v=>v===null||typeof v==='string'&&/^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(v);
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const nul=f=>v=>v===null||f(v);
const label=max=>v=>text(v,max);
const uuid=businessUuid,day=businessDay,status=v=>BUSINESS_STATUSES.includes(v),none=v=>v===null;
const stamp=v=>typeof v==='string'&&v.length<=40&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(v)&&Number.isFinite(Date.parse(v));
function shape(value,schema){
 if(typeof schema==='function'){need(schema(value));return;}
 if(Array.isArray(schema)){need(Array.isArray(value)&&value.length<=schema[1]);for(const item of value)shape(item,schema[0]);return;}
 const keys=Object.keys(schema);need(plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)));
 for(const k of keys)shape(value[k],schema[k]);
}
const KPIS={total:money,orders:count,units:qty,ticket:money};
const STATUS_ROW={status,orders:count,total:money};
// 188: IMPOSTOS from the alíquota of Ajustes and LUCRO (cost readers); null before 188. TAXA VENDA stays empty (no marketplace).
const INDICATORS={revenue_without_freight:money,cost:nul(money),gross_margin:nul(money),gross_margin_pct:pct,lines_without_cost:nul(count),taxes:nul(money),fees:none,profit:nul(money)};
const PRODUCT={product_id:nul(uuid),code:nul(label(60)),name:label(200),units:qty,total:money,cost:nul(money),margin_pct:pct,stock:nul(qty)};
const CHANNEL={channel:label(86),orders:count,total:money};
const GOAL={id:uuid,name:label(120),start_on:day,end_on:day,segment:v=>['geral','vendedor'].includes(v),seller:nul(label(80)),target:money,achieved:money,active:v=>typeof v==='boolean',version:v=>count(v)&&v>=1,updated_at:stamp};
const FILTERS={
 mensal:{statuses:[status,7],from:day,to:day,compare_from:nul(day),compare_to:nul(day)},
 diario:{statuses:[status,7],day,compare_day:nul(day)},
 'pedidos-venda':{statuses:[status,7],from:day,to:day,state:nul(v=>UFS.includes(v))},
 'vendas-vendedor':{statuses:[status,7],from:day,to:day,seller:nul(label(80))},
 'venda-canal':{statuses:[status,7],from:day,to:day},
 'previsao-estoque':{statuses:[status,7],from:day,to:day,warehouse_id:nul(uuid),reserve:v=>typeof v==='boolean',mode:v=>FORECAST_MODES.includes(v)},
 'margem-pedido':{statuses:[status,7],from:day,to:day,tab:v=>['todos','lucro','prejuizo'].includes(v)},
 'novos-recorrentes':{statuses:[status,7],from:day,to:day},
 'atividade-carteira':{statuses:[status,7],from:day,to:day,brand:nul(label(100)),min_days:nul(count),keywords:[label(60),10]},
 'curva-abc':{statuses:[status,7],from:day,to:day,brand:nul(label(100))},
};
const BODY={
 mensal:{kpis:{current:KPIS,previous:nul(v=>{shape(v,KPIS);return true;})},daily:{current:[{day,orders:count,total:money},366],previous:[{day,orders:count,total:money},366]},
  statuses:[STATUS_ROW,7],indicators:INDICATORS,channels:[CHANNEL,50],top_skus:[{...PRODUCT,forecast_days:nul(count)},10],months:[{month,total:money},12],annual:KPIS,goals:[GOAL,20]},
 diario:{kpis:{current:{...KPIS,new_customers:count},previous:nul(v=>{shape(v,{...KPIS,new_customers:count});return true;})},statuses:[STATUS_ROW,7],indicators:INDICATORS,top_skus:[PRODUCT,10]},
 'pedidos-venda':{totals:{orders:count,units:qty,total:money,freight:money,ticket:money},statuses:[STATUS_ROW,7],
  by_state:[{state:nul(v=>UFS.includes(v)),orders:count,units:qty,total:money,freight_avg:money,ticket:money},28],by_product:[PRODUCT,300],
  by_channel:[{channel:label(86),orders:count,ticket:money,units:qty,cost:nul(money),total:money,freight:money,unit_value:money,margin_pct:pct,taxes:nul(money),fees:none,contribution_pct:pct},50]},
 'vendas-vendedor':{sellers:[label(86),200],by_seller:[{seller:nul(label(86)),orders:count,units:qty,freight:money,total:money,ticket:money,margin_pct:pct},201],by_product:[PRODUCT,300],
  evolution:[{bucket:v=>day(v)||month(v),total:money},62],statuses:[STATUS_ROW,7]},
 'venda-canal':{channels:[label(86),20],months:[{month,values:[{channel:label(86),total:money},20]},24]},
 'previsao-estoque':{turnover:[{product_id:uuid,code:nul(label(60)),name:label(200),sold:qty,per_day:qty,stock:qty,composition:nul(v=>['physical','virtual'].includes(v)),coverage_days:nul(count)},300],by_channel:[{channel:label(86),orders:count,units:qty,total:money},50],
  by_day:[{day,units:qty,total:money},366]},
 // Leva H (374): freight_buyer is the frete cobrado do cliente, freight_seller the frete pago pela empresa (informed per pedido) and
 // freight_paid_pending the pedidos without it; each order carries its freight_paid (null while not informed).
 'margem-pedido':{indicators:{revenue:money,ticket:money,orders:count,freight_buyer:money,freight_seller:money,freight_paid_pending:count,cost:money,taxes:nul(money),fees:none,contribution:money,contribution_pct:pct,orders_without_cost:count},
  progression:[{day,revenue:money,contribution:money},366],total:count,
  orders:[{id:uuid,number:v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v),day,contact:label(200),channel:label(86),total:money,freight:money,freight_paid:nul(money),revenue:money,cost:nul(money),contribution:nul(money),contribution_pct:pct},500]},
 'novos-recorrentes':{cards:{recorrentes:{customers:count,orders:count,total:money,units:qty,ticket:money,share_pct:pct},novos:{customers:count,orders:count,total:money,units:qty,ticket:money,share_pct:pct}},
  chart:[{bucket:month,new:money,recurring:money},25],total:count,
  customers:[{contact_id:uuid,name:label(200),kind:v=>['novo','recorrente'].includes(v),channel:label(86),orders:count,units:qty,total:money,margin_pct:pct,profit:nul(money),mobile:nul(label(40))},300]},
 'atividade-carteira':{total:count,sum:money,customers:[{contact_id:uuid,name:label(200),orders:count,total:money,first_purchase:day,last_purchase:day,cycle_days:nul(count),days_without:count,
  document:nul(label(20)),state:nul(label(2)),email:nul(label(254)),mobile:nul(label(40))},500]},
 'curva-abc':{total:money,counts:{A:count,B:count,C:count},products:[{product_id:nul(uuid),code:nul(label(60)),name:label(200),units:qty,total:money,share_pct:pct,cumulative_pct:pct,curve:v=>['A','B','C'].includes(v)},800]},
};
const sameList=(a,b)=>Array.isArray(a)&&a.length===b.length&&a.every((v,i)=>v===b[i]);
const sum=values=>values.reduce((t,v)=>t+BigInt(v.replace('.','').replace(/^(-?)0+(?=\d)/,'$1')),0n);
const days=(from,to)=>Array.from({length:span(from,to)},(_,i)=>addDays(from,i));
/** GET /v1/meu-negocio/<painel>. `role` (optional) is the caller's role as the browser knows it. */
// A database before 374 answers Margem por Pedido without the frete pago: its Frete was the frete cobrado do cliente, now freight_buyer.
function legacyMargin(v){if(!plain(v)||v.panel!=='margem-pedido'||!plain(v.indicators)||Object.hasOwn(v.indicators,'freight_paid_pending')||v.indicators.freight_buyer!==null)return v;
 return{...v,indicators:{...v.indicators,freight_buyer:v.indicators.freight_seller,freight_seller:'0.00',freight_paid_pending:v.indicators.orders},
  orders:Array.isArray(v.orders)?v.orders.map(o=>plain(o)?{...o,freight_paid:null}:o):v.orders};}
export function parseBusinessPanel(raw,q){
 const v=legacyMargin(snapshot(raw)),body=BODY[q.panel];need(body);
 let coverage;try{coverage=documentNativeCoverage(v);}catch{need(false);}
 if(coverage.origin)for(const key of ['origin','mirror_excluded_count','coverage'])delete v[key];
 const envelope=['scope','data_mode','panel','role','as_of','business_date','cost_visible','stock_visible','filters'];
 need(plain(v)&&Object.keys(v).length===envelope.length+Object.keys(body).length&&[...envelope,...Object.keys(body)].every(k=>Object.hasOwn(v,k)));
 need(v.scope==='business_dashboard'&&v.data_mode==='erp_native'&&v.panel===q.panel&&BUSINESS_PANEL_ROLES[q.panel].includes(v.role)&&stamp(v.as_of)&&day(v.business_date));
 need(v.cost_visible===COST_ROLES.includes(v.role)&&v.stock_visible===STOCK_ROLES.includes(v.role));
 shape(v.filters,FILTERS[q.panel]);const f=v.filters;need(f.statuses.length>=1&&sameList(f.statuses,BUSINESS_STATUSES.filter(s=>f.statuses.includes(s))));
 if(q.statuses)need(sameList(f.statuses,q.statuses));
 for(const k of['from','to','compare_from','compare_to','day','compare_day','state','seller','warehouse_id','reserve','mode','tab','brand','min_days'])if(Object.hasOwn(q,k))need(f[k]===q[k]);
 if(q.keywords)need(sameList(f.keywords,q.keywords));
 const{scope,data_mode,panel,role,as_of,business_date,cost_visible,stock_visible,filters,...rest}=v;shape(rest,body);
 const noCost=rows=>{if(!cost_visible)need(rows.every(r=>(!('cost' in r)||r.cost===null)&&(!('margin_pct' in r)||r.margin_pct===null)&&(!('profit' in r)||r.profit===null)&&(!('contribution_pct' in r)||r.contribution_pct===null)));};
 const noStock=rows=>{if(!stock_visible)need(rows.every(r=>r.stock===null));};
 const indicators=i=>{need(cost_visible?i.cost!==null&&i.gross_margin!==null&&i.lines_without_cost!==null:i.cost===null&&i.gross_margin===null&&i.gross_margin_pct===null&&i.lines_without_cost===null&&i.profit===null);
  if(i.profit!==null)need(i.taxes!==null);};
 const statusRows=rows=>need(sameList(rows.map(r=>r.status),f.statuses));
 switch(panel){
  case'mensal':need(sameList(v.daily.current.map(r=>r.day),days(f.from,f.to))&&(f.compare_from===null?v.kpis.previous===null&&v.daily.previous.length===0:v.kpis.previous!==null&&sameList(v.daily.previous.map(r=>r.day),days(f.compare_from,f.compare_to))));
   need(sum(v.daily.current.map(r=>r.total))===sum([v.kpis.current.total])&&v.daily.current.reduce((t,r)=>t+r.orders,0)===v.kpis.current.orders);
   statusRows(v.statuses);indicators(v.indicators);noCost(v.top_skus);noStock(v.top_skus);need(v.top_skus.every(r=>r.cost===null&&r.margin_pct===null));need(v.months.length===12);break;
  case'diario':statusRows(v.statuses);indicators(v.indicators);noStock(v.top_skus);need(v.top_skus.every(r=>r.cost===null&&r.margin_pct===null)&&(f.compare_day===null)===(v.kpis.previous===null));break;
  case'pedidos-venda':statusRows(v.statuses);noCost(v.by_product);noCost(v.by_channel);need(v.by_product.every(r=>r.stock===null));
   need(v.statuses.reduce((t,r)=>t+r.orders,0)===v.totals.orders&&sum(v.statuses.map(r=>r.total))===sum([v.totals.total]));break;
  case'vendas-vendedor':statusRows(v.statuses);noCost(v.by_seller);noCost(v.by_product);need(v.by_product.every(r=>r.stock===null));break;
  case'venda-canal':need(v.months.length===24&&v.months.every(m=>sameList(m.values.map(x=>x.channel),v.channels)));break;
  case'previsao-estoque':need(stock_visible&&sameList(v.by_day.map(r=>r.day),days(f.from,f.to).slice(0,366)));break;
  case'margem-pedido':need(cost_visible&&v.orders.length<=v.total&&sameList(v.progression.map(r=>r.day),days(f.from,f.to).slice(0,366)));
   if(f.tab==='lucro')need(v.orders.every(o=>o.contribution!==null&&!o.contribution.startsWith('-')));if(f.tab==='prejuizo')need(v.orders.every(o=>o.contribution!==null&&o.contribution.startsWith('-')));break;
  case'novos-recorrentes':noCost(v.customers);need(v.customers.length<=v.total);break;
  case'atividade-carteira':need(v.customers.length<=v.total&&v.customers.every(c=>c.first_purchase<=c.last_purchase&&(f.min_days===null||c.days_without>=f.min_days)));break;
  case'curva-abc':need(v.products.length<=v.counts.A+v.counts.B+v.counts.C);break;
 }
 return {...v,...coverage};
}

// Metas.
export const GOAL_TABS=Object.freeze(['andamento','inativas']);
export function captureGoalsQuery(input={}){need(plain(input)&&Object.keys(input).every(k=>k==='aba'),400,'ERP_INVALID_QUERY');const tab=input.aba??'andamento';need(GOAL_TABS.includes(tab),400,'ERP_INVALID_QUERY');return Object.freeze({tab});}
export function parseGoals(raw,q){
 const v=snapshot(raw);let coverage;try{coverage=documentNativeCoverage(v);}catch{need(false);}
 if(coverage.origin)for(const key of ['origin','mirror_excluded_count','coverage'])delete v[key];
 shape(v,{scope:x=>x==='business_goals',data_mode:x=>x==='erp_native',role:x=>BUSINESS_ROLES.includes(x),tab:x=>x===q.tab,can_manage:x=>typeof x==='boolean',business_date:day,
  statuses:[status,7],total:count,items:[GOAL,200],sellers:[label(86),200]});
 need(v.can_manage===(v.role==='admin')&&v.items.length<=v.total);
 for(const g of v.items){need(g.start_on<=g.end_on&&(g.segment==='vendedor')===(g.seller!==null));const running=g.active&&g.end_on>=v.business_date;need(running===(q.tab==='andamento'));}
 return {...v,...coverage};
}
const GOAL_DATA=['active','end_on','name','segment','seller','start_on','target'];
/** POST /v1/meu-negocio/metas body: {command_id, goal_id|null, expected_version, data}. */
export function captureGoalSave(raw){
 const v=snapshot(raw);need(plain(v)&&Object.keys(v).length===4&&['command_id','goal_id','expected_version','data'].every(k=>Object.hasOwn(v,k)),400,'ERP_INVALID_INPUT');
 need(businessUuid(v.command_id)&&(v.goal_id===null||businessUuid(v.goal_id))&&Number.isSafeInteger(v.expected_version)&&v.expected_version>=0&&v.expected_version<=2147483646&&(v.goal_id===null)===(v.expected_version===0),400,'ERP_INVALID_INPUT');
 const d=v.data;need(plain(d)&&Object.keys(d).length===GOAL_DATA.length&&GOAL_DATA.every(k=>Object.hasOwn(d,k)),400,'ERP_INVALID_INPUT');
 need(text(d.name,120)&&day(d.start_on)&&day(d.end_on)&&d.start_on<=d.end_on&&span(d.start_on,d.end_on)<=3661&&d.start_on>='2000-01-01'&&d.end_on<='2100-12-31',400,'ERP_INVALID_INPUT');
 need(['geral','vendedor'].includes(d.segment)&&(d.segment==='vendedor'?text(d.seller,80):d.seller===null)&&typeof d.active==='boolean',400,'ERP_INVALID_INPUT');
 need(typeof d.target==='string'&&/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(d.target)&&/[1-9]/.test(d.target),400,'ERP_INVALID_INPUT');
 return Object.freeze({command_id:v.command_id,goal_id:v.goal_id,expected_version:v.expected_version,data:Object.freeze({...d})});
}
export function parseGoalResult(raw,{commandId,input=null,lookup=false}){
 const v=snapshot(raw);shape(v,{scope:x=>x==='business_goal_command',data_mode:x=>x==='erp_native',receipt:{command_id:x=>x===commandId,goal_id:uuid,changed_at:stamp,from_version:count,to_version:count},
  goal:nul(x=>{shape(x,GOAL);return true;}),replayed:x=>typeof x==='boolean'});
 need(v.receipt.to_version===v.receipt.from_version+1&&(!lookup||v.replayed===true)&&(v.goal===null||v.goal.id===v.receipt.goal_id&&v.goal.version>=v.receipt.to_version));
 if(!lookup)need(v.goal!==null);
 if(input){need(v.receipt.from_version===input.expected_version&&(input.goal_id===null||input.goal_id===v.receipt.goal_id));
  if(v.goal&&v.goal.version===v.receipt.to_version){const g=v.goal,d=input.data,[whole,cents='']=d.target.split('.');
   need(g.name===d.name&&g.start_on===d.start_on&&g.end_on===d.end_on&&g.segment===d.segment&&g.seller===d.seller&&g.active===d.active&&g.target===`${whole}.${cents.padEnd(2,'0')}`);}}
 return v;
}
