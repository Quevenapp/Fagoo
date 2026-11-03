import { documentsResponse } from './documents.mjs';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PATH=/^\/v1\/documentos\/sales_proposals\/([a-fA-F0-9-]+)\/convert-service$/;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=v=>typeof v==='string'&&UUID.test(v);
export class DocumentServiceConversionError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_QUERY')=>{throw new DocumentServiceConversionError(status,code);};
const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
export const documentServiceConversionMethods=path=>path.startsWith('/v1/documentos/sales_proposals/')&&path.endsWith('/convert-service')?['POST']:null;

async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body)fail();
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))fail();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='',timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new DocumentServiceConversionError(408,'ERP_REQUEST_TIMEOUT'));},10000);});
 try{for(;;){const{done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>4096)fail();text+=decoder.decode(value,{stream:true});}text+=decoder.decode();const input=JSON.parse(text);if(!object(input))fail();return input;}
 catch(error){if(error instanceof DocumentServiceConversionError)throw error;fail();}
 finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function parseDocumentServiceConversionRoute(request){
 const url=new URL(request.url);if(!documentServiceConversionMethods(url.pathname))return null;
 const match=PATH.exec(url.pathname);if(!match||!uuid(match[1]))fail(404,'ERP_NOT_FOUND');
 if(request.method!=='POST')fail(405,'ERP_METHOD_NOT_ALLOWED');
 if(url.searchParams.size||(request.headers.has('Content-Encoding')&&request.headers.get('Content-Encoding')!=='identity'))fail();
 const input=await body(request);
 if(Object.keys(input).some(key=>!['command_id','expected_version'].includes(key))||!uuid(input.command_id)
  ||!Number.isInteger(input.expected_version)||input.expected_version<1||input.expected_version>=2147483647)fail();
 return{rpc:'erp_proposal_convert_to_service',args:{p_id:match[1].toLowerCase(),p_expected_version:input.expected_version,p_command_id:input.command_id.toLowerCase()}};
}
function normalized(value,kind){
 try{return documentsResponse({kind,document:value,data_mode:'erp_native',operational_effects:false},{kind,id:value.id},{type:'document'}).document;}
 catch{bad();}
}
export function documentServiceConversionResponse(value,route){
 if(!object(value)||value.data_mode!=='erp_native'||value.operational_effects!==false||typeof value.replayed!=='boolean'
  ||!object(value.proposal)||!object(value.service_order))bad();
 const source=value.proposal,target=value.service_order;
 if(!uuid(source.id)||!uuid(target.id)||source.id!==route.args.p_id||source.kind!=='sales_proposals'||source.status!=='completed'||source.template!==false
  ||source.version!==route.args.p_expected_version+1||target.kind!=='service_orders'||target.status!=='open'||target.version!==1
  ||target.id===source.id||target.source_proposal_id!==source.id||target.template!==false)bad();
 const proposal=normalized(source,'sales_proposals');
 const service_order=normalized(target,'service_orders');
 const identity=new Set(proposal.items.map(item=>item.id));
 const comparable=doc=>{
  const {id,kind,number,version,status,source_proposal_id,created_at,updated_at,effect_flags,items,...fields}=doc;
  return{...fields,items:items.map(({id,...line})=>line)};
 };
 if(service_order.items.some(item=>identity.has(item.id))||JSON.stringify(comparable(proposal))!==JSON.stringify(comparable(service_order)))bad();
 return{proposal,service_order,replayed:value.replayed,data_mode:'erp_native',operational_effects:false};
}
export async function executeDocumentServiceConversionRoute(route,{userId,rpc}){
 if(!uuid(userId))fail(401,'ERP_UNAUTHORIZED');
 if(!route||route.rpc!=='erp_proposal_convert_to_service')fail(404,'ERP_NOT_FOUND');
 return documentServiceConversionResponse(await rpc(route.rpc,{p_user_id:userId.toLowerCase(),...route.args}),route);
}
