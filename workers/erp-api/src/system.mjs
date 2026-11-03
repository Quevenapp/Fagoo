/** Sistema routes of wave B under /v1/sistema (migrations 148-151), one router with closed sub-routes:
 * - GET situacoes?tipo=, POST situacoes, POST transicoes and POST transicoes/exclusao (Gerenciador de transições) — 148;
 * - GET relatorios, POST relatorios/execucao (a read), POST relatorios and POST relatorios/exclusao (Relatórios customizados) — 149;
 * - GET etiquetas, POST etiquetas, POST etiquetas/exclusao and GET etiquetas/registros?tipo=&busca= (Etiquetas customizadas) — 149;
 *   GET etiquetas/nota?id= (the product labels of one note, "Imprimir etiquetas" of the notas list) — 230;
 * (The tags routes of 148 were retired with migration 185: the product tag screens of migration 119 are the only ones.)
 * - GET perfil (Meu perfil), GET armazenamento (Espaço e armazenamento) — 151; GET permissoes (Permissões do usuário) — 229;
 * - GET notificacoes?aba=nao_lidas|todas and POST notificacoes/lidas (sino) — 151;
 * - GET and POST empresa-dados (Dados da empresa do Origin além da identidade fiscal) — 151;
 * - GET usuarios/:id/seguranca (Dispositivos utilizados, Histórico do segundo fator) — 151;
 * - GET validade (Página inicial: Produtos próximos da validade) — 187;
 * - GET and POST graficos-inicio, GET top-produtos?periodo=&de=&ate= (gráficos da página inicial) and GET and POST
 *   empresa-socios (Dados do sócio(s)) — 189.
 * The SQL functions check every role again; responses are parsed by the shared contracts. */
import{SYSTEM_BASE,SYSTEM_BODY_BYTES,parseProfile,parseStorage,captureNotificationsQuery,parseNotifications,captureNotificationsRead,parseNotificationsRead,parseCompanyExtra,
 captureCompanyExtraSave,parseCompanyExtraResult,parseUserSecurity,parseExpiring,parseHomeCharts,captureHomeChartsSave,parseHomeChartsResult,
 captureTopProductsQuery,parseTopProducts,parseCompanyPartners,captureCompanyPartnersSave,parseCompanyPartnersResult,systemUuid,SystemContractError}from'../../../packages/erp-domain/src/system-profile.mjs';
import{captureSituationsQuery,parseSituationsPage,captureSituationSave,captureTransitionSave,captureTransitionsDelete,parseSituationsResult,FrameworkContractError}from'../../../packages/erp-domain/src/system-frameworks.mjs';
import{parseReports,captureReportRun,parseReportRows,captureReportSave,captureFrameworkDelete,parseFrameworkResult,parseLabels,captureLabelSave,captureLabelRecordsQuery,parseLabelRecords,
 captureLabelInvoiceQuery,parseLabelInvoiceProducts,ReportsContractError}from'../../../packages/erp-domain/src/reports-labels.mjs';
import{parseMyPermissions,PermissionsContractError}from'../../../packages/erp-domain/src/user-permissions.mjs';
import{PreferencesError,need,readJsonBody,getWithoutBody}from'./preferences-kit.mjs';

const known=e=>e instanceof SystemContractError||e instanceof FrameworkContractError||e instanceof ReportsContractError||e instanceof PermissionsContractError;
const contract=fn=>{try{return fn();}catch(e){if(known(e))throw new PreferencesError(e.status,e.code);throw e;}};
function params(url){const out={};for(const k of url.searchParams.keys()){need(url.searchParams.getAll(k).length===1&&/^[a-z_]{1,20}$/.test(k),400,'ERP_INVALID_QUERY');out[k]=url.searchParams.get(k);}return out;}
const BOTH=new Set(['empresa-dados','situacoes','relatorios','etiquetas','graficos-inicio','empresa-socios']),
 POSTS=new Set(['notificacoes/lidas','transicoes','transicoes/exclusao','relatorios/execucao','relatorios/exclusao','etiquetas/exclusao']);
