/** Pure, local homologation candidates. No transport, origin attestation or grant. */
import {createHash, X509Certificate} from 'node:crypto';
import {verifyNfeXml} from '../../fiscal-xml/src/signature.mjs';
import {parseStrict, elements, serialize} from '../../fiscal-xml/src/xml.mjs';
import {NFCE_SP_HOMOLOGATION_QR_V3} from '../../fiscal-xml/src/nfce-profile.mjs';

export const AUTHORIZATION_PROFILE = 'sp-single-homologation-authorization-candidate-v1';
export const MAX_AUTHORIZATION_BYTES = 512000;
export const AUTHORIZATION_FLAGS = Object.freeze({xsdValidated:false,tlsOriginVerified:false,
  taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,
  sefazAuthorized:false,authorizedInHomologation:false,productionAuthorized:false,
  legalFiscalValue:false,canEmit:false,canTransmit:false,retrySubmissionAllowed:false});
export class FiscalAuthorizationError extends Error {
  constructor(code) { super(code); this.name='FiscalAuthorizationError'; this.code=code; }
}
const fail=code=>{throw new FiscalAuthorizationError(code);};
const need=(ok,code)=>{if(!ok)fail(code);};
const NS='http://www.portalfiscal.inf.br/nfe', DS='http://www.w3.org/2000/09/xmldsig#';
const HASH=/^[a-f0-9]{64}$/, requests=new WeakMap(), responses=new WeakMap();
const hash=value=>createHash('sha256').update(value).digest('hex');
const proto=Object.getPrototypeOf(Uint8Array.prototype);
const getters=Object.fromEntries(['byteLength','byteOffset','buffer'].map(k=>[k,Object.getOwnPropertyDescriptor(proto,k).get]));
function fields(value,allowed) {
  try {
    need(value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)), 'AUTHORIZATION_INPUT_INVALID');
    const ds=Object.getOwnPropertyDescriptors(value), keys=Reflect.ownKeys(ds);
    need(keys.length===allowed.length&&keys.every(k=>typeof k==='string'&&allowed.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')), 'AUTHORIZATION_INPUT_INVALID');
    return Object.fromEntries(allowed.map(k=>[k,ds[k].value]));
  } catch { fail('AUTHORIZATION_INPUT_INVALID'); }
}
function copyBytes(value) {
  try {
    need(ArrayBuffer.isView(value)&&value instanceof Uint8Array,'AUTHORIZATION_BYTES_INVALID');
    const n=getters.byteLength.call(value), offset=getters.byteOffset.call(value), buffer=getters.buffer.call(value);
    need(n>0&&n<=MAX_AUTHORIZATION_BYTES&&!(typeof SharedArrayBuffer!=='undefined'&&buffer instanceof SharedArrayBuffer),'AUTHORIZATION_BYTES_INVALID');
    return Uint8Array.from(new Uint8Array(buffer,offset,n));
  } catch { fail('AUTHORIZATION_BYTES_INVALID'); }
}
function textBytes(value) {
  const bytes=copyBytes(value);
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); }
  catch { fail('AUTHORIZATION_ENCODING_INVALID'); }
  finally { bytes.fill(0); }
}
function parse(xml) { try { return parseStrict(xml); } catch { fail('AUTHORIZATION_XML_INVALID'); } }
function attrs(node,allowed=[]) {
  for(const a of Array.from(node.attributes??[])) {
    if(a.namespaceURI==='http://www.w3.org/2000/xmlns/')continue;
    need(!a.namespaceURI&&allowed.includes(a.name),'AUTHORIZATION_STRUCTURE_INVALID');
  }
}
function children(node,allowed,repeated=[]) {
  need(Array.from(node.childNodes).every(n=>n.nodeType!==3||!n.data.trim()),'AUTHORIZATION_STRUCTURE_INVALID');
  const result=elements(node),seen=new Set();
  for(const c of result){need(c.namespaceURI===NS&&!c.prefix&&allowed.includes(c.localName)&&(!seen.has(c.localName)||repeated.includes(c.localName)),'AUTHORIZATION_STRUCTURE_INVALID');seen.add(c.localName);}
  return Object.fromEntries(result.map(c=>[c.localName,c]));
}
function leaf(node,optional=false) {
  if(!node){need(optional,'AUTHORIZATION_STRUCTURE_INVALID');return null;}
  attrs(node);need(elements(node).length===0,'AUTHORIZATION_STRUCTURE_INVALID');return node.textContent;
}
function stamp(v) {
  const m=typeof v==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  need(m&&+m[1]>=2000&&+m[4]<24&&+m[5]<60&&+m[6]<60&&(+m[8]||0)<=14&&(+m[9]||0)<60&&!(+m[8]===14&&+m[9]!==0),'AUTHORIZATION_TIMESTAMP_INVALID');
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  need(d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3],'AUTHORIZATION_TIMESTAMP_INVALID');return v;
}
const code=v=>{need(typeof v==='string'&&/^\d{3,4}$/.test(v),'AUTHORIZATION_STATUS_INVALID');return v;};
function verified(xml,trust,model) {
  try { return verifyNfeXml({xml,...trust,...(model==='65'?{nfceQrProfile:NFCE_SP_HOMOLOGATION_QR_V3}:{})}); }
  catch { fail('AUTHORIZATION_SIGNATURE_INVALID'); }
}
function request(value) { const r=requests.get(value);need(r,'AUTHORIZATION_REQUEST_UNATTESTED');return r; }

