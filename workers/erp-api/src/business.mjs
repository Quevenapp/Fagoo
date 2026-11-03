/** Meu Negócio (migration 150): /v1/meu-negocio/<painel> (GET, read-only dashboards) and /v1/meu-negocio/metas (GET list,
 * POST one audited command) plus /v1/meu-negocio/metas/comandos/:id ("Conferir resultado"). Strict query parameters,
 * closed DTOs from packages/erp-domain; the SQL functions check the role again. */
import{BUSINESS_BASE,BUSINESS_BODY_BYTES,BUSINESS_PANELS,BUSINESS_RPC,captureBusinessQuery,businessArgs,parseBusinessPanel,captureGoalsQuery,parseGoals,captureGoalSave,parseGoalResult,
 BusinessContractError}from'../../../packages/erp-domain/src/business-dashboards.mjs';
import{PreferencesError,need,uuid,readJsonBody,getWithoutBody}from'./preferences-kit.mjs';
const contract=fn=>{try{return fn();}catch(e){if(e instanceof BusinessContractError)throw new PreferencesError(e.status,e.code);throw e;}};
function params(url){
 const out={};for(const k of url.searchParams.keys()){need(url.searchParams.getAll(k).length===1&&/^[a-z_]{1,20}$/.test(k),400,'ERP_INVALID_QUERY');out[k]=url.searchParams.get(k);}
 return out;
}
export const businessRouter={base:BUSINESS_BASE,
 methods:rest=>rest==='metas'?['GET','POST']:['GET'],
 async parse(request,rest,url){
  if(rest.startsWith('metas/comandos/')){const id=rest.slice(15);need(uuid(id)&&!url.search,404,'ERP_NOT_FOUND');getWithoutBody(request);return{action:'goal-command',rpc:'erp_home_business_panel',mutation:false,args:{p_panel:'metas_command',p_args:{p_command_id:id}}};}
  if(rest==='metas'){
   if(request.method==='GET'){getWithoutBody(request);const q=contract(()=>captureGoalsQuery(params(url)));return{action:'goals',rpc:'erp_home_business_panel',mutation:false,query:q,args:{p_panel:'metas',p_args:{p_tab:q.tab}}};}
   need(!url.search,400,'ERP_INVALID_QUERY');const body=await readJsonBody(request,BUSINESS_BODY_BYTES),sent=contract(()=>captureGoalSave(body));
   return{action:'goal-save',rpc:'erp_home_business_panel',mutation:true,input:sent,args:{p_panel:'metas_save',p_args:{p_command_id:sent.command_id,p_goal_id:sent.goal_id,p_expected_version:sent.expected_version,p_data:{...sent.data}}}};
  }
  need(BUSINESS_PANELS.includes(rest),404,'ERP_NOT_FOUND');getWithoutBody(request);
  const q=contract(()=>captureBusinessQuery(rest,params(url)));
  // 229: every panel goes through erp_home_business_panel, which checks the Meu Negócio › Dashboard permissions first.
  return{action:'panel',rpc:'erp_home_business_panel',mutation:false,query:q,args:{p_panel:rest,p_args:businessArgs(q)}};
 },
 result(route,args,result){
  if(route.action==='panel')return parseBusinessPanel(result,route.query);
  if(route.action==='goals')return parseGoals(result,route.query);
  if(route.action==='goal-save')return parseGoalResult(result,{commandId:args.p_args.p_command_id,input:route.input});
  return parseGoalResult(result,{commandId:args.p_args.p_command_id,lookup:true});
 },
 contractError:e=>e instanceof BusinessContractError};
