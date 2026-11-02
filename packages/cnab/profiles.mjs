import { requireCnab, digits, validDocument, mod10 } from './primitives.mjs';

export const LAYOUTS = Object.freeze({ '341': 'itau-cnab400-2017-01', '077': 'inter-cnab400-v2.2-2024-08-26' });
export function validateProfile(profile, { generation = false } = {}) {
  requireCnab(profile && typeof profile === 'object' && !Array.isArray(profile), 'CNAB_PROFILE_INVALID');
  requireCnab(['341', '077'].includes(profile.bank) && profile.layout === LAYOUTS[profile.bank], 'CNAB_LAYOUT_UNSUPPORTED');
  requireCnab(digits(profile.agency, 4) && !/^0+$/.test(profile.agency)
    && digits(profile.account, profile.bank === '341' ? 5 : 9) && !/^0+$/.test(profile.account)
    && digits(profile.accountDigit, 1), 'CNAB_ACCOUNT_INVALID');
  requireCnab(profile.bank !== '077' || profile.agency === '0001', 'CNAB_INTER_AGENCY_INVALID');
  requireCnab(validDocument('02', profile.cnpj), 'CNAB_NUMERIC_CNPJ_INVALID');
  requireCnab((profile.bank === '341' ? ['109'] : ['110', '112']).includes(profile.wallet), 'CNAB_WALLET_UNSUPPORTED');
  requireCnab(typeof profile.accountId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(profile.accountId), 'CNAB_ACCOUNT_ID_INVALID');
  if (generation) {
    requireCnab(profile.contractVerified === true && typeof profile.agreementReference === 'string' && profile.agreementReference.trim().length > 0, 'CNAB_BANK_AGREEMENT_UNCONFIRMED');
    requireCnab(profile.simpleCollectionPolicyVerified === true, 'CNAB_COLLECTION_POLICY_UNCONFIRMED');
    if (profile.bank === '077' && profile.wallet === '110') requireCnab(profile.reservedRange?.verified === true
      && digits(profile.reservedRange.start, 10) && digits(profile.reservedRange.end, 10)
      && BigInt(profile.reservedRange.start) <= BigInt(profile.reservedRange.end), 'CNAB_INTER_RESERVED_RANGE_REQUIRED');
  }
  return profile;
}
export function accountScope(profile) { validateProfile(profile); return [profile.bank, profile.agency, profile.account, profile.accountDigit, profile.wallet, profile.cnpj].join(':'); }
export function itauOurNumberDigit({ agency, account, wallet, ourNumber }) {
  requireCnab(digits(agency, 4) && digits(account, 5) && digits(wallet, 3) && digits(ourNumber, 8), 'CNAB_OUR_NUMBER_INVALID');
  requireCnab(['109', '110'].includes(wallet), 'CNAB_DIGIT_WALLET_UNSUPPORTED');
  return mod10(agency + account + wallet + ourNumber);
}
export function interOurNumberDigit(ourNumber) {
  requireCnab(digits(ourNumber, 10), 'CNAB_OUR_NUMBER_INVALID');
  return mod10('0001' + '110' + ourNumber);
}
