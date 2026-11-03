/** Explicit internal homologation numbering; no XML, signing or transmission. */
import {isValidCnpj} from '../../../packages/fiscal-core/src/identity.mjs';

const BASE='/v1/numeracao-fiscal',MAX_BODY=8192;
export const FISCAL_NUMBERING_RESPONSE_BYTES=131072;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,HASH=/^[a-f0-9]{64}$/;
const FLAGS=Object.freeze({data_mode:'fiscal_numbering',policy:'brufap-homologation-exclusive-v1',environment:'2',can_emit:false,can_transmit:false,authorized:false,financial_mutation_performed:false,stock_mutation_performed:false});
const routes=new WeakSet();
export class FiscalNumberingError extends Error{constructor(status,code){super(code);this.name='FiscalNumberingError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new FiscalNumberingError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),canonicalId=v=>id(v)&&v===v.toLowerCase();
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const nullable=(v,test)=>v===null||test(v);
const number=v=>typeof v==='string'&&/^[1-9][0-9]{0,8}$/.test(v);
const series=v=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,2})$/.test(v)&&BigInt(v)<=889n;
const reference=v=>typeof v==='string'&&Array.from(v).length>=3&&Array.from(v).length<=240&&v.trim().length>0&&!/[\x00-\x1f\x7f-\x9f]/.test(v);
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const[y,m,d,h,minute,s]=v.slice(0,19).split(/[-T:]/).map(Number),offset=v.endsWith('Z')?[0,0]:v.slice(-5).split(':').map(Number);
 return y>=2000&&m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<=23&&minute<=59&&s<=59&&offset[0]<=14&&offset[1]<=59&&(offset[0]!==14||offset[1]===0)&&Number.isFinite(Date.parse(v));
}
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
function freeze(v){if(object(v)){for(const value of Object.values(v))freeze(value);Object.freeze(v);}return v;}

export function fiscalNumberingRoute(path){
 if(path===`${BASE}/series`)return{type:'series',methods:['GET','POST']};
 if(path===`${BASE}/reservations`)return{type:'reserve',methods:['POST']};
 const match=new RegExp(`^${BASE}/(reservations|drafts|commands)/([a-fA-F0-9-]+)$`).exec(path);
 return match&&id(match[2])?{type:{reservations:'reservation',drafts:'draft',commands:'command'}[match[1]],id:match[2].toLowerCase(),methods:['GET']}:null;
}
export const fiscalNumberingMethods=route=>(typeof route==='string'?fiscalNumberingRoute(route):route)?.methods??null;

