// Dashboards de produtos no padrão do Origin (migração 107): Estoque de Produtos, Sugestão de Compras e Sem Movimentação.
import {units} from './stock-launch-model.ts';
import {readNativeReportCoverage,type NativeReportCoverage} from './document-reports-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('INVALID_DASHBOARD');};
function need(value:unknown):asserts value {if(!value)fail();}
export type DashboardTab='estoque'|'sugestao'|'sem-movimentacao';
export const DASHBOARD_TABS:{id:DashboardTab;label:string}[]=[{id:'estoque',label:'Estoque de Produtos'},{id:'sugestao',label:'Sugestão de Compras'},{id:'sem-movimentacao',label:'Sem Movimentação'}];
export const dashboardTab=(search:string):DashboardTab=>{const value=new URLSearchParams(search).get('painel');return value==='sugestao'||value==='sem-movimentacao'?value:'estoque';};
// Sugestão de Compras shows Pedido de Compra and Valor Estimado (purchase data): stock readers who also read purchase orders (008).
const SUGGESTION_ROLES=['admin','consulta','estoque','fiscal'];
export const dashboardTabAllowed=(tab:DashboardTab,role:string|undefined)=>tab!=='sugestao'||SUGGESTION_ROLES.includes(role??'');
export const PURCHASE_STATUS_LABELS:Record<string,string>={open:'Em aberto',in_progress:'Em andamento',partially_fulfilled:'Atendido parcialmente',fulfilled:'Atendido',cancelled:'Cancelado'};
export const SALES_STATUS_LABELS:Record<string,string>={draft:'Em digitação',open:'Em aberto',verified:'Verificado',in_progress:'Em andamento',partially_fulfilled:'Atendido parcialmente',fulfilled:'Atendido',cancelled:'Cancelado'};
export const NO_RESULT='Nenhum resultado encontrado - Verifique os filtros utilizados.';
export const INVALID_FILTERS='Filtros inválidos!';
// 181: Fornecedor (product suppliers, 119) and Tipo de Estoque (Físico | Virtual) of the Origin filters.
export interface SupplierFilter {id:string;name:string}
export type StockTypeFilter=''|'fisico'|'virtual';
export const STOCK_TYPE_OPTIONS:{value:StockTypeFilter;label:string}[]=[{value:'',label:'Todos'},{value:'fisico',label:'Físico'},{value:'virtual',label:'Virtual'}];
/** Origin hint of the panel; Brufap reads the ledger when the panel is opened. */
export const STOCK_DASHBOARD_HINT='Os dados de Estoque, Custo e Valor podem levar até 15 minutos para ser atualizados no Origin. No FAGOO, eles são calculados na hora da consulta.';
export interface StockDashboardFilters {query:string;searchBy:'code'|'description'|'gtin';warehouse:string;brand:string;supplier?:SupplierFilter|null;stockType?:StockTypeFilter}
export function stockDashboardPath(filters:StockDashboardFilters,page:number):string {
  const params=new URLSearchParams();
  if(filters.query.trim())params.set('q',filters.query.trim());
  params.set('pesquisar_por',filters.searchBy);
  if(filters.warehouse)params.set('warehouse_id',filters.warehouse);
  if(filters.brand.trim())params.set('marca',filters.brand.trim());
  if(filters.supplier)params.set('fornecedor',filters.supplier.id);
  if(filters.stockType)params.set('tipo_estoque',filters.stockType);
  if(page>1)params.set('pagina',String(page));
  return `/v1/estoque/painel/estoque?${params}`;
}
// 145: Custo = quantidade × custo médio (Preferências > Suprimentos > Estoque); null for who does not read purchase orders.
// 181: Custo of Origin = custo do fornecedor padrão × quantidade (stock_cost, cost_source 'supplier'); without it, the custo médio ('average').
export interface StockDashboardRow {product_id:string;code:string|null;name:string;quantity:string;value:string|null;average_cost?:string|null;cost?:string|null;
  supplier_cost?:string|null;unit_cost?:string|null;cost_source?:'supplier'|'average'|null;stock_cost?:string|null}
export interface StockDashboardPage extends NativeReportCoverage {items:StockDashboardRow[];total:number;page:number;totals:{quantity:string;value:string;unpriced:number;cost?:string|null;uncosted?:number|null;stock_cost?:string|null;stock_uncosted?:number|null;supplier_costed?:number|null};
  warehouses:{warehouse_id:string;name:string;ignored:boolean;quantity:string;value:string;cost?:string|null;stock_cost?:string|null}[];costVisible:boolean;costBasis:'preco_compra'|'custo_lancamento'}
