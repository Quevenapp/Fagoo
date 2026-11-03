// Entirely synthetic caller declarations, not bank/Origin evidence.
export function itauTerms(resolution = null) {
  return { profile: 'itau109-explicit-charges-v1', monthlyInterestPercent: '1.00', penaltyPercent: '2.00',
    penaltyToleranceDays: 1, punctualityDiscountPercent: '0.00', species: 'DM', acceptance: 'N',
    sourceInstructions: 'absent', automaticProtest: false, resolution };
}
export function syntheticResolution(overrides = {}) {
  return { monthDays: 30, rounding: 'half-up', dailyInterestCents: '4', interestStartsOn: '2026-10-31',
    penaltyStartsOn: '2026-10-31', penaltyDateRule: 'due-plus-tolerance', confirmed: true,
    reference: 'SYNTHETIC CONVENTION FOR TEST ONLY', ...overrides };
}
