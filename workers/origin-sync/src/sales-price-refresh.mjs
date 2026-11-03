/** Directed current sales detail GETs. No native import or historical snapshot writes. */
import {sourceId} from './resources.mjs';
import {salesPriceCapture} from './sales-price-json.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[1-9][0-9]{0,39}$/,HASH=/^[0-9a-f]{64}$/;
const RESOURCE='sales_orders',PREFIX='origin_sync_sales_price_';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const str=(v,re)=>typeof v==='string'&&re.test(v);
const version=v=>str(v,/^[1-9][0-9]{0,18}$/)&&BigInt(v)<=9223372036854775807n;
const safe=e=>{const c=e?.code??e?.message;return typeof c==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(c)?c:'SALES_PRICE_REFRESH_FAILED';};
const states=['pending','stored','conflict','failed','superseded'];
function recovery(v,id){
 if(!plain(v)||v.attempt_id!==id||![...states,'missing'].includes(v.state)||!Object.hasOwn(v,'receipt'))throw new Error('SALES_PRICE_RECOVERY_INVALID');
 if(v.state==='stored'){
  const r=v.receipt;if(!plain(r)||r.sales_price_captures!==1||r.inserted!==0||!Number.isSafeInteger(r.updated)||!Number.isSafeInteger(r.unchanged)||r.updated+r.unchanged!==1)throw new Error('SALES_PRICE_RECEIPT_INVALID');
 }else if(v.receipt!==null)throw new Error('SALES_PRICE_RECOVERY_INVALID');
 return v;
}
export async function refreshSalesPrices(repo,client,{owner,lease,deadline,heartbeat=async()=>{},now=Date.now,
 enabled=false,salesPriceCaptureEnabled=false}={}){
 const result={status:'completed',attempted:0,stored:0,conflicts:0,recovered:0,requests:0,errors:[],stop_json:false};
 if(enabled!==true||salesPriceCaptureEnabled!==true)return{...result,status:'disabled'};
 if(!str(owner,UUID)||!str(lease?.lease_token,UUID)||!Number.isFinite(deadline))throw new Error('SALES_PRICE_REFRESH_CONFIG_INVALID');
 const started=client.requestsMade,phaseDeadline=Math.min(deadline-30000,now()+60000);
 const room=()=>{
  if(now()+5000>=phaseDeadline){result.status='skipped_time';return false;}
  if(result.attempted>=40||client.requestsMade-started>=40||client.remainingRequests<15){result.status='skipped_budget';return false;}
  return true;
 };
 if(!room())return result;
 let resource;
 try{resource=await repo.rpc('origin_sync_claim',{p_resource:RESOURCE,p_owner:owner,p_ttl_seconds:300},{deadline:phaseDeadline});}
 catch(error){return{...result,status:'partial',stop_json:true,errors:[{code:safe(error)}]};}
 if(!plain(resource)||typeof resource.acquired!=='boolean'||resource.acquired&&!str(resource.lease_token,UUID))return{...result,status:'partial',stop_json:true,errors:[{code:'SALES_PRICE_LEASE_INVALID'}]};
 if(!resource.acquired)return{...result,status:'already_running'};
 const identity=Object.freeze({p_owner:owner,p_lease_token:lease.lease_token,p_resource_token:resource.lease_token});
 const rpc=(name,args={})=>repo.rpc(PREFIX+name,{...identity,...args},{deadline:phaseDeadline});
 try{
  const list=await rpc('candidates',{p_limit:40});
  if(!plain(list)||!Array.isArray(list.items)||list.items.length>40)throw new Error('SALES_PRICE_CANDIDATES_INVALID');
  const seen=new Set(),candidates=list.items.map(v=>{
   if(!plain(v)||!str(v.source_id,ID)||!str(v.source_hash,HASH)||!version(v.source_version)
    ||!str(v.source_seen_at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/)
    ||!Number.isFinite(Date.parse(v.source_seen_at))||seen.has(v.source_id))throw new Error('SALES_PRICE_CANDIDATES_INVALID');
   seen.add(v.source_id);return Object.freeze(Object.fromEntries(['source_id','source_hash','source_version','source_seen_at'].map(k=>[k,v[k]])));
  });
  for(const candidate of candidates){
   if(!room())break;
   let attempt=null,stage='heartbeat';
   try{
    await heartbeat(phaseDeadline);if(!room())break;
    attempt=crypto.randomUUID();stage='begin';result.attempted++;
    const begun=await rpc('begin',{p_attempt_id:attempt,...Object.fromEntries(Object.entries(candidate).map(([k,v])=>['p_'+k,v]))});
    if(!plain(begun)||begun.attempt_id!==attempt||!states.includes(begun.state)||typeof begun.replayed!=='boolean')throw new Error('SALES_PRICE_BEGIN_INVALID');
    // A retried begin may be acknowledged after an uncertain response. Do not GET again.
    if(begun.replayed||begun.state!=='pending'){
     recovery(await rpc('attempt',{p_attempt_id:attempt}),attempt);result.stop_json=true;result.errors.push({code:'SALES_PRICE_BEGIN_RECOVERY_REQUIRED'});break;
    }
    // attempted now includes this job, so the final (40th) GET still has its slot.
    if(now()+5000>=phaseDeadline||client.remainingRequests<15){stage='fetch';throw new Error('SALES_PRICE_PHASE_ENDED');}
    stage='fetch';
    const payload=await client.get(`/pedidos/vendas/${candidate.source_id}`,{}, {deadline:Math.min(phaseDeadline-2000,now()+15000),maxAttempts:1});
    if(!plain(payload)||sourceId(payload.id)!==candidate.source_id)throw new Error('SALES_PRICE_DETAIL_IDENTITY_INVALID');
    const capture=salesPriceCapture(payload);if(!capture||capture.source!=='detail')throw new Error('SALES_PRICE_CAPTURE_REQUIRED');
    stage='heartbeat';await heartbeat(phaseDeadline);
    stage='finish';const saved=await rpc('finish',{p_attempt_id:attempt,p_payload:payload,p_price_capture:capture});
    if(!plain(saved)||typeof saved.stored!=='boolean'||typeof saved.conflict!=='boolean'||saved.stored===saved.conflict||typeof saved.replayed!=='boolean')throw new Error('SALES_PRICE_FINISH_INVALID');
    if(saved.stored)result.stored++;else result.conflicts++;
   }catch(error){
    const code=safe(error);result.errors.push({code});
    if(stage!=='fetch'){
     // A lost DB ACK never becomes a failure write, new UUID or another external GET.
     result.stop_json=true;
     if(attempt&&now()+1000<phaseDeadline){try{
      const read=recovery(await rpc('attempt',{p_attempt_id:attempt}),attempt);
      if(read.state==='stored'){result.stored++;result.recovered++;}else if(read.state==='conflict')result.conflicts++;
     }catch{result.errors.push({code:'SALES_PRICE_RECOVERY_UNAVAILABLE'});}}
     break;
    }
    if(attempt&&now()+1000<phaseDeadline){try{
     const failed=await rpc('fail',{p_attempt_id:attempt,p_code:code,p_http_status:Number.isInteger(error?.status)?error.status:null});
     if(!plain(failed)||typeof failed.recorded!=='boolean'||typeof failed.already_finished!=='boolean')throw new Error('SALES_PRICE_FAIL_INVALID');
    }catch{result.errors.push({code:'SALES_PRICE_FAILURE_RECORD_UNAVAILABLE'});result.stop_json=true;break;}}
    else{result.stop_json=true;break;}
    if([401,429].includes(error?.status)){result.stop_json=true;break;}
    if(error?.status===403||code==='SALES_PRICE_PHASE_ENDED')break;
   }
  }
 }catch(error){result.errors.push({code:safe(error)});result.stop_json=true;}
 finally{
  result.requests=client.requestsMade-started;
  try{await repo.rpc('origin_sync_release',{p_resource:RESOURCE,...{p_owner:owner,p_lease_token:resource.lease_token}},{deadline:phaseDeadline});}
  catch{result.errors.push({code:'SALES_PRICE_LEASE_RELEASE_UNAVAILABLE'});result.stop_json=true;}
 }
 if(result.errors.length)result.status='partial';return result;
}
