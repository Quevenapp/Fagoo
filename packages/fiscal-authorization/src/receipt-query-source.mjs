/** Read-only089 source attestation. Four original objects, public certificate and two fresh ACL reads. */
import {pinnedCandidateCertificate} from './pinned-certificate.mjs';
import {prepareAuthorization} from './index.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,extractReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {createReceiptEvidenceReaderV2} from './receipt-core.mjs';
import {captureReceiptQuerySourceInput,projectReceiptQuerySource,receiptQuerySourceEvidence} from './receipt-query-evidence.mjs';
import {authorizationReceiptDetails} from './receipt-query-receipt.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as PROFILE} from './validator.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from './receipt-query-manifest.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {AuthorizationServiceError,data,need,hash,freeze,scope,readBody,cancel} from './service-common.mjs';
import {same,stamp,SQLSTATES} from './service-dto.mjs';
export {RECEIPT_QUERY_SOURCE_MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH} from './receipt-query-manifest.mjs';
const BUCKET='fagoo-fiscal-artifacts',handles=new WeakMap();
const failure=code=>new AuthorizationServiceError('RECEIPT_QUERY_SOURCE_'+code);
const requireThat=(v,code)=>{if(!v)throw failure(code);};
function sidecar(raw,v){
 const x=data(raw,['profile','origin','attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash','response_hash','response_size','http_status','received_at','tls_peer_verified','tls_origin_verified','tls_protocol','server_trust_profile','server_trust_anchor_sha256','subset_review_hash'],[],'RECEIPT_QUERY_SOURCE_JOURNAL_CONFLICT'),c=v.recovery;
 requireThat(x.profile==='authorization-reviewed-journal-v1'&&x.origin==='operational'&&x.tls_peer_verified===true&&x.tls_origin_verified===true
  &&['TLSv1.2','TLSv1.3'].includes(x.tls_protocol)&&x.server_trust_profile===SP_AUTHORIZATION_SERVER_TRUST&&x.server_trust_anchor_sha256===SP_AUTHORIZATION_ROOT_HASH
  &&[200,500].includes(x.http_status)&&stamp(x.received_at)&&['attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash'].every(k=>x[k]===c[k])
  &&x.response_hash===v.artifact.response_hash&&x.response_size===v.artifact.response_size&&x.subset_review_hash===v.rule_review.review_hash,'JOURNAL_CONFLICT');
 return x;
}
function checkReport(raw,request,bytes,kind){
 const failKeys=['ok','code','xmlDigest','kind','signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit','xsdValidated','contextMatched'];
 const flags=['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit'];
 // Inspect own data properties before consulting a runner result. No getters or extra claims.
 const ok=data(raw,['ok'],[...failKeys.filter(k=>k!=='ok'),'schemaProfile','model','environment','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared','validatorHash','schemaManifestHash'],'RECEIPT_QUERY_SOURCE_VALIDATOR_INVALID').ok;
 if(ok===false){
  const v=data(raw,failKeys,[],'RECEIPT_QUERY_SOURCE_VALIDATOR_INVALID');
  requireThat(v.xmlDigest===hash(bytes)&&v.kind===kind&&[...flags,'xsdValidated','contextMatched'].every(k=>v[k]===false)&&typeof v.code==='string'&&/^AUTHORIZATION_[A-Z_]{1,70}$/.test(v.code),'VALIDATOR_INVALID');
  throw failure(v.code==='AUTHORIZATION_XSD_INVALID'?'XSD_INVALID':/CONTEXT|REFERENCE|BATCH/.test(v.code)?'CONTEXT_MISMATCH':'XML_INVALID');
 }
 const v=data(raw,['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared',...flags,'validatorHash','schemaManifestHash'],[],'RECEIPT_QUERY_SOURCE_VALIDATOR_INVALID');
 requireThat(v.ok===true&&v.schemaProfile===PROFILE.profile&&v.validatorHash===PROFILE.validatorHash&&v.schemaManifestHash===PROFILE.manifestHash&&v.kind===kind&&v.xmlDigest===hash(bytes)
  &&v.model===request.model&&v.environment==='2'&&v.xsdValidated===true&&v.contextMatched===true&&flags.every(k=>v[k]===false)
  &&['cStat','protocolCStat'].every(k=>v[k]===null||typeof v[k]==='string'&&/^\d{3,4}$/.test(v[k]))&&typeof v.referenceDigestMatched==='boolean'
  &&v.authorizationDeclared===['100','150'].includes(v.protocolCStat)&&(kind==='response'?v.cStat!==null:v.cStat===null&&v.authorizationDeclared&&v.referenceDigestMatched),'VALIDATOR_INVALID');
 return v;
}

