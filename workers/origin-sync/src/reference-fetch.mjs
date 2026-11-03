/** Missing exact catalog references from local open proposals; staging only. */
import { sourceId } from './resources.mjs';
import { priceCapture } from './price-json.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[1-9][0-9]{0,39}$/;
const HASH=/^[0-9a-f]{64}$/;
const ENTITIES=['contacts','products'];
const RESOURCE='proposal_references';
const PREFIX='origin_sync_reference_';
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safe=e=>/^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code||e?.message||'')?e.code||e.message:'REFERENCE_FETCH_FAILED';

export async function fetchMissingReferences(repo,client,{owner,lease,deadline,heartbeat=async()=>{},now=Date.now}={}) {
 if(!UUID.test(owner)||!UUID.test(lease?.lease_token)||!Number.isFinite(deadline))throw new Error('REFERENCE_FETCH_CONFIG_INVALID');
 const started=client.requestsMade,phaseDeadline=Math.min(deadline-20000,now()+40000);
 const result={status:'completed',attempted:0,stored:0,conflicts:0,requests:0,errors:[],stop_json:false};
 const room=()=>{
  if(now()+5000>=phaseDeadline){result.status='skipped_time';return false;}
  // One HTTP attempt per GET. Keep the existing 14-request JSON-page reserve.
  if(client.requestsMade-started>=10||client.remainingRequests<15){result.status='skipped_budget';return false;}
  return true;
 };
 if(!room())return result;
 const resource=await repo.rpc('origin_sync_claim',{p_resource:RESOURCE,p_owner:owner,p_ttl_seconds:300},{deadline:phaseDeadline});
 if(!plain(resource)||typeof resource.acquired!=='boolean'||(resource.acquired&&!UUID.test(resource.lease_token)))throw new Error('REFERENCE_LEASE_INVALID');
 if(!resource.acquired)return {...result,status:'already_running'};
 const identity={p_owner:owner,p_lease_token:lease.lease_token,p_resource_token:resource.lease_token};
 const rpc=(name,args={})=>repo.rpc(PREFIX+name,{...identity,...args},{deadline:phaseDeadline});
 const suspended=new Set();
 try {
  const list=await rpc('candidates',{p_limit:10});
  if(!plain(list)||!Array.isArray(list.items)||list.items.length>10)throw new Error('REFERENCE_CANDIDATES_INVALID');
  const seen=new Set();
  const candidates=list.items.map(v=>{
   if(!plain(v)||!ENTITIES.includes(v.entity)||typeof v.source_id!=='string'||!ID.test(v.source_id)||typeof v.proposal_id!=='string'||!ID.test(v.proposal_id)||typeof v.proposal_hash!=='string'||!HASH.test(v.proposal_hash)
    ||typeof v.proposal_version!=='string'||!(/^[1-9][0-9]{0,18}$/).test(v.proposal_version)||BigInt(v.proposal_version)>9223372036854775807n
    ||seen.has(`${v.entity}:${v.source_id}`))throw new Error('REFERENCE_CANDIDATES_INVALID');
   seen.add(`${v.entity}:${v.source_id}`);
   return Object.freeze({entity:v.entity,source_id:v.source_id,proposal_id:v.proposal_id,proposal_hash:v.proposal_hash,proposal_version:v.proposal_version});
  });
  for(const candidate of candidates){
   if(suspended.has(candidate.entity))continue;
   if(!room())break;
   let attempt=null;
   try{
    await heartbeat(phaseDeadline);if(!room())break;
    const id=crypto.randomUUID();
    const begun=await rpc('begin',{p_attempt_id:id,p_entity:candidate.entity,p_source_id:candidate.source_id,
     p_proposal_id:candidate.proposal_id,p_proposal_hash:candidate.proposal_hash,p_proposal_version:candidate.proposal_version});
    if(!plain(begun)||begun.attempt_id!==id||!['pending','stored','conflict','failed','superseded'].includes(begun.state)||typeof begun.replayed!=='boolean')throw new Error('REFERENCE_BEGIN_INVALID');
    if(begun.state!=='pending')continue;
    attempt=id;
    if(!room())break;
    result.attempted++;
    const payload=await client.get(`/${candidate.entity==='contacts'?'contatos':'produtos'}/${candidate.source_id}`,{},
     {deadline:Math.min(phaseDeadline-2000,now()+15000),maxAttempts:1});
    if(!plain(payload)||sourceId(payload.id)!==candidate.source_id)throw new Error('REFERENCE_DETAIL_IDENTITY_INVALID');
    await heartbeat(phaseDeadline);
    const capture=priceCapture(payload);
    const saved=await rpc(capture?'finish_precise':'finish',{p_attempt_id:attempt,p_payload:payload,...(capture?{p_price_capture:capture}:{})});
    if(!plain(saved)||typeof saved.stored!=='boolean'||typeof saved.conflict!=='boolean'||saved.stored===saved.conflict||typeof saved.replayed!=='boolean')throw new Error('REFERENCE_FINISH_INVALID');
    if(saved.stored){result.stored++;if(capture)result.price_captures=(result.price_captures||0)+1;}else result.conflicts++;
   }catch(error){
    const code=safe(error);result.errors.push({entity:candidate.entity,code});
    if(error?.status===403)suspended.add(candidate.entity);
    if(attempt&&now()+1000<phaseDeadline){
     try{const failed=await rpc('fail',{p_attempt_id:attempt,p_code:code,p_http_status:Number.isInteger(error?.status)?error.status:null});
      if(!plain(failed)||typeof failed.recorded!=='boolean'||typeof failed.already_finished!=='boolean')throw new Error('REFERENCE_FAIL_INVALID');
     }catch{result.errors.push({entity:candidate.entity,code:'REFERENCE_FAILURE_RECORD_UNAVAILABLE'});}
    }
    if([401,429].includes(error?.status)){result.stop_json=true;break;}
   }
  }
 }finally{
  result.requests=client.requestsMade-started;
  // Releasing only our exact fence is safe even if the lease expired.
  try{await repo.rpc('origin_sync_release',{p_resource:RESOURCE,p_owner:owner,p_lease_token:resource.lease_token},{deadline});}
  catch{result.errors.push({code:'REFERENCE_LEASE_RELEASE_UNAVAILABLE'});}
 }
 if(result.errors.length)result.status='partial';
 return result;
}
