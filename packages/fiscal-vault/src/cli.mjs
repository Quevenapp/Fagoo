#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createOpenSslLoader, sealCredential, envelopeBytes, envelopeHash } from './index.mjs';
import { need, safe, context, MAX_PFX } from './common.mjs';

async function boundedFile(path, maximum) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    need(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'VAULT_INPUT_FILE_INVALID');
    const bytes = await handle.readFile(); need(bytes.length <= maximum, 'VAULT_INPUT_FILE_INVALID'); return bytes;
  } finally { await handle?.close(); }
}
async function descriptor(fd, limit) {
  // Dedicated inherited pipes, never argv/env. A bounded timer prevents a forgotten
  // pipe writer from leaving a credential-import process waiting indefinitely.
  const chunks = []; let size = 0;
  const stream = createReadStream('', { fd, autoClose: false, highWaterMark: Math.min(limit + 1, 4096) });
  const timer = setTimeout(() => stream.destroy(new Error('FD_TIMEOUT')), 10000);
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) { chunk.fill(0); stream.destroy(); need(false, 'VAULT_SECRET_FD_INVALID'); }
      chunks.push(chunk);
    }
    need(size >= 1, 'VAULT_SECRET_FD_INVALID'); return Buffer.concat(chunks);
  } finally { clearTimeout(timer); chunks.forEach(buffer => buffer.fill(0)); }
}
export async function sealFromDescriptors(argv) {
  const flags = new Map(); let legacy = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--legacy-pfx') { need(!legacy, 'VAULT_ARGUMENT_INVALID'); legacy = true; continue; }
    need(['--pfx', '--context', '--output', '--openssl', '--key-id'].includes(flag) && !flags.has(flag) && typeof argv[index + 1] === 'string', 'VAULT_ARGUMENT_INVALID');
    flags.set(flag, argv[++index]);
  }
  need(flags.size === 5, 'VAULT_ARGUMENT_INVALID');
  const destination = resolve(flags.get('--output'));
  need(destination !== resolve(flags.get('--pfx')) && destination !== resolve(flags.get('--context')), 'VAULT_OUTPUT_CONFLICT');
  let pfx, password, kek, output;
  try {
    const ctx = context(JSON.parse((await boundedFile(flags.get('--context'), 4096)).toString('utf8')));
    pfx = await boundedFile(flags.get('--pfx'), MAX_PFX);
    // Start both pipe readers together: neither writer can block behind the other.
    const secrets = await Promise.allSettled([descriptor(3, 1024), descriptor(4, 32)]);
    if (secrets[0].status === 'fulfilled') password = secrets[0].value;
    if (secrets[1].status === 'fulfilled') kek = secrets[1].value;
    need(password && kek, 'VAULT_SECRET_FD_INVALID');
    const loader = await createOpenSslLoader({ binaryPath: flags.get('--openssl'), allowLegacy: legacy });
    const envelope = await sealCredential({ pfxBytes: pfx, passwordBytes: password, context: ctx, kekBytes: kek, keyId: flags.get('--key-id'), loader });
    const bytes = envelopeBytes(envelope);
    // No overwrite, including after a previous successful write whose response was lost.
    output = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await output.writeFile(bytes); await output.sync();
    return { stored_encrypted: true, envelope_hash: envelopeHash(envelope), can_transmit: false };
  } catch (error) { throw safe(error, 'VAULT_OFFLINE_IMPORT_FAILED'); }
  finally { pfx?.fill(0); password?.fill(0); kek?.fill(0); await output?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(await sealFromDescriptors(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ error: safe(error, 'VAULT_OFFLINE_IMPORT_FAILED').code }) + '\n'); process.exitCode = 1; }
}
