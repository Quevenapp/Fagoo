import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoletoDigits, createItau109BoletoTermsCandidate } from '../src/index.mjs';
import { itauTerms, syntheticResolution } from '../../cnab-core/test/itau-terms-fixture.mjs';

const base = () => ({ purpose: 'offline-validation',
  profile: { bank: '341', wallet: '109', layout: 'itau-cnab400-2017-01', agency: '1234', account: '12345', accountDigit: '1',
    cnpj: '12345678000195', accountId: 'synthetic-account', companyName: 'EMPRESA FICTICIA', contractVerified: true,
    agreementReference: 'SYNTHETIC CONTRACT ONLY', simpleCollectionPolicyVerified: true },
  title: { amountCents: '12345', dueOn: '2026-10-30', referenceOn: '2026-10-16' },
  allocation: { ourNumber: '00000001', confirmed: true, reference: 'SYNTHETIC ALLOCATION ONLY' } });

test('fees do not change nominal barcode, factors, digits or original amount', () => {
  const nominal = createBoletoDigits(base());
  const candidate = createItau109BoletoTermsCandidate({ ...base(), collectionTerms: itauTerms(syntheticResolution()) });
  for (const field of ['barcode', 'digitableLine', 'formattedLine', 'freeField', 'dueFactor', 'amountCents', 'dueOn', 'ourNumberWithDigit']) assert.equal(candidate[field], nominal[field]);
  assert.equal(candidate.collectionTerms.encodingReady, true);
  assert.equal(candidate.collectionTerms.encoding.penaltyPercentHundredths, '200');
  assert.equal(candidate.bankAcceptanceVerified, false); assert.equal(candidate.canIssue, false); assert.equal(candidate.canTransmit, false);
  assert.ok(candidate.pending.includes('BANK_CHARGES_POLICY_NOT_VERIFIED'));
  assert.ok(candidate.pending.includes('PRINTED_INSTRUCTIONS_NOT_VALIDATED'));
});

test('unresolved source configuration remains visible and cannot masquerade as resolved payment terms', () => {
  const result = createItau109BoletoTermsCandidate({ ...base(), collectionTerms: itauTerms() });
  assert.equal(result.collectionTerms.encodingReady, false); assert.equal(result.collectionTerms.encoding, null);
  assert.ok(result.pending.includes('PENALTY_START_DATE_UNCONFIRMED')); assert.ok(Object.isFrozen(result.pending));
  assert.throws(() => createBoletoDigits({ ...base(), collectionTerms: itauTerms() }), { code: 'BOLETO_INPUT_INVALID' });
  assert.throws(() => createItau109BoletoTermsCandidate({ ...base(), collectionTerms: { ...itauTerms(), automaticProtest: true } }), { code: 'BOLETO_ITAU_TERMS_UNSUPPORTED' });
  assert.throws(() => createItau109BoletoTermsCandidate({ ...base(), collectionTerms: itauTerms(syntheticResolution({ dailyInterestCents: '999' })) }), { code: 'BOLETO_ITAU_DAILY_INTEREST_MISMATCH' });
});
