import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenSslLoader, sealCredential, withCredential, parseEnvelope, envelopeHash } from '../src/index.mjs';
import { binary, chainFixture, exportPfx, CONTEXT, KEK, PASSWORD, NOW } from './fixtures.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const chain = await chainFixture(), pfx = await exportPfx(chain.leaf, chain.chain);
function callCli(args, password = PASSWORD) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const out = [], err = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b));
    child.once('error', reject); child.once('close', code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdio[3].on('error', () => {}); child.stdio[4].on('error', () => {});
    child.stdio[3].end(password); child.stdio[4].end(KEK);
  });
}
test('operator CLI consumes secrets from FDs only, creates0600ciphertext, refuses overwrite and sanitizes failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brufap-vault-cli-'));
  try {
    const source = join(dir, 'synthetic.pfx'), ctx = join(dir, 'context.json'), output = join(dir, 'sealed.json');
    await writeFile(source, pfx, { mode: 0o600 }); await writeFile(ctx, JSON.stringify(CONTEXT), { mode: 0o600 });
    const args = ['--pfx', source, '--context', ctx, '--output', output, '--openssl', binary, '--key-id', 'synthetic-kek'];
    const result = await callCli(args);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout), saved = await readFile(output);
    assert.equal(receipt.envelope_hash, envelopeHash(parseEnvelope(saved))); assert.equal(receipt.can_transmit, false);
    assert.equal((await stat(output)).mode & 0o777, 0o600); assert.equal(saved.includes(Buffer.from(PASSWORD)), false);
    const second = await callCli(args); assert.equal(second.code, 1); assert.deepEqual(await readFile(output), saved);
    assert.equal(second.stderr, '{"error":"VAULT_OFFLINE_IMPORT_FAILED"}\n');
    const wrong = await callCli(args, Buffer.from('DO_NOT_PRINT_THIS_PASSWORD'));
    assert.equal(wrong.code, 1); assert.equal(wrong.stdout, ''); assert.equal(wrong.stderr.includes('DO_NOT_PRINT'), false);
    assert.deepEqual((await readdir(dir)).sort(), ['context.json', 'sealed.json', 'synthetic.pfx']);
  } finally { await rm(dir, { recursive: true }); }
});
test('OpenSSL timeout/diagnostic limit are bounded and subprocess diagnostics never enter thrown errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brufap-vault-runner-'));
  try {
    const fake = join(dir, 'openssl-synthetic');
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "version" ]; then echo "OpenSSL 3.6.3 test-only"; exit 0; fi\nexec /bin/sleep 5\n', { mode: 0o700 });
    const loader = await createOpenSslLoader({ binaryPath: fake, timeoutMs: 500 });
    const started = Date.now();
    await assert.rejects(loader.load({ pfxBytes: pfx, passwordBytes: PASSWORD, expectedHolderCnpj: CONTEXT.holder_cnpj, purpose: CONTEXT.purpose, now: NOW }), /VAULT_OPENSSL_TIMEOUT/);
    assert.ok(Date.now() - started < 2000);
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "version" ]; then echo "OpenSSL 3.6.3 test-only"; exit 0; fi\n/usr/bin/head -c 70000 /dev/zero >&2\nexit 1\n', { mode: 0o700 });
    const noisy = await createOpenSslLoader({ binaryPath: fake });
    await assert.rejects(noisy.load({ pfxBytes: pfx, passwordBytes: PASSWORD, expectedHolderCnpj: CONTEXT.holder_cnpj, purpose: CONTEXT.purpose, now: NOW }), /VAULT_OPENSSL_OUTPUT_LIMIT/);
  } finally { await rm(dir, { recursive: true }); }
});
test('caller buffer mutation during validation cannot change the encrypted credential or KEK', async () => {
  const loader = await createOpenSslLoader({ binaryPath: binary });
  const file = Buffer.from(pfx), password = Buffer.from(PASSWORD), kek = Buffer.from(KEK);
  let entered, proceed;
  const started = new Promise(resolve => { entered = resolve; }), paused = new Promise(resolve => { proceed = resolve; });
  const delayed = { async load(options) { entered(); await paused; return loader.load(options); } };
  const pending = sealCredential({ pfxBytes: file, passwordBytes: password, context: CONTEXT, kekBytes: kek, keyId: 'synthetic-kek', loader: delayed, now: NOW });
  await started; file.fill(0); password.fill(0); kek.fill(0); proceed();
  const sealed = await pending;
  const result = await withCredential({ envelope: sealed, expectedContext: CONTEXT, kekBytes: KEK, expectedKeyId: 'synthetic-kek', loader, now: NOW }, signer => signer.certificate.holderCnpj);
  assert.equal(result, CONTEXT.holder_cnpj);
});
