import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecureContext } from 'node:tls';
import { disposeSigner } from '../../fiscal-xml/src/index.mjs';
import { need, safe, exact, context, clock, inputs, key, keyId, b64, unb64, hash, HASH, MAX_PFX, MAX_ENVELOPE } from './common.mjs';

const FORMAT = 'brufap-a1-envelope-v1';
const ALGORITHM = 'AES-256-GCM';
const METADATA = ['profile', 'legacy_provider_enabled', 'pfx_mac', 'pfx_mac_iterations', 'fingerprint_sha256', 'holder_cnpj', 'not_before', 'not_after', 'rsa_bits', 'presented_chain', 'validated_at', 'key_matches_certificate', 'presented_chain_links_checked', 'icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'client_auth_eku_verified', 'can_transmit'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function metadata(value, ctx) {
  exact(value, METADATA);
  need(value.profile === 'openssl3-pkcs12' && typeof value.legacy_provider_enabled === 'boolean', 'VAULT_METADATA_INVALID');
  need(['sha1', 'sha224', 'sha256', 'sha384', 'sha512'].includes(value.pfx_mac) && Number.isInteger(value.pfx_mac_iterations) && value.pfx_mac_iterations >= 1 && value.pfx_mac_iterations <= 1000000, 'VAULT_METADATA_INVALID');
  need(typeof value.fingerprint_sha256 === 'string' && HASH.test(value.fingerprint_sha256) && value.holder_cnpj === ctx.holder_cnpj, 'VAULT_METADATA_INVALID');
  for (const field of ['not_before', 'not_after', 'validated_at'])
    need(typeof value[field] === 'string' && ISO.test(value[field]) && new Date(value[field]).toISOString() === value[field], 'VAULT_METADATA_INVALID');
  need(value.not_before <= value.validated_at && value.validated_at <= value.not_after && [2048, 3072, 4096].includes(value.rsa_bits), 'VAULT_METADATA_INVALID');
  need(Array.isArray(value.presented_chain) && value.presented_chain.length >= 1 && value.presented_chain.length <= 10 &&
    value.presented_chain.every(value => typeof value === 'string' && HASH.test(value)) &&
    new Set(value.presented_chain).size === value.presented_chain.length && value.presented_chain[0] === value.fingerprint_sha256, 'VAULT_METADATA_INVALID');
  need(value.key_matches_certificate === true && value.presented_chain_links_checked === true &&
    ['icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'client_auth_eku_verified', 'can_transmit'].every(field => value[field] === false), 'VAULT_METADATA_INVALID');
  return Object.fromEntries(METADATA.map(field => [field, field === 'presented_chain' ? [...value[field]] : value[field]]));
}
function piece(value, min, max) {
  exact(value, ['iv', 'ciphertext', 'tag']);
  const iv = unb64(value.iv, 12, 12), ciphertext = unb64(value.ciphertext, min, max), tag = unb64(value.tag, 16, 16);
  return { iv, ciphertext, tag };
}
function checked(value, expectedContext) {
  exact(value, ['format', 'algorithm', 'context', 'metadata', 'key_id', 'wrapped_key', 'payload']);
  need(value.format === FORMAT && value.algorithm === ALGORITHM, 'VAULT_FORMAT_UNSUPPORTED');
  const ctx = context(value.context), expected = context(expectedContext);
  need(JSON.stringify(ctx) === JSON.stringify(expected), 'VAULT_CONTEXT_MISMATCH');
  const meta = metadata(value.metadata, ctx);
  return { format: FORMAT, algorithm: ALGORITHM, context: ctx, metadata: meta, key_id: keyId(value.key_id),
    wrapped_key: { ...value.wrapped_key }, payload: { ...value.payload } };
}
const aad = (envelope, purpose) => Buffer.from(JSON.stringify({ format: FORMAT, algorithm: ALGORITHM,
  context: envelope.context, metadata: envelope.metadata, purpose,
  ...(purpose === 'wrap-dek' ? { key_id: envelope.key_id } : {}),
}), 'utf8');
function encrypt(plaintext, secret, associated) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv, { authTagLength: 16 });
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
}
function decrypt(value, secret, associated, min, max) {
  const p = piece(value, min, max), decipher = createDecipheriv('aes-256-gcm', secret, p.iv, { authTagLength: 16 });
  decipher.setAAD(associated); decipher.setAuthTag(p.tag);
  // Do not return any unauthenticated plaintext from update() before final().
  let partial;
  try { partial = decipher.update(p.ciphertext); return Buffer.concat([partial, decipher.final()]); }
  finally { partial?.fill(0); }
}
function pack(file, password) {
  const payload = Buffer.alloc(8 + file.length + password.length);
  payload.writeUInt32BE(file.length, 0); payload.writeUInt32BE(password.length, 4);
  payload.set(file, 8); payload.set(password, 8 + file.length); return payload;
}
function unpack(bytes) {
  need(bytes.length >= 10, 'VAULT_PAYLOAD_INVALID');
  const fileLength = bytes.readUInt32BE(0), passwordLength = bytes.readUInt32BE(4);
  need(bytes.length === 8 + fileLength + passwordLength, 'VAULT_PAYLOAD_INVALID');
  const pfxBytes = bytes.subarray(8, 8 + fileLength), passwordBytes = bytes.subarray(8 + fileLength);
  inputs(pfxBytes, passwordBytes); return { pfxBytes, passwordBytes };
}
export function envelopeBytes(value) {
  // Validates structural metadata; integrity requires a KEK and expected context.
  const e = checked(value, value.context); piece(e.wrapped_key, 32, 32); piece(e.payload, 10, MAX_PFX + 1032);
  const result = Buffer.from(JSON.stringify(e), 'utf8');
  need(result.length <= MAX_ENVELOPE, 'VAULT_ENVELOPE_SIZE_INVALID'); return result;
}
export function parseEnvelope(bytes) {
  need(bytes instanceof Uint8Array && bytes.length >= 1 && bytes.length <= MAX_ENVELOPE, 'VAULT_ENVELOPE_SIZE_INVALID');
  try { const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); envelopeBytes(value); return value; }
  catch (error) { throw safe(error, 'VAULT_ENVELOPE_INVALID'); }
}
export function envelopeHash(value) { return hash(envelopeBytes(value)); }

