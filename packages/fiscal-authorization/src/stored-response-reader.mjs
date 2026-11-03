/** Private read-only revalidation of an existing069 journal. No default I/O, A1, transport or writes. */
import {pinnedCandidateCertificate} from './pinned-certificate.mjs';
import {prepareAuthorization,parseAuthorizationResponse,composeProcessedNfe} from './index.mjs';
import {prepareReviewedAuthorizationSoap,encodeReviewedAuthorizationSoap,extractReviewedAuthorizationSoap} from './authorization-soap-binding.mjs';
import {projectDispatchLedger} from './dispatch-dto.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as PROFILE} from './validator.mjs';
import {STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from './stored-response-manifest.mjs';
import {SP_AUTHORIZATION_SERVER_TRUST,SP_AUTHORIZATION_ROOT_HASH} from '../../fiscal-runtime/src/authorization-server-trust.mjs';
import {AuthorizationServiceError,data,need,id,hash,freeze,scope,readBody,cancel} from './service-common.mjs';
import {resultEvidence,same,stamp,SQLSTATES} from './service-dto.mjs';
export {STORED_RESPONSE_MANIFEST,STORED_RESPONSE_MANIFEST_HASH} from './stored-response-manifest.mjs';
const BUCKET='brufap-fiscal-artifacts';
const failure=code=>new AuthorizationServiceError('AUTHORIZATION_STORED_RESPONSE_'+code);
const requireThat=(v,code)=>{if(!v)throw failure(code);};
const snapshot=v=>freeze({receipt:v.receipt,recovery:v.recovery,artifact:v.artifact,rule_review:v.rule_review,observation:v.observation});
function eligible(v){
 requireThat(v.receipt.origin==='operational'&&v.recovery.origin==='operational'&&v.current.state==='review_required'&&v.current.grant_consumed===true
  &&v.current.recovery_required===false&&v.artifact?.evidence.outcome==='invalid_response'&&v.artifact.evidence.rejection_code==='SOAP_INVALID'
  &&v.artifact.processed_hash===null&&v.artifact.processed_size===null&&v.rule_review!==null&&v.observation!==null&&v.rule_review.profile===v.recovery.rule_profile,'SOURCE_INVALID');
 return v;
}
function sidecar(raw,v){
 const x=data(raw,['profile','origin','attempt_id','command_id','candidate_id','batch_id','signed_hash','request_hash','response_hash','response_size','http_status','received_at','tls_peer_verified','tls_origin_verified','tls_protocol','server_trust_profile','server_trust_anchor_sha256','subset_review_hash'],[],'AUTHORIZATION_STORED_RESPONSE_JOURNAL_CONFLICT'),c=v.recovery;
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
 const ok=data(raw,['ok'],[...failKeys.filter(k=>k!=='ok'),'schemaProfile','model','environment','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared','validatorHash','schemaManifestHash'],'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID').ok;
 if(ok===false){
  const v=data(raw,failKeys,[],'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID');
  requireThat(v.xmlDigest===hash(bytes)&&v.kind===kind&&[...flags,'xsdValidated','contextMatched'].every(k=>v[k]===false)&&typeof v.code==='string'&&/^AUTHORIZATION_[A-Z_]{1,70}$/.test(v.code),'VALIDATOR_INVALID');
  throw failure(v.code==='AUTHORIZATION_XSD_INVALID'?'XSD_INVALID':/CONTEXT|REFERENCE|BATCH/.test(v.code)?'CONTEXT_MISMATCH':'XML_INVALID');
 }
 const v=data(raw,['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared',...flags,'validatorHash','schemaManifestHash'],[],'AUTHORIZATION_STORED_RESPONSE_VALIDATOR_INVALID');
 requireThat(v.ok===true&&v.schemaProfile===PROFILE.profile&&v.validatorHash===PROFILE.validatorHash&&v.schemaManifestHash===PROFILE.manifestHash&&v.kind===kind&&v.xmlDigest===hash(bytes)
  &&v.model===request.model&&v.environment==='2'&&v.xsdValidated===true&&v.contextMatched===true&&flags.every(k=>v[k]===false)
  &&['cStat','protocolCStat'].every(k=>v[k]===null||typeof v[k]==='string'&&/^\d{3,4}$/.test(v[k]))&&typeof v.referenceDigestMatched==='boolean'
  &&v.authorizationDeclared===['100','150'].includes(v.protocolCStat)&&(kind==='response'?v.cStat!==null:v.cStat===null&&v.authorizationDeclared&&v.referenceDigestMatched),'VALIDATOR_INVALID');
 return v;
}
const safeCodes=new Set(['AUTHORIZATION_SERVICE_ABORTED','AUTHORIZATION_SERVICE_TIMEOUT','AUTHORIZATION_SERVICE_BODY_INVALID','AUTHORIZATION_SERVICE_BODY_LIMIT','AUTHORIZATION_SERVICE_HASH_MISMATCH','AUTHORIZATION_SERVICE_INPUT_INVALID','AUTHORIZATION_SERVICE_RESPONSE_INVALID','AUTHORIZATION_SOURCE_INVALID','AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH','AUTHORIZATION_PINNED_CERTIFICATE_INVALID',...SQLSTATES]);
const localCodes=new Set(['SOURCE_INVALID','JOURNAL_CONFLICT','JOURNAL_MISSING','SOAP_INVALID','VALIDATOR_INVALID','XSD_INVALID','CONTEXT_MISMATCH','XML_INVALID','PROCESSED_INVALID','SOURCE_CHANGED','READ_FAILED'].map(x=>'AUTHORIZATION_STORED_RESPONSE_'+x));
/** The injected command reader must authenticate/re-authorize the actor on each call. Hashes do not replace that ACL. */
export function createStoredResponseReader(configuration){
 const p=data(configuration,['readCommand','readObject','validate']);need(['readCommand','readObject','validate'].every(k=>typeof p[k]==='function'));
 const readCommand=p.readCommand,readObject=p.readObject,validate=p.validate;
 return function readStoredResponse(input,options={}){
  // Capture the request and scope before the first await, including the original abort signal.
  const x=data(input,['actor','authorizationCommandId']);need(id(x.actor)&&id(x.authorizationCommandId));freeze(x);const s=scope(options);
  return (async()=>{
   const owned=[];let processed=null,delivered=false;
   const read=async(key,expected)=>{
    let response;const pending=Promise.resolve().then(()=>{s.check();return readObject({bucket:BUCKET,key,signal:s.signal,deadline:s.deadline});});
    try{try{response=await s.bounded(()=>pending);}catch(e){void pending.then(r=>cancel(r?.body)).catch(()=>{});throw e;}requireThat(response!==null,'JOURNAL_MISSING');
     const b=await readBody(response,s,expected);owned.push(b);return b;
    }finally{cancel(response?.body);}
   };
   const command=async()=>{const raw=await s.bounded(()=>readCommand(x,{signal:s.signal,deadline:s.deadline}));s.check();return eligible(projectDispatchLedger('command',raw,{p_user_id:x.actor,p_command_id:x.authorizationCommandId}));};
   const checked=async(request,bytes,kind)=>{const copy=Buffer.from(bytes),before=hash(bytes);try{const raw=await s.bounded(()=>validate({request,xmlBytes:copy,kind},{signal:s.signal,deadline:s.deadline}));s.check();requireThat(hash(copy)===before,'VALIDATOR_INVALID');return checkReport(raw,request,bytes,kind);}finally{copy.fill(0);}};
   try{
    const before=await command(),source=snapshot(before),c=before.recovery,a=before.artifact,path=type=>`authorization/${c.attempt_id}/${type}/${c.request_hash}.${type==='observations'?'json':'xml'}`;
    const signed=await read(`candidates/${c.candidate_id}/${c.signed_hash}.xml`,{expectedHash:c.signed_hash,expectedSize:c.signed_size});
    const wire=await read(path('requests'),{expectedHash:c.request_hash,expectedSize:c.request_size});
    const response=await read(path('responses'),{expectedHash:a.response_hash,expectedSize:a.response_size});
    const meta=await read(path('observations'),{max:8192,expectedHash:before.observation.sha256,expectedSize:before.observation.size_bytes});
    let decoded;try{decoded=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(meta));}catch{throw failure('JOURNAL_CONFLICT');}
    const observation=sidecar(decoded,before);requireThat(observation.http_status===200,'SOAP_INVALID');
    // The historical public certificate verifies the historical signed bytes; no PFX or current A1 is read.
    const at=new Date(before.receipt.created_at),cert=pinnedCandidateCertificate({signedBytes:signed,signedHash:c.signed_hash,signedSize:c.signed_size,certificateFingerprint:c.certificate_fingerprint,model:c.model,now:at});
    requireThat(cert.issuerCnpj===c.issuer_cnpj&&cert.accessKey===c.access_key&&cert.referenceDigest===c.reference_digest,'SOURCE_INVALID');
    const request=prepareAuthorization({signedBytes:signed,expectedSignedHash:c.signed_hash,expectedModel:c.model,expectedIssuerCnpj:c.issuer_cnpj,expectedHolderCnpj:c.issuer_cnpj,expectedCertificate:cert.certificate,expectedCertificateFingerprint:c.certificate_fingerprint,now:at,batchId:c.batch_id});
    const soap=prepareReviewedAuthorizationSoap({request}),rebuilt=Buffer.from(encodeReviewedAuthorizationSoap(soap));owned.push(rebuilt);requireThat(rebuilt.equals(wire),'JOURNAL_CONFLICT');
    // The parser consumes the original response bytes. Never rewrite its declaration or journal hash.
    let extracted;try{extracted=extractReviewedAuthorizationSoap({request:soap,envelopeBytes:response});}catch{throw failure('SOAP_INVALID');}
    const payload=Buffer.from(extracted.payloadXml);owned.push(payload);const report=await checked(request,payload,'response'),parsed=parseAuthorizationResponse({request,responseBytes:payload});
    requireThat(report.cStat===parsed.cStat&&report.protocolCStat===(parsed.protocol?.cStat??null)&&report.authorizationDeclared===(parsed.classification==='authorization_declared'),'VALIDATOR_INVALID');
    if(parsed.classification==='authorization_declared'){
     requireThat(report.referenceDigestMatched===true,'CONTEXT_MISMATCH');
     const composed=composeProcessedNfe({request,response:parsed});processed=Buffer.from(composed.processedXml);
     const checkedProcessed=await checked(request,processed,'processed');requireThat(composed.signatureVerified===true&&checkedProcessed.referenceDigestMatched&&checkedProcessed.authorizationDeclared&&checkedProcessed.protocolCStat===parsed.protocol.cStat,'PROCESSED_INVALID');
    }
    const evidence=resultEvidence({origin:'operational',request_hash:c.request_hash,response_hash:hash(response),payload_hash:hash(payload),schema_profile:PROFILE.profile,schema_manifest_hash:PROFILE.manifestHash,validator_hash:PROFILE.validatorHash,binding_profile:c.binding_profile,rule_profile:c.rule_profile,
     outcome:parsed.classification,rejection_code:null,cstat:parsed.cStat,protocol_cstat:parsed.protocol?.cStat??null,protocol_number:parsed.protocol?.number??null,received_at:new Date(parsed.protocol?.receivedAt??parsed.receivedAt).toISOString(),receipt_number:parsed.receiptNumber,
     reference_digest:processed?request.referenceDigest:null,signature_verified:processed!==null,xsd_validated:true,context_matched:true,processed_xsd_validated:processed!==null,tls_origin_verified:true,transport_hash:hash(meta),transport_size:meta.length,can_emit:false,can_transmit:false});
    const validation=freeze({parser_profile:STORED_RESPONSE_MANIFEST.profile,parser_manifest_hash:STORED_RESPONSE_MANIFEST_HASH,evidence,signed_hash:c.signed_hash,signed_size:signed.length,response_size:response.length,processed_hash:processed?hash(processed):null,processed_size:processed?.length??null,tax_rules_validated:false});
    // Re-authorize after all Storage/validator waits. Mutable current-state flags do not replace history.
    const after=await command();requireThat(same(source,snapshot(after)),'SOURCE_CHANGED');s.check();
    delivered=true;return Object.freeze({source,validation,processedBytes:processed});
   }catch(e){
    const descriptor=e!==null&&typeof e==='object'?Object.getOwnPropertyDescriptor(e,'code'):null,code=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:null;
    if(e instanceof AuthorizationServiceError&&(safeCodes.has(code)||localCodes.has(code)))throw e;
    if(SQLSTATES.includes(code))throw new AuthorizationServiceError(code);
    throw failure('READ_FAILED');
   }finally{for(const b of owned)b.fill(0);if(!delivered)processed?.fill(0);s.close();}
  })();
 };
}
