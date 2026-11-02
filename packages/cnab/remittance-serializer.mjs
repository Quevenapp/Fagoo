import { alpha, cents, dateField, digits, encodeRecords, makeRecord, numeric, requireCnab, sha256, validDocument } from './primitives.mjs';
import { accountScope, interOurNumberDigit, itauOurNumberDigit, validateProfile } from './profiles.mjs';
import { prepareItau109Terms } from './itau-terms.mjs';

const STATES = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
const titleFields = new Set(['id', 'control', 'documentNumber', 'ourNumber', 'amountCents', 'issuedOn', 'dueOn', 'payer', 'paymentLimitDays', 'collectionTerms']);
const payerFields = new Set(['type', 'document', 'name', 'address', 'neighborhood', 'city', 'state', 'postalCode']);
const zeros = size => '0'.repeat(size);
const record = (fields, sequence) => makeRecord([...fields, [395, 400, numeric(String(sequence), 6)]]);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function validateTitle(title, profile, generatedOn) {
  requireCnab(isObject(title) && Object.keys(title).every(key => titleFields.has(key)), 'CNAB_TITLE_OR_FEATURE_UNSUPPORTED');
  requireCnab(typeof title.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(title.id), 'CNAB_TITLE_ID_INVALID');
  alpha(title.control, 25, true); alpha(title.documentNumber, 10, true);
  requireCnab(title.control === title.control.trim() && title.documentNumber === title.documentNumber.trim(), 'CNAB_REFERENCE_INVALID');
  dateField(title.issuedOn); dateField(title.dueOn);
  requireCnab(title.issuedOn <= generatedOn && title.dueOn >= generatedOn, 'CNAB_ISSUE_OR_DUE_DATE_INVALID');
  const amount = cents(title.amountCents);
  requireCnab(amount >= (profile.bank === '077' ? 250n : 1n), 'CNAB_AMOUNT_BELOW_MINIMUM');
  const payer = title.payer;
  requireCnab(isObject(payer) && Object.keys(payer).every(key => payerFields.has(key)) && validDocument(payer.type, payer.document), 'CNAB_PAYER_DOCUMENT_INVALID');
  alpha(payer.name, profile.bank === '341' ? 30 : 40, true);
  alpha(payer.address, profile.bank === '341' ? 40 : 38, true);
  requireCnab(STATES.has(payer.state) && digits(payer.postalCode, 8) && !/^0+$/.test(payer.postalCode), 'CNAB_PAYER_ADDRESS_INVALID');
  if (profile.bank === '341') {
    alpha(payer.neighborhood, 12, true); alpha(payer.city, 15, true);
    requireCnab(title.paymentLimitDays === undefined, 'CNAB_TITLE_OR_FEATURE_UNSUPPORTED');
    requireCnab(digits(title.ourNumber, 8) && !/^0+$/.test(title.ourNumber), 'CNAB_OUR_NUMBER_INVALID');
  } else {
    requireCnab(!Object.hasOwn(title, 'collectionTerms'), 'CNAB_TITLE_OR_FEATURE_UNSUPPORTED');
    requireCnab(Number.isInteger(title.paymentLimitDays) && title.paymentLimitDays >= 1 && title.paymentLimitDays <= 60, 'CNAB_PAYMENT_LIMIT_INVALID');
    if (profile.wallet === '112') requireCnab(title.ourNumber === undefined, 'CNAB_INTER_NUMBER_BANK_ASSIGNED');
    else {
      requireCnab(digits(title.ourNumber, 10) && !/^0+$/.test(title.ourNumber), 'CNAB_OUR_NUMBER_INVALID');
      requireCnab(BigInt(title.ourNumber) >= BigInt(profile.reservedRange.start) && BigInt(title.ourNumber) <= BigInt(profile.reservedRange.end), 'CNAB_INTER_NUMBER_OUTSIDE_RESERVED_RANGE');
    }
  }
}

