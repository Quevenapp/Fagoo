#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeManifest, signManifest } from '../packages/release/manifest.mjs';

const [version, image, artifactPath, keyPath, outputDirectory, dbVersion = '1', compatibleMin = dbVersion] = process.argv.slice(2);
if (!version || !image || !artifactPath || !keyPath || !outputDirectory) {
  console.error('Usage: node scripts/release-sign.mjs vX.Y.Z ghcr.io/quevenapp/fagoo@sha256:... deployment.tar.gz /outside/repo/key.pem output-dir [database-version] [compatible-min]');
  process.exit(2);
}
const repoRoot = resolve(import.meta.dirname, '..'), keyRelative = relative(repoRoot, resolve(keyPath));
if (keyRelative && !keyRelative.startsWith('..') && !isAbsolute(keyRelative)) throw new Error('PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY');
const artifact = await readFile(artifactPath);
const manifest = { schema: 1, product: 'fagoo', version, platform: 'linux/amd64', minimum_updater: 1, image,
  database_version: Number(dbVersion), compatible_database_min: Number(compatibleMin), published_at: new Date().toISOString(),
  artifact: { url: `https://github.com/Quevenapp/Fagoo/releases/download/${version}/deployment.tar.gz`, size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') } };
const encoded = encodeManifest(manifest), signature = signManifest(encoded, await readFile(keyPath));
await writeFile(resolve(outputDirectory, 'manifest.json'), encoded);
await writeFile(resolve(outputDirectory, 'manifest.sig'), signature);
console.log(`Signed ${version}. Upload manifest.json, manifest.sig and deployment.tar.gz to the same public release.`);
