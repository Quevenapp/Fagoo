import { need, exact, uuid, sha256, route } from './protocol.mjs';
const ALG = { name: 'HMAC', hash: 'SHA-256' }, TEXT = new TextEncoder();
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function hex(bytes) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
function fromHex(value) { return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16)); }
function b64url(bytes) { let s = ''; for (const byte of bytes) s += String.fromCharCode(byte); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function unb64url(text) {
  need(/^[a-zA-Z0-9_-]{1,4000}$/.test(text), 401, 'A1_RUNTIME_UNAUTHORIZED');
  try { const s = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)); return Uint8Array.from(s, char => char.charCodeAt(0)); }
  catch { need(false, 401, 'A1_RUNTIME_UNAUTHORIZED'); }
}
function checkedClaims(value, { audience, method, path, now }) {
  need(exact(value, ['version', 'audience', 'actor', 'nonce', 'issued_at_ms', 'method', 'path', 'body_hash']) && value.version === 1 &&
    value.audience === audience && uuid(value.actor) && uuid(value.nonce) && sha256(value.body_hash) &&
    value.method === method && value.path === path && Number.isSafeInteger(value.issued_at_ms) &&
    value.issued_at_ms >= now - 60000 && value.issued_at_ms <= now + 5000, 401, 'A1_RUNTIME_UNAUTHORIZED');
  route(path, method); return value;
}
export async function signRuntimeRequest({ secretBytes, keyId, audience, actor, nonce, method, path, bodyHash, now = Date.now() }) {
  need(secretBytes instanceof Uint8Array && secretBytes.length === 32 && /^[a-zA-Z0-9_-]{1,64}$/.test(keyId) && typeof audience === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(audience), 500, 'A1_RUNTIME_CONFIGURATION_INVALID');
  const claims = checkedClaims({ version: 1, audience, actor, nonce, issued_at_ms: now, method, path, body_hash: bodyHash }, { audience, method, path, now });
  const encoded = b64url(TEXT.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', secretBytes, ALG, false, ['sign']);
  const signature = hex(new Uint8Array(await crypto.subtle.sign(ALG, key, TEXT.encode(`brufap-a1-request-v1.${keyId}.${encoded}`))));
  return `Brufap-A1 ${keyId}.${encoded}.${signature}`;
}
/** Header authentication can run before reading the body. The actual body hash is checked later. */
export async function verifyRuntimeRequest({ header, secretBytes, keyId, audience, method, path, now = Date.now() }) {
  need(typeof header === 'string' && header.length <= 4200 && secretBytes instanceof Uint8Array && secretBytes.length === 32, 401, 'A1_RUNTIME_UNAUTHORIZED');
  const match = /^Brufap-A1 ([a-zA-Z0-9_-]{1,64})\.([a-zA-Z0-9_-]{1,4000})\.([a-f0-9]{64})$/.exec(header);
  need(match && match[1] === keyId, 401, 'A1_RUNTIME_UNAUTHORIZED');
  const key = await crypto.subtle.importKey('raw', secretBytes, ALG, false, ['verify']);
  need(await crypto.subtle.verify(ALG, key, fromHex(match[3]), TEXT.encode(`brufap-a1-request-v1.${keyId}.${match[2]}`)), 401, 'A1_RUNTIME_UNAUTHORIZED');
  let claims;
  try { claims = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(unb64url(match[2]))); }
  catch { need(false, 401, 'A1_RUNTIME_UNAUTHORIZED'); }
  return checkedClaims(claims, { audience, method, path, now });
}
