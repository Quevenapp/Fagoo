import test from 'node:test';
import assert from 'node:assert/strict';
import { PFX } from 'pkijs';
import { disposeSigner, loadPfxSigner, signNfeXml } from '../src/index.mjs';
import { credentials, HOLDER, NOW, PASSWORD, pfxFixture, unsignedXml } from './fixtures.mjs';

const credential = await credentials();
const bytes = await pfxFixture(credential);
const options = (pfxBytes = bytes,passwordBytes = PASSWORD) => ({pfxBytes,passwordBytes,expectedHolderCnpj:HOLDER,now:NOW,purpose:'offline-homologation'});
test('AES256/PBKDF2-SHA256 PFX loads only in memory and its extracted key signs correctly', async () => {
  const originalPassword = Uint8Array.from(PASSWORD), originalFile = Uint8Array.from(bytes);
  const signer = await loadPfxSigner(options());
  assert.equal(signer.certificate.holderCnpj,HOLDER);
  const result = signNfeXml({xml:unsignedXml(),signer,expectedIssuerCnpj:HOLDER,now:NOW});
  assert.equal(result.verification.signatureVerified,true); assert.equal(result.canTransmit,false);
  assert.deepEqual(PASSWORD,originalPassword); assert.deepEqual(bytes,originalFile);
  assert.equal(disposeSigner(signer),true);
});
test('encrypted certificate safe is validated and decrypted with the same strict policy', async () => {
  const encrypted = await pfxFixture(credential,{encryptedSafe:true});
  const signer = await loadPfxSigner(options(encrypted)); assert.equal(signer.certificate.holderCnpj,HOLDER); disposeSigner(signer);
});
test('wrong password and tampered MAC fail with safe fixed error; secrets and contents are not in errors', async () => {
  const wrong = new TextEncoder().encode('senha-errada-que-nao-deve-aparecer');
  await assert.rejects(loadPfxSigner(options(bytes,wrong)),error => error.code === 'PFX_INVALID_OR_PASSWORD_REJECTED' && !error.message.includes('senha'));
  const pfx = PFX.fromBER(bytes); pfx.macData.mac.digest.valueBlock.valueHexView[0] ^= 1;
  await assert.rejects(loadPfxSigner(options(new Uint8Array(pfx.toSchema().toBER(false)))),/PFX_INVALID_OR_PASSWORD_REJECTED/);
});
test('unbounded KDF costs and missing integrity are rejected before deriving keys', async () => {
  const pfx = PFX.fromBER(bytes); pfx.macData.iterations = 100001;
  await assert.rejects(loadPfxSigner(options(new Uint8Array(pfx.toSchema().toBER(false)))),/PFX_KDF_ITERATIONS_UNSUPPORTED/);
  delete pfx.macData;
  await assert.rejects(loadPfxSigner(options(new Uint8Array(pfx.toSchema().toBER(false)))),/PFX_INTEGRITY_REQUIRED/);
});
test('validly authenticated PFX outside the encryption/MAC allowlist has no fallback', async () => {
  const aes128 = await pfxFixture(credential,{keyLength:128});
  await assert.rejects(loadPfxSigner(options(aes128)),/PFX_ENCRYPTION_UNSUPPORTED/);
  const sha1 = await pfxFixture(credential,{macHash:'SHA-1'});
  await assert.rejects(loadPfxSigner(options(sha1)),/PFX_MAC_HASH_UNSUPPORTED/);
});
test('password must be bounded bytes and no PFX data is accepted as unchecked PEM or production input', async () => {
  await assert.rejects(loadPfxSigner(options(bytes,'password')),/PFX_PASSWORD_BYTES_REQUIRED/);
  await assert.rejects(loadPfxSigner(options(new Uint8Array(131073))),/PFX_SIZE_INVALID/);
  await assert.rejects(loadPfxSigner({...options(),purpose:'production'}),/SIGNER_PRODUCTION_UNAVAILABLE/);
  const trailing = new Uint8Array(bytes.length+1); trailing.set(bytes);
  await assert.rejects(loadPfxSigner(options(trailing)),/CERTIFICATE_ASN1_INVALID/);
});
