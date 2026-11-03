import { createPrivateKey, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import { AuthenticatedSafe, Certificate, CryptoEngine, EncryptedData, PFX, PBES2Params, PBKDF2Params, SafeContents } from 'pkijs';
import { boundedAsn1, createSigner } from './certificate.mjs';
import { need, safeError } from './common.mjs';

const engine = new CryptoEngine({name:'brufap-node',crypto:webcrypto,subtle:webcrypto.subtle});
const DATA = '1.2.840.113549.1.7.1', ENCRYPTED = '1.2.840.113549.1.7.6';
function encryptionPolicy(algorithm) {
  need(algorithm.algorithmId === '1.2.840.113549.1.5.13','PFX_ENCRYPTION_UNSUPPORTED');
  const params = new PBES2Params({schema:algorithm.algorithmParams});
  need(params.keyDerivationFunc.algorithmId === '1.2.840.113549.1.5.12','PFX_KDF_UNSUPPORTED');
  const kdf = new PBKDF2Params({schema:params.keyDerivationFunc.algorithmParams});
  need(Number.isSafeInteger(kdf.iterationCount) && kdf.iterationCount >= 1000 && kdf.iterationCount <= 100000,'PFX_KDF_ITERATIONS_UNSUPPORTED');
  need(kdf.salt instanceof asn1js.OctetString && kdf.salt.valueBlock.valueHexView.length >= 8 && kdf.salt.valueBlock.valueHexView.length <= 64,'PFX_KDF_SALT_INVALID');
  need(kdf.prf?.algorithmId === '1.2.840.113549.2.9','PFX_KDF_HASH_UNSUPPORTED');
  need(params.encryptionScheme.algorithmId === '2.16.840.1.101.3.4.1.42','PFX_ENCRYPTION_UNSUPPORTED');
  need(params.encryptionScheme.algorithmParams instanceof asn1js.OctetString && params.encryptionScheme.algorithmParams.valueBlock.valueHexView.length === 16,'PFX_IV_INVALID');
}
/** Restricted PKCS#12: authenticated MAC + PBES2/AES256/PBKDF2-SHA256. No legacy fallback. */
export async function loadPfxSigner({pfxBytes,passwordBytes,expectedHolderCnpj,now = new Date(),purpose} = {}) {
  need(purpose === 'offline-homologation','SIGNER_PRODUCTION_UNAVAILABLE');
  need(pfxBytes instanceof Uint8Array && pfxBytes.byteLength >= 1 && pfxBytes.byteLength <= 131072,'PFX_SIZE_INVALID');
  need(passwordBytes instanceof Uint8Array && passwordBytes.byteLength >= 1 && passwordBytes.byteLength <= 1024,'PFX_PASSWORD_BYTES_REQUIRED');
  const password = Uint8Array.from(passwordBytes), file = Uint8Array.from(pfxBytes), temporary = [];
  try {
    new TextDecoder('utf-8',{fatal:true}).decode(password);
    const pfx = new PFX({schema:boundedAsn1(file)});
    need(pfx.version === 3 && pfx.authSafe.contentType === DATA && pfx.macData,'PFX_INTEGRITY_REQUIRED');
    need(pfx.macData.mac.digestAlgorithm.algorithmId === '2.16.840.1.101.3.4.2.1','PFX_MAC_HASH_UNSUPPORTED');
    need(Number.isSafeInteger(pfx.macData.iterations) && pfx.macData.iterations >= 1000 && pfx.macData.iterations <= 100000,'PFX_KDF_ITERATIONS_UNSUPPORTED');
    const saltLength = pfx.macData.macSalt.valueBlock.valueHexView.length;
    need(saltLength >= 8 && saltLength <= 64,'PFX_KDF_SALT_INVALID');
    // Validate nested ASN.1 resource bounds before the library processes it or runs KDFs.
    const safeBytes = pfx.authSafe.content.getValue(); boundedAsn1(safeBytes);
    await pfx.parseInternalValues({password:password.buffer,checkIntegrity:true},engine);
    const safe = new AuthenticatedSafe({schema:boundedAsn1(safeBytes)});
    need(safe.safeContents.length >= 1 && safe.safeContents.length <= 4,'PFX_CONTENT_COUNT_UNSUPPORTED');
    const keys = [], certs = [];
    let bagCount = 0;
    for (const content of safe.safeContents) {
      let bytes;
      if (content.contentType === DATA) bytes = content.content.getValue();
      else {
        need(content.contentType === ENCRYPTED,'PFX_CONTENT_TYPE_UNSUPPORTED');
        const encrypted = new EncryptedData({schema:content.content});
        encryptionPolicy(encrypted.encryptedContentInfo.contentEncryptionAlgorithm);
        bytes = await encrypted.decrypt({password:password.buffer},engine); temporary.push(new Uint8Array(bytes));
      }
      const bags = new SafeContents({schema:boundedAsn1(bytes)}).safeBags;
      need((bagCount += bags.length) <= 12,'PFX_BAG_COUNT_UNSUPPORTED');
      for (const bag of bags) {
        if (bag.bagId === '1.2.840.113549.1.12.10.1.3') {
          need(bag.bagValue.parsedValue instanceof Certificate,'PFX_CERTIFICATE_TYPE_UNSUPPORTED');
          certs.push(Buffer.from(bag.bagValue.certValue.valueBlock.valueHexView));
        } else {
          need(bag.bagId === '1.2.840.113549.1.12.10.1.2','PFX_UNENCRYPTED_OR_UNKNOWN_KEY_BAG');
          encryptionPolicy(bag.bagValue.encryptionAlgorithm);
          await bag.bagValue.parseInternalValues({password:password.buffer},engine);
          const der = Buffer.from(bag.bagValue.parsedValue.toSchema().toBER(false)); temporary.push(der);
          keys.push(createPrivateKey({key:der,type:'pkcs8',format:'der'}));
        }
      }
    }
    need(keys.length === 1 && certs.length === 1,'PFX_SINGLE_KEY_AND_LEAF_REQUIRED');
    return createSigner({privateKey:keys[0],certificate:certs[0],expectedHolderCnpj,now,purpose});
  } catch(error) { throw safeError(error,'PFX_INVALID_OR_PASSWORD_REJECTED'); }
  finally { password.fill(0); file.fill(0); temporary.forEach(bytes => bytes.fill(0)); }
}
