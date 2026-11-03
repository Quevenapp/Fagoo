import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { X509Certificate, webcrypto, randomBytes } from 'node:crypto';
import { credentials, HOLDER, OTHER, NOW, PASSWORD, unsignedXml } from '../../fiscal-xml/test/fixtures.mjs';
const require = createRequire(new URL('../../fiscal-xml/package.json', import.meta.url));
const { CryptoEngine } = require('pkijs');
const { BitString, OctetString, Utf8String } = require('asn1js');
export { HOLDER, OTHER, NOW, PASSWORD, unsignedXml, credentials };
export const KEK = randomBytes(32);
export const CONTEXT = { vault_id: '10000000-0000-4000-8000-000000000001', credential_id: '20000000-0000-4000-8000-000000000001',
  credential_version: 1, company_identity_version: 1, holder_cnpj: HOLDER, environment: '2', purpose: 'offline-homologation' };
export const binary = process.env.BRUFAP_TEST_OPENSSL_PATH ?? '/opt/homebrew/opt/openssl@3/bin/openssl';
await access(binary); // No silent skips: CI must provide pinned OpenSSL3 explicitly.
const engine = new CryptoEngine({ name: 'synthetic-vault-test', crypto: webcrypto, subtle: webcrypto.subtle });
async function resign(credential, issuer, { ca = false, name } = {}) {
  const cert = credential.pkijsCertificate;
  if (name) cert.subject.typesAndValues[0].value = new Utf8String({ value: name });
  cert.issuer = issuer.pkijsCertificate.subject;
  if (ca) cert.extensions[1].extnValue = new OctetString({ valueHex: new BitString({ unusedBits: 1, valueHex: new Uint8Array([0x86]).buffer }).toBER(false) });
  const key = await webcrypto.subtle.importKey('pkcs8', issuer.privateDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  await cert.sign(key, 'SHA-256', engine);
  credential.certificateDer = Buffer.from(cert.toSchema(true).toBER(false)); credential.certificate = new X509Certificate(credential.certificateDer).toString();
  return credential;
}
export async function chainFixture() {
  const root = await credentials({ ca: true }); await resign(root, root, { ca: true, name: 'ROOT SYNTHETIC ONLY' });
  const intermediate = await credentials({ ca: true }); await resign(intermediate, root, { ca: true, name: 'INTERMEDIATE SYNTHETIC ONLY' });
  const leaf = await credentials(); await resign(leaf, intermediate);
  return { leaf, chain: [intermediate, root] };
}
export function exportPfx(leaf, chain = [], { legacy = false, noMac = false, password = PASSWORD, iterations = 2048, friendlyName } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['pkcs12', '-export', '-passout', 'fd:3', '-iter', String(iterations),
      ...(legacy ? ['-legacy', '-macalg', 'sha1'] : []), ...(noMac ? ['-nomac'] : []), ...(friendlyName ? ['-name', friendlyName] : [])],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', OPENSSL_CONF: '/dev/null' } });
    const out = [], err = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`SYNTHETIC_EXPORT_FAILED_${code}`)));
    for (const stream of [child.stdin, ...child.stdio.slice(3)]) stream.on('error', () => {});
    // One PEM stream is portable on Linux too: reopening a Node socket through /dev/fd/N is not.
    const pem = leaf.privateKey.export({ type: 'pkcs8', format: 'pem' });
    child.stdin.end([pem, leaf.certificate, ...chain.map(c => c.certificate)].join('\n')); child.stdio[3].end(password);
  });
}