/** Use a backend-pinned certificate, including hash/DER-pinned050 extraction; never trust unpinned KeyInfo or browser input. */
export function prepareAuthorization(input) {
  const v=fields(input,['signedBytes','expectedSignedHash','expectedModel','expectedIssuerCnpj','expectedCertificate','expectedHolderCnpj','expectedCertificateFingerprint','now','batchId']);
  need(['55','65'].includes(v.expectedModel)&&typeof v.expectedSignedHash==='string'&&HASH.test(v.expectedSignedHash)
    &&typeof v.expectedCertificateFingerprint==='string'&&HASH.test(v.expectedCertificateFingerprint)
    &&typeof v.expectedCertificate==='string'&&v.expectedCertificate.length<=16384
    &&typeof v.batchId==='string'&&/^[1-9]\d{0,14}$/.test(v.batchId),'AUTHORIZATION_INPUT_INVALID');
  let clock;try{clock=Date.prototype.getTime.call(v.now);}catch{fail('AUTHORIZATION_CLOCK_INVALID');}
  need(Number.isFinite(clock),'AUTHORIZATION_CLOCK_INVALID');
  const xml=textBytes(v.signedBytes);need(hash(xml)===v.expectedSignedHash,'AUTHORIZATION_SIGNED_HASH_MISMATCH');
  let certificate;try{certificate=new X509Certificate(v.expectedCertificate);}catch{fail('AUTHORIZATION_CERTIFICATE_INVALID');}
  need(hash(certificate.raw)===v.expectedCertificateFingerprint,'AUTHORIZATION_CERTIFICATE_MISMATCH');
  const trust=Object.freeze({expectedCertificate:certificate.toString(),expectedHolderCnpj:v.expectedHolderCnpj,expectedIssuerCnpj:v.expectedIssuerCnpj,now:new Date(clock)});
  const proof=verified(xml,trust,v.expectedModel);
  need(proof.identity.model===v.expectedModel&&proof.identity.cUF==='35'&&proof.identity.environment==='2'&&proof.identity.tpEmis==='1'&&Number(proof.identity.series)<=889,'AUTHORIZATION_CONTEXT_MISMATCH');
  const referenceDigest=createHash('sha1').update(proof.authenticatedInfNfe,'utf8').digest('base64');
  // XML declaration is not part of NFe; otherwise keep the original signed subtree bytes.
  const nfe=xml.replace(/^<\?xml version="1\.0"(?: encoding="[Uu][Tt][Ff]-8")?\?>/,'');
  const requestXml=`<enviNFe xmlns="${NS}" versao="4.00"><idLote>${v.batchId}</idLote><indSinc>1</indSinc>${nfe}</enviNFe>`;
  need(Buffer.byteLength(requestXml)<=MAX_AUTHORIZATION_BYTES,'AUTHORIZATION_SIZE_LIMIT');parse(requestXml);
  const handle=Object.freeze({profile:AUTHORIZATION_PROFILE,model:v.expectedModel,environment:'2',batchId:v.batchId,
    accessKey:proof.accessKey,signedHash:v.expectedSignedHash,requestHash:hash(requestXml),sizeBytes:Buffer.byteLength(requestXml),
    referenceDigest,signatureVerified:true,...AUTHORIZATION_FLAGS});
  requests.set(handle,{xml,nfe,requestXml,trust,model:v.expectedModel,accessKey:proof.accessKey,referenceDigest,issuedAt:proof.identity.issuedAt});
  return handle;
}
/** Every call returns a separate owned copy. A clone of the handle is not accepted. */
export function authorizationRequestBytes(handle) { return new TextEncoder().encode(request(handle).requestXml); }

