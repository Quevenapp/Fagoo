/** Loopback-only protocol QA. Fixed synthetic history; no DB, credentials, A1 loader or outbound network. */
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {result,payload} from '../../packages/fiscal-reconciliation-runtime/test/fixtures.mjs';
import {FLAGS,publicResult} from '../../packages/fiscal-reconciliation-runtime/src/dto.mjs';
import {SIGNED_FLAGS} from '../../apps/erp/src/lib/fiscal-signed-model.ts';
import {captureReconciliationRequest,RECONCILIATION_BASE as BASE} from '../../apps/erp/src/lib/fiscal-reconciliation-model.ts';
import {configured,company,envelope} from '../../apps/erp/test/helpers/a1-fixtures.mjs';
export const RECONCILIATION_QA_ORIGIN='http://127.0.0.1:9015';
export const QA_ACTOR='a6200000-0000-4000-8000-000000000001',QA_OTHER='a6200000-0000-4000-8000-000000000002';
const FRONTEND='http://127.0.0.1:5173';
export function createReconciliationQaHandler(){
 const commands=new Map(),candidates=[];
 for(const model of ['55','65']){
  const id=`a6200000-0000-4000-8000-0000000000${model}`;
  let receipt;
  for(const [ordinal,state] of [[1,'stored'],[2,'dispatched']]){
   const commandId=`a6200000-0000-4000-8000-00000000${model}0${ordinal}`,b={...payload(),command_id:commandId,candidate_id:id},value=result(state,b,true);
   Object.assign(value.receipt,{model,ordinal,attempt_id:commandId});value.current.candidate.latest_candidate_id=id;
   if(state==='stored'){value.artifact.cstat='217';value.recoverable_by_actor=false;}
   publicResult(value,{action:'command',commandId});commands.set(commandId,value);receipt=value.receipt;
  }
  const r=receipt,c=[...commands.values()].find(v=>v.receipt.candidate_id===id).current.candidate,{lease_until,...current}=c;
  candidates.push({...SIGNED_FLAGS,status:'stored',candidate_id:id,candidate_version:r.candidate_version,unsigned_job_id:r.unsigned_job_id,unsigned_hash:'f'.repeat(64),basis_hash:r.basis_hash,model,completion_version:r.completion_version,completion_hash:r.completion_hash,a1_version:r.signing_a1_version,error_code:null,signed:true,signature_verified:true,xsd_validated:true,current,artifact:{sha256:r.signed_hash,size_bytes:r.signed_size,created_at:r.created_at},read_only:true});
 }
 return async request=>{
  const url=new URL(request.url),origin=request.headers.get('origin'),headers={'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...(origin===FRONTEND?{'access-control-allow-origin':FRONTEND,Vary:'Origin'}:{})};
  const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers}),error=(code,status)=>json({error:code,recovery_required:false},status);
  if(url.origin!==RECONCILIATION_QA_ORIGIN||url.search||url.hash||origin&&origin!==FRONTEND)return error('LOCAL_QA_ONLY',403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'GET, POST','access-control-allow-headers':'accept, content-type, x-qa-actor'}});
  if(url.pathname==='/fixtures'&&request.method==='GET')return json({profile:'synthetic-reconciliation-qa-v1',enabled:false,actor:QA_ACTOR,other_actor:QA_OTHER,candidates});
  const actor=request.headers.get('x-qa-actor');if(![QA_ACTOR,QA_OTHER].includes(actor))return error('RECONCILIATION_UNAUTHENTICATED',401);
  if(url.pathname==='/v1/a1'&&request.method==='GET')return json(envelope(configured));
  if(url.pathname==='/v1/empresa/identidade'&&request.method==='GET')return json(company);
  let selected;
  try{
   let body;if(request.method!=='GET'){
    const raw=new Uint8Array(await request.arrayBuffer());if(raw.byteLength>4096)return error('RECONCILIATION_BODY_TOO_LARGE',413);body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
   }
   selected=captureReconciliationRequest(url.pathname,{method:request.method,...(body===undefined?{}:{body})});
  }catch{return error('RECONCILIATION_INVALID_REQUEST',400);}
  if(selected.action==='run')return error('RECONCILIATION_DISABLED',409);
  const project=v=>({...structuredClone(v),recoverable_by_actor:actor===QA_ACTOR&&v.current.grant_consumed&&v.current.recovery_required});
  if(selected.action==='history'){
   if(!candidates.some(c=>c.candidate_id===selected.id))return error('RECONCILIATION_NOT_FOUND',404);
   const rows=[...commands.values()].filter(v=>v.receipt.candidate_id===selected.id&&(selected.payload.before===null||BigInt(v.receipt.ordinal)<BigInt(selected.payload.before))).sort((a,b)=>b.receipt.ordinal-a.receipt.ordinal),items=rows.slice(0,selected.payload.limit).map(project),more=rows.length>items.length;
   return json(publicResult({...FLAGS,read_only:true,candidate_id:selected.id,items,limit:selected.payload.limit,has_more:more,next_cursor:more?String(items.at(-1).receipt.ordinal):null},{action:'history',candidateId:selected.id,payload:selected.payload}));
  }
  const commandId=selected.action==='command'?selected.id:selected.payload.command_id,value=commands.get(commandId);
  if(!value)return error('RECONCILIATION_NOT_FOUND',404);if(actor!==QA_ACTOR)return error('RECONCILIATION_FORBIDDEN',403);
  if(selected.action==='recover'){
   const next=structuredClone(value);next.status='stored';next.current.state='stored';next.current.finished_at='2026-10-16T12:00:02.000Z';next.current.recovery_required=false;next.recovery_required=false;next.recoverable_by_actor=false;next.error_code=null;
   next.artifact={sha256:'d'.repeat(64),size_bytes:500,outcome:'validated',rejection_code:null,cstat:'217',event_reconciliation_required:false,created_at:'2026-10-16T12:00:02.000Z',tls_origin_verified:true};commands.set(commandId,next);
   return json(publicResult({...next,read_only:false,recovered:true},{action:'recover',payload:{command_id:commandId}}));
  }
  return json(publicResult(project(value),{action:'command',commandId}));
 };
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const handler=createReconciliationQaHandler();
 const server=createServer(async(req,res)=>{
  try{
   if(req.headers.host!=='127.0.0.1:9015'){res.writeHead(403);res.end();return;}
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){res.writeHead(413);res.end();return;}chunks.push(chunk);}
   const response=await handler(new Request(new URL(req.url,RECONCILIATION_QA_ORIGIN),{method:req.method,headers:req.headers,...(size?{body:Buffer.concat(chunks)}:{})}));
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"SYNTHETIC_QA_FAILED","recovery_required":false}');}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 server.listen(9015,'127.0.0.1',()=>process.stdout.write('Synthetic protocol QA only: http://127.0.0.1:9015\n'));
}
