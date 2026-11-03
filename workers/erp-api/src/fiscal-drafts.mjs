/** Local fiscal preparation only. This module has no XML, certificate, transport or numbering code. */
import {normalizeDocument,STATES} from '../../../packages/erp-domain/src/index.mjs';
import {normalizeCompany} from '../../../packages/erp-domain/src/company.mjs';

const PREFIX='/v1/rascunhos-fiscais';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const TOTALS=['gross','line_discount','subtotal','discount','freight','other_expenses','total'];
const TAX_KEYS=['tax_ipi','tax_icms_st'];
const ITEM_FIELDS=['id','product_id','description','code','unit','quantity','unit_price','discount_percent'];
const CONTACT_FIELDS={name:200,person_type:1,document:30,ie:30,postal_code:20,street:200,number:30,complement:200,district:100,city:100,state:2};
const PRODUCT_FIELDS={name:200,code:100,unit:16,kind:1,format:1,ncm:8,gtin:14};
const COMPANY_FIELDS=['legal_name','trade_name','cnpj','ie','postal_code','street','number','complement','district','city','municipality_code','state'];
export const FISCAL_DRAFT_PENDING=Object.freeze(['TAX_REVIEW_REQUIRED','CATALOG_SNAPSHOTS_REQUIRE_REVIEW','RECIPIENT_FISCAL_MAPPING_REQUIRED',
 'ITEM_FISCAL_MAPPING_REQUIRED','PAYMENT_FISCAL_MAPPING_REQUIRED','FISCAL_XML_NOT_BUILT','XSD_NOT_VALIDATED','SIGNATURE_NOT_CREATED',
 'TRANSPORT_UNAVAILABLE','HOMOLOGATION_NOT_PERFORMED','COMPANY_IDENTITY_MISSING','COMPANY_STATE_OUTSIDE_PROFILE','COMPANY_IE_MISSING',
 'REGIME_UNCONFIRMED','OPERATION_NATURE_MISSING','RECIPIENT_DOCUMENT_MISSING','RECIPIENT_ADDRESS_INCOMPLETE','ITEM_WITHOUT_CATALOG_LINK',
 'ITEM_KIND_REQUIRES_REVIEW','ITEM_NCM_MISSING','PAYMENT_PLAN_MISSING','SOURCE_DOCUMENT_CHANGED','COMPANY_CONFIGURATION_CHANGED','SOURCE_DOCUMENT_CANCELLED','DRAFT_ARCHIVED']);
