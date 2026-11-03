import {normalizeCompany,CRT_LABELS} from '../../../packages/erp-domain/src/company.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>object(v)&&Object.keys(v).every(key=>keys.includes(key));
const version=(v,min=1)=>Number.isInteger(v)&&v>=min&&v<=2147483647;
export class CompanyError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const invalid=()=>{throw new CompanyError(400,'ERP_INVALID_QUERY');};
const bad=()=>{throw new CompanyError(502,'ERP_UPSTREAM_INVALID_RESPONSE');};
export function companyRoute(path){const match=/^\/v1\/empresa(?:\/(identidade|fiscal))?$/.exec(path);return match?{section:match[1]==='identidade'?'identity':match[1]||null}:null;}
export const companyMethods=route=>route?.section?['GET','POST']:['GET'];
async function body(request){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||!request.body||Number(request.headers.get('content-length'))>16384)invalid();
 const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384)invalid();text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
 catch{return invalid();}finally{try{await reader.cancel();}catch{/* No input logging. */}reader.releaseLock();}
}
export async function companyOperation(request,route,params){
 if(!route)throw new CompanyError(404,'ERP_NOT_FOUND');if(!companyMethods(route).includes(request.method))throw new CompanyError(405,'ERP_METHOD_NOT_ALLOWED');if(params.size)invalid();
 if(request.method==='GET')return {rpc:route.section?'erp_company_get':'erp_company_access',args:route.section?{p_section:route.section}:{},type:route.section||'access'};
 const input=await body(request);
 if(!only(input,route.section==='identity'?['command_id','expected_version','data','reason']:['command_id','expected_version','expected_identity_version','crt','confirmed','reason'])||!UUID.test(input.command_id||'')||!version(input.expected_version,route.section==='identity'?0:1))invalid();
 if(route.section==='identity'){
  // 302: the document may be a CPF (Tipo da Pessoa = Pessoa Física); SQL checks it against the Tipo da Pessoa of the company.
  try{normalizeCompany(input.data,{document:'any'});}catch{return invalid();}
  // 189: correcting Nome, Nome Fantasia or CNPJ carries a reason (3 to 1000 characters); without it the command is the one of 016.
  if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>1000||/[\x00-\x1f\x7f]/.test(input.reason)))invalid();
  return {rpc:'erp_company_save_identity',args:{p_expected_version:input.expected_version,p_command_id:input.command_id,p_data:input.data,...(input.reason!==undefined?{p_reason:input.reason}:{})},type:'identity'};
 }
 if(!version(input.expected_identity_version)||!(input.crt===null||typeof input.crt==='string'&&Object.hasOwn(CRT_LABELS,input.crt))||typeof input.confirmed!=='boolean'
  ||input.confirmed!==(input.crt!==null)||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>1000||/[\x00-\x1f\x7f]/.test(input.reason))invalid();
 return {rpc:'erp_company_confirm_fiscal',args:{p_expected_version:input.expected_version,p_expected_identity_version:input.expected_identity_version,p_command_id:input.command_id,p_crt:input.crt,p_confirmed:input.confirmed,p_reason:input.reason},type:'fiscal'};
}
const timestamp=value=>typeof value==='string'&&value.length<=100&&Number.isFinite(Date.parse(value));
export function companyResponse(value,route,operation){
 if(!object(value)||value.data_mode!=='erp_native'||value.emission_enabled!==false)bad();const base={data_mode:'erp_native',emission_enabled:false};
 if(operation.type==='access'){
  const safe={...base};for(const field of ['read_identity','write_identity','read_fiscal','write_fiscal']){if(typeof value[field]!=='boolean')bad();safe[field]=value[field];}if(!safe.read_identity||safe.write_fiscal&&!safe.read_fiscal)bad();return safe;
 }
 if(value.section!==operation.type||value.replayed!==undefined&&typeof value.replayed!=='boolean')bad();
 let record=null;
 if(value.record!==null){
  const row=value.record;if(!object(row)||!version(row.version)||!timestamp(row.updated_at))bad();
  if(operation.type==='identity'){
   if(!timestamp(row.created_at))bad();let normalized;try{normalized=normalizeCompany(row.data,{document:'any'});}catch{return bad();}
   if(Object.entries(normalized).some(([key,v])=>row.data[key]!==v))bad();
   record={version:row.version,data:normalized,created_at:row.created_at,updated_at:row.updated_at};
  }else{
   if(!version(row.identity_version)||!(row.crt===null||typeof row.crt==='string'&&Object.hasOwn(CRT_LABELS,row.crt))||typeof row.confirmed!=='boolean'||row.confirmed!==(row.crt!==null)
    ||(row.confirmed?!timestamp(row.confirmed_at):row.confirmed_at!==null)||!(row.reason===null||typeof row.reason==='string'&&row.reason.length<=1000))bad();
   record={version:row.version,identity_version:row.identity_version,crt:row.crt,confirmed:row.confirmed,confirmed_at:row.confirmed_at,reason:row.reason,updated_at:row.updated_at};
  }
 }else if(operation.rpc!=='erp_company_get')bad();
 return {...base,section:operation.type,record,...(value.replayed===undefined?{}:{replayed:value.replayed})};
}
