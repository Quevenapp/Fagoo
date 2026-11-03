/** Local 055 tool port. No environment lookup, default fetch, retry or credential logging. */
import {createHash} from 'node:crypto';
import {ORIGIN_PROPOSAL_IMPORT_V2_BASE as BASE,parseOriginProposalImportV2Route,originProposalImportV2Response} from '../../workers/erp-api/src/origin-proposal-import-v2.mjs';
import {documentsRoute,documentsOperation,documentsResponse} from '../../workers/erp-api/src/documents.mjs';

export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const SOURCE=/^[1-9][0-9]{0,39}$/;
export const RESPONSE_BYTES=1048576;
export class ProposalBatchError extends Error{constructor(code,status=0){super(code);this.name='ProposalBatchError';this.code=code;this.status=status;}}
export const requireBatch=(yes,code)=>{if(!yes)throw new ProposalBatchError(code);};
export function copyJson(value,max=16*1048576){const text=JSON.stringify(value);requireBatch(typeof text==='string'&&Buffer.byteLength(text)<=max,'LOCAL_DATA_LIMIT');return JSON.parse(text);}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const proposalBatchDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

export async function proposalBatchOperation(type,input){
 let path=BASE,method='GET',body;
 if(type==='sources'||type==='native'){
  requireBatch(exact(input,['after'])&&(input.after===null||typeof input.after==='string'&&(type==='sources'?SOURCE:UUID).test(input.after)),'REQUEST_INVALID');
  path=(type==='native'?'/v1/documentos/sales_proposals':BASE)+'?limit=25'+(input.after===null?'':'&after='+input.after);
 }else if(type==='preview'){requireBatch(exact(input,['source_id']),'REQUEST_INVALID');path+='/preview';method='POST';body=input;
 }else if(type==='command'){requireBatch(exact(input,['command_id'])&&typeof input.command_id==='string'&&UUID.test(input.command_id),'REQUEST_INVALID');path+='/commands/'+input.command_id;
 }else if(type==='apply'){path+='/apply';method='POST';body=input;}else throw new ProposalBatchError('REQUEST_OUTSIDE_SCOPE');
 const request=new Request('https://proposal-tool.invalid'+path,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
 if(type==='native'){const url=new URL(request.url),route=documentsRoute(url.pathname),op=await documentsOperation(request,route,url.searchParams);return{rpc:op.rpc,args:op.args,project:raw=>documentsResponse(raw,route,op)};}
 const route=await parseOriginProposalImportV2Route(request);return{rpc:route.rpc,args:route.args,project:raw=>originProposalImportV2Response(raw,route)};
}

/** Shared bounded lifetime includes response headers and every stream chunk. */
export function proposalBatchScope(port,{signal,deadline=Date.now()+600000}={}){
 requireBatch(port&&typeof port.call==='function'&&typeof port.actor==='string'&&UUID.test(port.actor)&&/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(port.project_url),'PORT_INVALID');
 requireBatch(Number.isFinite(deadline)&&deadline>Date.now()&&deadline<=Date.now()+600000&&(signal===undefined||signal instanceof AbortSignal),'DEADLINE_INVALID');
 const call=port.call,actor=port.actor,project_url=port.project_url,controller=new AbortController();let reject,calls=0;
 const stopped=new Promise((_,r)=>{reject=r;});stopped.catch(()=>{});
 const cancel=()=>{controller.abort();reject(new ProposalBatchError('BATCH_INTERRUPTED'));};
 const timer=setTimeout(cancel,Math.max(1,deadline-Date.now()));signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const check=()=>requireBatch(!controller.signal.aborted&&Date.now()<deadline,'BATCH_INTERRUPTED');
 return{actor,project_url,check,async call(type,input){check();requireBatch(++calls<=3000,'CALL_LIMIT');const own=copyJson(input,4096),op=await proposalBatchOperation(type,own);check();
   const raw=await Promise.race([Promise.resolve().then(()=>{check();return call(type,own,{signal:controller.signal,deadline});}),stopped]);check();
   return op.project(copyJson(raw,RESPONSE_BYTES));
  },close(){clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}};
}

/** Actor is fixed by construction; callers cannot pass a replacement p_user_id. */
export function createProposalBatchPort({projectUrl,actor,serviceKey,fetchImpl,timeoutMs=15000,allowApply=false}){
 requireBatch(typeof projectUrl==='string'&&/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)&&typeof actor==='string'&&UUID.test(actor),'PORT_CONFIG_INVALID');
 requireBatch(typeof serviceKey==='string'&&/^[\x21-\x7e]{20,8192}$/.test(serviceKey)&&typeof fetchImpl==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=30000&&typeof allowApply==='boolean','PORT_CONFIG_INVALID');
 return Object.freeze({actor,project_url:projectUrl,async call(type,input,options={}){
  requireBatch(type!=='apply'||allowApply,'APPLY_NOT_ENABLED');const own=copyJson(input,4096),signal=options.signal,deadline=Math.min(options.deadline??Infinity,Date.now()+timeoutMs);
  requireBatch(Number.isFinite(deadline)&&deadline>Date.now()&&(signal===undefined||signal instanceof AbortSignal),'DEADLINE_INVALID');
  const controller=new AbortController();let reject,response,reader;
  const stopped=new Promise((_,r)=>{reject=r;});stopped.catch(()=>{});
  const stop=()=>{controller.abort();reject(new ProposalBatchError('RPC_UNCONFIRMED',503));};
  const timer=setTimeout(stop,Math.max(1,deadline-Date.now()));signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw new ProposalBatchError('RPC_UNCONFIRMED',503);};
  try{
   const op=await proposalBatchOperation(type,own);check();const url=projectUrl+'/rest/v1/rpc/'+op.rpc,body=JSON.stringify({...op.args,p_user_id:actor});requireBatch(Buffer.byteLength(body)<=4096,'REQUEST_LIMIT');
   const pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{apikey:serviceKey,authorization:'Bearer '+serviceKey,'content-type':'application/json',accept:'application/json','accept-encoding':'identity'},body,signal:controller.signal});});
   pending.then(r=>{if(controller.signal.aborted)void r?.body?.cancel().catch(()=>{});},()=>{});
   response=await Promise.race([pending,stopped]);check();
   requireBatch(response instanceof Response&&!response.redirected&&response.url===url&&!([301,302,303,307,308].includes(response.status)),'RPC_RESPONSE_INVALID');
   requireBatch(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&(!response.headers.has('content-encoding')||response.headers.get('content-encoding')==='identity')&&response.body,'RPC_RESPONSE_INVALID');
   const length=response.headers.get('content-length');requireBatch(length===null||/^\d+$/.test(length)&&Number(length)<=RESPONSE_BYTES,'RPC_RESPONSE_LIMIT');
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
   for(;;){check();const part=await Promise.race([reader.read(),stopped]);check();if(part.done)break;requireBatch(part.value instanceof Uint8Array&&(size+=part.value.byteLength)<=RESPONSE_BYTES,'RPC_RESPONSE_LIMIT');text+=decoder.decode(part.value,{stream:true});}
   requireBatch(length===null||Number(length)===size,'RPC_RESPONSE_INVALID');const value=JSON.parse(text+decoder.decode());check();
   if(response.status!==200){const status=({P0002:404,'42501':403,'40001':409,'23505':409,'22023':422})[value?.code];throw new ProposalBatchError(status===404?'COMMAND_NOT_FOUND':status?'RPC_REJECTED':'RPC_UNCONFIRMED',status??503);}
   return op.project(value);
  }catch(e){if(e instanceof ProposalBatchError)throw e;throw new ProposalBatchError('RPC_UNCONFIRMED',503);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}else void response?.body?.cancel().catch(()=>{});}
 }});
}
