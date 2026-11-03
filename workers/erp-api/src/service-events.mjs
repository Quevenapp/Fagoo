/** Operator declarations only: no consent proof, commercial transition or ledger mutation. */
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/,SEQ=/^[1-9][0-9]{0,9}$/;
export const SERVICE_EVENTS_RESPONSE_BYTES=1024*1024;
const MAX_BODY=65536,ROUTES=new WeakSet(),TYPES=['reception','customer_decision','delivery'];
const STATES=['open','quoted','service_done','finalized','rejected','approved','in_progress','waiting_parts','no_repair','cancelled'];
const FLAGS={scope:'service_order_events',data_mode:'erp_native',signature_verified:false,consent_verified:false,changes_document_status:false,financial_mutation_performed:false,stock_mutation_performed:false};
const SPACE=' \\t\\r\\n\\u00a0\\u1680\\u2000-\\u200b\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff',TRIM=new RegExp(`^[${SPACE}]+|[${SPACE}]+$`,'g');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),sequence=v=>typeof v==='string'&&SEQ.test(v),version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const hash=v=>typeof v==='string'&&SHA.test(v),amount=v=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(v);
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const normalized=v=>v===null?null:typeof v==='string'?(v.replace(TRIM,'')||null):undefined;
export class ServiceEventsError extends Error{constructor(status,code){super(code);this.name='ServiceEventsError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new ServiceEventsError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
function text(v,max,required=false,multiline=false){
 const value=normalized(v);return value!==undefined&&(!required||value!==null)&&(value===null||Array.from(value).length<=max&&!/[<>]/.test(value)&&!(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/:/[\x00-\x1f\x7f-\x9f]/).test(value));
}
const exposedText=(v,max,nullable=false)=>v===null?nullable:typeof v==='string'&&Array.from(v).length>=1&&Array.from(v).length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(v);
function date(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2099-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const m=/([+-])(\d{2}):(\d{2})$/.exec(v),offset=m?(m[1]==='+'?1:-1)*(Number(m[2])*60+Number(m[3])):0;
 return (!m||Number(m[2])<=14&&Number(m[3])<=59&&(m[2]!=='14'||m[3]==='00'))&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+offset*60000).toISOString().slice(0,19)===v.slice(0,19);
}
function details(v,type){
 if(type==='reception')return exact(v,['accessories','apparent_condition'])&&text(v.accessories,1000,false,true)&&text(v.apparent_condition,1000,true,true);
 if(type==='delivery')return exact(v,['delivered_condition','tests_summary'])&&text(v.delivered_condition,1000,true,true)&&text(v.tests_summary,1000,false,true);
 return type==='customer_decision'&&exact(v,['decision','channel'])&&['approved','rejected'].includes(v.decision)&&['in_person','phone','email','message','document','other'].includes(v.channel);
}
function input(v){
 if(!exact(v,['type','occurred_on','declarant_name','declarant_role','details','notes','attachment_id','corrects_event_id','correction_reason','confirm_record'])
  ||!TYPES.includes(v.type)||!date(v.occurred_on)||!text(v.declarant_name,200,true)||!['customer','representative','other'].includes(v.declarant_role)
  ||!details(v.details,v.type)||!text(v.notes,2000,false,true)||!(v.attachment_id===null||id(v.attachment_id))||!(v.corrects_event_id===null||id(v.corrects_event_id))
  ||!text(v.correction_reason,1000,v.corrects_event_id!==null,true)||v.confirm_record!==true)fail();
 const reason=normalized(v.correction_reason);if(v.corrects_event_id===null?reason!==null:reason===null||Array.from(reason).length<3)fail();
}
function normalizeData(v){return{...v,declarant_name:normalized(v.declarant_name),notes:normalized(v.notes),correction_reason:normalized(v.correction_reason),attachment_id:v.attachment_id?.toLowerCase()??null,corrects_event_id:v.corrects_event_id?.toLowerCase()??null,details:v.type==='customer_decision'?{...v.details}:Object.fromEntries(Object.entries(v.details).map(([k,value])=>[k,normalized(value)]))};}
function same(a,b){if(a===b)return true;return object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));}
function freeze(v){if(object(v)||Array.isArray(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function shape(path){const m=/^\/v1\/ordens-servico\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/eventos(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/i.exec(path);return m?{documentId:m[1].toLowerCase(),eventId:m[2]?.toLowerCase()??null}:null;}
export const serviceEventsRoute=path=>typeof path==='string'&&/^\/v1\/ordens-servico\/[^/]+\/eventos(?:\/|$)/.test(path);
export const serviceEventsMethods=path=>{const s=shape(path);return s?(s.eventId?['GET']:['GET','POST']):null;};
async function body(request){
 if(!request.body||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))fail();
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,source='',timer,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;timer=setTimeout(()=>reject(new ServiceEventsError(408,'ERP_BODY_TIMEOUT')),5000);});
 const abort=()=>rejectStop(new ServiceEventsError(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{for(;;){if(request.signal.aborted)abort();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(size+=part.value.length)>MAX_BODY)fail(413,'ERP_BODY_TOO_LARGE');source+=decoder.decode(part.value,{stream:true});}
  if(declared!==null&&Number(declared)!==size)fail();return JSON.parse(source+decoder.decode());
 }catch(error){if(error instanceof ServiceEventsError)throw error;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export async function parseServiceEventsRoute(request){
 const url=new URL(request.url);if(!serviceEventsRoute(url.pathname))return null;
 const selected=shape(url.pathname);if(!selected)fail(404,'ERP_NOT_FOUND');if(!serviceEventsMethods(url.pathname).includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')fail();
 const args={p_document_id:selected.documentId};let type;
 if(request.method==='GET'){
  if(request.body!==null)fail();if(selected.eventId){if(url.search)fail();type='get';args.p_event_id=selected.eventId;}
  else{for(const k of url.searchParams.keys())if(!['limit','before'].includes(k)||url.searchParams.getAll(k).length!==1)fail();
   const limit=url.searchParams.get('limit')??'25',before=url.searchParams.get('before');if(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25||before!==null&&!sequence(before))fail();type='list';args.p_limit=Number(limit);args.p_before=before;}
 }else{
  if(url.search)fail();const v=await body(request);if(!exact(v,['command_id','expected_document_version','data'])||!id(v.command_id)||!version(v.expected_document_version))fail();input(v.data);
  type='append';Object.assign(args,{p_command_id:v.command_id.toLowerCase(),p_expected_document_version:v.expected_document_version,p_data:v.data});
 }
 const route=freeze({type,rpc:'erp_service_event_'+type,args});ROUTES.add(route);return route;
}
function allowed(status){return status==='cancelled'?[]:['reception',...(['quoted','approved','rejected'].includes(status)?['customer_decision']:[]),...(['service_done','finalized','no_repair'].includes(status)?['delivery']:[])];}
function attachment(v){
 if(v===null)return null;const extensions={'application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','application/xml':'xml','text/plain':'txt'};
 if(!object(v)||!id(v.id)||!Object.hasOwn(extensions,v.mime_type)||!Number.isInteger(v.size_bytes)||v.size_bytes<1||v.size_bytes>10485760||!hash(v.sha256)||typeof v.filename!=='string'||!(new RegExp(`^anexo-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\\.${extensions[v.mime_type]}$`)).test(v.filename))bad();
 return pick(v,['id','filename','mime_type','size_bytes','sha256']);
}
function row(v,document){
 const r=v?.record,c=v?.current,s=r?.snapshot;
 if(!object(r)||!id(r.id)||r.document_id!==document.id||!sequence(r.sequence)||!TYPES.includes(r.type)||!version(r.document_version)||r.document_version>document.version||!STATES.includes(r.document_status)||!hash(r.commercial_hash)||!amount(r.total)
  ||!object(s)||s.number!==document.number||!object(s.contact)||!id(s.contact.id)||!exposedText(s.contact.name,200)||!exposedText(s.equipment,4000,true)||!exposedText(s.serial_number,100,true)||!exposedText(s.technician,200,true)
  ||!date(r.occurred_on)||!text(r.declarant_name,200,true)||r.declarant_name!==normalized(r.declarant_name)||!['customer','representative','other'].includes(r.declarant_role)||!details(r.details,r.type)
  ||!text(r.notes,2000,false,true)||r.notes!==normalized(r.notes)||!(r.corrects_event_id===null||id(r.corrects_event_id))||!text(r.correction_reason,1000,r.corrects_event_id!==null,true)||r.correction_reason!==normalized(r.correction_reason)||!id(r.actor_id)||!stamp(r.recorded_at))bad();
 if(!allowed(r.document_status).includes(r.type)||r.document_version===document.version&&(r.document_status!==document.status||r.commercial_hash!==document.commercial_hash||r.total!==document.total))bad();
 if(r.corrects_event_id===null?r.correction_reason!==null:Array.from(r.correction_reason).length<3||r.corrects_event_id===r.id)bad();
 const a=attachment(r.attachment),d=r.type==='customer_decision'?pick(r.details,['decision','channel']):Object.fromEntries(Object.entries(r.details).map(([k,value])=>{if(value!==normalized(value))bad();return[k,value];}));
 if(!object(c)||c.document_version!==document.version||c.document_status!==document.status||c.document_version_changed!==(r.document_version!==document.version)||c.commercial_content_changed!==(r.commercial_hash!==document.commercial_hash)||c.total_changed!==(r.total!==document.total)
  ||!(c.corrected_by_event_id===null||id(c.corrected_by_event_id))||c.corrected_by_event_id===r.id||typeof c.approval_basis_matches_current!=='boolean')bad();
 // The latest decision is a database fact; false cannot be upgraded by this boundary.
 if(c.approval_basis_matches_current&&(r.type!=='customer_decision'||d.decision!=='approved'||c.document_version_changed||c.commercial_content_changed||c.total_changed||c.corrected_by_event_id!==null||document.status==='cancelled'))bad();
 return{record:{...pick(r,['id','document_id','sequence','type','document_version','document_status','commercial_hash','total','occurred_on','declarant_name','declarant_role','notes','corrects_event_id','correction_reason','actor_id','recorded_at']),
  snapshot:{number:s.number,contact:pick(s.contact,['id','name']),...pick(s,['equipment','serial_number','technician'])},details:d,attachment:a},current:pick(c,['document_version','document_status','document_version_changed','commercial_content_changed','total_changed','corrected_by_event_id','approval_basis_matches_current'])};
}
export function serviceEventsResponse(raw,route,actor){
 const d=raw?.document;if(!object(raw)||Object.entries(FLAGS).some(([k,v])=>raw[k]!==v)||!object(d)||d.id!==route.args.p_document_id||d.kind!=='service_orders'||!sequence(d.number)||!version(d.version)||!STATES.includes(d.status)||!amount(d.total)||!hash(d.commercial_hash)||typeof raw.can_record!=='boolean'||!Array.isArray(raw.allowed_event_types))bad();
 const types=raw.can_record?allowed(d.status):[];if(raw.allowed_event_types.length!==types.length||raw.allowed_event_types.some((v,i)=>v!==types[i])||d.status==='cancelled'&&raw.can_record)bad();
 const document=pick(d,['id','kind','number','version','status','total','commercial_hash']),base={...FLAGS,document,can_record:raw.can_record,allowed_event_types:[...types]};
 if(route.type==='list'){
  if(raw.read_only!==true||raw.limit!==route.args.p_limit||!Array.isArray(raw.items)||raw.items.length>raw.limit||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==raw.limit)bad();
  let previous=BigInt(route.args.p_before??'10000000000');const ids=new Set(),items=raw.items.map(v=>{const item=row(v,document);if(BigInt(item.record.sequence)>=previous||ids.has(item.record.id))bad();previous=BigInt(item.record.sequence);ids.add(item.record.id);return item;});
  const next=raw.has_more?items.at(-1).record.sequence:null;if(raw.next_before!==next)bad();return{...base,read_only:true,items,limit:raw.limit,has_more:raw.has_more,next_before:next};
 }
 const item=row(raw,document),r=item.record;
 if(route.type==='get'){if(raw.read_only!==true||r.id!==route.args.p_event_id)bad();return{...base,read_only:true,...item};}
 const p=normalizeData(route.args.p_data);
 if(typeof raw.replayed!=='boolean'||r.actor_id!==actor||r.document_version!==route.args.p_expected_document_version||['type','occurred_on','declarant_name','declarant_role','notes','corrects_event_id','correction_reason'].some(k=>r[k]!==p[k])||!same(r.details,p.details)||(r.attachment?.id??null)!==p.attachment_id)bad();
 if(!raw.replayed&&(!raw.can_record||document.version!==r.document_version||!types.includes(r.type)))bad();
 return{...base,...item,replayed:raw.replayed};
}
function mapped(error,mutating,started){
 if(error instanceof ServiceEventsError)throw error;
 const codes={42501:[403,'ERP_FORBIDDEN'],22023:[400,'ERP_INVALID_QUERY'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],54000:[409,'ERP_SERVICE_EVENT_LIMIT']};
 if(Object.hasOwn(codes,error?.code))fail(...codes[error.code]);
 if(error?.status===409&&error.code==='ERP_SERVICE_EVENT_LIMIT')fail(409,'ERP_SERVICE_EVENT_LIMIT');
 if([400,401,403,404,409].includes(error?.status))fail(error.status,({400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHORIZED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT'})[error.status]);
 fail(mutating&&started?503:502,mutating&&started?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_UNAVAILABLE');
}
export async function executeServiceEventsRoute(route,{userId,rpc,signal,timeoutMs=15000}={}){
 if(!route||!ROUTES.has(route))fail(404,'ERP_NOT_FOUND');if(!id(userId))fail(401,'ERP_UNAUTHORIZED');if(typeof rpc!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||signal!==undefined&&!(signal instanceof AbortSignal))bad();
 const actor=userId.toLowerCase(),controller=new AbortController();let timer,rejectStop,started=false;
 const interrupted=()=>new ServiceEventsError(started&&route.type==='append'?503:400,started&&route.type==='append'?'ERP_RESULT_UNCONFIRMED':'ERP_REQUEST_ABORTED');
 const stopped=new Promise((_,reject)=>{rejectStop=reject;timer=setTimeout(()=>{controller.abort();reject(new ServiceEventsError(503,started&&route.type==='append'?'ERP_RESULT_UNCONFIRMED':'ERP_UPSTREAM_TIMEOUT'));},timeoutMs);});
 const abort=()=>{controller.abort();rejectStop(interrupted());};signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw interrupted();const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw interrupted();started=true;return rpc(route.rpc,{...route.args,p_user_id:actor},{signal:controller.signal});}),stopped]);
  if(controller.signal.aborted)throw interrupted();const result=serviceEventsResponse(raw,route,actor);if(new TextEncoder().encode(JSON.stringify(result)).length>SERVICE_EVENTS_RESPONSE_BYTES)bad();return result;
 }catch(error){mapped(error,route.type==='append',started);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