function itauDetail(title, profile, sequence, terms) {
  const payer = title.payer;
  return record([
    [1,1,'1'],[2,3,'02'],[4,17,profile.cnpj],[18,21,profile.agency],[22,23,'00'],[24,28,profile.account],[29,29,profile.accountDigit],
    [34,37,'0000'],[38,62,alpha(title.control,25)],[63,70,title.ourNumber],[71,83,zeros(13)],[84,86,profile.wallet],[108,108,'I'],
    [109,110,'01'],[111,120,alpha(title.documentNumber,10)],[121,126,dateField(title.dueOn)],[127,139,numeric(title.amountCents,13)],
    [140,142,'341'],[143,147,'00000'],[148,149,'01'],[150,150,'N'],[151,156,dateField(title.issuedOn)],
    // Legacy: 10+47. Explicit charges: 10+44 plus daily cents/date (notes 11/12).
    // No protest, return or free-form instruction is inferred from printed text.
    [157,158,'10'],[159,160,terms ? '44' : '47'],[161,173,terms ? numeric(terms.encoding.dailyInterestCents,13) : zeros(13)],
    [174,179,zeros(6)],[180,192,zeros(13)],[193,205,zeros(13)],[206,218,zeros(13)],
    [219,220,payer.type],[221,234,numeric(payer.document,14)],[235,264,alpha(payer.name,30)],[275,314,alpha(payer.address,40)],
    [315,326,alpha(payer.neighborhood,12)],[327,334,payer.postalCode],[335,349,alpha(payer.city,15)],[350,351,payer.state],
    [386,391,terms ? dateField(terms.encoding.interestStartsOn) : zeros(6)],[392,393,'00'],
  ], sequence);
}
function itauPenalty(terms, sequence) {
  const day = terms.encoding.penaltyStartsOn;
  // Manual p.9 / note35: a single type2 immediately follows its own type1.
  return record([[1,1,'2'],[2,2,'2'],[3,10,day.slice(8,10)+day.slice(5,7)+day.slice(0,4)],
    [11,23,numeric(terms.encoding.penaltyPercentHundredths,13)]], sequence);
}
function interDetail(title, profile, sequence) {
  const payer = title.payer;
  return record([
    [1,1,'1'],[21,23,profile.wallet],[24,27,'0001'],[28,36,profile.account],[37,37,profile.accountDigit],[38,62,alpha(title.control,25)],
    [66,66,'0'],[67,79,zeros(13)],[80,83,zeros(4)],[84,89,zeros(6)],
    [90,100,profile.wallet === '112' ? zeros(11) : title.ourNumber + interOurNumberDigit(title.ourNumber)],
    [109,110,'01'],[111,120,alpha(title.documentNumber,10)],[121,126,dateField(title.dueOn)],[127,139,numeric(title.amountCents,13)],
    [140,141,numeric(String(title.paymentLimitDays),2)],[148,149,'01'],[150,150,'N'],[160,160,'0'],[161,173,zeros(13)],
    [174,177,zeros(4)],[178,183,zeros(6)],[184,184,'0'],[185,197,zeros(13)],[198,201,zeros(4)],[202,207,zeros(6)],
    [221,222,payer.type],[223,236,numeric(payer.document,14)],[237,276,alpha(payer.name,40)],[277,314,alpha(payer.address,38)],
    [315,316,payer.state],[317,324,payer.postalCode],
  ], sequence);
}

