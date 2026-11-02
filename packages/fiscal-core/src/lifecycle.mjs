import { buildAccessKey, emissionIdentityKey, normalizeFiscalIdentity, validFiscalTimestamp } from './identity.mjs';
import { evaluateEmissionGates } from './gates.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const protocol = value => typeof value === 'string' && /^(?:[0-9]{15}|[0-9]{17})$/.test(value) && !/^0+$/.test(value);
const receipt = value => typeof value === 'string' && /^[0-9]{15}$/.test(value) && !/^0+$/.test(value);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const pending = new Set(['SUBMITTING', 'PROCESSING', 'RECONCILIATION_REQUIRED']);
const rejectionCodes = new Set(['203', '207', '208', '209', '210', '211', '212', '213', '215', '225', '252']);
const next = (record, changes) => Object.freeze({ ...record, ...changes, revision: record.revision + 1 });
function revision(record, expected) {
  if (!Number.isSafeInteger(expected) || record.revision !== expected) throw new Error('FISCAL_REVISION_CONFLICT');
}
function state(record, allowed) { if (!allowed.includes(record.state)) throw new Error('FISCAL_TRANSITION_INVALID'); }

export function createEmission({ id, identity }) {
  if (!token(id)) throw new Error('FISCAL_ID_INVALID');
  const normalized = normalizeFiscalIdentity(identity);
  return Object.freeze({ id, identity: normalized, identityKey: emissionIdentityKey(normalized), accessKey: buildAccessKey(normalized), state: 'DRAFT', revision: 0 });
}

export function validateEmission(record, { expectedRevision, config, now, documentDigest, schemaValidated, taxReviewRef }) {
  revision(record, expectedRevision); state(record, ['DRAFT']);
  const gates = evaluateEmissionGates(record.identity, config, now);
  if (!gates.configurationReady) throw new Error('FISCAL_CONFIGURATION_BLOCKED');
  if (!digest(documentDigest) || schemaValidated !== true || !token(taxReviewRef)) throw new Error('FISCAL_VALIDATION_EVIDENCE_REQUIRED');
  return next(record, { state: 'VALIDATED', documentDigest, taxReviewRef });
}

export function attachSignature(record, { expectedRevision, signedXmlDigest, verified, documentDigest }) {
  revision(record, expectedRevision); state(record, ['VALIDATED']);
  if (!digest(signedXmlDigest) || documentDigest !== record.documentDigest || verified !== true) throw new Error('FISCAL_SIGNATURE_EVIDENCE_REQUIRED');
  return next(record, { state: 'SIGNED', signedXmlDigest });
}

/** Pure planning only. Persist atomically BEFORE a future adapter performs any network request. */
export function beginSubmission(record, { expectedRevision, requestId, signedXmlDigest, config, now }) {
  revision(record, expectedRevision);
  if (!token(requestId) || signedXmlDigest !== record.signedXmlDigest || !digest(signedXmlDigest)) throw new Error('FISCAL_SUBMISSION_MISMATCH');
  if (record.state !== 'SIGNED') {
    if (pending.has(record.state) || ['AUTHORIZED', 'CANCELLED', 'LEGACY_DENIED'].includes(record.state)) return { record, planned: false, action: nextReconciliationAction(record) };
    throw new Error('FISCAL_TRANSITION_INVALID');
  }
  if (!evaluateEmissionGates(record.identity, config, now).configurationReady) throw new Error('FISCAL_CONFIGURATION_BLOCKED');
  return { record: next(record, { state: 'SUBMITTING', requestId }), planned: true, action: 'TRANSPORT_NOT_IMPLEMENTED' };
}

export function recordTransportFailure(record, { expectedRevision, requestId }) {
  revision(record, expectedRevision); state(record, [...pending]);
  if (requestId !== record.requestId) throw new Error('FISCAL_RESPONSE_MISMATCH');
  return next(record, { state: 'RECONCILIATION_REQUIRED', reason: 'TRANSPORT_OUTCOME_UNKNOWN' });
}

export function nextReconciliationAction(record) {
  if (!pending.has(record.state)) return 'NONE';
  return record.receipt ? 'CONSULT_RECEIPT_THEN_PROTOCOL' : 'CONSULT_PROTOCOL_BY_EXISTING_KEY';
}

