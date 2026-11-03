import {CnabError, requireCnab, sha256, numeric, dateField} from './primitives.mjs';
import {validateProfile} from './profiles.mjs';
import {serializeRemittance,validateRemittanceInput} from './remittance-serializer.mjs';
import {prepareItau109ObservedTerms, ITAU_109_OBSERVED_PROFILE} from './itau-observed.mjs';
import {encodeObservedRecords} from './itau-observed-serializer.mjs';

export const ITAU_109_LEGACY_PROFILE='itau109-no-charges-v1';
export const ITAU_OPERATIONAL_V2_CONTRACT='itau109-operational-v2';
const error='CNAB_OPERATIONAL_V2_INPUT_INVALID';
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
function capture(v,depth=0){
 requireCnab(depth<=8,error);
 if(v===null||['string','boolean','number'].includes(typeof v))return v;
 try{
  requireCnab(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),error);
  const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);
  requireCnab(keys.every(k=>typeof k==='string'&&Object.hasOwn(d[k],'value')&&(d[k].enumerable||(Array.isArray(v)&&k==='length'))),error);
  if(Array.isArray(v)){
   requireCnab(Number.isInteger(d.length.value)&&d.length.value<=30&&keys.length===d.length.value+1,error);
   return Array.from({length:d.length.value},(_,i)=>{requireCnab(Object.hasOwn(d,String(i)),error);return capture(d[i].value,depth+1);});
  }
  return Object.fromEntries(keys.map(k=>[k,capture(d[k].value,depth+1)]));
 }catch(e){if(e instanceof CnabError)throw e;throw new CnabError(error);}
}
function fields(v,required,optional=[]){requireCnab(v&&typeof v==='object'&&!Array.isArray(v)&&required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),error);}
const same=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);

/** Compact immutable evidence shared with SQL067. It is not bank authorization. */
export function operationalEncodingTerms(input){
 const v=capture(input);fields(v,['amountCents','dueOn','zeroDailyInterestConfirmed']);const{amountCents,dueOn,zeroDailyInterestConfirmed}=v;
 const review=prepareItau109ObservedTerms({profile:ITAU_109_OBSERVED_PROFILE,amountCents,dueOn,
  confirmation:{confirmed:true,reference:'BACKEND CAPTURE VALIDATION'},zeroDailyInterestConfirmed});
 return frozen({profile:ITAU_109_OBSERVED_PROFILE,version:1,dailyInterestCents:review.dailyCalculation.dailyCents,
  interestDateField:dueOn,penaltyPercentHundredths:'200',penaltyDateField:new Date(Date.parse(dueOn+'T00:00:00Z')+86400000).toISOString().slice(0,10),zeroDailyInterestConfirmed});
}

