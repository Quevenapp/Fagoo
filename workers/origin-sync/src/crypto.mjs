const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const associatedData = encoder.encode('brufap:origin-sync:tokens:v1');

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value, code) {
  if (typeof value !== 'string' || !value || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(code);
  }
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if (encodeBase64(bytes) !== value) throw new Error();
    return bytes;
  } catch {
    throw new Error(code);
  }
}

async function importKey(base64key, usage) {
  const bytes = decodeBase64(base64key, 'INVALID_ENCRYPTION_KEY');
  if (bytes.length !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  return globalThis.crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
}

function isTokenObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function encryptTokens(tokens, base64key) {
  const key = await importKey(base64key, 'encrypt');
  if (!isTokenObject(tokens)) throw new Error('INVALID_TOKEN_PAYLOAD');
  try {
    const plaintext = encoder.encode(JSON.stringify(tokens));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData, tagLength: 128 }, key, plaintext,
    );
    return { iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(encrypted)), version: 1 };
  } catch {
    throw new Error('TOKEN_ENCRYPT_FAILED');
  }
}

export async function decryptTokens(envelope, base64key) {
  const key = await importKey(base64key, 'decrypt');
  if (!envelope || envelope.version !== 1) throw new Error('INVALID_TOKEN_ENVELOPE');
  const iv = decodeBase64(envelope.iv, 'INVALID_TOKEN_ENVELOPE');
  const ciphertext = decodeBase64(envelope.ciphertext, 'INVALID_TOKEN_ENVELOPE');
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error('INVALID_TOKEN_ENVELOPE');
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: associatedData, tagLength: 128 }, key, ciphertext,
    );
    const tokens = JSON.parse(decoder.decode(plaintext));
    if (!isTokenObject(tokens)) throw new Error();
    return tokens;
  } catch {
    throw new Error('TOKEN_DECRYPT_FAILED');
  }
}

export async function sha256(text) {
  if (typeof text !== 'string') throw new Error('INVALID_HASH_INPUT');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return encodeBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
