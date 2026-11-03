import { isConfiguredBackendOrigin } from '../../backend-config/src/origin.mjs';
/** Private068 RPC only. Explicit HTTP driver; no default fetch, env or fiscal transport. */
import {SubsetReviewError,need,fields,captureArgs,projectSubsetReview} from './subset-review-dto.mjs';
export {SubsetReviewError} from './subset-review-dto.mjs';
export const SUBSET_RPC_ENVELOPE_BYTES=294912;
const SQLSTATES=['22023','40001','42501','55000','P0002'],MAX_ERROR=8192,MAX_MS=45000;
const cancel=body=>{try{void body?.cancel().catch(()=>{});}catch{}};
const cancelReader=r=>{try{void r.cancel().catch(()=>{});}catch{}try{r.releaseLock();}catch{}};
const abortGet=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
function aborted(signal){try{return signal===undefined?false:abortGet.call(signal);}catch{throw new SubsetReviewError('SUBSET_REVIEW_RPC_OPTIONS_INVALID');}}
export function createSubsetReviewRpc(configuration){
 const c=fields(configuration,['projectUrl','serviceKey','fetchImpl'],['supabaseDeployment']);
 need(isConfiguredBackendOrigin(c.projectUrl,c.supabaseDeployment),'SUBSET_REVIEW_RPC_CONFIG_INVALID');
 need(typeof c.serviceKey==='string'&&c.serviceKey.length>=20&&c.serviceKey.length<=8192&&/^[!-~]+$/.test(c.serviceKey)&&typeof c.fetchImpl==='function','SUBSET_REVIEW_RPC_CONFIG_INVALID');
 const {projectUrl,serviceKey,fetchImpl}=c;
 return async function rpc(name,input,options){
  const args=captureArgs(name,input),o=fields(options,['deadline'],['signal']),signal=o.signal,start=Date.now(),deadline=o.deadline;
  need(Number.isSafeInteger(deadline)&&deadline>start&&deadline<=start+MAX_MS,'SUBSET_REVIEW_RPC_DEADLINE_INVALID');need(!aborted(signal),'SUBSET_REVIEW_RPC_ABORTED');
  const body=Buffer.from(JSON.stringify(args),'utf8');if(body.length>SUBSET_RPC_ENVELOPE_BYTES){body.fill(0);throw new SubsetReviewError('SUBSET_REVIEW_RPC_BODY_LIMIT');}
  const url=projectUrl+'/rest/v1/rpc/'+name,controller=new AbortController();let response,reader,timer,code,rejectStop;
  const stopped=new Promise((_,reject)=>{rejectStop=reject;});stopped.catch(()=>{});
  const stop=c=>{if(code)return;code=c;controller.abort();rejectStop(new SubsetReviewError(c));};
  const onAbort=()=>stop('SUBSET_REVIEW_RPC_ABORTED');if(signal)EventTarget.prototype.addEventListener.call(signal,'abort',onAbort,{once:true});
  const check=()=>{if(aborted(signal))stop('SUBSET_REVIEW_RPC_ABORTED');if(Date.now()>=deadline)stop('SUBSET_REVIEW_RPC_TIMEOUT');need(!code,code);};
  const bounded=fn=>{check();return Promise.race([Promise.resolve().then(()=>{check();return fn();}),stopped]);};
  timer=setTimeout(()=>stop('SUBSET_REVIEW_RPC_TIMEOUT'),Math.max(1,deadline-Date.now()));
  async function json(limit){
   const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
   need(/^application\/json(?:[ \t]*;[ \t]*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')&&(encoding===null||encoding==='identity')&&(length===null||/^\d+$/.test(length)&&Number(length)<=limit)&&response.body,'SUBSET_REVIEW_RPC_RESPONSE_INVALID');
   reader=response.body.getReader();const buffer=Buffer.alloc(limit);let size=0;
   try{
    for(;;){const part=await bounded(()=>reader.read());check();if(part.done)break;
     need(part.value instanceof Uint8Array&&part.value.buffer instanceof ArrayBuffer&&part.value.byteLength>0&&part.value.byteLength<=limit-size,'SUBSET_REVIEW_RPC_BODY_LIMIT');buffer.set(part.value,size);size+=part.value.byteLength;
    }
    need(size>0&&(length===null||Number(length)===size),'SUBSET_REVIEW_RPC_RESPONSE_INVALID');check();let value;
    try{value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(buffer.subarray(0,size)));}catch{throw new SubsetReviewError('SUBSET_REVIEW_RPC_JSON_INVALID');}
    check();need(value!==null&&typeof value==='object'&&!Array.isArray(value),'SUBSET_REVIEW_RPC_RESPONSE_INVALID');return value;
   }finally{buffer.fill(0);cancelReader(reader);reader=undefined;}
  }
  try{
   const pending=Promise.resolve().then(()=>{check();return fetchImpl(url,{method:'POST',redirect:'manual',signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+serviceKey,apikey:serviceKey,'Content-Type':'application/json','Content-Length':String(body.length),Accept:'application/json','Accept-Encoding':'identity','Cache-Control':'no-store'},body});});
   try{response=await bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}
   need(response instanceof Response&&!response.redirected&&(response.url===''||response.url===url),'SUBSET_REVIEW_RPC_RESPONSE_INVALID');need(response.status<300||response.status>=400,'SUBSET_REVIEW_RPC_REDIRECT_REJECTED');
   if(response.status!==200){const error=await json(MAX_ERROR);throw new SubsetReviewError(SQLSTATES.includes(error.code)?error.code:'SUBSET_REVIEW_RPC_HTTP_REJECTED');}
   const value=projectSubsetReview(name,await json(SUBSET_RPC_ENVELOPE_BYTES),args);check();return value;
  }catch(e){if(e instanceof SubsetReviewError)throw e;throw new SubsetReviewError('SUBSET_REVIEW_RPC_IO_FAILED');}
  finally{clearTimeout(timer);if(signal)EventTarget.prototype.removeEventListener.call(signal,'abort',onAbort);controller.abort();if(reader)cancelReader(reader);else cancel(response?.body);body.fill(0);}
 };
}
