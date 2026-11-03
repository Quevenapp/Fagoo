import { EXTENSION_FIELDS,INITIAL_STATE,KINDS,normalizeDocument } from '../../../packages/erp-domain/src/index.mjs';
import { documentsResponse } from './documents.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// 202610200287: campos customizados of the OS.
const FIELDS=['date','contact_id','warehouse_id','expected_date','valid_until','next_contact','template','items','discount_mode','discount_value','freight','other_expenses','installments','notes','internal_notes','payment_terms','delivery_terms','equipment','serial_number','technician','defect','solution','commercial','tax_ipi','tax_icms_st','custom_fields',...EXTENSION_FIELDS];
// 202610200196: Preço lista and Código no fornecedor of the items, Forma and details of the parcelas.
// 202610200268: Peças / Serviços executados of the OS (group, Orçar and OK).
// 202610200287: Informar lotes, Garantia of the item of the OS and IPI % of the item of the pedido de compra.
const ITEM_FIELDS=['id','product_id','description','code','unit','quantity','unit_price','discount_percent','detailed_description','list_price','supplier_code','group','quote','done','lots','warranty_days','ipi_rate'];
const RESET_FIELDS=['date','expected_date','valid_until','next_contact','installments','template','equipment','serial_number','technician','defect','solution'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),uuid=v=>typeof v==='string'&&UUID.test(v);
const version=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const pick=(v,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(v,key)).map(key=>[key,v[key]]));
export class DocumentCopyError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new DocumentCopyError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
export const documentCopyMethods=path=>path.startsWith('/v1/duplicacao-documentos/')?/\/(preview|origin)$/.test(path)?['GET']:['POST']:null;
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body)fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))fail();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='',timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new DocumentCopyError(408,'ERP_REQUEST_TIMEOUT'));},10000);});
 try{for(;;){const{done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>262144)fail();text+=decoder.decode(value,{stream:true});}text+=decoder.decode();const input=JSON.parse(text);if(!object(input))fail();return input;}
 catch(error){if(error instanceof DocumentCopyError)throw error;fail();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function parseDocumentCopyRoute(request){
 const url=new URL(request.url),methods=documentCopyMethods(url.pathname);if(!methods)return null;
 const match=/^\/v1\/duplicacao-documentos\/(sales_proposals|sales_orders|purchase_orders|service_orders)\/([a-fA-F0-9-]+)(\/(?:preview|origin))?$/.exec(url.pathname);
 if(!match||!uuid(match[2]))fail(404,'ERP_NOT_FOUND');if(!methods.includes(request.method))fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.searchParams.size||(request.headers.has('Content-Encoding')&&request.headers.get('Content-Encoding')!=='identity'))fail();
 const args={p_kind:match[1],p_source_id:match[2].toLowerCase()};
 if(match[3]==='/origin')return{type:'origin',rpc:'erp_document_copy_origin',args:{p_kind:args.p_kind,p_document_id:args.p_source_id}};
 if(match[3])return{type:'preview',rpc:'erp_document_copy_preview',args};
 const input=await body(request);
 if(Object.keys(input).some(key=>!['command_id','expected_source_version','data'].includes(key))||!uuid(input.command_id)||!version(input.expected_source_version))fail();
 try{normalizeDocument(args.p_kind,input.data);}catch{fail();}
 // "Editar número" (202610200129) belongs to the document save; the copy always takes the automatic number.
 if(Object.hasOwn(input.data,'number'))fail();
 return{type:'copy',rpc:'erp_document_copy',args:{...args,p_command_id:input.command_id.toLowerCase(),p_expected_source_version:input.expected_source_version,p_body:input.data}};
}
function source(value,route){
 if(!object(value)||value.id!==route.args.p_source_id||value.kind!==route.args.p_kind||!version(value.version)
  ||typeof value.number!=='string'||!/^[1-9][0-9]{0,9}$/.test(value.number))bad();
 return{id:value.id,kind:value.kind,number:value.number,version:value.version};
}
function normalizedData(value,kind){try{return normalizeDocument(kind,value);}catch{bad();}}
function inputProjection(value){
 const data=pick(value,FIELDS);data.items=value.items.map(item=>pick(item,ITEM_FIELDS));data.installments=value.installments.map(row=>pick(row,['due_date','amount','method','note','payment_reference','payment_method_id','details']));return data;
}
function withoutItemIds(value){return{...value,items:value.items.map(({id,...item})=>item)};}
export function documentCopyResponse(value,route){
 if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false)bad();
 const base={data_mode:'erp_native',operational_effects:false};
 if(route.type==='origin'){
  if(value.kind!==route.args.p_kind||value.document_id!==route.args.p_document_id||!Object.hasOwn(value,'copy_source'))bad();
  const origin=value.copy_source===null?null:source(value.copy_source,{args:{p_kind:route.args.p_kind,p_source_id:value.copy_source?.id}});
  if(origin&&(!uuid(origin.id)||origin.id===value.document_id))bad();
  return{...base,document_id:value.document_id,kind:value.kind,copy_source:origin};
 }
 if(route.type==='preview'){
  const origin=source(value.source,route),normalized=normalizedData(value.data,route.args.p_kind);
  // 202610200132: with "Data do pedido clonado" a pedido de compra keeps the source date, so "date" leaves the reset fields;
  // 202610200164 also keeps the data prevista (the 132 shape stays accepted while the database is on 132).
  const kept=route.args.p_kind!=='purchase_orders'?null:[['date'],['date','expected_date']].find(fields=>JSON.stringify(value.reset_fields)===JSON.stringify(RESET_FIELDS.filter(field=>!fields.includes(field))))??null;
  if(value.persisted!==false||(!kept&&JSON.stringify(value.reset_fields)!==JSON.stringify(RESET_FIELDS))||normalized.template!==false||normalized.installments.length
   ||normalized.items.some(item=>item.id!==null)||RESET_FIELDS.filter(field=>!['date','installments','template',...(kept??[])].includes(field)).some(field=>normalized[field]!==null)
   ||(normalized.seller_id&&route.args.p_kind==='purchase_orders'))bad();
  return{...base,source:origin,data:inputProjection(normalized),reset_fields:kept?RESET_FIELDS.filter(field=>!kept.includes(field)):[...RESET_FIELDS],persisted:false};
 }
 if(route.type!=='copy'||value.kind!==route.args.p_kind||typeof value.replayed!=='boolean')bad();
 const origin=source(value.copy_source,route);
 if(origin.version!==route.args.p_expected_source_version)bad();
 let result;try{result=documentsResponse(value,{kind:route.args.p_kind,id:null},{type:'document'});}catch{bad();}
 const doc=result.document;
 if(!uuid(doc.id)||doc.id===origin.id||doc.version!==1||!(doc.status===INITIAL_STATE[doc.kind]||(doc.kind==='sales_orders'&&doc.status==='draft'))||doc.source_proposal_id!==null)bad();
 const expected=normalizedData(route.args.p_body,route.args.p_kind),actual=normalizedData(inputProjection(doc),route.args.p_kind);
 const submittedIds=new Set(expected.items.map(item=>item.id).filter(Boolean));
 if(doc.items.some(item=>submittedIds.has(item.id))||JSON.stringify(withoutItemIds(actual))!==JSON.stringify(withoutItemIds(expected)))bad();
 return{...result,copy_source:origin};
}
export async function executeDocumentCopyRoute(route,{userId,rpc}){
 if(!uuid(userId))fail(401,'ERP_UNAUTHORIZED');
 if(!route||!['preview','copy','origin'].includes(route.type)||!KINDS.includes(route.args?.p_kind))fail(404,'ERP_NOT_FOUND');
 return documentCopyResponse(await rpc(route.rpc,{p_user_id:userId.toLowerCase(),...route.args}),route);
}
