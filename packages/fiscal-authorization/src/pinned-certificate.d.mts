/** Backend-only public material. Do not serialize certificate/issuer/access key into HTTP outputs. */
export function pinnedCandidateCertificate(input:{signedBytes:Uint8Array;signedHash:string;signedSize:number;certificateFingerprint:string;model:'55'|'65';now:Date}):Readonly<{
 private_executor_only:true;certificate:string;certificateFingerprint:string;issuerCnpj:string;model:'55'|'65';accessKey:string;referenceDigest:string;issuedAt:string;signatureVerified:true;
}>;
