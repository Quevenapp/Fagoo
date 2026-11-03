/** Public configuration/read-only boundary. Runtime dispatch/finalize RPCs are deliberately absent. */
import {inspectAccessKey} from '../../../packages/fiscal-core/src/identity.mjs';
import {DfeSummaryError,readReceivedSummary} from '../../../packages/fiscal-xml/src/dfe-summary.mjs';

const BASE='/v1/notas-recebidas',BUCKET='brufap-received-dfe',MAX_BYTES=8388608,MAX_BODY=8192;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,SHA=/^[a-f0-9]{64}$/,NSU=/^[0-9]{15}$/;
const KINDS=['invoice_summary','invoice','event_summary','event','unsupported'];
const FLAGS=Object.freeze({data_mode:'received_dfe',model:'55',transport_enabled:false,can_query:false,can_manifest:false,can_emit:false,origin_authenticated:false,signature_verified:false,xsd_validated:false,sefaz_authorized:false,financial_mutation_performed:false,stock_mutation_performed:false});
const routes=new WeakSet();
export class DfeDistributionError extends Error{constructor(status,code){super(code);this.name='DfeDistributionError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new DfeDistributionError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&UUID.test(v);
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const nullable=(v,test)=>v===null||test(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const nsu=v=>typeof v==='string'&&NSU.test(v);
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const[y,m,d,h,minute,s]=v.slice(0,19).split(/[-T:]/).map(Number),off=v.endsWith('Z')?[0,0]:v.slice(-5).split(':').map(Number);
 return y>=2000&&m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<=23&&minute<=59&&s<=59&&off[0]<=14&&off[1]<=59&&(off[0]!==14||off[1]===0)&&Number.isFinite(Date.parse(v));
}
const reason=v=>typeof v==='string'&&Array.from(v).length>=3&&Array.from(v).length<=240&&v.trim().length>0&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
function readonly(v){if(v&&typeof v==='object'){for(const x of Object.values(v))readonly(x);Object.freeze(v);}return v;}
function routeShape(path){
 if(path===`${BASE}/settings`)return{type:'settings',methods:['GET','POST']};
 if(path===`${BASE}/documents`)return{type:'documents',methods:['GET']};
 // Leva H (NFE-212, 202610210359): the stored readings of a page and the reading of one document from its checked bytes.
 if(path===`${BASE}/summaries`)return{type:'summaries',methods:['GET']};
 let m=new RegExp(`^${BASE}/documents/([a-fA-F0-9-]+)/download$`).exec(path);if(m&&id(m[1]))return{type:'download',documentId:m[1].toLowerCase(),methods:['GET']};
 m=new RegExp(`^${BASE}/documents/([a-fA-F0-9-]+)/summary$`).exec(path);if(m&&id(m[1]))return{type:'summary',documentId:m[1].toLowerCase(),methods:['POST']};
 m=new RegExp(`^${BASE}/commands/([a-fA-F0-9-]+)$`).exec(path);if(m&&id(m[1]))return{type:'command',commandId:m[1].toLowerCase(),methods:['GET']};return null;
}
export const dfeDistributionMethods=path=>routeShape(path)?.methods??null;
async function jsonBody(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body)fail();
 const declared=request.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let timer,size=0,text='';
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new DfeDistributionError(408,'ERP_BODY_TIMEOUT')),5000);});
 try{while(true){if(request.signal.aborted)fail(400,'ERP_REQUEST_ABORTED');const part=await Promise.race([reader.read(),timeout]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(size+=part.value.length)>MAX_BODY)fail(413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode());}
 catch(e){if(e instanceof DfeDistributionError)throw e;fail();}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** The parsing boundary never accepts a user ID, URL, XML, Storage path or runtime action. */
export async function parseDfeDistributionRoute(request){
 const url=new URL(request.url);if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return null;
 const shape=routeShape(url.pathname);if(!shape)fail(404,'ERP_NOT_FOUND');if(!shape.methods.includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')fail();
 const query=url.searchParams,allowed=shape.type==='settings'&&request.method==='GET'?['environment']:shape.type==='documents'?['channel_id','kind','limit','after']:shape.type==='summaries'?['channel_id','ids']:[];
 for(const k of query.keys())if(!allowed.includes(k)||query.getAll(k).length!==1)fail();
 let route;
 if(shape.type==='settings'&&request.method==='GET'){
  const environment=query.get('environment');if(!['1','2'].includes(environment))fail();route={type:'settings',args:{p_environment:environment}};
 }else if(shape.type==='settings'){
  const v=await jsonBody(request),keys=['command_id','environment','expected_version','expected_identity_version','coordinator','checkpoint','checkpoint_confirmed','other_consumers_reviewed','collection_requested','reason'];
  if(!exact(v,keys)||!id(v.command_id)||!['1','2'].includes(v.environment)||!version(v.expected_version,0)||v.expected_version===2147483647||!version(v.expected_identity_version)||!['unconfirmed','external','brufap'].includes(v.coordinator)||!nullable(v.checkpoint,nsu)||typeof v.checkpoint_confirmed!=='boolean'||typeof v.other_consumers_reviewed!=='boolean'||typeof v.collection_requested!=='boolean'||!reason(v.reason)||v.checkpoint_confirmed&&v.checkpoint===null||v.collection_requested&&(v.coordinator!=='brufap'||!v.checkpoint_confirmed||!v.other_consumers_reviewed))fail();
  route={type:'configure',commandId:v.command_id.toLowerCase(),args:{p_command_id:v.command_id.toLowerCase(),p_environment:v.environment,p_expected_version:v.expected_version,p_expected_identity_version:v.expected_identity_version,p_coordinator:v.coordinator,p_checkpoint:v.checkpoint,p_checkpoint_confirmed:v.checkpoint_confirmed,p_other_consumers_reviewed:v.other_consumers_reviewed,p_collection_requested:v.collection_requested,p_reason:v.reason}};
 }else if(shape.type==='documents'){
  const channel=query.get('channel_id'),kind=query.get('kind'),limit=query.get('limit'),after=query.get('after');if(!id(channel)||kind!==null&&!KINDS.includes(kind)||limit!==null&&(!/^[1-9]\d?$/.test(limit)||Number(limit)>50)||after!==null&&!id(after))fail();
  route={type:'documents',args:{p_channel_id:channel.toLowerCase(),p_kind:kind,p_limit:limit===null?25:Number(limit),p_after:after?.toLowerCase()??null}};
 }else if(shape.type==='summaries'){
  const channel=query.get('channel_id'),raw=query.get('ids');if(!id(channel)||raw===null)fail();
  const ids=raw.split(',');if(!ids.length||ids.length>50||ids.some(v=>!id(v)))fail();const unique=[...new Set(ids.map(v=>v.toLowerCase()))];
  route={type:'summaries',args:{p_channel_id:channel.toLowerCase(),p_document_ids:unique}};
 }else if(shape.type==='summary'){
  // The body is empty ({}): the reading comes only from the stored bytes, never from the browser.
  const v=await jsonBody(request);if(!exact(v,[]))fail();route={type:'summary',documentId:shape.documentId,args:{p_document_id:shape.documentId}};
 }else route=shape.type==='download'?{type:'download',args:{p_document_id:shape.documentId}}:{type:'command',commandId:shape.commandId,args:{p_command_id:shape.commandId}};
 readonly(route);routes.add(route);return route;
}
function flags(v){if(!object(v)||Object.entries(FLAGS).some(([k,x])=>v[k]!==x))bad();return v;}
function channel(v){
 if(!object(v)||!id(v.id)||!['1','2'].includes(v.environment)||!version(v.identity_version)||!version(v.version)||!['unconfirmed','external','brufap'].includes(v.coordinator)||typeof v.other_consumers_reviewed!=='boolean'||!nullable(v.checkpoint,nsu)||typeof v.checkpoint_confirmed!=='boolean'||typeof v.collection_requested!=='boolean'||typeof v.paused!=='boolean'||!nullable(v.active_attempt_id,id)||!nullable(v.not_before,stamp)||!stamp(v.updated_at)||typeof v.company_changed!=='boolean'||v.checkpoint_confirmed&&v.checkpoint===null||v.collection_requested&&(v.coordinator!=='brufap'||!v.checkpoint_confirmed||!v.other_consumers_reviewed))bad();
 return{id:v.id.toLowerCase(),environment:v.environment,identity_version:v.identity_version,version:v.version,coordinator:v.coordinator,other_consumers_reviewed:v.other_consumers_reviewed,checkpoint:v.checkpoint,checkpoint_confirmed:v.checkpoint_confirmed,collection_requested:v.collection_requested,paused:v.paused,has_active_attempt:v.active_attempt_id!==null,not_before:v.not_before,updated_at:v.updated_at,company_changed:v.company_changed};
}
function settings(v,route){flags(v);const current=v.current===null?null:channel(v.current);if(current&&current.environment!==route.args.p_environment)bad();return{...FLAGS,current};}
function command(v,route){
 flags(v);if(v.action!=='configure')fail(404,'ERP_NOT_FOUND');if(v.command_id!==route.commandId||v.state!=='committed'||typeof v.replayed!=='boolean')bad();
 const receipt=channel(v.receipt),current=channel(v.current);if(receipt.id!==current.id||receipt.environment!==current.environment||current.version<receipt.version||receipt.has_active_attempt)bad();
 if(route.type==='configure'){
  const p=route.args;if(receipt.version!==p.p_expected_version+1||receipt.identity_version!==p.p_expected_identity_version||receipt.environment!==p.p_environment||receipt.coordinator!==p.p_coordinator||receipt.checkpoint!==p.p_checkpoint||receipt.checkpoint_confirmed!==p.p_checkpoint_confirmed||receipt.other_consumers_reviewed!==p.p_other_consumers_reviewed||receipt.collection_requested!==p.p_collection_requested||receipt.paused)bad();
 }
 return{...FLAGS,command_id:route.commandId,action:'configure',state:'committed',receipt,current,replayed:v.replayed};
}
function document(v){
 if(!object(v)||!id(v.id)||!id(v.channel_id)||!nullable(v.nsu,nsu)||!KINDS.includes(v.kind)||typeof v.schema!=='string'||v.schema.length>100||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\.xsd$/.test(v.schema)||!nullable(v.recipient_match,x=>typeof x==='boolean')||typeof v.quarantined!=='boolean'||typeof v.xml_hash!=='string'||!SHA.test(v.xml_hash)||!Number.isInteger(v.size_bytes)||v.size_bytes<1||v.size_bytes>MAX_BYTES||!stamp(v.collected_at)||v.is_complete_invoice!==(v.kind==='invoice'))bad();
 const expected={'resNFe_v1.00.xsd':'invoice_summary','resNFe_v1.01.xsd':'invoice_summary','resEvento_v1.00.xsd':'event_summary','resEvento_v1.01.xsd':'event_summary','procNFe_v3.10.xsd':'invoice','procNFe_v4.00.xsd':'invoice','procEventoNFe_v1.00.xsd':'event'};
 if(v.kind!==(Object.hasOwn(expected,v.schema)?expected[v.schema]:'unsupported')||v.quarantined!==(v.kind==='unsupported')||v.kind!=='invoice'&&v.recipient_match!==null)bad();
 if(v.kind==='unsupported'){if(v.access_key!==null||v.model!==null||v.recipient_match!==null)bad();}else{const inspected=inspectAccessKey(v.access_key);if(!inspected.valid||inspected.parts.model!=='55'||v.model!=='55')bad();}
 return{id:v.id.toLowerCase(),channel_id:v.channel_id.toLowerCase(),nsu:v.nsu,kind:v.kind,schema:v.schema,model:v.model,access_key:v.access_key,recipient_match:v.recipient_match,quarantined:v.quarantined,xml_hash:v.xml_hash,size_bytes:v.size_bytes,collected_at:v.collected_at,is_complete_invoice:v.is_complete_invoice};
}
function documents(v,route){
 flags(v);const p=route.args;if(v.channel_id!==p.p_channel_id||v.limit!==p.p_limit||!Array.isArray(v.items)||v.items.length>p.p_limit||typeof v.has_more!=='boolean'||v.has_more&&v.items.length!==p.p_limit)bad();
 const items=v.items.map(document);let previous=p.p_after;for(const d of items){if(d.channel_id!==p.p_channel_id||previous!==null&&d.id<=previous||p.p_kind!==null&&d.kind!==p.p_kind)bad();previous=d.id;}
 const next=v.has_more?previous:null;if(v.next_cursor!==next)bad();return{...FLAGS,channel_id:p.p_channel_id,items,limit:p.p_limit,has_more:v.has_more,next_cursor:next};
}
function metadata(v,expectedId){
 flags(v);const d=document(v.document);if(d.id!==expectedId||v.bucket!==BUCKET||v.object_key!==`objects/${d.xml_hash}.xml`)bad();
 const prefix=d.kind==='invoice'?'NFE_':d.kind==='invoice_summary'?'RESUMO_NFE_':['event','event_summary'].includes(d.kind)?'EVENTO_NFE_':'QUARENTENA_';if(v.filename!==`${prefix}${d.id}.xml`)bad();
 return{document:d,bucket:BUCKET,object_key:`objects/${d.xml_hash}.xml`,filename:`${prefix}${d.id}.xml`};
}
/** Fixed-size download, one deadline through body+hash+reauthorization, and no public/signed URL. */
async function download(route,ports){
 const{meta,bytes}=await verifiedBytes(route,ports);
 return{type:'download',bytes,filename:meta.filename,headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'Content-Disposition':`attachment; filename="${meta.filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'}};
}
// ---- Leva H (NFE-212, 202610210359): Data emissão, Valor, Fornecedor and CNPJ/CPF of the documents already kept ----
const MONEY=/^(0|[1-9]\d{0,12})\.\d{2}$/;
function summaryRecord(v,documentId=null){
 if(!exact(v,['document_id','issue_date','total','supplier_name','supplier_document','situation'])||!id(v.document_id)||documentId!==null&&v.document_id!==documentId
  ||!nullable(v.issue_date,x=>typeof x==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(x)&&new Date(`${x}T00:00:00Z`).toISOString().slice(0,10)===x)||!nullable(v.total,x=>typeof x==='string'&&MONEY.test(x))
  ||!nullable(v.supplier_name,x=>typeof x==='string'&&Array.from(x).length>=1&&Array.from(x).length<=200&&!/[\x00-\x1f\x7f]/.test(x))||!nullable(v.supplier_document,x=>typeof x==='string'&&/^(\d{11}|\d{14})$/.test(x))
  ||!nullable(v.situation,x=>['1','2','3'].includes(x)))bad();
 return{document_id:v.document_id.toLowerCase(),issue_date:v.issue_date,total:v.total,supplier_name:v.supplier_name,supplier_document:v.supplier_document,situation:v.situation};
}
function summaries(v,route){
 flags(v);if(v.channel_id!==route.args.p_channel_id||!Array.isArray(v.items)||v.items.length>route.args.p_document_ids.length)bad();
 const items=v.items.map(x=>summaryRecord(x));if(items.some(x=>!route.args.p_document_ids.includes(x.document_id))||new Set(items.map(x=>x.document_id)).size!==items.length)bad();
 return{...FLAGS,channel_id:route.args.p_channel_id,items};
}
async function summary(route,ports){
 const{meta,bytes}=await verifiedBytes(route,ports);
 if(!['invoice_summary','invoice'].includes(meta.document.kind))fail(422,'ERP_DFE_SUMMARY_UNAVAILABLE');
 let reading;try{reading=readReceivedSummary(bytes,meta.document);}catch(e){if(e instanceof DfeSummaryError)fail(422,'ERP_DFE_SUMMARY_UNREADABLE');throw e;}
 const v=await ports.rpc('erp_dfe_summary_record',{p_document_id:route.args.p_document_id,p_object_hash:meta.document.xml_hash,p_summary:reading,p_user_id:ports.userId});
 flags(v);if(typeof v.recorded!=='boolean')bad();const stored=summaryRecord(v.summary,route.args.p_document_id);
 // A new reading must be stored exactly as read; an earlier reading of the same immutable bytes stays.
 if(v.recorded&&['issue_date','total','supplier_name','supplier_document','situation'].some(k=>stored[k]!==reading[k]))bad();
 return{...FLAGS,summary:stored,recorded:v.recorded};
}
/** The stored bytes of one document, checked by size and SHA-256 and reauthorized after the read. */
async function verifiedBytes(route,{userId,rpc,fetchObject,timeoutMs}){
 if(typeof fetchObject!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail(500,'ERP_DFE_PORT_UNAVAILABLE');
 const controller=new AbortController();let timer,reader,response,expired=false;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;controller.abort();reject(new DfeDistributionError(504,'ERP_DFE_TIMEOUT'));},timeoutMs);});
 const bounded=p=>Promise.race([p,deadline]);
 const args={p_document_id:route.args.p_document_id,p_user_id:userId};
 try{
  const meta=metadata(await bounded(rpc('erp_dfe_object',args)),args.p_document_id);
  const pending=Promise.resolve().then(()=>{if(expired)throw new DfeDistributionError(504,'ERP_DFE_TIMEOUT');return fetchObject(`/storage/v1/object/authenticated/${BUCKET}/${meta.object_key}`,{signal:controller.signal,redirect:'manual'});});
  try{response=await bounded(pending);}catch(e){void pending.then(late=>late.body?.cancel()).catch(()=>{});throw e;}
  if(!(response instanceof Response)||response.status!==200||response.redirected||!response.body)fail(502,'ERP_DFE_DOWNLOAD_UNAVAILABLE');
  const mime=response.headers.get('content-type'),encoding=response.headers.get('content-encoding'),size=response.headers.get('content-length');
  if(!mime||!/^application\/octet-stream(?:\s*;|$)/i.test(mime)||encoding!==null&&encoding!=='identity'||size!==null&&(!/^\d+$/.test(size)||Number(size)!==meta.document.size_bytes))bad();
  reader=response.body.getReader();const bytes=new Uint8Array(meta.document.size_bytes);let used=0;
  while(true){const part=await bounded(reader.read());if(part.done)break;if(!(part.value instanceof Uint8Array)||used+part.value.length>bytes.length)bad();bytes.set(part.value,used);used+=part.value.length;}
  if(used!==bytes.length)bad();const digest=[...new Uint8Array(await bounded(crypto.subtle.digest('SHA-256',bytes)))].map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==meta.document.xml_hash)fail(502,'ERP_DFE_INTEGRITY_FAILURE');
  const current=metadata(await bounded(rpc('erp_dfe_object',args)),args.p_document_id);if(JSON.stringify(current)!==JSON.stringify(meta))bad();
  return{meta,bytes};
 }finally{clearTimeout(timer);controller.abort();if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}else void response?.body?.cancel().catch(()=>{});}
}
function sqlError(e){if(e instanceof DfeDistributionError)throw e;const mapped={42501:[403,'ERP_FORBIDDEN'],22023:[400,'ERP_INVALID_QUERY'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],55000:[503,'ERP_DFE_STORAGE_UNAVAILABLE'],P0002:[404,'ERP_NOT_FOUND']};if(mapped[e?.code])fail(...mapped[e.code]);if([400,401,403,404,409,503,504].includes(e?.status))fail(e.status,e.status===400?'ERP_INVALID_QUERY':e.status===401?'ERP_UNAUTHORIZED':e.status===403?'ERP_FORBIDDEN':'ERP_DFE_UNAVAILABLE');fail(502,'ERP_DFE_UPSTREAM_UNAVAILABLE');}
export async function executeDfeDistributionRoute(route,{userId,rpc,fetchObject,timeoutMs=20000}){
 if(!id(userId))fail(401,'ERP_UNAUTHORIZED');if(!routes.has(route))fail(404,'ERP_NOT_FOUND');if(typeof rpc!=='function')fail(500,'ERP_DFE_PORT_UNAVAILABLE');userId=userId.toLowerCase();
 try{
  if(route.type==='download')return await download(route,{userId,rpc,fetchObject,timeoutMs});
  if(route.type==='summary')return{type:'json',body:await summary(route,{userId,rpc,fetchObject,timeoutMs})};
  const name={settings:'erp_dfe_settings',configure:'erp_dfe_configure',documents:'erp_dfe_documents',command:'erp_dfe_command',summaries:'erp_dfe_summaries'}[route.type];
  const value=await rpc(name,{...route.args,p_user_id:userId});const body=route.type==='settings'?settings(value,route):route.type==='documents'?documents(value,route):route.type==='summaries'?summaries(value,route):command(value,route);return{type:'json',body};
 }catch(e){sqlError(e);}
}
