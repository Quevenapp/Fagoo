import { isValidCnpj, normalizeFiscalIdentity, validateFiscalIdentity, validFiscalTimestamp } from './identity.mjs';
import { nfceQrProfile } from './nfce-qr-profile.mjs';

const reference = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value);
const validTime = value => typeof value === 'string' && validFiscalTimestamp(value.replace(/\.\d{1,3}(?=Z$|[+-]\d{2}:\d{2}$)/, ''));
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Metadata only: never pass a PFX, password, CSC value or private key into this module. */
export function evaluateEmissionGates(input, config = {}, now = new Date()) {
  config = object(config);
  const errors = validateFiscalIdentity(input).errors.map(error => error.code);
  if (errors.length) return { configurationReady: false, canTransmit: false, errors, transmissionBlockers: ['TRANSPORT_NOT_IMPLEMENTED'] };
  const identity = normalizeFiscalIdentity(input);
  const clock = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(clock)) errors.push('CLOCK_INVALID');
  if (identity.cUF !== '35') errors.push('UF_NOT_IMPLEMENTED');
  if (identity.tpEmis !== '1') errors.push('CONTINGENCY_NOT_IMPLEMENTED');
  if (Number(identity.series) > 889) errors.push('SERIES_RESERVED_FOR_OTHER_ISSUERS');
  if (config.cnpj !== identity.cnpj) errors.push('CONFIGURED_ISSUER_MISMATCH');
  if (typeof config.stateRegistration !== 'string' || !config.stateRegistration.trim()) errors.push('STATE_REGISTRATION_REQUIRED');
  if (![1, 2, 3, 4].includes(config.taxRegime?.crt) || config.taxRegime?.confirmed !== true) errors.push('TAX_REGIME_UNCONFIRMED');
  const certificate = object(config.certificate);
  if (certificate.type !== 'A1' || certificate.verified !== true || !reference(certificate.secretRef)) errors.push('VERIFIED_A1_REQUIRED');
  if (!isValidCnpj(certificate.cnpj) || certificate.cnpj.slice(0, 8) !== identity.cnpj.slice(0, 8)) errors.push('CERTIFICATE_ISSUER_MISMATCH');
  if (!validTime(certificate.validFrom) || !validTime(certificate.validUntil)
      || Date.parse(certificate.validFrom) > clock || Date.parse(certificate.validUntil) <= clock) errors.push('CERTIFICATE_OUTSIDE_VALIDITY');
  if (config.accreditation?.[identity.model]?.[identity.environment] !== true) errors.push('ACCREDITATION_UNCONFIRMED');
  if (!reference(config.schemaProfile?.id) || config.schemaProfile?.reviewed !== true
      || !Array.isArray(config.schemaProfile?.models) || !config.schemaProfile.models.includes(identity.model)) errors.push('CURRENT_SCHEMA_PROFILE_UNCONFIRMED');
  if (config.taxRulesReviewed !== true) errors.push('TAX_RULES_UNREVIEWED');
  if (identity.model === '65') {
    if (config.nfceQrProfile !== undefined) {
      // Selection must match the same fixed profile used by the XML supplement.
      // Invalid selection cannot fall back to CSC or broaden to production.
      if (!nfceQrProfile(identity, config.nfceQrProfile)) errors.push('NFCE_QR_PROFILE_UNSUPPORTED');
    } else {
      const csc = config.csc?.[identity.environment] || {};
      if (!/^[0-9]{6}$/.test(csc.id || '') || Number(csc.id) === 0 || !reference(csc.secretRef) || csc.verified !== true) errors.push('CSC_FOR_ENVIRONMENT_REQUIRED');
    }
  }
  if (identity.environment === '1') {
    if (config.homologation?.[identity.model]?.completed !== true || !reference(config.homologation?.[identity.model]?.evidenceRef)) errors.push('HOMOLOGATION_EVIDENCE_REQUIRED');
    if (config.productionEnabled !== true) errors.push('PRODUCTION_NOT_ENABLED');
  }
  return { configurationReady: errors.length === 0, canTransmit: false, errors: [...new Set(errors)], transmissionBlockers: ['TRANSPORT_NOT_IMPLEMENTED'] };
}
