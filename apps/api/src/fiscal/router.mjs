import { createFiscalService } from './service.mjs';
import { BusinessError, assert } from '../../../../packages/domain/decimal.mjs';
const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
async function body(request){
  assert(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),'JSON_REQUIRED',415);assert(!request.headers.get('content-encoding')||request.headers.get('content-encoding')==='identity','CONTENT_ENCODING_UNSUPPORTED',415);assert(request.body,'BODY_REQUIRED');const reader=request.body.getReader(),chunks=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;assert(size<=2_097_152,'BODY_TOO_LARGE',413);chunks.push(chunk.value);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new BusinessError(400,'INVALID_JSON');}}
  finally{await reader.cancel().catch(()=>{});}
}
export async function handleFiscalRequest(request,{pool,actor,storage}){
  const url=new URL(request.url),path=url.pathname;const config=path==='/api/v1/company/fiscal',ingest=path==='/api/v1/invoices/received/import',match=/^\/api\/v1\/invoices\/received\/([^/]+)(\/xml)?$/.exec(path);
  if(!config&&!ingest&&!match)return null;const service=createFiscalService({pool,storage});
  try{
    assert(!url.search,'INVALID_QUERY');
    if(config){assert(['GET','PATCH'].includes(request.method),'METHOD_NOT_ALLOWED',405);return respond(request.method==='GET'?await service.configuration(actor):await service.configure(actor,await body(request)));}
    if(ingest){assert(request.method==='POST','METHOD_NOT_ALLOWED',405);return respond(await service.importXml(actor,await body(request)));}
    assert(request.method==='GET','METHOD_NOT_ALLOWED',405);
    if(match[2]){const result=await service.xml(actor,match[1]);return new Response(result.bytes,{headers:{'content-type':'application/xml; charset=utf-8','content-disposition':`attachment; filename="${result.filename}"`,'cache-control':'no-store','x-content-type-options':'nosniff'}});}
    return respond(await service.detail(actor,match[1]));
  }catch(error){if(error instanceof BusinessError)return respond({error:{code:error.code,...(error.details?{details:error.details}:{})}},error.status);throw error;}
}
