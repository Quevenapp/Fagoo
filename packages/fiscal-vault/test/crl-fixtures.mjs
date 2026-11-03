import { createRequire } from 'node:module';
import { createHash, webcrypto, X509Certificate, sign, constants } from 'node:crypto';
import { engine } from '../../fiscal-xml/test/fixtures.mjs';
import { trustFixture, NOW } from './trust-fixtures.mjs';
const require = createRequire(new URL('../../fiscal-xml/package.json', import.meta.url));
export const asn = require('asn1js'), pki = require('pkijs');
export { trustFixture, NOW };
export const ext = (id, value, critical = false) => new pki.Extension({ extnID: id, critical, extnValue: value.toBER(false) });
const ski = issuer => asn.fromBER(issuer.pkijsCertificate.extensions.find(e => e.extnID === '2.5.29.14').extnValue.valueBlock.valueHexView).result.valueBlock.valueHexView;
const time = value => new pki.Time({ type: new Date(value).getUTCFullYear() >= 2050 ? 1 : 0, value: new Date(value) });
export async function reissue(value, issuer, change) {
  change(value.pkijsCertificate);
  const key = await webcrypto.subtle.importKey('pkcs8', issuer.privateDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  await value.pkijsCertificate.sign(key, 'SHA-256', engine);
  value.certificateDer = Buffer.from(value.pkijsCertificate.toSchema(true).toBER(false)); value.certificate = new X509Certificate(value.certificateDer).toString();
  return value;
}
export async function makeCrl(issuer, options = {}) {
  const crl = new pki.CertificateRevocationList({ version: 1, issuer: issuer.pkijsCertificate.subject,
    thisUpdate: time(options.thisUpdate ?? '2026-10-16T10:00:00Z'),
    ...(options.nextUpdate === null ? {} : { nextUpdate: time(options.nextUpdate ?? '2026-10-17T10:00:00Z') }),
    crlExtensions: new pki.Extensions({ extensions: [
      ...(options.omitAki ? [] : [ext('2.5.29.35', new pki.AuthorityKeyIdentifier({ keyIdentifier: new asn.OctetString({ valueHex: options.aki ?? ski(issuer) }) }).toSchema())]),
      ext('2.5.29.20', new asn.Integer({ value: options.number ?? 1 })), ...(options.extensions ?? []),
    ] }),
    ...(options.revoked?.length ? { revokedCertificates: options.revoked.map(value => new pki.RevokedCertificate({
      userCertificate: typeof value.serial === 'string' ? new asn.Integer({ valueHex: Buffer.from(value.serial, 'hex') }) : new asn.Integer({ value: value.serial ?? 1 }),
      revocationDate: time(value.date ?? '2026-10-16T09:00:00Z'),
      ...(value.reason !== undefined || value.extensions ? { crlEntryExtensions: new pki.Extensions({ extensions: [
        ...(value.reason === undefined ? [] : [ext('2.5.29.21', new asn.Enumerated({ value: value.reason }))]), ...(value.extensions ?? []),
      ] }) } : {}),
    })) } : {}),
  });
  const hashAlgorithm = options.weak ? 'SHA-1' : 'SHA-256';
  const key = await webcrypto.subtle.importKey('pkcs8', issuer.privateDer, { name: 'RSASSA-PKCS1-v1_5', hash: hashAlgorithm }, true, ['sign']);
  await crl.sign(key, hashAlgorithm, engine);
  if (options.pss) {
    const algorithm = new pki.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.10', algorithmParams: new pki.RSASSAPSSParams({
      hashAlgorithm: new pki.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1', algorithmParams: new asn.Null() }),
      maskGenAlgorithm: new pki.AlgorithmIdentifier({ algorithmId: '1.2.840.113549.1.1.8', algorithmParams: new pki.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1', algorithmParams: new asn.Null() }).toSchema() }), saltLength: 32,
    }).toSchema() });
    crl.signature = algorithm; crl.signatureAlgorithm = algorithm; crl.tbsView = new Uint8Array(crl.encodeTBS().toBER(false));
    crl.signatureValue = new asn.BitString({ valueHex: sign('sha256', crl.tbsView, { key: issuer.privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }) });
  }
  const bytes = Buffer.from(crl.toSchema().toBER(false));
  return { crl, bytes, pem: `-----BEGIN X509 CRL-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END X509 CRL-----\n`, hash: createHash('sha256').update(bytes).digest('hex') };
}
export async function complete(fixture, leafOptions = {}, rootOptions = {}) {
  const leaf = await makeCrl(fixture.intermediate, leafOptions), root = await makeCrl(fixture.root, rootOptions);
  return { leaf, root, input: { ...fixture.input, crls: [leaf.bytes, root.bytes] } };
}

