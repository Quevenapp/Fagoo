import {encodeObservedRecords} from './itau-observed-serializer.mjs';
import { CnabError, cents, dateField, encodeRecords, makeRecord, numeric, readRecords, requireCnab, sha256 } from './primitives.mjs';
import { validateProfile } from './profiles.mjs';
import { generateRemittance } from './remittance.mjs';

export const ITAU_109_OBSERVED_PROFILE = 'itau109-origin-observed-v1';
const FLAGS = Object.freeze({ canEmit:false, canTransmit:false, bankPolicyVerified:false, bankAcceptanceVerified:false,
  bankTransmissionPerformed:false, financialMutationPerformed:false, originAuthenticated:false });
const WARNINGS = Object.freeze(['ACCOUNT_PERMANENT_INSTRUCTIONS_UNKNOWN', 'INTEREST_DATE_EFFECT_UNKNOWN',
  'PENALTY_DATE_EFFECT_UNKNOWN', 'NO_PROTEST_INSTRUCTION_DOES_NOT_DISABLE_PERMANENT_PROTEST', 'BANK_HOMOLOGATION_NOT_VERIFIED']);
const PROFILE_FIELDS = ['bank','layout','agency','account','accountDigit','wallet','cnpj','accountId','companyName',
  'contractVerified','agreementReference','simpleCollectionPolicyVerified'];
const TITLE_FIELDS = ['id','control','documentNumber','ourNumber','amountCents','issuedOn','dueOn','payer','zeroDailyInterestConfirmed'];
const PAYER_FIELDS = ['type','document','name','address','neighborhood','city','state','postalCode'];
const freeze = value => { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };
function copy(value, fields) {
  try {
    requireCnab(value!==null && typeof value==='object' && !Array.isArray(value)
      && [Object.prototype,null].includes(Object.getPrototypeOf(value)), 'CNAB_ITAU_OBSERVED_INPUT_INVALID');
    const d=Object.getOwnPropertyDescriptors(value), keys=Reflect.ownKeys(d);
    requireCnab(keys.length===fields.length && keys.every(k=>typeof k==='string' && fields.includes(k)
      && d[k].enumerable && Object.hasOwn(d[k],'value')), 'CNAB_ITAU_OBSERVED_INPUT_INVALID');
    return Object.fromEntries(fields.map(k=>[k,d[k].value]));
  } catch(error) { if(error instanceof CnabError)throw error;throw new CnabError('CNAB_ITAU_OBSERVED_INPUT_INVALID'); }
}
function scalarValues(value) {
  requireCnab(Object.values(value).every(v=>typeof v==='string'||typeof v==='boolean'), 'CNAB_ITAU_OBSERVED_INPUT_INVALID');
  return value;
}
function confirmation(value) {
  if(value===null)return null;
  const c=copy(value,['confirmed','reference']);
  requireCnab(c.confirmed===true && typeof c.reference==='string' && c.reference.length>=3 && c.reference.length<=160
    && c.reference===c.reference.trim() && !/[\x00-\x1f\x7f]/.test(c.reference), 'CNAB_ITAU_OBSERVED_CONFIRMATION_INVALID');
  return c;
}
function tomorrow(day) {
  dateField(day);
  const next=new Date(Date.parse(day+'T00:00:00.000Z')+86400000).toISOString().slice(0,10);
  dateField(next);return next;
}

/** A declared byte-compatibility profile; never an assertion of the bank's charging policy. */
export function prepareItau109ObservedTerms(input) {
  const v=copy(input,['profile','amountCents','dueOn','confirmation','zeroDailyInterestConfirmed']);
  requireCnab(v.profile===ITAU_109_OBSERVED_PROFILE, 'CNAB_ITAU_OBSERVED_PROFILE_UNSUPPORTED');
  const amount=cents(v.amountCents);requireCnab(amount>0n,'CNAB_AMOUNT_BELOW_MINIMUM');
  dateField(v.dueOn);const penaltyDateField=tomorrow(v.dueOn),review=confirmation(v.confirmation);
  requireCnab(typeof v.zeroDailyInterestConfirmed==='boolean','CNAB_ITAU_OBSERVED_INPUT_INVALID');
  const daily=(amount+1500n)/3000n, zero=daily===0n;
  requireCnab(zero || v.zeroDailyInterestConfirmed===false,'CNAB_ITAU_ZERO_CONFIRMATION_NOT_APPLICABLE');
  const pending=[...(!review?['HISTORICAL_PROFILE_UNCONFIRMED']:[]),...(zero&&!v.zeroDailyInterestConfirmed?['ZERO_DAILY_FIELD_UNCONFIRMED']:[])];
  return freeze({ profile:v.profile, amountCents:v.amountCents, dueOn:v.dueOn, confirmation:review,
    zeroDailyInterestConfirmed:v.zeroDailyInterestConfirmed, encodingReady:pending.length===0, pending,
    dailyCalculation:{numeratorCents:v.amountCents,denominator:'3000',rounding:'half-up',dailyCents:daily.toString()},
    encoding:pending.length?null:{species:'01',acceptance:'N',instructions:['00','00'],dailyInterestCents:daily.toString(),
      interestDateField:v.dueOn,penaltyCode:'2',penaltyPercentHundredths:'200',penaltyDateField,
      discountCents:'0',discountUntil:null,iofCents:'0',abatementCents:'0',variableCurrencyQuantity:'0',protestDays:'00'},
    warnings:[...WARNINGS,...(zero?['ZERO_DAILY_FIELD_BANK_EFFECT_UNKNOWN']:[])],...FLAGS });
}

