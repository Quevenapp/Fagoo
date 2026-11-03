import type {AccessState,NativeRequestOptions} from './real-access';
import {SYSTEM_BASE,NOTIFICATION_LABELS,parseProfile,parseStorage,parseNotifications,parseNotificationsRead,captureNotificationsQuery,captureNotificationsRead,parseCompanyExtra,captureCompanyExtraSave,
 parseCompanyExtraResult,normalizeCompanyExtra,parseUserSecurity,parseExpiring,EXPIRY_LIMIT,HOME_CHARTS,HOME_CHART_LABELS,TOP_PRODUCT_ROLES,parseHomeCharts,captureHomeChartsSave,parseHomeChartsResult,
 captureTopProductsQuery,parseTopProducts,PARTNER_LIMIT,normalizeCompanyPartners,parseCompanyPartners,captureCompanyPartnersSave,parseCompanyPartnersResult,PERSON_TYPES,COMPANY_SIZES,SEGMENTS,REVENUES,EMPLOYEES,SUBSTITUTE_UFS,
 type Profile,type StorageUsage,type NotificationItem,type NotificationsView,type NotificationsReadInput,type NotificationType,type CompanyExtraData,type CompanyExtraView,type CompanyExtraSaveInput,
 type UserSecurity,type ExpiringView,type ExpiringProduct,type HomeChart,type HomeChartsView,type HomeChartsSaveInput,type HomeChartsResult,type TopProductsQuery,type TopProductsView,
 type CompanyPartner,type CompanyPartnersView,type CompanyPartnersSaveInput,type CompanyPartnersResult} from '../../../../packages/erp-domain/src/system-profile.mjs';
export {SYSTEM_BASE,NOTIFICATION_LABELS,parseProfile,parseStorage,parseNotifications,parseNotificationsRead,captureNotificationsQuery,captureNotificationsRead,parseCompanyExtra,captureCompanyExtraSave,
 parseCompanyExtraResult,normalizeCompanyExtra,parseUserSecurity,parseExpiring,EXPIRY_LIMIT,HOME_CHARTS,HOME_CHART_LABELS,TOP_PRODUCT_ROLES,parseHomeCharts,captureHomeChartsSave,parseHomeChartsResult,
 captureTopProductsQuery,parseTopProducts,PARTNER_LIMIT,normalizeCompanyPartners,parseCompanyPartners,captureCompanyPartnersSave,parseCompanyPartnersResult,PERSON_TYPES,COMPANY_SIZES,SEGMENTS,REVENUES,EMPLOYEES,SUBSTITUTE_UFS};
export type {Profile,StorageUsage,NotificationItem,NotificationsView,NotificationsReadInput,NotificationType,CompanyExtraData,CompanyExtraView,CompanyExtraSaveInput,UserSecurity,ExpiringView,ExpiringProduct,HomeChart,HomeChartsView,HomeChartsSaveInput,HomeChartsResult,TopProductsQuery,TopProductsView,
 CompanyPartner,CompanyPartnersView,CompanyPartnersSaveInput,CompanyPartnersResult};
