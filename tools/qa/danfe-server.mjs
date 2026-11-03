/** Loopback-only synthetic DANFE QA. No database, credentials or outbound fetch. */
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture} from '../../packages/fiscal-danfe-runtime/test/fixtures.mjs';
import {publicResult} from '../../packages/fiscal-danfe-runtime/src/dto.mjs';
import {SIGNED_FLAGS} from '../../apps/erp/src/lib/fiscal-signed-model.ts';

export const DANFE_QA_ORIGIN='http://127.0.0.1:9014';
const FRONTEND='http://127.0.0.1:5173',ID55='a1000000-0000-4000-8000-000000000055',ID65='a1000000-0000-4000-8000-000000000065';
export async function createDanfeQaHandler(){
 const previews=new Map(),candidates=[];
 for(const model of ['55','65']){
  const f=await fixture({model}),id=model==='55'?ID55:ID65;
  const dto=await publicResult({...f.dto,candidate_id:id},{candidateId:id});previews.set(id,dto);
  candidates.push({...SIGNED_FLAGS,status:'stored',candidate_id:id,candidate_version:1,unsigned_job_id:'a1000000-0000-4000-8000-000000000048',unsigned_hash:'1'.repeat(64),basis_hash:'2'.repeat(64),model,
   completion_version:1,completion_hash:'3'.repeat(64),a1_version:1,error_code:null,signed:true,signature_verified:true,xsd_validated:true,
   current:{state:'stored',attempt_count:1,unsigned_artifact_current:true,basis_changed:false,draft_archived:false,source_cancelled:false,series_enabled:true,a1_version:1,a1_changed:false,certificate_time_valid_now:true,latest_candidate_id:id,latest_candidate_version:1,is_latest_candidate:true,artifact_current:true},
   artifact:{sha256:dto.source_sha256,size_bytes:dto.source_size_bytes,created_at:'2026-10-16T12:00:00.000Z'}});
 }
 return async request=>{
  const origin=request.headers.get('origin'),url=new URL(request.url);
  const headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===FRONTEND?{'access-control-allow-origin':FRONTEND,Vary:'Origin'}:{})};
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
  if(url.origin!==DANFE_QA_ORIGIN||url.search||url.hash||origin&&origin!==FRONTEND)return json({error:'LOCAL_QA_ONLY'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET','access-control-allow-headers':'accept'}});
  if(request.method!=='GET')return json({error:'QA_GET_ONLY'},405);
  if(url.pathname==='/fixtures')return json({profile:'synthetic-danfe-qa-v1',candidates});
  const match=/^\/v1\/fiscal-danfe\/candidates\/([a-f0-9-]{36})\/preview$/.exec(url.pathname);
  return match&&previews.has(match[1])?json(previews.get(match[1])):json({error:'DANFE_NOT_FOUND',recovery_required:false},404);
 };
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const handler=await createDanfeQaHandler();
 const server=createServer(async(req,res)=>{
  try{
   if(req.headers.host!=='127.0.0.1:9014'){res.writeHead(403);res.end();return;}
   const result=await handler(new Request(new URL(req.url,DANFE_QA_ORIGIN),{method:req.method,headers:req.headers}));
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"SYNTHETIC_QA_FAILED"}');}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 server.listen(9014,'127.0.0.1',()=>process.stdout.write('Synthetic DANFE QA only: http://127.0.0.1:9014\n'));
}
