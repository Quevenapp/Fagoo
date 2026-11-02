import { createHash } from 'node:crypto';
import { isValidCnpj } from '../../fiscal-core/src/identity.mjs';

export class VaultError extends Error {
  constructor(code) { super(code); this.name = 'VaultError'; this.code = code; }
}
export const need = (value, code) => { if (!value) throw new VaultError(code); };
export const safe = (error, code) => error instanceof VaultError ? error : new VaultError(code);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const MAX_PFX = 1024 * 1024;
export const MAX_ENVELOPE = 1500000;
export function exact(value, keys, code = 'VAULT_SHAPE_INVALID') {
  need(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  need(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
}
export function clock(now) {
  need(now instanceof Date && Number.isFinite(now.getTime()), 'VAULT_CLOCK_INVALID');
  return now.toISOString();
}
export function context(value) {
  exact(value, ['vault_id', 'credential_id', 'credential_version', 'company_identity_version', 'holder_cnpj', 'environment', 'purpose']);
  need(typeof value.vault_id === 'string' && typeof value.credential_id === 'string' && UUID.test(value.vault_id) && UUID.test(value.credential_id), 'VAULT_ID_INVALID');
  for (const field of ['credential_version', 'company_identity_version'])
    need(Number.isInteger(value[field]) && value[field] > 0 && value[field] <= 2147483647, 'VAULT_VERSION_INVALID');
  need(isValidCnpj(value.holder_cnpj), 'VAULT_HOLDER_INVALID');
  need(value.environment === '2' && value.purpose === 'offline-homologation', 'VAULT_OFFLINE_ONLY');
  return Object.fromEntries(['vault_id', 'credential_id', 'credential_version', 'company_identity_version', 'holder_cnpj', 'environment', 'purpose'].map(key => [key, value[key]]));
}
export function inputs(pfx, password) {
  need(pfx instanceof Uint8Array && pfx.length > 0 && pfx.length <= MAX_PFX, 'VAULT_PFX_SIZE_INVALID');
  need(password instanceof Uint8Array && password.length >= 1 && password.length <= 1024, 'VAULT_PASSWORD_INVALID');
  // OpenSSL's fd password reader is line-oriented; do not silently truncate these bytes.
  need(!password.some(byte => byte === 0 || byte === 10 || byte === 13), 'VAULT_PASSWORD_ENCODING_UNSUPPORTED');
  try { new TextDecoder('utf-8', { fatal: true }).decode(password); }
  catch { throw new VaultError('VAULT_PASSWORD_ENCODING_UNSUPPORTED'); }
}
export function key(bytes) {
  need(bytes instanceof Uint8Array && bytes.length === 32, 'VAULT_KEY_INVALID');
}
export function keyId(value) {
  need(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value), 'VAULT_KEY_ID_INVALID');
  return value;
}
export function b64(bytes) { return Buffer.from(bytes).toString('base64'); }
export function unb64(value, min, max) {
  need(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'VAULT_ENCODING_INVALID');
  const bytes = Buffer.from(value, 'base64');
  need(bytes.length >= min && bytes.length <= max && bytes.toString('base64') === value, 'VAULT_ENCODING_INVALID');
  return bytes;
}
