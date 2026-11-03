import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRemittance, generateOperationalRemittance, prepareItau109Terms } from '../src/index.mjs';
import { PROFILES, title } from './fixtures.mjs';
import { itauTerms, syntheticResolution } from './itau-terms-fixture.mjs';

const input = (terms = itauTerms(), changes = {}) => ({ amountCents: '12345', dueOn: '2026-10-30', terms, ...changes });
const options = (titles, profile = PROFILES.itau) => ({ profile, titles, generatedOn: '2026-10-15', remittanceSequence: '1', purpose: 'homologation' });
const rows = result => new TextDecoder().decode(result.bytes).slice(0, -2).split('\r\n');
const field = (row, from, to) => row.slice(from - 1, to);
const throws = (data, code) => assert.throws(() => prepareItau109Terms(data), error => error.code === code);

test('source rate and tolerance remain pending: no implicit rounding, dates or authority', () => {
  const result = prepareItau109Terms(input());
  assert.equal(result.encodingReady, false); assert.equal(result.encoding, null); assert.equal(result.resolution, null);
  assert.deepEqual(result.thirtyDayScenario, { selected: false, numeratorCents: '12345', denominator: '3000', wholeDailyCents: '4', remainder: '345' });
  assert.deepEqual(result.pending, ['INTEREST_BASIS_AND_ROUNDING_UNCONFIRMED', 'INTEREST_START_DATE_UNCONFIRMED', 'PENALTY_START_DATE_UNCONFIRMED']);
  for (const flag of ['bankPolicyVerified', 'bankAcceptanceVerified', 'bankTransmissionPerformed', 'financialMutationPerformed', 'automaticProtest']) assert.equal(result[flag], false);
  assert.ok(Object.isFrozen(result.source)); assert.ok(Object.isFrozen(result.pending));
});

test('explicit month convention and daily cents must agree, using exact integers', () => {
  for (const [rounding, dailyInterestCents] of [['down', '1'], ['half-up', '2'], ['up', '2']]) {
    const result = prepareItau109Terms(input(itauTerms(syntheticResolution({ rounding, dailyInterestCents })), { amountCents: '4500' }));
    assert.equal(result.encoding.dailyInterestCents, dailyInterestCents);
    assert.equal(result.thirtyDayScenario.remainder, '1500');
  }
  const exact = prepareItau109Terms(input(itauTerms(syntheticResolution({ rounding: 'exact', dailyInterestCents: '10' })), { amountCents: '30000' }));
  assert.equal(exact.encoding.dailyInterestCents, '10');
  throws(input(itauTerms(syntheticResolution({ rounding: 'exact' }))), 'CNAB_ITAU_INTEREST_FRACTION_UNRESOLVED');
  throws(input(itauTerms(syntheticResolution({ dailyInterestCents: '5' }))), 'CNAB_ITAU_DAILY_INTEREST_MISMATCH');
  throws(input(itauTerms(syntheticResolution({ monthDays: 31 }))), 'CNAB_ITAU_INTEREST_CONVENTION_UNSUPPORTED');
  throws(input(itauTerms(syntheticResolution({ dailyInterestCents: '0' })), { amountCents: '1' }), 'CNAB_ITAU_DAILY_INTEREST_BELOW_CENT');
  const max = prepareItau109Terms(input(itauTerms(syntheticResolution({ rounding: 'down', dailyInterestCents: '3333333333' })), { amountCents: '9999999999999' }));
  assert.equal(max.thirtyDayScenario.remainder, '999');
  assert.equal(max.encoding.dailyInterestCents, '3333333333');
});

