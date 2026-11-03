/** Reviewed native title creation; no source API, settlement, cash or bank operation. */
const PREFIX='/v1/importacao-financeira-origin';
const ENTITIES=['receivables','payables'];
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const COMMON={data_mode:'financial_import_review',policy:'origin-open-unique-v1',cutoff_at:null,coverage_certified:false,creates_titles:true,settles_titles:false,changes_cash_balance:false,bank_actions:false};
export const FINANCIAL_IMPORT_RESPONSE_BYTES=1024*1024;
export const FINANCIAL_IMPORT_BLOCKERS=Object.freeze(['SOURCE_MISSING','SOURCE_CHANGED','SOURCE_ID_MISMATCH','STATUS_NOT_OPEN','AMOUNT_INVALID','BALANCE_NOT_FULL','DATES_INVALID','ISSUE_DATE_FUTURE','DESCRIPTION_INVALID','OCCURRENCE_NOT_UNIQUE','CONTACT_NOT_READY','CATEGORY_NOT_READY','REFRESH_NOT_VERIFIED','REFRESH_EXPIRED','SOURCE_ALREADY_IMPORTED']);
export class FinancialImportError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new FinancialImportError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const text=(v,max)=>typeof v==='string'&&Array.from(v).length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const uuid=v=>typeof v==='string'&&UUID.test(v);
const hash=v=>typeof v==='string'&&HASH.test(v);
const sourceId=v=>typeof v==='string'&&/^[0-9]{1,40}$/.test(v)&&!/^0+$/.test(v);
const sourceVersion=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const time=v=>typeof v==='string'&&v.length<=60&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const date=v=>typeof v==='string'&&/^(19|20)\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const nativeDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const nativeText=(v,max)=>typeof v==='string'&&Array.from(v).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const cents=(v,max=999999999999999n,zero=true)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,16})$/.test(v)&&BigInt(v)<=max&&(zero||v!=='0');
const nullable=(v,test)=>v===null||test(v);
const kind=entity=>entity==='receivables'?'receivable':'payable';
const reference=(entity,id)=>`Origin ${entity==='receivables'?'AR':'AP'} ${id}`;

