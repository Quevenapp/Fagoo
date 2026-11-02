import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { createSigner, disposeSigner } from '../../fiscal-xml/src/index.mjs';
import { need, safe, inputs, clock, hash, VaultError } from './common.mjs';

// No shell, inherited environment, filenames, passwords in argv, or plaintext files.
// The executable path is trusted deployment configuration, never a request parameter.
function run(binary, args, input, password, timeoutMs, {signal, deadline} = {}) {
  return new Promise((resolve, reject) => {
    need(!signal?.aborted, 'VAULT_OPENSSL_ABORTED');
    const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - Date.now());
    need(remaining > 0, 'VAULT_OPENSSL_TIMEOUT');
    const output = [], diagnostics = []; let outputSize = 0, diagnosticSize = 0, failure;
    const child = spawn(binary, args, {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', OPENSSL_CONF: '/dev/null' },
    });
    const fail = code => { failure ??= new VaultError(code); child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('VAULT_OPENSSL_TIMEOUT'), remaining);
    const abort = () => fail('VAULT_OPENSSL_ABORTED');
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      outputSize += chunk.length;
      if (outputSize > 2 * 1024 * 1024) { chunk.fill(0); fail('VAULT_OPENSSL_OUTPUT_LIMIT'); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      diagnosticSize += chunk.length;
      if (diagnosticSize > 65536) { chunk.fill(0); fail('VAULT_OPENSSL_OUTPUT_LIMIT'); }
      else diagnostics.push(chunk);
    });
    child.once('error', () => { failure ??= new VaultError('VAULT_OPENSSL_UNAVAILABLE'); });
    // EPIPE can follow a rejected file. The exit status determines the sanitized error.
    child.stdin.on('error', () => {}); child.stdio[3].on('error', () => {});
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const stdout = Buffer.concat(output), stderr = Buffer.concat(diagnostics);
      output.forEach(buffer => buffer.fill(0)); diagnostics.forEach(buffer => buffer.fill(0));
      if (failure || code !== 0) {
        stdout.fill(0); stderr.fill(0);
        reject(failure ?? new VaultError('VAULT_PFX_REJECTED')); return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
    child.stdio[3].end(password);
  });
}

function blocks(bytes) {
  const found = []; let offset = 0;
  const begin = Buffer.from('-----BEGIN ');
  while (true) {
    const start = bytes.indexOf(begin, offset); if (start === -1) break;
    const endLabel = bytes.indexOf('-----', start + begin.length);
    need(endLabel > start && endLabel - start < 64, 'VAULT_PEM_INVALID');
    const label = bytes.subarray(start + begin.length, endLabel).toString('ascii');
    need(['CERTIFICATE', 'PRIVATE KEY'].includes(label), 'VAULT_PEM_INVALID');
    const endMarker = Buffer.from(`-----END ${label}-----`);
    const end = bytes.indexOf(endMarker, endLabel + 5);
    need(end > endLabel && end - start <= 50000 && found.length < 16, 'VAULT_PEM_INVALID');
    const pem = bytes.subarray(start, end + endMarker.length);
    need(pem.indexOf(begin, begin.length) === -1, 'VAULT_PEM_INVALID');
    found.push({ label, pem }); offset = end + endMarker.length;
  }
  return found;
}

function presentedChain(certs, leaf, now) {
  const remaining = certs.filter(cert => cert !== leaf), chain = [leaf];
  while (remaining.length) {
    const child = chain.at(-1);
    const candidates = remaining.filter(parent => parent.ca && child.checkIssued(parent) && child.verify(parent.publicKey));
    need(candidates.length === 1, 'VAULT_PRESENTED_CHAIN_AMBIGUOUS_OR_UNRELATED');
    const parent = candidates[0];
    need(now >= parent.validFromDate && now <= parent.validToDate, 'VAULT_PRESENTED_CHAIN_EXPIRED');
    remaining.splice(remaining.indexOf(parent), 1); chain.push(parent);
  }
  return chain.map(cert => hash(cert.raw));
}

