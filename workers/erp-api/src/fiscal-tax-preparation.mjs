import {TAX_PREPARATION_PROFILE,TAX_PREPARATION_FLAGS,validateTaxDecisions,resolveTaxItems} from '../../../packages/fiscal-core/src/tax-preparation.mjs';
import {gtinCheckDigitMatches} from '../../../packages/fiscal-core/src/item-preparation.mjs';
const PREFIX='/v1/preparacao-tributaria',UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
export const FISCAL_TAX_RESPONSE_BYTES=2*1024*1024;
export class FiscalTaxError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new FiscalTaxError(400,'ERP_INVALID_QUERY');},bad=()=>{throw new FiscalTaxError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
const equal=(a,b)=>{if(a===b)return true;if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));if(object(a)&&object(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));return false;};
async function body(request){
 const size=request.headers.get('content-length'),encoding=request.headers.get('content-encoding');
 if(!request.body||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||encoding!==null&&encoding.trim().toLowerCase()!=='identity'
  ||size!==null&&(!/^\d+$/.test(size)||Number(size)>524288))invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let timer;
 const reading=(async()=>{let bytes=0,text='';for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>524288)invalid();text+=decoder.decode(part.value,{stream:true});}return JSON.parse(text+decoder.decode());})();
 try{return await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new FiscalTaxError(408,'ERP_REQUEST_TIMEOUT')),10000);})]);}
 catch(e){if(e instanceof FiscalTaxError)throw e;invalid();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* no payload logging */}}
}
export function fiscalTaxRoute(path){const m=/^\/v1\/preparacao-tributaria\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(history|preview|save))?$/i.exec(path);return m&&(!m[2]||['history','preview','save'].includes(m[2]))?{id:m[1].toLowerCase(),action:m[2]||'get'}:null;}
export const fiscalTaxMethods=route=>['preview','save'].includes(route?.action)?['POST']:['GET'];
export async function parseFiscalTaxRoute(request){
 const url=new URL(request.url);if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return null;
 const r=fiscalTaxRoute(url.pathname);if(!r)throw new FiscalTaxError(404,'ERP_NOT_FOUND');if(!fiscalTaxMethods(r).includes(request.method))throw new FiscalTaxError(405,'ERP_METHOD_NOT_ALLOWED');
 const args={p_draft_id:r.id};
 if(request.method==='GET'){
  if(request.body!==null)invalid();const keys=r.action==='history'?['limit','before']:['version'];
  for(const k of url.searchParams.keys())if(!keys.includes(k)||url.searchParams.getAll(k).length!==1)invalid();
  const integer=(k,fallback)=>{const v=url.searchParams.get(k);if(v===null)return fallback;if(!/^[1-9][0-9]{0,9}$/.test(v)||!version(Number(v)))invalid();return Number(v);};
  if(r.action==='history'){args.p_limit=integer('limit',25);args.p_before=integer('before',null);if(args.p_limit>25)invalid();}else args.p_version=integer('version',null);
 }else{
  if(url.search)invalid();const v=await body(request),save=r.action==='save';
  if(!exact(v,['expected_draft_version','snapshot_hash','item_preparation_version','expected_version','operation','decisions',...(save?['command_id']:[])])||!version(v.expected_draft_version)||!version(v.item_preparation_version)||!version(v.expected_version,0)||v.expected_version===2147483647
   ||typeof v.snapshot_hash!=='string'||!HASH.test(v.snapshot_hash)||v.operation!=='internal_normal_sale'||save&&!id(v.command_id))invalid();
  try{validateTaxDecisions(v.decisions);}catch{invalid();}
  Object.assign(args,{p_expected_draft_version:v.expected_draft_version,p_snapshot_hash:v.snapshot_hash,p_item_preparation_version:v.item_preparation_version,p_expected_version:v.expected_version,p_operation:v.operation,p_decisions:v.decisions});
  if(save)args.p_command_id=v.command_id;
 }
 return{...r,operation:r.action,rpc:'erp_fiscal_tax_'+r.action,args};
}
const metadataKeys=['draft_id','version','draft_version','snapshot_hash','item_preparation_version','model','environment','operation','crt','company_identity_version','company_fiscal_version','source_document_id','source_document_version','created_at'];
function metadata(v,r,preview=false){
 if(!object(v)||v.draft_id!==r.id||!['version','draft_version','item_preparation_version','company_identity_version','company_fiscal_version','source_document_version'].every(k=>version(v[k]))
  ||typeof v.snapshot_hash!=='string'||!HASH.test(v.snapshot_hash)||!['55','65'].includes(v.model)||v.environment!=='2'||v.operation!=='internal_normal_sale'||v.crt!=='1'||!id(v.source_document_id)
  ||(preview?v.created_at!==null:typeof v.created_at!=='string'||!v.created_at.includes('T')||!Number.isFinite(Date.parse(v.created_at))))bad();return pick(v,metadataKeys);
}
function identifiers(v){
 if(!exact(v,['ncm','origin','cest','gtin','gtin_tax']))bad();
 for(const [k,x]of Object.entries(v))if(x!==null&&(typeof x!=='string'||(k==='ncm'?!/^(?:[0-9]{2}|[0-9]{8})$/.test(x):k==='origin'?!/^[0-8]$/.test(x):k==='cest'?!/^[0-9]{7}$/.test(x):x!=='SEM GTIN'&&!gtinCheckDigitMatches(x))))bad();
 return structuredClone(v);
}
function record(raw,r){
 const rec=metadata(raw,r,r.operation==='preview');if(!Array.isArray(raw.items)||raw.items.length<1||raw.items.length>250)bad();
 const seen=new Set();const base=raw.items.map((i,index)=>{if(!object(i)||!id(i.item_id)||seen.has(i.item_id)||i.position!==index+1||!(i.product_id===null||id(i.product_id)))bad();seen.add(i.item_id);
  return{item_id:i.item_id,position:i.position,product_id:i.product_id,identifiers:identifiers(i.identifiers)};});
 const computed=resolveTaxItems({model:rec.model,items:base,decisions:raw.items.map(i=>i.decisions)});
 for(let n=0;n<computed.length;n++)if(!equal(computed[n],pick(raw.items[n],['item_id','position','product_id','identifiers','decisions','provenance','pending'])))bad();
 if(['save','preview'].includes(r.operation)){
  const chosen=resolveTaxItems({model:rec.model,items:base,decisions:r.args.p_decisions});if(!equal(chosen,computed)||rec.version!==r.args.p_expected_version+1||rec.draft_version!==r.args.p_expected_draft_version
   ||rec.item_preparation_version!==r.args.p_item_preparation_version||rec.snapshot_hash!==r.args.p_snapshot_hash||rec.operation!==r.args.p_operation)bad();
 }
 return{...rec,items:computed};
}
export async function executeFiscalTaxRoute(route,{userId,rpc}){
 if(!route)throw new FiscalTaxError(404,'ERP_NOT_FOUND');if(typeof userId!=='string'||!id(userId.toLowerCase()))throw new FiscalTaxError(401,'ERP_UNAUTHORIZED');
 const raw=await rpc(route.rpc,{p_user_id:userId.toLowerCase(),...route.args});
 try{
  if(!object(raw)||raw.data_mode!=='fiscal_tax_preparation'||raw.profile!==TAX_PREPARATION_PROFILE||raw.schema_profile!=='pl010f-v1.04'||Object.keys(TAX_PREPARATION_FLAGS).some(k=>raw[k]!==false))bad();
  const flags={data_mode:raw.data_mode,profile:TAX_PREPARATION_PROFILE,schema_profile:raw.schema_profile,...TAX_PREPARATION_FLAGS};let result;
  if(route.operation==='history'){
   if(raw.draft_id!==route.id||raw.limit!==route.args.p_limit||!Array.isArray(raw.items)||raw.items.length>raw.limit||typeof raw.has_more!=='boolean')bad();let prior=route.args.p_before??2147483648;
   const items=raw.items.map(i=>{const v=metadata(i,route);if(v.version>=prior)bad();prior=v.version;return v;});
   const cursor=raw.has_more?items.at(-1)?.version:null;if(raw.has_more&&items.length!==raw.limit||raw.next_cursor!==cursor)bad();
   result={...flags,draft_id:route.id,items,limit:raw.limit,has_more:raw.has_more,next_cursor:cursor};
  }else{
   const rec=raw.record===null?null:record(raw.record,route),c=raw.current;
   if(!object(c)||!version(c.tax_version,0)||!version(c.draft_version)||!version(c.item_preparation_version,0)||!['draft','archived'].includes(c.draft_status)||typeof c.source_status!=='string'||c.source_status.length>40
    ||typeof c.source_changed!=='boolean'||typeof c.company_changed!=='boolean'||c.matches_current_draft!==(rec!==null&&rec.draft_version===c.draft_version)||c.matches_current_item_preparation!==(rec!==null&&rec.item_preparation_version===c.item_preparation_version))bad();
   if(rec===null){if(c.tax_version!==0||route.operation!=='get'||route.args.p_version!==null)bad();}
   else if(route.operation==='preview'){if(rec.version!==c.tax_version+1||raw.persisted!==false||raw.expected_version!==route.args.p_expected_version||!c.matches_current_draft||!c.matches_current_item_preparation||c.company_changed||c.source_changed||c.draft_status!=='draft'||c.source_status==='cancelled')bad();}
   else if(rec.version>c.tax_version)bad();
   if(route.operation==='get'&&rec!==null&&rec.version!==(route.args.p_version??c.tax_version))bad();
   if(route.operation==='save'&&(!rec||typeof raw.replayed!=='boolean'))bad();
   result={...flags,record:rec,current:pick(c,['tax_version','draft_version','item_preparation_version','draft_status','source_status','source_changed','company_changed','matches_current_draft','matches_current_item_preparation']),
    ...(route.operation==='preview'?{persisted:false,expected_version:raw.expected_version}:route.operation==='save'?{replayed:raw.replayed}:{})};
  }
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>FISCAL_TAX_RESPONSE_BYTES)bad();return result;
 }catch(e){if(e instanceof FiscalTaxError)throw e;bad();}
}