/** Input must come from a trusted adapter that validates TLS/XML/XSD and stores the raw response privately. */
export function applySefazResponse(record, { expectedRevision, response }) {
  revision(record, expectedRevision); state(record, [...pending, 'AUTHORIZED']);
  if (!response || response.requestId !== record.requestId || String(response.environment) !== record.identity.environment
      || !['authorization', 'receipt', 'protocol'].includes(response.source) || response.verified !== true || !digest(response.evidenceDigest)) throw new Error('FISCAL_RESPONSE_MISMATCH');
  const status = String(response.cStat);
  const result = response.protocol;
  const resultCode = String(result?.cStat ?? status);
  const evidence = { lastStatus: status, evidenceDigest: response.evidenceDigest };
  if (result && response.source !== 'protocol' && status !== '104') throw new Error('FISCAL_RESPONSE_MISMATCH');
  if (result && response.source === 'protocol' && resultCode !== status) throw new Error('FISCAL_RESPONSE_MISMATCH');
  if (result && (result.accessKey !== record.accessKey || String(result.environment) !== record.identity.environment)) throw new Error('FISCAL_RESPONSE_MISMATCH');
  if (['100', '150', '101', '151'].includes(resultCode)) {
    if (!result || !protocol(result.number) || !validFiscalTimestamp(result.receivedAt)) throw new Error('FISCAL_PROTOCOL_EVIDENCE_REQUIRED');
    const cancelled = ['101', '151'].includes(resultCode);
    if (cancelled && response.source !== 'protocol') throw new Error('FISCAL_RESPONSE_MISMATCH');
    if (record.state === 'AUTHORIZED' && !cancelled) {
      if (record.authorizationProtocol !== result.number) throw new Error('FISCAL_PROTOCOL_CONFLICT');
      return record;
    }
    if (cancelled) return next(record, { ...evidence, state: 'CANCELLED', cancellationProtocol: result.number,
      cancellationReceivedAt: result.receivedAt, cancellationEvidenceDigest: response.evidenceDigest, reason: undefined });
    return next(record, { ...evidence, state: 'AUTHORIZED', authorizationProtocol: result.number,
      authorizationReceivedAt: result.receivedAt, authorizationEvidenceDigest: response.evidenceDigest, reason: undefined });
  }
  // An authorized document cannot regress because of a stale, incomplete or contradictory query.
  if (record.state === 'AUTHORIZED') throw new Error('FISCAL_AUTHORIZED_STATE_CONFLICT');
  if (['110', '301', '302'].includes(resultCode) && response.source === 'protocol' && result) {
    if (!protocol(result.number) || !validFiscalTimestamp(result.receivedAt)) throw new Error('FISCAL_PROTOCOL_EVIDENCE_REQUIRED');
    return next(record, { ...evidence, state: 'LEGACY_DENIED', denialProtocol: result.number,
      denialReceivedAt: result.receivedAt, denialEvidenceDigest: response.evidenceDigest, reason: 'HISTORICAL_DENIAL_RECONCILED' });
  }
  if (['103', '105'].includes(status)) {
    if ((status === '103' && response.source !== 'authorization') || (status === '105' && response.source !== 'receipt')) throw new Error('FISCAL_RESPONSE_MISMATCH');
    const value = response.receipt || record.receipt;
    if (!receipt(value) || (record.receipt && value !== record.receipt)) throw new Error('FISCAL_RECEIPT_MISMATCH');
    return next(record, { ...evidence, state: 'PROCESSING', receipt: value, reason: undefined });
  }
  if (rejectionCodes.has(resultCode) && response.source !== 'protocol') {
    return next(record, { ...evidence, state: 'REJECTED', rejectionCode: resultCode, reason: 'CORRECTION_REQUIRES_NEW_VALIDATION' });
  }
  // 104 without a protocol, 204/539 duplicates, 106/217 not found and unknown statuses never authorize a resend.
  return next(record, { ...evidence, state: 'RECONCILIATION_REQUIRED', reason: ['204', '539'].includes(resultCode) ? 'DUPLICATE_REQUIRES_RECONCILIATION' : 'OUTCOME_UNRESOLVED' });
}
