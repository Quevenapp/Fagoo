/** Administrative, reviewed staging import. No route writes to Origin or any ledger. */
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const ACTIONS=['create','update','pending_human_review','pending_source_deleted','unchanged','invalid_source','missing_source'];
const REDACTED=['document','ie','email','phone','mobile','postal_code','street','number','complement','district'];
const FIELDS={contacts:['name','code','active','trade_name','person_type',...REDACTED,'city','state','roles'],products:['name','code','active','unit','price','kind','format','description','ncm','gtin']};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).every(key=>keys.includes(key));
const id=v=>typeof v==='string'&&v.length>0&&v.length<=200&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v);
export class CatalogImportError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CatalogImportError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new CatalogImportError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
export function catalogImportRoute(path){const match=/^\/v1\/importacao-cadastros\/(contacts|products)(?:\/(preview|apply))?$/.exec(path);return match?{entity:match[1],action:match[2]||null}:null;}
export const catalogImportMethods=route=>route?.action?['POST']:['GET'];
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body||Number(request.headers.get('content-length'))>65536)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)invalid();text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
 catch{return invalid();}finally{try{await reader.cancel();}catch{/* Never log input. */}reader.releaseLock();}
}
export async function catalogImportOperation(request,route,params){
 if(!route)throw new CatalogImportError(404,'ERP_NOT_FOUND');
 if(!catalogImportMethods(route).includes(request.method))throw new CatalogImportError(405,'ERP_METHOD_NOT_ALLOWED');
 if(!route.action){
  for(const key of params.keys())if(!['limit','after','q'].includes(key)||params.getAll(key).length!==1)invalid();
  const limit=params.get('limit')??'25',after=params.get('after'),query=params.get('q');
  if(!/^[0-9]{1,3}$/.test(limit)||Number(limit)<1||Number(limit)>100||(after!==null&&!id(after))||(query!==null&&(query.length>120||/[\x00-\x1f\x7f]/.test(query))))invalid();
  return {rpc:'erp_catalog_import_sources',args:{p_entity:route.entity,p_limit:Number(limit),p_after:after,p_query:query?.trim()||null},type:'list'};
 }
 if(params.size)invalid();const input=await body(request);
 if(!exact(input,route.action==='preview'?['items']:['items','command_id','preview_hash'])||!Array.isArray(input.items)||input.items.length<1||input.items.length>100)invalid();
 const seen=new Set();
 for(const item of input.items){if(!exact(item,['source_id','source_hash'])||!id(item.source_id)||!HASH.test(item.source_hash||'')||seen.has(item.source_id))invalid();seen.add(item.source_id);}
 const args={p_entity:route.entity,p_items:input.items};
 if(route.action==='apply'){if(!UUID.test(input.command_id||'')||!HASH.test(input.preview_hash||''))invalid();Object.assign(args,{p_command_id:input.command_id,p_preview_hash:input.preview_hash});}
 return {rpc:route.action==='preview'?'erp_catalog_import_preview':'erp_catalog_import_apply',args,type:route.action};
}
function string(value,max,nullable=true){if(value===null||value===undefined){if(!nullable)bad();return null;}if(typeof value!=='string'||value.length>max)bad();return value;}
function summary(value){
 if(!object(value)||!id(value.source_id)||!ACTIONS.includes(value.action)||!ACTIONS.includes(value.operation_action))bad();
 const safe={source_id:value.source_id,action:value.action,operation_action:value.operation_action};
 for(const [key,max]of Object.entries({source_hash:64,source_version:30,last_seen_at:100,name:200,code:100,source_status:1,record_id:36,local_name:200,origin_state:30,error:40}))safe[key]=string(value[key],max);
 if(safe.source_hash!==null&&!HASH.test(safe.source_hash)||safe.source_version!==null&&!/^[1-9][0-9]*$/.test(safe.source_version)||safe.record_id!==null&&!UUID.test(safe.record_id)
  ||safe.source_status!==null&&!['A','I','E','S'].includes(safe.source_status)||safe.origin_state!==null&&!['synced','local_modified','source_changed','source_deleted'].includes(safe.origin_state)
  ||safe.error!==null&&!['source_mapping_invalid','source_status_unknown'].includes(safe.error))bad();
 if(value.record_version!==null&&(!Number.isInteger(value.record_version)||value.record_version<1||value.record_version>2147483647))bad();safe.record_version=value.record_version;
 for(const key of ['human_edited','stock_locked','candidate_retained']){if(typeof value[key]!=='boolean')bad();safe[key]=value[key];}
 return safe;
}
function changes(value,entity){
 if(!Array.isArray(value)||value.length>FIELDS[entity].length)bad();const seen=new Set();
 return value.map(change=>{
  if(!object(change)||!FIELDS[entity].includes(change.field)||seen.has(change.field)||typeof change.redacted!=='boolean')bad();seen.add(change.field);
  if(change.redacted!==REDACTED.includes(change.field))bad();
  if(change.redacted){if(change.before!==null||change.after!==null)bad();return {field:change.field,redacted:true,before:null,after:null};}
  const safe={field:change.field,redacted:false};
  for(const key of ['before','after']){
   const field=change[key];
   if(field!==null){if(change.field==='active'){if(typeof field!=='boolean')bad();}
    else if(change.field==='roles'){if(!Array.isArray(field)||field.length>3||field.some(role=>!['customer','supplier','carrier'].includes(role)))bad();}
    else string(field,change.field==='description'?4000:254,false);}
   safe[key]=field;
  }return safe;
 });
}
export function catalogImportResponse(value,route,operation){
 if(!object(value)||value.entity!==route.entity||value.data_mode!=='erp_native'||value.operational_effects!==false||!Array.isArray(value.items))bad();
 const base={entity:route.entity,data_mode:'erp_native',operational_effects:false};
 if(operation.type==='list'){
  if(value.limit!==operation.args.p_limit||value.items.length>value.limit||typeof value.has_more!=='boolean'||(value.has_more?!id(value.next_cursor):value.next_cursor!==null)||value.source!=='origin_staging')bad();
  const items=value.items.map(summary);if(value.has_more&&value.next_cursor!==items.at(-1)?.source_id)bad();
  return {...base,items,limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor,source:'origin_staging'};
 }
 if(value.items.length!==operation.args.p_items.length||value.items.some((row,i)=>row.source_id!==operation.args.p_items[i].source_id)||!HASH.test(value.preview_hash||''))bad();
 if(operation.type==='preview'){
  if(value.dry_run!==true)bad();return {...base,dry_run:true,preview_hash:value.preview_hash,items:value.items.map(row=>({...summary(row),changes:changes(row.changes,route.entity)}))};
 }
 if(value.dry_run!==false||typeof value.replayed!=='boolean'||value.preview_hash!==operation.args.p_preview_hash)bad();
 return {...base,dry_run:false,replayed:value.replayed,preview_hash:value.preview_hash,items:value.items.map(row=>{
  if(!object(row)||!id(row.source_id)||!ACTIONS.includes(row.action))bad();
  const safe={source_id:row.source_id,action:row.action};
  for(const [key,max]of Object.entries({source_hash:64,source_version:30,record_id:36,error:40}))safe[key]=string(row[key],max);
  if(safe.source_hash!==null&&!HASH.test(safe.source_hash)||safe.record_id!==null&&!UUID.test(safe.record_id)||safe.source_version!==null&&!/^[1-9][0-9]*$/.test(safe.source_version)||safe.error!==null&&!['source_mapping_invalid','source_status_unknown'].includes(safe.error))bad();
  return safe;
 })};
}