export interface SystemController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;system:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}
export const EXPIRING_PATH=`${SYSTEM_BASE}/validade`,CHARTS_PATH=`${SYSTEM_BASE}/graficos-inicio`,PARTNERS_PATH=`${SYSTEM_BASE}/empresa-socios`;
export const topProductsPath=(key:string,from:string|null,to:string|null)=>`${SYSTEM_BASE}/top-produtos?${new URLSearchParams({periodo:key,...(key==='customizado'&&from&&to?{de:from,ate:to}:{})})}`;
export const PROFILE_PATH=`${SYSTEM_BASE}/perfil`,STORAGE_PATH=`${SYSTEM_BASE}/armazenamento`,EXTRA_PATH=`${SYSTEM_BASE}/empresa-dados`,NOTIFICATIONS_READ_PATH=`${SYSTEM_BASE}/notificacoes/lidas`;
export const notificationsPath=(tab:'nao_lidas'|'todas')=>`${SYSTEM_BASE}/notificacoes?aba=${tab}`;
export const userSecurityPath=(id:string)=>`${SYSTEM_BASE}/usuarios/${id}/seguranca`;
export const CENTRAL_NOTIFICATIONS='/preferencias/sistema/central-notificacoes';
/** 229: Permissões and the access window of the signed-in user. */
export const PERMISSIONS_PATH=`${SYSTEM_BASE}/permissoes`;
const MONTHS=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
/** Origin "20 de outubro - 09:15", São Paulo time. */
export function notificationDate(value:string){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
 return `${Number(parts.day)} de ${MONTHS[Number(parts.month)-1]} - ${parts.hour==='24'?'00':parts.hour}:${parts.minute}`;
}
const money=(value:string)=>{const [whole,cents='00']=value.split('.');return `R$ ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,'.')},${cents.padEnd(2,'0').slice(0,2)}`;};
const plural=(n:number,one:string,many:string)=>`${n.toLocaleString('pt-BR')} ${n===1?one:many}`;
/** Title, text and destination of one daily notification. */
export function notificationContent(n:NotificationItem){
 const amount=n.amount===null?'':` — ${money(n.amount)}`;
 switch(n.type){
  case'contas_receber_atrasadas':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'conta a receber vencida e em aberto','contas a receber vencidas e em aberto')}${amount}.`,to:'/financeiro-empresa?area=receivable'};
  case'contas_pagar_atrasadas':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'conta a pagar vencida e em aberto','contas a pagar vencidas e em aberto')}${amount}.`,to:'/financeiro-empresa?area=payable'};
  case'pagamento_recebido':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'baixa de conta a receber registrada hoje','baixas de contas a receber registradas hoje')}${amount}.`,to:'/financeiro-empresa?area=receivable'};
  case'pagamento_efetuado':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'baixa de conta a pagar registrada hoje','baixas de contas a pagar registradas hoje')}${amount}.`,to:'/financeiro-empresa?area=payable'};
  case'estoque_abaixo_minimo':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'produto com estoque disponível abaixo do mínimo','produtos com estoque disponível abaixo do mínimo')}.`,to:'/painel-produtos-empresa'};
  case'estoque_maximo':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'produto chegou ao estoque máximo','produtos chegaram ao estoque máximo')}.`,to:'/painel-produtos-empresa'};
  case'estoque_zerado':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'produto com estoque zerado ou negativo','produtos com estoque zerado ou negativo')}.`,to:'/painel-produtos-empresa'};
  case'proximo_contato':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'proposta comercial com próximo contato hoje','propostas comerciais com próximo contato hoje')}.`,to:'/documentos-empresa?tipo=sales_proposals'};
  case'cliente_visitado':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'contato com próxima visita hoje','contatos com próxima visita hoje')}.`,to:'/cadastros-reais?cadastro=contacts'};
  case'validade':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'produto com data de validade próxima','produtos com data de validade próxima')}.`,to:'/acesso'};
  case'certificado_a1':return{title:NOTIFICATION_LABELS[n.type],text:'O certificado A1 em custódia vence em até 30 dias ou já venceu. Providencie a renovação.',to:'/certificado-a1'};
  // 283: the lots with stock that expire within the days of Preferências › Cadastros › Controle de lotes (aba Lotes e validades of each product).
  case'lote_vencimento':return{title:NOTIFICATION_LABELS[n.type],text:`${plural(n.quantity,'lote com saldo vence','lotes com saldo vencem')} dentro do prazo de aviso de validade.`,to:'/estoque-empresa'};
 }
 return{title:'Notificação',text:'',to:'/acesso'};
}
/** Sizes in the Origin style (decimal comma); exact bytes stay in the title. */
export function bytesText(value:string){const n=BigInt(value);if(n<1024n)return `${n} B`;const units=[['KB',1024n],['MB',1048576n],['GB',1073741824n]] as const;
 for(let i=units.length-1;i>=0;i--){const [unit,size]=units[i]!;if(n>=size){const tenths=(n*10n)/size;return `${tenths/10n},${tenths%10n} ${unit}`;}}return `${n} B`;}
/** Armazenamento of the top bar and the home card (Origin "<usado>/<limite>", orange above 90%); no limit means usage only. */
export function storageSummary(value:Pick<StorageUsage,'total_bytes'|'limit_bytes'>){
 const used=bytesText(value.total_bytes);if(value.limit_bytes===null)return{label:used,percent:null,warn:false};
 const tenths=Number(BigInt(value.total_bytes)*1000n/BigInt(value.limit_bytes)),percent=Math.min(tenths,1000)/10;
 return{label:`${used}/${bytesText(value.limit_bytes)}`,percent,warn:tenths>900};
}
export const STORAGE_LABELS:Record<string,string>={anexos:'Anexos dos documentos',fiscal:'XMLs e documentos fiscais',cobranca:'Arquivos de cobrança',backup:'Backup do Origin',certificado:'Certificado digital',outros:'Outros arquivos'};
export const initials=(name:string)=>name.split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]!.toUpperCase()).join('')||'B';