async function body(request){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')||!request.body)fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>MAX_BODY))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let timer,rejectStop,bytes=0,text='';
 const stopped=new Promise((_,reject)=>{rejectStop=reject;timer=setTimeout(()=>reject(new FiscalNumberingError(408,'ERP_BODY_TIMEOUT')),5000);});
 const abort=()=>rejectStop(new FiscalNumberingError(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{
  for(;;){if(request.signal.aborted)abort();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(bytes+=part.value.length)>MAX_BODY)fail(413,'ERP_BODY_TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}
  if(length!==null&&Number(length)!==bytes)fail();return JSON.parse(text+decoder.decode());
 }catch(error){if(error instanceof FiscalNumberingError)throw error;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* no body logging */}}
}

export async function parseFiscalNumberingRoute(request){
 const url=new URL(request.url);if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return null;
 const shape=fiscalNumberingRoute(url.pathname);if(!shape)fail(404,'ERP_NOT_FOUND');if(!shape.methods.includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 const encoding=request.headers.get('content-encoding');if(encoding!==null&&encoding!=='identity')fail();
 const query=url.searchParams,allowed=shape.type==='series'&&request.method==='GET'?['model','limit','after']:[];
 for(const key of query.keys())if(!allowed.includes(key)||query.getAll(key).length!==1)fail();
 let route;
 if(request.method==='GET'){
  if(request.body!==null)fail();
  if(shape.type==='series'){
   const model=query.get('model'),limit=query.get('limit'),after=query.get('after');
   if(model!==null&&!['55','65'].includes(model)||limit!==null&&(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>25)||after!==null&&!id(after))fail();
   route={type:'series',rpc:'erp_fiscal_numbering_series',args:{p_model:model,p_limit:limit===null?25:Number(limit),p_after:after?.toLowerCase()??null}};
  }else route={type:shape.type,id:shape.id,rpc:`erp_fiscal_numbering_${shape.type}`,args:{[shape.type==='command'?'p_command_id':shape.type==='draft'?'p_draft_id':'p_id']:shape.id}};
 }else{
  const v=await body(request);
  if(shape.type==='series'){
   const keys=['command_id','id','expected_version','expected_identity_version','model','environment','series','initial_number','enabled','exclusive_use_confirmed','reference'];
   if(!exact(v,keys)||!canonicalId(v.command_id)||!nullable(v.id,canonicalId)||!version(v.expected_version,0)||v.expected_version===2147483647||(v.id===null)!==(v.expected_version===0)||!version(v.expected_identity_version)||!['55','65'].includes(v.model)||v.environment!=='2'||!series(v.series)||!number(v.initial_number)||typeof v.enabled!=='boolean'||typeof v.exclusive_use_confirmed!=='boolean'||v.enabled&&!v.exclusive_use_confirmed||!reference(v.reference))fail();
   route={type:'configure',rpc:'erp_fiscal_numbering_configure',commandId:v.command_id,args:Object.fromEntries(keys.map(key=>[`p_${key}`,v[key]]))};
  }else{
   const keys=['command_id','series_id','expected_series_version','expected_identity_version','draft_id','expected_draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','confirm_reserve'];
   if(!exact(v,keys)||!['command_id','series_id','draft_id'].every(key=>canonicalId(v[key]))||!['expected_series_version','expected_identity_version','expected_draft_version','item_preparation_version','tax_preparation_version'].every(key=>version(v[key]))||v.expected_series_version===2147483647||typeof v.snapshot_hash!=='string'||!HASH.test(v.snapshot_hash)||v.confirm_reserve!==true)fail();
   route={type:'reserve',rpc:'erp_fiscal_numbering_reserve',commandId:v.command_id,args:Object.fromEntries(keys.map(key=>[`p_${key}`,v[key]]))};
  }
 }
 freeze(route);routes.add(route);return route;
}

const seriesKeys=['id','issuer_cnpj','cuf','model','environment','series','first_number','next_number','exhausted','version','identity_version','enabled','exclusive_use_confirmed','reference','created_at','updated_at','company_changed'];
function seriesRecord(v){
 if(!object(v)||!canonicalId(v.id)||typeof v.issuer_cnpj!=='string'||!isValidCnpj(v.issuer_cnpj)||v.cuf!=='35'||!['55','65'].includes(v.model)||v.environment!=='2'||!series(v.series)||!number(v.first_number)||!nullable(v.next_number,number)||typeof v.exhausted!=='boolean'||v.exhausted!==(v.next_number===null)||v.next_number!==null&&BigInt(v.next_number)<BigInt(v.first_number)||!version(v.version)||!version(v.identity_version)||typeof v.enabled!=='boolean'||typeof v.exclusive_use_confirmed!=='boolean'||v.enabled&&!v.exclusive_use_confirmed||!reference(v.reference)||!stamp(v.created_at)||!stamp(v.updated_at)||Date.parse(v.updated_at)<Date.parse(v.created_at)||typeof v.company_changed!=='boolean')bad();
 const progress=(v.exhausted?1000000000n:BigInt(v.next_number))-BigInt(v.first_number);if(progress>BigInt(v.version-1))bad();
 return pick(v,seriesKeys);
}
const reservationKeys=['id','state','numbering_reserved','series_id','series_version','issuer_cnpj','cuf','model','environment','series','number','draft_id','draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','item_preparation_hash','tax_preparation_hash','source_document_id','source_document_version','company_identity_version','company_fiscal_version','reserved_at'];
function reservationRecord(v){
 if(!object(v)||!['id','series_id','draft_id','source_document_id'].every(key=>canonicalId(v[key]))||v.state!=='reserved'||v.numbering_reserved!==true||!['series_version','draft_version','item_preparation_version','tax_preparation_version','source_document_version','company_identity_version','company_fiscal_version'].every(key=>version(v[key]))||!['snapshot_hash','item_preparation_hash','tax_preparation_hash'].every(key=>typeof v[key]==='string'&&HASH.test(v[key]))||typeof v.issuer_cnpj!=='string'||!isValidCnpj(v.issuer_cnpj)||v.cuf!=='35'||!['55','65'].includes(v.model)||v.environment!=='2'||!series(v.series)||!number(v.number)||!stamp(v.reserved_at))bad();
 return pick(v,reservationKeys);
}
function compatibleSeries(old,current){
 for(const key of ['id','issuer_cnpj','cuf','model','environment','series','first_number','created_at'])if(old[key]!==current[key])bad();
 if(current.version<old.version||current.identity_version<old.identity_version||old.exhausted&&!current.exhausted)bad();
 const a=old.exhausted?1000000000n:BigInt(old.next_number),b=current.exhausted?1000000000n:BigInt(current.next_number);
 if(b<a||b-a>BigInt(current.version-old.version))bad();
 if(current.version===old.version)for(const key of ['next_number','exhausted','identity_version','enabled','exclusive_use_confirmed','reference','updated_at'])if(old[key]!==current[key])bad();
}
const basisKeys=['draft_version','draft_status','source_document_version','source_status','item_preparation_version','tax_preparation_version','company_identity_version','company_fiscal_version','basis_changed','draft_archived','source_cancelled'];
function basisRecord(v,receipt,currentSeries){
 if(!object(v)||!version(v.draft_version)||v.draft_version<receipt.draft_version||!version(v.source_document_version)||v.source_document_version<receipt.source_document_version||!['draft','archived'].includes(v.draft_status)||!['draft','open','verified','in_progress','agency_sale','checkout_partial','partially_fulfilled','partially_invoiced','fulfilled','cancelled'].includes(v.source_status)||!['item_preparation_version','tax_preparation_version','company_identity_version','company_fiscal_version'].every(key=>nullable(v[key],version))||v.draft_archived!==(v.draft_status==='archived')||v.source_cancelled!==(v.source_status==='cancelled'))bad();
 const differs=['draft_version','source_document_version','item_preparation_version','tax_preparation_version','company_identity_version','company_fiscal_version'].some(key=>v[key]!==receipt[key]);
 if(v.basis_changed!==differs||receipt.series_id!==currentSeries.id||receipt.series!==currentSeries.series||receipt.model!==currentSeries.model||receipt.issuer_cnpj!==currentSeries.issuer_cnpj||currentSeries.version<=receipt.series_version||BigInt(receipt.number)<BigInt(currentSeries.first_number)||currentSeries.next_number!==null&&BigInt(currentSeries.next_number)<=BigInt(receipt.number)||currentSeries.company_changed!==(currentSeries.identity_version!==v.company_identity_version))bad();
 return pick(v,basisKeys);
}
function output(raw,route){
 if(!object(raw)||Object.entries(FLAGS).some(([key,value])=>raw[key]!==value))bad();
 if(route.type==='series'){
  const p=route.args;if(raw.read_only!==true||raw.limit!==p.p_limit||!Array.isArray(raw.items)||raw.items.length>p.p_limit||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==p.p_limit)bad();
  let previous=p.p_after,issuer=null;const items=raw.items.map(value=>{const item=seriesRecord(value);if(previous!==null&&item.id<=previous||p.p_model!==null&&item.model!==p.p_model||issuer!==null&&item.issuer_cnpj!==issuer)bad();previous=item.id;issuer=item.issuer_cnpj;return item;});
  const next=raw.has_more?previous:null;if(raw.next_cursor!==next)bad();return{...FLAGS,read_only:true,items,limit:p.p_limit,has_more:raw.has_more,next_cursor:next};
 }
 const isCommand=['command','configure','reserve'].includes(route.type);
 if(!isCommand&&raw.read_only!==true)bad();
 if(route.type==='draft'&&raw.receipt===null){if(raw.current_series!==null||raw.current_basis!==null)bad();return{...FLAGS,read_only:true,receipt:null,current_series:null,current_basis:null};}
 if(isCommand&&(raw.command_id!==(route.commandId??route.id)||!['configure','reserve'].includes(raw.action)||typeof raw.replayed!=='boolean'||route.type!=='command'&&raw.action!==route.type))bad();
 const action=isCommand?raw.action:'reserve',currentSeries=seriesRecord(raw.current_series),receipt=action==='configure'?seriesRecord(raw.receipt):reservationRecord(raw.receipt);
 let currentBasis=null;
 if(action==='configure'){if(raw.current_basis!==null)bad();compatibleSeries(receipt,currentSeries);}
 else currentBasis=basisRecord(raw.current_basis,receipt,currentSeries);
 if(route.type==='reservation'&&receipt.id!==route.id||route.type==='draft'&&receipt.draft_id!==route.id)bad();
 if(route.type==='configure'){
  const p=route.args;if(p.p_id!==null&&receipt.id!==p.p_id||receipt.version!==p.p_expected_version+1||receipt.identity_version!==p.p_expected_identity_version||receipt.model!==p.p_model||receipt.environment!==p.p_environment||receipt.series!==p.p_series||receipt.first_number!==p.p_initial_number||receipt.enabled!==p.p_enabled||receipt.exclusive_use_confirmed!==p.p_exclusive_use_confirmed||receipt.reference!==p.p_reference||receipt.company_changed)bad();
  if(p.p_id===null&&(receipt.next_number!==p.p_initial_number||receipt.exhausted))bad();
 }
 if(route.type==='reserve'){
  const p=route.args;if(receipt.series_id!==p.p_series_id||receipt.series_version!==p.p_expected_series_version||receipt.company_identity_version!==p.p_expected_identity_version||receipt.draft_id!==p.p_draft_id||receipt.draft_version!==p.p_expected_draft_version||receipt.snapshot_hash!==p.p_snapshot_hash||receipt.item_preparation_version!==p.p_item_preparation_version||receipt.tax_preparation_version!==p.p_tax_preparation_version)bad();
 }
 return{...FLAGS,...(isCommand?{command_id:raw.command_id,action,replayed:raw.replayed}:{read_only:true}),receipt,current_series:currentSeries,current_basis:currentBasis};
}
function sqlError(error){
 if(error instanceof FiscalNumberingError)throw error;
 const mapping={22023:[400,'ERP_INVALID_QUERY'],42501:[403,'ERP_FORBIDDEN'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],55000:[503,'ERP_FISCAL_NUMBERING_UNAVAILABLE']};
 if(mapping[error?.code])fail(...mapping[error.code]);
 const status=error?.status;if([400,401,403,404,409,503,504].includes(status))fail(status,({400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHORIZED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT'})[status]??'ERP_FISCAL_NUMBERING_UNAVAILABLE');
 fail(502,'ERP_FISCAL_NUMBERING_UNAVAILABLE');
}
export async function executeFiscalNumberingRoute(route,{userId,rpc,timeoutMs=15000}){
 if(!id(userId))fail(401,'ERP_UNAUTHORIZED');if(!routes.has(route))fail(404,'ERP_NOT_FOUND');if(typeof rpc!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)fail(500,'ERP_FISCAL_NUMBERING_PORT_UNAVAILABLE');
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;let timer;
 try{
  const value=await Promise.race([Promise.resolve().then(()=>rpc(route.rpc,{...route.args,p_user_id:userId.toLowerCase()},{signal:controller.signal,deadline})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new FiscalNumberingError(504,'ERP_FISCAL_NUMBERING_TIMEOUT'));},timeoutMs);})]);
  const result=output(value,route);if(new TextEncoder().encode(JSON.stringify(result)).byteLength>FISCAL_NUMBERING_RESPONSE_BYTES)bad();return{type:'json',body:result};
 }catch(error){sqlError(error);}finally{clearTimeout(timer);controller.abort();}
}