test('one-day tolerance requires an explicit date interpretation, including leap/year boundaries', () => {
  const due = '2028-02-28';
  for (const [penaltyDateRule, penaltyStartsOn] of [['due-plus-tolerance', '2028-02-29'], ['after-complete-tolerance-days', '2028-03-01']]) {
    const result = prepareItau109Terms(input(itauTerms(syntheticResolution({ interestStartsOn: '2028-02-29', penaltyDateRule, penaltyStartsOn })), { dueOn: due }));
    assert.equal(result.encoding.penaltyStartsOn, penaltyStartsOn);
  }
  const year = prepareItau109Terms(input(itauTerms(syntheticResolution({ interestStartsOn: '2027-01-01', penaltyStartsOn: '2027-01-01' })), { dueOn: '2026-12-31' }));
  assert.equal(year.encoding.penaltyStartsOn, '2027-01-01');
  throws(input(itauTerms(syntheticResolution({ penaltyStartsOn: '2026-11-01' }))), 'CNAB_ITAU_PENALTY_DATE_MISMATCH');
  throws(input(itauTerms(syntheticResolution({ interestStartsOn: '2026-10-30' }))), 'CNAB_ITAU_INTEREST_DATE_INVALID');
  throws(input(itauTerms(syntheticResolution({ penaltyStartsOn: '2026-02-30' }))), 'CNAB_DATE_INVALID');
});

test('strict own-data shape prevents silent defaults, coercion, unsupported instructions and getter execution', () => {
  const changes = { monthlyInterestPercent: '1', penaltyPercent: '100.00', penaltyToleranceDays: 0, punctualityDiscountPercent: '1.00',
    acceptance: 'A', species: 'DS', sourceInstructions: '00', automaticProtest: true };
  for (const [key, value] of Object.entries(changes)) throws(input({ ...itauTerms(), [key]: value }), 'CNAB_ITAU_TERMS_UNSUPPORTED');
  const missing = itauTerms(); delete missing.resolution;
  for (const terms of [missing, { ...itauTerms(), message: 'PROTESTAR' }, { ...itauTerms(), [Symbol('extra')]: 1 }, null]) throws(input(terms), 'CNAB_ITAU_TERMS_INVALID');
  let read = false; const getter = itauTerms(); Object.defineProperty(getter, 'resolution', { enumerable: true, get() { read = true; return null; } });
  throws(input(getter), 'CNAB_ITAU_TERMS_INVALID'); assert.equal(read, false);
  throws(input(itauTerms(syntheticResolution({ confirmed: false }))), 'CNAB_ITAU_TERMS_UNCONFIRMED');
  throws(input(itauTerms(syntheticResolution({ reference: 'bad\nreference' }))), 'CNAB_ITAU_TERMS_UNCONFIRMED');
  throws(input(itauTerms(syntheticResolution({ dailyInterestCents: ['4'] }))), 'CNAB_AMOUNT_INVALID');
});

test('one type2 per title follows type1; exact manual fields, explicit no protest and no discount', async () => {
  const terms = itauTerms(syntheticResolution());
  const result = await generateRemittance(options([title({ collectionTerms: terms })]));
  const [header, detail, penalty, trailer] = rows(result);
  assert.equal(result.bytes.length, 1608); assert.equal(result.totalCents, '12345');
  assert.equal(field(detail, 148, 150), '01N'); assert.equal(field(detail, 157, 160), '1044');
  assert.equal(field(detail, 161, 173), '0000000000004'); assert.equal(field(detail, 174, 218), '0'.repeat(45));
  assert.equal(field(detail, 386, 391), '311026'); assert.equal(field(detail, 392, 393), '00');
  assert.equal(field(penalty, 1, 23), '22' + '31102026' + '0000000000200');
  assert.equal(field(penalty, 24, 394), ' '.repeat(371));
  assert.equal(field(header, 1, 1), '0'); assert.equal(field(trailer, 1, 1), '9');
  rows(result).forEach((row, i) => { assert.equal(row.length, 400); assert.equal(field(row, 395, 400), String(i + 1).padStart(6, '0')); });
  assert.equal(result.manifest[0].collectionTerms.encoding.penaltyPercentHundredths, '200');
  assert.equal(result.manifest[0].collectionTerms.bankPolicyVerified, false);
  assert.ok(result.warnings.includes('PRINTED_PROTEST_TEXT_NOT_ENCODED'));
  assert.equal(result.productionReady, false);
});

