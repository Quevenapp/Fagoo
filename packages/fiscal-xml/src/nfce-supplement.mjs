import { NS, need, safeError } from './common.mjs';
import { expectedNfceSupplement } from './nfce-profile.mjs';
import { verifyNfeXml } from './signature.mjs';
import { parseStrict, serialize } from './xml.mjs';

/** Add the unsigned supplement only to an already verified NFC-e; no transmission. */
export function addNfceOnlineSupplement({xml,profile,expectedCertificate,expectedHolderCnpj,expectedIssuerCnpj,now = new Date()} = {}) {
  try {
    const trust = {expectedCertificate,expectedHolderCnpj,expectedIssuerCnpj,now};
    const before = verifyNfeXml({xml,...trust});
    const supplement = expectedNfceSupplement(before.identity,profile);
    const doc = parseStrict(xml), root = doc.documentElement;
    const group = doc.createElementNS(NS,'infNFeSupl');
    for (const name of ['qrCode','urlChave']) {
      const field = doc.createElementNS(NS,name);
      field.appendChild(doc.createTextNode(supplement[name])); group.appendChild(field);
    }
    root.insertBefore(group,root.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','Signature')[0]);
    const signedXml = serialize(doc);
    // Verify the actual final XML, not a stripped copy of it.
    const verification = verifyNfeXml({xml:signedXml,nfceQrProfile:profile,...trust});
    need(verification.signedContentDigest === before.signedContentDigest,'XML_AUTHENTICATED_REFERENCE_MISMATCH');
    return Object.freeze({signedXml,verification,supplement,...Object.fromEntries(
      ['xsdValidated','taxRulesValidated','icpBrasilChainValidated','revocationChecked','sefazAuthorized','canTransmit'].map(name => [name,false]))});
  } catch(error) { throw safeError(error,'NFCE_SUPPLEMENT_FAILED'); }
}