/** Internal trusted reader. Its synchronous accept callback must never come from an HTTP request. */
export async function createPkcs12Reader({ binaryPath, allowLegacy = false, timeoutMs = 5000 } = {}) {
  need(typeof binaryPath === 'string' && isAbsolute(binaryPath) && !binaryPath.includes('\0'), 'VAULT_OPENSSL_PATH_INVALID');
  need(typeof allowLegacy === 'boolean' && Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 10000, 'VAULT_OPENSSL_OPTIONS_INVALID');
  const version = await run(binaryPath, ['version'], undefined, undefined, timeoutMs);
  try { need(/^OpenSSL 3\.\d+\.\d+\b/.test(version.stdout.toString('ascii')), 'VAULT_OPENSSL_3_REQUIRED'); }
  finally { version.stdout.fill(0); version.stderr.fill(0); }
  return Object.freeze({
    async read({ pfxBytes, passwordBytes, expectedHolderCnpj, now = new Date() } = {}, accept, { retainSigner = false, signal, deadline } = {}) {
      inputs(pfxBytes, passwordBytes); clock(now);
      now = new Date(now.getTime());
      need(typeof accept === 'function' && typeof retainSigner === 'boolean', 'VAULT_ACTION_REQUIRED');
      need(signal === undefined || signal instanceof AbortSignal, 'VAULT_OPENSSL_SIGNAL_INVALID');
      need(deadline === undefined || Number.isSafeInteger(deadline) && deadline > Date.now(), 'VAULT_OPENSSL_DEADLINE_INVALID');
      const file = Buffer.from(pfxBytes), password = Buffer.from(passwordBytes);
      let result, signer, retained = false;
      try {
        result = await run(binaryPath, ['pkcs12', '-info', '-noenc', '-passin', 'fd:3', ...(allowLegacy ? ['-legacy'] : [])], file, password, timeoutMs, {signal, deadline});
        // OpenSSL normally allows a no-MAC PFX. Our profile never does. The command
        // does not use -nomacver: with a MAC, an invalid password/integrity exits nonzero.
        const info = result.stderr.toString('ascii');
        const mac = /^MAC: (sha1|sha224|sha256|sha384|sha512), Iteration (\d+)\r?$/m.exec(info);
        need(mac && BigInt(mac[2]) >= 1n && BigInt(mac[2]) <= 1000000n, 'VAULT_PFX_MAC_REQUIRED_OR_UNSUPPORTED');
        need(!/^Key bag\b/m.test(info), 'VAULT_UNENCRYPTED_KEY_BAG_REJECTED');
        const parsed = blocks(result.stdout);
        const keys = parsed.filter(block => block.label === 'PRIVATE KEY');
        const certs = parsed.filter(block => block.label === 'CERTIFICATE').map(block => new X509Certificate(block.pem));
        need(keys.length === 1 && certs.length >= 1 && certs.length <= 10, 'VAULT_SINGLE_KEY_REQUIRED');
        need(new Set(certs.map(cert => hash(cert.raw))).size === certs.length, 'VAULT_DUPLICATE_CERTIFICATE');
        const privateKey = createPrivateKey(keys[0].pem);
        const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
        const leaves = certs.filter(cert => cert.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey));
        need(leaves.length === 1, 'VAULT_KEY_LEAF_MISMATCH');
        const leaf = leaves[0];
        const chain = presentedChain(certs, leaf, now);
        signer = createSigner({ privateKey, certificate: leaf.raw, expectedHolderCnpj, now, purpose: 'offline-homologation' });
        const metadata = Object.freeze({
          profile: 'openssl3-pkcs12', legacy_provider_enabled: allowLegacy,
          pfx_mac: mac[1], pfx_mac_iterations: Number(mac[2]),
          fingerprint_sha256: signer.certificate.fingerprint256, holder_cnpj: signer.certificate.holderCnpj,
          not_before: signer.certificate.notBefore, not_after: signer.certificate.notAfter,
          rsa_bits: signer.certificate.rsaBits, presented_chain: Object.freeze(chain), validated_at: now.toISOString(),
          key_matches_certificate: true, presented_chain_links_checked: true,
          icp_brasil_chain_validated: false, revocation_checked: false, a1_policy_verified: false,
          client_auth_eku_verified: false, can_transmit: false,
        });
        const accepted = accept(Object.freeze({ signer, metadata, privateKeyPem: keys[0].pem,
          certificateChain: Object.freeze(chain.map(fingerprint => certs.find(cert => hash(cert.raw) === fingerprint))) }));
        need(!(accepted && typeof accepted.then === 'function'), 'VAULT_ACCEPT_MUST_BE_SYNCHRONOUS');
        retained = retainSigner;
        return accepted;
      } catch (error) {
        throw safe(error, 'VAULT_CREDENTIAL_REJECTED');
      } finally {
        if (signer && !retained) disposeSigner(signer);
        file.fill(0); password.fill(0); result?.stdout.fill(0); result?.stderr.fill(0);
      }
    },
  });
}
