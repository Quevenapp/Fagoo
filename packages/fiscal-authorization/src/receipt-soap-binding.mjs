/** Pure receipt SOAP55/65. No transport, credentials, ledger or runtime activation. */
import {createHash} from 'node:crypto';
import {receiptRequestBytes,parseReceiptResponse,RECEIPT_FLAGS,RECEIPT_PROFILE,RECEIPT_MANIFEST_HASH} from './receipt-core.mjs';
import {parseStrict,elements,serialize} from '../../fiscal-xml/src/xml.mjs';
import {RECEIPT_MANIFEST} from './receipt-manifest.mjs';
export const RECEIPT_SOAP_MANIFESTS=Object.freeze(Object.fromEntries(RECEIPT_MANIFEST.bindings.map(b=>[b.model,Object.freeze({
 ...b,profile:`sp${b.model}-receipt-soap12-reviewed-20261016-v1`,payloadProfile:RECEIPT_PROFILE,payloadManifestHash:RECEIPT_MANIFEST_HASH,
 source:b.wsdl,outputPart:'nfeRetAutorizacaoLoteResult',limitations:Object.freeze(['Local binding only; no grant, transport or origin attestation.','The authorization103 receipt remains historical; no retry of submission.'])
})])));
const MANIFESTS=RECEIPT_SOAP_MANIFESTS;
export const MAX_RECEIPT_SOAP_BYTES=512000;
export const RECEIPT_SOAP_FLAGS=Object.freeze({...RECEIPT_FLAGS,signatureVerified:false,bindingReviewed:true,bindingVerified:false,operationAuthorized:false});
const SOAP='http://www.w3.org/2003/05/soap-envelope',NFE='http://www.portalfiscal.inf.br/nfe',XMLNS='http://www.w3.org/2000/xmlns/';
const hash=v=>createHash('sha256').update(v).digest('hex');
export const RECEIPT_SOAP_MANIFEST_HASHES=Object.freeze(Object.fromEntries(Object.entries(MANIFESTS).map(([model,m])=>[model,hash(JSON.stringify(m))])));
const BINDINGS=Object.freeze(Object.fromEntries(Object.entries(MANIFESTS).map(([model,m])=>[model,Object.freeze({...m,manifestHash:RECEIPT_SOAP_MANIFEST_HASHES[model],...RECEIPT_SOAP_FLAGS})])));
const requests=new WeakMap(),typed=Object.getPrototypeOf(Uint8Array.prototype);
const getters=Object.fromEntries(['buffer','byteLength','byteOffset'].map(k=>[k,Object.getOwnPropertyDescriptor(typed,k).get]));
export class ReceiptSoapBindingError extends Error{constructor(code){super(code);this.name='ReceiptSoapBindingError';this.code=code;}}
const need=(ok,code)=>{if(!ok)throw new ReceiptSoapBindingError(code);};
function fields(value,keys){
 try{
  need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'SOAP_RECEIPT_INPUT_INVALID');
  const d=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(d);
  need(actual.length===keys.length&&actual.every(k=>typeof k==='string'&&keys.includes(k)&&d[k].enumerable&&Object.hasOwn(d[k],'value')),'SOAP_RECEIPT_INPUT_INVALID');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
 }catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_INPUT_INVALID');}
}
function copy(value){
 try{
  need(ArrayBuffer.isView(value)&&value instanceof Uint8Array,'SOAP_RECEIPT_BYTES_INVALID');
  const size=getters.byteLength.call(value),offset=getters.byteOffset.call(value),buffer=getters.buffer.call(value);
  need(size>0&&size<=MAX_RECEIPT_SOAP_BYTES&&!(typeof SharedArrayBuffer!=='undefined'&&buffer instanceof SharedArrayBuffer),'SOAP_RECEIPT_BYTES_INVALID');
  return Uint8Array.from(new Uint8Array(buffer,offset,size));
 }catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_BYTES_INVALID');}
}
function parse(xml){try{return parseStrict(xml);}catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_XML_INVALID');}}
function exact(node,name,ns){need(node?.localName===name&&node.namespaceURI===ns,'SOAP_RECEIPT_STRUCTURE_INVALID');}
function attrs(node){for(const a of Array.from(node.attributes??[]))need(a.namespaceURI===XMLNS,'SOAP_RECEIPT_ATTRIBUTE_UNSUPPORTED');}
function whitespace(node){need(Array.from(node.childNodes??[]).every(n=>n.nodeType!==3||!n.data.trim()),'SOAP_RECEIPT_MIXED_CONTENT');}
function context(handle){const value=requests.get(handle);need(value,'SOAP_RECEIPT_REQUEST_UNATTESTED');return value;}
/** Metadata for the exact observed model; neither model borrows the other's pin or endpoint. */
export function reviewedReceiptBinding(model){need(model==='55'||model==='65','SOAP_RECEIPT_MODEL_UNSUPPORTED');return BINDINGS[model];}
/** Exact-byte match only. Does not download, follow imports or authorize the operation. */
export function verifyReviewedReceiptWsdl(input){
 const v=fields(input,['model','wsdlBytes']),binding=reviewedReceiptBinding(v.model),bytes=copy(v.wsdlBytes);
 try{need(bytes.length===binding.source.sizeBytes&&hash(bytes)===binding.source.sha256,'SOAP_RECEIPT_WSDL_MISMATCH');return binding;}
 finally{bytes.fill(0);}
}
/** The core handle is attested before any property is read. No arbitrary XML, URL or action input. */
export function prepareReviewedReceiptSoap(input){
 const v=fields(input,['request']);let payload;
 try{
  try{payload=receiptRequestBytes(v.request);}catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_SOURCE_UNATTESTED');}
  const source=v.request,binding=reviewedReceiptBinding(source.model);
  need(source.environment==='2'&&payload.length===source.sizeBytes&&hash(payload)===source.requestHash,'SOAP_RECEIPT_CONTEXT_MISMATCH');
  const xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);
  // Each root explicitly resets its namespace; no unreviewed SOAP headers.
  const envelope=`<Envelope xmlns="${SOAP}"><Body><nfeDadosMsg xmlns="${binding.serviceNamespace}">${xml}</nfeDadosMsg></Body></Envelope>`;
  const size=Buffer.byteLength(envelope);need(size<=MAX_RECEIPT_SOAP_BYTES,'SOAP_RECEIPT_SIZE_LIMIT');
  const contentType=`application/soap+xml; charset=utf-8; action="${binding.soapAction}"`;
  const handle=Object.freeze({profile:binding.profile,binding,model:source.model,environment:'2',operation:'receipt',
   method:'POST',endpoint:binding.endpoint,contentType,soapAction:binding.soapAction,headers:Object.freeze({'Content-Type':contentType}),
   signedHash:source.signedHash,batchId:source.batchId,authorizationCommandId:source.commandId,sourceEvidenceHash:source.sourceEvidenceHash,payloadHash:source.requestHash,payloadSizeBytes:payload.length,
   envelopeHash:hash(envelope),envelopeSizeBytes:size,...RECEIPT_SOAP_FLAGS});
  requests.set(handle,Object.freeze({source,binding,envelope}));return handle;
 }finally{payload?.fill(0);}
}
/** Each call returns owned bytes; modifying the caller's copy cannot change a prepared request. */
export function encodeReviewedReceiptSoap(handle){return new TextEncoder().encode(context(handle).envelope);}
/** Extracts one contextual declaration. XSD, actual TLS origin and grant remain independent. */
export function extractReviewedReceiptSoap(input){
 const v=fields(input,['request','envelopeBytes']),ctx=context(v.request),binding=ctx.binding,bytes=copy(v.envelopeBytes);
 try{
  let xml;try{xml=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_ENCODING_INVALID');}
  const doc=parse(xml),root=doc.documentElement;exact(root,'Envelope',SOAP);attrs(root);whitespace(root);
  const all=[root,...Array.from(root.getElementsByTagName('*'))],parts=elements(root);
  need(parts.length===1||parts.length===2,'SOAP_RECEIPT_STRUCTURE_INVALID');
  if(parts.length===2){exact(parts[0],'Header',SOAP);attrs(parts[0]);whitespace(parts[0]);need(elements(parts[0]).length===0,'SOAP_RECEIPT_HEADER_UNSUPPORTED');}
  const body=parts.at(-1);exact(body,'Body',SOAP);attrs(body);whitespace(body);
  need(all.filter(n=>n.localName==='Envelope').length===1&&all.filter(n=>n.localName==='Body').length===1&&all.filter(n=>n.localName==='Header').length===parts.length-1,'SOAP_RECEIPT_WRAPPING_REJECTED');
  need(!all.some(n=>n.localName==='Fault'),'SOAP_RECEIPT_FAULT');
  const values=elements(body);need(values.length===1,'SOAP_RECEIPT_RESULT_AMBIGUOUS');
  const result=values[0];exact(result,'nfeResultMsg',binding.serviceNamespace);attrs(result);whitespace(result);
  need(all.filter(n=>n.localName==='nfeResultMsg').length===1,'SOAP_RECEIPT_RESULT_AMBIGUOUS');
  const values2=elements(result);need(values2.length===1,'SOAP_RECEIPT_PAYLOAD_AMBIGUOUS');
  const payload=values2[0];exact(payload,'retConsReciNFe',NFE);
  need(all.filter(n=>n.localName==='retConsReciNFe').length===1,'SOAP_RECEIPT_PAYLOAD_AMBIGUOUS');
  let payloadXml;try{payloadXml=serialize(payload);}catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_XML_INVALID');}
  const payloadBytes=Buffer.from(payloadXml);let response;
  try{response=parseReceiptResponse({request:ctx.source,responseBytes:payloadBytes});}
  catch{throw new ReceiptSoapBindingError('SOAP_RECEIPT_PAYLOAD_INVALID');}
  finally{payloadBytes.fill(0);}
  return Object.freeze({profile:binding.profile,binding,model:ctx.source.model,environment:'2',
   envelopeHash:hash(bytes),envelopeSizeBytes:bytes.length,payloadXml,payloadHash:hash(payloadXml),payloadSizeBytes:Buffer.byteLength(payloadXml),
   response,...RECEIPT_SOAP_FLAGS});
 }finally{bytes.fill(0);}
}
