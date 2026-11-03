/** Admin-only preparation reports. GET only; no raw source payload or import action. */
const ENTITIES=['contacts','products','receivables','payables','stock_snapshot'];
const COUNT_ENTITIES=[...ENTITIES,'sales_orders','purchase_orders','cash_movements'];
const HASH=/^[a-f0-9]{64}$/;const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CHECKS=['ABSENT_FROM_SELECTED_BACKUP','NOT_OBSERVED_IN_API','MISSING_SOURCE_ID','NO_NATIVE_CATALOG_LINK','CSV_AMOUNT_UNAVAILABLE','CSV_PAID_UNAVAILABLE','CSV_FINANCIAL_ACCOUNT_MISSING','CSV_HAS_NO_CONTACT_ID','CSV_QUANTITY_UNAVAILABLE','WAREHOUSE_MAPPING_NOT_DEFINED','STOCK_SEMANTICS_REQUIRE_REVIEW','API_AMOUNT_UNAVAILABLE','API_BALANCE_UNAVAILABLE','API_STATUS_UNRECOGNIZED','SOURCE_OPEN_OR_PARTIAL_REQUIRES_REVIEW','NO_NATIVE_CONTACT_LINK','DUPLICATE_BACKUP_SOURCE_ID','STOCK_PRODUCT_MULTIPLE_ROWS'];
const LIMITATIONS=['CUTOFF_NOT_DEFINED','API_COVERAGE_NOT_CERTIFIED','BACKUP_AND_API_DIFFERENT_TIMES','NO_BANK_BALANCE_RECONSTRUCTION','WAREHOUSE_MAPPING_NOT_DEFINED','NO_OPERATIONAL_EFFECTS'];
export class CutoverError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CutoverError(400,'ERP_INVALID_QUERY');};const upstream=()=>{throw new CutoverError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const str=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const nullable=(v,test)=>v===null||test(v);const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000000;
const timestamp=v=>str(v,100)&&Number.isFinite(Date.parse(v));
const decimal=(v,scale)=>typeof v==='string'&&new RegExp(`^-?[0-9]{1,14}\\.[0-9]{${scale}}$`).test(v);
const take=(v,fields)=>Object.fromEntries(fields.map(k=>[k,v[k]]));
export function parseCutoverRoute(request){
 const u=new URL(request.url);if(!u.pathname.startsWith('/v1/preparacao-virada'))return null;
 if(request.method!=='GET')throw new CutoverError(405,'ERP_METHOD_NOT_ALLOWED');
 if(u.pathname==='/v1/preparacao-virada'){if(u.searchParams.size)invalid();return{type:'summary',rpc:'erp_cutover_summary',args:{}};}
 const m=/^\/v1\/preparacao-virada\/([a-f0-9]{64})\/(contacts|products|receivables|payables|stock_snapshot)$/.exec(u.pathname);if(!m)throw new CutoverError(404,'ERP_NOT_FOUND');
 for(const key of u.searchParams.keys())if(!['limit','after','q'].includes(key)||u.searchParams.getAll(key).length!==1)invalid();
 const limit=u.searchParams.get('limit')??'25',after=u.searchParams.get('after'),q=u.searchParams.get('q');
 if(!/^[0-9]{1,2}$/.test(limit)||Number(limit)<1||Number(limit)>25||(after!==null&&(!str(after,300)||!(/^[ab]:/.test(after))))||(q!==null&&!str(q,120)))invalid();
 return{type:'records',rpc:'erp_cutover_records',entity:m[2],sha:m[1],args:{p_backup_sha:m[1],p_entity:m[2],p_limit:Number(limit),p_after:after,p_query:q||null}};
}
export const cutoverMethods=path=>path.startsWith('/v1/preparacao-virada')?['GET']:null;
function backup(v){
 if(v===null)return null;
 if(!obj(v)||!HASH.test(v.file_id)||!count(v.row)||v.row<1||!nullable(v.name,x=>str(x,200))||!nullable(v.code,x=>str(x,100))
  ||!nullable(v.status,x=>str(x,40))||!nullable(v.unit,x=>str(x,16))||!nullable(v.amount,x=>decimal(x,2))||!nullable(v.paid,x=>decimal(x,2))||!nullable(v.quantity,x=>decimal(x,6))
  ||!nullable(v.due_date,x=>str(x,20))||!nullable(v.depot_label,x=>str(x,200))||!nullable(v.stock_mode,x=>str(x,80))||!nullable(v.financial_account_present,x=>typeof x==='boolean'))upstream();
 return take(v,['file_id','row','name','code','status','unit','amount','paid','quantity','due_date','depot_label','stock_mode','financial_account_present']);
}
const labels={'1':'Aberto','2':'Pago','3':'Parcial','4':'Devolvido','5':'Cancelado','6':'Devolvido parcial','7':'Confirmado'};
function api(v){
 if(v===null)return null;
 if(!obj(v)||!timestamp(v.observed_at)||!HASH.test(v.source_hash)||!nullable(v.name,x=>str(x,200))||!nullable(v.code,x=>str(x,100))||!nullable(v.unit,x=>str(x,16))||!nullable(v.product_kind,x=>str(x,1))
  ||!nullable(v.status_code,x=>str(x,40))||v.status_label!==(labels[v.status_code]??null)||!nullable(v.amount,x=>decimal(x,2))||!nullable(v.balance,x=>decimal(x,2))
  ||!nullable(v.due_date,x=>str(x,20))||!nullable(v.contact_source_id,x=>str(x,200))||!nullable(v.native_contact_id,x=>UUID.test(x)))upstream();
 return take(v,['observed_at','source_hash','name','code','unit','product_kind','status_code','status_label','amount','balance','due_date','contact_source_id','native_contact_id']);
}
function native(v){
 if(v===null)return null;
 if(!obj(v)||!UUID.test(v.record_id)||!count(v.version)||v.version<1||typeof v.active!=='boolean'||!['synced','local_modified','source_changed','source_deleted'].includes(v.state)||typeof v.candidate_pending!=='boolean'||typeof v.source_changed_since_apply!=='boolean')upstream();
 return take(v,['record_id','version','active','state','candidate_pending','source_changed_since_apply']);
}
function response(v,r){
 if(!obj(v)||v.data_mode!=='cutover_readonly'||v.reconciled!==false||v.cutoff_at!==null||!timestamp(v.as_of))upstream();
 const base=take(v,['data_mode','as_of','reconciled','cutoff_at']);
 if(r.type==='records'){
  if(v.backup_sha!==r.sha||v.entity!==r.entity||v.limit!==r.args.p_limit||typeof v.has_more!=='boolean'||!Array.isArray(v.items)||v.items.length>v.limit||(v.has_more?(!str(v.next_cursor,300)||!(/^[ab]:/.test(v.next_cursor))):v.next_cursor!==null))upstream();
  const keys=new Set();const items=v.items.map(item=>{
   if(!obj(item)||!str(item.key,300)||!(/^[ab]:/.test(item.key))||keys.has(item.key)||!nullable(item.source_id,x=>str(x,200))||!Array.isArray(item.checks)||item.checks.length>CHECKS.length||new Set(item.checks).size!==item.checks.length||item.checks.some(x=>!CHECKS.includes(x)))upstream();keys.add(item.key);
   const b=backup(item.backup),a=api(item.api);if(!b&&!a)upstream();
   if((item.key.startsWith('b:')&&(!b||item.key!==`b:${b.file_id}:${String(b.row).padStart(7,'0')}`))||(item.key.startsWith('a:')&&(b||!a||item.key!==`a:${item.source_id}`)))upstream();
   return{key:item.key,source_id:item.source_id,backup:b,api:a,native:native(item.native),checks:[...item.checks]};
  });
  if(v.has_more&&v.next_cursor!==items.at(-1)?.key)upstream();
  return{...base,backup_sha:v.backup_sha,entity:v.entity,items,limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
 }
 if(!Array.isArray(v.batches)||v.batches.length>20||!count(v.batch_count)||typeof v.batches_truncated!=='boolean'||v.batches_truncated!==(v.batch_count>20)||!Array.isArray(v.api)||v.api.length!==4||!Array.isArray(v.limitations)||v.limitations.length!==LIMITATIONS.length||new Set(v.limitations).size!==LIMITATIONS.length||v.limitations.some(x=>!LIMITATIONS.includes(x)))upstream();
 const batches=v.batches.map(b=>{
  if(!obj(b)||!HASH.test(b.backup_sha)||!['stored','stored_with_issues'].includes(b.status)||!timestamp(b.stored_at)||!count(b.issues)||!Array.isArray(b.counts)||b.counts.length!==COUNT_ENTITIES.length)upstream();
  const counts=b.counts.map(c=>{if(!obj(c)||!COUNT_ENTITIES.includes(c.entity)||!['rows','distinct_ids','ids_seen_in_api','missing_id_rows'].every(k=>count(c[k]))||c.distinct_ids>c.rows||c.ids_seen_in_api>c.distinct_ids||c.missing_id_rows>c.rows)upstream();return take(c,['entity','rows','distinct_ids','ids_seen_in_api','missing_id_rows']);});
  if(new Set(counts.map(x=>x.entity)).size!==COUNT_ENTITIES.length)upstream();return{backup_sha:b.backup_sha,status:b.status,stored_at:b.stored_at,issues:b.issues,counts};
 });
 if(new Set(batches.map(b=>b.backup_sha)).size!==batches.length)upstream();
 const sources=v.api.map(a=>{
  if(!obj(a)||!ENTITIES.slice(0,4).includes(a.entity)||!['records','native_links','pending_candidates'].every(k=>count(a[k]))||!nullable(a.oldest_observation,timestamp)||!nullable(a.newest_observation,timestamp)||!Array.isArray(a.statuses)||a.statuses.length>1000)upstream();
  const statuses=a.statuses.map(s=>{if(!obj(s)||!nullable(s.code,x=>str(x,40))||s.label!==(labels[s.code]??null)||!count(s.count))upstream();return take(s,['code','label','count']);});
  return{...take(a,['entity','records','oldest_observation','newest_observation','native_links','pending_candidates']),statuses};
 });
 if(new Set(sources.map(x=>x.entity)).size!==4)upstream();
 return{...base,batches,batch_count:v.batch_count,batches_truncated:v.batches_truncated,api:sources,limitations:[...v.limitations]};
}
export async function executeCutoverRoute(route,{userId,rpc}){
 if(!route)throw new CutoverError(404,'ERP_NOT_FOUND');
 return response(await rpc(route.rpc,{p_user_id:userId,...route.args}),route);
}
