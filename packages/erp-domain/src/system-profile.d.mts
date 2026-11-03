import type { NativeDocumentCoverage } from './document-mirror.mjs';
export type SystemRole='admin'|'consulta'|'vendas'|'financeiro'|'estoque'|'fiscal';
export type NotificationType='contas_pagar_atrasadas'|'contas_receber_atrasadas'|'estoque_abaixo_minimo'|'estoque_maximo'|'estoque_zerado'|'pagamento_efetuado'|'pagamento_recebido'|'proximo_contato'|'cliente_visitado'|'validade'|'certificado_a1'|'lote_vencimento';
export type StorageGroup='anexos'|'fiscal'|'cobranca'|'backup'|'certificado'|'outros';
export const SYSTEM_BASE:'/v1/sistema';
export const SYSTEM_BODY_BYTES:number;
export const NOTIFICATION_TYPES:readonly NotificationType[];
export const NOTIFICATION_LABELS:Readonly<Record<NotificationType,string>>;
export const NOTIFICATION_ROLES:Readonly<Record<NotificationType,readonly SystemRole[]>>;
export const STORAGE_GROUPS:readonly StorageGroup[];
export const ROLES:readonly SystemRole[];
export class SystemContractError extends Error{status:number;code:string;constructor(status:number,code:string);}
export function systemUuid(value:unknown):value is string;
export interface Profile{scope:'access_profile';data_mode:'erp_native';user_id:string;role:SystemRole;name:string|null;email:string|null;company:{legal_name:string|null;trade_name:string|null}|null}
export function parseProfile(raw:unknown):Profile;
export interface StorageUsage{scope:'storage_usage';data_mode:'erp_native';total_bytes:string;objects:number;limit_bytes:string|null;groups:{group:StorageGroup;bytes:string;objects:number}[]|null;as_of:string}
export function parseStorage(raw:unknown):StorageUsage;
export const NOTIFICATION_TABS:readonly('nao_lidas'|'todas')[];
export interface NotificationsQuery{tab:'nao_lidas'|'todas'}
export interface NotificationItem{id:string;type:NotificationType;day:string;quantity:number;amount:string|null;created_at:string;read:boolean}
export interface NotificationsView{scope:'notifications';data_mode:'erp_native';tab:'nao_lidas'|'todas';role:SystemRole;business_date:string;unread:number;items:NotificationItem[]}
export interface NotificationsReadInput{command_id:string;ids:readonly string[]|null}
export interface NotificationsReadResult{scope:'notifications_command';data_mode:'erp_native';receipt:{command_id:string;all:boolean;marked:number;changed_at:string};view:NotificationsView;replayed:boolean}
export function captureNotificationsQuery(input?:{aba?:string}):NotificationsQuery;
export const EXPIRY_LIMIT:number;
export interface ExpiringProduct{product_id:string;code:string|null;name:string;expiry_date:string;expired:boolean}
export interface ExpiringView{scope:'product_expiry';data_mode:'erp_native';business_date:string;days:number;total:number;items:ExpiringProduct[]}
export function parseExpiring(raw:unknown):ExpiringView;
export function parseNotifications(raw:unknown,query:NotificationsQuery):NotificationsView;
export function captureNotificationsRead(raw:unknown):NotificationsReadInput;
export function parseNotificationsRead(raw:unknown,input:NotificationsReadInput):NotificationsReadResult;
export interface CompanyExtraData{person_type:'juridica'|'fisica';ie_exempt:boolean;municipal_registration:string|null;suframa:string|null;cnae:string|null;company_size:'mei'|'micro'|'pequena'|'media'|'grande'|null;
 segments:('comercio'|'ecommerce'|'industria'|'servicos')[];revenue:'ate_60k'|'de_60k_360k'|'acima_360k'|null;employees:'ate_5'|'de_5_10'|'mais_10'|null;contacts:string|null;mobile:string|null;billing_email:string|null;site:string|null;
 substitute_ies:{uf:string;ie:string}[]}
