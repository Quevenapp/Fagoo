import { archiveKey,decodeArchivedDocuments } from '../../../packages/fiscal-xml/src/archive.mjs';
import { XmlStorage } from './xml-storage.mjs';

const codeOf=error=>{
 const code=error?.code||error?.message||'';
 if(code==='ORIGIN_HTTP_ERROR'&&Number.isInteger(error?.status)&&error.status>=400&&error.status<=599)return `ORIGIN_HTTP_${error.status}`;
 return /^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'XML_COLLECTION_FAILED';
};
/** Called inside the existing scheduler lease, with the same rate-limited client. */
export async function collectXml(repo,client,{owner,lease,deadline,heartbeat=async()=>{},storage=new XmlStorage(repo),now=Date.now,
 maxCandidates=2,maxRequests=6,examinations={visited:new Set(),stopped:false},candidateProvider}={}){
 if(!Number.isInteger(maxCandidates)||maxCandidates<1||maxCandidates>4||!Number.isInteger(maxRequests)||maxRequests<3||maxRequests>12
  ||!(examinations?.visited instanceof Set)||typeof examinations.stopped!=='boolean'
  ||candidateProvider!==undefined&&(typeof candidateProvider?.list!=='function'||typeof candidateProvider?.settled!=='function'))throw new Error('XML_COLLECTION_OPTIONS_INVALID');
 const result={status:'completed',keys:0,files:0,unchanged:0,errors:[],requests:0,stop_json:false};
 const startedRequests=client.requestsMade,cap=maxRequests;
 const phaseDeadline=Math.min(deadline,now()+45000);
 const check=limit=>{if(now()>=limit)throw new Error('XML_TIME_LIMIT');};
 const budgeted={get(path,params,keyDeadline){check(keyDeadline);if(client.remainingRequests<3||client.requestsMade-startedRequests>cap-3)throw new Error('XML_REQUEST_BUDGET');return client.get(path,params,{deadline:keyDeadline});}};
 if(examinations.stopped)return{...result,status:'skipped_stopped'};
 let candidates;try{check(phaseDeadline);candidates=candidateProvider
  ?await candidateProvider.list({limit:maxCandidates,deadline:phaseDeadline})
  :await repo.rpc('origin_sync_xml_candidates',{p_owner:owner,p_lease_token:lease.lease_token,p_limit:maxCandidates},{deadline:phaseDeadline});check(phaseDeadline);}
 catch(error){examinations.stopped=true;return{...result,status:'failed',errors:[{code:codeOf(error)}]};}
 if(!Array.isArray(candidates?.items)||candidates.items.length>maxCandidates){examinations.stopped=true;return{...result,status:'failed',errors:[{code:'XML_CANDIDATES_INVALID'}]};}
 for(const candidate of candidates.items){
  if(now()+5000>=phaseDeadline||client.remainingRequests<3||client.requestsMade-startedRequests>cap-3)break;
  const keyDeadline=Math.min(phaseDeadline,now()+20000);let attempt,stage='candidate';
  try{
   if(!candidate||!['nfe','nfce'].includes(candidate.entity)||typeof candidate.source_id!=='string'||!/^\d{1,40}$/.test(candidate.source_id)||!/^\d{44}$/.test(candidate.key)||!/^[a-f0-9]{64}$/.test(candidate.fingerprint))throw new Error('XML_CANDIDATE_INVALID');
   const identity=`${candidate.entity}/${candidate.source_id}/${candidate.key}`;
   if(examinations.visited.has(identity))continue;
   // Mark before begin: even an unknown ACK cannot authorize a second GET this cycle.
   examinations.visited.add(identity);
   await heartbeat(keyDeadline);check(keyDeadline);stage='begin';
   attempt=await repo.rpc('origin_sync_xml_begin',{p_owner:owner,p_lease_token:lease.lease_token,p_entity:candidate.entity,p_source_id:candidate.source_id,p_key:candidate.key,p_fingerprint:candidate.fingerprint},{deadline:keyDeadline});
   if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt?.attempt_id)||attempt.entity!==candidate.entity||attempt.source_id!==candidate.source_id||attempt.key!==candidate.key||attempt.fingerprint!==candidate.fingerprint)throw new Error('XML_ATTEMPT_INVALID');
   check(keyDeadline);stage='object';
   archiveKey(candidate.key,candidate.entity);
   const data=await budgeted.get(`/nfe/documento/${candidate.key}`,{formato:'xml'},keyDeadline);
   const documents=await decodeArchivedDocuments(data,{key:candidate.key,entity:candidate.entity,deadline:Math.min(keyDeadline,now()+15000),now});
   for(const document of documents){check(keyDeadline);await heartbeat(keyDeadline);check(keyDeadline);await storage.ensure(document,{deadline:Math.min(keyDeadline,now()+15000)});check(keyDeadline);}
   await heartbeat(keyDeadline);check(keyDeadline);stage='finish';
   const stored=await repo.rpc('origin_sync_xml_finish',{p_owner:owner,p_lease_token:lease.lease_token,p_attempt_id:attempt.attempt_id,p_documents:documents.map(({bytes,...metadata})=>metadata)},{deadline:keyDeadline});
   if(stored?.stored!==true||stored.files!==documents.length||typeof stored.unchanged!=='boolean')throw new Error('XML_FINISH_INVALID');
   result.keys++;result.files+=stored.files;if(stored.unchanged)result.unchanged++;
   stage='settle';await candidateProvider?.settled(candidate,{attempt_id:attempt.attempt_id,deadline:phaseDeadline});
  }catch(error){
   const code=codeOf(error);result.errors.push({entity:candidate?.entity==='nfce'?'nfce':'nfe',code});
   if(stage==='begin'||stage==='finish'||stage==='settle')examinations.stopped=true;
   if(attempt?.attempt_id&&stage!=='settle'){const blocked=error.status===403||(/^XML_/.test(code)&&!/(?:TIME|BUDGET|STORAGE|ABORT)/.test(code));
    const retrySeconds=code==='ORIGIN_XML_DOCUMENT_UNAVAILABLE'?86400:[400,404,422].includes(error.status)?3600:blocked?86400:300;
    try{check(phaseDeadline);const failed=await repo.rpc('origin_sync_xml_fail',{p_owner:owner,p_lease_token:lease.lease_token,p_attempt_id:attempt.attempt_id,p_code:code,p_blocked:blocked,p_retry_seconds:retrySeconds},{deadline:phaseDeadline});
     if(failed?.recorded!==true&&!(failed?.recorded===false&&failed.already_stored===true))throw new Error('XML_FAILURE_STATUS_INVALID');
     await candidateProvider?.settled(candidate,{attempt_id:attempt.attempt_id,deadline:phaseDeadline});
    }catch{examinations.stopped=true;result.errors.push({code:'XML_FAILURE_STATUS_UNAVAILABLE'});}}
   if([401,429].includes(error.status))result.stop_json=true;
   if([401,403,429].includes(error.status))examinations.stopped=true;
   if(examinations.stopped)break;
  }
 }
 result.requests=client.requestsMade-startedRequests;if(result.errors.length)result.status='partial';return result;
}
