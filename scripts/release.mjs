#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { VERSION, encodeManifest, signManifest, verifyManifest } from '../packages/release/manifest.mjs';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/, ''), args[index + 1]]);
  return pairs;
}, []));
if (!VERSION.test(options.version ?? '') || !options.key || !options.out) {
  console.error('Usage: node scripts/release.mjs --version v0.1.0-alpha.1 --key /outside/repo/signing.pem --out /outside/repo/release [--image existing-local-tag]');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '..'), keyPath = resolve(options.key), output = resolve(options.out);
const keyRelative = relative(root, keyPath);
if (!keyRelative || (!keyRelative.startsWith('..') && !isAbsolute(keyRelative))) throw new Error('PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY');
await access(join(root, 'apps/web/dist/index.html'));
await mkdir(output, { recursive: true });

function run(command, args, capture = false) {
  return new Promise((fulfill, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let result = ''; if (capture) child.stdout.on('data', chunk => { result += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? fulfill(result.trim()) : reject(new Error(`${command} failed: ${code}`)));
  });
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size: (await stat(path)).size };
}

const sourceCommit = await run('git', ['rev-parse', 'HEAD'], true);
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('COMMITTED_SOURCE_REQUIRED');
if (await run('git', ['status', '--porcelain'], true)) throw new Error('CLEAN_COMMITTED_SOURCE_REQUIRED');
const localImage = options.image ?? `fagoo/release:${options.version}`;
if (!options.image) await run('docker', ['build', '--platform', 'linux/amd64', '--build-arg', `SOURCE_COMMIT=${sourceCommit}`, '-f', 'infra/Dockerfile', '-t', localImage, '.']);
const imageCommit = await run('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', localImage], true);
if (imageCommit !== sourceCommit) throw new Error('IMAGE_SOURCE_COMMIT_MISMATCH');
const image = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', localImage], true);
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('INVALID_BUILT_IMAGE_ID');
const imagePath = join(output, 'app-image.tar.gz'), imagePartial = imagePath + '.partial';
console.log('Packaging prebuilt image; customers do not need registry credentials.');
const save = spawn('docker', ['save', localImage], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const saveExit = new Promise((fulfill, reject) => { save.once('error', reject); save.once('exit', code => code === 0 ? fulfill() : reject(new Error(`docker save failed: ${code}`))); });
await Promise.all([pipeline(save.stdout, createGzip({ level: 6 }), createWriteStream(imagePartial)), saveExit]);
await rename(imagePartial, imagePath);

const staging = await mkdtemp(join(tmpdir(), 'fagoo-deployment-'));
try {
  const filter = path => !path.includes('node_modules') && !path.includes('__pycache__') && !path.endsWith('.pyc');
  await cp(join(root, 'infra'), join(staging, 'infra'), { recursive: true, filter });
  await mkdir(join(staging, 'scripts'), { recursive: true });
  for (const name of ['install.sh', 'install-source.sh', 'install-cloudflare.py', 'install-backup.py', 'backup.sh', 'restore.sh']) {
    await cp(join(root, 'scripts', name), join(staging, 'scripts', name));
  }
  await mkdir(join(staging, 'apps/web'), { recursive: true });
  await cp(join(root, 'apps/web/dist'), join(staging, 'apps/web/dist'), { recursive: true });
  await cp(join(root, 'apps/web/worker.mjs'), join(staging, 'apps/web/worker.mjs'));
  const artifactPath = join(output, 'deployment.tar.gz');
  await run('tar', ['-czf', artifactPath, '-C', staging, 'infra', 'scripts', 'apps']);
  const manifest = { schema: 1, product: 'fagoo', version: options.version, platform: 'linux/amd64', minimum_updater: 1, image,
    database_version: 1, compatible_database_min: 1, published_at: new Date().toISOString(), source_commit: sourceCommit,
    artifact: { url: `https://github.com/Quevenapp/Fagoo/releases/download/${options.version}/deployment.tar.gz`, ...await hashFile(artifactPath) },
    image_artifact: { url: `https://github.com/Quevenapp/Fagoo/releases/download/${options.version}/app-image.tar.gz`, ...await hashFile(imagePath) } };
  const bytes = encodeManifest(manifest), signature = signManifest(bytes, await readFile(keyPath));
  verifyManifest(bytes, signature, await readFile(join(root, 'infra/release-root.pem')));
  await writeFile(join(output, 'manifest.json'), bytes);
  await writeFile(join(output, 'manifest.sig'), signature);
  await cp(join(root, 'scripts/install.sh'), join(output, 'install.sh'));
  console.log(JSON.stringify({ prepared: true, version: options.version, image, output, cloudflare_deployed: false }, null, 2));
} finally {
  if (!resolve(staging).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('UNSAFE_STAGING_PATH');
  await rm(staging, { recursive: true, force: true });
}