/** Pure bytes only. Callers must establish ACL and persisted approval before invoking. */
function validateSnapshot(input,allowPending){
 const v=frozen(capture(input));
 fields(v,['profile','titles','generatedOn','remittanceSequence','purpose','operational_authorization','preview_hash','encoding_profile','encoding_authorization']);
 requireCnab(v.purpose==='operational'&&[ITAU_109_LEGACY_PROFILE,ITAU_109_OBSERVED_PROFILE].includes(v.encoding_profile),error);
 fields(v.profile,['bank','layout','agency','account','accountDigit','wallet','cnpj','accountId','companyName','contractVerified','agreementReference','simpleCollectionPolicyVerified'],['ourNumberStart','remittanceSequenceStart']);
 validateProfile(v.profile);
 requireCnab(v.profile.bank==='341'&&v.profile.wallet==='109'&&v.profile.contractVerified===true&&typeof v.profile.agreementReference==='string'&&v.profile.agreementReference.trim().length>0,error);
 requireCnab(typeof v.profile.simpleCollectionPolicyVerified==='boolean',error);
 const a=v.encoding_authorization,o=v.operational_authorization;
 fields(a,['approval_version','policy_hash','reference','confirmed_on','compatibility_confirmed','permanent_instructions_acknowledged']);
 fields(o,['approval_version','profile_config_hash','identity_version']);
 requireCnab(Number.isInteger(a.approval_version)&&a.approval_version>0&&a.approval_version===o.approval_version&&Number.isInteger(o.identity_version)&&o.identity_version>0,error);
 for(const h of[a.policy_hash,o.profile_config_hash,v.preview_hash])requireCnab(typeof h==='string'&&/^[a-f0-9]{64}$/.test(h),error);
 // SQL stores btrim(text) (ASCII space), while length(text) counts Unicode characters.
 requireCnab(typeof a.reference==='string'&&Array.from(a.reference).length>=3&&Array.from(a.reference).length<=200
  &&a.reference===a.reference.replace(/^ +| +$/g,'')&&a.reference.trim().length>0&&!/[\x00-\x1f\x7f]/.test(a.reference),error);
 dateField(a.confirmed_on);requireCnab(a.confirmed_on<=v.generatedOn,error);
 const observed=v.encoding_profile===ITAU_109_OBSERVED_PROFILE;
 requireCnab(typeof a.compatibility_confirmed==='boolean'&&typeof a.permanent_instructions_acknowledged==='boolean',error);
 if(observed)requireCnab(a.compatibility_confirmed&&a.permanent_instructions_acknowledged,'CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');
 else requireCnab(v.profile.simpleCollectionPolicyVerified===true,'CNAB_COLLECTION_POLICY_UNCONFIRMED');
 requireCnab(Array.isArray(v.titles)&&v.titles.length>=1&&v.titles.length<=30,error);
 const pending=[],reviews=[],titles=v.titles.map(t=>{
  fields(t,['id','control','documentNumber','ourNumber','amountCents','issuedOn','dueOn','payer',...(observed?['encodingTerms']:[])]);
  fields(t.payer,['type','document','name','address','neighborhood','city','state','postalCode']);
  if(observed){
   const e=t.encodingTerms;fields(e,['profile','version','dailyInterestCents','interestDateField','penaltyPercentHundredths','penaltyDateField','zeroDailyInterestConfirmed']);
   const expected=operationalEncodingTerms({amountCents:t.amountCents,dueOn:t.dueOn,zeroDailyInterestConfirmed:e.zeroDailyInterestConfirmed});
   requireCnab(same(e,expected),'CNAB_OPERATIONAL_V2_TERMS_MISMATCH');
   const review=prepareItau109ObservedTerms({profile:v.encoding_profile,amountCents:t.amountCents,dueOn:t.dueOn,
    confirmation:{confirmed:true,reference:'BACKEND CAPTURE VALIDATION'},zeroDailyInterestConfirmed:e.zeroDailyInterestConfirmed});
   if(!review.encodingReady){requireCnab(allowPending,'CNAB_ITAU_OBSERVED_TERMS_UNCONFIRMED');pending.push({code:'ZERO_DAILY_FIELD_UNCONFIRMED',title_id:t.id});}reviews.push(review);
  }
  const{encodingTerms,...base}=t;return base;
 });
 validateRemittanceInput({profile:v.profile,titles,generatedOn:v.generatedOn,remittanceSequence:v.remittanceSequence});
 const totalCents=titles.reduce((sum,t)=>sum+BigInt(t.amountCents),0n).toString();
 const warnings=observed?[...new Set(reviews.flatMap(r=>r.warnings)),'FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT','NO_BANK_TRANSMISSION_PERFORMED']
  :['BANK_CLEARANCE_DECLARED_BY_OPERATOR','FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT','NO_BANK_TRANSMISSION_PERFORMED'];
 return {v,titles,reviews,observed,pending,totalCents,warnings};
}

export function validateOperationalRemittanceV2(input,{allowPending=false}={}){
 requireCnab(typeof allowPending==='boolean',error);const {v,pending,totalCents,warnings}=validateSnapshot(input,allowPending);
 return frozen({snapshot:v,pending,canReserve:pending.length===0,totalCents,warnings});
}

export async function generateOperationalRemittanceV2(input){
 const {v,titles,reviews,observed}=validateSnapshot(input,false),a=v.encoding_authorization;
 // Capture all metadata before the first digest await; no caller graph survives.
 const base=await serializeRemittance({profile:v.profile,titles,generatedOn:v.generatedOn,remittanceSequence:v.remittanceSequence,purpose:'operational'});
 const bytes=observed?encodeObservedRecords(base,reviews):base.bytes;
 const manifest=frozen(base.manifest.map((entry,i)=>({...entry,...(observed?{encodingTerms:v.titles[i].encodingTerms}:{})})));
 const warnings=observed?[...new Set(reviews.flatMap(r=>r.warnings)),'FILE_DOES_NOT_ENCODE_TEST_ENVIRONMENT','NO_BANK_TRANSMISSION_PERFORMED']:base.warnings;
 return {...base,contract:ITAU_OPERATIONAL_V2_CONTRACT,encodingProfile:v.encoding_profile,approvalVersion:a.approval_version,encodingPolicyHash:a.policy_hash,
  filename:`ITAU_COBRANCA_${numeric(v.remittanceSequence,7)}.REM`,bytes,fileHash:await sha256(bytes),manifest,warnings,
  bankTransmissionPerformed:false,financialMutationPerformed:false,originAuthenticated:false,
  bankPolicyVerified:false,bankAcceptanceVerified:false,canEmit:false,canTransmit:false};
}