/** Validates credentials before sealing, and disposes all material before returning ciphertext. */
export async function sealCredential({ pfxBytes, passwordBytes, context: ctx, kekBytes, keyId: id, loader, now = new Date() } = {}) {
  inputs(pfxBytes, passwordBytes); key(kekBytes); keyId(id); ctx = context(ctx); clock(now);
  need(loader && typeof loader.load === 'function', 'VAULT_LOADER_REQUIRED');
  // Caller-owned arrays and Date may change while the subprocess is running.
  const file = Buffer.from(pfxBytes), password = Buffer.from(passwordBytes), kek = Buffer.from(kekBytes), at = new Date(now.getTime());
  let loaded, plaintext, dek;
  try {
    loaded = await loader.load({ pfxBytes: file, passwordBytes: password, expectedHolderCnpj: ctx.holder_cnpj, purpose: ctx.purpose, now: at });
    const e = { format: FORMAT, algorithm: ALGORITHM, context: ctx, metadata: metadata(loaded.metadata, ctx), key_id: id };
    plaintext = pack(file, password); dek = randomBytes(32);
    e.payload = encrypt(plaintext, dek, aad(e, 'credential-payload'));
    e.wrapped_key = encrypt(dek, kek, aad(e, 'wrap-dek'));
    return JSON.parse(envelopeBytes(e).toString('utf8'));
  } catch (error) { throw safe(error, 'VAULT_SEAL_FAILED'); }
  finally { if (loaded?.signer) disposeSigner(loaded.signer); plaintext?.fill(0); dek?.fill(0); file.fill(0); password.fill(0); kek.fill(0); }
}

