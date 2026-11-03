/** Read-only, admin-scoped AP/AR evidence. No raw source payload or import route. */
const PREFIX='/v1/conferencia-financeira-origin';
const ENTITIES=['receivables','payables'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const INT=/^(0|[1-9][0-9]*)$/;
const labels={'1':'Aberto','2':'Pago','3':'Parcial','4':'Devolvido','5':'Cancelado','6':'Devolvido parcial','7':'Confirmado'};
const blockers=['SOURCE_ID_MISMATCH','SOURCE_STATUS_UNKNOWN','AMOUNT_UNAVAILABLE','AMOUNT_ZERO','AMOUNT_EXCEEDS_NATIVE_LIMIT','BALANCE_UNAVAILABLE','BALANCE_EXCEEDS_AMOUNT','DATES_MISSING_OR_INVALID','DUE_BEFORE_ISSUED','CONTACT_REFERENCE_MISSING','CONTACT_REFERENCE_INVALID','CONTACT_UNMATCHED','CONTACT_INACTIVE'];
const reviews=['SOURCE_STATUS_OUTSIDE_OPEN_SCOPE','BALANCE_ZERO','OPEN_BALANCE_DIFFERS','PARTIAL_STATUS_REQUIRES_REVIEW','CONTACT_PENDING_REVIEW','CONTACT_LOCALLY_EDITED','SOURCE_TEXT_TRUNCATED','SOURCE_TEXT_INVALID','REFERENCE_INVALID','BANK_MAPPING_NOT_ESTABLISHED','INSTALLMENT_LINKAGE_NOT_ESTABLISHED','OBSERVATION_OLDER_THAN_ONE_HOUR','OBSERVATION_IN_FUTURE','REFRESH_FAILED','REFRESH_CONFLICT','REFRESH_EVIDENCE_INCOMPLETE'];
export const FINANCIAL_CUTOVER_ISSUES=Object.freeze(Object.fromEntries([...blockers.map(c=>[c,'blocker']),...reviews.map(c=>[c,'review']),['REFRESH_PENDING','info']]));
export const FINANCIAL_CUTOVER_RESPONSE_BYTES=1024*1024;
export class FinancialCutoverError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new FinancialCutoverError(400,'ERP_INVALID_QUERY');};
const upstream=()=>{throw new FinancialCutoverError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const id=v=>text(v,200)&&v.length>0;
const nullable=(v,p)=>v===null||p(v);
const timestamp=v=>text(v,60)&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v));
const positiveVersion=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const count=v=>Number.isSafeInteger(v)&&v>=0&&v<=25;
const take=(v,fields)=>Object.fromEntries(fields.map(k=>[k,v[k]]));
function date(v){return typeof v==='string'&&/^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
// Matches PostgreSQL COLLATE "C", including identifiers containing non-ASCII text.
function compare(a,b){const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;}
export function financialCutoverMethods(path){return path===PREFIX||path.startsWith(`${PREFIX}/`)?['GET']:null;}
export function parseFinancialCutoverRoute(request){
 const u=new URL(request.url);if(!financialCutoverMethods(u.pathname))return null;
 if(request.method!=='GET')throw new FinancialCutoverError(405,'ERP_METHOD_NOT_ALLOWED');
 if(u.pathname===PREFIX){
  for(const k of u.searchParams.keys())if(!['entity','status','limit','after','q','from','to'].includes(k)||u.searchParams.getAll(k).length!==1)invalid();
  const entity=u.searchParams.get('entity'),status=u.searchParams.get('status')??'open_partial',limit=u.searchParams.get('limit')??'25',after=u.searchParams.get('after'),q=u.searchParams.get('q'),from=u.searchParams.get('from'),to=u.searchParams.get('to');
  if(!ENTITIES.includes(entity)||!['open_partial','all','unknown'].includes(status)||!/^([1-9]|1[0-9]|2[0-5])$/.test(limit)
   ||!nullable(after,id)||!nullable(q,v=>text(v,100))||!nullable(from,date)||!nullable(to,date)||(from&&to&&from>to))invalid();
  return{type:'list',rpc:'erp_cutover_financial_list',entity,args:{p_entity:entity,p_status:status,p_limit:Number(limit),p_after:after,p_query:q||null,p_from:from,p_to:to}};
 }
 const match=new RegExp(`^${PREFIX}/(receivables|payables)/([^/]+)$`).exec(u.pathname);
 if(!match)throw new FinancialCutoverError(404,'ERP_NOT_FOUND');
 if(u.searchParams.size)invalid();let sourceId;try{sourceId=decodeURIComponent(match[2]);}catch{invalid();}if(!id(sourceId))invalid();
 return{type:'detail',rpc:'erp_cutover_financial_get',entity:match[1],sourceId,args:{p_entity:match[1],p_source_id:sourceId}};
}
function money(v){
 if(!obj(v)||!['available','missing','null','invalid_type','invalid_value','out_of_range'].includes(v.state))upstream();
 if(v.state==='available'){
  if(typeof v.value!=='string'||!/^(0|[1-9][0-9]{0,13})\.[0-9]{2}$/.test(v.value)||typeof v.cents!=='string'||!INT.test(v.cents)||v.cents.length>16||BigInt(v.value.replace('.',''))!==BigInt(v.cents))upstream();
 }else if(v.value!==null||v.cents!==null)upstream();
 return take(v,['state','value','cents']);
}
function contact(v){
 if(!obj(v)||!nullable(v.source_id,id)||!['matched','missing_reference','invalid_reference','unmatched','inactive'].includes(v.match)
  ||!nullable(v.record_id,x=>typeof x==='string'&&UUID.test(x))||!nullable(v.record_version,positiveVersion)||!nullable(v.name,x=>text(x,200))
  ||!nullable(v.origin_state,x=>['synced','local_modified','source_changed','source_deleted'].includes(x))
  ||!['human_edited','pending_review','source_changed_since_apply'].every(k=>nullable(v[k],x=>typeof x==='boolean')))upstream();
 const linked=['matched','inactive'].includes(v.match);
 if(linked&&(!v.source_id||!v.record_id||!v.record_version||!v.name||!v.origin_state||v.human_edited===null||v.pending_review===null))upstream();
 if(!linked&&['record_id','record_version','name','origin_state','human_edited','pending_review','source_changed_since_apply'].some(k=>v[k]!==null))upstream();
 if(['missing_reference','invalid_reference'].includes(v.match)&&v.source_id!==null)upstream();if(v.match==='unmatched'&&v.source_id===null)upstream();
 return take(v,['source_id','match','record_id','record_version','name','origin_state','human_edited','pending_review','source_changed_since_apply']);
}
function extras(v){
 const b=v.banking,i=v.installments,o=v.origin,r=v.refresh;
 if(!obj(b)||b.bank_mapping!=='not_established'||!nullable(b.bank_number,x=>text(x,200))||!['carrier_id','payment_method_id','category_id','accounting_id'].every(k=>nullable(b[k],id))
  ||!Array.isArray(b.bordero_ids)||b.bordero_ids.length>100||b.bordero_ids.some(x=>!id(x)))upstream();
 if(!obj(i)||i.linkage!=='not_established'||i.index!==null||i.group_id!==null||!nullable(i.kind,x=>typeof x==='string'&&/^[0-9]{1,3}$/.test(x))||!nullable(i.total,x=>typeof x==='string'&&/^[0-9]{1,6}$/.test(x)))upstream();
 if(!obj(o)||!nullable(o.id,id)||!nullable(o.type,x=>text(x,100))||!nullable(o.number,x=>text(x,200)))upstream();
 if(!obj(r)||!['never_attempted','incomplete','pending','stored','conflict','failed','superseded'].includes(r.state)
  ||!['last_attempt_at','last_success_at','last_finished_at','next_attempt_at'].every(k=>nullable(r[k],timestamp))
  ||!nullable(r.error_code,x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(x))||!nullable(r.http_status,x=>Number.isInteger(x)&&x>=100&&x<=599)
  ||!nullable(r.current_source_matches_result,x=>typeof x==='boolean'))upstream();
 if(r.state==='never_attempted'&&['last_attempt_at','last_success_at','last_finished_at','next_attempt_at','error_code','http_status','current_source_matches_result'].some(k=>r[k]!==null))upstream();
 if(!['never_attempted','incomplete'].includes(r.state)&&r.last_attempt_at===null)upstream();
 if(r.state==='incomplete'&&['last_finished_at','error_code','http_status','current_source_matches_result'].some(k=>r[k]!==null))upstream();
 if(r.state==='pending'&&r.last_finished_at!==null)upstream();if(!['never_attempted','incomplete','pending'].includes(r.state)&&r.last_finished_at===null)upstream();
 if(r.state!=='stored'&&r.current_source_matches_result!==null)upstream();
 if(r.state==='stored'&&(r.current_source_matches_result===null||r.error_code!==null||r.http_status!==null))upstream();
 return{banking:{...take(b,['bank_number','carrier_id','payment_method_id','category_id','accounting_id','bank_mapping']),bordero_ids:[...b.bordero_ids]},installments:take(i,['kind','total','index','group_id','linkage']),origin:take(o,['id','type','number']),refresh:take(r,['state','last_attempt_at','last_success_at','last_finished_at','next_attempt_at','error_code','http_status','current_source_matches_result'])};
}
function row(v,route){
 if(!obj(v)||v.entity!==route.entity||!id(v.source_id)||!positiveVersion(v.source_version)||typeof v.source_hash!=='string'||!HASH.test(v.source_hash)||!timestamp(v.observed_at)||!timestamp(v.changed_at)
  ||!obj(v.status)||!nullable(v.status.code,x=>typeof x==='string'&&Object.hasOwn(labels,x))
  ||v.status.label!==(labels[v.status.code]??'Não reconhecida')||v.status.scope!==({'1':'open','3':'partial'}[v.status.code]??(v.status.code===null?'unknown':'outside_open_scope'))
  ||!nullable(v.document_number,x=>text(x,200))||!nullable(v.description,x=>text(x,240))||!['issued_on','due_on','original_due_on','competence_on'].every(k=>nullable(v[k],date)))upstream();
 if(!Array.isArray(v.issues)||v.issues.length>Object.keys(FINANCIAL_CUTOVER_ISSUES).length||new Set(v.issues.map(i=>i?.code)).size!==v.issues.length||v.issues.some(i=>!obj(i)||!Object.hasOwn(FINANCIAL_CUTOVER_ISSUES,i.code)||i.level!==FINANCIAL_CUTOVER_ISSUES[i.code]))upstream();
 const amount=money(v.amount),balance=money(v.balance),c=contact(v.contact),codes=new Set(v.issues.map(i=>i.code));
 const requireIssue=(condition,code)=>{if(condition&&!codes.has(code))upstream();};
 requireIssue(v.status.scope==='unknown','SOURCE_STATUS_UNKNOWN');requireIssue(v.status.scope==='outside_open_scope','SOURCE_STATUS_OUTSIDE_OPEN_SCOPE');requireIssue(v.status.scope==='partial','PARTIAL_STATUS_REQUIRES_REVIEW');
 requireIssue(amount.state!=='available','AMOUNT_UNAVAILABLE');requireIssue(amount.cents==='0','AMOUNT_ZERO');requireIssue(amount.cents!==null&&BigInt(amount.cents)>999999999999999n,'AMOUNT_EXCEEDS_NATIVE_LIMIT');
 requireIssue(balance.state!=='available','BALANCE_UNAVAILABLE');requireIssue(balance.cents==='0','BALANCE_ZERO');
 requireIssue(amount.cents!==null&&balance.cents!==null&&BigInt(balance.cents)>BigInt(amount.cents),'BALANCE_EXCEEDS_AMOUNT');
 requireIssue(v.status.scope==='open'&&amount.cents!==null&&balance.cents!==null&&amount.cents!==balance.cents,'OPEN_BALANCE_DIFFERS');
 requireIssue(v.issued_on===null||v.due_on===null,'DATES_MISSING_OR_INVALID');requireIssue(v.issued_on!==null&&v.due_on!==null&&v.due_on<v.issued_on,'DUE_BEFORE_ISSUED');
 for(const[match,code]of[['missing_reference','CONTACT_REFERENCE_MISSING'],['invalid_reference','CONTACT_REFERENCE_INVALID'],['unmatched','CONTACT_UNMATCHED'],['inactive','CONTACT_INACTIVE']])requireIssue(c.match===match,code);
 requireIssue(c.pending_review===true,'CONTACT_PENDING_REVIEW');requireIssue(c.human_edited===true,'CONTACT_LOCALLY_EDITED');
 const result={...take(v,['entity','source_id','source_version','source_hash','observed_at','changed_at','document_number','description','issued_on','due_on','original_due_on','competence_on']),status:take(v.status,['code','label','scope']),amount,balance,contact:c,issues:v.issues.map(i=>take(i,['code','level']))};
 if(route.type==='detail'){
  if(v.source_id!==route.sourceId)upstream();Object.assign(result,extras(v));
  requireIssue(true,'BANK_MAPPING_NOT_ESTABLISHED');requireIssue(true,'INSTALLMENT_LINKAGE_NOT_ESTABLISHED');
  requireIssue(v.refresh.state==='pending','REFRESH_PENDING');requireIssue(v.refresh.state==='failed','REFRESH_FAILED');requireIssue(v.refresh.state==='conflict','REFRESH_CONFLICT');
  requireIssue(v.refresh.state==='incomplete','REFRESH_EVIDENCE_INCOMPLETE');
 }
 return result;
}
function response(v,route){
 if(!obj(v)||v.data_mode!=='financial_cutover_readonly'||!timestamp(v.as_of)||v.cutoff_at!==null||!['persisted','import_enabled','operational_effects','reconciled','coverage_certified'].every(k=>v[k]===false))upstream();
 const base=take(v,['data_mode','as_of','persisted','import_enabled','operational_effects','reconciled','cutoff_at','coverage_certified']);
 if(route.type==='detail')return{...base,record:row(v.record,route)};
 if(v.entity!==route.entity||v.status!==route.args.p_status||v.limit!==route.args.p_limit||v.q!==route.args.p_query||v.from!==route.args.p_from||v.to!==route.args.p_to
  ||!Array.isArray(v.items)||v.items.length>v.limit||typeof v.has_more!=='boolean'||!nullable(v.next_cursor,id)||v.has_more!==(v.next_cursor!==null))upstream();
 const items=v.items.map(item=>row(item,route));let previous=route.args.p_after;
 for(const item of items){if(previous!==null&&compare(item.source_id,previous)<=0)upstream();previous=item.source_id;
  if(v.status==='open_partial'&&!['open','partial'].includes(item.status.scope)||v.status==='unknown'&&item.status.scope!=='unknown')upstream();
  if(v.from!==null&&(item.due_on===null||item.due_on<v.from)||v.to!==null&&(item.due_on===null||item.due_on>v.to))upstream();
  if(v.q!==null&&!item.source_id.includes(v.q)&&!(item.document_number??'').includes(v.q))upstream();
 }
 if(v.has_more&&(items.length!==v.limit||v.next_cursor!==items.at(-1)?.source_id))upstream();
 const totals=v.page_totals;if(!obj(totals)||totals.scope!=='current_page_only')upstream();
 for(const key of ['amount','balance']){
  const available=items.filter(i=>i[key].state==='available');const sum=available.reduce((s,i)=>s+BigInt(i[key].cents),0n).toString();
  if(totals[`${key}_cents`]!==sum||!count(totals[`${key}_available_count`])||!count(totals[`${key}_unavailable_count`])||totals[`${key}_available_count`]!==available.length||totals[`${key}_unavailable_count`]!==items.length-available.length)upstream();
 }
 return{...base,...take(v,['entity','status','limit','from','to','q','has_more','next_cursor']),items,page_totals:take(totals,['amount_cents','balance_cents','amount_available_count','balance_available_count','amount_unavailable_count','balance_unavailable_count','scope'])};
}
export async function executeFinancialCutoverRoute(route,{userId,rpc}){
 if(!route)throw new FinancialCutoverError(404,'ERP_NOT_FOUND');if(typeof userId!=='string'||!UUID.test(userId))throw new FinancialCutoverError(403,'ERP_ACCESS_DENIED');
 const projected=response(await rpc(route.rpc,{p_user_id:userId.toLowerCase(),...route.args}),route);
 if(new TextEncoder().encode(JSON.stringify(projected)).length>FINANCIAL_CUTOVER_RESPONSE_BYTES)upstream();return projected;
}
