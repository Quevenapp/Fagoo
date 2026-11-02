import { X509Certificate, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import * as asn1js from 'asn1js';
import { BasicConstraints, Certificate } from 'pkijs';
import { isValidCnpj } from '../../fiscal-core/src/identity.mjs';
import { need, safeError, sha256 } from './common.mjs';

const signerSecrets = new WeakMap();
const CNPJ_OID = '2.16.76.1.3.3';
export function boundedAsn1(bytes) {
  const decoded = asn1js.fromBER(bytes,{maxDepth:24,maxNodes:4000});
  need(decoded.offset === bytes.byteLength,'CERTIFICATE_ASN1_INVALID'); return decoded.result;
}
function parseCertificate(input) {
  if (typeof input === 'string') need(/^\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END CERTIFICATE-----\s*$/.test(input) && input.length <= 50000,'CERTIFICATE_PEM_INVALID');
  else need(input instanceof Uint8Array && input.byteLength <= 32768,'CERTIFICATE_INPUT_INVALID');
  const native = new X509Certificate(input);
  const certificate = new Certificate({schema:boundedAsn1(native.raw)});
  const extensions = certificate.extensions ?? [];
  need(new Set(extensions.map(extension => extension.extnID)).size === extensions.length,'CERTIFICATE_DUPLICATE_EXTENSION');
  const san = extensions.find(extension => extension.extnID === '2.5.29.17');
  need(san,'CERTIFICATE_CNPJ_MISSING');
  const decoded = boundedAsn1(san.extnValue.valueBlock.valueHexView);
  need(decoded instanceof asn1js.Sequence,'CERTIFICATE_SAN_INVALID');
  const values = [];
  for (const name of decoded.valueBlock.value) {
    if (name.idBlock.tagClass !== 3 || name.idBlock.tagNumber !== 0) continue;
    const children = name.valueBlock.value;
    need(Array.isArray(children) && children.length === 2 && children[0] instanceof asn1js.ObjectIdentifier,'CERTIFICATE_SAN_INVALID');
    if (children[0].valueBlock.toString() !== CNPJ_OID) continue;
    const value = children[1];
    need(value.idBlock.tagClass === 3 && value.idBlock.tagNumber === 0 && value.valueBlock.value?.length === 1,'CERTIFICATE_CNPJ_INVALID');
    const string = value.valueBlock.value[0];
    if (string instanceof asn1js.Utf8String || string instanceof asn1js.PrintableString || string instanceof asn1js.IA5String) values.push(string.valueBlock.value);
    else if (string instanceof asn1js.OctetString && !string.idBlock.isConstructed) values.push(new TextDecoder('utf-8',{fatal:true}).decode(string.valueBlock.valueHexView));
    else need(false,'CERTIFICATE_CNPJ_ENCODING_UNSUPPORTED');
  }
  need(values.length === 1 && isValidCnpj(values[0]),'CERTIFICATE_CNPJ_INVALID');
  const usage = extensions.find(extension => extension.extnID === '2.5.29.15');
  need(usage,'CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED');
  const bits = boundedAsn1(usage.extnValue.valueBlock.valueHexView);
  need(bits instanceof asn1js.BitString && (bits.valueBlock.valueHexView[0] & 0x80) !== 0,'CERTIFICATE_DIGITAL_SIGNATURE_USAGE_REQUIRED');
  const basic = extensions.find(extension => extension.extnID === '2.5.29.19');
  need(!native.ca && (!basic || new BasicConstraints({schema:boundedAsn1(basic.extnValue.valueBlock.valueHexView)}).cA !== true),'CERTIFICATE_CA_NOT_ALLOWED');
  need(native.publicKey.asymmetricKeyType === 'rsa' && native.publicKey.asymmetricKeyDetails.modulusLength >= 2048 && native.publicKey.asymmetricKeyDetails.modulusLength <= 4096,'CERTIFICATE_RSA_KEY_UNSUPPORTED');
  return { native,holderCnpj:values[0] };
}

export function inspectCertificate(certificateInput,{expectedHolderCnpj,now = new Date()} = {}) {
  try {
    need(isValidCnpj(expectedHolderCnpj),'CERTIFICATE_EXPECTED_HOLDER_REQUIRED');
    const {native,holderCnpj} = parseCertificate(certificateInput);
    need(holderCnpj === expectedHolderCnpj,'CERTIFICATE_HOLDER_MISMATCH');
    need(now instanceof Date && Number.isFinite(now.getTime()),'CERTIFICATE_CLOCK_INVALID');
    need(now.getTime() >= native.validFromDate.getTime() && now.getTime() <= native.validToDate.getTime(),'CERTIFICATE_NOT_CURRENTLY_VALID');
    return Object.freeze({ holderCnpj,subject:native.subject,issuer:native.issuer,serialNumber:native.serialNumber,
      notBefore:native.validFromDate.toISOString(),notAfter:native.validToDate.toISOString(),fingerprint256:sha256(native.raw),
      rsaBits:native.publicKey.asymmetricKeyDetails.modulusLength,metadataChecked:true,chainTrusted:false,revocationChecked:false,typeA1Attested:false });
  } catch (error) { throw safeError(error,'CERTIFICATE_INVALID'); }
}

/** Keeps native private-key material behind an opaque, disposable in-memory handle. */
export function createSigner({ privateKey,certificate,expectedHolderCnpj,now = new Date(),purpose } = {}) {
  try {
    need(purpose === 'offline-homologation','SIGNER_PRODUCTION_UNAVAILABLE');
    const metadata = inspectCertificate(certificate,{expectedHolderCnpj,now});
    const native = new X509Certificate(certificate);
    const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    need(key.type === 'private' && key.asymmetricKeyType === 'rsa','PRIVATE_KEY_TYPE_UNSUPPORTED');
    need(createPublicKey(key).export({type:'spki',format:'der'}).equals(native.publicKey.export({type:'spki',format:'der'})),'PRIVATE_KEY_CERTIFICATE_MISMATCH');
    const handle = Object.freeze({purpose,certificate:metadata});
    signerSecrets.set(handle,{key,certificatePem:native.toString(),certificateDer:Buffer.from(native.raw),expectedHolderCnpj});
    return handle;
  } catch(error) { throw safeError(error,'SIGNER_CREDENTIALS_INVALID'); }
}
export function signerMaterial(handle,now) {
  const material = signerSecrets.get(handle); need(material,'SIGNER_HANDLE_INVALID_OR_DISPOSED');
  inspectCertificate(material.certificatePem,{expectedHolderCnpj:material.expectedHolderCnpj,now});
  return material;
}
export function disposeSigner(handle) { return signerSecrets.delete(handle); }
