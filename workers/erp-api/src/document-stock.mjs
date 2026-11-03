/** Explicit document-to-stock bridge. Minimal operational projection; no commercial amounts. */
import { stockResponse } from './stock.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const KINDS=['sales_orders','purchase_orders','service_orders'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&UUID.test(v);
const text=(v,max,min=0)=>typeof v==='string'&&v.length<=max&&v.trim().length>=min&&!/[\x00-\x1f\x7f]/.test(v);
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const decimal=v=>typeof v==='string'&&/^-?(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/.test(v);
// Balances before/after may be negative since migration100; the arithmetic below stays exact.
const units=v=>{const negative=v.startsWith('-'),[whole,fraction='']=v.replace(/^-/,'').split('.');return(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')))*(negative?-1n:1n);};
const pick=(v,keys)=>Object.fromEntries(keys.map(key=>[key,v[key]]));
export class DocumentStockError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new DocumentStockError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new DocumentStockError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const exact=(v,keys)=>{if(!object(v)||Object.keys(v).some(key=>!keys.includes(key)))invalid();};
function day(v){if(!text(v,10)||!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01')return false;const date=new Date(`${v}T00:00:00Z`);return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===v;}
const instant=v=>text(v,100)&&Number.isFinite(Date.parse(v));
async function readBody(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body||Number(request.headers.get('content-length'))>65536)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let timer;
 const reading=(async()=>{let size=0,input='';while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)invalid();input+=decoder.decode(value,{stream:true});}return JSON.parse(input+decoder.decode());})();
 try{return await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new DocumentStockError(408,'ERP_REQUEST_TIMEOUT')),10000);})]);}
 catch(error){if(error instanceof DocumentStockError)throw error;invalid();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* Pending read is cancelled; never log request contents. */}}
}
export function documentStockMethods(path){return /\/(preview|post|reverse-preview|reverse)$/.test(path)?['POST']:['GET'];}
export async function parseDocumentStockRoute(request){
 const url=new URL(request.url),prefix='/v1/documentos-estoque';
 if(url.pathname!==prefix&&!url.pathname.startsWith(`${prefix}/`))return null;
 let operation,args;
 if(url.pathname===prefix){operation='list';args={};}
 else{
  const match=/^\/v1\/documentos-estoque\/(sales_orders|purchase_orders|service_orders)\/([a-f0-9-]+)(?:\/(preview|post|[a-f0-9-]+)(?:\/(reverse-preview|reverse))?)?$/i.exec(url.pathname);
  if(!match||!KINDS.includes(match[1])||!id(match[2]))throw new DocumentStockError(404,'ERP_NOT_FOUND');
  const [,kind,document,segment,reverse]=match;args={p_kind:kind,p_document_id:document.toLowerCase()};
  if(!segment)operation='get';else if(['preview','post'].includes(segment)&&!reverse)operation=segment;
  else if(id(segment)&&reverse){operation=reverse;args.p_posting_id=segment.toLowerCase();}
  else throw new DocumentStockError(404,'ERP_NOT_FOUND');
 }
 const method=['list','get'].includes(operation)?'GET':'POST';
 if(request.method!==method)throw new DocumentStockError(405,'ERP_METHOD_NOT_ALLOWED');
 if(method==='GET'){
  const allowed=operation==='list'?['kind','limit','after','query']:['limit','after'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  const limit=url.searchParams.get('limit')??'25',after=url.searchParams.get('after');
  if(!/^\d{1,2}$/.test(limit)||Number(limit)<1||Number(limit)>25||(after!==null&&!id(after)))invalid();
  args.p_limit=Number(limit);args.p_after=after?.toLowerCase()??null;
  if(operation==='list'){
   const kind=url.searchParams.get('kind'),query=url.searchParams.get('query');
   if(!KINDS.includes(kind)||(query!==null&&!text(query,100)))invalid();args.p_kind=kind;args.p_query=query;
  }
 }else{
  if(url.search)invalid();const input=await readBody(request),reverse=operation.startsWith('reverse'),mutate=['post','reverse'].includes(operation);
  // 184 (estoque): the warehouse chosen in the conferência ("Depósitos" of Origin) for a document without warehouse or to change it.
  const chosen=!reverse&&object(input)&&Object.hasOwn(input,'warehouse_id');
  exact(input,['expected_document_version','occurred_on','reason',...(chosen?['warehouse_id']:[]),...(reverse?['expected_posting_version']:[]),...(mutate?['command_id','preview_hash']:[]),...(operation==='post'?['ignored_item_ids']:[])]);
  if(chosen){if(!id(input.warehouse_id))invalid();args.p_warehouse_id=input.warehouse_id.toLowerCase();}
  if(!version(input.expected_document_version)||!day(input.occurred_on)||!text(input.reason,500,3))invalid();
  args.p_expected_version=input.expected_document_version;args.p_occurred_on=input.occurred_on;args.p_reason=input.reason;
  if(reverse){if(!version(input.expected_posting_version))invalid();args.p_posting_version=input.expected_posting_version;}
  if(mutate){if(!id(input.command_id)||typeof input.preview_hash!=='string'||!HASH.test(input.preview_hash))invalid();args.p_command_id=input.command_id.toLowerCase();args.p_preview_hash=input.preview_hash;}
  if(operation==='post'){
   if(!Array.isArray(input.ignored_item_ids)||input.ignored_item_ids.length>250||input.ignored_item_ids.some(v=>!id(v)))invalid();
   const ids=input.ignored_item_ids.map(v=>v.toLowerCase());if(new Set(ids).size!==ids.length)invalid();args.p_ignored_item_ids=ids.sort();
  }
 }
 return {operation,rpc:args.p_warehouse_id?`erp_stock_document_warehouse_${operation}`:`erp_document_stock_${operation.replace('-','_')}`,args};
}
function summary(v,kind){
 if(!object(v)||!id(v.id)||v.kind!==kind||!KINDS.includes(v.kind)||!text(v.number,10,1)||!/^[1-9][0-9]{0,9}$/.test(v.number)||!version(v.version)||!text(v.status,40,1)
  ||!day(v.date)||(v.warehouse_id!==null&&!id(v.warehouse_id))||typeof v.eligible!=='boolean'||(v.active_posting_id!==null&&!id(v.active_posting_id)))bad();
 return pick(v,['id','kind','number','version','status','date','warehouse_id','eligible','active_posting_id']);
}
function posting(v,document){
 if(!object(v)||!id(v.id)||v.document_id!==document||!version(v.source_document_version)||!id(v.movement_id)||!version(v.version)
  ||!['active','reversed'].includes(v.state)||!instant(v.created_at)||!day(v.occurred_on)||!['receipt','issue'].includes(v.direction)
  ||!Number.isInteger(v.positions)||v.positions<1||v.positions>100||!Number.isInteger(v.ignored_items)||v.ignored_items<0||v.ignored_items>250
  ||(v.state==='active'?(v.reversal_movement_id!==null||v.reversed_at!==null||v.reason!==null):(!id(v.reversal_movement_id)||!instant(v.reversed_at)||!text(v.reason,500,3))))bad();
 return pick(v,['id','document_id','source_document_version','movement_id','state','version','created_at','reversal_movement_id','reversed_at','reason','occurred_on','direction','positions','ignored_items']);
}
function page(v,items,limit){
 if(v.limit!==limit||typeof v.has_more!=='boolean'||(v.has_more?!id(v.next_cursor):v.next_cursor!==null)||items.length>limit
  ||(v.has_more&&(items.length!==limit||items.at(-1).id!==v.next_cursor)))bad();
 for(let i=1;i<items.length;i++)if(items[i-1].id>=items[i].id)bad();
 return {limit:v.limit,has_more:v.has_more,next_cursor:v.next_cursor};
}
function line(v){
 if(!object(v)||!id(v.id)||!Number.isInteger(v.position)||v.position<1||v.position>250||(v.product_id!==null&&!id(v.product_id))
  ||!text(v.description,200,1)||!text(v.unit,16,1)||!decimal(v.quantity)||units(v.quantity)<=0n)bad();
 return pick(v,['id','position','product_id','description','unit','quantity']);
}
// 296 (estoque): the lots informed on the items (data->'lots' of the documentos lane) of a position: each lot once, the sign of the
// position, the lot balance never below zero, at most the position; in the lançamento each lot names its items (plain sources of the
// position) and no item gives more than its own quantity; in the estorno the lots of the lançamento come back without sources.
const abs=v=>v<0n?-v:v;
function positionLots(row,sources,reverse){
 if(!Array.isArray(row.lots)||row.lots.length<1||row.lots.length>250)bad();
 const plain=new Map(sources.filter(s=>!Object.hasOwn(s,'kit_product_id')).map(s=>[s.id,s])),given=new Map(),seen=new Set();let sum=0n;
 const keys=['lot_id','code','expires_on','quantity','balance_before','balance_after',...(reverse?[]:['sources'])];
 const lots=row.lots.map(l=>{
  if(!object(l)||Object.keys(l).length!==keys.length||keys.some(k=>!Object.hasOwn(l,k))||!id(l.lot_id)||seen.has(l.lot_id)||!text(l.code,60,1)||(l.expires_on!==null&&!day(l.expires_on))
   ||!decimal(l.quantity)||units(l.quantity)===0n||(units(l.quantity)<0n)!==(units(row.quantity)<0n)||!decimal(l.balance_before)||units(l.balance_before)<0n
   ||!decimal(l.balance_after)||units(l.balance_after)<0n||units(l.balance_before)+units(l.quantity)!==units(l.balance_after))bad();
  seen.add(l.lot_id);sum+=abs(units(l.quantity));
  const out=pick(l,['lot_id','code','expires_on','quantity','balance_before','balance_after']);
  if(reverse)return out;
  if(!Array.isArray(l.sources)||l.sources.length<1||l.sources.length>250)bad();
  const items=new Set();let total=0n;
  out.sources=l.sources.map(s=>{const item=object(s)?plain.get(s.id):null;
   if(!item||items.has(s.id)||Object.keys(s).some(k=>!['id','position','quantity'].includes(k))||s.position!==item.position||!decimal(s.quantity)||units(s.quantity)<=0n)bad();
   items.add(s.id);total+=units(s.quantity);given.set(s.id,(given.get(s.id)??0n)+units(s.quantity));return pick(s,['id','position','quantity']);});
  if(total!==abs(units(l.quantity)))bad();
  return out;
 });
 if(sum>abs(units(row.quantity))||[...given].some(([item,quantity])=>quantity>units(plain.get(item).quantity)))bad();
 return lots;
}
function preview(v,route){
 const reverse=route.operation==='reverse-preview',action=reverse?'reverse':'post';
 if(!object(v)||v.action!==action||!HASH.test(v.preview_hash??'')||v.occurred_on!==route.args.p_occurred_on||v.reason!==route.args.p_reason)bad();
 const document=summary(v.document,route.args.p_kind);
 if(document.id!==route.args.p_document_id||document.version!==route.args.p_expected_version
  ||v.direction!==(reverse?'reversal':document.kind==='purchase_orders'?'receipt':'issue'))bad();
 // 184: a chosen warehouse replaces the document's one; a reversal uses the warehouse of its own posting.
 const w=v.warehouse;if(!object(w)||!id(w.id)||!text(w.name,200,1)||!version(w.version)||typeof w.active!=='boolean'||(!reverse&&w.id!==(route.args.p_warehouse_id??document.warehouse_id)))bad();
 if(!Array.isArray(v.positions)||v.positions.length<1||v.positions.length>100||!Array.isArray(v.ignored)||v.ignored.length>250)bad();
 // 222: a composition item reaches each component's position with the item quantity (kit_quantity), the quantity of the component per
 // composition (component_quantity) and the product of both (quantity); the same item may also be a plain source of the composition.
 const seenProducts=new Set(),seenItems=new Set(),plainOf=new Map(),kitSources=[];
 const positions=v.positions.map(row=>{
  if(!object(row)||!id(row.product_id)||seenProducts.has(row.product_id)||row.warehouse_id!==w.id||!text(row.product_name,200,1)||!version(row.catalog_version)||!text(row.unit,16,1)
   ||!decimal(row.quantity)||units(row.quantity)===0n||!decimal(row.balance_before)||!decimal(row.balance_after)
   ||units(row.balance_before)+units(row.quantity)!==units(row.balance_after)||!version(row.expected_version,0)||!Array.isArray(row.sources)||row.sources.length>250)bad();
  if(!reverse&&((v.direction==='receipt'&&units(row.quantity)<0n)||(v.direction==='issue'&&units(row.quantity)>0n)))bad();
  seenProducts.add(row.product_id);let total=0n;
  const rowItems=new Set();
  const sources=row.sources.map(s=>{if(!object(s)||!id(s.id)||rowItems.has(s.id)||!Number.isInteger(s.position)||s.position<1||s.position>250||!decimal(s.quantity)||units(s.quantity)<=0n)bad();
   rowItems.add(s.id);seenItems.add(s.id);total+=units(s.quantity);
   if(!Object.hasOwn(s,'kit_product_id')){if(plainOf.has(s.id)||Object.keys(s).some(k=>!['id','position','quantity'].includes(k)))bad();plainOf.set(s.id,row.product_id);return pick(s,['id','position','quantity']);}
   if(Object.keys(s).some(k=>!['id','position','quantity','kit_product_id','kit_quantity','component_quantity'].includes(k))||!id(s.kit_product_id)||s.kit_product_id===row.product_id
    ||!decimal(s.kit_quantity)||units(s.kit_quantity)<=0n||!decimal(s.component_quantity)||units(s.component_quantity)<=0n
    ||units(s.quantity)*1000000n!==units(s.kit_quantity)*units(s.component_quantity))bad();
   kitSources.push(s);return pick(s,['id','position','quantity','kit_product_id','kit_quantity','component_quantity']);});
  if(reverse?sources.length!==0:(!sources.length||total!==(units(row.quantity)<0n?-units(row.quantity):units(row.quantity))))bad();
  // 224: a reversed position that keeps its balance (Balanço after the lançamento, option off) is marked by the preview.
  if(Object.hasOwn(row,'balance_kept')&&(row.balance_kept!==true||!reverse))bad();
  const lots=Object.hasOwn(row,'lots')?positionLots(row,sources,reverse):null;
  return {...pick(row,['product_id','product_name','catalog_version','warehouse_id','unit','quantity','balance_before','balance_after','expected_version']),sources,...(row.balance_kept===true?{balance_kept:true}:{}),...(lots?{lots}:{})};
 });
 const sourceItems=seenItems.size;
 const ignored=v.ignored.map(row=>{const out=line(row);if(seenItems.has(out.id)||!['service','unlinked_item'].includes(row.reason)
  ||(row.reason==='service'?(!id(row.product_id)||!version(row.catalog_version)):(row.product_id!==null||row.catalog_version!==null)))bad();seenItems.add(out.id);return {...out,catalog_version:row.catalog_version,reason:row.reason};});
 // A composition item is a plain source only of the composition itself (Lançar estoque: Produto e componente).
 const kitOf=new Map();for(const k of kitSources){const seen=kitOf.get(k.id);if(seen&&(seen.kit_product_id!==k.kit_product_id||seen.kit_quantity!==k.kit_quantity||seen.position!==k.position))bad();kitOf.set(k.id,k);}
 if(kitSources.some(k=>plainOf.has(k.id)&&plainOf.get(k.id)!==k.kit_product_id))bad();
 if(sourceItems+ignored.length>250||(reverse&&ignored.length))bad();
 const result={action,document,direction:v.direction,occurred_on:v.occurred_on,reason:v.reason,warehouse:pick(w,['id','name','version','active']),positions,ignored,preview_hash:v.preview_hash};
 if(reverse){result.posting=posting(v.posting,document.id);if(result.posting.id!==route.args.p_posting_id||result.posting.version!==route.args.p_posting_version||result.posting.state!=='active'||result.posting.movement_id===null)bad();
  if(positions.some(row=>(result.posting.direction==='receipt'?units(row.quantity)>=0n:units(row.quantity)<=0n)))bad();}
 return result;
}
export async function executeDocumentStockRoute(route,{userId,rpc}){
 const v=await rpc(route.rpc,{...route.args,p_user_id:userId});if(!object(v)||v.data_mode!=='erp_native')bad();
 if(route.operation==='list'){
  if(v.kind!==route.args.p_kind||!Array.isArray(v.items))bad();const items=v.items.map(row=>summary(row,route.args.p_kind));
  return {kind:v.kind,items,...page(v,items,route.args.p_limit),data_mode:'erp_native'};
 }
 if(route.operation==='get'){
  const document=summary(v.document,route.args.p_kind);if(document.id!==route.args.p_document_id||!Array.isArray(v.items)||v.items.length>250||!Array.isArray(v.postings))bad();
  const seen=new Set(),items=v.items.map((row,index)=>{const value=line(row);if(value.position!==index+1||seen.has(value.id)||(row.code!==null&&!text(row.code,100)))bad();seen.add(value.id);return {...value,code:row.code};});
  const postings=v.postings.map(row=>posting(row,document.id)),active=v.active_posting===null?null:posting(v.active_posting,document.id);
  if(active?(active.state!=='active'||document.active_posting_id!==active.id):document.active_posting_id!==null)bad();
  return {document,items,active_posting:active,postings,...page(v,postings,route.args.p_limit),data_mode:'erp_native'};
 }
 if(['preview','reverse-preview'].includes(route.operation))return {preview:preview(v.preview,route),data_mode:'erp_native'};
 if(v.document_id!==route.args.p_document_id||!version(v.document_version)||typeof v.replayed!=='boolean'||v.action!==route.operation)bad();
 const p=posting(v.posting,v.document_id);
 if(p.direction!==(route.args.p_kind==='purchase_orders'?'receipt':'issue'))bad();
 if(route.operation==='post'?(p.state!=='active'||p.source_document_version!==route.args.p_expected_version):(p.id!==route.args.p_posting_id||p.state!=='reversed'))bad();
 if(route.args.p_warehouse_id&&(!Array.isArray(v.movement?.items)||v.movement.items.some(item=>item?.warehouse_id!==route.args.p_warehouse_id)))bad();
 if(v.document_version!==route.args.p_expected_version+1)bad();
 let movement;try{movement=stockResponse({movement:v.movement,replayed:v.replayed,data_mode:'erp_native'},null,{type:'mutation'}).movement;}catch{bad();}
 if(movement.id!==(route.operation==='post'?p.movement_id:p.reversal_movement_id)||movement.kind!==(route.operation==='post'?p.direction:'reversal')
  ||movement.occurred_on!==route.args.p_occurred_on||movement.reason!==route.args.p_reason.trim()
  ||(route.operation==='reverse'?movement.reverses_id!==p.movement_id:movement.reverses_id!==null)||movement.items.length!==p.positions)bad();
 return {document_id:v.document_id,document_version:v.document_version,posting:p,movement,action:route.operation,replayed:v.replayed,data_mode:'erp_native'};
}