test('mixed titles and maximum 30 titles keep physical sequences and title totals independent', async () => {
  const titles = Array.from({ length: 30 }, (_, i) => title({ id: `title-${i}`, control: `CONTROL${i}`, documentNumber: `DOC${i}`,
    ourNumber: String(i + 1).padStart(8, '0'), ...(i % 2 === 0 ? { collectionTerms: itauTerms(syntheticResolution()) } : {}) }));
  const result = await generateRemittance(options(titles));
  assert.equal(rows(result).length, 47); assert.equal(result.bytes.length, 47 * 402); assert.equal(result.totalCents, '370350');
  assert.equal(result.manifest.length, 30);
  let cursor = 1;
  for (let i = 0; i < titles.length; i++) {
    assert.equal(rows(result)[cursor++][0], '1'); if (i % 2 === 0) assert.equal(rows(result)[cursor++][0], '2');
  }
  rows(result).forEach((row, i) => assert.equal(field(row, 395, 400), String(i + 1).padStart(6, '0')));
});

test('missing resolution blocks generation; Inter refuses the new profile and legacy bytes stay stable', async () => {
  await assert.rejects(generateRemittance(options([title({ collectionTerms: itauTerms() })])), { code: 'CNAB_ITAU_TERMS_UNRESOLVED' });
  await assert.rejects(generateRemittance(options([title({ ourNumber: undefined, paymentLimitDays: 30, collectionTerms: itauTerms(syntheticResolution()) })], PROFILES.inter)), { code: 'CNAB_TITLE_OR_FEATURE_UNSUPPORTED' });
  const legacy = await generateRemittance(options([title()]));
  assert.equal(rows(legacy).length, 3); assert.equal(field(rows(legacy)[1], 157, 160), '1047');
  assert.equal(Object.hasOwn(legacy.manifest[0], 'collectionTerms'), false);
  const operational = await generateOperationalRemittance({ ...options([title({ collectionTerms: itauTerms(syntheticResolution()) })]), purpose: 'operational' });
  assert.equal(operational.bankTransmissionPerformed, false); assert.equal(operational.financialMutationPerformed, false);
  assert.equal(operational.productionReady, false);
});

test('review owns its nested copies and dates; source mutation cannot rewrite the resolved encoding', () => {
  const resolution = syntheticResolution(), terms = itauTerms(resolution);
  const reviewed = prepareItau109Terms(input(terms));
  resolution.dailyInterestCents = '99'; resolution.reference = 'CHANGED'; terms.penaltyPercent = '99.00';
  assert.equal(reviewed.encoding.dailyInterestCents, '4'); assert.equal(reviewed.source.penaltyPercent, '2.00');
  assert.equal(reviewed.resolution.reference, 'SYNTHETIC CONVENTION FOR TEST ONLY');
  assert.ok(Object.isFrozen(reviewed.encoding.instructions));
});

test('input mutation while hashing cannot detach either entry manifest, total or terms from encoded bytes', async () => {
  for (const [generate, purpose] of [[generateRemittance, 'homologation'], [generateOperationalRemittance, 'operational']]) {
    const source = title({ collectionTerms: itauTerms(syntheticResolution()) });
    const sources = [source], config = { ...options(sources), profile: structuredClone(PROFILES.itau), purpose };
    const expected = await generate(structuredClone(config));
    const resultPromise = generate(config);
    source.id = 'different-id'; source.amountCents = '99999'; source.control = 'DIFFERENT';
    source.documentNumber = 'OTHER'; source.ourNumber = '99999999'; source.dueOn = '2027-01-01';
    source.collectionTerms.resolution.dailyInterestCents = '999';
    source.collectionTerms.resolution.reference = 'CHANGED AFTER CALL';
    source.collectionTerms = null; sources.length = 0;
    config.profile.accountId = 'different-account'; config.profile.wallet = '112';
    const result = await resultPromise;
    assert.deepEqual(result, expected);
    assert.equal(field(rows(result)[1], 127, 139), '0000000012345');
    assert.equal(result.totalCents, '12345');
    assert.equal(result.manifest[0].collectionTerms.encoding.dailyInterestCents, '4');
    assert.equal(result.manifest[0].collectionTerms.resolution.reference, 'SYNTHETIC CONVENTION FOR TEST ONLY');
  }
});
