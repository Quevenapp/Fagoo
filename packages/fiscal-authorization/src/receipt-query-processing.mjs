/** Local089 response validation. This module neither sends nor persists anything. */
import {data,need,hash} from './service-common.mjs';
import {RECEIPT_VALIDATOR_PROFILE as RECEIPT} from './receipt-validator.mjs';
import {AUTHORIZATION_VALIDATOR_PROFILE as AUTHORIZATION} from './validator.mjs';
import {receiptQuerySource} from './receipt-query-source.mjs';
import {extractReviewedReceiptSoap,prepareReviewedReceiptSoap} from './receipt-soap-binding.mjs';
import {composeReceiptQueryProcessedNfe} from './receipt-query-processed.mjs';
import {RECEIPT_QUERY_SOURCE_MANIFEST as MANIFEST,RECEIPT_QUERY_SOURCE_MANIFEST_HASH as MANIFEST_HASH} from './receipt-query-manifest.mjs';
export const receiptQueryEvidenceBase=c=>({profile:MANIFEST.profile,manifest_hash:MANIFEST_HASH,...Object.fromEntries(['query_id','nonce','source_binding_hash','signed_hash','model','environment','receipt_number'].map(k=>[k,c[k]])),request_hash:c.request_hash,tax_rules_validated:false,can_emit:false,can_transmit:false});
/** The validator port is backend-only, but its output must still match fixed pins and exact bytes. */
export async function validateReceiptQueryBytes(port,request,bytes,kind,s){
 const processed=kind==='processed',profile=processed?AUTHORIZATION:RECEIPT;
 const negative=['signatureVerified','tlsOriginVerified','sefazAuthorized','authorizedInHomologation','canEmit','canTransmit',...processed?[]:['canQuery','retrySubmissionAllowed']];
 const own=Buffer.from(bytes),tag=hash(bytes);
 try{
  const raw=await s.bounded(()=>port({request,xmlBytes:own,kind},{signal:s.signal,deadline:s.deadline}));s.check();need(hash(own)===tag,'RECEIPT_QUERY_VALIDATOR_INVALID');
  const ok=Object.getOwnPropertyDescriptor(raw??{},'ok');need(ok&&Object.hasOwn(ok,'value'),'RECEIPT_QUERY_VALIDATOR_INVALID');
  if(ok.value===false){const x=data(raw,['ok','code','xmlDigest','kind','xsdValidated','contextMatched',...negative]);need(x.xmlDigest===tag&&x.kind===kind&&x.xsdValidated===false&&x.contextMatched===false&&negative.every(k=>x[k]===false)&&typeof x.code==='string'&&/^(?:AUTHORIZATION|RECEIPT)_[A-Z_]{1,80}$/.test(x.code),'RECEIPT_QUERY_VALIDATOR_INVALID');return x;}
  const x=data(raw,['ok','schemaProfile','kind','xmlDigest','model','environment','xsdValidated','contextMatched','cStat','protocolCStat','referenceDigestMatched','authorizationDeclared','validatorHash','schemaManifestHash',...negative]);
  need(x.ok===true&&x.schemaProfile===profile.profile&&x.validatorHash===profile.validatorHash&&x.schemaManifestHash===profile.manifestHash&&x.kind===kind&&x.xmlDigest===tag&&x.model===request.model&&x.environment==='2'&&x.xsdValidated===true&&x.contextMatched===true&&negative.every(k=>x[k]===false)&&typeof x.referenceDigestMatched==='boolean'&&typeof x.authorizationDeclared==='boolean'&&[x.cStat,x.protocolCStat].every(v=>v===null||typeof v==='string'&&/^\d{3,4}$/.test(v))&&x.authorizationDeclared===['100','150'].includes(x.protocolCStat),'RECEIPT_QUERY_VALIDATOR_INVALID');return x;
 }finally{own.fill(0);}
}
export async function processReceiptQueryResponse({context:c,source,request,bytes,httpStatus,observationHash,observationSize,validate,validateProcessed},s){
 let payload=null,processed=null,parsed=null,payloadHash=null,code=null;
 try{
  try{const extracted=extractReviewedReceiptSoap({request:prepareReviewedReceiptSoap({request}),envelopeBytes:bytes});payload=Buffer.from(extracted.payloadXml);payloadHash=hash(payload);parsed=extracted.response;}
  catch(e){code=e?.code==='SOAP_RECEIPT_FAULT'?'SOAP_FAULT':'SOAP_INVALID';}
  if(!code&&httpStatus!==200)code='SOAP_INVALID';
  if(!code){const report=await validateReceiptQueryBytes(validate,request,payload,'response',s);if(!report.ok)code=report.code==='RECEIPT_XSD_INVALID'?'XSD_INVALID':/CONTEXT|REFERENCE|DIGEST/.test(report.code)?'CONTEXT_MISMATCH':'XML_INVALID';
   else need(report.cStat===parsed.cStat&&report.protocolCStat===(parsed.protocol?.cStat??null)&&report.authorizationDeclared===(parsed.classification==='authorization_declared'),'RECEIPT_QUERY_VALIDATOR_INVALID');}
  if(!code&&parsed.classification==='authorization_declared'){
   const candidate=composeReceiptQueryProcessedNfe({source,request,response:parsed,responseBytes:payload});processed=Buffer.from(candidate.processedXml);
   const report=await validateReceiptQueryBytes(validateProcessed,receiptQuerySource(source).authorizationRequest,processed,'processed',s);
   if(!report.ok)code='PROCESSED_INVALID';else need(report.authorizationDeclared&&report.referenceDigestMatched&&report.protocolCStat===parsed.protocol.cStat,'RECEIPT_QUERY_VALIDATOR_INVALID');
  }
  if(code){processed?.fill(0);processed=null;}
  const evidence={...receiptQueryEvidenceBase(c),response_hash:hash(bytes),payload_hash:payloadHash,outcome:code?'invalid_response':parsed.classification,rejection_code:code,cstat:code?null:parsed.cStat,protocol_cstat:code?null:parsed.protocol?.cStat??null,protocol_number:processed?parsed.protocol.number:null,received_at:code?null:new Date(parsed.protocol?.receivedAt??parsed.receivedAt).toISOString(),reference_digest:processed?c.reference_digest:null,signature_verified:processed!==null,xsd_validated:!code,context_matched:!code,processed_xsd_validated:processed!==null,tls_origin_verified:true,observation_hash:observationHash,observation_size:observationSize};
  return{evidence,processed};
 }catch(e){processed?.fill(0);throw e;}finally{payload?.fill(0);}
}
