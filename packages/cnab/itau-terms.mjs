import { CnabError, cents, dateField, requireCnab } from './primitives.mjs';

export const ITAU_109_TERMS_PROFILE = 'itau109-explicit-charges-v1';
const TERMS = ['profile', 'monthlyInterestPercent', 'penaltyPercent', 'penaltyToleranceDays', 'punctualityDiscountPercent',
  'species', 'acceptance', 'sourceInstructions', 'automaticProtest', 'resolution'];
const RESOLUTION = ['monthDays', 'rounding', 'dailyInterestCents', 'interestStartsOn', 'penaltyStartsOn',
  'penaltyDateRule', 'confirmed', 'reference'];
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function copy(value, fields) {
  try {
    requireCnab(value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'CNAB_ITAU_TERMS_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    requireCnab(keys.length === fields.length && keys.every(key => typeof key === 'string' && fields.includes(key)
      && descriptors[key].enumerable && 'value' in descriptors[key]), 'CNAB_ITAU_TERMS_INVALID');
    return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
  } catch (error) {
    if (error instanceof CnabError) throw error;
    throw new CnabError('CNAB_ITAU_TERMS_INVALID');
  }
}
function plusDays(day, count) {
  dateField(day);
  const result = new Date(Date.parse(day + 'T00:00:00.000Z') + count * 86_400_000).toISOString().slice(0, 10);
  dateField(result);
  return result;
}

/**
 * Explicit, local review of one limited Itaú profile. Neither the source monthly
 * rate nor its tolerance selects a bank rounding/date convention automatically.
 * A resolution is a caller declaration, never bank acceptance or authorization.
 */
export function prepareItau109Terms(input) {
  const { amountCents, dueOn, terms } = copy(input, ['amountCents', 'dueOn', 'terms']);
  const amount = cents(amountCents);
  requireCnab(amount > 0n, 'CNAB_AMOUNT_BELOW_MINIMUM');
  dateField(dueOn);
  const source = copy(terms, TERMS);
  requireCnab(source.profile === ITAU_109_TERMS_PROFILE && source.monthlyInterestPercent === '1.00'
    && source.penaltyPercent === '2.00' && source.penaltyToleranceDays === 1
    && source.punctualityDiscountPercent === '0.00' && source.species === 'DM'
    && source.acceptance === 'N' && source.sourceInstructions === 'absent'
    && source.automaticProtest === false, 'CNAB_ITAU_TERMS_UNSUPPORTED');
  // 1% of nominal cents / 30 days, as a labelled scenario only. BigInt retains
  // the fractional cent; no monetary Number, implicit rounding or default basis.
  const quotient = amount / 3000n, remainder = amount % 3000n;
  const review = {
    profile: source.profile, amountCents, dueOn,
    source: Object.fromEntries(TERMS.filter(key => !['profile', 'resolution'].includes(key)).map(key => [key, source[key]])),
    thirtyDayScenario: { selected: false, numeratorCents: amountCents, denominator: '3000',
      wholeDailyCents: quotient.toString(), remainder: remainder.toString() },
    encodingReady: false, encoding: null, resolution: null,
    pending: ['INTEREST_BASIS_AND_ROUNDING_UNCONFIRMED', 'INTEREST_START_DATE_UNCONFIRMED', 'PENALTY_START_DATE_UNCONFIRMED'],
    bankPolicyVerified: false, bankAcceptanceVerified: false, bankTransmissionPerformed: false,
    financialMutationPerformed: false, automaticProtest: false,
    warnings: ['SOURCE_ABSENT_INSTRUCTIONS_NOT_REPRODUCED', 'PRINTED_PROTEST_TEXT_NOT_ENCODED', 'BANK_CHARGES_POLICY_NOT_VERIFIED'],
  };
  if (source.resolution === null) return freeze(review);
  const resolved = copy(source.resolution, RESOLUTION);
  requireCnab(resolved.confirmed === true && typeof resolved.reference === 'string'
    && resolved.reference.length >= 3 && resolved.reference.length <= 160
    && resolved.reference.trim() === resolved.reference && !/[\x00-\x1f\x7f]/.test(resolved.reference), 'CNAB_ITAU_TERMS_UNCONFIRMED');
  requireCnab(resolved.monthDays === 30 && ['exact', 'down', 'half-up', 'up'].includes(resolved.rounding), 'CNAB_ITAU_INTEREST_CONVENTION_UNSUPPORTED');
  requireCnab(resolved.rounding !== 'exact' || remainder === 0n, 'CNAB_ITAU_INTEREST_FRACTION_UNRESOLVED');
  const daily = quotient + (resolved.rounding === 'up' && remainder > 0n || resolved.rounding === 'half-up' && remainder * 2n >= 3000n ? 1n : 0n);
  requireCnab(cents(resolved.dailyInterestCents) === daily, 'CNAB_ITAU_DAILY_INTEREST_MISMATCH');
  // Zero in the monetary field could reintroduce a permanent account rule.
  // This profile never silently converts a positive rate to a zero daily fee.
  requireCnab(daily > 0n, 'CNAB_ITAU_DAILY_INTEREST_BELOW_CENT');
  dateField(resolved.interestStartsOn); dateField(resolved.penaltyStartsOn);
  requireCnab(resolved.interestStartsOn > dueOn, 'CNAB_ITAU_INTEREST_DATE_INVALID');
  requireCnab(['due-plus-tolerance', 'after-complete-tolerance-days'].includes(resolved.penaltyDateRule), 'CNAB_ITAU_PENALTY_DATE_CONVENTION_UNSUPPORTED');
  const penaltyOffset = resolved.penaltyDateRule === 'due-plus-tolerance' ? 1 : 2;
  requireCnab(resolved.penaltyStartsOn === plusDays(dueOn, penaltyOffset), 'CNAB_ITAU_PENALTY_DATE_MISMATCH');
  return freeze({ ...review, thirtyDayScenario: { ...review.thirtyDayScenario, selected: true },
    encodingReady: true, pending: [], resolution: resolved,
    encoding: { species: '01', acceptance: 'N', instructions: ['10', '44'], dailyInterestCents: daily.toString(),
      interestStartsOn: resolved.interestStartsOn, penaltyCode: '2', penaltyPercentHundredths: '200',
      penaltyStartsOn: resolved.penaltyStartsOn, discountCents: '0', discountUntil: null, protestDays: '00' },
  });
}