function protocol(node,ctx) {
  attrs(node,['versao']);need(node.getAttribute('versao')==='4.00','AUTHORIZATION_STRUCTURE_INVALID');
  const list=elements(node);need(list.length>=1&&list.length<=2&&list[0].localName==='infProt'&&list[0].namespaceURI===NS
    &&(!list[1]||(list[1].localName==='Signature'&&list[1].namespaceURI===DS)),'AUTHORIZATION_STRUCTURE_INVALID');
  const inf=list[0];attrs(inf,['Id']);
  // cMsg/xMsg may repeat by the official schema. They are not used as proof.
  const p=children(inf,['tpAmb','verAplic','chNFe','dhRecbto','nProt','digVal','cStat','xMotivo','cMsg','xMsg'],['cMsg','xMsg']);
  const messages=elements(inf).filter(n=>['cMsg','xMsg'].includes(n.localName));
  need(messages.length<=10&&messages.length%2===0&&messages.every((n,i)=>n.localName===(i%2?'xMsg':'cMsg')),'AUTHORIZATION_STRUCTURE_INVALID');
  for(const n of messages){const value=leaf(n);need(n.localName==='cMsg'?/^\d{1,4}$/.test(value):value.length>=1&&value.length<=255,'AUTHORIZATION_STRUCTURE_INVALID');}
  need(leaf(p.tpAmb)==='2'&&leaf(p.chNFe)===ctx.accessKey,'AUTHORIZATION_PROTOCOL_CONTEXT_MISMATCH');
  const cStat=code(leaf(p.cStat)), receivedAt=stamp(leaf(p.dhRecbto)), number=leaf(p.nProt,true), digest=leaf(p.digVal,true);
  leaf(p.verAplic);leaf(p.xMotivo);
  if(number!==null)need(/^(?:\d{15}|\d{17})$/.test(number)&&!/^0+$/.test(number),'AUTHORIZATION_PROTOCOL_NUMBER_INVALID');
  if(digest!==null)need(/^[A-Za-z0-9+/]{27}=$/.test(digest)&&Buffer.from(digest,'base64').toString('base64')===digest&&digest===ctx.referenceDigest,'AUTHORIZATION_PROTOCOL_DIGEST_MISMATCH');
  if(['100','150'].includes(cStat))need(number!==null&&digest!==null&&Date.parse(receivedAt)>=Date.parse(ctx.issuedAt),'AUTHORIZATION_PROTOCOL_INCOMPLETE');
  return Object.freeze({cStat,number,receivedAt,referenceDigestMatched:digest!==null});
}