/** Custo shown in the Origin column: the 181 value, or the custo médio of an older answer. */
export const rowCost=(row:{stock_cost?:string|null;cost?:string|null})=>row.stock_cost!==undefined?row.stock_cost:row.cost??null;
export const rowCostSource=(row:StockDashboardRow)=>row.cost_source!==undefined?row.cost_source:row.cost?'average':null;
export const totalCost=(totals:StockDashboardPage['totals'])=>totals.stock_cost!==undefined?totals.stock_cost:totals.cost??null;
export const totalUncosted=(totals:StockDashboardPage['totals'])=>totals.stock_uncosted!==undefined?totals.stock_uncosted:totals.uncosted??null;
export function parseStockDashboard(value:unknown,page:number):StockDashboardPage {
  need(isObject(value)&&value.scope==='stock_dashboard_stock'&&value.page===page&&Number.isInteger(value.total)&&Array.isArray(value.items)&&isObject(value.totals)&&Array.isArray(value.warehouses));
  for(const item of value.items as unknown[])need(isObject(item)&&typeof item.product_id==='string'&&UUID.test(item.product_id)&&typeof item.quantity==='string');
  const costVisible=value.cost_visible===true;
  return {items:value.items as StockDashboardRow[],total:value.total as number,page,totals:value.totals as StockDashboardPage['totals'],warehouses:value.warehouses as StockDashboardPage['warehouses'],
    costVisible,costBasis:value.cost_basis==='custo_lancamento'?'custo_lancamento':'preco_compra',...readNativeReportCoverage(value)};
}
export interface IdleRow {product_id:string;code:string|null;name:string;quantity:string;last_sale:string|null}
export function parseIdle(value:unknown,since:string,page:number):NativeReportCoverage & {items:IdleRow[];total:number} {
  need(isObject(value)&&value.scope==='stock_dashboard_idle'&&value.since===since&&value.page===page&&Number.isInteger(value.total)&&Array.isArray(value.items));
  for(const item of value.items as unknown[])need(isObject(item)&&typeof item.product_id==='string'&&(item.last_sale===null||(typeof item.last_sale==='string'&&item.last_sale<since)));
  return {items:value.items as IdleRow[],total:value.total as number,...readNativeReportCoverage(value)};
}
export interface SuggestionFilters {from:string;to:string;coverage:string;warehouse:string;reserve:boolean;purchase:string[];sales:string[];brand:string;supplier?:SupplierFilter|null}
/** Origin default: from the same day of the previous month until today (America/Sao_Paulo). */
export function defaultPeriod(today:string):{from:string;to:string} {
  const [y,m,d]=today.split('-').map(Number) as [number,number,number],month=m===1?12:m-1,year=m===1?y-1:y,last=new Date(Date.UTC(year,month,0)).getUTCDate();
  return {from:`${year}-${String(month).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`,to:today};
}
export function suggestionPath(filters:SuggestionFilters):string {
  const coverage=filters.coverage.trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(filters.from)||!/^\d{4}-\d{2}-\d{2}$/.test(filters.to)||filters.from>filters.to||!/^[1-9]\d{0,3}$/.test(coverage)||Number(coverage)>3650||!filters.purchase.length||!filters.sales.length)throw new Error(INVALID_FILTERS);
  const params=new URLSearchParams({de:filters.from,ate:filters.to,cobertura:coverage,reserva:filters.reserve?'sim':'nao',compras:filters.purchase.join(','),vendas:filters.sales.join(',')});
  if(filters.warehouse)params.set('warehouse_id',filters.warehouse);
  if(filters.brand.trim())params.set('marca',filters.brand.trim());
  if(filters.supplier)params.set('fornecedor',filters.supplier.id);
  return `/v1/estoque/painel/sugestao?${params}`;
}
// 181: the unit and the supplier of each row ("Gerar pedido de compra com os selecionados") and the origin of the Valor Estimado price.
export type PriceSource='supplier_cost'|'supplier_purchase'|'last_purchase';
export const PRICE_SOURCE_LABELS:Record<PriceSource,string>={supplier_cost:'Preço de custo do fornecedor',supplier_purchase:'Preço de compra do fornecedor',last_purchase:'Preço da última compra registrada no FAGOO'};
export type PriceMode='ultima_compra'|'custo'|'compra';
export interface SuggestionRow {product_id:string;code:string|null;name:string;sold:string;stock:string;reserved:string;ordered:string;suggestion:string;unit_price:string|null;value:string|null;
  unit?:string|null;price_source?:PriceSource|null;supplier_id?:string|null;supplier_name?:string|null}