const safeCodes=new Set(['AUTHORIZATION_SERVICE_ABORTED','AUTHORIZATION_SERVICE_TIMEOUT','AUTHORIZATION_SERVICE_BODY_INVALID','AUTHORIZATION_SERVICE_BODY_LIMIT','AUTHORIZATION_SERVICE_HASH_MISMATCH','AUTHORIZATION_SERVICE_INPUT_INVALID','AUTHORIZATION_SERVICE_RESPONSE_INVALID','AUTHORIZATION_SOURCE_INVALID','AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH','AUTHORIZATION_PINNED_CERTIFICATE_INVALID',...SQLSTATES]);
const localCodes=new Set(['SOURCE_INVALID','JOURNAL_CONFLICT','JOURNAL_MISSING','SOAP_INVALID','VALIDATOR_INVALID','XSD_INVALID','CONTEXT_MISMATCH','XML_INVALID','SOURCE_CHANGED','READ_FAILED','UNATTESTED'].map(x=>'RECEIPT_QUERY_SOURCE_'+x));
/** readSource is a fixed service-only SQL source projection with current original-actor/issuer ACL.
 * Its second call must perform that ACL again. There are no current A1, policy, review or emission-time checks here. */
export function createReceiptQuerySource(configuration){
 const p=data(configuration,['readSource','readObject','validate']);need(['readSource','readObject','validate'].every(k=>typeof p[k]==='function'));
 const {readSource,readObject,validate}=p;
 return function readReceiptSource(input,options={}){
  const x=captureReceiptQuerySourceInput(input),s=scope(options);
  return(async()=>{
   const owned=[];
   const read=async(key,expected)=>{
    let response;const pending=Promise.resolve().then(()=>{s.check();return readObject({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
    try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}requireThat(response!==null,'JOURNAL_MISSING');
     const b=await readBody(response,s,expected);owned.push(b);return b;
    }finally{cancel(response?.body);}
   };
   const source=async()=>{const raw=await s.bounded(()=>readSource(x,{signal:s.signal,deadline:s.deadline}));s.check();return projectReceiptQuerySource(raw,x);};
   const checked=async(request,bytes)=>{const copy=Buffer.from(bytes),before=hash(bytes);try{const raw=await s.bounded(()=>validate({request,xmlBytes:copy,kind:'response'},{signal:s.signal,deadline:s.deadline}));s.check();requireThat(hash(copy)===before,'VALIDATOR_INVALID');return checkReport(raw,request,bytes,'response');}finally{copy.fill(0);}};
   try{
    const before=await source(),original=before.original_source,c=original.recovery,a=original.artifact,e=receiptQuerySourceEvidence(before),path=type=>`authorization/${c.attempt_id}/${type}/${c.request_hash}.${type==='observations'?'json':'xml'}`;
    const signed=await read(`candidates/${c.candidate_id}/${c.signed_hash}.xml`,{expectedHash:c.signed_hash,expectedSize:c.signed_size});
    const wire=await read(path('requests'),{expectedHash:c.request_hash,expectedSize:c.request_size});
    const response=await read(path('responses'),{expectedHash:a.response_hash,expectedSize:a.response_size});
    const meta=await read(path('observations'),{max:8192,expectedHash:original.observation.sha256,expectedSize:original.observation.size_bytes});
    let decoded;try{decoded=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(meta));}catch{throw failure('JOURNAL_CONFLICT');}
    const observation=sidecar(decoded,original);requireThat(observation.http_status===200,'SOAP_INVALID');
    const at=new Date(original.receipt.created_at),cert=pinnedCandidateCertificate({signedBytes:signed,signedHash:c.signed_hash,signedSize:c.signed_size,certificateFingerprint:c.certificate_fingerprint,model:c.model,now:at});
    requireThat(cert.issuerCnpj===c.issuer_cnpj&&cert.accessKey===c.access_key&&cert.referenceDigest===c.reference_digest,'SOURCE_INVALID');
    const request=prepareAuthorization({signedBytes:signed,expectedSignedHash:c.signed_hash,expectedModel:c.model,expectedIssuerCnpj:c.issuer_cnpj,expectedHolderCnpj:c.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:c.certificate_fingerprint,now:at,batchId:c.batch_id});
    const soap=prepareReviewedAuthorizationSoap({request}),rebuilt=Buffer.from(encodeReviewedAuthorizationSoap(soap));owned.push(rebuilt);requireThat(rebuilt.equals(wire),'JOURNAL_CONFLICT');
    let extracted;try{extracted=extractReviewedAuthorizationSoap({request:soap,envelopeBytes:response});}catch{throw failure('SOAP_INVALID');}
    const payload=Buffer.from(extracted.payloadXml);owned.push(payload);const report=await checked(request,payload),details=authorizationReceiptDetails({request,payloadBytes:payload});
    requireThat(report.cStat==='103'&&report.protocolCStat===null&&report.authorizationDeclared===false&&report.referenceDigestMatched===false,'VALIDATOR_INVALID');
    requireThat(details.payload_hash===e.payload_hash&&details.receipt_number===e.receipt_number&&details.received_at===e.received_at,'CONTEXT_MISMATCH');
    const validation=freeze({profile:RECEIPT_QUERY_SOURCE_MANIFEST.profile,manifest_hash:RECEIPT_QUERY_SOURCE_MANIFEST_HASH,source_binding_hash:before.source_binding_hash,
     payload_hash:details.payload_hash,receipt_number:details.receipt_number,tmed_seconds:details.tmed_seconds,received_at:details.received_at,observed_at:new Date(observation.received_at).toISOString(),
     signature_verified:true,xsd_validated:true,context_matched:true,tls_origin_verified:true,tax_rules_validated:false,can_query:false,can_emit:false,can_transmit:false});
    const after=await source();requireThat(same(before,after),'SOURCE_CHANGED');s.check();
    const evidence=await createReceiptEvidenceReaderV2({readReceipt:async()=>({source:before,payloadBytes:payload})})({request,...x},{signal:s.signal,deadline:s.deadline});s.check();
    const handle=freeze({profile:validation.profile,manifest_hash:validation.manifest_hash,source_binding_hash:before.source_binding_hash,source_kind:before.source_kind,source_command_id:before.source_command_id,
     authorization_command_id:before.authorization_command_id,authorization_attempt_id:before.authorization_attempt_id,model:before.model,candidate_id:before.candidate_id,tax_rules_validated:false,can_query:false,can_emit:false,can_transmit:false});
    handles.set(handle,freeze({source:before,validation,authorizationRequest:request,evidence,tmedLiteral:details.tmed_literal}));return handle;
   }catch(error){
    const d=error!==null&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):null,code=d&&Object.hasOwn(d,'value')?d.value:null;
    if(error instanceof AuthorizationServiceError&&(safeCodes.has(code)||localCodes.has(code)))throw error;
    if(SQLSTATES.includes(code))throw new AuthorizationServiceError(code);
    throw failure('READ_FAILED');
   }finally{for(const b of owned)b.fill(0);s.close();}
  })();
 };
}
/** Private, local provenance only. A copied object cannot unlock the attested request/evidence. */
export function receiptQuerySource(handle){const v=handles.get(handle);requireThat(v,'UNATTESTED');return v;}
export function disposeReceiptQuerySource(handle){handles.delete(handle);}