/** Contextual inspection only: even 100/150 is a declaration until TLS and XSD are checked separately. */
export function parseAuthorizationResponse(input) {
  const v=fields(input,['request','responseBytes']),ctx=request(v.request),xml=textBytes(v.responseBytes),root=parse(xml).documentElement;
  need(root.localName==='retEnviNFe'&&root.namespaceURI===NS&&!root.prefix,'AUTHORIZATION_RESPONSE_ROOT_INVALID');
  attrs(root,['versao']);need(root.getAttribute('versao')==='4.00','AUTHORIZATION_STRUCTURE_INVALID');
  const p=children(root,['tpAmb','verAplic','cStat','xMotivo','cUF','dhRecbto','infRec','protNFe']);
  need(leaf(p.tpAmb)==='2'&&leaf(p.cUF)==='35','AUTHORIZATION_CONTEXT_MISMATCH');leaf(p.verAplic);leaf(p.xMotivo);
  const cStat=code(leaf(p.cStat)),receivedAt=stamp(leaf(p.dhRecbto));let receiptNumber=null,prot=null,classification='review_required';
  if(cStat==='103') {
    need(p.infRec&&!p.protNFe,'AUTHORIZATION_BATCH_STRUCTURE_MISMATCH');attrs(p.infRec);
    const r=children(p.infRec,['nRec','tMed']);receiptNumber=leaf(r.nRec);
    need(/^\d{15}$/.test(receiptNumber)&&!/^0+$/.test(receiptNumber)&&/^\d{1,4}$/.test(leaf(r.tMed)),'AUTHORIZATION_RECEIPT_INVALID');classification='receipt_pending';
  } else if(cStat==='104') {
    need(p.protNFe&&!p.infRec,'AUTHORIZATION_BATCH_STRUCTURE_MISMATCH');prot=protocol(p.protNFe,ctx);
    classification=['100','150'].includes(prot.cStat)?'authorization_declared':Number(prot.cStat)<200||['204','539','217'].includes(prot.cStat)?'review_required':'rejected';
  } else {
    need(!p.protNFe&&!p.infRec,'AUTHORIZATION_BATCH_STRUCTURE_MISMATCH');
    if(Number(cStat)>=200&&!['204','539','217'].includes(cStat))classification='rejected';
  }
  const handle=Object.freeze({profile:AUTHORIZATION_PROFILE,model:ctx.model,environment:'2',requestHash:v.request.requestHash,
    responseHash:hash(xml),sizeBytes:Buffer.byteLength(xml),classification,cStat,receivedAt,receiptNumber,protocol:prot,
    signatureVerified:false,...AUTHORIZATION_FLAGS});
  responses.set(handle,{request:v.request,xml,protocolXml:p.protNFe?serialize(p.protNFe):null});return handle;
}

/** Produces only a candidate nfeProc, retaining the exact signed NFe and a bound protocol. */
export function composeProcessedNfe(input) {
  const v=fields(input,['request','response']),ctx=request(v.request),res=responses.get(v.response);
  need(res&&res.request===v.request,'AUTHORIZATION_RESPONSE_UNATTESTED');
  need(v.response.classification==='authorization_declared'&&res.protocolXml,'AUTHORIZATION_PROTOCOL_NOT_AUTHORIZED_DECLARATION');
  const xml=`<nfeProc xmlns="${NS}" versao="4.00">${ctx.nfe}${res.protocolXml}</nfeProc>`;
  need(Buffer.byteLength(xml)<=MAX_AUTHORIZATION_BYTES,'AUTHORIZATION_SIZE_LIMIT');
  const root=parse(xml).documentElement,parts=elements(root);
  need(parts.length===2&&parts[0].localName==='NFe'&&parts[1].localName==='protNFe','AUTHORIZATION_STRUCTURE_INVALID');
  // The wrapper supplies only the same default namespace: no extra namespace/xml:*
  // can change inclusive C14N. Verification is repeated on the included subtree.
  const proof=verified(serialize(parts[0]),ctx.trust,ctx.model);
  need(proof.accessKey===ctx.accessKey&&createHash('sha1').update(proof.authenticatedInfNfe,'utf8').digest('base64')===ctx.referenceDigest,'AUTHORIZATION_PROCESSED_SIGNATURE_MISMATCH');
  protocol(parts[1],ctx);
  return Object.freeze({profile:AUTHORIZATION_PROFILE,processedXml:xml,processedHash:hash(xml),sizeBytes:Buffer.byteLength(xml),
    signedHash:v.request.signedHash,requestHash:v.request.requestHash,responseHash:v.response.responseHash,referenceDigest:ctx.referenceDigest,
    model:ctx.model,environment:'2',protocol:v.response.protocol,signatureVerified:true,...AUTHORIZATION_FLAGS});
}

