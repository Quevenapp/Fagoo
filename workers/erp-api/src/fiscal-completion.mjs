/** Explicit, versioned preparation only. This module cannot allocate numbers or build/transmit XML. */
import {COMPLETION_FLAGS,COMPLETION_TOTAL_FIELDS,COMPLETION_EXCLUDED_FIELDS,resolveBusinessCompletion} from '../../../packages/fiscal-core/src/business-completion.mjs';

const BASE='/v1/complemento-fiscal',MAX_BODY=524288;
export const FISCAL_COMPLETION_RESPONSE_BYTES=2*1024*1024;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const routes=new WeakSet();
export class FiscalCompletionError extends Error{constructor(status,code){super(code);this.name='FiscalCompletionError';this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new FiscalCompletionError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string'&&UUID.test(v),hash=v=>typeof v==='string'&&HASH.test(v);
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
const choice=(v,values)=>v===null||typeof v==='string'&&values.includes(v);
const text=(v,max)=>v===null||typeof v==='string'&&v.length>=1&&v.length<=max&&/^[\x21-\x7e\xa0-\xff](?:[\x20-\x7e\xa0-\xff]*[\x21-\x7e\xa0-\xff])?$/.test(v);
const money=v=>v===null||typeof v==='string'&&/^(?:0|[1-9][0-9]{0,12})\.[0-9]{2}$/.test(v);
const decimal=(v,scale,positive=false)=>v===null||typeof v==='string'&&new RegExp(`^(?:0|[1-9][0-9]{0,10})(?:\\.[0-9]{1,${scale}})?$`).test(v)&&(!positive||/[1-9]/.test(v));
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]]));
function freeze(v){if(v!==null&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
function equal(a,b){if(a===b)return true;if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));return object(a)&&object(b)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));}
function stamp(v){
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v))return false;
 const[y,m,d,h,minute,s]=v.slice(0,19).split(/[-T:]/).map(Number),offset=v.endsWith('Z')?[0,0]:v.slice(-5).split(':').map(Number);
 return y>=2000&&m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate()&&h<=23&&minute<=59&&s<=59&&offset[0]<=14&&offset[1]<=59&&(offset[0]!==14||offset[1]===0)&&Number.isFinite(Date.parse(v));
}

// Only the union of allowed input shapes is checked here. Model, CEST, CSOSN,
// item membership/order and all captured versions are resolved in one SQL transaction.
function inputCompletion(v){
 if(!exact(v,['operation','recipient','items','totals','payments','transport_mode','excluded_groups','homologation_labels','additional_information'])
  ||!exact(v.operation,['tpNF','idDest','finNFe','indFinal','indPres'])||!['tpNF','idDest','finNFe','indPres'].every(k=>choice(v.operation[k],['1']))||!choice(v.operation.indFinal,['0','1'])
  ||!exact(v.recipient,['municipality_code','indIEDest'])||!(v.recipient.municipality_code===null||typeof v.recipient.municipality_code==='string'&&/^35[0-9]{5}$/.test(v.recipient.municipality_code))||!choice(v.recipient.indIEDest,['1','2','9'])
  ||!exact(v.totals,COMPLETION_TOTAL_FIELDS)||!Object.values(v.totals).every(money)||!Array.isArray(v.items)||v.items.length<1||v.items.length>250
  ||!exact(v.payments,['items','change'])||!Array.isArray(v.payments.items)||v.payments.items.length>100||!money(v.payments.change)
  ||!choice(v.transport_mode,['0','1','2','3','4','9'])||!exact(v.excluded_groups,COMPLETION_EXCLUDED_FIELDS)||!Object.values(v.excluded_groups).every(x=>choice(x,['not_included_in_profile']))
  ||!choice(v.homologation_labels,['apply_test_labels'])||!text(v.additional_information,2000))fail();
 for(const p of v.payments.items)if(!exact(p,['type','timing','amount'])||!choice(p.type,['01','15'])||!choice(p.timing,['0','1'])||!money(p.amount))fail();
 const seen=new Set();
 for(const i of v.items){
  if(!exact(i,['item_id','tributary','allocations','cest_absence','icms'])||!id(i.item_id)||seen.has(i.item_id)
   ||!exact(i.tributary,['unit','quantity','unit_price'])||!text(i.tributary.unit,6)||!decimal(i.tributary.quantity,6,true)||!decimal(i.tributary.unit_price,10)
   ||!exact(i.allocations,['global_discount','freight','other'])||!Object.values(i.allocations).every(money)||!choice(i.cest_absence,['omit'])||!exact(i.icms,['credit','groups500']))fail();
  const{credit,groups500}=i.icms;
  if(credit!==null&&(!exact(credit,['base','amount'])||!Object.values(credit).every(money))||groups500!==null&&(!exact(groups500,['retention','fcp','effective'])||!Object.values(groups500).every(x=>choice(x,['include','omit'])))||credit!==null&&groups500!==null)fail();
  seen.add(i.item_id);
 }
}

