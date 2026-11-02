import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const VERSION = /^v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const IMAGE = /^(?:ghcr\.io\/quevenapp\/fagoo@)?sha256:[a-f0-9]{64}$/;

export function validateManifest(value) {
  if (!value || value.schema !== 1 || value.product !== 'fagoo' || !VERSION.test(value.version ?? '') || value.platform !== 'linux/amd64') throw new Error('INVALID_RELEASE');
  if (value.minimum_updater !== 1 || !IMAGE.test(value.image ?? '')) throw new Error('UNSUPPORTED_RELEASE');
  if (!Number.isSafeInteger(value.database_version) || value.database_version < 1) throw new Error('INVALID_DATABASE_VERSION');
  if (!Number.isSafeInteger(value.compatible_database_min) || value.compatible_database_min < 1 || value.compatible_database_min > value.database_version) throw new Error('INVALID_COMPATIBILITY');
  if (!Number.isFinite(Date.parse(value.published_at))) throw new Error('INVALID_PUBLICATION_DATE');
  const artifact = value.artifact;
  if (!artifact || !DIGEST.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > 50 * 1024 * 1024) throw new Error('INVALID_ARTIFACT');
  if (artifact.url !== `https://github.com/Quevenapp/Fagoo/releases/download/${value.version}/deployment.tar.gz`) throw new Error('INVALID_ARTIFACT_URL');
  if (value.image.startsWith('sha256:') || value.image_artifact !== undefined) {
    const archive = value.image_artifact;
    if (!archive || !DIGEST.test(archive.sha256 ?? '') || !Number.isSafeInteger(archive.size) || archive.size < 1 || archive.size > 2 * 1024 ** 3) throw new Error('INVALID_IMAGE_ARTIFACT');
    if (!value.image.startsWith('sha256:') || archive.url !== `https://github.com/Quevenapp/Fagoo/releases/download/${value.version}/app-image.tar.gz`) throw new Error('INVALID_IMAGE_ARTIFACT_URL');
  }
  return value;
}

export function encodeManifest(value) {
  validateManifest(value);
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}

export function signManifest(bytes, privatePem) {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_KEY_REQUIRED');
  validateManifest(JSON.parse(bytes));
  return sign(null, bytes, key);
}

export function verifyManifest(bytes, signature, publicPem) {
  if (bytes.length > 65536 || signature.length !== 64) throw new Error('INVALID_ENVELOPE');
  const key = createPublicKey(publicPem);
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, signature)) throw new Error('INVALID_SIGNATURE');
  return validateManifest(JSON.parse(bytes));
}

export function verifyArtifact(bytes, artifact) {
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('INVALID_ARTIFACT_DIGEST');
}
