/** Explicit document-to-title bridge. No routing integration or credentials in this module. */
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const KINDS=['sales_orders','purchase_orders','service_orders'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export class DocumentFinanceError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new DocumentFinanceError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new DocumentFinanceError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const exact=(v,keys)=>{if(!object(v)||Object.keys(v).some(key=>!keys.includes(key)))invalid();};
const version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const id=v=>typeof v==='string'&&UUID.test(v);
const cents=v=>typeof v==='string'&&/^[0-9]{1,15}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
function day(v){if(!text(v,10)||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01'||v>'2100-12-31')return false;const date=new Date(`${v}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===v;}
const date=v=>text(v,100)&&Number.isFinite(Date.parse(v));
async function readBody(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body||Number(request.headers.get('content-length'))>65536)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,input='';
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)invalid();input+=decoder.decode(value,{stream:true});}return JSON.parse(input+decoder.decode());}
 catch{return invalid();}finally{try{await reader.cancel();}catch{/* No financial input logging. */}reader.releaseLock();}
}
function plan(value){
 if(value===undefined||value===null)return null;
 if(!Array.isArray(value)||!value.length||value.length>120)invalid();
 for(const part of value){exact(part,['amount_cents','due_on','method']);if(!cents(part.amount_cents)||BigInt(part.amount_cents)<=0n||!day(part.due_on)||(part.method!==undefined&&part.method!==null&&!text(part.method,100)))invalid();}
 return value;
}
export function documentFinanceMethods(path){return /\/(preview|post|reverse-preview|reverse)$/.test(path)?['POST']:['GET'];}
export async function parseDocumentFinanceRoute(request){
 const url=new URL(request.url);
 if(!/^\/v1\/documentos\/[^/]+\/[^/]+\/financeiro(?:\/|$)/.test(url.pathname))return null;
 const match=/^\/v1\/documentos\/(sales_orders|purchase_orders|service_orders)\/([a-f0-9-]+)\/financeiro(?:\/(preview|post|[a-f0-9-]+)(?:\/(reverse-preview|reverse))?)?$/i.exec(url.pathname);
 if(!match||!KINDS.includes(match[1])||!id(match[2]))throw new DocumentFinanceError(404,'ERP_NOT_FOUND');
 const [kind,documentId,segment,reverseAction]=match.slice(1),postingId=segment&&!['preview','post'].includes(segment)?segment.toLowerCase():null;
 if((postingId&&!id(postingId))||(reverseAction&&!postingId))throw new DocumentFinanceError(404,'ERP_NOT_FOUND');
 if(!documentFinanceMethods(url.pathname).includes(request.method))throw new DocumentFinanceError(405,'ERP_METHOD_NOT_ALLOWED');
 const args={p_kind:kind,p_document_id:documentId.toLowerCase()};
 if(request.method==='GET'){
  if(postingId){if(url.search)invalid();return {operation:'get',rpc:'erp_document_finance_get',args:{...args,p_posting_id:postingId}};}
  for(const key of url.searchParams.keys())if(!['limit','after'].includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  const limit=url.searchParams.get('limit')??'25',after=url.searchParams.get('after');if(!/^\d{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(after!==null&&!id(after)))invalid();
  return {operation:'list',rpc:'erp_document_finance_list',args:{...args,p_limit:Number(limit),p_after:after?.toLowerCase()??null}};
 }
 if(url.search)invalid();const input=await readBody(request),operation=reverseAction||segment;
 if(!['preview','post','reverse-preview','reverse'].includes(operation))throw new DocumentFinanceError(405,'ERP_METHOD_NOT_ALLOWED');
 exact(input,operation==='preview'?['expected_document_version','category_id','installments']:operation==='post'?['expected_document_version','category_id','installments','command_id','preview_hash']
  :operation==='reverse-preview'?['expected_document_version','expected_posting_version']:['expected_document_version','expected_posting_version','command_id','preview_hash','title_versions','reason']);
 if(!version(input.expected_document_version))invalid();args.p_expected_version=input.expected_document_version;
 if(['preview','post'].includes(operation)){
  if(input.category_id!==undefined&&input.category_id!==null&&!id(input.category_id))invalid();args.p_category_id=input.category_id?.toLowerCase()??null;args.p_plan=plan(input.installments);
 }else{if(!version(input.expected_posting_version))invalid();args.p_posting_id=postingId;args.p_posting_version=input.expected_posting_version;}
 if(['post','reverse'].includes(operation)){
  if(!id(input.command_id)||typeof input.preview_hash!=='string'||!HASH.test(input.preview_hash))invalid();args.p_command_id=input.command_id.toLowerCase();args.p_preview_hash=input.preview_hash;
 }
 if(operation==='reverse'){
  if(!text(input.reason,1000)||input.reason.trim().length<3||!Array.isArray(input.title_versions)||!input.title_versions.length||input.title_versions.length>120)invalid();
  const seen=new Set();for(const row of input.title_versions){exact(row,['id','version']);if(!id(row.id)||!version(row.version)||seen.has(row.id.toLowerCase()))invalid();seen.add(row.id.toLowerCase());}
  args.p_reason=input.reason;args.p_title_versions=input.title_versions.map(row=>({id:row.id.toLowerCase(),version:row.version}));
 }
 return {operation,rpc:`erp_document_finance_${operation.replace('-','_')}`,args};
}
function posting(value){
 if(!object(value)||!id(value.id)||!id(value.document_id)||!id(value.group_id)||!version(value.source_document_version)||!version(value.version)
  ||!['active','reversed'].includes(value.state)||!KINDS.includes(value.kind)||!text(value.number,10)||!/^\d+$/.test(value.number)
  ||value.direction!==(value.kind==='purchase_orders'?'payable':'receivable')||!cents(value.total_cents)||BigInt(value.total_cents)<=0n||!Number.isInteger(value.installments)||value.installments<1||value.installments>120
  ||!['document','explicit'].includes(value.plan_source)||!date(value.created_at)||(value.reversed_at!==null&&!date(value.reversed_at))||(value.reason!==null&&!text(value.reason,1000))
  ||(value.state==='active'?(value.reversed_at!==null||value.reason!==null):(value.reversed_at===null||!value.reason)))bad();
 return Object.fromEntries(['id','document_id','source_document_version','group_id','state','version','kind','number','direction','total_cents','installments','plan_source','created_at','reversed_at','reason'].map(key=>[key,value[key]]));
}
function titles(value){
 if(!Array.isArray(value)||value.length<1||value.length>120)bad();const seen=new Set();
 return value.map((row,index)=>{if(!object(row)||!id(row.id)||seen.has(row.id)||row.position!==index+1||!version(row.version)||!day(row.due_on)||!cents(row.amount_cents)||BigInt(row.amount_cents)<=0n||!cents(row.settled_cents)||!cents(row.balance_cents)
  ||BigInt(row.amount_cents)!==BigInt(row.settled_cents)+BigInt(row.balance_cents)||typeof row.cancelled!=='boolean'||typeof row.cnab_linked!=='boolean'||(row.category_id!==null&&!id(row.category_id))||!text(row.description,240))bad();seen.add(row.id);
  return Object.fromEntries(['id','position','version','due_on','amount_cents','settled_cents','balance_cents','cancelled','category_id','description','cnab_linked'].map(key=>[key,row[key]]));});
}
function detail(value){
 if(!object(value)||!id(value.document_id)||!version(value.document_version))bad();const p=posting(value.posting),rows=titles(value.titles);
 if(p.document_id!==value.document_id||rows.length!==p.installments||rows.reduce((sum,row)=>sum+BigInt(row.amount_cents),0n)!==BigInt(p.total_cents))bad();
 return {document_id:value.document_id,document_version:value.document_version,posting:p,titles:rows};
}
function scopedDetail(value,route){
 const result=detail(value);
 if(result.document_id!==route.args.p_document_id||result.posting.kind!==route.args.p_kind||(route.args.p_posting_id&&result.posting.id!==route.args.p_posting_id))bad();
 return result;
}
// 202610200196: the Forma and the conta financeira (Destino) of each conta; absent before 196. The contas stay open.
function payment(row){
 if(!Object.hasOwn(row,'payment_method_id'))return {};
 const named=(idValue,name,max)=>idValue===null?name===null:id(idValue)&&text(name,max)&&name.trim()!=='';
 if(!named(row.payment_method_id,row.payment_method_name,100)||!named(row.account_id,row.account_name,200))bad();
 return {payment_method_id:row.payment_method_id,payment_method_name:row.payment_method_name,account_id:row.account_id,account_name:row.account_name};
}
function postPreview(value){
 if(!object(value)||!id(value.document_id)||!KINDS.includes(value.kind)||!text(value.number,10)||!/^\d+$/.test(value.number)||!version(value.document_version)||!text(value.status,40)||!id(value.contact_id)||!text(value.contact_name,200)||!version(value.contact_version)
  ||!day(value.issued_on)||value.direction!==(value.kind==='purchase_orders'?'payable':'receivable')||!cents(value.total_cents)||(value.category_id===null?(value.category_name!==null||value.category_version!==null):(!id(value.category_id)||!text(value.category_name,200)||!version(value.category_version)))
  ||!['document','explicit'].includes(value.plan_source)||!Array.isArray(value.installments)||value.installments.length<1||value.installments.length>120||!HASH.test(value.preview_hash||''))bad();
 const parts=value.installments.map((row,index)=>{if(!object(row)||row.position!==index+1||!cents(row.amount_cents)||BigInt(row.amount_cents)<=0n||!day(row.due_on)||row.due_on<value.issued_on||(row.method!==null&&!text(row.method,100)))bad();return {position:row.position,amount_cents:row.amount_cents,due_on:row.due_on,method:row.method,...payment(row)};});
 if(parts.reduce((sum,row)=>sum+BigInt(row.amount_cents),0n)!==BigInt(value.total_cents))bad();
 return {...Object.fromEntries(['document_id','kind','number','document_version','status','contact_id','contact_name','contact_version','issued_on','direction','total_cents','category_id','category_name','category_version','plan_source','preview_hash'].map(key=>[key,value[key]])),installments:parts};
}
export async function executeDocumentFinanceRoute(route,{userId,rpc}){
 const value=await rpc(route.rpc,{p_user_id:userId,...route.args});if(!object(value)||value.data_mode!=='erp_native')bad();
 const base={data_mode:'erp_native'};
 if(route.operation==='list'){
  if(!id(value.document_id)||value.document_id!==route.args.p_document_id||value.kind!==route.args.p_kind||!text(value.number,10)||!version(value.document_version)||!Array.isArray(value.items)||value.items.length>route.args.p_limit||value.limit!==route.args.p_limit
   ||typeof value.has_more!=='boolean'||(value.has_more?!id(value.next_cursor):value.next_cursor!==null))bad();
  const items=value.items.map(posting),active=value.active_posting===null?null:posting(value.active_posting);
  if(items.some(item=>item.document_id!==value.document_id||item.kind!==route.args.p_kind)||(active&&(active.document_id!==value.document_id||active.kind!==route.args.p_kind||active.state!=='active')))bad();
  return {...base,document_id:value.document_id,document_version:value.document_version,kind:value.kind,number:value.number,active_posting:active,items,limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor};
 }
 if(route.operation==='get')return {...base,...scopedDetail(value,route)};
 if(value.cash_movement_performed!==false)bad();base.cash_movement_performed=false;
 if(route.operation==='preview'){
  const preview=postPreview(value.preview);if(preview.document_id!==route.args.p_document_id||preview.kind!==route.args.p_kind)bad();return {...base,preview};
 }
 if(route.operation==='reverse-preview'){
  if(!object(value.preview)||!HASH.test(value.preview.preview_hash||''))bad();return {...base,preview:{...scopedDetail(value.preview,route),preview_hash:value.preview.preview_hash}};
 }
 if(value.action!==route.operation||typeof value.replayed!=='boolean')bad();return {...base,...scopedDetail(value,route),action:value.action,replayed:value.replayed};
}