export function financialImportMethods(path){
 if(path===PREFIX+'/preview'||path===PREFIX+'/apply')return['POST'];
 return path.startsWith(PREFIX+'/')?['GET']:null;
}
async function readBody(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body)fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>65536))fail();
 if(request.signal.aborted)fail();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let content='',size=0,timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new FinancialImportError(408,'ERP_REQUEST_TIMEOUT'));void reader.cancel().catch(()=>{});},10000);});
 try{for(;;){const {value,done}=await Promise.race([reader.read(),timeout]);if(request.signal.aborted)fail();if(done)break;size+=value.byteLength;if(size>65536)fail();content+=decoder.decode(value,{stream:true});}return JSON.parse(content+decoder.decode());}
 catch(e){if(e instanceof FinancialImportError)throw e;fail();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function parseFinancialImportRoute(request){
 const url=new URL(request.url),methods=financialImportMethods(url.pathname);if(!methods)return null;
 if(!methods.includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.searchParams.size||url.hash||(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity'))fail();
 const action=/^\/v1\/importacao-financeira-origin\/(preview|apply)$/.exec(url.pathname);
 if(action){
  const v=await readBody(request),apply=action[1]==='apply';
  if(!exact(v,['entity','duplicate_reviewed','items',...(apply?['command_id','preview_hash','confirm_import']:[])])||!ENTITIES.includes(v.entity)||v.duplicate_reviewed!==true||!Array.isArray(v.items)||v.items.length<1||v.items.length>25)fail();
  const seen=new Set(),items=v.items.map(i=>{
   if(!exact(i,['source_id','source_hash','source_version','source_seen_at','category_id','category_version'])||!sourceId(i.source_id)||!hash(i.source_hash)||!sourceVersion(i.source_version)||!time(i.source_seen_at)||seen.has(i.source_id)
    ||(i.category_id===null?i.category_version!==null:!uuid(i.category_id)||!version(i.category_version)))fail();seen.add(i.source_id);
   return{...i,category_id:i.category_id?.toLowerCase()??null};
  });
  const args={p_entity:v.entity,p_items:items,p_duplicate_reviewed:true};
  if(apply){if(!uuid(v.command_id)||!hash(v.preview_hash)||v.confirm_import!==true)fail();Object.assign(args,{p_command_id:v.command_id.toLowerCase(),p_preview_hash:v.preview_hash,p_confirm_import:true});}
  return{type:action[1],rpc:`erp_origin_financial_import_${action[1]}`,args};
 }
 const batch=/^\/v1\/importacao-financeira-origin\/batches\/([^/]+)$/.exec(url.pathname);
 if(batch){if(!uuid(batch[1]))fail();return{type:'batch',rpc:'erp_origin_financial_import_batch',args:{p_command_id:batch[1].toLowerCase()}};}
 const title=/^\/v1\/importacao-financeira-origin\/titles\/([^/]+)\/origin$/.exec(url.pathname);
 if(title){if(!uuid(title[1]))fail();return{type:'title_origin',rpc:'erp_origin_financial_import_title_origin',args:{p_title_id:title[1].toLowerCase()}};}
 const origin=/^\/v1\/importacao-financeira-origin\/origins\/(receivables|payables)\/([^/]+)$/.exec(url.pathname);
 if(origin){let id;try{id=decodeURIComponent(origin[2]);}catch{fail();}if(!sourceId(id))fail();return{type:'origin',rpc:'erp_origin_financial_import_origin',args:{p_entity:origin[1],p_source_id:id}};}
 fail(404,'ERP_NOT_FOUND');
}
function category(v){
 if(!nullable(v.category_id,uuid)||!nullable(v.category_version,version)||(v.category_id===null)!==(v.category_version===null))bad();
}
function proposed(v,entity,source){
 if(!object(v)||v.kind!==kind(entity)||!uuid(v.contact_id)||!version(v.contact_version)||!text(v.contact_name,200)||!v.contact_name
  ||!text(v.description,240)||!v.description.trim()||v.source_reference!==reference(entity,source)||!date(v.issued_on)||!date(v.due_on)||v.due_on<v.issued_on
  ||!cents(v.amount_cents,999999999999999n,false)||v.settled_cents!=='0'||v.installment!==1||v.installments!==1)bad();
 category(v);if(v.category_id===null?v.category_name!==null:!text(v.category_name,200)||!v.category_name)bad();
 return pick(v,['kind','contact_id','contact_version','contact_name','category_id','category_version','category_name','description','source_reference','issued_on','due_on','amount_cents','settled_cents','installment','installments']);
}
function existing(v){if(v===null)return null;if(!object(v)||!uuid(v.title_id)||!uuid(v.batch_id)||!time(v.imported_at))bad();return pick(v,['title_id','batch_id','imported_at']);}
function preview(v,route){
 if(v.entity!==route.args.p_entity||v.dry_run!==true||v.persisted!==false||v.duplicate_reviewed!==true||!hash(v.preview_hash)||typeof v.can_apply!=='boolean'||!nullable(v.valid_until,time)
  ||!Array.isArray(v.items)||v.items.length!==route.args.p_items.length||!object(v.summary))bad();
 let total=0n,eligible=0;const expiries=[];
 const items=v.items.map((row,index)=>{
  const input=route.args.p_items[index];
  if(!object(row)||['source_id','source_hash','source_version','source_seen_at'].some(k=>row[k]!==input[k])||!['eligible','blocked','already_imported'].includes(row.status)
   ||!Array.isArray(row.blockers)||row.blockers.length>FINANCIAL_IMPORT_BLOCKERS.length||new Set(row.blockers).size!==row.blockers.length||row.blockers.some(b=>!FINANCIAL_IMPORT_BLOCKERS.includes(b)))bad();
  const e=row.evidence;if(!object(e)||!nullable(e.status_code,x=>typeof x==='string'&&/^[1-7]$/.test(x))||!nullable(e.amount_cents,x=>cents(x,9999999999999999n))||!nullable(e.balance_cents,x=>cents(x,9999999999999999n))
   ||!nullable(e.occurrence_type,x=>typeof x==='string'&&/^[0-9]{1,3}$/.test(x))||!nullable(e.contact_source_id,x=>text(x,200)&&x.length>0)||!nullable(e.refresh_finished_at,time))bad();
  const old=existing(row.existing),p=row.proposed===null?null:proposed(row.proposed,v.entity,row.source_id);
  if((row.status==='eligible')!==(p!==null)||((row.status==='eligible')!==(row.blockers.length===0))||(row.status==='already_imported')!==(old!==null)
   ||(old!==null&&!row.blockers.includes('SOURCE_ALREADY_IMPORTED')))bad();
  if(p){if(e.status_code!=='1'||e.occurrence_type!=='1'||e.amount_cents!==p.amount_cents||e.balance_cents!==p.amount_cents||!e.contact_source_id||!e.refresh_finished_at
    ||p.category_id!==input.category_id||p.category_version!==input.category_version)bad();eligible++;total+=BigInt(p.amount_cents);expiries.push(Date.parse(e.refresh_finished_at)+3600000);}
  return{...pick(row,['source_id','source_hash','source_version','source_seen_at','status']),blockers:[...row.blockers],evidence:pick(e,['status_code','amount_cents','balance_cents','occurrence_type','contact_source_id','refresh_finished_at']),proposed:p,existing:old};
 });
 const all=eligible===items.length;if(v.can_apply!==all||(all?Date.parse(v.valid_until)!==Math.min(...expiries):v.valid_until!==null)
  ||v.summary.selected!==items.length||v.summary.eligible!==eligible||v.summary.blocked!==items.length-eligible||v.summary.total_cents!==total.toString())bad();
 return{...COMMON,...pick(v,['dry_run','persisted','entity','duplicate_reviewed','preview_hash','valid_until','can_apply']),items,summary:pick(v.summary,['selected','eligible','blocked','total_cents'])};
}
function receipt(v,route){
 if(!object(v)||!uuid(v.id)||v.id!==route.args.p_command_id||!ENTITIES.includes(v.entity)||!time(v.created_at)||!hash(v.preview_hash)||v.duplicate_reviewed!==true
  ||!Array.isArray(v.items)||!v.items.length||v.items.length>25||!cents(v.total_cents,24999999999999975n,false))bad();
 if(route.type==='apply'&&(v.entity!==route.args.p_entity||v.preview_hash!==route.args.p_preview_hash||v.items.length!==route.args.p_items.length))bad();
 const seen=new Set(),titles=new Set();let total=0n;
 const items=v.items.map((i,index)=>{
  if(!object(i)||!sourceId(i.source_id)||seen.has(i.source_id)||!uuid(i.title_id)||titles.has(i.title_id)||!hash(i.source_hash)||!sourceVersion(i.source_version)||!time(i.source_seen_at)||!time(i.refresh_finished_at)
   ||!uuid(i.contact_id)||!version(i.contact_version)||i.kind!==kind(v.entity)||!text(i.description,240)||!i.description.trim()||i.source_reference!==reference(v.entity,i.source_id)
   ||!date(i.issued_on)||!date(i.due_on)||i.due_on<i.issued_on||!cents(i.amount_cents,999999999999999n,false))bad();
  category(i);if(route.type==='apply'&&['source_id','source_hash','source_version','source_seen_at','category_id','category_version'].some(k=>i[k]!==route.args.p_items[index][k]))bad();
  seen.add(i.source_id);titles.add(i.title_id);total+=BigInt(i.amount_cents);
  return pick(i,['source_id','title_id','source_hash','source_version','source_seen_at','refresh_finished_at','contact_id','contact_version','category_id','category_version','kind','description','source_reference','issued_on','due_on','amount_cents']);
 });
 if(v.total_cents!==total.toString())bad();return{...pick(v,['id','entity','created_at','preview_hash','duplicate_reviewed','total_cents']),items};
}
function currentTitle(v){
 if(!object(v)||!uuid(v.id)||!version(v.version)||!['receivable','payable'].includes(v.kind)||!uuid(v.contact_id)||!nullable(v.category_id,uuid)
  ||!nativeText(v.description,240)||!nullable(v.source_reference,x=>text(x,200))||!date(v.issued_on)||!nativeDate(v.due_on)||v.due_on<v.issued_on
  ||!cents(v.amount_cents,999999999999999n,false)||!cents(v.settled_cents)||!cents(v.balance_cents)||BigInt(v.amount_cents)!==BigInt(v.settled_cents)+BigInt(v.balance_cents)
  ||typeof v.cancelled!=='boolean'||v.status!==(v.cancelled?'cancelled':v.settled_cents==='0'?'open':v.balance_cents==='0'?'paid':'partial'))bad();
 return pick(v,['id','version','kind','contact_id','category_id','description','source_reference','issued_on','due_on','amount_cents','settled_cents','balance_cents','cancelled','status']);
}
export function financialImportResponse(v,route){
 if(!object(v))bad();
 if(route.type==='title_origin'){
  if(v.data_mode!=='erp_native'||v.read_only!==true||v.title_id!==route.args.p_title_id||!Object.hasOwn(v,'origin'))bad();
  const o=v.origin;if(o!==null&&(!object(o)||o.system!=='origin'||!ENTITIES.includes(o.entity)||!sourceId(o.source_id)||!uuid(o.batch_id)||!time(o.imported_at)||!hash(o.source_hash)||!sourceVersion(o.source_version)||o.core_fields_locked!==true||o.cnab_reservation_blocked!==true))bad();
  return{data_mode:'erp_native',read_only:true,title_id:v.title_id,origin:o===null?null:pick(o,['system','entity','source_id','batch_id','imported_at','source_hash','source_version','core_fields_locked','cnab_reservation_blocked'])};
 }
 if(Object.entries(COMMON).some(([k,value])=>v[k]!==value))bad();
 if(route.type==='preview')return preview(v,route);
 if(route.type==='apply'){
  if(v.dry_run!==false||v.persisted!==true||typeof v.replayed!=='boolean')bad();return{...COMMON,dry_run:false,persisted:true,replayed:v.replayed,batch:receipt(v.batch,route)};
 }
 if(v.read_only!==true)bad();
 if(route.type==='batch'){
  const batch=receipt(v.batch,route);if(!Array.isArray(v.current_titles)||v.current_titles.length!==batch.items.length)bad();
  const current_titles=v.current_titles.map((t,index)=>{const current=currentTitle(t),old=batch.items[index];if(current.id!==old.title_id||['kind','contact_id','issued_on','amount_cents','source_reference'].some(k=>current[k]!==old[k]))bad();return current;});
  return{...COMMON,read_only:true,batch,current_titles};
 }
 const o=v.origin;if(!object(o)||o.entity!==route.args.p_entity||o.source_id!==route.args.p_source_id||!uuid(o.title_id)||!uuid(o.batch_id)||!time(o.imported_at)||!hash(o.source_hash)||!sourceVersion(o.source_version)||!time(o.source_seen_at)||!time(o.refresh_finished_at))bad();
 const current=currentTitle(v.current_title);if(current.id!==o.title_id||current.kind!==kind(o.entity)||current.source_reference!==reference(o.entity,o.source_id))bad();
 return{...COMMON,read_only:true,origin:pick(o,['entity','source_id','title_id','batch_id','imported_at','source_hash','source_version','source_seen_at','refresh_finished_at']),current_title:current};
}
export async function executeFinancialImportRoute(route,{userId,rpc}){
 if(!uuid(userId))fail(403,'ERP_FORBIDDEN');
 const result=financialImportResponse(await rpc(route.rpc,{p_user_id:userId.toLowerCase(),...route.args}),route);
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>FINANCIAL_IMPORT_RESPONSE_BYTES)bad();return result;
}