function capture(input) {
  const v=copy(input,['profile','historicalProfile','confirmation','titles','generatedOn','remittanceSequence']);
  requireCnab(v.historicalProfile===ITAU_109_OBSERVED_PROFILE,'CNAB_ITAU_OBSERVED_PROFILE_UNSUPPORTED');
  const profile=scalarValues(copy(v.profile,PROFILE_FIELDS));
  validateProfile(profile,{generation:true});
  requireCnab(profile.bank==='341'&&profile.wallet==='109','CNAB_ITAU_OBSERVED_PROFILE_UNSUPPORTED');
  requireCnab(typeof v.generatedOn==='string'&&typeof v.remittanceSequence==='string','CNAB_ITAU_OBSERVED_INPUT_INVALID');
  const declared=confirmation(v.confirmation);
  let descriptors;
  try {
    requireCnab(Array.isArray(v.titles)&&Object.getPrototypeOf(v.titles)===Array.prototype,'CNAB_ITAU_OBSERVED_INPUT_INVALID');
    const length=Object.getOwnPropertyDescriptor(v.titles,'length')?.value;
    requireCnab(Number.isInteger(length)&&length>=1&&length<=30,'CNAB_HOMOLOGATION_TITLE_LIMIT');
    descriptors=Object.getOwnPropertyDescriptors(v.titles);
    requireCnab(Reflect.ownKeys(descriptors).length===length+1 && Array.from({length},(_,i)=>String(i))
      .every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')),'CNAB_ITAU_OBSERVED_INPUT_INVALID');
  } catch(error){if(error instanceof CnabError)throw error;throw new CnabError('CNAB_ITAU_OBSERVED_INPUT_INVALID');}
  const reviews=[],titles=[];
  for(let i=0;i<descriptors.length.value;i++){
    const t=copy(descriptors[String(i)].value,TITLE_FIELDS),payer=scalarValues(copy(t.payer,PAYER_FIELDS));
    const {zeroDailyInterestConfirmed,payer:ignored,...base}=t;scalarValues(base);
    const review=prepareItau109ObservedTerms({profile:v.historicalProfile,amountCents:t.amountCents,dueOn:t.dueOn,
      confirmation:declared,zeroDailyInterestConfirmed});
    requireCnab(review.encodingReady,'CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');
    titles.push({...base,payer});reviews.push(review);
  }
  return freeze({profile,titles,reviews,generatedOn:v.generatedOn,remittanceSequence:v.remittanceSequence});
}
/** Isolated offline encoder. No existing generation entry point selects this profile. */
export async function generateObservedItau109Remittance(input) {
  // Capture the complete caller graph and decisions before the legacy encoder's
  // digest yields. This composition only patches fixed, reviewed positions.
  const captured=capture(input);
  const base=await generateRemittance({profile:captured.profile,titles:captured.titles,generatedOn:captured.generatedOn,
    remittanceSequence:captured.remittanceSequence,purpose:'homologation'});
  const bytes=encodeObservedRecords(base,captured.reviews),manifest=base.manifest.map((entry,i)=>({...entry,historicalTerms:captured.reviews[i]}));
  return {purpose:'offline-compatibility',profile:ITAU_109_OBSERVED_PROFILE,productionReady:false,
    bank:base.bank,layout:base.layout,accountId:base.accountId,accountScope:base.accountScope,
    filename:`ITAU109_COMPATIBILITY_${numeric(captured.remittanceSequence,7)}.REM`,bytes,fileHash:await sha256(bytes),
    totalCents:base.totalCents,manifest:freeze(manifest),warnings:[...WARNINGS,
      ...(captured.reviews.some(r=>r.dailyCalculation.dailyCents==='0')?['ZERO_DAILY_FIELD_BANK_EFFECT_UNKNOWN']:[]),
      'FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT'],...FLAGS};
}