export class FiscalDraftError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new FiscalDraftError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new FiscalDraftError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&UUID.test(v);
const version=v=>Number.isInteger(v)&&v>0&&v<=2147483647;
const text=(v,max,multiline=false)=>typeof v==='string'&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(multiline?v.replace(/[\r\n\t]/g,''):v);
const timestamp=v=>text(v,100)&&Number.isFinite(Date.parse(v));
const pick=(v,fields)=>Object.fromEntries(fields.map(k=>[k,v[k]]));
const only=(v,fields)=>object(v)&&Object.keys(v).every(k=>fields.includes(k));
const nullable=(v,check)=>v===null||check(v);
const prepValid=v=>only(v,['operation_nature','notes'])&&nullable(v.operation_nature,x=>text(x,60))&&nullable(v.notes,x=>text(x,4000,true));
function preparation(v,fail=invalid){
 if(!only(v,['operation_nature','notes']))fail();
 const result={operation_nature:v.operation_nature??null,notes:v.notes??null};
 if(!prepValid(result))fail();return result;
}
async function readBody(request){
 const length=request.headers.get('content-length');
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body
  ||(length!==null&&(!/^\d+$/.test(length)||Number(length)>16384)))invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,value='';
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384)invalid();value+=decoder.decode(part.value,{stream:true});}
  const parsed=JSON.parse(value+decoder.decode());if(!object(parsed))invalid();return parsed;
 }catch{return invalid();}finally{try{await reader.cancel();}catch{/* Never log body data. */}reader.releaseLock();}
}
export function fiscalDraftRoute(path){
 const match=/^\/v1\/rascunhos-fiscais(?:\/([a-fA-F0-9-]+)(?:\/(refresh|archive|revisions)(?:\/([0-9]+))?)?)?$/.exec(path);
 if(!match||(match[1]&&!id(match[1]))||(match[3]&&(match[2]!=='revisions'||!version(Number(match[3]))||String(Number(match[3]))!==match[3])))return null;
 return{id:match[1]?.toLowerCase()??null,action:match[2]??null,revision:match[3]?Number(match[3]):null};
}
export const fiscalDraftMethods=route=>route?.action==='refresh'||route?.action==='archive'?['POST']:route?.action==='revisions'?['GET']:route?.id?['GET','PATCH']:['GET','POST'];
export async function parseFiscalDraftRoute(request){
 const url=new URL(request.url);if(!url.pathname.startsWith(PREFIX))return null;
 const route=fiscalDraftRoute(url.pathname);if(!route)throw new FiscalDraftError(404,'ERP_NOT_FOUND');
 if(!fiscalDraftMethods(route).includes(request.method))throw new FiscalDraftError(405,'ERP_METHOD_NOT_ALLOWED');
 if(request.method==='GET'){
  if(route.id&&(route.action!=='revisions'||route.revision)){
   if(url.search)invalid();return{...route,operation:'get',rpc:'erp_fiscal_draft_get',args:{p_id:route.id,p_revision:route.revision}};
  }
  const allowed=route.id?['limit','after']:['limit','after','model','status','source_document_id'];
  for(const key of url.searchParams.keys())if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)invalid();
  const limit=url.searchParams.get('limit')??'25',after=url.searchParams.get('after');
  if(!/^\d{1,2}$/.test(limit)||Number(limit)<1||Number(limit)>25)invalid();
  if(route.id){
   if(after!==null&&(!/^[1-9]\d{0,9}$/.test(after)||!version(Number(after))))invalid();
   return{...route,operation:'revisions',rpc:'erp_fiscal_draft_revisions',args:{p_id:route.id,p_limit:Number(limit),p_after:after===null?null:Number(after)}};
  }
  const model=url.searchParams.get('model'),status=url.searchParams.get('status'),source=url.searchParams.get('source_document_id');
  if((model!==null&&!['55','65'].includes(model))||(status!==null&&!['draft','archived'].includes(status))||(source!==null&&!id(source))||(after!==null&&!id(after)))invalid();
  return{...route,operation:'list',rpc:'erp_fiscal_draft_list',args:{p_model:model,p_status:status,p_source_document_id:source?.toLowerCase()??null,p_limit:Number(limit),p_after:after?.toLowerCase()??null}};
 }
 if(url.search)invalid();const input=await readBody(request),action=route.action||(route.id?'update':'create');
 const fields=action==='create'?['command_id','source_document_id','expected_source_version','model','preparation']
  :action==='update'?['command_id','expected_version','preparation']:action==='refresh'?['command_id','expected_version','expected_source_version']:['command_id','expected_version','reason'];
 if(!only(input,fields)||!id(input.command_id))invalid();
 const data={};if(route.id){if(!version(input.expected_version))invalid();data.id=route.id;data.expected_version=input.expected_version;}
 if(action==='create'||action==='refresh'){if(!version(input.expected_source_version))invalid();data.expected_source_version=input.expected_source_version;}
 if(action==='create'){
  if(!id(input.source_document_id)||!['55','65'].includes(input.model))invalid();data.source_document_id=input.source_document_id.toLowerCase();data.model=input.model;
 }
 if(action==='create'||action==='update')data.preparation=preparation(input.preparation);
 if(action==='archive'){if(!text(input.reason,1000)||input.reason.trim().length<3)invalid();data.reason=input.reason;}
 return{...route,operation:action,rpc:'erp_fiscal_draft_execute',args:{p_command_id:input.command_id.toLowerCase(),p_action:action,p_data:data}};
}
function catalogSnapshot(v,expectedId,fields){
 if(expectedId===null){if(v!==null)bad();return null;}
 if(!object(v)||v.id!==expectedId||!version(v.version)||!text(v.name,200)||!v.name)bad();
 const result={id:v.id,version:v.version};
 for(const [key,max]of Object.entries(fields)){if(!nullable(v[key],x=>text(x,max)))bad();result[key]=v[key];}
 return result;
}
function companySnapshot(v){
 if(v===null)return null;
 if(!object(v)||!version(v.identity_version)||!nullable(v.fiscal_version,version)||!object(v.identity)
  ||!nullable(v.crt,x=>['1','2','3','4'].includes(x))||typeof v.regime_confirmed!=='boolean'||v.regime_confirmed!==(v.crt!==null)
  ||(v.fiscal_version===null&&v.crt!==null))bad();
 // 302: a company of Pessoa Física keeps its CPF in the identity; the copy of a draft is read as it was taken.
 let normalized;try{normalized=normalizeCompany({...pick(v.identity,COMPANY_FIELDS),phone:null,email:null},{document:'any'});}catch{return bad();}
 if(COMPANY_FIELDS.some(key=>normalized[key]!==v.identity[key]))bad();
 return{identity_version:v.identity_version,fiscal_version:v.fiscal_version,identity:pick(normalized,COMPANY_FIELDS),crt:v.crt,regime_confirmed:v.regime_confirmed};
}
const CENTS=/^\d{1,13}\.\d{2}$/;
const cents=v=>BigInt(v.replace('.',''));
const money=v=>{const s=String(v);return `${s.length>2?s.slice(0,-2):'0'}.${s.padStart(2,'0').slice(-2)}`;};
/**
 * 202610200251: the copy of a pedido that adds Total do IPI / Total ICMS ST (documentos 196) carries tax_ipi / tax_icms_st and the
 * totals ipi / icms_st. A copy made before 251 kept only the old totals while its total already had the taxes: it is read with
 * legacy_taxes (IPI + ICMS ST together, not split), never by guessing the split.
 */
