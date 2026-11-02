import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { encodeManifest, signManifest, verifyManifest, verifyArtifact, validateManifest } from './manifest.mjs';

const pair = generateKeyPairSync('ed25519');
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const bytes = Buffer.from('verified package');
const fixture = () => ({ schema: 1, product: 'fagoo', version: 'v0.1.0', platform: 'linux/amd64', minimum_updater: 1,
  image: `ghcr.io/quevenapp/fagoo@sha256:${'a'.repeat(64)}`, database_version: 1, compatible_database_min: 1,
  published_at: '2026-11-02T12:00:00Z', artifact: { url: 'https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0/deployment.tar.gz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });

test('signed release and artifact verify with pinned trust root', () => {
  const encoded = encodeManifest(fixture());
  assert.deepEqual(verifyManifest(encoded, signManifest(encoded, privatePem), publicPem), fixture());
  verifyArtifact(bytes, fixture().artifact);
});
test('tampering, another signing key, and corrupt artifacts fail closed', () => {
  const encoded = encodeManifest(fixture()), signature = signManifest(encoded, privatePem);
  const tampered = Buffer.from(encoded); tampered[10] ^= 1;
  assert.throws(() => verifyManifest(tampered, signature, publicPem), /INVALID_SIGNATURE/);
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyManifest(encoded, signature, other), /INVALID_SIGNATURE/);
  assert.throws(() => verifyArtifact(Buffer.from('modified package'), fixture().artifact));
});
test('signed manifest cannot redirect download or use mutable image tag', () => {
  assert.throws(() => validateManifest({ ...fixture(), image: 'ghcr.io/quevenapp/fagoo:latest' }));
  const bad = fixture(); bad.artifact.url = 'https://example.com/deployment.tar.gz';
  assert.throws(() => validateManifest(bad));
  assert.throws(() => validateManifest({ ...fixture(), version: '../../main' }));
  assert.throws(() => validateManifest({ ...fixture(), minimum_updater: 2 }));
});
test('image archive requires a signed immutable local image ID and artifact hash', () => {
  const value = { ...fixture(), image: `sha256:${'b'.repeat(64)}` };
  assert.throws(() => validateManifest(value), /INVALID_IMAGE_ARTIFACT/);
  value.image_artifact = { url: 'https://github.com/Quevenapp/Fagoo/releases/download/v0.1.0/app-image.tar.gz', size: 100, sha256: 'c'.repeat(64) };
  assert.equal(validateManifest(value), value);
  value.image_artifact.url = 'https://example.com/image.tar.gz';
  assert.throws(() => validateManifest(value));
});
