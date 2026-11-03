/** Aggregate-only boundary. Never forwards scheduler checkpoints, cursors, payloads or diagnostic bodies. */
const PREFIX='/v1/integracao-origin',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const PROGRESS_ENTITIES=Object.freeze(['contacts','products','sales_orders','sales_proposals','purchase_orders','receivables','payables','nfe','nfce','payment_methods','sellers']);
export const PROGRESS_RESOURCES=Object.freeze([
 ['contacts','contacts',true],['contacts_deleted','contacts',false],
 ...['zero','positive','negative'].map(v=>[`products_${v}`,'products',true]),
 ...['zero','positive','negative'].map(v=>[`products_deleted_${v}`,'products',false]),
 ...['sales_orders','sales_proposals','purchase_orders','receivables','payables'].map(v=>[v,v,true]),
 ...['nfe_in','nfe_out','nfe_in_cancelled','nfe_out_cancelled'].map(v=>[v,'nfe',true]),['nfce','nfce',true],
 ['payment_methods_active','payment_methods',false],['payment_methods_inactive','payment_methods',false],['sellers','sellers',true],['sellers_deleted','sellers',false],
]);
export const EXTRA_PROGRESS_ENTITIES=Object.freeze(['service_orders','warehouses','product_categories','financial_categories','ledger_accounts','cash_entries','stock_balances']);
export const EXTRA_PROGRESS_RESOURCES=Object.freeze([
 ['service_orders','service_orders',true],['warehouses_active','warehouses',false],['warehouses_inactive','warehouses',false],
 ['product_categories','product_categories',false],['financial_categories','financial_categories',false],['ledger_accounts','ledger_accounts',false],
 ['cash_entries_registered','cash_entries',true],['cash_entries_deleted','cash_entries',true],['stock_balances','stock_balances',false],
]);
export class IntegrationProgressError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=502,code='ERP_UPSTREAM_INVALID_RESPONSE')=>{throw new IntegrationProgressError(status,code);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const count=v=>{if(!Number.isSafeInteger(v)||v<0)fail();return v;};
const bool=v=>{if(typeof v!=='boolean')fail();return v;};
const date=v=>{
 if(typeof v!=='string'||v.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))fail();
 const part=v.slice(0,10);if(new Date(`${part}T00:00:00Z`).toISOString().slice(0,10)!==part)fail();return v;
};
const nullable=(v,validate)=>v===null?null:validate(v);
const local=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(v))fail();date(`${v.replace(' ','T')}${v.length===10?'T00:00:00':''}Z`);return v;};
const fields=(value,names,validate)=>Object.fromEntries(names.map(name=>[name,validate(value[name])]));
function run(v){
 if(v===null)return null;if(!object(v)||!['completed','partial','failed','skipped_time','skipped_budget','unknown'].includes(v.status))fail();
 return{status:v.status,...fields(v,['started_at','finished_at'],x=>nullable(x,date)),
  ...fields(v,['pages','records','requests','attempted','stored','files','error_count'],x=>nullable(x,count))};
}
function exactRows(rows,names,key){
 if(!Array.isArray(rows)||rows.length!==names.length||rows.some(v=>!object(v)||!names.includes(v[key]))||new Set(rows.map(v=>v[key])).size!==names.length)fail();
 return rows;
}
function entityRows(value,names){
 return exactRows(value,names,'entity').map(row=>{
  const result={entity:row.entity,records:count(row.records),oldest_observation:nullable(row.oldest_observation,date),newest_observation:nullable(row.newest_observation,date)};
  if(result.records===0?(result.oldest_observation!==null||result.newest_observation!==null):(!result.oldest_observation||!result.newest_observation||Date.parse(result.oldest_observation)>Date.parse(result.newest_observation)))fail();return result;
 });
}
function resourceRows(value,variants){
 return exactRows(value,variants.map(r=>r[0]),'resource').map(row=>{
  const[,entity,windowed]=variants.find(r=>r[0]===row.resource);if(row.entity!==entity||row.windowed!==windowed)fail();
  const result={resource:row.resource,entity,windowed,checkpoint_present:bool(row.checkpoint_present),state_updated_at:nullable(row.state_updated_at,date),
   ...fields(row,['recent_completed_local','history_completed_local','sweep_completed_local'],x=>nullable(x,local)),...fields(row,['recent_open','history_open','sweep_open'],bool)};
  if(result.checkpoint_present!==(result.state_updated_at!==null)||windowed&&(result.sweep_open||result.sweep_completed_local!==null)||!windowed&&(result.recent_open||result.history_open||result.recent_completed_local!==null||result.history_completed_local!==null))fail();return result;
 });
}
function extraResources(value){
 if(value===undefined||value===null)return null;
 if(!object(value)||value.profile!=='origin-extra-progress-v1'||value.coverage_certified!==false)fail();
 const entities=entityRows(value.entities,EXTRA_PROGRESS_ENTITIES),resources=resourceRows(value.resources,EXTRA_PROGRESS_RESOURCES);
 for(const r of resources)if(!r.checkpoint_present&&(r.recent_open||r.history_open||r.sweep_open||r.recent_completed_local!==null||r.history_completed_local!==null||r.sweep_completed_local!==null))fail();
 let stock_last_observation=null;
 if(value.stock_last_observation!==null){
  const v=value.stock_last_observation;if(!object(v)||v.coverage_complete!==false)fail();
  stock_last_observation={requested:count(v.requested),returned:count(v.returned),unavailable:count(v.unavailable),observed_at:date(v.observed_at),coverage_complete:false};
  if(stock_last_observation.requested>25||stock_last_observation.returned+stock_last_observation.unavailable!==stock_last_observation.requested||!resources.find(r=>r.resource==='stock_balances').checkpoint_present)fail();
 }
 return{profile:'origin-extra-progress-v1',coverage_certified:false,entities,resources,stock_last_observation};
}
export function integrationProgressResponse(v){
 if(!object(v)||v.data_mode!=='integration_progress_readonly'||v.role!=='admin'||v.coverage_certified!==false||v.erp_mutations!==false||v.runtime_configuration_known!==false)fail();
 const entities=entityRows(v.entities,PROGRESS_ENTITIES),resources=resourceRows(v.resources,PROGRESS_RESOURCES);
 if(!object(v.xml)||v.xml.validation!=='structural_only'||v.xml.authorization_verified!==false)fail();
 const xml={...fields(v.xml,['known_origins','eligible_origins','without_valid_key','with_preserved_revision','without_preserved_revision','never_attempted','retry_origins','blocked_origins','backing_off','preserved_objects','preserved_revisions'],count),last_success_at:nullable(v.xml.last_success_at,date),validation:'structural_only',authorization_verified:false};
 if(xml.eligible_origins+xml.without_valid_key!==xml.known_origins||xml.with_preserved_revision+xml.without_preserved_revision!==xml.eligible_origins||xml.never_attempted>xml.without_preserved_revision||xml.retry_origins+xml.blocked_origins>xml.eligible_origins||xml.backing_off>xml.eligible_origins||xml.preserved_revisions<xml.with_preserved_revision)fail();
 if(!object(v.finance_refresh)||!object(v.finance_refresh.reference_limits))fail();
 const reference_limits={max_ids:8,max_seconds:40,max_attempts:24,shared_requests:120,observation_age_seconds:3600};
 for(const[k,n]of Object.entries(reference_limits))if(v.finance_refresh.reference_limits[k]!==n)fail();
 const financeEntities=exactRows(v.finance_refresh.entities,['payables','receivables'],'entity').map(row=>{
  const result={entity:row.entity,...fields(row,['known_open_partial','observed_over_hour_ago','unavailable_balance','backing_off'],count),...fields(row,['oldest_observation','last_success_at','retry_after'],x=>nullable(x,date))};
  if(result.observed_over_hour_ago>result.known_open_partial||result.unavailable_balance>result.known_open_partial||result.backing_off>result.known_open_partial||(result.known_open_partial===0)!==(result.oldest_observation===null))fail();return result;
 });
 const last_run=run(v.last_run),last_xml_run=run(v.last_xml_run),last_finance_run=run(v.last_finance_run);
 if(last_run===null&&(last_xml_run!==null||last_finance_run!==null))fail();
 return{data_mode:'integration_progress_readonly',as_of:date(v.as_of),role:'admin',coverage_certified:false,erp_mutations:false,runtime_configuration_known:false,
  entities,resources,last_run,last_xml_run,last_finance_run,xml,finance_refresh:{entities:financeEntities,reference_limits},extra_resources:extraResources(v.extra_resources)};
}
// 101: freshness of the current Origin staging. Same admin-only, read-only boundary.
// Lanes follow workers/origin-sync/src/resources.mjs: modified-date filters need only the
// recent lane; document-date filters also need history; undated variants are sweeps.
export const FRESHNESS_PATH=`${PREFIX}/frescor`;
export const FRESHNESS_LEVELS=Object.freeze({A:600,B:1800,C:86400});
const dated=resource=>[[resource,'recent'],[resource,'history']],balance=['zero','positive','negative'];
export const FRESHNESS_ENTITIES=Object.freeze([
 ['contacts','A',[['contacts','recent'],['contacts_deleted','sweep']]],
 ['products','A',[...balance.map(v=>[`products_${v}`,'recent']),...balance.map(v=>[`products_deleted_${v}`,'sweep'])]],
 ['sales_orders','A',[['sales_orders','recent']]],
 ['nfe','A',['nfe_in','nfe_out','nfe_in_cancelled','nfe_out_cancelled'].flatMap(dated)],['nfce','A',dated('nfce')],
 ...['sales_proposals','purchase_orders','service_orders','receivables','payables'].map(entity=>[entity,'B',dated(entity)]),
 ['cash_entries','B',['cash_entries_registered','cash_entries_deleted'].flatMap(dated)],['stock_balances','B',[['stock_balances','sweep']]],
 ['sellers','C',[['sellers','recent'],['sellers_deleted','sweep']]],
 ['payment_methods','C',[['payment_methods_active','sweep'],['payment_methods_inactive','sweep']]],
 ['warehouses','C',[['warehouses_active','sweep'],['warehouses_inactive','sweep']]],
 ...['product_categories','financial_categories','ledger_accounts'].map(entity=>[entity,'C',[[entity,'sweep']]]),
].map(([entity,level,lanes])=>Object.freeze([entity,level,Object.freeze(lanes.map(lane=>Object.freeze(lane)))])));
const RUN_STATUS=['completed','partial','failed','skipped_time','skipped_budget','unknown'];
const ms=v=>Date.parse(v),SKEW_MS=300000;
// ok within the level, attention above it, stale above three times it or without a measured pass.
export const freshnessStatus=(age,target)=>age===null?'stale':age<=target?'ok':age<=3*target?'attention':'stale';
const pattern=re=>x=>typeof x==='string'&&re.test(x)?x:fail();
function freshnessCollector(v){
 if(!object(v))fail();
 const c={oauth_connected:bool(v.oauth_connected),oauth_expires_at:nullable(v.oauth_expires_at,date),
  last_run_status:nullable(v.last_run_status,x=>RUN_STATUS.includes(x)?x:fail()),
  last_run_started_at:nullable(v.last_run_started_at,date),last_run_finished_at:nullable(v.last_run_finished_at,date),
  last_run_error_count:nullable(v.last_run_error_count,count),
  last_error_code:nullable(v.last_error_code,pattern(/^[A-Z][A-Z0-9_]{0,80}$/)),last_error_resource:nullable(v.last_error_resource,pattern(/^[a-z][a-z0-9_]{0,79}$/))};
 if(c.oauth_connected!==(c.oauth_expires_at!==null))fail();
 if(c.last_run_status===null&&(c.last_run_started_at!==null||c.last_run_finished_at!==null||c.last_run_error_count!==null))fail();
 if((c.last_error_code!==null||c.last_error_resource!==null)&&!(c.last_run_error_count>0))fail();
 return c;
}
function freshnessEntity(row,[entity,level,lanes],asOf){
 if(!object(row)||row.entity!==entity||row.level!==level||row.target_seconds!==FRESHNESS_LEVELS[level])fail();
 const records=count(row.records),[last_changed_at,last_seen_at,oldest_seen_at]=['last_changed_at','last_seen_at','oldest_seen_at'].map(k=>nullable(row[k],date));
 if(records===0?(last_changed_at!==null||last_seen_at!==null||oldest_seen_at!==null):(last_changed_at===null||last_seen_at===null||oldest_seen_at===null||ms(oldest_seen_at)>ms(last_seen_at)))fail();
 if(!Array.isArray(row.lanes)||row.lanes.length!==lanes.length)fail();
 const laneRows=row.lanes.map((lane,i)=>{
  if(!object(lane)||lane.resource!==lanes[i][0]||lane.lane!==lanes[i][1])fail();
  const x={resource:lane.resource,lane:lane.lane,checkpoint_present:bool(lane.checkpoint_present),open:bool(lane.open),
   completed_started_at:nullable(lane.completed_started_at,date),completed_finished_at:nullable(lane.completed_finished_at,date)};
  if(!x.checkpoint_present&&(x.open||x.completed_finished_at!==null)||x.completed_finished_at!==null&&ms(x.completed_finished_at)>ms(asOf)+SKEW_MS
   ||x.completed_started_at!==null&&(x.completed_finished_at===null||ms(x.completed_started_at)>ms(x.completed_finished_at)))fail();
  return x;
 });
 const measured=laneRows.filter(x=>x.completed_started_at!==null),complete=measured.length===lanes.length;
 if(row.lanes_total!==lanes.length||row.lanes_measured!==measured.length)fail();
 const freshness_at=nullable(row.freshness_at,date),pass_finished_at=nullable(row.pass_finished_at,date),age_seconds=nullable(row.age_seconds,count);
 const pass_resource=nullable(row.pass_resource,pattern(/^[a-z][a-z0-9_]{0,79}$/)),pass_lane=nullable(row.pass_lane,x=>['recent','history','sweep'].includes(x)?x:fail());
 if(!complete){if(freshness_at!==null||pass_finished_at!==null||age_seconds!==null||pass_resource!==null||pass_lane!==null)fail();}
 else{
  // The limiting pass is the measured lane with the oldest start; never the latest cycle.
  const oldest=Math.min(...measured.map(x=>ms(x.completed_started_at))),limit=measured.find(x=>x.resource===pass_resource&&x.lane===pass_lane);
  if(freshness_at===null||age_seconds===null||!limit||ms(freshness_at)!==oldest||ms(limit.completed_started_at)!==oldest||pass_finished_at===null||ms(pass_finished_at)!==ms(limit.completed_finished_at))fail();
  // age_seconds is rounded up in SQL; JSON instants lose sub-millisecond digits here.
  const elapsed=Math.max(0,(ms(asOf)-oldest)/1000);if(age_seconds<elapsed-0.001||age_seconds>=elapsed+1.001)fail();
 }
 if(row.status!==freshnessStatus(age_seconds,FRESHNESS_LEVELS[level]))fail();
 return{entity,level,target_seconds:FRESHNESS_LEVELS[level],records,last_changed_at,last_seen_at,oldest_seen_at,lanes_total:lanes.length,lanes_measured:measured.length,
  freshness_at,age_seconds,pass_finished_at,pass_resource,pass_lane,status:row.status,lanes:laneRows};
}
export function originSyncFreshnessResponse(v){
 if(!object(v)||v.profile!=='origin-sync-freshness-v1'||v.data_mode!=='origin_sync_freshness_readonly'||v.role!=='admin'||v.time_zone!=='America/Sao_Paulo'||v.coverage_certified!==false||v.erp_mutations!==false)fail();
 const as_of=date(v.as_of),levels=Object.entries(FRESHNESS_LEVELS).map(([level,target_seconds])=>({level,target_seconds,stale_after_seconds:3*target_seconds}));
 if(!Array.isArray(v.levels)||v.levels.length!==levels.length||levels.some((l,i)=>!object(v.levels[i])||Object.keys(l).some(k=>v.levels[i][k]!==l[k])))fail();
 if(!Array.isArray(v.entities)||v.entities.length!==FRESHNESS_ENTITIES.length)fail();
 return{profile:'origin-sync-freshness-v1',data_mode:'origin_sync_freshness_readonly',as_of,role:'admin',time_zone:'America/Sao_Paulo',coverage_certified:false,erp_mutations:false,
  levels,collector:freshnessCollector(v.collector),entities:FRESHNESS_ENTITIES.map((spec,i)=>freshnessEntity(v.entities[i],spec,as_of))};
}
const ROUTES=Object.freeze({[PREFIX]:{type:'summary',rpc:'erp_origin_progress',response:integrationProgressResponse},
 [FRESHNESS_PATH]:{type:'freshness',rpc:'erp_origin_sync_freshness',response:originSyncFreshnessResponse}});
export const integrationProgressMethods=path=>Object.hasOwn(ROUTES,path)?['GET']:null;
export function parseIntegrationProgressRoute(request){
 const url=new URL(request.url);if(!Object.hasOwn(ROUTES,url.pathname))return null;
 if(request.method!=='GET')fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.search||request.headers.has('Content-Encoding')&&request.headers.get('Content-Encoding')!=='identity')fail(400,'ERP_INVALID_QUERY');
 const{type,rpc}=ROUTES[url.pathname];return{type,rpc,args:{}};
}
export async function executeIntegrationProgressRoute(route,{userId,rpc}){
 if(typeof userId!=='string'||!UUID.test(userId))fail(401,'ERP_UNAUTHORIZED');
 const known=Object.values(ROUTES).find(r=>r.type===route?.type);
 if(!known||route.rpc!==known.rpc||!object(route.args)||Object.keys(route.args).length)fail(404,'ERP_NOT_FOUND');
 return known.response(await rpc(known.rpc,{p_user_id:userId.toLowerCase()}));
}