export const systemRouter={base:SYSTEM_BASE,
 methods:rest=>BOTH.has(rest)?['GET','POST']:POSTS.has(rest)?['POST']:['GET'],
 async parse(request,rest,url){
  if(request.method==='POST'){
   need(!url.search,400,'ERP_INVALID_QUERY');const body=await readJsonBody(request,SYSTEM_BODY_BYTES);
   if(rest==='graficos-inicio'){const sent=contract(()=>captureHomeChartsSave(body));return{action:'charts-save',rpc:'erp_home_charts_save',mutation:true,input:sent,args:{p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_charts:sent.charts}};}
   if(rest==='empresa-socios'){const sent=contract(()=>captureCompanyPartnersSave(body));return{action:'partners-save',rpc:'erp_company_partners_save',mutation:true,input:sent,args:{p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_partners:sent.partners}};}
   if(rest==='notificacoes/lidas'){const sent=contract(()=>captureNotificationsRead(body));return{action:'notifications-read',rpc:'erp_home_notifications_read',mutation:true,input:sent,args:{p_command_id:sent.command_id,p_ids:sent.ids}};}
   if(rest==='situacoes'){const sent=contract(()=>captureSituationSave(body));return{action:'situation-save',rpc:'erp_preferences_situation_save',mutation:true,input:sent,
    args:{p_command_id:sent.command_id,p_kind:sent.kind,p_situation:sent.id,p_expected_version:sent.expected_version,p_data:sent.data}};}
   if(rest==='transicoes'){const sent=contract(()=>captureTransitionSave(body));return{action:'transition-save',rpc:'erp_preferences_transition_save',mutation:true,input:sent,
    args:{p_command_id:sent.command_id,p_kind:sent.kind,p_from:sent.from,p_to:sent.to,p_expected_version:sent.expected_version,p_data:sent.data}};}
   if(rest==='transicoes/exclusao'){const sent=contract(()=>captureTransitionsDelete(body));return{action:'transitions-delete',rpc:'erp_preferences_transitions_delete',mutation:true,input:sent,
    args:{p_command_id:sent.command_id,p_kind:sent.kind,p_items:sent.items}};}
   if(rest==='relatorios/execucao'){const q=contract(()=>captureReportRun(body));return{action:'report-run',rpc:'erp_preferences_report_run',mutation:false,query:q,
    args:{p_base:q.base,p_columns:q.columns,p_filters:q.filters,p_view_limit:q.view_limit,p_offset:q.offset,p_page:q.page}};}
   if(rest==='relatorios'){const sent=contract(()=>captureReportSave(body));return{action:'report-save',rpc:'erp_preferences_report_save',mutation:true,input:sent,
    args:{p_command_id:sent.command_id,p_report:sent.id,p_expected_version:sent.expected_version,p_data:sent.data}};}
   if(rest==='etiquetas'){const sent=contract(()=>captureLabelSave(body));return{action:'label-save',rpc:'erp_preferences_label_save',mutation:true,input:sent,
    args:{p_command_id:sent.command_id,p_label:sent.id,p_expected_version:sent.expected_version,p_data:sent.data}};}
   if(rest==='relatorios/exclusao'||rest==='etiquetas/exclusao'){const sent=contract(()=>captureFrameworkDelete(body)),reports=rest==='relatorios/exclusao';
    return{action:reports?'reports-delete':'labels-delete',rpc:'erp_preferences_framework_delete',mutation:true,input:sent,args:{p_command_id:sent.command_id,p_target:reports?'reports':'labels',p_items:sent.items}};}
   const sent=contract(()=>captureCompanyExtraSave(body));return{action:'extra-save',rpc:'erp_company_extra_save',mutation:true,input:sent,args:{p_command_id:sent.command_id,p_expected_version:sent.expected_version,p_data:sent.data}};
  }
  getWithoutBody(request);
  if(rest==='notificacoes'){const q=contract(()=>captureNotificationsQuery(params(url)));return{action:'notifications',rpc:'erp_home_notifications',mutation:false,query:q,args:{p_tab:q.tab}};}
  if(rest==='situacoes'){const q=contract(()=>captureSituationsQuery(params(url)));return{action:'situations',rpc:'erp_preferences_situations',mutation:false,query:q,args:{p_kind:q.kind}};}
  if(rest==='top-produtos'){const q=contract(()=>captureTopProductsQuery(params(url)));return{action:'top-products',rpc:'erp_home_top_products',mutation:false,query:q,args:{p_period:q.key,p_from:q.from,p_to:q.to}};}
  if(rest==='etiquetas/nota'){const q=contract(()=>captureLabelInvoiceQuery(params(url)));return{action:'label-invoice',rpc:'erp_preferences_label_invoice_products',mutation:false,query:q,args:{p_invoice_id:q.id}};}
  if(rest==='etiquetas/registros'){const q=contract(()=>captureLabelRecordsQuery(params(url)));return{action:'label-records',rpc:'erp_preferences_label_records',mutation:false,query:q,args:{p_type:q.type,p_query:q.q}};}
  need(!url.search,400,'ERP_INVALID_QUERY');
  if(rest==='relatorios')return{action:'reports',rpc:'erp_preferences_reports',mutation:false,args:{}};
  if(rest==='etiquetas')return{action:'labels',rpc:'erp_preferences_labels',mutation:false,args:{}};
  if(rest==='perfil')return{action:'profile',rpc:'erp_access_profile_me',mutation:false,args:{}};
  // 229: Permissões and the access window of the signed-in user.
  if(rest==='permissoes')return{action:'permissions',rpc:'erp_access_permissions_me',mutation:false,args:{}};
  if(rest==='armazenamento')return{action:'storage',rpc:'erp_access_storage',mutation:false,args:{}};
  if(rest==='empresa-dados')return{action:'extra',rpc:'erp_company_extra_get',mutation:false,args:{}};
  if(rest==='validade')return{action:'expiring',rpc:'erp_home_expiring',mutation:false,args:{}};
  if(rest==='graficos-inicio')return{action:'charts',rpc:'erp_home_charts_get',mutation:false,args:{}};
  if(rest==='empresa-socios')return{action:'partners',rpc:'erp_company_partners_get',mutation:false,args:{}};
  const security=/^usuarios\/([a-f0-9-]{36})\/seguranca$/.exec(rest);
  if(security&&systemUuid(security[1]))return{action:'security',rpc:'erp_access_user_security',mutation:false,target:security[1],args:{p_target:security[1]}};
  return need(false,404,'ERP_NOT_FOUND');
 },
 result(route,args,result){
  switch(route.action){
   case'profile':return parseProfile(result);
   case'permissions':return parseMyPermissions(result);
   case'storage':return parseStorage(result);
   case'notifications':return parseNotifications(result,route.query);
   case'notifications-read':return parseNotificationsRead(result,route.input);
   case'extra':return parseCompanyExtra(result);
   case'expiring':return parseExpiring(result);
   case'charts':return parseHomeCharts(result);
   case'charts-save':return parseHomeChartsResult(result,route.input);
   case'top-products':return parseTopProducts(result,route.query);
   case'partners':return parseCompanyPartners(result);
   case'partners-save':return parseCompanyPartnersResult(result,route.input);
   case'extra-save':return parseCompanyExtraResult(result,route.input);
   case'security':return parseUserSecurity(result,route.target);
   case'situations':return parseSituationsPage(result,route.query);
   case'situation-save':return parseSituationsResult(result,route.input,'situation');
   case'transition-save':return parseSituationsResult(result,route.input,'transition');
   case'transitions-delete':return parseSituationsResult(result,route.input,'delete');
   case'reports':return parseReports(result);
   case'report-run':return parseReportRows(result,route.query);
   case'labels':return parseLabels(result);
   case'label-records':return parseLabelRecords(result,route.query);
   case'label-invoice':return parseLabelInvoiceProducts(result,route.query);
   case'report-save':case'reports-delete':case'label-save':case'labels-delete':return parseFrameworkResult(result,route.input,route.action);
  }
  return need(false,404,'ERP_NOT_FOUND');
 },
 contractError:known};
