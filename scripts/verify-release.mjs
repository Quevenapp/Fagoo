#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { verifyManifest, verifyArtifact } from '../packages/release/manifest.mjs';
const [manifestPath, signaturePath, artifactPath, publicKeyPath = 'infra/release-root.pem'] = process.argv.slice(2);
if (!manifestPath || !signaturePath || !artifactPath) throw new Error('Usage: node scripts/verify-release.mjs manifest.json manifest.sig deployment.tar.gz [public.pem]');
const manifest = verifyManifest(await readFile(manifestPath), await readFile(signaturePath), await readFile(publicKeyPath));
verifyArtifact(await readFile(artifactPath), manifest.artifact);
console.log(JSON.stringify({ verified: true, version: manifest.version, image: manifest.image }));
