/** Private, optional diagnostics. Never part of a SQL receipt or public DTO. */
const PHASES = new Set(['input_validation', 'key_selection', 'authorization_replay',
  'encrypted_object_read', 'encrypted_object_validation', 'envelope_validation',
  'envelope_open', 'pkcs12_validation', 'certificate_binding', 'tls_local', 'callback_validation']);
const CODES = new Map([
  ['42501', 'authorization_denied'], ['40001', 'context_conflict'], ['55000', 'context_unavailable'],
  ['P0002', 'not_found'], ['22023', 'input_rejected'],
  ['WSDL_CUSTODY_PREPARATION_INVALID', 'input_rejected'], ['WSDL_CUSTODY_OPTIONS_INVALID', 'input_rejected'],
  ['WSDL_CUSTODY_CLOCK_INVALID', 'clock_invalid'], ['WSDL_CUSTODY_LEASE_EXPIRED', 'lease_invalid'],
  ['WSDL_CUSTODY_CERTIFICATE_EXPIRED', 'certificate_time_invalid'],
  ['WSDL_CUSTODY_KEY_UNAVAILABLE', 'key_unavailable'],
  ['WSDL_CUSTODY_AUTHORIZATION_REJECTED', 'authorization_rejected'],
  ['WSDL_CUSTODY_PREPARATION_CHANGED', 'context_conflict'],
  ['WSDL_CUSTODY_OBJECT_INVALID', 'object_integrity_invalid'],
  ['WSDL_CUSTODY_ENVELOPE_INVALID', 'envelope_invalid'],
  ['WSDL_CUSTODY_ENVELOPE_CONFLICT', 'envelope_binding_invalid'],
  ['WSDL_CUSTODY_TIMEOUT', 'deadline_exceeded'], ['WSDL_CUSTODY_ABORTED', 'aborted'],
  ['WSDL_CUSTODY_CALLBACK_INVALID', 'callback_invalid'],
  ['A1_UPSTREAM_UNAVAILABLE', 'object_io_unavailable'], ['A1_FORBIDDEN', 'object_access_denied'],
  ['A1_NOT_FOUND', 'object_missing'], ['A1_STORAGE_VALIDATION_FAILED', 'object_integrity_invalid'],
  ['A1_STORAGE_REFERENCE_INVALID', 'object_reference_invalid'],
  ['WSDL_RPC_TIMEOUT', 'deadline_exceeded'], ['WSDL_RPC_ABORTED', 'aborted'],
  ['WSDL_RPC_IO_FAILED', 'authorization_io_unavailable'], ['WSDL_RPC_HTTP_REJECTED', 'authorization_http_rejected'],
  ['WSDL_RPC_RESPONSE_INVALID', 'authorization_response_invalid'], ['WSDL_RPC_BODY_INVALID', 'authorization_response_invalid'],
  ['WSDL_RPC_BODY_LIMIT', 'authorization_response_invalid'], ['WSDL_RPC_JSON_INVALID', 'authorization_response_invalid'],
  ['WSDL_SERVICE_RESPONSE_INVALID', 'authorization_response_invalid'],
  ['WSDL_SERVICE_PREPARATION_STALE', 'context_conflict'],
  ['VAULT_WSDL_OPEN_OR_ACTION_FAILED', 'credential_open_rejected'],
  ['VAULT_OPENSSL_UNAVAILABLE', 'pkcs12_process_unavailable'], ['VAULT_OPENSSL_OUTPUT_LIMIT', 'pkcs12_output_limit'],
  ['VAULT_OPENSSL_TIMEOUT', 'deadline_exceeded'], ['VAULT_OPENSSL_ABORTED', 'aborted'],
  ['VAULT_PFX_REJECTED', 'pkcs12_rejected'], ['VAULT_PFX_MAC_REQUIRED_OR_UNSUPPORTED', 'pkcs12_integrity_profile_rejected'],
  ['VAULT_UNENCRYPTED_KEY_BAG_REJECTED', 'pkcs12_key_profile_rejected'], ['VAULT_PEM_INVALID', 'pkcs12_material_invalid'],
  ['VAULT_SINGLE_KEY_REQUIRED', 'pkcs12_key_profile_rejected'], ['VAULT_DUPLICATE_CERTIFICATE', 'certificate_chain_rejected'],
  ['VAULT_KEY_LEAF_MISMATCH', 'certificate_binding_invalid'],
  ['VAULT_PRESENTED_CHAIN_AMBIGUOUS_OR_UNRELATED', 'certificate_chain_rejected'],
  ['VAULT_PRESENTED_CHAIN_EXPIRED', 'certificate_time_invalid'], ['VAULT_CREDENTIAL_REJECTED', 'credential_rejected'],
  ['VAULT_CERTIFICATE_MISMATCH', 'certificate_binding_invalid'],
  ['VAULT_TLS_CERTIFICATE_MISMATCH', 'certificate_binding_invalid'],
  ['VAULT_TLS_CLIENT_USAGE_EXCLUDED', 'certificate_usage_rejected'],
  ['VAULT_TLS_CONTEXT_CREATION_FAILED', 'tls_context_creation_failed'],
  ['VAULT_TLS_CONTEXT_FACTORY_INVALID', 'tls_context_invalid'],
  ['VAULT_TLS_TIMEOUT', 'deadline_exceeded'], ['VAULT_TLS_ABORTED', 'aborted'],
  ['VAULT_WSDL_TIMEOUT', 'deadline_exceeded'], ['VAULT_WSDL_ABORTED', 'aborted'],
]);

function codeOf(error) {
  // Do not inspect message, stack, cause, name, prototype fields or toJSON.
  try {
    if (!error || typeof error !== 'object') return undefined;
    const d = Object.getOwnPropertyDescriptor(error, 'code');
    return d && Object.hasOwn(d, 'value') && typeof d.value === 'string' && d.value.length <= 80 ? d.value : undefined;
  } catch { return undefined; }
}

/** One bounded JSON line per failed pre-callback preparation; no identifiers. */
export function createWsdlPreparationDiagnostic(observer, now = () => performance.now()) {
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : 0; } catch { return 0; } };
  const began = clock(); let emitted = false;
  return (phase, error) => {
    if (emitted || typeof observer !== 'function') return;
    emitted = true;
    const rawCode = codeOf(error), code = CODES.get(rawCode) ?? 'unclassified';
    if (['VAULT_TLS_CONTEXT_CREATION_FAILED', 'VAULT_TLS_CONTEXT_FACTORY_INVALID'].includes(rawCode)) phase = 'tls_local';
    if (['VAULT_TLS_CERTIFICATE_MISMATCH', 'VAULT_CERTIFICATE_MISMATCH', 'VAULT_TLS_CLIENT_USAGE_EXCLUDED'].includes(rawCode)) phase = 'certificate_binding';
    const line = JSON.stringify({event: 'wsdl_preparation_failed', version: 1,
      phase: PHASES.has(phase) ? phase : 'input_validation', code,
      elapsed_ms: Math.min(30000, Math.max(0, Math.trunc(clock() - began)))});
    try {
      const returned = observer(line);
      // A trusted sink must be nonblocking. Observe native promise rejection
      // without assimilating foreign thenables or delaying custody cleanup.
      if (returned instanceof Promise) void Promise.prototype.then.call(returned, undefined, () => {});
    } catch { /* A diagnostic sink cannot replace the original failure. */ }
  };
}
