/** Sistema > Registro de atividades (and Consulta de exclusões) and Gerenciador de arquivos (migration 118; 263: every origin). Read-only,
 * administrador only (checked again by each RPC), closed query parameters and responses. */
import{ACTIVITY_BASE,FILES_BASE,captureActivityQuery,captureFilesQuery,parseActivity,parseFiles,captureActivityDetailQuery,parseActivityDetail,ActivityContractError}from'../../../packages/erp-domain/src/activity.mjs';
import{PreferencesError,need,getWithoutBody}from'./preferences-kit.mjs';
const contract=fn=>{try{return fn();}catch(e){if(e instanceof ActivityContractError)throw new PreferencesError(e.status,e.code);throw e;}};
function params(url,allowed){
 for(const k of url.searchParams.keys())need(allowed.includes(k)&&url.searchParams.getAll(k).length===1,400,'ERP_INVALID_QUERY');
 const get=k=>url.searchParams.get(k),num=(k,d)=>{const v=get(k);if(v===null)return d;need(/^(0|[1-9][0-9]{0,5})$/.test(v),400,'ERP_INVALID_QUERY');return Number(v);};
 return{get,num};
}
export const activityRouter={base:ACTIVITY_BASE,root:['GET'],methods:()=>['GET'],
 async parse(request,rest,url){need(rest===''||rest==='detalhe',404,'ERP_NOT_FOUND');getWithoutBody(request);
  // 148: GET detalhe?origem=&id= (antes e depois de um registro).
  if(rest==='detalhe'){const p=params(url,['origem','id']);const q=contract(()=>captureActivityDetailQuery({source:p.get('origem'),id:p.get('id')}));
   return{action:'activity-detail',rpc:'erp_activity_detail',mutation:false,query:q,args:{p_source:q.source,p_entry_id:q.id}};}
  const p=params(url,['de','ate','modulo','operacao','usuario','q','limit','offset']);
  const q=contract(()=>captureActivityQuery({from:p.get('de'),to:p.get('ate'),module:p.get('modulo'),operation:p.get('operacao'),actor:p.get('usuario'),q:p.get('q'),limit:p.num('limit',100),offset:p.num('offset',0)}));
  return{action:'activity',rpc:'erp_activity_list',mutation:false,query:q,args:{p_from:q.from,p_to:q.to,p_module:q.module,p_operation:q.operation,p_actor:q.actor,p_query:q.q,p_limit:q.limit,p_offset:q.offset}};},
 result:(route,args,result)=>route.action==='activity-detail'?parseActivityDetail(result,route.query):parseActivity(result,route.query),
 contractError:e=>e instanceof ActivityContractError};
export const filesRouter={base:FILES_BASE,root:['GET'],methods:()=>['GET'],
 async parse(request,rest,url){need(rest==='',404,'ERP_NOT_FOUND');getWithoutBody(request);
  const p=params(url,['q','de','ate','ordem','origem','limit','offset']);
  const q=contract(()=>captureFilesQuery({q:p.get('q'),from:p.get('de'),to:p.get('ate'),order:p.get('ordem')??'data',origin:p.get('origem'),limit:p.num('limit',100),offset:p.num('offset',0)}));
  // 263: every origin of the company (anexos dos documentos, contatos, contas e lançamentos, imagens dos produtos e o logo).
  return{action:'files',rpc:'erp_files_list_v2',mutation:false,query:q,args:{p_query:q.q,p_from:q.from,p_to:q.to,p_order:q.order,p_origin:q.origin,p_limit:q.limit,p_offset:q.offset}};},
 result:(route,args,result)=>parseFiles(result,route.query),
 contractError:e=>e instanceof ActivityContractError};
