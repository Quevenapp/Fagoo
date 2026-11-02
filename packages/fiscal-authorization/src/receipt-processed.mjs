/** Candidate nfeProc from an attested receipt query. No origin/TLS/XSD/authorization claim. */
import {createHash} from 'node:crypto';
import {authorizationRequestBytes,verifyProcessedAuthorization} from './index.mjs';
import {assertReceiptResponse,receiptValidationContext,parseReceiptResponse,MAX_RECEIPT_BYTES,RECEIPT_FLAGS} from './receipt-core.mjs';
import {parseStrict,elements,serialize} from '../../fiscal-xml/src/xml.mjs';
export const RECEIPT_PROCESSED_PROFILE='sp-receipt-processed-candidate-20261017-v1';
export class ReceiptProcessedError extends Error{constructor(code){super(code);this.name='ReceiptProcessedError';this.code=code;}}
const fail=code=>{throw new ReceiptProcessedError(code);},need=(v,code)=>{if(!v)fail(code);};
const NS='http://www.portalfiscal.inf.br/nfe',hash=v=>createHash('sha256').update(v).digest('hex');
const typed=Object.getPrototypeOf(Uint8Array.prototype),gets=Object.fromEntries(['buffer','byteLength','byteOffset'].map(k=>[k,Object.getOwnPropertyDescriptor(typed,k).get]));
function fields(v){try{need(v&&[Object.prototype,null].includes(Object.getPrototypeOf(v)),'RECEIPT_PROCESSED_INPUT_INVALID');const d=Object.getOwnPropertyDescriptors(v),keys=['authorizationRequest','request','response','responseBytes'];need(Reflect.ownKeys(d).length===keys.length&&keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')),'RECEIPT_PROCESSED_INPUT_INVALID');return Object.fromEntries(keys.map(k=>[k,d[k].value]));}catch{fail('RECEIPT_PROCESSED_INPUT_INVALID');}}
function copy(v){try{need(ArrayBuffer.isView(v)&&v instanceof Uint8Array,'RECEIPT_PROCESSED_BYTES_INVALID');const buffer=gets.buffer.call(v),size=gets.byteLength.call(v),offset=gets.byteOffset.call(v);need(buffer instanceof ArrayBuffer&&size>0&&size<=MAX_RECEIPT_BYTES,'RECEIPT_PROCESSED_BYTES_INVALID');return Buffer.from(new Uint8Array(buffer,offset,size));}catch{fail('RECEIPT_PROCESSED_BYTES_INVALID');}}
function text(b){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);}catch{fail('RECEIPT_PROCESSED_ENCODING_INVALID');}}

export function composeReceiptProcessedNfe(input){
 const v=fields(input);let original,bytes;
 try{
  // Neither a clone nor a property getter may supply a forged source or response.
  try{original=authorizationRequestBytes(v.authorizationRequest);}catch{fail('RECEIPT_PROCESSED_AUTHORIZATION_UNATTESTED');}
  let response,context;try{response=assertReceiptResponse({request:v.request,response:v.response});context=receiptValidationContext(v.request);}catch{fail('RECEIPT_PROCESSED_RESPONSE_UNATTESTED');}
  const a=v.authorizationRequest,q=v.request;
  need(a.model===q.model&&a.environment===q.environment&&a.signedHash===q.signedHash&&a.batchId===q.batchId&&a.accessKey===context.accessKey&&a.referenceDigest===context.referenceDigest,'RECEIPT_PROCESSED_SOURCE_MISMATCH');
  need(response.classification==='authorization_declared'&&response.cStat==='104'&&['100','150'].includes(response.protocol?.cStat),'RECEIPT_PROCESSED_NOT_AUTHORIZED_DECLARATION');
  bytes=copy(v.responseBytes);need(hash(bytes)===response.responseHash&&bytes.length===response.sizeBytes,'RECEIPT_PROCESSED_RESPONSE_HASH_MISMATCH');
  // Reparse the exact hash-bound bytes before extracting the one contextual protocol.
  let parsed;try{parsed=parseReceiptResponse({request:q,responseBytes:bytes});}catch{fail('RECEIPT_PROCESSED_RESPONSE_INVALID');}
  need(parsed.responseHash===response.responseHash&&parsed.classification===response.classification,'RECEIPT_PROCESSED_RESPONSE_INVALID');
  const prefix=`<enviNFe xmlns="${NS}" versao="4.00"><idLote>${a.batchId}</idLote><indSinc>1</indSinc>`,suffix='</enviNFe>',source=text(original);
  need(source.startsWith(prefix)&&source.endsWith(suffix),'RECEIPT_PROCESSED_SOURCE_MISMATCH');
  const nfe=source.slice(prefix.length,-suffix.length);let protocol;
  try{const root=parseStrict(text(bytes)).documentElement;const all=elements(root).filter(n=>n.localName==='protNFe'&&n.namespaceURI===NS);need(all.length===1,'RECEIPT_PROCESSED_RESPONSE_INVALID');protocol=serialize(all[0]);}catch{fail('RECEIPT_PROCESSED_RESPONSE_INVALID');}
  const xml=`<nfeProc xmlns="${NS}" versao="4.00">${nfe}${protocol}</nfeProc>`;
  need(Buffer.byteLength(xml)<=MAX_RECEIPT_BYTES,'RECEIPT_PROCESSED_SIZE_LIMIT');
  const processedBytes=Buffer.from(xml);let proof;
  try{proof=verifyProcessedAuthorization({request:a,processedBytes});}catch{fail('RECEIPT_PROCESSED_SIGNATURE_OR_CONTEXT_INVALID');}finally{processedBytes.fill(0);}
  need(proof.protocol.cStat===response.protocol.cStat&&proof.protocol.number===response.protocol.number&&proof.protocol.receivedAt===response.protocol.receivedAt,'RECEIPT_PROCESSED_PROTOCOL_MISMATCH');
  return Object.freeze({profile:RECEIPT_PROCESSED_PROFILE,model:q.model,environment:'2',origin:q.origin,
   sourceState:'receipt_pending',authorizationCommandId:q.commandId,sourceEvidenceHash:q.sourceEvidenceHash,
   signedHash:a.signedHash,batchId:q.batchId,receiptNumber:q.receiptNumber,authorizationPayloadHash:a.requestHash,
   queryPayloadHash:q.requestHash,receiptResponseHash:response.responseHash,processedXml:xml,processedHash:proof.processedHash,
   sizeBytes:proof.sizeBytes,referenceDigest:proof.referenceDigest,protocol:response.protocol,...RECEIPT_FLAGS,
   signatureVerified:true,contextMatched:true});
 }finally{original?.fill(0);bytes?.fill(0);}
}
