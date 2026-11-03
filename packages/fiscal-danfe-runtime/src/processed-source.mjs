/** Historical read-only source. Ports must enforce current RBAC/original actor on every RPC.
 * The brand prevents fabricated projections; it does not replace the injected ports' ACL. */
import {isProcessedReceiptQuerySource,processedReceiptQuerySource,disposeProcessedReceiptQuerySource,reauthorizeProcessedReceiptQuerySource} from './processed-receipt-query-source.mjs';
import {data,id,hash,freeze,scope,readBody,cancel,copy} from '../../fiscal-authorization/src/service-common.mjs';
import {same,stamp} from '../../fiscal-authorization/src/service-dto.mjs';
import {projectDispatchLedger} from '../../fiscal-authorization/src/dispatch-dto.mjs';
import {projectRevalidationLedger} from '../../fiscal-authorization/src/revalidation-dto.mjs';
import {pinnedCandidateCertificate} from '../../fiscal-authorization/src/pinned-certificate.mjs';
import {prepareAuthorization,parseAuthorizationResponse,verifyProcessedAuthorization} from '../../fiscal-authorization/src/index.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,extractReviewedAuthorizationSoap} from '../../fiscal-authorization/src/authorization-soap-binding.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {DanfeRuntimeError,need} from './processed-protocol.mjs';
const handles=new WeakMap(),BUCKET='brufap-fiscal-artifacts';
const required=v=>need(v,502,'DANFE_STORAGE_INVALID');
const snapshot=v=>freeze({receipt:v.receipt,recovery:v.recovery,artifact:v.artifact,rule_review:v.rule_review,observation:v.observation});
const caught=e=>{
 if(e instanceof DanfeRuntimeError)return e;
 const d=e&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,c=d&&Object.hasOwn(d,'value')?d.value:null;
 const map={P0002:[404,'DANFE_NOT_FOUND'],'42501':[403,'DANFE_FORBIDDEN'],'40001':[409,'DANFE_CONFLICT'],'55000':[409,'DANFE_NOT_STORED'],AUTHORIZATION_SERVICE_ABORTED:[503,'DANFE_UPSTREAM_UNAVAILABLE'],AUTHORIZATION_SERVICE_TIMEOUT:[503,'DANFE_UPSTREAM_UNAVAILABLE']};
 return Object.hasOwn(map,c??'')?new DanfeRuntimeError(...map[c]):new DanfeRuntimeError(502,'DANFE_STORAGE_INVALID');
};
function attested(handle){need(handles.has(handle),400,'DANFE_INVALID_REQUEST');return handles.get(handle);}
/** Every exported buffer is a copy. No trust object, certificate, raw ledger or Storage path escapes. */
export function processedSource(handle){if(isProcessedReceiptQuerySource(handle))return processedReceiptQuerySource(handle);const x=attested(handle);return Object.freeze({metadata:x.metadata,signedBytes:copy(x.signed),processedBytes:copy(x.processed)});}
export function disposeProcessedSource(handle){if(isProcessedReceiptQuerySource(handle))return disposeProcessedReceiptQuerySource(handle);const x=attested(handle);handles.delete(handle);x.signed.fill(0);x.processed.fill(0);}
export async function reauthorizeProcessedSource(handle,options={}){if(isProcessedReceiptQuerySource(handle))return reauthorizeProcessedReceiptQuerySource(handle,options);const x=attested(handle);try{await x.reauthorize(options);need(handles.has(handle),409,'DANFE_CONFLICT');}catch(e){throw caught(e);}}
function sidecar(raw,source){
 const x=data(raw,['profile','origin','attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash','response_hash','response_size','http_status','received_at','tls_peer_verified','tls_origin_verified','tls_protocol','server_trust_profile','server_trust_anchor_sha256','subset_review_hash']),c=source.recovery;
 required(x.profile==='authorization-reviewed-journal-v1'&&x.origin==='operational'&&x.http_status===200&&stamp(x.received_at)&&x.tls_peer_verified===true&&x.tls_origin_verified===true&&['TLSv1.2','TLSv1.3'].includes(x.tls_protocol)&&x.server_trust_profile===SP_AUTHORIZATION_SERVER_TRUST&&x.server_trust_anchor_sha256===SP_AUTHORIZATION_ROOT_HASH
  &&['attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash'].every(k=>x[k]===c[k])&&x.response_hash===source.artifact.response_hash&&x.response_size===source.artifact.response_size&&x.subset_review_hash===source.rule_review.review_hash);
}
export function createProcessedSource(configuration){
 const p=data(configuration,['authorizationRpc','revalidationRpc','storage']),storage=data(p.storage,['read']);
 required(typeof p.authorizationRpc==='function'&&typeof p.revalidationRpc==='function'&&typeof storage.read==='function');
 const {authorizationRpc,revalidationRpc}=p,readObject=storage.read;
 return function readProcessedSource(input,options={}){
  const x=data(input,['actor','sourceKind','commandId']);need(id(x.actor)&&id(x.commandId)&&['authorization','revalidation'].includes(x.sourceKind),400,'DANFE_INVALID_REQUEST');freeze(x);const s=scope(options);
  const command=async session=>{
   const args=Object.freeze({p_user_id:x.actor,p_command_id:x.commandId});
   const raw=await session.bounded(()=>x.sourceKind==='authorization'?authorizationRpc('command',args,{signal:session.signal,deadline:session.deadline}):revalidationRpc('command',args,{signal:session.signal,deadline:session.deadline}));session.check();
   if(x.sourceKind==='authorization'){
    const v=projectDispatchLedger('command',raw,args);need(v.receipt.origin==='operational'&&v.current.state==='authorized_homologation'&&v.current.grant_consumed===true&&v.artifact&&v.rule_review&&v.observation,409,'DANFE_NOT_STORED');
    return {source:snapshot(v),receipt:v.receipt,evidence:v.artifact.evidence,processedHash:v.artifact.processed_hash,processedSize:v.artifact.processed_size,stable:snapshot(v),key:`authorization/${v.receipt.attempt_id}/processed/${v.artifact.processed_hash}.xml`};
   }
   const v=projectRevalidationLedger('command',raw,args),r=v.receipt;need(r.origin==='operational'&&r.state==='authorized_homologation',409,'DANFE_NOT_STORED');
   return{source:v.source,receipt:r,evidence:r.evidence,processedHash:r.processed_hash,processedSize:r.processed_size,stable:freeze({receipt:r,source:v.source}),key:`revalidations/${r.attempt_id}/${r.parser_manifest_hash}/processed/${r.processed_hash}.xml`};
  };
  return(async()=>{
   const owned=[];let handle;
   const read=async(key,expected)=>{let response;const pending=Promise.resolve().then(()=>{s.check();return readObject({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
    try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}const b=await readBody(response,s,expected);owned.push(b);return b;}finally{cancel(response?.body);}};
   try{
    const before=await command(s),v=before.source,c=v.recovery,e=before.evidence;
    required(c.origin==='operational'&&e.origin==='operational'&&e.outcome==='authorization_declared'&&e.cstat==='104'&&['100','150'].includes(e.protocol_cstat)&&e.rejection_code===null&&e.reference_digest===c.reference_digest&&['signature_verified','xsd_validated','context_matched','processed_xsd_validated','tls_origin_verified'].every(k=>e[k]===true));
    const signed=await read(`candidates/${c.candidate_id}/${c.signed_hash}.xml`,{expectedHash:c.signed_hash,expectedSize:c.signed_size});
    const path=type=>`authorization/${c.attempt_id}/${type}/${c.request_hash}.${type==='observations'?'json':'xml'}`;
    const wire=await read(path('requests'),{expectedHash:c.request_hash,expectedSize:c.request_size});
    const response=await read(path('responses'),{expectedHash:v.artifact.response_hash,expectedSize:v.artifact.response_size});
    const meta=await read(path('observations'),{max:8192,expectedHash:v.observation.sha256,expectedSize:v.observation.size_bytes});
    let decoded;try{decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(meta));}catch{required(false);}sidecar(decoded,v);
    const processed=await read(before.key,{expectedHash:before.processedHash,expectedSize:before.processedSize});
    const at=new Date(v.receipt.created_at),cert=pinnedCandidateCertificate({signedBytes:signed,signedHash:c.signed_hash,signedSize:c.signed_size,certificateFingerprint:c.certificate_fingerprint,model:c.model,now:at});
    required(cert.issuerCnpj===c.issuer_cnpj&&cert.accessKey===c.access_key&&cert.referenceDigest===c.reference_digest);
    const request=prepareAuthorization({signedBytes:signed,expectedSignedHash:c.signed_hash,expectedModel:c.model,expectedIssuerCnpj:c.issuer_cnpj,expectedHolderCnpj:c.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:c.certificate_fingerprint,now:at,batchId:c.batch_id});
    const soap=prepareReviewedAuthorizationSoap({request}),rebuilt=Buffer.from(encodeReviewedAuthorizationSoap(soap));owned.push(rebuilt);required(rebuilt.equals(wire));
    const extracted=extractReviewedAuthorizationSoap({request:soap,envelopeBytes:response}),payload=Buffer.from(extracted.payloadXml);owned.push(payload);required(hash(payload)===e.payload_hash);
    const parsed=parseAuthorizationResponse({request,responseBytes:payload}),proof=verifyProcessedAuthorization({request,processedBytes:processed});
    required(parsed.classification==='authorization_declared'&&parsed.cStat===e.cstat&&same(parsed.protocol,proof.protocol)&&proof.processedHash===before.processedHash&&proof.sizeBytes===before.processedSize&&proof.protocol.cStat===e.protocol_cstat&&proof.protocol.number===e.protocol_number&&Date.parse(proof.protocol.receivedAt)===Date.parse(e.received_at));
    const after=await command(s);need(same(before.stable,after.stable),409,'DANFE_CONFLICT');s.check();
    const metadata=freeze({source_kind:x.sourceKind,source_command_id:x.commandId,authorization_command_id:v.receipt.command_id,attempt_id:c.attempt_id,candidate_id:c.candidate_id,candidate_version:v.receipt.candidate_version,signed_hash:c.signed_hash,signed_size:c.signed_size,model:c.model,environment:'2',processed_hash:before.processedHash,processed_size:before.processedSize,protocol:{cstat:proof.protocol.cStat,number:proof.protocol.number,received_at:new Date(proof.protocol.receivedAt).toISOString()}});
    handle=Object.freeze({profile:'processed-document-source-v1'});handles.set(handle,{metadata,signed:copy(signed),processed:copy(processed),reauthorize:async opts=>{const next=scope(opts);try{const value=await command(next);need(same(before.stable,value.stable),409,'DANFE_CONFLICT');next.check();}finally{next.close();}}});return handle;
   }catch(error){if(handle&&handles.has(handle))disposeProcessedSource(handle);throw caught(error);}
   finally{for(const b of owned)b.fill(0);s.close();}
  })();
 };
}
