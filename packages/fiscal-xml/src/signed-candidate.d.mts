export interface SignedHomologationCandidateInput {
 xml:string;
 /** Opaque handle returned by createSigner/loadPfxSigner; a copied handle is invalid. */
 signer:object;
 expectedIssuerCnpj:string;
 expectedModel:'55'|'65';
 expectedUnsignedHash:string;
 expectedCertificateFingerprint:string;
 /** One explicit, captured clock instant. The helper does not choose a default. */
 now:Date;
}
export interface SignedHomologationCandidate {
 readonly signedXml:string;
 /** SHA-256 of the exact final UTF-8 XML bytes. */
 readonly xmlDigest:string;
 /** SHA-256 of the authenticated infNFe reference, distinct from XMLDSig's SHA-1 field. */
 readonly signedContentDigest:string;
 /** SHA-1 Base64 of that authenticated reference, matched to the signed DigestValue. */
 readonly referenceDigest:string;
 readonly certificateFingerprint:string;
 readonly model:'55'|'65';
 readonly sizeBytes:number;
 readonly signatureVerified:true;
 readonly qrProfile:'sp-homologation-online-qr-v3'|null;
 readonly xsdValidated:false;
 readonly taxRulesValidated:false;
 readonly icpBrasilChainValidated:false;
 readonly revocationChecked:false;
 readonly sefazAuthorized:false;
 readonly canEmit:false;
 readonly canTransmit:false;
}
export function createSignedHomologationCandidate(input:SignedHomologationCandidateInput):SignedHomologationCandidate;
