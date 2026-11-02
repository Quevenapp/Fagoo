/** Local, pinned homologation candidate. No certificate trust, XSD or SEFAZ claim. */
import {createHash} from 'node:crypto';
import {signerMaterial} from './certificate.mjs';
import {signNfeXml,verifyNfeXml} from './signature.mjs';
import {addNfceOnlineSupplement} from './nfce-supplement.mjs';
import {NFCE_SP_HOMOLOGATION_QR_V3} from './nfce-profile.mjs';
import {inspectNfe} from './xml.mjs';
import {DS,MAX_XML_BYTES,need,safeError,sha256} from './common.mjs';

const KEYS=['xml','signer','expectedIssuerCnpj','expectedModel','expectedUnsignedHash','expectedCertificateFingerprint','now'];
const HASH=/^[a-f0-9]{64}$/;

/** The caller owns the opaque signer and must dispose it after its authorized use. */
export function createSignedHomologationCandidate(options){
 try{
  need(options!==null&&typeof options==='object'&&!Array.isArray(options)
   &&Reflect.ownKeys(options).length===KEYS.length&&KEYS.every(key=>Object.hasOwn(options,key)
    &&Object.hasOwn(Object.getOwnPropertyDescriptor(options,key),'value')),'SIGNED_CANDIDATE_INPUT_INVALID');
  const {xml,signer,expectedIssuerCnpj,expectedModel,expectedUnsignedHash,expectedCertificateFingerprint,now}=options;
  need(['55','65'].includes(expectedModel)&&typeof expectedUnsignedHash==='string'&&HASH.test(expectedUnsignedHash)
   &&typeof expectedCertificateFingerprint==='string'&&HASH.test(expectedCertificateFingerprint),'SIGNED_CANDIDATE_INPUT_INVALID');
  need(now instanceof Date,'CERTIFICATE_CLOCK_INVALID');
  const milliseconds=Date.prototype.getTime.call(now);need(Number.isFinite(milliseconds),'CERTIFICATE_CLOCK_INVALID');
  // Capture one instant for all local validity checks; never let later reads choose another time.
  const clock=new Date(milliseconds);
  need(typeof xml==='string'&&Buffer.byteLength(xml,'utf8')>0&&Buffer.byteLength(xml,'utf8')<=MAX_XML_BYTES,'XML_SIZE_INVALID');
  need(sha256(xml)===expectedUnsignedHash,'XML_UNSIGNED_HASH_MISMATCH');
  const unsigned=inspectNfe(xml);
  need(unsigned.identity.model===expectedModel,'XML_MODEL_MISMATCH');
  const material=signerMaterial(signer,clock),fingerprint=sha256(material.certificateDer);
  need(fingerprint===expectedCertificateFingerprint,'XML_CERTIFICATE_PIN_MISMATCH');
  const trust={expectedCertificate:material.certificatePem,expectedHolderCnpj:material.expectedHolderCnpj,expectedIssuerCnpj,now:clock};
  const signed=signNfeXml({xml,signer,expectedIssuerCnpj,now:clock});
  const qrProfile=expectedModel==='65'?NFCE_SP_HOMOLOGATION_QR_V3:null;
  const signedXml=qrProfile===null?signed.signedXml:addNfceOnlineSupplement({xml:signed.signedXml,profile:qrProfile,...trust}).signedXml;
  const sizeBytes=Buffer.byteLength(signedXml,'utf8');need(sizeBytes>0&&sizeBytes<=MAX_XML_BYTES,'XML_SIZE_INVALID');
  // Verify the whole final candidate, including independently checked NFC-e supplement.
  const verified=verifyNfeXml({xml:signedXml,...trust,...(qrProfile===null?{}:{nfceQrProfile:qrProfile})});
  need(verified.signatureVerified===true&&verified.signedContentDigest===signed.verification.signedContentDigest,'XML_AUTHENTICATED_REFERENCE_MISMATCH');
  need(verified.identity.model===expectedModel,'XML_MODEL_MISMATCH');
  need(verified.certificate.fingerprint256===expectedCertificateFingerprint,'XML_CERTIFICATE_PIN_MISMATCH');
  const referenceDigest=createHash('sha1').update(verified.authenticatedInfNfe,'utf8').digest('base64');
  // DigestValue is checked against the authenticated canonical reference, not trusted by extraction.
  const final=inspectNfe(signedXml,{signed:true,expectedCertificateDer:material.certificateDer,...(qrProfile===null?{}:{nfceQrProfile:qrProfile})});
  const values=final.signature.getElementsByTagNameNS(DS,'DigestValue');
  need(values.length===1&&values[0].textContent===referenceDigest,'XML_AUTHENTICATED_REFERENCE_MISMATCH');
  return Object.freeze({signedXml,xmlDigest:verified.xmlDigest,signedContentDigest:verified.signedContentDigest,referenceDigest,
   certificateFingerprint:fingerprint,model:expectedModel,sizeBytes,signatureVerified:true,qrProfile,
   xsdValidated:false,taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,sefazAuthorized:false,canEmit:false,canTransmit:false});
 }catch(error){throw safeError(error,'SIGNED_CANDIDATE_FAILED');}
}