/** Encodes the confirmed layout only; orchestration owns purpose/authorization. Never contacts a bank. */
export function validateRemittanceInput({ profile, titles, generatedOn, remittanceSequence } = {}) {
  validateProfile(profile);
  requireCnab(Array.isArray(titles) && titles.length >= 1 && titles.length <= 30, 'CNAB_HOMOLOGATION_TITLE_LIMIT');
  requireCnab(typeof remittanceSequence === 'string' && /^[1-9][0-9]{0,6}$/.test(remittanceSequence), 'CNAB_REMITTANCE_SEQUENCE_INVALID');
  dateField(generatedOn); alpha(profile.companyName, 30, true);
  const seen = { id: new Set(), control: new Set(), documentNumber: new Set(), ourNumber: new Set() };
  const preparedTerms = new Map();
  for (const title of titles) {
    validateTitle(title, profile, generatedOn);
    if (Object.hasOwn(title, 'collectionTerms')) {
      const terms = prepareItau109Terms({ amountCents: title.amountCents, dueOn: title.dueOn, terms: title.collectionTerms });
      requireCnab(terms.encodingReady, 'CNAB_ITAU_TERMS_UNRESOLVED');
      preparedTerms.set(title.id, terms);
    }
    for (const key of Object.keys(seen)) {
      if (title[key] === undefined) continue;
      requireCnab(!seen[key].has(title[key]), 'CNAB_DUPLICATE_TITLE_REFERENCE', { field: key }); seen[key].add(title[key]);
    }
  }
  return preparedTerms;
}
export async function serializeRemittance({profile,titles,generatedOn,remittanceSequence,purpose}={}){
  const preparedTerms=validateRemittanceInput({profile,titles,generatedOn,remittanceSequence});
  const common = [[1,1,'0'],[2,2,'1'],[3,9,'REMESSA'],[10,11,'01'],[12,26,alpha('COBRANCA',15)],
    [47,76,alpha(profile.companyName,30)],[77,79,profile.bank],[80,94,alpha(profile.bank === '341' ? 'BANCO ITAU SA' : 'INTER',15)],[95,100,dateField(generatedOn)]];
  const header = record(profile.bank === '341' ? [...common,[27,30,profile.agency],[31,32,'00'],[33,37,profile.account],[38,38,profile.accountDigit]]
    : [...common,[111,117,numeric(remittanceSequence,7)]], 1);
  const details = [];
  for (const title of titles) {
    const terms = preparedTerms.get(title.id);
    details.push((profile.bank === '341' ? itauDetail : interDetail)(title, profile, details.length + 2, terms));
    if (terms) details.push(itauPenalty(terms, details.length + 2));
  }
  const trailer = record(profile.bank === '341' ? [[1,1,'9']] : [[1,1,'9'],[2,7,numeric(String(titles.length),6)]], details.length + 2);
  const bytes = encodeRecords([header, ...details, trailer]);
  // Capture all caller-derived evidence before hashing yields. A later mutation
  // of input objects must not change the manifest/amount attached to these bytes.
  const totalCents = titles.reduce((sum, title) => sum + cents(title.amountCents), 0n).toString();
  const manifest = titles.map(title => ({ titleId: title.id, control: title.control, documentNumber: title.documentNumber, amountCents: title.amountCents,
    dueDate: title.dueOn, ourNumber: title.ourNumber === undefined ? null : title.ourNumber + (profile.bank === '341' ? itauOurNumberDigit({ ...profile, ourNumber: title.ourNumber }) : interOurNumberDigit(title.ourNumber)),
    ...(preparedTerms.has(title.id) ? { collectionTerms: preparedTerms.get(title.id) } : {}) }));
  return {
    purpose, productionReady: false, bank: profile.bank, layout: profile.layout, accountId: profile.accountId, accountScope: accountScope(profile),
    filename: profile.bank === '077' ? `CI400_001_${numeric(remittanceSequence,7)}.REM` : `${purpose==='operational'?'ITAU_COBRANCA':'ITAU_TESTE'}_${numeric(remittanceSequence,7)}.REM`,
    bytes, fileHash: await sha256(bytes), totalCents, manifest,
    warnings: [purpose==='operational'?'BANK_CLEARANCE_DECLARED_BY_OPERATOR':'BANK_HOMOLOGATION_REQUIRED', 'FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT', 'NO_BANK_TRANSMISSION_PERFORMED',
      ...(preparedTerms.size ? ['BANK_CHARGES_POLICY_NOT_VERIFIED', 'SOURCE_ABSENT_INSTRUCTIONS_NOT_REPRODUCED', 'PRINTED_PROTEST_TEXT_NOT_ENCODED'] : [])],
  };
}
