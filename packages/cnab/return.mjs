import { CnabError, cnabDate, parseLayout, readRecords, requireCnab, sha256 } from './primitives.mjs';
import { accountScope, interOurNumberDigit, itauOurNumberDigit, validateProfile } from './profiles.mjs';
import { ITAU_HEADER, INTER_HEADER, ITAU_DETAIL, INTER_DETAIL, ITAU_TRAILER, INTER_TRAILER } from './layouts.mjs';

const amount = value => BigInt(value).toString();
const validatedReturns = new WeakSet();
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
// Internal attestation, intentionally not exported from the package entry point.
export const isValidatedReturn = value => validatedReturns.has(value);
const OCCURRENCES = {
  '341': { '02': 'REGISTERED', '03': 'REJECTED', '06': 'PAID', '07': 'PARTIAL_PAYMENT', '08': 'NOTARY_PAYMENT', '09': 'CANCELLED', '10': 'CLOSED_AFTER_PAYMENT' },
  '077': { '02': 'REGISTERED', '03': 'REJECTED', '06': 'PAID', '07': 'CANCELLED' },
};
const date = (value, century, line, field, optional = false) => cnabDate(value === '' ? '      ' : value, { century, line, field, optional });
const profileFields = ['bank', 'layout', 'agency', 'account', 'accountDigit', 'wallet', 'cnpj', 'accountId'];
const typedArray = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(Uint8Array.prototype));
function dataProperties(value) {
  try {
    requireCnab(value !== null && typeof value === 'object' && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'CNAB_PROFILE_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireCnab(Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
      && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value')), 'CNAB_PROFILE_INVALID');
    return descriptors;
  } catch (error) {
    if (error instanceof CnabError) throw error;
    throw new CnabError('CNAB_PROFILE_INVALID');
  }
}
function captureReturnInput(bytes, options) {
  const settings = dataProperties(options);
  requireCnab(Object.keys(settings).every(key => key === 'profile' || key === 'century'), 'CNAB_PROFILE_INVALID');
  const source = dataProperties(settings.profile?.value);
  const profile = Object.freeze(Object.fromEntries(profileFields.map(key => [key, source[key]?.value])));
  validateProfile(profile);
  const century = settings.century?.value === undefined ? 2000 : settings.century.value;
  let captured;
  try {
    const prototype = Object.getPrototypeOf(bytes);
    requireCnab(ArrayBuffer.isView(bytes) && bytes instanceof Uint8Array
      && (prototype === Uint8Array.prototype || typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes) && prototype === Buffer.prototype)
      && ['buffer', 'byteLength', 'byteOffset', 'length'].every(key => !Object.hasOwn(bytes, key)), 'CNAB_FILE_SIZE_INVALID');
    // Intrinsic getters avoid caller accessors/iterators. Shared backing memory
    // cannot provide a stable capture and is deliberately unsupported.
    const buffer = typedArray.buffer.get.call(bytes), length = typedArray.byteLength.get.call(bytes), offset = typedArray.byteOffset.get.call(bytes);
    requireCnab(buffer instanceof ArrayBuffer && length > 0 && length <= 4_020_000, 'CNAB_FILE_SIZE_INVALID');
    captured = new Uint8Array(new Uint8Array(buffer, offset, length));
  } catch (error) {
    if (error instanceof CnabError) throw error;
    throw new CnabError('CNAB_FILE_SIZE_INVALID');
  }
  return { bytes: captured, profile, century };
}
// Exact alternative padding observed in local Itaú returns. The January 2017
// manual calls these regions reserved; no business value is inferred from them.
// Keep the original bytes for file/line hashes and reject every other variation.
function parseItauLayout(row, layout, line) {
  const alternatives = layout === ITAU_HEADER ? { bankName: 'BANCO ITAU S.A.' }
    : layout === ITAU_DETAIL ? { blank5: '0'.repeat(26), blank7: '0'.repeat(6) }
      : layout === ITAU_TRAILER ? { blank3: ' '.repeat(50) + '0'.repeat(30) + ' '.repeat(10) } : {};
  const result = {};
  for (const field of layout) {
    const [name, from, to, type] = field, raw = row.slice(from - 1, to);
    if (Object.hasOwn(alternatives, name) && raw === alternatives[name]) result[name] = type === 'A' ? raw.trimEnd() : raw;
    else Object.assign(result, parseLayout(row, [field], line));
  }
  return result;
}
function matchAccount(fields, profile, line, header = false) {
  const account = profile.bank === '077' ? profile.account + profile.accountDigit : profile.account;
  requireCnab(fields.agency === profile.agency && (profile.bank === '077' ? fields.accountWithDigit === account : fields.account === account && fields.accountDigit === profile.accountDigit), 'CNAB_ACCOUNT_MISMATCH', { line });
  if (!header) requireCnab(fields.wallet === profile.wallet && fields.issuerType === '02' && fields.issuerDocument === profile.cnpj, 'CNAB_BENEFICIARY_OR_WALLET_MISMATCH', { line });
}
function bankNumber(fields, profile, line) {
  requireCnab(fields.ourNumber === fields.ourNumber2 && (profile.bank !== '341' || fields.ourNumber === fields.ourNumber3), 'CNAB_OUR_NUMBER_COPIES_MISMATCH', { line });
  const missing = /^0+$/.test(fields.ourNumber);
  requireCnab(!missing || fields.occurrence === '03', 'CNAB_OUR_NUMBER_MISSING', { line });
  if (missing) return null;
  if (profile.bank === '341') {
    requireCnab(itauOurNumberDigit({ ...profile, ourNumber: fields.ourNumber }) === fields.ourNumberDigit, 'CNAB_OUR_NUMBER_DIGIT_INVALID', { line });
    return fields.ourNumber + fields.ourNumberDigit;
  }
  if (profile.wallet === '110') requireCnab(interOurNumberDigit(fields.ourNumber.slice(0,10)) === fields.ourNumber[10], 'CNAB_OUR_NUMBER_DIGIT_INVALID', { line });
  return fields.ourNumber;
}

