/** Backend only. Public certificate extraction is permitted only after both authenticated050 pins match. */
import {X509Certificate,createHash} from 'node:crypto';
import {parseStrict,elements} from '../../fiscal-xml/src/xml.mjs';
import {verifyNfeXml} from '../../fiscal-xml/src/signature.mjs';
import {NFCE_SP_HOMOLOGATION_QR_V3} from '../../fiscal-xml/src/nfce-profile.mjs';
import {AuthorizationServiceError,data,need,copy,sha,integer,hash,freeze} from './service-common.mjs';
const NS='http://www.portalfiscal.inf.br/nfe',DS='http://www.w3.org/2000/09/xmldsig#';
const bad=()=>{throw new AuthorizationServiceError('AUTHORIZATION_PINNED_CERTIFICATE_INVALID');};
function one(parent,name,namespace=DS){const list=elements(parent).filter(x=>x.localName===name&&x.namespaceURI===namespace);if(list.length!==1)bad();return list[0];}
function exactChildren(node,names){if(elements(node).map(x=>x.namespaceURI+':'+x.localName).join('|')!==names.map(x=>DS+':'+x).join('|')||Array.from(node.childNodes).some(x=>x.nodeType===3&&x.data.trim()))bad();}
/** The caller supplies only backend050 hash/size/fingerprint/model and a captured validation time. */
export function pinnedCandidateCertificate(input){
 const v=data(input,['signedBytes','signedHash','signedSize','certificateFingerprint','model','now']);
 need(sha(v.signedHash)&&sha(v.certificateFingerprint)&&integer(v.signedSize,512000)&&['55','65'].includes(v.model));
 let instant;try{instant=Date.prototype.getTime.call(v.now);}catch{bad();}need(Number.isFinite(instant),'AUTHORIZATION_PINNED_CERTIFICATE_INVALID');
 const bytes=copy(v.signedBytes);
 try{
  need(bytes.length===v.signedSize&&hash(bytes)===v.signedHash,'AUTHORIZATION_SIGNED_ARTIFACT_MISMATCH');
  let xml,doc,cert;try{
   xml=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);doc=parseStrict(xml);
   const root=doc.documentElement;if(root.localName!=='NFe'||root.namespaceURI!==NS||root.prefix)bad();
   const signature=one(root,'Signature'),key=one(signature,'KeyInfo'),chain=one(key,'X509Data'),leaf=one(chain,'X509Certificate');
   exactChildren(key,['X509Data']);exactChildren(chain,['X509Certificate']);if(elements(leaf).length)bad();
   // Reject alternate/embedded key sources anywhere, even before full signature validation.
   const allowed=new Map([['Signature',signature],['KeyInfo',key],['X509Data',chain],['X509Certificate',leaf]]);
   for(const n of Array.from(doc.getElementsByTagName('*'))){if(allowed.has(n.localName)&&n!==allowed.get(n.localName))bad();if(['KeyValue','RSAKeyValue','RetrievalMethod'].includes(n.localName))bad();}
   const encoded=leaf.textContent;if(encoded.length<1||encoded.length>22000||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))bad();
   const der=Buffer.from(encoded,'base64');if(der.length>16384||der.toString('base64')!==encoded||hash(der)!==v.certificateFingerprint)bad();
   cert=new X509Certificate(der);if(!cert.raw.equals(der))bad();
   const inf=one(root,'infNFe',NS),issuer=one(one(inf,'emit',NS),'CNPJ',NS).textContent;
   const proof=verifyNfeXml({xml,expectedCertificate:cert.toString(),expectedIssuerCnpj:issuer,expectedHolderCnpj:issuer,now:new Date(instant),...(v.model==='65'?{nfceQrProfile:NFCE_SP_HOMOLOGATION_QR_V3}:{})});
   if(proof.identity.model!==v.model||proof.identity.environment!=='2'||proof.identity.cUF!=='35'||proof.identity.tpEmis!=='1')bad();
   return freeze({private_executor_only:true,certificate:cert.toString(),certificateFingerprint:v.certificateFingerprint,issuerCnpj:issuer,model:v.model,
    accessKey:proof.accessKey,referenceDigest:createHash('sha1').update(proof.authenticatedInfNfe,'utf8').digest('base64'),issuedAt:proof.identity.issuedAt,signatureVerified:true});
  }catch(e){if(e instanceof AuthorizationServiceError)throw e;bad();}
 }finally{bytes.fill(0);}
}