export interface CompanyExtraRecord{version:number;data:CompanyExtraData;updated_at:string}
export interface CompanyExtraView{scope:'company_extra';data_mode:'erp_native';can_manage:boolean;record:CompanyExtraRecord|null}
export interface CompanyExtraSaveInput{command_id:string;expected_version:number;data:CompanyExtraData}
export interface CompanyExtraResult{scope:'company_extra_command';data_mode:'erp_native';receipt:{command_id:string;from_version:number;to_version:number;changed_at:string};record:CompanyExtraRecord;replayed:boolean}
export const PERSON_TYPES:readonly(readonly[string,string])[];
export const COMPANY_SIZES:readonly(readonly[string,string])[];
export const SEGMENTS:readonly(readonly[string,string])[];
export const REVENUES:readonly(readonly[string,string])[];
export const EMPLOYEES:readonly(readonly[string,string])[];
export const SUBSTITUTE_UFS:readonly string[];
export function normalizeCompanyExtra(raw:unknown,status?:number,code?:string):CompanyExtraData;
export function parseCompanyExtra(raw:unknown):CompanyExtraView;
export function captureCompanyExtraSave(raw:unknown):CompanyExtraSaveInput;
export function parseCompanyExtraResult(raw:unknown,input:CompanyExtraSaveInput):CompanyExtraResult;
export interface UserSecurity{scope:'access_user_security';data_mode:'erp_native';user_id:string;mfa:boolean;sessions:{last_access:string|null;created_at:string|null;ip:string|null;device:string|null;aal:string|null}[];
 factors:{type:string;status:string;created_at:string|null}[];challenges:{created_at:string|null;ip:string|null;type:string|null;valid:boolean}[]}
export function parseUserSecurity(raw:unknown,target:string):UserSecurity;
export type HomeChart='resumo'|'ticket_medio'|'valor_faturado'|'quantidade_pedidos'|'top_skus';
export const HOME_CHARTS:readonly HomeChart[];
export const HOME_CHART_LABELS:Readonly<Record<HomeChart,string>>;
export const TOP_PRODUCT_ROLES:readonly SystemRole[];
export interface HomeChartsView{scope:'home_charts';data_mode:'erp_native';role:SystemRole;version:number;customized:boolean;charts:HomeChart[];available:HomeChart[]}
export interface HomeChartsSaveInput{command_id:string;expected_version:number;charts:readonly HomeChart[]}
export interface HomeChartsResult extends HomeChartsView{receipt:{command_id:string;version:number;charts:HomeChart[];changed_at:string};replayed:boolean}
export function parseHomeCharts(raw:unknown):HomeChartsView;
export function captureHomeChartsSave(raw:unknown):HomeChartsSaveInput;
export function parseHomeChartsResult(raw:unknown,input:HomeChartsSaveInput):HomeChartsResult;
export const HOME_PERIOD_KEYS:readonly string[];
export interface TopProductsQuery{key:string;from:string|null;to:string|null}
export interface TopProduct{product_id:string;code:string|null;name:string;units:string;total_cents:string}
export interface TopProductsView extends NativeDocumentCoverage{scope:'home_top_products';data_mode:'erp_native';key:string;from:string;to:string;items:TopProduct[]}
export function captureTopProductsQuery(input?:{periodo?:string;de?:string;ate?:string}):TopProductsQuery;
export function parseTopProducts(raw:unknown,query:TopProductsQuery):TopProductsView;
export const PARTNER_LIMIT:number;
export interface CompanyPartner{name:string;cpf:string;share:string|null;role:string|null;email:string|null;phone:string|null}
export interface CompanyPartnersRecord{version:number;partners:CompanyPartner[];updated_at:string}
export interface CompanyPartnersView{scope:'company_partners';data_mode:'erp_native';record:CompanyPartnersRecord|null}
export interface CompanyPartnersSaveInput{command_id:string;expected_version:number;partners:unknown}
export interface CompanyPartnersResult{scope:'company_partners_command';data_mode:'erp_native';receipt:{command_id:string;from_version:number;to_version:number;changed_at:string};record:CompanyPartnersRecord;replayed:boolean}
export function normalizeCompanyPartners(raw:unknown,status?:number,code?:string):CompanyPartner[];
export function parseCompanyPartners(raw:unknown):CompanyPartnersView;
export function captureCompanyPartnersSave(raw:unknown):CompanyPartnersSaveInput;
export function parseCompanyPartnersResult(raw:unknown,input:CompanyPartnersSaveInput):CompanyPartnersResult;
