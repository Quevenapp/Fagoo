import test from 'node:test';
import assert from 'node:assert/strict';
import { applySefazResponse, attachSignature, beginSubmission, createEmission, nextReconciliationAction, recordTransportFailure, validateEmission } from '../src/index.mjs';
import { identity, config, now, documentDigest, signedXmlDigest } from './fixtures.mjs';

function signed() {
  const draft = createEmission({ id: 'synthetic-document', identity });
  const validated = validateEmission(draft, { expectedRevision: 0, config, now, documentDigest, schemaValidated: true, taxReviewRef: 'synthetic-review' });
  return attachSignature(validated, { expectedRevision: 1, signedXmlDigest, documentDigest, verified: true });
}
const request = { expectedRevision: 2, requestId: 'synthetic-request', signedXmlDigest, config, now };
function submitting() { return beginSubmission(signed(), request).record; }
function response(record, changes = {}) {
  return { requestId: record.requestId, environment: '2', source: 'authorization', verified: true, evidenceDigest: 'c'.repeat(64), cStat: '104', ...changes };
}
function authorizedProtocol(record, changes = {}) { return { accessKey: record.accessKey, environment: '2', cStat: '100', number: '13526000000000001', receivedAt: '2026-10-16T00:00:00-03:00', ...changes }; }
function apply(record, changes) { return applySefazResponse(record, { expectedRevision: record.revision, response: response(record, changes) }); }

test('preparation requires schema/tax/signature evidence and rejects stale revisions', () => {
  const draft = createEmission({ id: 'synthetic-document', identity });
  assert.throws(() => validateEmission(draft, { expectedRevision: 1, config, now, documentDigest }), /REVISION_CONFLICT/);
  assert.throws(() => validateEmission(draft, { expectedRevision: 0, config, now, documentDigest, schemaValidated: false }), /EVIDENCE_REQUIRED/);
  assert.throws(() => beginSubmission(draft, request), /REVISION_CONFLICT/);
  assert.equal(signed().state, 'SIGNED');
});

test('same submission is idempotent and changed signed payload is refused', () => {
  const original = signed();
  const first = beginSubmission(original, request);
  assert.equal(first.planned, true);
  assert.equal(first.action, 'TRANSPORT_NOT_IMPLEMENTED');
  assert.equal(original.state, 'SIGNED');
  const duplicate = beginSubmission(first.record, { ...request, expectedRevision: 3, requestId: 'another-retry' });
  assert.equal(duplicate.planned, false);
  assert.equal(duplicate.record, first.record);
  assert.throws(() => beginSubmission(first.record, { ...request, expectedRevision: 3, signedXmlDigest: 'd'.repeat(64) }), /SUBMISSION_MISMATCH/);
});

test('timeout, duplicate, batch completion without protocol and not-found remain unresolved without retransmission', () => {
  const record = submitting();
  const timeout = recordTransportFailure(record, { expectedRevision: 3, requestId: record.requestId });
  assert.equal(timeout.state, 'RECONCILIATION_REQUIRED');
  assert.equal(nextReconciliationAction(timeout), 'CONSULT_PROTOCOL_BY_EXISTING_KEY');
  for (const cStat of ['104', '204', '539', '106', '217', '9999']) {
    const unresolved = apply(timeout, { cStat });
    assert.equal(unresolved.state, 'RECONCILIATION_REQUIRED');
    assert.equal(unresolved.accessKey, record.accessKey);
    assert.equal(beginSubmission(unresolved, { ...request, expectedRevision: unresolved.revision }).planned, false);
  }
});

test('receipt received means processing, then a matching individual protocol authorizes the same document', () => {
  const original = submitting();
  const processing = apply(original, { cStat: '103', receipt: '351000000000001' });
  assert.equal(processing.state, 'PROCESSING');
  assert.equal(nextReconciliationAction(processing), 'CONSULT_RECEIPT_THEN_PROTOCOL');
  const authorized = apply(processing, { source: 'receipt', protocol: authorizedProtocol(processing) });
  assert.equal(authorized.state, 'AUTHORIZED');
  assert.equal(authorized.authorizationProtocol.length, 17);
  assert.equal(beginSubmission(authorized, { ...request, expectedRevision: authorized.revision }).planned, false);
  assert.equal(apply(authorized, { protocol: authorizedProtocol(authorized) }), authorized);
});

test('wrong key, environment, request, missing protocol, forged receipt and contradictory response cannot authorize', () => {
  const record = submitting();
  for (const changes of [
    { environment: '1' }, { requestId: 'other-request' }, { verified: false },
    { protocol: authorizedProtocol(record, { accessKey: '0'.repeat(44) }) },
    { protocol: authorizedProtocol(record, { environment: '1' }) },
    { protocol: authorizedProtocol(record, { number: '1' }) },
    { protocol: authorizedProtocol(record, { receivedAt: '2026-02-30T00:00:00Z' }) },
    { cStat: '100' }, { cStat: '103', receipt: 'invalid' },
    { cStat: '103', protocol: authorizedProtocol(record) },
  ]) assert.throws(() => apply(record, changes));
});

test('a documented rejection stays rejected and cannot be blindly submitted again', () => {
  const record = apply(submitting(), { cStat: '225' });
  assert.equal(record.state, 'REJECTED');
  assert.equal(record.rejectionCode, '225');
  assert.throws(() => beginSubmission(record, { ...request, expectedRevision: record.revision }), /TRANSITION_INVALID/);
});

test('authorized state cannot regress; confirmed cancellation is reconciled only from protocol consultation', () => {
  const base = submitting();
  const record = apply(base, { protocol: authorizedProtocol(base, { number: '135260000000001' }) });
  assert.throws(() => apply(record, { cStat: '217', source: 'protocol' }), /AUTHORIZED_STATE_CONFLICT/);
  assert.throws(() => apply(record, { protocol: authorizedProtocol(record, { number: '135260000000002' }) }), /PROTOCOL_CONFLICT/);
  const cancelled = apply(record, { cStat: '101', source: 'protocol', evidenceDigest: 'd'.repeat(64), protocol: authorizedProtocol(record, { cStat: '101', number: '13526000000000002', receivedAt: '2026-10-16T01:00:00-03:00' }) });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(cancelled.authorizationProtocol, '135260000000001');
  assert.equal(cancelled.authorizationReceivedAt, '2026-10-16T00:00:00-03:00');
  assert.equal(cancelled.authorizationEvidenceDigest, 'c'.repeat(64));
  assert.equal(cancelled.cancellationProtocol, '13526000000000002');
  assert.equal(cancelled.cancellationReceivedAt, '2026-10-16T01:00:00-03:00');
  assert.equal(cancelled.cancellationEvidenceDigest, 'd'.repeat(64));
});

test('receipt statuses require their documented service and legacy denial requires a valid received timestamp', () => {
  const record = submitting();
  assert.throws(() => apply(record, { cStat: '103', source: 'protocol', receipt: '351000000000001' }), /RESPONSE_MISMATCH/);
  assert.throws(() => apply(record, { cStat: '105', source: 'authorization', receipt: '351000000000001' }), /RESPONSE_MISMATCH/);
  const legacy = { cStat: '110', source: 'protocol', protocol: authorizedProtocol(record, { cStat: '110' }) };
  assert.equal(apply(record, legacy).state, 'LEGACY_DENIED');
  assert.throws(() => apply(record, { ...legacy, protocol: { ...legacy.protocol, receivedAt: '2026-02-30T00:00:00Z' } }), /PROTOCOL_EVIDENCE_REQUIRED/);
});
