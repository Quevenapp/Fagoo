/** Explicit identification decisions only. No fiscal classification, XML, numbering or transmission. */
import {executeFiscalDraftRoute} from './fiscal-drafts.mjs';
import {gtinCheckDigitMatches,ITEM_PREPARATION_FIELDS,ITEM_PREPARATION_FLAGS,ITEM_PREPARATION_PROFILE,ITEM_PREPARATION_SCHEMA} from '../../../packages/fiscal-core/src/item-preparation.mjs';

const PREFIX='/v1/preparacao-itens-fiscais',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
export const FISCAL_ITEM_RESPONSE_BYTES=8*1024*1024;
export class FiscalItemError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new FiscalItemError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new FiscalItemError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v);
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const instant=v=>typeof v==='string'&&v.length<=100&&Number.isFinite(Date.parse(v));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
function fieldValid(v,f){
 if(v===null)return true;if(typeof v!=='string')return false;
 if(f==='ncm')return /^(?:[0-9]{2}|[0-9]{8})$/.test(v);
 if(f==='origin')return /^[0-8]$/.test(v);
 if(f==='cest')return /^[0-9]{7}$/.test(v);
 return v==='SEM GTIN'||gtinCheckDigitMatches(v);
}
function decisions(v){
 if(!Array.isArray(v)||v.length>250)invalid();const seen=new Set();
 for(const d of v){
  if(!exact(d,['item_id','fields'])||!id(d.item_id)||seen.has(d.item_id)||!object(d.fields)||!Object.keys(d.fields).length)invalid();seen.add(d.item_id);
  for(const [f,c]of Object.entries(d.fields)){
   if(!ITEM_PREPARATION_FIELDS.includes(f)||!object(c))invalid();
   if(c.source==='manual'){if(!exact(c,['source','value'])||!fieldValid(c.value,f))invalid();}
   else if(c.source==='catalog'){if(!exact(c,['source','expected_product_id','expected_version'])||!id(c.expected_product_id)||!version(c.expected_version))invalid();}
   else invalid();
  }
 }
 // SQL measures jsonb with whitespace; reserve a small margin by measuring the same separators.
 if(new TextEncoder().encode(JSON.stringify(v).replace(/([,:])/g,'$1 ')).byteLength>262144)invalid();
 return v;
}
async function readBody(request){
 const length=request.headers.get('content-length');
 const encoding=request.headers.get('content-encoding');
 if((encoding!==null&&encoding.trim().toLowerCase()!=='identity')||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body
  ||(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144)))invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let timer;
 const reading=(async()=>{let bytes=0,text='';while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>262144)invalid();text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode());})();
 try{return await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new FiscalItemError(408,'ERP_REQUEST_TIMEOUT')),10000);})]);}
 catch(error){if(error instanceof FiscalItemError)throw error;invalid();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* No request bodies in logs. */}}
}
export function fiscalItemRoute(path){
 const match=/^\/v1\/preparacao-itens-fiscais\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(preview|history))?$/i.exec(path);
 if(!match||(match[2]&&!['preview','history'].includes(match[2])))return null;
 return{id:match[1].toLowerCase(),action:match[2]??null};
}
export const fiscalItemMethods=route=>route?.action==='preview'?['POST']:route?.action==='history'?['GET']:['GET','POST'];
export async function parseFiscalItemRoute(request){
 const url=new URL(request.url);if(url.pathname!==PREFIX&&!url.pathname.startsWith(`${PREFIX}/`))return null;
 const route=fiscalItemRoute(url.pathname);if(!route)throw new FiscalItemError(404,'ERP_NOT_FOUND');
 if(!fiscalItemMethods(route).includes(request.method))throw new FiscalItemError(405,'ERP_METHOD_NOT_ALLOWED');
 const args={p_draft_id:route.id};
 if(request.method==='GET'){
  if(request.body!==null)invalid();const keys=route.action==='history'?['limit','before']:['version'];
  for(const k of url.searchParams.keys())if(!keys.includes(k)||url.searchParams.getAll(k).length!==1)invalid();
  const integer=(key,fallback)=>{const v=url.searchParams.get(key);if(v===null)return fallback;if(!/^[1-9]\d{0,9}$/.test(v)||!version(Number(v)))invalid();return Number(v);};
  if(route.action==='history'){args.p_limit=integer('limit',25);args.p_before=integer('before',null);if(args.p_limit>25)invalid();}
  else args.p_version=integer('version',null);
  return{...route,operation:route.action==='history'?'history':'get',rpc:route.action==='history'?'erp_fiscal_item_history':'erp_fiscal_item_get',args};
 }
 if(url.search)invalid();const input=await readBody(request),save=route.action!=='preview';
 const keys=['expected_draft_version','snapshot_hash','expected_version','decisions',...(save?['command_id']:[])];
 if(!exact(input,keys)||!version(input.expected_draft_version)||typeof input.snapshot_hash!=='string'||!HASH.test(input.snapshot_hash)||!version(input.expected_version,0)
  ||input.expected_version===2147483647||(save&&!id(input.command_id)))invalid();
 Object.assign(args,{p_expected_draft_version:input.expected_draft_version,p_snapshot_hash:input.snapshot_hash,p_expected_version:input.expected_version,p_decisions:decisions(input.decisions)});
 if(save)args.p_command_id=input.command_id;
 return{...route,operation:save?'save':'preview',rpc:save?'erp_fiscal_item_save':'erp_fiscal_item_preview',args};
}
const missing={ncm:'NCM_NOT_PREPARED',origin:'ORIGIN_NOT_PREPARED',cest:'CEST_NOT_PREPARED',gtin:'GTIN_NOT_PREPARED',gtin_tax:'TRIBUTARY_GTIN_NOT_PREPARED'};
function resolvedItems(items,draft){
 const source=draft.snapshot.items;if(!Array.isArray(items)||items.length!==source.length)bad();
 return items.map((item,index)=>{
  const s=source[index];if(!object(item)||item.item_id!==s.id||item.position!==s.position||item.product_id!==s.product_id||!object(item.fields))bad();
  const fields={},pending=[];let catalogVersion=null,catalogActive=null;
  for(const f of ITEM_PREPARATION_FIELDS){
   const v=item.fields[f];if(!object(v)||!fieldValid(v.value,f)||!object(v.provenance))bad();
   const p=v.provenance;let provenance;
   if(p.source==='unreviewed'){if(v.value!==null)bad();provenance={source:p.source};}
   else if(p.source==='manual')provenance={source:p.source};
   else if(p.source==='catalog'){
    if(s.product_id===null||p.product_id!==s.product_id||!version(p.product_version)||p.product_version<s.product.version||typeof p.active!=='boolean')bad();
    if(catalogVersion!==null&&(catalogVersion!==p.product_version||catalogActive!==p.active))bad();catalogVersion=p.product_version;catalogActive=p.active;
    provenance=pick(p,['source','product_id','product_version','active']);
   }else bad();
   const check=['gtin','gtin_tax'].includes(f)&&v.value!==null&&v.value!=='SEM GTIN';if(v.check_digit_verified!==check)bad();
   fields[f]={value:v.value,provenance,check_digit_verified:check};if(v.value===null)pending.push(missing[f]);
  }
  if(fields.ncm.value?.length===2)pending.push('NCM_EXCEPTION_REQUIRES_REVIEW');
  pending.push('NCM_CLASSIFICATION_UNVERIFIED','ORIGIN_CLASSIFICATION_UNVERIFIED','CEST_APPLICABILITY_UNREVIEWED','GTIN_PRODUCT_MAPPING_UNVERIFIED','CFOP_UNPREPARED','CST_CSOSN_UNPREPARED','TAX_GROUPS_UNPREPARED','TRIBUTARY_UNIT_QUANTITY_PRICE_UNPREPARED');
  if(s.product_id===null)pending.push('FREE_ITEM_REQUIRES_REVIEW');
  if(JSON.stringify(item.pending)!==JSON.stringify(pending))bad();return{item_id:s.id,position:s.position,product_id:s.product_id,fields,pending};
 });
}
function metadata(v,id,preview=false){
 if(!object(v)||v.draft_id!==id||!version(v.version)||!version(v.draft_version)||!HASH.test(v.snapshot_hash||'')||!['55','65'].includes(v.model)
  ||v.environment!=='2'||!idValue(v.source_document_id)||!version(v.source_document_version)||(preview?v.created_at!==null:!instant(v.created_at)))bad();
 return pick(v,['draft_id','version','draft_version','snapshot_hash','model','environment','source_document_id','source_document_version','created_at']);
}
const idValue=id;
function verifyChoices(items,chosen){
 const byItem=new Map(chosen.map(d=>[d.item_id,d.fields]));if(chosen.some(d=>!items.some(i=>i.item_id===d.item_id)))bad();
 for(const i of items)for(const f of ITEM_PREPARATION_FIELDS){
  const c=byItem.get(i.item_id)?.[f],v=i.fields[f];
  if(!c){if(v.provenance.source!=='unreviewed')bad();}
  else if(v.provenance.source!==c.source)bad();
  else if(c.source==='manual'){if(v.value!==c.value)bad();}
  else if(v.provenance.product_id!==c.expected_product_id||v.provenance.product_version!==c.expected_version)bad();
 }
}
/** Authenticate before calling; SQL independently rechecks active admin/fiscal membership. */
export async function executeFiscalItemRoute(route,{userId,rpc}){
 if(!route)throw new FiscalItemError(404,'ERP_NOT_FOUND');
 if(typeof userId!=='string'||!id(userId.toLowerCase()))throw new FiscalItemError(401,'ERP_UNAUTHORIZED');
 userId=userId.toLowerCase();
 const raw=await rpc(route.rpc,{p_user_id:userId,...route.args});
 try{
  if(!object(raw)||raw.data_mode!=='fiscal_item_preparation'||raw.profile!==ITEM_PREPARATION_PROFILE||raw.schema_profile!==ITEM_PREPARATION_SCHEMA
   ||Object.keys(ITEM_PREPARATION_FLAGS).some(k=>raw[k]!==false))bad();
  const flags={data_mode:raw.data_mode,profile:raw.profile,schema_profile:raw.schema_profile,...ITEM_PREPARATION_FLAGS};
  let result;
  if(route.operation==='history'){
   if(raw.draft_id!==route.id||raw.limit!==route.args.p_limit||!Array.isArray(raw.items)||raw.items.length>raw.limit||typeof raw.has_more!=='boolean')bad();
   let prior=route.args.p_before??2147483648;
   const items=raw.items.map(v=>{const m=metadata(v,route.id);if(m.version>=prior)bad();prior=m.version;return m;});
   if(raw.has_more&&items.length!==raw.limit)bad();const cursor=raw.has_more?items.at(-1)?.version:null;if(raw.next_cursor!==cursor)bad();
   result={...flags,draft_id:route.id,items,limit:raw.limit,has_more:raw.has_more,next_cursor:cursor};
  }else{
   const preview=route.operation==='preview',mutation=preview||route.operation==='save';
   if(!object(raw.draft?.record))bad();
   const draft=await executeFiscalDraftRoute({operation:'get',id:route.id,revision:raw.draft.record.version,rpc:'erp_fiscal_draft_get',args:{}},{userId,rpc:async()=>raw.draft});
   let record=null;
   if(raw.record!==null){
    record=metadata(raw.record,route.id,preview);
    const d=draft.record;if(record.draft_version!==d.version||record.snapshot_hash!==d.snapshot_hash||record.model!==d.model||record.source_document_id!==d.source_document_id||record.source_document_version!==d.source_document_version)bad();
    record.items=resolvedItems(raw.record.items,d);
   }
   const c=raw.current;if(!object(c)||!version(c.preparation_version,0)||c.draft_version!==draft.current.version
    ||c.matches_current_draft!==(record!==null&&record.draft_version===draft.current.version))bad();
   if(record===null){if(c.preparation_version!==0||mutation||route.args.p_version!==null||draft.record.version!==draft.current.version)bad();}
   else if(preview){if(record.version!==c.preparation_version+1)bad();}
   else if(record.version>c.preparation_version)bad();
   if(route.operation==='get'&&record!==null&&record.version!==(route.args.p_version??c.preparation_version))bad();
   if(mutation){
    if(!record||draft.record.status!=='draft'||record.version!==route.args.p_expected_version+1||record.draft_version!==route.args.p_expected_draft_version||record.snapshot_hash!==route.args.p_snapshot_hash)bad();
    verifyChoices(record.items,route.args.p_decisions);
    if(preview&&(raw.persisted!==false||raw.expected_version!==route.args.p_expected_version||!c.matches_current_draft||draft.current.status!=='draft'||draft.current.source_status==='cancelled'))bad();
    if(!preview&&typeof raw.replayed!=='boolean')bad();
   }
   result={...flags,record,draft,current:pick(c,['preparation_version','draft_version','matches_current_draft']),
    ...(preview?{persisted:false,expected_version:raw.expected_version}:route.operation==='save'?{replayed:raw.replayed}:{})};
  }
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>FISCAL_ITEM_RESPONSE_BYTES)bad();return result;
 }catch(error){if(error instanceof FiscalItemError)throw error;bad();}
}
