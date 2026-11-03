/** Exact immutable089 Storage records. Responses/observations are named by REQUEST hash. */
import {data,need,id,sha,integer,hash,readBody,cancel} from './service-common.mjs';
import {stamp} from './service-dto.mjs';
import {SP_RECEIPT_QUERY_SERVER_TRUST,SP_RECEIPT_QUERY_ROOT_HASH} from './receipt-query-server-trust.mjs';
export const receiptQueryPath=(c,type,tag=c.request_hash)=>`receipt-queries/${c.query_id}/${type}/${tag}.${type==='observations'?'json':'xml'}`;
export function receiptQuerySidecar(raw,c,responseHash,responseSize){
 const x=data(raw,['profile','origin','query_id','nonce','authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','signed_hash','request_hash','response_hash','response_size','http_status','received_at','tls_peer_verified','tls_origin_verified','tls_protocol','server_trust_profile','server_trust_anchor_sha256']);
 need(x.profile==='receipt-query-journal-089-v1'&&x.origin==='operational'&&['query_id','nonce','authorization_command_id','authorization_attempt_id','source_kind','source_command_id','source_binding_hash','candidate_id','signed_hash','request_hash'].every(k=>x[k]===c[k])&&id(x.query_id)&&sha(x.request_hash)&&x.response_hash===responseHash&&x.response_size===responseSize&&integer(x.response_size,512000)&&[200,500].includes(x.http_status)&&stamp(x.received_at)&&Date.parse(x.received_at)>=Date.parse(c.created_at)&&x.tls_peer_verified===true&&x.tls_origin_verified===true&&['TLSv1.2','TLSv1.3'].includes(x.tls_protocol)&&x.server_trust_profile===SP_RECEIPT_QUERY_SERVER_TRUST&&x.server_trust_anchor_sha256===SP_RECEIPT_QUERY_ROOT_HASH,'RECEIPT_QUERY_JOURNAL_CONFLICT');return x;
}
export function createReceiptQueryJournal(storage){
 const p=data(storage,['read','putImmutable']);need(typeof p.read==='function'&&typeof p.putImmutable==='function');const read=p.read,put=p.putImmutable;
 async function readObject(key,s,expected={}){
  let response;const pending=Promise.resolve().then(()=>{s.check();return read({bucket:'brufap-fiscal-artifacts',key,signal:s.signal,deadline:s.deadline});});
  try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(v=>cancel(v?.body)).catch(()=>{});throw e;}s.check();if(response===null)return null;return await readBody(response,s,expected);}finally{cancel(response?.body);}
 }
 async function persist(key,bytes,s){
  const tag=hash(bytes),owned=Buffer.from(bytes);try{const raw=await s.bounded(()=>put({bucket:'brufap-fiscal-artifacts',key,bytes:owned,sha256:tag,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',signal:s.signal,deadline:s.deadline}));const ack=data(raw,['status','requires_readback']);need([200,201,409].includes(ack.status)&&ack.requires_readback===true&&hash(owned)===tag,'RECEIPT_QUERY_STORAGE_INVALID');}
  catch(e){if(e?.code==='42501')throw e;/* An immutable PUT is resolved only through an exact readback. */}finally{owned.fill(0);}
  s.check();const checked=await readObject(key,s,{expectedHash:tag,expectedSize:bytes.length});need(checked!==null,'RECEIPT_QUERY_JOURNAL_MISSING');checked.fill(0);return tag;
 }
 async function response(c,s,expected=null){
  const bytes=await readObject(receiptQueryPath(c,'responses'),s,expected?{expectedHash:expected.response_hash,expectedSize:expected.response_size}:{});need(bytes!==null,'RECEIPT_QUERY_JOURNAL_MISSING');let meta;
  try{meta=await readObject(receiptQueryPath(c,'observations'),s,{max:8192,...expected?{expectedHash:expected.observation_hash,expectedSize:expected.observation_size}:{}});need(meta!==null,'RECEIPT_QUERY_JOURNAL_MISSING');let raw;try{raw=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(meta));}catch{need(false,'RECEIPT_QUERY_JOURNAL_CONFLICT');}
   const observation=receiptQuerySidecar(raw,c,hash(bytes),bytes.length);return{bytes,observation,httpStatus:observation.http_status,observationHash:hash(meta),observationSize:meta.length};
  }catch(e){bytes.fill(0);throw e;}finally{meta?.fill(0);}
 }
 async function verify(v,s){
  if(!v.artifact)return;const c=v.recovery,a=v.artifact;
  const request=await readObject(receiptQueryPath(c,'requests'),s,{expectedHash:c.request_hash,expectedSize:c.request_size});need(request!==null,'RECEIPT_QUERY_JOURNAL_MISSING');request.fill(0);
  const journal=await response(c,s,a);journal.bytes.fill(0);
  if(a.processed_hash!==null){const processed=await readObject(receiptQueryPath(c,'processed',a.processed_hash),s,{expectedHash:a.processed_hash,expectedSize:a.processed_size});need(processed!==null,'RECEIPT_QUERY_JOURNAL_MISSING');processed.fill(0);}
 }
 return Object.freeze({read:readObject,persist,response,verify});
}
