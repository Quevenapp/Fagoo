/** One-time current detail capture for existing products used by pending proposals. */
import {sourceId} from './resources.mjs';
import {priceCapture} from './price-json.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[1-9][0-9]{0,39}$/,HASH=/^[0-9a-f]{64}$/;
const RESOURCE='proposal_prices',PREFIX='origin_sync_price_';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const string=(v,re)=>typeof v==='string'&&re.test(v);
const version=v=>string(v,/^[1-9][0-9]{0,18}$/)&&BigInt(v)<=9223372036854775807n;
const safe=e=>typeof e?.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(e.code)?e.code:'PRICE_REFRESH_FAILED';
export async function refreshProposalPrices(repo,client,{owner,lease,deadline,heartbeat=async()=>{},now=Date.now,
 enabled=false,priceCaptureEnabled=false}={}) {
 const result={status:'completed',attempted:0,stored:0,conflicts:0,requests:0,errors:[],stop_json:false};
 if(enabled!==true||priceCaptureEnabled!==true)return{...result,status:'disabled'};
 if(!string(owner,UUID)||!string(lease?.lease_token,UUID)||!Number.isFinite(deadline))throw new Error('PRICE_REFRESH_CONFIG_INVALID');
 const started=client.requestsMade,phaseDeadline=Math.min(deadline-20000,now()+30000);
 const room=()=>{
  if(now()+5000>=phaseDeadline){result.status='skipped_time';return false;}
  if(client.requestsMade-started>=8||client.remainingRequests<15){result.status='skipped_budget';return false;}
  return true;
 };
 if(!room())return result;
 const resource=await repo.rpc('origin_sync_claim',{p_resource:RESOURCE,p_owner:owner,p_ttl_seconds:300},{deadline:phaseDeadline});
 if(!plain(resource)||typeof resource.acquired!=='boolean'||resource.acquired&&!string(resource.lease_token,UUID))throw new Error('PRICE_LEASE_INVALID');
 if(!resource.acquired)return{...result,status:'already_running'};
 const identity={p_owner:owner,p_lease_token:lease.lease_token,p_resource_token:resource.lease_token};
 const rpc=(name,args={})=>repo.rpc(PREFIX+name,{...identity,...args},{deadline:phaseDeadline});
 try{
  const list=await rpc('candidates',{p_limit:8});
  if(!plain(list)||!Array.isArray(list.items)||list.items.length>8)throw new Error('PRICE_CANDIDATES_INVALID');
  const seen=new Set();
  const candidates=list.items.map(v=>{
   if(!plain(v)||!string(v.source_id,ID)||!string(v.proposal_id,ID)||!string(v.product_hash,HASH)||!string(v.proposal_hash,HASH)
    ||!version(v.product_version)||!version(v.proposal_version)||typeof v.product_seen_at!=='string'
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v.product_seen_at)
    ||!Number.isFinite(Date.parse(v.product_seen_at))||seen.has(v.source_id))throw new Error('PRICE_CANDIDATES_INVALID');
   seen.add(v.source_id);
   return Object.freeze(Object.fromEntries(['source_id','proposal_id','product_hash','proposal_hash','product_version','proposal_version','product_seen_at'].map(k=>[k,v[k]])));
  });
  for(const candidate of candidates){
   if(!room())break;
   let attempt=null;
   try{
    await heartbeat(phaseDeadline);if(!room())break;
    const id=crypto.randomUUID();
    const begun=await rpc('begin',{p_attempt_id:id,...Object.fromEntries(Object.entries(candidate).map(([k,v])=>['p_'+k,v]))});
    if(!plain(begun)||begun.attempt_id!==id||!['pending','stored','conflict','failed','superseded'].includes(begun.state)||typeof begun.replayed!=='boolean')throw new Error('PRICE_BEGIN_INVALID');
    if(begun.state!=='pending')continue;
    attempt=id;if(!room())break;
    result.attempted++;
    const payload=await client.get(`/produtos/${candidate.source_id}`,{}, {deadline:Math.min(phaseDeadline-2000,now()+15000),maxAttempts:1});
    if(!plain(payload)||sourceId(payload.id)!==candidate.source_id)throw new Error('PRICE_DETAIL_IDENTITY_INVALID');
    const capture=priceCapture(payload);
    if(!capture||capture.source!=='detail')throw new Error('PRICE_CAPTURE_REQUIRED');
    await heartbeat(phaseDeadline);
    const saved=await rpc('finish',{p_attempt_id:attempt,p_payload:payload,p_price_capture:capture});
    if(!plain(saved)||typeof saved.stored!=='boolean'||typeof saved.conflict!=='boolean'||saved.stored===saved.conflict||typeof saved.replayed!=='boolean')throw new Error('PRICE_FINISH_INVALID');
    if(saved.stored)result.stored++;else result.conflicts++;
   }catch(error){
    const code=safe(error);result.errors.push({code});
    if(attempt&&now()+1000<phaseDeadline){
     try{const failed=await rpc('fail',{p_attempt_id:attempt,p_code:code,p_http_status:Number.isInteger(error?.status)?error.status:null});
      if(!plain(failed)||typeof failed.recorded!=='boolean'||typeof failed.already_finished!=='boolean')throw new Error('PRICE_FAIL_INVALID');
     }catch{result.errors.push({code:'PRICE_FAILURE_RECORD_UNAVAILABLE'});}
    }
    if([401,429].includes(error?.status)){result.stop_json=true;break;}
    if(error?.status===403)break;
   }
  }
 }finally{
  result.requests=client.requestsMade-started;
  try{await repo.rpc('origin_sync_release',{p_resource:RESOURCE,p_owner:owner,p_lease_token:resource.lease_token},{deadline:phaseDeadline});}
  catch{result.errors.push({code:'PRICE_LEASE_RELEASE_UNAVAILABLE'});}
 }
 if(result.errors.length)result.status='partial';
 return result;
}
