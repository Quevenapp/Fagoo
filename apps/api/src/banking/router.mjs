import {createBankingService,bankingError} from './service.mjs';
import {assert,BusinessError} from '../../../../packages/domain/decimal.mjs';
const respond=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function body(request){
  assert(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''),'JSON_REQUIRED',415);assert(!request.headers.get('content-encoding')||request.headers.get('content-encoding')==='identity','CONTENT_ENCODING_UNSUPPORTED',415);assert(request.body,'BODY_REQUIRED');
  const reader=request.body.getReader(),chunks=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;assert(size<=5_400_000,'BODY_TOO_LARGE',413);chunks.push(next.value);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new BusinessError(400,'INVALID_JSON');}}
  finally{await reader.cancel().catch(()=>{});}
}
export async function handleBankingRequest(request,{pool,actor}){
  const url=new URL(request.url),base=url.pathname==='/api/v1/banking/cnab/profiles',match=/^\/api\/v1\/banking\/cnab\/profiles\/([^/]+)(?:\/(remittance-preview|return-preview))?$/.exec(url.pathname);
  if(!base&&!match)return null;const service=createBankingService({pool});
  try{
    assert(!url.search,'INVALID_QUERY');
    if(base){assert(['GET','POST'].includes(request.method),'METHOD_NOT_ALLOWED',405);return respond(request.method==='GET'?await service.list(actor):await service.save(actor,await body(request)));}
    if(!match[2]){assert(request.method==='PATCH','METHOD_NOT_ALLOWED',405);return respond(await service.save(actor,await body(request),match[1]));}
    assert(request.method==='POST','METHOD_NOT_ALLOWED',405);
    return respond(await service[match[2]==='remittance-preview'?'remittancePreview':'returnPreview'](actor,match[1],await body(request)));
  }catch(caught){const error=bankingError(caught);if(error instanceof BusinessError)return respond({error:{code:error.code,...(error.details?{details:error.details}:{})}},error.status);throw error;}
}