/** Local verification for a separately attested protocol consumer. Never exposes captured trust.
 * This narrow form retains the original signed subtree verbatim, including the NFC-e supplement.
 * It does not attest where the protocol came from, its XSD, TLS or fiscal authorization. */
export function verifyProcessedAuthorization(input) {
  const v=fields(input,['request','processedBytes']),ctx=request(v.request);
  const xml=textBytes(v.processedBytes),root=parse(xml).documentElement;
  need(root.localName==='nfeProc'&&root.namespaceURI===NS&&!root.prefix,'AUTHORIZATION_PROCESSED_ROOT_INVALID');
  const attributes=Array.from(root.attributes??[]);
  need(attributes.length===2&&attributes.some(a=>a.name==='xmlns'&&a.namespaceURI==='http://www.w3.org/2000/xmlns/'&&a.value===NS)
    &&attributes.some(a=>a.name==='versao'&&!a.namespaceURI&&a.value==='4.00'),'AUTHORIZATION_PROCESSED_ATTRIBUTE_INVALID');
  const parts=children(root,['NFe','protNFe']);
  need(elements(root).length===2&&elements(root)[0]===parts.NFe&&elements(root)[1]===parts.protNFe,'AUTHORIZATION_STRUCTURE_INVALID');
  // Deliberately a local composition format, not a generic archive XML reader.
  need(xml.startsWith(`<nfeProc xmlns="${NS}" versao="4.00">${ctx.nfe}`)&&xml.endsWith('</nfeProc>'),'AUTHORIZATION_PROCESSED_SOURCE_MISMATCH');
  const proof=verified(serialize(parts.NFe),ctx.trust,ctx.model);
  need(proof.accessKey===ctx.accessKey&&createHash('sha1').update(proof.authenticatedInfNfe,'utf8').digest('base64')===ctx.referenceDigest,'AUTHORIZATION_PROCESSED_SIGNATURE_MISMATCH');
  const prot=protocol(parts.protNFe,ctx);
  need(['100','150'].includes(prot.cStat)&&prot.referenceDigestMatched,'AUTHORIZATION_PROTOCOL_NOT_AUTHORIZED_DECLARATION');
  return Object.freeze({profile:AUTHORIZATION_PROFILE,model:ctx.model,environment:'2',signedHash:v.request.signedHash,
    requestHash:v.request.requestHash,processedHash:hash(xml),sizeBytes:Buffer.byteLength(xml),referenceDigest:ctx.referenceDigest,
    protocol:prot,signatureVerified:true,contextMatched:true,...AUTHORIZATION_FLAGS});
}

/** A configured endpoint is not a reviewed WSDL binding, permission or transport. */
export function authorizationBindingStatus(model) {
  need(['55','65'].includes(model),'AUTHORIZATION_INPUT_INVALID');
  return Object.freeze({model,environment:'2',operation:'authorization',status:'reviewed_wsdl_required',
    bindingReviewed:false,bindingVerified:false,operationAuthorized:false,canTransmit:false});
}