// Build the large revoked sequence as DER bytes, avoiding a test fixture with
// 100,000 PKIJS objects. The validator must retain this same bounded property.
const der = (tag, content) => {
  const length = content.length;
  let size = length < 128 ? Buffer.from([length]) : Buffer.from(length.toString(16).padStart(Math.ceil(length.toString(16).length / 2) * 2, '0'), 'hex');
  if (length >= 128) size = Buffer.concat([Buffer.from([0x80 | size.length]), size]);
  return Buffer.concat([Buffer.from([tag]), size, content]);
};
export async function largeCrl(issuer, count) {
  const f = await makeCrl(issuer), date = der(23, Buffer.from('261016090000Z')), entries = [];
  for (let i = 1; i <= count; i++) {
    let hex = i.toString(16); if (hex.length % 2) hex = '0' + hex; if (parseInt(hex.slice(0, 2), 16) >= 128) hex = '00' + hex;
    entries.push(der(0x30, Buffer.concat([der(2, Buffer.from(hex, 'hex')), date])));
  }
  const original = asn.fromBER(f.crl.tbsView).result.valueBlock.value;
  const tbs = der(0x30, Buffer.concat([...original.slice(0, -1).map(x => Buffer.from(x.toBER(false))), der(0x30, Buffer.concat(entries)), Buffer.from(original.at(-1).toBER(false))]));
  const signature = sign('sha256', tbs, issuer.privateKey);
  return der(0x30, Buffer.concat([tbs, Buffer.from(f.crl.signatureAlgorithm.toSchema().toBER(false)), der(3, Buffer.concat([Buffer.from([0]), signature]))]));
}
export function signedTbs(issuer, fixture, tbs) {
  const signature = sign('sha256', tbs, issuer.privateKey);
  return der(0x30, Buffer.concat([tbs, Buffer.from(fixture.crl.signatureAlgorithm.toSchema().toBER(false)), der(3, Buffer.concat([Buffer.from([0]), signature]))]));
}
export function noncanonicalAlgorithmCrl(issuer, fixture) {
  const algorithm = fixture.crl.signatureAlgorithm.toSchema().valueBlock.value, originalOid = Buffer.from(algorithm[0].toBER(false));
  // The same OID with an unnecessary zero base128 group in its first arc.
  const oid = der(6, Buffer.concat([Buffer.from([0x80]), originalOid.subarray(2)]));
  const modifiedAlgorithm = der(0x30, Buffer.concat([oid, ...algorithm.slice(1).map(x => Buffer.from(x.toBER(false)))]));
  const fields = asn.fromBER(fixture.crl.tbsView).result.valueBlock.value;
  const tbs = der(0x30, Buffer.concat(fields.map((x, i) => i === 1 ? modifiedAlgorithm : Buffer.from(x.toBER(false)))));
  const signature = sign('sha256', tbs, issuer.privateKey);
  return der(0x30, Buffer.concat([tbs, modifiedAlgorithm, der(3, Buffer.concat([Buffer.from([0]), signature]))]));
}
