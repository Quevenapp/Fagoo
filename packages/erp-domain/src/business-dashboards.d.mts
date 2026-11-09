import type { NativeDocumentCoverage } from './document-mirror.mjs';
export type BusinessRole='admin'|'consulta'|'vendas'|'financeiro'|'estoque'|'fiscal'|'operacao';
export type BusinessStatus='draft'|'open'|'verified'|'in_progress'|'partially_fulfilled'|'fulfilled'|'cancelled';
export type BusinessPanel='mensal'|'diario'|'pedidos-venda'|'vendas-vendedor'|'venda-canal'|'previsao-estoque'|'margem-pedido'|'novos-recorrentes'|'atividade-carteira'|'curva-abc';
export const BUSINESS_BASE:'/v1/meu-negocio';
export const BUSINESS_MAX_BYTES:number;
export const BUSINESS_BODY_BYTES:number;
export const BUSINESS_ROLES:readonly BusinessRole[];
export const BUSINESS_STATUSES:readonly BusinessStatus[];
export const BUSINESS_STATUS_LABELS:Readonly<Record<BusinessStatus,string>>;
export const BUSINESS_PANELS:readonly BusinessPanel[];
export const BUSINESS_RPC:Readonly<Record<BusinessPanel,string>>;
export const COST_ROLES:readonly BusinessRole[];
export const STOCK_ROLES:readonly BusinessRole[];
export const BUSINESS_PANEL_ROLES:Readonly<Record<BusinessPanel,readonly BusinessRole[]>>;
export const BUSINESS_PANEL_PARAMS:Readonly<Record<BusinessPanel,readonly string[]>>;
export const UFS:readonly string[];
export class BusinessContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export function businessUuid(value:unknown):value is string;
export function businessDay(value:unknown):value is string;
export interface BusinessQuery{panel:BusinessPanel;statuses?:BusinessStatus[];from?:string;to?:string;compare_from?:string|null;compare_to?:string|null;day?:string;compare_day?:string|null;
 state?:string|null;seller?:string|null;warehouse_id?:string|null;reserve?:boolean;mode?:ForecastMode;tab?:'todos'|'lucro'|'prejuizo';brand?:string|null;min_days?:number|null;keywords?:string[]}
export type ForecastMode='itens'|'desmembrados';
export const FORECAST_MODES:readonly ForecastMode[];
export function captureBusinessQuery(panel:string,input?:Record<string,string|null|undefined>):BusinessQuery;
export function businessQuerySearch(query:BusinessQuery):string;
export function businessArgs(query:BusinessQuery):Record<string,unknown>;
export interface Kpis{total:string;orders:number;units:string;ticket:string}
export interface StatusRow{status:BusinessStatus;orders:number;total:string}
export interface Indicators{revenue_without_freight:string;cost:string|null;gross_margin:string|null;gross_margin_pct:string|null;lines_without_cost:number|null;taxes:string|null;fees:null;profit:string|null}
export interface ProductRow{product_id:string|null;code:string|null;name:string;units:string;total:string;cost:string|null;margin_pct:string|null;stock:string|null}
export interface ChannelRow{channel:string;orders:number;total:string}
export interface Goal{id:string;name:string;start_on:string;end_on:string;segment:'geral'|'vendedor';seller:string|null;target:string;achieved:string;active:boolean;version:number;updated_at:string}
interface Envelope<P extends BusinessPanel,F> extends NativeDocumentCoverage{scope:'business_dashboard';data_mode:'erp_native';panel:P;role:BusinessRole;as_of:string;business_date:string;cost_visible:boolean;stock_visible:boolean;filters:F}
type Base={statuses:BusinessStatus[];from:string;to:string};
export interface MonthlyPanel extends Envelope<'mensal',Base&{compare_from:string|null;compare_to:string|null}>{kpis:{current:Kpis;previous:Kpis|null};daily:{current:{day:string;orders:number;total:string}[];previous:{day:string;orders:number;total:string}[]};
 statuses:StatusRow[];indicators:Indicators;channels:ChannelRow[];top_skus:(ProductRow&{forecast_days:number|null})[];months:{month:string;total:string}[];annual:Kpis;goals:Goal[]}
export interface DailyPanel extends Envelope<'diario',{statuses:BusinessStatus[];day:string;compare_day:string|null}>{kpis:{current:Kpis&{new_customers:number};previous:(Kpis&{new_customers:number})|null};statuses:StatusRow[];indicators:Indicators;top_skus:ProductRow[]}
export interface OrdersPanel extends Envelope<'pedidos-venda',Base&{state:string|null}>{totals:{orders:number;units:string;total:string;freight:string;ticket:string};statuses:StatusRow[];
 by_state:{state:string|null;orders:number;units:string;total:string;freight_avg:string;ticket:string}[];by_product:ProductRow[];
 by_channel:{channel:string;orders:number;ticket:string;units:string;cost:string|null;total:string;freight:string;unit_value:string;margin_pct:string|null;taxes:string|null;fees:null;contribution_pct:string|null}[]}
