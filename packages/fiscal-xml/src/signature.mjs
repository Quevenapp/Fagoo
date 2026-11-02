import { X509Certificate } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { isValidCnpj } from '../../fiscal-core/src/identity.mjs';
import { inspectCertificate, signerMaterial } from './certificate.mjs';
import { inspectNfe, serialize } from './xml.mjs';
import { C14N, ENVELOPED, NS, RSA_SHA1, SHA1, need, safeError, sha256 } from './common.mjs';
import { expectedNfceSupplement } from './nfce-profile.mjs';

const rootXPath = `/*[local-name()='NFe' and namespace-uri()='${NS}']`;
const infXPath = rootXPath + `/*[local-name()='infNFe' and namespace-uri()='${NS}']`;
function issuerPolicy(identity,expectedIssuerCnpj,holderCnpj) {
  need(isValidCnpj(expectedIssuerCnpj) && identity.cnpj === expectedIssuerCnpj,'XML_EXPECTED_ISSUER_MISMATCH');
  need(identity.cnpj.slice(0,8) === holderCnpj.slice(0,8),'CERTIFICATE_ISSUER_BASE_MISMATCH');
}
const limits = Object.freeze({xsdValidated:false,taxRulesValidated:false,icpBrasilChainValidated:false,revocationChecked:false,sefazAuthorized:false,canTransmit:false});

/** Verify with an externally pinned certificate; never derive trust from candidate KeyInfo. */
export function verifyNfeXml({xml,expectedCertificate,expectedHolderCnpj,expectedIssuerCnpj,nfceQrProfile,now = new Date()} = {}) {
  try {
    const metadata = inspectCertificate(expectedCertificate,{expectedHolderCnpj,now});
    const native = new X509Certificate(expectedCertificate);
    const candidate = inspectNfe(xml,{signed:true,expectedCertificateDer:native.raw,nfceQrProfile});
    issuerPolicy(candidate.identity,expectedIssuerCnpj,metadata.holderCnpj);
    // Id is a built-in xml-crypto attribute. Adding it again duplicates lookup entries in 6.4.0.
    const verifier = new SignedXml({publicCert:native.toString(),getCertFromKeyInfo:() => null});
    verifier.loadSignature(serialize(candidate.signature));
    need(verifier.checkSignature(xml),'XML_SIGNATURE_INVALID');
    const references = verifier.getSignedReferences();
    need(references.length === 1,'XML_SIGNED_REFERENCE_COUNT_INVALID');
    // Only reparse and return authenticated content from the verifier, not candidate business nodes.
    const authenticated = inspectNfe(`<NFe xmlns="${NS}">${references[0]}</NFe>`);
    need(authenticated.id === candidate.id,'XML_AUTHENTICATED_REFERENCE_MISMATCH');
    issuerPolicy(authenticated.identity,expectedIssuerCnpj,metadata.holderCnpj);
    // Supplement is outside infNFe's signature. Return only independently derived values,
    // after its exact match was checked and its identity was authenticated above.
    const supplement = nfceQrProfile === undefined ? null : expectedNfceSupplement(authenticated.identity,nfceQrProfile);
    return Object.freeze({signatureVerified:true,authenticatedInfNfe:references[0],accessKey:authenticated.accessKey,
      identity:Object.freeze({...authenticated.identity}),certificate:metadata,supplement,xmlDigest:sha256(xml),signedContentDigest:sha256(references[0]),...limits});
  } catch(error) { throw safeError(error,'XML_SIGNATURE_INVALID'); }
}

/** Offline homologation only: no XML generation, no network and no tax/XSD attestation. */
export function signNfeXml({xml,signer,expectedIssuerCnpj,now = new Date()} = {}) {
  try {
    const material = signerMaterial(signer,now), parsed = inspectNfe(xml);
    issuerPolicy(parsed.identity,expectedIssuerCnpj,material.expectedHolderCnpj);
    const signature = new SignedXml({privateKey:material.key,publicCert:material.certificatePem,
      signatureAlgorithm:RSA_SHA1,canonicalizationAlgorithm:C14N});
    signature.addReference({xpath:infXPath,transforms:[ENVELOPED,C14N],digestAlgorithm:SHA1});
    signature.computeSignature(xml,{location:{reference:rootXPath,action:'append'}});
    const signedXml = signature.getSignedXml();
    const verification = verifyNfeXml({xml:signedXml,expectedCertificate:material.certificatePem,
      expectedHolderCnpj:material.expectedHolderCnpj,expectedIssuerCnpj,now});
    return Object.freeze({signedXml,verification,...limits});
  } catch(error) { throw safeError(error,'XML_SIGNING_FAILED'); }
}