export function parseSuggestion(value:unknown,filters:SuggestionFilters):NativeReportCoverage & {items:SuggestionRow[];total:number;days:number;priceMode:PriceMode} {
  need(isObject(value)&&value.scope==='stock_purchase_suggestion'&&Array.isArray(value.items)&&Number.isInteger(value.total)&&Number.isInteger(value.days)&&isObject(value.filters)
    &&value.filters.date_from===filters.from&&value.filters.date_to===filters.to&&value.filters.coverage===Number(filters.coverage)&&value.filters.reserve===filters.reserve
    &&(value.filters.supplier_id===undefined?!filters.supplier:value.filters.supplier_id===(filters.supplier?.id??null)));
  const mode:PriceMode=value.price_mode==='custo'||value.price_mode==='compra'?value.price_mode:'ultima_compra';
  return {items:value.items as SuggestionRow[],total:value.total as number,days:value.days as number,priceMode:mode,...readNativeReportCoverage(value)};
}
export interface PurchaseOrderItem {product_id:string;description:string;code?:string;unit:string;quantity:string;unit_price:string}
/** "Gerar pedido de compra com os selecionados": the rows with a suggestion and a unit, as items of a new purchase order (documentos API). */
export function purchaseOrderItems(rows:readonly SuggestionRow[]):PurchaseOrderItem[] {
  return rows.filter(row=>/^[1-9][0-9]*$/.test(row.suggestion)&&row.unit).map(row=>({product_id:row.product_id,description:row.name.slice(0,200),...(row.code?{code:row.code.slice(0,100)}:{}),unit:row.unit!,
    quantity:row.suggestion,unit_price:row.unit_price??'0'}));
}
/** The supplier proposed for the order: the filtered one or, when every selected row has the same default supplier, that one. */
export function proposedSupplier(rows:readonly SuggestionRow[],filter:SupplierFilter|null|undefined):SupplierFilter|null {
  if(filter)return filter;
  const ids=new Set(rows.map(row=>row.supplier_id??null));
  if(ids.size!==1||ids.has(null))return null;
  return {id:rows[0]!.supplier_id!,name:rows[0]!.supplier_name??''};
}
/** "Estoque Atual" of Origin: with Reserva = Sim, the reserved quantity is taken off. */
export const currentStock=(row:SuggestionRow,reserve:boolean)=>reserve?fromUnits(units(row.stock)-units(row.reserved)):row.stock;
export const fromUnits=(value:bigint)=>{const negative=value<0n,digits=(negative?-value:value).toString().padStart(7,'0');return `${negative?'-':''}${digits.slice(0,-6)}.${digits.slice(-6)}`;};
export type SuggestionSort={key:'code'|'name'|'sold'|'stock'|'ordered'|'suggestion'|'value';direction:'asc'|'desc'};
const numeric=(value:string|null)=>value===null?null:units(value.includes('.')?value:`${value}.000000`);
/** Exact client-side sort of every column (Origin sorts all of them; default Sugestão de Compra descending). */
export function sortSuggestion(rows:readonly SuggestionRow[],sort:SuggestionSort,reserve:boolean):SuggestionRow[] {
  const key=(row:SuggestionRow)=>sort.key==='code'?row.code??'':sort.key==='name'?row.name:sort.key==='stock'?numeric(currentStock(row,reserve)):numeric(row[sort.key]);
  return [...rows].sort((a,b)=>{const x=key(a),y=key(b);let order:number;
    if(typeof x==='string'||typeof y==='string')order=String(x??'').localeCompare(String(y??''),'pt-BR');
    else order=x===null&&y===null?0:x===null?-1:y===null?1:x<y?-1:x>y?1:0;
    return (sort.direction==='asc'?order:-order)||a.product_id.localeCompare(b.product_id);});
}
export function suggestionTotals(rows:readonly SuggestionRow[],reserve:boolean){
  const sum=(pick:(row:SuggestionRow)=>string|null)=>rows.reduce((total,row)=>{const value=pick(row);return value===null?total:total+numeric(value)!;},0n);
  const money=rows.reduce((total,row)=>row.value===null?total:total+BigInt(row.value.replace('.','')),0n),cents=money.toString().padStart(3,'0');
  return {sold:fromUnits(sum(row=>row.sold)),stock:fromUnits(sum(row=>currentStock(row,reserve))),ordered:fromUnits(sum(row=>row.ordered)),suggestion:fromUnits(sum(row=>row.suggestion)),value:`${cents.slice(0,-2)}.${cents.slice(-2)}`};
}