/** Internal trusted callback, not a generic signing API. No decrypted credentials are returned. */
export async function withCredential({ envelope, expectedContext, kekBytes, expectedKeyId, loader, now = new Date() } = {}, action) {
  key(kekBytes); clock(now); keyId(expectedKeyId);
  need(typeof action === 'function' && loader && typeof loader.load === 'function', 'VAULT_ACTION_REQUIRED');
  const at = new Date(now.getTime());
  let dek, plaintext, loaded;
  try {
    const e = checked(envelope, expectedContext);
    need(e.key_id === expectedKeyId, 'VAULT_KEY_ID_MISMATCH');
    dek = decrypt(e.wrapped_key, kekBytes, aad(e, 'wrap-dek'), 32, 32);
    plaintext = decrypt(e.payload, dek, aad(e, 'credential-payload'), 10, MAX_PFX + 1032);
    const credential = unpack(plaintext);
    loaded = await loader.load({ ...credential, expectedHolderCnpj: e.context.holder_cnpj, now: at, purpose: e.context.purpose });
    const meta = metadata(loaded.metadata, e.context);
    need(meta.fingerprint_sha256 === e.metadata.fingerprint_sha256 && JSON.stringify(meta.presented_chain) === JSON.stringify(e.metadata.presented_chain), 'VAULT_CERTIFICATE_MISMATCH');
    return await action(loaded.signer);
  } catch (error) { throw safe(error, 'VAULT_OPEN_OR_ACTION_FAILED'); }
  finally { if (loaded?.signer) disposeSigner(loaded.signer); plaintext?.fill(0); dek?.fill(0); }
}