export interface SellersPanel extends Envelope<'vendas-vendedor',Base&{seller:string|null}>{sellers:string[];by_seller:{seller:string|null;orders:number;units:string;freight:string;total:string;ticket:string;margin_pct:string|null}[];
 by_product:ProductRow[];evolution:{bucket:string;total:string}[];statuses:StatusRow[]}
export interface ChannelsPanel extends Envelope<'venda-canal',Base>{channels:string[];months:{month:string;values:{channel:string;total:string}[]}[]}
export interface ForecastPanel extends Envelope<'previsao-estoque',Base&{warehouse_id:string|null;reserve:boolean;mode:ForecastMode}>{turnover:{product_id:string;code:string|null;name:string;sold:string;per_day:string;stock:string;composition:'physical'|'virtual'|null;coverage_days:number|null}[];
 by_channel:{channel:string;orders:number;units:string;total:string}[];by_day:{day:string;units:string;total:string}[]}
export interface MarginPanel extends Envelope<'margem-pedido',Base&{tab:'todos'|'lucro'|'prejuizo'}>{indicators:{revenue:string;ticket:string;orders:number;freight_buyer:string;freight_seller:string;freight_paid_pending:number;cost:string;taxes:string|null;fees:null;contribution:string;contribution_pct:string|null;orders_without_cost:number};
 progression:{day:string;revenue:string;contribution:string}[];total:number;orders:{id:string;number:string;day:string;contact:string;channel:string;total:string;freight:string;freight_paid:string|null;revenue:string;cost:string|null;contribution:string|null;contribution_pct:string|null}[]}
export interface CustomerCard{customers:number;orders:number;total:string;units:string;ticket:string;share_pct:string|null}
export interface CustomersPanel extends Envelope<'novos-recorrentes',Base>{cards:{recorrentes:CustomerCard;novos:CustomerCard};chart:{bucket:string;new:string;recurring:string}[];total:number;
 customers:{contact_id:string;name:string;kind:'novo'|'recorrente';channel:string;orders:number;units:string;total:string;margin_pct:string|null;profit:string|null;mobile:string|null}[]}
export interface PortfolioPanel extends Envelope<'atividade-carteira',Base&{brand:string|null;min_days:number|null;keywords:string[]}>{total:number;sum:string;
 customers:{contact_id:string;name:string;orders:number;total:string;first_purchase:string;last_purchase:string;cycle_days:number|null;days_without:number;document:string|null;state:string|null;email:string|null;mobile:string|null}[]}
export interface AbcPanel extends Envelope<'curva-abc',Base&{brand:string|null}>{total:string;counts:{A:number;B:number;C:number};products:{product_id:string|null;code:string|null;name:string;units:string;total:string;share_pct:string|null;cumulative_pct:string|null;curve:'A'|'B'|'C'}[]}
export type BusinessPanelView=MonthlyPanel|DailyPanel|OrdersPanel|SellersPanel|ChannelsPanel|ForecastPanel|MarginPanel|CustomersPanel|PortfolioPanel|AbcPanel;
export function parseBusinessPanel(raw:unknown,query:BusinessQuery):BusinessPanelView;
export const GOAL_TABS:readonly('andamento'|'inativas')[];
export interface GoalsQuery{tab:'andamento'|'inativas'}
export interface GoalsView extends NativeDocumentCoverage{scope:'business_goals';data_mode:'erp_native';role:BusinessRole;tab:'andamento'|'inativas';can_manage:boolean;business_date:string;statuses:BusinessStatus[];total:number;items:Goal[];sellers:string[]}
export interface GoalData{name:string;start_on:string;end_on:string;segment:'geral'|'vendedor';seller:string|null;target:string;active:boolean}
export interface GoalSaveInput{command_id:string;goal_id:string|null;expected_version:number;data:GoalData}
export interface GoalResult{scope:'business_goal_command';data_mode:'erp_native';receipt:{command_id:string;goal_id:string;changed_at:string;from_version:number;to_version:number};goal:Goal|null;replayed:boolean}
export function captureGoalsQuery(input?:{aba?:string}):GoalsQuery;
export function parseGoals(raw:unknown,query:GoalsQuery):GoalsView;
export function captureGoalSave(raw:unknown):GoalSaveInput;
export function parseGoalResult(raw:unknown,options:{commandId:string;input?:GoalSaveInput|null;lookup?:boolean}):GoalResult;
