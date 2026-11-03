import { need, exact, uuid, sha256, version } from './protocol.mjs';
export const FLAGS = Object.freeze({ data_mode: 'a1_custody', environment: '2', purpose: 'offline-homologation', can_emit: false, can_transmit: false });
export const REJECTIONS = Object.freeze(['CREDENTIAL_INPUT_INVALID', 'CERTIFICATE_REJECTED', 'CERTIFICATE_EXPIRED', 'HOLDER_MISMATCH', 'UNSUPPORTED_PROFILE', 'ENVELOPE_INVALID', 'STORAGE_VALIDATION_FAILED']);
const bad = condition => need(condition, 502, 'A1_RESPONSE_INVALID');
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value)) return false;
  const time = Date.parse(value); if (!Number.isFinite(time)) return false;
  const zone = /([+-])(\d{2}):(\d{2})$/.exec(value), offset = zone ? (zone[1] === '+' ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3])) : 0;
  return new Date(time + offset * 60000).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function metadata(value) {
  const fields = ['profile', 'legacy_provider_enabled', 'pfx_mac', 'pfx_mac_iterations', 'fingerprint_sha256', 'holder_cnpj', 'not_before', 'not_after', 'rsa_bits', 'presented_chain', 'validated_at', 'key_matches_certificate', 'presented_chain_links_checked', 'icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'client_auth_eku_verified', 'can_transmit'];
  bad(exact(value, fields) && value.profile === 'openssl3-pkcs12' && typeof value.legacy_provider_enabled === 'boolean' &&
    ['sha1', 'sha224', 'sha256', 'sha384', 'sha512'].includes(value.pfx_mac) && Number.isInteger(value.pfx_mac_iterations) && value.pfx_mac_iterations >= 1 && value.pfx_mac_iterations <= 1000000 &&
    sha256(value.fingerprint_sha256) && typeof value.holder_cnpj === 'string' && /^[A-Z0-9]{12}[0-9]{2}$/.test(value.holder_cnpj) &&
    [2048, 3072, 4096].includes(value.rsa_bits) && ['not_before', 'not_after', 'validated_at'].every(key => timestamp(value[key])));
  bad(Date.parse(value.not_before) <= Date.parse(value.validated_at) && Date.parse(value.validated_at) <= Date.parse(value.not_after));
  bad(Array.isArray(value.presented_chain) && value.presented_chain.length >= 1 && value.presented_chain.length <= 10 &&
    value.presented_chain.every(sha256) && new Set(value.presented_chain).size === value.presented_chain.length && value.presented_chain[0] === value.fingerprint_sha256);
  bad(value.key_matches_certificate === true && value.presented_chain_links_checked === true &&
    ['icp_brasil_chain_validated', 'revocation_checked', 'a1_policy_verified', 'client_auth_eku_verified', 'can_transmit'].every(key => value[key] === false));
  return Object.fromEntries(fields.map(key => [key, key === 'presented_chain' ? [...value[key]] : value[key]]));
}
export function current(value) {
  bad(exact(value, ['version', 'state', 'credential_id', 'company_identity_version', 'metadata', 'company_changed', 'time_valid_now']) &&
    version(value.version) && ['unconfigured', 'disabled', 'configured_offline'].includes(value.state) &&
    typeof value.company_changed === 'boolean' && typeof value.time_valid_now === 'boolean');
  const configured = value.state === 'configured_offline';
  bad(configured ? uuid(value.credential_id) && version(value.company_identity_version, 1) : value.credential_id === null && value.company_identity_version === null && value.metadata === null && value.time_valid_now === false);
  bad(value.state !== 'unconfigured' || value.version === 0);
  return { ...value, metadata: configured ? metadata(value.metadata) : null };
}
export function receipt(value) {
  bad(exact(value, ['command_id', 'action', 'version', 'state', 'credential_id', 'company_identity_version', 'metadata', 'recorded_at']) && uuid(value.command_id) &&
    ['configure', 'rewrap', 'disable'].includes(value.action) && version(value.version, 1) && timestamp(value.recorded_at));
  bad(value.action === 'disable' ? value.state === 'disabled' && value.credential_id === null && value.company_identity_version === null && value.metadata === null :
    value.state === 'configured_offline' && uuid(value.credential_id) && version(value.company_identity_version, 1));
  return { ...value, metadata: value.metadata === null ? null : metadata(value.metadata) };
}
/** Explicit whitelist: internal lease IDs, paths, ciphertext, object hashes and key IDs never leave here. */
export function publicResult(value, { action, commandId } = {}) {
  bad(value && typeof value === 'object' && Object.entries(FLAGS).every(([key, expected]) => value[key] === expected));
  const result = { ...FLAGS, current: current(value.current) };
  if (action === 'metadata') return result;
  bad(['pending', 'committed', 'rejected'].includes(value.state));
  result.state = value.state;
  result.receipt = value.state === 'committed' ? receipt(value.receipt) : null;
  result.error_code = value.state === 'rejected' ? value.error_code : null;
  bad(result.error_code === null || REJECTIONS.includes(result.error_code));
  if (result.receipt) {
    bad(result.receipt.command_id === commandId && (action === 'command' || result.receipt.action === action) && result.receipt.version <= result.current.version);
  }
  if (action !== 'command') { bad(typeof value.replayed === 'boolean'); result.replayed = value.replayed; }
  return result;
}