async function body(request){
 if(!request.body||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>MAX_BODY))fail(413,'ERP_BODY_TOO_LARGE');
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,value='',timer,rejectStop;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;timer=setTimeout(()=>reject(new FiscalCompletionError(408,'ERP_BODY_TIMEOUT')),5000);});
 const abort=()=>rejectStop(new FiscalCompletionError(400,'ERP_REQUEST_ABORTED'));request.signal.addEventListener('abort',abort,{once:true});
 try{
  for(;;){if(request.signal.aborted)abort();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;if(!(part.value instanceof Uint8Array)||(bytes+=part.value.length)>MAX_BODY)fail(413,'ERP_BODY_TOO_LARGE');value+=decoder.decode(part.value,{stream:true});}
  if(length!==null&&Number(length)!==bytes)fail();return JSON.parse(value+decoder.decode());
 }catch(error){if(error instanceof FiscalCompletionError)throw error;fail();}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{/* body is never logged */}}
}
export function fiscalCompletionRoute(path){
 const m=/^\/v1\/complemento-fiscal\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(history|preview|save))?$/i.exec(path);
 return m&&(!m[2]||['history','preview','save'].includes(m[2]))?{id:m[1].toLowerCase(),operation:m[2]??'get'}:null;
}
export const fiscalCompletionMethods=route=>{const r=typeof route==='string'?fiscalCompletionRoute(route):route;return r?(['preview','save'].includes(r.operation)?['POST']:['GET']):null;};
export async function parseFiscalCompletionRoute(request){
 const url=new URL(request.url);if(url.pathname!==BASE&&!url.pathname.startsWith(BASE+'/'))return null;
 const shape=fiscalCompletionRoute(url.pathname);if(!shape)fail(404,'ERP_NOT_FOUND');if(!fiscalCompletionMethods(shape).includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 const encoding=request.headers.get('content-encoding');if(encoding!==null&&encoding!=='identity')fail();
 const args={p_draft_id:shape.id};
 if(request.method==='GET'){
  if(request.body!==null)fail();const allowed=shape.operation==='history'?['limit','before']:['version'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)fail();
  const integer=(key,fallback)=>{const x=url.searchParams.get(key);if(x===null)return fallback;if(!/^[1-9][0-9]{0,9}$/.test(x)||!version(Number(x)))fail();return Number(x);};
  if(shape.operation==='history'){args.p_limit=integer('limit',25);args.p_before=integer('before',null);if(args.p_limit>25)fail();}else args.p_version=integer('version',null);
 }else{
  if(url.search)fail();const v=await body(request),keys=['expected_draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','expected_identity_version','expected_fiscal_version','expected_completion_version','completion',...(shape.operation==='save'?['command_id']:[])];
  if(!exact(v,keys)||!['expected_draft_version','item_preparation_version','tax_preparation_version','expected_identity_version','expected_fiscal_version'].every(k=>version(v[k]))||!version(v.expected_completion_version,0)||v.expected_completion_version===2147483647||!hash(v.snapshot_hash)||shape.operation==='save'&&!id(v.command_id))fail();
  inputCompletion(v.completion);for(const key of keys)args['p_'+key]=v[key];
 }
 const route=freeze({...shape,rpc:'erp_fiscal_completion_'+shape.operation,args});routes.add(route);return route;
}

const metadataKeys=['draft_id','version','draft_version','snapshot_hash','item_preparation_version','tax_preparation_version','item_preparation_hash','tax_preparation_hash','model','environment','company_identity_version','company_fiscal_version','source_document_id','source_document_version','created_at'];
function metadata(v,route,preview=false){
 if(!object(v)||v.draft_id!==route.id||!['version','draft_version','item_preparation_version','tax_preparation_version','company_identity_version','company_fiscal_version','source_document_version'].every(k=>version(v[k]))
  ||!['snapshot_hash','item_preparation_hash','tax_preparation_hash'].every(k=>hash(v[k]))||!['55','65'].includes(v.model)||v.environment!=='2'||!id(v.source_document_id)||(preview?v.created_at!==null:!stamp(v.created_at)))bad();
 return pick(v,metadataKeys);
}
function record(v,route){
 const result=metadata(v,route,route.operation==='preview');
 // The captured basis is evidence from the RPC, never reconstructed from mutable catalog data.
 const resolved=resolveBusinessCompletion(v.completion,{model:result.model,items:v.item_basis});
 if(!equal(v.pending,resolved.pending))bad();
 if(['preview','save'].includes(route.operation)){
  const p=route.args;
  if(result.version!==p.p_expected_completion_version+1||result.draft_version!==p.p_expected_draft_version||result.snapshot_hash!==p.p_snapshot_hash||result.item_preparation_version!==p.p_item_preparation_version||result.tax_preparation_version!==p.p_tax_preparation_version
   ||result.company_identity_version!==p.p_expected_identity_version||result.company_fiscal_version!==p.p_expected_fiscal_version||!equal(resolved.completion,p.p_completion))bad();
 }
 return{...result,item_basis:structuredClone(v.item_basis),...resolved};
}
const currentKeys=['completion_version','draft_version','draft_status','source_document_version','source_status','source_changed','company_changed','identity_version','fiscal_version','item_preparation_version','tax_preparation_version','matches_current_draft','matches_current_item_preparation','matches_current_tax_preparation','matches_current_company'];
function current(v,rec){
 if(!object(v)||!version(v.completion_version,0)||!version(v.draft_version)||!version(v.source_document_version)||!['draft','archived'].includes(v.draft_status)
  ||!['draft','open','verified','in_progress','agency_sale','checkout_partial','partially_fulfilled','partially_invoiced','fulfilled','cancelled'].includes(v.source_status)||!['identity_version','fiscal_version'].every(k=>v[k]===null||version(v[k]))
  ||!['item_preparation_version','tax_preparation_version'].every(k=>version(v[k],0))||!['source_changed','company_changed','matches_current_draft','matches_current_item_preparation','matches_current_tax_preparation','matches_current_company'].every(k=>typeof v[k]==='boolean'))bad();
 const matches={matches_current_draft:rec!==null&&rec.draft_version===v.draft_version,matches_current_item_preparation:rec!==null&&rec.item_preparation_version===v.item_preparation_version,
  matches_current_tax_preparation:rec!==null&&rec.tax_preparation_version===v.tax_preparation_version,matches_current_company:rec!==null&&rec.company_identity_version===v.identity_version&&rec.company_fiscal_version===v.fiscal_version};
 if(Object.entries(matches).some(([key,value])=>v[key]!==value))bad();
 if(rec&&(v.draft_version<rec.draft_version||v.source_document_version<rec.source_document_version||v.item_preparation_version<rec.item_preparation_version||v.tax_preparation_version<rec.tax_preparation_version))bad();
 if(matches.matches_current_draft&&(v.source_changed!==(v.source_document_version!==rec.source_document_version)||v.company_changed!==!matches.matches_current_company))bad();
 return pick(v,currentKeys);
}
function output(raw,route){
 if(!object(raw)||Object.entries(COMPLETION_FLAGS).some(([k,v])=>raw[k]!==v))bad();
 if(route.operation==='history'){
  if(raw.draft_id!==route.id||raw.limit!==route.args.p_limit||!Array.isArray(raw.items)||raw.items.length>raw.limit||typeof raw.has_more!=='boolean'||raw.has_more&&raw.items.length!==raw.limit)bad();
  let prior=route.args.p_before??2147483648,model=null,source=null;
  const items=raw.items.map(v=>{const item=metadata(v,route);if(item.version>=prior||model!==null&&item.model!==model||source!==null&&item.source_document_id!==source)bad();prior=item.version;model=item.model;source=item.source_document_id;return item;});
  const next=raw.has_more?items.at(-1)?.version:null;if(raw.next_cursor!==next)bad();return{...COMPLETION_FLAGS,draft_id:route.id,items,limit:raw.limit,has_more:raw.has_more,next_cursor:next};
 }
 const rec=raw.record===null?null:record(raw.record,route),now=current(raw.current,rec);
 if(rec===null){if(route.operation!=='get'||route.args.p_version!==null||now.completion_version!==0)bad();}
 else if(route.operation==='preview'){
  if(raw.persisted!==false||raw.expected_completion_version!==route.args.p_expected_completion_version||rec.version!==now.completion_version+1||!now.matches_current_draft||!now.matches_current_item_preparation||!now.matches_current_tax_preparation||!now.matches_current_company||now.source_changed||now.company_changed||now.draft_status!=='draft'||now.source_status==='cancelled')bad();
 }else if(rec.version>now.completion_version)bad();
 if(route.operation==='get'&&rec!==null&&rec.version!==(route.args.p_version??now.completion_version))bad();
 if(route.operation==='save'&&(!rec||typeof raw.replayed!=='boolean'))bad();
 return{...COMPLETION_FLAGS,record:rec,current:now,...(route.operation==='preview'?{persisted:false,expected_completion_version:raw.expected_completion_version}:route.operation==='save'?{replayed:raw.replayed}:{})};
}
function sqlError(error){
 if(error instanceof FiscalCompletionError)throw error;
 const mapping={22023:[400,'ERP_INVALID_QUERY'],42501:[403,'ERP_FORBIDDEN'],P0002:[404,'ERP_NOT_FOUND'],40001:[409,'ERP_CONFLICT'],23505:[409,'ERP_CONFLICT'],55000:[503,'ERP_FISCAL_COMPLETION_UNAVAILABLE']};
 const statuses={400:'ERP_INVALID_QUERY',401:'ERP_UNAUTHORIZED',403:'ERP_FORBIDDEN',404:'ERP_NOT_FOUND',409:'ERP_CONFLICT',503:'ERP_FISCAL_COMPLETION_UNAVAILABLE',504:'ERP_UPSTREAM_TIMEOUT'};
 if(Object.hasOwn(mapping,error?.code))fail(...mapping[error.code]);if(Object.hasOwn(statuses,error?.status))fail(error.status,statuses[error.status]);bad();
}
export async function executeFiscalCompletionRoute(route,{userId,rpc,timeoutMs=15000,signal}={}){
 if(!route||!routes.has(route))fail(404,'ERP_NOT_FOUND');if(typeof userId!=='string'||!id(userId.toLowerCase()))fail(401,'ERP_UNAUTHORIZED');
 if(typeof rpc!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)bad();
 const controller=new AbortController();let timer,rejectStop,rpcStarted=false;
 const stopped=new Promise((_,reject)=>{rejectStop=reject;timer=setTimeout(()=>{controller.abort();reject(new FiscalCompletionError(504,'ERP_UPSTREAM_TIMEOUT'));},timeoutMs);});
 // Cancellation cannot establish whether a dispatched transaction committed.
 const abort=()=>{controller.abort();rejectStop(new FiscalCompletionError(rpcStarted?503:400,rpcStarted?'ERP_RESULT_UNCONFIRMED':'ERP_REQUEST_ABORTED'));};signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)fail(400,'ERP_REQUEST_ABORTED');
  const raw=await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)fail(400,'ERP_REQUEST_ABORTED');rpcStarted=true;return rpc(route.rpc,{...route.args,p_user_id:userId.toLowerCase()},{signal:controller.signal});}),stopped]);
  const result=output(raw,route);if(new TextEncoder().encode(JSON.stringify(result)).length>FISCAL_COMPLETION_RESPONSE_BYTES)bad();return{type:'json',body:result};
 }catch(error){sqlError(error);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
