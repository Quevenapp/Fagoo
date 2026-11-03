/** Importações de Dados (migration 228) under /v1/importacoes, served by the Preferências module (preferences.mjs):
 * - POST <tipo>/lote: one validation (dry_run) or import batch of a spreadsheet; strict canonical rows, at most 50 items;
 * - GET (root) ?situacao=&limit=&offset=: Consultar gestão de ações (the user's jobs; the administrador sees all);
 * - GET <job_id>?erros=1&limit=&offset=: the recorded result of each line of one job.
 * An import batch is a mutation: an answer that does not arrive is "unconfirmed" and the same command must be sent again
 * ("Conferir resultado"). The SQL checks the administrador again and runs each item through the module's own RPC. */
import{IMPORT_BASE,IMPORT_BODY_BYTES,IMPORT_SLUGS,importKindOf,importUuid,captureImportBatch,parseImportBatchResult,captureJobsQuery,parseJobs,captureJobQuery,parseJob,
 ImportContractError}from'../../../packages/erp-domain/src/spreadsheet-import.mjs';
import{contactData,ContactsError}from'./contacts.mjs';
import{PreferencesError,need,readJsonBody,getWithoutBody}from'./preferences-kit.mjs';

const contract=fn=>{try{return fn();}catch(e){if(e instanceof ImportContractError)throw new PreferencesError(e.status,e.code);throw e;}};
// Contatos rows are the contatos lane's API data: its own validator (types, lengths, enums), any refusal is a refused batch.
const validateContact=data=>{try{return contactData(data,false);}catch(e){if(e instanceof ContactsError)throw new ImportContractError(400,'ERP_INVALID_INPUT');throw e;}};
function params(url,allowed){
 const out={};for(const k of url.searchParams.keys()){need(allowed.includes(k)&&url.searchParams.getAll(k).length===1,400,'ERP_INVALID_QUERY');out[k]=url.searchParams.get(k);}
 const num=k=>{if(out[k]===undefined)return undefined;need(/^(0|[1-9][0-9]{0,5})$/.test(out[k]),400,'ERP_INVALID_QUERY');return Number(out[k]);};
 return{out,num};
}
const BATCH=new RegExp(`^(${Object.values(IMPORT_SLUGS).join('|')})/lote$`);
export const importRouter={base:IMPORT_BASE,root:['GET'],
 methods:rest=>BATCH.test(rest)?['POST']:['GET'],
 async parse(request,rest,url){
  if(rest===''){getWithoutBody(request);const p=params(url,['situacao','limit','offset']);
   const q=contract(()=>captureJobsQuery({situacao:p.out.situacao??null,limit:p.num('limit')??25,offset:p.num('offset')??0}));
   return{action:'jobs',rpc:'erp_preferences_import_jobs',mutation:false,query:q,args:{p_status:q.status,p_limit:q.limit,p_offset:q.offset}};}
  const batch=BATCH.exec(rest);
  if(batch){need(!url.search,400,'ERP_INVALID_QUERY');const kind=importKindOf(batch[1]),body=await readJsonBody(request,IMPORT_BODY_BYTES);
   const input=contract(()=>captureImportBatch(kind,body,{validateContact}));
   return{action:'batch',rpc:'erp_preferences_import_batch',mutation:!input.dry_run,input,args:{p_command_id:input.command_id,p_job_id:input.job_id,p_kind:kind,
    p_file_name:input.file_name,p_total_rows:input.total_rows,p_dry_run:input.dry_run,p_rows:input.items}};}
  need(importUuid(rest),404,'ERP_NOT_FOUND');getWithoutBody(request);const p=params(url,['erros','limit','offset']);
  const q=contract(()=>captureJobQuery(rest,{erros:p.out.erros??null,limit:p.num('limit')??100,offset:p.num('offset')??0}));
  return{action:'job',rpc:'erp_preferences_import_job',mutation:false,query:q,args:{p_job_id:q.id,p_errors:q.errors,p_limit:q.limit,p_offset:q.offset}};
 },
 result(route,args,result){
  if(route.action==='batch')return parseImportBatchResult(result,route.input);
  if(route.action==='jobs')return parseJobs(result,route.query);
  return parseJob(result,route.query);
 },
 contractError:e=>e instanceof ImportContractError};
