import { validateProfile, itauOurNumberDigit } from '../../cnab-core/src/profiles.mjs';
import { mod10 } from '../../cnab-core/src/primitives.mjs';
import { prepareItau109Terms } from '../../cnab-core/src/itau-terms.mjs';
import { validateOperationalRemittanceV2 } from '../../cnab-core/src/operational-v2.mjs';

export class BoletoError extends Error {
  constructor(code) { super(code); this.name = 'BoletoError'; this.code = code; }
}
const fail = code => { throw new BoletoError(code); };
const requireValue = (ok, code) => { if (!ok) fail(code); };
const digits = (value, length) => typeof value === 'string' && new RegExp(`^[0-9]{${length}}$`).test(value);
const text = value => typeof value === 'string' && value.length >= 3 && value.length <= 120 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);

// Copy only own data properties. No caller getters or implicit string conversion.
function record(value, allowed, required = allowed) {
  try {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'BOLETO_INPUT_INVALID');
    requireValue([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'BOLETO_INPUT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors), copy = {};
    requireValue(keys.every(key => typeof key === 'string' && allowed.includes(key) && 'value' in descriptors[key] && descriptors[key].enumerable), 'BOLETO_INPUT_INVALID');
    requireValue(required.every(key => keys.includes(key)), 'BOLETO_INPUT_INVALID');
    for (const key of keys) copy[key] = descriptors[key].value;
    return copy;
  } catch (error) {
    if (error instanceof BoletoError) throw error;
    fail('BOLETO_INPUT_INVALID');
  }
}

function calendarDay(value) {
  requireValue(typeof value === 'string' && /^(?:20[0-9]{2})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(value), 'BOLETO_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number), stamp = Date.UTC(year, month - 1, day);
  requireValue(new Date(stamp).toISOString().slice(0, 10) === value, 'BOLETO_DATE_INVALID');
  return stamp / 86_400_000; // Integer UTC calendar days, never money.
}
const FACTOR_BASE_DAY = Date.UTC(2000, 6, 3) / 86_400_000;

/** Explicit calendar context; a four-digit factor alone cannot identify its cycle. */
export function calculateDueFactor(input) {
  const { dueOn, referenceOn } = record(input, ['dueOn', 'referenceOn']);
  const due = calendarDay(dueOn), reference = calendarDay(referenceOn);
  requireValue(due >= FACTOR_BASE_DAY && reference >= FACTOR_BASE_DAY, 'BOLETO_DATE_UNSUPPORTED');
  requireValue(due - reference >= -3000 && due - reference <= 5500, 'BOLETO_DUE_DATE_OUTSIDE_WINDOW');
  return String(1000 + (due - FACTOR_BASE_DAY) % 9000);
}

/** Arithmetic only: 43 digits excluding the fifth (general check digit) position. */
export function calculateBarcodeDigit(base43) {
  requireValue(digits(base43, 43), 'BOLETO_BARCODE_BASE_INVALID');
  let total = 0, weight = 2;
  for (let index = base43.length - 1; index >= 0; index--) {
    total += (base43.charCodeAt(index) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const result = 11 - total % 11;
  return String(result === 0 || result === 1 || result === 10 || result === 11 ? 1 : result);
}

/** Reorder a checked barcode. This does not validate a bank contract or free field. */
export function barcodeToDigitableLine(barcode) {
  requireValue(digits(barcode, 44) && ['341', '077'].includes(barcode.slice(0, 3)) && barcode[3] === '9', 'BOLETO_BARCODE_INVALID');
  requireValue(calculateBarcodeDigit(barcode.slice(0, 4) + barcode.slice(5)) === barcode[4], 'BOLETO_BARCODE_DIGIT_INVALID');
  const field1 = barcode.slice(0, 4) + barcode.slice(19, 24), field2 = barcode.slice(24, 34), field3 = barcode.slice(34);
  const one = field1 + mod10(field1), two = field2 + mod10(field2), three = field3 + mod10(field3);
  return Object.freeze({
    digits: one + two + three + barcode[4] + barcode.slice(5, 19),
    formatted: `${one.slice(0, 5)}.${one.slice(5)} ${two.slice(0, 5)}.${two.slice(5)} ${three.slice(0, 5)}.${three.slice(5)} ${barcode[4]} ${barcode.slice(5, 19)}`,
  });
}

export const BOLETO_FLAGS = Object.freeze({
  purpose: 'offline-validation', bankRegistered: false, bankAcceptanceVerified: false,
  homologationVerified: false, numberAllocationVerified: false,
  financialMutationPerformed: false, bankTransmissionPerformed: false,
  canIssue: false, canTransmit: false,
});
export const BOLETO_PENDING = Object.freeze([
  'PERSISTED_NUMBER_ALLOCATION_NOT_CHECKED', 'BANK_REGISTRATION_NOT_CHECKED',
  'BANK_HOMOLOGATION_NOT_CHECKED', 'BOLETO_RENDERING_NOT_PERFORMED',
]);
const PROFILE_FIELDS = ['bank', 'layout', 'accountId', 'agency', 'account', 'accountDigit', 'wallet', 'cnpj', 'companyName', 'contractVerified', 'agreementReference', 'simpleCollectionPolicyVerified'];

/** Backend-only mathematical candidate, not a registered or issued bank slip. */
export function createBoletoDigits(input) {
  return createBoletoDigitsForPolicy(input, false);
}

// The alternate policy is reachable only after the complete v2 snapshot check.
// Never rewrite simpleCollectionPolicyVerified to manufacture legacy approval.
function createBoletoDigitsForPolicy(input, observedPolicy) {
  const data = record(input, ['purpose', 'profile', 'title', 'allocation']);
  requireValue(data.purpose === 'offline-validation', 'BOLETO_PURPOSE_UNSUPPORTED');
  const profile = record(data.profile, [...PROFILE_FIELDS, 'reservedRange'], PROFILE_FIELDS);
  if ('reservedRange' in profile) profile.reservedRange = record(profile.reservedRange, ['start', 'end', 'verified']);
  const title = record(data.title, ['amountCents', 'dueOn', 'referenceOn']);
  const allocation = record(data.allocation, ['ourNumber', 'confirmed', 'reference']);
  requireValue(profile.contractVerified === true && text(profile.agreementReference), 'BOLETO_CONTRACT_UNCONFIRMED');
  requireValue(observedPolicy || profile.simpleCollectionPolicyVerified === true, 'BOLETO_POLICY_UNCONFIRMED');
  requireValue(typeof profile.companyName === 'string' && /^[A-Z0-9 .&/-]{1,30}$/.test(profile.companyName) && profile.companyName.trim().length > 0, 'BOLETO_PROFILE_INVALID');
  try { validateProfile(profile, { generation: !observedPolicy }); } catch { fail('BOLETO_PROFILE_INVALID'); }
  requireValue(!observedPolicy || profile.bank === '341' && profile.wallet === '109', 'BOLETO_WALLET_UNSUPPORTED');
  requireValue(profile.bank === '341' && profile.wallet === '109' || profile.bank === '077' && profile.wallet === '110', 'BOLETO_WALLET_UNSUPPORTED');
  requireValue(profile.bank === '077' || !('reservedRange' in profile), 'BOLETO_INPUT_INVALID');
  requireValue(allocation.confirmed === true && text(allocation.reference), 'BOLETO_ALLOCATION_UNCONFIRMED');
  requireValue(digits(allocation.ourNumber, profile.bank === '341' ? 8 : 10) && BigInt(allocation.ourNumber) > 0n, 'BOLETO_OUR_NUMBER_INVALID');
  requireValue(typeof title.amountCents === 'string' && /^[1-9][0-9]{0,9}$/.test(title.amountCents), 'BOLETO_AMOUNT_INVALID');
  requireValue(BigInt(title.amountCents) >= (profile.bank === '077' ? 250n : 1n), 'BOLETO_AMOUNT_BELOW_MINIMUM');
  const dueFactor = calculateDueFactor({ dueOn: title.dueOn, referenceOn: title.referenceOn });
  if (profile.bank === '077') {
    requireValue(BigInt(allocation.ourNumber) >= BigInt(profile.reservedRange.start) && BigInt(allocation.ourNumber) <= BigInt(profile.reservedRange.end), 'BOLETO_OUR_NUMBER_OUTSIDE_RANGE');
    // The consulted official v2.2 free-field table explicitly specifies112,
    // although its reservation and number-digit sections cover110. Never guess.
    fail('BOLETO_INTER110_FIELD_LAYOUT_UNCONFIRMED');
  }
  // Itaú7.3.2 position41 -> Annex3. Reject a mismatch instead of silently
  // replacing the bank-supplied account digit or assuming an exception.
  requireValue(mod10(profile.agency + profile.account) === profile.accountDigit, 'BOLETO_ACCOUNT_DIGIT_MISMATCH');
  const ourNumberDigit = itauOurNumberDigit({ ...profile, ourNumber: allocation.ourNumber });
  const freeField = profile.wallet + allocation.ourNumber + ourNumberDigit + profile.agency + profile.account + profile.accountDigit + '000';
  const prefix = profile.bank + '9', value = dueFactor + title.amountCents.padStart(10, '0');
  const barcode = prefix + calculateBarcodeDigit(prefix + value + freeField) + value + freeField;
  const line = barcodeToDigitableLine(barcode);
  return Object.freeze({ ...BOLETO_FLAGS, bank: profile.bank, wallet: profile.wallet, currency: 'BRL',
    barcode, digitableLine: line.digits, formattedLine: line.formatted, freeField, dueFactor,
    ourNumberWithDigit: allocation.ourNumber + ourNumberDigit,
    amountCents: title.amountCents, dueOn: title.dueOn, referenceOn: title.referenceOn,
    pending: BOLETO_PENDING,
  });
}

/** Separate offline review; fees never change the nominal barcode amount. No PDF or bank instruction is sent. */
export function createItau109BoletoTermsCandidate(input) {
  const data = record(input, ['purpose', 'profile', 'title', 'allocation', 'collectionTerms']);
  const base = createBoletoDigits({ purpose: data.purpose, profile: data.profile, title: data.title, allocation: data.allocation });
  let collectionTerms;
  try {
    collectionTerms = prepareItau109Terms({ amountCents: base.amountCents, dueOn: base.dueOn, terms: data.collectionTerms });
  } catch (error) {
    fail(typeof error?.code === 'string' && /^CNAB_[A-Z_]+$/.test(error.code)
      ? error.code.replace(/^CNAB_/, 'BOLETO_') : 'BOLETO_ITAU_TERMS_INVALID');
  }
  return Object.freeze({ ...base, collectionTerms,
    pending: Object.freeze([...base.pending, ...collectionTerms.pending, 'BANK_CHARGES_POLICY_NOT_VERIFIED', 'PRINTED_INSTRUCTIONS_NOT_VALIDATED']),
  });
}

// Numeric Interleaved 2 of 5 patterns (two wide elements per digit).
// Start/stop and 3:1 ratio cross-checked against ZXing ITFWriter and ReportLab.
const ITF_WIDTHS = Object.freeze(['11331','31113','13113','33111','11313','31311','13311','11133','31131','13131']);

/** Visible offline preview only; never a complete, registered or payable boleto. */
export function createItau109BarcodePreview(input) {
  const candidate = createBoletoDigits(input);
  return renderBarcode(candidate);
}

/** Captured v2 policy only. No account policy is inferred or overwritten. */
export function createItau109OperationalBarcodePreviewV2(input) {
  const data = record(input, ['snapshot', 'billingTitleId']);
  requireValue(typeof data.billingTitleId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.billingTitleId), 'BOLETO_INPUT_INVALID');
  let snapshot;
  try { snapshot = validateOperationalRemittanceV2(data.snapshot).snapshot; }
  catch { fail('BOLETO_OPERATIONAL_SNAPSHOT_INVALID'); }
  const selected = snapshot.titles.filter(t => t.id === data.billingTitleId);
  requireValue(selected.length === 1, 'BOLETO_OPERATIONAL_TITLE_INVALID');
  const title = selected[0];
  const candidate = createBoletoDigitsForPolicy({purpose:'offline-validation',
    profile:Object.fromEntries(PROFILE_FIELDS.map(k => [k, snapshot.profile[k]])),
    title:{amountCents:title.amountCents,dueOn:title.dueOn,referenceOn:snapshot.generatedOn},
    allocation:{ourNumber:title.ourNumber,confirmed:true,reference:'VALIDATED V2 CAPTURE '+data.billingTitleId}},
    snapshot.encoding_profile === 'itau109-origin-observed-v1');
  return renderBarcode(candidate);
}

function renderBarcode(candidate) {
  const widths = [1, 1, 1, 1];
  for (let i = 0; i < candidate.barcode.length; i += 2) {
    const bars = ITF_WIDTHS[Number(candidate.barcode[i])];
    const spaces = ITF_WIDTHS[Number(candidate.barcode[i + 1])];
    for (let j = 0; j < 5; j++) widths.push(Number(bars[j]), Number(spaces[j]));
  }
  widths.push(3, 1, 1);
  let x = 0;
  const rectangles = [];
  for (let i = 0; i < widths.length; i++) {
    if (i % 2 === 0) rectangles.push(`<rect x="${x}" y="0" width="${widths[i]}" height="13"/>`);
    x += widths[i];
  }
  // 44 digits yield exactly405 modules. Physical bars103x13mm, white5mm
  // on each side. The fixed warning is outside the symbol/quiet zone.
  requireValue(x === 405, 'BOLETO_BARCODE_GEOMETRY_INVALID');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="113mm" height="24mm" viewBox="0 0 113 24" role="img" aria-label="Prévia de código de barras Itaú 109. Não pagar."><title>PRÉVIA TÉCNICA - NÃO PAGAR</title><rect width="113" height="24" fill="white"/><text x="5" y="4" font-family="sans-serif" font-size="2.4" fill="black">PRÉVIA TÉCNICA - NÃO PAGAR</text><g fill="black" transform="translate(5 8) scale(${103 / 405} 1)">${rectangles.join('')}</g></svg>`;
  return Object.freeze({ ...candidate, renderProfile: 'itau109-barcode-preview-v1',
    mimeType: 'image/svg+xml', svg, symbolModules: 405, barcodeWidthMm: 103,
    barcodeHeightMm: 13, quietZoneMm: 5, fullBoletoRendered: false,
    printedLayoutValidatedByBank: false,
  });
}
