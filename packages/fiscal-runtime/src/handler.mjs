import { createHmac } from 'node:crypto';
import { sealCredential, rewrapCredential, envelopeBytes, parseEnvelope } from '../../fiscal-vault/src/index.mjs';
import { context as checkedContext, VaultError } from '../../fiscal-vault/src/common.mjs';
import { RuntimeError, need, exact, route, readBounded, parseConfigure, parseCommand, CONFIGURE_TYPE, uuid, sha256 } from './protocol.mjs';
import { digest, verifyRuntimeRequest } from './auth.mjs';
import { FLAGS, publicResult, metadata, timestamp } from './dto.mjs';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' };
function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: HEADERS }); }
function rejectCode(error) {
  if (!(error instanceof VaultError)) return null;
  if (/EXPIRED/.test(error.code)) return 'CERTIFICATE_EXPIRED';
  if (/PASSWORD|PFX_SIZE|SHAPE|ID_INVALID/.test(error.code)) return 'CREDENTIAL_INPUT_INVALID';
  if (/UNSUPPORTED|MAC_REQUIRED/.test(error.code)) return 'UNSUPPORTED_PROFILE';
  if (/ENVELOPE|CONTEXT|KEY_ID|REWRAP/.test(error.code)) return 'ENVELOPE_INVALID';
  return 'CERTIFICATE_REJECTED';
}
export function requestFingerprint(secret, actor, selected, bytes) {
  need(secret instanceof Uint8Array && secret.length === 32, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  return createHmac('sha256', secret).update(JSON.stringify({ format: 'brufap-a1-command-v1', actor, action: selected.action, path: selected.path })).update('\0').update(bytes).digest('hex');
}
/** Configuration/custody only. There is deliberately no signing, XML or generic proxy route. */
export function createRuntimeHandler({ repository, loader, transportSecret, transportKeyId, audience, fingerprintSecret, keyring, currentKeyId, now = Date.now, concurrency = 2, bodyTimeoutMs = 10000 }) {
  need(repository && loader && transportSecret instanceof Uint8Array && transportSecret.length === 32 && fingerprintSecret instanceof Uint8Array && fingerprintSecret.length === 32 &&
    keyring instanceof Map && keyring.has(currentKeyId) && keyring.size >= 1 && keyring.size <= 5 && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  for (const [id, secret] of keyring) need(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) && secret instanceof Uint8Array && secret.length === 32, 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  let active = 0;
  return async request => {
    let bytes, selected, claims, payload, reservation, abort, timer;
    let admitted = false;
    try {
      const url = new URL(request.url);
      need(!url.search && !url.hash && !url.username && !url.password, 400, 'A1_INVALID_REQUEST');
      selected = route(url.pathname, request.method);
      claims = await verifyRuntimeRequest({ header: request.headers.get('authorization'), secretBytes: transportSecret, keyId: transportKeyId, audience, method: selected.method, path: selected.path, now: now() });
      need(active < concurrency, 503, 'A1_RUNTIME_BUSY'); active++; admitted = true;
      abort = new AbortController(); timer = setTimeout(() => abort.abort(), 45000);
      const opts = { signal: abort.signal }, actor = claims.actor;
      const authorization = await repository.rpc('authorize', { p_user_id: actor, p_action: selected.action, p_nonce: claims.nonce, p_issued_at: new Date(claims.issued_at_ms).toISOString() }, opts);
      need(authorization && Object.entries(FLAGS).every(([key, value]) => authorization[key] === value) && uuid(authorization.vault_id), 502, 'A1_RESPONSE_INVALID');
      if (selected.method === 'POST') need(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === (selected.action === 'configure' ? CONFIGURE_TYPE : 'application/json'), 415, 'A1_CONTENT_TYPE_UNSUPPORTED');
      bytes = await readBounded(request, { limit: selected.limit, timeoutMs: bodyTimeoutMs });
      need(await digest(bytes) === claims.body_hash, 401, 'A1_BODY_AUTHENTICATION_FAILED');
      if (selected.action === 'metadata' || selected.action === 'command') {
        const value = await repository.rpc(selected.action, { p_user_id: actor, ...(selected.commandId ? { p_command_id: selected.commandId } : {}) }, opts);
        return response(publicResult(value, { action: selected.action, commandId: selected.commandId }));
      }
      payload = selected.action === 'configure' ? parseConfigure(bytes) : parseCommand(bytes, selected.action);
      const requestHash = requestFingerprint(fingerprintSecret, actor, selected, bytes);
      const shared = { p_user_id: actor, p_command_id: payload.command_id, p_request_hash: requestHash, p_expected_version: payload.expected_version, p_reason: payload.reason };
      if (selected.action === 'disable') {
        const result = await repository.rpc('disable', shared, opts);
        return response(publicResult(result, { action: selected.action, commandId: payload.command_id }));
      }
      reservation = await repository.rpc('reserve', { ...shared, p_action: selected.action, p_expected_identity_version: payload.expected_identity_version }, opts);
      if (reservation?.state === 'committed' || reservation?.state === 'rejected') return response(publicResult(reservation, { action: selected.action, commandId: payload.command_id }));
      need(reservation?.state === 'reserved' && uuid(reservation.lease_id) && uuid(reservation.credential_id) && timestamp(reservation.lease_until) && Date.parse(reservation.lease_until) > now(), 502, 'A1_RESPONSE_INVALID');
      const ctx = checkedContext(reservation.context);
      need(ctx.vault_id === authorization.vault_id && ctx.credential_id === reservation.credential_id, 502, 'A1_RESPONSE_INVALID');
      let envelope;
      if (selected.action === 'configure') {
        need(authorization.company && ctx.holder_cnpj === authorization.company.cnpj && ctx.company_identity_version === payload.expected_identity_version && ctx.company_identity_version === authorization.company.identity_version && reservation.metadata === null && reservation.source_object === null, 409, 'A1_COMPANY_CHANGED');
        envelope = await sealCredential({ pfxBytes: payload.pfxBytes, passwordBytes: payload.passwordBytes, context: ctx, kekBytes: keyring.get(currentKeyId), keyId: currentKeyId, loader, now: new Date(now()) });
      } else {
        const source = reservation.source_object;
        need(source && exact(source, ['bucket', 'path', 'hash', 'size', 'key_id']) && sha256(source.hash) && source.path === `credentials/${ctx.credential_id}/${source.hash}.json` && keyring.has(source.key_id) && source.key_id !== currentKeyId, 409, 'A1_KEY_ROTATION_UNAVAILABLE');
        const previousBytes = await repository.readObject(source, opts);
        try {
          const previous = parseEnvelope(previousBytes);
          need(JSON.stringify(previous.metadata) === JSON.stringify(metadata(reservation.metadata)) && previous.key_id === source.key_id, 502, 'A1_STORAGE_VALIDATION_FAILED');
          envelope = rewrapCredential({ envelope: previous, expectedContext: ctx, expectedEnvelopeHash: source.hash, oldKekBytes: keyring.get(source.key_id), newKekBytes: keyring.get(currentKeyId), newKeyId: currentKeyId });
        } finally { previousBytes.fill(0); }
      }
      need(!abort.signal.aborted && Date.parse(reservation.lease_until) > now(), 409, 'A1_LEASE_EXPIRED');
      const encrypted = envelopeBytes(envelope); let stored;
      try { stored = await repository.storeObject(ctx.credential_id, encrypted, opts); }
      finally { encrypted.fill(0); }
      need(!abort.signal.aborted && Date.parse(reservation.lease_until) > now(), 409, 'A1_LEASE_EXPIRED');
      // From this point all failures are potentially committed: never turn them into a rejected command.
      const lease = reservation.lease_id; reservation = null;
      const result = await repository.rpc('finalize', { p_user_id: actor, p_command_id: payload.command_id, p_lease_id: lease, p_metadata: envelope.metadata, p_object_hash: stored.hash, p_size_bytes: stored.size, p_key_id: envelope.key_id }, opts);
      return response(publicResult(result, { action: selected.action, commandId: payload.command_id }));
    } catch (error) {
      const code = rejectCode(error);
      if (code && reservation?.state === 'reserved' && claims && payload && !abort?.signal.aborted) {
        try {
          const result = await repository.rpc('reject', { p_user_id: claims.actor, p_command_id: payload.command_id, p_lease_id: reservation.lease_id, p_error_code: code }, { signal: abort.signal });
          return response(publicResult(result, { action: selected.action, commandId: payload.command_id }));
        } catch { /* A rejected-response loss remains recoverable using the unchanged command ID. */ }
      }
      return response({ error: error instanceof RuntimeError ? error.code : code ? 'A1_CREDENTIAL_REJECTED' : 'A1_RUNTIME_FAILED', recovery_required: Boolean(payload?.command_id) }, error instanceof RuntimeError ? error.status : code ? 422 : 500);
    } finally {
      clearTimeout(timer); abort?.abort(); bytes?.fill(0); if (admitted) active--;
    }
  };
}