/** Strictly validates the complete supported file before returning any event. */
export async function parseReturn(inputBytes, options = {}) {
  const { bytes, profile, century } = captureReturnInput(inputBytes, options);
  const rows = readRecords(bytes), inter = profile.bank === '077';
  const header = inter ? parseLayout(rows[0], INTER_HEADER, 1) : parseItauLayout(rows[0], ITAU_HEADER, 1);
  if (!inter) matchAccount(header, profile, 1, true);
  const generatedOn = date(header.generationDate, century, 1, 'generationDate');
  if (!inter) date(header.creditDate, century, 1, 'creditDate', true);
  const trailer = inter ? parseLayout(rows.at(-1), INTER_TRAILER, rows.length) : parseItauLayout(rows.at(-1), ITAU_TRAILER, rows.length);
  const scope = accountScope(profile), events = [];
  for (let index = 1; index < rows.length - 1; index++) {
    const line = index + 1, raw = rows[index];
    requireCnab(raw[0] === '1', 'CNAB_RECORD_TYPE_UNSUPPORTED', { line });
    // Cheque returns use another type-1 structure; never read them as normal billing.
    requireCnab(inter || !['69','76'].includes(raw.slice(108,110)), 'CNAB_CHEQUE_LAYOUT_UNSUPPORTED', { line });
    const fields = inter ? parseLayout(raw, INTER_DETAIL, line) : parseItauLayout(raw, ITAU_DETAIL, line);
    matchAccount(fields, profile, line);
    requireCnab(!inter || fields.wallet2 === profile.wallet, 'CNAB_WALLET_COPIES_MISMATCH', { line });
    const kind = OCCURRENCES[profile.bank][fields.occurrence] ?? 'UNSUPPORTED_OCCURRENCE';
    requireCnab(!inter || kind !== 'UNSUPPORTED_OCCURRENCE', 'CNAB_OCCURRENCE_UNSUPPORTED', { line });
    const ourNumber = bankNumber(fields, profile, line);
    const dueDate = date(fields.dueDate, century, line, 'dueDate', kind === 'REJECTED');
    const occurrenceDate = date(fields.occurrenceDate, century, line, 'occurrenceDate');
    const creditDate = date(fields.creditDate, century, line, 'creditDate', true);
    const adjustments = inter ? null : Object.fromEntries(['fee','iof','abatement','discount','interest','otherCredits'].map(key => [key, amount(fields[key])]));
    const canonical = {
      version: 1, accountScope: scope, bank: profile.bank, wallet: profile.wallet, control: fields.control, documentNumber: fields.documentNumber,
      ourNumber, occurrence: fields.occurrence, kind, occurrenceDate, creditDate, dueDate,
      amountCents: amount(fields.amount), paidCents: amount(fields.paid), adjustments,
      operationNumber: inter ? fields.operationNumber || null : null,
      // Rejection and other bank evidence must remain distinct; no raw text is logged by this package.
      rejection: fields.rejection, settlementChannel: fields.settlementChannel ?? null,
    };
    events.push({ ...canonical, eventHash: await sha256(JSON.stringify(canonical)), lineHash: await sha256(raw), line,
      warnings: [...(!inter && kind === 'UNSUPPORTED_OCCURRENCE' ? ['OCCURRENCE_REQUIRES_SEPARATE_REVIEW'] : []),
        ...(kind === 'PAID' && !creditDate ? ['CREDIT_DATE_MISSING'] : []),
        ...(inter && profile.wallet === '112' ? ['BANK_ASSIGNED_NUMBER_NO_DOCUMENTED_LOCAL_DIGIT_ALGORITHM'] : [])] });
  }
  const warnings = [];
  if (inter) {
    for (const [occurrence, field] of [['02','registeredCount'],['03','rejectedCount'],['06','paidCount']]) requireCnab(BigInt(trailer[field]) === BigInt(events.filter(event => event.occurrence === occurrence).length), 'CNAB_TRAILER_COUNT_MISMATCH', { field });
    const registered = events.filter(event => event.occurrence === '02').reduce((sum, event) => sum + BigInt(event.amountCents), 0n);
    requireCnab(BigInt(trailer.registeredAmount) === registered, 'CNAB_TRAILER_AMOUNT_MISMATCH', { field: 'registeredAmount' });
    const paid = events.filter(event => event.occurrence === '06');
    const nominalSum = paid.reduce((sum,event) => sum + BigInt(event.amountCents),0n);
    const receivedSum = paid.reduce((sum,event) => sum + BigInt(event.paidCents),0n);
    // The PDF labels its paid-count row "04", although type 1 defines paid as 06.
    // It does not disambiguate the aggregate paid amount when nominal != received.
    if (nominalSum === receivedSum) requireCnab(BigInt(trailer.paidAmount) === nominalSum, 'CNAB_TRAILER_AMOUNT_MISMATCH', { field: 'paidAmount' });
    else warnings.push('INTER_PAID_AGGREGATE_AMBIGUOUS_REQUIRES_BANK_CONFIRMATION');
    warnings.push('INTER_TRAILER_EDITORIAL_INCONSISTENCIES', 'INTER_REMITTANCE_COUNT_PRESERVED_NOT_USED_AS_RETURN_COUNT');
  } else {
    requireCnab(trailer.fileSequence === header.fileSequence, 'CNAB_FILE_SEQUENCE_MISMATCH');
    requireCnab(BigInt(trailer.detailCount) === BigInt(events.length), 'CNAB_TRAILER_COUNT_MISMATCH');
    const total = events.reduce((sum,event) => sum + BigInt(event.amountCents),0n);
    requireCnab(BigInt(trailer.fileAmount) === total, 'CNAB_TRAILER_AMOUNT_MISMATCH', { field: 'fileAmount' });
    warnings.push('ITAU_PORTFOLIO_TOTALS_ARE_NOT_FILE_TOTALS');
  }
  const fileHash = await sha256(bytes);
  const parsed = deepFreeze({ version: 1, validated: true, bank: profile.bank, layout: profile.layout, accountId: profile.accountId, accountScope: scope,
    fileHash, generatedOn, century, recordCount: rows.length, events, warnings, trailer,
    // Integrity/structure is not proof of bank origin. Provenance belongs to the receiving application.
    originAuthenticated: false, financialMutationPerformed: false });
  validatedReturns.add(parsed);
  return parsed;
}
