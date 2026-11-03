import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenSslLoader, sealCredential, withCredential, rewrapCredential, envelopeHash, envelopeBytes, parseEnvelope, openLocalVault } from '../src/index.mjs';
import { signNfeXml, disposeSigner } from '../../fiscal-xml/src/index.mjs';
import { binary, chainFixture, exportPfx, HOLDER, OTHER, NOW, PASSWORD, KEK, CONTEXT, unsignedXml, credentials } from './fixtures.mjs';

const chain = await chainFixture(), file = await exportPfx(chain.leaf, chain.chain);
const loader = await createOpenSslLoader({ binaryPath: binary });
const options = { pfxBytes: file, passwordBytes: PASSWORD, context: CONTEXT, kekBytes: KEK, keyId: 'test-key-v1', loader, now: NOW };
const envelope = await sealCredential(options);
const use = (value = envelope, extra = {}) => withCredential({ envelope: value, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW, ...extra }, signer => signNfeXml({ xml: unsignedXml(), signer, expectedIssuerCnpj: HOLDER, now: NOW }));

test('OpenSSL3 reads full chain only in pipes; leaf signs, metadata never claims ICP/revocation/SEFAZ', async () => {
  const credential = await loader.load({ pfxBytes: file, passwordBytes: PASSWORD, expectedHolderCnpj: HOLDER, purpose: 'offline-homologation', now: NOW });
  assert.equal(credential.metadata.presented_chain.length, 3);
  for (const field of ['icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'client_auth_eku_verified', 'can_transmit']) assert.equal(credential.metadata[field], false);
  assert.equal(signNfeXml({ xml: unsignedXml(), signer: credential.signer, expectedIssuerCnpj: HOLDER, now: NOW }).verification.signatureVerified, true);
  disposeSigner(credential.signer);
  assert.equal((await use()).verification.signatureVerified, true);
  const bytes = envelopeBytes(envelope);
  assert.equal(bytes.includes(Buffer.from(PASSWORD)), false); assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false); assert.equal(bytes.includes(file), false);
  assert.deepEqual(parseEnvelope(bytes), envelope);
});
test('independent AEAD DEKs/IVs and every contextual or metadata substitution fail closed', async () => {
  const again = await sealCredential(options);
  assert.notEqual(envelope.payload.ciphertext, again.payload.ciphertext); assert.notEqual(envelope.wrapped_key.ciphertext, again.wrapped_key.ciphertext);
  for (const part of ['payload', 'wrapped_key']) for (const field of ['iv', 'ciphertext', 'tag']) {
    const tampered = structuredClone(envelope), bytes = Buffer.from(tampered[part][field], 'base64'); bytes[0] ^= 1; tampered[part][field] = bytes.toString('base64');
    await assert.rejects(use(tampered), /VAULT_/);
  }
  for (const field of ['credential_id', 'vault_id']) {
    const tampered = structuredClone(envelope); tampered.context[field] = randomUUID();
    await assert.rejects(use(tampered, { expectedContext: tampered.context }), /VAULT_/);
  }
  const tampered = structuredClone(envelope); tampered.metadata.validated_at = '2026-10-16T13:00:00.000Z';
  await assert.rejects(use(tampered), /VAULT_/);
  await assert.rejects(use(envelope, { kekBytes: randomBytes(32) }), /VAULT_/);
  await assert.rejects(use(envelope, { expectedContext: { ...CONTEXT, holder_cnpj: OTHER } }), /VAULT_CONTEXT_MISMATCH/);
  await assert.rejects(use(envelope, { expectedContext: { ...CONTEXT, company_identity_version: 2 } }), /VAULT_CONTEXT_MISMATCH/);
  await assert.rejects(use(envelope, { expectedKeyId: 'wrong-key-id' }), /VAULT_KEY_ID_MISMATCH/);
});
test('KEK rotation preserves exact payload and requires old hash, then rejects the old key', async () => {
  const nextKey = randomBytes(32), next = rewrapCredential({ envelope, expectedContext: CONTEXT, expectedEnvelopeHash: envelopeHash(envelope), oldKekBytes: KEK, newKekBytes: nextKey, newKeyId: 'test-key-v2' });
  assert.deepEqual(next.payload, envelope.payload); assert.deepEqual(next.context, envelope.context); assert.deepEqual(next.metadata, envelope.metadata);
  assert.equal((await use(next, { kekBytes: nextKey, expectedKeyId: 'test-key-v2' })).verification.signatureVerified, true);
  await assert.rejects(use(next, { expectedKeyId: 'test-key-v2' }), /VAULT_/);
  assert.throws(() => rewrapCredential({ envelope, expectedContext: CONTEXT, expectedEnvelopeHash: '0'.repeat(64), oldKekBytes: KEK, newKekBytes: nextKey, newKeyId: 'test-key-v2' }), /VAULT_ENVELOPE_CONFLICT/);
});
test('AAD identities reject arrays and objects instead of regex coercion', async () => {
  for (const field of ['vault_id', 'credential_id']) {
    await assert.rejects(sealCredential({ ...options, context: { ...CONTEXT, [field]: [CONTEXT[field]] } }), /VAULT_ID_INVALID/);
    const changed = structuredClone(envelope); changed.context[field] = [CONTEXT[field]];
    assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify(changed))), /VAULT_ID_INVALID/);
  }
});
test('legacy RC2/3DES+SHA1 MAC requires explicit provider and is resealed under AES256GCM', async () => {
  const legacy = await exportPfx(chain.leaf, chain.chain, { legacy: true });
  await assert.rejects(sealCredential({ ...options, pfxBytes: legacy }), /VAULT_PFX_REJECTED/);
  const oldLoader = await createOpenSslLoader({ binaryPath: binary, allowLegacy: true });
  const sealed = await sealCredential({ ...options, pfxBytes: legacy, loader: oldLoader });
  assert.equal(sealed.metadata.legacy_provider_enabled, true);
  assert.equal((await use(sealed, { loader: oldLoader })).verification.signatureVerified, true);
});
test('no MAC, wrong password, wrong holder, stale certificate and malformed input never return signer or diagnostics', async () => {
  const noMac = await exportPfx(chain.leaf, chain.chain, { noMac: true });
  await assert.rejects(sealCredential({ ...options, pfxBytes: noMac }), /VAULT_PFX_MAC_REQUIRED_OR_UNSUPPORTED/);
  const wrong = Buffer.from('private-password-must-not-appear');
  await assert.rejects(sealCredential({ ...options, passwordBytes: wrong }), error => !JSON.stringify(error).includes(wrong.toString()) && error.code === 'VAULT_PFX_REJECTED');
  await assert.rejects(sealCredential({ ...options, context: { ...CONTEXT, holder_cnpj: OTHER } }), /VAULT_CREDENTIAL_REJECTED/);
  await assert.rejects(use(envelope, { now: new Date('2028-01-01T00:00:00Z') }), /VAULT_PRESENTED_CHAIN_EXPIRED/);
  await assert.rejects(sealCredential({ ...options, passwordBytes: Buffer.from('a\nb') }), /VAULT_PASSWORD_ENCODING_UNSUPPORTED/);
  await assert.rejects(sealCredential({ ...options, pfxBytes: Buffer.alloc(1048577) }), /VAULT_PFX_SIZE_INVALID/);
  await assert.rejects(sealCredential({ ...options, pfxBytes: Buffer.from('not-a-certificate') }), /VAULT_PFX_REJECTED/);
  await assert.rejects(sealCredential({ ...options, context: { ...CONTEXT, environment: '1' } }), /VAULT_OFFLINE_ONLY/);
  assert.throws(() => parseEnvelope(Buffer.from('{"privateKey":"never-accepted"}')), /VAULT_SHAPE_INVALID/);
});
test('an unrelated certificate and a duplicate leaf are rejected instead of silently picking a candidate', async () => {
  const unrelated = await credentials({ ca: true });
  const bad = await exportPfx(chain.leaf, [...chain.chain, unrelated]);
  await assert.rejects(sealCredential({ ...options, pfxBytes: bad }), /VAULT_PRESENTED_CHAIN_AMBIGUOUS_OR_UNRELATED/);
  const duplicate = await exportPfx(chain.leaf, [...chain.chain, chain.leaf]);
  await assert.rejects(sealCredential({ ...options, pfxBytes: duplicate }), /VAULT_DUPLICATE_CERTIFICATE/);
});
test('local store has real CAS, permanent command replay and disable without reactivation on replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brufap-vault-test-'));
  try {
    const store = await openLocalVault({ directory, vaultId: CONTEXT.vault_id, create: true });
    const command = { commandId: randomUUID(), expectedRevision: 0, action: 'select_offline', envelope, reason: 'Synthetic offline selection', kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW };
    const selected = await store.command(command); assert.equal(selected.current.revision, 1);
    assert.equal((await store.command(command)).replayed, true);
    await assert.rejects(store.command({ ...command, commandId: randomUUID() }), /VAULT_STORE_REVISION_CONFLICT/);
    const result = await store.use({ expectedRevision: 1, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW }, signer => signNfeXml({ xml: unsignedXml(), signer, expectedIssuerCnpj: HOLDER, now: NOW }));
    assert.equal(result.verification.signatureVerified, true);
    const disabled = await store.command({ commandId: randomUUID(), expectedRevision: 1, action: 'disable', expectedEnvelopeHash: envelopeHash(envelope), reason: 'Synthetic operator disable', now: NOW });
    assert.equal(disabled.current.selected, null);
    const replay = await store.command(command); assert.equal(replay.replayed, true); assert.equal(replay.receipt.revision, 1); assert.equal(replay.current.revision, 2); assert.equal(replay.current.selected, null);
    await assert.rejects(store.use({ expectedRevision: 2, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW }, () => {}), /VAULT_STORE_REVISION_CONFLICT/);
    for (const name of await readdir(directory)) { const bytes = await readFile(join(directory, name)); assert.equal(bytes.includes(Buffer.from(PASSWORD)), false); assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false); }
  } finally { await rm(directory, { recursive: true }); }
});
test('local lock serializes usage/disable; unsafe directories and symbolic files are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brufap-vault-test-'));
  try {
    await chmod(directory, 0o755); await assert.rejects(openLocalVault({ directory, vaultId: CONTEXT.vault_id, create: true }), /VAULT_STORE_DIRECTORY_UNSAFE/);
    await chmod(directory, 0o700);
    const store = await openLocalVault({ directory, vaultId: CONTEXT.vault_id, create: true });
    await store.command({ commandId: randomUUID(), expectedRevision: 0, action: 'select_offline', envelope, reason: 'Synthetic selection', kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW });
    let entered, release; const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
    const usePending = store.use({ expectedRevision: 1, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW }, async () => { entered(); await wait; });
    await started;
    await assert.rejects(store.command({ commandId: randomUUID(), expectedRevision: 1, action: 'disable', expectedEnvelopeHash: envelopeHash(envelope), reason: 'Synthetic disable', now: NOW }), /VAULT_STORE_BUSY/);
    release(); await usePending;
    const object = join(directory, `${envelopeHash(envelope)}.json`); await rm(object); await symlink(join(directory, 'head.json'), object);
    await assert.rejects(store.use({ expectedRevision: 1, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'test-key-v1', loader, now: NOW }, () => {}), /VAULT_STORE_OPERATION_FAILED/);
  } finally { await rm(directory, { recursive: true }); }
});