function orderTaxes(v){
 const keys=TAX_KEYS.filter(key=>Object.hasOwn(v,key)),totals=['ipi','icms_st'].filter(key=>Object.hasOwn(v.totals,key));
 if(keys.some(key=>typeof v[key]!=='string'||!CENTS.test(v[key]))||Object.hasOwn(v,'legacy_taxes')||(keys.length?totals.length!==2:totals.length!==0))bad();
 if(keys.length)return{input:Object.fromEntries(keys.map(key=>[key,v[key]])),legacy:null};
 // A copy without the taxes: its total must be the commercial total, or the commercial total plus the taxes of a pre-251 copy.
 if(!CENTS.test(v.totals.total??'')||!['gross','line_discount','discount','freight','other_expenses'].every(key=>CENTS.test(v.totals[key]??'')))bad();
 const commercial=cents(v.totals.gross)-cents(v.totals.line_discount)-cents(v.totals.discount)+cents(v.totals.freight)+cents(v.totals.other_expenses),extra=cents(v.totals.total)-commercial;
 if(extra<0n)bad();
 return extra===0n?{input:{},legacy:null}:{input:{tax_ipi:money(extra)},legacy:money(extra)};
}
function sourceSnapshot(v,record){
 if(!object(v)||v.catalog_basis!=='document_snapshot'||v.kind!=='sales_orders'||v.document_id!==record.source_document_id||v.document_version!==record.source_document_version
  ||!text(v.number,10)||!/^[1-9]\d{0,9}$/.test(v.number)||!Object.hasOwn(STATES.sales_orders,v.status)||!id(v.contact_id)
  ||!Array.isArray(v.items)||!Array.isArray(v.installments)||!object(v.totals))bad();
 const taxes=orderTaxes(v);
 const input={date:v.date,contact_id:v.contact_id,items:v.items.map(row=>object(row)?pick(row,ITEM_FIELDS):null),
  installments:v.installments.map(row=>object(row)?pick(row,['due_date','amount','method']):null),discount_mode:v.discount_mode,discount_value:v.discount_value,
  freight:v.totals.freight,other_expenses:v.totals.other_expenses,notes:v.notes,payment_terms:v.payment_terms,delivery_terms:v.delivery_terms,...taxes.input};
 let normalized;try{normalized=normalizeDocument('sales_orders',input);}catch{return bad();}
 if(TOTALS.some(key=>normalized.totals[key]!==v.totals[key])||normalized.discount_value!==v.discount_value)bad();
 const taxed=Object.hasOwn(v.totals,'ipi');
 if(taxed&&(normalized.totals.ipi!==v.totals.ipi||normalized.totals.icms_st!==v.totals.icms_st||TAX_KEYS.some(key=>Object.hasOwn(v,key)&&normalized[key]!==v[key])))bad();
 const seen=new Set();const items=normalized.items.map((row,index)=>{
  const actual=v.items[index];if(!id(row.id)||seen.has(row.id)||actual.position!==index+1||['quantity','unit_price','discount_percent','gross','discount','total'].some(key=>row[key]!==actual[key]))bad();seen.add(row.id);
  return{...pick(row,[...ITEM_FIELDS,'position','gross','discount','total']),product:catalogSnapshot(actual.product,row.product_id,PRODUCT_FIELDS)};
 });
 if(v.installments.some((row,index)=>row.position!==index+1||row.amount!==normalized.installments[index].amount))bad();
 return{...pick(v,['catalog_basis','document_id','document_version','kind','number','status','date','contact_id','discount_mode','discount_value','notes','payment_terms','delivery_terms']),
  contact:catalogSnapshot(v.contact,v.contact_id,CONTACT_FIELDS),items,totals:pick(normalized.totals,taxed?[...TOTALS,'ipi','icms_st']:TOTALS),installments:normalized.installments,company:companySnapshot(v.company),
  ...pick(v,TAX_KEYS.filter(key=>Object.hasOwn(v,key))),...(taxes.legacy?{legacy_taxes:taxes.legacy}:{})};
}
function metadata(v){
 if(!object(v)||!id(v.id)||!['55','65'].includes(v.model)||v.environment!=='2'||!['draft','archived'].includes(v.status)||!version(v.version)
  ||!id(v.source_document_id)||!version(v.source_document_version)||!timestamp(v.created_at)||!timestamp(v.updated_at))bad();
 return pick(v,['id','model','environment','status','version','source_document_id','source_document_version','created_at','updated_at']);
}
function record(v){
 const meta=metadata(v);if(!HASH.test(v.snapshot_hash||'')||!prepValid(v.preparation)
  ||(v.status==='draft'?(v.archived_at!==null||v.archive_reason!==null):(!timestamp(v.archived_at)||!text(v.archive_reason,1000)||v.archive_reason.trim().length<3)))bad();
 return{...meta,snapshot:sourceSnapshot(v.snapshot,meta),snapshot_hash:v.snapshot_hash,preparation:preparation(v.preparation,bad),archived_at:v.archived_at,archive_reason:v.archive_reason};
}
function summary(v){
 const meta=metadata(v);if(!text(v.order_number,10)||!/^[1-9]\d{0,9}$/.test(v.order_number)||!text(v.contact_name,200)||!v.contact_name
  ||typeof v.total!=='string'||!/^\d{1,12}\.\d{2}$/.test(v.total))bad();
 return{...meta,order_number:v.order_number,contact_name:v.contact_name,total:v.total};
}
function current(v,rec){
 if(!object(v)||!version(v.version)||v.version<rec.version||!['draft','archived'].includes(v.status)||!version(v.source_document_version)
  ||!Object.hasOwn(STATES.sales_orders,v.source_status)||!nullable(v.identity_version,version)||!nullable(v.fiscal_version,version)
  ||v.source_changed!==(v.source_document_version!==rec.source_document_version)
  ||v.company_changed!==((v.identity_version!==(rec.snapshot.company?.identity_version??null))||(v.fiscal_version!==(rec.snapshot.company?.fiscal_version??null))))bad();
 if((v.version===rec.version&&v.status!==rec.status)||(rec.status==='archived'&&v.status!=='archived'))bad();
 return pick(v,['version','status','source_document_version','source_status','identity_version','fiscal_version','source_changed','company_changed']);
}
function pending(rec,ctx){
 const s=rec.snapshot,codes=FISCAL_DRAFT_PENDING.slice(0,10);
 if(s.company===null)codes.push('COMPANY_IDENTITY_MISSING');
 else{if(s.company.identity.state!=='SP')codes.push('COMPANY_STATE_OUTSIDE_PROFILE');if(!s.company.identity.ie)codes.push('COMPANY_IE_MISSING');}
 if(!s.company?.crt)codes.push('REGIME_UNCONFIRMED');
 if(!rec.preparation.operation_nature)codes.push('OPERATION_NATURE_MISSING');
 if(!s.contact.document)codes.push('RECIPIENT_DOCUMENT_MISSING');
 if(['postal_code','street','number','district','city','state'].some(k=>!s.contact[k]))codes.push('RECIPIENT_ADDRESS_INCOMPLETE');
 if(s.items.some(i=>i.product_id===null))codes.push('ITEM_WITHOUT_CATALOG_LINK');
 if(s.items.some(i=>i.product?.kind!=='P'))codes.push('ITEM_KIND_REQUIRES_REVIEW');
 if(s.items.some(i=>!i.product?.ncm))codes.push('ITEM_NCM_MISSING');
 if(s.installments.length===0)codes.push('PAYMENT_PLAN_MISSING');
 if(ctx.source_changed)codes.push('SOURCE_DOCUMENT_CHANGED');if(ctx.company_changed)codes.push('COMPANY_CONFIGURATION_CHANGED');
 if(ctx.source_status==='cancelled')codes.push('SOURCE_DOCUMENT_CANCELLED');if(ctx.status==='archived')codes.push('DRAFT_ARCHIVED');
 return codes;
}
export async function executeFiscalDraftRoute(route,{userId,rpc}){
 if(!route)throw new FiscalDraftError(404,'ERP_NOT_FOUND');
 const value=await rpc(route.rpc,{p_user_id:userId,...route.args});
 if(!object(value)||value.data_mode!=='fiscal_draft'||value.emission_enabled!==false||value.operational_effects!==false)bad();
 const base={data_mode:'fiscal_draft',emission_enabled:false,operational_effects:false};
 if(route.operation==='list'||route.operation==='revisions'){
  if(!Array.isArray(value.items)||value.items.length>route.args.p_limit||value.limit!==route.args.p_limit||typeof value.has_more!=='boolean')bad();
  const rows=value.items.map(summary),seen=new Set();let previous=route.args.p_after;
  for(const row of rows){
   const key=route.operation==='list'?row.id:row.version;if(seen.has(key)||(previous!==null&&key<=previous))bad();seen.add(key);previous=key;
   if(route.operation==='list'&&((route.args.p_model!==null&&row.model!==route.args.p_model)||(route.args.p_status!==null&&row.status!==route.args.p_status)
     ||(route.args.p_source_document_id!==null&&row.source_document_id!==route.args.p_source_document_id)))bad();
   if(route.operation==='revisions'&&row.id!==route.id)bad();
  }
  const next=route.operation==='list'?rows.at(-1)?.id:rows.at(-1)?.version;
  if(value.has_more?value.next_cursor!==next||rows.length!==value.limit:value.next_cursor!==null)bad();
  if(route.operation==='revisions'&&value.draft_id!==route.id)bad();
  return{...base,...(route.operation==='revisions'?{draft_id:route.id}:{}),items:rows,limit:value.limit,has_more:value.has_more,next_cursor:value.next_cursor};
 }
 const rec=record(value.record),ctx=current(value.current,rec);
 if((route.id&&rec.id!==route.id)||(route.revision!==null&&route.revision!==undefined&&rec.version!==route.revision)
  ||(route.operation==='create'&&(rec.source_document_id!==route.args.p_data.source_document_id||rec.source_document_version!==route.args.p_data.expected_source_version||rec.model!==route.args.p_data.model)))bad();
 if(route.operation==='get'&&route.revision===null&&rec.version!==ctx.version)bad();
 const required=pending(rec,ctx);
 if(!Array.isArray(value.pending)||value.pending.length!==required.length||new Set(value.pending).size!==value.pending.length||value.pending.some(code=>!required.includes(code)))bad();
 const result={...base,record:rec,current:ctx,pending:[...value.pending]};
 if(route.operation!=='get'){
  if(value.action!==route.operation||typeof value.replayed!=='boolean')bad();
  if(rec.version!==(route.operation==='create'?1:route.args.p_data.expected_version+1)||rec.status!==(route.operation==='archive'?'archived':'draft')
    ||(route.operation==='refresh'&&rec.source_document_version!==route.args.p_data.expected_source_version))bad();
  return{...result,action:value.action,replayed:value.replayed};
 }
 return result;
}