const WSDL_PURPOSE = 'sefaz-sp-wsdl-readonly-v1';
const WSDL_KEYS = ['envelope', 'expectedEnvelopeHash', 'expectedContext', 'kekBytes', 'expectedKeyId', 'loader', 'purpose', 'now', 'signal', 'deadline'];
const WSDL_METADATA = ['fingerprint_sha256', 'holder_cnpj', 'not_before', 'not_after', 'client_auth_usage',
  'presented_chain_links_checked', 'icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'can_emit', 'can_transmit'];
function wsdlValues(value, allowed, required = allowed) {
  need(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'VAULT_WSDL_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  need(keys.every(k => typeof k === 'string' && allowed.includes(k) && Object.hasOwn(descriptors[k], 'value')) &&
    required.every(k => Object.hasOwn(descriptors, k)), 'VAULT_WSDL_INPUT_INVALID');
  return Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
}
// Snapshot data without invoking accessors/toJSON or retaining caller-owned objects.
function wsdlData(value, depth = 0, budget = {nodes:0, characters:0}) {
  need(depth <= 5 && ++budget.nodes <= 128, 'VAULT_WSDL_INPUT_INVALID');
  if (typeof value === 'string') {
    budget.characters += value.length;
    need(budget.characters <= MAX_ENVELOPE, 'VAULT_ENVELOPE_SIZE_INVALID'); return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  need(value && typeof value === 'object', 'VAULT_WSDL_INPUT_INVALID');
  const array = Array.isArray(value);
  need(array ? Object.getPrototypeOf(value) === Array.prototype : [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'VAULT_WSDL_INPUT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  need(keys.length <= 32 && keys.every(k => typeof k === 'string' && Object.hasOwn(descriptors[k], 'value')), 'VAULT_WSDL_INPUT_INVALID');
  if (array) {
    need(value.length <= 10 && keys.length === value.length + 1 && keys.every(k => k === 'length' || /^(?:0|[1-9][0-9]*)$/.test(k)), 'VAULT_WSDL_INPUT_INVALID');
    return Array.from({length:value.length}, (_, i) => wsdlData(descriptors[i]?.value, depth + 1, budget));
  }
  return Object.fromEntries(keys.map(k => [k, wsdlData(descriptors[k].value, depth + 1, budget)]));
}

/**
 * Internal fixed-purpose opening of the unchanged 041 offline envelope/AAD.
 * This helper grants no SQL authorization and performs no network request. Its
 * trusted loader and callback must not retain the temporary TLS context, and
 * must close any sockets when the scoped signal aborts. Native TLS memory is
 * outside the byte-buffer wiping guarantee. No credential or result is returned.
 */
async function withTlsCredential(options, action, purpose, maxMilliseconds) {
  let kek, dek, plaintext, controller, timer, signal, onAbort, stopListener;
  let active = true, calls = 0, completed = false, violated = false, callbackError, stopCode = 'VAULT_WSDL_TIMEOUT';
  try {
    const value = wsdlValues(options, WSDL_KEYS, WSDL_KEYS.filter(k => !['now', 'signal', 'deadline'].includes(k)));
    need(value.purpose === purpose && typeof action === 'function', 'VAULT_WSDL_PURPOSE_INVALID');
    key(value.kekBytes); keyId(value.expectedKeyId);
    need(typeof value.expectedEnvelopeHash === 'string' && HASH.test(value.expectedEnvelopeHash), 'VAULT_HASH_REQUIRED');
    const load = value.loader?.withContext;
    need(typeof load === 'function', 'VAULT_ACTION_REQUIRED');
    const at = value.now ?? new Date(); clock(at);
    const now = new Date(at.getTime()), deadline = value.deadline ?? Date.now() + 20000;
    need(Number.isSafeInteger(deadline) && deadline > Date.now() && deadline <= Date.now() + maxMilliseconds, 'VAULT_WSDL_DEADLINE_INVALID');
    need(value.signal === undefined || value.signal instanceof AbortSignal, 'VAULT_WSDL_SIGNAL_INVALID');
    signal = value.signal; kek = Buffer.from(value.kekBytes);
    const e = checked(wsdlData(value.envelope), wsdlData(value.expectedContext));
    need(e.key_id === value.expectedKeyId, 'VAULT_KEY_ID_MISMATCH');
    need(envelopeHash(e) === value.expectedEnvelopeHash, 'VAULT_ENVELOPE_CONFLICT');
    controller = new AbortController();
    onAbort = () => { stopCode = 'VAULT_WSDL_ABORTED'; controller.abort(); };
    signal?.addEventListener('abort', onAbort, {once:true}); if (signal?.aborted) onAbort();
    const check = () => { need(active && !controller.signal.aborted, stopCode); need(Date.now() < deadline, 'VAULT_WSDL_TIMEOUT'); };
    check(); timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    dek = decrypt(e.wrapped_key, kek, aad(e, 'wrap-dek'), 32, 32);
    plaintext = decrypt(e.payload, dek, aad(e, 'credential-payload'), 10, MAX_PFX + 1032);
    const credential = unpack(plaintext); check();
    const stopped = new Promise((_, reject) => {
      stopListener = () => { try { check(); } catch (error) { reject(error); } };
      controller.signal.addEventListener('abort', stopListener, {once:true});
    });
    const execute = Promise.resolve().then(() => {
      check();
      return load.call(value.loader, {...credential, expectedHolderCnpj:e.context.holder_cnpj,
        expectedFingerprint:e.metadata.fingerprint_sha256, now, purpose, signal:controller.signal, deadline}, scope => {
        const callback = (async () => {
          check();
          if (calls++) { violated = true; need(false, 'VAULT_WSDL_CALLBACK_INVALID'); }
          const scoped = wsdlValues(scope, ['secureContext', 'metadata', 'signal', 'deadline']);
          const meta = wsdlValues(scoped.metadata, WSDL_METADATA);
          need(scoped.secureContext instanceof SecureContext && scoped.signal instanceof AbortSignal && !scoped.signal.aborted && scoped.deadline === deadline, 'VAULT_WSDL_CALLBACK_INVALID');
          need(meta.fingerprint_sha256 === e.metadata.fingerprint_sha256 && meta.holder_cnpj === e.context.holder_cnpj &&
            meta.not_before === e.metadata.not_before && meta.not_after === e.metadata.not_after &&
            ['unrestricted_absent', 'explicit_client_auth', 'unrestricted_any'].includes(meta.client_auth_usage) &&
            meta.presented_chain_links_checked === true &&
            ['icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'can_emit', 'can_transmit'].every(k => meta[k] === false), 'VAULT_CERTIFICATE_MISMATCH');
          const result = await action(Object.freeze({secureContext:scoped.secureContext, metadata:Object.freeze(meta), signal:controller.signal, deadline}));
          check(); need(!scoped.signal.aborted, 'VAULT_WSDL_ABORTED');
          need(result === undefined, 'VAULT_WSDL_ACTION_MUST_RETURN_VOID'); completed = true;
        })();
        // A misbehaving injected loader must not create an unhandled rejection.
        callback.catch(error => { callbackError = error; }); return callback;
      });
    }).then(result => {
      check(); if (callbackError) throw callbackError;
      need(result === undefined && calls === 1 && completed && !violated, 'VAULT_WSDL_CALLBACK_INVALID');
    });
    await Promise.race([execute, stopped]); check();
  } catch (error) {
    if (controller?.signal.aborted) need(false, stopCode);
    throw safe(error, 'VAULT_WSDL_OPEN_OR_ACTION_FAILED');
  } finally {
    active = false; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    controller?.signal.removeEventListener('abort', stopListener); controller?.abort();
    plaintext?.fill(0); dek?.fill(0); kek?.fill(0);
  }
}

/** Existing WSDL-only API; its purpose and 30s ceiling remain unchanged. */
export async function withWsdlCredential(options, action) {
  return withTlsCredential(options, action, WSDL_PURPOSE, 30000);
}

/**
 * Private 062 protocol opening. The 041 context/AAD stays offline-homologation.
 * This grants no SQL authorization, chooses no destination and performs no IO.
 * A trusted custody port must reauthorize preparation, then consume use062
 * before any handshake inside the awaited void callback. Not exported by index.
 */
export async function withProtocolCredential(options, action) {
  try { return await withTlsCredential(options, action, 'sefaz-sp-protocol-homologation-v1', 20000); }
  catch (error) {
    // Share the cryptographic implementation without mislabelling the new scope.
    if (typeof error?.code === 'string' && error.code.startsWith('VAULT_WSDL_'))
      need(false, error.code.replace('VAULT_WSDL_', 'VAULT_PROTOCOL_'));
    throw safe(error, 'VAULT_PROTOCOL_OPEN_OR_ACTION_FAILED');
  }
}

/** Private authorization opening. Preserves the authenticated 041 envelope/AAD.
 * Preparation and single-use069 are responsibilities of the backend custody and
 * service, respectively. This entrypoint performs no network or grant operation.
 */
export async function withAuthorizationCredential(options, action) {
  try { return await withTlsCredential(options, action, 'sp-authorization-homologation-v1', 20000); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('VAULT_WSDL_'))
      need(false, error.code.replace('VAULT_WSDL_', 'VAULT_AUTHORIZATION_'));
    throw safe(error, 'VAULT_AUTHORIZATION_OPEN_OR_ACTION_FAILED');
  }
}

/** Private089 receipt-query scope. The authenticated041 envelope/AAD remains
 * unchanged. SQL use089 and its single POST are enforced by the dedicated backend.
 * No alternate purpose is accepted and this entrypoint is not exported by index.
 */
export async function withReceiptQueryCredential(options, action) {
  try { return await withTlsCredential(options, action, 'sp-receipt-query-homologation-v1', 20000); }
  catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('VAULT_WSDL_'))
      need(false, error.code.replace('VAULT_WSDL_', 'VAULT_RECEIPT_QUERY_'));
    throw safe(error, 'VAULT_RECEIPT_QUERY_OPEN_OR_ACTION_FAILED');
  }
}

/** Rewrap changes the KEK only. Storage must additionally CAS the old envelope hash/head. */
export function rewrapCredential({ envelope, expectedContext, expectedEnvelopeHash, oldKekBytes, newKekBytes, newKeyId } = {}) {
  key(oldKekBytes); key(newKekBytes); keyId(newKeyId);
  need(typeof expectedEnvelopeHash === 'string' && HASH.test(expectedEnvelopeHash), 'VAULT_HASH_REQUIRED');
  let dek, plaintext;
  try {
    const e = checked(envelope, expectedContext);
    need(envelopeHash(e) === expectedEnvelopeHash, 'VAULT_ENVELOPE_CONFLICT');
    need(e.key_id !== newKeyId, 'VAULT_NEW_KEY_ID_REQUIRED');
    dek = decrypt(e.wrapped_key, oldKekBytes, aad(e, 'wrap-dek'), 32, 32);
    // Reject corrupted payloads before rotating the wrapping key; never emit a repaired-looking envelope.
    plaintext = decrypt(e.payload, dek, aad(e, 'credential-payload'), 10, MAX_PFX + 1032); unpack(plaintext);
    e.key_id = newKeyId; e.wrapped_key = encrypt(dek, newKekBytes, aad(e, 'wrap-dek'));
    return JSON.parse(envelopeBytes(e).toString('utf8'));
  } catch (error) { throw safe(error, 'VAULT_REWRAP_FAILED'); }
  finally { dek?.fill(0); plaintext?.fill(0); }
}
